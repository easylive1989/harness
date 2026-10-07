// src/main/agent/agentRun.ts
import { randomUUID } from 'node:crypto'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> }

/**
 * turn_end：final 表示這個 result 之後輸入已關閉（這次執行即將結束）；
 * interrupted 表示是使用者停止造成的結束，呼叫端不應視為錯誤。
 */
export type TurnEnd = {
  type: 'turn_end'
  ok: boolean
  error?: string
  interrupted?: boolean
  final: boolean
}

export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; isError: boolean; text: string }
  | TurnEnd
  | { type: 'notice'; message: string }

/** mapMessage 只看單一訊息，turn_end 的 final / interrupted 由 AgentRun 補上 */
export type MappedEvent =
  Exclude<RunnerEvent, TurnEnd> | { type: 'turn_end'; ok: boolean; error?: string }

type Block = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}
type Loose = {
  type: string
  subtype?: string
  session_id?: string
  parent_tool_use_id?: string | null
  message?: { content?: string | Block[] }
  error?: string
  is_error?: boolean
  errors?: string[]
  result?: string
  user_message_uuid?: string
  user_message_uuids?: string[]
  queued_turn_count?: number
  rate_limit_info?: { status: string; resetsAt?: number; rateLimitType?: string }
}

const blockText = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((x: Block) => (x.type === 'text' ? (x.text ?? '') : '')).join('')
      : ''

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: '超過最大回合數',
  error_during_execution: '執行時發生錯誤',
  error_max_budget_usd: '超過預算上限',
  error_max_structured_output_retries: '結構化輸出重試次數過多',
  success: 'Claude 執行失敗'
}

const ASSISTANT_ERRORS: Record<string, string> = {
  authentication_failed: 'Claude Code 驗證失敗，請重新登入',
  oauth_org_not_allowed: '這個帳號的組織不允許使用 Claude Code',
  account_on_hold: 'Claude 帳號目前被暫停使用',
  verification_required: 'Claude 帳號需要先完成驗證',
  billing_error: '訂閱或帳單有問題',
  rate_limit: '已達到用量上限，請稍後再試',
  overloaded: 'Claude 目前負載過高，請稍後再試',
  model_not_found: '找不到指定的模型',
  max_output_tokens: '回應超過輸出長度上限'
}

const RATE_LIMIT_TYPES: Record<string, string> = { five_hour: '5 小時', seven_day: '7 天' }

function rateLimitNotice(info: NonNullable<Loose['rate_limit_info']>): string {
  const kind = info.rateLimitType
    ? `（${RATE_LIMIT_TYPES[info.rateLimitType] ?? info.rateLimitType}）`
    : ''
  // resetsAt 的單位沒有文件說明：小於 1e12 視為秒
  const ms = info.resetsAt
    ? info.resetsAt < 1e12
      ? info.resetsAt * 1000
      : info.resetsAt
    : undefined
  const when = ms ? `，約 ${new Date(ms).toLocaleString('zh-TW')} 重置` : ''
  return info.status === 'rejected'
    ? `已達到訂閱方案的用量上限${kind}${when}。`
    : `即將達到訂閱方案的用量上限${kind}${when}。`
}

export function mapMessage(raw: SDKMessage): MappedEvent[] {
  const m = raw as unknown as Loose
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' && m.session_id
        ? [{ type: 'session', sessionId: m.session_id }]
        : []
    case 'assistant': {
      if (m.parent_tool_use_id) return []
      const events: MappedEvent[] = m.error
        ? [
            {
              type: 'notice',
              message: ASSISTANT_ERRORS[m.error] ?? `Claude 回應時發生錯誤（${m.error}）`
            }
          ]
        : []
      const content = Array.isArray(m.message?.content) ? m.message.content : []
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim())
          events.push({ type: 'assistant_text', text: b.text })
        if (b.type === 'tool_use') {
          events.push({
            type: 'tool_call',
            id: b.id ?? '',
            name: b.name ?? '',
            input: (b.input ?? {}) as Record<string, unknown>
          })
        }
      }
      return events
    }
    case 'user': {
      if (m.parent_tool_use_id || !Array.isArray(m.message?.content)) return []
      return m.message.content.flatMap((b): MappedEvent[] =>
        b.type === 'tool_result'
          ? [
              {
                type: 'tool_result',
                id: b.tool_use_id ?? '',
                isError: !!b.is_error,
                text: blockText(b.content)
              }
            ]
          : []
      )
    }
    case 'result': {
      const ok = m.subtype === 'success' && !m.is_error
      if (ok) return [{ type: 'turn_end', ok }]
      const error =
        (m.errors ?? []).join('\n') ||
        (m.is_error && m.result) ||
        RESULT_ERRORS[m.subtype ?? ''] ||
        m.subtype ||
        'Claude 執行失敗'
      return [{ type: 'turn_end', ok, error }]
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info
      if (!info || info.status === 'allowed') return []
      return [{ type: 'notice', message: rateLimitNotice(info) }]
    }
    default:
      return []
  }
}

