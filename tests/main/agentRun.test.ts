import { describe, expect, test, vi } from 'vitest'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRun, mapMessage, type QueryFn, type RunnerEvent } from '../../src/main/agent/agentRun'

const m = (x: unknown) => x as SDKMessage
const success = (extra: Record<string, unknown> = {}) =>
  m({ type: 'result', subtype: 'success', is_error: false, ...extra })

/** 把 async generator 包成 QueryFn 的回傳值 */
const wrap = (
  gen: AsyncGenerator<SDKMessage>,
  interrupt: () => Promise<unknown> = async () => undefined
) => Object.assign(gen, { interrupt })

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
  test('assistant 的 error 轉成 notice', () => {
    const auth = mapMessage(
      m({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'Invalid API key' }] }
      })
    )
    expect(auth).toEqual([
      { type: 'notice', message: 'Claude Code 驗證失敗，請重新登入' },
      { type: 'assistant_text', text: 'Invalid API key' }
    ])
    const [billing] = mapMessage(
      m({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'billing_error',
        message: { content: [] }
      })
    )
    expect(billing).toEqual({ type: 'notice', message: '訂閱或帳單有問題' })
    const [other] = mapMessage(
      m({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'server_error',
        message: { content: [] }
      })
    )
    expect(other.type).toBe('notice')
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
    expect(mapMessage(success())).toEqual([{ type: 'turn_end', ok: true }])
    expect(
      mapMessage(
        m({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] })
      )
    ).toEqual([{ type: 'turn_end', ok: false, error: 'boom' }])
  })
  test('result 錯誤訊息：errors → result 文字 → 依 subtype 的繁中說明', () => {
    expect(mapMessage(success({ is_error: true, result: 'API Error: 500' }))).toEqual([
      { type: 'turn_end', ok: false, error: 'API Error: 500' }
    ])
    expect(mapMessage(success({ is_error: true }))).toEqual([
      { type: 'turn_end', ok: false, error: 'Claude 執行失敗' }
    ])
    expect(
      mapMessage(m({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }))
    ).toEqual([{ type: 'turn_end', ok: false, error: '超過最大回合數' }])
    expect(
      mapMessage(m({ type: 'result', subtype: 'error_during_execution', is_error: true }))
    ).toEqual([{ type: 'turn_end', ok: false, error: '執行時發生錯誤' }])
    expect(
      mapMessage(m({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }))
    ).toEqual([{ type: 'turn_end', ok: false, error: '超過預算上限' }])
    expect(
      mapMessage(
        m({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true })
      )
    ).toEqual([{ type: 'turn_end', ok: false, error: '結構化輸出重試次數過多' }])
  })
  test('rate limit 只有非 allowed 才回報，秒與毫秒的 resetsAt 結果相同', () => {
    expect(
      mapMessage(m({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))
    ).toEqual([])
    const [sec] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1791400000, rateLimitType: 'five_hour' }
      })
    )
    const [ms] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1791400000000, rateLimitType: 'five_hour' }
      })
    )
    expect(sec.type).toBe('notice')
    expect(sec).toEqual(ms)
    expect(sec.type === 'notice' && sec.message).toContain('5 小時')
    expect(sec.type === 'notice' && sec.message).toContain('已達到')
    const [warn] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day' }
      })
    )
    expect(warn.type === 'notice' && warn.message).toContain('7 天')
    expect(warn.type === 'notice' && warn.message).toContain('即將')
    const [raw] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus' }
      })
    )
    expect(raw.type === 'notice' && raw.message).toContain('seven_day_opus')
  })
})

