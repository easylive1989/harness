// tests/renderer/RepoMenu.test.tsx
// 側欄 repo 列的「⋯」：從 Harness 移除 repo，它的任務一併刪除（兩段式確認）
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
import { call } from '@renderer/api'
import { Sidebar } from '@renderer/components/Sidebar'
import { resetStoreInternals, useStore } from '@renderer/store'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const repos = [
  { id: 'r1', name: 'shop-api', path: '/Users/me/shop-api', addedAt: '' },
  { id: 'r2', name: 'web', path: '/Users/me/web', addedAt: '' }
]

beforeEach(() => {
  vi.mocked(call).mockReset()
  vi.mocked(call).mockResolvedValue({ leftWorktrees: [] } as never)
  resetStoreInternals()
  useStore.setState({
    ready: true,
    repos,
    tasks: {
      a: makeTask({ id: 'a', repoId: 'r1', title: '登入失敗鎖定' }),
      b: makeTask({ id: 'b', repoId: 'r1', title: '匯出 CSV' }),
      gone: makeTask({ id: 'gone', repoId: 'r1', status: 'discarded' }),
      w: makeTask({ id: 'w', repoId: 'r2', title: '修正時區' })
    },
    timelines: {},
    view: { kind: 'new' },
    toast: undefined
  })
})

const trigger = (name: string) => screen.getByRole('button', { name: `「${name}」的動作` })
const menu = (name: string) => screen.getByRole('group', { name: `「${name}」的動作` })

test('「⋯」→ 移除 repo：確認文字寫出會刪除的任務數；確定後呼叫 repos:remove 並提示', async () => {
  render(<Sidebar />)
  expect(trigger('shop-api')).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(trigger('shop-api'))
  expect(trigger('shop-api')).toHaveAttribute('aria-expanded', 'true')
  await userEvent.click(within(menu('shop-api')).getByRole('button', { name: '移除 repo' }))
  expect(call).not.toHaveBeenCalled()
  // 已丟棄的任務在側欄看不到，不算在數量裡
  expect(menu('shop-api')).toHaveTextContent(
    '確定要從 Harness 移除 shop-api？它的 2 個任務會一併刪除：停止 Claude，刪除 worktree、分支和對話紀錄，無法復原。repo 資料夾本身不受影響。'
  )
  expect(menu('shop-api')).not.toHaveTextContent('會先停止')
  // 焦點移到「取消」：誤按 Enter 不會移除
  expect(within(menu('shop-api')).getByRole('button', { name: '取消' })).toHaveFocus()
  await userEvent.click(within(menu('shop-api')).getByRole('button', { name: '確定移除' }))
  expect(call).toHaveBeenCalledWith('repos:remove', 'r1')
  expect(useStore.getState().toast?.text).toBe('已移除 repo「shop-api」')
  expect(screen.queryByRole('group', { name: '「shop-api」的動作' })).not.toBeInTheDocument()
})

test('沒有任務時只說明 repo 資料夾不受影響；取消、Esc 都會關閉並把焦點還給「⋯」', async () => {
  useStore.setState({ tasks: {} })
  render(<Sidebar />)
  await userEvent.click(trigger('web'))
  await userEvent.click(within(menu('web')).getByRole('button', { name: '移除 repo' }))
  expect(menu('web')).toHaveTextContent('確定要從 Harness 移除 web？repo 資料夾本身不受影響。')
  expect(menu('web')).not.toHaveTextContent('任務')
  await userEvent.click(within(menu('web')).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('group', { name: '「web」的動作' })).not.toBeInTheDocument()
  expect(trigger('web')).toHaveFocus()
  await userEvent.click(trigger('web'))
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('group', { name: '「web」的動作' })).not.toBeInTheDocument()
  expect(trigger('web')).toHaveFocus()
  expect(call).not.toHaveBeenCalled()
})

test('Claude 正在執行（主線或分岔）時，確認文字說明會先停止', async () => {
  useStore.setState({
    tasks: {
      a: makeTask({ id: 'a', repoId: 'r1', runState: 'running' }),
      w: makeTask({
        id: 'w',
        repoId: 'r2',
        branches: [{ id: 'b1', title: '討論', status: 'open', running: true }] as never
      })
    }
  })
  render(<Sidebar />)
  for (const name of ['shop-api', 'web']) {
    await userEvent.click(trigger(name))
    await userEvent.click(within(menu(name)).getByRole('button', { name: '移除 repo' }))
    expect(menu(name)).toHaveTextContent('它的 1 個任務會一併刪除')
    expect(menu(name)).toHaveTextContent('Claude 正在執行，會先停止。')
    await userEvent.keyboard('{Escape}')
  }
})

test('有任務在整理報告時不能移除', async () => {
  useStore.setState({
    tasks: { a: makeTask({ id: 'a', repoId: 'r1', runState: 'finalizing' }) }
  })
  render(<Sidebar />)
  await userEvent.click(trigger('shop-api'))
  expect(within(menu('shop-api')).getByRole('button', { name: '移除 repo' })).toBeDisabled()
  expect(menu('shop-api')).toHaveTextContent('有任務正在整理報告，完成後才能移除。')
})

test('移除中按鈕停用、連點只送一次；失敗時留在選單顯示原因', async () => {
  render(<Sidebar />)
  await userEvent.click(trigger('shop-api'))
  await userEvent.click(within(menu('shop-api')).getByRole('button', { name: '移除 repo' }))
  let reject: (e: Error) => void = () => {}
  vi.mocked(call).mockImplementationOnce(() => new Promise((_, r) => (reject = r)) as never)
  const confirm = within(menu('shop-api')).getByRole('button', { name: '確定移除' })
  await userEvent.click(confirm)
  await userEvent.click(confirm)
  expect(call).toHaveBeenCalledTimes(1)
  expect(confirm).toHaveAttribute('aria-disabled', 'true')
  // 進行中點外面不關閉：結果要留在這裡
  await userEvent.click(screen.getByRole('button', { name: '新任務' }))
  reject(new Error('worktree 有檔案被鎖住'))
  const alert = await within(menu('shop-api')).findByRole('alert')
  expect(alert).toHaveTextContent('移除失敗：worktree 有檔案被鎖住')
  expect(alert).toHaveFocus()
  expect(useStore.getState().toast).toBeUndefined()
})

test('repo 資料夾已不存在：提示說明 worktree 資料夾沒有刪除與位置', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<Sidebar />)
  await userEvent.click(trigger('shop-api'))
  await userEvent.click(within(menu('shop-api')).getByRole('button', { name: '移除 repo' }))
  await userEvent.click(within(menu('shop-api')).getByRole('button', { name: '確定移除' }))
  await release({ leftWorktrees: ['/wt/shop-api/20261008-a', '/wt/shop-api/20261008-b'] })
  expect(useStore.getState().toast?.text).toBe(
    '已移除 repo「shop-api」。repo 資料夾已不存在，2 個 worktree 資料夾沒有刪除：/wt/shop-api/20261008-a、/wt/shop-api/20261008-b'
  )
})
