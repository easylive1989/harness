import { describe, expect, test, vi } from 'vitest'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../../src/main/agent/asyncQueue'
import { userMessage } from '../../src/main/agent/agentRun'
import { createFakeClaude, type FakeAction } from '../../src/main/e2e/fakeClaude'
import type { ToolSink } from '../../src/main/tools/harnessTools'

const sink = () =>
  ({
    askUser: vi.fn(),
    proposeSpec: vi.fn(),
    updatePlan: vi.fn(),
    concludeBranch: vi.fn(),
    submitReport: vi.fn()
  }) satisfies ToolSink

type Loose = {
  type: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  errors?: string[]
  user_message_uuids?: string[]
  message?: { content: { type: string; text?: string; name?: string; is_error?: boolean }[] }
}

/** 啟動一段假 Claude 的執行，收集它送出的訊息 */
function start(
  extra: Partial<Options> = {},
  opts: {
    sink?: ToolSink
    names?: Parameters<ReturnType<typeof createFakeClaude>['register']>[2]
  } = {}
) {
  const fake = createFakeClaude()
  const server = fake.register(
    { type: 'sdk', name: 'harness' },
    opts.sink ?? sink(),
    opts.names ?? ['ask_user', 'propose_spec', 'update_plan', 'submit_report']
  )
  const prompt = new AsyncQueue<ReturnType<typeof userMessage>>()
  const abortController = new AbortController()
  const q = fake.query({
    prompt,
    options: {
      cwd: '/tmp/wt',
      abortController,
      mcpServers: { harness: server as never },
      ...extra
    }
  })
  const seen: Loose[] = []
  const done = (async () => {
    for await (const m of q as AsyncIterable<SDKMessage>) seen.push(m as unknown as Loose)
  })()
  return { fake, prompt, q, seen, done, abortController }
}

