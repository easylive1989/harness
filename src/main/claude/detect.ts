// src/main/claude/detect.ts
import { spawn } from 'node:child_process'
import type { ClaudeStatus } from '@shared/types'

export interface ExecOptions {
  /** 逾時毫秒數，逾時會終止整個 process group 並拒絕 */
  timeoutMs?: number
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<string>

/**
 * 執行指令並回傳 stdout；非 0 結束時若有 stdout 也回傳（`claude auth status` 未登入時會這樣）。
 * stdin 為空，避免互動式 shell 或指令等待輸入而卡住啟動流程。
 */
export const execCapture: Exec = (cmd, args, { timeoutMs = 15_000 } = {}) =>
  new Promise((resolve, reject) => {
    // detached：自成 process group，逾時可連同孫程序一起終止
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      // 不等 close：孫程序可能還佔著輸出管線
      settle(() => reject(new Error(`${cmd} 執行逾時（${timeoutMs}ms）`)))
    }, timeoutMs)
    child.on('error', (err) => settle(() => reject(err)))
    child.on('close', (code, signal) =>
      settle(() => {
        if (code !== 0 && !stdout)
          reject(new Error(stderr.trim() || `${cmd} 結束代碼 ${code ?? signal}`))
        else resolve(stdout)
      })
    )
  })

const shell = () => process.env.SHELL || '/bin/zsh'

/**
 * 偵測 claude 的路徑、版本與登入狀態。
 * 啟動時必須先執行 applyLoginShellPath 再呼叫這裡：`-lc` 不讀 .zshrc，要靠繼承來的 PATH 才找得到 claude。
 */
export async function detectClaude(exec: Exec, explicitPath?: string): Promise<ClaudeStatus> {
  let path = explicitPath
  if (!path) {
    try {
      // 取最後一個非空行，忽略 shell 啟動時可能印出的訊息
      const out = await exec(shell(), ['-lc', 'command -v claude'])
      path =
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop() || undefined
    } catch {
      path = undefined
    }
  }
  if (!path)
    return { found: false, loggedIn: false, error: '找不到 claude 指令，請先安裝 Claude Code。' }
  let version: string
  let authOut: string
  try {
    version = (await exec(path, ['--version'])).trim()
    authOut = await exec(path, ['auth', 'status'])
  } catch (e) {
    return {
      found: true,
      path,
      loggedIn: false,
      error: `無法讀取 Claude Code 狀態：${(e as Error).message}`
    }
  }
  let auth: { loggedIn?: boolean; subscriptionType?: string; email?: string }
  try {
    auth = JSON.parse(authOut)
  } catch {
    // 舊版 claude 沒有 JSON 格式的 auth status
    return {
      found: true,
      path,
      version,
      loggedIn: false,
      error: '無法讀取登入狀態，請更新 Claude Code。'
    }
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
}

const PATH_MARKER = '__HARNESS_PATH__'

/**
 * 從 Finder 啟動時 PATH 不含 homebrew / nvm，改用 login shell 的 PATH。
 * 互動式 shell 可能印出歡迎訊息等雜訊，所以 PATH 夾在標記之間輸出，沒有標記就不採用。
 * 必須在 detectClaude 之前執行。
 */
export async function applyLoginShellPath(exec: Exec = execCapture) {
  try {
    const out = await exec(shell(), ['-ilc', `printf "${PATH_MARKER}%s${PATH_MARKER}" "$PATH"`], {
      timeoutMs: 10_000
    })
    const p = new RegExp(`${PATH_MARKER}(.*?)${PATH_MARKER}`, 's').exec(out)?.[1].trim()
    if (p) process.env.PATH = p
  } catch {
    /* 保留原本的 PATH */
  }
}
