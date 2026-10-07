// src/main/git/gitService.ts
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DiffStats } from '@shared/types'

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string
  ) {
    super(`${command} 失敗：${stderr.trim()}`)
  }
}

export interface RunOptions {
  /** 額外的環境變數（與 process.env 合併） */
  env?: Record<string, string>
  /** 寫入 stdin 的內容；沒給時 stdin 為空 */
  input?: string
}

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  opts: RunOptions = {}
): Promise<string> {
  const command = `${cmd} ${args.join(' ')}`
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, {
      cwd,
      // GIT_TERMINAL_PROMPT=0：需要帳密時直接失敗，不要卡在看不到的提示
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr?.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* 程序提早結束時忽略 EPIPE，以 exit code 為準 */
      })
      child.stdin.end(opts.input)
    }
    child.on('error', (err) => fail(new CommandError(command, err.message)))
    child.on('close', (code, signal) => {
      if (code === 0) done(stdout)
      else
        fail(
          new CommandError(command, stderr.trim() || stdout.trim() || `結束代碼 ${code ?? signal}`)
        )
    })
  })
}

/** core.quotePath=false：非 ASCII 路徑原樣輸出，不用八進位跳脫 */
const git = (cwd: string, ...args: string[]) =>
  runCommand('git', ['-c', 'core.quotePath=false', ...args], cwd)

const gitEnv = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  runCommand('git', ['-c', 'core.quotePath=false', ...args], cwd, { env })

/** diff 輸出固定格式：不上色、不走外部 diff 工具、改名視為刪除＋新增 */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-renames']

/** 擋掉會被 git 當成選項的名稱（如 `--output=...`）與不合法的分支名稱 */
export async function assertRefName(cwd: string, name: string): Promise<void> {
  const invalid = () => new CommandError('git check-ref-format', `不合法的分支名稱：${name}`)
  if (!name || name.startsWith('-')) throw invalid()
  try {
    await git(cwd, 'check-ref-format', '--branch', name)
  } catch {
    throw invalid()
  }
}

/** 解析 `git diff --numstat -z --no-renames`：每筆是 `add\tdel\tpath\0`，路徑不跳脫 */
export function parseNumstat(out: string): DiffStats {
  const perFile = out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [a, d, ...rest] = record.split('\t')
      return {
        path: rest.join('\t'),
        additions: a === '-' ? 0 : Number(a),
        deletions: d === '-' ? 0 : Number(d)
      }
    })
  return {
    files: perFile.length,
    additions: perFile.reduce((s, f) => s + f.additions, 0),
    deletions: perFile.reduce((s, f) => s + f.deletions, 0),
    perFile
  }
}

export class GitService {
  async isRepo(dir: string): Promise<boolean> {
    try {
      return (await git(dir, 'rev-parse', '--is-inside-work-tree')).trim() === 'true'
    } catch {
      return false
    }
  }

  async repoRoot(dir: string) {
    return (await git(dir, 'rev-parse', '--show-toplevel')).trim()
  }

