import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { makeTask } from '../fixtures/task'
import { sampleReport } from '../fixtures/report'

let root: string
let repo: Repository
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-repo-'))
  repo = new Repository(new Store(root), '/Users/me')
})

describe('Repository', () => {
  test('設定有預設值，儲存後合併', async () => {
    const s = await repo.getSettings()
    expect(s.worktreeRoot).toBe('/Users/me/.harness/worktrees')
    expect(s.defaultModel).toBe('claude-opus-5-5')
    // git diff / git log 帶任意參數可用 --output 寫檔，所以只預設允許不帶參數的版本
    expect(s.alwaysAllowedCommands).toEqual(['git status', 'git diff', 'git log', 'ls', 'ls *'])
    await repo.saveSettings({ ...s, branchPrefix: 'x/' })
    expect((await repo.getSettings()).branchPrefix).toBe('x/')
  })

  test('updateSettings 依序合併：同時更新不同欄位都會保留', async () => {
    const [a, b] = await Promise.all([
      repo.updateSettings({ branchPrefix: 'a/' }),
      repo.updateSettings({ loadProjectSettings: false })
    ])
    expect(a.branchPrefix).toBe('a/')
    expect(b).toMatchObject({ branchPrefix: 'a/', loadProjectSettings: false })
    expect(await repo.getSettings()).toMatchObject({
      branchPrefix: 'a/',
      loadProjectSettings: false
    })
  })

  test('讀取排在進行中的更新之後，不會讀到舊值', async () => {
    const [, read] = await Promise.all([
      repo.updateSettings({ branchPrefix: 'a/' }),
      repo.getSettings()
    ])
    expect(read.branchPrefix).toBe('a/')
  })

  test('cachedSettings：尚未讀取時是預設值，之後是最近一次讀取或寫入的設定', async () => {
    expect(repo.cachedSettings().branchPrefix).toBe('harness/')
    await writeFile(join(root, 'settings.json'), JSON.stringify({ branchPrefix: 'disk/' }))
    await repo.getSettings()
    expect(repo.cachedSettings().branchPrefix).toBe('disk/')
    await repo.updateSettings({ alwaysAllowedCommands: ['npm test'] })
    expect(repo.cachedSettings()).toMatchObject({
      branchPrefix: 'disk/',
      alwaysAllowedCommands: ['npm test']
    })
  })

  test('寫入失敗時快取維持原值，之後的更新照常進行', async () => {
    const store = new Store(root)
    const failing = new Repository(store, '/Users/me')
    await failing.getSettings()
    const write = vi.spyOn(store, 'writeJson').mockRejectedValueOnce(new Error('disk full'))
    await expect(failing.updateSettings({ branchPrefix: 'x/' })).rejects.toThrow('disk full')
    expect(failing.cachedSettings().branchPrefix).toBe('harness/')
    write.mockRestore()
    expect((await failing.updateSettings({ branchPrefix: 'y/' })).branchPrefix).toBe('y/')
  })

  test('任務依建立時間新到舊排序', async () => {
    await repo.saveTask(makeTask({ id: 'a', createdAt: '2026-10-01T00:00:00Z' }))
    await repo.saveTask(makeTask({ id: 'b', createdAt: '2026-10-05T00:00:00Z' }))
    expect((await repo.listTasks()).map((t) => t.id)).toEqual(['b', 'a'])
  })

  test('tasks 資料夾裡的雜檔（如 .DS_Store）不影響任務清單', async () => {
    await repo.saveTask(makeTask({ id: 'a' }))
    await mkdir(join(root, 'tasks'), { recursive: true })
    await writeFile(join(root, 'tasks/.DS_Store'), '')
    await writeFile(join(root, 'tasks/stray.txt'), '')
    expect((await repo.listTasks()).map((t) => t.id)).toEqual(['a'])
  })

  test('壞掉的 task.json 會被略過，不影響其他任務', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await repo.saveTask(makeTask({ id: 'a' }))
    await mkdir(join(root, 'tasks/bad'), { recursive: true })
    await writeFile(join(root, 'tasks/bad/task.json'), '{"id":')
    expect((await repo.listTasks()).map((t) => t.id)).toEqual(['a'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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
