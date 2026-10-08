// src/main/tasks/taskManager.ts
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent, CreateTaskInput } from '@shared/ipc'
import { IMPLEMENT_START_REF, msg, msgDisplay } from '@shared/protocol'
import type { ReportInput } from '@shared/report'
import type {
  Branch,
  BranchConclusion,
  Channel,
  FeedbackItem,
  PermissionDecision,
  PermissionRequest,
  Report,
  Task,
  TaskStatus,
  TimelineEvent,
  VerificationResult
} from '@shared/types'
import { AgentRun, type QueryFn, type RunnerEvent } from '../agent/agentRun'
import { MAIN_SYSTEM_APPEND } from '../agent/prompts'
import type { GitLike } from '../git/gitService'
import { hasShellOperators, matchesPattern } from '../permissions/commandPattern'
import {
  type ApprovalRequest,
  BUILTIN_TOOLS,
  createPermissionGate,
  createPreToolUseHook,
  type GateContext
} from '../permissions/gate'
import type { Repository } from '../store/repository'
import type { HarnessToolName, ToolSink } from '../tools/harnessTools'
import { prBody } from './prBody'
import { phaseOf, type TaskEventType, transition } from './stateMachine'

type McpServer = NonNullable<Options['mcpServers']>[string]
type TimelineEntry = Omit<TimelineEvent, 'id' | 'ts'>

export interface TaskManagerDeps {
  repo: Repository
  git: GitLike
  queryFn: QueryFn
  createToolServer: (sink: ToolSink, tools: HarnessToolName[]) => McpServer
  getClaudePath: () => string | undefined
  emit: (e: AppEvent) => void
  verify: (
    cwd: string,
    commands: string[],
    isAllowed: (c: string) => boolean,
    /** 關閉 app 時中止進行中的驗證指令 */
    signal?: AbortSignal
  ) => Promise<VerificationResult[]>
  now?: () => string
  newId?: () => string
  /** 開新一輪前等上一段執行結束的上限，逾時就中止它（預設 15000ms） */
  prevRunTimeoutMs?: number
}

interface PermissionWaiter {
  taskId: string
  channel: Channel
  /** 提出請求的執行；執行結束時還在等的請求一律拒絕 */
  run?: AgentRun
  request: PermissionRequest
  resolve: (d: PermissionDecision) => void
}

const MAIN_TOOLS: HarnessToolName[] = ['ask_user', 'propose_spec', 'update_plan', 'submit_report']
/** 中止上一段執行後再等它結束的上限 */
const ABORT_GRACE_MS = 2000
const runKey = (taskId: string, channel: Channel) => `${taskId}|${channel}`
const branchIdOf = (channel: Channel) =>
  channel.startsWith('branch:') ? channel.slice('branch:'.length) : undefined
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** 取 `<prefix><數字>` 形式的 id 中最大的編號 + 1（刪除或還原過也不會撞號） */
function nextId(prefix: string, ids: string[]): string {
  const max = ids.reduce((m, id) => {
    const n = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN
    return Number.isInteger(n) && n > m ? n : m
  }, 0)
  return `${prefix}${max + 1}`
}
const logError = (what: string) => (e: unknown) => console.error(`[TaskManager] ${what}`, e)

/** p 在 ms 內結束（成功或失敗）回傳 true，逾時回傳 false */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms)
  })
  return Promise.race([
    p.then(
      () => true,
      () => true
    ),
    timeout
  ]).finally(() => clearTimeout(timer))
}

export class TaskManager {
  private tasks = new Map<string, Task>()
  /** 每個 channel（taskId|channel）最多一段執行 */
  private runs = new Map<string, AgentRun>()
  /** 串起每個任務的 runner 事件與工具回呼，依發生順序處理 */
  private chains = new Map<string, Promise<unknown>>()
  /** 每個任務的 task.json 寫入依序進行 */
  private saves = new Map<string, Promise<unknown>>()
  /** 每個任務的時間軸寫入依序進行（磁碟順序＝推送順序） */
  private timelineWrites = new Map<string, Promise<unknown>>()
  /** 每個 channel 的「決定插話或開新一輪」依序進行，避免同時開出兩段執行 */
  private turnLocks = new Map<string, Promise<unknown>>()
  /** 等待使用者核准的請求，依提出順序；UI 一次顯示最早的一個 */
  private permissionWaiters = new Map<string, PermissionWaiter>()
  /**
   * 使用者拒絕過的 tool_use id → 提出請求的執行：之後的工具結果在時間軸上標成「已拒絕」而不是失敗。
   * 那段執行結束時清掉（沒等到工具結果的也一併清掉）。
   */
  private deniedToolUses = new Map<string, AgentRun | undefined>()
  /** 主線正在回答反問的問題卡片：這段期間的文字回覆寫進卡片 */
  private pendingCounter = new Map<string, string>()
  /** 報告整理中（邏輯狀態）：進入 reviewing 的同一步就清除 */
  private finalizing = new Set<string>()
  /** 報告整理的 promise，整個流程（含之後的時間軸寫入）結束才移除；whenIdle 用 */
  private reportJobs = new Map<string, Promise<void>>()
  /** 每個報告整理流程的 AbortController；關閉 app 時用來中止驗證指令 */
  private reportAborts = new Map<string, AbortController>()
  /** 正在開 PR／合併／丟棄的任務 */
  private finishing = new Set<string>()
  /** 收尾操作的 promise；關閉 app 時等它們（有上限） */
  private finishJobs = new Map<string, Promise<unknown>>()
  /** app 正在關閉：拒絕新任務與新訊息 */
  private shuttingDown = false
  private readonly now: () => string
  private readonly newId: () => string
  private readonly prevRunTimeoutMs: number
  /** 中止執行後再等它結束的上限 */
  private readonly abortGraceMs: number

