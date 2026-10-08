// tests/renderer/BranchPanel.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { BranchPanel } from '@renderer/components/BranchPanel'
import { resetStoreInternals, useStore } from '@renderer/store'
import { msg } from '@shared/protocol'
import type { Branch, TimelineEvent } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const concluded: Branch = {
  id: 'b1',
  title: '計數存放位置',
  status: 'concluded',
  running: false,
  createdAt: '',
  conclusion: { decision: '用 Redis', rationale: 'x', deferred: [] }
}
const concluding: Branch = {
  id: 'b2',
  title: '通知使用者',
  fromQuestionId: 'q2',
  status: 'concluding',
  running: false,
  createdAt: '',
  conclusion: { decision: '寄通知信', rationale: '避免騷擾', deferred: ['重設連結'] }
}
const open: Branch = { ...concluding, status: 'open', conclusion: undefined }
const task = makeTask({ branches: [concluded, concluding] })

const ev = (id: string, over: Partial<TimelineEvent>): TimelineEvent => ({
  id,
  ts: '',
  channel: 'branch:b2',
  kind: 'user_text',
  ...over
})
const talk = [
  ev('e1', { text: msg.branchOpen('通知使用者', '') }),
  ev('e2', { kind: 'assistant_text', text: '會有騷擾的風險。' }),
  ev('e3', { channel: 'main', kind: 'assistant_text', text: '主線的訊息' })
]

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({ activeBranch: { t1: 'b2' }, timelines: { t1: [] }, toast: undefined })
})

test('沒有分岔時顯示說明', () => {
  useStore.setState({ activeBranch: {} })
  render(<BranchPanel task={makeTask()} events={[]} />)
  expect(screen.getByRole('complementary', { name: '分岔討論' })).toHaveTextContent('還沒有分岔')
})

test('顯示結論預覽，確認後帶回主線', async () => {
  render(<BranchPanel task={task} events={[]} />)
  expect(screen.getByText('帶回主線的結論（預覽）')).toBeInTheDocument()
  expect(screen.getByText('寄通知信')).toBeInTheDocument()
  expect(screen.getByText(/重設連結/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '確認並帶回主線' }))
  expect(call).toHaveBeenCalledWith('branch:confirm', 't1', 'b2', undefined)
  await userEvent.click(screen.getByRole('button', { name: '重新整理結論' }))
  expect(call).toHaveBeenCalledWith('branch:conclude', 't1', 'b2')
})

test('分岔訊息：輸入法選字中的 Enter 不送出', async () => {
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  const input = screen.getByRole('textbox', { name: '分岔訊息' })
  await userEvent.type(input, '再想想')
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
  expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
  expect(call).not.toHaveBeenCalledWith('tasks:send', 't1', 'branch:b2', '再想想')
  expect(input).toHaveValue('再想想')
})

test('在分岔中送出訊息，Claude 回覆過後可以帶回主線', async () => {
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  expect(screen.getByText('開始討論：通知使用者')).toBeInTheDocument()
  expect(screen.getByText('會有騷擾的風險。')).toBeInTheDocument()
  expect(screen.queryByText('主線的訊息')).not.toBeInTheDocument()
  await userEvent.type(screen.getByRole('textbox', { name: '分岔訊息' }), '再想想{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'branch:b2', '再想想')
  expect(screen.getByRole('textbox', { name: '分岔訊息' })).toHaveValue('')
  await userEvent.click(screen.getByRole('button', { name: '帶回主線' }))
  expect(call).toHaveBeenCalledWith('branch:conclude', 't1', 'b2')
})

test('Claude 還沒在分岔回覆前不能帶回主線；執行中停用輸入', () => {
  const { rerender } = render(
    <BranchPanel task={{ ...task, branches: [open] }} events={talk.slice(0, 1)} />
  )
  expect(screen.getByRole('button', { name: '帶回主線' })).toBeDisabled()
  rerender(<BranchPanel task={{ ...task, branches: [{ ...open, running: true }] }} events={talk} />)
  expect(screen.getByRole('textbox', { name: '分岔訊息' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '帶回主線' })).toBeDisabled()
  expect(screen.getByText('Claude 正在回覆…')).toBeInTheDocument()
})

test('切換分岔；已帶回的分岔只能看', async () => {
  render(<BranchPanel task={task} events={[]} />)
  const chip = screen.getByRole('button', { name: /計數存放位置 · 已帶回/ })
  expect(chip).toHaveAttribute('aria-pressed', 'false')
  await userEvent.click(chip)
  expect(useStore.getState().activeBranch.t1).toBe('b1')
  expect(chip).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText('已帶回主線的結論')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '分岔訊息' })).not.toBeInTheDocument()
})

