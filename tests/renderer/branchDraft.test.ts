// tests/renderer/branchDraft.test.ts
import { expect, test } from 'vitest'
import { branchSeed, branchTitle, parseBranchSeed, stripMarkdown } from '@renderer/lib/branchDraft'

test('去掉 Markdown 標記：粗體、行內程式碼、標題、引用、連結、程式碼區塊的圍欄', () => {
  expect(stripMarkdown('建議改成 **429**，並用 `retryAfter` 帶秒數')).toBe(
    '建議改成 429，並用 retryAfter 帶秒數'
  )
  expect(stripMarkdown('## 選項\n> 引用\n[文件](https://x.dev)\n```ts\nconst a = 1\n```')).toBe(
    '選項\n引用\n文件\nconst a = 1'
  )
  // 識別字裡的底線不動
  expect(stripMarkdown('retry_after 與 __init__')).toBe('retry_after 與 __init__')
})

test('分岔標題：使用者的問題去掉 Markdown、壓成一行，最多 30 字', () => {
  expect(branchTitle('  為什麼回 **429**\n而不是 423？ ')).toBe('為什麼回 429 而不是 423？')
  expect(branchTitle('字'.repeat(40))).toBe('字'.repeat(30))
  // 不會切斷 emoji 等由兩個 UTF-16 單位組成的字
  expect(branchTitle('😀'.repeat(31))).toBe('😀'.repeat(30))
})

test('分岔的開場：引用訊息原文最多 600 字，接著是使用者的問題；可以再解析回來', () => {
  const seed = branchSeed('有幾件事要先確認。', '為什麼要先確認這些？')
  expect(seed).toBe('針對以下內容：\n有幾件事要先確認。\n\n我的問題：為什麼要先確認這些？')
  expect(parseBranchSeed(seed)).toEqual({
    excerpt: '有幾件事要先確認。',
    question: '為什麼要先確認這些？'
  })
  const long = branchSeed('長'.repeat(700), '？')
  expect(parseBranchSeed(long)?.excerpt).toBe('長'.repeat(600))
  expect(parseBranchSeed('針對這段內容深入討論：\n舊格式')).toBeUndefined()
  expect(parseBranchSeed('一般訊息')).toBeUndefined()
})
