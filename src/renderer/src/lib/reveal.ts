// src/renderer/src/lib/reveal.ts
// 跳到畫面上的某個位置（報告的錨點、釐清對話裡的問題）：捲過去、移動焦點，必要時短暫標示

/** 使用者在系統設定要求減少動態：不平滑捲動、不做閃爍動畫 */
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 捲過去，焦點也移過去（tabIndex=-1，不會多一個 Tab 停留點），
 * 鍵盤與螢幕閱讀器的使用者從那裡繼續。
 */
export function reveal(
  el: HTMLElement | null | undefined,
  block: ScrollLogicalPosition = 'center'
) {
  if (!el) return
  el.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block })
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1
  el.focus({ preventScroll: true })
}

/** 標示持續的時間 */
export const FLASH_MS = 2000
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/**
 * 短暫標示剛跳到的元素（app.css 的 [data-flash]：外框淡出；減少動態時只顯示外框，不做動畫）。
 * 直接改 DOM 屬性：不必為了一個暫時的外框讓整個畫面重繪。
 */
export function flash(el: HTMLElement) {
  clearTimeout(timers.get(el))
  el.removeAttribute('data-flash')
  // 讀一次版面讓動畫從頭開始（連續跳到同一個元素時）
  void el.offsetWidth
  el.setAttribute('data-flash', '')
  timers.set(
    el,
    setTimeout(() => el.removeAttribute('data-flash'), FLASH_MS)
  )
}
