// tests/renderer/ClarifyScreen.test.tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
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
  useStore.setState({ activeBranch: {}, timelines: { t1: events }, toast: undefined })
})

test('顯示主線時間軸，從輸入框送出訊息', async () => {
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(screen.getByText('加上登入失敗鎖定')).toBeInTheDocument()
  expect(screen.getByRole('complementary', { name: '分岔討論' })).toBeInTheDocument()
  const send = screen.getByRole('button', { name: '送出' })
  expect(send).toBeDisabled()
  await userEvent.type(screen.getByRole('textbox', { name: '訊息' }), '也要記錄稽核日誌{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'main', '也要記錄稽核日誌')
  expect(screen.getByRole('textbox', { name: '訊息' })).toHaveValue('')
})

test('從 Claude 的訊息開分岔並切過去', async () => {
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly={false} onOpenStage={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  expect(call).toHaveBeenCalledWith('branch:open', 't1', {
    title: '有幾件事要先確認。',
    seed: '針對這段內容深入討論：\n有幾件事要先確認。'
  })
  expect(useStore.getState().activeBranch.t1).toBe('b1')
})

test('開分岔進行中停用分岔按鈕，連點只開一個', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly={false} onOpenStage={() => {}} />)
  const button = screen.getByRole('button', { name: '從這則訊息分岔' })
  await userEvent.dblClick(button)
  expect(call).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  await release({ id: 'b3' })
  expect(useStore.getState().activeBranch.t1).toBe('b3')
  expect(button).toBeEnabled()
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
