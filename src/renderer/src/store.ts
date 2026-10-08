// src/renderer/src/store.ts
import { create } from 'zustand'
import type { AppEvent } from '@shared/ipc'
import type { ClaudeStatus, FeedbackItem, Repo, Settings, Task, TimelineEvent } from '@shared/types'
import { call, errorText, onEvent } from './api'

export type View = { kind: 'new' } | { kind: 'task'; taskId: string } | { kind: 'settings' }

export interface State {
  ready: boolean
  claude?: ClaudeStatus
  settings?: Settings
  repos: Repo[]
  tasks: Record<string, Task>
  timelines: Record<string, TimelineEvent[]>
  view: View
  /** 打開設定前的畫面：設定頁的「返回」回到這裡 */
  settingsReturn?: View
  activeBranch: Record<string, string | undefined>
  /**
   * 從 Claude 訊息開分岔的草稿（引用的訊息原文），以任務為鍵；送出問題前不會建立任何東西。
   * seq 每按一次分岔按鈕就遞增：再按同一則訊息也會把焦點移回問題輸入框
   */
  branchDrafts: Record<string, { excerpt: string; seq: number } | undefined>
  feedback: Record<string, FeedbackItem[]>
  /** id 每次遞增：同樣的錯誤再出現一次也會重新計時 */
  toast?: { id: number; text: string }
  /** 訂閱主程序事件並載入初始資料；回傳取消訂閱（給 useEffect 的 cleanup 用） */
  init(): () => void
  apply(e: AppEvent): void
  open(view: View): Promise<void>
  act<T>(fn: () => Promise<T>): Promise<T | undefined>
  /** 切到某個分岔（即使是已經在看的那個）：一併放棄這個任務的分岔草稿 */
  setActiveBranch(taskId: string, branchId?: string): void
  startBranchDraft(taskId: string, excerpt: string): void
  cancelBranchDraft(taskId: string): void
  addFeedback(taskId: string, item: FeedbackItem): void
  removeFeedback(taskId: string, anchor: string): void
  clearFeedback(taskId: string): void
  showToast(text: string): void
  dismissToast(): void
  /** 視窗重新取得焦點時呼叫：Claude Code 未就緒就重新偵測（最多每 5 秒一次） */
  recheckClaude(): Promise<void>
}

/** 視窗取得焦點時重新偵測 Claude Code 的最短間隔 */
export const CLAUDE_RECHECK_MS = 5000

// 上次因視窗取得焦點而重新偵測的時間（節流用）
let lastClaudeRecheck = -Infinity
let toastSeq = 0
let draftSeq = 0
/** 正在讀取時間軸的任務 → 讀取期間收到的即時事件（快照回來後併進去） */
const loadingTimelines = new Map<string, TimelineEvent[]>()
/** 每份時間軸已有的事件 id（以陣列本身為鍵，直接 setState 換掉陣列時會自動重建） */
const timelineIds = new WeakMap<TimelineEvent[], Set<string>>()
const idsOf = (list: TimelineEvent[]) => {
  let ids = timelineIds.get(list)
  if (!ids) timelineIds.set(list, (ids = new Set(list.map((e) => e.id))))
  return ids
}

