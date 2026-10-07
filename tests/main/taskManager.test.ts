// tests/main/taskManager.test.ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { AppEvent } from '@shared/ipc'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { TaskManager, type TaskManagerDeps } from '../../src/main/tasks/taskManager'
import { assistantText, FakeClaude, fakeGit } from './fakeClaude'

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
