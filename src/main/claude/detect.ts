// src/main/claude/detect.ts
import { execFile } from 'node:child_process'
import type { ClaudeStatus } from '@shared/types'

export type Exec = (cmd: string, args: string[]) => Promise<string>

/** 執行指令並回傳 stdout；非 0 結束時若有 stdout 也回傳（`claude auth status` 未登入時會這樣） */
export const execCapture: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error(stderr || err.message))
      else resolve(stdout)
    })
  })

const shell = () => process.env.SHELL || '/bin/zsh'

export async function detectClaude(exec: Exec, explicitPath?: string): Promise<ClaudeStatus> {
  let path = explicitPath
  if (!path) {
    try {
      path = (await exec(shell(), ['-lc', 'command -v claude'])).trim() || undefined
    } catch {
      path = undefined
    }
  }
  if (!path)
    return { found: false, loggedIn: false, error: '找不到 claude 指令，請先安裝 Claude Code。' }
  try {
    const version = (await exec(path, ['--version'])).trim()
    const auth = JSON.parse(await exec(path, ['auth', 'status'])) as {
      loggedIn?: boolean
      subscriptionType?: string
      email?: string
    }
    const loggedIn = !!auth.loggedIn
    return {
      found: true,
      path,
      version,
      loggedIn,
      subscriptionType: auth.subscriptionType,
      email: auth.email,
      error: loggedIn ? undefined : '尚未登入，請在終端機執行 claude 並完成登入。'
    }
  } catch (e) {
    return {
      found: true,
      path,
      loggedIn: false,
      error: `無法讀取 Claude Code 狀態：${(e as Error).message}`
    }
  }
}

const PATH_MARKER = '__HARNESS_PATH__'

/**
 * 從 Finder 啟動時 PATH 不含 homebrew / nvm，改用 login shell 的 PATH。
 * 互動式 shell 可能印出歡迎訊息等雜訊，所以 PATH 夾在標記之間輸出，沒有標記就不採用。
 */
export async function applyLoginShellPath(exec: Exec = execCapture) {
  try {
    const out = await exec(shell(), ['-ilc', `printf "${PATH_MARKER}%s${PATH_MARKER}" "$PATH"`])
    const p = new RegExp(`${PATH_MARKER}(.*?)${PATH_MARKER}`, 's').exec(out)?.[1].trim()
    if (p) process.env.PATH = p
  } catch {
    /* 保留原本的 PATH */
  }
}
