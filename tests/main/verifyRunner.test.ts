import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runShell, runVerification } from '../../src/main/verify/verifyRunner'

describe('verifyRunner', () => {
  test('記錄 exit code 與輸出', async () => {
    const ok = await runShell(tmpdir(), 'echo hello')
    expect(ok.exitCode).toBe(0)
    expect(ok.outputTail).toContain('hello')
    const fail = await runShell(tmpdir(), 'echo boom 1>&2; exit 3')
    expect(fail.exitCode).toBe(3)
    expect(fail.outputTail).toContain('boom')
  })

  test('逾時會終止', async () => {
    const r = await runShell(tmpdir(), 'sleep 5', 200)
    expect(r.outputTail).toContain('逾時')
  })

  test('逾時會終止整個 process group，不等子程序結束', async () => {
    const started = Date.now()
    const r = await runShell(tmpdir(), 'sleep 5; echo done', 200)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.outputTail).toContain('逾時')
    expect(r.outputTail).not.toContain('done')
  })

  test('忽略 SIGTERM 的指令在寬限期後以 SIGKILL 終止', async () => {
    const started = Date.now()
    const r = await runShell(tmpdir(), "trap '' TERM; sleep 5; echo done", 200)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(r.outputTail).toContain('逾時')
    expect(r.outputTail).not.toContain('done')
  })

  test('未核准的指令不執行', async () => {
    const r = await runVerification(tmpdir(), ['echo a', 'echo b'], (c) => c === 'echo a')
    expect(r[0].exitCode).toBe(0)
    expect(r[1]).toMatchObject({ command: 'echo b', exitCode: null })
    expect(r[1].skipped).toBeTruthy()
  })
})
