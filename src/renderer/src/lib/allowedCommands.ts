// src/renderer/src/lib/allowedCommands.ts
// 設定頁「永遠允許的指令」新增前的檢查（比對規則見 src/main/permissions/commandPattern.ts）
import { hasShellOperators, normalizeCommand } from '@shared/commandPattern'

export interface PatternCheck {
  /** 正規化後要存的樣式；空字串代表還沒輸入 */
  pattern: string
  /** 不能加入的原因 */
  error?: string
  /** 可以加入，但要提醒使用者的事（已知危險、範圍很廣、* 不在結尾） */
  warning?: string
}

/** 已知會造成破壞或能寫到 worktree 以外的樣式：可以加入，但說明原因 */
const DANGEROUS: Record<string, string> = {
  'rm *': '會允許刪除任何檔案',
  'rm -rf *': '會允許遞迴刪除任何檔案',
  'git push *': '會允許把變更推送到遠端',
  'git diff *': '會允許 git diff 帶 --output，把結果寫到 worktree 以外的檔案',
  'git log *': '會允許 git log 帶 --output，把結果寫到 worktree 以外的檔案',
  'curl *': '會允許任意網路請求，也能下載或上傳檔案'
}

export function checkNewPattern(raw: string, existing: string[]): PatternCheck {
  const pattern = normalizeCommand(raw)
  if (!pattern) return { pattern }
  if (existing.some((c) => normalizeCommand(c) === pattern))
    return { pattern, error: `「${pattern}」已經在清單中` }
  // 含串接或重導的指令一律詢問，這種樣式永遠不會生效
  if (hasShellOperators(pattern))
    return { pattern, error: '含有 ; & | ` < > $ 的指令一律需要核准，加進清單也不會生效' }
  if (pattern.split(' ')[0] === 'sudo')
    return { pattern, warning: `「${pattern}」會允許以管理員權限執行指令，請確認真的需要` }
  if (DANGEROUS[pattern])
    return { pattern, warning: `「${pattern}」${DANGEROUS[pattern]}，請確認真的需要` }
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
