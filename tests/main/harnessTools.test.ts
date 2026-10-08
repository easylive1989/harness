import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import {
  concludeBranchShape,
  createToolHandlers,
  ToolInputError,
  type ToolSink
} from '../../src/main/tools/harnessTools'
import { sampleReport } from '../fixtures/report'

function sink(over: Partial<ToolSink> = {}): ToolSink {
  return {
    askUser: vi.fn(),
    proposeSpec: vi.fn(),
    updatePlan: vi.fn(),
    concludeBranch: vi.fn(),
    submitReport: vi.fn(),
    ...over
  }
}
const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('')
const specArgs = {
  title: 't',
  summary: 's',
  in_scope: [],
  out_of_scope: [],
  decisions: [],
  tests: [
    {
      id: 'p1',
      name: '鎖定帳號',
      kind: 'unit' as const,
      change: 'added' as const,
      scenario: '輸錯 5 次 → 登入 → 423'
    }
  ],
  steps: ['a'],
  acceptance: ['b']
}

describe('harness tool handlers', () => {
  test('ask_user 呼叫 sink 並要求結束這一輪', async () => {
    const s = sink()
    const h = createToolHandlers(s)
    const args = { question_id: 'q1', question: '?', options: [], allow_free_text: true }
    const r = await h.ask_user(args)
    expect(s.askUser).toHaveBeenCalledWith(args)
    expect(textOf(r)).toContain('結束這一輪')
    expect(textOf(r)).toContain('不要說明你送出了問題')
  })

  test('submit_report 格式錯誤時回傳 isError 且不呼叫 sink', async () => {
    const s = sink()
    const bad = structuredClone(sampleReport)
    bad.architecture.after.edges.push({ from: 'x', to: 'y' })
    const r = await createToolHandlers(s).submit_report(bad)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('edge')
    expect(s.submitReport).not.toHaveBeenCalled()
  })

  test('submit_report 成功時呼叫 sink', async () => {
    const s = sink()
    const r = await createToolHandlers(s).submit_report(sampleReport)
    expect(r.isError).toBeFalsy()
    expect(s.submitReport).toHaveBeenCalled()
    expect(textOf(r)).toContain('不要在文字中重述報告')
  })

  test('propose_spec 成功時要求結束這一輪、不在文字中重述規格', async () => {
    const r = await createToolHandlers(sink()).propose_spec(specArgs)
    expect(textOf(r)).toContain('結束這一輪')
    expect(textOf(r)).toContain('不要在文字中重述規格')
  })

  test('sink 以 ToolInputError 拒絕時，原因原樣交給 Claude 修正', async () => {
    const s = sink({
      submitReport: vi.fn(async () => {
        throw new ToolInputError('報告和規格的預計測試對不上：p2')
      })
    })
    const r = await createToolHandlers(s).submit_report(sampleReport)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('報告和規格的預計測試對不上：p2')
  })

  test('conclude_branch 成功時要求結束這一輪、不在文字中重述結論', async () => {
    const r = await createToolHandlers(sink()).conclude_branch({
      decision: 'd',
      rationale: 'r',
      deferred: []
    })
    expect(textOf(r)).toContain('結束這一輪')
    expect(textOf(r)).toContain('不要在文字中重述結論')
  })

  test('sink 丟錯時轉成 isError，並在 host 端記錄', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = sink({
      proposeSpec: vi.fn(async () => {
        throw new Error('無法在 implementing 狀態執行 SPEC_PROPOSED')
      })
    })
    const r = await createToolHandlers(s).propose_spec(specArgs)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('implementing')
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  test('sink 丟出非 Error 時也轉成 isError', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = sink({
      updatePlan: vi.fn(async () => {
        throw '字串錯誤'
      })
    })
    const r = await createToolHandlers(s).update_plan({
      steps: [{ id: 's1', title: 't', status: 'pending' }]
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('字串錯誤')
    log.mockRestore()
  })

  describe('propose_spec 驗證', () => {
    test('沒有預計測試也沒有說明原因時拒絕，不呼叫 sink', async () => {
      const s = sink()
      const r = await createToolHandlers(s).propose_spec({ ...specArgs, tests: [] })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('請修正後重新呼叫 propose_spec')
      expect(textOf(r)).toContain('tests_note')
      expect(s.proposeSpec).not.toHaveBeenCalled()
    })

    test('只有空白的 tests_note 不算說明', async () => {
      const r = await createToolHandlers(sink()).propose_spec({
        ...specArgs,
        tests: [],
        tests_note: '  '
      })
      expect(r.isError).toBe(true)
    })

    test('沒有預計測試、但說明了原因時可以通過', async () => {
      const s = sink()
      const r = await createToolHandlers(s).propose_spec({
        ...specArgs,
        tests: [],
        tests_note: '只改 README'
      })
      expect(r.isError).toBeFalsy()
      expect(s.proposeSpec).toHaveBeenCalled()
    })

    test('預計測試 id 重複時拒絕', async () => {
      const r = await createToolHandlers(sink()).propose_spec({
        ...specArgs,
        tests: [specArgs.tests[0], { ...specArgs.tests[0], name: '另一個' }]
      })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('預計測試 id 重複：p1')
    })
  })

  describe('ask_user 驗證', () => {
    const base = {
      question_id: 'q1',
      question: '?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' }
      ],
      allow_free_text: true
    }

    test('選項 id 重複', async () => {
      const s = sink()
      const r = await createToolHandlers(s).ask_user({
        ...base,
        options: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'A2' }
        ]
      })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('重複')
      expect(s.askUser).not.toHaveBeenCalled()
    })

    test('recommended_option_id 必須是其中一個選項', async () => {
      const s = sink()
      const r = await createToolHandlers(s).ask_user({ ...base, recommended_option_id: 'zzz' })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('zzz')
      expect(s.askUser).not.toHaveBeenCalled()
    })

    test('沒有選項時必須允許自由作答', async () => {
      const s = sink()
      const r = await createToolHandlers(s).ask_user({
        ...base,
        options: [],
        allow_free_text: false
      })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('allow_free_text')
      expect(s.askUser).not.toHaveBeenCalled()
    })

    test('合法的建議選項可以通過', async () => {
      const s = sink()
      const r = await createToolHandlers(s).ask_user({ ...base, recommended_option_id: 'b' })
      expect(r.isError).toBeFalsy()
      expect(s.askUser).toHaveBeenCalled()
    })
  })
})

