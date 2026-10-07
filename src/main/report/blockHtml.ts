// src/main/report/blockHtml.ts
import { isSafeId } from '../ipcGuards'

/** 自訂區塊只能用 inline 的 style／script 與 data: 圖片字型，不能連網、不能送表單 */
export const BLOCK_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

export function wrapBlockHtml(block: { id: string; title: string; html: string }): string {
  // 避免 id 裡的 `</script>` 提早結束 script（id 已經過 zod 檢查，這裡再保險一次）
  const id = JSON.stringify(block.id).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BLOCK_CSP}">
<style>html,body{margin:0;background:transparent;color:#1c2430;font-family:'Noto Sans TC',-apple-system,'PingFang TC',sans-serif;font-size:14px;line-height:1.6}</style>
</head><body>${block.html}
<script>(function(){var post=function(){parent.postMessage({type:"harness-block-height",id:${id},height:document.documentElement.scrollHeight},"*")};new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post()})()</script>
</body></html>`
}

const BLOCK_ID = /^[a-z0-9_-]{1,128}$/

/** 解析 `harness-block://report/<taskId>/<version>/<blockId>`，格式不符回傳 null */
export function parseBlockUrl(
  url: string
): { taskId: string; version: number; blockId: string } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'harness-block:' || u.hostname !== 'report') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length !== 3) return null
  const [taskId, v, blockId] = parts
  if (!isSafeId(taskId) || !BLOCK_ID.test(blockId) || !/^[1-9][0-9]{0,8}$/.test(v)) return null
  return { taskId, version: Number(v), blockId }
}
