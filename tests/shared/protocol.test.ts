import { describe, expect, test } from 'vitest'
import {
  BRANCH_RULES,
  IMPLEMENT_START_REF,
  legacyImplementStart,
  msg,
  msgDisplay,
  parseTagged,
  startsImplementation
} from '@shared/protocol'

describe('protocol', () => {
  test('answer 含選項與補充文字', () => {
    const s = msg.answer('q3', 'lock15', '鎖 15 分鐘')
    expect(s).toBe('[answer question_id=q3 option=lock15] 鎖 15 分鐘')
    expect(parseTagged(s)).toEqual({
      tag: 'answer',
      attrs: { question_id: 'q3', option: 'lock15' },
      body: '鎖 15 分鐘'
    })
  })

  test('answer 沒有選項時省略 option', () => {
    expect(msg.answer('q1', undefined, '自己描述')).toBe('[answer question_id=q1] 自己描述')
  })

  test('屬性值中的空白與右括號會被替換', () => {
    expect(msg.counterQuestion('a b]c', '?')).toBe('[counter_question question_id=a_b_c] ?')
  })

  test('多行內容可以被解析', () => {
    const s = msg.branchConclusion('b2', {
      decision: '寄通知信',
      rationale: '避免騷擾',
      deferred: ['重設連結']
    })
    const p = parseTagged(s)!
    expect(p.tag).toBe('branch_conclusion')
    expect(p.attrs.branch).toBe('b2')
    expect(p.body).toBe('決策：寄通知信\n原因：避免騷擾\n延後：重設連結')
  })

  test('reportFeedback 列出錨點', () => {
    const s = msg.reportFeedback(
      [{ anchor: 'diff:a.ts:3', label: 'a.ts:3', text: '改成常數' }],
      '整體不錯'
    )
    expect(s).toBe('[report_feedback] - (diff:a.ts:3) 改成常數\n整體：整體不錯')
  })

  test('分岔規則要求 conclude_branch 用 title 給分岔一個簡短的主題', () => {
    const open = msg.branchOpen('鎖定期間要回什麼', '')
    expect(open).toContain(BRANCH_RULES)
    expect(BRANCH_RULES).toContain('title')
    expect(BRANCH_RULES).toContain('10–20 字')
  })

  test('一般文字不是 tagged', () => {
    expect(parseTagged('你好')).toBeNull()
  })
})

describe('msgDisplay / startsImplementation', () => {
  const userText = (text: string, ref?: string) => ({ kind: 'user_text' as const, text, ref })

  test('核准規格與送出報告回饋的訊息帶著實作起點標記', () => {
    expect(startsImplementation(userText(msgDisplay.specApproved, IMPLEMENT_START_REF))).toBe(true)
    expect(startsImplementation(userText('任何文字', IMPLEMENT_START_REF))).toBe(true)
    expect(startsImplementation({ kind: 'system', ref: IMPLEMENT_START_REF })).toBe(false)
  })

  test('只看標記：使用者打出一樣的字不會被當成起點', () => {
    expect(startsImplementation(userText(msgDisplay.specApproved))).toBe(false)
    expect(startsImplementation(userText(msgDisplay.specApproved, 'other'))).toBe(false)
    expect(startsImplementation(userText('送出 3 則報告回饋'))).toBe(false)
  })

  test('舊時間軸（整份都沒有標記）才用顯示文字判斷', () => {
    expect(legacyImplementStart(userText(msgDisplay.specApproved))).toBe(true)
    expect(legacyImplementStart(userText('送出 3 則報告回饋'))).toBe(true)
    expect(legacyImplementStart(userText('送出 0 則報告回饋與整體意見'))).toBe(true)
    expect(legacyImplementStart(userText('核准規格之前想再問一下'))).toBe(false)
    expect(legacyImplementStart(userText('送出 3 則報告回饋，然後呢？'))).toBe(false)
    expect(legacyImplementStart(userText(msgDisplay.resume))).toBe(false)
  })

  test('報告回饋的顯示文字；只有整體意見時不說 0 則', () => {
    expect(msgDisplay.reportFeedback(3, false)).toBe('送出 3 則報告回饋')
    expect(msgDisplay.reportFeedback(2, true)).toBe('送出 2 則報告回饋與整體意見')
    expect(msgDisplay.reportFeedback(0, true)).toBe('送出整體意見')
  })
})
