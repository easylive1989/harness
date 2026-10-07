import { afterEach, describe, expect, test } from 'vitest'
import { applyLoginShellPath, detectClaude, type Exec } from '../../src/main/claude/detect'

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
