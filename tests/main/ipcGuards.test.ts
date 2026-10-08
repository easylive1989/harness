// tests/main/ipcGuards.test.ts
import { describe, expect, test, vi } from 'vitest'
import type { ClaudeStatus } from '@shared/types'
import {
  assertChannel,
  assertId,
  assertModel,
  assertString,
  assertVersion,
  ensureClaudeReady,
  isPathInside,
  isSafeId,
  isValidBranchName,
  validateSettingsPatch
} from '../../src/main/ipcGuards'

describe('id 檢查', () => {
  test.each(['ab12cd34', 'r1', 'A_b-9', 'x'.repeat(64)])('接受 %s', (id) => {
    expect(isSafeId(id)).toBe(true)
    expect(assertId(id, '任務')).toBe(id)
  })

  test.each(['', '../x', 'a/b', 'a.b', 'a b', 'x'.repeat(65), 1, null, undefined, {}])(
    '拒絕 %s',
    (id) => {
      expect(isSafeId(id)).toBe(false)
      expect(() => assertId(id, '任務')).toThrow('無效的任務 id')
    }
  )
})

test('報告版本必須是正整數', () => {
  expect(assertVersion(3)).toBe(3)
  for (const v of [0, -1, 1.5, '1', NaN, undefined])
    expect(() => assertVersion(v)).toThrow('無效的報告版本')
})

test('channel 只接受 main 或 branch:<id>', () => {
  expect(assertChannel('main')).toBe('main')
  expect(assertChannel('branch:b1')).toBe('branch:b1')
  for (const c of ['branch:', 'branch:../x', 'other', 1])
    expect(() => assertChannel(c)).toThrow('無效的對話頻道')
})

describe('validateSettingsPatch', () => {
  test('只保留已知欄位，並整理值', () => {
    expect(
      validateSettingsPatch({
        branchPrefix: 'x/',
        evil: 1,
        claudePath: '/bin/claude',
        alwaysAllowedCommands: [' npm test ', 'ls'],
        loadProjectSettings: false,
        defaultModel: 'claude-sonnet-5-5',
        worktreeRoot: '/tmp/wt'
      })
    ).toEqual({
      branchPrefix: 'x/',
      claudePath: '/bin/claude',
      alwaysAllowedCommands: ['npm test', 'ls'],
      loadProjectSettings: false,
      defaultModel: 'claude-sonnet-5-5',
      worktreeRoot: '/tmp/wt'
    })
  })

  test('worktree 位置去掉前後空白並正規化；分支前綴去掉前後空白；允許清單去掉重複', () => {
    expect(validateSettingsPatch({ worktreeRoot: '  /tmp/a/../wt/ ' })).toEqual({
      worktreeRoot: '/tmp/wt'
    })
    expect(validateSettingsPatch({ branchPrefix: ' feat/ ' })).toEqual({ branchPrefix: 'feat/' })
    expect(
      validateSettingsPatch({ alwaysAllowedCommands: ['ls', ' ls ', 'npm test', 'ls'] })
    ).toEqual({ alwaysAllowedCommands: ['ls', 'npm test'] })
  })

  test.each(['harness/', 'feat-', 'me/wip/', 'a.b/', 'x', 'x.', 'user@host/'])(
    '接受分支前綴 %s',
    (prefix) =>
      expect(validateSettingsPatch({ branchPrefix: prefix })).toEqual({ branchPrefix: prefix })
  )

  test.each([
    'has space/',
    'tab\t/',
    'ctrl\u0001',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a..b',
    'a@{b',
    'a//',
    '-x',
    '/x',
    '.hidden/',
    'x/.y',
    'x.lock/'
  ])('拒絕不符合 git 分支名稱規則的前綴 %j', (prefix) => {
    expect(() => validateSettingsPatch({ branchPrefix: prefix })).toThrow(
      '分支前綴不符合 git 分支名稱規則'
    )
  })

  test('claudePath 空字串或 undefined 代表自動偵測', () => {
    expect(validateSettingsPatch({ claudePath: '  ' })).toEqual({ claudePath: undefined })
    expect(validateSettingsPatch({ claudePath: undefined })).toEqual({ claudePath: undefined })
  })

  test.each([
    [null, '無效的設定'],
    [{ worktreeRoot: '' }, 'worktree 位置'],
    [{ worktreeRoot: 'relative/dir' }, 'worktree 位置'],
    [{ worktreeRoot: 3 }, 'worktree 位置'],
    [{ branchPrefix: ' ' }, '分支前綴'],
    [{ claudePath: 1 }, 'claude 路徑'],
    [{ alwaysAllowedCommands: 'ls' }, '允許清單'],
    [{ alwaysAllowedCommands: ['ls', ' '] }, '允許清單'],
    [{ alwaysAllowedCommands: ['ls', 1] }, '允許清單'],
    [{ loadProjectSettings: 'yes' }, '載入專案設定'],
    [{ defaultModel: 'gpt-4' }, '模型']
  ])('拒絕 %j', (patch, msg) => {
    expect(() => validateSettingsPatch(patch)).toThrow(msg)
  })
})

