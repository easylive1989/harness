// src/renderer/src/components/PermissionDialog.tsx
import { useEffect, useId, useRef, useState } from 'react'
import type { PermissionRequest, Task } from '@shared/types'
import { call } from '../api'
import { relativeTo } from '../lib/timeline'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { Button, Icons, textareaClass } from './ui'

/** 修改這些工具的請求只會出現在 .git／.claude／.mcp.json（主程序只對這些路徑詢問） */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PREVIEW_MAX = 4000

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 要寫入的內容：Write 的全文、Edit 的取代前後（- / + 開頭），太長就截斷 */
function writePreview(input: Record<string, unknown>): string | undefined {
  const lines = (prefix: string, s?: string) =>
    s === undefined ? [] : s.split('\n').map((l) => `${prefix} ${l}`)
  const edit = (e: Record<string, unknown>) =>
    [...lines('-', str(e.old_string)), ...lines('+', str(e.new_string))].join('\n')
  const text =
    str(input.content) ??
    str(input.new_source) ??
    (Array.isArray(input.edits)
      ? input.edits.filter(isRecord).map(edit).join('\n…\n')
      : str(input.new_string) !== undefined
        ? edit(input)
        : undefined)
  if (!text) return undefined
  return text.length > PREVIEW_MAX
    ? `${text.slice(0, PREVIEW_MAX)}\n…（內容過長，只顯示前 ${PREVIEW_MAX} 字）`
    : text
}

interface View {
  title: string
  /** 深色區塊的主要內容：指令、檔案路徑、網址… */
  code: string
  /** 深色區塊的第二行（工具名稱、cwd） */
  sub?: string
  /** Claude 給的原因或用途 */
  reason?: string
  warning?: string
  preview?: string
}

function describe(r: PermissionRequest, cwd: string): View {
  const i = r.input
  if (r.toolName === 'Bash') {
    const description = str(i.description)
    return {
      title: 'Claude 想執行這個指令',
      code: `$ ${str(i.command) ?? ''}`,
      sub: `cwd: ${cwd}`,
      reason: description && `原因：${description}`
    }
  }
  if (WRITE_TOOLS.has(r.toolName)) {
    const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? ''
    return {
      title: 'Claude 想修改這個檔案',
      code: relativeTo(cwd, path),
      sub: `${r.toolName} · cwd: ${cwd}`,
      warning: '這個檔案會影響 Claude 的權限或 git 設定',
      preview: writePreview(i)
    }
  }
  if (r.toolName === 'WebFetch') {
    const prompt = str(i.prompt)
    return {
      title: 'Claude 想讀取這個網頁',
      code: str(i.url) ?? '',
      sub: 'WebFetch',
      reason: prompt && `用途：${prompt}`
    }
  }
  if (r.toolName === 'WebSearch')
    return { title: 'Claude 想搜尋網路', code: str(i.query) ?? '', sub: 'WebSearch' }
  return {
    title: `Claude 想使用 ${r.toolName}`,
    code: JSON.stringify(i, null, 2),
    sub: `cwd: ${cwd}`
  }
}

/** 對照 `B4-Implement.dc.html` 的 dialog；蓋在所在的 `<main>`（需要 relative）上 */
export function PermissionDialog({ request: r, cwd }: { request: PermissionRequest; cwd: string }) {
  const act = useStore((s) => s.act)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [remember, setRemember] = useState(false)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, run] = usePending()
  const v = describe(r, cwd)

  // 出現時把焦點移進對話框（使用者可能正在輸入框打字）；刻意不放在「允許」上，免得按 Enter 就核准
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

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

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-ink/28 p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-[20px] bg-surface p-6 shadow-dialog outline-none"
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-decision-ink">需要你的核准</span>
          <span id={titleId} className="text-lg font-bold">
            {v.title}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl bg-code px-4 py-3.5 font-mono text-[13px] text-code-ink">
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
          <pre
            aria-label="要寫入的內容"
            className="m-0 max-h-40 overflow-auto rounded-xl bg-fill-2 px-3.5 py-2.5 font-mono text-xs break-all whitespace-pre-wrap text-ink-2"
          >
            {v.preview}
          </pre>
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
              placeholder="告訴 Claude 為什麼不行、該怎麼做（選填）"
              className={textareaClass}
            />
            <div className="flex justify-end gap-2.5">
              <Button disabled={pending} onClick={() => setDenying(false)}>
                返回
              </Button>
              <Button variant="dark" disabled={pending} onClick={() => void resolve(false)}>
                送出拒絕
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2.5">
            <Button className="px-[18px]" disabled={pending} onClick={() => setDenying(true)}>
              拒絕並說明
            </Button>
            <Button
              variant="primary"
              className="px-[22px]"
              disabled={pending}
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
 * 以 id 為 key：換下一個請求時勾選、拒絕原因等狀態重新開始。
 */
export function PendingPermission({ task }: { task: Task }) {
  const r = task.pendingPermission
  if (!r) return null
  return <PermissionDialog key={r.id} request={r} cwd={task.worktreePath} />
}
