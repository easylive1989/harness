// src/renderer/src/components/RepoMenu.tsx
// 側欄 repo 列的「⋯」（滑鼠移過或鍵盤聚焦時出現）：從 Harness 移除 repo（兩段式確認）。
// 它的任務一併刪除（停止 Claude、刪除 worktree、分支與紀錄），repo 資料夾本身不動。
// 只有這裡會刪除任務的紀錄；單一任務仍只有任務標題列「⋯」的丟棄。
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { Repo, Task } from '@shared/types'
import { call, errorText } from '../api'
import { isComposing } from '../lib/ime'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { Button, cx } from './ui'

/** 移除後的提示；repo 資料夾已不存在時 git 無法清理，說明沒刪掉的 worktree 資料夾在哪裡 */
function removedText(name: string, left: string[]) {
  const base = `已移除 repo「${name}」`
  if (!left.length) return base
  return `${base}。repo 資料夾已不存在，${left.length} 個 worktree 資料夾沒有刪除：${left.join('、')}`
}

export function RepoMenu({
  repo,
  tasks,
  children
}: {
  repo: Repo
  /** 這個 repo 的所有任務（含已丟棄、在側欄看不到的） */
  tasks: Task[]
  /** repo 列本身（展開／收合的按鈕） */
  children: ReactNode
}) {
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
  const label = `「${repo.name}」的動作`

  // 移除進行中不能關掉選單：結果（失敗原因）要留在這裡
  const close = (refocus = false) => {
    if (pending) return
    setOpen(false)
    setConfirming(false)
    setFailure(undefined)
    if (refocus) triggerRef.current?.focus()
  }

  // 點選單外面就關閉（在事件裡 setState，不是在 effect 本體）；移除進行中不關
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
  // 打開時焦點移到第一個項目；進入確認時移到「取消」（誤按 Enter 不會移除）
  useEffect(() => {
    if (!open) return
    const target = confirming ? cancelRef.current : itemRef.current
    target?.focus()
  }, [open, confirming])
  // 失敗時焦點移到原因（role="alert"、tabIndex=-1）
  useEffect(() => {
    if (failure) alertRef.current?.focus()
  }, [failure])

  const visible = tasks.filter((t) => t.status !== 'discarded').length
  const finalizing = tasks.some((t) => t.runState === 'finalizing')
  const running = tasks.some(
    (t) =>
      t.runState === 'running' ||
      t.runState === 'waiting_permission' ||
      t.branches.some((b) => b.running)
  )
  const confirmText = [
    `確定要從 Harness 移除 ${repo.name}？`,
    visible > 0 &&
      `它的 ${visible} 個任務會一併刪除：停止 Claude，刪除 worktree、分支和對話紀錄，無法復原。`,
    'repo 資料夾本身不受影響。',
    running && 'Claude 正在執行，會先停止。'
  ]
    .filter(Boolean)
    .join('')

  const remove = () =>
    run(async () => {
      setFailure(undefined)
      let left: string[]
      try {
        left = (await call('repos:remove', repo.id)).leftWorktrees
      } catch (e) {
        setFailure(`移除失敗：${errorText(e)}`)
        return
      }
      // repo 會從側欄消失；正在看它的任務時，store 收到 task_removed 會回到新任務
      setOpen(false)
      setConfirming(false)
      showToast(removedText(repo.name, left))
    })

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !isComposing(e) && open) {
      e.stopPropagation()
      close(true)
    }
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-1" onKeyDown={onKeyDown}>
      <div className="group flex items-center">
        {children}
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? close() : setOpen(true))}
          className={cx(
            'flex size-6 flex-none cursor-pointer items-center justify-center rounded-md leading-none text-muted group-hover:opacity-100 hover:bg-surface/60 hover:text-ink focus-visible:opacity-100',
            open ? 'bg-surface/60 text-ink opacity-100' : 'opacity-0'
          )}
        >
          <span aria-hidden>⋯</span>
        </button>
      </div>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={label}
          className="mx-1 flex flex-col gap-2 rounded-xl bg-surface p-2 text-[13px] shadow-raised"
        >
          {confirming ? (
            <div className="flex flex-col gap-2.5 rounded-lg bg-danger-soft p-3">
              <span className="text-danger">{confirmText}</span>
              <div className="flex gap-2">
                {/* 進行中用 aria-disabled 而不是 disabled：停用的按鈕會讓焦點掉到 body */}
                <Button
                  size="sm"
                  className="bg-danger font-medium text-white hover:bg-danger/90"
                  aria-disabled={pending || undefined}
                  onClick={() => void remove()}
                >
                  確定移除
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
                移除 repo
              </button>
              {finalizing && (
                <span className="px-3 pb-1 text-xs text-muted">
                  有任務正在整理報告，完成後才能移除。
                </span>
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
