// src/renderer/src/report/DiffView.tsx
import { useMemo, useState } from 'react'
import { type DiffFile, parseUnifiedDiff } from '@shared/diff'
import type { ReportInput } from '@shared/report'
import type { DiffStats } from '@shared/types'
import { InlineCode } from '../components/Markdown'
import { cx } from '../components/ui'
import { useStore } from '../store'
import { diffAnchor } from './anchors'
import { CommentForm, FeedbackNote } from './comments'

type Note = ReportInput['file_notes'][number]
type HunkNote = Note['hunks'][number]
type PerFile = DiffStats['perFile']

/**
 * 段落說明（行號是新檔的）放在範圍內第一個顯示出來的行之前；
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

/** 一個檔案的 diff：檔案說明、段落說明、每一行（可以點行號留言） */
function FileDiff({
  taskId,
  file,
  note,
  stats,
  readOnly,
  heading
}: {
  taskId: string
  file: DiffFile
  note?: Note
  stats?: PerFile[number]
  readOnly?: boolean
  /** 匯出時每個檔案前面加上檔名標題 */
  heading?: boolean
}) {
  const items = useStore((s) => s.feedback[taskId])
  const addFeedback = useStore((s) => s.addFeedback)
  const [commenting, setCommenting] = useState<number>()
  const { before, rest } = placeHunkNotes(file, note?.hunks ?? [])
  // 唯讀（舊版本、回看、匯出）不顯示待送出的回饋：那些是針對最新版本留的
  const feedbackOf = (line: number) =>
    readOnly ? undefined : items?.find((f) => f.anchor === diffAnchor(file.path, line))?.text

  return (
    <div className="flex flex-col gap-3.5">
      {heading && (
        <h3 className="m-0 font-mono text-[13px] font-medium">
          {file.path}
          <span className="font-normal text-muted">{statText(stats)}</span>
        </h3>
      )}
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
        <div className="rounded-xl bg-fill-2 px-3.5 py-3 text-[13px] text-muted">
          二進位檔案，不顯示內容
        </div>
      ) : file.hunks.length === 0 ? (
        <div className="rounded-xl bg-fill-2 px-3.5 py-3 text-[13px] text-muted">
          {file.status === 'added'
            ? '新增的空白檔案'
            : file.status === 'deleted'
              ? '刪除的空白檔案'
              : '只有檔名或權限變更'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-code py-1.5 font-mono text-[12.5px] leading-[1.8] text-code-ink">
          {file.hunks.map((h, hi) => (
            <div key={hi}>
              <div className="px-3 whitespace-pre text-code-line">{h.header}</div>
              {h.lines.map((l, li) => {
                const n = l.newNo
                const fb = n !== undefined ? feedbackOf(n) : undefined
                return (
                  <div
                    key={li}
                    data-anchor={n !== undefined ? diffAnchor(file.path, n) : undefined}
                  >
                    {before.get(`${hi}:${li}`)?.map((x, i) => (
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
                        fb !== undefined &&
                          'bg-diff-flag/22 shadow-[inset_3px_0_0_var(--color-diff-flag)]'
                      )}
                    >
                      {n !== undefined && !readOnly ? (
                        <button
                          type="button"
                          data-line
                          aria-label={`對第 ${n} 行留言`}
                          onClick={() => setCommenting(n)}
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
                        onSubmit={(text) => {
                          addFeedback(taskId, {
                            anchor: diffAnchor(file.path, n),
                            label: `${file.path}:${n}`,
                            text
                          })
                          setCommenting(undefined)
                        }}
                        onCancel={() => setCommenting(undefined)}
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
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 程式碼變更：上方是檔案標籤，下方是選取檔案的 diff。
 * isStatic（匯出 HTML）時沒有 script 可以切換，依序列出所有檔案。
 */
export function DiffView({
  taskId,
  diff,
  perFile,
  notes,
  selected,
  onSelect,
  readOnly,
  isStatic
}: {
  taskId: string
  diff: string
  perFile: PerFile
  notes: Note[]
  /** 由外部控制選取的檔案（例如點架構圖的方塊） */
  selected?: string
  onSelect?: (path: string) => void
  readOnly?: boolean
  isStatic?: boolean
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  const [own, setOwn] = useState<string>()
  const current = selected ?? own
  const file = files.find((f) => f.path === current) ?? files[0]
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
            heading
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
            onClick={() => {
              setOwn(f.path)
              onSelect?.(f.path)
            }}
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
      {/* key：換檔案時關掉正在輸入的留言 */}
      <FileDiff
        key={file.path}
        taskId={taskId}
        file={file}
        note={noteOf(file.path)}
        readOnly={readOnly}
      />
    </div>
  )
}
