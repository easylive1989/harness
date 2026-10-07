// tests/renderer/stage.test.ts
import { describe, expect, test } from 'vitest'
import { currentStage, reachable, taskStatusLabel } from '@renderer/lib/stage'
import { makeTask } from '../fixtures/task'

describe('stage', () => {
  test('依狀態決定目前階段', () => {
    expect(currentStage(makeTask({ status: 'clarifying' }))).toBe('clarify')
    expect(currentStage(makeTask({ status: 'spec_review' }))).toBe('spec')
    expect(currentStage(makeTask({ status: 'implementing' }))).toBe('implement')
    expect(currentStage(makeTask({ status: 'reviewing' }))).toBe('report')
    expect(currentStage(makeTask({ status: 'discarded', specs: [] }))).toBe('clarify')
  })

  test('可回看已經過的階段；有報告時實作中也能看報告', () => {
    const t = makeTask({ status: 'implementing', reportVersions: [1] })
    expect(reachable(t, 'clarify')).toBe(true)
    expect(reachable(t, 'report')).toBe(true)
    expect(reachable(makeTask({ status: 'clarifying' }), 'spec')).toBe(false)
  })

  test('側欄狀態文字', () => {
    expect(taskStatusLabel(makeTask({ runState: 'waiting_permission' })).text).toBe('等你核准指令')
    expect(
      taskStatusLabel(
        makeTask({
          status: 'implementing',
          plan: [
            { id: 's1', title: 'a', status: 'done' },
            { id: 's2', title: 'b', status: 'running' }
          ]
        })
      ).text
    ).toBe('實作中 · 1/2')
    expect(taskStatusLabel(makeTask({ status: 'reviewing', reportVersions: [1, 2] })).text).toBe(
      '待審閱報告 · v2'
    )
    expect(
      taskStatusLabel(
        makeTask({
          questions: [
            {
              id: 'q1',
              text: '?',
              options: [],
              allowFreeText: true,
              status: 'answered',
              followups: [],
              askedAt: ''
            },
            {
              id: 'q2',
              text: '?',
              options: [],
              allowFreeText: true,
              status: 'open',
              followups: [],
              askedAt: ''
            }
          ]
        })
      ).text
    ).toBe('釐清中 · 問題 2')
  })
})
