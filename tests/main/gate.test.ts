import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HookJSONOutput,
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput
} from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, test, vi } from 'vitest'
import {
  BUILTIN_TOOLS,
  createPermissionGate,
  createPreToolUseHook,
  evaluateTool,
  type GateContext
} from '../../src/main/permissions/gate'
import type { GatePhase } from '../../src/main/tasks/stateMachine'

type McpServer = { name: string; source: string }
const OURS: McpServer = { name: 'harness', source: 'sdk' }

function setup(
  phase: GatePhase,
  decision = { allow: true },
  patterns: string[] = [],
  worktreePath = '/wt/t1'
) {
  const state = { phase }
  const ctx: GateContext = {
    getPhase: () => state.phase,
    worktreePath,
    getAllowedPatterns: () => patterns,
    requestApproval: vi.fn(async () => decision),
    onApproved: vi.fn(),
    onBlocked: vi.fn()
  }
  const gate = createPermissionGate(ctx)
  const call = (
    tool: string,
    input: Record<string, unknown>,
    mcpServer?: McpServer,
    signal = new AbortController().signal
  ) => gate(tool, input, { signal, mcpServer, toolUseID: 'u1' } as never)
  const hook = createPreToolUseHook(ctx)
  const callHook = async (tool: string, toolInput: unknown, mcpServer?: McpServer) =>
    hookDecision(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: tool,
          tool_input: toolInput,
          tool_use_id: 'u1',
          session_id: 's1',
          transcript_path: '',
          cwd: worktreePath,
          mcp_server: mcpServer
        },
        'u1',
        { signal: new AbortController().signal }
      )
    )
  return { ctx, state, call, hook, callHook }
}

function hookDecision(out: HookJSONOutput) {
  const specific = (out as SyncHookJSONOutput).hookSpecificOutput as
    PreToolUseHookSpecificOutput | undefined
  return specific?.permissionDecision
}

