// tests/renderer/PermissionDialog.test.tsx
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { PendingPermission, PermissionDialog } from '@renderer/components/PermissionDialog'
import { APPROVAL_ARM_MS, PREVIEW_COLLAPSED } from '@renderer/lib/permission'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { PermissionRequest, Task } from '@shared/types'
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
const next: PermissionRequest = {
  ...req,
  id: 'p2',
  input: { command: 'npm run lint' },
  suggestedPattern: 'npm run *'
}

// 對話框剛出現時按鈕先停用一小段時間，測試用假時鐘跳過
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
const armed = () => act(() => vi.advanceTimersByTimeAsync(APPROVAL_ARM_MS))
const renderDialog = async (r: PermissionRequest = req) => {
  const view = render(<PermissionDialog request={r} cwd="/wt" />)
  await armed()
  return view
}

/** 畫面上的輸入框＋核准對話框（模擬實作頁：對話框關掉後焦點回到插話框） */
function Screen({ task }: { task: Task }) {
  const composer = useRef<HTMLInputElement>(null)
  return (
    <>
      <input aria-label="插話" ref={composer} />
      <input aria-label="分岔訊息" />
      <PendingPermission task={task} fallbackFocus={() => composer.current} />
    </>
  )
}

beforeEach(() => {
  // shouldAdvanceTime：Testing Library 內部的 setTimeout(0) 照常推進（它只會推 Jest 的假時鐘）
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.mocked(call).mockReset()
  vi.mocked(call).mockResolvedValue(undefined)
  resetStoreInternals()
  useStore.setState({ toast: undefined })
})
afterEach(() => {
  vi.useRealTimers()
})

test('顯示指令與原因，勾選後允許並記住樣式', async () => {
  await renderDialog()
  const u = user()
  const dialog = screen.getByRole('dialog', { name: 'Claude 想執行這個指令' })
  expect(dialog).toHaveAccessibleDescription(/\$ npm test -- auth.*cwd: \/wt/)
  expect(screen.getByText(/跑 auth 測試/)).toBeInTheDocument()
  await u.click(screen.getByRole('checkbox', { name: /本任務內都允許/ }))
  await u.click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', {
    allow: true,
    rememberPattern: 'npm test *'
  })
})

test('「本任務內都允許」的樣式範圍很廣或有危險時，顯示和設定頁一樣的提醒', async () => {
  const { rerender } = await renderDialog()
  expect(screen.getByRole('checkbox', { name: /本任務內都允許/ })).not.toHaveAccessibleDescription()
  rerender(
    <PermissionDialog
      request={{ ...req, input: { command: 'ls -la' }, suggestedPattern: 'ls *' }}
      cwd="/wt"
    />
  )
  expect(screen.getByRole('checkbox', { name: /本任務內都允許/ })).toHaveAccessibleDescription(
    '「ls *」會允許所有 ls 開頭的指令，範圍很廣'
  )
  rerender(
    <PermissionDialog
      request={{
        ...req,
        input: { command: 'sudo apt install jq' },
        suggestedPattern: 'sudo apt install jq'
      }}
      cwd="/wt"
    />
  )
  expect(
    screen.getByText('「sudo apt install jq」會允許以管理員權限執行指令，請確認真的需要')
  ).toBeInTheDocument()
})

test('沒有勾選時只允許這一次', async () => {
  await renderDialog()
  await user().click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: true })
})

