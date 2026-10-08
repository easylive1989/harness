// tests/renderer/testItems.test.ts
import { expect, test } from 'vitest'
import {
  coveringRuns,
  isTestFile,
  normalizeTestPath,
  runState,
  undocumentedTestFiles
} from '@renderer/report/testItems'
import { parseUnifiedDiff } from '@shared/diff'
import type { VerificationResult } from '@shared/types'
import { bigDiff, sampleReport } from '../fixtures/report'

test('依路徑判斷測試檔', () => {
  for (const p of [
    'src/a.test.ts',
    'a.test.js',
    'src/ui/Button.spec.tsx',
    'pkg/lockout_test.go',
    'app/test_views.py',
    'tests/helpers.ts',
    'packages/x/test/run.js',
    'src/__tests__/a.ts',
    'spec/models/user_spec.rb'
  ])
    expect(isTestFile(p), p).toBe(true)
  for (const p of [
    'src/testing.ts',
    'src/latest/a.ts',
    'src/attest/a.ts',
    'docs/test.md',
    'src/test_utils.ts',
    'specs.md',
    'src/contest.test',
    'src/spec.ts'
  ])
    expect(isTestFile(p), p).toBe(false)
})

test('測試檔路徑：去掉 worktree 前綴與開頭的 ./', () => {
  expect(normalizeTestPath('./src/a.test.ts')).toBe('src/a.test.ts')
  expect(normalizeTestPath('/tmp/wt/t1/src/a.test.ts', '/tmp/wt/t1')).toBe('src/a.test.ts')
  expect(normalizeTestPath('/tmp/wt/t1/src/a.test.ts', '/tmp/wt/t1/')).toBe('src/a.test.ts')
  expect(normalizeTestPath('/tmp/wt/t10/a.test.ts', '/tmp/wt/t1')).toBe('/tmp/wt/t10/a.test.ts')
  expect(normalizeTestPath(' src/a.test.ts ')).toBe('src/a.test.ts')
})

test('Claude 沒說明的測試檔：diff 裡是測試檔、但不在 tests 裡（含刪除的）', () => {
  const files = parseUnifiedDiff(
    [
      bigDiff('src/auth/lockout.test.ts', 2),
      bigDiff('tests/e2e/lockout.spec.ts', 3),
      bigDiff('src/auth/lockout.ts', 1),
      `diff --git a/src/old.test.ts b/src/old.test.ts
deleted file mode 100644
--- a/src/old.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-test('舊的', () => {})
`
    ].join('')
  )
  const tests = [{ ...sampleReport.tests[0], file: './src/auth/lockout.test.ts' }]
  expect(undocumentedTestFiles(files, tests).map((f) => [f.path, f.status])).toEqual([
    ['tests/e2e/lockout.spec.ts', 'added'],
    ['src/old.test.ts', 'deleted']
  ])
})

const run = (over: Partial<VerificationResult>): VerificationResult => ({
  command: 'npm test',
  exitCode: 0,
  durationMs: 1,
  outputTail: '',
  ...over
})

test('驗證結果的狀態：通過、失敗（含未完成）、略過', () => {
  expect(runState(run({}))).toBe('passed')
  expect(runState(run({ exitCode: 1 }))).toBe('failed')
  expect(runState(run({ exitCode: null }))).toBe('failed')
  expect(runState(run({ exitCode: null, skipped: '未核准' }))).toBe('skipped')
})

test('輸出提到測試檔（路徑或檔名）的驗證指令才算涵蓋它；略過的不算', () => {
  const runs = [
    run({ command: 'npm run lint', exitCode: 1, outputTail: 'src/a.ts: error' }),
    run({ command: 'npm test', outputTail: ' ✓ src/auth/lockout.test.ts (1 test)' }),
    run({ command: 'npx vitest run', outputTail: ' ✓ lockout.test.ts' }),
    run({ command: 'npm run e2e', skipped: '未核准', outputTail: 'src/auth/lockout.test.ts' })
  ]
  expect(coveringRuns('src/auth/lockout.test.ts', runs).map((v) => v.command)).toEqual([
    'npm test',
    'npx vitest run'
  ])
  expect(coveringRuns('src/auth/login.test.ts', runs)).toEqual([])
})
