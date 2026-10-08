// tests/renderer/SpecScreen.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { SpecScreen } from '@renderer/screens/SpecScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Spec, Task } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const spec = (version: number, over: Partial<Spec> = {}): Spec => ({
  version,
  title: '以帳號 + IP 計數的登入失敗鎖定',
  summary: '同一帳號從同一 IP 連續登入失敗 5 次，就鎖定 15 分鐘。',
  inScope: ['失敗計數與鎖定的中介層'],
  outOfScope: ['後台手動解鎖介面'],
  decisions: [
    { id: 'd1', text: '計數單位為帳號 + IP 組合', source: { type: 'question', ref: 'q1' } },
    { id: 'd2', text: '計數存在 `lockout:{userId}`', source: { type: 'branch', ref: 'b1' } },
    { id: 'd3', text: '錯誤訊息放進 i18n', source: { type: 'implementation', ref: '' } },
    { id: 'd4', text: '一併修正空密碼漏洞', source: { type: 'user', ref: '順便修空密碼' } }
  ],
  steps: ['新增 `src/auth/lockout.ts`', '在 login.ts 掛上 lockoutGuard'],
  acceptance: ['第 6 次請求回 429'],
  createdAt: '',
  ...over
})

const specTask = (over: Partial<Task> = {}) =>
  makeTask({
    status: 'spec_review',
    specs: [spec(1)],
    questions: [
      {
        id: 'q1',
        text: '計數單位',
        options: [{ id: 'combo', label: '帳號 + IP 組合' }],
        allowFreeText: true,
        status: 'answered',
        answer: { optionId: 'combo', text: '共用 IP 也分開算' },
        followups: [
          { role: 'user', text: '共用 IP 呢？' },
          { role: 'assistant', text: '會分開算。' }
        ],
        askedAt: ''
      },
      {
        id: 'q2',
        text: '還沒回答的問題',
        options: [],
        allowFreeText: true,
        status: 'open',
        followups: [],
        askedAt: ''
      }
    ],
    branches: [
      {
        id: 'b1',
        title: '計數存放位置',
        status: 'concluded',
        running: false,
        conclusion: { decision: '用既有 Redis', rationale: '', deferred: [] },
        createdAt: ''
      },
      { id: 'b2', title: '通知使用者', status: 'open', running: false, createdAt: '' }
    ],
    ...over
  })

const renderSpec = (task: Task, readOnly = false, onOpenQuestion = vi.fn()) =>
  render(
    <SpecScreen
      task={task}
      nav={null}
      readOnly={readOnly}
      onOpenStage={() => {}}
      onOpenQuestion={onOpenQuestion}
    />
  )

beforeEach(() => {
  vi.mocked(call).mockReset()
  vi.mocked(call).mockResolvedValue(undefined)
  resetStoreInternals()
  useStore.setState({ timelines: {}, toast: undefined })
})

test('顯示規格內容與每個決策的來源', () => {
  renderSpec(specTask())
  expect(
    screen.getByRole('heading', { name: '以帳號 + IP 計數的登入失敗鎖定' })
  ).toBeInTheDocument()
  expect(screen.getByText(/規格草稿/)).toHaveTextContent('根據 1 個問題、1 個分岔整理')
  expect(screen.getByText('• 失敗計數與鎖定的中介層')).toBeInTheDocument()
  expect(screen.getByText('• 後台手動解鎖介面')).toBeInTheDocument()
  const decisions = screen.getByRole('list', { name: '決策' })
  const rows = within(decisions).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual([
    'D1計數單位為帳號 + IP 組合問題 1',
    'D2計數存在 lockout:{userId}分岔',
    'D3錯誤訊息放進 i18n實作',
    // 使用者的指示：Claude 摘錄的指示給螢幕閱讀器唸（sr-only），滑過時也看得到
    'D4一併修正空密碼漏洞你的指示：順便修空密碼'
  ])
  expect(within(rows[3]).getByText('你的指示')).toHaveAttribute('title', '順便修空密碼')
  expect(within(rows[3]).getByText('：順便修空密碼')).toHaveClass('sr-only')
  // 反引號包住的內容顯示成程式碼
  expect(within(rows[1]).getByText('lockout:{userId}').tagName).toBe('CODE')
  expect(screen.getByText('src/auth/lockout.ts').tagName).toBe('CODE')
  expect(screen.getByText('• 第 6 次請求回 429')).toBeInTheDocument()
})

test('釐清紀錄列出已回答的問題與分岔', () => {
  renderSpec(specTask())
  const aside = screen.getByRole('complementary', { name: '釐清紀錄' })
  expect(within(aside).getByText('問題 1 · 計數單位')).toBeInTheDocument()
  expect(within(aside).getByText('帳號 + IP 組合；共用 IP 也分開算')).toBeInTheDocument()
  expect(within(aside).getByText('含 1 次反問')).toBeInTheDocument()
  expect(within(aside).queryByText(/還沒回答的問題/)).not.toBeInTheDocument()
  // 帶回的分岔指向規格裡引用它的決策
  expect(within(aside).getByText('分岔 · 計數存放位置')).toBeInTheDocument()
  expect(within(aside).getByText('→ D2')).toBeInTheDocument()
  expect(within(aside).getByText('尚未帶回')).toBeInTheDocument()
})

