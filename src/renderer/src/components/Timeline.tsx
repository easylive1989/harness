// src/renderer/src/components/Timeline.tsx
import { useMemo, useState } from 'react'
import type { Channel, Task, TimelineEvent } from '@shared/types'
import {
  latestQuestionEvents,
  SUBAGENT_LABEL,
  type ToolCall,
  toolLabel,
  toolResultLabel,
  toolSummary,
  userTextDisplay
} from '../lib/timeline'
import { MessageImages } from './Attachments'
import { Markdown } from './Markdown'
import { AnsweredQuestionRow, QuestionCard } from './QuestionCard'
import { Avatar, cx, Icons, LiveStatus } from './ui'

type ToolEvent = TimelineEvent & { tool: ToolCall }
type Item = { kind: 'event'; e: TimelineEvent } | { kind: 'tools'; events: ToolEvent[] }

/** 連續的工具呼叫合併成一組 */
function group(events: TimelineEvent[]): Item[] {
  const out: Item[] = []
  for (const e of events) {
    const last = out.at(-1)
    if (e.kind === 'tool_call' && e.tool) {
      const te = e as ToolEvent
      if (last?.kind === 'tools') last.events.push(te)
      else out.push({ kind: 'tools', events: [te] })
    } else out.push({ kind: 'event', e })
  }
  return out
}

function ToolGroup({ events, root }: { events: ToolEvent[]; root: string }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const e of events) {
    // 子代理裡的呼叫分開計數，例如「子代理讀取 2 次」
    const l = `${e.tool.subagent ? SUBAGENT_LABEL : ''}${toolLabel(e.tool.name)}`
    counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  return (
    <div className="ml-10 flex flex-col gap-1 text-xs text-muted-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="cursor-pointer self-start hover:text-ink"
      >
        {[...counts].map(([l, n]) => `${l} ${n} 次`).join(' · ')}{' '}
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open &&
        events.map((e) =>
          e.tool.subagent ? (
            <span key={e.id} className="flex items-baseline gap-1.5 self-start">
              <span className="flex-none rounded-full bg-fill px-1.5 text-[11px] text-muted">
                {SUBAGENT_LABEL}
              </span>
              <code className="break-all">{toolSummary(e.tool, root)}</code>
            </span>
          ) : (
            <code key={e.id} className="self-start break-all">
              {toolSummary(e.tool, root)}
            </code>
          )
        )}
    </div>
  )
}

function UserBubble({ taskId, e }: { taskId: string; e: TimelineEvent }) {
  const text = e.text ?? ''
  return (
    <div className="max-w-[78%] self-end rounded-[18px_18px_6px_18px] bg-fill px-4 py-3 whitespace-pre-wrap">
      {userTextDisplay(text)}
      <MessageImages taskId={taskId} images={e.images} className={text ? 'mt-2' : ''} />
    </div>
  )
}

