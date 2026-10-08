// src/main/permissions/gate.ts
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type {
  CanUseTool,
  HookCallback,
  McpServerProvenance,
  PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision } from '@shared/types'
import type { GatePhase } from '../tasks/stateMachine'
import { hasShellOperators, matchesPattern, suggestPattern } from './commandPattern'

export interface ApprovalRequest {
  toolName: string
  input: Record<string, unknown>
  suggestedPattern?: string
  /** SDK 的 toolUseID：UI 用來對應時間軸上的工具呼叫 */
  toolUseId?: string
}

export interface GateContext {
  getPhase(): GatePhase
  worktreePath: string
  getAllowedPatterns(): string[]
  requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<PermissionDecision>
  onApproved(command: string | undefined, rememberPattern?: string): void
}

/** evaluateTool 只需要規則相關的部分 */
export type GateRules = Pick<GateContext, 'getPhase' | 'worktreePath' | 'getAllowedPatterns'>

export interface Evaluation {
  decision: 'allow' | 'deny' | 'ask'
  message?: string
  /** Bash 的完整指令（核准後記錄用） */
  command?: string
  suggestedPattern?: string
}

export interface EvaluateOptions {
  mcpServer?: McpServerProvenance
}

/** 與 SDK 的 CanUseTool 相容，但永遠回傳結果（不回傳 null） */
export type PermissionGate = (...args: Parameters<CanUseTool>) => Promise<PermissionResult>

const READ = new Set(['Read', 'Glob', 'Grep', 'LS'])
const WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// ToolSearch 只回傳已提供工具的 schema（不執行任何東西）；Claude Code 會把 MCP 工具延後載入，
// 不允許它的話 Claude 拿不到 harness 工具的參數格式，只能猜
const ALWAYS = new Set(['TodoWrite', 'Task', 'Agent', 'ToolSearch'])
const NEEDS_APPROVAL = new Set(['WebFetch', 'WebSearch'])
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

/**
 * 明確提供給 Claude 的內建工具（query 的 `tools`）：只有上面有規則的這些。
 * 新版 Claude Code 預設不提供 Glob／Grep（改用 Bash 搜尋），但釐清階段不能用 Bash，
 * 不明確列出的話 Claude 只能猜檔名。CLI 不認得的名稱（舊工具）會被忽略。
 */
export const BUILTIN_TOOLS: string[] = [...READ, ...WRITE, 'Bash', ...NEEDS_APPROVAL, ...ALWAYS]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isOwnHarnessServer = (s: McpServerProvenance | undefined) =>
  s?.source === 'sdk' && s.name === 'harness'

/**
 * 對最近一個存在的上層做 realpath，再接回尚不存在的部分，藉此解開 symlink。
 * 路徑存在卻無法解析（例如懸空 symlink）時回傳 undefined（視為不安全）。
 */
function realpathNearest(abs: string): string | undefined {
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest)
    } catch {
      try {
        lstatSync(cur)
        return undefined
      } catch {
        /* 不存在，往上一層找 */
      }
    }
    const parent = dirname(cur)
    if (parent === cur) return undefined
    rest.unshift(basename(cur))
    cur = parent
  }
}

/** 路徑在 root 內時回傳相對於 root 的真實路徑（root 本身為 ''），否則 undefined */
function relativeInside(root: string, p: string): string | undefined {
  // resolve() 會在 realpath 之前字面上消掉 ..，使 link/../x 繞過 symlink 檢查，所以直接拒絕
  if (p.startsWith('~') || p.split('/').includes('..')) return undefined
  const r = realpathNearest(resolve(root))
  const abs = realpathNearest(resolve(root, p))
  if (!r || !abs) return undefined
  if (abs === r) return ''
  return abs.startsWith(r + sep) ? abs.slice(r.length + 1) : undefined
}

export function isInside(root: string, p: string | undefined): boolean {
  return p === undefined || relativeInside(root, p) !== undefined
}

/** 取出所有路徑參數；有任何一個不是字串就回傳 undefined（fail closed） */
function targetPaths(input: Record<string, unknown>): string[] | undefined {
  const out: string[] = []
  for (const key of PATH_KEYS) {
    const v = input[key]
    if (v === undefined) continue
    if (typeof v !== 'string') return undefined
    out.push(v)
  }
  return out
}

/**
 * Glob 的 pattern 不可含 ..，也不可在開頭或大括號選項（`{` `,` 之後）放 / 或 ~，
 * 否則 `{..,src}/**`、`{/etc,src}/**` 會繞過檢查。純絕對路徑（無大括號）須落在 worktree 內。
 */
