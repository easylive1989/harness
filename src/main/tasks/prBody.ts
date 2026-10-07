// src/main/tasks/prBody.ts
import type { Report } from '@shared/types'

/** PR 內文：報告摘要、決策、限制、後續工作與驗證結果 */
export function prBody(r: Report): string {
  const i = r.input
  const lines = ['## 摘要', i.overview.summary, '']
  if (i.decisions.length) {
    lines.push(
      '## 決策',
      ...i.decisions.map((d) => `- **${d.title}**：${d.chosen}（原因：${d.rationale}）`),
      ''
    )
  }
  if (i.limitations.length)
    lines.push('## 限制與風險', ...i.limitations.map((l) => `- ${l.title}：${l.detail}`), '')
  if (i.followups.length) {
    lines.push(
      '## 後續工作',
      ...i.followups.map((f) => `- ${f.title}${f.detail ? `：${f.detail}` : ''}`),
      ''
    )
  }
  if (r.verification.length) {
    lines.push(
      '## 驗證',
      ...r.verification.map((v) =>
        v.skipped
          ? `- ⏭️ \`${v.command}\`（${v.skipped}）`
          : `- ${v.exitCode === 0 ? '✅' : '❌'} \`${v.command}\``
      ),
      ''
    )
  }
  lines.push(
    `變更：${r.stats.files} 個檔案，+${r.stats.additions} −${r.stats.deletions}`,
    '',
    '— 由 Harness 產生（Claude Code）'
  )
  return lines.join('\n')
}
