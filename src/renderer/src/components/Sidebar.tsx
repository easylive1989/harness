// src/renderer/src/components/Sidebar.tsx
// 對照 docs/design/StyleB.dc.html、B1-NewTask.dc.html 的 <nav>
import { useState } from 'react'
import { MODELS, type Task } from '@shared/types'
import { call } from '../api'
import { taskStatusLabel } from '../lib/stage'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { Button, cx, Icons, TONE_TEXT } from './ui'

function RepoBadge({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex size-[22px] flex-none items-center justify-center rounded-md text-[11px]',
        active ? 'bg-brand-soft text-brand' : 'bg-chip text-muted'
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function TaskItem({ task, active, onClick }: { task: Task; active: boolean; onClick: () => void }) {
  const s = taskStatusLabel(task)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex cursor-pointer flex-col rounded-xl px-3 py-2.5 text-left',
        active ? 'bg-surface shadow-raised' : 'hover:bg-surface/60'
      )}
    >
      <span className={cx('text-[13px]', active ? 'font-medium text-ink' : 'text-ink-2')}>
        {task.title}
      </span>
      <span className={cx('text-xs', TONE_TEXT[s.tone])}>{s.text}</span>
    </button>
  )
}

export function Sidebar() {
  const { repos, tasks, view, claude, settings } = useStore(
    useShallow((s) => ({
      repos: s.repos,
      tasks: s.tasks,
      view: s.view,
      claude: s.claude,
      settings: s.settings
    }))
  )
  const open = useStore((s) => s.open)
  const act = useStore((s) => s.act)
  // 使用者手動展開／收合過的 repo；沒動過的依「目前焦點」決定
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const list = Object.values(tasks)
    .filter((t) => t.status !== 'discarded')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const activeId = view.kind === 'task' ? view.taskId : undefined
  // 焦點任務：目前打開的任務，否則是最新的任務；它所在的 repo 預設展開
  const focus = list.find((t) => t.id === activeId) ?? list[0]
  const focusRepo = focus?.repoId
  // 焦點換到另一個任務時，清掉它所在 repo 的手動收合，讓那個 repo 一定看得到
  // （React 文件建議的「render 期間依前一個值調整 state」，不用 effect）
  const [prevFocus, setPrevFocus] = useState(focus?.id)
  if (prevFocus !== focus?.id) {
    setPrevFocus(focus?.id)
    if (focusRepo && focusRepo in toggled) {
      const rest = { ...toggled }
      delete rest[focusRepo]
      setToggled(rest)
    }
  }
  const model = MODELS.find((m) => m.id === settings?.defaultModel)?.label ?? ''
  return (
    <nav
      aria-label="Repo 與任務"
      className="flex w-[236px] flex-none flex-col gap-[18px] px-1.5 py-2"
    >
      <Button
        variant="primary"
        className={cx(
          'h-[42px] text-sm',
          view.kind === 'new' && 'shadow-[0_0_0_3px_var(--color-brand-halo)]'
        )}
        aria-current={view.kind === 'new' ? 'page' : undefined}
        onClick={() => void open({ kind: 'new' })}
      >
        <Icons.Plus />
        新任務
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto">
        {repos.map((r) => {
          const ts = list.filter((t) => t.repoId === r.id)
          const expanded = toggled[r.id] ?? r.id === focusRepo
          return (
            <div key={r.id} className="flex flex-col gap-1">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setToggled((s) => ({ ...s, [r.id]: !expanded }))}
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[13px]',
                  expanded ? 'font-bold text-ink' : 'text-ink-2'
                )}
              >
                <RepoBadge name={r.name} active={expanded} />
                <span className="min-w-0 truncate">{r.name}</span>
                {!expanded && ts.length > 0 && (
                  <span className="ml-auto text-xs text-muted-2">{ts.length}</span>
                )}
              </button>
              {expanded &&
                ts.map((t) => (
                  <TaskItem
                    key={t.id}
                    task={t}
                    active={t.id === activeId}
                    onClick={() => void open({ kind: 'task', taskId: t.id })}
                  />
                ))}
            </div>
          )
        })}
        <button
          type="button"
          className="flex h-10 flex-none cursor-pointer items-center gap-2 px-2.5 text-[13px] text-muted hover:text-ink"
          onClick={() => void act(() => call('repos:pick'))}
        >
          <Icons.Plus width={14} height={14} />
          加入 repo
        </button>
      </div>
      <button
        type="button"
        onClick={() => void open({ kind: 'settings' })}
        aria-current={view.kind === 'settings' ? 'page' : undefined}
        className="flex cursor-pointer items-center gap-2.5 rounded-xl bg-chip p-3 text-left text-xs text-ink-2"
      >
        <span
          aria-hidden
          className={cx('size-2 flex-none rounded-full', claude?.loggedIn ? 'bg-ok' : 'bg-danger')}
        />
        {claude?.loggedIn ? `${model} · 訂閱方案` : 'Claude Code 未就緒'}
        <span className="ml-auto text-muted">設定</span>
      </button>
    </nav>
  )
}
