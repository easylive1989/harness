import { afterEach, describe, expect, test } from 'vitest'
import {
  applyLoginShellPath,
  detectClaude,
  execCapture,
  type Exec
} from '../../src/main/claude/detect'

function fakeExec(map: Record<string, string | Error>): Exec {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    const hit = Object.entries(map).find(([k]) => key.endsWith(k))
    if (!hit) throw new Error(`unexpected ${key}`)
    if (hit[1] instanceof Error) throw hit[1]
    return hit[1]
  }
}

describe('detectClaude', () => {
  test('找到且已登入', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': '/u/.local/bin/claude\n',
        'claude --version': '2.1.292 (Claude Code)\n',
        'claude auth status': JSON.stringify({
          loggedIn: true,
          subscriptionType: 'max',
          email: 'a@b'
        })
      })
    )
    expect(s).toEqual({
      found: true,
      path: '/u/.local/bin/claude',
      version: '2.1.292 (Claude Code)',
      loggedIn: true,
      subscriptionType: 'max',
      email: 'a@b',
      error: undefined
    })
  })

  test('使用設定指定的路徑', async () => {
    const s = await detectClaude(
      fakeExec({
        '/opt/claude --version': '1',
        '/opt/claude auth status': '{"loggedIn":true}'
      }),
      '/opt/claude'
    )
    expect(s.path).toBe('/opt/claude')
  })

  test('找不到 claude', async () => {
    const s = await detectClaude(fakeExec({ 'command -v claude': new Error('no') }))
    expect(s.found).toBe(false)
    expect(s.error).toContain('找不到')
  })

  test('未登入', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': '/c',
        '/c --version': '1',
        '/c auth status': '{"loggedIn":false}'
      })
    )
    expect(s.loggedIn).toBe(false)
    expect(s.error).toContain('登入')
  })
})

describe('detectClaude 容錯', () => {
  test('command -v 的輸出取最後一個非空行', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': 'Welcome!\n/u/bin/claude\n\n',
        '/u/bin/claude --version': '1',
        '/u/bin/claude auth status': '{"loggedIn":true}'
      })
    )
    expect(s.path).toBe('/u/bin/claude')
    expect(s.loggedIn).toBe(true)
  })

  test('auth status 不是 JSON 時給出友善訊息', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': '/c',
        '/c --version': '0.9 (Claude Code)',
        '/c auth status': 'error: unknown command auth'
      })
    )
    expect(s).toMatchObject({
      found: true,
      path: '/c',
      version: '0.9 (Claude Code)',
      loggedIn: false
    })
    expect(s.error).toContain('無法讀取登入狀態，請更新 Claude Code')
  })
})

describe('execCapture', () => {
  test('回傳 stdout；非 0 結束但有 stdout 時仍回傳', async () => {
    expect(await execCapture('sh', ['-c', 'echo hi'])).toBe('hi\n')
    expect(await execCapture('sh', ['-c', 'echo partial; exit 1'])).toBe('partial\n')
  })

  test('非 0 結束且沒有 stdout 時以 stderr 拒絕', async () => {
    await expect(execCapture('sh', ['-c', 'echo bad >&2; exit 1'])).rejects.toThrow('bad')
  })

  test('stdin 是空的，不會卡住', async () => {
    expect(await execCapture('cat', [], { timeoutMs: 3000 })).toBe('')
  })

  test('逾時會終止並拒絕，不等佔住輸出的孫程序', async () => {
    const started = Date.now()
    await expect(
      execCapture('sh', ['-c', 'sleep 5 & sleep 5'], { timeoutMs: 200 })
    ).rejects.toThrow('逾時')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('applyLoginShellPath', () => {
  const original = process.env.PATH
  afterEach(() => {
    process.env.PATH = original
  })

  test('只取標記之間的 PATH，忽略 shell 啟動訊息', async () => {
    await applyLoginShellPath(
      async () =>
        'Welcome to zsh!\nnvm: using v24\n__HARNESS_PATH__/a/bin:/b/bin__HARNESS_PATH__\nbye\n'
    )
    expect(process.env.PATH).toBe('/a/bin:/b/bin')
  })

  test('以 10 秒逾時執行 login shell', async () => {
    let seen: number | undefined
    await applyLoginShellPath(async (_cmd, _args, opts) => {
      seen = opts?.timeoutMs
      return '__HARNESS_PATH__/x__HARNESS_PATH__'
    })
    expect(seen).toBe(10_000)
  })

  test('沒有標記時保留原本的 PATH', async () => {
    process.env.PATH = '/keep'
    await applyLoginShellPath(async () => '/a/bin:/b/bin')
    expect(process.env.PATH).toBe('/keep')
  })

  test('執行失敗時保留原本的 PATH', async () => {
    process.env.PATH = '/keep'
    await applyLoginShellPath(async () => {
      throw new Error('boom')
    })
    expect(process.env.PATH).toBe('/keep')
  })
})
