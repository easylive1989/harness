// src/renderer/src/lib/allowedCommands.ts
// 設定頁「永遠允許的指令」新增前的檢查（比對規則見 src/main/permissions/commandPattern.ts）
import { hasShellOperators, normalizeCommand } from '@shared/commandPattern'

export interface PatternCheck {
  /** 正規化後要存的樣式；空字串代表還沒輸入 */
  pattern: string
  /** 不能加入的原因 */
  error?: string
  /** 可以加入，但要提醒使用者的事（範圍很廣、* 不在結尾） */
  warning?: string
}

export function checkNewPattern(raw: string, existing: string[]): PatternCheck {
  const pattern = normalizeCommand(raw)
  if (!pattern) return { pattern }
  if (existing.some((c) => normalizeCommand(c) === pattern))
    return { pattern, error: `「${pattern}」已經在清單中` }
  // 含串接或重導的指令一律詢問，這種樣式永遠不會生效
  if (hasShellOperators(pattern))
    return { pattern, error: '含有 ; & | ` < > $ 的指令一律需要核准，加進清單也不會生效' }
  const wildcard = pattern.endsWith(' *')
  const prefix = wildcard ? pattern.slice(0, -2) : pattern
  if (prefix.includes('*'))
    return { pattern, warning: '只有結尾的「 *」代表任意參數，其他位置的 * 會當成一般字元比對' }
  if (wildcard && !prefix.includes(' '))
    return {
      pattern,
      warning: `「${pattern}」會允許所有 ${prefix} 開頭的指令，範圍很廣`
    }
  return { pattern }
}
