// src/main/verify/verifyRunner.ts
import { spawn } from 'node:child_process'
import type { VerificationResult } from '@shared/types'

/** 逾時送出 SIGTERM 後，等這麼久還沒結束就送 SIGKILL */
const KILL_GRACE_MS = 2000
/** 中止（關閉 app）時的寬限較短，才能在關閉的時間上限內結束 */
const ABORT_KILL_GRACE_MS = 500
const TAIL_CHARS = 4000
const TIMEOUT_MARKER = '\n[Harness] 執行逾時，已終止'
const ABORT_MARKER = '\n[Harness] 已取消'

/**
 * 在 cwd 以 login shell 執行指令，回傳 exit code 與輸出結尾。
 * signal 中止時終止整個 process group（先 TERM，寬限後 KILL），輸出結尾標示已取消。
 */
export function runShell(
  cwd: string,
  command: string,
  timeoutMs = 10 * 60_000,
  signal?: AbortSignal
): Promise<VerificationResult> {
  const started = Date.now()
  if (signal?.aborted)
    return Promise.resolve({
      command,
      exitCode: null,
      durationMs: 0,
      outputTail: ABORT_MARKER.trim()
    })
  return new Promise((resolve) => {
    // detached：子程序自成 process group，逾時才能連同孫程序一起終止
    // stdin 為空：讀 stdin 的指令立刻拿到 EOF，不會卡住
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let timedOut = false
    let aborted = false
    // utf8 decoder 會保留跨 chunk 的多位元組字元
    const onData = (s: string) => {
      out = (out + s).slice(-2 * TAIL_CHARS)
    }
    child.stdout.setEncoding('utf8').on('data', onData)
    child.stderr.setEncoding('utf8').on('data', onData)
    // 只殺 shell 的話，孫程序會繼續佔住 stdout，close 要等它自己結束才會觸發
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        child.kill(signal)
      }
    }
    let killTimer: NodeJS.Timeout | undefined
    const terminate = (graceMs: number) => {
      if (killTimer) return
      killGroup('SIGTERM')
      // 忽略 SIGTERM 的程序在寬限期後強制終止
      killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate(KILL_GRACE_MS)
    }, timeoutMs)
    const onAbort = () => {
      aborted = true
      terminate(ABORT_KILL_GRACE_MS)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    /** 逾時／取消標記在結算時才接上，確保一定留在 tail 裡 */
    const tail = () => {
      const marker = aborted ? ABORT_MARKER : timedOut ? TIMEOUT_MARKER : ''
      return out.slice(-(TAIL_CHARS - marker.length)) + marker
    }
    child.on('close', (code) => {
      cleanup()
      resolve({ command, exitCode: code, durationMs: Date.now() - started, outputTail: tail() })
    })
    child.on('error', (err) => {
      cleanup()
      resolve({
        command,
        exitCode: null,
        durationMs: Date.now() - started,
        outputTail: String(err)
      })
    })
  })
}

export async function runVerification(
  cwd: string,
  commands: string[],
  isAllowed: (command: string) => boolean,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = []
  for (const command of commands) {
    if (signal?.aborted) {
      results.push({
        command,
        exitCode: null,
        durationMs: 0,
        outputTail: '',
        skipped: '已取消，未執行'
      })
      continue
    }
    if (!isAllowed(command)) {
      results.push({
        command,
        exitCode: null,
        durationMs: 0,
        outputTail: '',
        skipped: '這個指令在實作期間沒有被核准過，Harness 未自動執行'
      })
      continue
    }
    results.push(await runShell(cwd, command, timeoutMs, signal))
  }
  return results
}