/** 測試用：清掉模組層級的節流與讀取中狀態 */
export function resetStoreInternals() {
  lastClaudeRecheck = -Infinity
  loadingTimelines.clear()
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  repos: [],
  tasks: {},
  timelines: {},
  view: { kind: 'new' },
  activeBranch: {},
  branchDrafts: {},
  feedback: {},

  init() {
    const off = onEvent((e) => get().apply(e))
    // 使用者可能切到終端機登入 Claude Code 後再回來：回到視窗時重新偵測
    const onFocus = () => void get().recheckClaude()
    window.addEventListener('focus', onFocus)
    void (async () => {
      try {
        const [claude, settings, repos, tasks] = await Promise.all([
          call('claude:status'),
          call('settings:get'),
          call('repos:list'),
          call('tasks:list')
        ])
        const first = get().ready
        set((s) => {
          // 載入期間可能已經從事件收到較新的任務狀態：同一任務保留 updatedAt 較新的那份
          const merged: Record<string, Task> = Object.fromEntries(tasks.map((t) => [t.id, t]))
          for (const t of Object.values(s.tasks)) {
            const snap = merged[t.id]
            if (!snap || t.updatedAt > snap.updatedAt) merged[t.id] = t
          }
          return { claude, settings, repos, tasks: merged, ready: true }
        })
        // StrictMode 會讓 init 跑兩次：只有第一次載入時自動打開進行中的任務
        const active = tasks.find((t) => t.status !== 'discarded' && t.status !== 'done')
        if (!first && active && get().view.kind === 'new')
          await get().open({ kind: 'task', taskId: active.id })
      } catch (e) {
        get().showToast(errorText(e))
        set({ ready: true })
      }
    })()
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  },

  apply(e) {
    if (e.type === 'task') set((s) => ({ tasks: { ...s.tasks, [e.task.id]: e.task } }))
    else if (e.type === 'repos') set({ repos: e.repos })
    else if (e.type === 'timeline') {
      const buffer = loadingTimelines.get(e.taskId)
      if (buffer) {
        buffer.push(e.event)
        return
      }
      set((s) => {
        // 只附加到已載入的時間軸；還沒打開過的任務等打開時再整份讀取
        const list = s.timelines[e.taskId]
        if (!list) return {}
        const ids = idsOf(list)
        if (ids.has(e.event.id)) return {}
        const next = [...list, e.event]
        ids.add(e.event.id)
        timelineIds.set(next, ids)
        return { timelines: { ...s.timelines, [e.taskId]: next } }
      })
    }
  },

  async open(view) {
    const prev = get().view
    set(
      view.kind === 'settings' && prev.kind !== 'settings'
        ? { view, settingsReturn: prev }
        : { view }
    )
    if (view.kind !== 'task') return
    const id = view.taskId
    if (get().timelines[id] || loadingTimelines.has(id)) return
    // 讀取期間的即時事件先暫存，快照回來後接在後面（去掉快照裡已有的）
    loadingTimelines.set(id, [])
    const events = await get().act(() => call('tasks:timeline', id))
    const buffered = loadingTimelines.get(id) ?? []
    loadingTimelines.delete(id)
    if (!events) return
    set((s) => {
      if (s.timelines[id]) return {}
      const ids = new Set(events.map((e) => e.id))
      const list = [...events]
      for (const e of buffered) {
        if (ids.has(e.id)) continue
        ids.add(e.id)
        list.push(e)
      }
      timelineIds.set(list, ids)
      return { timelines: { ...s.timelines, [id]: list } }
    })
  },

  async act(fn) {
    try {
      return await fn()
    } catch (e) {
      get().showToast(errorText(e))
      return undefined
    }
  },

  setActiveBranch: (taskId, branchId) =>
    set((s) => ({
      activeBranch: { ...s.activeBranch, [taskId]: branchId },
      branchDrafts: { ...s.branchDrafts, [taskId]: undefined }
    })),
  startBranchDraft: (taskId, excerpt) =>
    set((s) => ({ branchDrafts: { ...s.branchDrafts, [taskId]: { excerpt, seq: ++draftSeq } } })),
  cancelBranchDraft: (taskId) =>
    set((s) =>
      s.branchDrafts[taskId] ? { branchDrafts: { ...s.branchDrafts, [taskId]: undefined } } : {}
    ),
  addFeedback: (taskId, item) =>
    set((s) => ({
      feedback: {
        ...s.feedback,
        [taskId]: [...(s.feedback[taskId] ?? []).filter((f) => f.anchor !== item.anchor), item]
      }
    })),
  removeFeedback: (taskId, anchor) =>
    set((s) => ({
      feedback: {
        ...s.feedback,
        [taskId]: (s.feedback[taskId] ?? []).filter((f) => f.anchor !== anchor)
      }
    })),
  clearFeedback: (taskId) => set((s) => ({ feedback: { ...s.feedback, [taskId]: [] } })),
  showToast: (text) => set({ toast: { id: ++toastSeq, text } }),
  dismissToast: () => set({ toast: undefined }),

  async recheckClaude() {
    const { ready, claude } = get()
    // claude 還沒有值（例如初始載入失敗）也當成未就緒
    if (!ready || claude?.loggedIn) return
    const now = Date.now()
    if (now - lastClaudeRecheck < CLAUDE_RECHECK_MS) return
    lastClaudeRecheck = now
    try {
      set({ claude: await call('claude:status', true) })
    } catch {
      // 背景偵測失敗不打擾使用者；橫幅上的「重新檢查」會顯示錯誤
    }
  }
}))