function globEscapes(root: string, input: Record<string, unknown>): boolean {
  const pattern = input.pattern
  if (pattern === undefined) return false
  if (typeof pattern !== 'string') return true
  if (pattern.includes('..') || pattern.startsWith('~') || /[{,]\s*[/~]/.test(pattern)) return true
  if (!isAbsolute(pattern)) return false
  if (pattern.includes('{')) return true
  return !isInside(root, pattern)
}

/** .git、.claude/ 與 .mcp.json 會改變 git 或 Claude 的行為，修改前要人工核准 */
function isProtected(rel: string): boolean {
  const segs = rel.toLowerCase().split(sep)
  return segs.includes('.git') || segs.includes('.claude') || segs.at(-1) === '.mcp.json'
}

const allowE = (): Evaluation => ({ decision: 'allow' })
const denyE = (message: string): Evaluation => ({ decision: 'deny', message })

/** 純判斷：所有權限規則都在這裡，canUseTool 與 PreToolUse hook 共用 */
export function evaluateTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GateRules,
  options: EvaluateOptions = {}
): Evaluation {
  const phase = ctx.getPhase()
  const root = ctx.worktreePath
  if (phase === 'closed') return denyE('任務已結束')
  if (ALWAYS.has(toolName)) return allowE()
  if (toolName.startsWith('mcp__harness__')) {
    // 名稱可被專案設定冒用，只信任 app 在 process 內註冊的伺服器
    return isOwnHarnessServer(options.mcpServer)
      ? allowE()
      : denyE('不明來源的 harness MCP 伺服器，已拒絕')
  }

  if (READ.has(toolName)) {
    const paths = targetPaths(input)
    if (!paths) return denyE('路徑參數格式不正確')
    if (!paths.every((p) => isInside(root, p))) return denyE('只能讀取 worktree 內的檔案')
    if (toolName === 'Glob' && globEscapes(root, input)) return denyE('只能搜尋 worktree 內的檔案')
    return allowE()
  }

  if (WRITE.has(toolName)) {
    if (phase !== 'implement')
      return denyE('目前不是實作階段，不能修改檔案。請用 ask_user 提問或用 propose_spec 提出規格。')
    const paths = targetPaths(input)
    if (!paths) return denyE('路徑參數格式不正確')
    if (paths.length === 0 || paths.some((p) => !p)) return denyE('缺少要修改的檔案路徑')
    const rels = paths.map((p) => relativeInside(root, p))
    if (rels.some((r) => r === undefined)) return denyE('只能修改 worktree 內的檔案')
    if (rels.some((r) => isProtected(r!)))
      return { decision: 'ask', message: '修改 git、Claude 或 MCP 設定檔需要使用者核准' }
    return allowE()
  }

  if (toolName === 'Bash') {
    if (phase !== 'implement') return denyE('目前不是實作階段，不能執行指令。')
    if (typeof input.command !== 'string') return denyE('指令格式不正確')
    const command = input.command
    const chained = hasShellOperators(command)
    if (!chained && ctx.getAllowedPatterns().some((p) => matchesPattern(command, p)))
      return allowE()
    return {
      decision: 'ask',
      message: '需要使用者核准這個指令',
      command,
      suggestedPattern: chained ? undefined : suggestPattern(command)
    }
  }

  if (NEEDS_APPROVAL.has(toolName)) return { decision: 'ask', message: '需要使用者核准' }

  return denyE(`Harness 不允許使用 ${toolName}`)
}

/** 等待核准期間任務可能被停止或改變階段；核准後再確認一次 */
function phaseStillAllows(toolName: string, phase: GatePhase): boolean {
  if (phase === 'closed') return false
  if (WRITE.has(toolName) || toolName === 'Bash') return phase === 'implement'
  return true
}

const allow = (input: Record<string, unknown>): PermissionResult => ({
  behavior: 'allow',
  updatedInput: input
})
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

/** canUseTool：套用規則，需要核准時詢問使用者 */
export function createPermissionGate(ctx: GateContext): PermissionGate {
  return async (toolName, input, { signal, mcpServer, toolUseID }) => {
    if (signal.aborted) return deny('已取消')
    const e = evaluateTool(toolName, input, ctx, { mcpServer })
    if (e.decision === 'allow') return allow(input)
    if (e.decision === 'deny') return deny(e.message ?? `Harness 不允許使用 ${toolName}`)

    const d = await ctx.requestApproval(
      { toolName, input, suggestedPattern: e.suggestedPattern, toolUseId: toolUseID },
      signal
    )
    if (!d.allow) return deny(d.message?.trim() || '使用者拒絕了這個操作')
    if (signal.aborted) return deny('已取消')
    if (!phaseStillAllows(toolName, ctx.getPhase())) return deny('任務狀態已改變')
    // 只有指令可以記住樣式
    ctx.onApproved(e.command, e.command ? d.rememberPattern : undefined)
    return allow(input)
  }
}

/**
 * PreToolUse hook：在 SDK 套用專案的 allow 規則之前執行，硬性規則（deny／ask）一定生效。
 * ask 會讓 SDK 轉交 canUseTool 走核准流程。
 */
export function createPreToolUseHook(ctx: GateRules): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    // 沒有來源資訊（舊版 CLI）時不做決定，交給拿得到 mcpServer 的 canUseTool
    if (input.tool_name.startsWith('mcp__harness__') && !input.mcp_server) return {}
    const e: Evaluation = isRecord(input.tool_input)
      ? evaluateTool(input.tool_name, input.tool_input, ctx, { mcpServer: input.mcp_server })
      : denyE('工具參數格式不正確')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: e.decision,
        permissionDecisionReason: e.message
      }
    }
  }
}
