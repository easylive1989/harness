// src/main/verify/verifyRunner.ts
import { spawn } from 'node:child_process'
import type { VerificationResult } from '@shared/types'

/** 逾時送出 SIGTERM 後，等這麼久還沒結束就送 SIGKILL */
const KILL_GRACE_MS = 2000
const TAIL_CHARS = 4000
const TIMEOUT_MARKER = '\n[Harness] 執行逾時，已終止'

export function runShell(
  cwd: string,
  command: string,
  timeoutMs = 10 * 60_000
): Promise<VerificationResult> {
  const started = Date.now()
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
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      // 忽略 SIGTERM 的程序在寬限期後強制終止
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    /** 逾時標記在結算時才接上，確保一定留在 tail 裡 */
    const tail = () =>
      timedOut
        ? out.slice(-(TAIL_CHARS - TIMEOUT_MARKER.length)) + TIMEOUT_MARKER
        : out.slice(-TAIL_CHARS)
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ command, exitCode: code, durationMs: Date.now() - started, outputTail: tail() })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
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
  timeoutMs?: number
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = []
  for (const command of commands) {
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
    results.push(await runShell(cwd, command, timeoutMs))
  }
  return results
}
