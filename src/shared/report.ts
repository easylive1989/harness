// src/shared/report.ts
import { z } from 'zod'

/** custom block id：也用在 harness-block:// 網址裡，主程序以相同規則（最長 64）檢查 */
const id = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_-]+$/)

const NodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['added', 'modified', 'unchanged']),
  files: z.array(z.string()).default([])
})
const EdgeSchema = z.object({ from: z.string(), to: z.string(), label: z.string().optional() })
export const GraphSchema = z.object({
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(EdgeSchema).default([])
})
/**
 * 決策的來源：釐清的問題（ref＝question_id）、分岔（ref＝分岔 id）、實作中自己做的決定，
 * 或使用者直接給的指示（規格回饋、實作中插話、報告回饋；ref＝指示的簡短摘錄，可留空）
 */
export const DecisionSourceSchema = z.object({
  type: z.enum(['question', 'branch', 'implementation', 'user']),
  ref: z.string()
})

const TestKindSchema = z.enum(['unit', 'integration', 'e2e', 'other']).default('unit')
const TestChangeSchema = z.enum(['added', 'modified']).default('added')

/** 情境（given／arrange）：測試開始前的前提狀態 */
const ScenarioSchema = z.string().min(1).describe('情境：測試開始前的前提狀態（given／arrange）')
/**
 * 預期行為（then／assert）：做了什麼之後預期的結果。
 * 舊規格與舊報告沒有這個欄位（只有一句 scenario），畫面上要容許 undefined
 */
const ExpectedSchema = z
  .string()
  .min(1)
  .describe('預期行為：做了什麼之後預期發生的結果（then／assert）')

/** 規格裡預計新增或修改的一個測試（id 用 p1、p2…）；報告的測試以 planned 對應回來 */
export const PlannedTestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: TestKindSchema,
  change: TestChangeSchema,
  scenario: ScenarioSchema,
  expected: ExpectedSchema,
  /** 預計的測試檔（相對於 repo 根目錄），規格階段不一定知道 */
  file: z.string().optional()
})
export type PlannedTest = z.infer<typeof PlannedTestSchema>

/** 本次新增或修改的一個測試：情境與預期行為用白話說明 */
export const TestNoteSchema = z.object({
  id: z.string().min(1),
  /** 相對於 repo 根目錄的路徑 */
  file: z.string().min(1),
  name: z.string().min(1),
  kind: TestKindSchema,
  change: TestChangeSchema,
  scenario: ScenarioSchema,
  expected: ExpectedSchema,
  /** 修改既有測試的原因 */
  why: z.string().optional(),
  /** 測試在新版檔案的行號 */
  line: z.number().int().positive().optional(),
  /** 對應的規格預計測試 id（規格外多加的測試沒有） */
  planned: z.string().optional()
})

/** submit_report 工具使用的 raw shape（tests 放在前面：報告最優先呈現新增的測試） */
export const ReportInputShape = {
  overview: z.object({ headline: z.string().min(1), summary: z.string().min(1) }),
  tests: z.array(TestNoteSchema).default([]),
  /** 沒有新增測試時的原因 */
  tests_note: z.string().optional(),
  /** 規格預計、但這次沒有加入的測試與原因 */
  planned_skipped: z
    .array(z.object({ id: z.string().min(1), reason: z.string().min(1) }))
    .default([]),
  architecture: z.object({ before: GraphSchema, after: GraphSchema }),
  decisions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      chosen: z.string(),
      rejected: z.array(z.string()).default([]),
      rationale: z.string(),
      source: DecisionSourceSchema
    })
  ),
  limitations: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        severity: z.enum(['low', 'medium', 'high'])
      })
    )
    .default([]),
  followups: z.array(z.object({ title: z.string(), detail: z.string().default('') })).default([]),
  file_notes: z
    .array(
      z.object({
        path: z.string(),
        why: z.string(),
        hunks: z
          .array(
            z.object({
              line_start: z.number().int().positive(),
              line_end: z.number().int().positive(),
              why: z.string()
            })
          )
          .default([])
      })
    )
    .default([]),
  verification: z.array(z.object({ command: z.string().min(1) })).default([]),
  custom_blocks: z
    .array(z.object({ id, title: z.string(), html: z.string().max(200_000) }))
    .max(5)
    .default([])
}

