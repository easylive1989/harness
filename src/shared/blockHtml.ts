// src/shared/blockHtml.ts
// 主程序以 harness-block:// 提供自訂區塊、renderer 匯出 HTML 時放進 srcdoc，兩邊用同一份包裝。

/** 自訂區塊只能用 inline 的 style／script 與 data: 圖片字型，不能連網、不能送表單 */
export const BLOCK_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

/**
 * 回報的高度量的是包住內容的容器（flow-root，子元素的 margin 也算在內），
 * 不是 documentElement.scrollHeight：後者至少是 iframe 目前的高度，內容變矮時 iframe 就縮不回來。
 */
export function wrapBlockHtml(block: { id: string; title: string; html: string }): string {
  // 避免 id 裡的 `</script>` 提早結束 script（id 已經過 zod 檢查，這裡再保險一次）
  const id = JSON.stringify(block.id).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BLOCK_CSP}">
<title>${escapeHtml(block.title)}</title>
<style>html,body{margin:0;background:transparent;color:#1c2430;font-family:'Noto Sans TC',-apple-system,'PingFang TC',sans-serif;font-size:14px;line-height:1.6}</style>
</head><body><div id="harness-block-root" style="display:flow-root">${block.html}</div>
<script>(function(){var root=document.getElementById("harness-block-root");var post=function(){parent.postMessage({type:"harness-block-height",id:${id},height:Math.ceil(root.getBoundingClientRect().height)},"*")};new ResizeObserver(post).observe(root);addEventListener("load",post);post()})()</script>
</body></html>`
}