test('核准規格；進行中停用按鈕，連點只送一次', async () => {
  const release = holdNextCall(vi.mocked(call))
  renderSpec(specTask())
  const approve = screen.getByRole('button', { name: '核准並開始實作' })
  await userEvent.dblClick(approve)
  expect(call).toHaveBeenCalledTimes(1)
  expect(call).toHaveBeenCalledWith('spec:approve', 't1')
  expect(approve).toBeDisabled()
  expect(screen.getByRole('button', { name: '要求修改' })).toBeDisabled()
  await release()
  expect(approve).toBeEnabled()
})

test('要求修改：沒有內容時停用；送出後清空，Enter 也能送出', async () => {
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  const button = screen.getByRole('button', { name: '要求修改' })
  expect(button).toBeDisabled()
  await userEvent.type(input, '   ')
  expect(button).toBeDisabled()
  await userEvent.clear(input)
  await userEvent.type(input, '上限改成 10 次')
  await userEvent.click(button)
  expect(call).toHaveBeenCalledWith('spec:requestChanges', 't1', '上限改成 10 次')
  expect(input).toHaveValue('')
  await userEvent.type(input, '鎖定改 30 分鐘{Enter}')
  expect(call).toHaveBeenLastCalledWith('spec:requestChanges', 't1', '鎖定改 30 分鐘')
})

test('要求修改：輸入法選字中的 Enter 不送出', async () => {
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改成十次')
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
  expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
  expect(call).not.toHaveBeenCalledWith('spec:requestChanges', 't1', '上限改成十次')
  expect(input).toHaveValue('上限改成十次')
})

test('要求修改失敗時保留內容並顯示錯誤', async () => {
  vi.mocked(call).mockRejectedValueOnce(new Error('任務正在收尾，請稍候'))
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改成 10 次{Enter}')
  expect(input).toHaveValue('上限改成 10 次')
  expect(useStore.getState().toast?.text).toContain('任務正在收尾')
})

