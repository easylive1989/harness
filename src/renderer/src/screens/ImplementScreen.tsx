// src/renderer/src/screens/ImplementScreen.tsx
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { msgDisplay } from '@shared/protocol'
import type { DiffStats, PlanStep, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { Composer, StopButton } from '../components/Composer'
import { InlineCode, Markdown } from '../components/Markdown'
import { PendingPermission } from '../components/PermissionDialog'
import { AnsweredQuestionRow, QuestionCard } from '../components/QuestionCard'
import { RunStatus } from '../components/Timeline'
import { Avatar, Button, cx, Icons, Pill, Spinner } from '../components/ui'
import { isBusy } from '../lib/stage'
import {
  implementEvents,
  latestQuestionEvents,
  SUBAGENT_LABEL,
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
/** 工具呼叫的結果：失敗、使用者在核准對話框拒絕，或 Harness 的規則擋下（reason：顯示的原因） */
type ToolOutcome = { kind: 'failed' | 'denied' | 'blocked'; reason?: string }
const isToolCall = (e: TimelineEvent): e is ToolEvent => e.kind === 'tool_call' && !!e.tool
/** 進行中的步驟裡列出最近幾個工具呼叫 */
const RECENT_TOOLS = 8
/** Claude 執行中每隔多久重新讀取變更檔案 */
const CHANGED_FILES_POLL_MS = 5000

function ToolRows({
  tools,
  root,
  waitingId,
  outcomes
}: {
  tools: ToolEvent[]
  /** worktree：路徑顯示成相對於它 */
  root: string
  waitingId?: string
  outcomes: Map<string, ToolOutcome>
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
      {tools.map((e) => {
        const waiting = e.id === waitingId
        const target = toolTarget(e.tool, root)
        const outcome = outcomes.get(e.tool.id)
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
            {e.tool.subagent && (
              <span className="flex-none rounded-full bg-surface px-1.5 text-[11px] text-muted">
                {SUBAGENT_LABEL}
              </span>
            )}
            <code className="min-w-0 truncate" title={target}>
              {target}
            </code>
            {waiting ? (
              <span className="ml-auto flex-none text-xs text-decision-ink">等待核准</span>
            ) : outcome?.kind === 'denied' ? (
              <span className="ml-auto flex-none text-xs text-muted">已拒絕</span>
            ) : outcome?.kind === 'blocked' ? (
              // Harness 的規則擋下（預期中的事，不是失敗）：原因放在 title
              <span className="ml-auto flex-none text-xs text-muted" title={outcome.reason}>
                已阻擋
              </span>
            ) : (
              outcome?.kind === 'failed' && (
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
    contentRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${events.length}:${task.updatedAt}`, task.id, events.length)
  const [showing, runShow] = usePending()
  const [, runResume] = usePending()
  const composerRef = useRef<HTMLInputElement>(null)

  const busy = isBusy(task)
  const running = task.runState === 'running' || task.runState === 'waiting_permission'
  const total = task.plan.length
  const done = task.plan.filter((s) => s.status === 'done').length
  const runningIdx = task.plan.findIndex((s) => s.status === 'running')

  // 等待核准的請求以 toolUseId 對應時間軸上的工具呼叫；沒有 id 的（開發期間的舊資料）找最近一個相同的呼叫
  const p = task.pendingPermission
  const allTools = events.filter(isToolCall)
  const waitingTool = p?.toolUseId ? allTools.findLast((e) => e.tool.id === p.toolUseId) : undefined
  const recent = allTools.slice(-RECENT_TOOLS)
  // 等待核准的呼叫比較早、不在最近幾個裡時，仍然列在最後一列（最近 7 個＋它）
  const tools =
    waitingTool && !recent.includes(waitingTool)
      ? [...allTools.slice(-(RECENT_TOOLS - 1)), waitingTool]
      : recent
  const outcomes = new Map<string, ToolOutcome>(
    events
      .filter((e) => e.kind === 'tool_result' && e.tool?.isError)
      .map((e): [string, ToolOutcome] => [
        e.tool!.id,
        {
          kind: e.tool!.denied ? 'denied' : e.tool!.blocked ? 'blocked' : 'failed',
          reason: e.text
        }
      ])
  )
  // 重新提問過的問題只在最後一次出現的位置畫卡片
  const latest = latestQuestionEvents(events)
  const chat = events.filter(
    (e) =>
      e.kind === 'user_text' ||
      e.kind === 'assistant_text' ||
      e.kind === 'system' ||
      (e.kind === 'question' && latest.has(e.id))
  )
  const isOpen = (id?: string) => task.questions.some((q) => q.id === id && q.status === 'open')
  // 這段實作裡沒有出現過的開放問題（例如核准前提出、還沒回答）放在最上方，才不會沒有地方回答
  const asked = new Set(chat.filter((e) => e.kind === 'question').map((e) => e.ref))
  const orphanQuestions = task.questions.filter((q) => q.status === 'open' && !asked.has(q.id))
  const waitingForAnswer =
    orphanQuestions.length > 0 || chat.some((e) => e.kind === 'question' && isOpen(e.ref))
  const waitingId = !p
    ? undefined
    : p.toolUseId
      ? waitingTool?.id
      : tools.findLast(
          (e) => toolSummary(e.tool) === toolSummary({ id: '', name: p.toolName, input: p.input })
        )?.id

  const status =
    task.runState === 'waiting_permission' ? (
      <Pill tone="decision">等待核准</Pill>
    ) : task.runState === 'running' ? (
      <Pill tone="brand">進行中</Pill>
    ) : waitingForAnswer ? (
      <Pill tone="decision">等你回答</Pill>
    ) : (
      <Pill tone="muted">暫停中</Pill>
    )
  const toolList = tools.length > 0 && (
    <div className="pr-4 pb-3.5 pl-[52px]">
      <ToolRows tools={tools} root={task.worktreePath} waitingId={waitingId} outcomes={outcomes} />
    </div>
  )

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        {/* 有等待中的核准請求時，遮罩後面的內容不能用鍵盤或滑鼠操作 */}
        <div className="contents" inert={!!task.pendingPermission}>
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
            <div ref={contentRef} className="mx-auto flex w-full max-w-[800px] flex-col gap-2.5">
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

              {orphanQuestions.map((q) => (
                <QuestionCard key={q.id} task={task} question={q} readOnly={readOnly} />
              ))}

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
                <section
                  aria-label="最近的動作"
                  className="overflow-hidden rounded-2xl shadow-focus"
                >
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
                <ChatItem
                  // 問題卡片以問題 id 為 key：重新提問時卡片搬到新位置，還沒送出的輸入留著
                  key={e.kind === 'question' ? `question:${e.ref}` : e.id}
                  task={task}
                  e={e}
                  readOnly={readOnly}
                />
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
                  inputRef={composerRef}
                  label="插話"
                  placeholder="插話給 Claude…"
                  // 整理報告時主程序不接受主線訊息
                  disabled={task.runState === 'finalizing'}
                  onSend={(t) => {
                    stick()
                    void act(() => call('tasks:send', task.id, 'main', t))
                  }}
                  extra={running && <StopButton taskId={task.id} channel="main" />}
                />
              </div>
            </div>
          )}
        </div>

        <PendingPermission task={task} fallbackFocus={() => composerRef.current} />
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
