// tests/renderer/ClarifyScreen.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => ({ id: 'b1' })),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { ClarifyScreen } from '@renderer/screens/ClarifyScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { TimelineEvent } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const events: TimelineEvent[] = [
  { id: 'e1', ts: '', channel: 'main', kind: 'user_text', text: '加上登入失敗鎖定' },
  { id: 'e2', ts: '', channel: 'main', kind: 'assistant_text', text: '有幾件事要先確認。' }
]

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({
    activeBranch: {},
    branchDrafts: {},
    timelines: { t1: events },
    toast: undefined
  })
})

test('顯示主線時間軸，從輸入框送出訊息', async () => {
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(screen.getByText('加上登入失敗鎖定')).toBeInTheDocument()
  expect(screen.getByRole('complementary', { name: '分岔討論' })).toBeInTheDocument()
  const send = screen.getByRole('button', { name: '送出' })
  expect(send).toBeDisabled()
  await userEvent.type(screen.getByRole('textbox', { name: '訊息' }), '也要記錄稽核日誌{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'main', '也要記錄稽核日誌', [])
  expect(screen.getByRole('textbox', { name: '訊息' })).toHaveValue('')
})

test('主線執行中（含等待核准）可以停止；連點只送一次；停下來後不顯示', async () => {
  const view = render(
    <ClarifyScreen
      task={makeTask({ runState: 'running' })}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
    />
  )
  const release = holdNextCall(vi.mocked(call))
  const stop = screen.getByRole('button', { name: '停止' })
  await userEvent.dblClick(stop)
  expect(vi.mocked(call).mock.calls.filter(([ch]) => ch === 'run:stop')).toEqual([
    ['run:stop', 't1', 'main']
  ])
  expect(stop).toBeDisabled()
  await release()
  view.rerender(
    <ClarifyScreen
      task={makeTask({ runState: 'idle' })}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
    />
  )
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  view.rerender(
    <ClarifyScreen
      task={makeTask({ runState: 'running' })}
      nav={null}
      readOnly
      onOpenStage={() => {}}
    />
  )
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
})

const clarify = (over: Parameters<typeof makeTask>[0] = {}) =>
  render(<ClarifyScreen task={makeTask(over)} nav={null} readOnly={false} onOpenStage={() => {}} />)
const newBranchForm = () => screen.getByRole('form', { name: '新分岔' })
const topicInput = () =>
  within(newBranchForm()).getByRole('textbox', { name: '想針對這段討論什麼？' })

test('從 Claude 的訊息分岔：先問想討論什麼，送出後才建立分岔並切過去', async () => {
  clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  // 還沒建立任何東西：分岔面板顯示引用與問題輸入框，焦點移到輸入框
  expect(call).not.toHaveBeenCalled()
  expect(within(newBranchForm()).getByText('有幾件事要先確認。')).toBeInTheDocument()
  expect(topicInput()).toHaveFocus()
  expect(within(newBranchForm()).getByRole('button', { name: '開始討論' })).toBeDisabled()
  await userEvent.type(topicInput(), '為什麼要先確認**這些**？{Enter}')
  expect(call).toHaveBeenCalledWith('branch:open', 't1', {
    title: '為什麼要先確認這些？',
    seed: '針對以下內容：\n有幾件事要先確認。\n\n我的問題：為什麼要先確認**這些**？'
  })
  expect(useStore.getState().activeBranch.t1).toBe('b1')
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
})

test('從訊息分岔：取消（按鈕或 Esc）不建立分岔', async () => {
  clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '先不要')
  await userEvent.click(within(newBranchForm()).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '{Escape}')
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
  // 焦點在表單的其他地方（例如按了取消旁邊的按鈕）時 Esc 也取消
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  within(newBranchForm()).getByRole('button', { name: '取消' }).focus()
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
  expect(call).not.toHaveBeenCalled()
})

test('從訊息分岔：輸入法選字中的 Enter 不送出、Esc 不取消', async () => {
  clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '鎖定期間')
  expect(fireEvent.keyDown(topicInput(), { key: 'Enter', isComposing: true })).toBe(false)
  expect(fireEvent.keyDown(topicInput(), { key: 'Enter', keyCode: 229 })).toBe(false)
  fireEvent.keyDown(topicInput(), { key: 'Escape', isComposing: true })
  expect(call).not.toHaveBeenCalled()
  expect(topicInput()).toHaveValue('鎖定期間')
})

