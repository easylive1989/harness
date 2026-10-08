// tests/renderer/TaskMenu.test.tsx
// 任務標題列的「⋯」選單：任何階段都能丟棄任務；已完成的任務只能清除 worktree
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
import { call } from '@renderer/api'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Task } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeReport } from '../fixtures/report'
import { makeTask } from '../fixtures/task'

let replies: Record<string, (...args: never[]) => unknown>

beforeEach(() => {
  replies = {
    'finish:discard': () => undefined,
    'report:get': (_taskId: string, version: number) => makeReport({ version }),
    'tasks:changedFiles': () => ({ files: 0, additions: 0, deletions: 0, perFile: [] })
  }
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string, ...args: never[]) =>
    replies[ch](...args)) as typeof call)
  resetStoreInternals()
  useStore.setState({
    tasks: {},
    timelines: { t1: [] },
    feedback: {},
    toast: undefined,
    view: { kind: 'task', taskId: 't1' }
  })
})

const show = (over: Partial<Task> = {}) => {
  useStore.setState({ tasks: { t1: makeTask(over) } })
  return render(<TaskScreen taskId="t1" />)
}
const menuButton = () => screen.getByRole('button', { name: '任務動作' })
const menu = () => screen.getByRole('group', { name: '任務動作' })

test('釐清中也能丟棄任務：兩段式確認，可以取消；丟棄後回到新任務並提示', async () => {
  show()
  expect(menuButton()).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(menuButton())
  expect(menuButton()).toHaveAttribute('aria-expanded', 'true')
  await userEvent.click(within(menu()).getByRole('button', { name: '丟棄任務' }))
  expect(call).not.toHaveBeenCalled()
  expect(menu()).toHaveTextContent('worktree 與分支 harness/t1 都會刪除，無法復原')
  // 焦點移到「取消」：誤按 Enter 不會丟棄
  expect(within(menu()).getByRole('button', { name: '取消' })).toHaveFocus()
  await userEvent.click(within(menu()).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('group', { name: '任務動作' })).not.toBeInTheDocument()

  await userEvent.click(menuButton())
  await userEvent.click(within(menu()).getByRole('button', { name: '丟棄任務' }))
  await userEvent.click(within(menu()).getByRole('button', { name: '確定丟棄' }))
  expect(call).toHaveBeenCalledWith('finish:discard', 't1')
  await waitFor(() => expect(useStore.getState().view).toEqual({ kind: 'new' }))
  expect(useStore.getState().toast?.text).toBe('已丟棄任務「登入失敗鎖定」')
})

test('規格、實作與報告階段的標題列都有選單', async () => {
  const { unmount } = show({ status: 'spec_review', specs: [] })
  expect(menuButton()).toBeInTheDocument()
  unmount()
  const second = show({ status: 'implementing' })
  expect(menuButton()).toBeInTheDocument()
  second.unmount()
  show({ status: 'reviewing', reportVersions: [1] })
  await screen.findByRole('heading', { name: '登入流程多了一道鎖定關卡' })
  expect(menuButton()).toBeInTheDocument()
  // 報告頁的收尾面板只留開 PR 與合併：丟棄只在標題列的選單
  const panel = screen.getByRole('complementary', { name: '回饋與收尾' })
  expect(within(panel).queryByRole('button', { name: /丟棄/ })).not.toBeInTheDocument()
})

test('Claude 執行中丟棄：說明會先停止 Claude', async () => {
  show({ status: 'implementing', runState: 'running' })
  await userEvent.click(menuButton())
  await userEvent.click(within(menu()).getByRole('button', { name: '丟棄任務' }))
  expect(menu()).toHaveTextContent('Claude 正在執行，會先停止')
})

test('整理報告中不能丟棄，並說明原因', async () => {
  show({ status: 'implementing', runState: 'finalizing' })
  await userEvent.click(menuButton())
  expect(within(menu()).getByRole('button', { name: '丟棄任務' })).toBeDisabled()
  expect(menu()).toHaveTextContent('正在整理報告，完成後才能丟棄')
})

test('丟棄失敗時在選單裡顯示原因，留在任務上', async () => {
  replies['finish:discard'] = () => {
    throw new Error('另一個收尾操作正在進行，請稍候')
  }
  show({ status: 'reviewing', reportVersions: [1] })
  await userEvent.click(menuButton())
  await userEvent.click(within(menu()).getByRole('button', { name: '丟棄任務' }))
  await userEvent.click(within(menu()).getByRole('button', { name: '確定丟棄' }))
  expect(await within(menu()).findByRole('alert')).toHaveTextContent(
    '丟棄失敗：另一個收尾操作正在進行，請稍候'
  )
  expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 't1' })
})

test('丟棄進行中停用確定鈕，連點只送一次；選單不會被關掉', async () => {
  show()
  await userEvent.click(menuButton())
  await userEvent.click(within(menu()).getByRole('button', { name: '丟棄任務' }))
  const release = holdNextCall(vi.mocked(call))
  const ok = within(menu()).getByRole('button', { name: '確定丟棄' })
  await userEvent.dblClick(ok)
  expect(call).toHaveBeenCalledTimes(1)
  expect(ok).toBeDisabled()
  await userEvent.keyboard('{Escape}')
  await userEvent.click(document.body)
  expect(menu()).toBeInTheDocument()
  await release()
  await waitFor(() => expect(useStore.getState().view).toEqual({ kind: 'new' }))
})

test('已完成：只有清除 worktree；清除後提示，不再顯示選單，留在任務上', async () => {
  show({ status: 'done', reportVersions: [1], prUrl: 'https://github.com/me/shop/pull/7' })
  await screen.findByRole('heading', { name: '登入流程多了一道鎖定關卡' })
  await userEvent.click(menuButton())
  expect(within(menu()).queryByRole('button', { name: '丟棄任務' })).not.toBeInTheDocument()
  await userEvent.click(within(menu()).getByRole('button', { name: '清除 worktree' }))
  expect(menu()).toHaveTextContent('已開的 PR 或已合併的內容不受影響')
  await userEvent.click(within(menu()).getByRole('button', { name: '確定清除' }))
  expect(call).toHaveBeenCalledWith('finish:discard', 't1')
  await waitFor(() => expect(useStore.getState().toast?.text).toBe('已清除 worktree'))
  expect(screen.queryByRole('button', { name: '任務動作' })).not.toBeInTheDocument()
  expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 't1' })
})

test('已丟棄的任務沒有選單', () => {
  show({ status: 'discarded' })
  expect(screen.queryByRole('button', { name: '任務動作' })).not.toBeInTheDocument()
})

test('Esc 或點選單外面關閉選單；Esc 後焦點回到選單按鈕', async () => {
  show()
  await userEvent.click(menuButton())
  expect(within(menu()).getByRole('button', { name: '丟棄任務' })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('group', { name: '任務動作' })).not.toBeInTheDocument()
  expect(menuButton()).toHaveFocus()
  await userEvent.click(menuButton())
  await userEvent.click(screen.getByText('登入失敗鎖定'))
  expect(screen.queryByRole('group', { name: '任務動作' })).not.toBeInTheDocument()
})
