// src/renderer/src/components/TaskMenu.tsx
// 任務標題列（階段切換旁）的「⋯」選單：釐清、規格、實作、報告任何階段都能丟棄任務（兩段式確認）；
// 已完成（開過 PR／合併）的任務只能清除 worktree；已丟棄的任務沒有選單。
// 這是每個畫面唯一的丟棄入口（報告頁的收尾面板只留開 PR 與合併）。
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { isBranchMode, type Task } from '@shared/types'
import { call, errorText } from '../api'
import { isComposing } from '../lib/ime'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { Button, cx } from './ui'

export function TaskMenu({
  task,
  cleared,
  onCleared
}: {
  task: Task
  /** 已完成的任務這次開著畫面時清除過 worktree（任務本身沒有記錄） */
  cleared?: boolean
  onCleared?: () => void
}) {
  const openView = useStore((s) => s.open)
  const showToast = useStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [pending, run] = usePending()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const done = task.status === 'done'

  // 丟棄進行中不能關掉選單：結果（失敗原因）要留在這裡
  const close = (refocus = false) => {
    if (pending) return
    setOpen(false)
    setConfirming(false)
    setFailure(undefined)
    if (refocus) triggerRef.current?.focus()
  }

  // 點選單外面就關閉（在事件裡 setState，不是在 effect 本體）；丟棄進行中不關
  useEffect(() => {
    if (!open || pending) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
      setConfirming(false)
      setFailure(undefined)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, pending])
  // 打開時焦點移到第一個項目；進入確認時移到「取消」（誤按 Enter 不會丟棄）
  useEffect(() => {
    if (!open) return
    const target = confirming ? cancelRef.current : itemRef.current
    target?.focus()
  }, [open, confirming])
  // 失敗時焦點移到原因（role="alert"、tabIndex=-1），鍵盤與螢幕閱讀器的使用者從這裡繼續
  useEffect(() => {
    if (failure) alertRef.current?.focus()
  }, [failure])
  // 出現新的核准請求時關掉選單：核准對話框會蓋住畫面（丟棄進行中除外，結果要留在這裡）。
  // React 文件建議的「render 期間依前一個值調整 state」，不用 effect
  const permissionId = task.pendingPermission?.id
  const [seenPermission, setSeenPermission] = useState(permissionId)
  if (seenPermission !== permissionId) {
    setSeenPermission(permissionId)
    if (permissionId && open && !pending) {
      setOpen(false)
      setConfirming(false)
      setFailure(undefined)
    }
  }

  if (task.status === 'discarded' || (done && cleared)) return null

  const finalizing = task.runState === 'finalizing'
  const running =
    task.runState === 'running' ||
    task.runState === 'waiting_permission' ||
    task.branches.some((b) => b.running)
  // branch 模式沒有 worktree：已完成的任務只剩本機分支可以刪
  const branchMode = isBranchMode(task)
  const cleanup = branchMode ? '刪除本機分支' : '清除 worktree'
  const label = done ? cleanup : '丟棄任務'

  const discard = () =>
    run(async () => {
      setFailure(undefined)
      try {
        await call('finish:discard', task.id)
      } catch (e) {
        setFailure(`${done ? `${cleanup}失敗` : '丟棄失敗'}：${errorText(e)}`)
        return
      }
      setOpen(false)
      setConfirming(false)
      if (done) {
        // 清除後選單消失：焦點移到旁邊的階段切換（正在看的階段），不掉到 body
        const stage = rootRef.current?.parentElement?.querySelector<HTMLElement>(
          'nav [aria-pressed="true"]'
        )
        flushSync(() => onCleared?.())
        stage?.focus()
        showToast(branchMode ? '已刪除本機分支' : '已清除 worktree')
        return
      }
      // 丟棄的任務會從側欄消失：回到新任務。丟棄要等執行停下來、刪除 worktree，
      // 期間使用者已經換到別的畫面就不拉回來
      showToast(`已丟棄任務「${task.title}」`)
      const view = useStore.getState().view
      if (view.kind === 'task' && view.taskId === task.id) void openView({ kind: 'new' })
    })

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !isComposing(e) && open) {
      e.stopPropagation()
      close(true)
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="任務動作"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className={cx(
          'flex size-8 cursor-pointer items-center justify-center rounded-full text-lg leading-none text-muted hover:bg-fill hover:text-ink',
          open && 'bg-fill text-ink'
        )}
      >
        <span aria-hidden>⋯</span>
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="任務動作"
          // z-[5]：蓋住時間軸與報告內容，但在核准對話框的遮罩（z-10）之下
          className="absolute top-full right-0 z-[5] mt-2 flex w-[280px] flex-col gap-2 rounded-xl bg-surface p-2 text-[13px] shadow-dialog"
        >
          {confirming ? (
            <div className="flex flex-col gap-2.5 rounded-lg bg-danger-soft p-3">
              <span className="text-danger">
                {done
                  ? `確定要刪除${branchMode ? '' : ' worktree 與'}本機分支 ${task.branch}？已開的 PR 或已合併的內容不受影響。`
                  : branchMode
                    ? `確定要丟棄這個任務？原 repo 未提交的變更會清除、切回 ${task.baseBranch}，分支 ${task.branch} 會刪除，無法復原。`
                    : `確定要丟棄這個任務？worktree 與分支 ${task.branch} 都會刪除，無法復原。`}
                {!done && running && ' Claude 正在執行，會先停止。'}
              </span>
              <div className="flex gap-2">
                {/* 進行中用 aria-disabled 而不是 disabled：停用的按鈕會讓焦點掉到 body */}
                <Button
                  size="sm"
                  className="bg-danger font-medium text-white hover:bg-danger/90"
                  aria-disabled={pending || undefined}
                  onClick={() => void discard()}
                >
                  {done ? '確定清除' : '確定丟棄'}
                </Button>
                <Button
                  ref={cancelRef}
                  size="sm"
                  variant="ghost"
                  aria-disabled={pending || undefined}
                  onClick={() => close(true)}
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <>
              <button
                ref={itemRef}
                type="button"
                disabled={finalizing}
                onClick={() => setConfirming(true)}
                className="cursor-pointer rounded-lg px-3 py-2 text-left text-danger hover:bg-danger-soft disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {label}
              </button>
              {finalizing && (
                <span className="px-3 pb-1 text-xs text-muted">正在整理報告，完成後才能丟棄。</span>
              )}
            </>
          )}
          {failure && (
            <div
              ref={alertRef}
              role="alert"
              tabIndex={-1}
              className="rounded-lg bg-danger-soft px-3 py-2.5 text-xs break-words whitespace-pre-wrap text-danger outline-none"
            >
              {failure}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
