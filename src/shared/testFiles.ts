// src/shared/testFiles.ts
// Harness 自己從 diff 判斷哪些是測試檔（不靠 Claude 的說明）：報告的「新增的測試」區塊與 PR 內文共用
import { type DiffFile, parseUnifiedDiff } from './diff'
import type { TestNote } from './report'

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** 測試檔一定是原始碼：文件、資料、設定與 snapshot 都不算 */
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs)$/
/** fixture、snapshot、mock 與測試資料的資料夾：裡面的檔案不是測試本身 */
const NOT_TESTS_DIR = /(^|\/)(fixtures?|__snapshots__|__mocks__|testdata)\//
/** 測試資料夾（Swift 慣用 Tests/） */
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|Tests)\//
/** 測試檔名：*.test.*、*.spec.*、*.cy.*、*_test.*、test_*.py、*_spec.rb、*Test(s).java／.kt */
const TEST_NAME =
  /^(.+\.(test|spec|cy)\.[^.]+|.+_test\.[^.]+|test_.+\.py|.+_spec\.rb|.+Tests?\.(java|kt))$/
/** 測試資料夾裡的輔助檔：helper(s)、setup、util(s)、conftest，可帶前綴（spec_helper、vitest.setup） */
const HELPER = /^([\w.-]*[._-])?(helpers?|setup|utils?|conftest)\.[^.]+$/

/** 依路徑判斷是不是測試檔 */
export function isTestFile(path: string): boolean {
  if (!SOURCE_EXT.test(path) || NOT_TESTS_DIR.test(path)) return false
  const name = baseName(path)
  if (TEST_NAME.test(name)) return true
  return TEST_DIR.test(path) && !HELPER.test(name)
}

/**
 * Claude 給的測試檔路徑 → diff 裡的路徑：去掉空白、worktree 前綴與開頭的 ./；
 * 仍對不到時以結尾比對（絕對路徑、/var 與 /private/var、省略前段的相對路徑），
 * 只在剛好對到一個檔案時採用；都對不到就回傳整理過的路徑。
 */
export function resolveTestPath(file: string, diffPaths: string[], root?: string): string {
  let p = file.trim()
  const prefix = root ? `${root.replace(/\/+$/, '')}/` : undefined
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length)
  p = p.replace(/^(\.\/)+/, '')
  if (diffPaths.includes(p)) return p
  // Claude 的路徑比較長（絕對路徑）：取 diff 裡最長的、是它結尾的路徑
  const tails = diffPaths.filter((d) => p.endsWith(`/${d}`))
  if (tails.length) return tails.reduce((a, b) => (b.length > a.length ? b : a))
  // Claude 的路徑比較短：diff 裡只有一個檔案以它結尾時才採用
  const heads = diffPaths.filter((d) => d.endsWith(`/${p}`))
  return heads.length === 1 ? heads[0] : p
}

/** diff 裡的測試檔中，沒有對到 Claude 在 tests 說明的（含刪除的測試檔） */
export function undocumentedTestFiles(
  files: DiffFile[],
  tests: TestNote[],
  root?: string
): DiffFile[] {
  const paths = files.map((f) => f.path)
  const described = new Set(tests.map((t) => resolveTestPath(t.file, paths, root)))
  return files.filter((f) => isTestFile(f.path) && !described.has(f.path))
}

/** diff 裡新增的測試檔路徑 */
export function addedTestFiles(diff: string): string[] {
  return parseUnifiedDiff(diff)
    .filter((f) => f.status === 'added' && isTestFile(f.path))
    .map((f) => f.path)
}