  constructor(private d: TaskManagerDeps) {
    this.now = d.now ?? (() => new Date().toISOString())
    this.newId = d.newId ?? (() => randomUUID().slice(0, 8))
    this.prevRunTimeoutMs = d.prevRunTimeoutMs ?? 15_000
    this.abortGraceMs = Math.min(ABORT_GRACE_MS, this.prevRunTimeoutMs)
  }

  // ───────── 讀取 ─────────

  async init() {
    for (const t of await this.d.repo.listTasks()) {
      // 上次關閉 app 時還在執行的任務：程序已不在，標為中斷，使用者可「繼續」
      const busy =
        t.runState === 'running' ||
        t.runState === 'waiting_permission' ||
        t.runState === 'finalizing'
      if (busy || t.pendingPermission || t.branches.some((b) => b.running)) {
        if (busy) t.runState = 'interrupted'
        t.pendingPermission = undefined
        t.branches.forEach((b) => {
          b.running = false
        })
        await this.d.repo.saveTask(t)
      }
      this.tasks.set(t.id, t)
    }
  }

  list(): Task[] {
    return [...this.tasks.values()]
      .map((t) => structuredClone(t))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** 回傳複本；內部一律用 task() */
  get(taskId: string): Task {
    return structuredClone(this.task(taskId))
  }

  timeline(taskId: string) {
    return this.d.repo.readTimeline(taskId)
  }

  /** 等這個任務的所有執行、事件與報告整理結束（測試用，也用於關閉 app 前） */
  async whenIdle(taskId: string) {
    const ofTask = (m: Map<string, Promise<unknown>>) =>
      [...m.entries()].filter(([k]) => k.startsWith(`${taskId}|`)).map(([, p]) => p)
    for (let i = 0; i < 100; i++) {
      const runs = this.runsOf(taskId).map(([, r]) => r.done.catch(() => undefined))
      await Promise.all([...runs, this.reportJobs.get(taskId)])
      await Promise.all(ofTask(this.turnLocks))
      await this.chains.get(taskId)
      await this.saves.get(taskId)
      await this.timelineWrites.get(taskId)
      await new Promise((r) => setTimeout(r, 0))
      if (this.runsOf(taskId).length === 0 && !this.reportJobs.has(taskId)) return
    }
    throw new Error(`whenIdle: 任務 ${taskId} 一直沒有停下來`)
  }

  // ───────── 內部工具 ─────────

  private task(taskId: string): Task {
    const t = this.tasks.get(taskId)
    if (!t) throw new Error(`找不到任務 ${taskId}`)
    return t
  }

  /** 取得還沒結束（未完成、未丟棄）的任務 */
  private openTask(taskId: string): Task {
    const t = this.task(taskId)
    if (t.status === 'done' || t.status === 'discarded') throw new Error('任務已結束')
    return t
  }

  /** 對 channel 送出訊息前必須成立的條件；改變狀態的操作要在改狀態之前先檢查 */
  private assertCanSend(taskId: string, channel: Channel): Task {
    if (this.shuttingDown) throw new Error('Harness 正在關閉')
    const t = this.openTask(taskId)
    if (this.finishing.has(taskId)) throw new Error('任務正在收尾，請稍候')
    if (channel === 'main' && this.finalizing.has(taskId))
      throw new Error('正在整理報告，請稍候再送出')
    return t
  }

  private runsOf(taskId: string) {
    return [...this.runs.entries()].filter(([k]) => k.startsWith(`${taskId}|`))
  }

  /** 把 fn 接在 map[key] 的尾端依序執行；尾端仍是自己時結束後移除，避免 map 無限成長 */
  private chainOn<T>(map: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>) {
    const prev = map.get(key) ?? Promise.resolve()
    const next = prev.then(fn)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    map.set(key, tail)
    void tail.then(() => {
      if (map.get(key) === tail) map.delete(key)
    })
    return next
  }

  private enqueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.chainOn(this.chains, taskId, fn)
  }

  /** 同步修改記憶體中的任務、推送事件，並依序寫入磁碟 */
  private async update(taskId: string, fn: (t: Task) => void): Promise<Task> {
    const t = this.task(taskId)
    fn(t)
    t.updatedAt = this.now()
    const snapshot = structuredClone(t)
    this.d.emit({ type: 'task', task: snapshot })
    await this.chainOn(this.saves, taskId, () => this.d.repo.saveTask(snapshot))
    return snapshot
  }

  /** 不等待寫入的 update（用在同步回呼裡），寫入失敗只記錄 */
  private persist(taskId: string, fn: (t: Task) => void) {
    this.update(taskId, fn).catch(logError('儲存任務失敗'))
  }

  private addTimeline(taskId: string, e: TimelineEntry): Promise<void> {
    const event: TimelineEvent = { id: this.newId(), ts: this.now(), ...e }
    return this.chainOn(this.timelineWrites, taskId, async () => {
      await this.d.repo.appendTimeline(taskId, event)
      this.d.emit({ type: 'timeline', taskId, event })
    })
  }

  /** 同步排入時間軸（排在之後的 runner 事件之前）；訊息已送出，寫入失敗只記錄 */
  private writeEntries(taskId: string, entries: TimelineEntry[]): Promise<void> {
    const writes = entries.map((e) => this.addTimeline(taskId, e))
    return Promise.all(writes).then(() => undefined, logError('寫入時間軸失敗'))
  }

  /** 改變任務狀態後送出訊息；送不出去就把狀態還原 */
  private async transitionAndSend(taskId: string, event: TaskEventType, send: () => Promise<void>) {
    this.assertCanSend(taskId, 'main')
    let prev: TaskStatus = 'clarifying'
    let next: TaskStatus = 'clarifying'
    await this.update(taskId, (t) => {
      next = transition(t.status, event)
      prev = t.status
      t.status = next
    })
    try {
      await send()
    } catch (e) {
      await this.update(taskId, (t) => {
        if (t.status === next) t.status = prev
      }).catch(logError('還原狀態失敗'))
      throw e
    }
  }

