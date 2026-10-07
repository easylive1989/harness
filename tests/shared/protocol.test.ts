import { describe, expect, test } from 'vitest'
import { msg, msgDisplay, parseTagged, startsImplementation } from '@shared/protocol'

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

  test('一般文字不是 tagged', () => {
    expect(parseTagged('你好')).toBeNull()
  })
})

describe('msgDisplay / startsImplementation', () => {
  test('核准規格與送出報告回饋標記一段實作的開始', () => {
    expect(startsImplementation(msgDisplay.specApproved)).toBe(true)
    expect(startsImplementation(msgDisplay.reportFeedback(3, false))).toBe(true)
    expect(startsImplementation(msgDisplay.reportFeedback(0, true))).toBe(true)
  })

  test('其他訊息不算', () => {
    expect(startsImplementation(msgDisplay.resume)).toBe(false)
    expect(startsImplementation(msgDisplay.specFeedback('上限改 10 次'))).toBe(false)
    expect(startsImplementation('核准規格之前想再問一下')).toBe(false)
    expect(startsImplementation('送出 3 則報告回饋，然後呢？')).toBe(false)
  })
})
