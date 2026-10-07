// src/renderer/src/screens/TaskScreen.tsx
import { useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  // 使用者回看的階段，只對選它時的任務與狀態有效；換任務或狀態前進就回到目前階段
  const [picked, setPicked] = useState<{ key: string; stage: Stage } | null>(null)
  if (!task) return null
  const key = `${taskId}:${task.status}`
  const current = currentStage(task)
  const shown = picked?.key === key ? picked.stage : current
  const nav = (
    <StageNav
      task={task}
      shown={shown}
      onSelect={(s) => setPicked(s === current ? null : { key, stage: s })}
    />
  )
  // Task 29–33 依 shown 切換到 ClarifyScreen / SpecScreen / ImplementScreen / ReportScreen
  return (
    <main className="flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
        <span className="text-lg font-bold">{task.title}</span>
        {nav}
      </div>
    </main>
  )
}
