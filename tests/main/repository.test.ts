import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { makeTask } from '../fixtures/task'
import { sampleReport } from '../fixtures/report'

let repo: Repository
beforeEach(async () => {
  repo = new Repository(new Store(await mkdtemp(join(tmpdir(), 'harness-repo-'))), '/Users/me')
})

describe('Repository', () => {
  test('設定有預設值，儲存後合併', async () => {
    const s = await repo.getSettings()
    expect(s.worktreeRoot).toBe('/Users/me/.harness/worktrees')
    expect(s.defaultModel).toBe('claude-opus-5-5')
    await repo.saveSettings({ ...s, branchPrefix: 'x/' })
    expect((await repo.getSettings()).branchPrefix).toBe('x/')
  })

  test('任務依建立時間新到舊排序', async () => {
    await repo.saveTask(makeTask({ id: 'a', createdAt: '2026-10-01T00:00:00Z' }))
    await repo.saveTask(makeTask({ id: 'b', createdAt: '2026-10-05T00:00:00Z' }))
    expect((await repo.listTasks()).map((t) => t.id)).toEqual(['b', 'a'])
  })

  test('時間軸 append 與讀取', async () => {
    await repo.appendTimeline('a', {
      id: 'e1',
      ts: 'x',
      channel: 'main',
      kind: 'user_text',
      text: 'hi'
    })
    expect(await repo.readTimeline('a')).toHaveLength(1)
  })

  test('報告存取，不存在時丟錯', async () => {
    const r = {
      version: 1,
      taskId: 'a',
      input: sampleReport,
      diff: '',
      stats: { files: 0, additions: 0, deletions: 0, perFile: [] },
      verification: [],
      createdAt: 'x'
    }
    await repo.saveReport(r)
    expect((await repo.getReport('a', 1)).version).toBe(1)
    await expect(repo.getReport('a', 2)).rejects.toThrow('v2')
  })
})
