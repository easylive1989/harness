// src/renderer/src/report/testItems.ts
// 驗證指令的結果：狀態、整體數字，以及「新增的測試」每個項目要顯示哪些指令的結果。
// 只有指令的整體結果是真的：不從輸出推測單一測試的結果。
import type { VerificationResult } from '@shared/types'

export type RunState = 'passed' | 'failed' | 'skipped'

/** 驗證指令的結果：沒跑完（exit code 是 null）也算失敗 */
export const runState = (v: VerificationResult): RunState =>
  v.skipped ? 'skipped' : v.exitCode === 0 ? 'passed' : 'failed'

export interface RunSummary {
  /** 實際執行的指令數（略過的不算在分母） */
  ran: number
  passed: number
  skipped: number
  /** 全部通過、有失敗，或一個都沒執行 */
  state: RunState
}

/** 一組驗證指令的整體結果（概觀的數據格、測試項目的整體數字共用） */
export function summarizeRuns(runs: VerificationResult[]): RunSummary {
  const ran = runs.filter((v) => !v.skipped)
  const passed = ran.filter((v) => v.exitCode === 0).length
  const state: RunState = !ran.length ? 'skipped' : passed === ran.length ? 'passed' : 'failed'
  return { ran: ran.length, passed, skipped: runs.length - ran.length, state }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** 輸出裡出現 term，而且前面是開頭、空白、引號、括號或 /，後面是結尾、空白、引號、括號、冒號或逗號 */
const mentions = (output: string, term: string) =>
  new RegExp(`(^|[\\s'"(\\[/])${escapeRegExp(term)}(?=$|[\\s'")\\]:,])`, 'm').test(output)

/** 輸出（末段）提到這個測試檔（完整路徑或檔名）的驗證指令；略過的沒有輸出 */
export function coveringRuns(file: string, runs: VerificationResult[]): VerificationResult[] {
  const name = baseName(file)
  return runs.filter(
    (v) => !v.skipped && (mentions(v.outputTail, file) || mentions(v.outputTail, name))
  )
}

const TEST_RUNNER = /\b(test|vitest|jest|pytest|rspec|playwright|cypress|mocha)\b/

/** 看起來是跑測試的指令（npm test、npm run test:unit、go test、cargo test、pytest…） */
export const isTestRunner = (command: string) => TEST_RUNNER.test(command)

/** 一個測試要顯示的驗證：指令的結果（runs），或只有整體數字（summary）；沒有驗證指令時 undefined */
export type TestVerdict = { runs: VerificationResult[] } | { summary: RunSummary } | undefined

/**
 * 一個測試的驗證：先看輸出提到這個測試檔的指令，再看所有跑測試的指令；
 * 都沒有（例如只有 lint、typecheck）時只給整體數字。
 */
export function testVerdict(file: string, runs: VerificationResult[]): TestVerdict {
  if (!runs.length) return undefined
  const covering = coveringRuns(file, runs)
  if (covering.length) return { runs: covering }
  const runners = runs.filter((v) => isTestRunner(v.command))
  return runners.length ? { runs: runners } : { summary: summarizeRuns(runs) }
}
