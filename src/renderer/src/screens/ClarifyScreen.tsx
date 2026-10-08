// src/renderer/src/screens/ClarifyScreen.tsx
import { type ReactNode, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { Task } from '@shared/types'
import { call } from '../api'
import { BranchPanel } from '../components/BranchPanel'
import { Composer } from '../components/Composer'
import { PendingPermission } from '../components/PermissionDialog'
import { RunStatus, Timeline } from '../components/Timeline'
import { branchSeed, branchTitle } from '../lib/branchDraft'
import { flash, reveal } from '../lib/reveal'
import { awaitingCounterReply, isBusy } from '../lib/stage'
import { useTimeline } from '../lib/timeline'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'

export function ClarifyScreen({
  task,
  nav,
  readOnly,
  onOpenStage,
  focusQuestion
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
  onOpenStage: (s: 'spec' | 'report') => void
  /** 從規格或報告點「問題 N」：捲到這個問題並短暫標示（每次點擊是新的物件） */
  focusQuestion?: { id: string }
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const startBranchDraft = useStore((s) => s.startBranchDraft)
  const cancelBranchDraft = useStore((s) => s.cancelBranchDraft)
  // 從訊息開分岔：先在分岔面板問使用者想討論什麼，送出問題才建立分岔（取消就什麼都不建立）。
  // 草稿放在 store：切到任何分岔（分岔標籤、問題卡片的「查看分岔」「升級成分岔」、建立完成）都會放棄它
  const draft = useStore((s) => s.branchDrafts[task.id])
  const events = useTimeline(task.id)
  // 卡片內容（反問回覆等）只改 task 不加事件，所以也看 updatedAt
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${events.length}:${task.updatedAt}`, task.id, events.length)
  // 主線執行中不能分岔（主程序會拒絕），但可以插話
  const busy = isBusy(task)
  // 問題卡片在等反問的回答時自己會顯示等待中，底部就不再重複顯示「處理中」
  const cardWaiting = task.questions.some((q) => awaitingCounterReply(task, q))
  // 按下的分岔按鈕：取消後焦點回到它（在事件裡寫入）
  const draftTrigger = useRef<HTMLElement | null>(null)
  // 離開釐清畫面（換階段或換任務）就放棄草稿，回來時不會冒出舊的輸入框
  useEffect(() => () => cancelBranchDraft(task.id), [task.id, cancelBranchDraft])
  const [branching, runBranch] = usePending()
  const composerRef = useRef<HTMLInputElement>(null)
  // 跳到指定的問題：等時間軸畫出那張卡片（或已答列）後才捲，同一次指定只捲一次。
  // 排在 useStickToBottom 的 layout effect（捲到底）之後執行
  const focused = useRef<{ id: string }>(undefined)
  useEffect(() => {
    if (!focusQuestion || focused.current === focusQuestion) return
    const el = [
      ...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-question]') ?? [])
    ].find((x) => x.dataset.question === focusQuestion.id)
    if (!el) return
    focused.current = focusQuestion
    reveal(el, 'center')
    flash(el)
  }, [focusQuestion, events, scrollRef])
  const createBranch = (excerpt: string, question: string) =>
    runBranch(async () => {
      const b = await act(() =>
        call('branch:open', task.id, {
          title: branchTitle(question),
          seed: branchSeed(excerpt, question)
        })
      )
      if (!b) return
      // 換到新分岔（store 一併放棄草稿）；畫出來之後把焦點移到新分岔的標籤
      flushSync(() => setActiveBranch(task.id, b.id))
      document.querySelector<HTMLElement>(`[data-branch-chip="${b.id}"]`)?.focus()
    })
  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        {/* 有等待中的核准請求時，遮罩後面的內容不能用鍵盤或滑鼠操作 */}
        <div className="contents" inert={!!task.pendingPermission}>
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
                onBranchFrom={
                  busy
                    ? undefined
                    : (excerpt, trigger) => {
                        draftTrigger.current = trigger
                        startBranchDraft(task.id, excerpt)
                      }
                }
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
                  inputRef={composerRef}
                  placeholder="補充需求或直接回答…"
                  onSend={(t) => {
                    stick()
                    void act(() => call('tasks:send', task.id, 'main', t))
                  }}
                />
              </div>
            </div>
          )}
        </div>
        {/* 釐清中 Claude（主線或分岔）要讀網頁、搜尋網路時也要核准 */}
        <PendingPermission task={task} fallbackFocus={() => composerRef.current} />
      </main>
      <BranchPanel
        task={task}
        events={events}
        readOnly={readOnly}
        draft={
          draft && {
            excerpt: draft.excerpt,
            seq: draft.seq,
            pending: branching,
            onSubmit: (q) => void createBranch(draft.excerpt, q),
            onCancel: () => {
              cancelBranchDraft(task.id)
              draftTrigger.current?.focus()
            }
          }
        }
      />
    </>
  )
}