  // ───────── 建立任務與對話 ─────────

  async createTask(input: CreateTaskInput): Promise<Task> {
    if (this.shuttingDown) throw new Error('Harness 正在關閉')
    const settings = await this.d.repo.getSettings()
    const repo = (await this.d.repo.listRepos()).find((r) => r.id === input.repoId)
    if (!repo) throw new Error('找不到 repo')
    const request = input.request.trim()
    if (!request) throw new Error('請描述需求')
    const id = this.newId()
    const slug = `${this.now().slice(0, 10).replace(/-/g, '')}-${id}`
    const branch = `${settings.branchPrefix}${slug}`
    const worktreePath = join(settings.worktreeRoot, repo.name, slug)
    await this.d.git.createWorktree(repo.path, worktreePath, branch, input.baseBranch)
    const now = this.now()
    const task: Task = {
      id,
      repoId: repo.id,
      title: request.split('\n')[0].slice(0, 40),
      request,
      baseBranch: input.baseBranch,
      branch,
      worktreePath,
      model: input.model,
      status: 'clarifying',
      runState: 'idle',
      questions: [],
      decisions: [],
      specs: [],
      plan: [],
      branches: [],
      allowedCommands: [],
      approvedCommands: [],
      reportVersions: [],
      createdAt: now,
      updatedAt: now
    }
    this.tasks.set(id, task)
    await this.update(id, () => undefined)
    await this.send(id, 'main', request)
    return this.get(id)
  }

  /**
   * 送出使用者訊息：該 channel 有進行中的執行就插話進去，否則以 resume 開新一輪。
   * silent 不寫入 user_text（例如回答卡片、反問，UI 另有呈現）；display 是時間軸上顯示的文字，
   * ref 是 user_text 的標記（例如 IMPLEMENT_START_REF）；entries 是訊息被接受後要一起寫入的時間軸項目。
   * 訊息沒送出時不寫入任何時間軸。
   */
  async send(
    taskId: string,
    channel: Channel,
    text: string,
    opts: { display?: string; ref?: string; silent?: boolean; entries?: TimelineEntry[] } = {}
  ) {
    this.assertCanSend(taskId, channel)
    const userText: TimelineEntry = {
      channel,
      kind: 'user_text',
      text: opts.display ?? text,
      ...(opts.ref ? { ref: opts.ref } : {})
    }
    const entries: TimelineEntry[] = [...(opts.silent ? [] : [userText]), ...(opts.entries ?? [])]
    const key = runKey(taskId, channel)
    await this.chainOn(this.turnLocks, key, async () => {
      // 排隊等 lock 的期間任務可能已開始收尾或整理報告
      this.assertCanSend(taskId, channel)
      const prev = this.runs.get(key)
      if (prev?.send(text)) {
        await this.writeEntries(taskId, entries)
        return
      }
      // 上一段執行已關閉輸入但程序還沒結束：等它結束，同一個 channel 永遠只有一個 run
      if (prev) await this.settlePrevious(taskId, channel, prev)
      await this.startTurn(taskId, channel, text, entries)
    })
  }

  /** 等上一段執行結束；逾時就中止它，仍不結束就把它丟掉並拒絕這次送出（下一次會開新的一輪） */
  private async settlePrevious(taskId: string, channel: Channel, prev: AgentRun) {
    if (await settlesWithin(prev.done, this.prevRunTimeoutMs)) return
    console.warn('[TaskManager] 上一段執行逾時未結束，中止它')
    prev.abort()
    this.denyWaitersOf(prev, '執行已結束')
    if (await settlesWithin(prev.done, this.abortGraceMs)) return
    this.dropStuckRun(taskId, channel, prev)
    throw new Error('上一輪尚未結束，請先停止')
  }

  /** abort 之後仍不結束的執行：不再追蹤它，避免整個 channel 永遠被卡住 */
  private dropStuckRun(taskId: string, channel: Channel, run: AgentRun) {
    const key = runKey(taskId, channel)
    if (this.runs.get(key) !== run) return
    console.warn(`[TaskManager] 執行 ${key} 在中止後仍未結束，不再等待它`)
    this.runs.delete(key)
    this.denyWaitersOf(run, '執行已結束')
    this.forgetDenied(run)
    const branchId = branchIdOf(channel)
    if (!branchId) this.pendingCounter.delete(taskId)
    this.persist(taskId, (t) => {
      if (branchId) {
        const b = t.branches.find((x) => x.id === branchId)
        if (b) b.running = false
      } else if (t.runState === 'running' || t.runState === 'waiting_permission') {
        t.runState = 'idle'
      }
      this.syncPermission(t)
    })
  }

