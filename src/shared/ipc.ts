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
import type { ImageInput, ImageRef } from './images'

export interface CreateTaskInput {
  repoId: string
  request: string
  /** 需求附加的圖片 */
  images?: ImageInput[]
  baseBranch: string
  model: ModelId
}

export interface IpcApi {
  'claude:status': (refresh?: boolean) => ClaudeStatus
  'settings:get': () => Settings
  'settings:set': (patch: Partial<Settings>) => Settings
  'repos:list': () => Repo[]
  'repos:pick': () => Repo | null
  'repos:branches': (repoId: string) => { branches: string[]; current: string }
  'tasks:list': () => Task[]
  'tasks:create': (input: CreateTaskInput) => Task
  'tasks:timeline': (taskId: string) => TimelineEvent[]
  /** 有附加圖片時 text 可以是空字串 */
  'tasks:send': (taskId: string, channel: Channel, text: string, images?: ImageInput[]) => void
  'tasks:answer': (
    taskId: string,
    questionId: string,
    answer: { optionId?: string; text?: string }
  ) => void
  'tasks:counter': (taskId: string, questionId: string, text: string) => void
  'tasks:changedFiles': (taskId: string) => DiffStats
  /** 讀取訊息附加的圖片，回傳 data URL */
  'attachments:read': (taskId: string, image: ImageRef) => string
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

export interface HarnessBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: Parameters<IpcApi[C]>
  ): Promise<Awaited<ReturnType<IpcApi[C]>>>
  onEvent(cb: (e: AppEvent) => void): () => void
}

export const APP_EVENT_CHANNEL = 'app:event'
