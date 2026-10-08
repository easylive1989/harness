// src/renderer/src/lib/useStickToBottom.ts
import { type UIEvent, useLayoutEffect, useRef } from 'react'

/** 距離底部多少 px 以內算「在底部」 */
const THRESHOLD = 80

/**
 * 對話捲動區：內容變多時自動捲到底，但使用者往上捲去看舊訊息時不打擾。
 * `version` 變了代表內容可能變了（例如事件數、任務的 updatedAt）；
 * `resetKey` 變了代表換了一段對話（例如換分岔），重新黏在底部；
 * `count` 是目前的項目數：從 0 變成有內容（初次載入，例如重開 app 後第一次打開任務、
 * 時間軸讀進來）時一定捲到底，不受讀取期間的捲動事件影響。
 * 使用者自己送出訊息時呼叫 `stick()`，之後的回覆一定看得到。
 */
export function useStickToBottom<T extends HTMLElement>(
  version: unknown,
  resetKey?: unknown,
  count?: number
) {
  const ref = useRef<T>(null)
  const sticking = useRef(true)
  const lastKey = useRef(resetKey)
  /** 這段對話已經有過內容（初次載入的強制捲到底只做一次） */
  const filled = useRef(false)
  // 在瀏覽器繪製前捲動，不會先閃一下舊的位置
  useLayoutEffect(() => {
    if (lastKey.current !== resetKey) {
      lastKey.current = resetKey
      sticking.current = true
      filled.current = false
    }
    if (!filled.current && count !== undefined && count > 0) {
      filled.current = true
      sticking.current = true
    }
    const el = ref.current
    if (el && sticking.current) el.scrollTop = el.scrollHeight
  }, [version, resetKey, count])
  const onScroll = (e: UIEvent<T>) => {
    const el = e.currentTarget
    sticking.current = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD
  }
  const stick = () => {
    sticking.current = true
  }
  return { ref, onScroll, stick }
}
