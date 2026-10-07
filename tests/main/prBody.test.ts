// tests/main/prBody.test.ts
import { expect, test } from 'vitest'
import { prBody } from '../../src/main/tasks/prBody'
import { sampleReport } from '../fixtures/report'

test('PR 內文包含摘要、決策、限制與驗證結果', () => {
  const body = prBody({
    version: 1,
    taskId: 't',
    input: sampleReport,
    diff: '',
    createdAt: 'x',
    stats: { files: 2, additions: 10, deletions: 1, perFile: [] },
    verification: [
      { command: 'npm test', exitCode: 0, durationMs: 10, outputTail: '' },
      { command: 'npm run lint', exitCode: 1, durationMs: 5, outputTail: '' },
      { command: 'npm run e2e', exitCode: null, durationMs: 0, outputTail: '', skipped: '未核准' }
    ]
  })
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
