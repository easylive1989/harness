// src/main/permissions/gate.ts
import { resolve, sep } from 'node:path'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision } from '@shared/types'
import type { GatePhase } from '../tasks/stateMachine'
import { hasShellOperators, matchesPattern, suggestPattern } from './commandPattern'

export interface ApprovalRequest {
  toolName: string
  input: Record<string, unknown>
  suggestedPattern?: string
}

export interface GateContext {
  getPhase(): GatePhase
  worktreePath: string
  getAllowedPatterns(): string[]
  requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<PermissionDecision>
  onApproved(command: string | undefined, rememberPattern?: string): void
}

/** 與 SDK 的 CanUseTool 相容，但永遠回傳結果（不回傳 null） */
export type PermissionGate = (...args: Parameters<CanUseTool>) => Promise<PermissionResult>

const READ = new Set(['Read', 'Glob', 'Grep', 'LS'])
const WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const ALWAYS = new Set(['TodoWrite', 'Task', 'Agent'])
const NEEDS_APPROVAL = new Set(['WebFetch', 'WebSearch'])

const allow = (input: Record<string, unknown>): PermissionResult => ({
  behavior: 'allow',
  updatedInput: input
})
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

export function isInside(root: string, p: string | undefined): boolean {
  if (!p) return true
  const r = resolve(root)
  const abs = resolve(r, p)
  return abs === r || abs.startsWith(r + sep)
}

function targetPath(input: Record<string, unknown>): string | undefined {
  const v = input.file_path ?? input.notebook_path ?? input.path
  return typeof v === 'string' ? v : undefined
}

export function createPermissionGate(ctx: GateContext): PermissionGate {
  async function ask(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    command?: string,
    suggestedPattern?: string
  ) {
    const d = await ctx.requestApproval({ toolName, input, suggestedPattern }, signal)
    if (!d.allow) return deny(d.message?.trim() || '使用者拒絕了這個操作')
    ctx.onApproved(command, d.rememberPattern)
    return allow(input)
  }

  return async (toolName, input, { signal }) => {
    const phase = ctx.getPhase()
    if (phase === 'closed') return deny('任務已結束')
    if (toolName.startsWith('mcp__harness__') || ALWAYS.has(toolName)) return allow(input)

    if (READ.has(toolName)) {
      return isInside(ctx.worktreePath, targetPath(input))
        ? allow(input)
        : deny('只能讀取 worktree 內的檔案')
    }

    if (WRITE.has(toolName)) {
      if (phase !== 'implement')
        return deny(
          '目前不是實作階段，不能修改檔案。請用 ask_user 提問或用 propose_spec 提出規格。'
        )
      return isInside(ctx.worktreePath, targetPath(input))
        ? allow(input)
        : deny('只能修改 worktree 內的檔案')
    }

    if (toolName === 'Bash') {
      if (phase !== 'implement') return deny('目前不是實作階段，不能執行指令。')
      const command = String(input.command ?? '')
      const chained = hasShellOperators(command)
      if (!chained && ctx.getAllowedPatterns().some((p) => matchesPattern(command, p)))
        return allow(input)
      return ask(toolName, input, signal, command, chained ? undefined : suggestPattern(command))
    }

    if (NEEDS_APPROVAL.has(toolName)) return ask(toolName, input, signal)

    return deny(`Harness 不允許使用 ${toolName}`)
  }
}
