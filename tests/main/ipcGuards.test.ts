// tests/main/ipcGuards.test.ts
import { describe, expect, test, vi } from 'vitest'
import type { ClaudeStatus } from '@shared/types'
import {
  assertChannel,
  assertId,
  assertVersion,
  ensureClaudeReady,
  isSafeId,
  pickSettingsPatch
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

test('設定只保留已知欄位', () => {
  expect(pickSettingsPatch({ branchPrefix: 'x/', evil: 1, claudePath: '/bin/claude' })).toEqual({
    branchPrefix: 'x/',
    claudePath: '/bin/claude'
  })
  expect(() => pickSettingsPatch(null)).toThrow('無效的設定')
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
