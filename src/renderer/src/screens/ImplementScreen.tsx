// src/renderer/src/screens/ImplementScreen.tsx
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { msgDisplay } from '@shared/protocol'
import type { DiffStats, PlanStep, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { Composer } from '../components/Composer'
import { InlineCode, Markdown } from '../components/Markdown'
import { PendingPermission } from '../components/PermissionDialog'
import { AnsweredQuestionRow, QuestionCard } from '../components/QuestionCard'
import { RunStatus } from '../components/Timeline'
import { Avatar, Button, cx, Icons, Pill, Spinner } from '../components/ui'
import { isBusy } from '../lib/stage'
import {
  implementEvents,
  relativeTo,
  type ToolCall,
  toolLabel,
  toolSummary,
  toolTarget,
  userTextDisplay,
  useTimeline
} from '../lib/timeline'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'

type ToolEvent = TimelineEvent & { tool: ToolCall }
const isToolCall = (e: TimelineEvent): e is ToolEvent => e.kind === 'tool_call' && !!e.tool
/** 進行中的步驟裡列出最近幾個工具呼叫 */
const RECENT_TOOLS = 8
/** Claude 執行中每隔多久重新讀取變更檔案 */
const CHANGED_FILES_POLL_MS = 5000

function ToolRows({
  tools,
  root,
  waitingId,
  failed
}: {
  tools: ToolEvent[]
  /** worktree：路徑顯示成相對於它 */
  root: string
  waitingId?: string
  failed: Set<string>
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
      {tools.map((e) => {
        const waiting = e.id === waitingId
        const target = relativeTo(root, toolTarget(e.tool))
        return (
          <li
            key={e.id}
            className={cx(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5',
              waiting ? 'bg-decision' : 'bg-fill-2'
            )}
          >
            <span
              className={cx(
                'w-11 flex-none font-mono text-[11px]',
                waiting ? 'text-decision-ink' : 'text-muted'
              )}
            >
              {toolLabel(e.tool.name)}
            </span>
            <code className="min-w-0 truncate" title={target}>
              {target}
            </code>
            {waiting ? (
              <span className="ml-auto flex-none text-xs text-decision-ink">等待核准</span>
            ) : (
              failed.has(e.tool.id) && (
                <span className="ml-auto flex-none text-xs text-danger">失敗</span>
              )
            )}
          </li>
        )
      })}
    </ul>
  )
}

function StepRow({ step, index }: { step: PlanStep; index: number }) {
  const done = step.status === 'done'
  return (
    <div
      className={cx(
        'flex items-center gap-3 rounded-[14px] px-4 py-3',
        done ? 'bg-fill-2' : 'text-muted'
      )}
    >
      {done ? (
        <span className="flex size-6 flex-none items-center justify-center rounded-full bg-brand text-white">
          <Icons.Check width={12} height={12} strokeWidth={3} />
          <span className="sr-only">已完成</span>
        </span>
      ) : (
        <span className="flex size-6 flex-none items-center justify-center rounded-full text-xs shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]">
          {index + 1}
        </span>
      )}
      <span className="flex-1">
        <InlineCode text={step.title} />
      </span>
      {step.status === 'blocked' && <Pill tone="danger">卡住</Pill>}
    </div>
  )
}

/** 主線的對話：插話、Claude 的回覆、實作中的提問與系統訊息（工具呼叫列在步驟裡） */
function ChatItem({ task, e, readOnly }: { task: Task; e: TimelineEvent; readOnly: boolean }) {
  switch (e.kind) {
    case 'user_text': {
      const text = e.text ?? ''
      return (
        <div className="max-w-[78%] self-end rounded-[18px_18px_6px_18px] bg-fill px-3.5 py-2.5 text-[13px] whitespace-pre-wrap">
          {text !== msgDisplay.resume && (
            <span className="block text-[11px] text-muted">你插話</span>
          )}
          {userTextDisplay(text)}
        </div>
      )
    }
    case 'assistant_text':
      return (
        <div className="flex gap-2.5 text-[13px]">
          <Avatar className="size-6 text-[11px]" />
          <div className="min-w-0 flex-1">
            <Markdown text={e.text ?? ''} />
          </div>
        </div>
      )
    case 'question': {
      const q = task.questions.find((x) => x.id === e.ref)
      if (!q) return null
      return q.status === 'open' ? (
        <QuestionCard task={task} question={q} readOnly={readOnly} />
      ) : (
        <AnsweredQuestionRow question={q} />
      )
    }
    case 'system':
      return (
        <div className="self-center rounded-full bg-fill px-3 py-1 text-xs text-muted">
          {e.text}
        </div>
      )
    default:
      return null
  }
}

/** 執行中定期重新讀取（未提交的變更也算）；停下來時再讀一次就不再輪詢 */
function ChangedFiles({ taskId, live }: { taskId: string; live: boolean }) {
  const [state, setState] = useState<{ stats?: DiffStats; failed?: boolean }>({})
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const stats = await call('tasks:changedFiles', taskId)
        if (alive) setState({ stats })
      } catch {
        // 讀過一次就保留上一份；從來沒讀到才顯示說明
        if (alive) setState((s) => ({ ...s, failed: true }))
      }
      if (alive && live) timer = setTimeout(() => void load(), CHANGED_FILES_POLL_MS)
    }
    void load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [taskId, live])
  const { stats } = state
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-bold">變更檔案</span>
        {stats && (
          <span className="font-mono text-xs">
            <span className="text-ok">+{stats.additions}</span>{' '}
            <span className="text-danger">−{stats.deletions}</span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 text-[13px]">
        {stats?.perFile.map((f) => (
          <div
            key={f.path}
            className="flex items-center gap-2 rounded-[10px] bg-fill-2 px-2.5 py-2"
          >
            <code className="min-w-0 truncate bg-transparent p-0" title={f.path}>
              {f.path}
            </code>
            <span className="ml-auto flex-none font-mono text-[11px]">
              <span className="text-ok">+{f.additions}</span>{' '}
              <span className="text-danger">−{f.deletions}</span>
            </span>
          </div>
        ))}
        {stats && stats.files === 0 && <span className="text-muted">還沒有變更</span>}
        {!stats && state.failed && <span className="text-muted">無法讀取變更</span>}
      </div>
    </>
  )
}

