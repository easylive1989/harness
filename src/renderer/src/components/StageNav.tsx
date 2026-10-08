// src/renderer/src/components/StageNav.tsx
import type { Task } from '@shared/types'
import { currentStage, reachable, type Stage, STAGES } from '../lib/stage'
import { cx } from './ui'

export function StageNav({
  task,
  shown,
  onSelect
}: {
  task: Task
  shown: Stage
  onSelect: (s: Stage) => void
}) {
  const current = currentStage(task)
  const order = STAGES.map((s) => s.id)
  return (
    <nav aria-label="任務階段" className="flex items-center gap-1 rounded-full bg-fill p-1 text-xs">
      {STAGES.map((s, i) => {
        const can = reachable(task, s.id)
        const passed = order.indexOf(s.id) < order.indexOf(current)
        return (
          <button
            key={s.id}
            type="button"
            // aria-current 標出任務目前所在的階段，aria-pressed 標出畫面正在顯示的階段
            aria-current={s.id === current ? 'step' : undefined}
            aria-pressed={shown === s.id}
            disabled={!can}
            onClick={() => onSelect(s.id)}
            className={cx(
              'rounded-full px-3 py-1 disabled:cursor-default',
              shown === s.id
                ? 'bg-surface font-medium text-brand shadow-tab'
                : can
                  ? 'cursor-pointer text-brand hover:bg-surface/60'
                  : 'text-muted-2'
            )}
          >
            {passed && shown !== s.id ? '✓' : i + 1} {s.label}
          </button>
        )
      })}
    </nav>
  )
}