describe('isValidBranchName', () => {
  test.each(['main', 'harness/20261008-ab12cd34', 'feat/a.b', 'v1.2', 'a-b_c'])('接受 %s', (n) =>
    expect(isValidBranchName(n)).toBe(true)
  )
  test.each([
    '',
    'a.',
    'a/',
    'a.lock',
    'a/b.lock',
    '.a',
    'a/.b',
    'a b',
    'a..b',
    'a@{1}',
    '-a',
    '@',
    'HEAD'
  ])('拒絕 %j', (n) => expect(isValidBranchName(n)).toBe(false))
})

describe('assertString', () => {
  test('回傳原字串', () => {
    expect(assertString('hi', '訊息')).toBe('hi')
    expect(assertString('', '訊息', { allowEmpty: true })).toBe('')
  })

  test.each([
    [undefined, {}],
    [3, {}],
    ['', {}],
    ['   ', {}],
    ['abcd', { max: 3 }]
  ])('拒絕 %j', (v, opts) => {
    expect(() => assertString(v, '訊息', opts)).toThrow('無效的訊息')
  })

  test('預設上限 100000 字元', () => {
    expect(assertString('a'.repeat(100_000), '訊息')).toHaveLength(100_000)
    expect(() => assertString('a'.repeat(100_001), '訊息')).toThrow('無效的訊息')
  })
})

test('model 必須是支援的模型', () => {
  expect(assertModel('claude-opus-5-5')).toBe('claude-opus-5-5')
  for (const m of ['gpt-4', '', 1, undefined]) expect(() => assertModel(m)).toThrow('無效的模型')
})

describe('isPathInside', () => {
  const roots = ['/repos/shop-api', '/home/me/.harness/worktrees/shop-api/20261007-ab12']

  test.each([
    '/repos/shop-api',
    '/repos/shop-api/src/a.ts',
    '/home/me/.harness/worktrees/shop-api/20261007-ab12/x'
  ])('允許 %s', (p) => {
    expect(isPathInside(p, roots)).toBe(true)
  })

  test.each([
    '/repos/shop-api-evil/a.ts',
    '/repos/shop-api/../other',
    '/etc/passwd',
    'relative/path',
    '',
    3
  ])('拒絕 %s', (p) => {
    expect(isPathInside(p, roots)).toBe(false)
  })
})

describe('ensureClaudeReady', () => {
  const ok: ClaudeStatus = { found: true, loggedIn: true, path: '/bin/claude' }
  const out: ClaudeStatus = {
    found: true,
    loggedIn: false,
    error: '尚未登入，請在終端機執行 claude 並完成登入。'
  }

  test('已登入直接通過，不重新偵測', async () => {
    const get = vi.fn(async () => ok)
    await expect(ensureClaudeReady(get)).resolves.toBe(ok)
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('快取未登入時重新偵測一次，登入了就通過', async () => {
    const get = vi.fn(async (refresh?: boolean) => (refresh ? ok : out))
    await expect(ensureClaudeReady(get)).resolves.toBe(ok)
    expect(get).toHaveBeenLastCalledWith(true)
  })

  test('仍未登入就以偵測的錯誤訊息拒絕', async () => {
    const get = vi.fn(async () => out)
    await expect(ensureClaudeReady(get)).rejects.toThrow(out.error)
  })
})
