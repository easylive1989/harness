import type {
  Branch,
  BranchConclusion,
  Channel,
  ClaudeStatus,
  DiffStats,
  FeedbackItem,
  ModelId,
  PermissionDecision,
  Report,
  Repo,
  Settings,
  Task,
  TimelineEvent
} from './types'

export interface CreateTaskInput {
  repoId: string
  request: string
  baseBranch: string
  model: ModelId
}

export interface IpcApi {
  'claude:status': (refresh?: boolean) => ClaudeStatus
  'settings:get': () => Settings
  'settings:set': (patch: Partial<Settings>) => Settings
  'repos:list': () => Repo[]
  'repos:pick': () => Repo | null
  /** 從 Harness 移除 repo（資料夾本身不動）；leftWorktrees 是 repo 資料夾已不存在而沒刪掉的 worktree */
  'repos:remove': (repoId: string) => { leftWorktrees: string[] }
  'repos:branches': (repoId: string) => { branches: string[]; current: string }
  'tasks:list': () => Task[]
  'tasks:create': (input: CreateTaskInput) => Task
  'tasks:timeline': (taskId: string) => TimelineEvent[]
  'tasks:send': (taskId: string, channel: Channel, text: string) => void
  'tasks:answer': (
    taskId: string,
    questionId: string,
    answer: { optionId?: string; text?: string }
  ) => void
  'tasks:counter': (taskId: string, questionId: string, text: string) => void
  'tasks:changedFiles': (taskId: string) => DiffStats
  'branch:open': (
    taskId: string,
    input: { title: string; fromQuestionId?: string; seed?: string }
  ) => Branch
  'branch:conclude': (taskId: string, branchId: string) => void
  'branch:confirm': (taskId: string, branchId: string, edited?: BranchConclusion) => void
  'spec:approve': (taskId: string) => void
  'spec:requestChanges': (taskId: string, text: string) => void
  'run:stop': (taskId: string, channel: Channel) => void
  'run:resume': (taskId: string) => void
  'permission:resolve': (taskId: string, requestId: string, decision: PermissionDecision) => void
  'report:get': (taskId: string, version: number) => Report
  'report:feedback': (taskId: string, items: FeedbackItem[], overall?: string) => void
  'report:saveHtml': (suggestedName: string, html: string) => string | null
  'finish:pr': (taskId: string) => string
  'finish:merge': (taskId: string) => void
  'finish:discard': (taskId: string) => void
  'shell:showInFolder': (path: string) => void
  'shell:openExternal': (url: string) => void
}
export type IpcChannel = keyof IpcApi

export type AppEvent =
  | { type: 'task'; task: Task }
  | { type: 'timeline'; taskId: string; event: TimelineEvent }
  | { type: 'repos'; repos: Repo[] }
  /** 任務的紀錄已刪除（移除 repo 時） */
  | { type: 'task_removed'; taskId: string }

export interface HarnessBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: Parameters<IpcApi[C]>
  ): Promise<Awaited<ReturnType<IpcApi[C]>>>
  onEvent(cb: (e: AppEvent) => void): () => void
}

export const APP_EVENT_CHANNEL = 'app:event'
