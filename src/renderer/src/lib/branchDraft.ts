// src/renderer/src/lib/branchDraft.ts
// 從 Claude 的訊息開分岔：使用者先說想討論什麼，分岔的標題是那個問題，開場訊息引用那則訊息

/** 開場訊息引用訊息原文的上限（字） */
export const EXCERPT_MAX = 600
/** 分岔標題的上限（字）；Claude 帶回結論時會換成整理過的主題 */
export const TITLE_MAX = 30

const SEED_HEAD = '針對以下內容：\n'
const SEED_QUESTION = '\n\n我的問題：'

/** 以字（code point）截斷，不會切斷 emoji 等由兩個 UTF-16 單位組成的字 */
const take = (s: string, n: number) => Array.from(s).slice(0, n).join('')

/**
 * 去掉常見的 Markdown 標記（** 粗體、刪除線、行內程式碼、圍欄、標題、引用、連結），給引用摘要與標題用。
 * 底線不動：__init__、retry_after 之類的識別字比底線粗體常見
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s*```.*$\n?/gm, '')
    .replace(/\*\*|~~|`/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 分岔標題：使用者的問題去掉 Markdown、壓成一行，最多 TITLE_MAX 字 */
export function branchTitle(question: string): string {
  return take(stripMarkdown(question).replace(/\s+/g, ' ').trim(), TITLE_MAX)
}

/** 分岔的開場內容（接在分岔規則與主題之後）：引用的訊息原文與使用者的問題 */
export function branchSeed(excerpt: string, question: string): string {
  return `${SEED_HEAD}${take(excerpt.trim(), EXCERPT_MAX)}${SEED_QUESTION}${question.trim()}`
}

/** 分岔面板顯示開場訊息時拆回引用與問題；不是這個格式（例如開發期間建立的舊分岔）回傳 undefined */
export function parseBranchSeed(text: string): { excerpt: string; question: string } | undefined {
  if (!text.startsWith(SEED_HEAD)) return undefined
  // 問題來自單行輸入框，不會含有分隔用的換行：取最後一個分隔
  const i = text.lastIndexOf(SEED_QUESTION)
  if (i < 0) return undefined
  return {
    excerpt: text.slice(SEED_HEAD.length, i),
    question: text.slice(i + SEED_QUESTION.length)
  }
}