describe('conclude_branch 的參數', () => {
  const schema = z.object(concludeBranchShape)
  const base = { decision: '用 Redis', rationale: '多台機器' }

  test('title（分岔的主題）選填：去掉前後空白、超過 30 字就截斷，只有空白當作沒給（不拒絕整個結論）', () => {
    expect(schema.parse(base).title).toBeUndefined()
    expect(schema.parse({ ...base, title: ' 計數存放位置 ' }).title).toBe('計數存放位置')
    expect(schema.parse({ ...base, title: '字'.repeat(31) }).title).toBe('字'.repeat(30))
    expect(schema.parse({ ...base, title: '😀'.repeat(31) }).title).toBe('😀'.repeat(30))
    // 空字串：TaskManager 保留原本的標題
    expect(schema.parse({ ...base, title: '   ' }).title).toBe('')
  })

  test('給 Claude 的 JSON schema 裡 title 是選填的字串（沒有長度限制，說明寫 10–20 字）', () => {
    const json = z.toJSONSchema(schema) as unknown as {
      properties: { title: Record<string, unknown> }
      required: string[]
    }
    expect(json.properties.title).toMatchObject({ type: 'string' })
    expect(json.properties.title.maxLength).toBeUndefined()
    expect(String(json.properties.title.description)).toContain('10–20 字')
    expect(json.required).not.toContain('title')
  })
})
