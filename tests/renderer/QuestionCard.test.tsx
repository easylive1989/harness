// tests/renderer/QuestionCard.test.tsx
import { render, screen } from '@testing-library/react'
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

  test('Claude 更新卡片後原本選的選項不見了，就回到建議選項', () => {
    const { rerender } = render(<QuestionCard task={task} question={q} />)
    const updated: Question = {
      ...q,
      options: [{ id: 'captcha', label: '改要求驗證碼' }, ...q.options.slice(0, 1)],
      recommendedOptionId: 'captcha'
    }
    rerender(<QuestionCard task={makeTask({ questions: [updated] })} question={updated} />)
    expect(screen.getByRole('radio', { name: /改要求驗證碼/ })).toBeChecked()
  })

  test('顯示反問紀錄並可再次反問', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.getByText('你反問了 1 次')).toBeInTheDocument()
    expect(screen.getByText('一律回 429 就不會。')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '反問' }), '那 IP 呢？{Enter}')
    expect(call).toHaveBeenCalledWith('tasks:counter', 't1', 'q3', '那 IP 呢？')
    expect(screen.getByRole('textbox', { name: '反問' })).toHaveValue('')
  })

  test('反問送出後等待回答時顯示處理中', () => {
    const waiting: Question = {
      ...q,
      followups: [...q.followups, { role: 'user', text: '那 IP 呢？' }]
    }
    render(<QuestionCard task={{ ...task, runState: 'running' }} question={waiting} />)
    expect(screen.getByText('Claude 正在回答…')).toBeInTheDocument()
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
