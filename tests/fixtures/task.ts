// tests/fixtures/task.ts
import type { Task } from '@shared/types'

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    repoId: 'r1',
    title: '登入失敗鎖定',
    request: '加上登入失敗鎖定',
    baseBranch: 'main',
    branch: 'harness/t1',
    worktreePath: '/tmp/wt/t1',
    model: 'claude-opus-5-5',
    status: 'clarifying',
    runState: 'idle',
    questions: [],
    decisions: [],
    specs: [],
    plan: [],
    branches: [],
    allowedCommands: [],
    approvedCommands: [],
    reportVersions: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    ...over
  }
}
