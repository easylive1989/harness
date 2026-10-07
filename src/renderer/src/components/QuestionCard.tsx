// src/renderer/src/components/QuestionCard.tsx
import { type FormEvent, useId, useRef, useState } from 'react'
import type { Question, Task } from '@shared/types'
import { call } from '../api'
import { awaitingCounterReply, isBusy } from '../lib/stage'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { Button, cx, Icons, inputClass, LiveStatus, textareaClass } from './ui'

const OTHER = '__other'

const optionClass = (on: boolean) =>
  cx(
    'flex cursor-pointer gap-2.5 rounded-[14px] p-3.5 has-[:disabled]:cursor-default',
    on ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2'
  )

export function QuestionCard({
  task,
  question: q,
  readOnly
}: {
  task: Task
  question: Question
  readOnly?: boolean
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const titleId = useId()
  // 使用者點選的選項；Claude 更新卡片後選項可能不見了，此時回到預設（render 時推導）
  const [picked, setPicked] = useState<string>()
  // 選「其他」時的答案，與選一般選項時的補充說明分開保存
  const [otherText, setOtherText] = useState('')
  const [note, setNote] = useState('')
  // 補充說明預設收起（設計稿沒有這一欄），按「＋ 補充說明」才展開；已有內容就保持展開
  const [noteOpen, setNoteOpen] = useState(false)
  const focusNote = useRef(false)
  const [counter, setCounter] = useState('')
  const [answering, runAnswer] = usePending()
  const [upgrading, runUpgrade] = usePending()

  const ids = q.options.map((o) => o.id)
  const valid = (id?: string): id is string =>
    !!id && (ids.includes(id) || (id === OTHER && q.allowFreeText))
  const fallback = valid(q.recommendedOptionId)
    ? q.recommendedOptionId
    : (ids[0] ?? (q.allowFreeText ? OTHER : undefined))
  const selected = valid(picked) ? picked : fallback

  const busy = isBusy(task)
  const disabled = readOnly || busy || q.status !== 'open'
  const waitingCounter = awaitingCounterReply(task, q)
  const counted = q.followups.filter((f) => f.role === 'user').length
  const index = task.questions.findIndex((x) => x.id === q.id) + 1
  // 已經從這個問題分出去的分岔：按鈕改成切過去看，不再開新的
  const existing = task.branches.find((b) => b.fromQuestionId === q.id)
  const canConfirm = !!selected && (selected !== OTHER || !!otherText.trim())

  const confirm = () =>
    runAnswer(() =>
      act(() =>
        call(
          'tasks:answer',
          task.id,
          q.id,
          selected === OTHER
            ? { optionId: undefined, text: otherText.trim() }
            : // Claude 改成不允許自由文字後，之前打的補充說明不送出
              { optionId: selected, text: (q.allowFreeText && note.trim()) || undefined }
        )
      )
    )
  const ask = (e: FormEvent) => {
    e.preventDefault()
    const text = counter.trim()
    if (!text || busy) return
    setCounter('')
    void act(() => call('tasks:counter', task.id, q.id, text))
  }
  const upgrade = () =>
    runUpgrade(async () => {
      const b = await act(() =>
        call('branch:open', task.id, { title: q.text.slice(0, 30), fromQuestionId: q.id })
      )
      if (b) setActiveBranch(task.id, b.id)
    })

  return (
    <section
      aria-labelledby={titleId}
      className="ml-10 flex flex-col gap-3.5 rounded-[18px] bg-surface p-5 shadow-focus"
    >
      <div className="flex flex-col gap-0.5">
        {index > 0 && <span className="text-xs font-medium text-brand">問題 {index}</span>}
        <span id={titleId} className="text-[17px] font-bold">
          {q.text}
        </span>
        {q.context && <span className="text-[13px] text-muted">{q.context}</span>}
      </div>

      <div role="radiogroup" aria-labelledby={titleId} className="grid grid-cols-2 gap-2.5">
        {q.options.map((o) => {
          const recommended = o.id === q.recommendedOptionId
          return (
            <label key={o.id} className={optionClass(selected === o.id)}>
              <input
                type="radio"
                name={`q-${q.id}`}
                checked={selected === o.id}
                onChange={() => setPicked(o.id)}
                disabled={disabled}
                className="mt-[5px] flex-none accent-brand"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{o.label}</span>
                {(o.description || recommended) && (
                  <span className={cx('text-xs', recommended ? 'text-brand-muted' : 'text-muted')}>
                    {recommended && <span className="font-medium">建議</span>}
                    {recommended && o.description && ' · '}
                    {o.description}
                  </span>
                )}
              </span>
            </label>
          )
        })}
        {q.allowFreeText && (
          <label className={optionClass(selected === OTHER)}>
            <input
              type="radio"
              name={`q-${q.id}`}
              checked={selected === OTHER}
              onChange={() => setPicked(OTHER)}
              disabled={disabled}
              className="mt-[5px] flex-none accent-brand"
            />
            <span className="text-muted">其他，自己描述…</span>
          </label>
        )}
      </div>

      {q.allowFreeText && selected === OTHER && (
        <label className="flex flex-col">
          <span className="sr-only">自己描述</span>
          <textarea
            rows={2}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            disabled={disabled}
            placeholder="描述你的答案"
            className={textareaClass}
          />
        </label>
      )}
      {q.allowFreeText &&
        selected !== undefined &&
        selected !== OTHER &&
        !readOnly &&
        (noteOpen || note ? (
          <label className="flex flex-col">
            <span className="sr-only">補充說明</span>
            <textarea
              // 剛按下「＋ 補充說明」時把焦點移進來（按鈕已經消失）
              ref={(el) => {
                if (el && focusNote.current) {
                  focusNote.current = false
                  el.focus()
                }
              }}
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={disabled}
              placeholder="補充說明（選填）"
              className={cx(textareaClass, 'resize-y')}
            />
          </label>
        ) : (
          <button
            type="button"
            aria-expanded={false}
            disabled={disabled}
            onClick={() => {
              focusNote.current = true
              setNoteOpen(true)
            }}
            className="cursor-pointer self-start text-xs text-muted hover:text-brand disabled:cursor-default disabled:opacity-50"
          >
            ＋ 補充說明
          </button>
        ))}

      {q.followups.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-[14px] bg-fill-2 px-3.5 py-3 text-[13px]">
          <span className="text-xs font-medium text-muted">你反問了 {counted} 次</span>
          {q.followups.map((f, i) => (
            <div key={i} className="flex gap-2">
              {f.role === 'user' ? (
                <span className="flex-none text-muted">你</span>
              ) : (
                <span className="flex-none font-medium text-brand">
                  <span aria-hidden>C</span>
                  <span className="sr-only">Claude</span>
                </span>
              )}
              <span className="min-w-0 whitespace-pre-wrap">{f.text}</span>
            </div>
          ))}
          <LiveStatus text={waitingCounter && 'Claude 正在回答…'} />
        </div>
      )}

      {!readOnly && q.status === 'open' && (
        <form onSubmit={ask} className="flex flex-wrap items-center gap-2.5">
          <label className="flex min-w-[220px] flex-1">
            <span className="sr-only">反問</span>
            <input
              value={counter}
              onChange={(e) => setCounter(e.target.value)}
              disabled={busy}
              placeholder="還有疑問？在這裡反問…"
              className={cx(inputClass, 'flex-1')}
            />
          </label>
          {existing ? (
            <Button
              className="h-[42px] px-3.5"
              onClick={() => setActiveBranch(task.id, existing.id)}
            >
              查看分岔
            </Button>
          ) : (
            <Button
              className="h-[42px] px-3.5"
              disabled={busy || upgrading}
              onClick={() => void upgrade()}
            >
              升級成分岔
            </Button>
          )}
          <Button
            variant="primary"
            className="h-[42px] px-5"
            disabled={disabled || answering || !canConfirm}
            onClick={() => void confirm()}
          >
            確認答案
          </Button>
        </form>
      )}
    </section>
  )
}

/** 已回答的問題：時間軸上收成一列 */
export function AnsweredQuestionRow({ question: q }: { question: Question }) {
  const label = q.answer?.optionId
    ? q.options.find((o) => o.id === q.answer?.optionId)?.label
    : undefined
  return (
    <div className="ml-10 flex items-center gap-2.5 rounded-xl bg-fill-2 px-4 py-2.5 text-[13px]">
      <Icons.Check className="flex-none text-brand" strokeWidth={2.5} aria-hidden />
      <span className="text-muted">{q.text}</span>
      <span className="ml-auto text-right font-medium">
        {[label, q.answer?.text].filter(Boolean).join('；')}
      </span>
    </div>
  )
}
