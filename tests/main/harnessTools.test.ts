import { describe, expect, test, vi } from 'vitest'
import { createToolHandlers, type ToolSink } from '../../src/main/tools/harnessTools'
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

describe('harness tool handlers', () => {
  test('ask_user 呼叫 sink 並要求結束這一輪', async () => {
    const s = sink()
    const h = createToolHandlers(s)
    const args = { question_id: 'q1', question: '?', options: [], allow_free_text: true }
    const r = await h.ask_user(args)
    expect(s.askUser).toHaveBeenCalledWith(args)
    expect(textOf(r)).toContain('結束這一輪')
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
  })

  test('sink 丟錯時轉成 isError，並在 host 端記錄', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = sink({
      proposeSpec: vi.fn(async () => {
        throw new Error('無法在 implementing 狀態執行 SPEC_PROPOSED')
      })
    })
    const r = await createToolHandlers(s).propose_spec({
      title: 't',
      summary: 's',
      in_scope: [],
      out_of_scope: [],
      decisions: [],
      steps: ['a'],
      acceptance: ['b']
    })
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
