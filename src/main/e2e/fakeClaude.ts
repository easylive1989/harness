// src/main/e2e/fakeClaude.ts
// 自動化端對端測試（tests/e2e）用的假 Claude：HARNESS_E2E_FAKE_CLAUDE=1 時 index.ts 用它取代 SDK 的 query，
// 不啟動 Claude Code、不用訂閱額度。
//
// 每收到一則使用者訊息就開一個「回合」，等測試透過 globalThis.__harnessFakeClaude（Playwright 的
// electronApp.evaluate）指定這一輪要回的文字、工具呼叫或錯誤。工具呼叫照真實的路徑走：
// PreToolUse hook → canUseTool（需要時跳出核准框）→ 執行（harness 工具的 handler；Read／Write／Edit／Bash
// 真的在 worktree 裡執行），所以權限規則、核准框與時間軸都和接真的 Claude 時一樣。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type {
  HookCallbackMatcher,
  HookEvent,
  SDKMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ClaudeStatus } from '@shared/types'
import type { QueryFn } from '../agent/agentRun'
import {
  askUserShape,
  concludeBranchShape,
  createToolHandlers,
  type HarnessToolName,
  proposeSpecShape,
  type ToolSink,
  updatePlanShape
} from '../tools/harnessTools'

/** 測試指定的一個動作：一段文字、一次工具呼叫，或讓這一輪以錯誤結束 */
export type FakeAction =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'error'; message: string }

/** 一個回合：app 送給 Claude 的一則訊息 */
export interface FakeTurn {
  id: number
  /** 第幾段執行（同一段執行裡的插話 run 相同） */
  run: number
  /** 主線或分岔（看這段執行拿到的 harness 工具） */
  kind: 'main' | 'branch'
  text: string
  /** 這段執行的工作目錄（worktree） */
  cwd: string
  sessionId: string
  /** 續接的 session（沒有表示新的對話） */
  resume?: string
}

export interface FakeToolOutcome {
  name: string
  isError: boolean
  text: string
}

export interface FakeTurnResult {
  outcomes: FakeToolOutcome[]
  /** 這一輪被停止或中止（使用者按停止、丟棄任務、關閉 app） */
  interrupted: boolean
}

/** 測試透過 globalThis.__harnessFakeClaude 使用 */
export interface FakeClaudeController {
  /** 等下一個還沒交給測試的回合 */
  nextTurn(timeoutMs?: number): Promise<FakeTurn>
  /** 指定這一輪要做的事；做完就結束這一輪（不等它做完，核准框可能還要測試去按） */
  reply(turnId: number, actions: FakeAction[]): void
  /** 等這一輪做完，回傳每個工具呼叫的結果 */
  turnResult(turnId: number, timeoutMs?: number): Promise<FakeTurnResult>
  /** 還沒交給測試的回合（除錯用） */
  waiting(): FakeTurn[]
}

export const FAKE_CLAUDE_GLOBAL = '__harnessFakeClaude'

/** 假的 Claude Code 狀態：已登入 */
export const FAKE_CLAUDE_STATUS: ClaudeStatus = {
  found: true,
  path: '/e2e/fake-claude',
  version: 'e2e fake',
  loggedIn: true,
  subscriptionType: 'max',
  email: 'e2e@example.com',
  ignoredEnv: []
}

const SHAPES: Partial<Record<HarnessToolName, z.ZodRawShape>> = {
  ask_user: askUserShape,
  propose_spec: proposeSpecShape,
  update_plan: updatePlanShape,
  conclude_branch: concludeBranchShape
}

const BASH_TIMEOUT_MS = 120_000

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  settled: boolean
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const d = { settled: false } as Deferred<T>
  d.promise = new Promise<T>((r) => (resolve = r))
  d.resolve = (v) => {
    if (d.settled) return
    d.settled = true
    resolve(v)
  }
  return d
}

interface TurnState {
  info: FakeTurn
  handed: boolean
  actions: Deferred<FakeAction[]>
  result: Deferred<FakeTurnResult>
}

