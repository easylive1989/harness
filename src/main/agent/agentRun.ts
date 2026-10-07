// src/main/agent/agentRun.ts
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> }

export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; isError: boolean; text: string }
  | { type: 'turn_end'; ok: boolean; error?: string }
  | { type: 'rate_limit'; message: string }

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
  is_error?: boolean
  errors?: string[]
  rate_limit_info?: { status: string; resetsAt?: number }
}

const blockText = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((x: Block) => (x.type === 'text' ? (x.text ?? '') : '')).join('')
      : ''

export function mapMessage(raw: SDKMessage): RunnerEvent[] {
  const m = raw as unknown as Loose
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' && m.session_id
        ? [{ type: 'session', sessionId: m.session_id }]
        : []
    case 'assistant': {
      if (m.parent_tool_use_id) return []
      const content = Array.isArray(m.message?.content) ? m.message.content : []
      return content.flatMap((b): RunnerEvent[] => {
        if (b.type === 'text' && b.text?.trim()) return [{ type: 'assistant_text', text: b.text }]
        if (b.type === 'tool_use')
          return [
            {
              type: 'tool_call',
              id: b.id ?? '',
              name: b.name ?? '',
              input: (b.input ?? {}) as Record<string, unknown>
            }
          ]
        return []
      })
    }
    case 'user': {
      if (m.parent_tool_use_id || !Array.isArray(m.message?.content)) return []
      return m.message.content.flatMap((b): RunnerEvent[] =>
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
      return [
        ok
          ? { type: 'turn_end', ok }
          : { type: 'turn_end', ok, error: (m.errors ?? []).join('\n') || m.subtype }
      ]
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info
      if (!info || info.status === 'allowed') return []
      const when = info.resetsAt
        ? `，約 ${new Date(info.resetsAt * 1000).toLocaleString('zh-TW')} 重置`
        : ''
      return [
        {
          type: 'rate_limit',
          message:
            info.status === 'rejected'
              ? `已達到訂閱方案的用量上限${when}。`
              : `即將達到訂閱方案的用量上限${when}。`
        }
      ]
    }
    default:
      return []
  }
}

export function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null
  } as SDKUserMessage
}

export interface RunConfig {
  options: Options
  firstPrompt: string
}

/** 一輪對話：送出第一則訊息，可插話，收到 result 後關閉輸入讓程序結束 */
export class AgentRun {
  private queue = new AsyncQueue<SDKUserMessage>()
  private readonly q: ReturnType<QueryFn>
  private ended = false
  readonly done: Promise<void>

  constructor(queryFn: QueryFn, cfg: RunConfig, onEvent: (e: RunnerEvent) => void) {
    this.queue.push(userMessage(cfg.firstPrompt))
    const q = queryFn({ prompt: this.queue, options: cfg.options })
    this.q = q
    this.done = (async () => {
      try {
        for await (const msg of q) {
          for (const e of mapMessage(msg)) {
            onEvent(e)
            if (e.type === 'turn_end') this.closeInput()
          }
        }
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
    this.queue.push(userMessage(text))
    return true
  }

  async interrupt() {
    await this.q.interrupt().catch(() => undefined)
    this.closeInput()
  }

  private closeInput() {
    if (!this.queue.isClosed) this.queue.close()
  }
}