test('從訊息分岔：標題最多 30 字；長訊息的引用可以展開，開場只帶前 600 字', async () => {
  const long = `${'甲'.repeat(650)}`
  useStore.setState({
    timelines: { t1: [{ id: 'e9', ts: '', channel: 'main', kind: 'assistant_text', text: long }] }
  })
  clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  const expand = within(newBranchForm()).getByRole('button', { name: '展開全文' })
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(expand)
  expect(within(newBranchForm()).getByRole('button', { name: '收合' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  await userEvent.type(topicInput(), `${'問'.repeat(35)}{Enter}`)
  expect(call).toHaveBeenCalledWith('branch:open', 't1', {
    title: '問'.repeat(30),
    seed: `針對以下內容：\n${'甲'.repeat(600)}\n\n我的問題：${'問'.repeat(35)}`
  })
})

test('開分岔進行中停用按鈕，連點只開一個', async () => {
  clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '差在哪？')
  const release = holdNextCall(vi.mocked(call))
  const start = within(newBranchForm()).getByRole('button', { name: '開始討論' })
  await userEvent.dblClick(start)
  expect(call).toHaveBeenCalledTimes(1)
  expect(start).toBeDisabled()
  expect(screen.getByRole('button', { name: '從這則訊息分岔' })).toBeDisabled()
  await release({ id: 'b3' })
  expect(useStore.getState().activeBranch.t1).toBe('b3')
  expect(screen.getByRole('button', { name: '從這則訊息分岔' })).toBeEnabled()
})

test('從訊息分岔：開分岔失敗時保留輸入的問題', async () => {
  vi.mocked(call).mockRejectedValueOnce(new Error('主線正在執行，請等它停下來再分岔'))
  clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '差在哪？{Enter}')
  expect(useStore.getState().toast?.text).toContain('主線正在執行')
  expect(topicInput()).toHaveValue('差在哪？')
})

test('從訊息分岔：主線開始執行後不能送出，並說明原因', async () => {
  const { rerender } = clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '差在哪？')
  rerender(
    <ClarifyScreen
      task={makeTask({ runState: 'running' })}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
    />
  )
  expect(within(newBranchForm()).getByRole('button', { name: '開始討論' })).toBeDisabled()
  expect(newBranchForm()).toHaveTextContent('主線正在執行，等它停下來才能開分岔')
})

test('從訊息分岔：取消後焦點回到分岔按鈕；建立後焦點移到新分岔的標籤', async () => {
  const { rerender } = clarify()
  const trigger = screen.getByRole('button', { name: '從這則訊息分岔' })
  await userEvent.click(trigger)
  await userEvent.type(topicInput(), '{Escape}')
  expect(trigger).toHaveFocus()

  await userEvent.click(trigger)
  await userEvent.type(topicInput(), '差在哪？')
  const release = holdNextCall(vi.mocked(call))
  await userEvent.click(within(newBranchForm()).getByRole('button', { name: '開始討論' }))
  // 主程序建立分岔時先推送任務更新，IPC 的結果才回來
  const created = {
    id: 'b1',
    title: '差在哪？',
    status: 'open' as const,
    running: true,
    createdAt: ''
  }
  rerender(
    <ClarifyScreen
      task={makeTask({ branches: [created] })}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
    />
  )
  await release({ id: 'b1' })
  expect(screen.getByRole('button', { name: /差在哪？ · 討論中/ })).toHaveFocus()
})

test('從訊息分岔：建立中不能取消（取消鈕停用、Esc 沒有作用）', async () => {
  clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '差在哪？')
  const release = holdNextCall(vi.mocked(call))
  await userEvent.click(within(newBranchForm()).getByRole('button', { name: '開始討論' }))
  expect(within(newBranchForm()).getByRole('button', { name: '取消' })).toBeDisabled()
  await userEvent.type(topicInput(), '{Escape}')
  expect(newBranchForm()).toBeInTheDocument()
  await release({ id: 'b3' })
  expect(useStore.getState().activeBranch.t1).toBe('b3')
})

test('從訊息分岔：換一則訊息就重新開始（不帶著前一則的問題）', async () => {
  useStore.setState({
    timelines: {
      t1: [
        ...events,
        { id: 'e3', ts: '', channel: 'main', kind: 'assistant_text', text: '第二則訊息' }
      ]
    }
  })
  clarify()
  const [first, second] = screen.getAllByRole('button', { name: '從這則訊息分岔' })
  await userEvent.click(first)
  await userEvent.type(topicInput(), '關於第一則')
  await userEvent.click(second)
  expect(within(newBranchForm()).getByText('第二則訊息')).toBeInTheDocument()
  expect(topicInput()).toHaveValue('')
  expect(topicInput()).toHaveFocus()
})

