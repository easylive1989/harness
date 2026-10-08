// src/renderer/src/report/diffFiles.ts
// 大 diff 的處理：自動產生的檔案、截斷與匯出摘要的門檻
import type { DiffFile } from '@shared/diff'

/** 畫面上超過這麼多行的檔案先只顯示前 TRUNCATED_LINES 行，按「顯示全部」才全部畫出來 */
export const TRUNCATE_OVER = 1500
export const TRUNCATED_LINES = 300
/** 匯出時超過這麼多行的檔案只放一行摘要（鎖定檔一律只放摘要） */
export const EXPORT_OVER = 3000

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const isLockfile = (path: string) => LOCKFILES.has(baseName(path))

/** 鎖定檔、壓縮過的 js、dist/ 與 build/ 底下的檔案 */
export function isGenerated(path: string): boolean {
  return isLockfile(path) || path.endsWith('.min.js') || /(^|\/)(dist|build)\//.test(path)
}

/** 預設選取的檔案：第一個不是自動產生的檔案；全部都是的話取第一個 */
export function defaultFile(files: DiffFile[]): DiffFile | undefined {
  return files.find((f) => !isGenerated(f.path)) ?? files[0]
}

/** 檔案 diff 的行數（新增、刪除與上下文行，不含段落標頭） */
export const lineCount = (file: DiffFile) => file.hunks.reduce((n, h) => n + h.lines.length, 0)
