// src/renderer/src/App.tsx
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
import { NewTaskScreen } from './screens/NewTaskScreen'
import { TaskScreen } from './screens/TaskScreen'
import { useStore } from './store'

/** 視窗用 hiddenInset 標題列：這一條是拖曳區，左側留給紅綠燈 */
function TitleBar({ title }: { title: string }) {
  return (
    <div className="drag flex h-11 flex-none items-center justify-center px-20 text-xs text-muted select-none">
      <span className="truncate">{title}</span>
    </div>
  )
}

export default function App() {
  const { ready, init, view, tasks, repos } = useStore()
  useEffect(() => init(), [init])
  if (!ready)
    return (
      <div className="drag flex h-full items-center justify-center text-muted select-none">
        載入中…
      </div>
    )
  const task = view.kind === 'task' ? tasks[view.taskId] : undefined
  const repo = task ? repos.find((r) => r.id === task.repoId) : undefined
  const title =
    view.kind === 'settings'
      ? '設定'
      : view.kind === 'new'
        ? '新任務'
        : [repo?.name, task?.title].filter(Boolean).join(' · ')
  return (
    <div className="flex h-full flex-col">
      <TitleBar title={title} />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <Sidebar />
        <div className="flex min-w-0 flex-1 gap-3">
          {view.kind === 'new' && <NewTaskScreen />}
          {view.kind === 'task' && <TaskScreen taskId={view.taskId} />}
          {/* Task 34 加入 SettingsScreen */}
        </div>
      </div>
      <Toast />
    </div>
  )
}
