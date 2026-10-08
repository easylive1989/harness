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
  /** 逾時毫秒數（預設 60 秒）：逾時就終止整個程序群組並回報錯誤，不會一直卡住 */
  timeoutMs?: number
}

/** 逾時送出 SIGTERM 後，等這麼久還沒結束就送 SIGKILL */
const KILL_GRACE_MS = 1000

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  opts: RunOptions = {}
): Promise<string> {
  const command = `${cmd} ${args.join(' ')}`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUTS.default
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, {
      cwd,
      // GIT_TERMINAL_PROMPT=0：需要帳密時直接失敗，不要卡在看不到的提示
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // 自成 process group：逾時可連同子程序（git 底下的 ssh、hook，gh 的子程序）一起終止
      detached: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        /* 已經結束 */
      }
    }
    const timer = setTimeout(() => {
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      // 不等 close：子程序可能還佔著輸出管線
      settle(() =>
        fail(new CommandError(command, `執行逾時（超過 ${timeoutMs / 1000} 秒），已終止`))
      )
    }, timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr?.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* 程序提早結束時忽略 EPIPE，以 exit code 為準 */
      })
      child.stdin.end(opts.input)
    }
    child.on('error', (err) => settle(() => fail(new CommandError(command, err.message))))
    child.on('close', (code, signal) =>
      settle(() => {
        if (code === 0) done(stdout)
        else
          fail(
            new CommandError(
              command,
              stderr.trim() || stdout.trim() || `結束代碼 ${code ?? signal}`
            )
          )
      })
    )
  })
}

/** git／gh 指令的逾時上限（毫秒） */
export interface GitTimeouts {
  /** 查詢、diff、刪除 worktree 等其他操作 */
  default: number
  /** commit、合併、建立 worktree（會寫入檔案或執行 hook） */
  commit: number
  /** push 與 gh pr create（走網路） */
  network: number
}
export const DEFAULT_GIT_TIMEOUTS: GitTimeouts = {
  default: 60_000,
  commit: 120_000,
  network: 300_000
}

/** core.quotePath=false：非 ASCII 路徑原樣輸出，不用八進位跳脫 */
const gitRun = (cwd: string, args: string[], opts: RunOptions = {}) =>
  runCommand('git', ['-c', 'core.quotePath=false', ...args], cwd, opts)

/** diff 輸出固定格式：不上色、不走外部 diff 工具、改名視為刪除＋新增 */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-renames']