  private async startTurn(
    taskId: string,
    channel: Channel,
    prompt: string,
    entries: TimelineEntry[]
  ) {
    // 等上一段執行結束的期間任務可能已被丟棄或開始收尾
    this.assertCanSend(taskId, channel)
    const settings = await this.d.repo.getSettings()
    // 上面的 await 期間狀態可能又變了：建立執行前最後確認一次
    const t = this.assertCanSend(taskId, channel)
    const branchId = branchIdOf(channel)
    const branch = branchId ? t.branches.find((b) => b.id === branchId) : undefined
    if (branchId && !branch) throw new Error(`找不到分岔 ${branchId}`)
    const resume = branch ? (branch.sessionId ?? t.mainSessionId) : t.mainSessionId
    if (branch && !resume) throw new Error('主線尚未建立 session，無法分岔')

    // canUseTool 只會在執行開始後被呼叫，那時 owner.run 已經設好
    const owner: { run?: AgentRun } = {}
    const gateCtx: GateContext = {
      getPhase: () => (branch ? 'branch' : phaseOf(this.task(taskId).status)),
      worktreePath: t.worktreePath,
      // 每次判斷都讀目前的設定：設定頁移除允許的指令後，進行中的這一輪也立即適用
      getAllowedPatterns: () => [
        ...this.d.repo.cachedSettings().alwaysAllowedCommands,
        ...this.task(taskId).allowedCommands
      ],
      requestApproval: (req, signal) =>
        this.requestApproval(taskId, channel, owner.run, req, signal),
      onApproved: (command, pattern) => {
        this.persist(taskId, (x) => {
          if (command && !x.approvedCommands.includes(command)) x.approvedCommands.push(command)
          if (pattern && !x.allowedCommands.includes(pattern)) x.allowedCommands.push(pattern)
        })
      }
    }

    const options: Options = {
      cwd: t.worktreePath,
      model: t.model,
      resume,
      forkSession: branch && !branch.sessionId ? true : undefined,
      settingSources: settings.loadProjectSettings ? ['project'] : [],
      tools: BUILTIN_TOOLS,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: MAIN_SYSTEM_APPEND },
      mcpServers: {
        harness: this.d.createToolServer(
          this.sinkFor(taskId, channel),
          branch ? ['conclude_branch'] : MAIN_TOOLS
        )
      },
      canUseTool: createPermissionGate(gateCtx),
      // 專案設定的 allow 規則會在 canUseTool 之前生效；硬性規則放在 PreToolUse hook 才不會被繞過
      hooks: { PreToolUse: [{ hooks: [createPreToolUseHook(gateCtx)] }] },
      pathToClaudeCodeExecutable: this.d.getClaudePath(),
      // claude.ai 帳號上的連接器（Gmail、Notion…）不載入：PermissionGate 一律拒絕，只會佔用 context，
      // Claude 還會在回覆裡提到它們
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }
    }

    const run = new AgentRun(this.d.queryFn, { options, firstPrompt: prompt }, (e) => {
      void this.enqueue(taskId, () => this.onRunnerEvent(taskId, channel, e))
    })
    owner.run = run
    this.runs.set(runKey(taskId, channel), run)
    // 訊息已被接受：同步排入時間軸，保證排在這段執行的任何事件之前
    const written = this.writeEntries(taskId, entries)
    run.done.then(
      () => this.onRunDone(taskId, channel, run),
      (err: unknown) => this.onRunDone(taskId, channel, run, err)
    )
    // 執行已經開始，寫入失敗不應讓呼叫端以為訊息沒送出
    await this.update(taskId, (x) => {
      if (branchId) {
        const b = x.branches.find((bb) => bb.id === branchId)
        if (b) {
          b.running = true
          b.error = undefined
        }
      } else {
        x.runState = 'running'
        x.error = undefined
      }
    }).catch(logError('儲存任務失敗'))
    await written
  }

  private onRunDone(taskId: string, channel: Channel, run: AgentRun, err?: unknown) {
    // 執行結束後不會再有人處理它的核准請求
    this.denyWaitersOf(run, '執行已結束')
    return this.enqueue(taskId, async () => {
      const key = runKey(taskId, channel)
      // send() 可能已在這段收尾排到之前開了下一段執行：那時不要動執行狀態，只記錄錯誤
      const current = this.runs.get(key) === run
      if (current) this.runs.delete(key)
      // 這段執行的工具結果都已處理完（排在這之前）：還記著的拒絕不會再用到
      this.forgetDenied(run)
      const branchId = branchIdOf(channel)
      if (current && !branchId) this.pendingCounter.delete(taskId)
      await this.update(taskId, (t) => {
        if (current) {
          if (branchId) {
            const b = t.branches.find((x) => x.id === branchId)
            if (b) b.running = false
          } else if (t.runState === 'running' || t.runState === 'waiting_permission') {
            t.runState = 'idle'
          }
        }
        if (err) {
          this.setRunError(t, channel, errorMessage(err))
          if (current && !branchId && t.runState !== 'finalizing') t.runState = 'error'
        }
        this.syncPermission(t)
      })
    }).catch(logError('收尾失敗'))
  }

  /** 執行錯誤記在所屬的 channel：分岔的錯誤顯示在分岔面板，不打斷主線 */
  private setRunError(t: Task, channel: Channel, message: string) {
    const branchId = branchIdOf(channel)
    if (!branchId) {
      t.error = message
      return
    }
    const b = t.branches.find((x) => x.id === branchId)
    if (b) b.error = message
  }

  private async onRunnerEvent(taskId: string, channel: Channel, e: RunnerEvent) {
    switch (e.type) {
      case 'session':
        await this.update(taskId, (t) => {
          const branchId = branchIdOf(channel)
          if (!branchId) t.mainSessionId = e.sessionId
          else {
            const b = t.branches.find((x) => x.id === branchId)
            if (b) b.sessionId = e.sessionId
          }
        })
        return
      case 'assistant_text': {
        const qid = channel === 'main' ? this.pendingCounter.get(taskId) : undefined
        if (qid) {
          await this.update(taskId, (t) => {
            const q = t.questions.find((x) => x.id === qid)
            if (!q) return
            const last = q.followups.at(-1)
            if (last?.role === 'assistant') last.text += `\n\n${e.text}`
            else q.followups.push({ role: 'assistant', text: e.text })
          })
          return
        }
        await this.addTimeline(taskId, { channel, kind: 'assistant_text', text: e.text })
        return
      }
      case 'tool_call':
        if (!e.name.startsWith('mcp__harness__')) {
          await this.addTimeline(taskId, {
            channel,
            kind: 'tool_call',
            tool: { id: e.id, name: e.name, input: e.input }
          })
        }
        return
      case 'tool_result': {
        const denied = this.deniedToolUses.delete(e.id)
        if (e.isError) {
          await this.addTimeline(taskId, {
            channel,
            kind: 'tool_result',
            text: e.text.slice(0, 2000),
            tool: { id: e.id, name: '', isError: true, ...(denied ? { denied: true } : {}) }
          })
        }
        return
      }
      case 'turn_end':
        // 使用者停止造成的結束（interrupted）不算錯誤
        if (!e.ok && !e.interrupted) {
          await this.update(taskId, (t) => {
            this.setRunError(t, channel, e.error || 'Claude 執行失敗')
          })
        }
        return
      case 'notice':
        await this.addTimeline(taskId, { channel, kind: 'system', text: e.message })
    }
  }

  // ───────── 工具回呼 ─────────

  private sinkFor(taskId: string, channel: Channel): ToolSink {
    return {
      askUser: (a) =>
        this.enqueue(taskId, async () => {
          // 回答反問後更新同一張卡片：卡片留在原位（反問與回答都在卡片裡）
          const counterReply = this.pendingCounter.get(taskId) === a.question_id
          if (counterReply) this.pendingCounter.delete(taskId)
          // 其他情況（新問題、重新提問已回答或還開著的問題）：時間軸最新的位置再放一張卡片，
          // 畫面只畫最後一張，使用者在底部就看得到（例如帶回分岔結論後 Claude 重新送出問題）
          let added = !counterReply
          await this.update(taskId, (t) => {
            const fields = {
              text: a.question,
              options: a.options,
              recommendedOptionId: a.recommended_option_id,
              allowFreeText: a.allow_free_text,
              context: a.context
            }
            const q = t.questions.find((x) => x.id === a.question_id)
            if (q) {
              Object.assign(q, fields, { status: 'open' as const, answer: undefined })
            } else {
              added = true
              t.questions.push({
                id: a.question_id,
                ...fields,
                status: 'open',
                followups: [],
                askedAt: this.now()
              })
            }
          })
          if (added)
            await this.addTimeline(taskId, { channel, kind: 'question', ref: a.question_id })
        }),
      proposeSpec: (a) =>
        this.enqueue(taskId, async () => {
          let version = 0
          await this.update(taskId, (t) => {
            const next = transition(t.status, 'SPEC_PROPOSED')
            version = t.specs.length + 1
            t.specs.push({
              version,
              title: a.title,
              summary: a.summary,
              inScope: a.in_scope,
              outOfScope: a.out_of_scope,
              decisions: a.decisions,
              steps: a.steps,
              acceptance: a.acceptance,
              createdAt: this.now()
            })
            t.title = a.title
            t.status = next
          })
          await this.addTimeline(taskId, { channel: 'main', kind: 'spec', ref: String(version) })
        }),
      updatePlan: (a) =>
        this.enqueue(taskId, async () => {
          await this.update(taskId, (t) => {
            t.plan = a.steps
          })
        }),
      concludeBranch: (a) =>
        this.enqueue(taskId, async () => {
          const branchId = branchIdOf(channel)
          if (!branchId) throw new Error('conclude_branch 只能在分岔中使用')
          await this.update(taskId, (t) => {
            const b = t.branches.find((x) => x.id === branchId)
            if (!b) throw new Error(`找不到分岔 ${branchId}`)
            if (b.status === 'concluded') throw new Error('這個分岔已經帶回主線')
            b.conclusion = { decision: a.decision, rationale: a.rationale, deferred: a.deferred }
            b.status = 'concluding'
          })
        }),
      submitReport: (input) =>
        this.enqueue(taskId, async () => {
          if (this.task(taskId).status !== 'implementing')
            throw new Error('只有實作階段可以提交報告')
          if (this.finalizing.has(taskId)) throw new Error('報告已提交，正在整理中')
          const run = this.runs.get(runKey(taskId, 'main'))
          const before = this.task(taskId).runState
          this.finalizing.add(taskId)
          try {
            await this.update(taskId, (t) => {
              t.runState = 'finalizing'
            })
          } catch (e) {
            // 記憶體中已改成 finalizing：還原，不然主線會一直卡在整理中
            this.finalizing.delete(taskId)
            this.persist(taskId, (t) => {
              if (t.runState === 'finalizing') t.runState = before
            })
            throw e
          }
          const job: Promise<void> = this.finalizeReport(taskId, input, run).finally(() => {
            if (this.reportJobs.get(taskId) === job) this.reportJobs.delete(taskId)
          })
          this.reportJobs.set(taskId, job)
        })
    }
  }

  // ───────── 問題卡片 ─────────

  async answerQuestion(
    taskId: string,
    questionId: string,
    answer: { optionId?: string; text?: string }
  ) {
    const q = this.assertCanSend(taskId, 'main').questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`找不到問題 ${questionId}`)
    const label = answer.optionId
      ? q.options.find((o) => o.id === answer.optionId)?.label
      : undefined
    if (answer.optionId && !label) throw new Error(`找不到選項 ${answer.optionId}`)
    const text = answer.text?.trim() || undefined
    if (!label && !text) throw new Error('請選擇選項或輸入回答')
    const before = { status: q.status, answer: q.answer }
    const next = { optionId: answer.optionId, text }
    await this.update(taskId, () => {
      q.status = 'answered'
      q.answer = next
    })
    const body = [label, text].filter(Boolean).join('；')
    try {
      await this.send(taskId, 'main', msg.answer(questionId, answer.optionId, body), {
        silent: true
      })
    } catch (e) {
      await this.update(taskId, () => {
        if (q.answer === next) Object.assign(q, before)
      }).catch(logError('還原問題卡片失敗'))
      throw e
    }
  }

  async counterQuestion(taskId: string, questionId: string, text: string) {
    const body = text.trim()
    if (!body) throw new Error('請輸入反問內容')
    const q = this.assertCanSend(taskId, 'main').questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`找不到問題 ${questionId}`)
    const followup = { role: 'user' as const, text: body }
    await this.update(taskId, () => {
      q.followups.push(followup)
    })
    // 送出前就要設定：新一輪的文字回覆可能比 send() 返回更早到
    this.pendingCounter.set(taskId, questionId)
    try {
      await this.send(taskId, 'main', msg.counterQuestion(questionId, body), { silent: true })
    } catch (e) {
      if (this.pendingCounter.get(taskId) === questionId) this.pendingCounter.delete(taskId)
      await this.update(taskId, () => {
        q.followups = q.followups.filter((f) => f !== followup)
      }).catch(logError('還原問題卡片失敗'))
      throw e
    }
  }

  // ───────── 分岔 ─────────

  async openBranch(
    taskId: string,
    input: { title: string; fromQuestionId?: string; seed?: string }
  ): Promise<Branch> {
    const t = this.openTask(taskId)
    if (!t.mainSessionId) throw new Error('請等 Claude 在主線回覆至少一次後再分岔')
    const branchId = nextId(
      'b',
      t.branches.map((b) => b.id)
    )
    const channel: Channel = `branch:${branchId}`
    this.assertCanSend(taskId, channel)
    // 主線在執行中時 session 還在變動，fork 出來的內容不確定
    if (this.runs.get(runKey(taskId, 'main'))?.active)
      throw new Error('主線正在執行，請等它停下來再分岔')
    const q = input.fromQuestionId
      ? t.questions.find((x) => x.id === input.fromQuestionId)
      : undefined
    if (input.fromQuestionId && !q) throw new Error(`找不到問題 ${input.fromQuestionId}`)
    const seed = [
      input.seed?.trim(),
      q && `來源問題：${q.text}`,
      q?.followups.length
        ? `之前的反問：\n${q.followups.map((f) => `${f.role === 'user' ? '使用者' : 'Claude'}：${f.text}`).join('\n')}`
        : undefined
    ]
      .filter(Boolean)
      .join('\n')
    const branch: Branch = {
      id: branchId,
      title: input.title.trim() || '分岔討論',
      fromQuestionId: input.fromQuestionId,
      status: 'open',
      running: false,
      createdAt: this.now()
    }
    await this.update(taskId, (x) => {
      x.branches.push(branch)
    })
    try {
      await this.send(taskId, channel, msg.branchOpen(branch.title, seed), {
        display: input.seed?.trim() || `開始討論：${branch.title}`
      })
    } catch (e) {
      await this.update(taskId, (x) => {
        x.branches = x.branches.filter((b) => b !== branch || b.sessionId)
      }).catch(logError('還原分岔失敗'))
      throw e
    }
    return structuredClone(branch)
  }

  async concludeBranch(taskId: string, branchId: string) {
    const channel: Channel = `branch:${branchId}`
    const b = this.assertCanSend(taskId, channel).branches.find((x) => x.id === branchId)
    if (!b) throw new Error(`找不到分岔 ${branchId}`)
    if (b.status === 'concluded') throw new Error('這個分岔已經帶回主線')
    await this.send(taskId, channel, msg.conclude(), { silent: true })
  }

  /** 使用者確認（可編輯過的）結論：記成決策並送回主線 */
  async confirmBranch(taskId: string, branchId: string, edited?: BranchConclusion) {
    const t = this.assertCanSend(taskId, 'main')
    const b = t.branches.find((x) => x.id === branchId)
    if (!b) throw new Error(`找不到分岔 ${branchId}`)
    if (b.status === 'concluded') throw new Error('這個分岔已經帶回主線')
    const c = edited ?? b.conclusion
    if (!c) throw new Error('分岔還沒有結論')
    const before = { status: b.status, conclusion: b.conclusion }
    const decisionId = nextId(
      'd',
      t.decisions.map((d) => d.id)
    )
    await this.update(taskId, (x) => {
      b.conclusion = c
      b.status = 'concluded'
      x.decisions.push({
        id: decisionId,
        text: c.decision,
        rationale: c.rationale,
        deferred: c.deferred,
        source: { type: 'branch', ref: branchId }
      })
    })
    try {
      await this.send(taskId, 'main', msg.branchConclusion(branchId, c), {
        silent: true,
        entries: [{ channel: 'main', kind: 'decision', ref: decisionId }]
      })
    } catch (e) {
      await this.update(taskId, (x) => {
        Object.assign(b, before)
        x.decisions = x.decisions.filter((d) => d.id !== decisionId)
      }).catch(logError('還原分岔結論失敗'))
      throw e
    }
  }

  // ───────── 規格 ─────────

  approveSpec(taskId: string) {
    return this.transitionAndSend(taskId, 'SPEC_APPROVED', () =>
      this.send(taskId, 'main', msg.specApproved(), {
        display: msgDisplay.specApproved,
        ref: IMPLEMENT_START_REF
      })
    )
  }

  async requestSpecChanges(taskId: string, text: string) {
    const body = text.trim()
    if (!body) throw new Error('請說明要修改的地方')
    await this.transitionAndSend(taskId, 'SPEC_CHANGES_REQUESTED', () =>
      this.send(taskId, 'main', msg.specFeedback(body), { display: msgDisplay.specFeedback(body) })
    )
  }

  // ───────── 指令核准 ─────────

  /** 依等待中的請求更新卡片與主線狀態（分岔的請求不改變主線的 runState） */
  private syncPermission(t: Task) {
    const waiting = [...this.permissionWaiters.values()].filter((w) => w.taskId === t.id)
    t.pendingPermission = waiting[0]?.request
    if (waiting.some((w) => w.channel === 'main')) {
      if (t.runState === 'running') t.runState = 'waiting_permission'
    } else if (t.runState === 'waiting_permission') {
      t.runState = 'running'
    }
  }

  private forgetDenied(run: AgentRun) {
    for (const [id, r] of this.deniedToolUses) if (r === run) this.deniedToolUses.delete(id)
  }

  private denyWaitersOf(run: AgentRun, message: string) {
    for (const w of [...this.permissionWaiters.values()]) {
      if (w.run === run) w.resolve({ allow: false, message })
    }
  }

  private requestApproval(
    taskId: string,
    channel: Channel,
    run: AgentRun | undefined,
    req: ApprovalRequest,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    if (signal.aborted) return Promise.resolve({ allow: false, message: '已取消' })
    const id = this.newId()
    return new Promise((resolve) => {
      let settled = false
      const onAbort = () => finish({ allow: false, message: '已取消' })
      const finish = (d: PermissionDecision) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        this.permissionWaiters.delete(id)
        this.persist(taskId, (t) => this.syncPermission(t))
        resolve(d)
      }
      this.permissionWaiters.set(id, {
        taskId,
        channel,
        run,
        request: {
          id,
          taskId,
          channel,
          toolUseId: req.toolUseId,
          toolName: req.toolName,
          input: req.input,
          suggestedPattern: req.suggestedPattern,
          createdAt: this.now()
        },
        resolve: finish
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.persist(taskId, (t) => this.syncPermission(t))
    })
  }

  async resolvePermission(taskId: string, requestId: string, decision: PermissionDecision) {
    const w = this.permissionWaiters.get(requestId)
    if (!w || w.taskId !== taskId) throw new Error('這個核准請求已經失效')
    if (!decision.allow && w.request.toolUseId) this.deniedToolUses.set(w.request.toolUseId, w.run)
    w.resolve(decision)
  }

  // ───────── 停止與續接 ─────────

  async stop(taskId: string, channel: Channel) {
    for (const w of [...this.permissionWaiters.values()]) {
      if (w.taskId === taskId && w.channel === channel)
        w.resolve({ allow: false, message: '使用者停止了執行' })
    }
    await this.runs.get(runKey(taskId, channel))?.interrupt()
  }

  /**
   * 關閉 app 前呼叫：之後拒絕新任務與新訊息，拒絕等待中的核准、中止所有執行與報告整理中的驗證指令。
   * 先等執行、報告整理與進行中的收尾操作（開 PR／合併／丟棄）結束，再寫入狀態；兩段各最多 timeoutMs，
   * 總共不超過 2 × timeoutMs，不讓關閉卡住。被中止的主線標為已中斷，下次啟動可「繼續」。
   */
  async shutdown(timeoutMs = this.abortGraceMs) {
    this.shuttingDown = true
    for (const w of [...this.permissionWaiters.values()])
      w.resolve({ allow: false, message: 'Harness 正在關閉' })
    const runs = [...this.runs.entries()]
    runs.forEach(([, r]) => r.abort())
    this.reportAborts.forEach((a) => a.abort())
    await settlesWithin(
      Promise.all([
        ...runs.map(([, r]) => r.done.catch(() => undefined)),
        ...this.reportJobs.values(),
        ...[...this.finishJobs.values()].map((p) => p.catch(() => undefined))
      ]),
      timeoutMs
    )
    const taskIds = new Set(runs.map(([key]) => key.slice(0, key.indexOf('|'))))
    const marks = [...taskIds].map((taskId) =>
      // 排在 onRunDone 的收尾之後，才不會被它改回 idle
      this.enqueue(taskId, () =>
        this.update(taskId, (t) => {
          const mainAborted = runs.some(([key]) => key === runKey(taskId, 'main'))
          if (
            mainAborted &&
            (t.runState === 'idle' ||
              t.runState === 'running' ||
              t.runState === 'waiting_permission')
          )
            t.runState = 'interrupted'
          t.branches.forEach((b) => {
            b.running = false
          })
          this.syncPermission(t)
        })
      )
    )
    await settlesWithin(Promise.all(marks), timeoutMs)
    // 中止後仍不結束的執行不會走到 onRunDone
    this.deniedToolUses.clear()
  }

  async resume(taskId: string) {
    const t = this.task(taskId)
    // 第一輪還沒拿到 session 就中斷：沒有可續接的對話，重新送出需求
    if (!t.mainSessionId) {
      await this.send(taskId, 'main', t.request, { display: msgDisplay.resume })
      return
    }
    await this.send(taskId, 'main', msg.resume(), { display: msgDisplay.resume })
  }

  // ───────── 報告 ─────────

  /** 等提交報告的那段執行結束後：commit、算 diff、實跑驗證指令、存報告 */
  private async finalizeReport(taskId: string, input: ReportInput, run?: AgentRun) {
    const abort = new AbortController()
    this.reportAborts.set(taskId, abort)
    const assertNotAborted = () => {
      if (abort.signal.aborted) throw new Error('Harness 正在關閉')
    }
    try {
      await run?.done.catch(() => undefined)
      assertNotAborted()
      const t = this.task(taskId)
      const version = t.reportVersions.length + 1
      const commit =
        (await this.d.git.commitAll(t.worktreePath, `${t.title}（Harness 報告 v${version}）`)) ??
        undefined
      const [diff, stats] = await Promise.all([
        this.d.git.diff(t.worktreePath, t.baseBranch),
        this.d.git.diffStats(t.worktreePath, t.baseBranch)
      ])
      const settings = await this.d.repo.getSettings()
      // 只自動執行本任務核准過或在允許清單中的指令（串接的指令只認完整核准過的）
      const isAllowed = (c: string) => {
        const x = this.task(taskId)
        if (x.approvedCommands.includes(c)) return true
        if (hasShellOperators(c)) return false
        return [...settings.alwaysAllowedCommands, ...x.allowedCommands].some((p) =>
          matchesPattern(c, p)
        )
      }
      const verification = await this.d.verify(
        t.worktreePath,
        input.verification.map((v) => v.command),
        isAllowed,
        abort.signal
      )
      // 驗證被中止的結果不完整：不存報告，下次啟動可「繼續」重新整理
      assertNotAborted()
      const report: Report = {
        version,
        taskId,
        input,
        diff,
        stats,
        verification,
        commit,
        createdAt: this.now()
      }
      await this.d.repo.saveReport(report)
      await this.update(taskId, (x) => {
        const next = transition(x.status, 'REPORT_SUBMITTED')
        x.reportVersions.push(version)
        x.status = next
        x.runState = 'idle'
        x.error = undefined
        // 與進入 reviewing 同一步結束「整理中」，中間沒有可以插進其他操作的空檔
        this.finalizing.delete(taskId)
      })
      await this.addTimeline(taskId, { channel: 'main', kind: 'report', ref: String(version) })
    } catch (e) {
      const aborted = abort.signal.aborted
      await this.update(taskId, (x) => {
        x.runState = aborted ? 'interrupted' : 'error'
        x.error = aborted ? '關閉 app 時報告尚未整理完成' : `整理報告失敗：${errorMessage(e)}`
        this.finalizing.delete(taskId)
      }).catch(logError('儲存任務失敗'))
    } finally {
      if (this.reportAborts.get(taskId) === abort) this.reportAborts.delete(taskId)
    }
  }

  getReport(taskId: string, version: number) {
    return this.d.repo.getReport(taskId, version)
  }

  async submitReportFeedback(taskId: string, items: FeedbackItem[], overall?: string) {
    const note = overall?.trim() || undefined
    if (!items.length && !note) throw new Error('請至少留一則回饋')
    await this.transitionAndSend(taskId, 'REPORT_FEEDBACK', () =>
      this.send(taskId, 'main', msg.reportFeedback(items, note), {
        display: msgDisplay.reportFeedback(items.length, !!note),
        ref: IMPLEMENT_START_REF
      })
    )
  }

  // ───────── 收尾 ─────────

  private async repoOf(t: Task) {
    const repo = (await this.d.repo.listRepos()).find((r) => r.id === t.repoId)
    if (!repo) throw new Error('找不到 repo')
    return repo
  }

  /** 開 PR／合併／丟棄同一時間只做一個，期間也拒絕送訊息與改變狀態的操作 */
  private async exclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    this.task(taskId)
    if (this.finishing.has(taskId)) throw new Error('另一個收尾操作正在進行，請稍候')
    this.finishing.add(taskId)
    const job = fn()
    this.finishJobs.set(taskId, job)
    try {
      return await job
    } finally {
      this.finishing.delete(taskId)
      this.finishJobs.delete(taskId)
    }
  }

  private assertReviewable(t: Task, what: string) {
    if (t.status !== 'reviewing') throw new Error(`只有待審閱的任務可以${what}`)
    if (this.runs.get(runKey(t.id, 'main'))?.active)
      throw new Error(`Claude 正在執行，請等它停下來再${what}`)
  }

  createPullRequest(taskId: string): Promise<string> {
    return this.exclusive(taskId, async () => {
      const t = this.task(taskId)
      this.assertReviewable(t, '開 PR')
      const report = await this.d.repo.getReport(taskId, t.reportVersions.at(-1)!)
      const url = await this.d.git.pushAndOpenPr(
        t.worktreePath,
        t.branch,
        t.baseBranch,
        t.specs.at(-1)?.title ?? t.title,
        prBody(report)
      )
      // PR 已經開了：直接記錄結果，不能因為狀態檢查失敗而遺失 URL
      await this.update(taskId, (x) => {
        x.prUrl = url
        x.status = 'done'
      })
      return url
    })
  }

  merge(taskId: string): Promise<void> {
    return this.exclusive(taskId, async () => {
      const t = this.task(taskId)
      this.assertReviewable(t, '合併')
      await this.d.git.merge((await this.repoOf(t)).path, t.branch, t.baseBranch)
      await this.update(taskId, (x) => {
        x.status = 'done'
      })
    })
  }

  /** 中止所有執行、移除 worktree 與分支；已完成（開過 PR／合併）的任務只清掉 worktree */
  discard(taskId: string): Promise<void> {
    return this.exclusive(taskId, async () => {
      const t = this.task(taskId)
      if (this.finalizing.has(taskId)) throw new Error('正在整理報告，請稍候再丟棄')
      for (const w of [...this.permissionWaiters.values()]) {
        if (w.taskId === taskId) w.resolve({ allow: false, message: '任務已丟棄' })
      }
      const runs = this.runsOf(taskId)
      runs.forEach(([, r]) => r.abort())
      // abort 後仍不結束的程序不要卡住丟棄：不再追蹤它
      await Promise.all(
        runs.map(async ([key, r]) => {
          if (await settlesWithin(r.done, this.abortGraceMs)) return
          this.dropStuckRun(taskId, key.slice(taskId.length + 1) as Channel, r)
        })
      )
      await this.d.git.removeWorktree((await this.repoOf(t)).path, t.worktreePath, t.branch)
      await this.update(taskId, (x) => {
        if (x.status !== 'done' && x.status !== 'discarded')
          x.status = transition(x.status, 'DISCARDED')
        x.runState = 'idle'
        x.pendingPermission = undefined
      })
    })
  }

  changedFiles(taskId: string) {
    const t = this.task(taskId)
    return this.d.git.workingStats(t.worktreePath, t.baseBranch)
  }
}
