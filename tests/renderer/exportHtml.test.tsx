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

  // 新增的測試排在概觀之後，情境與驗證結果都在；「查看測試結果」是頁內連結
  const sections = [...doc.querySelectorAll('section[aria-label]')].map((s) =>
    s.getAttribute('aria-label')
  )
  expect(sections.slice(0, 2)).toEqual(['概觀', '新增的測試'])
  const tests = doc.querySelector('section[aria-label="新增的測試"]')!
  expect(tests.textContent).toContain('連續失敗 5 次後鎖定帳號')
  expect(tests.textContent).toContain('src/auth/lockout.test.ts:3')
  expect(tests.textContent).toContain('同一帳號連續輸錯密碼 5 次 → 第 6 次登入 → 回 423')
  expect(tests.textContent).toContain('登入前多了鎖定檢查')
  expect(tests.textContent).toContain('驗證：npm test 通過')

  const frames = doc.querySelectorAll('iframe')
  expect(frames).toHaveLength(1)
  const frame = frames[0]
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.hasAttribute('src')).toBe(false)
  const srcdoc = frame.getAttribute('srcdoc') ?? ''
  expect(srcdoc).toContain('<div>正常 → 鎖定</div>')
  expect(srcdoc).toContain(`content="${BLOCK_CSP}"`)
})

test('匯出檔裡測試的整體驗證結果用頁內連結連到測試結果', async () => {
  const report = makeReport({
    verification: [
      { command: 'npm run lint', exitCode: 1, durationMs: 1, outputTail: '' },
      { command: 'npm run typecheck', exitCode: 0, durationMs: 1, outputTail: '' }
    ]
  })
  const doc = parse(await buildReportHtml(makeTask(), report))
  const tests = doc.querySelector('section[aria-label="新增的測試"]')!
  expect(tests.textContent).toContain('驗證：1 / 2 通過')
  expect(tests.querySelector('a')?.getAttribute('href')).toBe('#report-tests')
  expect(doc.getElementById('report-tests')).not.toBeNull()
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
  // （換掉整個 architecture：makeReport 的 input 與 sampleReport 共用同一個物件，不能就地改）
  const { before, after } = report.input.architecture
  report.input.architecture = {
    before,
    after: {
      nodes: [...after.nodes, { id: 'redis', label: 'Redis', status: 'unchanged', files: [] }],
      edges: [...after.edges, { from: 'guard', to: 'redis' }]
    }
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

test('前後兩張架構圖：欄寬放不下縮到 60% 的圖時上下排列（只用 CSS，匯出檔也一樣）', async () => {
  const report = makeReport()
  // 之後的圖最寬的一層有三個方塊：寬 3 × 180 + 2 × 40 = 620
  const { before, after } = report.input.architecture
  report.input.architecture = {
    before,
    after: {
      nodes: [
        ...after.nodes,
        { id: 'redis', label: 'Redis', status: 'unchanged', files: [] },
        { id: 'clock', label: '時鐘', status: 'added', files: [] }
      ],
      edges: [...after.edges, { from: 'guard', to: 'redis' }, { from: 'guard', to: 'clock' }]
    }
  }
  const html = await buildReportHtml(makeTask(), report)
  const svgs = [...parse(html).querySelectorAll('svg[role="group"]')]
  const columns = svgs.map((svg) => svg.closest('[data-arch-side]') as HTMLElement)
  expect(columns.map((c) => c.dataset.archSide)).toEqual(['before', 'after'])
  // 每欄的基本寬度 = 620 × 0.6 + 左右留白 40：兩欄並排放不下就換行，各自佔滿整列
  expect(columns.map((c) => c.getAttribute('style'))).toEqual(['flex:1 1 412px', 'flex:1 1 412px'])
  expect(columns[0].parentElement?.className).toContain('flex-wrap')
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
