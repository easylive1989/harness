// src/renderer/src/lib/useStickToBottom.ts
import { type UIEvent, useEffect, useRef } from 'react'

/** 距離底部多少 px 以內算「在底部」 */
const THRESHOLD = 80

/**
 * 對話捲動區：內容變多時自動捲到底，但使用者往上捲去看舊訊息時不打擾。
 * `version` 變了代表內容可能變了（例如事件數、任務的 updatedAt）。
 */
export function useStickToBottom<T extends HTMLElement>(version: unknown) {
  const ref = useRef<T>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [version])
  const onScroll = (e: UIEvent<T>) => {
    const el = e.currentTarget
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD
  }
  return { ref, onScroll }
}
