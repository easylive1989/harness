import { describe, expect, test } from 'vitest'
import { parseUnifiedDiff } from '@shared/diff'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export {}
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+-- not a header
+x
`

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF)

  test('解析出兩個檔案與狀態', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/new.ts', 'added']
    ])
  })

  test('行號正確', () => {
    const lines = files[0].hunks[0].lines
    expect(lines[0]).toEqual({ type: 'ctx', text: 'const a = 1', oldNo: 1, newNo: 1 })
    expect(lines[1]).toEqual({ type: 'del', text: 'const b = 2', oldNo: 2 })
    expect(lines[2]).toEqual({ type: 'add', text: 'const b = 3', newNo: 2 })
    expect(lines[3]).toEqual({ type: 'add', text: 'const c = 4', newNo: 3 })
    expect(lines[4]).toEqual({ type: 'ctx', text: 'export {}', oldNo: 3, newNo: 4 })
  })

  test('hunk 內以 -- 開頭的新增行不會被當成標頭', () => {
    expect(files[1].hunks[0].lines[0]).toEqual({ type: 'add', text: '-- not a header', newNo: 1 })
  })

  test('rename', () => {
    const r = parseUnifiedDiff(
      'diff --git a/x.ts b/y.ts\nsimilarity index 100%\nrename from x.ts\nrename to y.ts\n'
    )
    expect(r[0]).toMatchObject({ path: 'y.ts', oldPath: 'x.ts', status: 'renamed' })
  })

  test('modified 檔案沒有 oldPath', () => {
    expect(files[0].oldPath).toBeUndefined()
    expect(files[1].oldPath).toBeUndefined()
  })

  test('CRLF 換行與 LF 結果相同', () => {
    expect(parseUnifiedDiff(DIFF.replace(/\n/g, '\r\n'))).toEqual(files)
  })

  test('git 以引號與八進位跳脫表示的中文路徑', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/\344\270\255.ts" "b/\344\270\255.ts"
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ "b/\344\270\255.ts"
@@ -0,0 +1 @@
+x
`
    )
    expect(r[0]).toMatchObject({ path: '中.ts', status: 'added' })
    expect(r[0].hunks[0].lines).toEqual([{ type: 'add', text: 'x', newNo: 1 }])
  })

  test('沒有 ---/+++ 時從引號標頭取得路徑', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/\344\270\255.png" "b/\344\270\255.png"
new file mode 100644
index 0000000..1111111
Binary files /dev/null and "b/\344\270\255.png" differ
`
    )
    expect(r[0]).toMatchObject({ path: '中.png', status: 'added', binary: true })
  })

  test('引號路徑中的跳脫字元（雙引號、反斜線、tab、換行）', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/q\"b\\c\td\ne.ts" "b/q\"b\\c\td\ne.ts"
--- "a/q\"b\\c\td\ne.ts"
+++ "b/q\"b\\c\td\ne.ts"
@@ -1 +1 @@
-a
+b
`
    )
    expect(r[0].path).toBe('q"b\\c\td\ne.ts')
  })

  test('引號的 rename from/to', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/\344\270\255.ts" "b/\346\226\207.ts"
similarity index 100%
rename from "\344\270\255.ts"
rename to "\346\226\207.ts"
`
    )
    expect(r[0]).toMatchObject({ path: '文.ts', oldPath: '中.ts', status: 'renamed' })
  })

  test('刪除檔案沿用舊路徑', () => {
    const r = parseUnifiedDiff(
      'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex 111..000\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
    )
    expect(r[0]).toMatchObject({ path: 'old.ts', status: 'deleted' })
    expect(r[0].oldPath).toBeUndefined()
  })

  test('含空白的路徑會去掉 git 補在 ---/+++ 後的 tab', () => {
    const r = parseUnifiedDiff(
      'diff --git a/my file.ts b/my file.ts\nindex 1..2 100644\n--- a/my file.ts\t\n+++ b/my file.ts\t\n@@ -1 +1 @@\n-a\n+b\n'
    )
    expect(r[0].path).toBe('my file.ts')
  })
})
