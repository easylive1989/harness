// tests/renderer/ImplementScreen.test.tsx
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { implementEvents } from '@renderer/lib/timeline'
import { ImplementScreen } from '@renderer/screens/ImplementScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import { IMPLEMENT_START_REF, msgDisplay } from '@shared/protocol'
import type { DiffStats, PermissionRequest, Question, Task, TimelineEvent } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

let seq = 0
const ev = (over: Partial<TimelineEvent>): TimelineEvent => ({
  id: `e${++seq}`,
  ts: '',
  channel: 'main',
  kind: 'system',
  ...over
})
const tool = (name: string, input: Record<string, unknown>, id = `t${++seq}`) =>
  ev({ kind: 'tool_call', tool: { id, name, input } })

const stats: DiffStats = {
  files: 2,
  additions: 101,
  deletions: 12,
  perFile: [
    { path: 'src/auth/lockout.ts', additions: 68, deletions: 3 },
    { path: 'src/auth/login.ts', additions: 33, deletions: 9 }
  ]
}

const events: TimelineEvent[] = [
  ev({ kind: 'user_text', text: '加上登入失敗鎖定' }),
  ev({ kind: 'assistant_text', text: '釐清階段的回覆' }),
  ev({ kind: 'user_text', text: msgDisplay.specApproved, ref: IMPLEMENT_START_REF }),
  tool('Read', { file_path: 'src/http/errors.ts' }),
  ev({ kind: 'assistant_text', text: '開始實作' }),
  ev({ kind: 'user_text', text: '錯誤訊息放進 i18n' }),
  ev({ channel: 'branch:b1', kind: 'assistant_text', text: '分岔裡的訊息' }),
  tool('Bash', { command: 'npm test -- auth' }, 'bash1'),
  ev({ kind: 'tool_result', text: 'exit 1', tool: { id: 'bash1', name: '', isError: true } }),
  tool('Edit', { file_path: '/tmp/wt/t1/src/auth/login.ts' })
]

const implTask = (over: Partial<Task> = {}) =>
  makeTask({
    status: 'implementing',
    runState: 'running',
    plan: [
      { id: 's1', title: '新增 lockout 模組', status: 'done' },
      { id: 's2', title: '統一錯誤回應為 `429`', status: 'running' },
      { id: 's3', title: '通知信模板', status: 'pending' }
    ],
    ...over
  })

const renderImpl = (task: Task, readOnly = false) =>
  render(<ImplementScreen task={task} nav={null} readOnly={readOnly} />)
const callsOf = (channel: string) => vi.mocked(call).mock.calls.filter((c) => c[0] === channel)

beforeEach(() => {
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (channel: string) =>
    channel === 'tasks:changedFiles' ? stats : undefined) as never)
  resetStoreInternals()
  useStore.setState({ timelines: { t1: events }, toast: undefined, activeBranch: {} })
})

describe('implementEvents', () => {
  test('取最後一個實作起點（核准規格或送出報告回饋）之後的主線事件', () => {
    const list = implementEvents(events)
    expect(list[0].kind).toBe('tool_call')
    expect(list.some((e) => e.text === '釐清階段的回覆')).toBe(false)
    expect(list.some((e) => e.channel !== 'main')).toBe(false)
    const again = [
      ...events,
      ev({ kind: 'user_text', text: '送出整體意見', ref: IMPLEMENT_START_REF }),
      // 使用者打出一樣的字（有 ref 的新時間軸不看文字）
      ev({ kind: 'assistant_text', text: '第二輪' }),
      ev({ kind: 'user_text', text: msgDisplay.specApproved }),
      ev({ kind: 'assistant_text', text: '第二輪' })
    ]
    expect(implementEvents(again).map((e) => e.text)).toEqual([
      '第二輪',
      msgDisplay.specApproved,
      '第二輪'
    ])
  })

  test('舊時間軸（整份都沒有標記）用顯示文字找起點', () => {
    const legacy = [
      ev({ kind: 'user_text', text: '加上登入失敗鎖定' }),
      ev({ kind: 'user_text', text: msgDisplay.specApproved }),
      ev({ kind: 'assistant_text', text: '開始實作' })
    ]
    expect(implementEvents(legacy).map((e) => e.text)).toEqual(['開始實作'])
  })

  test('還沒有開始實作的訊息時是空的', () => {
    expect(implementEvents(events.slice(0, 2))).toEqual([])
  })
})