interface Registered {
  handlers: ReturnType<typeof createToolHandlers>
  names: HarnessToolName[]
}

class Stopped extends Error {}

const withTimeout = <T>(p: Promise<T>, ms: number, what: () => string) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(what())), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

const textOf = (m: SDKUserMessage) => {
  const c = m.message.content
  if (typeof c === 'string') return c
  return c.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

/** 在 cwd 用 /bin/sh 執行指令，回傳輸出與 exit code */
function runCommand(cwd: string, command: string, signal: AbortSignal) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (s: string) => (output += s))
    child.stderr.setEncoding('utf8').on('data', (s: string) => (output += s))
    const kill = () => child.kill('SIGKILL')
    const timer = setTimeout(kill, BASH_TIMEOUT_MS)
    signal.addEventListener('abort', kill, { once: true })
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ code: null, output: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', kill)
      done({ code, output })
    })
  })
}

export function createFakeClaude() {
  const turns: TurnState[] = []
  const servers = new WeakMap<object, Registered>()
  let listeners: (() => void)[] = []
  let runCount = 0
  let toolCount = 0
  const notify = () => {
    const ls = listeners
    listeners = []
    ls.forEach((l) => l())
  }
  const turn = (id: number) => {
    const t = turns.find((x) => x.info.id === id)
    if (!t) throw new Error(`沒有回合 ${id}`)
    return t
  }

  const controller: FakeClaudeController = {
    async nextTurn(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const t = turns.find((x) => !x.handed)
        if (t) {
          t.handed = true
          return t.info
        }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`等不到 app 送給 Claude 的訊息（${timeoutMs}ms）`)
        await withTimeout(
          new Promise<void>((r) => listeners.push(r)),
          left,
          () => `等不到 app 送給 Claude 的訊息（${timeoutMs}ms）`
        ).catch(() => undefined)
      }
    },
    reply(turnId, actions) {
      const t = turn(turnId)
      if (t.actions.settled) throw new Error(`回合 ${turnId} 已經回覆或已結束`)
      t.actions.resolve(actions)
    },
    turnResult(turnId, timeoutMs = 60_000) {
      return withTimeout(
        turn(turnId).result.promise,
        timeoutMs,
        () => `回合 ${turnId} 沒有在 ${timeoutMs}ms 內做完`
      )
    },
    waiting: () => turns.filter((t) => !t.handed).map((t) => t.info)
  }

  /** index.ts 的 createToolServer 包一層：記下這個 server 的 sink，假 Claude 用它執行 harness 工具 */
  function register<S extends object>(server: S, sink: ToolSink, names: HarnessToolName[]): S {
    servers.set(server, { handlers: createToolHandlers(sink), names })
    return server
  }

  const query: QueryFn = ({ prompt, options }) => {
    const run = ++runCount
    const sessionId = options.resume && !options.forkSession ? options.resume : randomUUID()
    const cwd = options.cwd ?? process.cwd()
    const harness = options.mcpServers?.harness
    const registered = harness ? servers.get(harness) : undefined
    const kind: FakeTurn['kind'] = registered?.names.includes('conclude_branch') ? 'branch' : 'main'
    const runAbort = options.abortController?.signal ?? new AbortController().signal
    /** 這段執行的工具呼叫的中止：使用者按停止（interrupt）或整段執行被中止 */
    const turnAbort = new AbortController()
    let interrupted = false
    const stop = deferred<void>()
    const onAbort = () => {
      turnAbort.abort()
      stop.resolve()
    }
    runAbort.addEventListener('abort', onAbort, { once: true })

    const assistant = (content: unknown[]) =>
      ({
        type: 'assistant',
        message: { role: 'assistant', content },
        parent_tool_use_id: null,
        session_id: sessionId
      }) as unknown as SDKMessage
    const toolResult = (id: string, text: string, isError: boolean) =>
      ({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }]
        },
        parent_tool_use_id: null,
        session_id: sessionId
      }) as unknown as SDKMessage
    const result = (uuid: string, error?: string) =>
      ({
        type: 'result',
        subtype: error ? 'error_during_execution' : 'success',
        is_error: !!error,
        ...(error ? { errors: [error] } : {}),
        session_id: sessionId,
        user_message_uuids: [uuid]
      }) as unknown as SDKMessage

    /** 等 p，期間這一輪被停止就丟 Stopped */
    const unlessStopped = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        stop.promise.then(() => {
          throw new Stopped()
        })
      ])

    async function permission(
      name: string,
      input: Record<string, unknown>,
      id: string
    ): Promise<{ ok: true; input: Record<string, unknown> } | { ok: false; reason: string }> {
      const server = name.startsWith('mcp__') ? name.split('__')[1] : undefined
      const config = server ? options.mcpServers?.[server] : undefined
      const mcpServer = server
        ? { name: server, source: config?.type === 'sdk' ? 'sdk' : 'project' }
        : undefined
      let decision: string | undefined
      let reason: string | undefined
      const matchers: HookCallbackMatcher[] =
        (options.hooks as Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined)
          ?.PreToolUse ?? []
      for (const m of matchers) {
        for (const hook of m.hooks) {
          const out = await hook(
            {
              hook_event_name: 'PreToolUse',
              session_id: sessionId,
              transcript_path: '',
              cwd,
              tool_name: name,
              tool_input: input,
              tool_use_id: id,
              ...(mcpServer ? { mcp_server: mcpServer } : {})
            },
            id,
            { signal: turnAbort.signal }
          )
          const specific = 'hookSpecificOutput' in out ? out.hookSpecificOutput : undefined
          if (specific?.hookEventName === 'PreToolUse' && specific.permissionDecision) {
            // deny 優先，其次 ask
            if (decision !== 'deny') {
              decision = specific.permissionDecision
              reason = specific.permissionDecisionReason
            }
          }
        }
      }
      if (decision === 'deny')
        return { ok: false, reason: `PreToolUse:${name} hook error: ${reason ?? ''}` }
      if (decision === 'allow') return { ok: true, input }
      if (!options.canUseTool) return { ok: true, input }
      const r = await options.canUseTool(name, input, {
        signal: turnAbort.signal,
        toolUseID: id,
        requestId: randomUUID(),
        ...(mcpServer ? { mcpServer } : {})
      })
      if (!r) return { ok: false, reason: '沒有核准結果' }
      if (r.behavior === 'deny') return { ok: false, reason: r.message }
      return { ok: true, input: r.updatedInput ?? input }
    }

    async function execute(
      name: string,
      input: Record<string, unknown>
    ): Promise<{ text: string; isError: boolean }> {
      const path = (p: unknown) => (isAbsolute(String(p)) ? String(p) : resolve(cwd, String(p)))
      if (name.startsWith('mcp__harness__')) {
        const tool = name.slice('mcp__harness__'.length) as HarnessToolName
        if (!registered?.names.includes(tool))
          return { text: `No such tool available: ${name}`, isError: true }
        let args: unknown = input
        const shape = SHAPES[tool]
        if (shape) {
          const parsed = z.object(shape).safeParse(input)
          if (!parsed.success)
            return { text: `參數格式錯誤：\n${z.prettifyError(parsed.error)}`, isError: true }
          args = parsed.data
        }
        const handler = registered.handlers[tool] as (a: unknown) => Promise<{
          content: { text: string }[]
          isError?: boolean
        }>
        const out = await handler(args)
        return { text: out.content.map((c) => c.text).join('\n'), isError: !!out.isError }
      }
      try {
        switch (name) {
          case 'Read':
            return { text: await readFile(path(input.file_path), 'utf8'), isError: false }
          case 'Write': {
            const file = path(input.file_path)
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, String(input.content ?? ''))
            return { text: `File created successfully at: ${file}`, isError: false }
          }
          case 'Edit': {
            const file = path(input.file_path)
            const before = await readFile(file, 'utf8')
            const oldText = String(input.old_string ?? '')
            const count = before.split(oldText).length - 1
            if (!oldText || count === 0)
              return { text: `String to replace not found in file: ${oldText}`, isError: true }
            if (count > 1 && !input.replace_all)
              return { text: `Found ${count} matches of the string to replace`, isError: true }
            const next = input.replace_all
              ? before.split(oldText).join(String(input.new_string ?? ''))
              : before.replace(oldText, () => String(input.new_string ?? ''))
            await writeFile(file, next)
            return { text: `The file ${file} has been updated.`, isError: false }
          }
          case 'Bash': {
            const r = await runCommand(cwd, String(input.command ?? ''), turnAbort.signal)
            return {
              text: r.code === 0 ? r.output : `Exit code ${r.code}\n${r.output}`,
              isError: r.code !== 0
            }
          }
          default:
            return { text: `假 Claude 不支援 ${name}`, isError: true }
        }
      } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true }
      }
    }

    async function* messages(): AsyncGenerator<SDKMessage> {
      try {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: sessionId
        } as unknown as SDKMessage
        const input = prompt[Symbol.asyncIterator]()
        for (;;) {
          // 輸入關閉（AgentRun 收到最後的 result）就結束；整段執行被中止時不再等輸入
          const next = await Promise.race([
            input.next(),
            new Promise<IteratorResult<SDKUserMessage>>((r) => {
              if (runAbort.aborted) r({ done: true, value: undefined })
              else
                runAbort.addEventListener('abort', () => r({ done: true, value: undefined }), {
                  once: true
                })
            })
          ])
          if (next.done || runAbort.aborted) return
          const msg = next.value as SDKUserMessage & { uuid: string }
          const state: TurnState = {
            info: {
              id: turns.length + 1,
              run,
              kind,
              text: textOf(msg),
              cwd,
              sessionId,
              ...(options.resume ? { resume: options.resume } : {})
            },
            handed: false,
            actions: deferred(),
            result: deferred()
          }
          turns.push(state)
          notify()
          const outcomes: FakeToolOutcome[] = []
          let error: string | undefined
          try {
            const actions = await unlessStopped(state.actions.promise)
            for (const a of actions) {
              if (a.type === 'error') {
                error = a.message
                break
              }
              if (a.type === 'text') {
                yield assistant([{ type: 'text', text: a.text }])
                continue
              }
              const id = `toolu_fake_${++toolCount}`
              yield assistant([{ type: 'tool_use', id, name: a.name, input: a.input }])
              const allowed = await unlessStopped(permission(a.name, a.input, id))
              const out = allowed.ok
                ? await unlessStopped(execute(a.name, allowed.input))
                : { text: allowed.reason, isError: true }
              outcomes.push({ name: a.name, ...out })
              yield toolResult(id, out.text, out.isError)
            }
          } catch (e) {
            if (!(e instanceof Stopped)) throw e
          }
          const stopped = interrupted || runAbort.aborted
          state.actions.resolve([])
          state.result.resolve({ outcomes, interrupted: stopped })
          // 中止：和真的 SDK 一樣以錯誤結束迭代（AgentRun 知道是自己中止的，不當成錯誤）
          if (runAbort.aborted) throw new Error('aborted')
          // 停止（interrupt）後 AgentRun 會關閉輸入，這段執行接著結束
          yield result(msg.uuid, stopped ? '已停止' : error)
        }
      } finally {
        runAbort.removeEventListener('abort', onAbort)
        // 這段執行結束時還沒回覆的回合不會再被處理
        for (const t of turns)
          if (t.info.run === run && !t.result.settled) {
            t.actions.resolve([])
            t.result.resolve({ outcomes: [], interrupted: true })
          }
      }
    }

    const gen = messages()
    return Object.assign(gen, {
      async interrupt() {
        interrupted = true
        turnAbort.abort()
        stop.resolve()
      }
    })
  }

  return { query, register, controller }
}

/** index.ts 在 e2e 模式呼叫：建立假 Claude 並把控制器放在 globalThis 給測試用 */
export function installFakeClaude() {
  const fake = createFakeClaude()
  ;(globalThis as Record<string, unknown>)[FAKE_CLAUDE_GLOBAL] = fake.controller
  return { ...fake, status: FAKE_CLAUDE_STATUS }
}