test('記住的分岔不存在時，改顯示還沒帶回的分岔', () => {
  useStore.setState({ activeBranch: { t1: 'gone' } })
  render(<BranchPanel task={task} events={[]} />)
  expect(screen.getByRole('button', { name: /通知使用者/ })).toHaveAttribute('aria-pressed', 'true')
})

test('唯讀時不能送出或帶回', () => {
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} readOnly />)
  expect(screen.queryByRole('textbox', { name: '分岔訊息' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '帶回主線' })).not.toBeInTheDocument()
})

test('帶回主線進行中停用，連點只送一次', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  const button = screen.getByRole('button', { name: '帶回主線' })
  await userEvent.dblClick(button)
  expect(call).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  await release()
  expect(button).toBeEnabled()
})

test('確認並帶回主線、重新整理結論進行中都停用，連點只送一次', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<BranchPanel task={task} events={[]} />)
  const confirm = screen.getByRole('button', { name: '確認並帶回主線' })
  const again = screen.getByRole('button', { name: '重新整理結論' })
  await userEvent.dblClick(confirm)
  expect(call).toHaveBeenCalledTimes(1)
  expect(confirm).toBeDisabled()
  expect(again).toBeDisabled()
  await release()
  expect(confirm).toBeEnabled()
  const release2 = holdNextCall(vi.mocked(call))
  await userEvent.dblClick(again)
  expect(call).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenLastCalledWith('branch:conclude', 't1', 'b2')
  await release2()
})

test('分岔的執行錯誤顯示在分岔面板', () => {
  render(
    <BranchPanel task={{ ...task, branches: [{ ...open, error: '分岔執行失敗' }] }} events={talk} />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('分岔執行失敗')
})

test('分岔裡的工具錯誤以錯誤樣式顯示；處理中在常駐的 live region', () => {
  const { rerender } = render(
    <BranchPanel
      task={{ ...task, branches: [open] }}
      events={[...talk, ev('e4', { kind: 'tool_result', text: 'EACCES' })]}
    />
  )
  expect(screen.getByText('工具錯誤：EACCES')).toHaveClass('text-danger')
  const status = screen.getByRole('status')
  expect(status).toHaveTextContent('')
  rerender(<BranchPanel task={{ ...task, branches: [{ ...open, running: true }] }} events={talk} />)
  expect(screen.getByRole('status')).toBe(status)
  expect(status).toHaveTextContent('Claude 正在回覆…')
})

test('從訊息開的分岔：第一則訊息分成引用（去掉 Markdown）與使用者的問題', () => {
  const seed = ev('e1', { text: '針對以下內容：\n建議改成 **429**\n\n我的問題：為什麼不是 423？' })
  render(<BranchPanel task={{ ...task, branches: [open] }} events={[seed]} />)
  const quote = screen.getByText('建議改成 429')
  expect(quote.closest('blockquote')).not.toBeNull()
  expect(screen.getByText('為什麼不是 423？')).toBeInTheDocument()
  expect(screen.queryByText(/針對以下內容/)).not.toBeInTheDocument()
})

test('正在開新分岔時顯示問題輸入框；點其他分岔就取消', async () => {
  const onCancel = vi.fn()
  render(
    <BranchPanel
      task={task}
      events={talk}
      draft={{ excerpt: '會有騷擾的風險。', pending: false, onSubmit: vi.fn(), onCancel }}
    />
  )
  expect(screen.getByRole('form', { name: '新分岔' })).toBeInTheDocument()
  // 分岔的內容先收起來，不會同時出現兩個輸入框
  expect(screen.queryByRole('textbox', { name: '分岔訊息' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /計數存放位置 · 已帶回/ }))
  expect(onCancel).toHaveBeenCalled()
  expect(useStore.getState().activeBranch.t1).toBe('b1')
})

test('唯讀時不顯示新分岔的輸入框', () => {
  render(
    <BranchPanel
      task={task}
      events={talk}
      readOnly
      draft={{ excerpt: 'x', pending: false, onSubmit: vi.fn(), onCancel: vi.fn() }}
    />
  )
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
})