  /**
   * 本地分支名稱。用 for-each-ref 只列 refs/heads/：`git branch` 在 detached HEAD 時
   * 會多出「(HEAD detached at …)」這種不是分支的項目；lstrip=2 在分支和 tag 同名時也不會變成 heads/x。
   */
  async branches(repo: string) {
    return (await git(repo, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /**
   * 目前所在的分支；detached HEAD 時是 'HEAD'。
   * 用 symbolic-ref 而不是 `rev-parse --abbrev-ref`：後者在分支和 tag 同名時會回 heads/x。
   */
  async currentBranch(repo: string) {
    try {
      return (await git(repo, 'symbolic-ref', '--quiet', 'HEAD'))
        .trim()
        .replace(/^refs\/heads\//, '')
    } catch {
      return 'HEAD'
    }
  }

  /** 給「從哪個分支開始」用：current 一定是 branches 之一（detached HEAD 時取第一個分支，沒有分支時為空字串） */
  async branchInfo(repo: string): Promise<{ branches: string[]; current: string }> {
    const [branches, current] = await Promise.all([this.branches(repo), this.currentBranch(repo)])
    return { branches, current: branches.includes(current) ? current : (branches[0] ?? '') }
  }

  async createWorktree(repo: string, worktreePath: string, branch: string, base: string) {
    await assertRefName(repo, branch)
    await assertRefName(repo, base)
    await mkdir(dirname(worktreePath), { recursive: true })
    await git(repo, 'worktree', 'add', '-b', branch, '--end-of-options', worktreePath, base)
  }

  async commitAll(wt: string, message: string): Promise<string | null> {
    await git(wt, 'add', '-A')
    if (!(await git(wt, 'diff', '--cached', '--name-only')).trim()) return null
    // 刻意不加 --no-verify：repo 的 git hooks 照常執行
    await git(wt, 'commit', '-q', '-m', message)
    return (await git(wt, 'rev-parse', 'HEAD')).trim()
  }

  diff(wt: string, base: string) {
    return git(
      wt,
      'diff',
      ...DIFF_FLAGS,
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--end-of-options',
      `${base}...HEAD`
    )
  }

  async diffStats(wt: string, base: string) {
    return parseNumstat(
      await git(wt, 'diff', '--numstat', '-z', ...DIFF_FLAGS, '--end-of-options', `${base}...HEAD`)
    )
  }

  /**
   * 含未 commit 與未追蹤檔案，相對於 base 的統計（實作中的「變更檔案」面板用）。
   * `add -N` 在暫存的 index 複本上做，不改動 worktree 真正的 index。
   */
  async workingStats(wt: string, base: string) {
    const mergeBase = (await git(wt, 'merge-base', '--end-of-options', base, 'HEAD')).trim()
    const realIndex = resolve(wt, (await git(wt, 'rev-parse', '--git-path', 'index')).trim())
    const tmp = await mkdtemp(join(tmpdir(), 'harness-index-'))
    const env = { GIT_INDEX_FILE: join(tmp, 'index') }
    try {
      if (existsSync(realIndex)) await copyFile(realIndex, env.GIT_INDEX_FILE)
      await gitEnv(wt, env, 'add', '-A', '-N')
      return parseNumstat(
        await gitEnv(
          wt,
          env,
          'diff',
          '--numstat',
          '-z',
          ...DIFF_FLAGS,
          '--end-of-options',
          mergeBase
        )
      )
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  async merge(repo: string, branch: string, base: string) {
    await assertRefName(repo, branch)
    await assertRefName(repo, base)
    if ((await git(repo, 'status', '--porcelain')).trim()) {
      throw new CommandError('git status', '原 repo 有未提交的變更，請先處理後再合併')
    }
    const current = await this.currentBranch(repo)
    if (current !== base)
      throw new CommandError('git rev-parse', `原 repo 目前在 ${current}，請切回 ${base} 再合併`)
    try {
      // 刻意不加 --no-verify：repo 的 git hooks 照常執行
      await git(repo, 'merge', '--no-ff', '-m', `Merge ${branch}`, '--end-of-options', branch)
    } catch (e) {
      // 衝突時還原成合併前的狀態，錯誤訊息保留 git 的 CONFLICT 輸出
      await git(repo, 'merge', '--abort').catch(() => undefined)
      const detail = e instanceof CommandError ? e.stderr : String(e)
      throw new CommandError(
        `git merge ${branch}`,
        `${detail}\n已中止合併，原 repo 維持合併前的狀態`
      )
    }
  }

  async removeWorktree(repo: string, wt: string, branch: string) {
    await assertRefName(repo, branch)
    try {
      await git(repo, 'worktree', 'remove', '--force', '--end-of-options', wt)
    } catch (e) {
      // 目錄已被手動刪掉時 remove 會失敗，prune 掉紀錄即可；目錄還在就是真的失敗
      await git(repo, 'worktree', 'prune').catch(() => undefined)
      if (existsSync(wt)) throw e
    }
    try {
      await git(repo, 'branch', '-D', '--end-of-options', branch)
    } catch (e) {
      const exists = await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
        .then(() => true)
        .catch(() => false)
      if (exists) throw e
    }
  }

  async pushAndOpenPr(
    wt: string,
    branch: string,
    base: string,
    title: string,
    body: string
  ): Promise<string> {
    await assertRefName(wt, branch)
    await assertRefName(wt, base)
    await git(wt, 'push', '-u', '--end-of-options', 'origin', branch)
    const out = await runCommand(
      'gh',
      [
        'pr',
        'create',
        `--base=${base}`,
        `--head=${branch}`,
        `--title=${title}`,
        '--body-file',
        '-'
      ],
      wt,
      { input: body }
    )
    return out.trim().split('\n').pop() ?? ''
  }
}

export type GitLike = Pick<
  GitService,
  | 'isRepo'
  | 'repoRoot'
  | 'branches'
  | 'currentBranch'
  | 'branchInfo'
  | 'createWorktree'
  | 'commitAll'
  | 'diff'
  | 'diffStats'
  | 'workingStats'
  | 'merge'
  | 'removeWorktree'
  | 'pushAndOpenPr'
>
