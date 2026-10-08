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
export const DecisionSourceSchema = z.object({
  type: z.enum(['question', 'branch', 'implementation']),
  ref: z.string()
})

/** 本次新增或修改的一個測試：情境用白話說明（在什麼情況下 → 做什麼 → 預期什麼） */
export const TestNoteSchema = z.object({
  id: z.string().min(1),
  /** 相對於 repo 根目錄的路徑 */
  file: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['unit', 'integration', 'e2e', 'other']).default('unit'),
  change: z.enum(['added', 'modified']).default('added'),
  scenario: z.string().min(1),
  /** 修改既有測試的原因 */
  why: z.string().optional(),
  /** 測試在新版檔案的行號 */
  line: z.number().int().positive().optional()
})

/** submit_report 工具使用的 raw shape（tests 放在前面：報告最優先呈現新增的測試） */
export const ReportInputShape = {
  overview: z.object({ headline: z.string().min(1), summary: z.string().min(1) }),
  tests: z.array(TestNoteSchema).default([]),
  /** 沒有新增測試時的原因 */
  tests_note: z.string().optional(),
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