describe('PermissionGate', () => {
  test('規則拒絕時通知 onBlocked（Harness 擋下，不是使用者拒絕）；使用者拒絕不通知', async () => {
    const { call, ctx } = setup('implement')
    await call('Read', { file_path: '/etc/passwd' })
    expect(ctx.onBlocked).toHaveBeenCalledWith('u1', '只能讀取 worktree 內的檔案')
    const denied = setup('implement', { allow: false })
    await denied.call('Bash', { command: 'npm run build' })
    expect(denied.ctx.onBlocked).not.toHaveBeenCalled()
  })

  test('核准後任務狀態已改變：也算 Harness 擋下', async () => {
    const { call, ctx, state } = setup('implement')
    vi.mocked(ctx.requestApproval).mockImplementationOnce(async () => {
      state.phase = 'clarify'
      return { allow: true }
    })
    expect(await call('Bash', { command: 'npm run build' })).toMatchObject({ behavior: 'deny' })
    expect(ctx.onBlocked).toHaveBeenCalledWith('u1', '任務狀態已改變')
  })

  test('harness 工具與 TodoWrite 永遠允許', async () => {
    const { call } = setup('clarify')
    expect((await call('mcp__harness__ask_user', {}, OURS)).behavior).toBe('allow')
    expect((await call('TodoWrite', {})).behavior).toBe('allow')
  })

  test('ToolSearch 永遠允許：Claude Code 把 MCP 工具的 schema 延後載入，要先用它才能正確呼叫 harness 工具', async () => {
    const { call, callHook } = setup('clarify')
    const input = { query: 'select:mcp__harness__ask_user', max_results: 1 }
    expect((await call('ToolSearch', input)).behavior).toBe('allow')
    expect(await callHook('ToolSearch', input)).toBe('allow')
  })

  test('提供給 Claude 的內建工具：含 Glob／Grep（新版 Claude Code 預設不提供），且都有權限規則', () => {
    expect(BUILTIN_TOOLS).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'Edit', 'Bash']))
    const rules = {
      getPhase: () => 'implement' as const,
      worktreePath: '/wt/t1',
      getAllowedPatterns: () => []
    }
    for (const tool of BUILTIN_TOOLS)
      expect(evaluateTool(tool, {}, rules).message ?? '').not.toContain('不允許使用')
  })

  test('只信任 app 自己註冊（source: sdk）的 harness MCP 伺服器', async () => {
    const { call } = setup('implement')
    expect(
      (await call('mcp__harness__ask_user', {}, { name: 'harness', source: 'project' })).behavior
    ).toBe('deny')
    expect((await call('mcp__harness__ask_user', {})).behavior).toBe('deny')
    expect(
      (await call('mcp__harness__ask_user', {}, { name: 'other', source: 'sdk' })).behavior
    ).toBe('deny')
  })

  test('讀取：worktree 內允許、外部拒絕、無路徑允許', async () => {
    const { call } = setup('clarify')
    expect((await call('Read', { file_path: '/wt/t1/src/a.ts' })).behavior).toBe('allow')
    expect((await call('Read', { file_path: 'src/a.ts' })).behavior).toBe('allow')
    expect((await call('Read', { file_path: '/etc/passwd' })).behavior).toBe('deny')
    expect((await call('Read', { file_path: '/wt/t1-other/a.ts' })).behavior).toBe('deny')
    expect((await call('Grep', { pattern: 'x' })).behavior).toBe('allow')
  })

  test('~ 開頭的路徑一律拒絕', async () => {
    const { call } = setup('implement')
    expect((await call('Read', { file_path: '~/x' })).behavior).toBe('deny')
    expect((await call('Write', { file_path: '~/x' })).behavior).toBe('deny')
  })

  test('路徑參數不是字串、或寫入工具沒有路徑時拒絕', async () => {
    const { call } = setup('implement')
    expect((await call('Read', { file_path: 123 })).behavior).toBe('deny')
    expect((await call('Grep', { pattern: 'x', path: ['/etc'] })).behavior).toBe('deny')
    expect((await call('Read', { file_path: null })).behavior).toBe('deny')
    expect((await call('Write', { content: 'x' })).behavior).toBe('deny')
  })

  test('Glob 的絕對路徑或含 .. 的 pattern 必須落在 worktree 內', async () => {
    const { call } = setup('clarify')
    expect((await call('Glob', { pattern: 'src/**/*.ts' })).behavior).toBe('allow')
    expect((await call('Glob', { pattern: '/wt/t1/src/**' })).behavior).toBe('allow')
    expect((await call('Glob', { pattern: '/etc/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: '../**/*.ts' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/../../**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/../lib/*.ts' })).behavior).toBe('deny')
  })

  test('Glob 的大括號展開不能繞過檢查', async () => {
    const { call } = setup('clarify')
    expect((await call('Glob', { pattern: '{..,src}/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: '{/etc,src}/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/{a,~/x}/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/**/*.{ts,tsx}' })).behavior).toBe('allow')
  })

  test('symlink 指到 worktree 外時拒絕', async () => {
    const base = await mkdtemp(join(tmpdir(), 'harness-gate-'))
    const wt = join(base, 'wt')
    const outside = join(base, 'outside')
    await mkdir(wt)
    await mkdir(outside)
    await writeFile(join(outside, 'secret'), 's')
    await writeFile(join(wt, 'ok.ts'), '')
    await symlink(outside, join(wt, 'link'))
    await symlink(join(outside, 'not-yet'), join(wt, 'dangling'))
    const { call } = setup('implement', { allow: true }, [], wt)
    expect((await call('Read', { file_path: join(wt, 'ok.ts') })).behavior).toBe('allow')
    expect((await call('Write', { file_path: join(wt, 'new.ts') })).behavior).toBe('allow')
    expect((await call('Read', { file_path: join(wt, 'link/secret') })).behavior).toBe('deny')
    expect((await call('Write', { file_path: 'link/new.ts' })).behavior).toBe('deny')
    expect((await call('Write', { file_path: join(wt, 'dangling') })).behavior).toBe('deny')
  })

  test('路徑含 .. 一律拒絕（避免 link/.. 被字面上消掉而繞過 symlink）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'harness-gate-'))
    const wt = join(base, 'wt')
    const outside = join(base, 'outside', 'deep')
    await mkdir(wt)
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(wt, 'link'))
    const { call } = setup('implement', { allow: true }, [], wt)
    expect((await call('Write', { file_path: `${wt}/link/../pwn.sh` })).behavior).toBe('deny')
    expect((await call('Write', { file_path: 'link/../pwn.sh' })).behavior).toBe('deny')
    expect((await call('Read', { file_path: 'link/../secret' })).behavior).toBe('deny')
    expect((await call('Grep', { pattern: 'x', path: 'src/..' })).behavior).toBe('deny')
    expect((await call('Write', { file_path: join(wt, 'a..b.ts') })).behavior).toBe('allow')
  })

  test('釐清與分岔階段不能寫檔或執行指令', async () => {
    for (const phase of ['clarify', 'branch'] as const) {
      const { call, ctx } = setup(phase)
      expect((await call('Edit', { file_path: '/wt/t1/a.ts' })).behavior).toBe('deny')
      expect((await call('Bash', { command: 'ls' })).behavior).toBe('deny')
      expect(ctx.requestApproval).not.toHaveBeenCalled()
    }
  })

  test('實作階段 worktree 內寫檔自動允許', async () => {
    const { call } = setup('implement')
    expect((await call('Write', { file_path: '/wt/t1/new.ts' })).behavior).toBe('allow')
    expect((await call('Write', { file_path: '/wt/t1/.gitignore' })).behavior).toBe('allow')
    expect((await call('Edit', { file_path: '/other/a.ts' })).behavior).toBe('deny')
  })

  test('寫入 .git、.claude/、.mcp.json 需要使用者核准', async () => {
    for (const file_path of [
      '/wt/t1/.git',
      '/wt/t1/.git/hooks/pre-commit',
      '/wt/t1/.claude/settings.json',
      '/wt/t1/pkg/.mcp.json'
    ]) {
      const { call, ctx } = setup('implement')
      expect((await call('Write', { file_path })).behavior).toBe('allow')
      expect(ctx.requestApproval).toHaveBeenCalledTimes(1)
    }
    const { call } = setup('implement', { allow: false } as never)
    expect((await call('Edit', { file_path: '/wt/t1/.claude/settings.json' })).behavior).toBe(
      'deny'
    )
  })

  test('符合允許樣式的指令直接允許', async () => {
    const { call, ctx } = setup('implement', { allow: true }, ['npm test *'])
    expect((await call('Bash', { command: 'npm test -- auth' })).behavior).toBe('allow')
    expect(ctx.requestApproval).not.toHaveBeenCalled()
  })

  test('有串接的指令即使符合樣式也要核准', async () => {
    const { call, ctx } = setup('implement', { allow: true }, ['npm test *'])
    await call('Bash', { command: 'npm test && rm -rf /' })
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedPattern: undefined }),
      expect.anything()
    )
  })

  test('使用者核准後回呼 onApproved，並附上建議樣式', async () => {
    const { call, ctx } = setup('implement', {
      allow: true,
      rememberPattern: 'npm test *'
    } as never)
    const r = await call('Bash', { command: 'npm test -- auth' })
    expect(r.behavior).toBe('allow')
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedPattern: 'npm test *' }),
      expect.anything()
    )
    expect(ctx.onApproved).toHaveBeenCalledWith('npm test -- auth', 'npm test *')
  })

  test('核准請求帶上 SDK 的 toolUseID（UI 用來對應時間軸上的工具呼叫）', async () => {
    const { ctx } = setup('implement')
    const gate = createPermissionGate(ctx)
    await gate('Bash', { command: 'npm run build' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu1'
    } as never)
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', toolUseId: 'tu1' }),
      expect.anything()
    )
  })

  test('使用者拒絕時帶回說明', async () => {
    const { call } = setup('implement', { allow: false, message: '先不要跑' } as never)
    expect(await call('Bash', { command: 'npm run build' })).toEqual({
      behavior: 'deny',
      message: '先不要跑'
    })
  })

  test('等待核准期間任務狀態改變時拒絕', async () => {
    for (const next of ['clarify', 'closed'] as const) {
      const { call, ctx, state } = setup('implement')
      vi.mocked(ctx.requestApproval).mockImplementation(async () => {
        state.phase = next
        return { allow: true }
      })
      expect(await call('Bash', { command: 'npm run build' })).toEqual({
        behavior: 'deny',
        message: '任務狀態已改變'
      })
      expect(ctx.onApproved).not.toHaveBeenCalled()
    }
  })

  test('signal 已中止時直接拒絕，不詢問使用者', async () => {
    const { call, ctx } = setup('implement')
    const ac = new AbortController()
    ac.abort()
    expect((await call('Bash', { command: 'npm run build' }, undefined, ac.signal)).behavior).toBe(
      'deny'
    )
    expect(ctx.requestApproval).not.toHaveBeenCalled()
  })

  test('任務結束後一律拒絕；未知工具拒絕', async () => {
    expect((await setup('closed').call('Read', {})).behavior).toBe('deny')
    expect((await setup('implement').call('KillShell', {})).behavior).toBe('deny')
  })
})

