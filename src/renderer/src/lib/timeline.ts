// src/renderer/src/lib/timeline.ts
import { parseTagged } from '@shared/protocol'
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

/** 工具呼叫的一行摘要，例如「讀取 src/auth/login.ts」 */
export function toolSummary(tool: ToolCall): string {
  const i = tool.input ?? {}
  const target = i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? ''
  return `${toolLabel(tool.name)}${target ? ` ${String(target)}` : ''}`
}

/**
 * 時間軸上使用者訊息的顯示文字。主程序多半已寫入給人看的版本，
 * 但舊資料或使用者直接送出的協定訊息（`[tag ...] 內容`）在這裡轉成可讀文字，
 * 不把分岔規則之類給 Claude 的指示顯示出來。不認得的標籤照原文顯示。
 */
export function userTextDisplay(text: string): string {
  const t = parseTagged(text)
  if (!t) return text
  switch (t.tag) {
    case 'answer':
      return `回答：${t.body}`
    case 'counter_question':
      return `反問：${t.body}`
    case 'branch_open': {
      const title = /^主題：(.*)$/m.exec(t.body)?.[1]?.trim()
      return title ? `開始討論：${title}` : '開始分岔討論'
    }
    case 'conclude':
      return '請 Claude 整理這個分岔的結論'
    case 'branch_conclusion':
      return `帶回分岔結論\n${t.body}`
    case 'spec_feedback':
      return `要求修改規格：${t.body}`
    case 'spec_approved':
      return '核准規格，開始實作'
    case 'report_feedback':
      return `報告回饋：\n${t.body}`
    case 'resume':
      return '繼續執行'
    default:
      return text
  }
}

const EMPTY: TimelineEvent[] = []

/** 任務的時間軸（還沒載入時是空陣列） */
export function useTimeline(taskId: string): TimelineEvent[] {
  return useStore((s) => s.timelines[taskId]) ?? EMPTY
}
