// src/renderer/src/report/DiffView.tsx
import { memo, useCallback, useMemo, useState } from 'react'
import { type DiffFile, type DiffHunk, parseUnifiedDiff } from '@shared/diff'
import type { ReportInput } from '@shared/report'
import type { DiffStats } from '@shared/types'
import { InlineCode } from '../components/Markdown'
import { cx, Pill } from '../components/ui'
import { useStore } from '../store'
import { diffAnchor, fileAnchor } from './anchors'
import { CommentButton, CommentForm, FeedbackNote } from './comments'
import {
  defaultFile,
  EXPORT_OVER,
  isLockfile,
  lineCount,
  TRUNCATE_OVER,
  TRUNCATED_LINES
} from './diffFiles'

type Note = ReportInput['file_notes'][number]
type HunkNote = Note['hunks'][number]
type PerFile = DiffStats['perFile']
/** 正在對哪裡留言：新檔行號，或整個檔案 */
type Commenting = number | 'file'

const EMPTY_NOTES: HunkNote[] = []

/**
 * 段落說明（行號是新檔的）放在範圍內第一個顯示出來的行之前（鍵為 `段落:行`）；
 * 範圍內沒有任何顯示出來的行（例如只刪除、或 Claude 給的行號不在 diff 裡）就列在檔案說明下方。
 */
function placeHunkNotes(file: DiffFile, notes: HunkNote[]) {
  const before = new Map<string, HunkNote[]>()
  const placed = new Set<HunkNote>()
  file.hunks.forEach((h, hi) =>
    h.lines.forEach((l, li) => {
      if (l.newNo === undefined) return
      for (const n of notes) {
        if (placed.has(n) || l.newNo < n.line_start || l.newNo > n.line_end) continue
        placed.add(n)
        const key = `${hi}:${li}`
        before.set(key, [...(before.get(key) ?? []), n])
      }
    })
  )
  return { before, rest: notes.filter((n) => !placed.has(n)) }
}

/** 檔案標籤上的增刪行數；二進位檔（都是 0）不顯示 */
const statText = (s?: PerFile[number]) =>
  s && (s.additions || s.deletions)
    ? ` +${s.additions}${s.deletions ? ` −${s.deletions}` : ''}`
    : ''

const STATUS_LABEL: Partial<Record<DiffFile['status'], string>> = {
  added: '新增',
  deleted: '刪除',
  renamed: '改名'
}

