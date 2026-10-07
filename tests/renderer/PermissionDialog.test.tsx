// tests/renderer/PermissionDialog.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { PendingPermission, PermissionDialog } from '@renderer/components/PermissionDialog'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { PermissionRequest } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const req: PermissionRequest = {
  id: 'p1',
  taskId: 't1',
  channel: 'main',
  toolName: 'Bash',
  input: { command: 'npm test -- auth', description: '跑 auth 測試' },
  suggestedPattern: 'npm test *',
  createdAt: ''
}

beforeEach(() => {
  vi.mocked(call).mockReset()
  vi.mocked(call).mockResolvedValue(undefined)
  resetStoreInternals()
  useStore.setState({ toast: undefined })
})

test('顯示指令與原因，勾選後允許並記住樣式', async () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  expect(screen.getByRole('dialog', { name: 'Claude 想執行這個指令' })).toBeInTheDocument()
  expect(screen.getByText('$ npm test -- auth')).toBeInTheDocument()
  expect(screen.getByText('cwd: /wt')).toBeInTheDocument()
  expect(screen.getByText(/跑 auth 測試/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('checkbox', { name: /本任務內都允許/ }))
  await userEvent.click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', {
    allow: true,
    rememberPattern: 'npm test *'
  })
})

test('沒有勾選時只允許這一次', async () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  await userEvent.click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: true })
})

test('拒絕並說明', async () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  await userEvent.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await userEvent.type(screen.getByRole('textbox', { name: '拒絕原因' }), '先不要跑')
  await userEvent.click(screen.getByRole('button', { name: '送出拒絕' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', {
    allow: false,
    message: '先不要跑'
  })
})

test('不寫原因也能拒絕；可以返回', async () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  await userEvent.click(screen.getByRole('button', { name: '拒絕並說明' }))
  expect(screen.getByRole('textbox', { name: '拒絕原因' })).toHaveFocus()
  await userEvent.click(screen.getByRole('button', { name: '返回' }))
  expect(screen.queryByRole('textbox', { name: '拒絕原因' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await userEvent.click(screen.getByRole('button', { name: '送出拒絕' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: false })
})

test('送出中停用按鈕，連點只送一次', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<PermissionDialog request={req} cwd="/wt" />)
  const allow = screen.getByRole('button', { name: '允許' })
  await userEvent.dblClick(allow)
  expect(call).toHaveBeenCalledTimes(1)
  expect(allow).toBeDisabled()
  expect(screen.getByRole('button', { name: '拒絕並說明' })).toBeDisabled()
  await release()
  expect(allow).toBeEnabled()
})

test('核准失敗（請求已失效）時顯示錯誤', async () => {
  vi.mocked(call).mockRejectedValueOnce(new Error('這個核准請求已經失效'))
  render(<PermissionDialog request={req} cwd="/wt" />)
  await userEvent.click(screen.getByRole('button', { name: '允許' }))
  expect(useStore.getState().toast?.text).toContain('已經失效')
})

test('串接的指令不能記住樣式', () => {
  render(
    <PermissionDialog
      request={{
        ...req,
        input: { command: 'npm test && rm -rf dist' },
        suggestedPattern: undefined
      }}
      cwd="/wt"
    />
  )
  expect(screen.getByText('$ npm test && rm -rf dist')).toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.getByText(/只能逐次核准/)).toBeInTheDocument()
})

test('修改受保護的檔案：顯示工具、相對路徑、說明與要寫入的內容', () => {
  render(
    <PermissionDialog
      request={{
        ...req,
        toolName: 'Edit',
        input: {
          file_path: '/wt/.claude/settings.json',
          old_string: '"allow": []',
          new_string: '"allow": ["Bash(*)"]'
        },
        suggestedPattern: undefined
      }}
      cwd="/wt"
    />
  )
  expect(screen.getByRole('dialog', { name: 'Claude 想修改這個檔案' })).toBeInTheDocument()
  expect(screen.getByText('.claude/settings.json')).toBeInTheDocument()
  expect(screen.getByText('Edit · cwd: /wt')).toBeInTheDocument()
  expect(screen.getByText('這個檔案會影響 Claude 的權限或 git 設定')).toBeInTheDocument()
  expect(screen.getByLabelText('要寫入的內容')).toHaveTextContent(
    '- "allow": [] + "allow": ["Bash(*)"]'
  )
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

test('WebFetch 顯示網址與用途；WebSearch 顯示搜尋字詞', () => {
  const { unmount } = render(
    <PermissionDialog
      request={{
        ...req,
        toolName: 'WebFetch',
        input: { url: 'https://example.com/docs', prompt: '找出 API 的速率限制' },
        suggestedPattern: undefined
      }}
      cwd="/wt"
    />
  )
  expect(screen.getByRole('dialog', { name: 'Claude 想讀取這個網頁' })).toBeInTheDocument()
  expect(screen.getByText('https://example.com/docs')).toBeInTheDocument()
  expect(screen.getByText('WebFetch')).toBeInTheDocument()
  expect(screen.getByText('用途：找出 API 的速率限制')).toBeInTheDocument()
  unmount()
  render(
    <PermissionDialog
      request={{ ...req, toolName: 'WebSearch', input: { query: 'redis ttl' } }}
      cwd="/wt"
    />
  )
  expect(screen.getByRole('dialog', { name: 'Claude 想搜尋網路' })).toBeInTheDocument()
  expect(screen.getByText('redis ttl')).toBeInTheDocument()
})

test('出現時把焦點移到對話框（不直接停在「允許」上）', () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  expect(screen.getByRole('dialog')).toHaveFocus()
})

test('PendingPermission：沒有請求時不顯示；換下一個請求時重設勾選與拒絕狀態', async () => {
  const { rerender } = render(<PendingPermission task={makeTask()} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  rerender(<PendingPermission task={makeTask({ pendingPermission: req })} />)
  await userEvent.click(screen.getByRole('checkbox'))
  expect(screen.getByRole('checkbox')).toBeChecked()
  const next: PermissionRequest = {
    ...req,
    id: 'p2',
    input: { command: 'npm run lint' },
    suggestedPattern: 'npm run *'
  }
  rerender(<PendingPermission task={makeTask({ pendingPermission: next })} />)
  expect(screen.getByText('$ npm run lint')).toBeInTheDocument()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await userEvent.click(screen.getByRole('button', { name: '拒絕並說明' }))
  rerender(<PendingPermission task={makeTask({ pendingPermission: { ...next, id: 'p3' } })} />)
  expect(screen.getByRole('button', { name: '允許' })).toBeInTheDocument()
  expect(screen.getByText('cwd: /tmp/wt/t1')).toBeInTheDocument()
})
