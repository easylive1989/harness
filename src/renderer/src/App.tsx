// src/renderer/src/App.tsx
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
import { NewTaskScreen } from './screens/NewTaskScreen'
import { SettingsScreen } from './screens/SettingsScreen'
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
  // relative + overflow-clip：沒有定位祖先的絕對定位元素（例如架構圖的 sr-only 連線清單）以外框為準並被裁掉，
  // 文件不會比視窗高；否則捲到報告底再滾、或跳到某個位置（scrollIntoView）會把整個視窗往上捲走
  return (
    <div className="relative flex h-full flex-col overflow-clip">
      <TitleBar title={title} />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        {/* 設定頁自帶左欄（分類與返回） */}
        {view.kind !== 'settings' && <Sidebar />}
        <div className="flex min-w-0 flex-1 gap-3">
          {view.kind === 'new' && <NewTaskScreen />}
          {/* key：換任務時重建，回看階段等畫面狀態不會帶到下一個任務 */}
          {view.kind === 'task' && <TaskScreen key={view.taskId} taskId={view.taskId} />}
          {view.kind === 'settings' && <SettingsScreen />}
        </div>
      </div>
      <Toast />
    </div>
  )
}
