// src/main/git/gitService.ts
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { DiffStats } from '@shared/types'

const pexec = promisify(execFile)

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string
  ) {
    super(`${command} 失敗：${stderr.trim()}`)
  }
}

export async function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await pexec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new CommandError(`${cmd} ${args.join(' ')}`, err.stderr || err.message)
  }
}

/** core.quotePath=false：非 ASCII 路徑原樣輸出，不用八進位跳脫 */
const git = (cwd: string, ...args: string[]) =>
  runCommand('git', ['-c', 'core.quotePath=false', ...args], cwd)

export function parseNumstat(out: string): DiffStats {
  const perFile = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...rest] = line.split('\t')
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

  async branches(repo: string) {
    return (await git(repo, 'branch', '--format=%(refname:short)'))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  async currentBranch(repo: string) {
    return (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
  }

  async createWorktree(repo: string, worktreePath: string, branch: string, base: string) {
    await mkdir(dirname(worktreePath), { recursive: true })
    await git(repo, 'worktree', 'add', '-b', branch, worktreePath, base)
  }

  async commitAll(wt: string, message: string): Promise<string | null> {
    await git(wt, 'add', '-A')
    if (!(await git(wt, 'diff', '--cached', '--name-only')).trim()) return null
    await git(wt, 'commit', '-q', '-m', message)
    return (await git(wt, 'rev-parse', 'HEAD')).trim()
  }

  /** --no-renames：改名一律視為刪除＋新增，與 diffStats 的逐檔路徑一致 */
  diff(wt: string, base: string) {
    return git(wt, 'diff', '--no-renames', `${base}...HEAD`)
  }

  /** --no-renames：numstat 遇到改名會輸出 `old => new`，關掉後每列都是單純路徑 */
  async diffStats(wt: string, base: string) {
    return parseNumstat(await git(wt, 'diff', '--numstat', '--no-renames', `${base}...HEAD`))
  }

  /** 含未 commit 與未追蹤檔案，相對於 base 的統計（實作中的「變更檔案」面板用） */
  async workingStats(wt: string, base: string) {
    await git(wt, 'add', '-A', '-N')
    const mergeBase = (await git(wt, 'merge-base', base, 'HEAD')).trim()
    return parseNumstat(await git(wt, 'diff', '--numstat', '--no-renames', mergeBase))
  }

  async merge(repo: string, branch: string, base: string) {
    if ((await git(repo, 'status', '--porcelain')).trim()) {
      throw new CommandError('git status', '原 repo 有未提交的變更，請先處理後再合併')
    }
    const current = await this.currentBranch(repo)
    if (current !== base)
      throw new CommandError('git rev-parse', `原 repo 目前在 ${current}，請切回 ${base} 再合併`)
    await git(repo, 'merge', '--no-ff', branch, '-m', `Merge ${branch}`)
  }

  async removeWorktree(repo: string, wt: string, branch: string) {
    await git(repo, 'worktree', 'remove', '--force', wt).catch(() => git(repo, 'worktree', 'prune'))
    await git(repo, 'branch', '-D', branch)
  }

  async pushAndOpenPr(
    wt: string,
    branch: string,
    base: string,
    title: string,
    body: string
  ): Promise<string> {
    await git(wt, 'push', '-u', 'origin', branch)
    const out = await runCommand(
      'gh',
      ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body],
      wt
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
  | 'createWorktree'
  | 'commitAll'
  | 'diff'
  | 'diffStats'
  | 'workingStats'
  | 'merge'
  | 'removeWorktree'
  | 'pushAndOpenPr'
>
