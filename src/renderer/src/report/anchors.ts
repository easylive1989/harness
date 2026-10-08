// src/renderer/src/report/anchors.ts
// 回饋錨點（主程序原樣轉給 Claude）：section:<id>、decision:<id>、block:<id>、
// file:<路徑>（整個檔案）、diff:<路徑>:<新檔行號>
import type { FeedbackItem } from '@shared/types'

export const diffAnchor = (path: string, line: number) => `diff:${path}:${line}`
export const fileAnchor = (path: string) => `file:${path}`

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
  decision: '決策',
  block: '視覺化',
  section: '區塊'
}

/** 回饋清單上的標題，例如「程式碼 · src/a.ts:12」 */
export function feedbackTitle(f: FeedbackItem): string {
  const kind = KIND[f.anchor.slice(0, f.anchor.indexOf(':'))]
  return kind ? `${kind} · ${f.label}` : f.label
}
