// tests/shared/report.test.ts
import { describe, expect, test } from 'vitest'
import { DecisionSourceSchema, ReportInputSchema } from '@shared/report'
import { sampleReport } from '../fixtures/report'

describe('ReportInputSchema', () => {
  test('接受完整的報告', () => {
    expect(ReportInputSchema.safeParse(sampleReport).success).toBe(true)
  })

  test('缺少選填陣列時補預設值', () => {
    const { overview, architecture, decisions } = sampleReport
    const r = ReportInputSchema.parse({ overview, architecture, decisions })
    expect(r.limitations).toEqual([])
    expect(r.custom_blocks).toEqual([])
    // 舊格式（沒有 tests）也能解析
    expect(r.tests).toEqual([])
    expect(r.tests_note).toBeUndefined()
  })

  test('測試的類型預設單元、狀態預設新增；行號與修改原因選填', () => {
    const r = ReportInputSchema.parse({
      ...sampleReport,
      tests: [
        { id: 't1', file: 'a.test.ts', name: '空白輸入', scenario: '輸入空白 → 送出 → 顯示錯誤' }
      ],
      tests_note: '只改文件'
    })
    expect(r.tests).toEqual([
      {
        id: 't1',
        file: 'a.test.ts',
        name: '空白輸入',
        kind: 'unit',
        change: 'added',
        scenario: '輸入空白 → 送出 → 顯示錯誤'
      }
    ])
    expect(r.tests_note).toBe('只改文件')
  })

  test('測試一定要有情境說明，行號要是正整數', () => {
    const empty = structuredClone(sampleReport)
    empty.tests[0].scenario = ''
    expect(ReportInputSchema.safeParse(empty).success).toBe(false)
    const badLine = structuredClone(sampleReport)
    badLine.tests[0].line = 0
    expect(ReportInputSchema.safeParse(badLine).success).toBe(false)
    const badKind = { ...sampleReport, tests: [{ ...sampleReport.tests[0], kind: 'smoke' }] }
    expect(ReportInputSchema.safeParse(badKind).success).toBe(false)
  })

  test('決策來源：問題、分岔、實作中決定，或使用者的指示（規格回饋、插話、報告回饋）', () => {
    for (const type of ['question', 'branch', 'implementation', 'user'])
      expect(DecisionSourceSchema.safeParse({ type, ref: '' }).success, type).toBe(true)
    expect(DecisionSourceSchema.safeParse({ type: 'spec_feedback', ref: '' }).success).toBe(false)
    const r = ReportInputSchema.parse({
      ...sampleReport,
      decisions: [
        { ...sampleReport.decisions[0], source: { type: 'user', ref: '錯誤訊息用繁體中文' } }
      ]
    })
    expect(r.decisions[0].source).toEqual({ type: 'user', ref: '錯誤訊息用繁體中文' })
  })

  test('測試 id 重複時失敗', () => {
    const bad = structuredClone(sampleReport)
    bad.tests.push({ ...bad.tests[0], name: '另一個' })
    const r = ReportInputSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.path.join('.') === 'tests.2.id')).toBe(true)
  })

  test('edge 參照不存在的節點時失敗', () => {
    const bad = structuredClone(sampleReport)
    bad.architecture.after.edges.push({ from: 'guard', to: 'nope' })
    const r = ReportInputSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('nope')
  })

  test('custom block id 只能是小寫英數與連字號', () => {
    const bad = structuredClone(sampleReport)
    bad.custom_blocks[0].id = 'State Machine'
    expect(ReportInputSchema.safeParse(bad).success).toBe(false)
  })

  test('custom block id 最長 64 字元（與 harness-block:// 網址的檢查一致）', () => {
    const ok = structuredClone(sampleReport)
    ok.custom_blocks[0].id = 'a'.repeat(64)
    expect(ReportInputSchema.safeParse(ok).success).toBe(true)
    const bad = structuredClone(sampleReport)
    bad.custom_blocks[0].id = 'a'.repeat(65)
    expect(ReportInputSchema.safeParse(bad).success).toBe(false)
  })

  test('同一張圖裡節點 id 重複時失敗', () => {
    const bad = structuredClone(sampleReport)
    bad.architecture.before.nodes.push({
      id: 'login',
      label: 'login2',
      status: 'unchanged',
      files: []
    })
    const r = ReportInputSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.path.join('.') === 'architecture.before.nodes.2')).toBe(
      true
    )
  })

  test('before 與 after 可以有相同的節點 id', () => {
    expect(ReportInputSchema.safeParse(sampleReport).success).toBe(true)
  })

  test('custom block id 重複時失敗', () => {
    const bad = structuredClone(sampleReport)
    bad.custom_blocks.push({ id: 'state-machine', title: '重複', html: '<p></p>' })
    const r = ReportInputSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.path.join('.') === 'custom_blocks.1.id')).toBe(true)
  })
})