export function userMessage(text: string): SDKUserMessage & { uuid: string } {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid: randomUUID()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待超過 ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export interface RunConfig {
  options: Options
  firstPrompt: string
  /** interrupt() 等待 SDK 回應的上限，逾時改用 abort（預設 5000ms） */
  interruptTimeoutMs?: number
}

/**
 * 一段對話：送出第一則訊息，可插話；每則送出的訊息都被 result 回應過之後關閉輸入，讓程序結束。
 */
export class AgentRun {
  private queue = new AsyncQueue<SDKUserMessage>()
  private readonly q: ReturnType<QueryFn>
  private readonly abortController = new AbortController()
  private readonly interruptTimeoutMs: number
  private readonly pending = new Set<string>()
  private readonly noticed = new Set<string>()
  private ended = false
  private stopping = false
  readonly done: Promise<void>

  constructor(queryFn: QueryFn, cfg: RunConfig, onEvent: (e: RunnerEvent) => void) {
    this.interruptTimeoutMs = cfg.interruptTimeoutMs ?? 5000
    const external = cfg.options.abortController
    if (external) {
      if (external.signal.aborted) this.abortController.abort()
      else external.signal.addEventListener('abort', () => this.abort(), { once: true })
    }
    const emit = (e: RunnerEvent) => {
      try {
        onEvent(e)
      } catch (err) {
        console.error('[AgentRun] onEvent 回呼失敗', err)
      }
    }
    this.enqueue(cfg.firstPrompt)
    // 用區域變數迭代：TS 會把建構子內的 async IIFE 視為立即執行，直接讀 this.q 會報 TS2565
    const q = queryFn({
      prompt: this.queue,
      options: { ...cfg.options, abortController: this.abortController }
    })
    this.q = q
    this.done = (async () => {
      try {
        for await (const raw of q) {
          for (const e of mapMessage(raw)) {
            if (e.type === 'notice' && !this.firstNotice(raw)) continue
            if (e.type !== 'turn_end') {
              emit(e)
              continue
            }
            const final = this.stopping || this.turnComplete(raw)
            if (final) this.closeInput()
            emit(
              this.stopping
                ? { type: 'turn_end', ok: true, interrupted: true, final }
                : { ...e, final }
            )
          }
        }
      } catch (err) {
        // 使用者停止（interrupt / abort）造成的結束不算錯誤
        if (!this.stopping) throw err
      } finally {
        this.ended = true
        this.closeInput()
      }
    })()
  }

  get active() {
    return !this.ended && !this.queue.isClosed
  }

  send(text: string): boolean {
    if (!this.active) return false
    this.enqueue(text)
    return true
  }

  /** 請 SDK 中斷目前這一輪；沒有在時限內回應就直接 abort */
  async interrupt() {
    this.stopping = true
    try {
      await withTimeout(this.q.interrupt(), this.interruptTimeoutMs)
    } catch {
      this.abortController.abort()
    } finally {
      this.closeInput()
    }
  }

  /** 立即中止底層程序 */
  abort() {
    this.stopping = true
    this.abortController.abort()
    this.closeInput()
  }

  private enqueue(text: string) {
    const msg = userMessage(text)
    this.pending.add(msg.uuid)
    this.queue.push(msg)
  }

  /** 這個 result 之後是否已沒有待回應的訊息 */
  private turnComplete(raw: SDKMessage): boolean {
    const m = raw as unknown as Loose
    const answered =
      m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : undefined)
    if (!answered) return !(m.queued_turn_count && m.queued_turn_count > 0)
    for (const id of answered) this.pending.delete(id)
    return this.pending.size === 0
  }

  /** rate limit 通知每種狀態每次執行只回報一次 */
  private firstNotice(raw: SDKMessage): boolean {
    const m = raw as unknown as Loose
    if (m.type !== 'rate_limit_event' || !m.rate_limit_info) return true
    const key = m.rate_limit_info.status
    if (this.noticed.has(key)) return false
    this.noticed.add(key)
    return true
  }

  private closeInput() {
    if (!this.queue.isClosed) this.queue.close()
  }
}
