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

  test('detached HEAD：branches 只列真正的分支，branchInfo 的 current 取第一個分支', async () => {
    sh(repo, 'branch', 'develop')
    sh(repo, 'tag', 'v1')
    sh(repo, 'checkout', '-q', '--detach')
    expect(await git.branches(repo)).toEqual(['develop', 'main'])
    expect(await git.currentBranch(repo)).toBe('HEAD')
    expect(await git.branchInfo(repo)).toEqual({
      branches: ['develop', 'main'],
      current: 'develop'
    })
    sh(repo, 'checkout', '-q', 'develop')
    expect(await git.branchInfo(repo)).toEqual({
      branches: ['develop', 'main'],
      current: 'develop'
    })
  })

  test('分支與 tag 同名時仍回傳正確的分支名稱', async () => {
    // 停在 main 時建立同名 tag；測試本身不再用 main 這個名字下 git 指令，避免 ambiguous 警告
    sh(repo, 'branch', 'alpha')
    sh(repo, 'tag', 'main')
    expect(await git.branches(repo)).toEqual(['alpha', 'main'])
    expect(await git.currentBranch(repo)).toBe('main')
    expect(await git.branchInfo(repo)).toEqual({ branches: ['alpha', 'main'], current: 'main' })
  })

  test('沒有任何 commit 的 repo：沒有分支，current 為空字串', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'harness-git-empty-'))
    try {
      sh(empty, 'init', '-q', '-b', 'main')
      expect(await git.branches(empty)).toEqual([])
      expect(await git.branchInfo(empty)).toEqual({ branches: [], current: '' })
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('branch 模式：isClean、createBranch、在原 repo commit 與 diff', async () => {
    expect(await git.isClean(repo)).toBe(true)
    await writeFile(join(repo, 'untracked.txt'), 'x\n')
    expect(await git.isClean(repo)).toBe(false)
    await rm(join(repo, 'untracked.txt'))
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-q', '-m', 'ignore')
    await writeFile(join(repo, 'ignored.txt'), 'keep\n')
    expect(await git.isClean(repo)).toBe(true)

    await git.createBranch(repo, 'harness/t1', 'main')
    expect(await git.currentBranch(repo)).toBe('harness/t1')
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n')
    expect(await git.commitAll(repo, 'change')).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.diff(repo, 'main')).toContain('+two')
    await git.checkout(repo, 'main')
    expect(await git.currentBranch(repo)).toBe('main')
    await expect(git.createBranch(repo, '--evil', 'main')).rejects.toThrow('不合法的分支名稱')
  })

  test('discardBranch：清掉未提交變更（保留 ignore 的檔案）、切回 base、刪除分支', async () => {
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-q', '-m', 'ignore')
    await git.createBranch(repo, 'harness/t1', 'main')
    await writeFile(join(repo, 'a.txt'), 'changed\n')
    await writeFile(join(repo, 'new.txt'), 'new\n')
    await writeFile(join(repo, 'ignored.txt'), 'keep\n')
    await git.discardBranch(repo, 'harness/t1', 'main')
    expect(await git.currentBranch(repo)).toBe('main')
    expect(await git.branches(repo)).toEqual(['main'])
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(existsSync(join(repo, 'ignored.txt'))).toBe(true)
    expect(sh(repo, 'show', 'HEAD:a.txt')).toBe('one\n')
    expect(await git.isClean(repo)).toBe(true)
  })

  test('discardBranch：原 repo 已不在任務分支時不動工作目錄，只刪分支', async () => {
    await git.createBranch(repo, 'harness/t1', 'main')
    sh(repo, 'checkout', '-q', 'main')
    await writeFile(join(repo, 'mine.txt'), 'user\n')
    await git.discardBranch(repo, 'harness/t1', 'main')
    expect(existsSync(join(repo, 'mine.txt'))).toBe(true)
    expect(await git.branches(repo)).toEqual(['main'])
    // 分支已經不在也不算失敗
    await git.deleteBranch(repo, 'harness/t1')
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

  test('commitAll 不執行任何 git hook（hook 檔案在 worktree 裡，Claude 改得到）', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    // repo 設定的 core.hooksPath 指向 worktree 裡的 .husky：pre-commit 失敗、post-commit 寫標記
    const marker = join(await mkdtemp(join(tmpdir(), 'harness-hook-')), 'ran')
    await mkdir(join(wt, '.husky'))
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
      await writeFile(
        join(wt, '.husky', hook),
        `#!/bin/sh\necho ${hook} >> "${marker}"\n${hook === 'pre-commit' ? 'exit 1\n' : ''}`,
        { mode: 0o755 }
      )
    }
    sh(repo, 'config', 'core.hooksPath', '.husky')
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
    expect(await git.commitAll(wt, 'change')).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(marker)).toBe(false)
    expect(sh(wt, 'status', '--porcelain')).toBe('')
    // 確認 hook 本身有效：一般的 git commit 會執行它（pre-commit 失敗）
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\n')
    sh(wt, 'add', '-A')
    expect(() =>
      execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: wt, stdio: 'pipe' })
    ).toThrow()
    expect(existsSync(marker)).toBe(true)
  })

  test('hooksPath：回傳 repo 設定的 core.hooksPath（相對路徑以 worktree 為準）；沒設定時 undefined', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    expect(await git.hooksPath(wt)).toBeUndefined()
    sh(repo, 'config', 'core.hooksPath', '.githooks')
    expect(await git.hooksPath(wt)).toBe(join(wt, '.githooks'))
    sh(repo, 'config', 'core.hooksPath', '/opt/hooks')
    expect(await git.hooksPath(wt)).toBe('/opt/hooks')
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

  test('逾時就終止整個程序群組並回報錯誤，不會一直卡住', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-hang-'))
    const marker = join(dir, 'child-alive')
    const started = Date.now()
    // 子程序（sh 底下的 sleep）也要一起終止：留著的話會佔住輸出管線
    await expect(
      runCommand('sh', ['-c', `(sleep 2; touch "${marker}") & sleep 30`], dir, { timeoutMs: 200 })
    ).rejects.toThrow('逾時')
    expect(Date.now() - started).toBeLessThan(1500)
    await new Promise((r) => setTimeout(r, 2500))
    expect(existsSync(marker)).toBe(false)
  })
})

describe('GitService 的逾時', () => {
  test('push 卡住時依設定的上限終止並回報錯誤（開 PR 不會一直等）', async () => {
    const slow = new GitService({ timeouts: { network: 300 } })
    await slow.createWorktree(repo, wt, 'harness/t1', 'main')
    // ssh 連線卡住：core.sshCommand 只是 sleep
    sh(repo, 'remote', 'add', 'origin', 'ssh://example.invalid/repo.git')
    sh(repo, 'config', 'core.sshCommand', "sh -c 'sleep 30' --")
    const started = Date.now()
    await expect(slow.pushAndOpenPr(wt, 'harness/t1', 'main', 't', 'b')).rejects.toThrow('逾時')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('預設上限：commit 120 秒、push 與 gh 300 秒、其他 60 秒', () => {
    expect(new GitService().timeouts).toEqual({
      default: 60_000,
      commit: 120_000,
      network: 300_000
    })
    expect(new GitService({ timeouts: { commit: 5 } }).timeouts).toEqual({
      default: 60_000,
      commit: 5,
      network: 300_000
    })
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
