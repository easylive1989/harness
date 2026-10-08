// tests/shared/testFiles.test.ts
import { expect, test } from 'vitest'
import { parseUnifiedDiff } from '@shared/diff'
import {
  addedTestFiles,
  isTestFile,
  resolveTestPath,
  undocumentedTestFiles
} from '@shared/testFiles'
import { bigDiff, sampleReport } from '../fixtures/report'

test('依路徑判斷測試檔：檔名慣例，或測試資料夾底下的原始碼', () => {
  for (const p of [
    'src/a.test.ts',
    'a.test.js',
    'src/ui/Button.spec.tsx',
    'cypress/e2e/login.cy.ts',
    'pkg/lockout_test.go',
    'app/test_views.py',
    'spec/models/user_spec.rb',
    'src/LoginTest.java',
    'app/src/test/kotlin/LoginTests.kt',
    'tests/login.ts',
    'packages/x/test/run.mjs',
    'src/__tests__/a.jsx',
    'spec/models/user.rb',
    'src/test/java/com/x/Login.java',
    'Tests/AppTests/LoginTests.swift',
    'tests/Feature/LoginTest.php',
    'tests/Login.cs',
    'tests/lockout.rs'
  ])
    expect(isTestFile(p), p).toBe(true)
})

test('不是測試檔：一般程式碼、文件與資料、fixture、snapshot、mock、測試輔助檔', () => {
  for (const p of [
    'src/testing.ts',
    'src/latest/a.ts',
    'src/attest/a.ts',
    'src/contest.test',
    'src/spec.ts',
    'src/test_utils.ts',
    'src/Contest.java',
    'Test.java',
    // 文件、資料與規格文件
    'docs/test.md',
    'specs.md',
    'tests/README.md',
    'test/data.json',
    'docs/spec/api.md',
    'api.spec.md',
    'openapi.spec.yaml',
    'Tests/Info.plist',
    // fixture、snapshot、mock、testdata
    'tests/fixtures/users.ts',
    'tests/fixtures/user.json',
    'test/fixture/a.js',
    'src/fixtures/login.test.ts',
    'src/__snapshots__/a.test.ts.snap',
    'src/a.test.ts.snap',
    'src/__mocks__/api.ts',
    'pkg/testdata/a_test.go',
    // 測試資料夾裡的輔助檔
    'tests/helpers.ts',
    'tests/helper.py',
    'test/setup.js',
    'tests/vitest.setup.ts',
    'tests/utils.ts',
    'tests/util.py',
    'tests/test-utils.tsx',
    'spec/spec_helper.rb',
    'test/test_helper.rb',
    'tests/conftest.py'
  ])
    expect(isTestFile(p), p).toBe(false)
})

const paths = [
  'src/auth/lockout.test.ts',
  'src/auth/login.test.ts',
  'pkg/a/x.test.ts',
  'pkg/b/x.test.ts'
]

test('Claude 給的路徑對到 diff 裡的路徑：去掉 ./ 與 worktree 前綴', () => {
  expect(resolveTestPath('src/auth/lockout.test.ts', paths)).toBe('src/auth/lockout.test.ts')
  expect(resolveTestPath(' ./src/auth/lockout.test.ts ', paths)).toBe('src/auth/lockout.test.ts')
  expect(resolveTestPath('/tmp/wt/t1/src/auth/login.test.ts', paths, '/tmp/wt/t1/')).toBe(
    'src/auth/login.test.ts'
  )
})

test('絕對路徑（/var 與 /private/var 不同）或省略前段時，以結尾對到 diff 裡唯一的檔案', () => {
  const abs = '/private/var/folders/x/wt/t1/src/auth/login.test.ts'
  expect(resolveTestPath(abs, paths, '/var/folders/x/wt/t1')).toBe('src/auth/login.test.ts')
  expect(resolveTestPath('auth/lockout.test.ts', paths)).toBe('src/auth/lockout.test.ts')
  expect(resolveTestPath('lockout.test.ts', paths)).toBe('src/auth/lockout.test.ts')
  // 有兩個候選時不猜
  expect(resolveTestPath('x.test.ts', paths)).toBe('x.test.ts')
  // 不在 diff 裡：只做基本的整理
  expect(resolveTestPath('/tmp/wt/t1/src/gone.test.ts', paths, '/tmp/wt/t1')).toBe(
    'src/gone.test.ts'
  )
  expect(resolveTestPath('src/xlockout.test.ts', paths)).toBe('src/xlockout.test.ts')
})

const deleted = `diff --git a/src/old.test.ts b/src/old.test.ts
deleted file mode 100644
--- a/src/old.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-test('舊的', () => {})
`

test('Claude 沒說明的測試檔：diff 裡是測試檔、但沒有對到 tests（含刪除的，不含 fixture）', () => {
  const files = parseUnifiedDiff(
    bigDiff('src/auth/lockout.test.ts', 2) +
      bigDiff('tests/e2e/lockout.spec.ts', 3) +
      bigDiff('tests/fixtures/users.ts', 3) +
      bigDiff('src/auth/lockout.ts', 1) +
      deleted
  )
  // 絕對路徑（/private 前綴）也算說明過，不會重複列出
  const tests = [{ ...sampleReport.tests[0], file: '/private/tmp/wt/t1/src/auth/lockout.test.ts' }]
  expect(undocumentedTestFiles(files, tests, '/tmp/wt/t1').map((f) => [f.path, f.status])).toEqual([
    ['tests/e2e/lockout.spec.ts', 'added'],
    ['src/old.test.ts', 'deleted']
  ])
})

test('新增的測試檔（PR 內文判斷有沒有新增測試用）', () => {
  const diff = bigDiff('src/a.test.ts', 1) + bigDiff('src/a.ts', 1) + deleted
  expect(addedTestFiles(diff)).toEqual(['src/a.test.ts'])
  expect(addedTestFiles('')).toEqual([])
})
