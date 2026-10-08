// src/main/tools/harnessTools.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  DecisionSourceSchema,
  type ReportInput,
  ReportInputSchema,
  ReportInputShape
} from '@shared/report'

const id = z.string().regex(/^[a-z0-9_-]+$/)

export const askUserShape = {
  question_id: id.describe('問題 ID（小寫英數），更新同一張卡片時沿用'),
  question: z.string().min(1).describe('一個具體的問題'),
  options: z
    .array(
      z.object({
        id: id.describe('小寫英數、_ 或 -'),
        label: z.string().min(1),
        description: z.string().optional()
      })
    )
    .max(6)
    .describe('互斥的選項，附簡短說明與取捨'),
  recommended_option_id: z.string().optional(),
  allow_free_text: z.boolean().default(true),
  context: z.string().optional().describe('為什麼要問、會影響什麼')
}
export const proposeSpecShape = {
  title: z.string().min(1),
  summary: z.string().min(1),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()).default([]),
  decisions: z.array(z.object({ id: z.string(), text: z.string(), source: DecisionSourceSchema })),
  steps: z.array(z.string()).min(1),
  acceptance: z.array(z.string()).min(1)
}
export const updatePlanShape = {
  steps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(['pending', 'running', 'done', 'blocked'])
      })
    )
    .min(1)
}
export const concludeBranchShape = {
  // 從 Claude 訊息開出的分岔，暫定標題是使用者的問題；結論時換成整理過的主題
  title: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .optional()
    .describe('這個分岔的主題，10–20 字（會取代目前的分岔標題）'),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  deferred: z.array(z.string()).default([])
}

export type AskUserArgs = z.infer<z.ZodObject<typeof askUserShape>>
export type ProposeSpecArgs = z.infer<z.ZodObject<typeof proposeSpecShape>>
export type UpdatePlanArgs = z.infer<z.ZodObject<typeof updatePlanShape>>
export type ConcludeBranchArgs = z.infer<z.ZodObject<typeof concludeBranchShape>>

export interface ToolSink {
  askUser(a: AskUserArgs): Promise<void> | void
  proposeSpec(a: ProposeSpecArgs): Promise<void> | void
  updatePlan(a: UpdatePlanArgs): Promise<void> | void
  concludeBranch(a: ConcludeBranchArgs): Promise<void> | void
  submitReport(r: ReportInput): Promise<void> | void
}

export type HarnessToolName =
  'ask_user' | 'propose_spec' | 'update_plan' | 'conclude_branch' | 'submit_report'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] })
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true })

async function guard(fn: () => Promise<Result>): Promise<Result> {
  try {
    return await fn()
  } catch (e) {
    console.error('[harness tools] handler failed', e)
    return fail(`Harness 無法處理：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** schema 表達不了的跨欄位規則；回傳錯誤說明，沒有問題時回傳 undefined */
function askUserProblem(a: AskUserArgs): string | undefined {
  const ids = a.options.map((o) => o.id)
  const dup = ids.find((x, i) => ids.indexOf(x) !== i)
  if (dup) return `選項 id 重複：${dup}`
  if (a.recommended_option_id !== undefined && !ids.includes(a.recommended_option_id)) {
    return `recommended_option_id「${a.recommended_option_id}」不在選項中`
  }
  if (ids.length === 0 && a.allow_free_text === false) {
    return '沒有選項時必須允許自由作答（allow_free_text 不可為 false）'
  }
  return undefined
}

export function createToolHandlers(sink: ToolSink) {
  return {
    ask_user: (a: AskUserArgs) =>
      guard(async () => {
        const problem = askUserProblem(a)
        if (problem) return fail(`問題格式有誤，請修正後重新呼叫 ask_user：${problem}`)
        await sink.askUser(a)
        return ok(
          '問題已顯示給使用者。請立刻結束這一輪，不要再輸出其他內容，等待使用者以 [answer …] 或 [counter_question …] 回覆。'
        )
      }),
    propose_spec: (a: ProposeSpecArgs) =>
      guard(async () => {
        await sink.proposeSpec(a)
        return ok(
          '規格草稿已交給使用者審閱。請結束這一輪，等待 [spec_approved] 或 [spec_feedback …]。'
        )
      }),
    update_plan: (a: UpdatePlanArgs) =>
      guard(async () => {
        await sink.updatePlan(a)
        return ok('進度已更新。')
      }),
    conclude_branch: (a: ConcludeBranchArgs) =>
      guard(async () => {
        await sink.concludeBranch(a)
        return ok('結論已交給使用者確認。請結束這一輪。')
      }),
    submit_report: (raw: unknown) =>
      guard(async () => {
        const parsed = ReportInputSchema.safeParse(raw)
        if (!parsed.success)
          return fail(
            `報告格式有誤，請修正後重新呼叫 submit_report：\n${z.prettifyError(parsed.error)}`
          )
        await sink.submitReport(parsed.data)
        return ok('報告已提交，Harness 會整理 diff 並實際執行驗證指令。請結束這一輪。')
      })
  }
}

const DESCRIPTIONS: Record<HarnessToolName, string> = {
  ask_user:
    '向使用者提出一個需要釐清的問題，以問題卡片呈現。一次只問一題，呼叫後立刻結束這一輪。用相同 question_id 再呼叫可更新卡片。',
  propose_spec: '當你對需求有足夠把握時，提出規格草稿給使用者核准。呼叫後結束這一輪。',
  update_plan: '實作階段回報步驟清單與每一步的狀態。',
  conclude_branch:
    '在分岔討論中，使用者要求帶回主線時，整理結論，並用 title 給這個分岔一個 10–20 字的主題。',
  submit_report: '實作完成並驗證後，提交結構化的變更報告。'
}

export function createHarnessServer(sink: ToolSink, names: HarnessToolName[]) {
  const h = createToolHandlers(sink)
  const all = {
    ask_user: tool('ask_user', DESCRIPTIONS.ask_user, askUserShape, h.ask_user),
    propose_spec: tool('propose_spec', DESCRIPTIONS.propose_spec, proposeSpecShape, h.propose_spec),
    update_plan: tool('update_plan', DESCRIPTIONS.update_plan, updatePlanShape, h.update_plan),
    conclude_branch: tool(
      'conclude_branch',
      DESCRIPTIONS.conclude_branch,
      concludeBranchShape,
      h.conclude_branch
    ),
    submit_report: tool(
      'submit_report',
      DESCRIPTIONS.submit_report,
      ReportInputShape,
      h.submit_report
    )
  }
  // alwaysLoad：Claude Code 預設把 MCP 工具藏在 tool search 後面，Claude 沒先載入 schema 就會猜錯參數
  return createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    alwaysLoad: true,
    tools: names.map((n) => all[n])
  })
}
