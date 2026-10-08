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
  useStore.setState({
    activeBranch: { t1: 'b2' },
    branchDrafts: {},
    timelines: { t1: [] },
    toast: undefined
  })
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
  expect(call).not.toHaveBeenCalledWith('tasks:send', 't1', 'branch:b2', '再想想', [])
  expect(input).toHaveValue('再想想')
})

test('在分岔中送出訊息，Claude 回覆過後可以帶回主線', async () => {
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  expect(screen.getByText('開始討論：通知使用者')).toBeInTheDocument()
  expect(screen.getByText('會有騷擾的風險。')).toBeInTheDocument()
  expect(screen.queryByText('主線的訊息')).not.toBeInTheDocument()
  await userEvent.type(screen.getByRole('textbox', { name: '分岔訊息' }), '再想想{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'branch:b2', '再想想', [])
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

test('分岔執行中可以停止（只停這個分岔）；連點只送一次', async () => {
  const { rerender } = render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  rerender(<BranchPanel task={{ ...task, branches: [{ ...open, running: true }] }} events={talk} />)
  const release = holdNextCall(vi.mocked(call))
  const stop = screen.getByRole('button', { name: '停止' })
  await userEvent.dblClick(stop)
  expect(vi.mocked(call).mock.calls).toEqual([['run:stop', 't1', 'branch:b2']])
  expect(stop).toBeDisabled()
  await release()
  expect(stop).toBeEnabled()
  rerender(
    <BranchPanel
      task={{ ...task, branches: [{ ...open, running: true }] }}
      events={talk}
      readOnly
    />
  )
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
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

test('分岔裡被 Harness 規則擋下或使用者拒絕的工具以中性的顏色顯示', () => {
  render(
    <BranchPanel
      task={{ ...task, branches: [open] }}
      events={[
        ...talk,
        ev('e4', {
          kind: 'tool_result',
          text: '分岔裡不能執行指令',
          tool: { id: 'x', name: '', isError: true, blocked: true }
        }),
        ev('e5', {
          kind: 'tool_result',
          text: '先不要',
          tool: { id: 'y', name: '', isError: true, denied: true }
        })
      ]}
    />
  )
  expect(screen.getByText('已阻擋：分岔裡不能執行指令')).toHaveClass('text-muted')
  expect(screen.getByText('已拒絕：先不要')).toHaveClass('text-muted')
})

test('從訊息開的分岔：第一則訊息分成引用（去掉 Markdown）與使用者的問題', () => {
  const seed = ev('e1', { text: '針對以下內容：\n建議改成 **429**\n\n我的問題：為什麼不是 423？' })
  render(<BranchPanel task={{ ...task, branches: [open] }} events={[seed]} />)
  const quote = screen.getByText('建議改成 429')
  expect(quote.closest('blockquote')).not.toBeNull()
  expect(screen.getByText('為什麼不是 423？')).toBeInTheDocument()
  expect(screen.queryByText(/針對以下內容/)).not.toBeInTheDocument()
})

test('正在開新分岔時顯示問題輸入框；點分岔標籤就切過去（store 會放棄草稿）', async () => {
  useStore.getState().startBranchDraft('t1', '會有騷擾的風險。')
  const draft = {
    ...useStore.getState().branchDrafts.t1!,
    pending: false,
    onSubmit: vi.fn(),
    onCancel: vi.fn()
  }
  render(<BranchPanel task={task} events={talk} draft={draft} />)
  expect(screen.getByRole('form', { name: '新分岔' })).toBeInTheDocument()
  // 分岔的內容先收起來，不會同時出現兩個輸入框
  expect(screen.queryByRole('textbox', { name: '分岔訊息' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /計數存放位置 · 已帶回/ }))
  expect(useStore.getState().activeBranch.t1).toBe('b1')
  expect(useStore.getState().branchDrafts.t1).toBeUndefined()
})

test('新分岔建立中停用分岔標籤', async () => {
  render(
    <BranchPanel
      task={task}
      events={talk}
      draft={{ excerpt: 'x', seq: 1, pending: true, onSubmit: vi.fn(), onCancel: vi.fn() }}
    />
  )
  const chip = screen.getByRole('button', { name: /計數存放位置 · 已帶回/ })
  expect(chip).toBeDisabled()
  await userEvent.click(chip)
  expect(useStore.getState().activeBranch.t1).toBe('b2')
})

test('唯讀時不顯示新分岔的輸入框', () => {
  render(
    <BranchPanel
      task={task}
      events={talk}
      readOnly
      draft={{ excerpt: 'x', seq: 1, pending: false, onSubmit: vi.fn(), onCancel: vi.fn() }}
    />
  )
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
})

test('取消新分岔、回到原本的分岔時捲到最底（重新畫出的訊息列表）', () => {
  // jsdom 沒有版面：讓每個元素都有內容高度
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 500
  })
  try {
    const draft = { excerpt: 'x', seq: 1, pending: false, onSubmit: vi.fn(), onCancel: vi.fn() }
    const view = (d?: typeof draft) => (
      <BranchPanel task={{ ...task, branches: [open] }} events={talk} draft={d} />
    )
    const { rerender } = render(view())
    rerender(view(draft))
    rerender(view())
    const list = screen.getByText('會有騷擾的風險。').closest('.overflow-y-auto')!
    expect(list.scrollTop).toBe(500)
  } finally {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', desc)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
  }
})
