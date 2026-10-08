// src/shared/protocol.ts
import type { BranchConclusion, FeedbackItem, TimelineEvent } from './types'

export interface Tagged {
  tag: string
  attrs: Record<string, string>
  body: string
}

const clean = (v: string) => v.replace(/[\s\]]/g, '_')

function tag(name: string, attrs: Record<string, string | undefined>, body = ''): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}=${clean(v as string)}`)
    .join('')
  return `[${name}${a}]${body ? ` ${body}` : ''}`
}

export const BRANCH_RULES = [
  '（Harness 規則）這是從主線分出來的分岔討論，用來深入討論一個主題。',
  '你可以閱讀程式碼，但不能修改檔案或執行指令；不要使用 ask_user、propose_spec，直接用文字討論。',
  '使用者送出 [conclude] 時，呼叫 mcp__harness__conclude_branch 整理結論（decision 一句話、rationale 原因、deferred 延後事項），然後結束這一輪。',
  // 新增的規則放在最後一行：之前的行保持原樣，時間軸才認得舊紀錄裡的規則（stripRules）
  '呼叫 conclude_branch 時，用 title 給這個分岔一個 10–20 字的主題（例如「鎖定期間的回應碼」），取代目前的暫定標題。'
].join('\n')

export const msg = {
  answer: (questionId: string, optionId?: string, text?: string) =>
    tag('answer', { question_id: questionId, option: optionId }, text),
  counterQuestion: (questionId: string, text: string) =>
    tag('counter_question', { question_id: questionId }, text),
  branchOpen: (title: string, seed: string) =>
    tag('branch_open', {}, `${BRANCH_RULES}\n\n主題：${title}${seed ? `\n${seed}` : ''}`),
  conclude: () => tag('conclude', {}, '請呼叫 conclude_branch 整理這個分岔的結論。'),
  branchConclusion: (branchId: string, c: BranchConclusion) =>
    tag(
      'branch_conclusion',
      { branch: branchId },
      `決策：${c.decision}\n原因：${c.rationale}${c.deferred.length ? `\n延後：${c.deferred.join('；')}` : ''}`
    ),
  specFeedback: (text: string) => tag('spec_feedback', {}, text),
  specApproved: () => tag('spec_approved', {}, '規格已核准，現在進入實作階段，請開始實作。'),
  reportFeedback: (items: FeedbackItem[], overall?: string) =>
    tag(
      'report_feedback',
      {},
      [...items.map((i) => `- (${i.anchor}) ${i.text}`), overall ? `整體：${overall}` : '']
        .filter(Boolean)
        .join('\n')
    ),
  resume: () => tag('resume', {}, '上一次執行被中斷，請從中斷的地方繼續。')
}

/** 上面幾則訊息在時間軸上給人看的文字（主程序寫入 user_text 時用） */
export const msgDisplay = {
  specApproved: '核准規格，開始實作',
  specFeedback: (text: string) => `要求修改規格：${text}`,
  reportFeedback: (count: number, withOverall: boolean) =>
    count ? `送出 ${count} 則報告回饋${withOverall ? '與整體意見' : ''}` : '送出整體意見',
  resume: '繼續執行'
}

/** 核准規格、送出報告回饋寫入的 user_text 帶這個 ref：實作畫面從最後一個標記開始顯示 */
export const IMPLEMENT_START_REF = 'implement_start'

/** 時間軸事件是否標記一段實作的開始（看 ref：使用者打出一樣的字不會被誤認） */
export function startsImplementation(e: Pick<TimelineEvent, 'kind' | 'ref'>): boolean {
  return e.kind === 'user_text' && e.ref === IMPLEMENT_START_REF
}

/**
 * 加上 ref 標記之前寫入的實作起點，只能比對顯示文字。
 * 只在整份時間軸都沒有標記時使用（新時間軸裡沒有 ref 的 user_text 是使用者自己打的字）。
 */
export function legacyImplementStart(e: Pick<TimelineEvent, 'kind' | 'text' | 'ref'>): boolean {
  if (e.kind !== 'user_text' || e.ref !== undefined) return false
  const text = e.text ?? ''
  return text === msgDisplay.specApproved || /^送出 \d+ 則報告回饋(與整體意見)?$/.test(text)
}

export function parseTagged(s: string): Tagged | null {
  const m = /^\[([a-z_]+)((?:\s+[a-z_]+=[^\s\]]+)*)\](?:\s([\s\S]*))?$/.exec(s)
  if (!m) return null
  const attrs: Record<string, string> = {}
  for (const pair of m[2].trim().split(/\s+/).filter(Boolean)) {
    const i = pair.indexOf('=')
    attrs[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return { tag: m[1], attrs, body: m[3] ?? '' }
}
