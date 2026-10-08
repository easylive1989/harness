// src/renderer/src/components/PermissionDialog.tsx
import { type KeyboardEvent, useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import type { PermissionRequest, Task } from '@shared/types'
import { call } from '../api'
import { isComposing } from '../lib/ime'
import { APPROVAL_ARM_MS, describeRequest, PREVIEW_COLLAPSED, requesterOf } from '../lib/permission'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { Button, cx, Icons, textareaClass } from './ui'

/** 對話框關掉後焦點要去的地方（原本的位置拿不到焦點時），例如畫面的插話框 */
type FocusTarget = () => HTMLElement | null | undefined

/** 對照 `B4-Implement.dc.html` 的 dialog；蓋在所在的 `<main>`（需要 relative）上 */
export function PermissionDialog({
  request: r,
  cwd,
  branch,
  fallbackFocus
}: {
  request: PermissionRequest
  cwd: string
  /** 提出請求的分岔名稱；主線的請求不給 */
  branch?: string
  fallbackFocus?: FocusTarget
}) {
  const act = useStore((s) => s.act)
  const titleId = useId()
  const codeId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  // 剛出現時先停用核准與拒絕：連點「允許」時第二下不會落在下一個請求上
  const [armed, setArmed] = useState(false)
  const [remember, setRemember] = useState(false)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [pending, run] = usePending()
  const v = describeRequest(r, cwd, branch)
  const locked = pending || !armed

  useEffect(() => {
    const t = setTimeout(() => setArmed(true), APPROVAL_ARM_MS)
    return () => clearTimeout(t)
  }, [])

  const restoreFocus = useEffectEvent((prev: Element | null) => {
    if (prev instanceof HTMLElement && prev !== document.body && prev.isConnected) prev.focus()
    // 原本的位置不在了或拿不到焦點（例如還被遮罩擋住）時交給畫面決定
    if (!document.activeElement || document.activeElement === document.body)
      fallbackFocus?.()?.focus()
  })
  // 出現時把焦點移進對話框（使用者可能正在輸入框打字）；刻意不放在「允許」上，免得按 Enter 就核准。
  // 關掉時把焦點還給原本的位置；下一個排隊的請求出現時會再把焦點移到新的對話框。
  useEffect(() => {
    const prev = document.activeElement
    dialogRef.current?.focus()
    return () => restoreFocus(prev)
  }, [])

  const leaveDeny = () => {
    // 先把焦點放回對話框，拒絕原因的輸入框消失後焦點才不會掉到 body
    dialogRef.current?.focus()
    setDenying(false)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    // 拒絕原因輸入中、輸入法選字時的 Esc 是取消組字，不離開拒絕模式
    if (e.key === 'Escape' && denying && !isComposing(e)) {
      e.stopPropagation()
      leaveDeny()
    }
  }

  const resolve = (allow: boolean) =>
    run(() =>
      act(() =>
        call(
          'permission:resolve',
          r.taskId,
          r.id,
          allow
            ? {
                allow: true,
                ...(remember && r.suggestedPattern ? { rememberPattern: r.suggestedPattern } : {})
              }
            : { allow: false, ...(reason.trim() ? { message: reason.trim() } : {}) }
        )
      )
    )

  const longPreview = !!v.preview && v.preview.length > PREVIEW_COLLAPSED
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-ink/28 p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={codeId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-[20px] bg-surface p-6 shadow-dialog outline-none"
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-decision-ink">需要你的核准</span>
          <span id={titleId} className="text-lg font-bold">
            {v.title}
          </span>
        </div>
        <div
          id={codeId}
          className="flex flex-col gap-1.5 rounded-xl bg-code px-4 py-3.5 font-mono text-[13px] text-code-ink"
        >
          <span className="break-all whitespace-pre-wrap">{v.code}</span>
          {v.sub && <span className="text-[11px] break-all text-code-muted">{v.sub}</span>}
        </div>
        {v.warning && (
          <span className="flex items-start gap-2 text-[13px] text-decision-ink">
            <Icons.Info className="mt-[3px] flex-none" width={14} height={14} />
            {v.warning}
          </span>
        )}
        {v.preview && (
          <div className="flex flex-col gap-1.5">
            <pre
              aria-label="要寫入的內容"
              className={cx(
                'm-0 overflow-auto rounded-xl bg-fill-2 px-3.5 py-2.5 font-mono text-xs break-all whitespace-pre-wrap text-ink-2',
                expanded ? 'max-h-80' : 'max-h-40'
              )}
            >
              {longPreview && !expanded ? `${v.preview.slice(0, PREVIEW_COLLAPSED)}…` : v.preview}
            </pre>
            {longPreview && !expanded && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="cursor-pointer self-start text-xs text-brand hover:text-brand-hover"
              >
                顯示完整內容（共 {v.preview.length} 字）
              </button>
            )}
          </div>
        )}
        {v.reason && <span className="text-[13px] text-ink-2">{v.reason}</span>}
        {r.suggestedPattern ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <input
              type="checkbox"
              checked={remember}
              disabled={pending}
              onChange={(e) => setRemember(e.target.checked)}
              className="size-4 flex-none accent-brand"
            />
            <span>
              本任務內都允許 <code>{r.suggestedPattern}</code>
            </span>
          </label>
        ) : (
          r.toolName === 'Bash' && (
            <span className="text-xs text-muted">這個指令含有串接、重導或變數，只能逐次核准。</span>
          )
        )}
        {denying ? (
          <div className="flex flex-col gap-2.5">
            <textarea
              aria-label="拒絕原因"
              rows={2}
              // 使用者按了「拒絕並說明」才出現，直接把焦點放進來
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="告訴 Claude 為什麼不行、該怎麼做（選填，Esc 返回）"
              className={textareaClass}
            />
            <div className="flex justify-end gap-2.5">
              <Button disabled={pending} onClick={leaveDeny}>
                返回
              </Button>
              <Button variant="dark" disabled={locked} onClick={() => void resolve(false)}>
                送出拒絕
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2.5">
            <Button className="px-[18px]" disabled={locked} onClick={() => setDenying(true)}>
              拒絕並說明
            </Button>
            <Button
              variant="primary"
              className="px-[22px]"
              disabled={locked}
              onClick={() => void resolve(true)}
            >
              允許
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 任務有等待中的核准請求時蓋在畫面上。請求依序排隊（task.pendingPermission 是最早的一個），
 * 以 id 為 key：換下一個請求時勾選、拒絕原因、停用時間都重新開始，焦點也移到新的對話框。
 * fallbackFocus：請求都處理完、原本的位置拿不到焦點時，焦點要去的地方（例如插話框）。
 */
export function PendingPermission({
  task,
  fallbackFocus
}: {
  task: Task
  fallbackFocus?: FocusTarget
}) {
  const r = task.pendingPermission
  if (!r) return null
  return (
    <PermissionDialog
      key={r.id}
      request={r}
      cwd={task.worktreePath}
      branch={requesterOf(task, r)}
      fallbackFocus={fallbackFocus}
    />
  )
}
