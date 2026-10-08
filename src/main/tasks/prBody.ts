// src/main/tasks/prBody.ts
import type { Report } from '@shared/types'

/** PR 內文：報告摘要、新增的測試（最優先）、決策、限制、後續工作與驗證結果 */
export function prBody(r: Report): string {
  const i = r.input
  const lines = ['## 摘要', i.overview.summary, '']
  const added = i.tests.filter((t) => t.change === 'added')
  const modified = i.tests.filter((t) => t.change === 'modified')
  lines.push('## 新增的測試')
  if (!added.length)
    lines.push(i.tests_note ? `這次沒有新增測試：${i.tests_note}` : '這次沒有新增測試。')
  lines.push(
    ...added.map((t) => `- **${t.name}**（\`${t.file}\`）：${t.scenario}`),
    ...modified.map(
      (t) =>
        `- 修改：**${t.name}**（\`${t.file}\`）：${t.scenario}${t.why ? `（為什麼改：${t.why}）` : ''}`
    ),
    ''
  )
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
