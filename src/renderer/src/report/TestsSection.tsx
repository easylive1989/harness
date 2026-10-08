// src/renderer/src/report/TestsSection.tsx
// 報告最優先的區塊「新增的測試」：Claude 說明的每個測試（情境、修改原因）、
// 對應的驗證結果（Harness 實際執行的指令整體結果，不捏造逐個測試的結果），
// 以及 Harness 從 diff 偵測到、Claude 沒說明的測試檔。外框（標題、留言）由 ReportView 的 Section 提供。
import { type ReactNode, useId } from 'react'
import type { DiffFile } from '@shared/diff'
import type { TestNote } from '@shared/report'
import { resolveTestPath } from '@shared/testFiles'
import type { VerificationResult } from '@shared/types'
import { InlineCode } from '../components/Markdown'
import { cx, Icons, Pill } from '../components/ui'
import { testAnchor } from './anchors'
import { type RunState, runState, testVerdict } from './testItems'

const KIND_LABEL: Record<TestNote['kind'], string> = {
  unit: '單元',
  integration: '整合',
  e2e: '端對端',
  other: '其他'
}
const FILE_STATUS: Record<DiffFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '刪除',
  renamed: '改名'
}
const RUN_TEXT: Record<RunState, string> = {
  passed: 'text-brand-ink',
  failed: 'text-danger',
  skipped: 'text-muted'
}

function RunIcon({ state }: { state: RunState }) {
  const p = { width: 13, height: 13, strokeWidth: 2.5 }
  if (state === 'passed') return <Icons.Check {...p} className="flex-none text-brand" />
  if (state === 'failed') return <Icons.X {...p} className="flex-none text-danger" />
  return <Icons.Minus {...p} className="flex-none text-muted" />
}

function runLabel(v: VerificationResult): string {
  const s = runState(v)
  if (s === 'passed') return '通過'
  if (s === 'skipped') return '未執行'
  return v.exitCode === null ? '未完成' : `失敗（exit ${v.exitCode}）`
}

/**
 * 一個測試的驗證結果（規則見 testVerdict）：指令的結果附通過／失敗的顏色；
 * 只有整體數字時用中性的樣式（那些指令不一定跟這個測試有關），連到「測試結果」。
 */
