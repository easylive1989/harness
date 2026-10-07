// src/main/tasks/stateMachine.ts
import type { TaskStatus } from '@shared/types'

export type TaskEventType =
  | 'SPEC_PROPOSED'
  | 'SPEC_CHANGES_REQUESTED'
  | 'SPEC_APPROVED'
  | 'REPORT_SUBMITTED'
  | 'REPORT_FEEDBACK'
  | 'FINISHED'
  | 'DISCARDED'

const TABLE: Record<TaskStatus, Partial<Record<TaskEventType, TaskStatus>>> = {
  clarifying: { SPEC_PROPOSED: 'spec_review', DISCARDED: 'discarded' },
  spec_review: {
    SPEC_PROPOSED: 'spec_review',
    SPEC_CHANGES_REQUESTED: 'clarifying',
    SPEC_APPROVED: 'implementing',
    DISCARDED: 'discarded'
  },
  implementing: { REPORT_SUBMITTED: 'reviewing', DISCARDED: 'discarded' },
  reviewing: { REPORT_FEEDBACK: 'implementing', FINISHED: 'done', DISCARDED: 'discarded' },
  done: {},
  discarded: {}
}

export class InvalidTransition extends Error {}

export function transition(status: TaskStatus, event: TaskEventType): TaskStatus {
  const next = TABLE[status][event]
  if (!next) throw new InvalidTransition(`無法在 ${status} 狀態執行 ${event}`)
  return next
}

export type GatePhase = 'clarify' | 'branch' | 'implement' | 'closed'

export function phaseOf(status: TaskStatus): GatePhase {
  if (status === 'implementing') return 'implement'
  if (status === 'done' || status === 'discarded') return 'closed'
  return 'clarify'
}
