// src/renderer/src/screens/ClarifyScreen.tsx
import type { ReactNode } from 'react'
import type { Task } from '@shared/types'
import { call } from '../api'
import { BranchPanel } from '../components/BranchPanel'
import { Composer } from '../components/Composer'
import { RunStatus, Timeline } from '../components/Timeline'
import { awaitingCounterReply, isBusy } from '../lib/stage'
import { useTimeline } from '../lib/timeline'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'

export function ClarifyScreen({
  task,
  nav,
  readOnly,
  onOpenStage
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
  onOpenStage: (s: 'spec' | 'report') => void
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const events = useTimeline(task.id)
  // 卡片內容（反問回覆等）只改 task 不加事件，所以也看 updatedAt
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${events.length}:${task.updatedAt}`, task.id)
  // 主線執行中不能分岔（主程序會拒絕），但可以插話
  const busy = isBusy(task)
  // 問題卡片在等反問的回答時自己會顯示等待中，底部就不再重複顯示「處理中」
  const cardWaiting = task.questions.some((q) => awaitingCounterReply(task, q))
  const [branching, runBranch] = usePending()
  const branchFrom = (text: string) =>
    runBranch(async () => {
      const title = text
        .replace(/[`*_#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24)
      const b = await act(() =>
        call('branch:open', task.id, {
          title,
          seed: `針對這段內容深入討論：\n${text.slice(0, 600)}`
        })
      )
      if (b) setActiveBranch(task.id, b.id)
    })
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
          <span className="text-lg font-bold">{task.title}</span>
          {nav}
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6"
        >
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-5">
            <Timeline
              task={task}
              channel="main"
              events={events}
              readOnly={readOnly}
              onBranchFrom={busy ? undefined : (t) => void branchFrom(t)}
              branchPending={branching}
              onOpenStage={onOpenStage}
            />
            <RunStatus
              task={task}
              quiet={cardWaiting}
              onResume={() => void act(() => call('run:resume', task.id))}
            />
          </div>
        </div>
        {!readOnly && (
          <div className="px-7 pb-[22px]">
            <div className="mx-auto max-w-[800px]">
              <Composer
                placeholder="補充需求或直接回答…"
                onSend={(t) => {
                  stick()
                  void act(() => call('tasks:send', task.id, 'main', t))
                }}
              />
            </div>
          </div>
        )}
      </main>
      <BranchPanel task={task} events={events} readOnly={readOnly} />
    </>
  )
}
