// tests/renderer/testItems.test.ts
import { expect, test } from 'vitest'
import {
  coveringRuns,
  isTestRunner,
  runState,
  summarizeRuns,
  testVerdict
} from '@renderer/report/testItems'
import type { VerificationResult } from '@shared/types'

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

test('整體結果：略過的不算在分母', () => {
  expect(summarizeRuns([])).toEqual({ ran: 0, passed: 0, skipped: 0, state: 'skipped' })
  expect(
    summarizeRuns([run({}), run({ exitCode: 1 }), run({ skipped: '未核准', exitCode: null })])
  ).toEqual({ ran: 2, passed: 1, skipped: 1, state: 'failed' })
  expect(summarizeRuns([run({}), run({ skipped: '未核准' })])).toMatchObject({ state: 'passed' })
})

test('輸出提到測試檔（完整路徑或檔名，前後是路徑或空白的邊界）才算涵蓋；略過的不算', () => {
  const runs = [
    run({ command: 'npm run lint', exitCode: 1, outputTail: 'src/a.ts: error' }),
    run({ command: 'npm test', outputTail: ' ✓ src/auth/lockout.test.ts (1 test)' }),
    run({ command: 'npx vitest run', outputTail: ' ✓ packages/x/lockout.test.ts:3' }),
    run({ command: 'npm run e2e', skipped: '未核准', outputTail: 'src/auth/lockout.test.ts' }),
    run({ command: 'jest', outputTail: 'PASS xlockout.test.ts\nPASS lockout.test.tsx' })
  ]
  expect(coveringRuns('src/auth/lockout.test.ts', runs).map((v) => v.command)).toEqual([
    'npm test',
    'npx vitest run'
  ])
  expect(coveringRuns('src/auth/login.test.ts', runs)).toEqual([])
})

test('看起來是跑測試的指令', () => {
  for (const c of [
    'npm test',
    'npm run test:unit',
    'pnpm vitest run',
    'npx jest --ci',
    'python -m pytest -q',
    'go test ./...',
    'cargo test',
    'bundle exec rspec',
    'npx playwright test',
    'npx cypress run',
    'npx mocha'
  ])
    expect(isTestRunner(c), c).toBe(true)
  for (const c of ['npm run lint', 'npm run typecheck', 'tsc --noEmit', 'npm run e2e', 'make'])
    expect(isTestRunner(c), c).toBe(false)
})

test('一個測試的驗證：先看輸出提到它的指令，再看跑測試的指令，都沒有就只給整體數字', () => {
  const lint = run({ command: 'npm run lint', exitCode: 1 })
  const types = run({ command: 'npm run typecheck' })
  const unit = run({ command: 'npm test', outputTail: 'ok src/a.test.ts' })
  const e2e = run({ command: 'npx playwright test', exitCode: 1 })
  expect(testVerdict('src/a.test.ts', [lint, unit, e2e])).toEqual({ runs: [unit] })
  expect(testVerdict('src/b.test.ts', [lint, unit, e2e])).toEqual({ runs: [unit, e2e] })
  expect(testVerdict('src/b.test.ts', [lint, types])).toEqual({
    summary: { ran: 2, passed: 1, skipped: 0, state: 'failed' }
  })
  expect(testVerdict('src/b.test.ts', [])).toBeUndefined()
})