export function ImplementScreen({
  task,
  nav,
  readOnly
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
}) {
  const act = useStore((s) => s.act)
  const timeline = useTimeline(task.id)
  const events = useMemo(() => implementEvents(timeline), [timeline])
  // 步驟與卡片只改 task 不加事件，所以也看 updatedAt
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${events.length}:${task.updatedAt}`, task.id)
  const [stopping, runStop] = usePending()
  const [showing, runShow] = usePending()
  const [, runResume] = usePending()

  const busy = isBusy(task)
  const running = task.runState === 'running' || task.runState === 'waiting_permission'
  const total = task.plan.length
  const done = task.plan.filter((s) => s.status === 'done').length
  const runningIdx = task.plan.findIndex((s) => s.status === 'running')
  const openQuestion = task.questions.some((q) => q.status === 'open')

  const tools = events.filter(isToolCall).slice(-RECENT_TOOLS)
  const failed = new Set(
    events.filter((e) => e.kind === 'tool_result' && e.tool?.isError).map((e) => e.tool!.id)
  )
  const chat = events.filter(
    (e) =>
      e.kind === 'user_text' ||
      e.kind === 'assistant_text' ||
      e.kind === 'question' ||
      e.kind === 'system'
  )
  // 等待核准的請求對應到最近一個相同的工具呼叫（請求本身沒有 tool_use id）
  const p = task.pendingPermission
  const waitingId = p
    ? tools.findLast(
        (e) => toolSummary(e.tool) === toolSummary({ id: '', name: p.toolName, input: p.input })
      )?.id
    : undefined

  const status =
    task.runState === 'waiting_permission' ? (
      <Pill tone="decision">等待核准</Pill>
    ) : task.runState === 'running' ? (
      <Pill tone="brand">進行中</Pill>
    ) : openQuestion ? (
      <Pill tone="decision">等你回答</Pill>
    ) : (
      <Pill tone="muted">暫停中</Pill>
    )
  const toolList = tools.length > 0 && (
    <div className="pr-4 pb-3.5 pl-[52px]">
      <ToolRows tools={tools} root={task.worktreePath} waitingId={waitingId} failed={failed} />
    </div>
  )

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
          <div className="flex min-w-0 flex-col">
            <span className="text-lg font-bold">{task.title}</span>
            <span className="truncate font-mono text-[11px] text-muted">{task.branch}</span>
          </div>
          {nav}
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6"
        >
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-2.5">
            <div className="mb-1.5 flex items-center gap-3">
              <span className="text-[13px] text-muted">進度</span>
              <span
                role="progressbar"
                aria-label="進度"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
                aria-valuetext={total ? `${done} / ${total}` : '還沒有步驟'}
                className="flex h-1.5 flex-1 rounded-[3px] bg-line-soft"
              >
                <span
                  className="rounded-[3px] bg-brand transition-[width]"
                  style={{ width: `${total ? (done / total) * 100 : 0}%` }}
                />
              </span>
              <span className="font-mono text-xs">
                {done} / {total || '?'}
              </span>
            </div>

            {task.plan.map((s, i) =>
              i === runningIdx ? (
                <section
                  key={s.id}
                  aria-label="進行中的步驟"
                  className="overflow-hidden rounded-2xl shadow-focus"
                >
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <span className="flex size-6 flex-none items-center justify-center rounded-full text-xs font-bold text-brand shadow-[inset_0_0_0_2px_var(--color-brand)]">
                      {i + 1}
                    </span>
                    <span className="flex-1 font-medium">
                      <InlineCode text={s.title} />
                    </span>
                    {status}
                  </div>
                  {toolList}
                </section>
              ) : (
                <StepRow key={s.id} step={s} index={i} />
              )
            )}

            {/* 還沒列出步驟（剛開始讀程式碼）或步驟之間：仍然看得到 Claude 在做什麼 */}
            {runningIdx < 0 && busy && tools.length > 0 && (
              <section aria-label="最近的動作" className="overflow-hidden rounded-2xl shadow-focus">
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <span className="flex size-6 flex-none items-center justify-center">
                    <Spinner decorative />
                  </span>
                  <span className="flex-1 font-medium">
                    {total ? '最近的動作' : '正在規劃步驟'}
                  </span>
                  {status}
                </div>
                {toolList}
              </section>
            )}

            {chat.map((e) => (
              <ChatItem key={e.id} task={task} e={e} readOnly={readOnly} />
            ))}

            <RunStatus
              task={task}
              onResume={() => void runResume(() => act(() => call('run:resume', task.id)))}
            />
          </div>
        </div>

        {!readOnly && (
          <div className="px-7 pb-[22px]">
            <div className="mx-auto max-w-[800px]">
              <Composer
                label="插話"
                placeholder="插話給 Claude…"
                // 整理報告時主程序不接受主線訊息
                disabled={task.runState === 'finalizing'}
                onSend={(t) => {
                  stick()
                  void act(() => call('tasks:send', task.id, 'main', t))
                }}
                extra={
                  running && (
                    <button
                      type="button"
                      disabled={stopping}
                      onClick={() =>
                        void runStop(() => act(() => call('run:stop', task.id, 'main')))
                      }
                      className="flex h-10 flex-none cursor-pointer items-center gap-1.5 rounded-full bg-surface px-4 text-[13px] text-danger disabled:cursor-default disabled:opacity-50"
                    >
                      <Icons.Stop width={12} height={12} />
                      停止
                    </button>
                  )
                }
              />
            </div>
          </div>
        )}

        <PendingPermission task={task} />
      </main>

      <aside
        aria-label="變更檔案"
        className="flex w-[320px] flex-none flex-col gap-3.5 overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card"
      >
        <ChangedFiles taskId={task.id} live={busy} />
        <div className="h-px flex-none bg-line-soft" />
        <div className="flex flex-col gap-2 text-[13px]">
          <span className="font-bold">本任務已允許的指令</span>
          <div className="flex flex-wrap gap-1.5">
            {task.allowedCommands.length ? (
              task.allowedCommands.map((c) => <code key={c}>{c}</code>)
            ) : (
              <span className="text-muted">（只有設定中的永遠允許清單）</span>
            )}
          </div>
        </div>
        <div className="h-px flex-none bg-line-soft" />
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-bold">Worktree</span>
          <span className="font-mono text-[11px] break-all text-ink-2">{task.worktreePath}</span>
          <Button
            size="sm"
            className="self-start"
            disabled={showing}
            onClick={() =>
              void runShow(() => act(() => call('shell:showInFolder', task.worktreePath)))
            }
          >
            在 Finder 開啟
          </Button>
        </div>
      </aside>
    </>
  )
}