test('拒絕並說明', async () => {
  await renderDialog()
  const u = user()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await u.type(screen.getByRole('textbox', { name: '拒絕原因' }), '先不要跑')
  await u.click(screen.getByRole('button', { name: '送出拒絕' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', {
    allow: false,
    message: '先不要跑'
  })
})

test('拒絕原因：輸入法選字中按 Esc 不離開拒絕模式', async () => {
  await renderDialog()
  const u = user()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  const reason = screen.getByRole('textbox', { name: '拒絕原因' })
  await u.type(reason, '先不要')
  fireEvent.keyDown(reason, { key: 'Escape', isComposing: true })
  fireEvent.keyDown(reason, { key: 'Escape', keyCode: 229 })
  expect(screen.getByRole('textbox', { name: '拒絕原因' })).toHaveValue('先不要')
})

test('不寫原因也能拒絕；返回或按 Esc 離開拒絕模式', async () => {
  await renderDialog()
  const u = user()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  expect(screen.getByRole('textbox', { name: '拒絕原因' })).toHaveFocus()
  await u.click(screen.getByRole('button', { name: '返回' }))
  expect(screen.queryByRole('textbox', { name: '拒絕原因' })).not.toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('textbox', { name: '拒絕原因' })).not.toBeInTheDocument()
  expect(screen.getByRole('dialog')).toHaveFocus()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await u.click(screen.getByRole('button', { name: '送出拒絕' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: false })
})

test('送出中停用按鈕，連點只送一次', async () => {
  await renderDialog()
  const release = holdNextCall(vi.mocked(call))
  const allow = screen.getByRole('button', { name: '允許' })
  await user().dblClick(allow)
  expect(call).toHaveBeenCalledTimes(1)
  expect(allow).toBeDisabled()
  expect(screen.getByRole('button', { name: '拒絕並說明' })).toBeDisabled()
  await release()
  expect(allow).toBeEnabled()
})

test('新的請求出現後先停用一下：連點不會核准到下一個請求', async () => {
  const u = user()
  const { rerender } = render(<PendingPermission task={makeTask({ pendingPermission: req })} />)
  // 剛出現時也停用
  expect(screen.getByRole('button', { name: '允許' })).toBeDisabled()
  await armed()
  await u.click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledTimes(1)
  // 主程序顯示下一個請求；使用者的第二下點擊落在新的對話框上
  rerender(<PendingPermission task={makeTask({ pendingPermission: next })} />)
  const allow = screen.getByRole('button', { name: '允許' })
  expect(allow).toBeDisabled()
  expect(screen.getByRole('button', { name: '拒絕並說明' })).toBeDisabled()
  await u.click(allow)
  expect(call).toHaveBeenCalledTimes(1)
  await armed()
  expect(allow).toBeEnabled()
})

test('核准失敗（請求已失效）時顯示錯誤', async () => {
  vi.mocked(call).mockRejectedValueOnce(new Error('這個核准請求已經失效'))
  await renderDialog()
  await user().click(screen.getByRole('button', { name: '允許' }))
  expect(useStore.getState().toast?.text).toContain('已經失效')
})

test('串接的指令不能記住樣式', async () => {
  await renderDialog({
    ...req,
    input: { command: 'npm test && rm -rf dist' },
    suggestedPattern: undefined
  })
  expect(screen.getByText('$ npm test && rm -rf dist')).toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.getByText(/只能逐次核准/)).toBeInTheDocument()
})

