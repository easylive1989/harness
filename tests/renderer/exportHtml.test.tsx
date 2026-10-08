// tests/renderer/exportHtml.test.tsx
import { expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { buildReportHtml, exportFileName } from '@renderer/report/exportHtml'
import { useStore } from '@renderer/store'
import { BLOCK_CSP } from '@shared/blockHtml'
import { bigDiff, makeReport } from '../fixtures/report'
import { makeTask } from '../fixtures/task'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

test('匯出的 HTML 自含、轉義所有報告文字、沒有互動控制', async () => {
  // 待送出的回饋不應該出現在匯出檔
  useStore.setState({
    feedback: { t1: [{ anchor: 'diff:src/auth/login.ts:11', label: 'x', text: '私人意見' }] }
  })
  const report = makeReport()
  report.input.overview = {
    headline: '<img src=x onerror=alert(1)>標題',
    summary: '</style><script>alert(2)</script>'
  }
  const task = makeTask({ status: 'reviewing', reportVersions: [1], title: '鎖定 <b>&</b>' })
  const html = await buildReportHtml(task, report)
  expect(html).toMatch(/^<!doctype html>/)
  expect(html).not.toContain('<img src=x')
  expect(html).not.toContain('<script>alert(2)')
  expect(html).toContain('<title>鎖定 &lt;b&gt;&amp;&lt;/b&gt; · 變更報告 v1</title>')
  expect(html).not.toContain('私人意見')

  const doc = parse(html)
  // 不能連網
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
  expect(csp?.getAttribute('content')).toContain("default-src 'none'")
  expect(doc.querySelectorAll('link, script[src], img[src^="http"]')).toHaveLength(0)
  expect(doc.querySelector('h1')?.textContent).toBe('<img src=x onerror=alert(1)>標題')
  expect(doc.querySelectorAll('button, input, textarea, select, form')).toHaveLength(0)
  // 匯出檔不需要回饋清單用的錨點
  expect(doc.querySelectorAll('[data-anchor]')).toHaveLength(0)
  // 所有檔案的 diff 都在（沒有切換檔案的按鈕可用）
  expect(doc.body.textContent).toContain('獨立計數邏輯')
  expect(doc.body.textContent).toContain('登入前先檢查鎖定')

  const frames = doc.querySelectorAll('iframe')
  expect(frames).toHaveLength(1)
  const frame = frames[0]
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.hasAttribute('src')).toBe(false)
  const srcdoc = frame.getAttribute('srcdoc') ?? ''
  expect(srcdoc).toContain('<div>正常 → 鎖定</div>')
  expect(srcdoc).toContain(`content="${BLOCK_CSP}"`)
})

test('匯出檔名去掉控制字元與不能用在檔名的字元，並限制長度', () => {
  expect(exportFileName(makeTask({ title: 'a/b:c*?"<>|d\n e' }), 3)).toBe(
    'a-b-c------d e-變更報告-v3.html'
  )
  expect(exportFileName(makeTask({ title: 'x\u0000\u0007y\u007f' }), 1)).toBe(
    'x y-變更報告-v1.html'
  )
  expect(exportFileName(makeTask({ title: '  ' }), 1)).toBe('任務-變更報告-v1.html')
  const long = exportFileName(makeTask({ title: '登入'.repeat(100) + '😀' }), 12)
  expect(long.endsWith('-變更報告-v12.html')).toBe(true)
  expect(Array.from(long.replace(/\.html$/, ''))).toHaveLength(80)
})

test('前後兩張架構圖用同樣的比例縮放（匯出檔沒有 script 也一樣）', async () => {
  const report = makeReport()
  // 之後的圖有一層並排兩個方塊：寬 400；之前的圖寬 180
  report.input.architecture.after = {
    nodes: [
      ...report.input.architecture.after.nodes,
      { id: 'redis', label: 'Redis', status: 'unchanged', files: [] }
    ],
    edges: [...report.input.architecture.after.edges, { from: 'guard', to: 'redis' }]
  }
  const html = await buildReportHtml(makeTask(), report)
  const widths = [...parse(html).querySelectorAll('svg[role="group"]')].map((svg) =>
    svg.getAttribute('style')
  )
  expect(widths).toEqual([
    'width:min(180px, 45%);min-width:108px',
    'width:min(400px, 100%);min-width:240px'
  ])
})

test('大 diff：超過 3000 行的檔案與鎖定檔只放摘要，匯出檔維持小', async () => {
  const report = makeReport({
    diff:
      bigDiff('src/generated/huge.ts', 20000) +
      bigDiff('package-lock.json', 40) +
      bigDiff('src/a.ts', 2),
    stats: { files: 3, additions: 20042, deletions: 0, perFile: [] }
  })
  const html = await buildReportHtml(makeTask(), report)
  expect(html).toContain('此檔案變更 20000 行，未包含在匯出中')
  expect(html).toContain('此檔案變更 40 行，未包含在匯出中')
  expect(html).toContain('line 2')
  expect(html).not.toContain('line 2999')
  expect(html.length).toBeLessThan(60_000)
})
