// tests/main/taskManager.test.ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent } from '@shared/ipc'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { TaskManager, type TaskManagerDeps } from '../../src/main/tasks/taskManager'
import { sampleReport } from '../fixtures/report'
import { assistantText, FakeClaude, fakeGit, until } from './fakeClaude'

async function setup() {
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
    now: () => '2026-10-07T10:00:00.000Z'
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
    expect(claude.calls[0].tools).toEqual([
      'ask_user',
      'propose_spec',
      'update_plan',
      'submit_report'
    ])
    expect(t).toMatchObject({ status: 'clarifying', runState: 'idle', mainSessionId: 'sess-0' })
    expect(events.some((e) => e.type === 'task' && e.task.runState === 'running')).toBe(true)
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

  test('同時送出兩則訊息不會開兩段執行', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [assistantText('收到')]
    await Promise.all([
      tm.send(id, 'main', '第一則', { silent: true }),
      tm.send(id, 'main', '第二則', { silent: true })
    ])
    await tm.whenIdle(id)
    // 第二則插話進第一段執行（FakeClaude 不讀插話），所以只多一次 query
    expect(claude.calls).toHaveLength(2)
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
      result = await options.canUseTool!('Bash', { command: 'npm test -- auth' }, signalOf())
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    const req = tm.get(id).pendingPermission!
    expect(req).toMatchObject({ toolName: 'Bash', suggestedPattern: 'npm test *' })
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

  test('分岔的核准請求不影響主線的執行狀態', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('WebFetch', { url: 'https://example.com' }, signalOf())
    }
    await tm.openBranch(id, { title: '查資料' })
    await until(() => !!tm.get(id).pendingPermission)
    expect(tm.get(id).runState).toBe('idle')
    expect(tm.get(id).branches[0].running).toBe(true)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: true })
    await tm.whenIdle(id)
    expect(result?.behavior).toBe('allow')
    expect(tm.get(id)).toMatchObject({ runState: 'idle', approvedCommands: [] })
    expect(tm.get(id).branches[0].running).toBe(false)
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

async function toImplementing() {
  const ctx = await setup()
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
    tm.get(id).approvedCommands.push('npm test') // get() 回傳內部物件，模擬實作中核准過 npm test
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成了嗎？')
    await tm.whenIdle(id)
    const t = tm.get(id)
    expect(t).toMatchObject({ status: 'reviewing', runState: 'idle', reportVersions: [1] })
    const r = await repo.getReport(id, 1)
    expect(r).toMatchObject({ version: 1, commit: 'abc123', stats: { files: 1 } })
    expect(await tm.getReport(id, 1)).toEqual(r)
    expect(verify).toHaveBeenCalledWith(t.worktreePath, ['npm test'], expect.any(Function))
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
    expect(tm.get(id).reportVersions).toEqual([1, 2])
    expect(tm.get(id).status).toBe('reviewing')
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
