// src/renderer/src/store.ts
import { create } from 'zustand'
import type { AppEvent } from '@shared/ipc'
import type { ClaudeStatus, FeedbackItem, Repo, Settings, Task, TimelineEvent } from '@shared/types'
import { call, errorText, onEvent } from './api'

export type View = { kind: 'new' } | { kind: 'task'; taskId: string } | { kind: 'settings' }

interface State {
  ready: boolean
  claude?: ClaudeStatus
  settings?: Settings
  repos: Repo[]
  tasks: Record<string, Task>
  timelines: Record<string, TimelineEvent[]>
  view: View
  activeBranch: Record<string, string | undefined>
  feedback: Record<string, FeedbackItem[]>
  toast?: string
  /** 訂閱主程序事件並載入初始資料；回傳取消訂閱（給 useEffect 的 cleanup 用） */
  init(): () => void
  apply(e: AppEvent): void
  open(view: View): Promise<void>
  act<T>(fn: () => Promise<T>): Promise<T | undefined>
  setActiveBranch(taskId: string, branchId?: string): void
  addFeedback(taskId: string, item: FeedbackItem): void
  removeFeedback(taskId: string, anchor: string): void
  clearFeedback(taskId: string): void
  dismissToast(): void
  /** 視窗重新取得焦點時呼叫：Claude Code 未就緒就重新偵測（最多每 5 秒一次） */
  recheckClaude(): Promise<void>
}

/** 視窗取得焦點時重新偵測 Claude Code 的最短間隔 */
export const CLAUDE_RECHECK_MS = 5000

// 上次因視窗取得焦點而重新偵測的時間（只在這個模組內用來節流）
let lastClaudeRecheck = -Infinity

export const useStore = create<State>((set, get) => ({
  ready: false,
  repos: [],
  tasks: {},
  timelines: {},
  view: { kind: 'new' },
  activeBranch: {},
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
        set({
          claude,
          settings,
          repos,
          tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
          ready: true
        })
        // StrictMode 會讓 init 跑兩次：只有第一次載入時自動打開進行中的任務
        const active = tasks.find((t) => t.status !== 'discarded' && t.status !== 'done')
        if (!first && active && get().view.kind === 'new')
          await get().open({ kind: 'task', taskId: active.id })
      } catch (e) {
        set({ toast: errorText(e), ready: true })
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
      set((s) => {
        const list = s.timelines[e.taskId]
        if (!list || list.some((x) => x.id === e.event.id)) return {}
        return { timelines: { ...s.timelines, [e.taskId]: [...list, e.event] } }
      })
    }
  },

  async open(view) {
    set({ view })
    if (view.kind === 'task' && !get().timelines[view.taskId]) {
      const events = await get().act(() => call('tasks:timeline', view.taskId))
      if (!events) return
      // 同時打開兩次時，先回來的那份已經在接收即時事件，保留它
      set((s) =>
        s.timelines[view.taskId] ? {} : { timelines: { ...s.timelines, [view.taskId]: events } }
      )
    }
  },

  async act(fn) {
    try {
      return await fn()
    } catch (e) {
      set({ toast: errorText(e) })
      return undefined
    }
  },

  setActiveBranch: (taskId, branchId) =>
    set((s) => ({ activeBranch: { ...s.activeBranch, [taskId]: branchId } })),
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
  dismissToast: () => set({ toast: undefined }),

  async recheckClaude() {
    const { ready, claude } = get()
    if (!ready || !claude || claude.loggedIn) return
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