describe('AgentRun', () => {
  test('送出第一則訊息、轉發事件，turn_end 後關閉輸入', async () => {
    const prompts: string[] = []
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          for await (const u of prompt) {
            prompts.push(String(u.message.content))
            yield m({ type: 'system', subtype: 'init', session_id: 's1' })
            yield success()
          }
        })()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'hello' }, (e) => events.push(e))
    await run.done
    expect(prompts).toEqual(['hello'])
    expect(events).toEqual([
      { type: 'session', sessionId: 's1' },
      { type: 'turn_end', ok: true, final: true }
    ])
    expect(run.active).toBe(false)
    expect(run.send('late')).toBe(false)
  })

  test('執行中可以插話', async () => {
    const prompts: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          const it = prompt[Symbol.asyncIterator]()
          prompts.push(String((await it.next()).value.message.content))
          await gate
          prompts.push(String((await it.next()).value.message.content))
          yield success()
        })()
      )
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, () => {})
    expect(run.send('b')).toBe(true)
    release()
    await run.done
    expect(prompts).toEqual(['a', 'b'])
  })

  test('每則訊息帶 uuid；插話未被第一個 result 涵蓋時保持輸入開啟，直到第二個 result', async () => {
    const seen: SDKUserMessage[] = []
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          const it = prompt[Symbol.asyncIterator]()
          const first = (await it.next()).value
          seen.push(first)
          yield success({ user_message_uuids: [first.uuid], queued_turn_count: 1 })
          const second = (await it.next()).value
          seen.push(second)
          yield success({ user_message_uuid: second.uuid })
        })()
      )
    const events: RunnerEvent[] = []
    let activeAfterFirst: boolean | undefined
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => {
      events.push(e)
      if (events.length === 1) activeAfterFirst = run.active
    })
    expect(run.send('b')).toBe(true)
    await run.done
    expect(seen.map((u) => u.message.content)).toEqual(['a', 'b'])
    expect(seen[0].uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen[0].uuid).not.toBe(seen[1].uuid)
    expect(events).toEqual([
      { type: 'turn_end', ok: true, final: false },
      { type: 'turn_end', ok: true, final: true }
    ])
    expect(activeAfterFirst).toBe(true)
    expect(run.active).toBe(false)
  })

  test('result 沒有 uuid 欄位時，queued_turn_count > 0 保持輸入開啟', async () => {
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          const it = prompt[Symbol.asyncIterator]()
          await it.next()
          yield success({ queued_turn_count: 1 })
          await it.next()
          yield success({ queued_turn_count: 0 })
        })()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    run.send('b')
    await run.done
    expect(events.map((e) => e.type === 'turn_end' && e.final)).toEqual([false, true])
  })

  test('options 會合併內部的 abortController', async () => {
    let got: Options | undefined
    const fake: QueryFn = ({ prompt, options }) =>
      wrap(
        (async function* () {
          got = options
          await prompt[Symbol.asyncIterator]().next()
          yield success()
        })()
      )
    const run = new AgentRun(fake, { options: { model: 'x' }, firstPrompt: 'a' }, () => {})
    await run.done
    expect(got?.model).toBe('x')
    expect(got?.abortController).toBeInstanceOf(AbortController)
  })

  test('interrupt 後的 turn_end 標記 interrupted 且不是錯誤', async () => {
    let interrupted!: () => void
    const stopped = new Promise<void>((r) => {
      interrupted = r
    })
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          await stopped
          yield m({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['aborted']
          })
        })(),
        async () => interrupted()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    await run.interrupt()
    expect(run.active).toBe(false)
    await run.done
    expect(events.at(-1)).toEqual({ type: 'turn_end', ok: true, interrupted: true, final: true })
  })

  test('interrupt 沒有回應時改用 abort', async () => {
    let signal: AbortSignal | undefined
    const fake: QueryFn = ({ prompt, options }) => {
      signal = options.abortController?.signal
      return wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          await new Promise<void>((_, reject) =>
            signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
        })(),
        () => new Promise(() => {})
      )
    }
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a', interruptTimeoutMs: 10 }, (e) =>
      events.push(e)
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))
    await run.interrupt()
    expect(signal?.aborted).toBe(true)
    await expect(run.done).resolves.toBeUndefined()
    expect(run.active).toBe(false)
  })

  test('abort() 直接中止', async () => {
    let signal: AbortSignal | undefined
    const fake: QueryFn = ({ prompt, options }) => {
      signal = options.abortController?.signal
      return wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          await new Promise<void>((_, reject) =>
            signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
        })()
      )
    }
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    run.abort()
    expect(signal?.aborted).toBe(true)
    await expect(run.done).resolves.toBeUndefined()
  })

  test('迭代器丟錯時 done 會 reject', async () => {
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          throw new Error('process exited')
        })()
      )
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, () => {})
    await expect(run.done).rejects.toThrow('process exited')
    expect(run.active).toBe(false)
  })

  test('onEvent 丟錯不會中斷執行', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          yield success()
        })()
      )
    const types: string[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => {
      types.push(e.type)
      if (e.type === 'session') throw new Error('callback bug')
    })
    await expect(run.done).resolves.toBeUndefined()
    expect(types).toEqual(['session', 'turn_end'])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  test('同一種 rate limit 狀態每次執行只回報一次', async () => {
    const rl = (status: string) =>
      m({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour' } })
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield rl('allowed_warning')
          yield rl('allowed_warning')
          yield rl('rejected')
          yield rl('rejected')
          yield success()
        })()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    await run.done
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(2)
  })
})
