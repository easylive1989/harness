// src/renderer/src/components/BranchPanel.tsx
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { Branch, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { parseBranchSeed, stripMarkdown } from '../lib/branchDraft'
import { userTextDisplay } from '../lib/timeline'
import { blockImeSubmit, isComposing } from '../lib/ime'
import { isBusy } from '../lib/stage'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import { Button, cx, inputClass, LiveStatus } from './ui'

function statusText(b: Branch) {
  if (b.status === 'concluded') return '已帶回'
  if (b.running) return '討論中'
  if (b.status === 'concluding') return '待確認'
  return '進行中'
}

/** 分岔的輸入框：打字的狀態留在這裡，不會讓整個面板（訊息列表）跟著重繪 */
function BranchInput({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || disabled) return
    setText('')
    onSend(t)
  }
  return (
    <form onSubmit={submit} className="flex">
      <label className="flex flex-1">
        <span className="sr-only">分岔訊息</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={blockImeSubmit}
          disabled={disabled}
          placeholder="繼續在分岔裡討論…"
          className={cx(inputClass, 'flex-1')}
        />
      </label>
    </form>
  )
}

/** 正在從 Claude 的訊息開新分岔（ClarifyScreen 管理）：送出問題前不會建立任何東西 */
export interface BranchDraft {
  /** 引用的 Claude 訊息（原文） */
  excerpt: string
  /** 正在建立分岔 */
  pending: boolean
  onSubmit: (question: string) => void
  /** 放棄草稿；refocus（預設）時焦點回到按下的分岔按鈕 */
  onCancel: (refocus?: boolean) => void
}

/** 引用的訊息：最多 3 行，長的可以展開 */
function Quote({ text, toggle = true }: { text: string; toggle?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const quote = stripMarkdown(text)
  // jsdom 量不到行數：以字數與換行估計會不會超過 3 行（面板寬約 22 個中文字）
  const long = toggle && (quote.length > 60 || quote.split('\n').length > 3)
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-fill-2 py-2.5 pr-3.5 pl-3 shadow-[inset_3px_0_0_var(--color-line-strong)]">
      <blockquote className={cx('m-0 whitespace-pre-wrap text-ink-2', !expanded && 'line-clamp-3')}>
        {quote}
      </blockquote>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="cursor-pointer self-start text-xs text-brand hover:text-brand-hover"
        >
          {expanded ? '收合' : '展開全文'}
        </button>
      )}
    </div>
  )
}

/** 從訊息開分岔：先問使用者想針對這段討論什麼 */
function NewBranchForm({ draft, blocked }: { draft: BranchDraft; blocked: boolean }) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // 按下訊息旁的分岔按鈕（或換了引用的訊息）後，焦點移到問題輸入框
  useEffect(() => {
    inputRef.current?.focus()
  }, [draft.excerpt])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = text.trim()
    if (!q || blocked || draft.pending) return
    draft.onSubmit(q)
  }
  // 表單裡任何地方（輸入框、展開全文）按 Esc 都取消；選字中的 Esc 是取消組字，不是取消開分岔。
  // 建立中不能取消：分岔已經在建立，取消也擋不住
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape' && !isComposing(e) && !draft.pending) draft.onCancel()
  }
  return (
    <form
      aria-label="新分岔"
      onSubmit={submit}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 px-5 pt-1 pb-5 text-[13px]"
    >
      <span className="text-xs font-medium text-brand">新分岔 · 引用的訊息</span>
      <Quote text={draft.excerpt} />
      <label className="flex flex-col gap-1.5">
        <span className="font-medium">想針對這段討論什麼？</span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={blockImeSubmit}
          placeholder="例如：為什麼建議 429 而不是 423？"
          className={inputClass}
        />
      </label>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={draft.pending} onClick={() => draft.onCancel()}>
          取消
        </Button>
        <Button
          type="submit"
          variant="dark"
          className="flex-1"
          disabled={blocked || draft.pending || !text.trim()}
        >
          開始討論
        </Button>
      </div>
      {blocked && <span className="text-xs text-muted">主線正在執行，等它停下來才能開分岔。</span>}
    </form>
  )
}

function BranchMessage({ e }: { e: TimelineEvent }) {
  switch (e.kind) {
    case 'user_text': {
      const text = e.text ?? ''
      // 從訊息開的分岔：開場分成引用與使用者的問題
      const seed = parseBranchSeed(text)
      return (
        <div className="flex max-w-[88%] flex-col gap-2 self-end rounded-[16px_16px_6px_16px] bg-fill px-3.5 py-2.5 whitespace-pre-wrap">
          {seed ? (
            <>
              <Quote text={seed.excerpt} />
              <span>{seed.question}</span>
            </>
          ) : (
            userTextDisplay(text)
          )}
        </div>
      )
    }
    case 'assistant_text':
      return <Markdown text={e.text ?? ''} />
    case 'tool_result':
      return (
        <div className="line-clamp-4 text-xs break-all whitespace-pre-wrap text-danger">
          工具錯誤：{e.text}
        </div>
      )
    case 'system':
      return <div className="self-center text-xs text-muted">{e.text}</div>
    default:
      return null
  }
}

