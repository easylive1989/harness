// src/renderer/src/report/ReportView.tsx
// 對照 docs/design/B5-Report.dc.html 的 <main>；isStatic 給匯出 HTML 用，不含任何互動控制
import { type ReactNode, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { parseUnifiedDiff } from '@shared/diff'
import { layoutGraph } from '@shared/layout'
import { wrapBlockHtml } from '@shared/blockHtml'
import type { ReportInput } from '@shared/report'
import { undocumentedTestFiles } from '@shared/testFiles'
import type { Report, Task, VerificationResult } from '@shared/types'
import { InlineCode } from '../components/Markdown'
import { cx, Icons, Pill } from '../components/ui'
import { shortTime } from '../lib/format'
import { useStore } from '../store'
import { reveal } from '../lib/reveal'
import { diffAnchor, fileAnchor, findAnchor } from './anchors'
import { ArchitectureDiagram, MIN_SCALE } from './ArchitectureDiagram'
import { BLOCK_DEFAULT_H } from './blocks'
import { CommentButton, CommentForm, FeedbackNote } from './comments'
import { CustomBlockFrame } from './CustomBlockFrame'
import { DiffView } from './DiffView'
import { runState, summarizeRuns } from './testItems'
import { TestsSection } from './TestsSection'

type Decision = ReportInput['decisions'][number]
type Limitation = ReportInput['limitations'][number]

/** 報告的一個區塊（白底卡片）；data-anchor 讓回饋清單可以捲到這裡 */
function Section({
  id,
  anchor,
  title,
  tag,
  end,
  subtitle,
  className,
  children
}: {
  id: string
  anchor?: string
  title: string
  /** 緊接在標題後面（例如「Claude 自訂視覺化」） */
  tag?: ReactNode
  /** 靠右（圖例、留言按鈕） */
  end?: ReactNode
  subtitle?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section
      id={`report-${id}`}
      data-anchor={anchor}
      aria-label={title}
      className={cx('flex flex-col gap-4 rounded-2xl bg-surface p-7 shadow-card', className)}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="m-0 text-lg font-bold">{title}</h2>
          {tag}
          {end && <div className="ml-auto flex items-center gap-3">{end}</div>}
        </div>
        {subtitle && <span className="text-xs text-muted">{subtitle}</span>}
      </div>
      {children}
    </section>
  )
}

/** 某個錨點的留言：正在輸入時顯示輸入框，否則顯示已留下的意見（沒有就不顯示） */
function CommentSlot({
  taskId,
  anchor,
  label,
  open,
  onClose
}: {
  taskId: string
  anchor: string
  label: string
  open: boolean
  onClose: () => void
}) {
  const existing = useStore((s) => s.feedback[taskId]?.find((f) => f.anchor === anchor)?.text)
  const addFeedback = useStore((s) => s.addFeedback)
  if (open)
    return (
      <CommentForm
        initial={existing}
        placeholder={`對「${label}」的回饋…`}
        onSubmit={(text) => {
          addFeedback(taskId, { anchor, label, text })
          onClose()
        }}
        onCancel={onClose}
      />
    )
  return existing === undefined ? null : <FeedbackNote title="回饋" text={existing} />
}

function Stat({
  label,
  className,
  labelClass,
  children
}: {
  label: string
  className?: string
  labelClass?: string
  children: ReactNode
}) {
  return (
    <div className={cx('flex flex-col rounded-[14px] bg-fill-2 px-4 py-3.5', className)}>
      <span className={cx('text-xs text-muted', labelClass)}>{label}</span>
      {/* 數字比格子寬時換行，不會被切掉 */}
      <span className="text-2xl font-bold wrap-anywhere">{children}</span>
    </div>
  )
}

function DecisionSource({
  task,
  source,
  onOpenQuestion
}: {
  task: Task
  source: Decision['source']
  onOpenQuestion?: (questionId: string) => void
}) {
  if (source.type === 'branch') return <Pill tone="decision">來自分岔</Pill>
  if (source.type === 'implementation') return <Pill tone="muted">實作中決定</Pill>
  // 規格回饋、實作中插話或報告回饋中直接給的指示；ref 是 Claude 摘錄的指示
  if (source.type === 'user')
    return (
      <Pill tone="brand" title={source.ref || undefined}>
        你的指示
      </Pill>
    )
  const i = task.questions.findIndex((q) => q.id === source.ref)
  const label = i >= 0 ? `問題 ${i + 1}` : '問題'
  // 點了切到釐清階段並捲到那個問題（回看當時的問答）
  return onOpenQuestion ? (
    <button
      type="button"
      aria-label={`${label}（查看釐清對話）`}
      onClick={() => onOpenQuestion(source.ref)}
      className="cursor-pointer"
    >
      <Pill className="hover:bg-chip">{label}</Pill>
    </button>
  ) : (
    <Pill>{label}</Pill>
  )
}

const SEVERITY: Record<Limitation['severity'], { box: string; body: string; tag: string }> = {
  high: { box: 'bg-danger-soft', body: 'text-ink-2', tag: 'text-danger' },
  medium: { box: 'bg-decision', body: 'text-decision-body', tag: 'text-decision-ink' },
  low: { box: 'bg-fill-2', body: 'text-muted', tag: 'text-muted' }
}
const SEVERITY_LABEL: Record<Limitation['severity'], string> = {
  high: '高風險',
  medium: '中風險',
  low: '低風險'
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`

function VerificationRow({ v }: { v: VerificationResult }) {
  const state = runState(v)
  const status = v.skipped
    ? v.skipped
    : v.exitCode === 0
      ? `通過 · ${seconds(v.durationMs)}`
      : v.exitCode === null
        ? `未完成 · ${seconds(v.durationMs)}`
        : `失敗（exit ${v.exitCode}）· ${seconds(v.durationMs)}`
  const row = (
    <>
      {state === 'passed' ? (
        <Icons.Check className="flex-none text-brand" strokeWidth={2.5} />
      ) : state === 'failed' ? (
        <Icons.X className="flex-none text-danger" strokeWidth={2.5} />
      ) : (
        <Icons.Minus className="flex-none text-muted" strokeWidth={2.5} />
      )}
      <code className="min-w-0 truncate bg-transparent p-0" title={v.command}>
        {v.command}
      </code>
      <span
        className={cx(
          'ml-auto min-w-0 text-right text-xs',
          state === 'passed' ? 'text-brand-ink' : state === 'failed' ? 'text-danger' : 'text-muted'
        )}
      >
        {status}
      </span>
    </>
  )
  const box = cx(
    'rounded-xl px-3.5 py-3',
    state === 'passed' ? 'bg-brand-tint' : state === 'failed' ? 'bg-danger-soft' : 'bg-fill-2'
  )
  if (!v.outputTail) return <div className={cx(box, 'flex items-center gap-3')}>{row}</div>
  // 失敗的輸出預設展開
  return (
    <details className={cx(box, 'group')} open={state === 'failed'}>
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        {row}
        <Icons.Chevron
          width={14}
          height={14}
          className="flex-none text-muted transition-transform group-open:rotate-90"
        />
      </summary>
      <pre className="mt-2.5 mb-0 max-h-64 overflow-auto rounded-lg bg-code p-3 font-mono text-xs whitespace-pre-wrap text-code-ink">
        {v.outputTail}
      </pre>
    </details>
  )
}

export function ReportView({
  task,
  report,
  isStatic,
  canComment,
  diffFile,
  diffLine,
  onDiffFile,
  onOpenQuestion
}: {
  task: Task
  report: Report
  /** 匯出 HTML：沒有按鈕、所有檔案的 diff 都列出來、自訂區塊用 srcdoc */
  isStatic?: boolean
  /** 可以留言（待審閱且正在看最新版本） */
  canComment?: boolean
  /** diff 選取的檔案與要捲到的行（由 ReportScreen 控制） */
  diffFile?: string
  diffLine?: number
  onDiffFile?: (path: string, line?: number) => void
  /** 決策來源的「問題 N」：切到釐清畫面並捲到那個問題 */
  onOpenQuestion?: (questionId: string) => void
}) {
  const r = report.input
  const [commentOn, setCommentOn] = useState<string>()
  const commentable = !isStatic && !!canComment
  // 匯出檔不需要回饋清單捲動用的錨點
  const anchorAttr = (anchor: string) => (isStatic ? undefined : anchor)
  // 前後兩張架構圖用同樣的比例縮放
  const fitWidth = Math.max(
    ...(['before', 'after'] as const).map(
      (side) => layoutGraph(r.architecture[side].nodes, r.architecture[side].edges).width
    )
  )
  // 每欄的基本寬度：放得下縮到 MIN_SCALE 的圖，加上欄內左右留白（p-5）。兩欄並排放不下時
  // flex-wrap 讓「之後」換到下一列，兩欄各佔滿整列（上下排列），圖就不必縮到看不清或被切掉。
  // 只用 CSS：匯出的 HTML 沒有 script 也一樣
  const archColumn = `1 1 ${Math.ceil(fitWidth * MIN_SCALE) + 40}px`
  const changed = new Set(report.stats.perFile.map((f) => f.path))
  const { ran, passed, skipped, state: verifyState } = summarizeRuns(report.verification)
  const allPassed = verifyState === 'passed'
  // 「新增的測試」：diff 裡的檔案、Claude 沒說明的測試檔（大 diff 只解析一次）
  const diffFiles = useMemo(() => parseUnifiedDiff(report.diff), [report.diff])
  const undocumented = useMemo(
    () => undocumentedTestFiles(diffFiles, r.tests, task.worktreePath),
    [diffFiles, r.tests, task.worktreePath]
  )
  const addedTests = r.tests.filter((t) => t.change === 'added').length
  const modifiedTests = r.tests.length - addedTests
  const undocumentedAdded = undocumented.filter((f) => f.status === 'added').length

  const button = (anchor: string, label: string, aria = `對「${label}」留言`) =>
    commentable && <CommentButton label={aria} onClick={() => setCommentOn(anchor)} />
  const slot = (anchor: string, label: string) =>
    commentable && (
      <CommentSlot
        taskId={task.id}
        anchor={anchor}
        label={label}
        open={commentOn === anchor}
        onClose={() => setCommentOn(undefined)}
      />
    )
  const jumpToFile = (path: string) => {
    onDiffFile?.(path)
    document.getElementById('report-diff')?.scrollIntoView?.({ behavior: 'smooth' })
  }
  /** 從「新增的測試」跳到 diff：先畫出選到的檔案（與行），再捲到那一行；找不到那一行就到檔頭 */
  const jumpToTest = (path: string, line?: number) => {
    flushSync(() => onDiffFile?.(path, line))
    const atLine = line === undefined ? undefined : findAnchor(diffAnchor(path, line))
    reveal(atLine ?? findAnchor(fileAnchor(path)), atLine ? 'center' : 'start')
  }
  const showResults = () => reveal(document.getElementById('report-tests'), 'start')

  return (
    <div className="flex flex-col gap-3">
      <section
        id="report-overview"
        data-anchor={anchorAttr('section:overview')}
        aria-label="概觀"
        className="flex flex-col gap-[18px] rounded-2xl bg-surface p-7 shadow-card"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-brand">概觀</span>
            <span className="ml-auto">{button('section:overview', '概觀')}</span>
          </div>
          {slot('section:overview', '概觀')}
          <h1 className="m-0 text-[26px] leading-snug font-bold">{r.overview.headline}</h1>
          <span className="max-w-[720px] whitespace-pre-wrap text-ink-2">
            <InlineCode text={r.overview.summary} />
          </span>
        </div>
        {/* 窄視窗時換行（不會擠到數字被切掉）；寬的時候五格一排 */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-2.5">
          <Stat label="變更檔案">{report.stats.files}</Stat>
          <Stat label="行數">
            <span className="text-ok">+{report.stats.additions}</span>{' '}
            <span className="text-lg text-danger">−{report.stats.deletions}</span>
          </Stat>
          {/* 沒有新增測試時用警示的顏色；Claude 沒說明的新增測試檔另外標出 */}
          <Stat
            label="新增測試"
            className={addedTests ? undefined : 'bg-warn-soft'}
            labelClass={addedTests ? undefined : 'text-warn'}
          >
            {addedTests}
            {modifiedTests > 0 && (
              <span className="ml-1.5 inline-block text-xs font-normal whitespace-nowrap text-muted">
                修改 {modifiedTests}
              </span>
            )}
            {undocumentedAdded > 0 && (
              <span className="ml-1.5 inline-block text-xs font-normal whitespace-nowrap text-warn">
                未說明 {undocumentedAdded}
              </span>
            )}
          </Stat>
          <Stat
            label="驗證"
            className={ran === 0 ? '' : allPassed ? 'bg-brand-tint' : 'bg-danger-soft'}
            labelClass={allPassed ? 'text-brand-muted' : undefined}
          >
            <span className={allPassed ? 'text-brand-ink' : ran ? 'text-danger' : ''}>
              {ran ? `${passed} / ${ran} 通過` : '未執行'}
            </span>
            {skipped > 0 && (
              // 五格並排時可能放不下：整段換到下一行，不在字中間斷開
              <span className="ml-1.5 inline-block text-xs font-normal whitespace-nowrap text-muted">
                略過 {skipped}
              </span>
            )}
          </Stat>
          <Stat label="決策" className="bg-decision" labelClass="text-decision-ink">
            {r.decisions.length}
          </Stat>
        </div>
      </section>

      <Section
        id="new-tests"
        anchor={anchorAttr('section:tests')}
        title="新增的測試"
        end={button('section:tests', '新增的測試')}
        subtitle="情境由 Claude 說明；驗證是 Harness 實際執行指令的整體結果，不是逐個測試的結果。"
      >
        {slot('section:tests', '新增的測試')}
        <TestsSection
          tests={r.tests}
          note={r.tests_note}
          files={diffFiles}
          undocumented={undocumented}
          root={task.worktreePath}
          runs={report.verification}
          isStatic={isStatic}
          anchorAttr={anchorAttr}
          button={button}
          slot={slot}
          onJump={jumpToTest}
          onShowResults={showResults}
        />
      </Section>

      <Section
        id="arch"
        anchor={anchorAttr('section:architecture')}
        title="架構前後對照"
        end={
          <>
            <span className="flex gap-3 text-xs text-ink-2">
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-brand" />
                新增
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-surface shadow-[inset_0_0_0_2px_var(--color-review)]" />
                修改
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-line-soft" />
                未變
              </span>
            </span>
            {button('section:architecture', '架構前後對照')}
          </>
        }
      >
        {slot('section:architecture', '架構前後對照')}
        <div className="flex flex-wrap gap-4">
          {(['before', 'after'] as const).map((side) => (
            <div
              key={side}
              data-arch-side={side}
              className="flex min-w-0 flex-col gap-3 rounded-2xl bg-fill-2 p-5"
              style={{ flex: archColumn }}
            >
              <span
                className={cx(
                  'text-[13px] font-bold',
                  side === 'after' ? 'text-brand' : 'text-muted'
                )}
              >
                {side === 'before' ? '之前' : '之後'}
              </span>
              <ArchitectureDiagram
                graph={r.architecture[side]}
                label={side === 'before' ? '之前的架構' : '之後的架構'}
                fitWidth={fitWidth}
                changedFiles={changed}
                onSelectFile={isStatic ? undefined : jumpToFile}
              />
            </div>
          ))}
        </div>
        {!isStatic && (
          <span className="text-[13px] text-muted">點有變更的方塊可以跳到對應的程式碼變更。</span>
        )}
      </Section>

      <Section id="decisions" title="決策與原因">
        {r.decisions.length === 0 ? (
          <span className="text-[13px] text-muted">沒有記錄的決策</span>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {r.decisions.map((d) => {
              const anchor = `decision:${d.id}`
              const label = `${d.id.toUpperCase()} ${d.title}`
              return (
                <div
                  key={d.id}
                  data-anchor={anchorAttr(anchor)}
                  className="flex min-w-0 flex-col gap-2 rounded-[14px] p-4 shadow-[0_0_0_1px_var(--color-chip)]"
                >
                  {/* 窄視窗時來源標籤與留言換到下一行，標題不會被擠成一字一行 */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-xs text-muted">{d.id.toUpperCase()}</span>
                    <span className="min-w-0 flex-[1_1_7em] font-bold">
                      <InlineCode text={d.title} />
                    </span>
                    <span className="ml-auto flex flex-none items-center gap-1">
                      <DecisionSource
                        task={task}
                        source={d.source}
                        onOpenQuestion={isStatic ? undefined : onOpenQuestion}
                      />
                      {button(anchor, label, `對決策 ${d.id.toUpperCase()} 留言`)}
                    </span>
                  </div>
                  {d.chosen && (
                    <div className="text-[13px]">
                      <span className="mr-2 font-medium text-brand">選擇</span>
                      <InlineCode text={d.chosen} />
                    </div>
                  )}
                  {d.rejected.length > 0 && (
                    <div className="text-[13px] text-muted">
                      <span className="mr-2 font-medium">捨棄</span>
                      <InlineCode text={d.rejected.join('；')} />
                    </div>
                  )}
                  {d.rationale && (
                    <div className="rounded-[10px] bg-fill-2 px-3 py-2.5 text-[13px] text-ink-2">
                      <InlineCode text={d.rationale} />
                    </div>
                  )}
                  {slot(anchor, label)}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {r.custom_blocks.map((b) => (
        <Section
          key={b.id}
          id={`block-${b.id}`}
          anchor={anchorAttr(`block:${b.id}`)}
          title={b.title}
          tag={<Pill>Claude 自訂視覺化</Pill>}
          end={button(`block:${b.id}`, b.title)}
        >
          {slot(`block:${b.id}`, b.title)}
          {isStatic ? (
            // 匯出檔：同一份包裝（CSP 禁止連網、回報高度）放進 srcdoc，一樣只給 allow-scripts
            <iframe
              title={b.title}
              sandbox="allow-scripts"
              srcDoc={wrapBlockHtml(b)}
              data-block={b.id}
              className="block w-full rounded-2xl border-0 bg-fill-2"
              style={{ height: BLOCK_DEFAULT_H }}
            />
          ) : (
            // key：換版本時重新載入、高度重新計算
            <CustomBlockFrame
              key={`${report.version}:${b.id}`}
              taskId={task.id}
              version={report.version}
              id={b.id}
              title={b.title}
            />
          )}
        </Section>
      ))}

      <section
        id="report-limits"
        data-anchor={anchorAttr('section:limitations')}
        aria-label="限制與後續"
        className="flex flex-col gap-4 rounded-2xl bg-surface p-7 shadow-card"
      >
        {slot('section:limitations', '限制與後續')}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex items-center">
              <h2 className="m-0 text-lg font-bold">限制與風險</h2>
              <span className="ml-auto">{button('section:limitations', '限制與後續')}</span>
            </div>
            {r.limitations.length ? (
              r.limitations.map((l, i) => (
                <div
                  key={i}
                  className={cx('rounded-xl px-3.5 py-3 text-[13px]', SEVERITY[l.severity].box)}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">
                      <InlineCode text={l.title} />
                    </span>
                    <span className={cx('ml-auto flex-none text-xs', SEVERITY[l.severity].tag)}>
                      {SEVERITY_LABEL[l.severity]}
                    </span>
                  </div>
                  <span className={SEVERITY[l.severity].body}>
                    <InlineCode text={l.detail} />
                  </span>
                </div>
              ))
            ) : (
              <span className="text-[13px] text-muted">沒有已知的限制</span>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2.5">
            <h2 className="m-0 text-lg font-bold">後續工作</h2>
            {r.followups.length ? (
              r.followups.map((f, i) => (
                <div key={i} className="rounded-xl bg-fill-2 px-3.5 py-3 text-[13px]">
                  <InlineCode text={f.title} />
                  {f.detail && (
                    <span className="text-muted">
                      ：<InlineCode text={f.detail} />
                    </span>
                  )}
                </div>
              ))
            ) : (
              <span className="text-[13px] text-muted">沒有</span>
            )}
          </div>
        </div>
      </section>

      <Section
        id="diff"
        title="程式碼變更"
        tag={
          <span className="text-xs text-muted">
            每段變更都附上「為什麼改」{commentable && '；點行號可以留下回饋'}
          </span>
        }
      >
        <DiffView
          taskId={task.id}
          diff={report.diff}
          perFile={report.stats.perFile}
          notes={r.file_notes}
          selected={diffFile}
          focusLine={diffLine}
          onSelect={onDiffFile}
          readOnly={!commentable}
          isStatic={isStatic}
        />
      </Section>

      <Section
        id="tests"
        title="測試結果"
        subtitle="由 Harness 在 worktree 中實際執行，不是 Claude 的自述。"
      >
        <div className="flex flex-col gap-1.5 text-[13px]">
          {report.verification.length === 0 && (
            <span className="text-muted">Claude 沒有提供驗證指令</span>
          )}
          {report.verification.map((v, i) => (
            <VerificationRow key={i} v={v} />
          ))}
        </div>
      </Section>
    </div>
  )
}

/** 匯出檔最上方的標題（畫面上這些資訊在 ReportScreen 的標題列） */
export function ExportHeader({ task, report }: { task: Task; report: Report }) {
  return (
    <header className="mb-3 flex flex-col gap-1 rounded-2xl bg-surface px-7 py-[18px] shadow-card">
      <span className="text-lg font-bold">{task.title}</span>
      <span className="text-xs text-muted">
        變更報告 v{report.version} · {shortTime(report.createdAt)} · 分支 <code>{task.branch}</code>{' '}
        → <code>{task.baseBranch}</code>
        {report.commit && (
          <>
            {' '}
            · commit <code>{report.commit.slice(0, 7)}</code>
          </>
        )}
      </span>
    </header>
  )
}
