// tests/renderer/imeInputs.test.tsx
// 使用者用注音等輸入法打中文：選字時按 Enter 是確認候選字，不能送出、儲存或關閉輸入框
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { Composer } from '@renderer/components/Composer'
import { CommentForm } from '@renderer/report/comments'

/** fireEvent 回傳 false 代表預設動作被取消（瀏覽器不會隱式送出表單） */
const composingEnter = (el: Element) => fireEvent.keyDown(el, { key: 'Enter', isComposing: true })
const enter229 = (el: Element) => fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 })

describe('輸入法選字中的 Enter', () => {
  test('Composer：選字中的 Enter 不送出，選完再按 Enter 才送出', async () => {
    const onSend = vi.fn()
    render(<Composer placeholder="輸入訊息" onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '訊息' })
    await userEvent.type(input, '你好')
    expect(composingEnter(input)).toBe(false)
    expect(enter229(input)).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('你好')
    // 一般的 Enter 不取消預設動作，表單照常送出
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })).toBe(true)
    await userEvent.type(input, '{Enter}')
    expect(onSend).toHaveBeenCalledWith('你好')
  })

  test('留言輸入框：選字中的 Enter 不加入、Esc 不取消', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<CommentForm placeholder="寫下回饋" onSubmit={onSubmit} onCancel={onCancel} />)
    const input = screen.getByRole('textbox', { name: '回饋' })
    await userEvent.type(input, '這裡要改')
    expect(composingEnter(input)).toBe(false)
    expect(enter229(input)).toBe(false)
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    await userEvent.type(input, '{Enter}')
    expect(onSubmit).toHaveBeenCalledWith('這裡要改')
  })
})
