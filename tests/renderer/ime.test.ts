// tests/renderer/ime.test.ts
import { describe, expect, test, vi } from 'vitest'
import { blockImeSubmit, isComposing, isImeEnter } from '@renderer/lib/ime'

/** React 鍵盤事件裡用到的欄位 */
const keyEvent = (key: string, native: { isComposing?: boolean; keyCode?: number } = {}) => ({
  key,
  nativeEvent: { isComposing: native.isComposing ?? false, keyCode: native.keyCode ?? 0 },
  preventDefault: vi.fn()
})

describe('ime', () => {
  test('輸入法組字中的按鍵：isComposing，或 compositionend 先到時只剩 keyCode 229', () => {
    expect(isComposing(keyEvent('Enter', { isComposing: true }))).toBe(true)
    expect(isComposing(keyEvent('Enter', { keyCode: 229 }))).toBe(true)
    expect(isComposing(keyEvent('Enter', { keyCode: 13 }))).toBe(false)
  })

  test('isImeEnter 只認組字中的 Enter', () => {
    expect(isImeEnter(keyEvent('Enter', { isComposing: true }))).toBe(true)
    expect(isImeEnter(keyEvent('Escape', { isComposing: true }))).toBe(false)
    expect(isImeEnter(keyEvent('Enter'))).toBe(false)
  })

  test('blockImeSubmit 只取消組字中 Enter 的預設動作（表單不會隱式送出）', () => {
    const composing = keyEvent('Enter', { keyCode: 229 })
    blockImeSubmit(composing)
    expect(composing.preventDefault).toHaveBeenCalled()
    const normal = keyEvent('Enter', { keyCode: 13 })
    blockImeSubmit(normal)
    expect(normal.preventDefault).not.toHaveBeenCalled()
  })
})