export function Timeline({
  task,
  channel,
  events,
  readOnly,
  onBranchFrom,
  branchPending,
  onOpenStage
}: {
  task: Task
  channel: Channel
  events: TimelineEvent[]
  readOnly?: boolean
  /** 從 Claude 的訊息分岔：訊息原文與按下的按鈕（取消後焦點回到它） */
  onBranchFrom?: (text: string, trigger: HTMLElement) => void
  /** 正在開分岔：停用所有「從這則訊息分岔」按鈕，避免重複開 */
  branchPending?: boolean
  onOpenStage?: (stage: 'spec' | 'report') => void
}) {
  const { items, latest } = useMemo(() => {
    const list = events.filter((e) => e.channel === channel)
    return { items: group(list), latest: latestQuestionEvents(list) }
  }, [events, channel])
  return (
    <div className="flex flex-col gap-5">
      {items.map((it) => {
        if (it.kind === 'tools')
          return <ToolGroup key={it.events[0].id} events={it.events} root={task.worktreePath} />
        const e = it.e
        switch (e.kind) {
          case 'user_text':
            return <UserBubble key={e.id} taskId={task.id} e={e} />
          case 'assistant_text':
            return (
              <div key={e.id} className="group flex gap-3">
                <Avatar />
                <div className="min-w-0 flex-1">
                  <Markdown text={e.text ?? ''} />
                </div>
                {onBranchFrom && !readOnly && (
                  <button
                    type="button"
                    aria-label="從這則訊息分岔"
                    title="從這則訊息分岔"
                    disabled={branchPending}
                    onClick={(ev) => onBranchFrom(e.text ?? '', ev.currentTarget)}
                    className="flex h-7 flex-none cursor-pointer items-center rounded-lg px-2 text-muted opacity-0 group-hover:opacity-100 hover:bg-fill focus-visible:opacity-100 disabled:cursor-default disabled:opacity-40"
                  >
                    <Icons.Branch width={14} height={14} />
                  </button>
                )}
              </div>
            )
          case 'question': {
            const q = task.questions.find((x) => x.id === e.ref)
            // 重新提問過的問題只在最後一次出現的位置畫卡片。key 用問題 id：卡片移到最新的位置時
            // React 搬動同一個元件，還沒送出的選擇、補充說明與反問都留著
            if (!q || !latest.has(e.id)) return null
            return q.status === 'open' ? (
              <QuestionCard key={`question:${q.id}`} task={task} question={q} readOnly={readOnly} />
            ) : (
              <AnsweredQuestionRow key={`question:${q.id}`} question={q} />
            )
          }
          case 'decision': {
            const d = task.decisions.find((x) => x.id === e.ref)
            if (!d) return null
            const b =
              d.source.type === 'branch'
                ? task.branches.find((x) => x.id === d.source.ref)
                : undefined
            return (
              <div
                key={e.id}
                className="ml-10 flex flex-col gap-1.5 rounded-[14px] bg-decision px-4 py-3.5"
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-decision-ink">
                  <Icons.Branch width={14} height={14} />
                  {d.source.type === 'branch'
                    ? `分岔「${b?.title ?? d.source.ref}」的結論`
                    : '決策'}
                </span>
                <span>{d.text}</span>
                {d.rationale && (
                  <span className="text-[13px] text-decision-body">原因：{d.rationale}</span>
                )}
                {!!d.deferred?.length && (
                  <span className="text-[13px] text-decision-body">
                    延後：{d.deferred.join('；')}
                  </span>
                )}
              </div>
            )
          }
          case 'spec':
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpenStage?.('spec')}
                className="ml-10 cursor-pointer self-start rounded-xl bg-brand-tint px-4 py-2.5 text-[13px] text-brand-ink hover:bg-brand-soft"
              >
                規格草稿 v{e.ref} 已產生 → 查看
              </button>
            )
          case 'report':
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpenStage?.('report')}
                className="ml-10 cursor-pointer self-start rounded-xl bg-review-soft px-4 py-2.5 text-[13px] text-review"
              >
                變更報告 v{e.ref} 已產生 → 查看
              </button>
            )
          case 'tool_result': {
            const { label, muted } = toolResultLabel(e.tool)
            return (
              <div
                key={e.id}
                className={cx(
                  'ml-10 line-clamp-4 text-xs break-all whitespace-pre-wrap',
                  muted ? 'text-muted' : 'text-danger'
                )}
              >
                {label}：{e.text}
              </div>
            )
          }
          case 'system':
            return (
              <div
                key={e.id}
                className="self-center rounded-full bg-fill px-3 py-1 text-xs text-muted"
              >
                {e.text}
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}

/**
 * 主線的執行狀態：常駐的 live region 顯示處理中，錯誤另外用 alert。
 * 只看主線（task.runState / task.error）；分岔的錯誤記在 Branch.error，由分岔面板顯示。
 * quiet：問題卡片已經在顯示「Claude 正在回答…」時不再重複顯示處理中。
 */
export function RunStatus({
  task,
  onResume,
  quiet
}: {
  task: Task
  onResume: () => void
  quiet?: boolean
}) {
  const progress =
    task.runState === 'running'
      ? 'Claude 正在處理…'
      : task.runState === 'finalizing'
        ? '正在整理 diff 並執行驗證指令…'
        : undefined
  const failed = task.runState === 'interrupted' || task.runState === 'error' || !!task.error
  const canResume = task.runState === 'interrupted' || task.runState === 'error'
  // 報告已提交、整理被中斷或失敗：「繼續」直接重新整理（主程序的 resume），不會再呼叫 Claude
  const retryReport = canResume && !!task.pendingReport
  const message =
    task.runState === 'interrupted'
      ? retryReport
        ? '報告還沒整理完就中斷了。'
        : '上一次執行被中斷了。'
      : (task.error ?? '發生錯誤')
  return (
    <>
      <LiveStatus text={!quiet && progress} className="ml-10 text-[13px]" />
      {failed && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger"
        >
          <span className="flex-1">
            {message}
            {retryReport && (
              <>
                {' '}
                <span className="text-ink-2">
                  按「繼續」會直接重新整理報告，不會再呼叫 Claude。
                </span>
              </>
            )}
          </span>
          {canResume && (
            <button
              type="button"
              onClick={onResume}
              className="cursor-pointer font-medium underline"
            >
              繼續
            </button>
          )}
        </div>
      )}
    </>
  )
}
