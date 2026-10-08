// tests/main/fakeClaude.ts
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from '../../src/main/agent/agentRun'
import type { GitLike } from '../../src/main/git/gitService'
import type { HarnessToolName, ToolSink } from '../../src/main/tools/harnessTools'

export interface ScriptCtx {
  call: number
  prompt: string
  options: Options
  sink: ToolSink
}
export type Script = (ctx: ScriptCtx) => Promise<unknown[] | void>

export const assistantText = (text: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text }] }
})

/**
 * 假的 Claude：每次 query() 讀第一則訊息、送 init、執行 script（可呼叫 sink），最後送 result。
 * result 不帶 user_message_uuid，AgentRun 會在每個 result 之後關閉輸入（插話的訊息不會被讀取）。
 * interrupt() 或 abort 會讓 script 提早結束：interrupt 照常送 result，abort 則丟出錯誤。
 */
export class FakeClaude {
  /** images：第一則訊息附帶的圖片（image content block） */
  calls: {
    prompt: string
    options: Options
    tools: HarnessToolName[]
    images: { mediaType: string; data: string }[]
  }[] = []
  script: Script = async () => []
  /** 下一次 query() 直接丟出錯誤（模擬 CLI 無法啟動） */
  failNextQuery?: Error
  /**
   * 送出 result 之後不結束：'hang' 會在 abort 時結束，'hang_ignoring_abort' 連 abort 都不理，
   * 兩者都可用 releaseHang() 放行
   */
  afterResult?: 'hang' | 'hang_ignoring_abort'
  /** 正在迭代中的 query() 數，與曾經同時進行的最大值（檢查同一 channel 不會同時有兩段執行） */
  active = 0
  maxActive = 0
  /** 已被 AgentRun 處理完的 result 數（yield 之後才加，代表消費端已讀過） */
  results = 0
  private hangRelease = new Set<() => void>()
  private lastSink?: ToolSink
  private lastTools: HarnessToolName[] = []

  createToolServer = (sink: ToolSink, tools: HarnessToolName[]) => {
    this.lastSink = sink
    this.lastTools = tools
    return { type: 'sdk', name: 'harness' } as never
  }

  releaseHang() {
    for (const r of this.hangRelease) r()
    this.hangRelease.clear()
  }

  queryFn: QueryFn = ({ prompt, options }) => {
    if (this.failNextQuery) {
      const e = this.failNextQuery
      this.failNextQuery = undefined
      throw e
    }
    const afterResult = this.afterResult
    const hang = new Promise<'released'>((r) => this.hangRelease.add(() => r('released')))
    const sink = this.lastSink!
    const tools = this.lastTools
    const call = this.calls.length
    const signal = options.abortController?.signal
    let interrupt!: () => void
    const interrupted = new Promise<'interrupted'>((r) => {
      interrupt = () => r('interrupted')
    })
    const aborted = new Promise<'aborted'>((r) => {
      if (signal?.aborted) r('aborted')
      signal?.addEventListener('abort', () => r('aborted'), { once: true })
    })
    const record = (c: FakeClaude['calls'][number]) => this.calls.push(c)
    const resultConsumed = () => this.results++
    const started = () => {
      this.active++
      this.maxActive = Math.max(this.maxActive, this.active)
    }
    const ended = () => this.active--
    const run = (ctx: ScriptCtx) => this.script(ctx)
    const gen = (async function* () {
      started()
      try {
        const it = prompt[Symbol.asyncIterator]()
        const first = await it.next()
        const content = (first.value as SDKUserMessage).message.content
        const blocks = typeof content === 'string' ? [] : content
        const text =
          typeof content === 'string'
            ? content
            : blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
        const images = blocks.flatMap((b) =>
          b.type === 'image' && b.source.type === 'base64'
            ? [{ mediaType: b.source.media_type, data: b.source.data }]
            : []
        )
        record({ prompt: text, options, tools, images })
        const sessionId = options.forkSession ? `fork-${call}` : (options.resume ?? `sess-${call}`)
        yield { type: 'system', subtype: 'init', session_id: sessionId } as unknown as SDKMessage
        const outcome = await Promise.race([
          run({ call, prompt: text, options, sink }),
          interrupted,
          aborted
        ])
        if (outcome === 'aborted') throw new Error('aborted')
        if (outcome !== 'interrupted') {
          for (const m of outcome ?? []) yield m as SDKMessage
          // 讓 script 裡用 setTimeout 延後的工具呼叫落在同一輪內
          await Promise.race([new Promise((r) => setTimeout(r, 40)), interrupted, aborted])
        }
        if (signal?.aborted) throw new Error('aborted')
        yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage
        resultConsumed()
        if (afterResult === 'hang') {
          if ((await Promise.race([hang, aborted])) === 'aborted') throw new Error('aborted')
        } else if (afterResult === 'hang_ignoring_abort') {
          await hang
        }
      } finally {
        ended()
      }
    })()
    return Object.assign(gen, {
      interrupt: async () => {
        interrupt()
      }
    })
  }
}

/** state：原 repo 目前的分支與是否乾淨（branch 模式用，測試可直接改） */
export function fakeGit(): GitLike & {
  calls: string[]
  state: { current: string; clean: boolean }
} {
  const calls: string[] = []
  const state = { current: 'main', clean: true }
  return {
    calls,
    state,
    isRepo: async () => true,
    repoRoot: async (d) => d,
    branches: async () => ['main'],
    currentBranch: async () => state.current,
    branchInfo: async () => ({ branches: ['main'], current: 'main' }),
    createWorktree: async (_repo, wt, branch, base) => {
      calls.push(`worktree ${wt} ${branch} ${base}`)
    },
    isClean: async () => state.clean,
    createBranch: async (repo, branch, base) => {
      calls.push(`branch ${repo} ${branch} ${base}`)
      state.current = branch
    },
    checkout: async (_repo, branch) => {
      calls.push(`checkout ${branch}`)
      state.current = branch
    },
    discardBranch: async (_repo, branch, base) => {
      calls.push(`discardBranch ${branch} ${base}`)
      state.current = base
    },
    deleteBranch: async (_repo, branch) => {
      calls.push(`deleteBranch ${branch}`)
    },
    commitAll: async () => 'abc123',
    hooksPath: async () => undefined,
    diff: async () => 'diff --git a/a.ts b/a.ts\n',
    diffStats: async () => ({
      files: 1,
      additions: 2,
      deletions: 0,
      perFile: [{ path: 'a.ts', additions: 2, deletions: 0 }]
    }),
    workingStats: async () => ({ files: 0, additions: 0, deletions: 0, perFile: [] }),
    merge: async (_repo, branch, base) => {
      calls.push(`merge ${branch} ${base}`)
    },
    removeWorktree: async (_repo, wt, branch) => {
      calls.push(`remove ${wt} ${branch}`)
    },
    pushAndOpenPr: async (_wt, branch, base, title) => {
      calls.push(`pr ${branch} ${base} ${title}`)
      return 'https://github.com/me/shop-api/pull/1'
    }
  }
}

/** 輪詢到條件成立為止；條件成立就立刻返回，上限只防止無限等待（機器忙時也要夠寬） */
export async function until(cond: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
