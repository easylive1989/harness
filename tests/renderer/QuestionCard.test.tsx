// tests/renderer/QuestionCard.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => ({ id: 'b1' })),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { AnsweredQuestionRow, QuestionCard } from '@renderer/components/QuestionCard'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Question } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const q: Question = {
  id: 'q3',
  text: '達到上限後要怎麼處理？',
  status: 'open',
  allowFreeText: true,
  askedAt: '',
  options: [
    { id: 'lock15', label: '鎖定 15 分鐘', description: '自動解除' },
    { id: 'email', label: 'email 重設才解鎖' }
  ],
  recommendedOptionId: 'lock15',
  followups: [
    { role: 'user', text: '會洩漏帳號嗎？' },
    { role: 'assistant', text: '一律回 429 就不會。' }
  ]
}
const task = makeTask({ questions: [q] })

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({ activeBranch: {}, toast: undefined })
})

describe('QuestionCard', () => {
  test('預設選建議選項，確認後送出答案', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.getByRole('radiogroup', { name: '達到上限後要怎麼處理？' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /鎖定 15 分鐘/ })).toBeChecked()
    expect(screen.getByText('建議')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /email/ }))
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: 'email',
      text: undefined
    })
  })

  test('選「其他」時送出自由文字', async () => {
    render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('radio', { name: /其他/ }))
    expect(screen.getByRole('button', { name: '確認答案' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: '自己描述' }), '鎖 30 分鐘')
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: undefined,
      text: '鎖 30 分鐘'
    })
  })

  test('選了的選項被 Claude 更新卡片時拿掉，就回到建議選項', async () => {
    const { rerender } = render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('radio', { name: /email/ }))
    expect(screen.getByRole('radio', { name: /email/ })).toBeChecked()
    const updated: Question = {
      ...q,
      options: [{ id: 'captcha', label: '改要求驗證碼' }, q.options[0]],
      recommendedOptionId: 'captcha'
    }
    rerender(<QuestionCard task={makeTask({ questions: [updated] })} question={updated} />)
    expect(screen.getByRole('radio', { name: /改要求驗證碼/ })).toBeChecked()
    expect(screen.queryByRole('radio', { name: /email/ })).not.toBeInTheDocument()
  })

  test('補充說明預設收起，按「＋ 補充說明」展開並移入焦點', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.queryByRole('textbox', { name: '補充說明' })).not.toBeInTheDocument()
    const reveal = screen.getByRole('button', { name: '＋ 補充說明' })
    expect(reveal).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(reveal)
    expect(screen.getByRole('textbox', { name: '補充說明' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: '＋ 補充說明' })).not.toBeInTheDocument()
  })

  test('選一般選項時可附補充說明，與「其他」的描述分開；有內容就保持展開', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.queryByRole('textbox', { name: '自己描述' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '＋ 補充說明' }))
    await userEvent.type(screen.getByRole('textbox', { name: '補充說明' }), '要寫稽核日誌')
    await userEvent.click(screen.getByRole('radio', { name: /其他/ }))
    expect(screen.queryByRole('textbox', { name: '補充說明' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '＋ 補充說明' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '自己描述' })).toHaveValue('')
    await userEvent.click(screen.getByRole('radio', { name: /鎖定 15 分鐘/ }))
    expect(screen.getByRole('textbox', { name: '補充說明' })).toHaveValue('要寫稽核日誌')
    expect(screen.getByRole('textbox', { name: '補充說明' })).not.toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: 'lock15',
      text: '要寫稽核日誌'
    })
  })

  test('Claude 改成不允許自由文字後，不送出之前打的補充說明', async () => {
    const { rerender } = render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('button', { name: '＋ 補充說明' }))
    await userEvent.type(screen.getByRole('textbox', { name: '補充說明' }), '要寫稽核日誌')
    const strict: Question = { ...q, allowFreeText: false }
    rerender(<QuestionCard task={makeTask({ questions: [strict] })} question={strict} />)
    expect(screen.queryByRole('textbox', { name: '補充說明' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '＋ 補充說明' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /其他/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: 'lock15',
      text: undefined
    })
  })

  test('確認答案送出中停用，連點只送一次', async () => {
    const release = holdNextCall(vi.mocked(call))
    render(<QuestionCard task={task} question={q} />)
    const confirm = screen.getByRole('button', { name: '確認答案' })
    await userEvent.dblClick(confirm)
    expect(call).toHaveBeenCalledTimes(1)
    expect(confirm).toBeDisabled()
    await release()
    expect(confirm).toBeEnabled()
  })

  test('顯示反問紀錄並可再次反問', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.getByText('你反問了 1 次')).toBeInTheDocument()
    expect(screen.getByText('一律回 429 就不會。')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '反問' }), '那 IP 呢？{Enter}')
    expect(call).toHaveBeenCalledWith('tasks:counter', 't1', 'q3', '那 IP 呢？')
    expect(screen.getByRole('textbox', { name: '反問' })).toHaveValue('')
  })

  test('反問：輸入法選字中的 Enter 不送出', async () => {
    render(<QuestionCard task={task} question={q} />)
    const input = screen.getByRole('textbox', { name: '反問' })
    await userEvent.type(input, '那 IP 呢')
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
    expect(call).not.toHaveBeenCalledWith('tasks:counter', 't1', 'q3', '那 IP 呢')
    expect(input).toHaveValue('那 IP 呢')
  })

  test('反問送出後等待回答時，在常駐的 live region 顯示處理中', () => {
    const waiting: Question = {
      ...q,
      followups: [...q.followups, { role: 'user', text: '那 IP 呢？' }]
    }
    const { rerender } = render(<QuestionCard task={task} question={waiting} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('')
    rerender(<QuestionCard task={{ ...task, runState: 'running' }} question={waiting} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Claude 正在回答…')
    expect(screen.getByRole('textbox', { name: '反問' })).toBeDisabled()
  })

  test('升級成分岔並切到新分岔', async () => {
    render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('button', { name: '升級成分岔' }))
    expect(call).toHaveBeenCalledWith('branch:open', 't1', {
      title: '達到上限後要怎麼處理？',
      fromQuestionId: 'q3'
    })
    expect(useStore.getState().activeBranch.t1).toBe('b1')
  })

  test('升級成分岔進行中停用，連點只開一個', async () => {
    const release = holdNextCall(vi.mocked(call))
    render(<QuestionCard task={task} question={q} />)
    const upgrade = screen.getByRole('button', { name: '升級成分岔' })
    await userEvent.dblClick(upgrade)
    expect(call).toHaveBeenCalledTimes(1)
    expect(upgrade).toBeDisabled()
    await release({ id: 'b9' })
    expect(useStore.getState().activeBranch.t1).toBe('b9')
    expect(upgrade).toBeEnabled()
  })

  test('已經從這個問題分出分岔時，改成查看分岔', async () => {
    const withBranch = makeTask({
      questions: [q],
      branches: [
        {
          id: 'b4',
          title: '上限處理',
          fromQuestionId: 'q3',
          status: 'open',
          running: false,
          createdAt: ''
        }
      ]
    })
    render(<QuestionCard task={withBranch} question={q} />)
    expect(screen.queryByRole('button', { name: '升級成分岔' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '查看分岔' }))
    expect(useStore.getState().activeBranch.t1).toBe('b4')
    expect(call).not.toHaveBeenCalled()
  })

  test('Claude 執行中時停用操作', () => {
    render(<QuestionCard task={{ ...task, runState: 'running' }} question={q} />)
    expect(screen.getByRole('button', { name: '確認答案' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '升級成分岔' })).toBeDisabled()
  })

  test('唯讀時不能作答也沒有反問欄', () => {
    render(<QuestionCard task={task} question={q} readOnly />)
    expect(screen.getByRole('radio', { name: /鎖定 15 分鐘/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '確認答案' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '反問' })).not.toBeInTheDocument()
  })
})

describe('AnsweredQuestionRow', () => {
  test('只有自由文字的答案', () => {
    render(
      <AnsweredQuestionRow
        question={{ ...q, status: 'answered', answer: { text: '鎖 30 分鐘' } }}
      />
    )
    expect(screen.getByText('鎖 30 分鐘')).toBeInTheDocument()
  })

  test('顯示問題與答案（選項加補充）', () => {
    render(
      <AnsweredQuestionRow
        question={{ ...q, status: 'answered', answer: { optionId: 'lock15', text: '但要記錄' } }}
      />
    )
    expect(screen.getByText('達到上限後要怎麼處理？')).toBeInTheDocument()
    expect(screen.getByText('鎖定 15 分鐘；但要記錄')).toBeInTheDocument()
  })
})
