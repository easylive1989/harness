// src/main/tasks/prBody.ts
import { plannedCoverage } from '@shared/report'
import { addedTestFiles, resolveTestPath } from '@shared/testFiles'
import type { Report } from '@shared/types'

/** Claude 給的文字放進清單項目：換行與連續空白壓成一個空白，不會拆壞 Markdown 清單 */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Markdown code span：用比內容裡最長的反引號串多一個的反引號包住；開頭或結尾是反引號時補空白 */
function code(s: string): string {
  const text = oneLine(s)
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  const pad = longest > 0 ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** 「新增的測試」段落：Claude 說明的新增／修改測試；沒說明但 diff 裡有新增的測試檔時照實寫出，不說沒有新增 */
function testLines(r: Report): string[] {
  const i = r.input
  const added = i.tests.filter((t) => t.change === 'added')
  const modified = i.tests.filter((t) => t.change === 'modified')
  const files = addedTestFiles(r.diff)
  const described = new Set(i.tests.map((t) => resolveTestPath(t.file, files)))
  const undocumented = files.filter((f) => !described.has(f))
  const list = (paths: string[]) => paths.map(code).join('、')
  const lines = ['## 新增的測試']
  // 規格的預計測試：先說做到幾個，再列出沒做到的與原因
  if (r.plannedTests?.length) {
    const c = plannedCoverage(r.plannedTests, i)
    const n = r.plannedTests.length
    lines.push(
      c.skipped.length
        ? `規格預計 ${n} 個測試：已加入 ${c.added.length} 個，${c.skipped.length} 個沒有加入。`
        : `規格預計 ${n} 個測試：都已加入。`,
      ...c.skipped.map(
        (s) =>
          `- 沒有加入：**${oneLine(s.test.name)}**（${s.test.id.toUpperCase()}）：${s.reason ? oneLine(s.reason) : '沒有說明原因'}`
      )
    )
  }
  if (!added.length) {
    if (undocumented.length) {
      lines.push(`Claude 沒有說明新增的測試：${list(undocumented)}`)
      if (i.tests_note) lines.push(`Claude 的說明：${oneLine(i.tests_note)}`)
    } else
      lines.push(i.tests_note ? `這次沒有新增測試：${oneLine(i.tests_note)}` : '這次沒有新增測試。')
  }
  lines.push(
    ...added.map((t) => `- **${oneLine(t.name)}**（${code(t.file)}）：${oneLine(t.scenario)}`),
    ...modified.map(
      (t) =>
        `- 修改：**${oneLine(t.name)}**（${code(t.file)}）：${oneLine(t.scenario)}` +
        (t.why ? `（為什麼改：${oneLine(t.why)}）` : '')
    )
  )
  if (added.length && undocumented.length) lines.push(`- 未說明的新增測試檔：${list(undocumented)}`)
  lines.push('')
  return lines
}

/** PR 內文：報告摘要、新增的測試（最優先）、決策、限制、後續工作與驗證結果 */
export function prBody(r: Report): string {
  const i = r.input
  const lines = ['## 摘要', i.overview.summary, '', ...testLines(r)]
  if (i.decisions.length) {
    lines.push(
      '## 決策',
      ...i.decisions.map(
        (d) => `- **${oneLine(d.title)}**：${oneLine(d.chosen)}（原因：${oneLine(d.rationale)}）`
      ),
      ''
    )
  }
  if (i.limitations.length) {
    lines.push(
      '## 限制與風險',
      ...i.limitations.map((l) => `- ${oneLine(l.title)}：${oneLine(l.detail)}`),
      ''
    )
  }
  if (i.followups.length) {
    lines.push(
      '## 後續工作',
      ...i.followups.map((f) => `- ${oneLine(f.title)}${f.detail ? `：${oneLine(f.detail)}` : ''}`),
      ''
    )
  }
  if (r.verification.length) {
    lines.push(
      '## 驗證',
      ...r.verification.map((v) =>
        v.skipped
          ? `- ⏭️ ${code(v.command)}（${oneLine(v.skipped)}）`
          : `- ${v.exitCode === 0 ? '✅' : '❌'} ${code(v.command)}`
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
