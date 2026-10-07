// src/renderer/src/components/Toast.tsx
import { useEffect } from 'react'
import { useStore } from '../store'
import { Icons } from './ui'

export const TOAST_MS = 8000

export function Toast() {
  const toast = useStore((s) => s.toast)
  const dismissToast = useStore((s) => s.dismissToast)
  // 以 id 為依賴：同樣的錯誤再出現一次（新的 id）也會重新計時
  const id = toast?.id
  useEffect(() => {
    if (id === undefined) return
    const t = setTimeout(dismissToast, TOAST_MS)
    return () => clearTimeout(t)
  }, [id, dismissToast])
  if (!toast) return null
  return (
    <div
      role="alert"
      className="fixed right-5 bottom-5 z-50 flex max-w-md items-start gap-3 rounded-2xl bg-ink px-4 py-3 text-[13px] text-white shadow-dialog"
    >
      <span className="flex-1 whitespace-pre-wrap">{toast.text}</span>
      <button
        type="button"
        aria-label="關閉"
        onClick={dismissToast}
        className="mt-0.5 cursor-pointer text-white/70 hover:text-white"
      >
        <Icons.X width={14} height={14} />
      </button>
    </div>
  )
}
