// src/main/ipcGuards.ts
// IPC 邊界的輸入檢查（純函式，不依賴 electron，可單元測試）
import { isAbsolute, resolve, sep } from 'node:path'
import { type Channel, type ClaudeStatus, MODELS, type ModelId, type Settings } from '@shared/types'

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

/** 字串參數：預設不可為空白、最長 100000 字元 */
export function assertString(
  value: unknown,
  what: string,
  { max = 100_000, allowEmpty = false }: { max?: number; allowEmpty?: boolean } = {}
): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()))
    throw new Error(`無效的${what}`)
  return value
}

export function assertModel(value: unknown): ModelId {
  if (!MODELS.some((m) => m.id === value)) throw new Error('無效的模型')
  return value as ModelId
}

const nonEmpty = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what}必須是非空白的文字`)
  return v
}

/** 每個已知設定欄位的檢查與整理；未知欄位不寫進 settings.json */
const SETTINGS_VALIDATORS: { [K in keyof Settings]-?: (v: unknown) => Settings[K] } = {
  defaultModel: (v) => {
    if (!MODELS.some((m) => m.id === v)) throw new Error('不支援的模型')
    return v as ModelId
  },
  worktreeRoot: (v) => {
    const p = nonEmpty(v, 'worktree 位置')
    if (!isAbsolute(p)) throw new Error('worktree 位置必須是絕對路徑')
    return p
  },
  branchPrefix: (v) => nonEmpty(v, '分支前綴'),
  alwaysAllowedCommands: (v) => {
    if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !c.trim()))
      throw new Error('允許清單必須是非空白指令的清單')
    return v.map((c: string) => c.trim())
  },
  loadProjectSettings: (v) => {
    if (typeof v !== 'boolean') throw new Error('載入專案設定必須是開或關')
    return v
  },
  claudePath: (v) => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') throw new Error('claude 路徑必須是文字')
    // 空字串代表改回自動偵測
    return v.trim() || undefined
  }
}

export function validateSettingsPatch(patch: unknown): Partial<Settings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('無效的設定')
  const out: Record<string, unknown> = {}
  for (const [k, validate] of Object.entries(SETTINGS_VALIDATORS)) {
    if (k in patch)
      out[k] = (validate as (v: unknown) => unknown)((patch as Record<string, unknown>)[k])
  }
  return out as Partial<Settings>
}

/** path 是否位於 roots 其中之一（含本身）；只接受絕對路徑，`..` 會先解析掉 */
export function isPathInside(path: unknown, roots: string[]): boolean {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const p = resolve(path)
  return roots.some((root) => {
    const r = resolve(root)
    return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
  })
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