test('顯示進度、步驟、進行中步驟的工具與這一段的對話', async () => {
  renderImpl(implTask())
  expect(screen.getByRole('progressbar', { name: '進度' })).toHaveAttribute('aria-valuenow', '1')
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getByText('429').tagName).toBe('CODE')
  expect(within(step).getByText('進行中')).toBeInTheDocument()
  const rows = within(step).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual([
    '讀取src/http/errors.ts',
    '指令npm test -- auth失敗',
    '編輯src/auth/login.ts'
  ])
  expect(screen.getByText('新增 lockout 模組')).toBeInTheDocument()
  expect(screen.getByText('通知信模板')).toBeInTheDocument()
  expect(screen.getByText('開始實作')).toBeInTheDocument()
  expect(screen.getByText('錯誤訊息放進 i18n')).toBeInTheDocument()
  expect(screen.getByText('你插話')).toBeInTheDocument()
  expect(screen.queryByText('釐清階段的回覆')).not.toBeInTheDocument()
  expect(screen.queryByText('加上登入失敗鎖定')).not.toBeInTheDocument()
  expect(screen.queryByText('分岔裡的訊息')).not.toBeInTheDocument()
  expect(screen.queryByText(msgDisplay.specApproved)).not.toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('還沒有步驟時，最近的動作仍然看得到', async () => {
  renderImpl(implTask({ plan: [] }))
  expect(screen.getByText('0 / ?')).toBeInTheDocument()
  const recent = screen.getByRole('region', { name: '最近的動作' })
  expect(within(recent).getByText('src/http/errors.ts')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('等待核准：步驟與對應的指令標示等待核准，並顯示核准對話框', async () => {
  renderImpl(
    implTask({
      runState: 'waiting_permission',
      pendingPermission: {
        id: 'p1',
        taskId: 't1',
        channel: 'main',
        toolName: 'Bash',
        input: { command: 'npm test -- auth' },
        suggestedPattern: 'npm test *',
        createdAt: ''
      }
    })
  )
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getAllByText('等待核准')).toHaveLength(2)
  expect(within(step).getAllByRole('listitem')[1]).toHaveTextContent('等待核准')
  const dialog = screen.getByRole('dialog', { name: 'Claude 想執行這個指令' })
  expect(within(dialog).getByText('cwd: /tmp/wt/t1')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('插話送到主線；停止中斷執行，連點只送一次', async () => {
  renderImpl(implTask())
  await userEvent.type(screen.getByRole('textbox', { name: '插話' }), '順便改錯誤訊息{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'main', '順便改錯誤訊息')
  const release = holdNextCall(vi.mocked(call))
  const stop = screen.getByRole('button', { name: '停止' })
  await userEvent.dblClick(stop)
  expect(callsOf('run:stop')).toEqual([['run:stop', 't1', 'main']])
  expect(stop).toBeDisabled()
  await release()
})

test('沒有在執行時不顯示停止；整理報告中不能插話', async () => {
  const { rerender } = renderImpl(implTask({ runState: 'idle' }))
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  rerender(
    <ImplementScreen task={implTask({ runState: 'finalizing' })} nav={null} readOnly={false} />
  )
  expect(screen.getByRole('textbox', { name: '插話' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  expect(screen.getByText('正在整理 diff 並執行驗證指令…')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('Claude 在實作中提問時顯示問題卡片', async () => {
  useStore.setState({
    timelines: { t1: [...events, ev({ kind: 'question', ref: 'q9' })] }
  })
  renderImpl(
    implTask({
      runState: 'idle',
      questions: [
        {
          id: 'q9',
          text: '通知信要用哪個模板？',
          options: [{ id: 'a', label: '沿用密碼重設的模板' }],
          allowFreeText: true,
          status: 'open',
          followups: [],
          askedAt: ''
        }
      ]
    })
  )
  expect(screen.getByRole('radiogroup', { name: '通知信要用哪個模板？' })).toBeInTheDocument()
  expect(
    within(screen.getByRole('region', { name: '進行中的步驟' })).getByText('等你回答')
  ).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('變更檔案：列出每個檔案；執行結束時再讀一次', async () => {
  const { rerender } = renderImpl(implTask())
  const aside = screen.getByRole('complementary', { name: '變更檔案' })
  expect(await within(aside).findByText('src/auth/lockout.ts')).toBeInTheDocument()
  expect(within(aside).getByText('+101')).toBeInTheDocument()
  expect(within(aside).getByText('−12')).toBeInTheDocument()
  expect(callsOf('tasks:changedFiles')).toEqual([['tasks:changedFiles', 't1']])
  rerender(<ImplementScreen task={implTask({ runState: 'idle' })} nav={null} readOnly={false} />)
  await vi.waitFor(() => expect(callsOf('tasks:changedFiles')).toHaveLength(2))
})

test('讀不到變更時顯示說明', async () => {
  vi.mocked(call).mockImplementation((async (channel: string) => {
    if (channel === 'tasks:changedFiles') throw new Error('worktree 不存在')
  }) as never)
  renderImpl(implTask({ runState: 'idle' }))
  expect(await screen.findByText('無法讀取變更')).toBeInTheDocument()
})

test('已允許的指令與 worktree；在 Finder 開啟', async () => {
  renderImpl(implTask({ runState: 'idle', allowedCommands: ['npm test *', 'git diff *'] }))
  const aside = screen.getByRole('complementary', { name: '變更檔案' })
  expect(within(aside).getByText('npm test *')).toBeInTheDocument()
  expect(within(aside).getByText('git diff *')).toBeInTheDocument()
  expect(within(aside).getByText('/tmp/wt/t1')).toBeInTheDocument()
  await userEvent.click(within(aside).getByRole('button', { name: '在 Finder 開啟' }))
  expect(call).toHaveBeenCalledWith('shell:showInFolder', '/tmp/wt/t1')
})

test('唯讀時沒有輸入框與停止按鈕', async () => {
  renderImpl(implTask(), true)
  expect(screen.queryByRole('textbox', { name: '插話' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('TaskScreen：實作中顯示實作畫面', async () => {
  useStore.setState({ tasks: { t1: implTask() } })
  render(<TaskScreen taskId="t1" />)
  expect(screen.getByRole('region', { name: '進行中的步驟' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '插話' })).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

const perm = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'p1',
  taskId: 't1',
  channel: 'main',
  toolName: 'Bash',
  input: { command: 'npm test' },
  suggestedPattern: 'npm test *',
  createdAt: '',
  ...over
})
const openQuestion = (id: string, text: string): Question => ({
  id,
  text,
  options: [{ id: 'a', label: '帳號的 email' }],
  allowFreeText: true,
  status: 'open',
  followups: [],
  askedAt: ''
})
const start = ev({ kind: 'user_text', text: msgDisplay.specApproved, ref: IMPLEMENT_START_REF })

test('等待核准的工具以 toolUseId 對應；使用者拒絕過的標「已拒絕」、規則擋下的標「已阻擋」', async () => {
  useStore.setState({
    timelines: {
      t1: [
        start,
        tool('Bash', { command: 'npm test' }, 'tu-a'),
        tool('Bash', { command: 'rm -rf dist' }, 'tu-d'),
        ev({
          kind: 'tool_result',
          text: '先不要刪',
          tool: { id: 'tu-d', name: '', isError: true, denied: true }
        }),
        tool('Bash', { command: 'npm test' }, 'tu-b'),
        tool('Read', { file_path: '/etc/hosts' }, 'tu-x'),
        ev({
          kind: 'tool_result',
          text: '只能讀取 worktree 內的檔案',
          tool: { id: 'tu-x', name: '', isError: true, blocked: true }
        })
      ]
    }
  })
  renderImpl(
    implTask({ runState: 'waiting_permission', pendingPermission: perm({ toolUseId: 'tu-a' }) })
  )
  const rows = within(screen.getByRole('region', { name: '進行中的步驟' })).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual([
    '指令npm test等待核准',
    '指令rm -rf dist已拒絕',
    '指令npm test',
    // Harness 規則擋下的：中性的「已阻擋」，原因在 title
    '讀取/etc/hosts已阻擋'
  ])
  const blocked = within(rows[3]).getByText('已阻擋')
  expect(blocked).toHaveClass('text-muted')
  expect(blocked).toHaveAttribute('title', '只能讀取 worktree 內的檔案')
  await screen.findByText('src/auth/lockout.ts')
})

test('子代理的工具呼叫列在步驟的工具列表裡，標「子代理」', async () => {
  useStore.setState({
    timelines: {
      t1: [
        start,
        tool('Agent', { prompt: '找出登入相關的檔案' }),
        ev({
          kind: 'tool_call',
          tool: {
            id: 'sub1',
            name: 'Read',
            input: { file_path: '/tmp/wt/t1/src/auth/login.ts' },
            subagent: true
          }
        })
      ]
    }
  })
  renderImpl(implTask())
  const rows = within(screen.getByRole('region', { name: '進行中的步驟' })).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual(['子代理', '讀取子代理src/auth/login.ts'])
  expect(within(rows[1]).getByText('子代理')).toHaveClass('text-muted')
  await screen.findByText('src/auth/lockout.ts')
})

test('等待核准的工具不在最近 8 個裡時仍然列出來（最近 7 個＋它）', async () => {
  const many = Array.from({ length: 9 }, (_, i) => tool('Read', { file_path: `src/f${i}.ts` }))
  useStore.setState({
    timelines: { t1: [start, tool('Bash', { command: 'npm test' }, 'tu-old'), ...many] }
  })
  renderImpl(
    implTask({ runState: 'waiting_permission', pendingPermission: perm({ toolUseId: 'tu-old' }) })
  )
  const rows = within(screen.getByRole('region', { name: '進行中的步驟' })).getAllByRole('listitem')
  expect(rows).toHaveLength(8)
  expect(rows[0]).toHaveTextContent('src/f2.ts')
  expect(rows.at(-1)).toHaveTextContent('指令npm test等待核准')
  await screen.findByText('src/auth/lockout.ts')
})

test('沒有在這段實作裡出現過的開放問題，顯示在最上方', async () => {
  useStore.setState({ timelines: { t1: [ev({ kind: 'question', ref: 'q7' }), ...events] } })
  renderImpl(implTask({ runState: 'idle', questions: [openQuestion('q7', '通知信寄給誰？')] }))
  const card = screen.getByRole('radiogroup', { name: '通知信寄給誰？' })
  expect(
    card.compareDocumentPosition(screen.getByText('新增 lockout 模組')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getByText('等你回答')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('沒有開放中的問題時步驟顯示暫停中', async () => {
  renderImpl(implTask({ runState: 'idle' }))
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getByText('暫停中')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('重新提問的問題只顯示一張卡片', async () => {
  useStore.setState({
    timelines: {
      t1: [
        ...events,
        ev({ kind: 'question', ref: 'q9' }),
        ev({ kind: 'assistant_text', text: '再確認一次' }),
        ev({ kind: 'question', ref: 'q9' })
      ]
    }
  })
  renderImpl(implTask({ runState: 'idle', questions: [openQuestion('q9', '模板用哪個？')] }))
  expect(screen.getAllByRole('radiogroup', { name: '模板用哪個？' })).toHaveLength(1)
  await screen.findByText('src/auth/lockout.ts')
})

test('有等待中的核准請求時遮罩後面不能操作；處理完焦點回到插話框', async () => {
  const { rerender } = renderImpl(
    implTask({ runState: 'waiting_permission', pendingPermission: perm() })
  )
  const input = screen.getByRole('textbox', { name: '插話' })
  expect(input.closest('[inert]')).not.toBeNull()
  expect(screen.getByRole('region', { name: '進行中的步驟' }).closest('[inert]')).not.toBeNull()
  expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<ImplementScreen task={implTask()} nav={null} readOnly={false} />)
  expect(input.closest('[inert]')).toBeNull()
  expect(input).toHaveFocus()
  await screen.findByText('src/auth/lockout.ts')
})

describe('變更檔案的輪詢', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

  test('執行中每 5 秒重新讀取；停下來時讀最後一次，之後不再輪詢', async () => {
    const { rerender } = renderImpl(implTask())
    await tick(0)
    expect(callsOf('tasks:changedFiles')).toHaveLength(1)
    await tick(5000)
    expect(callsOf('tasks:changedFiles')).toHaveLength(2)
    await tick(5000)
    expect(callsOf('tasks:changedFiles')).toHaveLength(3)
    rerender(<ImplementScreen task={implTask({ runState: 'idle' })} nav={null} readOnly={false} />)
    await tick(0)
    expect(callsOf('tasks:changedFiles')).toHaveLength(4)
    await tick(20000)
    expect(callsOf('tasks:changedFiles')).toHaveLength(4)
  })
})
