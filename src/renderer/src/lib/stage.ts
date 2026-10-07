// src/renderer/src/lib/stage.ts
import type { Question, Task } from '@shared/types'
import type { Tone } from '../components/ui'

export type Stage = 'clarify' | 'spec' | 'implement' | 'report'
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'clarify', label: '釐清' },
  { id: 'spec', label: '規格' },
  { id: 'implement', label: '實作' },
  { id: 'report', label: '報告' }
]
const ORDER: Stage[] = ['clarify', 'spec', 'implement', 'report']

export function currentStage(t: Task): Stage {
  switch (t.status) {
    case 'clarifying':
      return 'clarify'
    case 'spec_review':
      return 'spec'
    case 'implementing':
      return 'implement'
    case 'reviewing':
    case 'done':
      return 'report'
    case 'discarded':
      return t.reportVersions.length
        ? 'report'
        : t.plan.length
          ? 'implement'
          : t.specs.length
            ? 'spec'
            : 'clarify'
  }
}

export function reachable(t: Task, s: Stage): boolean {
  if (s === 'report') return t.reportVersions.length > 0
  return ORDER.indexOf(s) <= ORDER.indexOf(currentStage(t))
}

export function taskStatusLabel(t: Task): { text: string; tone: Tone } {
  if (t.runState === 'waiting_permission') return { text: '等你核准指令', tone: 'progress' }
  if (t.runState === 'error') return { text: '發生錯誤', tone: 'danger' }
  if (t.runState === 'interrupted') return { text: '已中斷', tone: 'danger' }
  switch (t.status) {
    case 'clarifying': {
      const idx = t.questions.findIndex((q) => q.status === 'open')
      return {
        text: `釐清中 · 問題 ${idx >= 0 ? idx + 1 : Math.max(1, t.questions.length)}`,
        tone: 'brand'
      }
    }
    case 'spec_review':
      return { text: '規格待核准', tone: 'brand' }
    case 'implementing': {
      if (t.runState === 'finalizing') return { text: '整理報告中', tone: 'progress' }
      const done = t.plan.filter((s) => s.status === 'done').length
      return {
        text: t.plan.length ? `實作中 · ${done}/${t.plan.length}` : '實作中',
        tone: 'progress'
      }
    }
    case 'reviewing':
      return { text: `待審閱報告 · v${t.reportVersions.at(-1)}`, tone: 'review' }
    case 'done':
      return { text: t.prUrl ? '已開 PR' : '已合併', tone: 'muted' }
    case 'discarded':
      return { text: '已丟棄', tone: 'muted' }
  }
}

/**
 * 主線正在執行（含等待核准、整理報告）。此時 UI 停用作答、反問與分岔：
 * 主程序在主線執行中會拒絕開分岔；作答與反問雖然會被當成插話送進這一輪，
 * 但等這一輪停下來再開放，回答才不會和 Claude 正在進行的回覆交錯。
 */
export function isBusy(t: Task): boolean {
  return (
    t.runState === 'running' || t.runState === 'waiting_permission' || t.runState === 'finalizing'
  )
}

/** 使用者反問後正在等 Claude 回答（問題卡片自己會顯示等待中） */
export function awaitingCounterReply(t: Task, q: Question): boolean {
  return isBusy(t) && q.status === 'open' && q.followups.at(-1)?.role === 'user'
}
