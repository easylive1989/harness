// src/renderer/src/screens/NewTaskScreen.tsx
// 對照 docs/design/B1-NewTask.dc.html
import { useEffect, useState } from 'react'
import { MODELS, type ModelId } from '@shared/types'
import { call } from '../api'
import { ClaudeBanner } from '../components/ClaudeBanner'
import { Button, cx, Icons, inputClass, textareaClass } from '../components/ui'
import { useStore } from '../store'

/** 把家目錄縮寫成 ~，卡片上比較好讀 */
const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')

export function NewTaskScreen() {
  const { repos, settings, claude, act, open } = useStore()
  const [picked, setPicked] = useState<string>()
  const [request, setRequest] = useState('')
  const [branchInfo, setBranchInfo] = useState<{
    repoId: string
    branches: string[]
    current: string
  }>()
  const [baseChoice, setBaseChoice] = useState<{ repoId: string; value: string }>()
  const [model, setModel] = useState<ModelId>(settings?.defaultModel ?? 'claude-opus-5-5')
  const [busy, setBusy] = useState(false)

  // 選的 repo 不在清單裡（還沒選、或剛被移除）時用第一個
  const repoId = repos.some((r) => r.id === picked) ? picked : repos[0]?.id
  // 分支清單與選擇只對載入它的 repo 有效，切換 repo 時不會沿用上一個 repo 的分支
  const info = repoId && branchInfo?.repoId === repoId ? branchInfo : undefined
  const branches = info?.branches ?? []
  const choice = repoId && baseChoice?.repoId === repoId ? baseChoice.value : undefined
  // 目前分支不在清單裡（例如 detached HEAD）時用第一個分支
  const base =
    choice ?? (info && (branches.includes(info.current) ? info.current : branches[0])) ?? ''

  useEffect(() => {
    if (!repoId) return
    let live = true
    void act(async () => {
      const r = await call('repos:branches', repoId)
      if (live) setBranchInfo({ repoId, ...r })
    })
    return () => {
      live = false
    }
  }, [repoId, act])

  const ready = !!claude?.loggedIn && !!repoId && !!request.trim() && !!base && !busy

  const submit = async () => {
    if (!ready || !repoId) return
    setBusy(true)
    const task = await act(() => call('tasks:create', { repoId, request, baseBranch: base, model }))
    setBusy(false)
    if (task) await open({ kind: 'task', taskId: task.id })
  }

  const pickFolder = () =>
    void act(async () => {
      const r = await call('repos:pick')
      if (r) setPicked(r.id)
    })

  return (
    <main className="flex min-w-0 flex-1 flex-col items-center overflow-y-auto rounded-2xl bg-surface px-7 py-14 shadow-card">
      <div className="flex w-full max-w-[680px] flex-col gap-7">
        <ClaudeBanner />
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[26px] font-bold">想改什麼？</h1>
          <span className="text-muted">
            選一個 repo，用一兩句話描述需求。Claude 會先讀程式碼，再用問題跟你釐清細節。
          </span>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-[13px] font-medium">Repo</legend>
          {repos.length > 0 ? (
            <div className="grid grid-cols-2 gap-2.5">
              {repos.map((r) => {
                const on = repoId === r.id
                return (
                  <label
                    key={r.id}
                    className={cx(
                      'flex cursor-pointer items-center gap-3 rounded-[14px] p-3.5',
                      on ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2'
                    )}
                  >
                    <input
                      type="radio"
                      name="repo"
                      checked={on}
                      onChange={() => setPicked(r.id)}
                      className="accent-brand"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{r.name}</span>
                      <span
                        className={cx(
                          'truncate font-mono text-[11px]',
                          on ? 'text-brand-muted' : 'text-muted'
                        )}
                        title={r.path}
                      >
                        {shortPath(r.path)}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <span className="text-[13px] text-muted">還沒有加入 repo，先選一個 git 資料夾。</span>
          )}
          <button
            type="button"
            onClick={pickFolder}
            className="flex h-10 cursor-pointer items-center gap-2 self-start rounded-xl border border-dashed border-line-strong bg-surface px-3.5 text-[13px] text-ink-2 hover:bg-fill-2"
          >
            <Icons.Folder width={14} height={14} />
            選擇其他資料夾…
          </button>
        </fieldset>

        <label className="flex flex-col gap-2.5">
          <span className="text-[13px] font-medium">需求</span>
          <textarea
            rows={5}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="例如：登入 API 要加上失敗次數限制，連續失敗太多次就鎖帳號。"
            className={cx(
              textareaClass,
              'resize-y rounded-[14px] px-4 py-3.5 text-sm leading-[1.65]'
            )}
          />
        </label>

        <div className="flex flex-wrap gap-4">
          <label className="flex min-w-[200px] flex-1 flex-col gap-2">
            <span className="text-[13px] font-medium">從哪個分支開始</span>
            <select
              value={base}
              onChange={(e) => repoId && setBaseChoice({ repoId, value: e.target.value })}
              disabled={!branches.length}
              className={cx(inputClass, 'px-3 text-sm')}
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[200px] flex-1 flex-col gap-2">
            <span className="text-[13px] font-medium">模型</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelId)}
              className={cx(inputClass, 'px-3 text-sm')}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}（{m.hint}）
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3 rounded-xl bg-fill-2 px-3.5 py-3 text-[13px] text-ink-2">
          <Icons.Info className="flex-none text-brand" />
          <span>
            Harness 會建立獨立的 git worktree。釐清階段 Claude 只會讀檔案；規格經你核准後，才會在
            worktree 裡改程式碼。
          </span>
        </div>

        <Button
          variant="primary"
          className="h-[46px] self-end px-6 text-sm"
          disabled={!ready}
          onClick={() => void submit()}
        >
          {busy ? '建立中…' : '開始釐清'}
          <Icons.Arrow />
        </Button>
      </div>
    </main>
  )
}
