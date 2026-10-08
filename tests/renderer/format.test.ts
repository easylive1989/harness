// tests/renderer/format.test.ts
import { expect, test } from 'vitest'
import { shortTime } from '@renderer/lib/format'

test('以本地時間顯示月/日 時:分，補零', () => {
  expect(shortTime(new Date(2026, 9, 7, 14, 5).toISOString())).toBe('10/07 14:05')
  expect(shortTime(new Date(2026, 0, 3, 9, 0).toISOString())).toBe('01/03 09:00')
})

test('無法解析的時間回傳空字串', () => {
  expect(shortTime('')).toBe('')
  expect(shortTime('not a date')).toBe('')
})
