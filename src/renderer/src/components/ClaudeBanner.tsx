// src/renderer/src/components/ClaudeBanner.tsx
// Claude Code 未就緒（找不到或未登入）時顯示；登入後按「重新檢查」更新狀態
import { useStore } from '../store'
import { call } from '../api'
import { Button, Icons } from './ui'

export function ClaudeBanner() {
  const { claude, act } = useStore()
  if (claude?.loggedIn) return null
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger"
    >
      <Icons.Info className="flex-none" />
      <span className="flex-1">{claude?.error ?? '正在檢查 Claude Code…'}</span>
      <Button
        size="sm"
        onClick={() =>
          void act(async () => useStore.setState({ claude: await call('claude:status', true) }))
        }
      >
        重新檢查
      </Button>
    </div>
  )
}