test('從訊息分岔的輸入框開著時，從問題卡片切到分岔（查看分岔）就放棄草稿', async () => {
  const task = makeTask({
    questions: [
      {
        id: 'q1',
        text: '要鎖多久？',
        status: 'open',
        allowFreeText: true,
        askedAt: '',
        options: [{ id: 'a', label: '15 分鐘' }],
        followups: []
      }
    ],
    branches: [
      {
        id: 'b1',
        title: '鎖定時間',
        fromQuestionId: 'q1',
        status: 'open',
        running: false,
        createdAt: ''
      }
    ]
  })
  useStore.setState({
    activeBranch: {},
    timelines: {
      t1: [...events, { id: 'e3', ts: '', channel: 'main', kind: 'question', ref: 'q1' }]
    }
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  expect(newBranchForm()).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '查看分岔' }))
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /鎖定時間 · 進行中/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('從訊息分岔的輸入框開著時，「查看分岔」到已經在看的分岔也會放棄草稿', async () => {
  const task = makeTask({
    questions: [
      {
        id: 'q1',
        text: '要鎖多久？',
        status: 'open',
        allowFreeText: true,
        askedAt: '',
        options: [{ id: 'a', label: '15 分鐘' }],
        followups: []
      }
    ],
    branches: [
      {
        id: 'b1',
        title: '鎖定時間',
        fromQuestionId: 'q1',
        status: 'open',
        running: false,
        createdAt: ''
      }
    ]
  })
  // 分岔面板本來就在看 b1
  useStore.setState({
    activeBranch: { t1: 'b1' },
    timelines: {
      t1: [...events, { id: 'e3', ts: '', channel: 'main', kind: 'question', ref: 'q1' }]
    }
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  expect(newBranchForm()).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '查看分岔' }))
  expect(screen.queryByRole('form', { name: '新分岔' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /鎖定時間 · 進行中/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('從訊息分岔：再按一次同一則訊息的分岔按鈕，焦點回到問題輸入框（打的字留著）', async () => {
  clarify()
  const trigger = screen.getByRole('button', { name: '從這則訊息分岔' })
  await userEvent.click(trigger)
  await userEvent.type(topicInput(), '差在哪')
  trigger.focus()
  await userEvent.click(trigger)
  expect(topicInput()).toHaveFocus()
  expect(topicInput()).toHaveValue('差在哪')
})

test('從訊息分岔：建立中不能用分岔標籤放棄草稿；建立失敗時問題留著', async () => {
  const task = makeTask({
    branches: [{ id: 'b1', title: '舊分岔', status: 'open', running: false, createdAt: '' }]
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  await userEvent.type(topicInput(), '差在哪？')
  const release = holdNextCall(vi.mocked(call))
  await userEvent.click(within(newBranchForm()).getByRole('button', { name: '開始討論' }))
  const chip = screen.getByRole('button', { name: /舊分岔 · 進行中/ })
  expect(chip).toBeDisabled()
  await userEvent.click(chip)
  expect(newBranchForm()).toBeInTheDocument()
  // 建立失敗（act 吞掉錯誤、回傳 undefined）：輸入的問題還在
  await release(undefined)
  expect(topicInput()).toHaveValue('差在哪？')
  expect(chip).toBeEnabled()
})

test('離開釐清畫面就放棄草稿', async () => {
  const { unmount } = clarify()
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  expect(useStore.getState().branchDrafts.t1).toBeDefined()
  unmount()
  expect(useStore.getState().branchDrafts.t1).toBeUndefined()
})

test('等反問的回答時只在卡片顯示處理中，不重複顯示', () => {
  const task = makeTask({
    runState: 'running',
    questions: [
      {
        id: 'q1',
        text: '要鎖多久？',
        status: 'open',
        allowFreeText: true,
        askedAt: '',
        options: [{ id: 'a', label: '15 分鐘' }],
        followups: [{ role: 'user', text: '可以依帳號調整嗎？' }]
      }
    ]
  })
  useStore.setState({
    timelines: {
      t1: [...events, { id: 'e3', ts: '', channel: 'main', kind: 'question', ref: 'q1' }]
    }
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(screen.getByText('Claude 正在回答…')).toBeInTheDocument()
  expect(screen.queryByText('Claude 正在處理…')).not.toBeInTheDocument()
})

test('分岔的錯誤只出現在分岔面板，不在主線', () => {
  const task = makeTask({
    branches: [
      { id: 'b1', title: '通知', status: 'open', running: false, createdAt: '', error: '分岔失敗' }
    ]
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(within(screen.getByRole('main')).queryByRole('alert')).not.toBeInTheDocument()
  expect(
    within(screen.getByRole('complementary', { name: '分岔討論' })).getByRole('alert')
  ).toHaveTextContent('分岔失敗')
})

test('Claude 執行中不能從訊息分岔，但仍可插話', () => {
  render(
    <ClarifyScreen
      task={makeTask({ runState: 'running' })}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
    />
  )
  expect(screen.queryByRole('button', { name: '從這則訊息分岔' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '訊息' })).toBeEnabled()
})

test('指定要跳到的問題：捲到那個問題（卡片或已答列）並短暫標示，焦點也移過去', () => {
  const q = (id: string, status: 'open' | 'answered') => ({
    id,
    text: `問題 ${id}`,
    status,
    allowFreeText: true,
    askedAt: '',
    options: [{ id: 'a', label: '選項' }],
    answer: status === 'answered' ? { optionId: 'a' } : undefined,
    followups: []
  })
  const task = makeTask({ questions: [q('q1', 'answered'), q('q2', 'open')] })
  useStore.setState({
    timelines: {
      t1: [
        ...events,
        { id: 'e3', ts: '', channel: 'main', kind: 'question', ref: 'q1' },
        { id: 'e4', ts: '', channel: 'main', kind: 'question', ref: 'q2' }
      ]
    }
  })
  // jsdom 沒有 scrollIntoView：記下被捲到的元素
  const scrolled: Element[] = []
  const original = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  onTestFinished(() => {
    Element.prototype.scrollIntoView = original
  })
  const { rerender } = render(
    <ClarifyScreen
      task={task}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
      focusQuestion={{ id: 'q1' }}
    />
  )
  const row = document.querySelector<HTMLElement>('[data-question="q1"]')!
  expect(scrolled).toEqual([row])
  expect(row).toHaveAttribute('data-flash')
  expect(row).toHaveFocus()
  // 同一次跳轉不會因為畫面更新又捲一次；再點一次（新的指定）才會
  rerender(
    <ClarifyScreen
      task={{ ...task, updatedAt: 'x' }}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
      focusQuestion={{ id: 'q2' }}
    />
  )
  const card = document.querySelector<HTMLElement>('[data-question="q2"]')!
  expect(card.tagName).toBe('SECTION')
  expect(scrolled).toEqual([row, card])
})

test('唯讀時沒有輸入框', () => {
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly onOpenStage={() => {}} />)
  expect(screen.queryByRole('textbox', { name: '訊息' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '從這則訊息分岔' })).not.toBeInTheDocument()
})

test('TaskScreen：釐清中的任務顯示釐清畫面；回看釐清時唯讀', async () => {
  useStore.setState({ tasks: { t1: makeTask() } })
  const { unmount } = render(<TaskScreen taskId="t1" />)
  expect(screen.getByRole('textbox', { name: '訊息' })).toBeInTheDocument()
  unmount()
  useStore.setState({ tasks: { t1: makeTask({ status: 'spec_review' }) } })
  render(<TaskScreen taskId="t1" />)
  await userEvent.click(screen.getByRole('button', { name: /釐清/ }))
  expect(screen.getByText('加上登入失敗鎖定')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '訊息' })).not.toBeInTheDocument()
})

test('TaskScreen：已丟棄的任務即使停在釐清也唯讀', () => {
  useStore.setState({ tasks: { t1: makeTask({ status: 'discarded' }) } })
  render(<TaskScreen taskId="t1" />)
  expect(screen.getByText('加上登入失敗鎖定')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '訊息' })).not.toBeInTheDocument()
})

test('釐清中 Claude 要讀網頁時也顯示核准對話框', () => {
  const task = makeTask({
    runState: 'waiting_permission',
    pendingPermission: {
      id: 'p1',
      taskId: 't1',
      channel: 'main',
      toolName: 'WebFetch',
      input: { url: 'https://example.com/docs', prompt: '查 API 限制' },
      createdAt: ''
    }
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(
    within(screen.getByRole('main')).getByRole('dialog', { name: 'Claude 想讀取這個網頁' })
  ).toBeInTheDocument()
})
