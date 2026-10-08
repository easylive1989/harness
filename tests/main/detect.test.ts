import { afterEach, describe, expect, test } from 'vitest'
import type { ClaudeStatus } from '@shared/types'
import {
  applyLoginShellPath,
  claudeEnv,
  createClaudeStatusCache,
  detectClaude,
  execCapture,
  type Exec,
  type ExecOptions
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
      }),
      undefined,
      { PATH: '/usr/bin' }
    )
    expect(s).toEqual({
      found: true,
      path: '/u/.local/bin/claude',
      version: '2.1.292 (Claude Code)',
      loggedIn: true,
      subscriptionType: 'max',
      email: 'a@b',
      error: undefined,
      ignoredEnv: []
    })
  })

  test('API key、其他驗證方式與端點的環境變數不傳給 claude，並回報忽略了哪些', async () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth'
    }
    const seen: (ExecOptions | undefined)[] = []
    const exec: Exec = async (cmd, args, opts) => {
      if (cmd === '/c') seen.push(opts)
      return args.includes('auth') ? '{"loggedIn":true}' : '1'
    }
    const s = await detectClaude(exec, '/c', env)
    expect(s.ignoredEnv).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY'
    ])
    expect(seen).toHaveLength(2)
    for (const opts of seen)
      expect(opts?.env).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })
    // 空字串不算設定
    expect((await detectClaude(exec, '/c', { ANTHROPIC_API_KEY: '' })).ignoredEnv).toEqual([])
  })

  test('claudeEnv 是複本：不改動原本的環境變數', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'k' }
    expect(claudeEnv(env)).toEqual({ PATH: '/bin' })
    expect(env.ANTHROPIC_API_KEY).toBe('k')
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

describe('createClaudeStatusCache', () => {
  const status = (path: string): ClaudeStatus => ({ found: true, loggedIn: true, path })
  const deferred = () => {
    let resolve!: (s: ClaudeStatus) => void
    const promise = new Promise<ClaudeStatus>((r) => (resolve = r))
    return { promise, resolve }
  }

  test('不重新偵測時回傳快取；重新偵測後更新快取', async () => {
    const cache = createClaudeStatusCache(async () => status('/new'), status('/old'))
    expect(await cache.status()).toEqual(status('/old'))
    expect(await cache.status(true)).toEqual(status('/new'))
    expect(cache.current().path).toBe('/new')
  })

  test('較早開始、較晚結束的偵測不會蓋掉較新的結果', async () => {
    const first = deferred()
    const second = deferred()
    const pending = [first, second]
    const cache = createClaudeStatusCache(() => pending.shift()!.promise, status('/initial'))
    const older = cache.status(true)
    const newer = cache.status(true)
    second.resolve(status('/second'))
    expect(await newer).toEqual(status('/second'))
    first.resolve(status('/first'))
    // 較舊的呼叫拿到的是目前的快取（較新的結果）
    expect(await older).toEqual(status('/second'))
    expect(cache.current().path).toBe('/second')
  })

  test('較早開始的呼叫會等到最新的偵測結束，不回傳過時的狀態', async () => {
    const [first, second, third] = [deferred(), deferred(), deferred()]
    const pending = [first, second, third]
    const cache = createClaudeStatusCache(() => pending.shift()!.promise, status('/initial'))
    const results: string[] = []
    const track = (p: Promise<ClaudeStatus>, name: string) =>
      p.then((s) => void results.push(`${name}:${s.path}`))
    const flush = () => new Promise((r) => setTimeout(r, 0))
    const a = track(cache.status(true), 'a')
    const b = track(cache.status(true), 'b')
    first.resolve(status('/first'))
    await flush()
    // a 的偵測結束了，但 b 的還沒：a 繼續等
    expect(results).toEqual([])
    // 等待期間又開始一次偵測：a、b 都要等到這一次
    const c = track(cache.status(true), 'c')
    second.resolve(status('/second'))
    await flush()
    expect(results).toEqual([])
    third.resolve(status('/third'))
    await Promise.all([a, b, c])
    expect(results.sort()).toEqual(['a:/third', 'b:/third', 'c:/third'])
    expect(cache.current().path).toBe('/third')
  })

  test('最新的偵測失敗時，它的呼叫收到錯誤，較早的呼叫回傳原本的快取', async () => {
    const first = deferred()
    let rejectSecond!: (e: Error) => void
    const second = new Promise<ClaudeStatus>((_, reject) => (rejectSecond = reject))
    const pending = [first.promise, second]
    const cache = createClaudeStatusCache(() => pending.shift()!, status('/initial'))
    const older = cache.status(true)
    const newer = cache.status(true)
    first.resolve(status('/first'))
    rejectSecond(new Error('boom'))
    await expect(newer).rejects.toThrow('boom')
    expect(await older).toEqual(status('/initial'))
  })

  test('偵測失敗時保留原本的快取', async () => {
    const cache = createClaudeStatusCache(async () => {
      throw new Error('boom')
    }, status('/old'))
    await expect(cache.status(true)).rejects.toThrow('boom')
    expect(cache.current().path).toBe('/old')
  })
})