describe('PreToolUse hook', () => {
  test('釐清階段 Edit 被 hook 拒絕', async () => {
    const { callHook } = setup('clarify')
    expect(await callHook('Edit', { file_path: '/wt/t1/a.ts' })).toBe('deny')
  })

  test('規則拒絕（deny）時以 tool_use_id 通知 onBlocked；ask、allow 不通知', async () => {
    const { callHook, ctx } = setup('clarify')
    await callHook('Edit', { file_path: '/wt/t1/a.ts' })
    expect(ctx.onBlocked).toHaveBeenCalledWith('u1', expect.stringContaining('目前不是實作階段'))
    vi.mocked(ctx.onBlocked!).mockClear()
    const impl = setup('implement')
    await impl.callHook('Bash', { command: 'npm run build' })
    await impl.callHook('Read', { file_path: '/wt/t1/a.ts' })
    expect(impl.ctx.onBlocked).not.toHaveBeenCalled()
  })

  test('不在允許清單的 Bash 交給使用者核准（ask）', async () => {
    const { callHook, ctx } = setup('implement', { allow: true }, ['npm test *'])
    expect(await callHook('Bash', { command: 'npm run build' })).toBe('ask')
    expect(await callHook('Bash', { command: 'npm test -- auth' })).toBe('allow')
    expect(ctx.requestApproval).not.toHaveBeenCalled()
  })

  test('受保護路徑回傳 ask', async () => {
    const { callHook } = setup('implement')
    expect(await callHook('Write', { file_path: '/wt/t1/.claude/settings.json' })).toBe('ask')
  })

  test('harness MCP 工具：有來源資訊就判斷，沒有就交給 canUseTool', async () => {
    const { hook, callHook } = setup('clarify')
    expect(await callHook('mcp__harness__ask_user', {}, OURS)).toBe('allow')
    expect(
      await callHook('mcp__harness__ask_user', {}, { name: 'harness', source: 'project' })
    ).toBe('deny')
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__harness__ask_user',
          tool_input: {},
          tool_use_id: 'u1',
          session_id: 's1',
          transcript_path: '',
          cwd: '/wt/t1'
        },
        'u1',
        { signal: new AbortController().signal }
      )
    ).toEqual({})
  })

  test('tool_input 不是物件時拒絕', async () => {
    const { callHook } = setup('implement')
    expect(await callHook('Read', 'oops')).toBe('deny')
  })

  test('非 PreToolUse 事件不做決定', async () => {
    const { hook } = setup('implement')
    expect(
      await hook(
        {
          hook_event_name: 'Stop',
          session_id: 's1',
          transcript_path: '',
          cwd: '/wt/t1',
          stop_hook_active: false
        } as never,
        undefined,
        { signal: new AbortController().signal }
      )
    ).toEqual({})
  })
})
