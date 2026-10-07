// src/renderer/src/App.tsx
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
import { NewTaskScreen } from './screens/NewTaskScreen'
import { TaskScreen } from './screens/TaskScreen'
import { type State, useStore } from './store'

/** 視窗用 hiddenInset 標題列：這一條是拖曳區，左側留給紅綠燈 */
function TitleBar({ title }: { title: string }) {
  return (
    <div className="drag flex h-11 flex-none items-center justify-center px-20 text-xs text-muted select-none">
      <span className="truncate">{title}</span>
    </div>
  )
}

/** 標題列文字（選出字串，任務其他欄位變動時不必重繪 App） */
function titleOf(s: State): string {
  if (s.view.kind === 'settings') return '設定'
  if (s.view.kind === 'new') return '新任務'
  const task = s.tasks[s.view.taskId]
  const repo = task && s.repos.find((r) => r.id === task.repoId)
  return [repo?.name, task?.title].filter(Boolean).join(' · ')
}

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const view = useStore((s) => s.view)
  const title = useStore(titleOf)
  useEffect(() => init(), [init])
  if (!ready)
    return (
      <div className="drag flex h-full items-center justify-center text-muted select-none">
        載入中…
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <TitleBar title={title} />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <Sidebar />
        <div className="flex min-w-0 flex-1 gap-3">
          {view.kind === 'new' && <NewTaskScreen />}
          {/* key：換任務時重建，回看階段等畫面狀態不會帶到下一個任務 */}
          {view.kind === 'task' && <TaskScreen key={view.taskId} taskId={view.taskId} />}
          {/* Task 34 加入 SettingsScreen */}
        </div>
      </div>
      <Toast />
    </div>
  )
}
