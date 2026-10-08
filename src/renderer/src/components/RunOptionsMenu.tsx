// src/renderer/src/components/RunOptionsMenu.tsx
// 任務標題列的執行選項（模型、effort、權限模式）：任務進行中可以調整，下一輪執行生效。
// 已結束（完成、丟棄）的任務只顯示當時的設定。
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { EFFORTS, modelLabel, type RunOptions, type Task } from '@shared/types'
import { call } from '../api'
import { isComposing } from '../lib/ime'
import { taskRunOptions } from '../lib/runOptions'
import { useStore } from '../store'
import { RunOptionFields } from './RunOptionFields'
import { cx } from './ui'

export function RunOptionsMenu({ task }: { task: Task }) {
  const models = useStore((s) => s.models)
  const act = useStore((s) => s.act)
  const [open, setOpen] = useState(false)
  // 儲存中先顯示剛選的值
  const [draft, setDraft] = useState<RunOptions>()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const ended = task.status === 'done' || task.status === 'discarded'
  const value = draft ?? taskRunOptions(task)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const effort = EFFORTS.find((e) => e.id === value.effort)
  const summary = [
    modelLabel(models, value.model),
    value.effort === 'auto' ? undefined : effort?.label,
    value.permissionMode === 'auto' ? 'Auto 權限' : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  if (ended) return <span className="text-xs text-muted">{summary}</span>

  const save = async (next: RunOptions) => {
    setDraft(next)
    await act(() => call('tasks:setRunOptions', task.id, next))
    setDraft((d) => (d === next ? undefined : d))
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !isComposing(e) && open) {
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`執行選項：${summary}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'flex h-8 max-w-[220px] cursor-pointer items-center rounded-full px-3 text-xs text-muted hover:bg-fill hover:text-ink',
          open && 'bg-fill text-ink'
        )}
      >
        <span className="truncate">{summary}</span>
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="執行選項"
          // z-[5]：蓋住時間軸與報告內容，但在核准對話框的遮罩（z-10）之下
          className="absolute top-full right-0 z-[5] mt-2 flex w-[300px] flex-col gap-3 rounded-xl bg-surface p-3.5 text-[13px] shadow-dialog"
        >
          <RunOptionFields
            value={value}
            onChange={(next) => void save(next)}
            className="flex-col gap-3"
          />
          <span className="text-xs text-muted">修改後從下一輪執行開始生效。</span>
        </div>
      )}
    </div>
  )
}
