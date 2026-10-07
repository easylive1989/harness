// src/renderer/src/components/Toast.tsx
import { useEffect } from 'react'
import { useStore } from '../store'
import { Icons } from './ui'

export function Toast() {
  const { toast, dismissToast } = useStore()
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dismissToast, 8000)
    return () => clearTimeout(t)
  }, [toast, dismissToast])
  if (!toast) return null
  return (
    <div
      role="alert"
      className="fixed right-5 bottom-5 z-50 flex max-w-md items-start gap-3 rounded-2xl bg-ink px-4 py-3 text-[13px] text-white shadow-dialog"
    >
      <span className="flex-1 whitespace-pre-wrap">{toast}</span>
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
