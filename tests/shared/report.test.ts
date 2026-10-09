// tests/shared/report.test.ts
import { describe, expect, test } from 'vitest'
import {
  DecisionSourceSchema,
  PlannedTestSchema,
  plannedTestsProblem,
  ReportInputSchema
} from '@shared/report'
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
    expect(r.planned_skipped).toEqual([])
  })

  test('測試的類型預設單元、狀態預設新增；行號與修改原因選填', () => {
    const r = ReportInputSchema.parse({
      ...sampleReport,
      tests: [
        {
          id: 't1',
          file: 'a.test.ts',
          name: '空白輸入',
          scenario: '表單是空白的',
          expected: '送出後顯示錯誤'
        }
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
        scenario: '表單是空白的',
        expected: '送出後顯示錯誤'
      }
    ])
    expect(r.tests_note).toBe('只改文件')
  })

  test('測試一定要有情境與預期行為，行號要是正整數', () => {
    const empty = structuredClone(sampleReport)
    empty.tests[0].scenario = ''
    expect(ReportInputSchema.safeParse(empty).success).toBe(false)
    const noExpected = structuredClone(sampleReport)
    delete (noExpected.tests[0] as Partial<(typeof noExpected.tests)[number]>).expected
    expect(ReportInputSchema.safeParse(noExpected).success).toBe(false)
    const emptyExpected = structuredClone(sampleReport)
    emptyExpected.tests[0].expected = ''
    expect(ReportInputSchema.safeParse(emptyExpected).success).toBe(false)
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

describe('規格的預計測試', () => {
  const planned = [
    PlannedTestSchema.parse({
      id: 'p1',
      name: '鎖定帳號',
      scenario: '同一帳號已經輸錯 5 次',
      expected: '再登入回 423'
    }),
    PlannedTestSchema.parse({
      id: 'p2',
      name: '解鎖',
      kind: 'integration',
      scenario: '帳號已鎖定 15 分鐘',
      expected: '登入成功',
      file: 'src/auth/lockout.test.ts'
    })
  ]
  const withTests = (tests: object[], skipped: object[] = []) =>
    ReportInputSchema.parse({ ...sampleReport, tests, planned_skipped: skipped })
  const t = (id: string, planned?: string) => ({
    id,
    file: 'a.test.ts',
    name: id,
    scenario: '情境',
    expected: '預期行為',
    ...(planned ? { planned } : {})
  })

  test('預計測試的類型預設單元、狀態預設新增，檔案選填', () => {
    expect(planned[0]).toEqual({
      id: 'p1',
      name: '鎖定帳號',
      kind: 'unit',
      change: 'added',
      scenario: '同一帳號已經輸錯 5 次',
      expected: '再登入回 423'
    })
  })

  test('預計測試一定要有預期行為', () => {
    const p = { id: 'p1', name: '鎖定帳號', scenario: '同一帳號已經輸錯 5 次' }
    expect(PlannedTestSchema.safeParse(p).success).toBe(false)
    expect(PlannedTestSchema.safeParse({ ...p, expected: '' }).success).toBe(false)
  })

  test('每個預計測試都有對應的測試或列在 planned_skipped 時沒有問題；規格外多加的測試不用對應', () => {
    expect(plannedTestsProblem(planned, withTests([t('t1', 'p1'), t('t2', 'p2'), t('t3')]))).toBe(
      undefined
    )
    expect(
      plannedTestsProblem(
        planned,
        withTests([t('t1', 'p1')], [{ id: 'p2', reason: '改成手動驗證' }])
      )
    ).toBe(undefined)
  })

  test('預計測試沒有對應、也沒說明原因：列出是哪幾個', () => {
    expect(plannedTestsProblem(planned, withTests([t('t1', 'p1')]))).toBe(
      '這些預計測試沒有對應的測試，也沒有在 planned_skipped 說明原因：p2（解鎖）'
    )
  })

  test('對應到規格裡沒有的預計測試、或同一個預計測試又有測試又列在 planned_skipped', () => {
    const r = withTests(
      [t('t1', 'p1'), t('t2', 'p9'), t('t3', 'p2')],
      [
        { id: 'p2', reason: '不做' },
        { id: 'p7', reason: '不做' }
      ]
    )
    expect(plannedTestsProblem(planned, r)).toBe(
      [
        '規格裡沒有這些預計測試：p9、p7',
        '這些預計測試已經有對應的測試，不要再列在 planned_skipped：p2'
      ].join('\n')
    )
  })

  test('舊規格沒有預計測試（undefined）時不檢查；規格說明不新增測試（空陣列）時不能對應', () => {
    expect(plannedTestsProblem(undefined, withTests([t('t1', 'p1')]))).toBe(undefined)
    expect(plannedTestsProblem([], withTests([t('t1')]))).toBe(undefined)
    expect(plannedTestsProblem([], withTests([t('t1', 'p1')]))).toBe('規格裡沒有這些預計測試：p1')
  })

  test('planned_skipped 一定要有原因', () => {
    expect(
      ReportInputSchema.safeParse({ ...sampleReport, planned_skipped: [{ id: 'p1', reason: '' }] })
        .success
    ).toBe(false)
  })
})
