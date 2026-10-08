// src/main/ipcGuards.ts
// IPC 邊界的輸入檢查（純函式，不依賴 electron，可單元測試）
import { isAbsolute, resolve, sep } from 'node:path'
import {
  base64Bytes,
  type ImageInput,
  type ImageRef,
  isImageMediaType,
  MAX_IMAGE_BYTES,
  MAX_IMAGES
} from '@shared/images'
import {
  type Channel,
  type ClaudeStatus,
  type EffortChoice,
  EFFORTS,
  type ModelId,
  PERMISSION_MODES,
  type PermissionModeChoice,
  type RunOptions,
  type Settings,
  WORKSPACES,
  type WorkspaceMode
} from '@shared/types'

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

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** 單張附加圖片：格式在白名單內、資料是 base64 且不超過大小上限 */
export function assertImageRef(value: unknown): ImageRef {
  const v = value as Partial<ImageRef> | null
  if (!v || typeof v !== 'object' || !isSafeId(v.id) || !isImageMediaType(v.mediaType))
    throw new Error('無效的圖片')
  return { id: v.id, mediaType: v.mediaType }
}

/** 訊息附加的圖片：沒有附加時回傳空陣列 */
export function assertImages(value: unknown): ImageInput[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('無效的圖片')
  if (value.length > MAX_IMAGES) throw new Error(`一則訊息最多附加 ${MAX_IMAGES} 張圖片`)
  return value.map((raw: unknown) => {
    const img = raw as Partial<ImageInput> | null
    if (!img || typeof img !== 'object' || !isImageMediaType(img.mediaType))
      throw new Error('只支援 PNG、JPEG、GIF、WebP 圖片')
    if (typeof img.data !== 'string' || !img.data || !BASE64.test(img.data))
      throw new Error('無效的圖片資料')
    if (base64Bytes(img.data) > MAX_IMAGE_BYTES) throw new Error('單張圖片不能超過 5 MB')
    const name = typeof img.name === 'string' ? img.name.slice(0, 255) : undefined
    return { mediaType: img.mediaType, data: img.data, ...(name ? { name } : {}) }
  })
}

/** 模型清單依帳號動態取得，這裡只檢查格式（完整 id 或 `opus[1m]` 之類的別名） */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/

export function assertModel(value: unknown): ModelId {
  if (typeof value !== 'string' || !MODEL_ID.test(value)) throw new Error('無效的模型')
  return value
}

export function assertEffort(value: unknown): EffortChoice {
  if (!EFFORTS.some((e) => e.id === value)) throw new Error('無效的 effort')
  return value as EffortChoice
}

export function assertPermissionMode(value: unknown): PermissionModeChoice {
  if (!PERMISSION_MODES.some((m) => m.id === value)) throw new Error('無效的權限模式')
  return value as PermissionModeChoice
}

/** 任務進行中修改的執行選項：只收有給的欄位 */
export function assertRunOptionsPatch(value: unknown): Partial<RunOptions> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('無效的執行選項')
  const v = value as Record<string, unknown>
  const out: Partial<RunOptions> = {}
  if (v.model !== undefined) out.model = assertModel(v.model)
  if (v.effort !== undefined) out.effort = assertEffort(v.effort)
  if (v.permissionMode !== undefined) out.permissionMode = assertPermissionMode(v.permissionMode)
  return out
}

export function assertWorkspace(value: unknown): WorkspaceMode {
  if (!WORKSPACES.some((w) => w.id === value)) throw new Error('無效的工作方式')
  return value as WorkspaceMode
}

const nonEmpty = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what}必須是非空白的文字`)
  return v.trim()
}

/**
 * git check-ref-format 的分支名稱規則（純 JS 版，不必執行 git）：不可有空白、控制字元與
 * ~^:?*[\，不可有 ..、@{、//，不可以 - 或 / 開頭、以 / 或 . 結尾，
 * 每一段不可以 . 開頭或以 .lock 結尾；保險起見也拒絕單獨的 `@` 與 `HEAD`。
 * 檢查的是完整的分支名稱：設定的分支前綴以 `${前綴}x` 代表之後接上「日期-代號」的樣子。
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name === '@' || name === 'HEAD') return false
  if (/[\s~^:?*[\\]/.test(name)) return false
  // 控制字元（含 DEL）
  if ([...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (/^[-/]/.test(name) || /[/.]$/.test(name)) return false
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** 每個已知設定欄位的檢查與整理；未知欄位不寫進 settings.json */
const SETTINGS_VALIDATORS: { [K in keyof Settings]-?: (v: unknown) => Settings[K] } = {
  defaultModel: (v) => assertModel(v),
  defaultEffort: (v) => assertEffort(v),
  defaultPermissionMode: (v) => assertPermissionMode(v),
  defaultWorkspace: (v) => assertWorkspace(v),
  worktreeRoot: (v) => {
    const p = nonEmpty(v, 'worktree 位置')
    if (!isAbsolute(p)) throw new Error('worktree 位置必須是絕對路徑')
    // 去掉 ..、多餘的 / 與結尾的 /
    return resolve(p)
  },
  branchPrefix: (v) => {
    const prefix = nonEmpty(v, '分支前綴')
    // 前綴後面會接「日期-代號」，所以檢查接上一個字元之後的名稱
    if (!isValidBranchName(`${prefix}x`)) throw new Error('分支前綴不符合 git 分支名稱規則')
    return prefix
  },
  alwaysAllowedCommands: (v) => {
    if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !c.trim()))
      throw new Error('允許清單必須是非空白指令的清單')
    return [...new Set(v.map((c: string) => c.trim()))]
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
