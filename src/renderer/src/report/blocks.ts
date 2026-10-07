// src/renderer/src/report/blocks.ts
// 自訂區塊 iframe 的高度規則：畫面上的 CustomBlockFrame 與匯出 HTML 的小段 script 共用。

/** 自訂區塊 iframe 的高度範圍：區塊回報的高度夾在這之間 */
export const BLOCK_MIN_H = 80
export const BLOCK_MAX_H = 1600
/** 區塊還沒回報高度前的預設高度（匯出檔沒有 script 可跑時也用這個） */
export const BLOCK_DEFAULT_H = 220

/** 區塊回報的高度：只接受有限的數字，並夾在範圍內；格式不對回傳 undefined */
export function blockHeight(data: unknown, id: string): number | undefined {
  const d = data as { type?: unknown; id?: unknown; height?: unknown } | null
  if (!d || d.type !== 'harness-block-height' || d.id !== id) return undefined
  if (typeof d.height !== 'number' || !Number.isFinite(d.height)) return undefined
  return Math.min(Math.max(d.height, BLOCK_MIN_H), BLOCK_MAX_H)
}
