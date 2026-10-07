// src/main/ipcGuards.ts
// IPC 邊界的輸入檢查（純函式，不依賴 electron，可單元測試）
import type { Channel, ClaudeStatus, Settings } from '@shared/types'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** 任務／repo id：只允許英數、底線與連字號，避免被拿來組出 Store 以外的路徑 */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

export function assertId(value: unknown, what: string): string {
  if (!isSafeId(value)) throw new Error(`無效的${what} id`)
  return value
}

export function assertVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error('無效的報告版本')
  return value
}

export function assertChannel(value: unknown): Channel {
  if (value === 'main') return value
  if (typeof value === 'string' && value.startsWith('branch:')) {
    if (isSafeId(value.slice('branch:'.length))) return value as Channel
  }
  throw new Error('無效的對話頻道')
}

const SETTINGS_KEYS: (keyof Settings)[] = [
  'defaultModel',
  'worktreeRoot',
  'branchPrefix',
  'alwaysAllowedCommands',
  'loadProjectSettings',
  'claudePath'
]

/** 只保留已知的設定欄位，其他欄位不寫進 settings.json */
export function pickSettingsPatch(patch: unknown): Partial<Settings> {
  if (!patch || typeof patch !== 'object') throw new Error('無效的設定')
  const out: Record<string, unknown> = {}
  for (const k of SETTINGS_KEYS) if (k in patch) out[k] = (patch as Record<string, unknown>)[k]
  return out as Partial<Settings>
}

/**
 * 開始任務前確認 Claude Code 已登入：快取的狀態未登入時重新偵測一次
 * （使用者可能在 app 開著時才去終端機登入），仍未登入就以偵測的錯誤訊息拒絕。
 */
export async function ensureClaudeReady(
  getStatus: (refresh?: boolean) => Promise<ClaudeStatus>
): Promise<ClaudeStatus> {
  let s = await getStatus()
  if (!s.loggedIn) s = await getStatus(true)
  if (!s.loggedIn) throw new Error(s.error ?? '尚未登入，請在終端機執行 claude 並完成登入。')
  return s
}
