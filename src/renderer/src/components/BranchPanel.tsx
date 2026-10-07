// src/renderer/src/components/BranchPanel.tsx
import { type FormEvent, useState } from 'react'
import type { Branch, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { userTextDisplay } from '../lib/timeline'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import { Button, cx, inputClass, Spinner } from './ui'

function statusText(b: Branch) {
  if (b.status === 'concluded') return '已帶回'
  if (b.running) return '討論中'
  if (b.status === 'concluding') return '待確認'
  return '進行中'
}

export function BranchPanel({
  task,
  events,
  readOnly
}: {
  task: Task
  events: TimelineEvent[]
  readOnly?: boolean
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const picked = useStore((s) => s.activeBranch[task.id])
  const [text, setText] = useState('')
  // 使用者選的分岔不存在（例如開分岔失敗被撤回）時，改顯示還沒帶回的分岔或最後一個
  const b =
    task.branches.find((x) => x.id === picked) ??
    task.branches.find((x) => x.status !== 'concluded') ??
    task.branches.at(-1)
  const list = b ? events.filter((e) => e.channel === `branch:${b.id}`) : []
  const replied = list.some((e) => e.kind === 'assistant_text')
  const { ref: scrollRef, onScroll } = useStickToBottom<HTMLDivElement>(
    `${b?.id}:${list.length}:${task.updatedAt}`
  )
  const fromIndex = b?.fromQuestionId
    ? task.questions.findIndex((q) => q.id === b.fromQuestionId) + 1
    : 0

  const send = (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!b || !t || b.running) return
    setText('')
    void act(() => call('tasks:send', task.id, `branch:${b.id}`, t))
  }

  return (
    <aside
      aria-label="分岔討論"
      className="flex w-[340px] flex-none flex-col rounded-2xl bg-surface shadow-card"
    >
      <div className="flex flex-col gap-2.5 px-5 pt-[18px] pb-3">
        <span className="text-[15px] font-bold">分岔討論</span>
        {task.branches.length === 0 ? (
          <span className="text-[13px] text-muted">
            還沒有分岔。在 Claude 的訊息旁或問題卡片上按「分岔」，就能另開一段討論，結論再帶回主線。
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {task.branches.map((x) => (
              <button
                key={x.id}
                type="button"
                aria-pressed={x.id === b?.id}
                onClick={() => setActiveBranch(task.id, x.id)}
                className={cx(
                  'cursor-pointer rounded-full px-2.5 py-1',
                  x.id === b?.id ? 'bg-brand-soft font-medium text-brand-ink' : 'bg-fill text-muted'
                )}
              >
                {x.title} · {statusText(x)}
              </button>
            ))}
          </div>
        )}
      </div>

      {b && (
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
            {list.map((e) =>
              e.kind === 'user_text' ? (
                <div
                  key={e.id}
                  className="max-w-[88%] self-end rounded-[16px_16px_6px_16px] bg-fill px-3.5 py-2.5 whitespace-pre-wrap"
                >
                  {userTextDisplay(e.text ?? '')}
                </div>
              ) : e.kind === 'assistant_text' ? (
                <Markdown key={e.id} text={e.text ?? ''} />
              ) : e.kind === 'system' || e.kind === 'tool_result' ? (
                <div key={e.id} className="text-xs break-all text-muted">
                  {e.text}
                </div>
              ) : null
            )}
            {b.running && (
              <span className="flex items-center gap-2 text-muted">
                <Spinner />
                Claude 正在回覆…
              </span>
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
              <form onSubmit={send} className="flex">
                <label className="flex flex-1">
                  <span className="sr-only">分岔訊息</span>
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={b.running}
                    placeholder="繼續在分岔裡討論…"
                    className={cx(inputClass, 'flex-1')}
                  />
                </label>
              </form>
              {b.status === 'concluding' ? (
                // 看過預覽後可能又討論了幾句：可以請 Claude 重新整理結論
                <div className="flex gap-2">
                  <Button
                    disabled={b.running}
                    onClick={() => void act(() => call('branch:conclude', task.id, b.id))}
                  >
                    重新整理結論
                  </Button>
                  <Button
                    variant="dark"
                    className="flex-1"
                    disabled={b.running}
                    onClick={() => void act(() => call('branch:confirm', task.id, b.id, undefined))}
                  >
                    確認並帶回主線
                  </Button>
                </div>
              ) : (
                <Button
                  variant="dark"
                  disabled={b.running || !replied}
                  onClick={() => void act(() => call('branch:conclude', task.id, b.id))}
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
