// src/main/tasks/taskManager.ts
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent, CreateTaskInput } from '@shared/ipc'
import { msg } from '@shared/protocol'
import type { ReportInput } from '@shared/report'
import type {
  Channel,
  PermissionDecision,
  Task,
  TimelineEvent,
  VerificationResult
} from '@shared/types'
import { AgentRun, type QueryFn, type RunnerEvent } from '../agent/agentRun'
import { MAIN_SYSTEM_APPEND } from '../agent/prompts'
import type { GitLike } from '../git/gitService'
import {
  type ApprovalRequest,
  createPermissionGate,
  createPreToolUseHook,
  type GateContext
} from '../permissions/gate'
import type { Repository } from '../store/repository'
import type { HarnessToolName, ToolSink } from '../tools/harnessTools'
import { phaseOf, transition } from './stateMachine'

type McpServer = NonNullable<Options['mcpServers']>[string]

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
    isAllowed: (c: string) => boolean
  ) => Promise<VerificationResult[]>
  now?: () => string
  newId?: () => string
}

const MAIN_TOOLS: HarnessToolName[] = ['ask_user', 'propose_spec', 'update_plan', 'submit_report']
const runKey = (taskId: string, channel: Channel) => `${taskId}|${channel}`
const branchIdOf = (channel: Channel) =>
  channel.startsWith('branch:') ? channel.slice('branch:'.length) : undefined
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class TaskManager {
  private tasks = new Map<string, Task>()
  /** 每個 channel（taskId|channel）最多一段執行 */
  private runs = new Map<string, AgentRun>()
  /** 串起每個任務的 runner 事件與工具回呼，依發生順序處理 */
  private chains = new Map<string, Promise<unknown>>()
  /** 每個任務的 task.json 寫入依序進行 */
  private saves = new Map<string, Promise<void>>()
  /** 每個任務的時間軸寫入依序進行（磁碟順序＝推送順序） */
  private timelineWrites = new Map<string, Promise<void>>()
  /** 每個 channel 的「決定插話或開新一輪」依序進行，避免同時開出兩段執行 */
  private turnLocks = new Map<string, Promise<unknown>>()
  /** 主線正在回答反問的問題卡片：這段期間的文字回覆寫進卡片 */
  private pendingCounter = new Map<string, string>()
  private finalizing = new Map<string, Promise<void>>()
  private readonly now: () => string
  private readonly newId: () => string

  constructor(private d: TaskManagerDeps) {
    this.now = d.now ?? (() => new Date().toISOString())
    this.newId = d.newId ?? (() => randomUUID().slice(0, 8))
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

  get(taskId: string): Task {
    const t = this.tasks.get(taskId)
    if (!t) throw new Error(`找不到任務 ${taskId}`)
    return t
  }

  timeline(taskId: string) {
    return this.d.repo.readTimeline(taskId)
  }

  /** 等這個任務的所有執行、事件與報告整理結束（測試用，也用於關閉 app 前） */
  async whenIdle(taskId: string) {
    for (let i = 0; i < 100; i++) {
      const runs = this.runsOf(taskId).map(([, r]) => r.done.catch(() => undefined))
      await Promise.all([...runs, this.finalizing.get(taskId)])
      await Promise.all(
        [...this.turnLocks.entries()].filter(([k]) => k.startsWith(`${taskId}|`)).map(([, p]) => p)
      )
      await this.chains.get(taskId)
      await this.saves.get(taskId)
      await this.timelineWrites.get(taskId)
      await new Promise((r) => setTimeout(r, 0))
      if (this.runsOf(taskId).length === 0 && !this.finalizing.has(taskId)) return
    }
    throw new Error(`whenIdle: 任務 ${taskId} 一直沒有停下來`)
  }

  // ───────── 內部工具 ─────────

  private runsOf(taskId: string) {
    return [...this.runs.entries()].filter(([k]) => k.startsWith(`${taskId}|`))
  }

  private enqueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(taskId) ?? Promise.resolve()
    const next = prev.then(fn)
    this.chains.set(
      taskId,
      next.catch(() => undefined)
    )
    return next
  }

  private withTurnLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.turnLocks.get(key) ?? Promise.resolve()
    const next = prev.then(fn)
    const tail = next.catch(() => undefined)
    this.turnLocks.set(key, tail)
    void tail.then(() => {
      if (this.turnLocks.get(key) === tail) this.turnLocks.delete(key)
    })
    return next
  }

  /** 同步修改記憶體中的任務、推送事件，並依序寫入磁碟 */
  private async update(taskId: string, fn: (t: Task) => void): Promise<Task> {
    const t = this.get(taskId)
    fn(t)
    t.updatedAt = this.now()
    const snapshot = structuredClone(t)
    const prev = this.saves.get(taskId) ?? Promise.resolve()
    const save = prev.then(() => this.d.repo.saveTask(snapshot))
    this.saves.set(
      taskId,
      save.catch(() => undefined)
    )
    this.d.emit({ type: 'task', task: snapshot })
    await save
    return snapshot
  }

  private addTimeline(taskId: string, e: Omit<TimelineEvent, 'id' | 'ts'>): Promise<void> {
    const event: TimelineEvent = { id: this.newId(), ts: this.now(), ...e }
    const prev = this.timelineWrites.get(taskId) ?? Promise.resolve()
    const write = prev.then(async () => {
      await this.d.repo.appendTimeline(taskId, event)
      this.d.emit({ type: 'timeline', taskId, event })
    })
    this.timelineWrites.set(
      taskId,
      write.catch(() => undefined)
    )
    return write
  }

  // ───────── 建立任務與對話 ─────────

  async createTask(input: CreateTaskInput): Promise<Task> {
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
    return structuredClone(this.get(id))
  }

  /**
   * 送出使用者訊息：該 channel 有進行中的執行就插話進去，否則以 resume 開新一輪。
   * silent 不寫入時間軸（例如回答卡片、反問，UI 另有呈現）；display 是時間軸上顯示的文字。
   */
  async send(
    taskId: string,
    channel: Channel,
    text: string,
    opts: { display?: string; silent?: boolean } = {}
  ) {
    const t = this.get(taskId)
    if (t.status === 'done' || t.status === 'discarded') throw new Error('任務已結束')
    if (channel === 'main' && this.finalizing.has(taskId))
      throw new Error('正在整理報告，請稍候再送出')
    if (!opts.silent)
      await this.addTimeline(taskId, { channel, kind: 'user_text', text: opts.display ?? text })
    const key = runKey(taskId, channel)
    await this.withTurnLock(key, async () => {
      const prev = this.runs.get(key)
      if (prev?.send(text)) return
      // 上一段執行已關閉輸入但程序還沒結束：等它結束，同一個 channel 永遠只有一個 run
      if (prev) await prev.done.catch(() => undefined)
      await this.startTurn(taskId, channel, text)
    })
  }

  private async startTurn(taskId: string, channel: Channel, prompt: string) {
    const t = this.get(taskId)
    const settings = await this.d.repo.getSettings()
    const branchId = branchIdOf(channel)
    const branch = branchId ? t.branches.find((b) => b.id === branchId) : undefined
    if (branchId && !branch) throw new Error(`找不到分岔 ${branchId}`)
    const resume = branch ? (branch.sessionId ?? t.mainSessionId) : t.mainSessionId
    if (branch && !resume) throw new Error('主線尚未建立 session，無法分岔')

    const gateCtx: GateContext = {
      getPhase: () => (branch ? 'branch' : phaseOf(this.get(taskId).status)),
      worktreePath: t.worktreePath,
      getAllowedPatterns: () => [
        ...settings.alwaysAllowedCommands,
        ...this.get(taskId).allowedCommands
      ],
      requestApproval: (req, signal) => this.requestApproval(taskId, channel, req, signal),
      onApproved: (command, pattern) => {
        void this.update(taskId, (x) => {
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
      pathToClaudeCodeExecutable: this.d.getClaudePath()
    }

    const run = new AgentRun(this.d.queryFn, { options, firstPrompt: prompt }, (e) => {
      void this.enqueue(taskId, () => this.onRunnerEvent(taskId, channel, e))
    })
    this.runs.set(runKey(taskId, channel), run)
    // 先掛上收尾，update 的寫入失敗也不會漏掉
    run.done.then(
      () => this.onRunDone(taskId, channel, run),
      (err: unknown) => this.onRunDone(taskId, channel, run, err)
    )
    await this.update(taskId, (x) => {
      if (branchId) {
        const b = x.branches.find((bb) => bb.id === branchId)
        if (b) b.running = true
      } else {
        x.runState = 'running'
        x.error = undefined
      }
    })
  }

  private onRunDone(taskId: string, channel: Channel, run: AgentRun, err?: unknown) {
    return this.enqueue(taskId, async () => {
      const key = runKey(taskId, channel)
      // send() 可能已在這段收尾排到之前開了下一段執行：那時不要動執行狀態，只記錄錯誤
      const current = this.runs.get(key) === run
      if (current) this.runs.delete(key)
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
          t.error = errorMessage(err)
          if (current && !branchId && t.runState !== 'finalizing') t.runState = 'error'
        }
      })
    }).catch((e: unknown) => console.error('[TaskManager] 收尾失敗', e))
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
      case 'tool_result':
        if (e.isError) {
          await this.addTimeline(taskId, {
            channel,
            kind: 'tool_result',
            text: e.text.slice(0, 2000),
            tool: { id: e.id, name: '', isError: true }
          })
        }
        return
      case 'turn_end':
        // 使用者停止造成的結束（interrupted）不算錯誤
        if (!e.ok && !e.interrupted) {
          await this.update(taskId, (t) => {
            t.error = e.error || 'Claude 執行失敗'
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
          if (this.pendingCounter.get(taskId) === a.question_id) this.pendingCounter.delete(taskId)
          let created = false
          await this.update(taskId, (t) => {
            const fields = {
              text: a.question,
              options: a.options,
              recommendedOptionId: a.recommended_option_id,
              allowFreeText: a.allow_free_text,
              context: a.context
            }
            const q = t.questions.find((x) => x.id === a.question_id)
            if (q) Object.assign(q, fields, { status: 'open' as const, answer: undefined })
            else {
              created = true
              t.questions.push({
                id: a.question_id,
                ...fields,
                status: 'open',
                followups: [],
                askedAt: this.now()
              })
            }
          })
          if (created)
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
      concludeBranch: () => this.enqueue(taskId, async () => undefined),
      submitReport: (input) =>
        this.enqueue(taskId, async () => {
          if (this.get(taskId).status !== 'implementing')
            throw new Error('只有實作階段可以提交報告')
          if (this.finalizing.has(taskId)) throw new Error('報告已提交，正在整理中')
          const run = this.runs.get(runKey(taskId, 'main'))
          await this.update(taskId, (t) => {
            t.runState = 'finalizing'
          })
          const job = this.finalizeReport(taskId, input, run).finally(() =>
            this.finalizing.delete(taskId)
          )
          this.finalizing.set(taskId, job)
        })
    }
  }

  // ───────── 問題卡片 ─────────

  async answerQuestion(
    taskId: string,
    questionId: string,
    answer: { optionId?: string; text?: string }
  ) {
    const q = this.get(taskId).questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`找不到問題 ${questionId}`)
    const label = answer.optionId
      ? q.options.find((o) => o.id === answer.optionId)?.label
      : undefined
    if (answer.optionId && !label) throw new Error(`找不到選項 ${answer.optionId}`)
    const text = answer.text?.trim() || undefined
    if (!label && !text) throw new Error('請選擇選項或輸入回答')
    await this.update(taskId, (t) => {
      const qq = t.questions.find((x) => x.id === questionId)!
      qq.status = 'answered'
      qq.answer = { optionId: answer.optionId, text }
    })
    const body = [label, text].filter(Boolean).join('；')
    await this.send(taskId, 'main', msg.answer(questionId, answer.optionId, body), { silent: true })
  }

  async counterQuestion(taskId: string, questionId: string, text: string) {
    const body = text.trim()
    if (!body) throw new Error('請輸入反問內容')
    if (!this.get(taskId).questions.some((x) => x.id === questionId))
      throw new Error(`找不到問題 ${questionId}`)
    await this.update(taskId, (t) => {
      t.questions.find((x) => x.id === questionId)!.followups.push({ role: 'user', text: body })
    })
    this.pendingCounter.set(taskId, questionId)
    await this.send(taskId, 'main', msg.counterQuestion(questionId, body), { silent: true })
  }

  // ───────── 暫時的 stub（Task 23、24 取代） ─────────

  private requestApproval(
    taskId: string,
    channel: Channel,
    req: ApprovalRequest,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    void [taskId, channel, req, signal]
    return Promise.resolve({ allow: false, message: '尚未實作' })
  }

  private async finalizeReport(taskId: string, input: ReportInput, run?: AgentRun) {
    void [taskId, input, run]
  }
}
