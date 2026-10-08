// src/renderer/src/report/testItems.ts
// 「新增的測試」區塊用的判斷：哪些是測試檔、Claude 沒說明的測試檔、驗證指令的結果
import type { DiffFile } from '@shared/diff'
import type { TestNote } from '@shared/report'
import type { VerificationResult } from '@shared/types'

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** tests/、test/、__tests__/、spec/ 底下的檔案 */
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//
/** *.test.*、*.spec.*、*_test.*、test_*.py */
const TEST_NAME = /^(.+\.(test|spec)\..+|.+_test\..+|test_.+\.py)$/

/** 依路徑判斷是不是測試檔（Harness 自己從 diff 偵測，不靠 Claude 的說明） */
export const isTestFile = (path: string) => TEST_DIR.test(path) || TEST_NAME.test(baseName(path))

/** Claude 給的測試檔路徑 → diff 裡的路徑：去掉 worktree 前綴與開頭的 ./ */
export function normalizeTestPath(file: string, root?: string): string {
  let p = file.trim()
  const prefix = root ? `${root.replace(/\/+$/, '')}/` : undefined
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length)
  return p.replace(/^(\.\/)+/, '')
}

/** diff 裡的測試檔中，Claude 沒有在 tests 說明的（含刪除的測試檔） */
export function undocumentedTestFiles(
  files: DiffFile[],
  tests: TestNote[],
  root?: string
): DiffFile[] {
  const described = new Set(tests.map((t) => normalizeTestPath(t.file, root)))
  return files.filter((f) => isTestFile(f.path) && !described.has(f.path))
}

export type RunState = 'passed' | 'failed' | 'skipped'

/** 驗證指令的結果：沒跑完（exit code 是 null）也算失敗 */
export const runState = (v: VerificationResult): RunState =>
  v.skipped ? 'skipped' : v.exitCode === 0 ? 'passed' : 'failed'

/**
 * 輸出（末段）提到這個測試檔（路徑或檔名）的驗證指令。
 * 只是「這個指令跑到了這個檔案」的證據：顯示的是指令的整體結果，不是單一測試的結果。
 */
export function coveringRuns(file: string, runs: VerificationResult[]): VerificationResult[] {
  const name = baseName(file)
  return runs.filter(
    (v) => !v.skipped && (v.outputTail.includes(file) || v.outputTail.includes(name))
  )
}
