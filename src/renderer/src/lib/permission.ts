// src/renderer/src/lib/permission.ts
import type { PermissionRequest, Task } from '@shared/types'
import { relativeTo } from './timeline'

/**
 * 核准對話框出現後按鈕先停用的時間：連點「允許」時第二下不會落在下一個排隊的請求上，
 * 對話框突然出現在游標下時也不會被誤按。
 */
export const APPROVAL_ARM_MS = 500
/** 要寫入的內容先顯示前幾個字，其餘按「顯示完整內容」展開 */
export const PREVIEW_COLLAPSED = 1500

/** 修改這些工具的請求只會出現在 .git／.claude／.mcp.json（主程序只對這些路徑詢問） */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 要寫入的內容：Write 的全文、Edit 的取代前後（- / + 開頭） */
export function writePreview(input: Record<string, unknown>): string | undefined {
  const lines = (prefix: string, s?: string) =>
    s === undefined ? [] : s.split('\n').map((l) => `${prefix} ${l}`)
  const edit = (e: Record<string, unknown>) =>
    [...lines('-', str(e.old_string)), ...lines('+', str(e.new_string))].join('\n')
  const text =
    str(input.content) ??
    str(input.new_source) ??
    (Array.isArray(input.edits)
      ? input.edits.filter(isRecord).map(edit).join('\n…\n')
      : str(input.new_string) !== undefined
        ? edit(input)
        : undefined)
  return text || undefined
}

/** 提出請求的是誰：主線是 Claude，分岔標出分岔名稱 */
export function requesterOf(task: Task, r: PermissionRequest): string | undefined {
  if (!r.channel.startsWith('branch:')) return undefined
  const id = r.channel.slice('branch:'.length)
  return task.branches.find((b) => b.id === id)?.title ?? id
}

export interface RequestView {
  title: string
  /** 深色區塊的主要內容：指令、檔案路徑、網址… */
  code: string
  /** 深色區塊的第二行（工具名稱、cwd） */
  sub?: string
  /** Claude 給的原因或用途 */
  reason?: string
  warning?: string
  preview?: string
}

/** 核准對話框的內容；branch 是提出請求的分岔名稱（主線不給） */
export function describeRequest(r: PermissionRequest, cwd: string, branch?: string): RequestView {
  const who = branch === undefined ? 'Claude ' : `分岔「${branch}」`
  const i = r.input
  if (r.toolName === 'Bash') {
    const description = str(i.description)
    return {
      title: `${who}想執行這個指令`,
      code: `$ ${str(i.command) ?? ''}`,
      sub: `cwd: ${cwd}`,
      reason: description && `原因：${description}`
    }
  }
  if (WRITE_TOOLS.has(r.toolName)) {
    const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? ''
    return {
      title: `${who}想修改這個檔案`,
      code: relativeTo(cwd, path),
      sub: `${r.toolName} · cwd: ${cwd}`,
      warning: '這個檔案會影響 Claude 的權限或 git 設定',
      preview: writePreview(i)
    }
  }
  if (r.toolName === 'WebFetch') {
    const prompt = str(i.prompt)
    return {
      title: `${who}想讀取這個網頁`,
      code: str(i.url) ?? '',
      sub: 'WebFetch',
      reason: prompt && `用途：${prompt}`
    }
  }
  if (r.toolName === 'WebSearch')
    return { title: `${who}想搜尋網路`, code: str(i.query) ?? '', sub: 'WebSearch' }
  return {
    title: `${who}想使用 ${r.toolName}`,
    code: JSON.stringify(i, null, 2),
    sub: `cwd: ${cwd}`
  }
}
