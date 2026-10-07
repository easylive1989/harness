import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { GitService, parseNumstat, runCommand } from '../../src/main/git/gitService'

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

  test('workingStats 不動到真正的 index', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(wt, 'b.txt'), 'new\n')
    const before = sh(wt, 'status', '--porcelain')
    expect((await git.workingStats(wt, 'main')).files).toBe(2)
    expect(sh(wt, 'status', '--porcelain')).toBe(before)
  })

  test('檔名含引號時路徑原樣保留', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'q"uote.txt'), 'q\n')
    expect((await git.workingStats(wt, 'main')).perFile).toEqual([
      { path: 'q"uote.txt', additions: 1, deletions: 0 }
    ])
    await git.commitAll(wt, 'quote')
    expect((await git.diffStats(wt, 'main')).perFile).toEqual([
      { path: 'q"uote.txt', additions: 1, deletions: 0 }
    ])
  })

  test('merge 衝突時中止合併並回報 CONFLICT', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'a.txt'), 'branch\n')
    await git.commitAll(wt, 'branch change')
    await writeFile(join(repo, 'a.txt'), 'main\n')
    sh(repo, 'commit', '-qam', 'main change')
    await expect(git.merge(repo, 'harness/t1', 'main')).rejects.toThrow('CONFLICT')
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(sh(repo, 'status', '--porcelain')).toBe('')
  })

  test('拒絕看起來像選項或不合法的分支名稱', async () => {
    for (const bad of ['-x', '--output=/tmp/x', 'a..b']) {
      await expect(git.createWorktree(repo, wt, bad, 'main')).rejects.toThrow('分支名稱')
      await expect(git.createWorktree(repo, wt, 'harness/t1', bad)).rejects.toThrow('分支名稱')
      await expect(git.merge(repo, bad, 'main')).rejects.toThrow('分支名稱')
      await expect(git.removeWorktree(repo, wt, bad)).rejects.toThrow('分支名稱')
      await expect(git.pushAndOpenPr(repo, bad, 'main', 't', 'b')).rejects.toThrow('分支名稱')
    }
    expect(existsSync(wt)).toBe(false)
    expect(await git.branches(repo)).toEqual(['main'])
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
    expect(existsSync(wt)).toBe(false)
  })

  test('removeWorktree：目錄與分支已不存在時視為成功', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await rm(wt, { recursive: true, force: true })
    sh(repo, 'worktree', 'prune')
    sh(repo, 'branch', '-D', 'harness/t1')
    await git.removeWorktree(repo, wt, 'harness/t1')
    expect(await git.branches(repo)).toEqual(['main'])
  })

  test('removeWorktree：移除失敗且目錄仍在時拋出原本的錯誤', async () => {
    await mkdir(wt, { recursive: true })
    sh(repo, 'branch', 'harness/t1')
    await expect(git.removeWorktree(repo, wt, 'harness/t1')).rejects.toThrow('worktree remove')
    expect(await git.branches(repo)).toContain('harness/t1')
  })
})

describe('runCommand', () => {
  test('錯誤訊息在 stderr 為空時改用 stdout', async () => {
    // 輸出 "out-put" 不出現在指令文字裡，確保訊息真的來自 stdout
    await expect(
      runCommand('sh', ['-c', 'printf "%s-%s" out put; exit 1'], tmpdir())
    ).rejects.toThrow('失敗：out-put')
  })

  test('支援 stdin 與額外環境變數，並關閉 git 的帳密提示', async () => {
    expect(await runCommand('cat', [], tmpdir(), { input: 'from-stdin' })).toBe('from-stdin')
    const out = await runCommand(
      'sh',
      ['-c', 'printf "%s %s" "$GIT_TERMINAL_PROMPT" "$FOO"'],
      tmpdir(),
      {
        env: { FOO: 'bar' }
      }
    )
    expect(out).toBe('0 bar')
  })

  test('沒有 input 時 stdin 是空的，不會卡住', async () => {
    expect(await runCommand('cat', [], tmpdir())).toBe('')
  })
})

describe('parseNumstat', () => {
  test('-z 輸出的路徑可含換行與 tab', () => {
    expect(parseNumstat('1\t0\ta\nb\tc.txt\0').perFile).toEqual([
      { path: 'a\nb\tc.txt', additions: 1, deletions: 0 }
    ])
  })

  test('二進位檔以 0 計', () => {
    expect(parseNumstat('3\t1\ta.ts\0-\t-\timg.png\0')).toEqual({
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
