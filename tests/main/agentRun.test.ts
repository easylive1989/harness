import { describe, expect, test } from 'vitest'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRun, mapMessage, type QueryFn, type RunnerEvent } from '../../src/main/agent/agentRun'

const m = (x: unknown) => x as SDKMessage

describe('mapMessage', () => {
  test('init → session', () => {
    expect(mapMessage(m({ type: 'system', subtype: 'init', session_id: 's1' }))).toEqual([
      { type: 'session', sessionId: 's1' }
    ])
  })
  test('assistant 的文字與 tool_use', () => {
    expect(
      mapMessage(
        m({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'text', text: '你好' },
              { type: 'text', text: '  ' },
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } }
            ]
          }
        })
      )
    ).toEqual([
      { type: 'assistant_text', text: '你好' },
      { type: 'tool_call', id: 'tu1', name: 'Read', input: { file_path: 'a' } }
    ])
  })
  test('子代理的訊息略過', () => {
    expect(
      mapMessage(
        m({
          type: 'assistant',
          parent_tool_use_id: 'x',
          message: { content: [{ type: 'text', text: 'hi' }] }
        })
      )
    ).toEqual([])
  })
  test('tool_result', () => {
    expect(
      mapMessage(
        m({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu1',
                is_error: true,
                content: [{ type: 'text', text: 'denied' }]
              }
            ]
          }
        })
      )
    ).toEqual([{ type: 'tool_result', id: 'tu1', isError: true, text: 'denied' }])
  })
  test('result', () => {
    expect(mapMessage(m({ type: 'result', subtype: 'success', is_error: false }))).toEqual([
      { type: 'turn_end', ok: true }
    ])
    expect(
      mapMessage(
        m({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] })
      )
    ).toEqual([{ type: 'turn_end', ok: false, error: 'boom' }])
  })
  test('rate limit 只有非 allowed 才回報', () => {
    expect(
      mapMessage(m({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))
    ).toEqual([])
    const [e] = mapMessage(
      m({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791400000 } })
    )
    expect(e.type).toBe('rate_limit')
  })
})

describe('AgentRun', () => {
  test('送出第一則訊息、轉發事件，turn_end 後關閉輸入', async () => {
    const prompts: string[] = []
    const fake: QueryFn = ({ prompt }) => {
      const gen = (async function* () {
        for await (const u of prompt as AsyncIterable<SDKUserMessage>) {
          prompts.push(String(u.message.content))
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          yield m({ type: 'result', subtype: 'success', is_error: false })
        }
      })()
      return Object.assign(gen, { interrupt: async () => undefined })
    }
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'hello' }, (e) => events.push(e))
    await run.done
    expect(prompts).toEqual(['hello'])
    expect(events.map((e) => e.type)).toEqual(['session', 'turn_end'])
    expect(run.active).toBe(false)
    expect(run.send('late')).toBe(false)
  })

  test('執行中可以插話', async () => {
    const prompts: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fake: QueryFn = ({ prompt }) => {
      const gen = (async function* () {
        const it = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
        prompts.push(String((await it.next()).value.message.content))
        await gate
        prompts.push(String((await it.next()).value.message.content))
        yield m({ type: 'result', subtype: 'success', is_error: false })
      })()
      return Object.assign(gen, { interrupt: async () => undefined })
    }
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, () => {})
    expect(run.send('b')).toBe(true)
    release()
    await run.done
    expect(prompts).toEqual(['a', 'b'])
  })
})
