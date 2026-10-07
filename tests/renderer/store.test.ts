// tests/renderer/store.test.ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/api')>()),
  call: vi.fn(),
  onEvent: vi.fn(() => () => {})
}))
import { call, onEvent } from '@renderer/api'
import { useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

beforeEach(() => {
  vi.mocked(call).mockReset()
  useStore.setState({
    ready: false,
    tasks: {},
    timelines: {},
    feedback: {},
    view: { kind: 'new' },
    toast: undefined
  })
})

describe('store.apply', () => {
  test('task 事件 upsert', () => {
    useStore.getState().apply({ type: 'task', task: makeTask({ id: 'a' }) })
    expect(useStore.getState().tasks.a.id).toBe('a')
  })
  test('timeline 事件只附加到已載入的時間軸，並去重', () => {
    const e = { id: 'e1', ts: '', channel: 'main' as const, kind: 'user_text' as const, text: 'hi' }
    useStore.getState().apply({ type: 'timeline', taskId: 'a', event: e })
    expect(useStore.getState().timelines.a).toBeUndefined()
    useStore.setState({ timelines: { a: [] } })
    useStore.getState().apply({ type: 'timeline', taskId: 'a', event: e })
    useStore.getState().apply({ type: 'timeline', taskId: 'a', event: e })
    expect(useStore.getState().timelines.a).toHaveLength(1)
  })
  test('回饋新增與移除', () => {
    const s = useStore.getState()
    s.addFeedback('a', { anchor: 'diff:a.ts:3', label: 'a.ts:3', text: 'x' })
    s.addFeedback('a', { anchor: 'diff:a.ts:3', label: 'a.ts:3', text: 'y' })
    expect(useStore.getState().feedback.a).toEqual([
      { anchor: 'diff:a.ts:3', label: 'a.ts:3', text: 'y' }
    ])
    s.removeFeedback('a', 'diff:a.ts:3')
    expect(useStore.getState().feedback.a).toEqual([])
  })
})

const ipcError = (channel: string, msg: string) =>
  new Error(`Error invoking remote method '${channel}': Error: ${msg}`)

describe('store.init / open / act', () => {
  test('載入初始資料並打開第一個進行中的任務；回傳取消訂閱', async () => {
    const off = vi.fn()
    vi.mocked(onEvent).mockReturnValueOnce(off)
    const tasks = [makeTask({ id: 'd', status: 'done' }), makeTask({ id: 'b' })]
    const replies: Record<string, unknown> = {
      'claude:status': { found: true, loggedIn: true },
      'settings:get': { defaultModel: 'claude-opus-5-5' },
      'repos:list': [],
      'tasks:list': tasks,
      'tasks:timeline': []
    }
    vi.mocked(call).mockImplementation((async (ch: string) => replies[ch]) as typeof call)
    const unsubscribe = useStore.getState().init()
    await vi.waitFor(() => expect(useStore.getState().timelines.b).toEqual([]))
    const s = useStore.getState()
    expect(s.ready).toBe(true)
    expect(Object.keys(s.tasks)).toEqual(['d', 'b'])
    expect(s.view).toEqual({ kind: 'task', taskId: 'b' })
    unsubscribe()
    expect(off).toHaveBeenCalled()
  })

  test('載入失敗時仍進入畫面並顯示錯誤', async () => {
    vi.mocked(call).mockRejectedValue(ipcError('repos:list', '讀取失敗'))
    const unsubscribe = useStore.getState().init()
    await vi.waitFor(() => expect(useStore.getState().ready).toBe(true))
    expect(useStore.getState().toast).toBe('讀取失敗')
    unsubscribe()
  })

  test('時間軸讀取失敗時顯示 toast，不丟出未處理的錯誤', async () => {
    vi.mocked(call).mockRejectedValue(ipcError('tasks:timeline', '找不到任務'))
    await useStore.getState().open({ kind: 'task', taskId: 'x' })
    expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'x' })
    expect(useStore.getState().timelines.x).toBeUndefined()
    expect(useStore.getState().toast).toBe('找不到任務')
  })

  test('act 回傳結果；失敗時只留主程序的訊息', async () => {
    expect(await useStore.getState().act(async () => 1)).toBe(1)
    const r = await useStore.getState().act(async () => {
      throw ipcError('tasks:create', '尚未登入')
    })
    expect(r).toBeUndefined()
    expect(useStore.getState().toast).toBe('尚未登入')
    useStore.getState().dismissToast()
    expect(useStore.getState().toast).toBeUndefined()
  })
})

describe('store.recheckClaude（視窗取得焦點時）', () => {
  const focus = () => window.dispatchEvent(new Event('focus'))
  const statusCalls = () =>
    vi.mocked(call).mock.calls.filter((c) => c[0] === 'claude:status' && c[1] === true).length

  test('未登入時重新偵測，最多每 5 秒一次；登入後或取消訂閱後不再偵測', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
      let loggedIn = false
      const replies: Record<string, () => unknown> = {
        'claude:status': () => ({ found: true, loggedIn }),
        'settings:get': () => ({ defaultModel: 'claude-opus-5-5' }),
        'repos:list': () => [],
        'tasks:list': () => []
      }
      vi.mocked(call).mockImplementation((async (ch: string) => replies[ch]()) as typeof call)
      const unsubscribe = useStore.getState().init()
      await vi.waitFor(() => expect(useStore.getState().ready).toBe(true))

      focus()
      await vi.waitFor(() => expect(statusCalls()).toBe(1))
      focus()
      // waitFor 的輪詢也會推進假的 Date，第一次偵測約在 00:00:00.1
      vi.setSystemTime(new Date('2026-10-07T00:00:04Z'))
      focus()
      expect(statusCalls()).toBe(1)

      loggedIn = true
      vi.setSystemTime(new Date('2026-10-07T00:00:06Z'))
      focus()
      await vi.waitFor(() => expect(useStore.getState().claude?.loggedIn).toBe(true))
      expect(statusCalls()).toBe(2)

      vi.setSystemTime(new Date('2026-10-07T00:01:00Z'))
      focus()
      useStore.setState({ claude: { found: true, loggedIn: false } })
      unsubscribe()
      vi.setSystemTime(new Date('2026-10-07T00:02:00Z'))
      focus()
      await Promise.resolve()
      expect(statusCalls()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
