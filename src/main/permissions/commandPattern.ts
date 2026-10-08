// src/main/permissions/commandPattern.ts
import { hasShellOperators, normalizeCommand as normalize } from '@shared/commandPattern'

export { hasShellOperators }

export function matchesPattern(command: string, pattern: string): boolean {
  const c = normalize(command)
  const p = normalize(pattern)
  if (!p) return false
  if (p.endsWith(' *')) {
    const prefix = p.slice(0, -2)
    return c === prefix || c.startsWith(`${prefix} `)
  }
  return c === p
}

/**
 * 這些指令換個參數就可能刪檔、把結果寫到 worktree 以外（git diff／log 的 --output）、連網或推送：
 * 核准時只建議記住完全相同的指令（設定頁對這些樣式也會提醒，見 renderer 的 allowedCommands.ts）
 */
const EXACT_ONLY = [['rm'], ['curl'], ['sudo'], ['git', 'diff'], ['git', 'log'], ['git', 'push']]

/** 核准對話框「本任務內都允許」建議的樣式：前兩個詞加 *；危險的指令是完全相同的指令 */
export function suggestPattern(command: string): string {
  const c = normalize(command)
  const parts = c.split(' ')
  if (EXACT_ONLY.some((words) => words.every((w, i) => parts[i] === w))) return c
  return `${parts.slice(0, Math.min(2, parts.length)).join(' ')} *`
}
