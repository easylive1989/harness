// src/renderer/src/lib/timeline.ts
import {
  BRANCH_RULES,
  msgDisplay,
  parseTagged,
  startsImplementation,
  type Tagged
} from '@shared/protocol'
import type { TimelineEvent } from '@shared/types'
import { useStore } from '../store'

const TOOL_LABEL: Record<string, string> = {
  Read: '讀取',
  Glob: '搜尋檔名',
  Grep: '搜尋內容',
  Edit: '編輯',
  Write: '寫入',
  MultiEdit: '編輯',
  NotebookEdit: '編輯',
  Bash: '指令',
  WebFetch: '讀取網頁',
  WebSearch: '搜尋網路',
  Agent: '子代理',
  Task: '子代理',
  TodoWrite: '待辦'
}

export type ToolCall = NonNullable<TimelineEvent['tool']>

export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name

/** 工具呼叫的對象（檔案、指令、網址…），沒有就是空字串 */
export function toolTarget(tool: Pick<ToolCall, 'input'>): string {
  const i = tool.input ?? {}
  return String(i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? '')
}

/** worktree 內的絕對路徑顯示成相對路徑（Claude Code 的檔案工具都用絕對路徑）；其他原樣回傳 */
export function relativeTo(root: string, p: string): string {
  const base = root.endsWith('/') ? root : `${root}/`
  return p.startsWith(base) ? p.slice(base.length) : p
}

/** 工具呼叫的一行摘要，例如「讀取 src/auth/login.ts」 */
export function toolSummary(tool: ToolCall): string {
  const target = toolTarget(tool)
  return `${toolLabel(tool.name)}${target ? ` ${target}` : ''}`
}

const RULE_LINES = BRANCH_RULES.split('\n')

/** 去掉混進文字裡的分岔規則（給 Claude 的指示，不給使用者看）；沒有就原樣回傳 */
function stripRules(text: string): string {
  let out = text
  for (const line of RULE_LINES) out = out.split(line).join('')
  return out === text ? text : out.replace(/\n{3,}/g, '\n\n').trim()
}

/** 協定訊息轉成可讀文字；格式不符（缺必要屬性、不認得的標籤）時回傳 undefined */
function describeTagged(t: Tagged): string | undefined {
  switch (t.tag) {
    case 'answer':
      return t.attrs.question_id ? `回答：${t.body}` : undefined
    case 'counter_question':
      return t.attrs.question_id ? `反問：${t.body}` : undefined
    case 'branch_open': {
      const title = /^主題：(.*)$/m.exec(t.body)?.[1]?.trim()
      return title ? `開始討論：${title}` : '開始分岔討論'
    }
    case 'conclude':
      return '請 Claude 整理這個分岔的結論'
    case 'branch_conclusion':
      return t.attrs.branch ? `帶回分岔結論\n${t.body}` : undefined
    case 'spec_feedback':
      return msgDisplay.specFeedback(t.body)
    case 'spec_approved':
      return msgDisplay.specApproved
    case 'report_feedback':
      return `報告回饋：\n${t.body}`
    case 'resume':
      return msgDisplay.resume
    default:
      return undefined
  }
}

/**
 * 時間軸上使用者訊息的顯示文字。主程序多半已寫入給人看的版本，
 * 但舊資料或使用者直接送出的協定訊息（`[tag ...] 內容`）在這裡轉成可讀文字。
 * 格式不符的照原文顯示；無論如何都不顯示 `BRANCH_RULES` 這類給 Claude 的指示。
 */
export function userTextDisplay(text: string): string {
  const t = parseTagged(text)
  return stripRules((t && describeTagged(t)) ?? text)
}

/**
 * 這一段實作的主線事件：最後一次「核准規格」或「送出報告回饋」之後（不含那則訊息）。
 * 還沒有這樣的訊息（例如剛核准、訊息還沒寫進時間軸）時是空的，不會顯示釐清階段的對話。
 */
export function implementEvents(events: TimelineEvent[]): TimelineEvent[] {
  const main = events.filter((e) => e.channel === 'main')
  const start = main.findLastIndex(
    (e) => e.kind === 'user_text' && startsImplementation(e.text ?? '')
  )
  return start < 0 ? [] : main.slice(start + 1)
}

const EMPTY: TimelineEvent[] = []

/** 任務的時間軸（還沒載入時是空陣列） */
export function useTimeline(taskId: string): TimelineEvent[] {
  return useStore((s) => s.timelines[taskId]) ?? EMPTY
}
