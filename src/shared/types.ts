import type { ImageRef } from './images'
import type { PlannedTest, ReportInput } from './report'

/** 傳給 SDK 的模型 id（完整 id 或 Claude Code 的別名）；可用的模型依帳號由 SDK 回報 */
export type ModelId = string
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
export interface ModelOption {
  id: ModelId
  /** 別名實際對應的完整 id（SDK 的 resolvedModel） */
  resolvedId?: string
  label: string
  hint: string
  /** 支援的 effort 等級；undefined 表示不知道（不過濾），空陣列表示不支援 effort */
  efforts?: EffortLevel[]
  /** 是否支援 auto 權限模式；undefined 表示不知道（允許） */
  autoMode?: boolean
}
/** 取不到 SDK 回報的清單時使用 */
export const FALLBACK_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: '預設，品質最好' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '較快，省訂閱額度' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: '最快，最省額度' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: '最新一代模型' }
]
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5'

/** auto：不指定，用模型的預設 */
export type EffortChoice = 'auto' | EffortLevel
export const EFFORTS: { id: EffortChoice; label: string }[] = [
  { id: 'auto', label: 'Auto（模型預設）' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]

/** manual：需要核准的操作一律問使用者；auto：先交給 Claude Code 的分類器判斷，判斷不了才問 */
export type PermissionModeChoice = 'manual' | 'auto'
export const PERMISSION_MODES: { id: PermissionModeChoice; label: string; hint: string }[] = [
  { id: 'manual', label: '手動核准', hint: '需要核准的指令與操作都由你決定' },
  {
    id: 'auto',
    label: 'Auto',
    hint: '由 Claude Code 的分類器自動核准或拒絕，判斷不了才問你；Harness 的規則與受保護檔案仍照常把關'
  }
]

/** 找到模型的資訊（也比對別名對應的完整 id）；清單裡沒有時回傳 undefined */
export function findModel(models: ModelOption[], id: ModelId): ModelOption | undefined {
  return models.find((m) => m.id === id) ?? models.find((m) => m.resolvedId === id)
}

export function modelLabel(models: ModelOption[], id: ModelId): string {
  return findModel(models, id)?.label ?? FALLBACK_MODELS.find((m) => m.id === id)?.label ?? id
}

/** 模型可選的 effort（含 auto） */
export function effortsFor(model: ModelOption | undefined): EffortChoice[] {
  const levels = model?.efforts ?? EFFORT_LEVELS
  return ['auto', ...EFFORT_LEVELS.filter((l) => levels.includes(l))]
}

export const supportsAutoMode = (model: ModelOption | undefined) => model?.autoMode !== false

/** 換模型後把不支援的 effort／權限模式改回預設 */
export function fitRunOptions(
  model: ModelOption | undefined,
  effort: EffortChoice,
  permissionMode: PermissionModeChoice
): { effort: EffortChoice; permissionMode: PermissionModeChoice } {
  return {
    effort: effortsFor(model).includes(effort) ? effort : 'auto',
    permissionMode:
      permissionMode === 'auto' && !supportsAutoMode(model) ? 'manual' : permissionMode
  }
}

/** 任務在執行時可調整的選項；下一輪執行生效 */
export interface RunOptions {
  model: ModelId
  effort: EffortChoice
  permissionMode: PermissionModeChoice
}

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
  /** 預計新增或修改的測試；這個欄位加上之前的規格沒有（undefined），報告也就不對照 */
  tests?: PlannedTest[]
  /** 不新增測試的原因（tests 是空陣列時） */
  testsNote?: string
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
  /** 需求附加的圖片（中斷後重新送出需求時一併重送） */
  requestImages?: ImageRef[]
  baseBranch: string
  branch: string
  /** 工作方式；沒有這個欄位的舊任務是 worktree */
  workspace?: WorkspaceMode
  /** Claude 工作的資料夾：worktree 模式是獨立的 worktree，branch 模式是原 repo 資料夾 */
  worktreePath: string
  model: ModelId
  /** 沒有這個欄位的舊任務是 auto */
  effort?: EffortChoice
  /** 沒有這個欄位的舊任務是 manual */
  permissionMode?: PermissionModeChoice
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
  /** user_text 附加的圖片 */
  images?: ImageRef[]
}

/**
 * 任務的工作方式：worktree 建立獨立的 git worktree；branch 直接在原 repo 資料夾 checkout 新分支
 * （原 repo 必須沒有未提交變更，同一個 repo 一次只能有一個進行中的 branch 任務）
 */
export type WorkspaceMode = 'worktree' | 'branch'
export const WORKSPACES: { id: WorkspaceMode; label: string; hint: string }[] = [
  { id: 'worktree', label: 'Worktree', hint: '建立獨立資料夾，不影響原 repo，可同時進行多個任務' },
  {
    id: 'branch',
    label: 'Branch',
    hint: '直接在原 repo 資料夾開新分支；原 repo 必須沒有未提交的變更，一次一個任務'
  }
]
export const isBranchMode = (t: Pick<Task, 'workspace'>) => t.workspace === 'branch'

export interface Settings {
  defaultModel: ModelId
  defaultEffort: EffortChoice
  defaultPermissionMode: PermissionModeChoice
  /** 新任務畫面預設的工作方式 */
  defaultWorkspace: WorkspaceMode
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
  /** 整理報告時規格的預計測試（報告自己帶著，舊版本與匯出的 HTML 都能對照）；舊規格沒有 */
  plannedTests?: PlannedTest[]
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
