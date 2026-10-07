// src/renderer/src/components/Timeline.tsx
import { useState } from 'react'
import type { Channel, Task, TimelineEvent } from '@shared/types'
import { type ToolCall, toolLabel, toolSummary, userTextDisplay } from '../lib/timeline'
import { Markdown } from './Markdown'
import { AnsweredQuestionRow, QuestionCard } from './QuestionCard'
import { Avatar, Icons, Spinner } from './ui'

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

function ToolGroup({ events }: { events: ToolEvent[] }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const e of events) {
    const l = toolLabel(e.tool.name)
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
        {[...counts].map(([l, n]) => `${l} ${n} 次`).join(' · ')} {open ? '▴' : '▾'}
      </button>
      {open &&
        events.map((e) => (
          <code key={e.id} className="self-start break-all">
            {toolSummary(e.tool)}
          </code>
        ))}
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[78%] self-end rounded-[18px_18px_6px_18px] bg-fill px-4 py-3 whitespace-pre-wrap">
      {userTextDisplay(text)}
    </div>
  )
}

export function Timeline({
  task,
  channel,
  events,
  readOnly,
  onBranchFrom,
  onOpenStage
}: {
  task: Task
  channel: Channel
  events: TimelineEvent[]
  readOnly?: boolean
  onBranchFrom?: (text: string) => void
  onOpenStage?: (stage: 'spec' | 'report') => void
}) {
  const items = group(events.filter((e) => e.channel === channel))
  return (
    <div className="flex flex-col gap-5">
      {items.map((it) => {
        if (it.kind === 'tools') return <ToolGroup key={it.events[0].id} events={it.events} />
        const e = it.e
        switch (e.kind) {
          case 'user_text':
            return <UserBubble key={e.id} text={e.text ?? ''} />
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
                    onClick={() => onBranchFrom(e.text ?? '')}
                    className="flex h-7 flex-none cursor-pointer items-center rounded-lg px-2 text-muted opacity-0 group-hover:opacity-100 hover:bg-fill focus-visible:opacity-100"
                  >
                    <Icons.Branch width={14} height={14} />
                  </button>
                )}
              </div>
            )
          case 'question': {
            const q = task.questions.find((x) => x.id === e.ref)
            if (!q) return null
            return q.status === 'open' ? (
              <QuestionCard key={e.id} task={task} question={q} readOnly={readOnly} />
            ) : (
              <AnsweredQuestionRow key={e.id} question={q} />
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
          case 'tool_result':
            return (
              <div
                key={e.id}
                className="ml-10 line-clamp-4 text-xs break-all whitespace-pre-wrap text-danger"
              >
                工具錯誤：{e.text}
              </div>
            )
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

export function RunStatus({ task, onResume }: { task: Task; onResume: () => void }) {
  if (task.runState === 'running')
    return (
      <div className="ml-10 flex items-center gap-2 text-[13px] text-muted">
        <Spinner />
        Claude 正在處理…
      </div>
    )
  if (task.runState === 'finalizing')
    return (
      <div className="ml-10 flex items-center gap-2 text-[13px] text-muted">
        <Spinner />
        正在整理 diff 並執行驗證指令…
      </div>
    )
  if (task.runState === 'interrupted' || task.runState === 'error' || task.error) {
    const canResume = task.runState === 'interrupted' || task.runState === 'error'
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger"
      >
        <span className="flex-1">
          {task.runState === 'interrupted' ? '上一次執行被中斷了。' : (task.error ?? '發生錯誤')}
        </span>
        {canResume && (
          <button type="button" onClick={onResume} className="cursor-pointer font-medium underline">
            繼續
          </button>
        )}
      </div>
    )
  }
  return null
}