export const ReportInputSchema = z.object(ReportInputShape).superRefine((r, ctx) => {
  for (const side of ['before', 'after'] as const) {
    const ids = new Set<string>()
    r.architecture[side].nodes.forEach((n, i) => {
      if (ids.has(n.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['architecture', side, 'nodes', i],
          message: `節點 id 重複：${n.id}`
        })
      }
      ids.add(n.id)
    })
    r.architecture[side].edges.forEach((e, i) => {
      if (!ids.has(e.from) || !ids.has(e.to)) {
        ctx.addIssue({
          code: 'custom',
          path: ['architecture', side, 'edges', i],
          message: `edge 參照不存在的節點 ${e.from}→${e.to}`
        })
      }
    })
  }
  const testIds = new Set<string>()
  r.tests.forEach((t, i) => {
    if (testIds.has(t.id)) {
      ctx.addIssue({ code: 'custom', path: ['tests', i, 'id'], message: `測試 id 重複：${t.id}` })
    }
    testIds.add(t.id)
  })
  const blockIds = new Set<string>()
  r.custom_blocks.forEach((b, i) => {
    if (blockIds.has(b.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['custom_blocks', i, 'id'],
        message: `custom block id 重複：${b.id}`
      })
    }
    blockIds.add(b.id)
  })
})

export type ReportInput = z.infer<typeof ReportInputSchema>
export type TestNote = ReportInput['tests'][number]

/** 規格、報告與 PR 內文列出的測試：單元測試不列出（資料仍完整保留，供對照與未說明測試檔的判斷） */
export const isShownTest = (t: { kind: PlannedTest['kind'] }) => t.kind !== 'unit'

/** 規格的預計測試在報告裡的狀況：有對應測試的（已加入）與沒有的（附 planned_skipped 的原因） */
export function plannedCoverage(
  planned: PlannedTest[],
  r: Pick<ReportInput, 'tests' | 'planned_skipped'>
) {
  const linked = new Set(r.tests.map((t) => t.planned))
  return {
    added: planned.filter((p) => linked.has(p.id)),
    skipped: planned
      .filter((p) => !linked.has(p.id))
      .map((p) => ({ test: p, reason: r.planned_skipped.find((s) => s.id === p.id)?.reason }))
  }
}

/**
 * 報告和規格的預計測試對不上的地方（每個預計測試都要有對應的測試或列在 planned_skipped，
 * 不能對應到規格裡沒有的預計測試）；沒有問題時回傳 undefined。
 * planned 是規格的預計測試：舊規格沒有這個欄位（undefined）時不檢查
 */
export function plannedTestsProblem(
  planned: PlannedTest[] | undefined,
  r: ReportInput
): string | undefined {
  if (!planned) return undefined
  const ids = new Set(planned.map((p) => p.id))
  const linked = r.tests.flatMap((t) => (t.planned ? [t.planned] : []))
  const skipped = r.planned_skipped.map((s) => s.id)
  const problems: string[] = []
  const unknown = [...new Set([...linked, ...skipped].filter((id) => !ids.has(id)))]
  if (unknown.length) problems.push(`規格裡沒有這些預計測試：${unknown.join('、')}`)
  const covered = new Set([...linked, ...skipped])
  const missing = planned.filter((p) => !covered.has(p.id))
  if (missing.length)
    problems.push(
      `這些預計測試沒有對應的測試，也沒有在 planned_skipped 說明原因：${missing.map((p) => `${p.id}（${p.name}）`).join('、')}`
    )
  const both = skipped.filter((id) => ids.has(id) && linked.includes(id))
  if (both.length)
    problems.push(`這些預計測試已經有對應的測試，不要再列在 planned_skipped：${both.join('、')}`)
  return problems.length ? problems.join('\n') : undefined
}
