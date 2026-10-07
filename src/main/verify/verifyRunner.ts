// src/main/verify/verifyRunner.ts
import { spawn } from 'node:child_process'
import type { VerificationResult } from '@shared/types'

export function runShell(
  cwd: string,
  command: string,
  timeoutMs = 10 * 60_000
): Promise<VerificationResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    // detached：子程序自成 process group，逾時才能連同孫程序一起終止
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      detached: true
    })
    let out = ''
    const onData = (b: Buffer) => {
      out = (out + b.toString()).slice(-8000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      out += '\n[Harness] 執行逾時，已終止'
      // 只殺 shell 的話，孫程序會繼續佔住 stdout，close 要等它自己結束才會觸發
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        command,
        exitCode: code,
        durationMs: Date.now() - started,
        outputTail: out.slice(-4000)
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
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
