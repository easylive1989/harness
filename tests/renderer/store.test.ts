// tests/renderer/store.test.ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/api')>()),
  call: vi.fn(),
  onEvent: vi.fn(() => () => {})
}))
import { call, onEvent } from '@renderer/api'
import { resetStoreInternals, useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

beforeEach(() => {
  vi.mocked(call).mockReset()
  resetStoreInternals()
  useStore.setState({
    ready: false,
    claude: undefined,
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

const ev = (id: string) => ({
  id,
  ts: '',
  channel: 'main' as const,
  kind: 'assistant_text' as const,
  text: id
})

describe('時間軸讀取中的即時事件', () => {
  test('讀取期間收到的事件會接在快照後面，去掉快照裡已有的並保持順序', async () => {
    let reply!: (events: ReturnType<typeof ev>[]) => void
    vi.mocked(call).mockImplementation(
      (() => new Promise((r) => (reply = r as typeof reply))) as unknown as typeof call
    )
    const opening = useStore.getState().open({ kind: 'task', taskId: 'a' })
    // 讀取中再打開一次不會重複讀取
    void useStore.getState().open({ kind: 'task', taskId: 'a' })
    expect(call).toHaveBeenCalledTimes(1)
    const apply = (id: string) =>
      useStore.getState().apply({ type: 'timeline', taskId: 'a', event: ev(id) })
    apply('e2') // 快照裡也有
    apply('e3')
    apply('e3') // 重複
    apply('e4')
    expect(useStore.getState().timelines.a).toBeUndefined()
    reply([ev('e1'), ev('e2')])
    await opening
    expect(useStore.getState().timelines.a.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    apply('e4')
    apply('e5')
    expect(useStore.getState().timelines.a.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  })

  test('讀取失敗時丟掉暫存，之後再打開會重新讀取', async () => {
    vi.mocked(call).mockRejectedValueOnce(new Error('x'))
    await useStore.getState().open({ kind: 'task', taskId: 'a' })
    useStore.getState().apply({ type: 'timeline', taskId: 'a', event: ev('e1') })
    expect(useStore.getState().timelines.a).toBeUndefined()
    vi.mocked(call).mockResolvedValueOnce([ev('e0')] as never)
    await useStore.getState().open({ kind: 'task', taskId: 'a' })
    expect(useStore.getState().timelines.a.map((e) => e.id)).toEqual(['e0'])
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

  test('初始快照與載入期間收到的任務事件合併，保留 updatedAt 較新的', async () => {
    let reply!: (tasks: unknown) => void
    vi.mocked(call).mockImplementation((async (ch: string) => {
      if (ch === 'tasks:list') return new Promise<unknown>((r) => (reply = r))
      if (ch === 'claude:status') return { found: true, loggedIn: true }
      return ch === 'repos:list' ? [] : {}
    }) as typeof call)
    const unsubscribe = useStore.getState().init()
    const apply = (t: ReturnType<typeof makeTask>) =>
      useStore.getState().apply({ type: 'task', task: t })
    apply(makeTask({ id: 'a', title: '事件較新', updatedAt: '2026-10-07T00:00:02.000Z' }))
    apply(makeTask({ id: 'b', title: '事件較舊', updatedAt: '2026-10-07T00:00:00.000Z' }))
    apply(makeTask({ id: 'c', title: '只有事件', status: 'done' }))
    await vi.waitFor(() => expect(reply).toBeDefined())
    reply([
      makeTask({
        id: 'a',
        title: '快照較舊',
        updatedAt: '2026-10-07T00:00:01.000Z',
        status: 'done'
      }),
      makeTask({
        id: 'b',
        title: '快照較新',
        updatedAt: '2026-10-07T00:00:01.000Z',
        status: 'done'
      })
    ])
    await vi.waitFor(() => expect(useStore.getState().ready).toBe(true))
    const t = useStore.getState().tasks
    expect([t.a.title, t.b.title, t.c.title]).toEqual(['事件較新', '快照較新', '只有事件'])
    unsubscribe()
  })

  test('載入失敗時仍進入畫面並顯示錯誤', async () => {
    vi.mocked(call).mockRejectedValue(ipcError('repos:list', '讀取失敗'))
    const unsubscribe = useStore.getState().init()
    await vi.waitFor(() => expect(useStore.getState().ready).toBe(true))
    expect(useStore.getState().toast?.text).toBe('讀取失敗')
    unsubscribe()
  })

  test('時間軸讀取失敗時顯示 toast，不丟出未處理的錯誤', async () => {
    vi.mocked(call).mockRejectedValue(ipcError('tasks:timeline', '找不到任務'))
    await useStore.getState().open({ kind: 'task', taskId: 'x' })
    expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'x' })
    expect(useStore.getState().timelines.x).toBeUndefined()
    expect(useStore.getState().toast?.text).toBe('找不到任務')
  })

  test('act 回傳結果；失敗時只留主程序的訊息', async () => {
    expect(await useStore.getState().act(async () => 1)).toBe(1)
    const r = await useStore.getState().act(async () => {
      throw ipcError('tasks:create', '尚未登入')
    })
    expect(r).toBeUndefined()
    expect(useStore.getState().toast?.text).toBe('尚未登入')
    useStore.getState().dismissToast()
    expect(useStore.getState().toast).toBeUndefined()
  })
})

describe('store.open：設定頁的返回目標', () => {
  test('打開設定時記住原本的畫面；在設定頁裡再打開設定不覆蓋', async () => {
    vi.mocked(call).mockResolvedValue([])
    useStore.setState({ settingsReturn: undefined })
    await useStore.getState().open({ kind: 'task', taskId: 'a' })
    await useStore.getState().open({ kind: 'settings' })
    expect(useStore.getState().settingsReturn).toEqual({ kind: 'task', taskId: 'a' })
    await useStore.getState().open({ kind: 'settings' })
    expect(useStore.getState().settingsReturn).toEqual({ kind: 'task', taskId: 'a' })
    await useStore.getState().open({ kind: 'new' })
    await useStore.getState().open({ kind: 'settings' })
    expect(useStore.getState().settingsReturn).toEqual({ kind: 'new' })
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

describe('store.recheckClaude：claude 沒有值', () => {
  test('初始載入失敗、claude 沒有值時也會重新偵測', async () => {
    vi.mocked(call).mockResolvedValue({ found: true, loggedIn: true } as never)
    useStore.setState({ ready: true, claude: undefined })
    await useStore.getState().recheckClaude()
    expect(call).toHaveBeenCalledWith('claude:status', true)
    expect(useStore.getState().claude?.loggedIn).toBe(true)
    await useStore.getState().recheckClaude()
    expect(call).toHaveBeenCalledTimes(1)
  })

  test('resetStoreInternals 清掉節流', async () => {
    vi.mocked(call).mockResolvedValue({ found: true, loggedIn: false } as never)
    useStore.setState({ ready: true, claude: { found: true, loggedIn: false } })
    await useStore.getState().recheckClaude()
    await useStore.getState().recheckClaude()
    expect(call).toHaveBeenCalledTimes(1)
    resetStoreInternals()
    await useStore.getState().recheckClaude()
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe('從訊息開分岔的草稿', () => {
  test('每按一次分岔按鈕 seq 都遞增（再按同一則也是）；放棄後清掉', () => {
    useStore.setState({ branchDrafts: {}, activeBranch: {} })
    const { startBranchDraft, cancelBranchDraft } = useStore.getState()
    startBranchDraft('t1', '有幾件事要先確認。')
    const first = useStore.getState().branchDrafts.t1!
    startBranchDraft('t1', '有幾件事要先確認。')
    const second = useStore.getState().branchDrafts.t1!
    expect(second.excerpt).toBe('有幾件事要先確認。')
    expect(second.seq).toBeGreaterThan(first.seq)
    cancelBranchDraft('t1')
    expect(useStore.getState().branchDrafts.t1).toBeUndefined()
  })

  test('切到任何分岔（即使是已經在看的那個）都會放棄草稿；只影響那個任務', () => {
    useStore.setState({ branchDrafts: {}, activeBranch: { t1: 'b1' } })
    const { startBranchDraft, setActiveBranch } = useStore.getState()
    startBranchDraft('t1', 'A')
    startBranchDraft('t2', 'B')
    setActiveBranch('t1', 'b1')
    expect(useStore.getState().branchDrafts.t1).toBeUndefined()
    expect(useStore.getState().branchDrafts.t2?.excerpt).toBe('B')
    expect(useStore.getState().activeBranch.t1).toBe('b1')
  })
})