describe('createFakeClaude', () => {
  test('每則使用者訊息是一個回合：依 reply 的動作送出文字與 harness 工具，結束時回 result', async () => {
    const s = sink()
    const { fake, prompt, seen, done } = start({}, { sink: s })
    const msg = userMessage('登入要鎖帳號')
    prompt.push(msg)
    const turn = await fake.controller.nextTurn(1000)
    expect(turn).toMatchObject({
      id: 1,
      run: 1,
      kind: 'main',
      text: '登入要鎖帳號',
      cwd: '/tmp/wt'
    })
    const actions: FakeAction[] = [
      { type: 'text', text: '先問一題' },
      {
        type: 'tool',
        name: 'mcp__harness__ask_user',
        input: { question_id: 'q1', question: '鎖多久？', options: [{ id: 'a', label: '1 分鐘' }] }
      }
    ]
    fake.controller.reply(turn.id, actions)
    const result = await fake.controller.turnResult(turn.id, 1000)
    expect(result.interrupted).toBe(false)
    expect(result.outcomes).toEqual([
      expect.objectContaining({ name: 'mcp__harness__ask_user', isError: false })
    ])
    // zod 的預設值（allow_free_text）照真的 MCP 伺服器一樣補上
    expect(s.askUser).toHaveBeenCalledWith(expect.objectContaining({ allow_free_text: true }))
    prompt.close()
    await done
    expect(seen.map((m) => m.type)).toEqual(['system', 'assistant', 'assistant', 'user', 'result'])
    expect(seen[0]).toMatchObject({ subtype: 'init' })
    expect(seen.at(-1)).toMatchObject({
      subtype: 'success',
      is_error: false,
      user_message_uuids: [msg.uuid]
    })
  })

  test('PreToolUse hook 拒絕時不執行工具，工具結果是錯誤並帶原因', async () => {
    const hook = vi.fn(async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: '目前不是實作階段，不能執行指令。'
      }
    }))
    const canUseTool = vi.fn()
    const { fake, prompt, done } = start({
      hooks: { PreToolUse: [{ hooks: [hook] }] },
      canUseTool
    })
    prompt.push(userMessage('跑測試'))
    const turn = await fake.controller.nextTurn(1000)
    fake.controller.reply(turn.id, [{ type: 'tool', name: 'Bash', input: { command: 'npm test' } }])
    const { outcomes } = await fake.controller.turnResult(turn.id, 1000)
    expect(outcomes).toEqual([
      {
        name: 'Bash',
        isError: true,
        text: 'PreToolUse:Bash hook error: 目前不是實作階段，不能執行指令。'
      }
    ])
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp/wt' }),
      expect.any(String),
      expect.anything()
    )
    expect(canUseTool).not.toHaveBeenCalled()
    prompt.close()
    await done
  })

  test('hook 沒有決定時交給 canUseTool；harness 工具帶 sdk 來源，拒絕的原因成為工具結果', async () => {
    const hook = vi.fn(async () => ({}))
    const canUseTool = vi.fn(async (name: string) =>
      name === 'WebFetch'
        ? { behavior: 'deny' as const, message: '不需要上網' }
        : {
            behavior: 'allow' as const,
            updatedInput: { steps: [{ id: 's1', title: '寫', status: 'done' }] }
          }
    )
    const s = sink()
    const { fake, prompt, done } = start(
      { hooks: { PreToolUse: [{ hooks: [hook] }] }, canUseTool },
      { sink: s }
    )
    prompt.push(userMessage('開始'))
    const turn = await fake.controller.nextTurn(1000)
    fake.controller.reply(turn.id, [
      { type: 'tool', name: 'WebFetch', input: { url: 'https://example.com' } },
      { type: 'tool', name: 'mcp__harness__update_plan', input: { steps: [] } }
    ])
    const { outcomes } = await fake.controller.turnResult(turn.id, 1000)
    expect(outcomes[0]).toEqual({ name: 'WebFetch', isError: true, text: '不需要上網' })
    expect(outcomes[1]).toMatchObject({ name: 'mcp__harness__update_plan', isError: false })
    // canUseTool 回傳的 updatedInput 才是實際執行的參數
    expect(s.updatePlan).toHaveBeenCalledWith({
      steps: [{ id: 's1', title: '寫', status: 'done' }]
    })
    expect(hook).toHaveBeenLastCalledWith(
      expect.objectContaining({ mcp_server: { name: 'harness', source: 'sdk' } }),
      expect.any(String),
      expect.anything()
    )
    expect(canUseTool).toHaveBeenLastCalledWith(
      'mcp__harness__update_plan',
      { steps: [] },
      expect.objectContaining({ mcpServer: { name: 'harness', source: 'sdk' } })
    )
    prompt.close()
    await done
  })

  test('沒有提供給這段執行的 harness 工具與參數格式錯誤都回傳錯誤結果', async () => {
    const { fake, prompt, done } = start({}, { names: ['conclude_branch'] })
    prompt.push(userMessage('[branch_open] 主題：x'))
    const turn = await fake.controller.nextTurn(1000)
    expect(turn.kind).toBe('branch')
    fake.controller.reply(turn.id, [
      { type: 'tool', name: 'mcp__harness__ask_user', input: {} },
      { type: 'tool', name: 'mcp__harness__conclude_branch', input: { decision: '' } }
    ])
    const { outcomes } = await fake.controller.turnResult(turn.id, 1000)
    expect(outcomes.map((o) => o.isError)).toEqual([true, true])
    expect(outcomes[0].text).toContain('No such tool')
    expect(outcomes[1].text).toContain('參數格式錯誤')
    prompt.close()
    await done
  })

  test('error 動作讓這一輪以錯誤結束，之後的動作不執行', async () => {
    const { fake, prompt, seen, done } = start()
    prompt.push(userMessage('hi'))
    const turn = await fake.controller.nextTurn(1000)
    fake.controller.reply(turn.id, [
      { type: 'error', message: '已達到用量上限' },
      { type: 'text', text: '不會出現' }
    ])
    await fake.controller.turnResult(turn.id, 1000)
    prompt.close()
    await done
    expect(seen.filter((m) => m.type === 'assistant')).toEqual([])
    expect(seen.at(-1)).toMatchObject({ is_error: true, errors: ['已達到用量上限'] })
  })

  test('插話在同一段執行裡成為下一個回合', async () => {
    const { fake, prompt, done } = start()
    prompt.push(userMessage('第一則'))
    const first = await fake.controller.nextTurn(1000)
    prompt.push(userMessage('插話'))
    fake.controller.reply(first.id, [{ type: 'text', text: '好' }])
    const second = await fake.controller.nextTurn(1000)
    expect(second).toMatchObject({ run: first.run, text: '插話' })
    fake.controller.reply(second.id, [])
    await fake.controller.turnResult(second.id, 1000)
    prompt.close()
    await done
  })

  test('interrupt 結束等待中的回合並標為中斷；續接時沿用 session，分岔換新的 session', async () => {
    const { fake, prompt, q, seen, done } = start({ resume: 'sess-1' })
    prompt.push(userMessage('等一下'))
    const turn = await fake.controller.nextTurn(1000)
    expect(turn).toMatchObject({ resume: 'sess-1', sessionId: 'sess-1' })
    await (q as unknown as { interrupt(): Promise<void> }).interrupt()
    expect(await fake.controller.turnResult(turn.id, 1000)).toEqual({
      outcomes: [],
      interrupted: true
    })
    expect(() => fake.controller.reply(turn.id, [])).toThrow('已經回覆或已結束')
    prompt.close()
    await done
    expect(seen.at(-1)).toMatchObject({ type: 'result', is_error: true })

    const forked = start({ resume: 'sess-1', forkSession: true })
    forked.prompt.push(userMessage('分岔'))
    const t2 = await forked.fake.controller.nextTurn(1000)
    expect(t2.sessionId).not.toBe('sess-1')
    forked.abortController.abort()
    await expect(forked.done).rejects.toThrow('aborted')
  })

  test('等不到訊息時 nextTurn 逾時', async () => {
    const { fake, prompt, done } = start()
    await expect(fake.controller.nextTurn(50)).rejects.toThrow('等不到')
    prompt.close()
    await done
  })
})