function TestVerification({
  file,
  runs,
  isStatic,
  onShowResults
}: {
  file: string
  runs: VerificationResult[]
  isStatic?: boolean
  onShowResults?: () => void
}) {
  const verdict = testVerdict(file, runs)
  let body: ReactNode
  if (!verdict) body = <span className="text-muted">沒有驗證指令</span>
  else if ('runs' in verdict)
    body = verdict.runs.map((v, i) => {
      const state = runState(v)
      return (
        <span
          key={i}
          title={v.skipped}
          className={cx('flex min-w-0 items-center gap-1', RUN_TEXT[state])}
        >
          <RunIcon state={state} />
          <code title={v.command} className="min-w-0 truncate bg-transparent p-0 text-inherit">
            {v.command}
          </code>{' '}
          {runLabel(v)}
        </span>
      )
    })
  else {
    const { ran, passed, skipped } = verdict.summary
    const link = 'cursor-pointer text-brand hover:text-brand-hover'
    body = (
      <>
        <span className="text-ink-2">{ran ? `${passed} / ${ran} 通過` : '未執行'}</span>
        {skipped > 0 && ran > 0 && <span className="text-muted"> · 略過 {skipped}</span>}
        {isStatic ? (
          <a href="#report-tests" className={link}>
            查看測試結果
          </a>
        ) : (
          <button type="button" onClick={onShowResults} className={link}>
            查看測試結果
          </button>
        )}
      </>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-muted">驗證：</span>
      {body}
    </div>
  )
}

/** Claude 說明的一個測試：名稱（標題，可以點：跳到 diff 裡的測試檔與行）、檔案、標籤、情境、修改原因、驗證 */
function TestItem({
  test: t,
  path,
  inDiff,
  runs,
  isStatic,
  anchorAttr,
  button,
  slot,
  onJump,
  onShowResults
}: {
  test: TestNote
  path: string
  inDiff: boolean
  runs: VerificationResult[]
  isStatic?: boolean
  anchorAttr: (anchor: string) => string | undefined
  button: (anchor: string, label: string, aria?: string) => ReactNode
  slot: (anchor: string, label: string) => ReactNode
  onJump?: (path: string, line?: number) => void
  onShowResults?: () => void
}) {
  const anchor = testAnchor(t.id)
  const whereId = useId()
  const jump = !isStatic && inDiff && onJump
  return (
    <div
      data-anchor={anchorAttr(anchor)}
      className="flex min-w-0 flex-col gap-2 rounded-[14px] p-4 shadow-[0_0_0_1px_var(--color-chip)]"
    >
      <div className="flex items-start gap-3">
        {/* relative：按鈕的 ::after 蓋住名稱與檔案，點檔案也會跳 */}
        <div className="group relative flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <h3 className="m-0 text-sm leading-snug font-bold">
            {jump ? (
              <button
                type="button"
                title="在程式碼變更中查看"
                aria-describedby={whereId}
                onClick={() => onJump(path, t.line)}
                className="cursor-pointer text-left group-hover:text-brand after:absolute after:inset-0 after:content-['']"
              >
                <InlineCode text={t.name} />
              </button>
            ) : (
              <InlineCode text={t.name} />
            )}
          </h3>
          <span id={whereId} className="font-mono text-xs break-all text-muted">
            {t.line ? `${path}:${t.line}` : path}
            {!inDiff && <span className="font-sans">（不在這次的變更中）</span>}
          </span>
        </div>
        <span className="flex flex-none items-center gap-1">
          <Pill tone={t.change === 'added' ? 'brand' : 'review'}>
            {t.change === 'added' ? '新增' : '修改'}
          </Pill>
          <Pill tone="muted">{KIND_LABEL[t.kind]}</Pill>
          {button(anchor, t.name, `對測試「${t.name}」留言`)}
        </span>
      </div>
      <div className="text-[13px]">
        <span className="mr-2 font-medium text-brand">情境</span>
        <InlineCode text={t.scenario} />
      </div>
      {t.why && (
        <div className="rounded-[10px] bg-fill-2 px-3 py-2.5 text-[13px] text-ink-2">
          <span className="mr-2 font-medium">為什麼改</span>
          <InlineCode text={t.why} />
        </div>
      )}
      <TestVerification file={path} runs={runs} isStatic={isStatic} onShowResults={onShowResults} />
      {slot(anchor, t.name)}
    </div>
  )
}

export function TestsSection({
  tests,
  note,
  files,
  undocumented,
  root,
  runs,
  isStatic,
  anchorAttr,
  button,
  slot,
  onJump,
  onShowResults
}: {
  tests: TestNote[]
  /** 沒有新增測試的原因（Claude 說明） */
  note?: string
  /** diff 裡的檔案與其中 Claude 沒說明的測試檔（ReportView 算好，概觀的數據也用） */
  files: DiffFile[]
  undocumented: DiffFile[]
  /** worktree 路徑：Claude 給了絕對路徑時去掉 */
  root?: string
  runs: VerificationResult[]
  isStatic?: boolean
  anchorAttr: (anchor: string) => string | undefined
  /** 留言按鈕與留言（不能留言時回傳 false） */
  button: (anchor: string, label: string, aria?: string) => ReactNode
  slot: (anchor: string, label: string) => ReactNode
  onJump?: (path: string, line?: number) => void
  onShowResults?: () => void
}) {
  const paths = files.map((f) => f.path)
  // 新增的在前、修改的在後
  const ordered = [
    ...tests.filter((t) => t.change === 'added'),
    ...tests.filter((t) => t.change === 'modified')
  ]
  const hasAdded = ordered.some((t) => t.change === 'added')
  const undocumentedAdded = undocumented.some((f) => f.status === 'added')

  return (
    <div className="flex flex-col gap-3">
      {!hasAdded && (
        <div className="flex gap-2.5 rounded-xl bg-warn-soft px-3.5 py-3 text-[13px]">
          <Icons.Info className="mt-[3px] flex-none text-warn" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-warn">
              {undocumentedAdded ? 'Claude 沒有說明新增的測試' : '這次沒有新增測試'}
            </span>
            <span className="text-ink-2">
              {note ? (
                <InlineCode text={note} />
              ) : undocumentedAdded ? (
                '下方列出 diff 裡的測試檔，情境請看程式碼。'
              ) : (
                'Claude 沒有說明原因。'
              )}
            </span>
          </div>
        </div>
      )}
      {ordered.map((t) => {
        const path = resolveTestPath(t.file, paths, root)
        return (
          <TestItem
            key={t.id}
            test={t}
            path={path}
            inDiff={paths.includes(path)}
            runs={runs}
            isStatic={isStatic}
            anchorAttr={anchorAttr}
            button={button}
            slot={slot}
            onJump={onJump}
            onShowResults={onShowResults}
          />
        )
      })}
      {undocumented.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted">
            Harness 在 diff 裡偵測到這些測試檔，Claude 沒有說明情境：
          </span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {undocumented.map((f) => (
              <li
                key={f.path}
                className="flex items-center gap-3 rounded-xl bg-fill-2 px-3.5 py-2.5 text-[13px]"
              >
                {isStatic || !onJump ? (
                  <span className="min-w-0 flex-1 font-mono break-all">{f.path}</span>
                ) : (
                  <button
                    type="button"
                    title="在程式碼變更中查看"
                    onClick={() => onJump(f.path)}
                    className="min-w-0 flex-1 cursor-pointer text-left font-mono break-all hover:text-brand"
                  >
                    {f.path}
                  </button>
                )}
                <span className="flex flex-none items-center gap-1">
                  <Pill tone="muted">{FILE_STATUS[f.status]}</Pill>
                  <Pill tone="warn">未說明</Pill>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
