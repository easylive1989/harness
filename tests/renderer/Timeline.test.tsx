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
import { sampleReport } from '../fixtures/report'
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

  test('缺必要屬性的協定訊息照原文顯示', () => {
    expect(userTextDisplay('[answer] Redis')).toBe('[answer] Redis')
    expect(userTextDisplay('[counter_question] 會洩漏嗎？')).toBe('[counter_question] 會洩漏嗎？')
    expect(userTextDisplay('[branch_conclusion] 決策：x')).toBe('[branch_conclusion] 決策：x')
  })

  test('任何文字裡的分岔規則都不顯示', () => {
    expect(userTextDisplay(`${BRANCH_RULES}\n\n請比較 Redis 與 DB`)).toBe('請比較 Redis 與 DB')
    expect(userTextDisplay(`[todo] ${BRANCH_RULES}`)).not.toContain('Harness 規則')
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

  test('worktree 內的絕對路徑顯示成相對路徑', () => {
    const read = { id: 'x', name: 'Read', input: { file_path: '/wt/t1/src/a.ts' } }
    expect(toolSummary(read, '/wt/t1')).toBe('讀取 src/a.ts')
    expect(toolSummary(read, '/other')).toBe('讀取 /wt/t1/src/a.ts')
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
    const tools = screen.getByRole('button', { name: '讀取 2 次 · 搜尋內容 1 次' })
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

  test('子代理的工具呼叫：摘要與明細都標「子代理」', async () => {
    const sub = (id: string, name: string, input: Record<string, unknown>) =>
      ev({ kind: 'tool_call', tool: { id, name, input, subagent: true } })
    render(
      <Timeline
        task={makeTask()}
        channel="main"
        events={[
          ev({ kind: 'tool_call', tool: { id: 'a1', name: 'Agent', input: { prompt: '找檔案' } } }),
          sub('s1', 'Read', { file_path: '/tmp/wt/t1/src/a.ts' }),
          sub('s2', 'Read', { file_path: '/tmp/wt/t1/src/b.ts' }),
          sub('s3', 'Grep', { pattern: 'lockout' })
        ]}
      />
    )
    await userEvent.click(
      screen.getByRole('button', { name: '子代理 1 次 · 子代理讀取 2 次 · 子代理搜尋內容 1 次' })
    )
    expect(screen.getByText('讀取 src/a.ts').parentElement).toHaveTextContent('子代理讀取 src/a.ts')
    expect(screen.getByText('搜尋內容 lockout').parentElement).toHaveTextContent('子代理')
    // 主線自己呼叫的子代理（Agent 工具）是一般的一行，不加標籤
    const labels = screen.getAllByText('子代理')
    expect(labels.map((l) => l.tagName)).toEqual(['CODE', 'SPAN', 'SPAN', 'SPAN'])
  })

  test('工具錯誤、系統訊息、報告與非分岔決策', async () => {
    const onOpenStage = vi.fn()
    const t = makeTask({
      decisions: [
        { id: 'd2', text: '沿用既有錯誤碼', source: { type: 'implementation', ref: 's1' } }
      ]
    })
    render(
      <Timeline
        task={t}
        channel="main"
        onOpenStage={onOpenStage}
        events={[
          ev({ kind: 'tool_result', text: 'ENOENT: no such file' }),
          ev({ kind: 'system', text: '已切換到 Sonnet 5.5' }),
          ev({ kind: 'decision', ref: 'd2' }),
          ev({ kind: 'report', ref: '2' })
        ]}
      />
    )
    expect(screen.getByText('工具錯誤：ENOENT: no such file')).toBeInTheDocument()
    expect(screen.getByText('已切換到 Sonnet 5.5')).toBeInTheDocument()
    expect(screen.getByText('決策')).toBeInTheDocument()
    expect(screen.getByText('沿用既有錯誤碼')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /變更報告 v2/ }))
    expect(onOpenStage).toHaveBeenCalledWith('report')
  })

  test('工具列表的路徑相對於 worktree；使用者拒絕的工具顯示已拒絕', async () => {
    render(
      <Timeline
        task={makeTask()}
        channel="main"
        events={[
          ev({
            kind: 'tool_call',
            tool: { id: 'r1', name: 'Read', input: { file_path: '/tmp/wt/t1/src/a.ts' } }
          }),
          ev({
            kind: 'tool_result',
            text: '先不要讀網頁',
            tool: { id: 'w1', name: '', isError: true, denied: true }
          })
        ]}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: '讀取 1 次' }))
    expect(screen.getByText('讀取 src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('已拒絕：先不要讀網頁')).toBeInTheDocument()
    expect(screen.queryByText(/工具錯誤/)).not.toBeInTheDocument()
  })

  test('Harness 規則擋下的工具顯示「已阻擋：原因」（中性的顏色），真的失敗才是紅色的工具錯誤', () => {
    render(
      <Timeline
        task={makeTask()}
        channel="main"
        events={[
          ev({
            kind: 'tool_result',
            text: '目前不是實作階段，不能修改檔案。',
            tool: { id: 'e1', name: '', isError: true, blocked: true }
          }),
          ev({ kind: 'tool_result', text: 'exit 1', tool: { id: 'b1', name: '', isError: true } })
        ]}
      />
    )
    const blocked = screen.getByText('已阻擋：目前不是實作階段，不能修改檔案。')
    expect(blocked).toHaveClass('text-muted')
    expect(blocked).not.toHaveClass('text-danger')
    expect(screen.getByText('工具錯誤：exit 1')).toHaveClass('text-danger')
  })

  test('重新提問的問題只在最後一次出現的位置顯示卡片', () => {
    const open = { ...q, status: 'open' as const, answer: undefined }
    render(
      <Timeline
        task={{ ...task, questions: [open] }}
        channel="main"
        events={[
          ev({ kind: 'question', ref: 'q1' }),
          ev({ kind: 'assistant_text', text: '我想再確認一次' }),
          ev({ kind: 'question', ref: 'q1' })
        ]}
      />
    )
    expect(screen.getAllByRole('button', { name: '確認答案' })).toHaveLength(1)
    const card = screen.getByRole('radiogroup').closest('section')!
    expect(
      screen.getByText('我想再確認一次').compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('卡片移到最新的位置時，還沒送出的反問與選擇都留著', async () => {
    const open = { ...q, status: 'open' as const, answer: undefined, allowFreeText: true }
    const first = [ev({ id: 'x1', kind: 'question', ref: 'q1' })]
    const { rerender } = render(
      <Timeline task={{ ...task, questions: [open] }} channel="main" events={first} />
    )
    await userEvent.type(screen.getByRole('textbox', { name: '反問' }), '共用 IP 呢？')
    await userEvent.click(screen.getByRole('radio', { name: /其他/ }))
    rerender(
      <Timeline
        task={{ ...task, questions: [open] }}
        channel="main"
        events={[
          ...first,
          ev({ id: 'x2', kind: 'assistant_text', text: '採用分岔的結論，重新送出第一題。' }),
          ev({ id: 'x3', kind: 'question', ref: 'q1' })
        ]}
      />
    )
    expect(screen.getByRole('textbox', { name: '反問' })).toHaveValue('共用 IP 呢？')
    expect(screen.getByRole('radio', { name: /其他/ })).toBeChecked()
    const card = screen.getByRole('radiogroup').closest('section')!
    expect(
      screen.getByText('採用分岔的結論，重新送出第一題。').compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
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
    const button = screen.getByRole('button', { name: '從這則訊息分岔' })
    await userEvent.click(button)
    // 連同按下的按鈕：取消開分岔後焦點回到它
    expect(onBranchFrom).toHaveBeenCalledWith('有幾件事要先確認。', button)
  })

  test('正在開分岔時停用分岔按鈕', () => {
    render(
      <Timeline
        task={task}
        channel="main"
        events={[ev({ kind: 'assistant_text', text: '有幾件事要先確認。' })]}
        onBranchFrom={() => {}}
        branchPending
      />
    )
    expect(screen.getByRole('button', { name: '從這則訊息分岔' })).toBeDisabled()
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

  test('報告已提交、整理中斷或失敗：說明「繼續」會直接重新整理，不會再呼叫 Claude', async () => {
    const onResume = vi.fn()
    const pendingReport = { input: sampleReport }
    const { rerender } = render(
      <RunStatus task={makeTask({ runState: 'interrupted', pendingReport })} onResume={onResume} />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      '報告還沒整理完就中斷了。 按「繼續」會直接重新整理報告，不會再呼叫 Claude。'
    )
    rerender(
      <RunStatus
        task={makeTask({ runState: 'error', error: '整理報告失敗：commit 逾時', pendingReport })}
        onResume={onResume}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      '整理報告失敗：commit 逾時 按「繼續」會直接重新整理報告，不會再呼叫 Claude。'
    )
    await userEvent.click(screen.getByRole('button', { name: '繼續' }))
    expect(onResume).toHaveBeenCalled()
  })

  test('執行中在常駐的 live region 顯示處理中；quiet 時不顯示', () => {
    const { rerender } = render(<RunStatus task={makeTask()} onResume={() => {}} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('')
    rerender(<RunStatus task={makeTask({ runState: 'running' })} onResume={() => {}} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Claude 正在處理…')
    rerender(<RunStatus task={makeTask({ runState: 'running' })} onResume={() => {}} quiet />)
    expect(status).toHaveTextContent('')
  })

  test('只反映主線的錯誤，分岔的錯誤不出現在這裡', () => {
    const branchFailed = makeTask({
      branches: [
        { id: 'b1', title: 'x', status: 'open', running: false, createdAt: '', error: '分岔失敗' }
      ]
    })
    const { rerender } = render(<RunStatus task={branchFailed} onResume={() => {}} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    rerender(<RunStatus task={{ ...branchFailed, error: '主線失敗' }} onResume={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('主線失敗')
    expect(screen.queryByRole('button', { name: '繼續' })).not.toBeInTheDocument()
  })
})
