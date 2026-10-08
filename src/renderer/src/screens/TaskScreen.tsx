// src/renderer/src/screens/TaskScreen.tsx
import { useState } from 'react'
import { RunOptionsMenu } from '../components/RunOptionsMenu'
import { StageNav } from '../components/StageNav'
import { TaskMenu } from '../components/TaskMenu'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'
import { ClarifyScreen } from './ClarifyScreen'
import { ImplementScreen } from './ImplementScreen'
import { ReportScreen } from './ReportScreen'
import { SpecScreen } from './SpecScreen'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  // 使用者回看的階段，只對選它時的任務與狀態有效；換任務或狀態前進就回到目前階段
  const [picked, setPicked] = useState<{ key: string; stage: Stage } | null>(null)
  // 從規格或報告點「問題 N」要跳到的問題；只對點它時的任務與狀態有效
  const [focus, setFocus] = useState<{ key: string; id: string }>()
  // 已完成的任務這次開著畫面時清除過 worktree：不再顯示選單（換階段畫面也一樣）
  const [cleared, setCleared] = useState(false)
  if (!task) return null
  const key = `${taskId}:${task.status}`
  const current = currentStage(task)
  const shown = picked?.key === key ? picked.stage : current
  const openStage = (s: Stage) => {
    setPicked(s === current ? null : { key, stage: s })
    setFocus(undefined)
  }
  /** 切到釐清畫面並捲到那個問題（每次點擊是新的物件，再點一次會再捲一次） */
  const openQuestion = (id: string) => {
    setPicked(current === 'clarify' ? null : { key, stage: 'clarify' })
    setFocus({ key, id })
  }
  // 階段切換與「⋯」選單（丟棄任務）放在每個畫面的標題列右側
  const nav = (
    <div className="ml-auto flex items-center gap-2">
      <RunOptionsMenu task={task} />
      <StageNav task={task} shown={shown} onSelect={openStage} />
      <TaskMenu task={task} cleared={cleared} onCleared={() => setCleared(true)} />
    </div>
  )
  // 已丟棄的任務停在哪個階段都只能看
  const ended = task.status === 'discarded' || task.status === 'done'
  const readOnly = ended || shown !== current
  switch (shown) {
    case 'clarify':
      return (
        <ClarifyScreen
          task={task}
          nav={nav}
          readOnly={readOnly}
          onOpenStage={openStage}
          focusQuestion={focus?.key === key ? focus : undefined}
        />
      )
    case 'spec':
      return (
        <SpecScreen
          task={task}
          nav={nav}
          readOnly={readOnly}
          onOpenStage={openStage}
          onOpenQuestion={openQuestion}
        />
      )
    case 'implement':
      return <ImplementScreen task={task} nav={nav} readOnly={readOnly} />
    case 'report':
      // 依回饋修改中（implementing）回看報告時只能看；送出回饋只在待審閱時
      return (
        <ReportScreen task={task} nav={nav} readOnly={readOnly} onOpenQuestion={openQuestion} />
      )
  }
}
