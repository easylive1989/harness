// tests/renderer/Timeline.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { RunStatus, Timeline } from '@renderer/components/Timeline'
import { toolSummary, userTextDisplay } from '@renderer/lib/timeline'
import { resetStoreInternals, useStore } from '@renderer/store'
import { BRANCH_RULES, msg } from '@shared/protocol'
import type { TimelineEvent } from '@shared/types'
import { makeTask } from '../fixtures/task'

let seq = 0
const ev = (over: Partial<TimelineEvent>): TimelineEvent => ({
  id: `e${++seq}`,
  ts: '',
  channel: 'main',
  kind: 'system',
  ...over
})

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({ activeBranch: {}, toast: undefined })
})

describe('userTextDisplay', () => {
  test('一般文字原樣顯示', () => {
    expect(userTextDisplay('加上登入失敗鎖定')).toBe('加上登入失敗鎖定')
  })

  test('協定訊息轉成可讀文字，不露出分岔規則', () => {
    const open = userTextDisplay(msg.branchOpen('計數存放位置', '來源問題：存哪裡？'))
    expect(open).toBe('開始討論：計數存放位置')
    expect(open).not.toContain(BRANCH_RULES.split('\n')[0])
    expect(userTextDisplay(msg.answer('q1', 'redis', 'Redis'))).toBe('回答：Redis')
    expect(userTextDisplay(msg.counterQuestion('q1', '會洩漏嗎？'))).toBe('反問：會洩漏嗎？')
    expect(userTextDisplay(msg.conclude())).toBe('請 Claude 整理這個分岔的結論')
    expect(userTextDisplay(msg.resume())).toBe('繼續執行')
    expect(userTextDisplay(msg.specApproved())).toBe('核准規格，開始實作')
    expect(
      userTextDisplay(
        msg.branchConclusion('b1', { decision: '用 Redis', rationale: '共享', deferred: [] })
      )
    ).toBe('帶回分岔結論\n決策：用 Redis\n原因：共享')
  })

  test('不認得的標籤照原文顯示', () => {
    expect(userTextDisplay('[todo] 記得寫測試')).toBe('[todo] 記得寫測試')
  })
})

describe('toolSummary', () => {
  test('工具名稱與目標', () => {
    expect(toolSummary({ id: 'x', name: 'Read', input: { file_path: 'src/a.ts' } })).toBe(
      '讀取 src/a.ts'
    )
    expect(toolSummary({ id: 'x', name: 'mcp__foo' })).toBe('mcp__foo')
  })
})

describe('Timeline', () => {
  const q = {
    id: 'q1',
    text: '計數要以什麼為單位？',
    status: 'answered' as const,
    allowFreeText: false,
    askedAt: '',
    options: [{ id: 'combo', label: '帳號 + IP 組合' }],
    answer: { optionId: 'combo' },
    followups: []
  }
  const task = makeTask({
    questions: [q],
    branches: [
      { id: 'b1', title: '計數存放位置', status: 'concluded', running: false, createdAt: '' }
    ],
    decisions: [
      {
        id: 'd1',
        text: '使用既有 Redis',
        rationale: '多台機器要共享狀態',
        source: { type: 'branch', ref: 'b1' }
      }
    ]
  })

  test('依 channel 篩選並呈現各種事件', async () => {
    const events = [
      ev({ kind: 'user_text', text: '登入 API 要加上失敗次數限制' }),
      ev({
        kind: 'tool_call',
        tool: { id: 't1', name: 'Read', input: { file_path: 'src/auth/login.ts' } }
      }),
      ev({ kind: 'tool_call', tool: { id: 't2', name: 'Read', input: { file_path: 'src/x.ts' } } }),
      ev({ kind: 'tool_call', tool: { id: 't3', name: 'Grep', input: { pattern: 'rateLimit' } } }),
      ev({ kind: 'assistant_text', text: '我看過 `login.ts` 了。' }),
      ev({ kind: 'question', ref: 'q1' }),
      ev({ kind: 'decision', ref: 'd1' }),
      ev({ kind: 'spec', ref: '1' }),
      ev({ channel: 'branch:b1', kind: 'assistant_text', text: '分岔裡的回覆' })
    ]
    const onOpenStage = vi.fn()
    render(<Timeline task={task} channel="main" events={events} onOpenStage={onOpenStage} />)
    expect(screen.getByText('登入 API 要加上失敗次數限制')).toBeInTheDocument()
    expect(screen.queryByText('分岔裡的回覆')).not.toBeInTheDocument()
    const tools = screen.getByRole('button', { name: /讀取 2 次 · 搜尋內容 1 次/ })
    expect(tools).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(tools)
    expect(screen.getByText('讀取 src/auth/login.ts')).toBeInTheDocument()
    expect(screen.getByText('計數要以什麼為單位？')).toBeInTheDocument()
    expect(screen.getByText('帳號 + IP 組合')).toBeInTheDocument()
    expect(screen.getByText('分岔「計數存放位置」的結論')).toBeInTheDocument()
    expect(screen.getByText('原因：多台機器要共享狀態')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /規格草稿 v1/ }))
    expect(onOpenStage).toHaveBeenCalledWith('spec')
  })

  test('開放中的問題顯示成卡片', () => {
    const open = { ...q, status: 'open' as const, answer: undefined }
    render(
      <Timeline
        task={{ ...task, questions: [open] }}
        channel="main"
        events={[ev({ kind: 'question', ref: 'q1' })]}
      />
    )
    expect(screen.getByRole('button', { name: '確認答案' })).toBeInTheDocument()
  })

  test('從 Claude 的訊息分岔', async () => {
    const onBranchFrom = vi.fn()
    render(
      <Timeline
        task={task}
        channel="main"
        events={[ev({ kind: 'assistant_text', text: '有幾件事要先確認。' })]}
        onBranchFrom={onBranchFrom}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
    expect(onBranchFrom).toHaveBeenCalledWith('有幾件事要先確認。')
  })

  test('使用者訊息若是協定訊息，顯示可讀文字', () => {
    render(
      <Timeline
        task={task}
        channel="main"
        events={[ev({ kind: 'user_text', text: msg.branchOpen('通知', '') })]}
      />
    )
    expect(screen.getByText('開始討論：通知')).toBeInTheDocument()
    expect(screen.queryByText(/Harness 規則/)).not.toBeInTheDocument()
  })
})

describe('RunStatus', () => {
  test('中斷時可繼續', async () => {
    const onResume = vi.fn()
    render(<RunStatus task={makeTask({ runState: 'interrupted' })} onResume={onResume} />)
    expect(screen.getByRole('alert')).toHaveTextContent('上一次執行被中斷了。')
    await userEvent.click(screen.getByRole('button', { name: '繼續' }))
    expect(onResume).toHaveBeenCalled()
  })

  test('執行中顯示處理中', () => {
    render(<RunStatus task={makeTask({ runState: 'running' })} onResume={() => {}} />)
    expect(screen.getByText('Claude 正在處理…')).toBeInTheDocument()
  })
})
