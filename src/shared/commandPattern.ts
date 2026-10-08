// src/shared/commandPattern.ts
// 指令樣式的共用規則：主程序的權限判斷與設定頁的輸入檢查用同一份

/** 去掉前後空白並把連續空白合併成一個 */
export const normalizeCommand = (s: string) => s.trim().replace(/\s+/g, ' ')

/** 串接、重導、命令替換、變數展開或換行都視為需要人工核准 */
export function hasShellOperators(command: string): boolean {
  return /[;&|`<>$\n\r]/.test(command)
}
