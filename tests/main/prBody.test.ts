// tests/main/prBody.test.ts
import { expect, test } from 'vitest'
import { prBody } from '../../src/main/tasks/prBody'
import type { ReportInput } from '@shared/report'
import type { Report } from '@shared/types'
import { bigDiff, sampleDiff, sampleReport } from '../fixtures/report'

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

test('沒有說明新增的測試、但 diff 裡有新增的測試檔：不說「沒有新增測試」，列出那些檔案', () => {
  // 舊報告讀出來是 tests: []；diff 裡有新增的 lockout.test.ts（login.test.ts 是修改，不算）
  const old = { ...report({ ...sampleReport, tests: [] }), diff: sampleDiff }
  const body = prBody(old)
  expect(body).toContain('## 新增的測試\nClaude 沒有說明新增的測試：`src/auth/lockout.test.ts`\n')
  expect(body).not.toContain('這次沒有新增測試')

  const two = prBody({
    ...report({ ...sampleReport, tests: [], tests_note: '只是重構' }),
    diff: sampleDiff + bigDiff('tests/e2e/lockout.spec.ts', 1) + bigDiff('tests/fixtures/u.ts', 1)
  })
  expect(two).toContain(
    'Claude 沒有說明新增的測試：`src/auth/lockout.test.ts`、`tests/e2e/lockout.spec.ts`\nClaude 的說明：只是重構\n'
  )

  // 有說明新增的測試，另外還有沒說明的新增測試檔
  const extra = prBody({ ...report(), diff: sampleDiff + bigDiff('tests/e2e/lockout.spec.ts', 1) })
  expect(extra).toContain('- **連續失敗 5 次後鎖定帳號**')
  expect(extra).toContain('- 未說明的新增測試檔：`tests/e2e/lockout.spec.ts`')
})

test('Claude 給的文字壓成一行；code span 裡的反引號會跳脫', () => {
  const body = prBody({
    ...report({
      ...sampleReport,
      tests: [
        {
          id: 't1',
          file: 'src/`odd`.test.ts',
          name: '多行\n名稱',
          kind: 'unit',
          change: 'added',
          scenario: '第一行\n\n  第二行'
        }
      ],
      decisions: [{ ...sampleReport.decisions[0], rationale: '多台\n機器共享' }]
    }),
    verification: [{ command: 'echo `x`', exitCode: 0, durationMs: 1, outputTail: '' }]
  })
  expect(body).toContain('- **多行 名稱**（`` src/`odd`.test.ts ``）：第一行 第二行')
  expect(body).toContain('（原因：多台 機器共享）')
  expect(body).toContain('- ✅ `` echo `x` ``')
})
