// src/renderer/src/screens/ReportScreen.tsx
import { type ReactNode, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Report, Task } from '@shared/types'
import { call, errorText } from '../api'
import { Button, Spinner } from '../components/ui'
import { shortTime } from '../lib/format'
import { usePending } from '../lib/usePending'
import { diffAnchorPath } from '../report/anchors'
import { buildReportHtml, exportFileName } from '../report/exportHtml'
import { FeedbackPanel } from '../report/FeedbackPanel'
import { ReportView } from '../report/ReportView'
import { useStore } from '../store'

export function ReportScreen({
  task,
  nav,
  readOnly,
  onOpenStage
}: {
  task: Task
  nav: ReactNode
  /** 回看（依回饋修改中、已完成或已丟棄）：不能留言 */
  readOnly: boolean
  onOpenStage: (s: 'clarify') => void
}) {
  const act = useStore((s) => s.act)
  const showToast = useStore((s) => s.showToast)
  const latest = task.reportVersions.at(-1) ?? 0
  // 使用者選的版本只在「最新版本」沒變時有效；產生新版報告時自動切到最新版（不在 effect 裡 setState）
  const [picked, setPicked] = useState<{ latest: number; version: number }>()
  const version = picked?.latest === latest ? picked.version : latest
  // 報告產生後不會再變：讀過的版本留著，切回來不必重讀
  const [reports, setReports] = useState<Record<number, Report>>({})
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState<{ version: number; attempt: number; text: string }>()
  // diff 選取的檔案（點回饋清單時切換），只對選它時的版本有效
  const [diffFile, setDiffFile] = useState<{ version: number; path: string }>()
  const [exporting, runExport] = usePending()
  const report = reports[version]
  const has = !!report
  const loadError = failed?.version === version && failed.attempt === attempt ? failed : undefined

  useEffect(() => {
    if (!version || has) return
    let alive = true
    void (async () => {
      try {
        const r = await call('report:get', task.id, version)
        if (alive) setReports((m) => ({ ...m, [version]: r }))
      } catch (e) {
        if (alive) setFailed({ version, attempt, text: errorText(e) })
      }
    })()
    return () => {
      alive = false
    }
  }, [task.id, version, has, attempt])

  const viewingOld = version !== latest
  const canComment = !readOnly && task.status === 'reviewing' && !viewingOld

  const exportHtml = () =>
    report &&
    runExport(() =>
      act(async () => {
        const path = await call(
          'report:saveHtml',
          exportFileName(task, report.version),
          buildReportHtml(task, report)
        )
        if (path) showToast(`已匯出：${path}`)
      })
    )

  /** 回饋都是對最新版本留的：切回最新版、選到那個檔案，再捲到留言的位置 */
  const jump = (anchor: string) => {
    flushSync(() => {
      if (viewingOld) setPicked(undefined)
      const path = diffAnchorPath(anchor)
      if (path) setDiffFile({ version: latest, path })
    })
    const el = [...document.querySelectorAll<HTMLElement>('[data-anchor]')].find(
      (e) => e.dataset.anchor === anchor
    )
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex flex-col gap-2 rounded-2xl bg-surface px-7 py-[18px] shadow-card">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-lg font-bold">{task.title}</span>
            {nav}
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                版本
                <select
                  value={version}
                  onChange={(e) => setPicked({ latest, version: Number(e.target.value) })}
                  className="h-[34px] cursor-pointer rounded-[10px] border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
                >
                  {task.reportVersions.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                      {reports[v] && ` · ${shortTime(reports[v].createdAt)}`}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                className="h-[34px]"
                disabled={!report || exporting}
                onClick={() => void exportHtml()}
              >
                匯出 HTML
              </Button>
            </div>
          </div>
          {viewingOld && (
            <div className="text-xs text-muted">
              正在看 v{version}（舊版本），只能看；留言請到最新的 v{latest}。{' '}
              <button
                type="button"
                onClick={() => setPicked(undefined)}
                className="cursor-pointer text-brand hover:text-brand-hover"
              >
                回到 v{latest}
              </button>
            </div>
          )}
        </div>
        {report ? (
          <ReportView
            // key：換版本時重設正在輸入的留言等畫面狀態
            key={version}
            task={task}
            report={report}
            canComment={canComment}
            diffFile={diffFile?.version === version ? diffFile.path : undefined}
            onDiffFile={(path) => setDiffFile({ version, path })}
            onOpenQuestion={() => onOpenStage('clarify')}
          />
        ) : loadError ? (
          <div className="flex items-center gap-3 rounded-2xl bg-surface p-7 text-[13px] shadow-card">
            <span className="text-danger">
              無法讀取報告 v{version}：{loadError.text}
            </span>
            <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
              重試
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-2xl bg-surface p-7 text-muted shadow-card">
            <Spinner />
            載入報告…
          </div>
        )}
      </div>
      <FeedbackPanel task={task} onJump={jump} />
    </>
  )
}
