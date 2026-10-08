// src/renderer/src/screens/SpecScreen.tsx
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { type DecisionSource, isBranchMode, type Spec, type Task } from '@shared/types'
import { call } from '../api'
import { InlineCode } from '../components/Markdown'
import { PendingPermission } from '../components/PermissionDialog'
import { Button, cx, inputClass, LiveStatus, Pill, UserInstructionPill } from '../components/ui'
import { blockImeSubmit } from '../lib/ime'
import { currentStage, isBusy } from '../lib/stage'
import { TEST_CHANGE_LABEL, TEST_KIND_LABEL } from '../lib/testLabels'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'

/** 規格的「預計新增的測試」：報告會對照這些編號；舊規格沒有這個欄位時不顯示 */
function PlannedTests({ spec }: { spec: Spec }) {
  const titleId = useId()
  if (!spec.tests) return null
  return (
    <div className="flex flex-col gap-2.5">
      <span id={titleId} className="text-[15px] font-bold">
        預計新增的測試
      </span>
      {spec.tests.length ? (
        <ul aria-labelledby={titleId} className="m-0 flex list-none flex-col gap-2 p-0">
          {spec.tests.map((t) => (
            <li
              key={t.id}
              className="flex flex-col gap-1.5 rounded-[14px] px-4 py-3 shadow-[0_0_0_1px_var(--color-chip)]"
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 font-mono text-xs text-muted">{t.id.toUpperCase()}</span>
                <span className="min-w-0 flex-1 text-sm font-bold">
                  <InlineCode text={t.name} />
                </span>
                <span className="flex flex-none items-center gap-1">
                  <Pill tone={t.change === 'added' ? 'brand' : 'review'}>
                    {TEST_CHANGE_LABEL[t.change]}
                  </Pill>
                  <Pill tone="muted">{TEST_KIND_LABEL[t.kind]}</Pill>
                </span>
              </div>
              <div className="text-[13px]">
                <span className="mr-2 font-medium text-brand">情境</span>
                <InlineCode text={t.scenario} />
              </div>
              {t.file && <span className="font-mono text-xs break-all text-muted">{t.file}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-[13px] text-ink-2">
          這次不新增測試：
          <InlineCode text={spec.testsNote ?? 'Claude 沒有說明原因'} />
        </span>
      )}
    </div>
  )
}

function SourcePill({
  task,
  source,
  onOpenQuestion
}: {
  task: Task
  source: DecisionSource
  onOpenQuestion?: (id: string) => void
}) {
  switch (source.type) {
    case 'branch':
      return <Pill tone="decision">分岔</Pill>
    case 'user':
      // 規格回饋或訊息中直接給的指示；ref 是 Claude 摘錄的指示
      return <UserInstructionPill excerpt={source.ref} />
    case 'implementation':
      return <Pill tone="muted">實作</Pill>
    case 'question': {
      const i = task.questions.findIndex((q) => q.id === source.ref)
      const label = i >= 0 ? `問題 ${i + 1}` : '問題'
      if (!onOpenQuestion) return <Pill>{label}</Pill>
      // 點了切到釐清畫面並捲到那個問題（和報告的決策來源一樣）
      return (
        <button
          type="button"
          aria-label={`${label}（查看釐清對話）`}
          onClick={() => onOpenQuestion(source.ref)}
          className="cursor-pointer"
        >
          <Pill className="hover:bg-chip">{label}</Pill>
        </button>
      )
    }
  }
}

/** 右側的釐清紀錄：已回答的問題與分岔（分岔指向規格裡引用它的決策） */
function ClarifyLog({
  task,
  spec,
  onOpenClarify,
  onOpenQuestion
}: {
  task: Task
  spec: Spec
  onOpenClarify: () => void
  onOpenQuestion: (id: string) => void
}) {
  const answered = task.questions.filter((q) => q.status === 'answered')
  return (
    <aside
      aria-label="釐清紀錄"
      className="flex w-[320px] flex-none flex-col gap-3 overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card"
    >
      <span className="text-[15px] font-bold">釐清紀錄</span>
      <div className="flex flex-col gap-2.5 text-[13px]">
        {answered.length === 0 && task.branches.length === 0 && (
          <span className="text-muted">沒有回答過的問題或分岔。</span>
        )}
        {answered.map((q) => {
          const label = q.answer?.optionId
            ? q.options.find((o) => o.id === q.answer?.optionId)?.label
            : undefined
          const asked = q.followups.filter((f) => f.role === 'user').length
          // 點了切到釐清畫面並捲到那個問題
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => onOpenQuestion(q.id)}
              className="flex cursor-pointer flex-col gap-0.5 rounded-xl bg-fill-2 p-3 text-left hover:bg-fill"
            >
              <span className="text-muted">
                問題 {task.questions.indexOf(q) + 1} · {q.text}
              </span>
              <span className="font-medium">
                {[label, q.answer?.text].filter(Boolean).join('；')}
              </span>
              {asked > 0 && <span className="text-xs text-muted">含 {asked} 次反問</span>}
            </button>
          )
        })}
        {task.branches.map((b) => {
          const d = spec.decisions.find((x) => x.source.type === 'branch' && x.source.ref === b.id)
          return (
            <div key={b.id} className="flex flex-col gap-0.5 rounded-xl bg-decision p-3">
              <span className="text-decision-ink">分岔 · {b.title}</span>
              <span>
                {d
                  ? `→ ${d.id.toUpperCase()}`
                  : b.conclusion
                    ? `→ ${b.conclusion.decision}`
                    : '尚未帶回'}
              </span>
            </div>
          )
        })}
      </div>
      {/* 規格待核准時釐清對話只能回看；要補充需求請用「要求修改」 */}
      <button
        type="button"
        onClick={onOpenClarify}
        className="mt-1 cursor-pointer self-start text-[13px] text-brand hover:text-brand-hover"
      >
        查看釐清對話
      </button>
    </aside>
  )
}

export function SpecScreen({
  task,
  nav,
  readOnly,
  onOpenStage,
  onOpenQuestion
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
  onOpenStage: (s: 'clarify') => void
  /** 決策來源或釐清紀錄的問題：切到釐清畫面並捲到那個問題 */
  onOpenQuestion: (id: string) => void
}) {
  const act = useStore((s) => s.act)
  const decisionsId = useId()
  // 使用者選的版本只在「最新版本」沒變時有效；Claude 提出新版規格時自動顯示最新版
  const latest = task.specs.length
  const [picked, setPicked] = useState<{ latest: number; version: number }>()
  const version = picked?.latest === latest ? picked.version : latest
  const [feedback, setFeedback] = useState('')
  const feedbackRef = useRef<HTMLInputElement>(null)
  // 修改意見還沒送出就按核准時記下那段文字；文字改了就要重新確認（render 時推導）
  const [confirmFor, setConfirmFor] = useState<string>()
  // 核准與要求修改共用：其中一個送出中時兩個都停用
  const [pending, run] = usePending()
  // 有等待中的核准請求時，遮罩後面的內容不能用鍵盤或滑鼠操作
  const masked = !!task.pendingPermission
  const spec = task.specs[version - 1] ?? task.specs.at(-1)

  const header = (
    <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
      <span className="text-lg font-bold">{task.title}</span>
      {nav}
    </div>
  )
  if (!spec)
    return (
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="contents" inert={masked}>
          {header}
          <div className="px-7 text-muted">還沒有規格。</div>
        </div>
        <PendingPermission task={task} />
      </main>
    )

  const answered = task.questions.filter((q) => q.status === 'answered').length
  const concluded = task.branches.filter((b) => b.status === 'concluded').length
  const stage = currentStage(task)
  const approved = stage === 'implement' || stage === 'report'
  const viewingOld = spec.version !== latest
  // Claude 還在這一輪（例如剛提出規格、還沒結束）：等它停下來再核准或要求修改
  const busy = isBusy(task)
  const blocked = pending || busy || viewingOld

  const unsent = feedback.trim()
  const confirming = !!unsent && confirmFor === unsent
  // 修改意見還沒送出就按核准：先提醒，按「放棄意見並核准」才真的核准（連點核准鈕也不會）
  const approve = (discardFeedback = false) => {
    if (unsent && !discardFeedback) {
      setConfirmFor(unsent)
      return
    }
    void run(() => act(() => call('spec:approve', task.id)))
  }
  const requestChanges = (e: FormEvent) => {
    e.preventDefault()
    const text = feedback.trim()
    if (!text || blocked) return
    void run(async () => {
      const ok = await act(async () => {
        await call('spec:requestChanges', task.id, text)
        return true
      })
      // 送出期間又改了內容就保留
      if (ok) setFeedback((cur) => (cur.trim() === text ? '' : cur))
    })
  }

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="contents" inert={masked}>
          {header}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6">
            <div className="mx-auto flex w-full max-w-[800px] flex-col gap-[22px]">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-brand">
                  {approved && !viewingOld ? '已核准的規格' : '規格草稿'}{' '}
                  {task.specs.length > 1 ? (
                    <select
                      aria-label="規格版本"
                      value={spec.version}
                      onChange={(e) => setPicked({ latest, version: Number(e.target.value) })}
                      className="cursor-pointer rounded-md bg-fill px-1.5 py-0.5 outline-none focus-visible:shadow-[0_0_0_2px_var(--color-brand)]"
                    >
                      {task.specs.map((s) => (
                        <option key={s.version} value={s.version}>
                          v{s.version}
                        </option>
                      ))}
                    </select>
                  ) : (
                    `v${spec.version}`
                  )}
                  {/* 釐清紀錄是目前的狀態，不一定是舊版本當時的依據 */}
                  {!viewingOld && ` · 根據 ${answered} 個問題、${concluded} 個分岔整理`}
                </span>
                <h1 className="m-0 text-2xl font-bold">{spec.title}</h1>
                <span className="text-ink-2">
                  <InlineCode text={spec.summary} />
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5 rounded-[14px] bg-brand-tint p-4">
                  <span className="text-[13px] font-bold text-brand-ink">包含</span>
                  {spec.inScope.map((s, i) => (
                    <span key={i} className="text-[13px]">
                      • <InlineCode text={s} />
                    </span>
                  ))}
                </div>
                <div className="flex flex-col gap-1.5 rounded-[14px] bg-fill-2 p-4">
                  <span className="text-[13px] font-bold text-ink-2">不包含</span>
                  {spec.outOfScope.length ? (
                    spec.outOfScope.map((s, i) => (
                      <span key={i} className="text-[13px] text-ink-2">
                        • <InlineCode text={s} />
                      </span>
                    ))
                  ) : (
                    <span className="text-[13px] text-muted">—</span>
                  )}
                </div>
              </div>

              <PlannedTests spec={spec} />

              {spec.decisions.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <span id={decisionsId} className="text-[15px] font-bold">
                    決策
                  </span>
                  <ul
                    aria-labelledby={decisionsId}
                    className="m-0 flex list-none flex-col overflow-hidden rounded-[14px] p-0 shadow-[0_0_0_1px_var(--color-chip)]"
                  >
                    {spec.decisions.map((d, i) => (
                      <li
                        key={d.id}
                        className={cx(
                          'grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-3',
                          i < spec.decisions.length - 1 && 'border-b border-line-soft'
                        )}
                      >
                        <span className="font-mono text-xs text-muted">{d.id.toUpperCase()}</span>
                        <span>
                          <InlineCode text={d.text} />
                        </span>
                        <SourcePill task={task} source={d.source} onOpenQuestion={onOpenQuestion} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-col gap-2.5">
                <span className="text-[15px] font-bold">實作步驟</span>
                <ol className="m-0 flex list-none flex-col gap-2 p-0">
                  {spec.steps.map((s, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="flex size-6 flex-none items-center justify-center rounded-full bg-fill text-xs">
                        {i + 1}
                      </span>
                      <span>
                        <InlineCode text={s} />
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-[15px] font-bold">驗收條件</span>
                {spec.acceptance.map((a, i) => (
                  <span key={i} className="text-[13px]">
                    • <InlineCode text={a} />
                  </span>
                ))}
              </div>
            </div>
          </div>

          {!readOnly && task.status === 'spec_review' && (
            <div className="rounded-b-2xl border-t border-line-soft bg-surface px-7 py-4">
              <form
                onSubmit={requestChanges}
                className="mx-auto flex max-w-[800px] flex-wrap items-center gap-2.5"
              >
                <label className="flex flex-[1_1_260px]">
                  <span className="sr-only">修改意見</span>
                  <input
                    ref={feedbackRef}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    onKeyDown={blockImeSubmit}
                    placeholder="哪裡要改？例如：上限改成 10 次"
                    className={cx(inputClass, 'h-11 flex-1')}
                  />
                </label>
                <Button type="submit" disabled={blocked || !feedback.trim()}>
                  要求修改
                </Button>
                <Button
                  variant="primary"
                  className="px-5"
                  disabled={blocked}
                  onClick={() => approve()}
                >
                  核准並開始實作
                </Button>
              </form>
              <div className="mx-auto mt-2 max-w-[800px] text-xs text-muted">
                {viewingOld ? (
                  <>
                    正在看 v{spec.version}（舊版本），核准與修改意見都是針對最新的 v{latest}。{' '}
                    <button
                      type="button"
                      onClick={() => setPicked(undefined)}
                      className="cursor-pointer text-brand hover:text-brand-hover"
                    >
                      回到 v{latest}
                    </button>
                  </>
                ) : confirming ? (
                  <span className="text-decision-ink">
                    修改意見還沒送出。要放棄這段意見直接核准，或先按「要求修改」送出。{' '}
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => approve(true)}
                      className="cursor-pointer font-medium text-brand hover:text-brand-hover disabled:cursor-default disabled:opacity-50"
                    >
                      放棄意見並核准
                    </button>
                  </span>
                ) : (
                  <>
                    核准後 Claude 會在{isBranchMode(task) ? '原 repo' : ' worktree'}{' '}
                    <code className="break-all">{task.worktreePath}</code>
                    （分支 <code>{task.branch}</code>）中修改程式碼。
                  </>
                )}
              </div>
              <LiveStatus
                text={busy && 'Claude 正在處理，這一輪結束後就能核准或要求修改'}
                className={cx('mx-auto max-w-[800px] text-xs', busy && 'mt-2')}
              />
            </div>
          )}
        </div>
        <PendingPermission task={task} fallbackFocus={() => feedbackRef.current} />
      </main>

      <ClarifyLog
        task={task}
        spec={spec}
        onOpenClarify={() => onOpenStage('clarify')}
        onOpenQuestion={onOpenQuestion}
      />
    </>
  )
}
