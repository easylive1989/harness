import { describe, expect, test } from 'vitest'
import { InvalidTransition, phaseOf, transition } from '../../src/main/tasks/stateMachine'

describe('transition', () => {
  test.each([
    ['clarifying', 'SPEC_PROPOSED', 'spec_review'],
    ['spec_review', 'SPEC_PROPOSED', 'spec_review'],
    ['spec_review', 'SPEC_CHANGES_REQUESTED', 'clarifying'],
    ['spec_review', 'SPEC_APPROVED', 'implementing'],
    ['implementing', 'REPORT_SUBMITTED', 'reviewing'],
    ['reviewing', 'REPORT_FEEDBACK', 'implementing'],
    ['reviewing', 'FINISHED', 'done'],
    ['clarifying', 'DISCARDED', 'discarded']
  ] as const)('%s + %s → %s', (from, ev, to) => {
    expect(transition(from, ev)).toBe(to)
  })

  test('不合法的轉換丟出 InvalidTransition', () => {
    expect(() => transition('clarifying', 'SPEC_APPROVED')).toThrow(InvalidTransition)
    expect(() => transition('done', 'DISCARDED')).toThrow(InvalidTransition)
  })
})

describe('phaseOf', () => {
  test('實作階段才可寫入', () => {
    expect(phaseOf('implementing')).toBe('implement')
    expect(phaseOf('clarifying')).toBe('clarify')
    expect(phaseOf('spec_review')).toBe('clarify')
    expect(phaseOf('reviewing')).toBe('clarify')
    expect(phaseOf('done')).toBe('closed')
  })
})
