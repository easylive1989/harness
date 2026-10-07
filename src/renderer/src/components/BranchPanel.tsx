// src/renderer/src/components/BranchPanel.tsx
import { type FormEvent, useState } from 'react'
import type { Branch, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { userTextDisplay } from '../lib/timeline'
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
          disabled={disabled}
          placeholder="繼續在分岔裡討論…"
          className={cx(inputClass, 'flex-1')}
        />
      </label>
    </form>
  )
}

function BranchMessage({ e }: { e: TimelineEvent }) {
  switch (e.kind) {
    case 'user_text':
      return (
        <div className="max-w-[88%] self-end rounded-[16px_16px_6px_16px] bg-fill px-3.5 py-2.5 whitespace-pre-wrap">
          {userTextDisplay(e.text ?? '')}
        </div>
      )
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
  readOnly
}: {
  task: Task
  events: TimelineEvent[]
  readOnly?: boolean
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
  const list = branchId ? events.filter((e) => e.channel === `branch:${branchId}`) : []
  const replied = list.some((e) => e.kind === 'assistant_text')
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${list.length}:${task.updatedAt}`, branchId)
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
