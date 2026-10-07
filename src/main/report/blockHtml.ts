// src/main/report/blockHtml.ts
import { isSafeId } from '../ipcGuards'

export { BLOCK_CSP, wrapBlockHtml } from '@shared/blockHtml'

/** 與 @shared/report 的 custom block id 規則一致 */
const BLOCK_ID = /^[a-z0-9_-]{1,64}$/

/** 解析 `harness-block://report/<taskId>/<version>/<blockId>`，格式不符回傳 null */
export function parseBlockUrl(
  url: string
): { taskId: string; version: number; blockId: string } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'harness-block:' || u.hostname !== 'report') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length !== 3) return null
  const [taskId, v, blockId] = parts
  if (!isSafeId(taskId) || !BLOCK_ID.test(blockId) || !/^[1-9][0-9]{0,8}$/.test(v)) return null
  return { taskId, version: Number(v), blockId }
}
