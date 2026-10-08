// src/renderer/src/report/FeedbackPanel.tsx
// 對照 docs/design/B5-Report.dc.html 的 <aside>：待送出的回饋、整體意見、收尾（PR／合併／丟棄）
import { useState } from 'react'
import type { Task } from '@shared/types'
import { call, errorText } from '../api'
import { Button, cx, Icons, textareaClass } from '../components/ui'
import { isBusy } from '../lib/stage'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { feedbackTitle } from './anchors'

export function FeedbackPanel({
  task,
  onJump
}: {
  task: Task
  /** 點回饋清單的項目：捲到報告上對應的位置 */
  onJump?: (anchor: string) => void
}) {
  const items = useStore((s) => s.feedback[task.id]) ?? []
  const removeFeedback = useStore((s) => s.removeFeedback)
  const act = useStore((s) => s.act)
  const showToast = useStore((s) => s.showToast)
  const [overall, setOverall] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // 已完成的任務清除過 worktree：任務本身沒有記錄，這次開著畫面時就不再顯示按鈕
  const [cleared, setCleared] = useState(false)
  // 收尾失敗的原因（例如合併衝突）留在面板上，不只是幾秒就消失的 toast
  const [failure, setFailure] = useState<{ title: string; text: string }>()
  // 送出回饋與收尾操作共用：其中一個進行中時全部停用（主程序也只允許一個收尾操作）
  const [pending, run] = usePending()
  const blocked = pending || isBusy(task)
  const reviewing = task.status === 'reviewing'
  const done = task.status === 'done'
  const latest = task.reportVersions.at(-1) ?? 0
  const unsent = items.length > 0 || !!overall.trim()

  const send = () =>
    run(async () => {
      const sent = items
      const note = overall.trim()
      const ok = await act(async () => {
        await call('report:feedback', task.id, sent, note || undefined)
        return true
      })
      if (!ok) return
      // 只清掉送出的那些（送出期間又改過的保留）
      const now = useStore.getState().feedback[task.id] ?? []
      for (const f of sent) {
        if (now.some((x) => x.anchor === f.anchor && x.text === f.text))
          removeFeedback(task.id, f.anchor)
      }
      setOverall((cur) => (cur.trim() === note ? '' : cur))
    })

  const finish = (title: string, fn: () => Promise<unknown>) =>
    run(async () => {
      setFailure(undefined)
      try {
        await fn()
      } catch (e) {
        setFailure({ title, text: errorText(e) })
      }
    })
  const openPr = () =>
    finish('開 PR 失敗', async () => {
      const url = await call('finish:pr', task.id)
      // PR 已經開了：瀏覽器打不開只提示，不算開 PR 失敗
      await act(() => call('shell:openExternal', url))
    })
  const merge = () => finish('合併失敗', () => call('finish:merge', task.id))
  const discard = () =>
    finish(done ? '清除 worktree 失敗' : '丟棄失敗', async () => {
      await call('finish:discard', task.id)
      setConfirmDiscard(false)
      if (done) {
        setCleared(true)
        showToast('已清除 worktree')
      }
    })

  return (
    <aside
      aria-label="回饋與收尾"
      className="flex max-h-full w-[300px] flex-none flex-col gap-3.5 self-start overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card"
    >
      {reviewing && (
        <>
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-bold">回饋</span>
            <span className="text-xs text-muted">{items.length} 則待送出</span>
          </div>
          <div className="flex flex-col gap-2 text-[13px]">
            {items.length === 0 && (
              <span className="text-muted">
                在報告的區塊、測試、決策或程式碼行號上按「留言」，留下的意見會先列在這裡，一起送出。
              </span>
            )}
            {items.map((f) => (
              <div key={f.anchor} className="flex items-start gap-1 rounded-xl bg-note p-3">
                <button
                  type="button"
                  onClick={() => onJump?.(f.anchor)}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left text-ink"
                >
                  <span className="text-xs break-all text-note-ink">{feedbackTitle(f)}</span>
                  <span className="break-words whitespace-pre-wrap">{f.text}</span>
                </button>
                <button
                  type="button"
                  aria-label={`刪除對「${f.label}」的回饋`}
                  onClick={() => removeFeedback(task.id, f.anchor)}
                  className="-mt-0.5 -mr-1 flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-note-ink hover:bg-diff-flag/30"
                >
                  <Icons.X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">整體意見（選填）</span>
            <textarea
              rows={3}
              value={overall}
              onChange={(e) => setOverall(e.target.value)}
              placeholder="其他想調整的地方…"
              className={cx(textareaClass, 'resize-y')}
            />
          </label>
          <Button variant="primary" disabled={blocked || !unsent} onClick={() => void send()}>
            送出回饋，產生 v{latest + 1}
          </Button>
          <div className="h-px flex-none bg-line-soft" />
          <span className="text-[15px] font-bold">滿意了？</span>
          {unsent && (
            <span className="text-xs text-decision-ink">
              {items.length
                ? `還有 ${items.length} 則回饋${overall.trim() ? '與整體意見' : ''}沒送出`
                : '整體意見還沒送出'}
              ；開 PR 或合併不會送出。
            </span>
          )}
          <Button variant="dark" disabled={blocked} onClick={() => void openPr()}>
            開 Pull Request
          </Button>
          <Button className="text-ink" disabled={blocked} onClick={() => void merge()}>
            合併到 {task.baseBranch}
          </Button>
        </>
      )}

      {task.status === 'implementing' && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[15px] font-bold">修改中</span>
          <span className="text-muted">
            Claude 正在依回饋修改，完成後會產生 v{latest + 1}。這份報告只能看。
          </span>
        </div>
      )}

      {done && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[15px] font-bold">已完成</span>
          {task.prUrl ? (
            <button
              type="button"
              onClick={() => void act(() => call('shell:openExternal', task.prUrl!))}
              className="cursor-pointer self-start text-brand underline hover:text-brand-hover"
            >
              開啟 Pull Request
            </button>
          ) : (
            <span className="text-muted">已合併到 {task.baseBranch}。</span>
          )}
        </div>
      )}

      {task.status === 'discarded' && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[15px] font-bold">已丟棄</span>
          <span className="text-muted">worktree 與分支已刪除，報告仍然可以看與匯出。</span>
        </div>
      )}

      {task.status !== 'discarded' &&
        !(done && cleared) &&
        (confirmDiscard ? (
          <div className="flex flex-col gap-2.5 rounded-xl bg-danger-soft p-3 text-[13px]">
            <span className="text-danger">
              {done
                ? `確定要刪除 worktree 與本機分支 ${task.branch}？已開的 PR 或已合併的內容不受影響。`
                : `確定要丟棄？worktree 與分支 ${task.branch} 都會刪除，無法復原。`}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="bg-danger font-medium text-white hover:bg-danger/90"
                disabled={pending}
                onClick={() => void discard()}
              >
                {done ? '確定清除' : '確定丟棄'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="danger"
            className="h-10"
            disabled={pending}
            onClick={() => setConfirmDiscard(true)}
          >
            {done ? '清除 worktree' : '丟棄 worktree'}
          </Button>
        ))}

      {failure && (
        <div
          role="alert"
          className="flex max-h-60 flex-col gap-1 overflow-auto rounded-xl bg-danger-soft px-3 py-2.5 text-[13px]"
        >
          <span className="font-medium text-danger">{failure.title}</span>
          <span className="font-mono text-xs break-words whitespace-pre-wrap text-ink-2">
            {failure.text}
          </span>
        </div>
      )}
    </aside>
  )
}
