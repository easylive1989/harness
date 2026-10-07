// tests/renderer/api.test.ts
import { describe, expect, test } from 'vitest'
import { errorText } from '@renderer/api'

describe('errorText', () => {
  test('去掉 Electron 加上的 remote method 前綴', () => {
    expect(
      errorText(new Error("Error invoking remote method 'tasks:create': Error: 無效的需求"))
    ).toBe('無效的需求')
    expect(errorText(new Error('一般錯誤'))).toBe('一般錯誤')
    expect(errorText('字串')).toBe('字串')
  })
})