test('修改受保護的檔案：顯示工具、相對路徑、說明與要寫入的內容', async () => {
  await renderDialog({
    ...req,
    toolName: 'Edit',
    input: {
      file_path: '/wt/.claude/settings.json',
      old_string: '"allow": []',
      new_string: '"allow": ["Bash(*)"]'
    },
    suggestedPattern: undefined
  })
  expect(screen.getByRole('dialog', { name: 'Claude 想修改這個檔案' })).toBeInTheDocument()
  expect(screen.getByText('.claude/settings.json')).toBeInTheDocument()
  expect(screen.getByText('Edit · cwd: /wt')).toBeInTheDocument()
  expect(
    screen.getByText('這個檔案會影響 Claude 的權限、git 設定，或在 git 操作時執行的 hook')
  ).toBeInTheDocument()
  expect(screen.getByLabelText('要寫入的內容')).toHaveTextContent(
    '- "allow": [] + "allow": ["Bash(*)"]'
  )
  expect(screen.queryByRole('button', { name: /顯示完整內容/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

test('內容很長時先顯示開頭，可以展開完整內容', async () => {
  const content = `${'a'.repeat(PREVIEW_COLLAPSED)}TAIL`
  await renderDialog({
    ...req,
    toolName: 'Write',
    input: { file_path: '/wt/.git/hooks/pre-commit', content },
    suggestedPattern: undefined
  })
  const preview = screen.getByLabelText('要寫入的內容')
  expect(preview).not.toHaveTextContent('TAIL')
  await user().click(screen.getByRole('button', { name: /顯示完整內容/ }))
  expect(preview).toHaveTextContent('TAIL')
  expect(screen.queryByRole('button', { name: /顯示完整內容/ })).not.toBeInTheDocument()
})

test('WebFetch 顯示網址與用途；WebSearch 顯示搜尋字詞', async () => {
  const { unmount } = await renderDialog({
    ...req,
    toolName: 'WebFetch',
    input: { url: 'https://example.com/docs', prompt: '找出 API 的速率限制' },
    suggestedPattern: undefined
  })
  expect(screen.getByRole('dialog', { name: 'Claude 想讀取這個網頁' })).toBeInTheDocument()
  expect(screen.getByText('https://example.com/docs')).toBeInTheDocument()
  expect(screen.getByText('WebFetch')).toBeInTheDocument()
  expect(screen.getByText('用途：找出 API 的速率限制')).toBeInTheDocument()
  unmount()
  await renderDialog({ ...req, toolName: 'WebSearch', input: { query: 'redis ttl' } })
  expect(screen.getByRole('dialog', { name: 'Claude 想搜尋網路' })).toBeInTheDocument()
  expect(screen.getByText('redis ttl')).toBeInTheDocument()
})

test('分岔提出的請求標出是哪個分岔', () => {
  render(
    <PendingPermission
      task={makeTask({
        branches: [{ id: 'b1', title: '查資料', status: 'open', running: true, createdAt: '' }],
        pendingPermission: {
          ...req,
          channel: 'branch:b1',
          toolName: 'WebFetch',
          input: { url: 'https://example.com' },
          suggestedPattern: undefined
        }
      })}
    />
  )
  expect(screen.getByRole('dialog', { name: '分岔「查資料」想讀取這個網頁' })).toBeInTheDocument()
})

test('出現時把焦點移到對話框（不直接停在「允許」上）', () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  expect(screen.getByRole('dialog')).toHaveFocus()
})

test('PendingPermission：換下一個請求時重設狀態，焦點移到新的對話框', async () => {
  const u = user()
  const { rerender } = render(<PendingPermission task={makeTask()} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  rerender(<PendingPermission task={makeTask({ pendingPermission: req })} />)
  await armed()
  await u.click(screen.getByRole('checkbox'))
  expect(screen.getByRole('checkbox')).toBeChecked()
  const first = screen.getByRole('dialog')
  rerender(<PendingPermission task={makeTask({ pendingPermission: next })} />)
  expect(screen.getByText('$ npm run lint')).toBeInTheDocument()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('dialog')).not.toBe(first)
  expect(screen.getByRole('dialog')).toHaveFocus()
  await armed()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  rerender(<PendingPermission task={makeTask({ pendingPermission: { ...next, id: 'p3' } })} />)
  expect(screen.getByRole('button', { name: '允許' })).toBeInTheDocument()
  expect(screen.getByText('cwd: /tmp/wt/t1')).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toHaveFocus()
})

test('請求都處理完後，焦點回到使用者原本所在的地方', () => {
  const { rerender } = render(<Screen task={makeTask()} />)
  screen.getByRole('textbox', { name: '分岔訊息' }).focus()
  rerender(<Screen task={makeTask({ pendingPermission: req })} />)
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<Screen task={makeTask()} />)
  expect(screen.getByRole('textbox', { name: '分岔訊息' })).toHaveFocus()
})

test('原本沒有焦點時，請求處理完後焦點移到插話框', () => {
  const { rerender } = render(<Screen task={makeTask({ pendingPermission: req })} />)
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<Screen task={makeTask({ pendingPermission: next })} />)
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<Screen task={makeTask()} />)
  expect(screen.getByRole('textbox', { name: '插話' })).toHaveFocus()
})
