// tests/main/prBody.test.ts
import { expect, test } from 'vitest'
import { prBody } from '../../src/main/tasks/prBody'
import type { ReportInput } from '@shared/report'
import type { Report } from '@shared/types'
import { sampleReport } from '../fixtures/report'

const report = (input: ReportInput = sampleReport): Report => ({
  version: 1,
  taskId: 't',
  input,
  diff: '',
  createdAt: 'x',
  stats: { files: 2, additions: 10, deletions: 1, perFile: [] },
  verification: [
    { command: 'npm test', exitCode: 0, durationMs: 10, outputTail: '' },
    { command: 'npm run lint', exitCode: 1, durationMs: 5, outputTail: '' },
    { command: 'npm run e2e', exitCode: null, durationMs: 0, outputTail: '', skipped: '未核准' }
  ]
})

test('PR 內文包含摘要、決策、限制與驗證結果', () => {
  const body = prBody(report())
  expect(body).toContain('## 摘要')
  expect(body).toContain('在 IP 限流之後加入 lockoutGuard。')
  expect(body).toContain('- **計數存在 Redis**：既有 Redis（原因：多台機器共享）')
  expect(body).toContain('- Redis 掛掉時放行：fail-open')
  expect(body).toContain('- ✅ `npm test`')
  expect(body).toContain('- ❌ `npm run lint`')
  expect(body).toContain('- ⏭️ `npm run e2e`（未核准）')
  expect(body).toContain('2 個檔案，+10 −1')
  expect(body).toContain('由 Harness 產生')
})

test('摘要之後優先列出新增的測試與情境；修改的測試另外標出並附原因', () => {
  const body = prBody(report())
  const sections = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  expect(sections.slice(0, 3)).toEqual(['摘要', '新增的測試', '決策'])
  expect(body).toContain(
    '- **連續失敗 5 次後鎖定帳號**（`src/auth/lockout.test.ts`）：同一帳號連續輸錯密碼 5 次 → 第 6 次登入 → 回 423，而且不再檢查密碼'
  )
  expect(body).toContain(
    '- 修改：**錯誤密碼回 401**（`src/auth/login.test.ts`）：帳號沒有被鎖定時輸錯密碼 → 登入 → 仍然回 401（為什麼改：登入前多了鎖定檢查，測試要先準備一個沒有被鎖定的帳號）'
  )
  expect(body).not.toContain('這次沒有新增測試')
})

test('沒有新增測試時寫明，附上 Claude 說明的原因', () => {
  const withNote = prBody(report({ ...sampleReport, tests: [], tests_note: '只調整文案' }))
  expect(withNote).toContain('## 新增的測試\n這次沒有新增測試：只調整文案\n')
  const noNote = prBody(report({ ...sampleReport, tests: [] }))
  expect(noNote).toContain('## 新增的測試\n這次沒有新增測試。\n')
  // 只有修改既有測試：一樣寫明沒有新增，再列出修改的測試
  const onlyModified = prBody(report({ ...sampleReport, tests: [sampleReport.tests[1]] }))
  expect(onlyModified).toContain('這次沒有新增測試。\n- 修改：**錯誤密碼回 401**')
})
