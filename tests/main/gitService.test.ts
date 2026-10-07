import { execFileSync } from 'node:child_process'
import { mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { GitService, parseNumstat } from '../../src/main/git/gitService'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
let repo: string
let wt: string
const git = new GitService()

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'harness-git-'))
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@t')
  sh(repo, 'config', 'user.name', 't')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-q', '-m', 'init')
  wt = join(await mkdtemp(join(tmpdir(), 'harness-wt-')), 'nested', 't1')
})

describe('GitService', () => {
  test('isRepo 與 branches', async () => {
    expect(await git.isRepo(repo)).toBe(true)
    expect(await git.isRepo(tmpdir())).toBe(false)
    expect(await git.branches(repo)).toEqual(['main'])
    expect(await git.currentBranch(repo)).toBe('main')
  })

  test('建立 worktree、commit、diff 與統計', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    expect(await git.commitAll(wt, 'noop')).toBeNull()
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(wt, 'b.txt'), 'new\n')
    const working = await git.workingStats(wt, 'main')
    expect(working.files).toBe(2)
    const sha = await git.commitAll(wt, 'change')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.diff(wt, 'main')).toContain('+two')
    expect(await git.diffStats(wt, 'main')).toEqual({
      files: 2,
      additions: 2,
      deletions: 0,
      perFile: [
        { path: 'a.txt', additions: 1, deletions: 0 },
        { path: 'b.txt', additions: 1, deletions: 0 }
      ]
    })
  })

  test('改名視為刪除加新增，路徑不含 =>', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await rename(join(wt, 'a.txt'), join(wt, 'renamed.txt'))
    const expected = {
      files: 2,
      additions: 1,
      deletions: 1,
      perFile: [
        { path: 'a.txt', additions: 0, deletions: 1 },
        { path: 'renamed.txt', additions: 1, deletions: 0 }
      ]
    }
    expect(await git.workingStats(wt, 'main')).toEqual(expected)
    await git.commitAll(wt, 'rename')
    expect(await git.diffStats(wt, 'main')).toEqual(expected)
  })

  test('merge 前檢查原 repo 狀態', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'c.txt'), 'c\n')
    await git.commitAll(wt, 'add c')
    await writeFile(join(repo, 'dirty.txt'), 'x')
    await expect(git.merge(repo, 'harness/t1', 'main')).rejects.toThrow('未提交的變更')
    sh(repo, 'clean', '-fq')
    await git.merge(repo, 'harness/t1', 'main')
    expect(sh(repo, 'log', '--oneline')).toContain('Merge harness/t1')
  })

  test('removeWorktree 刪除 worktree 與分支', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await git.removeWorktree(repo, wt, 'harness/t1')
    expect(await git.branches(repo)).toEqual(['main'])
  })
})

describe('parseNumstat', () => {
  test('二進位檔以 0 計', () => {
    expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n')).toEqual({
      files: 2,
      additions: 3,
      deletions: 1,
      perFile: [
        { path: 'a.ts', additions: 3, deletions: 1 },
        { path: 'img.png', additions: 0, deletions: 0 }
      ]
    })
  })
})