/** 擋掉會被 git 當成選項的名稱（如 `--output=...`）與不合法的分支名稱 */
export async function assertRefName(cwd: string, name: string): Promise<void> {
  const invalid = () => new CommandError('git check-ref-format', `不合法的分支名稱：${name}`)
  if (!name || name.startsWith('-')) throw invalid()
  try {
    await gitRun(cwd, ['check-ref-format', '--branch', name])
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
  readonly timeouts: GitTimeouts

  constructor(opts: { timeouts?: Partial<GitTimeouts> } = {}) {
    this.timeouts = { ...DEFAULT_GIT_TIMEOUTS, ...opts.timeouts }
  }

  private git(cwd: string, ...args: string[]) {
    return gitRun(cwd, args, { timeoutMs: this.timeouts.default })
  }

  async isRepo(dir: string): Promise<boolean> {
    try {
      return (await this.git(dir, 'rev-parse', '--is-inside-work-tree')).trim() === 'true'
    } catch {
      return false
    }
  }

  async repoRoot(dir: string) {
    return (await this.git(dir, 'rev-parse', '--show-toplevel')).trim()
  }

  /**
   * 本地分支名稱。用 for-each-ref 只列 refs/heads/：`git branch` 在 detached HEAD 時
   * 會多出「(HEAD detached at …)」這種不是分支的項目；lstrip=2 在分支和 tag 同名時也不會變成 heads/x。
   */
  async branches(repo: string) {
    return (await this.git(repo, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'))
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
      return (await this.git(repo, 'symbolic-ref', '--quiet', 'HEAD'))
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
    await gitRun(repo, ['worktree', 'add', '-b', branch, '--end-of-options', worktreePath, base], {
      timeoutMs: this.timeouts.commit
    })
  }

  /** 沒有未提交的變更（含未追蹤檔案；.gitignore 忽略的不算） */
  async isClean(repo: string): Promise<boolean> {
    return !(await this.git(repo, 'status', '--porcelain')).trim()
  }

  /** branch 模式：在原 repo 資料夾從 base 建立並切換到新分支 */
  async createBranch(repo: string, branch: string, base: string) {
    await assertRefName(repo, branch)
    await assertRefName(repo, base)
    await gitRun(repo, ['checkout', '-b', branch, '--end-of-options', base], {
      timeoutMs: this.timeouts.commit
    })
  }

  async checkout(repo: string, branch: string) {
    await assertRefName(repo, branch)
    await gitRun(repo, ['checkout', '--end-of-options', branch], {
      timeoutMs: this.timeouts.commit
    })
  }

  /**
   * branch 模式丟棄任務：放棄未提交的變更（含未追蹤檔案，.gitignore 忽略的保留）、切回 base、刪除任務分支。
   * 建立任務時原 repo 一定是乾淨的，所以未提交的變更都是任務期間產生的。
   * 原 repo 已經不在任務分支上（使用者自己切走了）時不動工作目錄，只刪分支。
   */
  async discardBranch(repo: string, branch: string, base: string) {
    await assertRefName(repo, branch)
    await assertRefName(repo, base)
    if ((await this.currentBranch(repo)) === branch) {
      await this.git(repo, 'reset', '--hard', '-q')
      await this.git(repo, 'clean', '-fdq')
      await this.checkout(repo, base)
    }
    await this.deleteBranch(repo, branch)
  }

  /** 刪除本機分支；分支本來就不存在時不算失敗 */
  async deleteBranch(repo: string, branch: string) {
    await assertRefName(repo, branch)
    try {
      await this.git(repo, 'branch', '-D', '--end-of-options', branch)
    } catch (e) {
      const exists = await this.git(
        repo,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`
      )
        .then(() => true)
        .catch(() => false)
      if (exists) throw e
    }
  }

  /**
   * commit worktree 裡的所有變更（提交報告時由 app 自動執行）。不執行任何 git hook：
   * hook（.husky/、.githooks/、lefthook、pre-commit、core.hooksPath 指向的資料夾）是 worktree 裡
   * Claude 改得到的檔案，在這裡執行等於讓 Claude 不經指令核准就跑任意程式。
   * --no-verify 只跳過 pre-commit 與 commit-msg，所以再把 core.hooksPath 指到 /dev/null，
   * post-commit 等其他 hook 也不會執行。合併與 push 是使用者看過 diff 後按的，照常執行 hook。
   */
  async commitAll(wt: string, message: string): Promise<string | null> {
    await this.git(wt, 'add', '-A')
    if (!(await this.git(wt, 'diff', '--cached', '--name-only')).trim()) return null
    await gitRun(
      wt,
      ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', message],
      { timeoutMs: this.timeouts.commit }
    )
    return (await this.git(wt, 'rev-parse', 'HEAD')).trim()
  }

  /**
   * repo 設定的 core.hooksPath（絕對路徑；相對路徑以 worktree 根目錄為準，`~` 由 git 展開），
   * 沒有設定時 undefined。PermissionGate 用它把 worktree 裡的 hook 資料夾列為受保護的路徑。
   */
  async hooksPath(wt: string): Promise<string | undefined> {
    let out: string
    try {
      out = await this.git(wt, 'config', '--type=path', '--get', 'core.hooksPath')
    } catch {
      return undefined
    }
    const p = out.trim()
    return p ? resolve(wt, p) : undefined
  }

  diff(wt: string, base: string) {
    return this.git(
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
      await this.git(
        wt,
        'diff',
        '--numstat',
        '-z',
        ...DIFF_FLAGS,
        '--end-of-options',
        `${base}...HEAD`
      )
    )
  }

  /**
   * 含未 commit 與未追蹤檔案，相對於 base 的統計（實作中的「變更檔案」面板用）。
   * `add -N` 在暫存的 index 複本上做，不改動 worktree 真正的 index。
   */
  async workingStats(wt: string, base: string) {
    const mergeBase = (await this.git(wt, 'merge-base', '--end-of-options', base, 'HEAD')).trim()
    const realIndex = resolve(wt, (await this.git(wt, 'rev-parse', '--git-path', 'index')).trim())
    const tmp = await mkdtemp(join(tmpdir(), 'harness-index-'))
    const opts = { env: { GIT_INDEX_FILE: join(tmp, 'index') }, timeoutMs: this.timeouts.default }
    try {
      if (existsSync(realIndex)) await copyFile(realIndex, opts.env.GIT_INDEX_FILE)
      await gitRun(wt, ['add', '-A', '-N'], opts)
      return parseNumstat(
        await gitRun(
          wt,
          ['diff', '--numstat', '-z', ...DIFF_FLAGS, '--end-of-options', mergeBase],
          opts
        )
      )
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  async merge(repo: string, branch: string, base: string) {
    await assertRefName(repo, branch)
    await assertRefName(repo, base)
    if ((await this.git(repo, 'status', '--porcelain')).trim()) {
      throw new CommandError('git status', '原 repo 有未提交的變更，請先處理後再合併')
    }
    const current = await this.currentBranch(repo)
    if (current !== base)
      throw new CommandError('git rev-parse', `原 repo 目前在 ${current}，請切回 ${base} 再合併`)
    try {
      // 刻意不加 --no-verify：合併是使用者看過報告與 diff 後按的，repo 的 git hooks 照常執行
      await gitRun(
        repo,
        ['merge', '--no-ff', '-m', `Merge ${branch}`, '--end-of-options', branch],
        {
          timeoutMs: this.timeouts.commit
        }
      )
    } catch (e) {
      // 衝突時還原成合併前的狀態，錯誤訊息保留 git 的 CONFLICT 輸出
      await this.git(repo, 'merge', '--abort').catch(() => undefined)
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
      await this.git(repo, 'worktree', 'remove', '--force', '--end-of-options', wt)
    } catch (e) {
      // 目錄已被手動刪掉時 remove 會失敗，prune 掉紀錄即可；目錄還在就是真的失敗
      await this.git(repo, 'worktree', 'prune').catch(() => undefined)
      if (existsSync(wt)) throw e
    }
    await this.deleteBranch(repo, branch)
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
    // push 照常執行 pre-push hook：使用者看過報告與 diff 後才按開 PR
    await gitRun(wt, ['push', '-u', '--end-of-options', 'origin', branch], {
      timeoutMs: this.timeouts.network
    })
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
      { input: body, timeoutMs: this.timeouts.network }
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
  | 'isClean'
  | 'createBranch'
  | 'checkout'
  | 'discardBranch'
  | 'deleteBranch'
  | 'commitAll'
  | 'hooksPath'
  | 'diff'
  | 'diffStats'
  | 'workingStats'
  | 'merge'
  | 'removeWorktree'
  | 'pushAndOpenPr'
>
