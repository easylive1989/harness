// src/renderer/src/report/TestsSection.tsx
// 報告最優先的區塊「新增的測試」：Claude 說明的每個測試（情境、修改原因）、
// 對應的驗證結果（Harness 實際執行的指令整體結果，不捏造逐個測試的結果），
// 以及 Harness 從 diff 偵測到、Claude 沒說明的測試檔。外框（標題、留言）由 ReportView 的 Section 提供。
import { type ReactNode, useMemo } from 'react'
import { type DiffFile, parseUnifiedDiff } from '@shared/diff'
import type { TestNote } from '@shared/report'
import type { VerificationResult } from '@shared/types'
import { InlineCode } from '../components/Markdown'
import { cx, Icons, Pill } from '../components/ui'
import { testAnchor } from './anchors'
import {
  coveringRuns,
  normalizeTestPath,
  type RunState,
  runState,
  undocumentedTestFiles
} from './testItems'

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
 * 一個測試的驗證結果：輸出提到這個測試檔的指令，或只有一個驗證指令時，顯示那個指令的結果；
 * 否則顯示全部驗證的整體結果，連到「測試結果」。
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
  const covering = coveringRuns(file, runs)
  const shown = covering.length ? covering : runs.length === 1 ? runs : undefined
  let body: ReactNode
  if (runs.length === 0) body = <span className="text-muted">沒有驗證指令</span>
  else if (shown)
    body = shown.map((v, i) => {
      const state = runState(v)
      return (
        <span
          key={i}
          title={v.skipped}
          className={cx('flex min-w-0 items-center gap-1', RUN_TEXT[state])}
        >
          <RunIcon state={state} />
          <code className="min-w-0 truncate bg-transparent p-0 text-inherit">{v.command}</code>{' '}
          {runLabel(v)}
        </span>
      )
    })
  else {
    const ran = runs.filter((v) => !v.skipped)
    const passed = ran.filter((v) => v.exitCode === 0).length
    const skipped = runs.length - ran.length
    const state: RunState = !ran.length ? 'skipped' : passed === ran.length ? 'passed' : 'failed'
    const link = 'cursor-pointer text-brand hover:text-brand-hover'
    body = (
      <>
        <span className={cx('flex items-center gap-1', RUN_TEXT[state])}>
          <RunIcon state={state} />
          {ran.length ? `${passed} / ${ran.length} 通過` : '未執行'}
        </span>
        {skipped > 0 && ran.length > 0 && <span className="text-muted"> · 略過 {skipped}</span>}
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

/** 檔案在這次的 diff 裡、而且不是匯出檔時可以點：跳到 diff 裡的那個檔案（與行） */
function JumpTarget({
  path,
  line,
  enabled,
  onJump,
  children
}: {
  path: string
  line?: number
  enabled: boolean
  onJump?: (path: string, line?: number) => void
  children: ReactNode
}) {
  const layout = 'flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left'
  return onJump && enabled ? (
    <button
      type="button"
      title="在程式碼變更中查看"
      onClick={() => onJump(path, line)}
      className={cx(layout, 'group cursor-pointer')}
    >
      {children}
    </button>
  ) : (
    <div className={layout}>{children}</div>
  )
}

export function TestsSection({
  tests,
  note,
  diff,
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
  diff: string
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
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  const paths = useMemo(() => new Set(files.map((f) => f.path)), [files])
  const undocumented = useMemo(
    () => undocumentedTestFiles(files, tests, root),
    [files, tests, root]
  )
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
        <div className="flex gap-2.5 rounded-xl bg-decision px-3.5 py-3 text-[13px]">
          <Icons.Info className="mt-[3px] flex-none text-decision-ink" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-decision-ink">
              {undocumentedAdded ? 'Claude 沒有說明新增的測試' : '這次沒有新增測試'}
            </span>
            <span className="text-decision-body">
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
        const anchor = testAnchor(t.id)
        const path = normalizeTestPath(t.file, root)
        const inDiff = paths.has(path)
        return (
          <div
            key={t.id}
            data-anchor={anchorAttr(anchor)}
            className="flex min-w-0 flex-col gap-2 rounded-[14px] p-4 shadow-[0_0_0_1px_var(--color-chip)]"
          >
            <div className="flex items-start gap-3">
              <JumpTarget
                path={path}
                line={t.line}
                enabled={inDiff}
                onJump={isStatic ? undefined : onJump}
              >
                <span className="font-bold group-hover:text-brand">
                  <InlineCode text={t.name} />
                </span>
                <span className="font-mono text-xs break-all text-muted">
                  {t.line ? `${path}:${t.line}` : path}
                  {!inDiff && <span className="font-sans">（不在這次的變更中）</span>}
                </span>
              </JumpTarget>
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
            <TestVerification
              file={path}
              runs={runs}
              isStatic={isStatic}
              onShowResults={onShowResults}
            />
            {slot(anchor, t.name)}
          </div>
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
                <JumpTarget path={f.path} enabled onJump={isStatic ? undefined : onJump}>
                  <span className="font-mono break-all group-hover:text-brand">{f.path}</span>
                </JumpTarget>
                <span className="flex flex-none items-center gap-1">
                  <Pill tone="muted">{FILE_STATUS[f.status]}</Pill>
                  <Pill tone="decision">未說明</Pill>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
