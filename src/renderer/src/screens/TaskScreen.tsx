// src/renderer/src/screens/TaskScreen.tsx
import { useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'
import { ClarifyScreen } from './ClarifyScreen'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  // 使用者回看的階段，只對選它時的任務與狀態有效；換任務或狀態前進就回到目前階段
  const [picked, setPicked] = useState<{ key: string; stage: Stage } | null>(null)
  if (!task) return null
  const key = `${taskId}:${task.status}`
  const current = currentStage(task)
  const shown = picked?.key === key ? picked.stage : current
  const openStage = (s: Stage) => setPicked(s === current ? null : { key, stage: s })
  const nav = <StageNav task={task} shown={shown} onSelect={openStage} />
  // 已丟棄的任務停在哪個階段都只能看
  const ended = task.status === 'discarded' || task.status === 'done'
  if (shown === 'clarify')
    return (
      <ClarifyScreen
        task={task}
        nav={nav}
        readOnly={ended || current !== 'clarify'}
        onOpenStage={openStage}
      />
    )
  // Task 31–33 補上其他階段
  return <ClarifyScreen task={task} nav={nav} readOnly onOpenStage={openStage} />
}
