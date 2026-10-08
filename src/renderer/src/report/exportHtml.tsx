// src/renderer/src/report/exportHtml.tsx
// 匯出單一自含的 HTML：靜態渲染 ReportView（React 會轉義所有報告文字）＋ 目前頁面的 CSS。
// react-dom/server 只有匯出時才用到：按下匯出才載入（獨立的 chunk）。
import type { Report, Task } from '@shared/types'
import { BLOCK_MAX_H, BLOCK_MIN_H } from './blocks'
import { ExportHeader, ReportView } from './ReportView'

/** 匯出檔不能連網；自訂區塊的 srcdoc 會繼承這份 CSP（再加上區塊自己的） */
export const EXPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

/** 匯出檔唯一的 script：依自訂區塊回報的高度調整 iframe（只認自己頁面上的 iframe） */
const RESIZE_SCRIPT = `addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="harness-block-height"||typeof d.height!=="number"||!isFinite(d.height))return;var f=document.querySelectorAll("iframe[data-block]");for(var i=0;i<f.length;i++){if(f[i].contentWindow===e.source&&f[i].getAttribute("data-block")===d.id)f[i].style.height=Math.min(Math.max(d.height,${BLOCK_MIN_H}),${BLOCK_MAX_H})+"px"}})`

/** 目前頁面的所有 CSS 規則；字型檔不打包（改用字型堆疊裡的系統字型） */
function collectCss(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // 跨來源的樣式表讀不到，略過
    }
    for (const rule of Array.from(rules)) {
      if (rule.cssText.startsWith('@font-face')) continue
      out.push(rule.cssText)
    }
  }
  // 放在 <style> 裡：避免規則文字提早結束標籤
  return out.join('\n').replace(/<\/style/gi, '<\\/style')
}

/** 匯出檔名（不含 .html）的長度上限 */
const MAX_NAME = 80

/** 匯出檔名：去掉控制字元與不能用在檔名的字元，太長時截短標題 */
export function exportFileName(task: Task, version: number): string {
  const suffix = `-變更報告-v${version}`
  const cleaned = task.title
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  // 以字元（code point）截短，不會切開 emoji 等兩個 UTF-16 單位的字
  const room = MAX_NAME - Array.from(suffix).length
  const title = Array.from(cleaned).slice(0, room).join('').trim() || '任務'
  return `${title}${suffix}.html`
}

export async function buildReportHtml(task: Task, report: Report): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const body = renderToStaticMarkup(
    <>
      <ExportHeader task={task} report={report} />
      <ReportView task={task} report={report} isStatic />
    </>
  )
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(`${task.title} · 變更報告 v${report.version}`)}</title>
<style>${collectCss()}</style>
</head><body><div style="max-width:1100px;margin:0 auto;padding:24px">${body}</div>
<script>${RESIZE_SCRIPT}</script>
</body></html>`
}
