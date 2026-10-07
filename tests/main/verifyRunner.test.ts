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

  test('逾時標記一定出現在輸出結尾，即使終止後還有大量輸出', async () => {
    // 收到 TERM 後再印 10000 字元，舊做法會把標記擠出 tail
    const r = await runShell(
      tmpdir(),
      `trap 'printf "%010000d" 0; exit 0' TERM; sleep 5 & wait`,
      300
    )
    expect(r.outputTail.endsWith('[Harness] 執行逾時，已終止')).toBe(true)
    expect(r.outputTail.length).toBeLessThanOrEqual(4000)
  })

  test('stdin 是空的，讀 stdin 的指令不會卡住', async () => {
    const started = Date.now()
    const r = await runShell(tmpdir(), 'cat', 3000)
    expect(r.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('多位元組字元跨 chunk 也不會亂碼', async () => {
    // 「中」= e4 b8 ad，拆成兩次寫入、中間停一下，確保落在不同 chunk
    const r = await runShell(tmpdir(), `printf '\\xe4'; sleep 0.2; printf '\\xb8\\xad'`)
    expect(r.outputTail).toBe('中')
  })

  test('中止會終止整個 process group，並標示已取消', async () => {
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 100)
    const r = await runShell(tmpdir(), 'sleep 5; echo done', 60_000, ac.signal)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(r.outputTail.endsWith('[Harness] 已取消')).toBe(true)
    expect(r.outputTail).not.toContain('done')
  })

  test('中止時忽略 SIGTERM 的指令很快以 SIGKILL 終止', async () => {
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 100)
    const r = await runShell(tmpdir(), "trap '' TERM; sleep 5; echo done", 60_000, ac.signal)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(r.outputTail).toContain('[Harness] 已取消')
  })

  test('已中止的 signal 不會啟動指令', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runShell(tmpdir(), 'echo should-not-run', 60_000, ac.signal)
    expect(r).toMatchObject({ exitCode: null, durationMs: 0 })
    expect(r.outputTail).toContain('[Harness] 已取消')
    expect(r.outputTail).not.toContain('should-not-run')
  })

  test('runVerification 中止後其餘指令不執行', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = await runVerification(tmpdir(), ['sleep 5', 'echo b'], () => true, ac.signal)
    expect(r[0].outputTail).toContain('[Harness] 已取消')
    expect(r[1]).toMatchObject({ command: 'echo b', exitCode: null, skipped: '已取消，未執行' })
  })

  test('未核准的指令不執行', async () => {
    const r = await runVerification(tmpdir(), ['echo a', 'echo b'], (c) => c === 'echo a')
    expect(r[0].exitCode).toBe(0)
    expect(r[1]).toMatchObject({ command: 'echo b', exitCode: null })
    expect(r[1].skipped).toBeTruthy()
  })
})