test('Claude 還在執行時不能核准或要求修改，並說明原因', async () => {
  renderSpec(specTask({ runState: 'running' }))
  await userEvent.type(screen.getByRole('textbox', { name: '修改意見' }), '改')
  expect(screen.getByRole('button', { name: '要求修改' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Claude 正在處理')
})

test('可切換版本；看舊版本時不能核准；Claude 提出新版時回到最新版', async () => {
  const task = specTask({ specs: [spec(1, { title: '第一版' }), spec(2, { title: '第二版' })] })
  const { rerender } = renderSpec(task)
  expect(screen.getByRole('heading', { name: '第二版' })).toBeInTheDocument()
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '規格版本' }), 'v1')
  expect(screen.getByRole('heading', { name: '第一版' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeDisabled()
  expect(screen.getByText(/正在看 v1（舊版本）/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '回到 v2' }))
  expect(screen.getByRole('heading', { name: '第二版' })).toBeInTheDocument()

  await userEvent.selectOptions(screen.getByRole('combobox', { name: '規格版本' }), 'v1')
  rerender(
    <SpecScreen
      task={{ ...task, specs: [...task.specs, spec(3, { title: '第三版' })] }}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
      onOpenQuestion={() => {}}
    />
  )
  expect(screen.getByRole('heading', { name: '第三版' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeEnabled()
})

test('唯讀（已核准後回看）時沒有核准列，標示為已核准的規格', () => {
  renderSpec(specTask({ status: 'implementing' }), true)
  expect(screen.queryByRole('button', { name: '核准並開始實作' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '修改意見' })).not.toBeInTheDocument()
  expect(screen.getByText(/已核准的規格/)).toBeInTheDocument()
})

test('點決策的「問題 N」或釐清紀錄裡的問題：跳到釐清對話裡的那個問題', async () => {
  const onOpenQuestion = vi.fn()
  renderSpec(specTask(), false, onOpenQuestion)
  await userEvent.click(screen.getByRole('button', { name: '問題 1（查看釐清對話）' }))
  expect(onOpenQuestion).toHaveBeenLastCalledWith('q1')
  onOpenQuestion.mockClear()
  const aside = screen.getByRole('complementary', { name: '釐清紀錄' })
  await userEvent.click(within(aside).getByRole('button', { name: /問題 1 · 計數單位/ }))
  expect(onOpenQuestion).toHaveBeenLastCalledWith('q1')
})

test('TaskScreen：從規格點「問題 1」→ 切到釐清畫面，捲到那個問題並短暫標示', async () => {
  useStore.setState({
    tasks: { t1: specTask() },
    timelines: {
      t1: [
        { id: 'e1', ts: '', channel: 'main', kind: 'user_text', text: '加上登入失敗鎖定' },
        { id: 'e2', ts: '', channel: 'main', kind: 'question', ref: 'q1' },
        { id: 'e3', ts: '', channel: 'main', kind: 'question', ref: 'q2' }
      ]
    }
  })
  render(<TaskScreen taskId="t1" />)
  await userEvent.click(screen.getByRole('button', { name: '問題 1（查看釐清對話）' }))
  const nav = screen.getByRole('navigation', { name: '任務階段' })
  expect(within(nav).getByRole('button', { name: /釐清/ })).toHaveAttribute('aria-pressed', 'true')
  const row = document.querySelector<HTMLElement>('[data-question="q1"]')!
  expect(row).toHaveTextContent('共用 IP 也分開算')
  expect(row).toHaveAttribute('data-flash')
  expect(row).toHaveFocus()
  expect(document.querySelector('[data-question="q2"]')).not.toHaveAttribute('data-flash')
})

test('從釐清紀錄回到釐清對話', async () => {
  const onOpenStage = vi.fn()
  render(
    <SpecScreen
      task={specTask()}
      nav={null}
      readOnly={false}
      onOpenStage={onOpenStage}
      onOpenQuestion={vi.fn()}
    />
  )
  await userEvent.click(screen.getByRole('button', { name: '查看釐清對話' }))
  expect(onOpenStage).toHaveBeenCalledWith('clarify')
})

test('TaskScreen：規格待核准時顯示規格畫面', () => {
  useStore.setState({ tasks: { t1: specTask() } })
  render(<TaskScreen taskId="t1" />)
  expect(
    screen.getByRole('heading', { name: '以帳號 + IP 計數的登入失敗鎖定' })
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeInTheDocument()
})

test('TaskScreen：已丟棄的任務停在規格時唯讀', () => {
  useStore.setState({ tasks: { t1: specTask({ status: 'discarded' }) } })
  render(<TaskScreen taskId="t1" />)
  expect(
    screen.getByRole('heading', { name: '以帳號 + IP 計數的登入失敗鎖定' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '核准並開始實作' })).not.toBeInTheDocument()
  expect(screen.getByText(/規格草稿/)).toBeInTheDocument()
})

test('回看規格時有等待中的核准請求也會顯示', () => {
  renderSpec(
    specTask({
      status: 'implementing',
      runState: 'waiting_permission',
      pendingPermission: {
        id: 'p1',
        taskId: 't1',
        channel: 'main',
        toolName: 'Bash',
        input: { command: 'npm test' },
        suggestedPattern: 'npm test *',
        createdAt: ''
      }
    }),
    true
  )
  expect(screen.getByRole('dialog', { name: 'Claude 想執行這個指令' })).toBeInTheDocument()
})

test('還沒有規格時也顯示核准對話框', () => {
  renderSpec(
    specTask({
      specs: [],
      runState: 'waiting_permission',
      pendingPermission: {
        id: 'p1',
        taskId: 't1',
        channel: 'main',
        toolName: 'WebSearch',
        input: { query: 'redis ttl' },
        createdAt: ''
      }
    })
  )
  expect(screen.getByText('還沒有規格。')).toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Claude 想搜尋網路' })).toBeInTheDocument()
})

test('看舊版本時不顯示根據幾個問題整理（那是目前的釐清紀錄）', async () => {
  renderSpec(specTask({ specs: [spec(1, { title: '第一版' }), spec(2, { title: '第二版' })] }))
  expect(screen.getByText(/規格草稿/)).toHaveTextContent('根據 1 個問題、1 個分岔整理')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '規格版本' }), 'v1')
  expect(screen.getByText(/規格草稿/)).not.toHaveTextContent('根據')
})

test('修改意見還沒送出就按核准：先提醒，確認放棄才核准', async () => {
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改 10 次')
  await userEvent.click(screen.getByRole('button', { name: '核准並開始實作' }))
  expect(call).not.toHaveBeenCalled()
  expect(screen.getByText(/修改意見還沒送出/)).toBeInTheDocument()
  // 改了內容就重新確認
  await userEvent.type(input, '，鎖 30 分鐘')
  expect(screen.queryByText(/修改意見還沒送出/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '核准並開始實作' }))
  await userEvent.click(screen.getByRole('button', { name: '放棄意見並核准' }))
  expect(call).toHaveBeenCalledWith('spec:approve', 't1')
})

test('送出修改意見期間又改了內容就保留', async () => {
  const release = holdNextCall(vi.mocked(call))
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改 10 次{Enter}')
  expect(call).toHaveBeenCalledWith('spec:requestChanges', 't1', '上限改 10 次')
  await userEvent.type(input, '，還有鎖 30 分鐘')
  await release()
  expect(input).toHaveValue('上限改 10 次，還有鎖 30 分鐘')
})