/** 一個段落的行。memo：打開某一行的留言時，其他段落不重新 render */
const HunkRows = memo(function HunkRows({
  path,
  hunk,
  hunkIndex,
  limit,
  notesBefore,
  feedback,
  commenting,
  isStatic,
  interactive,
  onOpen,
  onSubmit,
  onCancel
}: {
  path: string
  hunk: DiffHunk
  hunkIndex: number
  /** 只畫前幾行（截斷顯示時） */
  limit: number
  notesBefore: Map<string, HunkNote[]>
  /** 待送出的回饋，以錨點為鍵；唯讀時沒有 */
  feedback?: Map<string, string>
  /** 正在留言的行（只有在這個段落裡時才給） */
  commenting?: number
  isStatic?: boolean
  interactive: boolean
  onOpen: (line: number) => void
  onSubmit: (line: number, text: string) => void
  onCancel: () => void
}) {
  return (
    <div>
      <div className="px-3 whitespace-pre text-code-line">{hunk.header}</div>
      {hunk.lines.slice(0, limit).map((l, li) => {
        const n = l.newNo
        const anchor = n !== undefined ? diffAnchor(path, n) : undefined
        const fb = anchor ? feedback?.get(anchor) : undefined
        return (
          <div key={li} data-anchor={isStatic ? undefined : anchor}>
            {notesBefore.get(`${hunkIndex}:${li}`)?.map((x, i) => (
              <div
                key={i}
                className="mx-3 my-1 rounded-lg bg-brand-deep px-3 py-1.5 font-sans text-xs leading-relaxed text-brand-soft"
              >
                <span className="font-medium">
                  為什麼（第 {x.line_start}–{x.line_end} 行）：
                </span>
                <InlineCode text={x.why} />
              </div>
            ))}
            <div
              className={cx(
                'grid grid-cols-[52px_minmax(0,1fr)]',
                l.type === 'add' && 'bg-diff-add/14',
                l.type === 'del' && 'bg-diff-del/16',
                fb !== undefined && 'bg-diff-flag/22 shadow-[inset_3px_0_0_var(--color-diff-flag)]'
              )}
            >
              {n !== undefined && interactive ? (
                <button
                  type="button"
                  data-line
                  aria-label={`對第 ${n} 行留言`}
                  onClick={() => onOpen(n)}
                  className="cursor-pointer pr-3 text-right text-code-line hover:text-white"
                >
                  {n}
                </button>
              ) : (
                // 刪除的行沒有新檔行號：顯示舊檔行號，顏色淡一點
                <span
                  data-line
                  className={cx(
                    'pr-3 text-right select-none',
                    n === undefined ? 'text-code-line/60' : 'text-code-line'
                  )}
                >
                  {n ?? l.oldNo}
                </span>
              )}
              <span className="whitespace-pre">
                {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
                {l.text}
              </span>
            </div>
            {n !== undefined && commenting === n ? (
              <CommentForm
                dark
                initial={fb}
                placeholder="這一行要怎麼改？"
                onSubmit={(text) => onSubmit(n, text)}
                onCancel={onCancel}
                className="my-1.5 mr-3 ml-[52px]"
              />
            ) : (
              fb !== undefined && (
                <FeedbackNote
                  title={`回饋 · 第 ${n} 行`}
                  text={fb}
                  className="my-1.5 mr-3 ml-[52px]"
                />
              )
            )}
          </div>
        )
      })}
    </div>
  )
})

const notice = (text: string) => (
  <div className="rounded-xl bg-fill-2 px-3.5 py-3 text-[13px] text-muted">{text}</div>
)

/**
 * 一個檔案的 diff：檔頭（狀態、改名、對整個檔案留言）、檔案說明、段落說明、每一行。
 * memo：報告其他地方的狀態（例如區塊留言）改變時不重新 render 整個 diff。
 * 很長的檔案先只畫前 TRUNCATED_LINES 行；匯出時太長的檔案與鎖定檔只放摘要。
 */
const FileDiff = memo(function FileDiff({
  taskId,
  file,
  note,
  stats,
  readOnly,
  isStatic,
  focusLine
}: {
  taskId: string
  file: DiffFile
  note?: Note
  stats?: PerFile[number]
  readOnly?: boolean
  isStatic?: boolean
  /** 要捲到的行（從回饋清單跳過來）：在截斷的範圍外時自動展開 */
  focusLine?: number
}) {
  const items = useStore((s) => s.feedback[taskId])
  const addFeedback = useStore((s) => s.addFeedback)
  const [commenting, setCommenting] = useState<Commenting>()
  const [expanded, setExpanded] = useState(false)
  const interactive = !readOnly && !isStatic
  const { before, rest } = useMemo(
    () => placeHunkNotes(file, note?.hunks ?? EMPTY_NOTES),
    [file, note]
  )
  // 唯讀（舊版本、回看、匯出）不顯示待送出的回饋：那些是針對最新版本留的
  const feedback = useMemo(
    () => (interactive ? new Map(items?.map((f) => [f.anchor, f.text])) : undefined),
    [items, interactive]
  )
  const total = useMemo(() => lineCount(file), [file])
  const path = file.path

  const openLine = useCallback((line: number) => setCommenting(line), [])
  const cancel = useCallback(() => setCommenting(undefined), [])
  const submitLine = useCallback(
    (line: number, text: string) => {
      addFeedback(taskId, { anchor: diffAnchor(path, line), label: `${path}:${line}`, text })
      setCommenting(undefined)
    },
    [addFeedback, taskId, path]
  )

  const truncated = !isStatic && total > TRUNCATE_OVER
  const showAll =
    !truncated ||
    expanded ||
    (focusLine !== undefined && focusIndex(file, focusLine) >= TRUNCATED_LINES)
  const summarized = isStatic && (isLockfile(path) || total > EXPORT_OVER)
  const fileFeedback = feedback?.get(fileAnchor(path))
  const limits = hunkLimits(file, showAll ? Infinity : TRUNCATED_LINES)

  return (
    <div className="flex flex-col gap-3.5">
      <div data-anchor={isStatic ? undefined : fileAnchor(path)} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {/* 匯出時沒有檔案標籤，檔名用標題 */}
          {isStatic ? (
            <h3 className="m-0 font-mono text-[13px] font-medium">
              {path}
              <span className="font-normal text-muted">{statText(stats)}</span>
            </h3>
          ) : (
            <span className="font-mono text-[13px] font-medium">{path}</span>
          )}
          {STATUS_LABEL[file.status] && <Pill tone="muted">{STATUS_LABEL[file.status]}</Pill>}
          {file.status === 'renamed' && file.oldPath && (
            <span className="text-xs text-muted">
              從 <code>{file.oldPath}</code> 改名
            </span>
          )}
          {interactive && (
            <CommentButton
              text="對此檔案留言"
              onClick={() => setCommenting('file')}
              className="ml-auto"
            />
          )}
        </div>
        {commenting === 'file' ? (
          <CommentForm
            initial={fileFeedback}
            placeholder={`對 ${path} 整個檔案的回饋…`}
            onSubmit={(text) => {
              addFeedback(taskId, { anchor: fileAnchor(path), label: path, text })
              setCommenting(undefined)
            }}
            onCancel={cancel}
          />
        ) : (
          fileFeedback !== undefined && <FeedbackNote title="回饋 · 整個檔案" text={fileFeedback} />
        )}
      </div>
      {(note || rest.length > 0) && (
        <div className="flex flex-col gap-1 rounded-xl bg-brand-tint px-3.5 py-3 text-[13px] text-brand-deep">
          {note && (
            <div>
              <span className="font-bold">為什麼：</span>
              <InlineCode text={note.why} />
            </div>
          )}
          {rest.map((n, i) => (
            <div key={i}>
              <span className="font-medium">
                第 {n.line_start}–{n.line_end} 行：
              </span>
              <InlineCode text={n.why} />
            </div>
          ))}
        </div>
      )}
      {file.binary ? (
        notice('二進位檔案，不顯示內容')
      ) : file.hunks.length === 0 ? (
        notice(
          file.status === 'added'
            ? '新增的空白檔案'
            : file.status === 'deleted'
              ? '刪除的空白檔案'
              : '只有檔名或權限變更'
        )
      ) : summarized ? (
        notice(`此檔案變更 ${total} 行，未包含在匯出中`)
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl bg-code py-1.5 font-mono text-[12.5px] leading-[1.8] text-code-ink">
            {file.hunks.map((h, hi) => {
              const limit = limits[hi]
              if (limit === 0) return null
              const here =
                typeof commenting === 'number' && h.lines.some((l) => l.newNo === commenting)
                  ? commenting
                  : undefined
              return (
                <HunkRows
                  key={hi}
                  path={path}
                  hunk={h}
                  hunkIndex={hi}
                  limit={limit}
                  notesBefore={before}
                  feedback={feedback}
                  commenting={here}
                  isStatic={isStatic}
                  interactive={interactive}
                  onOpen={openLine}
                  onSubmit={submitLine}
                  onCancel={cancel}
                />
              )
            })}
          </div>
          {!showAll && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="cursor-pointer self-start rounded-lg bg-fill px-3 py-1.5 text-xs text-ink-2 hover:bg-chip"
            >
              顯示全部（共 {total} 行）
            </button>
          )}
        </>
      )}
    </div>
  )
})

