// src/renderer/src/report/anchors.ts
// 回饋錨點（主程序原樣轉給 Claude）：section:<id>、decision:<id>、block:<id>、diff:<路徑>:<新檔行號>
import type { FeedbackItem } from '@shared/types'

export const diffAnchor = (path: string, line: number) => `diff:${path}:${line}`

/** diff 錨點的檔案路徑（路徑本身可能含冒號，所以取最後一個冒號之前） */
export function diffAnchorPath(anchor: string): string | undefined {
  if (!anchor.startsWith('diff:')) return undefined
  const rest = anchor.slice('diff:'.length)
  const i = rest.lastIndexOf(':')
  return i > 0 ? rest.slice(0, i) : undefined
}

const KIND: Record<string, string> = {
  diff: '程式碼',
  decision: '決策',
  block: '視覺化',
  section: '區塊'
}

/** 回饋清單上的標題，例如「程式碼 · src/a.ts:12」 */
export function feedbackTitle(f: FeedbackItem): string {
  const kind = KIND[f.anchor.slice(0, f.anchor.indexOf(':'))]
  return kind ? `${kind} · ${f.label}` : f.label
}
