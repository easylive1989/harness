// src/renderer/src/report/anchors.ts
// 回饋錨點（主程序原樣轉給 Claude）：section:<id>、test:<id>、decision:<id>、block:<id>、
// file:<路徑>（整個檔案）、diff:<路徑>:<新檔行號>
import type { FeedbackItem } from '@shared/types'

export const diffAnchor = (path: string, line: number) => `diff:${path}:${line}`
export const fileAnchor = (path: string) => `file:${path}`
export const testAnchor = (id: string) => `test:${id}`

/** 畫面上標著這個錨點的元素（以 dataset 比對：錨點裡的路徑可能有引號等字元，不放進選擇器） */
export const findAnchor = (anchor: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-anchor]')].find(
    (e) => e.dataset.anchor === anchor
  )

/**
 * 跳到報告上的某個位置：捲過去，焦點也移過去（tabIndex=-1，不會多一個 Tab 停留點），
 * 鍵盤與螢幕閱讀器的使用者從那裡繼續。
 */
export function reveal(
  el: HTMLElement | null | undefined,
  block: ScrollLogicalPosition = 'center'
) {
  if (!el) return
  el.scrollIntoView?.({ behavior: 'smooth', block })
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1
  el.focus({ preventScroll: true })
}

/** 指向 diff 的錨點對應的檔案與行號（路徑本身可能含冒號，所以行號取最後一個冒號之後） */
export function anchorTarget(anchor: string): { path: string; line?: number } | undefined {
  if (anchor.startsWith('file:')) return { path: anchor.slice('file:'.length) }
  if (!anchor.startsWith('diff:')) return undefined
  const rest = anchor.slice('diff:'.length)
  const i = rest.lastIndexOf(':')
  const line = Number(rest.slice(i + 1))
  return i > 0 && Number.isInteger(line) ? { path: rest.slice(0, i), line } : undefined
}

const KIND: Record<string, string> = {
  diff: '程式碼',
  file: '檔案',
  test: '測試',
  decision: '決策',
  block: '視覺化',
  section: '區塊'
}

/** 回饋清單上的標題，例如「程式碼 · src/a.ts:12」 */
export function feedbackTitle(f: FeedbackItem): string {
  const kind = KIND[f.anchor.slice(0, f.anchor.indexOf(':'))]
  return kind ? `${kind} · ${f.label}` : f.label
}