/** 截斷顯示時每個段落畫幾行：從頭開始一共畫 max 行 */
function hunkLimits(file: DiffFile, max: number): number[] {
  let remaining = max
  return file.hunks.map((h) => {
    const n = Math.min(h.lines.length, remaining)
    remaining -= n
    return n
  })
}

/** 某個新檔行號在檔案 diff 裡是第幾行（找不到時回傳 -1） */
function focusIndex(file: DiffFile, line: number): number {
  let i = 0
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.newNo === line) return i
      i++
    }
  }
  return -1
}

/**
 * 程式碼變更：上方是檔案標籤，下方是選取檔案的 diff。選取的檔案由外部控制（selected／onSelect），
 * 沒有選或選的檔案不在 diff 裡時，預設第一個不是自動產生的檔案。
 * isStatic（匯出 HTML）時沒有 script 可以切換，依序列出所有檔案。
 */
export function DiffView({
  taskId,
  diff,
  perFile,
  notes,
  selected,
  focusLine,
  onSelect,
  readOnly,
  isStatic
}: {
  taskId: string
  diff: string
  perFile: PerFile
  notes: Note[]
  selected?: string
  /** 選取檔案裡要捲到的行（從回饋清單跳過來） */
  focusLine?: number
  onSelect?: (path: string) => void
  readOnly?: boolean
  isStatic?: boolean
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  const file = files.find((f) => f.path === selected) ?? defaultFile(files)
  const statsOf = (path: string) => perFile.find((p) => p.path === path)
  const noteOf = (path: string) => notes.find((n) => n.path === path)

  if (!file) return <span className="text-[13px] text-muted">沒有程式碼變更</span>
  if (isStatic)
    return (
      <div className="flex flex-col gap-7">
        {files.map((f) => (
          <FileDiff
            key={f.path}
            taskId={taskId}
            file={f}
            note={noteOf(f.path)}
            stats={statsOf(f.path)}
            readOnly
            isStatic
          />
        ))}
      </div>
    )
  return (
    <div className="flex flex-col gap-3.5">
      <div role="group" aria-label="變更的檔案" className="flex flex-wrap gap-1.5 text-xs">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            aria-pressed={f.path === file.path}
            onClick={() => onSelect?.(f.path)}
            className={cx(
              'cursor-pointer rounded-full px-3 py-1.5 font-mono',
              f.path === file.path ? 'bg-ink text-white' : 'bg-fill hover:bg-chip'
            )}
          >
            {f.path}
            {statText(statsOf(f.path))}
          </button>
        ))}
      </div>
      {/* key：換檔案時關掉正在輸入的留言、收起展開的長檔案 */}
      <FileDiff
        key={file.path}
        taskId={taskId}
        file={file}
        note={noteOf(file.path)}
        readOnly={readOnly}
        focusLine={file.path === selected ? focusLine : undefined}
      />
    </div>
  )
}