export function BranchPanel({
  task,
  events,
  readOnly,
  draft
}: {
  task: Task
  events: TimelineEvent[]
  readOnly?: boolean
  /** 正在從訊息開新分岔：面板改顯示問題輸入框 */
  draft?: BranchDraft
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const picked = useStore((s) => s.activeBranch[task.id])
  // 帶回主線／重新整理／確認：IPC 進行中停用按鈕，避免連點送出兩次
  const [acting, runAction] = usePending()
  // 使用者選的分岔不存在（例如開分岔失敗被撤回）時，改顯示還沒帶回的分岔或最後一個
  const b =
    task.branches.find((x) => x.id === picked) ??
    task.branches.find((x) => x.status !== 'concluded') ??
    task.branches.at(-1)
  const branchId = b?.id
  const drafting = !readOnly && draft
  const list = branchId ? events.filter((e) => e.channel === `branch:${branchId}`) : []
  const replied = list.some((e) => e.kind === 'assistant_text')
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(
    `${list.length}:${task.updatedAt}`,
    // 新分岔的輸入框取代了訊息列表；收起後列表重新畫出，要再捲到底
    drafting ? 'draft' : branchId,
    list.length
  )
  const fromIndex = b?.fromQuestionId
    ? task.questions.findIndex((q) => q.id === b.fromQuestionId) + 1
    : 0

  const send = (text: string) => {
    if (!b) return
    stick()
    void act(() => call('tasks:send', task.id, `branch:${b.id}`, text))
  }
  const conclude = (id: string) =>
    void runAction(() => act(() => call('branch:conclude', task.id, id)))
  const confirm = (id: string) =>
    void runAction(() => act(() => call('branch:confirm', task.id, id, undefined)))

  return (
    <aside
      aria-label="分岔討論"
      className="flex w-[340px] flex-none flex-col rounded-2xl bg-surface shadow-card"
    >
      <div className="flex flex-col gap-2.5 px-5 pt-[18px] pb-3">
        <span className="text-[15px] font-bold">分岔討論</span>
        {task.branches.length === 0 ? (
          !drafting && (
            <span className="text-[13px] text-muted">
              還沒有分岔。在 Claude
              的訊息旁或問題卡片上按「分岔」，就能另開一段討論，結論再帶回主線。
            </span>
          )
        ) : (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {task.branches.map((x) => (
              <button
                key={x.id}
                type="button"
                aria-pressed={!drafting && x.id === b?.id}
                // 建立分岔後焦點移到這裡（ClarifyScreen）
                data-branch-chip={x.id}
                onClick={() => {
                  // 改看既有的分岔：放棄還沒送出的新分岔（焦點留在這裡）
                  if (drafting) draft.onCancel(false)
                  setActiveBranch(task.id, x.id)
                }}
                className={cx(
                  'cursor-pointer rounded-full px-2.5 py-1',
                  !drafting && x.id === b?.id
                    ? 'bg-brand-soft font-medium text-brand-ink'
                    : 'bg-fill text-muted'
                )}
              >
                {x.title} · {statusText(x)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* key：換一則引用的訊息就重新開始，不帶著前一則的問題 */}
      {drafting && <NewBranchForm key={draft.excerpt} draft={draft} blocked={isBusy(task)} />}
      {!drafting && b && (
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-2 text-[13px]"
          >
            {fromIndex > 0 && (
              <span className="text-xs text-muted-2">
                從問題 {fromIndex} 分出，帶著主線的上下文
              </span>
            )}
            {list.map((e) => (
              <BranchMessage key={e.id} e={e} />
            ))}
            <LiveStatus text={b.running && 'Claude 正在回覆…'} />
            {b.error && (
              <div role="alert" className="rounded-xl bg-danger-soft px-3.5 py-3 text-danger">
                {b.error}
              </div>
            )}
            {b.conclusion && (
              <div className="flex flex-col gap-1 rounded-[14px] bg-decision px-3.5 py-3">
                <span className="text-xs font-medium text-decision-ink">
                  {b.status === 'concluded' ? '已帶回主線的結論' : '帶回主線的結論（預覽）'}
                </span>
                <span>{b.conclusion.decision}</span>
                {b.conclusion.rationale && (
                  <span className="text-decision-body">原因：{b.conclusion.rationale}</span>
                )}
                {b.conclusion.deferred.length > 0 && (
                  <span className="text-decision-body">
                    延後：{b.conclusion.deferred.join('；')}
                  </span>
                )}
              </div>
            )}
          </div>

          {!readOnly && b.status !== 'concluded' && (
            <div className="flex flex-col gap-2.5 px-5 pt-3.5 pb-5">
              <BranchInput disabled={b.running} onSend={send} />
              {b.status === 'concluding' ? (
                // 看過預覽後可能又討論了幾句：可以請 Claude 重新整理結論
                <div className="flex gap-2">
                  <Button disabled={b.running || acting} onClick={() => conclude(b.id)}>
                    重新整理結論
                  </Button>
                  <Button
                    variant="dark"
                    className="flex-1"
                    disabled={b.running || acting}
                    onClick={() => confirm(b.id)}
                  >
                    確認並帶回主線
                  </Button>
                </div>
              ) : (
                <Button
                  variant="dark"
                  disabled={b.running || acting || !replied}
                  onClick={() => conclude(b.id)}
                >
                  帶回主線
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  )
}
