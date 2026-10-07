// src/renderer/src/lib/usePending.ts
import { useRef, useState } from 'react'

/**
 * 按鈕觸發的非同步操作（IPC）進行中時回報 pending，並擋掉重複觸發（例如連點兩下）。
 * ref 是同步的守門，state 讓畫面把按鈕停用。
 */
export function usePending() {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const run = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined
    inFlight.current = true
    setPending(true)
    try {
      return await fn()
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return [pending, run] as const
}
