import type { ReportInput } from './report'

export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5'
export const MODELS: { id: ModelId; label: string; hint: string }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: '預設，品質最好' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '較快，省訂閱額度' }
]

export type TaskStatus =
  'clarifying' | 'spec_review' | 'implementing' | 'reviewing' | 'done' | 'discarded'
/** 主線的執行狀態（分岔另有 Branch.running） */
export type RunState =
  'idle' | 'running' | 'waiting_permission' | 'finalizing' | 'interrupted' | 'error'
export type Channel = 'main' | `branch:${string}`

export interface Repo {
  id: string
  name: string
  path: string
  addedAt: string
}

export interface QuestionOption {
  id: string
  label: string
  description?: string
}
export interface QuestionFollowup {
  role: 'user' | 'assistant'
  text: string
}
export interface Question {
  /** Claude 給的 question_id，同一張卡片更新時沿用 */
  id: string
  text: string
  options: QuestionOption[]
  recommendedOptionId?: string
  allowFreeText: boolean
  context?: string
  status: 'open' | 'answered'
  answer?: { optionId?: string; text?: string }
  followups: QuestionFollowup[]
  askedAt: string
}

/** 見 DecisionSourceSchema（user：使用者在規格回饋、插話或報告回饋中直接給的指示） */
export interface DecisionSource {
  type: 'question' | 'branch' | 'implementation' | 'user'
  ref: string
}
export interface Decision {
  id: string
  text: string
  rationale?: string
  deferred?: string[]
  source: DecisionSource
}

export interface Spec {
  version: number
  title: string
  summary: string
  inScope: string[]
  outOfScope: string[]
  decisions: { id: string; text: string; source: DecisionSource }[]
  steps: string[]
  acceptance: string[]
  createdAt: string
}

export interface PlanStep {
  id: string
  title: string
  status: 'pending' | 'running' | 'done' | 'blocked'
}

export interface BranchConclusion {
  decision: string
  rationale: string
  deferred: string[]
}
export interface Branch {
  id: string
  title: string
  fromQuestionId?: string
  sessionId?: string
  status: 'open' | 'concluding' | 'concluded'
  running: boolean
  conclusion?: BranchConclusion
  /** 這個分岔最近一次執行的錯誤（主線的錯誤記在 Task.error） */
  error?: string
  createdAt: string
}

export interface PermissionRequest {
  id: string
  taskId: string
  /** 提出請求的執行（主線或分岔） */
  channel: Channel
  /** SDK 給的 tool_use id：對應時間軸上的工具呼叫 */
  toolUseId?: string
  toolName: string
  input: Record<string, unknown>
  suggestedPattern?: string
  createdAt: string
}
export interface PermissionDecision {
  allow: boolean
  message?: string
  rememberPattern?: string
}

/** 已提交、還沒整理完的報告：整理被中斷或失敗時，「繼續」用它直接重新整理（不再呼叫 Claude） */
export interface PendingReport {
  input: ReportInput
  /** 之前的整理已經做好的 commit（重試時沒有新的變更就沿用） */
  commit?: string
}

export interface Task {
  id: string
  repoId: string
  title: string
  request: string
  baseBranch: string
  branch: string
  worktreePath: string
  model: ModelId
  status: TaskStatus
  runState: RunState
  mainSessionId?: string
  questions: Question[]
  decisions: Decision[]
  specs: Spec[]
  plan: PlanStep[]
  branches: Branch[]
  /** 本任務允許的指令樣式（如 `npm test *`） */
  allowedCommands: string[]
  /** 使用者至少核准過一次的完整指令 */
  approvedCommands: string[]
  reportVersions: number[]
  pendingReport?: PendingReport
  pendingPermission?: PermissionRequest
  prUrl?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type TimelineKind =
  | 'user_text'
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result'
  | 'question'
  | 'decision'
  | 'spec'
  | 'report'
  | 'system'
export interface TimelineEvent {
  id: string
  ts: string
  channel: Channel
  kind: TimelineKind
  text?: string
  tool?: {
    id: string
    name: string
    input?: Record<string, unknown>
    isError?: boolean
    /** 工具結果：使用者在核准對話框拒絕了這個呼叫 */
    denied?: boolean
    /** 工具結果：Harness 的規則擋下了這個呼叫（階段不允許、worktree 外…），text 是原因 */
    blocked?: boolean
    /** 工具呼叫：子代理（Agent／Task 工具）裡的呼叫 */
    subagent?: boolean
  }
  /** question id / decision id / spec 版本 / report 版本；user_text 的實作起點標記（IMPLEMENT_START_REF） */
  ref?: string
}

export interface Settings {
  defaultModel: ModelId
  worktreeRoot: string
  branchPrefix: string
  alwaysAllowedCommands: string[]
  loadProjectSettings: boolean
  claudePath?: string
}

export interface ClaudeStatus {
  found: boolean
  path?: string
  version?: string
  loggedIn: boolean
  subscriptionType?: string
  email?: string
  error?: string
  /** 啟動時環境裡有、但 Harness 不傳給 Claude Code 的變數（API key、其他驗證方式或端點） */
  ignoredEnv?: string[]
}

export interface VerificationResult {
  command: string
  exitCode: number | null
  durationMs: number
  outputTail: string
  skipped?: string
}
export interface DiffStats {
  files: number
  additions: number
  deletions: number
  perFile: { path: string; additions: number; deletions: number }[]
}
export interface Report {
  version: number
  taskId: string
  input: ReportInput
  diff: string
  stats: DiffStats
  verification: VerificationResult[]
  commit?: string
  createdAt: string
}
export interface FeedbackItem {
  anchor: string
  label: string
  text: string
}
