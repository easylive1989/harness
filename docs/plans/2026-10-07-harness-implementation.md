# Harness 實作計畫

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建一個個人用的 Electron 桌面 app，讓使用者選 repo、用問題卡片與分岔和 Claude 釐清需求、核准規格後由 Claude 在 git worktree 實作，最後以 HTML 報告呈現架構、決策、限制、diff 與測試結果並可回饋迭代。

**Architecture:** Electron 主程序以 `@anthropic-ai/claude-agent-sdk` 驅動本機已登入（訂閱方案）的 Claude Code；app 透過 in-process MCP 工具（`ask_user`、`propose_spec`、`update_plan`、`conclude_branch`、`submit_report`）取得結構化資料，以 `canUseTool` 控制權限。每一輪對話是一個 `query()`（串流輸入以支援插話），以 `resume`／`forkSession` 續接與分岔。任務狀態、時間軸、報告以 JSON 存在 userData。Renderer 是 React + Tailwind v4，依設計稿 B「瓷白」實作。

**Tech Stack:** Electron 39、electron-vite 5、React 19、TypeScript 5.9、Tailwind CSS 4、tailwind-merge、zustand、zod 4、@anthropic-ai/claude-agent-sdk 0.3.292、Vitest、React Testing Library、git / gh CLI。

**設計依據：** `docs/plans/2026-10-07-harness-design.md`（架構與行為）、`docs/design/*.dc.html`（畫面，顏色／間距／字級以這些檔案的 inline style 為準）。

---

## 慣例

- 所有指令在 repo 根目錄執行。
- 測試：`npx vitest run <path>`；全部：`npm test`。型別：`npm run typecheck`。
- 每個 Task 結尾 commit；commit message 用英文 conventional commits，結尾加：
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- 使用者看得到的文字一律繁體中文。
- 路徑別名：`@shared/*` → `src/shared/*`（main、preload、renderer、tests 都可用）。

---

## Phase 0：專案骨架

### Task 1：Scaffold electron-vite + React + TS

**Files:**
- Create: 由範本產生的 `package.json`、`electron.vite.config.ts`、`tsconfig*.json`、`src/main/index.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/index.html`、`src/renderer/src/*`
- Create: `vitest.config.ts`、`tests/sanity.test.ts`
- Modify: `.gitignore`

**Step 1: 產生範本到暫存目錄並複製進 repo**

```bash
TMP=$(mktemp -d)
(cd "$TMP" && npm create @quick-start/electron@latest harness -- --template react-ts --skip < /dev/null)
rsync -a --exclude README.md --exclude .git "$TMP/harness/" ./
rm -rf build electron-builder.yml src/renderer/src/components/Versions.tsx src/renderer/src/assets/electron.svg src/renderer/src/assets/wavy-lines.svg
```

**Step 2: 調整 package.json**

- `"name": "harness"`、`"description": "Claude 驅動的需求釐清與實作桌面工具"`、加上 `"type": "module"`。
- 刪除 `postinstall`、`build:unpack`、`build:win`、`build:mac`、`build:linux` scripts，刪除 devDependency `electron-builder`。
- 加 scripts：`"test": "vitest run"`、`"test:watch": "vitest"`。

**Step 3: 安裝依賴**

```bash
npm install
npm install @anthropic-ai/claude-agent-sdk@0.3.292 zod@^4 zustand react-markdown remark-gfm @fontsource/noto-sans-tc @fontsource/ibm-plex-mono
npm install -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom tailwindcss @tailwindcss/vite
```

若 vitest 與已安裝的 vite 版本 peer 衝突，改裝 peer 範圍包含目前 vite 主版本的最新 vitest（`npm view vitest@<major> peerDependencies`）。`@anthropic-ai/sdk` 與 `@modelcontextprotocol/sdk` 是 SDK 的 peer，若 npm 未自動安裝則補裝：`npm install @anthropic-ai/sdk @modelcontextprotocol/sdk`。

**Step 4: electron.vite.config.ts**

```ts
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    resolve: { alias: { ...alias, '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()]
  }
})
```

**Step 5: tsconfig 路徑別名**

在 `tsconfig.node.json` 的 `compilerOptions` 加 `"baseUrl": "."`、`"paths": { "@shared/*": ["src/shared/*"] }`，`include` 加 `"src/shared/**/*"`、`"tests/**/*"`、`"vitest.config.ts"`。
在 `tsconfig.web.json` 的 `paths` 加 `"@shared/*": ["src/shared/*"]`，`include` 加 `"src/shared/**/*"`。

**Step 6: main 改為 ESM 可用的 preload 路徑**

`src/main/index.ts` 中 `preload: join(__dirname, '../preload/index.js')` 改為：

```ts
import { fileURLToPath } from 'node:url'
// ...
preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
```

renderer 載入同理：`mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))`。刪掉範本中對 `icon` 的 import 與使用。視窗設定改為 `width: 1440, height: 920, minWidth: 1100, minHeight: 700, titleBarStyle: 'hiddenInset', backgroundColor: '#eef0f3'`。

**Step 7: vitest.config.ts**

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') }

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    // Heavy jsdom renders (report/diff screens) can exceed the 5s default when the machine is busy
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/shared/**/*.test.ts', 'tests/main/**/*.test.ts', 'tests/sanity.test.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/renderer/setup.ts']
        }
      }
    ]
  }
})
```

建立 `tests/renderer/setup.ts`：

```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// vitest 沒開 globals，Testing Library 不會自動在每個測試後卸載畫面
afterEach(cleanup)
```

建立 `tests/sanity.test.ts`：

```ts
import { expect, test } from 'vitest'
test('sanity', () => { expect(1 + 1).toBe(2) })
```

**Step 8: 驗證**

Run: `npm test` → Expected: 1 passed（dom project 沒有測試檔時 vitest 可能顯示 "No test files found" 但整體 exit 0；若 exit 非 0，暫時在 dom project 加 `passWithNoTests: true`）。
Run: `npm run typecheck` → Expected: 無錯誤。
Run: `npm run dev` → Expected: 開出 Electron 視窗、範本畫面正常、DevTools 無錯誤。關閉視窗。

**Step 9: .gitignore 與 commit**

確認 `.gitignore` 包含 `node_modules/`、`out/`、`dist/`、`.DS_Store`、`*.log`、`.eslintcache`。

```bash
git add -A
git commit -m "chore: scaffold electron-vite react-ts app with vitest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2：設計 tokens、字體與基本樣式

**Files:**
- Create: `src/renderer/src/styles/app.css`
- Modify: `src/renderer/src/main.tsx`、`src/renderer/src/App.tsx`、`src/renderer/index.html`
- Delete: `src/renderer/src/assets/main.css`、`src/renderer/src/assets/base.css`

**Step 1: app.css（tokens 取自 `docs/design/StyleB.dc.html`）**

```css
@import 'tailwindcss';
@import '@fontsource/noto-sans-tc/400.css';
@import '@fontsource/noto-sans-tc/500.css';
@import '@fontsource/noto-sans-tc/700.css';
@import '@fontsource/ibm-plex-mono/400.css';
@import '@fontsource/ibm-plex-mono/500.css';

@theme {
  --font-sans: 'Noto Sans TC', -apple-system, 'PingFang TC', sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;

  --color-canvas: #eef0f3;
  --color-surface: #ffffff;
  --color-ink: #1c2430;
  --color-ink-2: #3a4350;
  --color-muted: #5b6472;
  --color-muted-2: #6b7480;
  --color-line: #dde1e7;
  --color-line-soft: #eef0f3;
  --color-fill: #f1f3f6;
  --color-fill-2: #f6f8f9;
  --color-chip: #e6e9ee;
  --color-line-strong: #b8c0cc;

  --color-brand: #0f766e;
  --color-brand-hover: #115e59;
  --color-brand-ink: #0f5f58;
  --color-brand-tint: #ecf6f4;
  --color-brand-soft: #d5ebe8;
  --color-brand-ring: #cfe3e0;
  --color-brand-muted: #3f5f5b;
  --color-brand-halo: #b9dcd7;

  --color-decision: #fdf6e7;
  --color-decision-ink: #8a5300;
  --color-decision-body: #5c4a2a;
  --color-progress: #9a5b00;
  --color-progress-bar: #c27c0e;
  --color-review: #2563eb;
  --color-review-soft: #e0ecff;
  --color-danger: #b42318;
  --color-danger-soft: #fef3f2;
  --color-ok: #15803d;
  --color-note: #fef9c3;
  --color-note-ink: #713f12;
  --color-code: #1c2430;
  --color-code-ink: #e7ecef;

  --shadow-card: 0 1px 3px rgba(16, 24, 40, 0.06);
  --shadow-raised: 0 1px 2px rgba(16, 24, 40, 0.06), 0 2px 8px rgba(16, 24, 40, 0.05);
  --shadow-focus: 0 0 0 1px #cfe3e0, 0 6px 24px rgba(15, 118, 110, 0.1);
  --shadow-tab: 0 1px 2px rgba(16, 24, 40, 0.08);
  --shadow-dialog: 0 20px 60px rgba(16, 24, 40, 0.25);
}

@layer base {
  html, body, #root { height: 100%; }
  body { margin: 0; background: var(--color-canvas); color: var(--color-ink); font-family: var(--font-sans); font-size: 14px; line-height: 1.65; -webkit-font-smoothing: antialiased; }
  a { color: var(--color-brand); }
  a:hover { color: var(--color-brand-hover); }
  code { font-family: var(--font-mono); font-size: 12px; background: #eef2f1; padding: 1px 6px; border-radius: 5px; color: #134e4a; }
}

@utility drag { -webkit-app-region: drag; }
@utility no-drag { -webkit-app-region: no-drag; }
```

**Step 2: main.tsx 改 import**

```tsx
import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

**Step 3: App.tsx 暫時佔位**

```tsx
export default function App() {
  return <div className="flex h-full items-center justify-center text-2xl font-bold text-brand">Harness</div>
}
```

**Step 4: index.html CSP**

把 `<meta http-equiv="Content-Security-Policy" ...>` 的 content 改成：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src harness-block:
```

`<title>` 改為 `Harness`，`<html lang="zh-Hant">`。

**Step 5: 驗證與 commit**

Run: `npm run dev` → Expected: 視窗背景 `#eef0f3`，中央青綠色「Harness」。
Run: `npm run typecheck` → PASS。

```bash
git add -A
git commit -m "feat(ui): add porcelain design tokens and fonts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 1：共用型別與純函式（src/shared）

### Task 3：領域型別

**Files:**
- Create: `src/shared/types.ts`

**Step 1: 寫入型別（無邏輯，不需測試；由後續測試覆蓋）**

```ts
import type { ReportInput } from './report'

export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5'
export const MODELS: { id: ModelId; label: string; hint: string }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: '預設，品質最好' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '較快，省訂閱額度' }
]

export type TaskStatus = 'clarifying' | 'spec_review' | 'implementing' | 'reviewing' | 'done' | 'discarded'
/** 主線的執行狀態（分岔另有 Branch.running） */
export type RunState = 'idle' | 'running' | 'waiting_permission' | 'finalizing' | 'interrupted' | 'error'
export type Channel = 'main' | `branch:${string}`

export interface Repo { id: string; name: string; path: string; addedAt: string }

export interface QuestionOption { id: string; label: string; description?: string }
export interface QuestionFollowup { role: 'user' | 'assistant'; text: string }
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

export interface DecisionSource { type: 'question' | 'branch' | 'implementation'; ref: string }
export interface Decision { id: string; text: string; rationale?: string; deferred?: string[]; source: DecisionSource }

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

export interface PlanStep { id: string; title: string; status: 'pending' | 'running' | 'done' | 'blocked' }

export interface BranchConclusion { decision: string; rationale: string; deferred: string[] }
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
export interface PermissionDecision { allow: boolean; message?: string; rememberPattern?: string }

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
  pendingPermission?: PermissionRequest
  prUrl?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type TimelineKind =
  | 'user_text' | 'assistant_text' | 'tool_call' | 'tool_result'
  | 'question' | 'decision' | 'spec' | 'report' | 'system'
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
}

export interface VerificationResult { command: string; exitCode: number | null; durationMs: number; outputTail: string; skipped?: string }
export interface DiffStats { files: number; additions: number; deletions: number; perFile: { path: string; additions: number; deletions: number }[] }
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
export interface FeedbackItem { anchor: string; label: string; text: string }
```

**Step 2: Commit**（與 Task 4 一起，因為 types.ts import report.ts）

---

### Task 4：報告 schema

**Files:**
- Create: `src/shared/report.ts`
- Create: `tests/fixtures/report.ts`
- Test: `tests/shared/report.test.ts`

**Step 1: 測試用 fixture**

```ts
// tests/fixtures/report.ts
import type { ReportInput } from '@shared/report'

export const sampleReport: ReportInput = {
  overview: { headline: '登入流程多了一道鎖定關卡', summary: '在 IP 限流之後加入 lockoutGuard。' },
  architecture: {
    before: {
      nodes: [
        { id: 'client', label: 'Client', status: 'unchanged', files: [] },
        { id: 'login', label: 'login.ts', status: 'unchanged', files: ['src/auth/login.ts'] }
      ],
      edges: [{ from: 'client', to: 'login' }]
    },
    after: {
      nodes: [
        { id: 'client', label: 'Client', status: 'unchanged', files: [] },
        { id: 'guard', label: 'lockoutGuard', status: 'added', files: ['src/auth/lockout.ts'] },
        { id: 'login', label: 'login.ts', status: 'modified', files: ['src/auth/login.ts'] }
      ],
      edges: [{ from: 'client', to: 'guard' }, { from: 'guard', to: 'login' }]
    }
  },
  decisions: [{ id: 'd1', title: '計數存在 Redis', chosen: '既有 Redis', rejected: ['in-memory'], rationale: '多台機器共享', source: { type: 'branch', ref: 'b1' } }],
  limitations: [{ title: 'Redis 掛掉時放行', detail: 'fail-open', severity: 'medium' }],
  followups: [{ title: '後台解鎖', detail: '' }],
  file_notes: [{ path: 'src/auth/lockout.ts', why: '獨立計數邏輯', hunks: [{ line_start: 12, line_end: 20, why: 'TTL 用 EXPIRE' }] }],
  verification: [{ command: 'npm test' }],
  custom_blocks: [{ id: 'state-machine', title: '鎖定狀態機', html: '<div>正常 → 鎖定</div>' }]
}
```

**Step 2: 寫失敗測試**

```ts
// tests/shared/report.test.ts
import { describe, expect, test } from 'vitest'
import { ReportInputSchema } from '@shared/report'
import { sampleReport } from '../fixtures/report'

describe('ReportInputSchema', () => {
  test('接受完整的報告', () => {
    expect(ReportInputSchema.safeParse(sampleReport).success).toBe(true)
  })

  test('缺少選填陣列時補預設值', () => {
    const { overview, architecture, decisions } = sampleReport
    const r = ReportInputSchema.parse({ overview, architecture, decisions })
    expect(r.limitations).toEqual([])
    expect(r.custom_blocks).toEqual([])
  })

  test('edge 參照不存在的節點時失敗', () => {
    const bad = structuredClone(sampleReport)
    bad.architecture.after.edges.push({ from: 'guard', to: 'nope' })
    const r = ReportInputSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('nope')
  })

  test('custom block id 只能是小寫英數與連字號', () => {
    const bad = structuredClone(sampleReport)
    bad.custom_blocks[0].id = 'State Machine'
    expect(ReportInputSchema.safeParse(bad).success).toBe(false)
  })

  test('custom block id 最長 64 字元（與 harness-block:// 網址的檢查一致）', () => {
    const ok = structuredClone(sampleReport)
    ok.custom_blocks[0].id = 'a'.repeat(64)
    expect(ReportInputSchema.safeParse(ok).success).toBe(true)
    const bad = structuredClone(sampleReport)
    bad.custom_blocks[0].id = 'a'.repeat(65)
    expect(ReportInputSchema.safeParse(bad).success).toBe(false)
  })

  test('同一張圖裡節點 id 重複時失敗', () => {
    const bad = structuredClone(sampleReport)
    bad.architecture.before.nodes.push({
      id: 'login',
      label: 'login2',
      status: 'unchanged',
      files: []
    })
    const r = ReportInputSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.path.join('.') === 'architecture.before.nodes.2')).toBe(
      true
    )
  })

  test('before 與 after 可以有相同的節點 id', () => {
    expect(ReportInputSchema.safeParse(sampleReport).success).toBe(true)
  })

  test('custom block id 重複時失敗', () => {
    const bad = structuredClone(sampleReport)
    bad.custom_blocks.push({ id: 'state-machine', title: '重複', html: '<p></p>' })
    const r = ReportInputSchema.safeParse(bad)
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.path.join('.') === 'custom_blocks.1.id')).toBe(true)
  })
})
```

**Step 3: 確認失敗**

Run: `npx vitest run tests/shared/report.test.ts` → Expected: FAIL（找不到 `@shared/report`）

**Step 4: 實作**

```ts
// src/shared/report.ts
import { z } from 'zod'

/** custom block id：也用在 harness-block:// 網址裡，主程序以相同規則（最長 64）檢查 */
const id = z.string().max(64).regex(/^[a-z0-9_-]+$/)

const NodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['added', 'modified', 'unchanged']),
  files: z.array(z.string()).default([])
})
const EdgeSchema = z.object({ from: z.string(), to: z.string(), label: z.string().optional() })
export const GraphSchema = z.object({
  nodes: z.array(NodeSchema).min(1),
  edges: z.array(EdgeSchema).default([])
})
export const DecisionSourceSchema = z.object({
  type: z.enum(['question', 'branch', 'implementation']),
  ref: z.string()
})

/** submit_report 工具使用的 raw shape */
export const ReportInputShape = {
  overview: z.object({ headline: z.string().min(1), summary: z.string().min(1) }),
  architecture: z.object({ before: GraphSchema, after: GraphSchema }),
  decisions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      chosen: z.string(),
      rejected: z.array(z.string()).default([]),
      rationale: z.string(),
      source: DecisionSourceSchema
    })
  ),
  limitations: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        severity: z.enum(['low', 'medium', 'high'])
      })
    )
    .default([]),
  followups: z.array(z.object({ title: z.string(), detail: z.string().default('') })).default([]),
  file_notes: z
    .array(
      z.object({
        path: z.string(),
        why: z.string(),
        hunks: z
          .array(
            z.object({
              line_start: z.number().int().positive(),
              line_end: z.number().int().positive(),
              why: z.string()
            })
          )
          .default([])
      })
    )
    .default([]),
  verification: z.array(z.object({ command: z.string().min(1) })).default([]),
  custom_blocks: z
    .array(z.object({ id, title: z.string(), html: z.string().max(200_000) }))
    .max(5)
    .default([])
}

export const ReportInputSchema = z.object(ReportInputShape).superRefine((r, ctx) => {
  for (const side of ['before', 'after'] as const) {
    const ids = new Set<string>()
    r.architecture[side].nodes.forEach((n, i) => {
      if (ids.has(n.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['architecture', side, 'nodes', i],
          message: `節點 id 重複：${n.id}`
        })
      }
      ids.add(n.id)
    })
    r.architecture[side].edges.forEach((e, i) => {
      if (!ids.has(e.from) || !ids.has(e.to)) {
        ctx.addIssue({
          code: 'custom',
          path: ['architecture', side, 'edges', i],
          message: `edge 參照不存在的節點 ${e.from}→${e.to}`
        })
      }
    })
  }
  const blockIds = new Set<string>()
  r.custom_blocks.forEach((b, i) => {
    if (blockIds.has(b.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['custom_blocks', i, 'id'],
        message: `custom block id 重複：${b.id}`
      })
    }
    blockIds.add(b.id)
  })
})

export type ReportInput = z.infer<typeof ReportInputSchema>
```

**Step 5: 確認通過**

Run: `npx vitest run tests/shared/report.test.ts` → Expected: 8 passed
Run: `npm run typecheck` → PASS

**Step 6: Commit**

```bash
git add src/shared tests/fixtures tests/shared
git commit -m "feat(shared): add domain types and report schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5：結構化訊息協定

使用者對 Claude 的回應以 `[tag key=value] 內容` 格式送出（見設計文件 3.3）。這些訊息在時間軸上給人看的文字（`msgDisplay`）與「實作從這裡開始」的標記（`IMPLEMENT_START_REF`、`startsImplementation`）也定義在這裡，主程序寫入時間軸、renderer 讀時間軸共用同一份定義。標記放在 user_text 的 `ref`，使用者打出一樣的字不會被誤認；整份時間軸都沒有標記（加上標記之前的任務）時才用 `legacyImplementStart` 比對文字。

**Files:**
- Create: `src/shared/protocol.ts`
- Test: `tests/shared/protocol.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import {
  IMPLEMENT_START_REF,
  legacyImplementStart,
  msg,
  msgDisplay,
  parseTagged,
  startsImplementation
} from '@shared/protocol'

describe('protocol', () => {
  test('answer 含選項與補充文字', () => {
    const s = msg.answer('q3', 'lock15', '鎖 15 分鐘')
    expect(s).toBe('[answer question_id=q3 option=lock15] 鎖 15 分鐘')
    expect(parseTagged(s)).toEqual({ tag: 'answer', attrs: { question_id: 'q3', option: 'lock15' }, body: '鎖 15 分鐘' })
  })

  test('answer 沒有選項時省略 option', () => {
    expect(msg.answer('q1', undefined, '自己描述')).toBe('[answer question_id=q1] 自己描述')
  })

  test('屬性值中的空白與右括號會被替換', () => {
    expect(msg.counterQuestion('a b]c', '?')).toBe('[counter_question question_id=a_b_c] ?')
  })

  test('多行內容可以被解析', () => {
    const s = msg.branchConclusion('b2', { decision: '寄通知信', rationale: '避免騷擾', deferred: ['重設連結'] })
    const p = parseTagged(s)!
    expect(p.tag).toBe('branch_conclusion')
    expect(p.attrs.branch).toBe('b2')
    expect(p.body).toBe('決策：寄通知信\n原因：避免騷擾\n延後：重設連結')
  })

  test('reportFeedback 列出錨點', () => {
    const s = msg.reportFeedback([{ anchor: 'diff:a.ts:3', label: 'a.ts:3', text: '改成常數' }], '整體不錯')
    expect(s).toBe('[report_feedback] - (diff:a.ts:3) 改成常數\n整體：整體不錯')
  })

  test('一般文字不是 tagged', () => {
    expect(parseTagged('你好')).toBeNull()
  })
})

describe('msgDisplay / startsImplementation', () => {
  const userText = (text: string, ref?: string) => ({ kind: 'user_text' as const, text, ref })

  test('核准規格與送出報告回饋的訊息帶著實作起點標記', () => {
    expect(startsImplementation(userText(msgDisplay.specApproved, IMPLEMENT_START_REF))).toBe(true)
    expect(startsImplementation(userText('任何文字', IMPLEMENT_START_REF))).toBe(true)
    expect(startsImplementation({ kind: 'system', ref: IMPLEMENT_START_REF })).toBe(false)
  })

  test('只看標記：使用者打出一樣的字不會被當成起點', () => {
    expect(startsImplementation(userText(msgDisplay.specApproved))).toBe(false)
    expect(startsImplementation(userText(msgDisplay.specApproved, 'other'))).toBe(false)
    expect(startsImplementation(userText('送出 3 則報告回饋'))).toBe(false)
  })

  test('舊時間軸（整份都沒有標記）才用顯示文字判斷', () => {
    expect(legacyImplementStart(userText(msgDisplay.specApproved))).toBe(true)
    expect(legacyImplementStart(userText('送出 3 則報告回饋'))).toBe(true)
    expect(legacyImplementStart(userText('送出 0 則報告回饋與整體意見'))).toBe(true)
    expect(legacyImplementStart(userText('核准規格之前想再問一下'))).toBe(false)
    expect(legacyImplementStart(userText('送出 3 則報告回饋，然後呢？'))).toBe(false)
    expect(legacyImplementStart(userText(msgDisplay.resume))).toBe(false)
  })

  test('報告回饋的顯示文字；只有整體意見時不說 0 則', () => {
    expect(msgDisplay.reportFeedback(3, false)).toBe('送出 3 則報告回饋')
    expect(msgDisplay.reportFeedback(2, true)).toBe('送出 2 則報告回饋與整體意見')
    expect(msgDisplay.reportFeedback(0, true)).toBe('送出整體意見')
  })
})
```

**Step 2: 確認失敗** — Run: `npx vitest run tests/shared/protocol.test.ts` → FAIL

**Step 3: 實作**

```ts
// src/shared/protocol.ts
import type { BranchConclusion, FeedbackItem, TimelineEvent } from './types'

export interface Tagged { tag: string; attrs: Record<string, string>; body: string }

const clean = (v: string) => v.replace(/[\s\]]/g, '_')

function tag(name: string, attrs: Record<string, string | undefined>, body = ''): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}=${clean(v as string)}`)
    .join('')
  return `[${name}${a}]${body ? ` ${body}` : ''}`
}

export const BRANCH_RULES = [
  '（Harness 規則）這是從主線分出來的分岔討論，用來深入討論一個主題。',
  '你可以閱讀程式碼，但不能修改檔案或執行指令；不要使用 ask_user、propose_spec，直接用文字討論。',
  '使用者送出 [conclude] 時，呼叫 mcp__harness__conclude_branch 整理結論（decision 一句話、rationale 原因、deferred 延後事項），然後結束這一輪。'
].join('\n')

export const msg = {
  answer: (questionId: string, optionId?: string, text?: string) =>
    tag('answer', { question_id: questionId, option: optionId }, text),
  counterQuestion: (questionId: string, text: string) => tag('counter_question', { question_id: questionId }, text),
  branchOpen: (title: string, seed: string) => tag('branch_open', {}, `${BRANCH_RULES}\n\n主題：${title}${seed ? `\n${seed}` : ''}`),
  conclude: () => tag('conclude', {}, '請呼叫 conclude_branch 整理這個分岔的結論。'),
  branchConclusion: (branchId: string, c: BranchConclusion) =>
    tag('branch_conclusion', { branch: branchId },
      `決策：${c.decision}\n原因：${c.rationale}${c.deferred.length ? `\n延後：${c.deferred.join('；')}` : ''}`),
  specFeedback: (text: string) => tag('spec_feedback', {}, text),
  specApproved: () => tag('spec_approved', {}, '規格已核准，現在進入實作階段，請開始實作。'),
  reportFeedback: (items: FeedbackItem[], overall?: string) =>
    tag('report_feedback', {}, [...items.map((i) => `- (${i.anchor}) ${i.text}`), overall ? `整體：${overall}` : '']
      .filter(Boolean).join('\n')),
  resume: () => tag('resume', {}, '上一次執行被中斷，請從中斷的地方繼續。')
}

/** 上面幾則訊息在時間軸上給人看的文字（主程序寫入 user_text 時用） */
export const msgDisplay = {
  specApproved: '核准規格，開始實作',
  specFeedback: (text: string) => `要求修改規格：${text}`,
  reportFeedback: (count: number, withOverall: boolean) =>
    count ? `送出 ${count} 則報告回饋${withOverall ? '與整體意見' : ''}` : '送出整體意見',
  resume: '繼續執行'
}

/** 核准規格、送出報告回饋寫入的 user_text 帶這個 ref：實作畫面從最後一個標記開始顯示 */
export const IMPLEMENT_START_REF = 'implement_start'

/** 時間軸事件是否標記一段實作的開始（看 ref：使用者打出一樣的字不會被誤認） */
export function startsImplementation(e: Pick<TimelineEvent, 'kind' | 'ref'>): boolean {
  return e.kind === 'user_text' && e.ref === IMPLEMENT_START_REF
}

/**
 * 加上 ref 標記之前寫入的實作起點，只能比對顯示文字。
 * 只在整份時間軸都沒有標記時使用（新時間軸裡沒有 ref 的 user_text 是使用者自己打的字）。
 */
export function legacyImplementStart(e: Pick<TimelineEvent, 'kind' | 'text' | 'ref'>): boolean {
  if (e.kind !== 'user_text' || e.ref !== undefined) return false
  const text = e.text ?? ''
  return text === msgDisplay.specApproved || /^送出 \d+ 則報告回饋(與整體意見)?$/.test(text)
}

export function parseTagged(s: string): Tagged | null {
  const m = /^\[([a-z_]+)((?:\s+[a-z_]+=[^\s\]]+)*)\](?:\s([\s\S]*))?$/.exec(s)
  if (!m) return null
  const attrs: Record<string, string> = {}
  for (const pair of m[2].trim().split(/\s+/).filter(Boolean)) {
    const i = pair.indexOf('=')
    attrs[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return { tag: m[1], attrs, body: m[3] ?? '' }
}
```

**Step 4: 確認通過** — Run: `npx vitest run tests/shared/protocol.test.ts` → 10 passed

**Step 5: Commit**

```bash
git add src/shared/protocol.ts tests/shared/protocol.test.ts
git commit -m "feat(shared): add structured user message protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6：Unified diff 解析

**Files:**
- Create: `src/shared/diff.ts`
- Test: `tests/shared/diff.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import { parseUnifiedDiff } from '@shared/diff'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export {}
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+-- not a header
+x
`

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF)

  test('解析出兩個檔案與狀態', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/new.ts', 'added']
    ])
  })

  test('行號正確', () => {
    const lines = files[0].hunks[0].lines
    expect(lines[0]).toEqual({ type: 'ctx', text: 'const a = 1', oldNo: 1, newNo: 1 })
    expect(lines[1]).toEqual({ type: 'del', text: 'const b = 2', oldNo: 2 })
    expect(lines[2]).toEqual({ type: 'add', text: 'const b = 3', newNo: 2 })
    expect(lines[3]).toEqual({ type: 'add', text: 'const c = 4', newNo: 3 })
    expect(lines[4]).toEqual({ type: 'ctx', text: 'export {}', oldNo: 3, newNo: 4 })
  })

  test('hunk 內以 -- 開頭的新增行不會被當成標頭', () => {
    expect(files[1].hunks[0].lines[0]).toEqual({ type: 'add', text: '-- not a header', newNo: 1 })
  })

  test('rename', () => {
    const r = parseUnifiedDiff(
      'diff --git a/x.ts b/y.ts\nsimilarity index 100%\nrename from x.ts\nrename to y.ts\n'
    )
    expect(r[0]).toMatchObject({ path: 'y.ts', oldPath: 'x.ts', status: 'renamed' })
  })

  test('modified 檔案沒有 oldPath', () => {
    expect(files[0].oldPath).toBeUndefined()
    expect(files[1].oldPath).toBeUndefined()
  })

  test('CRLF 換行與 LF 結果相同', () => {
    expect(parseUnifiedDiff(DIFF.replace(/\n/g, '\r\n'))).toEqual(files)
  })

  test('git 以引號與八進位跳脫表示的中文路徑', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/\344\270\255.ts" "b/\344\270\255.ts"
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ "b/\344\270\255.ts"
@@ -0,0 +1 @@
+x
`
    )
    expect(r[0]).toMatchObject({ path: '中.ts', status: 'added' })
    expect(r[0].hunks[0].lines).toEqual([{ type: 'add', text: 'x', newNo: 1 }])
  })

  test('沒有 ---/+++ 時從引號標頭取得路徑', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/\344\270\255.png" "b/\344\270\255.png"
new file mode 100644
index 0000000..1111111
Binary files /dev/null and "b/\344\270\255.png" differ
`
    )
    expect(r[0]).toMatchObject({ path: '中.png', status: 'added', binary: true })
  })

  test('引號路徑中的跳脫字元（雙引號、反斜線、tab、換行）', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/q\"b\\c\td\ne.ts" "b/q\"b\\c\td\ne.ts"
--- "a/q\"b\\c\td\ne.ts"
+++ "b/q\"b\\c\td\ne.ts"
@@ -1 +1 @@
-a
+b
`
    )
    expect(r[0].path).toBe('q"b\\c\td\ne.ts')
  })

  test('引號的 rename from/to', () => {
    const r = parseUnifiedDiff(
      String.raw`diff --git "a/\344\270\255.ts" "b/\346\226\207.ts"
similarity index 100%
rename from "\344\270\255.ts"
rename to "\346\226\207.ts"
`
    )
    expect(r[0]).toMatchObject({ path: '文.ts', oldPath: '中.ts', status: 'renamed' })
  })

  test('刪除檔案沿用舊路徑', () => {
    const r = parseUnifiedDiff(
      'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex 111..000\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
    )
    expect(r[0]).toMatchObject({ path: 'old.ts', status: 'deleted' })
    expect(r[0].oldPath).toBeUndefined()
  })

  test('含空白的路徑會去掉 git 補在 ---/+++ 後的 tab', () => {
    const r = parseUnifiedDiff(
      'diff --git a/my file.ts b/my file.ts\nindex 1..2 100644\n--- a/my file.ts\t\n+++ b/my file.ts\t\n@@ -1 +1 @@\n-a\n+b\n'
    )
    expect(r[0].path).toBe('my file.ts')
  })
})
```

**Step 2: 確認失敗** — `npx vitest run tests/shared/diff.test.ts` → FAIL

**Step 3: 實作**

```ts
// src/shared/diff.ts
export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}
export interface DiffHunk {
  header: string
  lines: DiffLine[]
}
export interface DiffFile {
  path: string
  /** 只有 status 為 'renamed' 時才有 */
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  hunks: DiffHunk[]
  binary: boolean
}

const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`
const GIT_HEADER = new RegExp(`^diff --git (${QUOTED}|a/.+) (${QUOTED}|b/.+)$`)
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }

/** 解開 git 的 C 風格引號路徑；八進位跳脫是 UTF-8 位元組 */
export function unquotePath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s
  const enc = new TextEncoder()
  const bytes: number[] = []
  for (const m of s.slice(1, -1).matchAll(/\\([0-7]{1,3}|[\s\S])|[^\\]+/g)) {
    const esc = m[1]
    if (esc === undefined) bytes.push(...enc.encode(m[0]))
    else if (/^[0-7]+$/.test(esc)) bytes.push(parseInt(esc, 8) & 0xff)
    else if (esc in C_ESCAPES) bytes.push(C_ESCAPES[esc])
    else bytes.push(...enc.encode(esc))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** `a/x`、`"b/x"`、`/dev/null`（可能帶 git 補上的結尾 tab）→ 路徑；/dev/null 回傳 null */
function sidePath(raw: string): string | null {
  const p = unquotePath(raw.replace(/\t.*$/, ''))
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  /** 本檔案 `---` 行的路徑，供 `+++ /dev/null`（刪除）沿用 */
  let minusPath: string | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = GIT_HEADER.exec(line)
      file = { path: m ? (sidePath(m[2]) ?? '') : '', status: 'modified', hunks: [], binary: false }
      files.push(file)
      hunk = undefined
      minusPath = null
      continue
    }
    if (!file) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = unquotePath(line.slice('rename from '.length))
      } else if (line.startsWith('rename to '))
        file.path = unquotePath(line.slice('rename to '.length))
      else if (line.startsWith('Binary files')) file.binary = true
      else if (line.startsWith('--- ')) {
        minusPath = sidePath(line.slice(4))
        if (minusPath === null) file.status = 'added'
      } else if (line.startsWith('+++ ')) {
        const p = sidePath(line.slice(4))
        if (p !== null) file.path = p
        else {
          file.status = 'deleted'
          if (minusPath !== null) file.path = minusPath
        }
      }
      continue
    }
    if (line.startsWith('+')) hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
    else if (line.startsWith('-'))
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
    else if (line.startsWith(' '))
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return files
}
```

**Step 4: 確認通過** — 12 passed

**Step 5: Commit**

```bash
git add src/shared/diff.ts tests/shared/diff.test.ts
git commit -m "feat(shared): add unified diff parser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7：架構圖分層排版

**Files:**
- Create: `src/shared/layout.ts`
- Test: `tests/shared/layout.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import { BOX_H, BOX_W, GAP_X, GAP_Y, layoutGraph } from '@shared/layout'

const n = (id: string) => ({ id })

describe('layoutGraph', () => {
  test('直線鏈每個節點一層', () => {
    const r = layoutGraph([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
    expect(r.nodes.map((x) => [x.node.id, x.layer])).toEqual([['a', 0], ['b', 1], ['c', 2]])
    expect(r.height).toBe(3 * BOX_H + 2 * GAP_Y)
    expect(r.width).toBe(BOX_W)
  })

  test('同一層的節點並排並置中', () => {
    const r = layoutGraph([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }])
    const b = r.nodes.find((x) => x.node.id === 'b')!
    const c = r.nodes.find((x) => x.node.id === 'c')!
    const a = r.nodes.find((x) => x.node.id === 'a')!
    expect(b.layer).toBe(1)
    expect(c.layer).toBe(1)
    expect(c.x - b.x).toBe(BOX_W + GAP_X)
    expect(a.x).toBe((r.width - BOX_W) / 2)
  })

  test('有環時仍會結束', () => {
    const r = layoutGraph([n('a'), n('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])
    expect(r.nodes).toHaveLength(2)
  })

  test('忽略指向不存在節點的邊', () => {
    const r = layoutGraph([n('a')], [{ from: 'a', to: 'zzz' }])
    expect(r.nodes[0].layer).toBe(0)
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/shared/layout.ts
export const BOX_W = 180
export const BOX_H = 44
export const GAP_X = 40
export const GAP_Y = 56

export interface LaidOutNode<N> { node: N; layer: number; index: number; x: number; y: number }

export function layoutGraph<N extends { id: string }>(nodes: N[], edges: { from: string; to: string }[]) {
  const layer = new Map(nodes.map((nd) => [nd.id, 0]))
  for (let i = 0; i < nodes.length; i++) {
    let changed = false
    for (const e of edges) {
      if (e.from === e.to || !layer.has(e.from) || !layer.has(e.to)) continue
      const want = layer.get(e.from)! + 1
      if (want > layer.get(e.to)! && want < nodes.length) {
        layer.set(e.to, want)
        changed = true
      }
    }
    if (!changed) break
  }

  const rows = new Map<number, N[]>()
  for (const nd of nodes) {
    const l = layer.get(nd.id)!
    rows.set(l, [...(rows.get(l) ?? []), nd])
  }
  const maxRow = Math.max(1, ...[...rows.values()].map((r) => r.length))
  const width = maxRow * BOX_W + (maxRow - 1) * GAP_X

  const laid: LaidOutNode<N>[] = []
  for (const [l, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const rowW = row.length * BOX_W + (row.length - 1) * GAP_X
    const x0 = (width - rowW) / 2
    row.forEach((node, index) => laid.push({ node, layer: l, index, x: x0 + index * (BOX_W + GAP_X), y: l * (BOX_H + GAP_Y) }))
  }
  const layers = rows.size ? Math.max(...rows.keys()) + 1 : 0
  return { nodes: laid, width, height: layers * BOX_H + Math.max(0, layers - 1) * GAP_Y }
}
```

**Step 4: 確認通過** — 4 passed

**Step 5: Commit**

```bash
git add src/shared/layout.ts tests/shared/layout.test.ts
git commit -m "feat(shared): add layered layout for architecture graphs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8：IPC 契約

**Files:**
- Create: `src/shared/ipc.ts`

**Step 1: 寫入（純型別）**

```ts
import type {
  Branch, BranchConclusion, Channel, ClaudeStatus, DiffStats, FeedbackItem, ModelId,
  PermissionDecision, Report, Repo, Settings, Task, TimelineEvent
} from './types'

export interface CreateTaskInput { repoId: string; request: string; baseBranch: string; model: ModelId }

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
  'tasks:send': (taskId: string, channel: Channel, text: string) => void
  'tasks:answer': (taskId: string, questionId: string, answer: { optionId?: string; text?: string }) => void
  'tasks:counter': (taskId: string, questionId: string, text: string) => void
  'tasks:changedFiles': (taskId: string) => DiffStats
  'branch:open': (taskId: string, input: { title: string; fromQuestionId?: string; seed?: string }) => Branch
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
  invoke<C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>): Promise<Awaited<ReturnType<IpcApi[C]>>>
  onEvent(cb: (e: AppEvent) => void): () => void
}

export const APP_EVENT_CHANNEL = 'app:event'
```

**Step 2: 驗證與 commit**

Run: `npm run typecheck` → PASS

```bash
git add src/shared/ipc.ts
git commit -m "feat(shared): define typed IPC contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Phase 2：主程序核心（src/main）

### Task 9：JSON Store

**Files:**
- Create: `src/main/store/store.ts`
- Test: `tests/main/store.test.ts`

**Step 1: 寫失敗測試**

```ts
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { Store } from '../../src/main/store/store'

let root: string
let store: Store
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-store-'))
  store = new Store(root)
})

describe('Store', () => {
  test('不存在的 JSON 回傳 fallback', async () => {
    expect(await store.readJson('a/b.json', { x: 1 })).toEqual({ x: 1 })
  })

  test('writeJson 會建立資料夾並可讀回', async () => {
    await store.writeJson('a/b.json', { y: 2 })
    expect(await store.readJson('a/b.json', null)).toEqual({ y: 2 })
  })

  test('jsonl append 與讀取，略過壞掉的行', async () => {
    await store.appendJsonl('t/log.jsonl', { n: 1 })
    await store.appendJsonl('t/log.jsonl', { n: 2 })
    await writeFile(
      join(root, 't/log.jsonl'),
      (await readFile(join(root, 't/log.jsonl'), 'utf8')) + '{"n":'
    )
    expect(await store.readJsonl('t/log.jsonl')).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('list 回傳子項目，資料夾不存在時回傳空陣列', async () => {
    expect(await store.list('tasks')).toEqual([])
    await mkdir(join(root, 'tasks/a'), { recursive: true })
    expect(await store.list('tasks')).toEqual(['a'])
  })

  test('list 略過以 . 開頭的項目', async () => {
    await mkdir(join(root, 'tasks/a'), { recursive: true })
    await writeFile(join(root, 'tasks/.DS_Store'), '')
    expect(await store.list('tasks')).toEqual(['a'])
  })

  test('路徑中間是檔案（ENOTDIR）時視為不存在', async () => {
    await writeFile(join(root, 'f'), '')
    expect(await store.readJson('f/x.json', 'fb')).toBe('fb')
    expect(await store.readJsonl('f/x.jsonl')).toEqual([])
    expect(await store.list('f/sub')).toEqual([])
  })

  test('上一行寫到一半時，append 會從新的一行開始', async () => {
    await store.appendJsonl('t/log.jsonl', { n: 1 })
    await writeFile(
      join(root, 't/log.jsonl'),
      (await readFile(join(root, 't/log.jsonl'), 'utf8')) + '{"n":'
    )
    await store.appendJsonl('t/log.jsonl', { n: 2 })
    expect(await store.readJsonl('t/log.jsonl')).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('writeJson 失敗時清掉暫存檔', async () => {
    await mkdir(join(root, 'd/sub'), { recursive: true })
    await expect(store.writeJson('d', { x: 1 })).rejects.toThrow()
    expect((await readdir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  test('路徑不能跳出 store 根目錄', async () => {
    await expect(store.readJson('../x.json', null)).rejects.toThrow('超出')
    await expect(store.writeJson('a/../../evil.json', {})).rejects.toThrow('超出')
    await expect(store.appendJsonl('/etc/x.jsonl', {})).rejects.toThrow('超出')
    await expect(store.list('..')).rejects.toThrow('超出')
  })
})
```

**Step 2: 確認失敗** — `npx vitest run tests/main/store.test.ts` → FAIL

**Step 3: 實作**

```ts
// src/main/store/store.ts
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

// ENOTDIR：路徑中間是檔案（例如 tasks/.DS_Store/task.json），一樣視為不存在
const isMissing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 檔案存在、非空且最後一個字元不是換行（上次寫到一半） */
async function endsMidLine(file: string): Promise<boolean> {
  let fh
  try {
    fh = await open(file, 'r')
  } catch (e) {
    if (isMissing(e)) return false
    throw e
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) return false
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] !== 0x0a
  } finally {
    await fh.close()
  }
}

export class Store {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private path(rel: string) {
    const p = resolve(this.root, rel)
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error(`路徑超出資料夾範圍：${rel}`)
    }
    return p
  }

  async readJson<T>(rel: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path(rel), 'utf8')) as T
    } catch (e) {
      if (isMissing(e)) return fallback
      throw e
    }
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    const file = this.path(rel)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2))
      await rename(tmp, file)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
  }

  async appendJsonl(rel: string, obj: unknown): Promise<void> {
    const file = this.path(rel)
    await mkdir(dirname(file), { recursive: true })
    const lead = (await endsMidLine(file)) ? '\n' : ''
    await appendFile(file, `${lead}${JSON.stringify(obj)}\n`)
  }

  async readJsonl<T>(rel: string): Promise<T[]> {
    let text: string
    try {
      text = await readFile(this.path(rel), 'utf8')
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
    const out: T[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        /* 寫到一半的行，略過 */
      }
    }
    return out
  }

  async list(relDir: string): Promise<string[]> {
    try {
      return (await readdir(this.path(relDir))).filter((name) => !name.startsWith('.'))
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
  }
}
```

**Step 4: 確認通過** — 9 passed

**Step 5: Commit**

```bash
git add src/main/store/store.ts tests/main/store.test.ts
git commit -m "feat(main): add atomic JSON store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10：Repository（設定、repo、任務、時間軸、報告的存取）

**Files:**
- Create: `src/main/store/repository.ts`（設定的讀寫依序進行並快取：`updateSettings` 合併寫入、`cachedSettings()` 同步取得最近一次的設定）
- Create: `tests/fixtures/task.ts`
- Test: `tests/main/repository.test.ts`

**Step 1: Task fixture**

```ts
// tests/fixtures/task.ts
import type { Task } from '@shared/types'

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    repoId: 'r1',
    title: '登入失敗鎖定',
    request: '加上登入失敗鎖定',
    baseBranch: 'main',
    branch: 'harness/t1',
    worktreePath: '/tmp/wt/t1',
    model: 'claude-opus-5-5',
    status: 'clarifying',
    runState: 'idle',
    questions: [],
    decisions: [],
    specs: [],
    plan: [],
    branches: [],
    allowedCommands: [],
    approvedCommands: [],
    reportVersions: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    ...over
  }
}
```

**Step 2: 寫失敗測試**

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { makeTask } from '../fixtures/task'
import { sampleReport } from '../fixtures/report'

let root: string
let repo: Repository
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-repo-'))
  repo = new Repository(new Store(root), '/Users/me')
})

describe('Repository', () => {
  test('設定有預設值，儲存後合併', async () => {
    const s = await repo.getSettings()
    expect(s.worktreeRoot).toBe('/Users/me/.harness/worktrees')
    expect(s.defaultModel).toBe('claude-opus-5-5')
    // git diff / git log 帶任意參數可用 --output 寫檔，所以只預設允許不帶參數的版本
    expect(s.alwaysAllowedCommands).toEqual(['git status', 'git diff', 'git log', 'ls', 'ls *'])
    await repo.saveSettings({ ...s, branchPrefix: 'x/' })
    expect((await repo.getSettings()).branchPrefix).toBe('x/')
  })

  test('updateSettings 依序合併：同時更新不同欄位都會保留', async () => {
    const [a, b] = await Promise.all([
      repo.updateSettings({ branchPrefix: 'a/' }),
      repo.updateSettings({ loadProjectSettings: false })
    ])
    expect(a.branchPrefix).toBe('a/')
    expect(b).toMatchObject({ branchPrefix: 'a/', loadProjectSettings: false })
    expect(await repo.getSettings()).toMatchObject({
      branchPrefix: 'a/',
      loadProjectSettings: false
    })
  })

  test('讀取排在進行中的更新之後，不會讀到舊值', async () => {
    const [, read] = await Promise.all([
      repo.updateSettings({ branchPrefix: 'a/' }),
      repo.getSettings()
    ])
    expect(read.branchPrefix).toBe('a/')
  })

  test('cachedSettings：尚未讀取時是預設值但不允許任何指令，之後是最近一次讀取或寫入的設定', async () => {
    // 還不知道使用者的允許清單：寧可多問，不自動允許預設的指令
    expect(repo.cachedSettings()).toMatchObject({
      branchPrefix: 'harness/',
      alwaysAllowedCommands: []
    })
    await writeFile(join(root, 'settings.json'), JSON.stringify({ branchPrefix: 'disk/' }))
    await repo.getSettings()
    expect(repo.cachedSettings().branchPrefix).toBe('disk/')
    await repo.updateSettings({ alwaysAllowedCommands: ['npm test'] })
    expect(repo.cachedSettings()).toMatchObject({
      branchPrefix: 'disk/',
      alwaysAllowedCommands: ['npm test']
    })
  })

  test('讀取失敗（設定檔壞掉）時 cachedSettings 仍不允許任何指令', async () => {
    await writeFile(join(root, 'settings.json'), '{"alwaysAllowedCommands":')
    await expect(repo.getSettings()).rejects.toThrow()
    expect(repo.cachedSettings().alwaysAllowedCommands).toEqual([])
  })

  test('寫入失敗時快取維持原值，之後的更新照常進行', async () => {
    const store = new Store(root)
    const failing = new Repository(store, '/Users/me')
    await failing.getSettings()
    const write = vi.spyOn(store, 'writeJson').mockRejectedValueOnce(new Error('disk full'))
    await expect(failing.updateSettings({ branchPrefix: 'x/' })).rejects.toThrow('disk full')
    expect(failing.cachedSettings().branchPrefix).toBe('harness/')
    write.mockRestore()
    expect((await failing.updateSettings({ branchPrefix: 'y/' })).branchPrefix).toBe('y/')
  })

  test('任務依建立時間新到舊排序', async () => {
    await repo.saveTask(makeTask({ id: 'a', createdAt: '2026-10-01T00:00:00Z' }))
    await repo.saveTask(makeTask({ id: 'b', createdAt: '2026-10-05T00:00:00Z' }))
    expect((await repo.listTasks()).map((t) => t.id)).toEqual(['b', 'a'])
  })

  test('tasks 資料夾裡的雜檔（如 .DS_Store）不影響任務清單', async () => {
    await repo.saveTask(makeTask({ id: 'a' }))
    await mkdir(join(root, 'tasks'), { recursive: true })
    await writeFile(join(root, 'tasks/.DS_Store'), '')
    await writeFile(join(root, 'tasks/stray.txt'), '')
    expect((await repo.listTasks()).map((t) => t.id)).toEqual(['a'])
  })

  test('壞掉的 task.json 會被略過，不影響其他任務', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await repo.saveTask(makeTask({ id: 'a' }))
    await mkdir(join(root, 'tasks/bad'), { recursive: true })
    await writeFile(join(root, 'tasks/bad/task.json'), '{"id":')
    expect((await repo.listTasks()).map((t) => t.id)).toEqual(['a'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('時間軸 append 與讀取', async () => {
    await repo.appendTimeline('a', {
      id: 'e1',
      ts: 'x',
      channel: 'main',
      kind: 'user_text',
      text: 'hi'
    })
    expect(await repo.readTimeline('a')).toHaveLength(1)
  })

  test('報告存取，不存在時丟錯', async () => {
    const r = {
      version: 1,
      taskId: 'a',
      input: sampleReport,
      diff: '',
      stats: { files: 0, additions: 0, deletions: 0, perFile: [] },
      verification: [],
      createdAt: 'x'
    }
    await repo.saveReport(r)
    expect((await repo.getReport('a', 1)).version).toBe(1)
    await expect(repo.getReport('a', 2)).rejects.toThrow('v2')
  })
})
```

**Step 3: 確認失敗**

**Step 4: 實作**

```ts
// src/main/store/repository.ts
import { join } from 'node:path'
import type { Report, Repo, Settings, Task, TimelineEvent } from '@shared/types'
import type { Store } from './store'

export const defaultSettings = (home: string): Settings => ({
  defaultModel: 'claude-opus-5-5',
  worktreeRoot: join(home, '.harness', 'worktrees'),
  branchPrefix: 'harness/',
  // git diff / git log 帶任意參數可用 --output 寫到 worktree 外，所以只允許不帶參數的版本
  alwaysAllowedCommands: ['git status', 'git diff', 'git log', 'ls', 'ls *'],
  loadProjectSettings: true
})

export class Repository {
  /** 設定的讀寫依序進行：「讀取 → 合併 → 寫入」之間不會插進另一個寫入 */
  private settingsLock: Promise<unknown> = Promise.resolve()
  /** 最近一次讀取或寫入的設定 */
  private settings?: Settings

  constructor(
    private store: Store,
    private home: string
  ) {}

  private withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settingsLock.then(fn)
    this.settingsLock = run.catch(() => undefined)
    return run
  }

  private async readSettings(): Promise<Settings> {
    const s = {
      ...defaultSettings(this.home),
      ...(await this.store.readJson<Partial<Settings>>('settings.json', {}))
    }
    this.settings = s
    return s
  }

  private async writeSettings(s: Settings) {
    await this.store.writeJson('settings.json', s)
    this.settings = s
  }

  getSettings(): Promise<Settings> {
    return this.withSettingsLock(() => this.readSettings())
  }
  saveSettings(s: Settings) {
    return this.withSettingsLock(() => this.writeSettings(s))
  }
  /** 讀出目前的設定、合併 patch 後寫回；同時呼叫也不會互相蓋掉欄位 */
  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.withSettingsLock(async () => {
      const next = { ...(await this.readSettings()), ...patch }
      await this.writeSettings(next)
      return next
    })
  }
  /**
   * 同步取得最近一次讀取或寫入的設定。
   * 給執行中的權限判斷用：設定頁移除允許的指令後，進行中的對話輪也立即適用。
   */
  cachedSettings(): Settings {
    // 還沒成功讀過設定（或設定檔壞掉）時不知道使用者的允許清單：
    // 其他欄位用預設值，但不自動允許任何指令（fail-safe，寧可多問一次）
    return this.settings ?? { ...defaultSettings(this.home), alwaysAllowedCommands: [] }
  }

  listRepos() {
    return this.store.readJson<Repo[]>('repos.json', [])
  }
  saveRepos(repos: Repo[]) {
    return this.store.writeJson('repos.json', repos)
  }

  async listTasks(): Promise<Task[]> {
    const ids = await this.store.list('tasks')
    const tasks = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.store.readJson<Task | null>(`tasks/${id}/task.json`, null)
        } catch (e) {
          // 單一任務檔壞掉不應讓整個清單載入失敗
          console.warn(`略過無法讀取的任務 ${id}:`, e)
          return null
        }
      })
    )
    return tasks
      .filter((t): t is Task => !!t)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  saveTask(t: Task) {
    return this.store.writeJson(`tasks/${t.id}/task.json`, t)
  }

  appendTimeline(taskId: string, e: TimelineEvent) {
    return this.store.appendJsonl(`tasks/${taskId}/timeline.jsonl`, e)
  }
  readTimeline(taskId: string) {
    return this.store.readJsonl<TimelineEvent>(`tasks/${taskId}/timeline.jsonl`)
  }

  saveReport(r: Report) {
    return this.store.writeJson(`tasks/${r.taskId}/reports/v${r.version}.json`, r)
  }
  async getReport(taskId: string, version: number): Promise<Report> {
    const r = await this.store.readJson<Report | null>(
      `tasks/${taskId}/reports/v${version}.json`,
      null
    )
    if (!r) throw new Error(`找不到報告 v${version}`)
    return r
  }
}
```

**Step 5: 確認通過** — 6 passed

**Step 6: Commit**

```bash
git add src/main/store/repository.ts tests/fixtures/task.ts tests/main/repository.test.ts
git commit -m "feat(main): add repository for settings, repos, tasks and reports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11：任務狀態機

**Files:**
- Create: `src/main/tasks/stateMachine.ts`
- Test: `tests/main/stateMachine.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import { InvalidTransition, phaseOf, transition } from '../../src/main/tasks/stateMachine'

describe('transition', () => {
  test.each([
    ['clarifying', 'SPEC_PROPOSED', 'spec_review'],
    ['spec_review', 'SPEC_PROPOSED', 'spec_review'],
    ['spec_review', 'SPEC_CHANGES_REQUESTED', 'clarifying'],
    ['spec_review', 'SPEC_APPROVED', 'implementing'],
    ['implementing', 'REPORT_SUBMITTED', 'reviewing'],
    ['reviewing', 'REPORT_FEEDBACK', 'implementing'],
    ['reviewing', 'FINISHED', 'done'],
    ['clarifying', 'DISCARDED', 'discarded']
  ] as const)('%s + %s → %s', (from, ev, to) => {
    expect(transition(from, ev)).toBe(to)
  })

  test('不合法的轉換丟出 InvalidTransition', () => {
    expect(() => transition('clarifying', 'SPEC_APPROVED')).toThrow(InvalidTransition)
    expect(() => transition('done', 'DISCARDED')).toThrow(InvalidTransition)
  })
})

describe('phaseOf', () => {
  test('實作階段才可寫入', () => {
    expect(phaseOf('implementing')).toBe('implement')
    expect(phaseOf('clarifying')).toBe('clarify')
    expect(phaseOf('spec_review')).toBe('clarify')
    expect(phaseOf('reviewing')).toBe('clarify')
    expect(phaseOf('done')).toBe('closed')
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/tasks/stateMachine.ts
import type { TaskStatus } from '@shared/types'

export type TaskEventType =
  | 'SPEC_PROPOSED' | 'SPEC_CHANGES_REQUESTED' | 'SPEC_APPROVED'
  | 'REPORT_SUBMITTED' | 'REPORT_FEEDBACK' | 'FINISHED' | 'DISCARDED'

const TABLE: Record<TaskStatus, Partial<Record<TaskEventType, TaskStatus>>> = {
  clarifying: { SPEC_PROPOSED: 'spec_review', DISCARDED: 'discarded' },
  spec_review: { SPEC_PROPOSED: 'spec_review', SPEC_CHANGES_REQUESTED: 'clarifying', SPEC_APPROVED: 'implementing', DISCARDED: 'discarded' },
  implementing: { REPORT_SUBMITTED: 'reviewing', DISCARDED: 'discarded' },
  reviewing: { REPORT_FEEDBACK: 'implementing', FINISHED: 'done', DISCARDED: 'discarded' },
  done: {},
  discarded: {}
}

export class InvalidTransition extends Error {}

export function transition(status: TaskStatus, event: TaskEventType): TaskStatus {
  const next = TABLE[status][event]
  if (!next) throw new InvalidTransition(`無法在 ${status} 狀態執行 ${event}`)
  return next
}

export type GatePhase = 'clarify' | 'branch' | 'implement' | 'closed'

export function phaseOf(status: TaskStatus): GatePhase {
  if (status === 'implementing') return 'implement'
  if (status === 'done' || status === 'discarded') return 'closed'
  return 'clarify'
}
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/tasks/stateMachine.ts tests/main/stateMachine.test.ts
git commit -m "feat(main): add task state machine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12：指令樣式比對

**Files:**
- Create: `src/main/permissions/commandPattern.ts`
- Test: `tests/main/commandPattern.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import {
  hasShellOperators,
  matchesPattern,
  suggestPattern
} from '../../src/main/permissions/commandPattern'

describe('matchesPattern', () => {
  test('完全相同', () => expect(matchesPattern('git status', 'git status')).toBe(true))
  test('結尾 * 比對前綴加參數', () => {
    expect(matchesPattern('npm test -- auth', 'npm test *')).toBe(true)
    expect(matchesPattern('npm test', 'npm test *')).toBe(true)
    expect(matchesPattern('npm testing', 'npm test *')).toBe(false)
  })
  test('多餘空白會被正規化', () =>
    expect(matchesPattern('  git   diff  HEAD ', 'git diff *')).toBe(true))
  test('空樣式不比對', () => expect(matchesPattern('ls', '')).toBe(false))
})

describe('hasShellOperators', () => {
  test.each([
    'a && b',
    'a; b',
    'a | b',
    'echo $(x)',
    'echo `x`',
    'a > f',
    'a\nb',
    'a\rb',
    'echo $HOME',
    'npm test -- ${X}'
  ])('%s 有串接', (c) => {
    expect(hasShellOperators(c)).toBe(true)
  })
  test('一般指令沒有', () => expect(hasShellOperators('npm test -- --run auth')).toBe(false))
})

describe('suggestPattern', () => {
  test.each([
    ['npm test -- auth', 'npm test *'],
    ['git diff', 'git diff *'],
    ['ls', 'ls *']
  ])('%s → %s', (c, p) => expect(suggestPattern(c)).toBe(p))
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/permissions/commandPattern.ts
const normalize = (s: string) => s.trim().replace(/\s+/g, ' ')

/** 串接、重導、命令替換、變數展開或換行都視為需要人工核准 */
export function hasShellOperators(command: string): boolean {
  return /[;&|`<>$\n\r]/.test(command)
}

export function matchesPattern(command: string, pattern: string): boolean {
  const c = normalize(command)
  const p = normalize(pattern)
  if (!p) return false
  if (p.endsWith(' *')) {
    const prefix = p.slice(0, -2)
    return c === prefix || c.startsWith(`${prefix} `)
  }
  return c === p
}

export function suggestPattern(command: string): string {
  const parts = normalize(command).split(' ')
  return `${parts.slice(0, Math.min(2, parts.length)).join(' ')} *`
}
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/permissions/commandPattern.ts tests/main/commandPattern.test.ts
git commit -m "feat(main): add shell command pattern matching

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13：PermissionGate（canUseTool ＋ PreToolUse hook）

**Files:**
- Create: `src/main/permissions/gate.ts`
- Test: `tests/main/gate.test.ts`

**Step 1: 寫失敗測試**

```ts
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HookJSONOutput,
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput
} from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, test, vi } from 'vitest'
import {
  BUILTIN_TOOLS,
  createPermissionGate,
  createPreToolUseHook,
  evaluateTool,
  type GateContext
} from '../../src/main/permissions/gate'
import type { GatePhase } from '../../src/main/tasks/stateMachine'

type McpServer = { name: string; source: string }
const OURS: McpServer = { name: 'harness', source: 'sdk' }

function setup(
  phase: GatePhase,
  decision = { allow: true },
  patterns: string[] = [],
  worktreePath = '/wt/t1'
) {
  const state = { phase }
  const ctx: GateContext = {
    getPhase: () => state.phase,
    worktreePath,
    getAllowedPatterns: () => patterns,
    requestApproval: vi.fn(async () => decision),
    onApproved: vi.fn()
  }
  const gate = createPermissionGate(ctx)
  const call = (
    tool: string,
    input: Record<string, unknown>,
    mcpServer?: McpServer,
    signal = new AbortController().signal
  ) => gate(tool, input, { signal, mcpServer } as never)
  const hook = createPreToolUseHook(ctx)
  const callHook = async (tool: string, toolInput: unknown, mcpServer?: McpServer) =>
    hookDecision(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: tool,
          tool_input: toolInput,
          tool_use_id: 'u1',
          session_id: 's1',
          transcript_path: '',
          cwd: worktreePath,
          mcp_server: mcpServer
        },
        'u1',
        { signal: new AbortController().signal }
      )
    )
  return { ctx, state, call, hook, callHook }
}

function hookDecision(out: HookJSONOutput) {
  const specific = (out as SyncHookJSONOutput).hookSpecificOutput as
    PreToolUseHookSpecificOutput | undefined
  return specific?.permissionDecision
}

describe('PermissionGate', () => {
  test('harness 工具與 TodoWrite 永遠允許', async () => {
    const { call } = setup('clarify')
    expect((await call('mcp__harness__ask_user', {}, OURS)).behavior).toBe('allow')
    expect((await call('TodoWrite', {})).behavior).toBe('allow')
  })

  test('ToolSearch 永遠允許：Claude Code 把 MCP 工具的 schema 延後載入，要先用它才能正確呼叫 harness 工具', async () => {
    const { call, callHook } = setup('clarify')
    const input = { query: 'select:mcp__harness__ask_user', max_results: 1 }
    expect((await call('ToolSearch', input)).behavior).toBe('allow')
    expect(await callHook('ToolSearch', input)).toBe('allow')
  })

  test('提供給 Claude 的內建工具：含 Glob／Grep（新版 Claude Code 預設不提供），且都有權限規則', () => {
    expect(BUILTIN_TOOLS).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'Edit', 'Bash']))
    const rules = {
      getPhase: () => 'implement' as const,
      worktreePath: '/wt/t1',
      getAllowedPatterns: () => []
    }
    for (const tool of BUILTIN_TOOLS)
      expect(evaluateTool(tool, {}, rules).message ?? '').not.toContain('不允許使用')
  })

  test('只信任 app 自己註冊（source: sdk）的 harness MCP 伺服器', async () => {
    const { call } = setup('implement')
    expect(
      (await call('mcp__harness__ask_user', {}, { name: 'harness', source: 'project' })).behavior
    ).toBe('deny')
    expect((await call('mcp__harness__ask_user', {})).behavior).toBe('deny')
    expect(
      (await call('mcp__harness__ask_user', {}, { name: 'other', source: 'sdk' })).behavior
    ).toBe('deny')
  })

  test('讀取：worktree 內允許、外部拒絕、無路徑允許', async () => {
    const { call } = setup('clarify')
    expect((await call('Read', { file_path: '/wt/t1/src/a.ts' })).behavior).toBe('allow')
    expect((await call('Read', { file_path: 'src/a.ts' })).behavior).toBe('allow')
    expect((await call('Read', { file_path: '/etc/passwd' })).behavior).toBe('deny')
    expect((await call('Read', { file_path: '/wt/t1-other/a.ts' })).behavior).toBe('deny')
    expect((await call('Grep', { pattern: 'x' })).behavior).toBe('allow')
  })

  test('~ 開頭的路徑一律拒絕', async () => {
    const { call } = setup('implement')
    expect((await call('Read', { file_path: '~/x' })).behavior).toBe('deny')
    expect((await call('Write', { file_path: '~/x' })).behavior).toBe('deny')
  })

  test('路徑參數不是字串、或寫入工具沒有路徑時拒絕', async () => {
    const { call } = setup('implement')
    expect((await call('Read', { file_path: 123 })).behavior).toBe('deny')
    expect((await call('Grep', { pattern: 'x', path: ['/etc'] })).behavior).toBe('deny')
    expect((await call('Read', { file_path: null })).behavior).toBe('deny')
    expect((await call('Write', { content: 'x' })).behavior).toBe('deny')
  })

  test('Glob 的絕對路徑或含 .. 的 pattern 必須落在 worktree 內', async () => {
    const { call } = setup('clarify')
    expect((await call('Glob', { pattern: 'src/**/*.ts' })).behavior).toBe('allow')
    expect((await call('Glob', { pattern: '/wt/t1/src/**' })).behavior).toBe('allow')
    expect((await call('Glob', { pattern: '/etc/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: '../**/*.ts' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/../../**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/../lib/*.ts' })).behavior).toBe('deny')
  })

  test('Glob 的大括號展開不能繞過檢查', async () => {
    const { call } = setup('clarify')
    expect((await call('Glob', { pattern: '{..,src}/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: '{/etc,src}/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/{a,~/x}/**' })).behavior).toBe('deny')
    expect((await call('Glob', { pattern: 'src/**/*.{ts,tsx}' })).behavior).toBe('allow')
  })

  test('symlink 指到 worktree 外時拒絕', async () => {
    const base = await mkdtemp(join(tmpdir(), 'harness-gate-'))
    const wt = join(base, 'wt')
    const outside = join(base, 'outside')
    await mkdir(wt)
    await mkdir(outside)
    await writeFile(join(outside, 'secret'), 's')
    await writeFile(join(wt, 'ok.ts'), '')
    await symlink(outside, join(wt, 'link'))
    await symlink(join(outside, 'not-yet'), join(wt, 'dangling'))
    const { call } = setup('implement', { allow: true }, [], wt)
    expect((await call('Read', { file_path: join(wt, 'ok.ts') })).behavior).toBe('allow')
    expect((await call('Write', { file_path: join(wt, 'new.ts') })).behavior).toBe('allow')
    expect((await call('Read', { file_path: join(wt, 'link/secret') })).behavior).toBe('deny')
    expect((await call('Write', { file_path: 'link/new.ts' })).behavior).toBe('deny')
    expect((await call('Write', { file_path: join(wt, 'dangling') })).behavior).toBe('deny')
  })

  test('路徑含 .. 一律拒絕（避免 link/.. 被字面上消掉而繞過 symlink）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'harness-gate-'))
    const wt = join(base, 'wt')
    const outside = join(base, 'outside', 'deep')
    await mkdir(wt)
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(wt, 'link'))
    const { call } = setup('implement', { allow: true }, [], wt)
    expect((await call('Write', { file_path: `${wt}/link/../pwn.sh` })).behavior).toBe('deny')
    expect((await call('Write', { file_path: 'link/../pwn.sh' })).behavior).toBe('deny')
    expect((await call('Read', { file_path: 'link/../secret' })).behavior).toBe('deny')
    expect((await call('Grep', { pattern: 'x', path: 'src/..' })).behavior).toBe('deny')
    expect((await call('Write', { file_path: join(wt, 'a..b.ts') })).behavior).toBe('allow')
  })

  test('釐清與分岔階段不能寫檔或執行指令', async () => {
    for (const phase of ['clarify', 'branch'] as const) {
      const { call, ctx } = setup(phase)
      expect((await call('Edit', { file_path: '/wt/t1/a.ts' })).behavior).toBe('deny')
      expect((await call('Bash', { command: 'ls' })).behavior).toBe('deny')
      expect(ctx.requestApproval).not.toHaveBeenCalled()
    }
  })

  test('實作階段 worktree 內寫檔自動允許', async () => {
    const { call } = setup('implement')
    expect((await call('Write', { file_path: '/wt/t1/new.ts' })).behavior).toBe('allow')
    expect((await call('Write', { file_path: '/wt/t1/.gitignore' })).behavior).toBe('allow')
    expect((await call('Edit', { file_path: '/other/a.ts' })).behavior).toBe('deny')
  })

  test('寫入 .git、.claude/、.mcp.json 需要使用者核准', async () => {
    for (const file_path of [
      '/wt/t1/.git',
      '/wt/t1/.git/hooks/pre-commit',
      '/wt/t1/.claude/settings.json',
      '/wt/t1/pkg/.mcp.json'
    ]) {
      const { call, ctx } = setup('implement')
      expect((await call('Write', { file_path })).behavior).toBe('allow')
      expect(ctx.requestApproval).toHaveBeenCalledTimes(1)
    }
    const { call } = setup('implement', { allow: false } as never)
    expect((await call('Edit', { file_path: '/wt/t1/.claude/settings.json' })).behavior).toBe(
      'deny'
    )
  })

  test('符合允許樣式的指令直接允許', async () => {
    const { call, ctx } = setup('implement', { allow: true }, ['npm test *'])
    expect((await call('Bash', { command: 'npm test -- auth' })).behavior).toBe('allow')
    expect(ctx.requestApproval).not.toHaveBeenCalled()
  })

  test('有串接的指令即使符合樣式也要核准', async () => {
    const { call, ctx } = setup('implement', { allow: true }, ['npm test *'])
    await call('Bash', { command: 'npm test && rm -rf /' })
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedPattern: undefined }),
      expect.anything()
    )
  })

  test('使用者核准後回呼 onApproved，並附上建議樣式', async () => {
    const { call, ctx } = setup('implement', {
      allow: true,
      rememberPattern: 'npm test *'
    } as never)
    const r = await call('Bash', { command: 'npm test -- auth' })
    expect(r.behavior).toBe('allow')
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedPattern: 'npm test *' }),
      expect.anything()
    )
    expect(ctx.onApproved).toHaveBeenCalledWith('npm test -- auth', 'npm test *')
  })

  test('核准請求帶上 SDK 的 toolUseID（UI 用來對應時間軸上的工具呼叫）', async () => {
    const { ctx } = setup('implement')
    const gate = createPermissionGate(ctx)
    await gate('Bash', { command: 'npm run build' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu1'
    } as never)
    expect(ctx.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', toolUseId: 'tu1' }),
      expect.anything()
    )
  })

  test('使用者拒絕時帶回說明', async () => {
    const { call } = setup('implement', { allow: false, message: '先不要跑' } as never)
    expect(await call('Bash', { command: 'npm run build' })).toEqual({
      behavior: 'deny',
      message: '先不要跑'
    })
  })

  test('等待核准期間任務狀態改變時拒絕', async () => {
    for (const next of ['clarify', 'closed'] as const) {
      const { call, ctx, state } = setup('implement')
      vi.mocked(ctx.requestApproval).mockImplementation(async () => {
        state.phase = next
        return { allow: true }
      })
      expect(await call('Bash', { command: 'npm run build' })).toEqual({
        behavior: 'deny',
        message: '任務狀態已改變'
      })
      expect(ctx.onApproved).not.toHaveBeenCalled()
    }
  })

  test('signal 已中止時直接拒絕，不詢問使用者', async () => {
    const { call, ctx } = setup('implement')
    const ac = new AbortController()
    ac.abort()
    expect((await call('Bash', { command: 'npm run build' }, undefined, ac.signal)).behavior).toBe(
      'deny'
    )
    expect(ctx.requestApproval).not.toHaveBeenCalled()
  })

  test('任務結束後一律拒絕；未知工具拒絕', async () => {
    expect((await setup('closed').call('Read', {})).behavior).toBe('deny')
    expect((await setup('implement').call('KillShell', {})).behavior).toBe('deny')
  })
})

describe('PreToolUse hook', () => {
  test('釐清階段 Edit 被 hook 拒絕', async () => {
    const { callHook } = setup('clarify')
    expect(await callHook('Edit', { file_path: '/wt/t1/a.ts' })).toBe('deny')
  })

  test('不在允許清單的 Bash 交給使用者核准（ask）', async () => {
    const { callHook, ctx } = setup('implement', { allow: true }, ['npm test *'])
    expect(await callHook('Bash', { command: 'npm run build' })).toBe('ask')
    expect(await callHook('Bash', { command: 'npm test -- auth' })).toBe('allow')
    expect(ctx.requestApproval).not.toHaveBeenCalled()
  })

  test('受保護路徑回傳 ask', async () => {
    const { callHook } = setup('implement')
    expect(await callHook('Write', { file_path: '/wt/t1/.claude/settings.json' })).toBe('ask')
  })

  test('harness MCP 工具：有來源資訊就判斷，沒有就交給 canUseTool', async () => {
    const { hook, callHook } = setup('clarify')
    expect(await callHook('mcp__harness__ask_user', {}, OURS)).toBe('allow')
    expect(
      await callHook('mcp__harness__ask_user', {}, { name: 'harness', source: 'project' })
    ).toBe('deny')
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__harness__ask_user',
          tool_input: {},
          tool_use_id: 'u1',
          session_id: 's1',
          transcript_path: '',
          cwd: '/wt/t1'
        },
        'u1',
        { signal: new AbortController().signal }
      )
    ).toEqual({})
  })

  test('tool_input 不是物件時拒絕', async () => {
    const { callHook } = setup('implement')
    expect(await callHook('Read', 'oops')).toBe('deny')
  })

  test('非 PreToolUse 事件不做決定', async () => {
    const { hook } = setup('implement')
    expect(
      await hook(
        {
          hook_event_name: 'Stop',
          session_id: 's1',
          transcript_path: '',
          cwd: '/wt/t1',
          stop_hook_active: false
        } as never,
        undefined,
        { signal: new AbortController().signal }
      )
    ).toEqual({})
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/permissions/gate.ts
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type {
  CanUseTool,
  HookCallback,
  McpServerProvenance,
  PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision } from '@shared/types'
import type { GatePhase } from '../tasks/stateMachine'
import { hasShellOperators, matchesPattern, suggestPattern } from './commandPattern'

export interface ApprovalRequest {
  toolName: string
  input: Record<string, unknown>
  suggestedPattern?: string
  /** SDK 的 toolUseID：UI 用來對應時間軸上的工具呼叫 */
  toolUseId?: string
}

export interface GateContext {
  getPhase(): GatePhase
  worktreePath: string
  getAllowedPatterns(): string[]
  requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<PermissionDecision>
  onApproved(command: string | undefined, rememberPattern?: string): void
}

/** evaluateTool 只需要規則相關的部分 */
export type GateRules = Pick<GateContext, 'getPhase' | 'worktreePath' | 'getAllowedPatterns'>

export interface Evaluation {
  decision: 'allow' | 'deny' | 'ask'
  message?: string
  /** Bash 的完整指令（核准後記錄用） */
  command?: string
  suggestedPattern?: string
}

export interface EvaluateOptions {
  mcpServer?: McpServerProvenance
}

/** 與 SDK 的 CanUseTool 相容，但永遠回傳結果（不回傳 null） */
export type PermissionGate = (...args: Parameters<CanUseTool>) => Promise<PermissionResult>

const READ = new Set(['Read', 'Glob', 'Grep', 'LS'])
const WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// ToolSearch 只回傳已提供工具的 schema（不執行任何東西）；Claude Code 會把 MCP 工具延後載入，
// 不允許它的話 Claude 拿不到 harness 工具的參數格式，只能猜
const ALWAYS = new Set(['TodoWrite', 'Task', 'Agent', 'ToolSearch'])
const NEEDS_APPROVAL = new Set(['WebFetch', 'WebSearch'])
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

/**
 * 明確提供給 Claude 的內建工具（query 的 `tools`）：只有上面有規則的這些。
 * 新版 Claude Code 預設不提供 Glob／Grep（改用 Bash 搜尋），但釐清階段不能用 Bash，
 * 不明確列出的話 Claude 只能猜檔名。CLI 不認得的名稱（舊工具）會被忽略。
 */
export const BUILTIN_TOOLS: string[] = [...READ, ...WRITE, 'Bash', ...NEEDS_APPROVAL, ...ALWAYS]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isOwnHarnessServer = (s: McpServerProvenance | undefined) =>
  s?.source === 'sdk' && s.name === 'harness'

/**
 * 對最近一個存在的上層做 realpath，再接回尚不存在的部分，藉此解開 symlink。
 * 路徑存在卻無法解析（例如懸空 symlink）時回傳 undefined（視為不安全）。
 */
function realpathNearest(abs: string): string | undefined {
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest)
    } catch {
      try {
        lstatSync(cur)
        return undefined
      } catch {
        /* 不存在，往上一層找 */
      }
    }
    const parent = dirname(cur)
    if (parent === cur) return undefined
    rest.unshift(basename(cur))
    cur = parent
  }
}

/** 路徑在 root 內時回傳相對於 root 的真實路徑（root 本身為 ''），否則 undefined */
function relativeInside(root: string, p: string): string | undefined {
  // resolve() 會在 realpath 之前字面上消掉 ..，使 link/../x 繞過 symlink 檢查，所以直接拒絕
  if (p.startsWith('~') || p.split('/').includes('..')) return undefined
  const r = realpathNearest(resolve(root))
  const abs = realpathNearest(resolve(root, p))
  if (!r || !abs) return undefined
  if (abs === r) return ''
  return abs.startsWith(r + sep) ? abs.slice(r.length + 1) : undefined
}

export function isInside(root: string, p: string | undefined): boolean {
  return p === undefined || relativeInside(root, p) !== undefined
}

/** 取出所有路徑參數；有任何一個不是字串就回傳 undefined（fail closed） */
function targetPaths(input: Record<string, unknown>): string[] | undefined {
  const out: string[] = []
  for (const key of PATH_KEYS) {
    const v = input[key]
    if (v === undefined) continue
    if (typeof v !== 'string') return undefined
    out.push(v)
  }
  return out
}

/**
 * Glob 的 pattern 不可含 ..，也不可在開頭或大括號選項（`{` `,` 之後）放 / 或 ~，
 * 否則 `{..,src}/**`、`{/etc,src}/**` 會繞過檢查。純絕對路徑（無大括號）須落在 worktree 內。
 */
function globEscapes(root: string, input: Record<string, unknown>): boolean {
  const pattern = input.pattern
  if (pattern === undefined) return false
  if (typeof pattern !== 'string') return true
  if (pattern.includes('..') || pattern.startsWith('~') || /[{,]\s*[/~]/.test(pattern)) return true
  if (!isAbsolute(pattern)) return false
  if (pattern.includes('{')) return true
  return !isInside(root, pattern)
}

/** .git、.claude/ 與 .mcp.json 會改變 git 或 Claude 的行為，修改前要人工核准 */
function isProtected(rel: string): boolean {
  const segs = rel.toLowerCase().split(sep)
  return segs.includes('.git') || segs.includes('.claude') || segs.at(-1) === '.mcp.json'
}

const allowE = (): Evaluation => ({ decision: 'allow' })
const denyE = (message: string): Evaluation => ({ decision: 'deny', message })

/** 純判斷：所有權限規則都在這裡，canUseTool 與 PreToolUse hook 共用 */
export function evaluateTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GateRules,
  options: EvaluateOptions = {}
): Evaluation {
  const phase = ctx.getPhase()
  const root = ctx.worktreePath
  if (phase === 'closed') return denyE('任務已結束')
  if (ALWAYS.has(toolName)) return allowE()
  if (toolName.startsWith('mcp__harness__')) {
    // 名稱可被專案設定冒用，只信任 app 在 process 內註冊的伺服器
    return isOwnHarnessServer(options.mcpServer)
      ? allowE()
      : denyE('不明來源的 harness MCP 伺服器，已拒絕')
  }

  if (READ.has(toolName)) {
    const paths = targetPaths(input)
    if (!paths) return denyE('路徑參數格式不正確')
    if (!paths.every((p) => isInside(root, p))) return denyE('只能讀取 worktree 內的檔案')
    if (toolName === 'Glob' && globEscapes(root, input)) return denyE('只能搜尋 worktree 內的檔案')
    return allowE()
  }

  if (WRITE.has(toolName)) {
    if (phase !== 'implement')
      return denyE('目前不是實作階段，不能修改檔案。請用 ask_user 提問或用 propose_spec 提出規格。')
    const paths = targetPaths(input)
    if (!paths) return denyE('路徑參數格式不正確')
    if (paths.length === 0 || paths.some((p) => !p)) return denyE('缺少要修改的檔案路徑')
    const rels = paths.map((p) => relativeInside(root, p))
    if (rels.some((r) => r === undefined)) return denyE('只能修改 worktree 內的檔案')
    if (rels.some((r) => isProtected(r!)))
      return { decision: 'ask', message: '修改 git、Claude 或 MCP 設定檔需要使用者核准' }
    return allowE()
  }

  if (toolName === 'Bash') {
    if (phase !== 'implement') return denyE('目前不是實作階段，不能執行指令。')
    if (typeof input.command !== 'string') return denyE('指令格式不正確')
    const command = input.command
    const chained = hasShellOperators(command)
    if (!chained && ctx.getAllowedPatterns().some((p) => matchesPattern(command, p)))
      return allowE()
    return {
      decision: 'ask',
      message: '需要使用者核准這個指令',
      command,
      suggestedPattern: chained ? undefined : suggestPattern(command)
    }
  }

  if (NEEDS_APPROVAL.has(toolName)) return { decision: 'ask', message: '需要使用者核准' }

  return denyE(`Harness 不允許使用 ${toolName}`)
}

/** 等待核准期間任務可能被停止或改變階段；核准後再確認一次 */
function phaseStillAllows(toolName: string, phase: GatePhase): boolean {
  if (phase === 'closed') return false
  if (WRITE.has(toolName) || toolName === 'Bash') return phase === 'implement'
  return true
}

const allow = (input: Record<string, unknown>): PermissionResult => ({
  behavior: 'allow',
  updatedInput: input
})
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })

/** canUseTool：套用規則，需要核准時詢問使用者 */
export function createPermissionGate(ctx: GateContext): PermissionGate {
  return async (toolName, input, { signal, mcpServer, toolUseID }) => {
    if (signal.aborted) return deny('已取消')
    const e = evaluateTool(toolName, input, ctx, { mcpServer })
    if (e.decision === 'allow') return allow(input)
    if (e.decision === 'deny') return deny(e.message ?? `Harness 不允許使用 ${toolName}`)

    const d = await ctx.requestApproval(
      { toolName, input, suggestedPattern: e.suggestedPattern, toolUseId: toolUseID },
      signal
    )
    if (!d.allow) return deny(d.message?.trim() || '使用者拒絕了這個操作')
    if (signal.aborted) return deny('已取消')
    if (!phaseStillAllows(toolName, ctx.getPhase())) return deny('任務狀態已改變')
    // 只有指令可以記住樣式
    ctx.onApproved(e.command, e.command ? d.rememberPattern : undefined)
    return allow(input)
  }
}

/**
 * PreToolUse hook：在 SDK 套用專案的 allow 規則之前執行，硬性規則（deny／ask）一定生效。
 * ask 會讓 SDK 轉交 canUseTool 走核准流程。
 */
export function createPreToolUseHook(ctx: GateRules): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    // 沒有來源資訊（舊版 CLI）時不做決定，交給拿得到 mcpServer 的 canUseTool
    if (input.tool_name.startsWith('mcp__harness__') && !input.mcp_server) return {}
    const e: Evaluation = isRecord(input.tool_input)
      ? evaluateTool(input.tool_name, input.tool_input, ctx, { mcpServer: input.mcp_server })
      : denyE('工具參數格式不正確')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: e.decision,
        permissionDecisionReason: e.message
      }
    }
  }
}
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/permissions/gate.ts tests/main/gate.test.ts
git commit -m "feat(main): add phase-aware permission gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14：GitService

**Files:**
- Create: `src/main/git/gitService.ts`
- Test: `tests/main/gitService.test.ts`（真的 git，暫存 repo）

**Step 1: 寫失敗測試**

```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { GitService, parseNumstat, runCommand } from '../../src/main/git/gitService'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
let repo: string
let wt: string
const git = new GitService()

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'harness-git-'))
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@t')
  sh(repo, 'config', 'user.name', 't')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-q', '-m', 'init')
  wt = join(await mkdtemp(join(tmpdir(), 'harness-wt-')), 'nested', 't1')
})

describe('GitService', () => {
  test('isRepo 與 branches', async () => {
    expect(await git.isRepo(repo)).toBe(true)
    expect(await git.isRepo(tmpdir())).toBe(false)
    expect(await git.branches(repo)).toEqual(['main'])
    expect(await git.currentBranch(repo)).toBe('main')
  })

  test('detached HEAD：branches 只列真正的分支，branchInfo 的 current 取第一個分支', async () => {
    sh(repo, 'branch', 'develop')
    sh(repo, 'tag', 'v1')
    sh(repo, 'checkout', '-q', '--detach')
    expect(await git.branches(repo)).toEqual(['develop', 'main'])
    expect(await git.currentBranch(repo)).toBe('HEAD')
    expect(await git.branchInfo(repo)).toEqual({
      branches: ['develop', 'main'],
      current: 'develop'
    })
    sh(repo, 'checkout', '-q', 'develop')
    expect(await git.branchInfo(repo)).toEqual({
      branches: ['develop', 'main'],
      current: 'develop'
    })
  })

  test('分支與 tag 同名時仍回傳正確的分支名稱', async () => {
    // 停在 main 時建立同名 tag；測試本身不再用 main 這個名字下 git 指令，避免 ambiguous 警告
    sh(repo, 'branch', 'alpha')
    sh(repo, 'tag', 'main')
    expect(await git.branches(repo)).toEqual(['alpha', 'main'])
    expect(await git.currentBranch(repo)).toBe('main')
    expect(await git.branchInfo(repo)).toEqual({ branches: ['alpha', 'main'], current: 'main' })
  })

  test('沒有任何 commit 的 repo：沒有分支，current 為空字串', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'harness-git-empty-'))
    try {
      sh(empty, 'init', '-q', '-b', 'main')
      expect(await git.branches(empty)).toEqual([])
      expect(await git.branchInfo(empty)).toEqual({ branches: [], current: '' })
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('建立 worktree、commit、diff 與統計', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    expect(await git.commitAll(wt, 'noop')).toBeNull()
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(wt, 'b.txt'), 'new\n')
    const working = await git.workingStats(wt, 'main')
    expect(working.files).toBe(2)
    const sha = await git.commitAll(wt, 'change')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.diff(wt, 'main')).toContain('+two')
    expect(await git.diffStats(wt, 'main')).toEqual({
      files: 2,
      additions: 2,
      deletions: 0,
      perFile: [
        { path: 'a.txt', additions: 1, deletions: 0 },
        { path: 'b.txt', additions: 1, deletions: 0 }
      ]
    })
  })

  test('改名視為刪除加新增，路徑不含 =>', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await rename(join(wt, 'a.txt'), join(wt, 'renamed.txt'))
    const expected = {
      files: 2,
      additions: 1,
      deletions: 1,
      perFile: [
        { path: 'a.txt', additions: 0, deletions: 1 },
        { path: 'renamed.txt', additions: 1, deletions: 0 }
      ]
    }
    expect(await git.workingStats(wt, 'main')).toEqual(expected)
    await git.commitAll(wt, 'rename')
    expect(await git.diffStats(wt, 'main')).toEqual(expected)
  })

  test('workingStats 不動到真正的 index', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(wt, 'b.txt'), 'new\n')
    const before = sh(wt, 'status', '--porcelain')
    expect((await git.workingStats(wt, 'main')).files).toBe(2)
    expect(sh(wt, 'status', '--porcelain')).toBe(before)
  })

  test('檔名含引號時路徑原樣保留', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'q"uote.txt'), 'q\n')
    expect((await git.workingStats(wt, 'main')).perFile).toEqual([
      { path: 'q"uote.txt', additions: 1, deletions: 0 }
    ])
    await git.commitAll(wt, 'quote')
    expect((await git.diffStats(wt, 'main')).perFile).toEqual([
      { path: 'q"uote.txt', additions: 1, deletions: 0 }
    ])
  })

  test('merge 衝突時中止合併並回報 CONFLICT', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'a.txt'), 'branch\n')
    await git.commitAll(wt, 'branch change')
    await writeFile(join(repo, 'a.txt'), 'main\n')
    sh(repo, 'commit', '-qam', 'main change')
    await expect(git.merge(repo, 'harness/t1', 'main')).rejects.toThrow('CONFLICT')
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(sh(repo, 'status', '--porcelain')).toBe('')
  })

  test('拒絕看起來像選項或不合法的分支名稱', async () => {
    for (const bad of ['-x', '--output=/tmp/x', 'a..b']) {
      await expect(git.createWorktree(repo, wt, bad, 'main')).rejects.toThrow('分支名稱')
      await expect(git.createWorktree(repo, wt, 'harness/t1', bad)).rejects.toThrow('分支名稱')
      await expect(git.merge(repo, bad, 'main')).rejects.toThrow('分支名稱')
      await expect(git.removeWorktree(repo, wt, bad)).rejects.toThrow('分支名稱')
      await expect(git.pushAndOpenPr(repo, bad, 'main', 't', 'b')).rejects.toThrow('分支名稱')
    }
    expect(existsSync(wt)).toBe(false)
    expect(await git.branches(repo)).toEqual(['main'])
  })

  test('merge 前檢查原 repo 狀態', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await writeFile(join(wt, 'c.txt'), 'c\n')
    await git.commitAll(wt, 'add c')
    await writeFile(join(repo, 'dirty.txt'), 'x')
    await expect(git.merge(repo, 'harness/t1', 'main')).rejects.toThrow('未提交的變更')
    sh(repo, 'clean', '-fq')
    await git.merge(repo, 'harness/t1', 'main')
    expect(sh(repo, 'log', '--oneline')).toContain('Merge harness/t1')
  })

  test('removeWorktree 刪除 worktree 與分支', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await git.removeWorktree(repo, wt, 'harness/t1')
    expect(await git.branches(repo)).toEqual(['main'])
    expect(existsSync(wt)).toBe(false)
  })

  test('removeWorktree：目錄與分支已不存在時視為成功', async () => {
    await git.createWorktree(repo, wt, 'harness/t1', 'main')
    await rm(wt, { recursive: true, force: true })
    sh(repo, 'worktree', 'prune')
    sh(repo, 'branch', '-D', 'harness/t1')
    await git.removeWorktree(repo, wt, 'harness/t1')
    expect(await git.branches(repo)).toEqual(['main'])
  })

  test('removeWorktree：移除失敗且目錄仍在時拋出原本的錯誤', async () => {
    await mkdir(wt, { recursive: true })
    sh(repo, 'branch', 'harness/t1')
    await expect(git.removeWorktree(repo, wt, 'harness/t1')).rejects.toThrow('worktree remove')
    expect(await git.branches(repo)).toContain('harness/t1')
  })
})

describe('runCommand', () => {
  test('錯誤訊息在 stderr 為空時改用 stdout', async () => {
    // 輸出 "out-put" 不出現在指令文字裡，確保訊息真的來自 stdout
    await expect(
      runCommand('sh', ['-c', 'printf "%s-%s" out put; exit 1'], tmpdir())
    ).rejects.toThrow('失敗：out-put')
  })

  test('支援 stdin 與額外環境變數，並關閉 git 的帳密提示', async () => {
    expect(await runCommand('cat', [], tmpdir(), { input: 'from-stdin' })).toBe('from-stdin')
    const out = await runCommand(
      'sh',
      ['-c', 'printf "%s %s" "$GIT_TERMINAL_PROMPT" "$FOO"'],
      tmpdir(),
      {
        env: { FOO: 'bar' }
      }
    )
    expect(out).toBe('0 bar')
  })

  test('沒有 input 時 stdin 是空的，不會卡住', async () => {
    expect(await runCommand('cat', [], tmpdir())).toBe('')
  })
})

describe('parseNumstat', () => {
  test('-z 輸出的路徑可含換行與 tab', () => {
    expect(parseNumstat('1\t0\ta\nb\tc.txt\0').perFile).toEqual([
      { path: 'a\nb\tc.txt', additions: 1, deletions: 0 }
    ])
  })

  test('二進位檔以 0 計', () => {
    expect(parseNumstat('3\t1\ta.ts\0-\t-\timg.png\0')).toEqual({
      files: 2,
      additions: 3,
      deletions: 1,
      perFile: [
        { path: 'a.ts', additions: 3, deletions: 1 },
        { path: 'img.png', additions: 0, deletions: 0 }
      ]
    })
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/git/gitService.ts
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DiffStats } from '@shared/types'

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string
  ) {
    super(`${command} 失敗：${stderr.trim()}`)
  }
}

export interface RunOptions {
  /** 額外的環境變數（與 process.env 合併） */
  env?: Record<string, string>
  /** 寫入 stdin 的內容；沒給時 stdin 為空 */
  input?: string
}

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  opts: RunOptions = {}
): Promise<string> {
  const command = `${cmd} ${args.join(' ')}`
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, {
      cwd,
      // GIT_TERMINAL_PROMPT=0：需要帳密時直接失敗，不要卡在看不到的提示
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr?.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* 程序提早結束時忽略 EPIPE，以 exit code 為準 */
      })
      child.stdin.end(opts.input)
    }
    child.on('error', (err) => fail(new CommandError(command, err.message)))
    child.on('close', (code, signal) => {
      if (code === 0) done(stdout)
      else
        fail(
          new CommandError(command, stderr.trim() || stdout.trim() || `結束代碼 ${code ?? signal}`)
        )
    })
  })
}

/** core.quotePath=false：非 ASCII 路徑原樣輸出，不用八進位跳脫 */
const git = (cwd: string, ...args: string[]) =>
  runCommand('git', ['-c', 'core.quotePath=false', ...args], cwd)

const gitEnv = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  runCommand('git', ['-c', 'core.quotePath=false', ...args], cwd, { env })

/** diff 輸出固定格式：不上色、不走外部 diff 工具、改名視為刪除＋新增 */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-renames']

/** 擋掉會被 git 當成選項的名稱（如 `--output=...`）與不合法的分支名稱 */
export async function assertRefName(cwd: string, name: string): Promise<void> {
  const invalid = () => new CommandError('git check-ref-format', `不合法的分支名稱：${name}`)
  if (!name || name.startsWith('-')) throw invalid()
  try {
    await git(cwd, 'check-ref-format', '--branch', name)
  } catch {
    throw invalid()
  }
}

/** 解析 `git diff --numstat -z --no-renames`：每筆是 `add\tdel\tpath\0`，路徑不跳脫 */
export function parseNumstat(out: string): DiffStats {
  const perFile = out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [a, d, ...rest] = record.split('\t')
      return {
        path: rest.join('\t'),
        additions: a === '-' ? 0 : Number(a),
        deletions: d === '-' ? 0 : Number(d)
      }
    })
  return {
    files: perFile.length,
    additions: perFile.reduce((s, f) => s + f.additions, 0),
    deletions: perFile.reduce((s, f) => s + f.deletions, 0),
    perFile
  }
}

export class GitService {
  async isRepo(dir: string): Promise<boolean> {
    try {
      return (await git(dir, 'rev-parse', '--is-inside-work-tree')).trim() === 'true'
    } catch {
      return false
    }
  }

  async repoRoot(dir: string) {
    return (await git(dir, 'rev-parse', '--show-toplevel')).trim()
  }

  /**
   * 本地分支名稱。用 for-each-ref 只列 refs/heads/：`git branch` 在 detached HEAD 時
   * 會多出「(HEAD detached at …)」這種不是分支的項目；lstrip=2 在分支和 tag 同名時也不會變成 heads/x。
   */
  async branches(repo: string) {
    return (await git(repo, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /**
   * 目前所在的分支；detached HEAD 時是 'HEAD'。
   * 用 symbolic-ref 而不是 `rev-parse --abbrev-ref`：後者在分支和 tag 同名時會回 heads/x。
   */
  async currentBranch(repo: string) {
    try {
      return (await git(repo, 'symbolic-ref', '--quiet', 'HEAD'))
        .trim()
        .replace(/^refs\/heads\//, '')
    } catch {
      return 'HEAD'
    }
  }

  /** 給「從哪個分支開始」用：current 一定是 branches 之一（detached HEAD 時取第一個分支，沒有分支時為空字串） */
  async branchInfo(repo: string): Promise<{ branches: string[]; current: string }> {
    const [branches, current] = await Promise.all([this.branches(repo), this.currentBranch(repo)])
    return { branches, current: branches.includes(current) ? current : (branches[0] ?? '') }
  }

  async createWorktree(repo: string, worktreePath: string, branch: string, base: string) {
    await assertRefName(repo, branch)
    await assertRefName(repo, base)
    await mkdir(dirname(worktreePath), { recursive: true })
    await git(repo, 'worktree', 'add', '-b', branch, '--end-of-options', worktreePath, base)
  }

  async commitAll(wt: string, message: string): Promise<string | null> {
    await git(wt, 'add', '-A')
    if (!(await git(wt, 'diff', '--cached', '--name-only')).trim()) return null
    // 刻意不加 --no-verify：repo 的 git hooks 照常執行
    await git(wt, 'commit', '-q', '-m', message)
    return (await git(wt, 'rev-parse', 'HEAD')).trim()
  }

  diff(wt: string, base: string) {
    return git(
      wt,
      'diff',
      ...DIFF_FLAGS,
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--end-of-options',
      `${base}...HEAD`
    )
  }

  async diffStats(wt: string, base: string) {
    return parseNumstat(
      await git(wt, 'diff', '--numstat', '-z', ...DIFF_FLAGS, '--end-of-options', `${base}...HEAD`)
    )
  }

  /**
   * 含未 commit 與未追蹤檔案，相對於 base 的統計（實作中的「變更檔案」面板用）。
   * `add -N` 在暫存的 index 複本上做，不改動 worktree 真正的 index。
   */
  async workingStats(wt: string, base: string) {
    const mergeBase = (await git(wt, 'merge-base', '--end-of-options', base, 'HEAD')).trim()
    const realIndex = resolve(wt, (await git(wt, 'rev-parse', '--git-path', 'index')).trim())
    const tmp = await mkdtemp(join(tmpdir(), 'harness-index-'))
    const env = { GIT_INDEX_FILE: join(tmp, 'index') }
    try {
      if (existsSync(realIndex)) await copyFile(realIndex, env.GIT_INDEX_FILE)
      await gitEnv(wt, env, 'add', '-A', '-N')
      return parseNumstat(
        await gitEnv(
          wt,
          env,
          'diff',
          '--numstat',
          '-z',
          ...DIFF_FLAGS,
          '--end-of-options',
          mergeBase
        )
      )
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  async merge(repo: string, branch: string, base: string) {
    await assertRefName(repo, branch)
    await assertRefName(repo, base)
    if ((await git(repo, 'status', '--porcelain')).trim()) {
      throw new CommandError('git status', '原 repo 有未提交的變更，請先處理後再合併')
    }
    const current = await this.currentBranch(repo)
    if (current !== base)
      throw new CommandError('git rev-parse', `原 repo 目前在 ${current}，請切回 ${base} 再合併`)
    try {
      // 刻意不加 --no-verify：repo 的 git hooks 照常執行
      await git(repo, 'merge', '--no-ff', '-m', `Merge ${branch}`, '--end-of-options', branch)
    } catch (e) {
      // 衝突時還原成合併前的狀態，錯誤訊息保留 git 的 CONFLICT 輸出
      await git(repo, 'merge', '--abort').catch(() => undefined)
      const detail = e instanceof CommandError ? e.stderr : String(e)
      throw new CommandError(
        `git merge ${branch}`,
        `${detail}\n已中止合併，原 repo 維持合併前的狀態`
      )
    }
  }

  async removeWorktree(repo: string, wt: string, branch: string) {
    await assertRefName(repo, branch)
    try {
      await git(repo, 'worktree', 'remove', '--force', '--end-of-options', wt)
    } catch (e) {
      // 目錄已被手動刪掉時 remove 會失敗，prune 掉紀錄即可；目錄還在就是真的失敗
      await git(repo, 'worktree', 'prune').catch(() => undefined)
      if (existsSync(wt)) throw e
    }
    try {
      await git(repo, 'branch', '-D', '--end-of-options', branch)
    } catch (e) {
      const exists = await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
        .then(() => true)
        .catch(() => false)
      if (exists) throw e
    }
  }

  async pushAndOpenPr(
    wt: string,
    branch: string,
    base: string,
    title: string,
    body: string
  ): Promise<string> {
    await assertRefName(wt, branch)
    await assertRefName(wt, base)
    await git(wt, 'push', '-u', '--end-of-options', 'origin', branch)
    const out = await runCommand(
      'gh',
      [
        'pr',
        'create',
        `--base=${base}`,
        `--head=${branch}`,
        `--title=${title}`,
        '--body-file',
        '-'
      ],
      wt,
      { input: body }
    )
    return out.trim().split('\n').pop() ?? ''
  }
}

export type GitLike = Pick<
  GitService,
  | 'isRepo'
  | 'repoRoot'
  | 'branches'
  | 'currentBranch'
  | 'branchInfo'
  | 'createWorktree'
  | 'commitAll'
  | 'diff'
  | 'diffStats'
  | 'workingStats'
  | 'merge'
  | 'removeWorktree'
  | 'pushAndOpenPr'
>
```

**Step 4: 確認通過** — `npx vitest run tests/main/gitService.test.ts` → 16 passed

**Step 5: Commit**

```bash
git add src/main/git tests/main/gitService.test.ts
git commit -m "feat(main): add git service for worktrees, diffs and merges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15：VerifyRunner

**Files:**
- Create: `src/main/verify/verifyRunner.ts`
- Test: `tests/main/verifyRunner.test.ts`

**Step 1: 寫失敗測試**

```ts
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runShell, runVerification } from '../../src/main/verify/verifyRunner'

describe('verifyRunner', () => {
  test('記錄 exit code 與輸出', async () => {
    const ok = await runShell(tmpdir(), 'echo hello')
    expect(ok.exitCode).toBe(0)
    expect(ok.outputTail).toContain('hello')
    const fail = await runShell(tmpdir(), 'echo boom 1>&2; exit 3')
    expect(fail.exitCode).toBe(3)
    expect(fail.outputTail).toContain('boom')
  })

  test('逾時會終止', async () => {
    const r = await runShell(tmpdir(), 'sleep 5', 200)
    expect(r.outputTail).toContain('逾時')
  })

  test('逾時會終止整個 process group，不等子程序結束', async () => {
    const started = Date.now()
    const r = await runShell(tmpdir(), 'sleep 5; echo done', 200)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.outputTail).toContain('逾時')
    expect(r.outputTail).not.toContain('done')
  })

  test('忽略 SIGTERM 的指令在寬限期後以 SIGKILL 終止', async () => {
    const started = Date.now()
    const r = await runShell(tmpdir(), "trap '' TERM; sleep 5; echo done", 200)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(r.outputTail).toContain('逾時')
    expect(r.outputTail).not.toContain('done')
  })

  test('逾時標記一定出現在輸出結尾，即使終止後還有大量輸出', async () => {
    // 收到 TERM 後再印 10000 字元，舊做法會把標記擠出 tail
    const r = await runShell(
      tmpdir(),
      `trap 'printf "%010000d" 0; exit 0' TERM; sleep 5 & wait`,
      300
    )
    expect(r.outputTail.endsWith('[Harness] 執行逾時，已終止')).toBe(true)
    expect(r.outputTail.length).toBeLessThanOrEqual(4000)
  })

  test('stdin 是空的，讀 stdin 的指令不會卡住', async () => {
    const started = Date.now()
    const r = await runShell(tmpdir(), 'cat', 3000)
    expect(r.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('多位元組字元跨 chunk 也不會亂碼', async () => {
    // 「中」= e4 b8 ad，拆成兩次寫入、中間停一下，確保落在不同 chunk
    const r = await runShell(tmpdir(), `printf '\\xe4'; sleep 0.2; printf '\\xb8\\xad'`)
    expect(r.outputTail).toBe('中')
  })

  test('中止會終止整個 process group，並標示已取消', async () => {
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 100)
    const r = await runShell(tmpdir(), 'sleep 5; echo done', 60_000, ac.signal)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(r.outputTail.endsWith('[Harness] 已取消')).toBe(true)
    expect(r.outputTail).not.toContain('done')
  })

  test('中止時忽略 SIGTERM 的指令很快以 SIGKILL 終止', async () => {
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 100)
    const r = await runShell(tmpdir(), "trap '' TERM; sleep 5; echo done", 60_000, ac.signal)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(r.outputTail).toContain('[Harness] 已取消')
  })

  test('已中止的 signal 不會啟動指令', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runShell(tmpdir(), 'echo should-not-run', 60_000, ac.signal)
    expect(r).toMatchObject({ exitCode: null, durationMs: 0 })
    expect(r.outputTail).toContain('[Harness] 已取消')
    expect(r.outputTail).not.toContain('should-not-run')
  })

  test('runVerification 中止後其餘指令不執行', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = await runVerification(tmpdir(), ['sleep 5', 'echo b'], () => true, ac.signal)
    expect(r[0].outputTail).toContain('[Harness] 已取消')
    expect(r[1]).toMatchObject({ command: 'echo b', exitCode: null, skipped: '已取消，未執行' })
  })

  test('未核准的指令不執行', async () => {
    const r = await runVerification(tmpdir(), ['echo a', 'echo b'], (c) => c === 'echo a')
    expect(r[0].exitCode).toBe(0)
    expect(r[1]).toMatchObject({ command: 'echo b', exitCode: null })
    expect(r[1].skipped).toBeTruthy()
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/verify/verifyRunner.ts
import { spawn } from 'node:child_process'
import type { VerificationResult } from '@shared/types'

/** 逾時送出 SIGTERM 後，等這麼久還沒結束就送 SIGKILL */
const KILL_GRACE_MS = 2000
/** 中止（關閉 app）時的寬限較短，才能在關閉的時間上限內結束 */
const ABORT_KILL_GRACE_MS = 500
const TAIL_CHARS = 4000
const TIMEOUT_MARKER = '\n[Harness] 執行逾時，已終止'
const ABORT_MARKER = '\n[Harness] 已取消'

/**
 * 在 cwd 以 login shell 執行指令，回傳 exit code 與輸出結尾。
 * signal 中止時終止整個 process group（先 TERM，寬限後 KILL），輸出結尾標示已取消。
 */
export function runShell(
  cwd: string,
  command: string,
  timeoutMs = 10 * 60_000,
  signal?: AbortSignal
): Promise<VerificationResult> {
  const started = Date.now()
  if (signal?.aborted)
    return Promise.resolve({
      command,
      exitCode: null,
      durationMs: 0,
      outputTail: ABORT_MARKER.trim()
    })
  return new Promise((resolve) => {
    // detached：子程序自成 process group，逾時才能連同孫程序一起終止
    // stdin 為空：讀 stdin 的指令立刻拿到 EOF，不會卡住
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let timedOut = false
    let aborted = false
    // utf8 decoder 會保留跨 chunk 的多位元組字元
    const onData = (s: string) => {
      out = (out + s).slice(-2 * TAIL_CHARS)
    }
    child.stdout.setEncoding('utf8').on('data', onData)
    child.stderr.setEncoding('utf8').on('data', onData)
    // 只殺 shell 的話，孫程序會繼續佔住 stdout，close 要等它自己結束才會觸發
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        child.kill(signal)
      }
    }
    let killTimer: NodeJS.Timeout | undefined
    const terminate = (graceMs: number) => {
      if (killTimer) return
      killGroup('SIGTERM')
      // 忽略 SIGTERM 的程序在寬限期後強制終止
      killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate(KILL_GRACE_MS)
    }, timeoutMs)
    const onAbort = () => {
      aborted = true
      terminate(ABORT_KILL_GRACE_MS)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    /** 逾時／取消標記在結算時才接上，確保一定留在 tail 裡 */
    const tail = () => {
      const marker = aborted ? ABORT_MARKER : timedOut ? TIMEOUT_MARKER : ''
      return out.slice(-(TAIL_CHARS - marker.length)) + marker
    }
    child.on('close', (code) => {
      cleanup()
      resolve({ command, exitCode: code, durationMs: Date.now() - started, outputTail: tail() })
    })
    child.on('error', (err) => {
      cleanup()
      resolve({
        command,
        exitCode: null,
        durationMs: Date.now() - started,
        outputTail: String(err)
      })
    })
  })
}

export async function runVerification(
  cwd: string,
  commands: string[],
  isAllowed: (command: string) => boolean,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = []
  for (const command of commands) {
    if (signal?.aborted) {
      results.push({
        command,
        exitCode: null,
        durationMs: 0,
        outputTail: '',
        skipped: '已取消，未執行'
      })
      continue
    }
    if (!isAllowed(command)) {
      results.push({
        command,
        exitCode: null,
        durationMs: 0,
        outputTail: '',
        skipped: '這個指令在實作期間沒有被核准過，Harness 未自動執行'
      })
      continue
    }
    results.push(await runShell(cwd, command, timeoutMs, signal))
  }
  return results
}
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/verify tests/main/verifyRunner.test.ts
git commit -m "feat(main): add verification command runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16：偵測 Claude Code 與登入狀態、修正 PATH

**Files:**
- Create: `src/main/claude/detect.ts`（含 `createClaudeStatusCache`：只採用最後開始的那次偵測）
- Test: `tests/main/detect.test.ts`

**Step 1: 寫失敗測試**

```ts
import { afterEach, describe, expect, test } from 'vitest'
import type { ClaudeStatus } from '@shared/types'
import {
  applyLoginShellPath,
  createClaudeStatusCache,
  detectClaude,
  execCapture,
  type Exec
} from '../../src/main/claude/detect'

function fakeExec(map: Record<string, string | Error>): Exec {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ')
    const hit = Object.entries(map).find(([k]) => key.endsWith(k))
    if (!hit) throw new Error(`unexpected ${key}`)
    if (hit[1] instanceof Error) throw hit[1]
    return hit[1]
  }
}

describe('detectClaude', () => {
  test('找到且已登入', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': '/u/.local/bin/claude\n',
        'claude --version': '2.1.292 (Claude Code)\n',
        'claude auth status': JSON.stringify({
          loggedIn: true,
          subscriptionType: 'max',
          email: 'a@b'
        })
      })
    )
    expect(s).toEqual({
      found: true,
      path: '/u/.local/bin/claude',
      version: '2.1.292 (Claude Code)',
      loggedIn: true,
      subscriptionType: 'max',
      email: 'a@b',
      error: undefined
    })
  })

  test('使用設定指定的路徑', async () => {
    const s = await detectClaude(
      fakeExec({
        '/opt/claude --version': '1',
        '/opt/claude auth status': '{"loggedIn":true}'
      }),
      '/opt/claude'
    )
    expect(s.path).toBe('/opt/claude')
  })

  test('找不到 claude', async () => {
    const s = await detectClaude(fakeExec({ 'command -v claude': new Error('no') }))
    expect(s.found).toBe(false)
    expect(s.error).toContain('找不到')
  })

  test('未登入', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': '/c',
        '/c --version': '1',
        '/c auth status': '{"loggedIn":false}'
      })
    )
    expect(s.loggedIn).toBe(false)
    expect(s.error).toContain('登入')
  })
})

describe('detectClaude 容錯', () => {
  test('command -v 的輸出取最後一個非空行', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': 'Welcome!\n/u/bin/claude\n\n',
        '/u/bin/claude --version': '1',
        '/u/bin/claude auth status': '{"loggedIn":true}'
      })
    )
    expect(s.path).toBe('/u/bin/claude')
    expect(s.loggedIn).toBe(true)
  })

  test('auth status 不是 JSON 時給出友善訊息', async () => {
    const s = await detectClaude(
      fakeExec({
        'command -v claude': '/c',
        '/c --version': '0.9 (Claude Code)',
        '/c auth status': 'error: unknown command auth'
      })
    )
    expect(s).toMatchObject({
      found: true,
      path: '/c',
      version: '0.9 (Claude Code)',
      loggedIn: false
    })
    expect(s.error).toContain('無法讀取登入狀態，請更新 Claude Code')
  })
})

describe('execCapture', () => {
  test('回傳 stdout；非 0 結束但有 stdout 時仍回傳', async () => {
    expect(await execCapture('sh', ['-c', 'echo hi'])).toBe('hi\n')
    expect(await execCapture('sh', ['-c', 'echo partial; exit 1'])).toBe('partial\n')
  })

  test('非 0 結束且沒有 stdout 時以 stderr 拒絕', async () => {
    await expect(execCapture('sh', ['-c', 'echo bad >&2; exit 1'])).rejects.toThrow('bad')
  })

  test('stdin 是空的，不會卡住', async () => {
    expect(await execCapture('cat', [], { timeoutMs: 3000 })).toBe('')
  })

  test('逾時會終止並拒絕，不等佔住輸出的孫程序', async () => {
    const started = Date.now()
    await expect(
      execCapture('sh', ['-c', 'sleep 5 & sleep 5'], { timeoutMs: 200 })
    ).rejects.toThrow('逾時')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('applyLoginShellPath', () => {
  const original = process.env.PATH
  afterEach(() => {
    process.env.PATH = original
  })

  test('只取標記之間的 PATH，忽略 shell 啟動訊息', async () => {
    await applyLoginShellPath(
      async () =>
        'Welcome to zsh!\nnvm: using v24\n__HARNESS_PATH__/a/bin:/b/bin__HARNESS_PATH__\nbye\n'
    )
    expect(process.env.PATH).toBe('/a/bin:/b/bin')
  })

  test('以 10 秒逾時執行 login shell', async () => {
    let seen: number | undefined
    await applyLoginShellPath(async (_cmd, _args, opts) => {
      seen = opts?.timeoutMs
      return '__HARNESS_PATH__/x__HARNESS_PATH__'
    })
    expect(seen).toBe(10_000)
  })

  test('沒有標記時保留原本的 PATH', async () => {
    process.env.PATH = '/keep'
    await applyLoginShellPath(async () => '/a/bin:/b/bin')
    expect(process.env.PATH).toBe('/keep')
  })

  test('執行失敗時保留原本的 PATH', async () => {
    process.env.PATH = '/keep'
    await applyLoginShellPath(async () => {
      throw new Error('boom')
    })
    expect(process.env.PATH).toBe('/keep')
  })
})

describe('createClaudeStatusCache', () => {
  const status = (path: string): ClaudeStatus => ({ found: true, loggedIn: true, path })
  const deferred = () => {
    let resolve!: (s: ClaudeStatus) => void
    const promise = new Promise<ClaudeStatus>((r) => (resolve = r))
    return { promise, resolve }
  }

  test('不重新偵測時回傳快取；重新偵測後更新快取', async () => {
    const cache = createClaudeStatusCache(async () => status('/new'), status('/old'))
    expect(await cache.status()).toEqual(status('/old'))
    expect(await cache.status(true)).toEqual(status('/new'))
    expect(cache.current().path).toBe('/new')
  })

  test('較早開始、較晚結束的偵測不會蓋掉較新的結果', async () => {
    const first = deferred()
    const second = deferred()
    const pending = [first, second]
    const cache = createClaudeStatusCache(() => pending.shift()!.promise, status('/initial'))
    const older = cache.status(true)
    const newer = cache.status(true)
    second.resolve(status('/second'))
    expect(await newer).toEqual(status('/second'))
    first.resolve(status('/first'))
    // 較舊的呼叫拿到的是目前的快取（較新的結果）
    expect(await older).toEqual(status('/second'))
    expect(cache.current().path).toBe('/second')
  })

  test('較早開始的呼叫會等到最新的偵測結束，不回傳過時的狀態', async () => {
    const [first, second, third] = [deferred(), deferred(), deferred()]
    const pending = [first, second, third]
    const cache = createClaudeStatusCache(() => pending.shift()!.promise, status('/initial'))
    const results: string[] = []
    const track = (p: Promise<ClaudeStatus>, name: string) =>
      p.then((s) => void results.push(`${name}:${s.path}`))
    const flush = () => new Promise((r) => setTimeout(r, 0))
    const a = track(cache.status(true), 'a')
    const b = track(cache.status(true), 'b')
    first.resolve(status('/first'))
    await flush()
    // a 的偵測結束了，但 b 的還沒：a 繼續等
    expect(results).toEqual([])
    // 等待期間又開始一次偵測：a、b 都要等到這一次
    const c = track(cache.status(true), 'c')
    second.resolve(status('/second'))
    await flush()
    expect(results).toEqual([])
    third.resolve(status('/third'))
    await Promise.all([a, b, c])
    expect(results.sort()).toEqual(['a:/third', 'b:/third', 'c:/third'])
    expect(cache.current().path).toBe('/third')
  })

  test('最新的偵測失敗時，它的呼叫收到錯誤，較早的呼叫回傳原本的快取', async () => {
    const first = deferred()
    let rejectSecond!: (e: Error) => void
    const second = new Promise<ClaudeStatus>((_, reject) => (rejectSecond = reject))
    const pending = [first.promise, second]
    const cache = createClaudeStatusCache(() => pending.shift()!, status('/initial'))
    const older = cache.status(true)
    const newer = cache.status(true)
    first.resolve(status('/first'))
    rejectSecond(new Error('boom'))
    await expect(newer).rejects.toThrow('boom')
    expect(await older).toEqual(status('/initial'))
  })

  test('偵測失敗時保留原本的快取', async () => {
    const cache = createClaudeStatusCache(async () => {
      throw new Error('boom')
    }, status('/old'))
    await expect(cache.status(true)).rejects.toThrow('boom')
    expect(cache.current().path).toBe('/old')
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/claude/detect.ts
import { spawn } from 'node:child_process'
import type { ClaudeStatus } from '@shared/types'

export interface ExecOptions {
  /** 逾時毫秒數，逾時會終止整個 process group 並拒絕 */
  timeoutMs?: number
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<string>

/**
 * 執行指令並回傳 stdout；非 0 結束時若有 stdout 也回傳（`claude auth status` 未登入時會這樣）。
 * stdin 為空，避免互動式 shell 或指令等待輸入而卡住啟動流程。
 */
export const execCapture: Exec = (cmd, args, { timeoutMs = 15_000 } = {}) =>
  new Promise((resolve, reject) => {
    // detached：自成 process group，逾時可連同孫程序一起終止
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s))
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      // 不等 close：孫程序可能還佔著輸出管線
      settle(() => reject(new Error(`${cmd} 執行逾時（${timeoutMs}ms）`)))
    }, timeoutMs)
    child.on('error', (err) => settle(() => reject(err)))
    child.on('close', (code, signal) =>
      settle(() => {
        if (code !== 0 && !stdout)
          reject(new Error(stderr.trim() || `${cmd} 結束代碼 ${code ?? signal}`))
        else resolve(stdout)
      })
    )
  })

const shell = () => process.env.SHELL || '/bin/zsh'

/**
 * 偵測 claude 的路徑、版本與登入狀態。
 * 啟動時必須先執行 applyLoginShellPath 再呼叫這裡：`-lc` 不讀 .zshrc，要靠繼承來的 PATH 才找得到 claude。
 */
export async function detectClaude(exec: Exec, explicitPath?: string): Promise<ClaudeStatus> {
  let path = explicitPath
  if (!path) {
    try {
      // 取最後一個非空行，忽略 shell 啟動時可能印出的訊息
      const out = await exec(shell(), ['-lc', 'command -v claude'])
      path =
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop() || undefined
    } catch {
      path = undefined
    }
  }
  if (!path)
    return { found: false, loggedIn: false, error: '找不到 claude 指令，請先安裝 Claude Code。' }
  let version: string
  let authOut: string
  try {
    version = (await exec(path, ['--version'])).trim()
    authOut = await exec(path, ['auth', 'status'])
  } catch (e) {
    return {
      found: true,
      path,
      loggedIn: false,
      error: `無法讀取 Claude Code 狀態：${(e as Error).message}`
    }
  }
  let auth: { loggedIn?: boolean; subscriptionType?: string; email?: string }
  try {
    auth = JSON.parse(authOut)
  } catch {
    // 舊版 claude 沒有 JSON 格式的 auth status
    return {
      found: true,
      path,
      version,
      loggedIn: false,
      error: '無法讀取登入狀態，請更新 Claude Code。'
    }
  }
  const loggedIn = !!auth.loggedIn
  return {
    found: true,
    path,
    version,
    loggedIn,
    subscriptionType: auth.subscriptionType,
    email: auth.email,
    error: loggedIn ? undefined : '尚未登入，請在終端機執行 claude 並完成登入。'
  }
}

/**
 * 快取的 Claude Code 狀態。`status(true)` 重新偵測；同時有多次偵測時只有最後開始的那次會更新快取
 * （較早開始、較晚結束的偵測不會蓋掉較新的結果）。較早開始的呼叫會等到最新的偵測結束再回傳，
 * 不會拿到過時的狀態；最新的偵測失敗時只有它的呼叫收到錯誤，其他呼叫回傳原本的快取。
 */
export function createClaudeStatusCache(
  detect: () => Promise<ClaudeStatus>,
  initial: ClaudeStatus
) {
  let cached = initial
  let generation = 0
  /** 最後開始的那次偵測（結束時已更新快取） */
  let latest: Promise<void> = Promise.resolve()
  return {
    current: () => cached,
    async status(refresh = false): Promise<ClaudeStatus> {
      if (!refresh) return cached
      const mine = ++generation
      const run = detect().then((next) => {
        if (mine === generation) cached = next
      })
      latest = run
      try {
        await run
      } catch (e) {
        if (mine === generation) throw e
      }
      // 等待期間有更新的偵測開始：等到最新的那次結束（期間可能又有更新的）
      let waited = run
      while (latest !== waited) {
        waited = latest
        await waited.catch(() => undefined)
      }
      return cached
    }
  }
}

const PATH_MARKER = '__HARNESS_PATH__'

/**
 * 從 Finder 啟動時 PATH 不含 homebrew / nvm，改用 login shell 的 PATH。
 * 互動式 shell 可能印出歡迎訊息等雜訊，所以 PATH 夾在標記之間輸出，沒有標記就不採用。
 * 必須在 detectClaude 之前執行。
 */
export async function applyLoginShellPath(exec: Exec = execCapture) {
  try {
    const out = await exec(shell(), ['-ilc', `printf "${PATH_MARKER}%s${PATH_MARKER}" "$PATH"`], {
      timeoutMs: 10_000
    })
    const p = new RegExp(`${PATH_MARKER}(.*?)${PATH_MARKER}`, 's').exec(out)?.[1].trim()
    if (p) process.env.PATH = p
  } catch {
    /* 保留原本的 PATH */
  }
}
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/claude tests/main/detect.test.ts
git commit -m "feat(main): detect Claude Code install and login status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Phase 3：Agent 層與任務協調

### Task 17：AsyncQueue

串流輸入模式需要一個可以持續 push 的 AsyncIterable。

**Files:**
- Create: `src/main/agent/asyncQueue.ts`
- Test: `tests/main/asyncQueue.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import { AsyncQueue } from '../../src/main/agent/asyncQueue'

describe('AsyncQueue', () => {
  test('先 push 後讀、先讀後 push 都可以，close 後結束', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    const it = q[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 1, done: false })
    const pending = it.next()
    q.push(2)
    expect(await pending).toEqual({ value: 2, done: false })
    const end = it.next()
    q.close()
    expect((await end).done).toBe(true)
    expect(q.isClosed).toBe(true)
  })

  test('close 會結束所有等待中的讀取', async () => {
    const q = new AsyncQueue<number>()
    const it = q[Symbol.asyncIterator]()
    const a = it.next()
    const b = it.next()
    q.close()
    expect((await a).done).toBe(true)
    expect((await b).done).toBe(true)
  })

  test('close 前 push 的項目仍會被讀完', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    const seen: number[] = []
    for await (const n of q) seen.push(n)
    expect(seen).toEqual([1, 2])
  })

  test('close 後 push 丟錯', () => {
    const q = new AsyncQueue<number>()
    q.close()
    expect(() => q.push(1)).toThrow()
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/agent/asyncQueue.ts
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  get isClosed() { return this.closed }

  push(item: T) {
    if (this.closed) throw new Error('queue 已關閉')
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/agent/asyncQueue.ts tests/main/asyncQueue.test.ts
git commit -m "feat(main): add async queue for streaming input

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18：Harness MCP 工具

**Files:**
- Create: `src/main/tools/harnessTools.ts`
- Test: `tests/main/harnessTools.test.ts`、`tests/main/harnessServer.test.ts`

**Step 1: 寫失敗測試**（直接測 handler，不經過 MCP）

```ts
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
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/tools/harnessTools.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  DecisionSourceSchema,
  type ReportInput,
  ReportInputSchema,
  ReportInputShape
} from '@shared/report'

const id = z.string().regex(/^[a-z0-9_-]+$/)

export const askUserShape = {
  question_id: id.describe('問題 ID（小寫英數），更新同一張卡片時沿用'),
  question: z.string().min(1).describe('一個具體的問題'),
  options: z
    .array(
      z.object({
        id: id.describe('小寫英數、_ 或 -'),
        label: z.string().min(1),
        description: z.string().optional()
      })
    )
    .max(6)
    .describe('互斥的選項，附簡短說明與取捨'),
  recommended_option_id: z.string().optional(),
  allow_free_text: z.boolean().default(true),
  context: z.string().optional().describe('為什麼要問、會影響什麼')
}
export const proposeSpecShape = {
  title: z.string().min(1),
  summary: z.string().min(1),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()).default([]),
  decisions: z.array(z.object({ id: z.string(), text: z.string(), source: DecisionSourceSchema })),
  steps: z.array(z.string()).min(1),
  acceptance: z.array(z.string()).min(1)
}
export const updatePlanShape = {
  steps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(['pending', 'running', 'done', 'blocked'])
      })
    )
    .min(1)
}
export const concludeBranchShape = {
  decision: z.string().min(1),
  rationale: z.string().min(1),
  deferred: z.array(z.string()).default([])
}

export type AskUserArgs = z.infer<z.ZodObject<typeof askUserShape>>
export type ProposeSpecArgs = z.infer<z.ZodObject<typeof proposeSpecShape>>
export type UpdatePlanArgs = z.infer<z.ZodObject<typeof updatePlanShape>>
export type ConcludeBranchArgs = z.infer<z.ZodObject<typeof concludeBranchShape>>

export interface ToolSink {
  askUser(a: AskUserArgs): Promise<void> | void
  proposeSpec(a: ProposeSpecArgs): Promise<void> | void
  updatePlan(a: UpdatePlanArgs): Promise<void> | void
  concludeBranch(a: ConcludeBranchArgs): Promise<void> | void
  submitReport(r: ReportInput): Promise<void> | void
}

export type HarnessToolName =
  'ask_user' | 'propose_spec' | 'update_plan' | 'conclude_branch' | 'submit_report'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] })
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true })

async function guard(fn: () => Promise<Result>): Promise<Result> {
  try {
    return await fn()
  } catch (e) {
    console.error('[harness tools] handler failed', e)
    return fail(`Harness 無法處理：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** schema 表達不了的跨欄位規則；回傳錯誤說明，沒有問題時回傳 undefined */
function askUserProblem(a: AskUserArgs): string | undefined {
  const ids = a.options.map((o) => o.id)
  const dup = ids.find((x, i) => ids.indexOf(x) !== i)
  if (dup) return `選項 id 重複：${dup}`
  if (a.recommended_option_id !== undefined && !ids.includes(a.recommended_option_id)) {
    return `recommended_option_id「${a.recommended_option_id}」不在選項中`
  }
  if (ids.length === 0 && a.allow_free_text === false) {
    return '沒有選項時必須允許自由作答（allow_free_text 不可為 false）'
  }
  return undefined
}

export function createToolHandlers(sink: ToolSink) {
  return {
    ask_user: (a: AskUserArgs) =>
      guard(async () => {
        const problem = askUserProblem(a)
        if (problem) return fail(`問題格式有誤，請修正後重新呼叫 ask_user：${problem}`)
        await sink.askUser(a)
        return ok(
          '問題已顯示給使用者。請立刻結束這一輪，不要再輸出其他內容，等待使用者以 [answer …] 或 [counter_question …] 回覆。'
        )
      }),
    propose_spec: (a: ProposeSpecArgs) =>
      guard(async () => {
        await sink.proposeSpec(a)
        return ok(
          '規格草稿已交給使用者審閱。請結束這一輪，等待 [spec_approved] 或 [spec_feedback …]。'
        )
      }),
    update_plan: (a: UpdatePlanArgs) =>
      guard(async () => {
        await sink.updatePlan(a)
        return ok('進度已更新。')
      }),
    conclude_branch: (a: ConcludeBranchArgs) =>
      guard(async () => {
        await sink.concludeBranch(a)
        return ok('結論已交給使用者確認。請結束這一輪。')
      }),
    submit_report: (raw: unknown) =>
      guard(async () => {
        const parsed = ReportInputSchema.safeParse(raw)
        if (!parsed.success)
          return fail(
            `報告格式有誤，請修正後重新呼叫 submit_report：\n${z.prettifyError(parsed.error)}`
          )
        await sink.submitReport(parsed.data)
        return ok('報告已提交，Harness 會整理 diff 並實際執行驗證指令。請結束這一輪。')
      })
  }
}

const DESCRIPTIONS: Record<HarnessToolName, string> = {
  ask_user:
    '向使用者提出一個需要釐清的問題，以問題卡片呈現。一次只問一題，呼叫後立刻結束這一輪。用相同 question_id 再呼叫可更新卡片。',
  propose_spec: '當你對需求有足夠把握時，提出規格草稿給使用者核准。呼叫後結束這一輪。',
  update_plan: '實作階段回報步驟清單與每一步的狀態。',
  conclude_branch: '在分岔討論中，使用者要求帶回主線時，整理結論。',
  submit_report: '實作完成並驗證後，提交結構化的變更報告。'
}

export function createHarnessServer(sink: ToolSink, names: HarnessToolName[]) {
  const h = createToolHandlers(sink)
  const all = {
    ask_user: tool('ask_user', DESCRIPTIONS.ask_user, askUserShape, h.ask_user),
    propose_spec: tool('propose_spec', DESCRIPTIONS.propose_spec, proposeSpecShape, h.propose_spec),
    update_plan: tool('update_plan', DESCRIPTIONS.update_plan, updatePlanShape, h.update_plan),
    conclude_branch: tool(
      'conclude_branch',
      DESCRIPTIONS.conclude_branch,
      concludeBranchShape,
      h.conclude_branch
    ),
    submit_report: tool(
      'submit_report',
      DESCRIPTIONS.submit_report,
      ReportInputShape,
      h.submit_report
    )
  }
  // alwaysLoad：Claude Code 預設把 MCP 工具藏在 tool search 後面，Claude 沒先載入 schema 就會猜錯參數
  return createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    alwaysLoad: true,
    tools: names.map((n) => all[n])
  })
}
```

若 `tool()` 對 handler 型別推論報錯（MCP `CallToolResult` 與 `Result` 不相容），把 `Result` 改為 `import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'`。

`alwaysLoad: true` 的測試（Task 35 端對端驗證時發現：Claude Code 預設把 MCP 工具藏在 tool search 後面，Claude 沒先載入 schema 就呼叫，參數會猜錯）：

```ts
import { describe, expect, test, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return { ...actual, createSdkMcpServer: vi.fn(actual.createSdkMcpServer) }
})

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { createHarnessServer, type ToolSink } from '../../src/main/tools/harnessTools'

const sink = {
  askUser: vi.fn(),
  proposeSpec: vi.fn(),
  updatePlan: vi.fn(),
  concludeBranch: vi.fn(),
  submitReport: vi.fn()
} satisfies ToolSink

describe('createHarnessServer', () => {
  test('harness 工具一律放進 prompt，不藏在 tool search 後面（否則 Claude 會猜參數格式）', () => {
    createHarnessServer(sink, ['ask_user', 'propose_spec'])
    const opts = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0]
    expect(opts.name).toBe('harness')
    expect(opts.alwaysLoad).toBe(true)
    expect(opts.tools?.map((t) => t.name)).toEqual(['ask_user', 'propose_spec'])
  })
})
```

**Step 4: 確認通過**、`npm run typecheck` PASS

**Step 5: Commit**

```bash
git add src/main/tools tests/main/harnessTools.test.ts tests/main/harnessServer.test.ts
git commit -m "feat(main): add harness MCP tools for questions, specs, plans and reports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19：系統提示（階段指示）

**Files:**
- Create: `src/main/agent/prompts.ts`
- Test: `tests/main/prompts.test.ts`

**Step 1: 寫失敗測試**

```ts
import { expect, test } from 'vitest'
import { MAIN_SYSTEM_APPEND } from '../../src/main/agent/prompts'

test('提示涵蓋所有工具與訊息格式', () => {
  for (const s of [
    'mcp__harness__ask_user',
    'mcp__harness__propose_spec',
    'mcp__harness__update_plan',
    'mcp__harness__submit_report',
    '[answer',
    '[counter_question',
    '[branch_conclusion',
    '[spec_approved]',
    '[spec_feedback',
    '[report_feedback',
    '[resume]',
    '[branch_open]',
    '[conclude]',
    'conclude_branch',
    'diff:檔案路徑:行號',
    'file:檔案路徑',
    '高度由內容決定，不要使用 vh 或 100% 高度',
    '繁體中文'
  ]) {
    expect(MAIN_SYSTEM_APPEND).toContain(s)
  }
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/agent/prompts.ts
export const MAIN_SYSTEM_APPEND = `
# Harness 工作模式

你在名為 Harness 的桌面 app 中工作，使用者透過 app 介面與你互動，看不到終端機。所有回覆、問題、規格與報告一律使用繁體中文（台灣用語）。
使用者訊息若以 [tag ...] 開頭，是 Harness 介面產生的結構化訊息，格式說明如下。

## 階段
任務依序經過：釐清 → 規格 → 實作 → 報告。在收到 [spec_approved] 之前都是釐清階段。

### 釐清階段（唯讀）
- 先閱讀相關程式碼理解現況，再提問。不能修改檔案或執行指令。
- 一次只問一個問題，且一定要用 mcp__harness__ask_user 提問，不要只用文字提問。呼叫後立刻結束這一輪。
- 選項要具體、互斥，附簡短說明與取捨；有建議就設定 recommended_option_id。
- 使用者回覆格式：
  - [answer question_id=… option=…] 補充 → 該題已回答（option 可能省略，表示自由作答）。
  - [counter_question question_id=…] 問題 → 先用文字簡短回答這個反問，再用同一個 question_id 再呼叫一次 ask_user（依反問更新選項、說明或建議），然後結束這一輪。
  - [branch_conclusion branch=…] → 使用者在分岔討論中做出的決策，直接採納；之後的規格中 source 用 {type:"branch", ref:分岔 id}。
- 對需求有足夠把握（約 95%）時，呼叫 mcp__harness__propose_spec。decisions 的 source 指出來源：question（ref=question_id）或 branch（ref=分岔 id）。
- 收到 [spec_feedback] 時修正並重新呼叫 propose_spec；若需要再問，繼續用 ask_user。

### 實作階段（收到 [spec_approved] 之後）
- 依核准的規格實作。先呼叫 mcp__harness__update_plan 列出步驟（id 用 s1、s2…），每開始或完成一步就更新。
- 可以自由修改 worktree 內的檔案。shell 指令需要使用者核准：只執行必要的指令，不要用 &&、;、| 串接，方便使用者核准。
- 遇到規格沒涵蓋、需要使用者決定的問題，用 ask_user 提問並結束這一輪。
- 使用者可能隨時插話，請依插話調整。
- 不要自己 git commit，Harness 會處理。
- 完成後執行專案既有的測試、型別檢查、lint（若有），然後呼叫 mcp__harness__submit_report。

### submit_report 的寫法
- architecture：before 與 after 各 3–10 個節點（模組、檔案群或外部服務），status 標 added / modified / unchanged，files 列相關路徑；edges 表示呼叫或資料流向。
- decisions：每個關鍵決策寫出選擇、捨棄的方案與原因；source 指回釐清的問題或分岔，實作中自己做的決定用 implementation。
- limitations：已知限制與風險；followups：刻意延後的事項。
- file_notes：每個變更檔案說明為什麼改；重要段落用 hunks 標出「新版檔案」的行號範圍與原因。
- verification：列出本次實作中實際執行過的驗證指令（Harness 會重新執行）。
- custom_blocks：只有在圖比文字清楚時才加（狀態機、資料流、時序等）。使用自含的 HTML 與 inline CSS，不可載入任何外部資源；寬度自適應、淺色背景；高度由內容決定，不要使用 vh 或 100% 高度。
- 收到 [report_feedback] 時，依回饋修改程式碼並重新呼叫 submit_report 產生新版本。
- [report_feedback] 的每一行格式為「- (錨點) 回饋內容」，錨點指出回饋針對的位置，例如 diff:檔案路徑:行號（新版檔案的行號）、file:檔案路徑（整個檔案）、decision:D1、section:architecture、block:id；最後可能有一行「整體：…」是整體回饋。

### 中斷
- 收到 [resume] 時，先檢查目前 worktree 的狀態，再從中斷的地方繼續。

### 分岔討論
- 若對話的第一則訊息是 [branch_open]，這段對話是分岔討論，改依該訊息中的規則（只用文字討論，不使用 ask_user 或 propose_spec；收到 [conclude] 時呼叫 mcp__harness__conclude_branch），優先於上方的階段指示。
`.trim()
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/agent/prompts.ts tests/main/prompts.test.ts
git commit -m "feat(main): add harness phase instructions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20：AgentRun（包裝 query()）

**Files:**
- Create: `src/main/agent/agentRun.ts`
- Test: `tests/main/agentRun.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test, vi } from 'vitest'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRun, mapMessage, type QueryFn, type RunnerEvent } from '../../src/main/agent/agentRun'

const m = (x: unknown) => x as SDKMessage
const success = (extra: Record<string, unknown> = {}) =>
  m({ type: 'result', subtype: 'success', is_error: false, ...extra })

/** 把 async generator 包成 QueryFn 的回傳值 */
const wrap = (
  gen: AsyncGenerator<SDKMessage>,
  interrupt: () => Promise<unknown> = async () => undefined
) => Object.assign(gen, { interrupt })

describe('mapMessage', () => {
  test('init → session', () => {
    expect(mapMessage(m({ type: 'system', subtype: 'init', session_id: 's1' }))).toEqual([
      { type: 'session', sessionId: 's1' }
    ])
  })
  test('assistant 的文字與 tool_use', () => {
    expect(
      mapMessage(
        m({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'text', text: '你好' },
              { type: 'text', text: '  ' },
              { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } }
            ]
          }
        })
      )
    ).toEqual([
      { type: 'assistant_text', text: '你好' },
      { type: 'tool_call', id: 'tu1', name: 'Read', input: { file_path: 'a' } }
    ])
  })
  test('子代理的訊息略過', () => {
    expect(
      mapMessage(
        m({
          type: 'assistant',
          parent_tool_use_id: 'x',
          message: { content: [{ type: 'text', text: 'hi' }] }
        })
      )
    ).toEqual([])
  })
  test('assistant 的 error 轉成 notice', () => {
    const auth = mapMessage(
      m({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'Invalid API key' }] }
      })
    )
    expect(auth).toEqual([
      { type: 'notice', message: 'Claude Code 驗證失敗，請重新登入' },
      { type: 'assistant_text', text: 'Invalid API key' }
    ])
    const [billing] = mapMessage(
      m({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'billing_error',
        message: { content: [] }
      })
    )
    expect(billing).toEqual({ type: 'notice', message: '訂閱或帳單有問題' })
    const [other] = mapMessage(
      m({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'server_error',
        message: { content: [] }
      })
    )
    expect(other.type).toBe('notice')
  })
  test('tool_result', () => {
    expect(
      mapMessage(
        m({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu1',
                is_error: true,
                content: [{ type: 'text', text: 'denied' }]
              }
            ]
          }
        })
      )
    ).toEqual([{ type: 'tool_result', id: 'tu1', isError: true, text: 'denied' }])
  })
  test('result', () => {
    expect(mapMessage(success())).toEqual([{ type: 'turn_end', ok: true }])
    expect(
      mapMessage(
        m({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] })
      )
    ).toEqual([{ type: 'turn_end', ok: false, error: 'boom' }])
  })
  test('result 錯誤訊息：errors → result 文字 → 依 subtype 的繁中說明', () => {
    expect(mapMessage(success({ is_error: true, result: 'API Error: 500' }))).toEqual([
      { type: 'turn_end', ok: false, error: 'API Error: 500' }
    ])
    expect(mapMessage(success({ is_error: true }))).toEqual([
      { type: 'turn_end', ok: false, error: 'Claude 執行失敗' }
    ])
    expect(
      mapMessage(m({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }))
    ).toEqual([{ type: 'turn_end', ok: false, error: '超過最大回合數' }])
    expect(
      mapMessage(m({ type: 'result', subtype: 'error_during_execution', is_error: true }))
    ).toEqual([{ type: 'turn_end', ok: false, error: '執行時發生錯誤' }])
    expect(
      mapMessage(m({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }))
    ).toEqual([{ type: 'turn_end', ok: false, error: '超過預算上限' }])
    expect(
      mapMessage(
        m({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true })
      )
    ).toEqual([{ type: 'turn_end', ok: false, error: '結構化輸出重試次數過多' }])
  })
  test('rate limit 只有非 allowed 才回報，秒與毫秒的 resetsAt 結果相同', () => {
    expect(
      mapMessage(m({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))
    ).toEqual([])
    const [sec] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1791400000, rateLimitType: 'five_hour' }
      })
    )
    const [ms] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1791400000000, rateLimitType: 'five_hour' }
      })
    )
    expect(sec.type).toBe('notice')
    expect(sec).toEqual(ms)
    expect(sec.type === 'notice' && sec.message).toContain('5 小時')
    expect(sec.type === 'notice' && sec.message).toContain('已達到')
    const [warn] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day' }
      })
    )
    expect(warn.type === 'notice' && warn.message).toContain('7 天')
    expect(warn.type === 'notice' && warn.message).toContain('即將')
    const [raw] = mapMessage(
      m({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus' }
      })
    )
    expect(raw.type === 'notice' && raw.message).toContain('seven_day_opus')
  })
})

describe('AgentRun', () => {
  test('送出第一則訊息、轉發事件，turn_end 後關閉輸入', async () => {
    const prompts: string[] = []
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          for await (const u of prompt) {
            prompts.push(String(u.message.content))
            yield m({ type: 'system', subtype: 'init', session_id: 's1' })
            yield success()
          }
        })()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'hello' }, (e) => events.push(e))
    await run.done
    expect(prompts).toEqual(['hello'])
    expect(events).toEqual([
      { type: 'session', sessionId: 's1' },
      { type: 'turn_end', ok: true, final: true }
    ])
    expect(run.active).toBe(false)
    expect(run.send('late')).toBe(false)
  })

  test('執行中可以插話', async () => {
    const prompts: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          const it = prompt[Symbol.asyncIterator]()
          prompts.push(String((await it.next()).value.message.content))
          await gate
          prompts.push(String((await it.next()).value.message.content))
          yield success()
        })()
      )
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, () => {})
    expect(run.send('b')).toBe(true)
    release()
    await run.done
    expect(prompts).toEqual(['a', 'b'])
  })

  test('每則訊息帶 uuid；插話未被第一個 result 涵蓋時保持輸入開啟，直到第二個 result', async () => {
    const seen: SDKUserMessage[] = []
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          const it = prompt[Symbol.asyncIterator]()
          const first = (await it.next()).value
          seen.push(first)
          yield success({ user_message_uuids: [first.uuid], queued_turn_count: 1 })
          const second = (await it.next()).value
          seen.push(second)
          yield success({ user_message_uuid: second.uuid })
        })()
      )
    const events: RunnerEvent[] = []
    let activeAfterFirst: boolean | undefined
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => {
      events.push(e)
      if (events.length === 1) activeAfterFirst = run.active
    })
    expect(run.send('b')).toBe(true)
    await run.done
    expect(seen.map((u) => u.message.content)).toEqual(['a', 'b'])
    expect(seen[0].uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen[0].uuid).not.toBe(seen[1].uuid)
    expect(events).toEqual([
      { type: 'turn_end', ok: true, final: false },
      { type: 'turn_end', ok: true, final: true }
    ])
    expect(activeAfterFirst).toBe(true)
    expect(run.active).toBe(false)
  })

  test('result 沒有 uuid 欄位時，queued_turn_count > 0 保持輸入開啟', async () => {
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          const it = prompt[Symbol.asyncIterator]()
          await it.next()
          yield success({ queued_turn_count: 1 })
          await it.next()
          yield success({ queued_turn_count: 0 })
        })()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    run.send('b')
    await run.done
    expect(events.map((e) => e.type === 'turn_end' && e.final)).toEqual([false, true])
  })

  test('options 會合併內部的 abortController', async () => {
    let got: Options | undefined
    const fake: QueryFn = ({ prompt, options }) =>
      wrap(
        (async function* () {
          got = options
          await prompt[Symbol.asyncIterator]().next()
          yield success()
        })()
      )
    const run = new AgentRun(fake, { options: { model: 'x' }, firstPrompt: 'a' }, () => {})
    await run.done
    expect(got?.model).toBe('x')
    expect(got?.abortController).toBeInstanceOf(AbortController)
  })

  test('interrupt 後的 turn_end 標記 interrupted 且不是錯誤', async () => {
    let interrupted!: () => void
    const stopped = new Promise<void>((r) => {
      interrupted = r
    })
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          await stopped
          yield m({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['aborted']
          })
        })(),
        async () => interrupted()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    await run.interrupt()
    expect(run.active).toBe(false)
    await run.done
    expect(events.at(-1)).toEqual({ type: 'turn_end', ok: true, interrupted: true, final: true })
  })

  test('interrupt 沒有回應時改用 abort', async () => {
    let signal: AbortSignal | undefined
    const fake: QueryFn = ({ prompt, options }) => {
      signal = options.abortController?.signal
      return wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          await new Promise<void>((_, reject) =>
            signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
        })(),
        () => new Promise(() => {})
      )
    }
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a', interruptTimeoutMs: 10 }, (e) =>
      events.push(e)
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))
    await run.interrupt()
    expect(signal?.aborted).toBe(true)
    await expect(run.done).resolves.toBeUndefined()
    expect(run.active).toBe(false)
  })

  test('abort() 直接中止', async () => {
    let signal: AbortSignal | undefined
    const fake: QueryFn = ({ prompt, options }) => {
      signal = options.abortController?.signal
      return wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          await new Promise<void>((_, reject) =>
            signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
        })()
      )
    }
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    run.abort()
    expect(signal?.aborted).toBe(true)
    await expect(run.done).resolves.toBeUndefined()
  })

  test('迭代器丟錯時 done 會 reject', async () => {
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          throw new Error('process exited')
        })()
      )
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, () => {})
    await expect(run.done).rejects.toThrow('process exited')
    expect(run.active).toBe(false)
  })

  test('onEvent 丟錯不會中斷執行', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          yield success()
        })()
      )
    const types: string[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => {
      types.push(e.type)
      if (e.type === 'session') throw new Error('callback bug')
    })
    await expect(run.done).resolves.toBeUndefined()
    expect(types).toEqual(['session', 'turn_end'])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  test('同一種 rate limit 狀態每次執行只回報一次', async () => {
    const rl = (status: string) =>
      m({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour' } })
    const fake: QueryFn = ({ prompt }) =>
      wrap(
        (async function* () {
          await prompt[Symbol.asyncIterator]().next()
          yield rl('allowed_warning')
          yield rl('allowed_warning')
          yield rl('rejected')
          yield rl('rejected')
          yield success()
        })()
      )
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, (e) => events.push(e))
    await run.done
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(2)
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/agent/agentRun.ts
import { randomUUID } from 'node:crypto'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> }

/**
 * turn_end：final 表示這個 result 之後輸入已關閉（這次執行即將結束）；
 * interrupted 表示是使用者停止造成的結束，呼叫端不應視為錯誤。
 */
export type TurnEnd = {
  type: 'turn_end'
  ok: boolean
  error?: string
  interrupted?: boolean
  final: boolean
}

export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; isError: boolean; text: string }
  | TurnEnd
  | { type: 'notice'; message: string }

/** mapMessage 只看單一訊息，turn_end 的 final / interrupted 由 AgentRun 補上 */
export type MappedEvent =
  Exclude<RunnerEvent, TurnEnd> | { type: 'turn_end'; ok: boolean; error?: string }

type Block = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}
type Loose = {
  type: string
  subtype?: string
  session_id?: string
  parent_tool_use_id?: string | null
  message?: { content?: string | Block[] }
  error?: string
  is_error?: boolean
  errors?: string[]
  result?: string
  user_message_uuid?: string
  user_message_uuids?: string[]
  queued_turn_count?: number
  rate_limit_info?: { status: string; resetsAt?: number; rateLimitType?: string }
}

const blockText = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((x: Block) => (x.type === 'text' ? (x.text ?? '') : '')).join('')
      : ''

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: '超過最大回合數',
  error_during_execution: '執行時發生錯誤',
  error_max_budget_usd: '超過預算上限',
  error_max_structured_output_retries: '結構化輸出重試次數過多',
  success: 'Claude 執行失敗'
}

const ASSISTANT_ERRORS: Record<string, string> = {
  authentication_failed: 'Claude Code 驗證失敗，請重新登入',
  oauth_org_not_allowed: '這個帳號的組織不允許使用 Claude Code',
  account_on_hold: 'Claude 帳號目前被暫停使用',
  verification_required: 'Claude 帳號需要先完成驗證',
  billing_error: '訂閱或帳單有問題',
  rate_limit: '已達到用量上限，請稍後再試',
  overloaded: 'Claude 目前負載過高，請稍後再試',
  model_not_found: '找不到指定的模型',
  max_output_tokens: '回應超過輸出長度上限'
}

const RATE_LIMIT_TYPES: Record<string, string> = { five_hour: '5 小時', seven_day: '7 天' }

function rateLimitNotice(info: NonNullable<Loose['rate_limit_info']>): string {
  const kind = info.rateLimitType
    ? `（${RATE_LIMIT_TYPES[info.rateLimitType] ?? info.rateLimitType}）`
    : ''
  // resetsAt 的單位沒有文件說明：小於 1e12 視為秒
  const ms = info.resetsAt
    ? info.resetsAt < 1e12
      ? info.resetsAt * 1000
      : info.resetsAt
    : undefined
  const when = ms ? `，約 ${new Date(ms).toLocaleString('zh-TW')} 重置` : ''
  return info.status === 'rejected'
    ? `已達到訂閱方案的用量上限${kind}${when}。`
    : `即將達到訂閱方案的用量上限${kind}${when}。`
}

export function mapMessage(raw: SDKMessage): MappedEvent[] {
  const m = raw as unknown as Loose
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' && m.session_id
        ? [{ type: 'session', sessionId: m.session_id }]
        : []
    case 'assistant': {
      if (m.parent_tool_use_id) return []
      const events: MappedEvent[] = m.error
        ? [
            {
              type: 'notice',
              message: ASSISTANT_ERRORS[m.error] ?? `Claude 回應時發生錯誤（${m.error}）`
            }
          ]
        : []
      const content = Array.isArray(m.message?.content) ? m.message.content : []
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim())
          events.push({ type: 'assistant_text', text: b.text })
        if (b.type === 'tool_use') {
          events.push({
            type: 'tool_call',
            id: b.id ?? '',
            name: b.name ?? '',
            input: (b.input ?? {}) as Record<string, unknown>
          })
        }
      }
      return events
    }
    case 'user': {
      if (m.parent_tool_use_id || !Array.isArray(m.message?.content)) return []
      return m.message.content.flatMap((b): MappedEvent[] =>
        b.type === 'tool_result'
          ? [
              {
                type: 'tool_result',
                id: b.tool_use_id ?? '',
                isError: !!b.is_error,
                text: blockText(b.content)
              }
            ]
          : []
      )
    }
    case 'result': {
      const ok = m.subtype === 'success' && !m.is_error
      if (ok) return [{ type: 'turn_end', ok }]
      const error =
        (m.errors ?? []).join('\n') ||
        (m.is_error && m.result) ||
        RESULT_ERRORS[m.subtype ?? ''] ||
        m.subtype ||
        'Claude 執行失敗'
      return [{ type: 'turn_end', ok, error }]
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info
      if (!info || info.status === 'allowed') return []
      return [{ type: 'notice', message: rateLimitNotice(info) }]
    }
    default:
      return []
  }
}

export function userMessage(text: string): SDKUserMessage & { uuid: string } {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid: randomUUID()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待超過 ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

export interface RunConfig {
  options: Options
  firstPrompt: string
  /** interrupt() 等待 SDK 回應的上限，逾時改用 abort（預設 5000ms） */
  interruptTimeoutMs?: number
}

/**
 * 一段對話：送出第一則訊息，可插話；每則送出的訊息都被 result 回應過之後關閉輸入，讓程序結束。
 */
export class AgentRun {
  private queue = new AsyncQueue<SDKUserMessage>()
  private readonly q: ReturnType<QueryFn>
  private readonly abortController = new AbortController()
  private readonly interruptTimeoutMs: number
  private readonly pending = new Set<string>()
  private readonly noticed = new Set<string>()
  private ended = false
  private stopping = false
  readonly done: Promise<void>

  constructor(queryFn: QueryFn, cfg: RunConfig, onEvent: (e: RunnerEvent) => void) {
    this.interruptTimeoutMs = cfg.interruptTimeoutMs ?? 5000
    const external = cfg.options.abortController
    if (external) {
      if (external.signal.aborted) this.abort()
      else external.signal.addEventListener('abort', () => this.abort(), { once: true })
    }
    const emit = (e: RunnerEvent) => {
      try {
        onEvent(e)
      } catch (err) {
        console.error('[AgentRun] onEvent 回呼失敗', err)
      }
    }
    this.enqueue(cfg.firstPrompt)
    // 用區域變數迭代：TS 會把建構子內的 async IIFE 視為立即執行，直接讀 this.q 會報 TS2565
    const q = queryFn({
      prompt: this.queue,
      options: { ...cfg.options, abortController: this.abortController }
    })
    this.q = q
    this.done = (async () => {
      try {
        for await (const raw of q) {
          for (const e of mapMessage(raw)) {
            if (e.type === 'notice' && !this.firstNotice(raw)) continue
            if (e.type !== 'turn_end') {
              emit(e)
              continue
            }
            const final = this.stopping || this.turnComplete(raw)
            if (final) this.closeInput()
            emit(
              this.stopping
                ? { type: 'turn_end', ok: true, interrupted: true, final }
                : { ...e, final }
            )
          }
        }
      } catch (err) {
        // 使用者停止（interrupt / abort）造成的結束不算錯誤
        if (!this.stopping) throw err
      } finally {
        this.ended = true
        this.closeInput()
      }
    })()
  }

  get active() {
    return !this.ended && !this.queue.isClosed
  }

  send(text: string): boolean {
    if (!this.active) return false
    this.enqueue(text)
    return true
  }

  /** 請 SDK 中斷目前這一輪；沒有在時限內回應就直接 abort */
  async interrupt() {
    this.stopping = true
    try {
      await withTimeout(this.q.interrupt(), this.interruptTimeoutMs)
    } catch {
      this.abortController.abort()
    } finally {
      this.closeInput()
    }
  }

  /** 立即中止底層程序 */
  abort() {
    this.stopping = true
    this.abortController.abort()
    this.closeInput()
  }

  private enqueue(text: string) {
    const msg = userMessage(text)
    this.pending.add(msg.uuid)
    this.queue.push(msg)
  }

  /** 這個 result 之後是否已沒有待回應的訊息 */
  private turnComplete(raw: SDKMessage): boolean {
    const m = raw as unknown as Loose
    const answered =
      m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : undefined)
    if (!answered) return !(m.queued_turn_count && m.queued_turn_count > 0)
    for (const id of answered) this.pending.delete(id)
    return this.pending.size === 0
  }

  /** rate limit 通知每種狀態每次執行只回報一次 */
  private firstNotice(raw: SDKMessage): boolean {
    const m = raw as unknown as Loose
    if (m.type !== 'rate_limit_event' || !m.rate_limit_info) return true
    const key = m.rate_limit_info.status
    if (this.noticed.has(key)) return false
    this.noticed.add(key)
    return true
  }

  private closeInput() {
    if (!this.queue.isClosed) this.queue.close()
  }
}
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/agent/agentRun.ts tests/main/agentRun.test.ts
git commit -m "feat(main): wrap agent sdk query as a single conversational turn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21：TaskManager（一）建立任務、對話輪、問題卡片與反問

**Files:**
- Create: `src/main/tasks/taskManager.ts`
- Create: `tests/main/fakeClaude.ts`
- Test: `tests/main/taskManager.test.ts`

**Step 1: 測試替身**

FakeClaude 接上真正的 `AgentRun`：它送出的 result 不帶 `user_message_uuid`，所以 AgentRun 在每個 result 之後就關閉輸入（插話的訊息不會被讀取，這是預期的）。
- `interrupt()` 讓 script 提早結束並照常送 result；`abortController` 被 abort 時丟出錯誤（模擬程序被終止）。
- `createToolServer` 記下每次的工具清單，測試可檢查分岔只拿到 `conclude_branch`。
- `failNextQuery` 讓下一次 `query()` 直接丟錯（模擬 CLI 無法啟動，用來測狀態還原）。
- `active`／`maxActive` 記錄同時在迭代的 query() 數，測試用來確認同一 channel 不會同時有兩段執行。
- `afterResult: 'hang' | 'hang_ignoring_abort'` 讓程序在 result 之後不結束（測「上一段執行卡住」）；`results` 是 AgentRun 已處理的 result 數（`yield` 之後才加），測試用它確認輸入已關閉。

```ts
// tests/main/fakeClaude.ts
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from '../../src/main/agent/agentRun'
import type { GitLike } from '../../src/main/git/gitService'
import type { HarnessToolName, ToolSink } from '../../src/main/tools/harnessTools'

export interface ScriptCtx {
  call: number
  prompt: string
  options: Options
  sink: ToolSink
}
export type Script = (ctx: ScriptCtx) => Promise<unknown[] | void>

export const assistantText = (text: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text }] }
})

/**
 * 假的 Claude：每次 query() 讀第一則訊息、送 init、執行 script（可呼叫 sink），最後送 result。
 * result 不帶 user_message_uuid，AgentRun 會在每個 result 之後關閉輸入（插話的訊息不會被讀取）。
 * interrupt() 或 abort 會讓 script 提早結束：interrupt 照常送 result，abort 則丟出錯誤。
 */
export class FakeClaude {
  calls: { prompt: string; options: Options; tools: HarnessToolName[] }[] = []
  script: Script = async () => []
  /** 下一次 query() 直接丟出錯誤（模擬 CLI 無法啟動） */
  failNextQuery?: Error
  /**
   * 送出 result 之後不結束：'hang' 會在 abort 時結束，'hang_ignoring_abort' 連 abort 都不理，
   * 兩者都可用 releaseHang() 放行
   */
  afterResult?: 'hang' | 'hang_ignoring_abort'
  /** 正在迭代中的 query() 數，與曾經同時進行的最大值（檢查同一 channel 不會同時有兩段執行） */
  active = 0
  maxActive = 0
  /** 已被 AgentRun 處理完的 result 數（yield 之後才加，代表消費端已讀過） */
  results = 0
  private hangRelease = new Set<() => void>()
  private lastSink?: ToolSink
  private lastTools: HarnessToolName[] = []

  createToolServer = (sink: ToolSink, tools: HarnessToolName[]) => {
    this.lastSink = sink
    this.lastTools = tools
    return { type: 'sdk', name: 'harness' } as never
  }

  releaseHang() {
    for (const r of this.hangRelease) r()
    this.hangRelease.clear()
  }

  queryFn: QueryFn = ({ prompt, options }) => {
    if (this.failNextQuery) {
      const e = this.failNextQuery
      this.failNextQuery = undefined
      throw e
    }
    const afterResult = this.afterResult
    const hang = new Promise<'released'>((r) => this.hangRelease.add(() => r('released')))
    const sink = this.lastSink!
    const tools = this.lastTools
    const call = this.calls.length
    const signal = options.abortController?.signal
    let interrupt!: () => void
    const interrupted = new Promise<'interrupted'>((r) => {
      interrupt = () => r('interrupted')
    })
    const aborted = new Promise<'aborted'>((r) => {
      if (signal?.aborted) r('aborted')
      signal?.addEventListener('abort', () => r('aborted'), { once: true })
    })
    const record = (c: FakeClaude['calls'][number]) => this.calls.push(c)
    const resultConsumed = () => this.results++
    const started = () => {
      this.active++
      this.maxActive = Math.max(this.maxActive, this.active)
    }
    const ended = () => this.active--
    const run = (ctx: ScriptCtx) => this.script(ctx)
    const gen = (async function* () {
      started()
      try {
        const it = prompt[Symbol.asyncIterator]()
        const first = await it.next()
        const text = String((first.value as SDKUserMessage).message.content)
        record({ prompt: text, options, tools })
        const sessionId = options.forkSession ? `fork-${call}` : (options.resume ?? `sess-${call}`)
        yield { type: 'system', subtype: 'init', session_id: sessionId } as unknown as SDKMessage
        const outcome = await Promise.race([
          run({ call, prompt: text, options, sink }),
          interrupted,
          aborted
        ])
        if (outcome === 'aborted') throw new Error('aborted')
        if (outcome !== 'interrupted') {
          for (const m of outcome ?? []) yield m as SDKMessage
          // 讓 script 裡用 setTimeout 延後的工具呼叫落在同一輪內
          await Promise.race([new Promise((r) => setTimeout(r, 40)), interrupted, aborted])
        }
        if (signal?.aborted) throw new Error('aborted')
        yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage
        resultConsumed()
        if (afterResult === 'hang') {
          if ((await Promise.race([hang, aborted])) === 'aborted') throw new Error('aborted')
        } else if (afterResult === 'hang_ignoring_abort') {
          await hang
        }
      } finally {
        ended()
      }
    })()
    return Object.assign(gen, {
      interrupt: async () => {
        interrupt()
      }
    })
  }
}

export function fakeGit(): GitLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    isRepo: async () => true,
    repoRoot: async (d) => d,
    branches: async () => ['main'],
    currentBranch: async () => 'main',
    branchInfo: async () => ({ branches: ['main'], current: 'main' }),
    createWorktree: async (_repo, wt, branch, base) => {
      calls.push(`worktree ${wt} ${branch} ${base}`)
    },
    commitAll: async () => 'abc123',
    diff: async () => 'diff --git a/a.ts b/a.ts\n',
    diffStats: async () => ({
      files: 1,
      additions: 2,
      deletions: 0,
      perFile: [{ path: 'a.ts', additions: 2, deletions: 0 }]
    }),
    workingStats: async () => ({ files: 0, additions: 0, deletions: 0, perFile: [] }),
    merge: async (_repo, branch, base) => {
      calls.push(`merge ${branch} ${base}`)
    },
    removeWorktree: async (_repo, wt, branch) => {
      calls.push(`remove ${wt} ${branch}`)
    },
    pushAndOpenPr: async (_wt, branch, base, title) => {
      calls.push(`pr ${branch} ${base} ${title}`)
      return 'https://github.com/me/shop-api/pull/1'
    }
  }
}

/** 輪詢到條件成立為止；條件成立就立刻返回，上限只防止無限等待（機器忙時也要夠寬） */
export async function until(cond: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
```

**Step 2: 寫失敗測試（本 Task 的部分）**

> 檔頭的 `PermissionResult`、`until`、`sampleReport` import 在 Task 23、24 才用到，本 Task 先不加（否則 lint 會報未使用）。`setup(over)` 可覆寫 deps（例如 `prevRunTimeoutMs`）。

```ts
// tests/main/taskManager.test.ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent } from '@shared/ipc'
import { BUILTIN_TOOLS } from '../../src/main/permissions/gate'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { TaskManager, type TaskManagerDeps } from '../../src/main/tasks/taskManager'
import { sampleReport } from '../fixtures/report'
import { assistantText, FakeClaude, fakeGit, until } from './fakeClaude'

async function setup(over: Partial<TaskManagerDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-tm-'))
  const repo = new Repository(new Store(root), '/home/me')
  await repo.saveRepos([{ id: 'r1', name: 'shop-api', path: '/repos/shop-api', addedAt: 'x' }])
  const claude = new FakeClaude()
  const git = fakeGit()
  const events: AppEvent[] = []
  const verify = vi.fn<TaskManagerDeps['verify']>(async (_cwd, commands) =>
    commands.map((command) => ({ command, exitCode: 0, durationMs: 1, outputTail: 'ok' }))
  )
  let n = 0
  const tm = new TaskManager({
    repo,
    git,
    queryFn: claude.queryFn,
    createToolServer: claude.createToolServer,
    getClaudePath: () => '/bin/claude',
    emit: (e) => events.push(e),
    verify,
    newId: () => `id${++n}`,
    now: () => '2026-10-07T10:00:00.000Z',
    ...over
  })
  await tm.init()
  const create = async () => {
    const t = await tm.createTask({
      repoId: 'r1',
      request: '加上登入失敗鎖定',
      baseBranch: 'main',
      model: 'claude-opus-5-5'
    })
    await tm.whenIdle(t.id)
    return t.id
  }
  return { tm, claude, git, events, verify, repo, create }
}

const askQ1 = {
  question_id: 'q1',
  question: '計數單位？',
  options: [
    { id: 'acct', label: '帳號' },
    { id: 'acct_ip', label: '帳號 + IP' }
  ],
  allow_free_text: true
}

describe('TaskManager：建立任務與釐清', () => {
  test('建立 worktree、送出需求、記下 session', async () => {
    const { tm, claude, git, events, create } = await setup()
    const id = await create()
    const t = tm.get(id)
    expect(git.calls[0]).toBe(
      `worktree /home/me/.harness/worktrees/shop-api/20261007-${id} harness/20261007-${id} main`
    )
    expect(claude.calls[0].prompt).toBe('加上登入失敗鎖定')
    expect(claude.calls[0].options).toMatchObject({
      cwd: t.worktreePath,
      model: 'claude-opus-5-5',
      settingSources: ['project'],
      pathToClaudeCodeExecutable: '/bin/claude'
    })
    expect(claude.calls[0].options.resume).toBeUndefined()
    // canUseTool 與 PreToolUse hook 都要接上（hook 擋住專案 allow 規則的繞過）
    expect(claude.calls[0].options.canUseTool).toBeTypeOf('function')
    expect(claude.calls[0].options.hooks?.PreToolUse?.[0].hooks).toHaveLength(1)
    // 不載入 claude.ai 帳號上的連接器（Harness 一律拒絕使用，只會增加噪音），其餘環境變數照傳
    // 只提供 PermissionGate 有規則的內建工具（新版 Claude Code 預設沒有 Glob／Grep，釐清時就找不到檔案）
    expect(claude.calls[0].options.tools).toEqual(BUILTIN_TOOLS)
    expect(claude.calls[0].options.env).toMatchObject({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      PATH: process.env.PATH
    })
    expect(claude.calls[0].tools).toEqual([
      'ask_user',
      'propose_spec',
      'update_plan',
      'submit_report'
    ])
    expect(t).toMatchObject({ status: 'clarifying', runState: 'idle', mainSessionId: 'sess-0' })
    expect(events.some((e) => e.type === 'task' && e.task.runState === 'running')).toBe(true)
  })

  test('ask_user 建立問題卡片；回答後以 resume 送出 [answer]', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    expect(tm.get(id).questions[0]).toMatchObject({
      id: 'q1',
      status: 'open',
      options: askQ1.options
    })
    expect((await tm.timeline(id)).map((e) => e.kind)).toEqual(['user_text', 'question'])

    await tm.answerQuestion(id, 'q1', { optionId: 'acct_ip' })
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0]).toMatchObject({
      status: 'answered',
      answer: { optionId: 'acct_ip' }
    })
    expect(claude.calls[1].prompt).toBe('[answer question_id=q1 option=acct_ip] 帳號 + IP')
    expect(claude.calls[1].options.resume).toBe('sess-0')
  })

  test('Claude 重新提問已回答的問題時，時間軸再出現一次問題卡片', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    claude.script = async ({ call, sink }) => {
      if (call === 1) await sink.askUser({ ...askQ1, question: '計數單位要再確認一次' })
    }
    await tm.answerQuestion(id, 'q1', { optionId: 'acct_ip' })
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0]).toMatchObject({ status: 'open', text: '計數單位要再確認一次' })
    const questions = (await tm.timeline(id)).filter((e) => e.kind === 'question')
    expect(questions.map((e) => e.ref)).toEqual(['q1', 'q1'])
  })

  test('反問：回答文字進入卡片，Claude 以同一 question_id 更新卡片', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    // 第二輪：先輸出文字，稍後（同一輪內）再以同一 question_id 更新卡片
    claude.script = async ({ call, sink }) => {
      if (call !== 1) return
      setTimeout(() => void sink.askUser({ ...askQ1, recommended_option_id: 'acct_ip' }), 20)
      return [assistantText('帳號 + IP 可以避免被惡意鎖帳號。')]
    }
    await tm.counterQuestion(id, 'q1', '只用帳號有什麼問題？')
    await tm.whenIdle(id)
    const q = tm.get(id).questions[0]
    expect(claude.calls[1].prompt).toBe('[counter_question question_id=q1] 只用帳號有什麼問題？')
    expect(q.followups).toEqual([
      { role: 'user', text: '只用帳號有什麼問題？' },
      { role: 'assistant', text: '帳號 + IP 可以避免被惡意鎖帳號。' }
    ])
    expect(q.recommendedOptionId).toBe('acct_ip')
    expect((await tm.timeline(id)).filter((e) => e.kind === 'assistant_text')).toHaveLength(0)
  })

  test('一般訊息寫入時間軸', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [assistantText('好的')]
    await tm.send(id, 'main', '補充：只針對 /login')
    await tm.whenIdle(id)
    expect((await tm.timeline(id)).slice(-2).map((e) => [e.kind, e.text])).toEqual([
      ['user_text', '補充：只針對 /login'],
      ['assistant_text', '好的']
    ])
  })

  test('同時送出兩則訊息不會開兩段執行', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    // 第一段執行卡住直到兩則都送出：第二則一定得插話進這段執行，不受機器快慢影響
    const release = deferred()
    claude.script = async () => {
      await release.promise
      return [assistantText('收到')]
    }
    claude.maxActive = 0
    await Promise.all([
      tm.send(id, 'main', '第一則', { silent: true }),
      tm.send(id, 'main', '第二則', { silent: true })
    ])
    release.resolve()
    await tm.whenIdle(id)
    // 第二則插話進第一段執行（FakeClaude 不讀插話），所以只多一次 query
    expect(claude.calls.map((c) => c.prompt).slice(1)).toEqual(['第一則'])
    expect(claude.maxActive).toBe(1)
    expect(tm.get(id).runState).toBe('idle')
  })

  test('執行失敗時記錄錯誤', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async () => {
      throw new Error('CLI crashed')
    }
    const id = await create()
    expect(tm.get(id)).toMatchObject({ runState: 'error', error: 'CLI crashed' })
  })
})
```

> 註：反問測試用 `setTimeout` 讓 askUser 晚於文字事件發生，模擬真實的「先文字、後工具」順序；FakeClaude 在送出 result 前會等 40ms，確保延遲的 askUser 落在同一輪內。
> 「同時送出兩則訊息」用 `silent` 送出（不先寫時間軸），才會真的在 `startTurn` 的 await 期間競爭；沒有 turn lock 時會開出兩段執行。第一段執行的 script 會卡住直到兩則都送出，否則機器忙時第一輪可能先跑完，第二則就會合理地開新的一輪（測試會誤判）。

**Step 3: 確認失敗** — `npx vitest run tests/main/taskManager.test.ts` → FAIL

**Step 4: 實作 TaskManager（本 Task 先實作下列成員，後續 Task 再補）**

重點（與真實模組對齊後的規則）：
- 同一個 channel 永遠只有一段執行：`send()` 在 per-channel 的 turn lock 內做「插話或開新一輪」的決定（`prev?.send(text)` 成功就插話；否則先等上一段執行結束再 `startTurn`），兩個同時的 `send()` 不會各開一段。
- 等上一段執行最多 `prevRunTimeoutMs`（預設 15 秒，可由 deps 覆寫）：逾時就 `abort()` 它並拒絕它的核准請求，再等最多 `min(2 秒, prevRunTimeoutMs)`；仍不結束就 `dropStuckRun`（從 `runs` 移除、記警告、重設執行狀態，`whenIdle` 不再等它）並拒絕這次送出（`上一輪尚未結束，請先停止`），下一則訊息會開新的一輪。
- `assertCanSend`：任務未結束、沒有在收尾（開 PR／合併／丟棄）、主線沒有在整理報告。`send()` 一開始、拿到 turn lock 之後（插話前）、`startTurn` 一開始、以及 `startTurn` 的 await 之後（建立 AgentRun 前）都檢查。
- 時間軸只在訊息被接受後才寫：插話成功後寫；開新一輪時在 `new AgentRun` 之後同步排入（保證排在這段執行的任何事件之前）。開新一輪失敗就什麼都不寫。
- 改變狀態後才送訊息的操作（`transitionAndSend`、回答、反問、分岔、確認結論）先檢查 `assertCanSend`，送不出去就還原。
- `onRunDone` 只有在該 run 仍是目前的 run 時才重設執行狀態，並拒絕這段執行還在等的核准請求（`執行已結束`）；`turn_end` 的 `interrupted`（使用者停止）不記錯誤。
- runner 事件與工具回呼都排進 per-task 的 `enqueue` 鏈依序處理；task.json 寫入（`update`）與時間軸寫入（`addTimeline`）各自有 per-task 的寫入鏈，磁碟順序＝推送順序。各個鏈（含 turn lock）在尾端結束且仍是最新時從 map 移除。
- `get()` 回傳複本；內部一律用 `task()`。
- 分岔與決策的 id 用 `nextId`：現有最大編號 + 1（不是長度 + 1），還原或刪除過也不會撞號。
- `submit_report` 寫入 `finalizing` 失敗時還原原本的 `runState`，不會卡在整理中。
- `canUseTool` 與 `options.hooks.PreToolUse` 用同一個 `gateCtx`。
- 不 import `electron`（要能在 vitest 的 node 專案測試）。

```ts
// src/main/tasks/taskManager.ts
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent, CreateTaskInput } from '@shared/ipc'
import { IMPLEMENT_START_REF, msg, msgDisplay } from '@shared/protocol'
import type { ReportInput } from '@shared/report'
import type {
  Branch,
  BranchConclusion,
  Channel,
  FeedbackItem,
  PermissionDecision,
  PermissionRequest,
  Report,
  Task,
  TaskStatus,
  TimelineEvent,
  VerificationResult
} from '@shared/types'
import { AgentRun, type QueryFn, type RunnerEvent } from '../agent/agentRun'
import { MAIN_SYSTEM_APPEND } from '../agent/prompts'
import type { GitLike } from '../git/gitService'
import { hasShellOperators, matchesPattern } from '../permissions/commandPattern'
import {
  type ApprovalRequest,
  BUILTIN_TOOLS,
  createPermissionGate,
  createPreToolUseHook,
  type GateContext
} from '../permissions/gate'
import type { Repository } from '../store/repository'
import type { HarnessToolName, ToolSink } from '../tools/harnessTools'
import { prBody } from './prBody'
import { phaseOf, type TaskEventType, transition } from './stateMachine'

type McpServer = NonNullable<Options['mcpServers']>[string]
type TimelineEntry = Omit<TimelineEvent, 'id' | 'ts'>

export interface TaskManagerDeps {
  repo: Repository
  git: GitLike
  queryFn: QueryFn
  createToolServer: (sink: ToolSink, tools: HarnessToolName[]) => McpServer
  getClaudePath: () => string | undefined
  emit: (e: AppEvent) => void
  verify: (
    cwd: string,
    commands: string[],
    isAllowed: (c: string) => boolean,
    /** 關閉 app 時中止進行中的驗證指令 */
    signal?: AbortSignal
  ) => Promise<VerificationResult[]>
  now?: () => string
  newId?: () => string
  /** 開新一輪前等上一段執行結束的上限，逾時就中止它（預設 15000ms） */
  prevRunTimeoutMs?: number
}

interface PermissionWaiter {
  taskId: string
  channel: Channel
  /** 提出請求的執行；執行結束時還在等的請求一律拒絕 */
  run?: AgentRun
  request: PermissionRequest
  resolve: (d: PermissionDecision) => void
}

const MAIN_TOOLS: HarnessToolName[] = ['ask_user', 'propose_spec', 'update_plan', 'submit_report']
/** 中止上一段執行後再等它結束的上限 */
const ABORT_GRACE_MS = 2000
const runKey = (taskId: string, channel: Channel) => `${taskId}|${channel}`
const branchIdOf = (channel: Channel) =>
  channel.startsWith('branch:') ? channel.slice('branch:'.length) : undefined
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** 取 `<prefix><數字>` 形式的 id 中最大的編號 + 1（刪除或還原過也不會撞號） */
function nextId(prefix: string, ids: string[]): string {
  const max = ids.reduce((m, id) => {
    const n = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN
    return Number.isInteger(n) && n > m ? n : m
  }, 0)
  return `${prefix}${max + 1}`
}
const logError = (what: string) => (e: unknown) => console.error(`[TaskManager] ${what}`, e)

/** p 在 ms 內結束（成功或失敗）回傳 true，逾時回傳 false */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms)
  })
  return Promise.race([
    p.then(
      () => true,
      () => true
    ),
    timeout
  ]).finally(() => clearTimeout(timer))
}

export class TaskManager {
  private tasks = new Map<string, Task>()
  /** 每個 channel（taskId|channel）最多一段執行 */
  private runs = new Map<string, AgentRun>()
  /** 串起每個任務的 runner 事件與工具回呼，依發生順序處理 */
  private chains = new Map<string, Promise<unknown>>()
  /** 每個任務的 task.json 寫入依序進行 */
  private saves = new Map<string, Promise<unknown>>()
  /** 每個任務的時間軸寫入依序進行（磁碟順序＝推送順序） */
  private timelineWrites = new Map<string, Promise<unknown>>()
  /** 每個 channel 的「決定插話或開新一輪」依序進行，避免同時開出兩段執行 */
  private turnLocks = new Map<string, Promise<unknown>>()
  /** 等待使用者核准的請求，依提出順序；UI 一次顯示最早的一個 */
  private permissionWaiters = new Map<string, PermissionWaiter>()
  /**
   * 使用者拒絕過的 tool_use id → 提出請求的執行：之後的工具結果在時間軸上標成「已拒絕」而不是失敗。
   * 那段執行結束時清掉（沒等到工具結果的也一併清掉）。
   */
  private deniedToolUses = new Map<string, AgentRun | undefined>()
  /** 主線正在回答反問的問題卡片：這段期間的文字回覆寫進卡片 */
  private pendingCounter = new Map<string, string>()
  /** 報告整理中（邏輯狀態）：進入 reviewing 的同一步就清除 */
  private finalizing = new Set<string>()
  /** 報告整理的 promise，整個流程（含之後的時間軸寫入）結束才移除；whenIdle 用 */
  private reportJobs = new Map<string, Promise<void>>()
  /** 每個報告整理流程的 AbortController；關閉 app 時用來中止驗證指令 */
  private reportAborts = new Map<string, AbortController>()
  /** 正在開 PR／合併／丟棄的任務 */
  private finishing = new Set<string>()
  /** 收尾操作的 promise；關閉 app 時等它們（有上限） */
  private finishJobs = new Map<string, Promise<unknown>>()
  private readonly now: () => string
  private readonly newId: () => string
  private readonly prevRunTimeoutMs: number
  /** 中止執行後再等它結束的上限 */
  private readonly abortGraceMs: number

  constructor(private d: TaskManagerDeps) {
    this.now = d.now ?? (() => new Date().toISOString())
    this.newId = d.newId ?? (() => randomUUID().slice(0, 8))
    this.prevRunTimeoutMs = d.prevRunTimeoutMs ?? 15_000
    this.abortGraceMs = Math.min(ABORT_GRACE_MS, this.prevRunTimeoutMs)
  }

  // ───────── 讀取 ─────────

  async init() {
    for (const t of await this.d.repo.listTasks()) {
      // 上次關閉 app 時還在執行的任務：程序已不在，標為中斷，使用者可「繼續」
      const busy =
        t.runState === 'running' ||
        t.runState === 'waiting_permission' ||
        t.runState === 'finalizing'
      if (busy || t.pendingPermission || t.branches.some((b) => b.running)) {
        if (busy) t.runState = 'interrupted'
        t.pendingPermission = undefined
        t.branches.forEach((b) => {
          b.running = false
        })
        await this.d.repo.saveTask(t)
      }
      this.tasks.set(t.id, t)
    }
  }

  list(): Task[] {
    return [...this.tasks.values()]
      .map((t) => structuredClone(t))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** 回傳複本；內部一律用 task() */
  get(taskId: string): Task {
    return structuredClone(this.task(taskId))
  }

  timeline(taskId: string) {
    return this.d.repo.readTimeline(taskId)
  }

  /** 等這個任務的所有執行、事件與報告整理結束（測試用，也用於關閉 app 前） */
  async whenIdle(taskId: string) {
    const ofTask = (m: Map<string, Promise<unknown>>) =>
      [...m.entries()].filter(([k]) => k.startsWith(`${taskId}|`)).map(([, p]) => p)
    for (let i = 0; i < 100; i++) {
      const runs = this.runsOf(taskId).map(([, r]) => r.done.catch(() => undefined))
      await Promise.all([...runs, this.reportJobs.get(taskId)])
      await Promise.all(ofTask(this.turnLocks))
      await this.chains.get(taskId)
      await this.saves.get(taskId)
      await this.timelineWrites.get(taskId)
      await new Promise((r) => setTimeout(r, 0))
      if (this.runsOf(taskId).length === 0 && !this.reportJobs.has(taskId)) return
    }
    throw new Error(`whenIdle: 任務 ${taskId} 一直沒有停下來`)
  }

  // ───────── 內部工具 ─────────

  private task(taskId: string): Task {
    const t = this.tasks.get(taskId)
    if (!t) throw new Error(`找不到任務 ${taskId}`)
    return t
  }

  /** 取得還沒結束（未完成、未丟棄）的任務 */
  private openTask(taskId: string): Task {
    const t = this.task(taskId)
    if (t.status === 'done' || t.status === 'discarded') throw new Error('任務已結束')
    return t
  }

  /** 對 channel 送出訊息前必須成立的條件；改變狀態的操作要在改狀態之前先檢查 */
  private assertCanSend(taskId: string, channel: Channel): Task {
    const t = this.openTask(taskId)
    if (this.finishing.has(taskId)) throw new Error('任務正在收尾，請稍候')
    if (channel === 'main' && this.finalizing.has(taskId))
      throw new Error('正在整理報告，請稍候再送出')
    return t
  }

  private runsOf(taskId: string) {
    return [...this.runs.entries()].filter(([k]) => k.startsWith(`${taskId}|`))
  }

  /** 把 fn 接在 map[key] 的尾端依序執行；尾端仍是自己時結束後移除，避免 map 無限成長 */
  private chainOn<T>(map: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>) {
    const prev = map.get(key) ?? Promise.resolve()
    const next = prev.then(fn)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    map.set(key, tail)
    void tail.then(() => {
      if (map.get(key) === tail) map.delete(key)
    })
    return next
  }

  private enqueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.chainOn(this.chains, taskId, fn)
  }

  /** 同步修改記憶體中的任務、推送事件，並依序寫入磁碟 */
  private async update(taskId: string, fn: (t: Task) => void): Promise<Task> {
    const t = this.task(taskId)
    fn(t)
    t.updatedAt = this.now()
    const snapshot = structuredClone(t)
    this.d.emit({ type: 'task', task: snapshot })
    await this.chainOn(this.saves, taskId, () => this.d.repo.saveTask(snapshot))
    return snapshot
  }

  /** 不等待寫入的 update（用在同步回呼裡），寫入失敗只記錄 */
  private persist(taskId: string, fn: (t: Task) => void) {
    this.update(taskId, fn).catch(logError('儲存任務失敗'))
  }

  private addTimeline(taskId: string, e: TimelineEntry): Promise<void> {
    const event: TimelineEvent = { id: this.newId(), ts: this.now(), ...e }
    return this.chainOn(this.timelineWrites, taskId, async () => {
      await this.d.repo.appendTimeline(taskId, event)
      this.d.emit({ type: 'timeline', taskId, event })
    })
  }

  /** 同步排入時間軸（排在之後的 runner 事件之前）；訊息已送出，寫入失敗只記錄 */
  private writeEntries(taskId: string, entries: TimelineEntry[]): Promise<void> {
    const writes = entries.map((e) => this.addTimeline(taskId, e))
    return Promise.all(writes).then(() => undefined, logError('寫入時間軸失敗'))
  }

  /** 改變任務狀態後送出訊息；送不出去就把狀態還原 */
  private async transitionAndSend(taskId: string, event: TaskEventType, send: () => Promise<void>) {
    this.assertCanSend(taskId, 'main')
    let prev: TaskStatus = 'clarifying'
    let next: TaskStatus = 'clarifying'
    await this.update(taskId, (t) => {
      next = transition(t.status, event)
      prev = t.status
      t.status = next
    })
    try {
      await send()
    } catch (e) {
      await this.update(taskId, (t) => {
        if (t.status === next) t.status = prev
      }).catch(logError('還原狀態失敗'))
      throw e
    }
  }

  // ───────── 建立任務與對話 ─────────

  async createTask(input: CreateTaskInput): Promise<Task> {
    const settings = await this.d.repo.getSettings()
    const repo = (await this.d.repo.listRepos()).find((r) => r.id === input.repoId)
    if (!repo) throw new Error('找不到 repo')
    const request = input.request.trim()
    if (!request) throw new Error('請描述需求')
    const id = this.newId()
    const slug = `${this.now().slice(0, 10).replace(/-/g, '')}-${id}`
    const branch = `${settings.branchPrefix}${slug}`
    const worktreePath = join(settings.worktreeRoot, repo.name, slug)
    await this.d.git.createWorktree(repo.path, worktreePath, branch, input.baseBranch)
    const now = this.now()
    const task: Task = {
      id,
      repoId: repo.id,
      title: request.split('\n')[0].slice(0, 40),
      request,
      baseBranch: input.baseBranch,
      branch,
      worktreePath,
      model: input.model,
      status: 'clarifying',
      runState: 'idle',
      questions: [],
      decisions: [],
      specs: [],
      plan: [],
      branches: [],
      allowedCommands: [],
      approvedCommands: [],
      reportVersions: [],
      createdAt: now,
      updatedAt: now
    }
    this.tasks.set(id, task)
    await this.update(id, () => undefined)
    await this.send(id, 'main', request)
    return this.get(id)
  }

  /**
   * 送出使用者訊息：該 channel 有進行中的執行就插話進去，否則以 resume 開新一輪。
   * silent 不寫入 user_text（例如回答卡片、反問，UI 另有呈現）；display 是時間軸上顯示的文字，
   * ref 是 user_text 的標記（例如 IMPLEMENT_START_REF）；entries 是訊息被接受後要一起寫入的時間軸項目。
   * 訊息沒送出時不寫入任何時間軸。
   */
  async send(
    taskId: string,
    channel: Channel,
    text: string,
    opts: { display?: string; ref?: string; silent?: boolean; entries?: TimelineEntry[] } = {}
  ) {
    this.assertCanSend(taskId, channel)
    const userText: TimelineEntry = {
      channel,
      kind: 'user_text',
      text: opts.display ?? text,
      ...(opts.ref ? { ref: opts.ref } : {})
    }
    const entries: TimelineEntry[] = [...(opts.silent ? [] : [userText]), ...(opts.entries ?? [])]
    const key = runKey(taskId, channel)
    await this.chainOn(this.turnLocks, key, async () => {
      // 排隊等 lock 的期間任務可能已開始收尾或整理報告
      this.assertCanSend(taskId, channel)
      const prev = this.runs.get(key)
      if (prev?.send(text)) {
        await this.writeEntries(taskId, entries)
        return
      }
      // 上一段執行已關閉輸入但程序還沒結束：等它結束，同一個 channel 永遠只有一個 run
      if (prev) await this.settlePrevious(taskId, channel, prev)
      await this.startTurn(taskId, channel, text, entries)
    })
  }

  /** 等上一段執行結束；逾時就中止它，仍不結束就把它丟掉並拒絕這次送出（下一次會開新的一輪） */
  private async settlePrevious(taskId: string, channel: Channel, prev: AgentRun) {
    if (await settlesWithin(prev.done, this.prevRunTimeoutMs)) return
    console.warn('[TaskManager] 上一段執行逾時未結束，中止它')
    prev.abort()
    this.denyWaitersOf(prev, '執行已結束')
    if (await settlesWithin(prev.done, this.abortGraceMs)) return
    this.dropStuckRun(taskId, channel, prev)
    throw new Error('上一輪尚未結束，請先停止')
  }

  /** abort 之後仍不結束的執行：不再追蹤它，避免整個 channel 永遠被卡住 */
  private dropStuckRun(taskId: string, channel: Channel, run: AgentRun) {
    const key = runKey(taskId, channel)
    if (this.runs.get(key) !== run) return
    console.warn(`[TaskManager] 執行 ${key} 在中止後仍未結束，不再等待它`)
    this.runs.delete(key)
    this.denyWaitersOf(run, '執行已結束')
    this.forgetDenied(run)
    const branchId = branchIdOf(channel)
    if (!branchId) this.pendingCounter.delete(taskId)
    this.persist(taskId, (t) => {
      if (branchId) {
        const b = t.branches.find((x) => x.id === branchId)
        if (b) b.running = false
      } else if (t.runState === 'running' || t.runState === 'waiting_permission') {
        t.runState = 'idle'
      }
      this.syncPermission(t)
    })
  }

  private async startTurn(
    taskId: string,
    channel: Channel,
    prompt: string,
    entries: TimelineEntry[]
  ) {
    // 等上一段執行結束的期間任務可能已被丟棄或開始收尾
    this.assertCanSend(taskId, channel)
    const settings = await this.d.repo.getSettings()
    // 上面的 await 期間狀態可能又變了：建立執行前最後確認一次
    const t = this.assertCanSend(taskId, channel)
    const branchId = branchIdOf(channel)
    const branch = branchId ? t.branches.find((b) => b.id === branchId) : undefined
    if (branchId && !branch) throw new Error(`找不到分岔 ${branchId}`)
    const resume = branch ? (branch.sessionId ?? t.mainSessionId) : t.mainSessionId
    if (branch && !resume) throw new Error('主線尚未建立 session，無法分岔')

    // canUseTool 只會在執行開始後被呼叫，那時 owner.run 已經設好
    const owner: { run?: AgentRun } = {}
    const gateCtx: GateContext = {
      getPhase: () => (branch ? 'branch' : phaseOf(this.task(taskId).status)),
      worktreePath: t.worktreePath,
      // 每次判斷都讀目前的設定：設定頁移除允許的指令後，進行中的這一輪也立即適用
      getAllowedPatterns: () => [
        ...this.d.repo.cachedSettings().alwaysAllowedCommands,
        ...this.task(taskId).allowedCommands
      ],
      requestApproval: (req, signal) =>
        this.requestApproval(taskId, channel, owner.run, req, signal),
      onApproved: (command, pattern) => {
        this.persist(taskId, (x) => {
          if (command && !x.approvedCommands.includes(command)) x.approvedCommands.push(command)
          if (pattern && !x.allowedCommands.includes(pattern)) x.allowedCommands.push(pattern)
        })
      }
    }

    const options: Options = {
      cwd: t.worktreePath,
      model: t.model,
      resume,
      forkSession: branch && !branch.sessionId ? true : undefined,
      settingSources: settings.loadProjectSettings ? ['project'] : [],
      tools: BUILTIN_TOOLS,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: MAIN_SYSTEM_APPEND },
      mcpServers: {
        harness: this.d.createToolServer(
          this.sinkFor(taskId, channel),
          branch ? ['conclude_branch'] : MAIN_TOOLS
        )
      },
      canUseTool: createPermissionGate(gateCtx),
      // 專案設定的 allow 規則會在 canUseTool 之前生效；硬性規則放在 PreToolUse hook 才不會被繞過
      hooks: { PreToolUse: [{ hooks: [createPreToolUseHook(gateCtx)] }] },
      pathToClaudeCodeExecutable: this.d.getClaudePath(),
      // claude.ai 帳號上的連接器（Gmail、Notion…）不載入：PermissionGate 一律拒絕，只會佔用 context，
      // Claude 還會在回覆裡提到它們
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }
    }

    const run = new AgentRun(this.d.queryFn, { options, firstPrompt: prompt }, (e) => {
      void this.enqueue(taskId, () => this.onRunnerEvent(taskId, channel, e))
    })
    owner.run = run
    this.runs.set(runKey(taskId, channel), run)
    // 訊息已被接受：同步排入時間軸，保證排在這段執行的任何事件之前
    const written = this.writeEntries(taskId, entries)
    run.done.then(
      () => this.onRunDone(taskId, channel, run),
      (err: unknown) => this.onRunDone(taskId, channel, run, err)
    )
    // 執行已經開始，寫入失敗不應讓呼叫端以為訊息沒送出
    await this.update(taskId, (x) => {
      if (branchId) {
        const b = x.branches.find((bb) => bb.id === branchId)
        if (b) {
          b.running = true
          b.error = undefined
        }
      } else {
        x.runState = 'running'
        x.error = undefined
      }
    }).catch(logError('儲存任務失敗'))
    await written
  }

  private onRunDone(taskId: string, channel: Channel, run: AgentRun, err?: unknown) {
    // 執行結束後不會再有人處理它的核准請求
    this.denyWaitersOf(run, '執行已結束')
    return this.enqueue(taskId, async () => {
      const key = runKey(taskId, channel)
      // send() 可能已在這段收尾排到之前開了下一段執行：那時不要動執行狀態，只記錄錯誤
      const current = this.runs.get(key) === run
      if (current) this.runs.delete(key)
      // 這段執行的工具結果都已處理完（排在這之前）：還記著的拒絕不會再用到
      this.forgetDenied(run)
      const branchId = branchIdOf(channel)
      if (current && !branchId) this.pendingCounter.delete(taskId)
      await this.update(taskId, (t) => {
        if (current) {
          if (branchId) {
            const b = t.branches.find((x) => x.id === branchId)
            if (b) b.running = false
          } else if (t.runState === 'running' || t.runState === 'waiting_permission') {
            t.runState = 'idle'
          }
        }
        if (err) {
          this.setRunError(t, channel, errorMessage(err))
          if (current && !branchId && t.runState !== 'finalizing') t.runState = 'error'
        }
        this.syncPermission(t)
      })
    }).catch(logError('收尾失敗'))
  }

  /** 執行錯誤記在所屬的 channel：分岔的錯誤顯示在分岔面板，不打斷主線 */
  private setRunError(t: Task, channel: Channel, message: string) {
    const branchId = branchIdOf(channel)
    if (!branchId) {
      t.error = message
      return
    }
    const b = t.branches.find((x) => x.id === branchId)
    if (b) b.error = message
  }

  private async onRunnerEvent(taskId: string, channel: Channel, e: RunnerEvent) {
    switch (e.type) {
      case 'session':
        await this.update(taskId, (t) => {
          const branchId = branchIdOf(channel)
          if (!branchId) t.mainSessionId = e.sessionId
          else {
            const b = t.branches.find((x) => x.id === branchId)
            if (b) b.sessionId = e.sessionId
          }
        })
        return
      case 'assistant_text': {
        const qid = channel === 'main' ? this.pendingCounter.get(taskId) : undefined
        if (qid) {
          await this.update(taskId, (t) => {
            const q = t.questions.find((x) => x.id === qid)
            if (!q) return
            const last = q.followups.at(-1)
            if (last?.role === 'assistant') last.text += `\n\n${e.text}`
            else q.followups.push({ role: 'assistant', text: e.text })
          })
          return
        }
        await this.addTimeline(taskId, { channel, kind: 'assistant_text', text: e.text })
        return
      }
      case 'tool_call':
        if (!e.name.startsWith('mcp__harness__')) {
          await this.addTimeline(taskId, {
            channel,
            kind: 'tool_call',
            tool: { id: e.id, name: e.name, input: e.input }
          })
        }
        return
      case 'tool_result': {
        const denied = this.deniedToolUses.delete(e.id)
        if (e.isError) {
          await this.addTimeline(taskId, {
            channel,
            kind: 'tool_result',
            text: e.text.slice(0, 2000),
            tool: { id: e.id, name: '', isError: true, ...(denied ? { denied: true } : {}) }
          })
        }
        return
      }
      case 'turn_end':
        // 使用者停止造成的結束（interrupted）不算錯誤
        if (!e.ok && !e.interrupted) {
          await this.update(taskId, (t) => {
            this.setRunError(t, channel, e.error || 'Claude 執行失敗')
          })
        }
        return
      case 'notice':
        await this.addTimeline(taskId, { channel, kind: 'system', text: e.message })
    }
  }

  // ───────── 工具回呼 ─────────

  private sinkFor(taskId: string, channel: Channel): ToolSink {
    return {
      askUser: (a) =>
        this.enqueue(taskId, async () => {
          if (this.pendingCounter.get(taskId) === a.question_id) this.pendingCounter.delete(taskId)
          // 新問題，或重新提問已回答過的問題：時間軸上依提問順序再放一張卡片
          let added = false
          await this.update(taskId, (t) => {
            const fields = {
              text: a.question,
              options: a.options,
              recommendedOptionId: a.recommended_option_id,
              allowFreeText: a.allow_free_text,
              context: a.context
            }
            const q = t.questions.find((x) => x.id === a.question_id)
            if (q) {
              added = q.status === 'answered'
              Object.assign(q, fields, { status: 'open' as const, answer: undefined })
            } else {
              added = true
              t.questions.push({
                id: a.question_id,
                ...fields,
                status: 'open',
                followups: [],
                askedAt: this.now()
              })
            }
          })
          if (added)
            await this.addTimeline(taskId, { channel, kind: 'question', ref: a.question_id })
        }),
      proposeSpec: (a) =>
        this.enqueue(taskId, async () => {
          let version = 0
          await this.update(taskId, (t) => {
            const next = transition(t.status, 'SPEC_PROPOSED')
            version = t.specs.length + 1
            t.specs.push({
              version,
              title: a.title,
              summary: a.summary,
              inScope: a.in_scope,
              outOfScope: a.out_of_scope,
              decisions: a.decisions,
              steps: a.steps,
              acceptance: a.acceptance,
              createdAt: this.now()
            })
            t.title = a.title
            t.status = next
          })
          await this.addTimeline(taskId, { channel: 'main', kind: 'spec', ref: String(version) })
        }),
      updatePlan: (a) =>
        this.enqueue(taskId, async () => {
          await this.update(taskId, (t) => {
            t.plan = a.steps
          })
        }),
      concludeBranch: (a) =>
        this.enqueue(taskId, async () => {
          const branchId = branchIdOf(channel)
          if (!branchId) throw new Error('conclude_branch 只能在分岔中使用')
          await this.update(taskId, (t) => {
            const b = t.branches.find((x) => x.id === branchId)
            if (!b) throw new Error(`找不到分岔 ${branchId}`)
            if (b.status === 'concluded') throw new Error('這個分岔已經帶回主線')
            b.conclusion = { decision: a.decision, rationale: a.rationale, deferred: a.deferred }
            b.status = 'concluding'
          })
        }),
      submitReport: (input) =>
        this.enqueue(taskId, async () => {
          if (this.task(taskId).status !== 'implementing')
            throw new Error('只有實作階段可以提交報告')
          if (this.finalizing.has(taskId)) throw new Error('報告已提交，正在整理中')
          const run = this.runs.get(runKey(taskId, 'main'))
          const before = this.task(taskId).runState
          this.finalizing.add(taskId)
          try {
            await this.update(taskId, (t) => {
              t.runState = 'finalizing'
            })
          } catch (e) {
            // 記憶體中已改成 finalizing：還原，不然主線會一直卡在整理中
            this.finalizing.delete(taskId)
            this.persist(taskId, (t) => {
              if (t.runState === 'finalizing') t.runState = before
            })
            throw e
          }
          const job: Promise<void> = this.finalizeReport(taskId, input, run).finally(() => {
            if (this.reportJobs.get(taskId) === job) this.reportJobs.delete(taskId)
          })
          this.reportJobs.set(taskId, job)
        })
    }
  }

  // ───────── 問題卡片 ─────────

  async answerQuestion(
    taskId: string,
    questionId: string,
    answer: { optionId?: string; text?: string }
  ) {
    const q = this.assertCanSend(taskId, 'main').questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`找不到問題 ${questionId}`)
    const label = answer.optionId
      ? q.options.find((o) => o.id === answer.optionId)?.label
      : undefined
    if (answer.optionId && !label) throw new Error(`找不到選項 ${answer.optionId}`)
    const text = answer.text?.trim() || undefined
    if (!label && !text) throw new Error('請選擇選項或輸入回答')
    const before = { status: q.status, answer: q.answer }
    const next = { optionId: answer.optionId, text }
    await this.update(taskId, () => {
      q.status = 'answered'
      q.answer = next
    })
    const body = [label, text].filter(Boolean).join('；')
    try {
      await this.send(taskId, 'main', msg.answer(questionId, answer.optionId, body), {
        silent: true
      })
    } catch (e) {
      await this.update(taskId, () => {
        if (q.answer === next) Object.assign(q, before)
      }).catch(logError('還原問題卡片失敗'))
      throw e
    }
  }

  async counterQuestion(taskId: string, questionId: string, text: string) {
    const body = text.trim()
    if (!body) throw new Error('請輸入反問內容')
    const q = this.assertCanSend(taskId, 'main').questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`找不到問題 ${questionId}`)
    const followup = { role: 'user' as const, text: body }
    await this.update(taskId, () => {
      q.followups.push(followup)
    })
    // 送出前就要設定：新一輪的文字回覆可能比 send() 返回更早到
    this.pendingCounter.set(taskId, questionId)
    try {
      await this.send(taskId, 'main', msg.counterQuestion(questionId, body), { silent: true })
    } catch (e) {
      if (this.pendingCounter.get(taskId) === questionId) this.pendingCounter.delete(taskId)
      await this.update(taskId, () => {
        q.followups = q.followups.filter((f) => f !== followup)
      }).catch(logError('還原問題卡片失敗'))
      throw e
    }
  }

  // ───────── 暫時的 stub（Task 23、24 取代） ─────────

  private requestApproval(
    taskId: string,
    channel: Channel,
    run: AgentRun | undefined,
    req: ApprovalRequest,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    void [taskId, channel, run, req, signal]
    return Promise.resolve({ allow: false, message: '尚未實作' })
  }
  private syncPermission(t: Task) {
    void t
  }
  private denyWaitersOf(run: AgentRun, message: string) {
    void [run, message]
  }
  private forgetDenied(run: AgentRun) {
    for (const [id, r] of this.deniedToolUses) if (r === run) this.deniedToolUses.delete(id)
  }
  private async finalizeReport(taskId: string, input: ReportInput, run?: AgentRun) {
    void [taskId, input, run]
  }

  // 以下成員在 Task 22–24 補上：openBranch、concludeBranch、confirmBranch、approveSpec、
  // requestSpecChanges、syncPermission、denyWaitersOf、requestApproval、resolvePermission、stop、resume、
  // finalizeReport、getReport、submitReportFeedback、exclusive、createPullRequest、merge、discard、changedFiles
}
```

本 Task 的檔頭 import 只保留用得到的（`IMPLEMENT_START_REF`、`msgDisplay` 在 Task 23 才加入；`FeedbackItem`、`Report`、`hasShellOperators`／`matchesPattern`、`prBody` 在 Task 24 才加入）。`finishing`、`finalizing`、`reportJobs`、`permissionWaiters`、`PermissionWaiter`、`persist`、`transitionAndSend` 在本 Task 就先建立（核准、報告與收尾的 Task 會用到）。

**Step 5: 確認通過**

Run: `npx vitest run tests/main/taskManager.test.ts` → 6 passed；`npm run typecheck`、`npm run lint` 0 errors

**Step 6: Commit**

```bash
git add src/main/tasks tests/main/fakeClaude.ts tests/main/taskManager.test.ts
git commit -m "feat(main): add task manager with turns, question cards and counter-questions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22：TaskManager（二）分岔

**Files:**
- Modify: `src/main/tasks/taskManager.ts`
- Test: `tests/main/taskManager.test.ts`（新增 describe）

**Step 1: 寫失敗測試**

```ts
describe('TaskManager：分岔', () => {
  test('從主線 fork、續接分岔、整理結論並帶回主線', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    await tm.counterQuestion(id, 'q1', '差在哪？')
    await tm.whenIdle(id)

    claude.script = async () => [assistantText('Redis 可以共享狀態')]
    const b = await tm.openBranch(id, {
      title: '計數存放位置',
      fromQuestionId: 'q1',
      seed: 'Redis 和 in-memory 差在哪？'
    })
    await tm.whenIdle(id)
    const forkCall = claude.calls.at(-1)!
    expect(forkCall.options).toMatchObject({ resume: 'sess-0', forkSession: true })
    expect(forkCall.tools).toEqual(['conclude_branch'])
    expect(forkCall.prompt).toContain('[branch_open]')
    expect(forkCall.prompt).toContain('來源問題：計數單位？')
    expect(forkCall.prompt).toContain('使用者：差在哪？')
    expect(tm.get(id).branches[0]).toMatchObject({
      id: b.id,
      sessionId: expect.stringMatching(/^fork-/),
      running: false
    })
    expect(tm.get(id).mainSessionId).toBe('sess-0')
    const tl = await tm.timeline(id)
    expect(tl.filter((e) => e.channel === `branch:${b.id}`).map((e) => e.kind)).toEqual([
      'user_text',
      'assistant_text'
    ])

    claude.script = async ({ sink }) => {
      await sink.concludeBranch({ decision: '用 Redis', rationale: '多台機器', deferred: [] })
    }
    await tm.concludeBranch(id, b.id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.options).toMatchObject({
      resume: tm.get(id).branches[0].sessionId
    })
    expect(claude.calls.at(-1)!.options.forkSession).toBeUndefined()
    expect(tm.get(id).branches[0]).toMatchObject({
      status: 'concluding',
      conclusion: { decision: '用 Redis' }
    })

    claude.script = async () => []
    await tm.confirmBranch(id, b.id)
    await tm.whenIdle(id)
    const t = tm.get(id)
    expect(t.branches[0].status).toBe('concluded')
    expect(t.decisions[0]).toMatchObject({
      id: 'd1',
      text: '用 Redis',
      source: { type: 'branch', ref: b.id }
    })
    expect(claude.calls.at(-1)!.prompt).toBe(
      `[branch_conclusion branch=${b.id}] 決策：用 Redis\n原因：多台機器`
    )
    expect(claude.calls.at(-1)!.options.resume).toBe('sess-0')
    expect((await tm.timeline(id)).at(-1)).toMatchObject({
      channel: 'main',
      kind: 'decision',
      ref: 'd1'
    })
    await expect(tm.confirmBranch(id, b.id)).rejects.toThrow('已經帶回主線')
  })

  test('主線還沒有 session 時不能分岔', async () => {
    const { tm, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x' }))
    await tm.init()
    await expect(tm.openBranch('x', { title: 't' })).rejects.toThrow('回覆至少一次')
  })

  test('主線不能呼叫 conclude_branch', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let error: unknown
    claude.script = async ({ sink }) => {
      try {
        await sink.concludeBranch({ decision: 'x', rationale: 'y', deferred: [] })
      } catch (e) {
        error = e
      }
    }
    await tm.send(id, 'main', '結束')
    await tm.whenIdle(id)
    expect(String(error)).toContain('只能在分岔中使用')
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作（加到 TaskManager）**

分岔執行的錯誤（丟出例外或 turn_end 失敗）由 Task 21 的 `setRunError` 記在 `branch.error`，不寫 `task.error`（主線的錯誤提示沒有對應的繼續動作，分岔面板才是顯示的地方）；該分岔開新一輪時清除。

sink 的 `concludeBranch` 已在 Task 21 的 `sinkFor` 中（只能在分岔中使用、已帶回主線的分岔不能再整理）。確認結論時，決策的時間軸項目以 `entries` 交給 `send()`，主線接受訊息後才寫入；送不出去就還原分岔與決策。新增：

```ts
  // ───────── 分岔 ─────────

  async openBranch(
    taskId: string,
    input: { title: string; fromQuestionId?: string; seed?: string }
  ): Promise<Branch> {
    const t = this.openTask(taskId)
    if (!t.mainSessionId) throw new Error('請等 Claude 在主線回覆至少一次後再分岔')
    const branchId = nextId(
      'b',
      t.branches.map((b) => b.id)
    )
    const channel: Channel = `branch:${branchId}`
    this.assertCanSend(taskId, channel)
    // 主線在執行中時 session 還在變動，fork 出來的內容不確定
    if (this.runs.get(runKey(taskId, 'main'))?.active)
      throw new Error('主線正在執行，請等它停下來再分岔')
    const q = input.fromQuestionId
      ? t.questions.find((x) => x.id === input.fromQuestionId)
      : undefined
    if (input.fromQuestionId && !q) throw new Error(`找不到問題 ${input.fromQuestionId}`)
    const seed = [
      input.seed?.trim(),
      q && `來源問題：${q.text}`,
      q?.followups.length
        ? `之前的反問：\n${q.followups.map((f) => `${f.role === 'user' ? '使用者' : 'Claude'}：${f.text}`).join('\n')}`
        : undefined
    ]
      .filter(Boolean)
      .join('\n')
    const branch: Branch = {
      id: branchId,
      title: input.title.trim() || '分岔討論',
      fromQuestionId: input.fromQuestionId,
      status: 'open',
      running: false,
      createdAt: this.now()
    }
    await this.update(taskId, (x) => {
      x.branches.push(branch)
    })
    try {
      await this.send(taskId, channel, msg.branchOpen(branch.title, seed), {
        display: input.seed?.trim() || `開始討論：${branch.title}`
      })
    } catch (e) {
      await this.update(taskId, (x) => {
        x.branches = x.branches.filter((b) => b !== branch || b.sessionId)
      }).catch(logError('還原分岔失敗'))
      throw e
    }
    return structuredClone(branch)
  }

  async concludeBranch(taskId: string, branchId: string) {
    const channel: Channel = `branch:${branchId}`
    const b = this.assertCanSend(taskId, channel).branches.find((x) => x.id === branchId)
    if (!b) throw new Error(`找不到分岔 ${branchId}`)
    if (b.status === 'concluded') throw new Error('這個分岔已經帶回主線')
    await this.send(taskId, channel, msg.conclude(), { silent: true })
  }

  /** 使用者確認（可編輯過的）結論：記成決策並送回主線 */
  async confirmBranch(taskId: string, branchId: string, edited?: BranchConclusion) {
    const t = this.assertCanSend(taskId, 'main')
    const b = t.branches.find((x) => x.id === branchId)
    if (!b) throw new Error(`找不到分岔 ${branchId}`)
    if (b.status === 'concluded') throw new Error('這個分岔已經帶回主線')
    const c = edited ?? b.conclusion
    if (!c) throw new Error('分岔還沒有結論')
    const before = { status: b.status, conclusion: b.conclusion }
    const decisionId = nextId(
      'd',
      t.decisions.map((d) => d.id)
    )
    await this.update(taskId, (x) => {
      b.conclusion = c
      b.status = 'concluded'
      x.decisions.push({
        id: decisionId,
        text: c.decision,
        rationale: c.rationale,
        deferred: c.deferred,
        source: { type: 'branch', ref: branchId }
      })
    })
    try {
      await this.send(taskId, 'main', msg.branchConclusion(branchId, c), {
        silent: true,
        entries: [{ channel: 'main', kind: 'decision', ref: decisionId }]
      })
    } catch (e) {
      await this.update(taskId, (x) => {
        Object.assign(b, before)
        x.decisions = x.decisions.filter((d) => d.id !== decisionId)
      }).catch(logError('還原分岔結論失敗'))
      throw e
    }
  }
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/tasks/taskManager.ts tests/main/taskManager.test.ts
git commit -m "feat(main): support side-branch discussions with conclusions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23：TaskManager（三）規格核准、實作、指令核准、停止與續接

**Files:**
- Modify: `src/main/tasks/taskManager.ts`
- Test: `tests/main/taskManager.test.ts`

**Step 1: 寫失敗測試**

檔頭加上 `import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'`、`until`（from `./fakeClaude`）與 `IMPLEMENT_START_REF`、`msgDisplay`、`startsImplementation`（from `@shared/protocol`）。SDK 的 `canUseTool` 回傳 `PermissionResult | null`，變數型別要容許 `null`。

```ts
const spec = {
  title: '帳號鎖定',
  summary: 's',
  in_scope: ['a'],
  out_of_scope: [],
  decisions: [],
  steps: ['實作'],
  acceptance: ['測試通過']
}
const signalOf = () => ({ signal: new AbortController().signal }) as never
/** canUseTool 的 options，帶 SDK 給的 toolUseID */
const toolOpts = (toolUseID: string) =>
  ({ signal: new AbortController().signal, toolUseID }) as never
/** 測試用：看 TaskManager 還記著幾個被拒絕的 tool_use id（應在執行結束時清掉） */
const deniedCount = (tm: TaskManager) =>
  (tm as unknown as { deniedToolUses: { size: number } }).deniedToolUses.size
const toolResult = (toolUseId: string, text: string) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: {
    content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: text }]
  }
})


describe('TaskManager：規格與實作', () => {
  test('propose_spec → spec_review；要求修改回到 clarifying；核准進入 implementing', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    expect(tm.get(id)).toMatchObject({ status: 'spec_review', title: '帳號鎖定' })
    expect(tm.get(id).specs[0].version).toBe(1)

    claude.script = async ({ sink }) => {
      await sink.proposeSpec({ ...spec, summary: 's2' })
    }
    await tm.requestSpecChanges(id, '上限改 10 次')
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toBe('[spec_feedback] 上限改 10 次')
    expect(tm.get(id)).toMatchObject({ status: 'spec_review' })
    expect(tm.get(id).specs).toHaveLength(2)

    claude.script = async ({ sink }) => {
      await sink.updatePlan({ steps: [{ id: 's1', title: '寫程式', status: 'running' }] })
    }
    await tm.approveSpec(id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toContain('[spec_approved]')
    expect(tm.get(id).status).toBe('implementing')
    // 實作畫面靠這則訊息的標記找出實作從哪裡開始；要求修改不是起點
    const userTexts = (await tm.timeline(id)).filter((e) => e.kind === 'user_text')
    const feedbackEntry = userTexts.find((e) => e.text === msgDisplay.specFeedback('上限改 10 次'))!
    expect(startsImplementation(feedbackEntry)).toBe(false)
    expect(userTexts.at(-1)).toMatchObject({
      text: msgDisplay.specApproved,
      ref: IMPLEMENT_START_REF
    })
    expect(tm.get(id).plan).toEqual([{ id: 's1', title: '寫程式', status: 'running' }])
    await expect(tm.approveSpec(id)).rejects.toThrow()
  })

  test('shell 指令等待核准，核准並記住樣式', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test -- auth' }, toolOpts('tu1'))
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    const req = tm.get(id).pendingPermission!
    expect(req).toMatchObject({
      toolName: 'Bash',
      suggestedPattern: 'npm test *',
      toolUseId: 'tu1',
      channel: 'main'
    })
    expect(tm.get(id).runState).toBe('waiting_permission')
    await tm.resolvePermission(id, req.id, { allow: true, rememberPattern: 'npm test *' })
    await tm.whenIdle(id)
    expect(result?.behavior).toBe('allow')
    expect(tm.get(id)).toMatchObject({
      allowedCommands: ['npm test *'],
      approvedCommands: ['npm test -- auth'],
      runState: 'idle'
    })
    expect(tm.get(id).pendingPermission).toBeUndefined()
    await expect(tm.resolvePermission(id, req.id, { allow: true })).rejects.toThrow('失效')
  })

  test('永遠允許的指令以目前的設定判斷：執行中移除樣式後，下一個指令就要核准', async () => {
    const { tm, claude, repo, create } = await setup()
    await repo.updateSettings({ alwaysAllowedCommands: ['npm test'] })
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    const results: (PermissionResult | null)[] = []
    let proceed!: () => void
    const removed = new Promise<void>((r) => (proceed = r))
    claude.script = async ({ options }) => {
      results.push(await options.canUseTool!('Bash', { command: 'npm test' }, signalOf()))
      await removed
      results.push(await options.canUseTool!('Bash', { command: 'npm test' }, signalOf()))
    }
    await tm.approveSpec(id)
    await until(() => results.length === 1)
    expect(results[0]?.behavior).toBe('allow')
    expect(tm.get(id).pendingPermission).toBeUndefined()
    await repo.updateSettings({ alwaysAllowedCommands: [] })
    proceed()
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: false })
    await tm.whenIdle(id)
    expect(results.map((r) => r?.behavior)).toEqual(['allow', 'deny'])
  })

  test('同時有多個核准請求時依序顯示', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    const results: (PermissionResult | null)[] = []
    claude.script = async ({ options }) => {
      results.push(
        ...(await Promise.all([
          options.canUseTool!('Bash', { command: 'npm test' }, signalOf()),
          options.canUseTool!('Bash', { command: 'npm run lint' }, signalOf())
        ]))
      )
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    const first = tm.get(id).pendingPermission!
    expect(first.input).toEqual({ command: 'npm test' })
    await tm.resolvePermission(id, first.id, { allow: false, message: '不要跑' })
    await until(
      () => tm.get(id).pendingPermission?.id !== first.id && !!tm.get(id).pendingPermission
    )
    const second = tm.get(id).pendingPermission!
    expect(second.input).toEqual({ command: 'npm run lint' })
    expect(tm.get(id).runState).toBe('waiting_permission')
    await tm.resolvePermission(id, second.id, { allow: true })
    await tm.whenIdle(id)
    expect(results.map((r) => r?.behavior)).toEqual(['deny', 'allow'])
    expect(results[0]).toMatchObject({ message: '不要跑' })
    expect(tm.get(id)).toMatchObject({ runState: 'idle', approvedCommands: ['npm run lint'] })
  })

  test('停止會拒絕等待中的核准並結束這一輪，不算錯誤', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await new Promise(() => undefined) // 卡住，直到被停止
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    await tm.stop(id, 'main')
    await tm.whenIdle(id)
    expect(result).toMatchObject({ behavior: 'deny', message: '使用者停止了執行' })
    expect(tm.get(id).pendingPermission).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')
    expect(tm.get(id).error).toBeUndefined()
  })

  test('分岔的核准請求不影響主線的執行狀態', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let result: PermissionResult | null | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('WebFetch', { url: 'https://example.com' }, signalOf())
    }
    await tm.openBranch(id, { title: '查資料' })
    await until(() => !!tm.get(id).pendingPermission)
    expect(tm.get(id).pendingPermission!.channel).toBe('branch:b1')
    expect(tm.get(id).runState).toBe('idle')
    expect(tm.get(id).branches[0].running).toBe(true)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: true })
    await tm.whenIdle(id)
    expect(result?.behavior).toBe('allow')
    expect(tm.get(id)).toMatchObject({ runState: 'idle', approvedCommands: [] })
    expect(tm.get(id).branches[0].running).toBe(false)
  })

  test('使用者拒絕的工具，時間軸上的工具結果標成已拒絕', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    claude.script = async ({ options }) => {
      await options.canUseTool!('Bash', { command: 'rm -rf dist' }, toolOpts('tu-deny'))
      return [toolResult('tu-deny', '先不要刪'), toolResult('tu-fail', 'exit 1')]
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, {
      allow: false,
      message: '先不要刪'
    })
    await tm.whenIdle(id)
    const results = (await tm.timeline(id)).filter((e) => e.kind === 'tool_result')
    expect(results.map((e) => [e.tool?.id, e.tool?.denied])).toEqual([
      ['tu-deny', true],
      ['tu-fail', undefined]
    ])
  })

  test('執行結束時清掉這段執行拒絕過、但沒等到工具結果的 tool_use id', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    claude.script = async ({ options }) => {
      await options.canUseTool!('Bash', { command: 'rm -rf dist' }, toolOpts('tu-lost'))
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: false })
    await tm.whenIdle(id)
    expect(deniedCount(tm)).toBe(0)
  })

  test('執行中插話會送進同一輪', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let release!: () => void
    claude.script = async () => {
      await new Promise<void>((r) => {
        release = r
      })
    }
    await tm.send(id, 'main', '開始')
    await until(() => tm.get(id).runState === 'running' && !!release)
    const before = claude.calls.length
    await tm.send(id, 'main', '順便改錯誤訊息')
    expect(claude.calls.length).toBe(before)
    release()
    await tm.whenIdle(id)
    expect(
      (await tm.timeline(id)).filter((e) => e.kind === 'user_text').map((e) => e.text)
    ).toContain('順便改錯誤訊息')
  })

  test('init 把執行中的任務標為中斷；resume 送出 [resume]', async () => {
    const { tm, claude, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x', runState: 'running', mainSessionId: 's9' }))
    await tm.init()
    expect(tm.get('x').runState).toBe('interrupted')
    await tm.resume('x')
    await tm.whenIdle('x')
    expect(claude.calls.at(-1)).toMatchObject({
      prompt: expect.stringContaining('[resume]'),
      options: { resume: 's9' }
    })
    expect(tm.get('x').runState).toBe('idle')
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作（加到 TaskManager，並刪除 Task 21 的 requestApproval／syncPermission／denyWaitersOf stub）**

檔頭的 `@shared/protocol` import 加上 `IMPLEMENT_START_REF`、`msgDisplay`。

核准請求的規則：
- 等待中的請求依提出順序放在 `permissionWaiters`，`pendingPermission` 永遠是最早的一個；解決一個後自動顯示下一個（同一輪可能平行要求多個核准）。
- 每個請求記下提出它的 AgentRun；那段執行結束（或因逾時被中止）時，還在等的請求一律拒絕（`執行已結束`）。
- 只有主線的請求會把 `runState` 切成 `waiting_permission`；分岔（例如 WebFetch）的請求不影響主線狀態。
- `signal` 已 abort 時立即拒絕；abort 時自動拒絕並移除 listener。
- `stop(taskId, channel)` 只拒絕該 channel 的等待中請求，再 `interrupt()` 該 channel 的執行。
- `resume` 在主線還沒有 session 時（第一輪就中斷）重新送出原始需求，而不是送 `[resume]`。
- `approveSpec`／`requestSpecChanges` 經 `transitionAndSend`：先檢查能不能送，再改狀態，送不出去就還原。核准規格寫入的 user_text 帶 `ref: IMPLEMENT_START_REF`（實作畫面從這裡開始顯示）。
- 請求記下 `channel` 與 SDK 的 `toolUseId`（UI 用來標出分岔的請求、對應時間軸上的工具呼叫）。使用者拒絕的 `toolUseId` 連同提出請求的執行記在 `deniedToolUses`，之後的工具結果標 `denied: true`（UI 顯示「已拒絕」而不是失敗）；那段執行結束（`onRunDone`、`dropStuckRun`）或關閉 app（`shutdown`）時清掉。

```ts
  // ───────── 規格 ─────────

  approveSpec(taskId: string) {
    return this.transitionAndSend(taskId, 'SPEC_APPROVED', () =>
      this.send(taskId, 'main', msg.specApproved(), {
        display: msgDisplay.specApproved,
        ref: IMPLEMENT_START_REF
      })
    )
  }

  async requestSpecChanges(taskId: string, text: string) {
    const body = text.trim()
    if (!body) throw new Error('請說明要修改的地方')
    await this.transitionAndSend(taskId, 'SPEC_CHANGES_REQUESTED', () =>
      this.send(taskId, 'main', msg.specFeedback(body), { display: msgDisplay.specFeedback(body) })
    )
  }

  // ───────── 指令核准 ─────────

  /** 依等待中的請求更新卡片與主線狀態（分岔的請求不改變主線的 runState） */
  private syncPermission(t: Task) {
    const waiting = [...this.permissionWaiters.values()].filter((w) => w.taskId === t.id)
    t.pendingPermission = waiting[0]?.request
    if (waiting.some((w) => w.channel === 'main')) {
      if (t.runState === 'running') t.runState = 'waiting_permission'
    } else if (t.runState === 'waiting_permission') {
      t.runState = 'running'
    }
  }

  private denyWaitersOf(run: AgentRun, message: string) {
    for (const w of [...this.permissionWaiters.values()]) {
      if (w.run === run) w.resolve({ allow: false, message })
    }
  }

  private requestApproval(
    taskId: string,
    channel: Channel,
    run: AgentRun | undefined,
    req: ApprovalRequest,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    if (signal.aborted) return Promise.resolve({ allow: false, message: '已取消' })
    const id = this.newId()
    return new Promise((resolve) => {
      let settled = false
      const onAbort = () => finish({ allow: false, message: '已取消' })
      const finish = (d: PermissionDecision) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        this.permissionWaiters.delete(id)
        this.persist(taskId, (t) => this.syncPermission(t))
        resolve(d)
      }
      this.permissionWaiters.set(id, {
        taskId,
        channel,
        run,
        request: {
          id,
          taskId,
          channel,
          toolUseId: req.toolUseId,
          toolName: req.toolName,
          input: req.input,
          suggestedPattern: req.suggestedPattern,
          createdAt: this.now()
        },
        resolve: finish
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.persist(taskId, (t) => this.syncPermission(t))
    })
  }

  async resolvePermission(taskId: string, requestId: string, decision: PermissionDecision) {
    const w = this.permissionWaiters.get(requestId)
    if (!w || w.taskId !== taskId) throw new Error('這個核准請求已經失效')
    if (!decision.allow && w.request.toolUseId) this.deniedToolUses.set(w.request.toolUseId, w.run)
    w.resolve(decision)
  }

  // ───────── 停止與續接 ─────────

  async stop(taskId: string, channel: Channel) {
    for (const w of [...this.permissionWaiters.values()]) {
      if (w.taskId === taskId && w.channel === channel)
        w.resolve({ allow: false, message: '使用者停止了執行' })
    }
    await this.runs.get(runKey(taskId, channel))?.interrupt()
  }

  async resume(taskId: string) {
    const t = this.task(taskId)
    // 第一輪還沒拿到 session 就中斷：沒有可續接的對話，重新送出需求
    if (!t.mainSessionId) {
      await this.send(taskId, 'main', t.request, { display: msgDisplay.resume })
      return
    }
    await this.send(taskId, 'main', msg.resume(), { display: msgDisplay.resume })
  }
```

**Step 4: 確認通過**

**Step 5: Commit**

```bash
git add src/main/tasks/taskManager.ts tests/main/taskManager.test.ts
git commit -m "feat(main): add spec approval, command approvals, interjection and resume

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 24：TaskManager（四）報告整理、回饋與收尾

**Files:**
- Create: `src/main/tasks/prBody.ts`
- Modify: `src/main/tasks/taskManager.ts`
- Test: `tests/main/taskManager.test.ts`、`tests/main/prBody.test.ts`

**Step 1: prBody 測試**

```ts
// tests/main/prBody.test.ts
import { expect, test } from 'vitest'
import { prBody } from '../../src/main/tasks/prBody'
import { sampleReport } from '../fixtures/report'

test('PR 內文包含摘要、決策、限制與驗證結果', () => {
  const body = prBody({
    version: 1,
    taskId: 't',
    input: sampleReport,
    diff: '',
    createdAt: 'x',
    stats: { files: 2, additions: 10, deletions: 1, perFile: [] },
    verification: [
      { command: 'npm test', exitCode: 0, durationMs: 10, outputTail: '' },
      { command: 'npm run lint', exitCode: 1, durationMs: 5, outputTail: '' },
      { command: 'npm run e2e', exitCode: null, durationMs: 0, outputTail: '', skipped: '未核准' }
    ]
  })
  expect(body).toContain('## 摘要')
  expect(body).toContain('在 IP 限流之後加入 lockoutGuard。')
  expect(body).toContain('- **計數存在 Redis**：既有 Redis（原因：多台機器共享）')
  expect(body).toContain('- Redis 掛掉時放行：fail-open')
  expect(body).toContain('- ✅ `npm test`')
  expect(body).toContain('- ❌ `npm run lint`')
  expect(body).toContain('- ⏭️ `npm run e2e`（未核准）')
  expect(body).toContain('2 個檔案，+10 −1')
  expect(body).toContain('由 Harness 產生')
})
```

**Step 2: prBody 實作**

```ts
// src/main/tasks/prBody.ts
import type { Report } from '@shared/types'

/** PR 內文：報告摘要、決策、限制、後續工作與驗證結果 */
export function prBody(r: Report): string {
  const i = r.input
  const lines = ['## 摘要', i.overview.summary, '']
  if (i.decisions.length) {
    lines.push(
      '## 決策',
      ...i.decisions.map((d) => `- **${d.title}**：${d.chosen}（原因：${d.rationale}）`),
      ''
    )
  }
  if (i.limitations.length)
    lines.push('## 限制與風險', ...i.limitations.map((l) => `- ${l.title}：${l.detail}`), '')
  if (i.followups.length) {
    lines.push(
      '## 後續工作',
      ...i.followups.map((f) => `- ${f.title}${f.detail ? `：${f.detail}` : ''}`),
      ''
    )
  }
  if (r.verification.length) {
    lines.push(
      '## 驗證',
      ...r.verification.map((v) =>
        v.skipped
          ? `- ⏭️ \`${v.command}\`（${v.skipped}）`
          : `- ${v.exitCode === 0 ? '✅' : '❌'} \`${v.command}\``
      ),
      ''
    )
  }
  lines.push(
    `變更：${r.stats.files} 個檔案，+${r.stats.additions} −${r.stats.deletions}`,
    '',
    '— 由 Harness 產生（Claude Code）'
  )
  return lines.join('\n')
}
```

**Step 3: TaskManager 測試**

檔頭加上 `import { sampleReport } from '../fixtures/report'`。`get()` 回傳複本，測試不能直接改內部狀態：要讓 `npm test` 算「核准過」，就真的走一次核准流程。

```ts
async function toImplementing(over: Partial<TaskManagerDeps> = {}) {
  const ctx = await setup(over)
  ctx.claude.script = async ({ call, sink }) => {
    if (call === 0) await sink.proposeSpec(spec)
  }
  const id = await ctx.create()
  ctx.claude.script = async () => []
  await ctx.tm.approveSpec(id)
  await ctx.tm.whenIdle(id)
  return { ...ctx, id }
}

describe('TaskManager：報告與收尾', () => {
  test('submit_report → commit、diff、驗證、存報告、進入 reviewing', async () => {
    const { tm, claude, verify, repo, id } = await toImplementing()
    // 實作中核准過 npm test，之後提交報告
    claude.script = async ({ options, sink }) => {
      await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成了嗎？')
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: true })
    await tm.whenIdle(id)
    const t = tm.get(id)
    expect(t).toMatchObject({ status: 'reviewing', runState: 'idle', reportVersions: [1] })
    const r = await repo.getReport(id, 1)
    expect(r).toMatchObject({ version: 1, commit: 'abc123', stats: { files: 1 } })
    expect(await tm.getReport(id, 1)).toEqual(r)
    expect(verify).toHaveBeenCalledWith(
      t.worktreePath,
      ['npm test'],
      expect.any(Function),
      expect.any(AbortSignal)
    )
    const isAllowed = verify.mock.calls[0][2]
    expect(isAllowed('npm test')).toBe(true)
    expect(isAllowed('git status')).toBe(true) // 全域允許清單
    expect(isAllowed('rm -rf /')).toBe(false)
    expect(isAllowed('ls && rm -rf /')).toBe(false) // 串接的指令不套用樣式（ls * 在允許清單中）
    expect((await tm.timeline(id)).at(-1)).toMatchObject({ kind: 'report', ref: '1' })
  })

  test('同一輪重複提交報告會被拒絕', async () => {
    const { tm, claude, id } = await toImplementing()
    let error: unknown
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
      await Promise.resolve(sink.submitReport(sampleReport)).catch((e: unknown) => {
        error = e
      })
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(String(error)).toContain('正在整理')
    expect(tm.get(id).reportVersions).toEqual([1])
  })

  test('整理報告失敗時記錄錯誤', async () => {
    const { tm, claude, git, id } = await toImplementing()
    git.commitAll = async () => {
      throw new Error('pre-commit hook failed')
    }
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({
      status: 'implementing',
      runState: 'error',
      error: '整理報告失敗：pre-commit hook failed'
    })
  })

  test('回饋 → implementing，送出 [report_feedback]；再次提交產生 v2', async () => {
    const { tm, claude, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    await tm.submitReportFeedback(id, [{ anchor: 'diff:a.ts:3', label: 'a.ts:3', text: '改常數' }])
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toBe('[report_feedback] - (diff:a.ts:3) 改常數')
    const feedback = (await tm.timeline(id)).filter((e) => e.kind === 'user_text').at(-1)!
    expect(feedback).toMatchObject({
      text: msgDisplay.reportFeedback(1, false),
      ref: IMPLEMENT_START_REF
    })
    expect(tm.get(id).reportVersions).toEqual([1, 2])
    expect(tm.get(id).status).toBe('reviewing')
  })

  test('只有整體意見的回饋顯示「送出整體意見」', async () => {
    const { tm, claude, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    claude.script = async () => []
    await tm.submitReportFeedback(id, [], '命名再一致一點')
    await tm.whenIdle(id)
    expect((await tm.timeline(id)).filter((e) => e.kind === 'user_text').at(-1)).toMatchObject({
      text: '送出整體意見',
      ref: IMPLEMENT_START_REF
    })
  })

  test('開 PR 與合併都會結束任務', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(await tm.createPullRequest(id)).toBe('https://github.com/me/shop-api/pull/1')
    expect(git.calls.at(-1)).toBe(`pr ${tm.get(id).branch} main 帳號鎖定`)
    expect(tm.get(id)).toMatchObject({
      status: 'done',
      prUrl: 'https://github.com/me/shop-api/pull/1'
    })
    await expect(tm.merge(id)).rejects.toThrow()
    expect(git.calls.some((c) => c.startsWith('merge'))).toBe(false)
  })

  test('合併到 base branch', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    await tm.merge(id)
    expect(git.calls.at(-1)).toBe(`merge ${tm.get(id).branch} main`)
    expect(tm.get(id).status).toBe('done')
  })

  test('丟棄會停止執行並移除 worktree', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async () => {
      await new Promise(() => undefined) // 卡住，直到被中止
    }
    await tm.send(id, 'main', '繼續')
    await until(() => tm.get(id).runState === 'running')
    await tm.discard(id)
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ status: 'discarded', runState: 'idle' })
    expect(tm.get(id).error).toBeUndefined()
    expect(git.calls.at(-1)).toBe(`remove ${tm.get(id).worktreePath} ${tm.get(id).branch}`)
    await expect(tm.send(id, 'main', 'hi')).rejects.toThrow('任務已結束')
    await tm.discard(id) // 再丟棄一次也不會出錯
    expect(tm.get(id).status).toBe('discarded')
  })
})
```

狀態一致性與「上一段執行卡住」的測試：

```ts
/** 可以從外部放行的 promise */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function toReviewing(over: Partial<TaskManagerDeps> = {}) {
  const ctx = await setup(over)
  ctx.claude.script = async ({ call, sink }) => {
    if (call === 0) await sink.proposeSpec(spec)
    if (call === 2) await sink.submitReport(sampleReport)
  }
  const id = await ctx.create()
  await ctx.tm.approveSpec(id)
  await ctx.tm.whenIdle(id)
  await ctx.tm.send(id, 'main', '完成')
  await ctx.tm.whenIdle(id)
  expect(ctx.tm.get(id).status).toBe('reviewing')
  ctx.claude.script = async () => []
  return { ...ctx, id }
}

describe('TaskManager：狀態一致性', () => {
  test('get() 回傳複本，改動不影響內部狀態', async () => {
    const { tm, create } = await setup()
    const id = await create()
    tm.get(id).approvedCommands.push('rm -rf /')
    expect(tm.get(id).approvedCommands).toEqual([])
  })

  test('閒置後不留下串接用的 promise', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async () => [assistantText('好')]
    const id = await create()
    await tm.send(id, 'main', '再一次')
    await tm.whenIdle(id)
    await new Promise((r) => setTimeout(r, 0))
    const internals = tm as unknown as Record<string, Map<string, unknown>>
    for (const name of ['chains', 'saves', 'timelineWrites', 'turnLocks']) {
      expect(internals[name].size, name).toBe(0)
    }
  })

  test('開 PR 期間拒絕其他收尾與改變狀態的操作', async () => {
    const { tm, git, id } = await toReviewing()
    const push = deferred<string>()
    git.pushAndOpenPr = () => push.promise
    const pr = tm.createPullRequest(id)
    await expect(tm.merge(id)).rejects.toThrow('收尾')
    await expect(tm.discard(id)).rejects.toThrow('收尾')
    await expect(tm.createPullRequest(id)).rejects.toThrow('收尾')
    await expect(
      tm.submitReportFeedback(id, [{ anchor: 'a', label: 'a', text: '改' }])
    ).rejects.toThrow('收尾')
    await expect(tm.send(id, 'main', '還有一件事')).rejects.toThrow('收尾')
    await expect(tm.openBranch(id, { title: 't' })).rejects.toThrow('收尾')
    expect(tm.get(id).status).toBe('reviewing')
    push.resolve('https://github.com/me/shop-api/pull/2')
    expect(await pr).toBe('https://github.com/me/shop-api/pull/2')
    expect(tm.get(id)).toMatchObject({
      status: 'done',
      prUrl: 'https://github.com/me/shop-api/pull/2'
    })
  })

  test('合併期間拒絕規格與卡片操作', async () => {
    const { tm, git, id } = await toReviewing()
    const merging = deferred()
    git.merge = () => merging.promise
    const m = tm.merge(id)
    await expect(tm.approveSpec(id)).rejects.toThrow('收尾')
    await expect(tm.requestSpecChanges(id, '改')).rejects.toThrow('收尾')
    await expect(tm.answerQuestion(id, 'q1', { text: 'x' })).rejects.toThrow('收尾')
    await expect(tm.counterQuestion(id, 'q1', 'x')).rejects.toThrow('收尾')
    merging.resolve()
    await m
    expect(tm.get(id).status).toBe('done')
  })

  test('開新一輪失敗時還原狀態，也不寫入時間軸', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    const before = (await tm.timeline(id)).length

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.approveSpec(id)).rejects.toThrow('spawn failed')
    expect(tm.get(id).status).toBe('spec_review')

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.requestSpecChanges(id, '改')).rejects.toThrow('spawn failed')
    expect(tm.get(id).status).toBe('spec_review')

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.openBranch(id, { title: 't' })).rejects.toThrow('spawn failed')
    expect(tm.get(id).branches).toEqual([])

    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.send(id, 'main', '哈囉')).rejects.toThrow('spawn failed')
    expect(await tm.timeline(id)).toHaveLength(before)
    expect(tm.get(id).runState).toBe('idle')
  })

  test('回饋送出失敗時回到 reviewing', async () => {
    const { tm, claude, id } = await toReviewing()
    claude.failNextQuery = new Error('spawn failed')
    await expect(
      tm.submitReportFeedback(id, [{ anchor: 'a', label: 'a', text: '改' }])
    ).rejects.toThrow('spawn failed')
    expect(tm.get(id).status).toBe('reviewing')
  })

  test('回答或反問送出失敗時還原卡片', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.askUser(askQ1)
    }
    const id = await create()
    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.answerQuestion(id, 'q1', { optionId: 'acct' })).rejects.toThrow()
    expect(tm.get(id).questions[0]).toMatchObject({ status: 'open', answer: undefined })
    claude.failNextQuery = new Error('spawn failed')
    await expect(tm.counterQuestion(id, 'q1', '為什麼？')).rejects.toThrow()
    expect(tm.get(id).questions[0].followups).toEqual([])
    // 反問失敗後的一般回覆不應被當成反問的答案
    claude.script = async () => [assistantText('一般回覆')]
    await tm.send(id, 'main', '繼續')
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0].followups).toEqual([])
    expect((await tm.timeline(id)).at(-1)).toMatchObject({ kind: 'assistant_text' })
  })

  test('整理報告期間拒絕主線訊息；成功後清除舊錯誤', async () => {
    const verifying = deferred()
    const { tm, claude, verify, id } = await toImplementing()
    claude.script = async () => [{ type: 'result', subtype: 'error_during_execution' }]
    await tm.send(id, 'main', '先失敗一次')
    await tm.whenIdle(id)
    expect(tm.get(id).error).toBe('執行時發生錯誤') // turn_end 失敗（不是丟出例外）也記錄錯誤
    expect(tm.get(id).runState).toBe('idle')

    verify.mockImplementationOnce(async () => {
      await verifying.promise
      return []
    })
    // 同一輪裡提交報告後又回報失敗：整理報告成功後應清掉這個錯誤
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
      return [{ type: 'result', subtype: 'error_during_execution' }]
    }
    await tm.send(id, 'main', '完成')
    await until(() => tm.get(id).runState === 'finalizing' && verify.mock.calls.length > 0)
    await expect(tm.send(id, 'main', '等等')).rejects.toThrow('正在整理報告')
    verifying.resolve()
    await tm.whenIdle(id)
    expect(tm.get(id)).toMatchObject({ status: 'reviewing', runState: 'idle' })
    expect(tm.get(id).error).toBeUndefined()
  })

  test('執行結束時拒絕還在等待的核准', async () => {
    const { tm, claude, id } = await toImplementing()
    let result: Promise<unknown> | undefined
    claude.script = async ({ options }) => {
      // 不等核准就結束這一輪（模擬 SDK 沒有取消 canUseTool 就結束）
      result = Promise.resolve(options.canUseTool!('Bash', { command: 'npm test' }, signalOf()))
      await until(() => !!tm.get(id).pendingPermission)
    }
    await tm.send(id, 'main', '跑測試')
    await tm.whenIdle(id)
    expect(await result).toMatchObject({ behavior: 'deny', message: '執行已結束' })
    expect(tm.get(id).pendingPermission).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')
  })

  test('丟棄會拒絕等待中的核准', async () => {
    const { tm, claude, id } = await toImplementing()
    let result: unknown
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await new Promise(() => undefined)
    }
    await tm.send(id, 'main', '跑測試')
    await until(() => !!tm.get(id).pendingPermission)
    await tm.discard(id)
    await tm.whenIdle(id)
    expect(result).toMatchObject({ behavior: 'deny', message: '任務已丟棄' })
    expect(tm.get(id)).toMatchObject({ status: 'discarded', runState: 'idle' })
    expect(tm.get(id).pendingPermission).toBeUndefined()
  })

  test('停止分岔不影響主線', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => {
      await new Promise(() => undefined)
    }
    const b = await tm.openBranch(id, { title: '討論' })
    await until(() => tm.get(id).branches[0].running)
    await tm.stop(id, `branch:${b.id}`)
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].running).toBe(false)
    expect(tm.get(id)).toMatchObject({ runState: 'idle' })
    expect(tm.get(id).error).toBeUndefined()
  })

  test('沒有 session 的中斷任務：resume 重新送出需求', async () => {
    const { tm, claude, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x', runState: 'interrupted' }))
    await tm.init()
    await tm.resume('x')
    await tm.whenIdle('x')
    expect(claude.calls.at(-1)!.prompt).toBe('加上登入失敗鎖定')
    expect(claude.calls.at(-1)!.options.resume).toBeUndefined()
  })

  test('init 清掉殘留的核准請求與分岔執行狀態', async () => {
    const { tm, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(
      makeTask({
        id: 'x',
        runState: 'idle',
        pendingPermission: {
          id: 'p1',
          taskId: 'x',
          channel: 'main',
          toolName: 'Bash',
          input: { command: 'ls' },
          createdAt: 'x'
        },
        branches: [{ id: 'b1', title: 't', status: 'open', running: true, createdAt: 'x' }]
      })
    )
    await tm.init()
    expect(tm.get('x').runState).toBe('idle')
    expect(tm.get('x').pendingPermission).toBeUndefined()
    expect(tm.get('x').branches[0].running).toBe(false)
    expect((await repo.listTasks()).find((t) => t.id === 'x')!.branches[0].running).toBe(false)
  })
})

describe('TaskManager：上一段執行卡住', () => {
  test('等太久就中止上一段執行，再開新的一輪', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 50 })
    const id = await create()
    claude.afterResult = 'hang'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2) // 第一輪的 result 已處理，輸入已關閉
    claude.afterResult = undefined
    await tm.send(id, 'main', '第二輪')
    await tm.whenIdle(id)
    expect(claude.calls.map((c) => c.prompt).slice(-2)).toEqual(['第一輪', '第二輪'])
    expect(tm.get(id).runState).toBe('idle')
  })

  test('中止後仍不結束就拒絕送出', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 50 })
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2) // 第一輪的 result 已處理，輸入已關閉
    claude.afterResult = undefined
    await expect(tm.send(id, 'main', '第二輪')).rejects.toThrow('上一輪尚未結束，請先停止')
    expect(claude.calls).toHaveLength(2)
    expect((await tm.timeline(id)).map((e) => e.text)).not.toContain('第二輪')
    // 卡住的執行已被丟掉：狀態回到 idle，whenIdle 不再等它，下一則訊息開新的一輪
    expect(tm.get(id).runState).toBe('idle')
    await tm.whenIdle(id)
    await tm.send(id, 'main', '第三輪')
    await tm.whenIdle(id)
    expect(claude.calls.map((c) => c.prompt).at(-1)).toBe('第三輪')
    claude.releaseHang()
  })

  test('丟棄時不理會 abort 的執行不會卡住', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 50 })
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2)
    await tm.discard(id)
    expect(tm.get(id)).toMatchObject({ status: 'discarded', runState: 'idle' })
    await tm.whenIdle(id)
    claude.releaseHang()
  })

  test('等上一段執行期間任務被丟棄，就不再開新的一輪', async () => {
    const { tm, claude, create } = await setup({ prevRunTimeoutMs: 5000 })
    const id = await create()
    claude.afterResult = 'hang'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2) // 第一輪的 result 已處理，輸入已關閉
    claude.afterResult = undefined
    // 先接住結果：拒絕會在 discard() 進行中發生
    const sending = tm.send(id, 'main', '第二輪').then(
      () => 'sent',
      (e: unknown) => String(e)
    )
    await tm.discard(id)
    expect(await sending).toContain('收尾')
    expect(claude.calls).toHaveLength(2)
    await tm.whenIdle(id)
  })
})

describe('TaskManager：審查補強', () => {
  test('分岔與決策 id 取現有最大編號 + 1', async () => {
    const { tm, claude, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(
      makeTask({
        id: 'x',
        mainSessionId: 's1',
        branches: [
          {
            id: 'b2',
            title: '舊分岔',
            status: 'concluding',
            running: false,
            sessionId: 'f2',
            conclusion: { decision: '用 Redis', rationale: '多台', deferred: [] },
            createdAt: 'x'
          }
        ],
        decisions: [{ id: 'd2', text: '舊決策', source: { type: 'question', ref: 'q1' } }]
      })
    )
    await tm.init()
    claude.script = async () => []
    const b = await tm.openBranch('x', { title: '新分岔' })
    expect(b.id).toBe('b3')
    await tm.whenIdle('x')
    await tm.confirmBranch('x', 'b2')
    await tm.whenIdle('x')
    expect(tm.get('x').decisions.map((d) => d.id)).toEqual(['d2', 'd3'])
  })

  test('submit_report 存檔失敗時不會卡在 finalizing', async () => {
    const { tm, claude, repo, id } = await toImplementing()
    const save = repo.saveTask.bind(repo)
    const spy = vi.spyOn(repo, 'saveTask').mockImplementation(async (t) => {
      if (t.runState === 'finalizing') throw new Error('disk full')
      return save(t)
    })
    let error: unknown
    claude.script = async ({ sink }) => {
      await Promise.resolve(sink.submitReport(sampleReport)).catch((e: unknown) => {
        error = e
      })
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    spy.mockRestore()
    expect(String(error)).toContain('disk full')
    expect(tm.get(id)).toMatchObject({ status: 'implementing', runState: 'idle' })
    // 沒有殘留的整理中狀態：主線可以繼續送訊息
    await tm.send(id, 'main', '再試一次')
    await tm.whenIdle(id)
  })

  test('插話前再檢查一次：排隊期間開始收尾就拒絕', async () => {
    const { tm, claude, id } = await toImplementing()
    const started = deferred()
    claude.script = async () => {
      started.resolve()
      await new Promise(() => undefined) // 一直執行，直到被停止
    }
    await tm.send(id, 'main', '開始')
    // 等 script 真的開始跑（這段執行正在進行中），不靠輪詢與時間
    await started.promise
    expect(tm.get(id).runState).toBe('running')
    // 白箱：佔住主線的 turn lock，讓下一則訊息排隊
    const internals = tm as unknown as {
      chainOn: (
        m: Map<string, Promise<unknown>>,
        k: string,
        fn: () => Promise<void>
      ) => Promise<void>
      turnLocks: Map<string, Promise<unknown>>
      finishing: Set<string>
    }
    const gate = deferred()
    void internals.chainOn(internals.turnLocks, `${id}|main`, () => gate.promise)
    const sending = tm.send(id, 'main', '插話').then(
      () => 'sent',
      (e: unknown) => String(e)
    )
    internals.finishing.add(id)
    gate.resolve()
    expect(await sending).toContain('收尾')
    expect((await tm.timeline(id)).map((e) => e.text)).not.toContain('插話')
    internals.finishing.delete(id)
    await tm.stop(id, 'main')
    await tm.whenIdle(id)
  })
})
```

> 「等上一段執行期間任務被丟棄」先用 `.then(ok, err)` 接住 `send()` 的結果：拒絕發生在 `discard()` 進行中，晚接會變成 unhandled rejection。

**Step 4: 確認失敗**

**Step 5: 實作（加到 TaskManager，取代 finalizeReport stub）**

檔頭加上 `FeedbackItem`、`Report`（`@shared/types`）、`hasShellOperators`、`matchesPattern`（`../permissions/commandPattern`）、`prBody`（`./prBody`）。

規則：
- 驗證指令的 `isAllowed` 與 gate 一致：完整核准過的指令可跑；含 shell 運算子（`&&`、`;`、`|`…）的指令不套用允許樣式（否則 `ls && rm -rf /` 會因 `ls *` 被自動執行）。
- `finalizing`（邏輯狀態）在 `submit_report` 時、寫入前設定，並在進入 reviewing（或記錄失敗）的同一個同步步驟清除，中間沒有空檔；`reportJobs` 追蹤整個流程（含之後的時間軸寫入）給 `whenIdle` 用。成功時清掉舊的 `error`；失敗時 `runState = 'error'`，記錄 `整理報告失敗：…`。
- 整理報告期間拒絕主線的新訊息與重複的 `submit_report`；丟棄也要等整理完。
- 開 PR／合併／丟棄以 `exclusive` 互斥，期間 `assertCanSend` 也拒絕送訊息與所有改變狀態的操作（回饋、核准規格、要求修改、回答、反問、分岔）。開 PR／合併要求主線沒有在執行。
- git 的副作用成功後（PR 已開、已合併）直接記錄 `status = 'done'`（保留 `prUrl`），不再走會丟錯的 transition。
- `submitReportFeedback` 經 `transitionAndSend`，送不出去就回到 reviewing。
- 丟棄直接 `abort()` 所有執行（每個最多等 `min(2 秒, prevRunTimeoutMs)`，仍不結束就 `dropStuckRun`）、拒絕等待中的核准，再移除 worktree；重複丟棄不會出錯。

```ts
  // ───────── 報告 ─────────

  /** 等提交報告的那段執行結束後：commit、算 diff、實跑驗證指令、存報告 */
  private async finalizeReport(taskId: string, input: ReportInput, run?: AgentRun) {
    const abort = new AbortController()
    this.reportAborts.set(taskId, abort)
    const assertNotAborted = () => {
      if (abort.signal.aborted) throw new Error('Harness 正在關閉')
    }
    try {
      await run?.done.catch(() => undefined)
      assertNotAborted()
      const t = this.task(taskId)
      const version = t.reportVersions.length + 1
      const commit =
        (await this.d.git.commitAll(t.worktreePath, `${t.title}（Harness 報告 v${version}）`)) ??
        undefined
      const [diff, stats] = await Promise.all([
        this.d.git.diff(t.worktreePath, t.baseBranch),
        this.d.git.diffStats(t.worktreePath, t.baseBranch)
      ])
      const settings = await this.d.repo.getSettings()
      // 只自動執行本任務核准過或在允許清單中的指令（串接的指令只認完整核准過的）
      const isAllowed = (c: string) => {
        const x = this.task(taskId)
        if (x.approvedCommands.includes(c)) return true
        if (hasShellOperators(c)) return false
        return [...settings.alwaysAllowedCommands, ...x.allowedCommands].some((p) =>
          matchesPattern(c, p)
        )
      }
      const verification = await this.d.verify(
        t.worktreePath,
        input.verification.map((v) => v.command),
        isAllowed,
        abort.signal
      )
      // 驗證被中止的結果不完整：不存報告，下次啟動可「繼續」重新整理
      assertNotAborted()
      const report: Report = {
        version,
        taskId,
        input,
        diff,
        stats,
        verification,
        commit,
        createdAt: this.now()
      }
      await this.d.repo.saveReport(report)
      await this.update(taskId, (x) => {
        const next = transition(x.status, 'REPORT_SUBMITTED')
        x.reportVersions.push(version)
        x.status = next
        x.runState = 'idle'
        x.error = undefined
        // 與進入 reviewing 同一步結束「整理中」，中間沒有可以插進其他操作的空檔
        this.finalizing.delete(taskId)
      })
      await this.addTimeline(taskId, { channel: 'main', kind: 'report', ref: String(version) })
    } catch (e) {
      const aborted = abort.signal.aborted
      await this.update(taskId, (x) => {
        x.runState = aborted ? 'interrupted' : 'error'
        x.error = aborted ? '關閉 app 時報告尚未整理完成' : `整理報告失敗：${errorMessage(e)}`
        this.finalizing.delete(taskId)
      }).catch(logError('儲存任務失敗'))
    } finally {
      if (this.reportAborts.get(taskId) === abort) this.reportAborts.delete(taskId)
    }
  }

  getReport(taskId: string, version: number) {
    return this.d.repo.getReport(taskId, version)
  }

  async submitReportFeedback(taskId: string, items: FeedbackItem[], overall?: string) {
    const note = overall?.trim() || undefined
    if (!items.length && !note) throw new Error('請至少留一則回饋')
    await this.transitionAndSend(taskId, 'REPORT_FEEDBACK', () =>
      this.send(taskId, 'main', msg.reportFeedback(items, note), {
        display: msgDisplay.reportFeedback(items.length, !!note),
        ref: IMPLEMENT_START_REF
      })
    )
  }

  // ───────── 收尾 ─────────

  private async repoOf(t: Task) {
    const repo = (await this.d.repo.listRepos()).find((r) => r.id === t.repoId)
    if (!repo) throw new Error('找不到 repo')
    return repo
  }

  /** 開 PR／合併／丟棄同一時間只做一個，期間也拒絕送訊息與改變狀態的操作 */
  private async exclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    this.task(taskId)
    if (this.finishing.has(taskId)) throw new Error('另一個收尾操作正在進行，請稍候')
    this.finishing.add(taskId)
    const job = fn()
    this.finishJobs.set(taskId, job)
    try {
      return await job
    } finally {
      this.finishing.delete(taskId)
      this.finishJobs.delete(taskId)
    }
  }

  private assertReviewable(t: Task, what: string) {
    if (t.status !== 'reviewing') throw new Error(`只有待審閱的任務可以${what}`)
    if (this.runs.get(runKey(t.id, 'main'))?.active)
      throw new Error(`Claude 正在執行，請等它停下來再${what}`)
  }

  createPullRequest(taskId: string): Promise<string> {
    return this.exclusive(taskId, async () => {
      const t = this.task(taskId)
      this.assertReviewable(t, '開 PR')
      const report = await this.d.repo.getReport(taskId, t.reportVersions.at(-1)!)
      const url = await this.d.git.pushAndOpenPr(
        t.worktreePath,
        t.branch,
        t.baseBranch,
        t.specs.at(-1)?.title ?? t.title,
        prBody(report)
      )
      // PR 已經開了：直接記錄結果，不能因為狀態檢查失敗而遺失 URL
      await this.update(taskId, (x) => {
        x.prUrl = url
        x.status = 'done'
      })
      return url
    })
  }

  merge(taskId: string): Promise<void> {
    return this.exclusive(taskId, async () => {
      const t = this.task(taskId)
      this.assertReviewable(t, '合併')
      await this.d.git.merge((await this.repoOf(t)).path, t.branch, t.baseBranch)
      await this.update(taskId, (x) => {
        x.status = 'done'
      })
    })
  }

  /** 中止所有執行、移除 worktree 與分支；已完成（開過 PR／合併）的任務只清掉 worktree */
  discard(taskId: string): Promise<void> {
    return this.exclusive(taskId, async () => {
      const t = this.task(taskId)
      if (this.finalizing.has(taskId)) throw new Error('正在整理報告，請稍候再丟棄')
      for (const w of [...this.permissionWaiters.values()]) {
        if (w.taskId === taskId) w.resolve({ allow: false, message: '任務已丟棄' })
      }
      const runs = this.runsOf(taskId)
      runs.forEach(([, r]) => r.abort())
      // abort 後仍不結束的程序不要卡住丟棄：不再追蹤它
      await Promise.all(
        runs.map(async ([key, r]) => {
          if (await settlesWithin(r.done, this.abortGraceMs)) return
          this.dropStuckRun(taskId, key.slice(taskId.length + 1) as Channel, r)
        })
      )
      await this.d.git.removeWorktree((await this.repoOf(t)).path, t.worktreePath, t.branch)
      await this.update(taskId, (x) => {
        if (x.status !== 'done' && x.status !== 'discarded')
          x.status = transition(x.status, 'DISCARDED')
        x.runState = 'idle'
        x.pendingPermission = undefined
      })
    })
  }

  changedFiles(taskId: string) {
    const t = this.task(taskId)
    return this.d.git.workingStats(t.worktreePath, t.baseBranch)
  }
```

**Step 6: 確認通過** — `npx vitest run tests/main` → 全部通過；`npm run typecheck` PASS；`npm test` 連跑 3 次沒有 flaky

**Step 7: Commit**

```bash
git add src/main/tasks tests/main/taskManager.test.ts tests/main/prBody.test.ts
git commit -m "feat(main): finalize reports, handle feedback, PR, merge and discard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 25：主程序組裝：IPC、自訂區塊 protocol、preload

**Files:**
- Create: `src/main/ipcGuards.ts`（IPC 邊界的輸入檢查，純函式）
- Create: `src/main/report/blockHtml.ts`
- Create: `src/main/ipc.ts`
- Modify: `src/main/tasks/taskManager.ts`（加 `shutdown()`；報告整理的驗證可中止、收尾操作可等待，見 Task 24）
- Modify: `src/main/verify/verifyRunner.ts`（`runShell`／`runVerification` 接受 AbortSignal，見 Task 15）
- Modify: `src/shared/report.ts`（custom block id 最長 64，見 Task 4）
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`、`src/preload/index.d.ts`；移除 `@electron-toolkit/preload` 依賴
- Test: `tests/main/ipcGuards.test.ts`、`tests/main/blockHtml.test.ts`、`tests/main/taskManager.test.ts`、`tests/main/verifyRunner.test.ts`、`tests/shared/report.test.ts`

設計重點：
- renderer 傳進來的任務／repo id 在 IPC 邊界先檢查格式（`/^[A-Za-z0-9_-]{1,64}$/`），再交給會組出 Store 路徑的模組（Store 本身也擋路徑穿越）。報告版本必須是正整數，channel 只能是 `main` 或 `branch:<id>`；文字參數（訊息、需求、base branch、問題／分岔／核准請求 id）必須是非空白字串並有長度上限，model 必須是支援的模型。
- `settings:set` 只保留已知欄位並逐欄檢查型別：worktree 位置去掉前後空白、必須是絕對路徑並以 `path.resolve` 正規化；分支前綴去掉前後空白，`${前綴}x` 必須符合 git 分支名稱規則（純 JS 的 `isValidBranchName`，錯誤「分支前綴不符合 git 分支名稱規則」）；允許清單去掉前後空白與重複；claudePath 空字串代表自動偵測。合併寫入用 `Repository.updateSettings`（設定的讀寫依序進行，同時呼叫不會互相蓋掉欄位），重新偵測 Claude Code 在鎖外進行。
- Claude Code 狀態用 `createClaudeStatusCache`（Task 16）：同時有多次重新偵測時只有最後開始的那次會更新快取。
- 只接受主視窗 main frame 送來的 IPC（`e.senderFrame === win.webContents.mainFrame`）；session 的權限請求與檢查一律拒絕。
- `shell:showInFolder` 只能打開已加入的 repo 或任務 worktree 裡的路徑；`report:saveHtml` 的預設路徑只取檔名。
- 啟動失敗（例如資料夾無法讀取）時顯示錯誤對話框並結束。
- 環境變數 `HARNESS_USER_DATA_DIR` 有值時，在模組最上方（任何地方讀 userData 之前）以 `app.setPath('userData', …)` 改用該資料夾；供 Task 35 的手動端對端驗證（`scripts/e2e/`）隔離資料，不碰使用者真正的 userData。不另寫單元測試。
- Claude Code 未登入時 `tasks:create` 以偵測的錯誤訊息拒絕（快取狀態未登入時先重新偵測一次）。
- `ipc.ts` 只做對應與檢查；可測的邏輯放 `ipcGuards.ts`／`blockHtml.ts`（tests/main 不 import electron）。
- `harness-block://report/<taskId>/<version>/<blockId>`：先用 `parseBlockUrl` 檢查格式（blockId 規則與 `@shared/report` 一致，最長 64），不符就 404；回應帶 CSP header，HTML 內也有同樣的 CSP meta 與轉義過的 `<title>`。
- 關閉 app（`before-quit`）時呼叫 `TaskManager.shutdown(1200)`：中止所有執行與報告整理中的驗證指令（TERM，0.5 秒後 KILL），等執行、報告整理與進行中的收尾操作結束後寫入狀態；兩段各最多 1.2 秒，外層再有 3 秒硬上限，不讓關閉卡住。收尾後用 `app.exit(0)`（由 SIGTERM 觸發、又被 preventDefault 擋下的關閉，在 macOS 上再 `app.quit()` 只會關掉視窗、程序不會結束）。

**Step 1: ipcGuards 測試**

```ts
// tests/main/ipcGuards.test.ts
import { describe, expect, test, vi } from 'vitest'
import type { ClaudeStatus } from '@shared/types'
import {
  assertChannel,
  assertId,
  assertModel,
  assertString,
  assertVersion,
  ensureClaudeReady,
  isPathInside,
  isSafeId,
  isValidBranchName,
  validateSettingsPatch
} from '../../src/main/ipcGuards'

describe('id 檢查', () => {
  test.each(['ab12cd34', 'r1', 'A_b-9', 'x'.repeat(64)])('接受 %s', (id) => {
    expect(isSafeId(id)).toBe(true)
    expect(assertId(id, '任務')).toBe(id)
  })

  test.each(['', '../x', 'a/b', 'a.b', 'a b', 'x'.repeat(65), 1, null, undefined, {}])(
    '拒絕 %s',
    (id) => {
      expect(isSafeId(id)).toBe(false)
      expect(() => assertId(id, '任務')).toThrow('無效的任務 id')
    }
  )
})

test('報告版本必須是正整數', () => {
  expect(assertVersion(3)).toBe(3)
  for (const v of [0, -1, 1.5, '1', NaN, undefined])
    expect(() => assertVersion(v)).toThrow('無效的報告版本')
})

test('channel 只接受 main 或 branch:<id>', () => {
  expect(assertChannel('main')).toBe('main')
  expect(assertChannel('branch:b1')).toBe('branch:b1')
  for (const c of ['branch:', 'branch:../x', 'other', 1])
    expect(() => assertChannel(c)).toThrow('無效的對話頻道')
})

describe('validateSettingsPatch', () => {
  test('只保留已知欄位，並整理值', () => {
    expect(
      validateSettingsPatch({
        branchPrefix: 'x/',
        evil: 1,
        claudePath: '/bin/claude',
        alwaysAllowedCommands: [' npm test ', 'ls'],
        loadProjectSettings: false,
        defaultModel: 'claude-sonnet-5-5',
        worktreeRoot: '/tmp/wt'
      })
    ).toEqual({
      branchPrefix: 'x/',
      claudePath: '/bin/claude',
      alwaysAllowedCommands: ['npm test', 'ls'],
      loadProjectSettings: false,
      defaultModel: 'claude-sonnet-5-5',
      worktreeRoot: '/tmp/wt'
    })
  })

  test('worktree 位置去掉前後空白並正規化；分支前綴去掉前後空白；允許清單去掉重複', () => {
    expect(validateSettingsPatch({ worktreeRoot: '  /tmp/a/../wt/ ' })).toEqual({
      worktreeRoot: '/tmp/wt'
    })
    expect(validateSettingsPatch({ branchPrefix: ' feat/ ' })).toEqual({ branchPrefix: 'feat/' })
    expect(
      validateSettingsPatch({ alwaysAllowedCommands: ['ls', ' ls ', 'npm test', 'ls'] })
    ).toEqual({ alwaysAllowedCommands: ['ls', 'npm test'] })
  })

  test.each(['harness/', 'feat-', 'me/wip/', 'a.b/', 'x', 'x.', 'user@host/'])(
    '接受分支前綴 %s',
    (prefix) =>
      expect(validateSettingsPatch({ branchPrefix: prefix })).toEqual({ branchPrefix: prefix })
  )

  test.each([
    'has space/',
    'tab\t/',
    'ctrl\u0001',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a..b',
    'a@{b',
    'a//',
    '-x',
    '/x',
    '.hidden/',
    'x/.y',
    'x.lock/'
  ])('拒絕不符合 git 分支名稱規則的前綴 %j', (prefix) => {
    expect(() => validateSettingsPatch({ branchPrefix: prefix })).toThrow(
      '分支前綴不符合 git 分支名稱規則'
    )
  })

  test('claudePath 空字串或 undefined 代表自動偵測', () => {
    expect(validateSettingsPatch({ claudePath: '  ' })).toEqual({ claudePath: undefined })
    expect(validateSettingsPatch({ claudePath: undefined })).toEqual({ claudePath: undefined })
  })

  test.each([
    [null, '無效的設定'],
    [{ worktreeRoot: '' }, 'worktree 位置'],
    [{ worktreeRoot: 'relative/dir' }, 'worktree 位置'],
    [{ worktreeRoot: 3 }, 'worktree 位置'],
    [{ branchPrefix: ' ' }, '分支前綴'],
    [{ claudePath: 1 }, 'claude 路徑'],
    [{ alwaysAllowedCommands: 'ls' }, '允許清單'],
    [{ alwaysAllowedCommands: ['ls', ' '] }, '允許清單'],
    [{ alwaysAllowedCommands: ['ls', 1] }, '允許清單'],
    [{ loadProjectSettings: 'yes' }, '載入專案設定'],
    [{ defaultModel: 'gpt-4' }, '模型']
  ])('拒絕 %j', (patch, msg) => {
    expect(() => validateSettingsPatch(patch)).toThrow(msg)
  })
})

describe('isValidBranchName', () => {
  test.each(['main', 'harness/20261008-ab12cd34', 'feat/a.b', 'v1.2', 'a-b_c'])('接受 %s', (n) =>
    expect(isValidBranchName(n)).toBe(true)
  )
  test.each([
    '',
    'a.',
    'a/',
    'a.lock',
    'a/b.lock',
    '.a',
    'a/.b',
    'a b',
    'a..b',
    'a@{1}',
    '-a',
    '@',
    'HEAD'
  ])('拒絕 %j', (n) => expect(isValidBranchName(n)).toBe(false))
})

describe('assertString', () => {
  test('回傳原字串', () => {
    expect(assertString('hi', '訊息')).toBe('hi')
    expect(assertString('', '訊息', { allowEmpty: true })).toBe('')
  })

  test.each([
    [undefined, {}],
    [3, {}],
    ['', {}],
    ['   ', {}],
    ['abcd', { max: 3 }]
  ])('拒絕 %j', (v, opts) => {
    expect(() => assertString(v, '訊息', opts)).toThrow('無效的訊息')
  })

  test('預設上限 100000 字元', () => {
    expect(assertString('a'.repeat(100_000), '訊息')).toHaveLength(100_000)
    expect(() => assertString('a'.repeat(100_001), '訊息')).toThrow('無效的訊息')
  })
})

test('model 必須是支援的模型', () => {
  expect(assertModel('claude-opus-5-5')).toBe('claude-opus-5-5')
  for (const m of ['gpt-4', '', 1, undefined]) expect(() => assertModel(m)).toThrow('無效的模型')
})

describe('isPathInside', () => {
  const roots = ['/repos/shop-api', '/home/me/.harness/worktrees/shop-api/20261007-ab12']

  test.each([
    '/repos/shop-api',
    '/repos/shop-api/src/a.ts',
    '/home/me/.harness/worktrees/shop-api/20261007-ab12/x'
  ])('允許 %s', (p) => {
    expect(isPathInside(p, roots)).toBe(true)
  })

  test.each([
    '/repos/shop-api-evil/a.ts',
    '/repos/shop-api/../other',
    '/etc/passwd',
    'relative/path',
    '',
    3
  ])('拒絕 %s', (p) => {
    expect(isPathInside(p, roots)).toBe(false)
  })
})

describe('ensureClaudeReady', () => {
  const ok: ClaudeStatus = { found: true, loggedIn: true, path: '/bin/claude' }
  const out: ClaudeStatus = {
    found: true,
    loggedIn: false,
    error: '尚未登入，請在終端機執行 claude 並完成登入。'
  }

  test('已登入直接通過，不重新偵測', async () => {
    const get = vi.fn(async () => ok)
    await expect(ensureClaudeReady(get)).resolves.toBe(ok)
    expect(get).toHaveBeenCalledTimes(1)
  })

  test('快取未登入時重新偵測一次，登入了就通過', async () => {
    const get = vi.fn(async (refresh?: boolean) => (refresh ? ok : out))
    await expect(ensureClaudeReady(get)).resolves.toBe(ok)
    expect(get).toHaveBeenLastCalledWith(true)
  })

  test('仍未登入就以偵測的錯誤訊息拒絕', async () => {
    const get = vi.fn(async () => out)
    await expect(ensureClaudeReady(get)).rejects.toThrow(out.error)
  })
})
```

**Step 2: ipcGuards 實作**

```ts
// src/main/ipcGuards.ts
// IPC 邊界的輸入檢查（純函式，不依賴 electron，可單元測試）
import { isAbsolute, resolve, sep } from 'node:path'
import { type Channel, type ClaudeStatus, MODELS, type ModelId, type Settings } from '@shared/types'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** 任務／repo id：只允許英數、底線與連字號，避免被拿來組出 Store 以外的路徑 */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

export function assertId(value: unknown, what: string): string {
  if (!isSafeId(value)) throw new Error(`無效的${what} id`)
  return value
}

export function assertVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error('無效的報告版本')
  return value
}

export function assertChannel(value: unknown): Channel {
  if (value === 'main') return value
  if (typeof value === 'string' && value.startsWith('branch:')) {
    if (isSafeId(value.slice('branch:'.length))) return value as Channel
  }
  throw new Error('無效的對話頻道')
}

/** 字串參數：預設不可為空白、最長 100000 字元 */
export function assertString(
  value: unknown,
  what: string,
  { max = 100_000, allowEmpty = false }: { max?: number; allowEmpty?: boolean } = {}
): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()))
    throw new Error(`無效的${what}`)
  return value
}

export function assertModel(value: unknown): ModelId {
  if (!MODELS.some((m) => m.id === value)) throw new Error('無效的模型')
  return value as ModelId
}

const nonEmpty = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what}必須是非空白的文字`)
  return v.trim()
}

/**
 * git check-ref-format 的分支名稱規則（純 JS 版，不必執行 git）：不可有空白、控制字元與
 * ~^:?*[\，不可有 ..、@{、//，不可以 - 或 / 開頭、以 / 或 . 結尾，
 * 每一段不可以 . 開頭或以 .lock 結尾；保險起見也拒絕單獨的 `@` 與 `HEAD`。
 * 檢查的是完整的分支名稱：設定的分支前綴以 `${前綴}x` 代表之後接上「日期-代號」的樣子。
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name === '@' || name === 'HEAD') return false
  if (/[\s~^:?*[\\]/.test(name)) return false
  // 控制字元（含 DEL）
  if ([...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (/^[-/]/.test(name) || /[/.]$/.test(name)) return false
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** 每個已知設定欄位的檢查與整理；未知欄位不寫進 settings.json */
const SETTINGS_VALIDATORS: { [K in keyof Settings]-?: (v: unknown) => Settings[K] } = {
  defaultModel: (v) => {
    if (!MODELS.some((m) => m.id === v)) throw new Error('不支援的模型')
    return v as ModelId
  },
  worktreeRoot: (v) => {
    const p = nonEmpty(v, 'worktree 位置')
    if (!isAbsolute(p)) throw new Error('worktree 位置必須是絕對路徑')
    // 去掉 ..、多餘的 / 與結尾的 /
    return resolve(p)
  },
  branchPrefix: (v) => {
    const prefix = nonEmpty(v, '分支前綴')
    // 前綴後面會接「日期-代號」，所以檢查接上一個字元之後的名稱
    if (!isValidBranchName(`${prefix}x`)) throw new Error('分支前綴不符合 git 分支名稱規則')
    return prefix
  },
  alwaysAllowedCommands: (v) => {
    if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !c.trim()))
      throw new Error('允許清單必須是非空白指令的清單')
    return [...new Set(v.map((c: string) => c.trim()))]
  },
  loadProjectSettings: (v) => {
    if (typeof v !== 'boolean') throw new Error('載入專案設定必須是開或關')
    return v
  },
  claudePath: (v) => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') throw new Error('claude 路徑必須是文字')
    // 空字串代表改回自動偵測
    return v.trim() || undefined
  }
}

export function validateSettingsPatch(patch: unknown): Partial<Settings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('無效的設定')
  const out: Record<string, unknown> = {}
  for (const [k, validate] of Object.entries(SETTINGS_VALIDATORS)) {
    if (k in patch)
      out[k] = (validate as (v: unknown) => unknown)((patch as Record<string, unknown>)[k])
  }
  return out as Partial<Settings>
}

/** path 是否位於 roots 其中之一（含本身）；只接受絕對路徑，`..` 會先解析掉 */
export function isPathInside(path: unknown, roots: string[]): boolean {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const p = resolve(path)
  return roots.some((root) => {
    const r = resolve(root)
    return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
  })
}

/**
 * 開始任務前確認 Claude Code 已登入：快取的狀態未登入時重新偵測一次
 * （使用者可能在 app 開著時才去終端機登入），仍未登入就以偵測的錯誤訊息拒絕。
 */
export async function ensureClaudeReady(
  getStatus: (refresh?: boolean) => Promise<ClaudeStatus>
): Promise<ClaudeStatus> {
  let s = await getStatus()
  if (!s.loggedIn) s = await getStatus(true)
  if (!s.loggedIn) throw new Error(s.error ?? '尚未登入，請在終端機執行 claude 並完成登入。')
  return s
}
```

**Step 3: blockHtml 測試**

```ts
// tests/main/blockHtml.test.ts
import { expect, test } from 'vitest'
import { BLOCK_CSP, parseBlockUrl, wrapBlockHtml } from '../../src/main/report/blockHtml'

test('包住區塊 HTML 並回報高度', () => {
  const html = wrapBlockHtml({ id: 'state-machine', title: 't', html: '<div id="x">hi</div>' })
  expect(html).toContain('<div id="x">hi</div>')
  expect(html).toContain('"harness-block-height"')
  expect(html).toContain('"state-machine"')
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain(`content="${BLOCK_CSP}"`)
})

test('標題轉義後放進 <title>', () => {
  const html = wrapBlockHtml({ id: 'x', title: '狀態機 <script>&"\'', html: '' })
  expect(html).toContain('<title>狀態機 &lt;script&gt;&amp;&quot;&#39;</title>')
  expect(html).not.toContain('<title>狀態機 <script>')
})

test('區塊 id 最長 64 字元', () => {
  expect(parseBlockUrl(`harness-block://report/ab12/1/${'a'.repeat(64)}`)?.blockId).toHaveLength(64)
})

test('id 裡的 < 不會結束 script', () => {
  const html = wrapBlockHtml({ id: '</script>', title: 't', html: '' })
  expect(html).not.toContain('"</script>"')
})

test('CSP 禁止網路', () => {
  expect(BLOCK_CSP).toContain("default-src 'none'")
  expect(BLOCK_CSP).not.toContain('http')
})

test('解析區塊網址', () => {
  expect(parseBlockUrl('harness-block://report/ab12cd34/2/state-machine')).toEqual({
    taskId: 'ab12cd34',
    version: 2,
    blockId: 'state-machine'
  })
})

test.each([
  'harness-block://report/ab12/0/x',
  'harness-block://report/ab12/1.5/x',
  'harness-block://report/ab12/-1/x',
  'harness-block://report/ab12/abc/x',
  'harness-block://report/..%2f..%2fetc/1/x',
  'harness-block://report/ab12/1/..',
  'harness-block://report/ab12/1/X%20Y',
  `harness-block://report/ab12/1/${'a'.repeat(65)}`,
  'harness-block://report/ab12/1',
  'harness-block://report/ab12/1/x/extra',
  'harness-block://other/ab12/1/x',
  'https://report/ab12/1/x',
  'not a url'
])('拒絕不合格式的網址 %s', (url) => {
  expect(parseBlockUrl(url)).toBeNull()
})
```

**Step 4: blockHtml 實作**

```ts
// src/main/report/blockHtml.ts
import { isSafeId } from '../ipcGuards'

/** 自訂區塊只能用 inline 的 style／script 與 data: 圖片字型，不能連網、不能送表單 */
export const BLOCK_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

export function wrapBlockHtml(block: { id: string; title: string; html: string }): string {
  // 避免 id 裡的 `</script>` 提早結束 script（id 已經過 zod 檢查，這裡再保險一次）
  const id = JSON.stringify(block.id).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BLOCK_CSP}">
<title>${escapeHtml(block.title)}</title>
<style>html,body{margin:0;background:transparent;color:#1c2430;font-family:'Noto Sans TC',-apple-system,'PingFang TC',sans-serif;font-size:14px;line-height:1.6}</style>
</head><body>${block.html}
<script>(function(){var post=function(){parent.postMessage({type:"harness-block-height",id:${id},height:document.documentElement.scrollHeight},"*")};new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post()})()</script>
</body></html>`
}

/** 與 @shared/report 的 custom block id 規則一致 */
const BLOCK_ID = /^[a-z0-9_-]{1,64}$/

/** 解析 `harness-block://report/<taskId>/<version>/<blockId>`，格式不符回傳 null */
export function parseBlockUrl(
  url: string
): { taskId: string; version: number; blockId: string } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'harness-block:' || u.hostname !== 'report') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length !== 3) return null
  const [taskId, v, blockId] = parts
  if (!isSafeId(taskId) || !BLOCK_ID.test(blockId) || !/^[1-9][0-9]{0,8}$/.test(v)) return null
  return { taskId, version: Number(v), blockId }
}
```

**Step 5: TaskManager.shutdown（測試加在 `tests/main/taskManager.test.ts` 最後）**

```ts
describe('TaskManager：關閉 app', () => {
  test('shutdown 中止所有執行、拒絕核准，主線標為中斷，之後拒絕新操作', async () => {
    const { tm, claude, id, repo } = await toImplementing()
    let result: PermissionResult | null | undefined
    claude.script = async () => {
      await new Promise(() => undefined) // 一直執行，直到被中止
    }
    await tm.openBranch(id, { title: '查資料' })
    await until(() => tm.get(id).branches[0]?.running === true)
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test' }, signalOf())
      await new Promise(() => undefined)
    }
    await tm.send(id, 'main', '開始')
    await until(() => !!tm.get(id).pendingPermission)

    await tm.shutdown(2000) // 上限放寬：全部結束就會提早返回
    expect(result).toMatchObject({ behavior: 'deny' })
    const t = tm.get(id)
    expect(t.runState).toBe('interrupted')
    expect(t.pendingPermission).toBeUndefined()
    expect(t.branches[0].running).toBe(false)
    await expect(tm.send(id, 'main', '再一則')).rejects.toThrow('正在關閉')
    await expect(
      tm.createTask({ repoId: 'r1', request: 'x', baseBranch: 'main', model: 'claude-opus-5-5' })
    ).rejects.toThrow('正在關閉')
    // 寫進磁碟的狀態也是中斷，下次啟動可以「繼續」
    expect((await repo.listTasks()).find((x) => x.id === id)?.runState).toBe('interrupted')
  })

  test('shutdown 清掉被拒絕的 tool_use id（執行卡住、不會結束）', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => {
      if (call === 0) await sink.proposeSpec(spec)
    }
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    claude.script = async ({ options }) => {
      await options.canUseTool!('Bash', { command: 'rm -rf dist' }, toolOpts('tu-stuck'))
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    await tm.resolvePermission(id, tm.get(id).pendingPermission!.id, { allow: false })
    await until(() => claude.results === 2)
    expect(deniedCount(tm)).toBe(1)
    await tm.shutdown(100)
    expect(deniedCount(tm)).toBe(0)
    claude.releaseHang()
  })

  test('shutdown 不會被不理會 abort 的執行卡住', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.afterResult = 'hang_ignoring_abort'
    await tm.send(id, 'main', '第一輪')
    await until(() => claude.results === 2)
    const started = Date.now()
    await tm.shutdown(100)
    // 卡住的執行永遠不會結束：只要沒有無限等待就算通過（上限寬鬆，避免機器忙時誤判）
    expect(Date.now() - started).toBeLessThan(3000)
    expect(tm.get(id).runState).toBe('interrupted')
    claude.releaseHang()
  })

  test('shutdown 中止進行中的驗證指令，報告不存檔，主線標為中斷', async () => {
    let seen: AbortSignal | undefined
    const verify = vi.fn<TaskManagerDeps['verify']>(async (_cwd, commands, _ok, signal) => {
      seen = signal
      await new Promise((r) => signal!.addEventListener('abort', r, { once: true }))
      return commands.map((command) => ({
        command,
        exitCode: null,
        durationMs: 1,
        outputTail: '[Harness] 已取消'
      }))
    })
    const { tm, claude, repo, id } = await toImplementing({ verify })
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await until(() => verify.mock.calls.length === 1)
    const started = Date.now()
    await tm.shutdown(3000)
    // 驗證指令沒被中止的話會等滿上限
    expect(Date.now() - started).toBeLessThan(2500)
    expect(seen?.aborted).toBe(true)
    expect(tm.get(id)).toMatchObject({
      status: 'implementing',
      runState: 'interrupted',
      reportVersions: []
    })
    await expect(repo.getReport(id, 1)).rejects.toThrow()
  })

  test('shutdown 等進行中的合併完成（有上限）', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async ({ sink }) => {
      await sink.submitReport(sampleReport)
    }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    const merge = git.merge
    git.merge = async (...a) => {
      await new Promise((r) => setTimeout(r, 150))
      await merge(...a)
    }
    const merging = tm.merge(id)
    await tm.shutdown(3000) // 合併一完成就返回；上限放寬避免機器忙時誤判
    expect(tm.get(id).status).toBe('done')
    await merging
  })

  test('沒有執行時 shutdown 立即結束，閒置任務狀態不變', async () => {
    const { tm, create } = await setup()
    const id = await create()
    await tm.shutdown(100)
    expect(tm.get(id).runState).toBe('idle')
  })
})

describe('TaskManager：分岔的錯誤', () => {
  test('分岔執行丟出錯誤記在分岔上，不影響主線；再送訊息就清除', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => {
      throw new Error('CLI crashed')
    }
    const b = await tm.openBranch(id, { title: '討論' })
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0]).toMatchObject({ running: false, error: 'CLI crashed' })
    expect(tm.get(id).error).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')

    claude.script = async () => [assistantText('好')]
    await tm.send(id, `branch:${b.id}`, '再試一次')
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].error).toBeUndefined()
    expect(tm.get(id).error).toBeUndefined()
  })

  test('分岔的 turn_end 失敗記在分岔上', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [{ type: 'result', subtype: 'error_during_execution' }]
    await tm.openBranch(id, { title: '討論' })
    await tm.whenIdle(id)
    expect(tm.get(id).branches[0].error).toBe('執行時發生錯誤')
    expect(tm.get(id).error).toBeUndefined()
    expect(tm.get(id).runState).toBe('idle')
  })

  test('主線的錯誤仍記在任務上', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    claude.script = async () => [{ type: 'result', subtype: 'error_during_execution' }]
    await tm.send(id, 'main', '失敗')
    await tm.whenIdle(id)
    expect(tm.get(id).error).toBe('執行時發生錯誤')
    claude.script = async () => []
    await tm.send(id, 'main', '再一次')
    await tm.whenIdle(id)
    expect(tm.get(id).error).toBeUndefined()
  })
})
```

實作：TaskManager 加 `private shuttingDown = false`；`assertCanSend` 與 `createTask` 開頭在關閉中時丟出 `new Error('Harness 正在關閉')`。`reportAborts`（finalizeReport 傳給 `verify` 的 AbortSignal）與 `finishJobs`（`exclusive` 的收尾操作）見 Task 24 的程式碼。在 `stop()` 之後加：

```ts
  /**
   * 關閉 app 前呼叫：之後拒絕新任務與新訊息，拒絕等待中的核准、中止所有執行與報告整理中的驗證指令。
   * 先等執行、報告整理與進行中的收尾操作（開 PR／合併／丟棄）結束，再寫入狀態；兩段各最多 timeoutMs，
   * 總共不超過 2 × timeoutMs，不讓關閉卡住。被中止的主線標為已中斷，下次啟動可「繼續」。
   */
  async shutdown(timeoutMs = this.abortGraceMs) {
    this.shuttingDown = true
    for (const w of [...this.permissionWaiters.values()])
      w.resolve({ allow: false, message: 'Harness 正在關閉' })
    const runs = [...this.runs.entries()]
    runs.forEach(([, r]) => r.abort())
    this.reportAborts.forEach((a) => a.abort())
    await settlesWithin(
      Promise.all([
        ...runs.map(([, r]) => r.done.catch(() => undefined)),
        ...this.reportJobs.values(),
        ...[...this.finishJobs.values()].map((p) => p.catch(() => undefined))
      ]),
      timeoutMs
    )
    const taskIds = new Set(runs.map(([key]) => key.slice(0, key.indexOf('|'))))
    const marks = [...taskIds].map((taskId) =>
      // 排在 onRunDone 的收尾之後，才不會被它改回 idle
      this.enqueue(taskId, () =>
        this.update(taskId, (t) => {
          const mainAborted = runs.some(([key]) => key === runKey(taskId, 'main'))
          if (
            mainAborted &&
            (t.runState === 'idle' ||
              t.runState === 'running' ||
              t.runState === 'waiting_permission')
          )
            t.runState = 'interrupted'
          t.branches.forEach((b) => {
            b.running = false
          })
          this.syncPermission(t)
        })
      )
    )
    await settlesWithin(Promise.all(marks), timeoutMs)
    // 中止後仍不結束的執行不會走到 onRunDone
    this.deniedToolUses.clear()
  }
```

**Step 6: ipc.ts（把 IpcApi 的每個 channel 對應到實作）**

```ts
// src/main/ipc.ts
// 把 IpcApi 的每個 channel 對應到實作；這裡只做對應與輸入檢查，邏輯放在各模組
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { type BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { CreateTaskInput, IpcApi, IpcChannel } from '@shared/ipc'
import type { ClaudeStatus, Repo } from '@shared/types'
import type { GitService } from './git/gitService'
import {
  assertChannel,
  assertId,
  assertModel,
  assertString,
  assertVersion,
  ensureClaudeReady,
  isPathInside,
  validateSettingsPatch
} from './ipcGuards'
import type { Repository } from './store/repository'
import type { TaskManager } from './tasks/taskManager'

export interface IpcDeps {
  win: () => BrowserWindow | null
  repo: Repository
  git: GitService
  tasks: TaskManager
  claudeStatus: (refresh?: boolean) => Promise<ClaudeStatus>
  emitRepos: (repos: Repo[]) => void
}

type Handlers = {
  [C in IpcChannel]: (
    ...args: Parameters<IpcApi[C]>
  ) => ReturnType<IpcApi[C]> | Promise<ReturnType<IpcApi[C]>>
}

const task = (id: unknown) => assertId(id, '任務')
/** 訊息內容（使用者輸入的文字） */
const text = (v: unknown, what = '訊息') => assertString(v, what)
/** Claude 或 app 產生的 id（問題、分岔、核准請求），不會用來組路徑 */
const ref = (v: unknown, what: string) => assertString(v, what, { max: 200 })
/** 匯出的 HTML 可能很大（含 diff），只擋非字串與極端大小 */
const MAX_HTML = 50_000_000

export function registerIpc(d: IpcDeps) {
  const handlers: Handlers = {
    'claude:status': (refresh) => d.claudeStatus(refresh === true),
    'settings:get': () => d.repo.getSettings(),
    'settings:set': async (raw) => {
      const patch = validateSettingsPatch(raw)
      // 依序合併寫入；重新偵測 Claude Code 在鎖外進行，不擋住其他設定的儲存
      const next = await d.repo.updateSettings(patch)
      if ('claudePath' in patch) await d.claudeStatus(true)
      return next
    },
    'repos:list': () => d.repo.listRepos(),
    'repos:pick': async () => {
      const w = d.win()
      if (!w) return null
      const res = await dialog.showOpenDialog(w, {
        properties: ['openDirectory'],
        title: '選擇 git repo'
      })
      if (res.canceled || !res.filePaths[0]) return null
      if (!(await d.git.isRepo(res.filePaths[0]))) throw new Error('這個資料夾不是 git repo')
      const root = await d.git.repoRoot(res.filePaths[0])
      const repos = await d.repo.listRepos()
      const existing = repos.find((r) => r.path === root)
      if (existing) return existing
      const repo: Repo = {
        id: randomUUID().slice(0, 8),
        name: basename(root),
        path: root,
        addedAt: new Date().toISOString()
      }
      await d.repo.saveRepos([...repos, repo])
      d.emitRepos([...repos, repo])
      return repo
    },
    'repos:branches': async (repoId) => {
      assertId(repoId, 'repo')
      const r = (await d.repo.listRepos()).find((x) => x.id === repoId)
      if (!r) throw new Error('找不到 repo')
      return d.git.branchInfo(r.path)
    },
    'tasks:list': () => d.tasks.list(),
    'tasks:create': async (raw: CreateTaskInput) => {
      if (!raw || typeof raw !== 'object') throw new Error('無效的任務內容')
      const input: CreateTaskInput = {
        repoId: assertId(raw.repoId, 'repo'),
        request: text(raw.request, '需求'),
        baseBranch: assertString(raw.baseBranch, 'base branch', { max: 255 }),
        model: assertModel(raw.model)
      }
      await ensureClaudeReady(d.claudeStatus)
      return d.tasks.createTask(input)
    },
    'tasks:timeline': (taskId) => d.tasks.timeline(task(taskId)),
    'tasks:send': (taskId, channel, msg) =>
      d.tasks.send(task(taskId), assertChannel(channel), text(msg)),
    'tasks:answer': (taskId, qid, answer) =>
      d.tasks.answerQuestion(task(taskId), ref(qid, '問題 id'), answer),
    'tasks:counter': (taskId, qid, msg) =>
      d.tasks.counterQuestion(task(taskId), ref(qid, '問題 id'), text(msg)),
    'tasks:changedFiles': (taskId) => d.tasks.changedFiles(task(taskId)),
    'branch:open': (taskId, input) => {
      if (!input || typeof input !== 'object') throw new Error('無效的分岔內容')
      text(input.title, '分岔標題')
      return d.tasks.openBranch(task(taskId), input)
    },
    'branch:conclude': (taskId, branchId) =>
      d.tasks.concludeBranch(task(taskId), ref(branchId, '分岔 id')),
    'branch:confirm': (taskId, branchId, edited) =>
      d.tasks.confirmBranch(task(taskId), ref(branchId, '分岔 id'), edited),
    'spec:approve': (taskId) => d.tasks.approveSpec(task(taskId)),
    'spec:requestChanges': (taskId, msg) => d.tasks.requestSpecChanges(task(taskId), text(msg)),
    'run:stop': (taskId, channel) => d.tasks.stop(task(taskId), assertChannel(channel)),
    'run:resume': (taskId) => d.tasks.resume(task(taskId)),
    'permission:resolve': (taskId, requestId, decision) =>
      d.tasks.resolvePermission(task(taskId), ref(requestId, '核准請求 id'), decision),
    'report:get': (taskId, version) => d.tasks.getReport(task(taskId), assertVersion(version)),
    'report:feedback': (taskId, items, overall) =>
      d.tasks.submitReportFeedback(task(taskId), items, overall),
    'report:saveHtml': async (suggestedName, html) => {
      assertString(html, 'HTML', { max: MAX_HTML })
      const w = d.win()
      if (!w) return null
      const res = await dialog.showSaveDialog(w, {
        // 只取檔名：建議名稱不能把儲存對話框預設到其他資料夾
        defaultPath: basename(String(suggestedName)),
        filters: [{ name: 'HTML', extensions: ['html'] }]
      })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, html)
      return res.filePath
    },
    'finish:pr': (taskId) => d.tasks.createPullRequest(task(taskId)),
    'finish:merge': (taskId) => d.tasks.merge(task(taskId)),
    'finish:discard': (taskId) => d.tasks.discard(task(taskId)),
    'shell:showInFolder': async (path) => {
      // 只能打開已加入的 repo 或任務 worktree 裡的位置
      const roots = [
        ...(await d.repo.listRepos()).map((r) => r.path),
        ...d.tasks.list().map((t) => t.worktreePath)
      ]
      if (!isPathInside(path, roots)) throw new Error('只能顯示 repo 或 worktree 裡的檔案')
      shell.showItemInFolder(path)
    },
    'shell:openExternal': async (url) => {
      if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url)
    }
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (e, ...args: unknown[]) => {
      // 只接受主視窗本身（不是 iframe 或其他視窗）送來的請求
      const main = d.win()?.webContents.mainFrame
      if (!e.senderFrame || !main || e.senderFrame !== main)
        throw new Error('拒絕來自未知來源的請求')
      return (fn as (...a: unknown[]) => unknown)(...args)
    })
  }
}
```

**Step 7: main/index.ts**

```ts
// src/main/index.ts
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { APP_EVENT_CHANNEL, type AppEvent } from '@shared/ipc'
import type { QueryFn } from './agent/agentRun'
import {
  applyLoginShellPath,
  createClaudeStatusCache,
  detectClaude,
  execCapture
} from './claude/detect'
import { GitService } from './git/gitService'
import { registerIpc } from './ipc'
import { BLOCK_CSP, parseBlockUrl, wrapBlockHtml } from './report/blockHtml'
import { Repository } from './store/repository'
import { Store } from './store/store'
import { TaskManager } from './tasks/taskManager'
import { createHarnessServer } from './tools/harnessTools'
import { runVerification } from './verify/verifyRunner'

// 手動端對端驗證（scripts/e2e）用：把 userData 指到暫存資料夾，不碰使用者真正的資料。
// 必須在任何地方讀取 userData 之前設定
if (process.env.HARNESS_USER_DATA_DIR) app.setPath('userData', process.env.HARNESS_USER_DATA_DIR)

// 自訂區塊用獨立的 scheme：iframe 不和 renderer 同源，也拿不到 preload 的 bridge
protocol.registerSchemesAsPrivileged([
  { scheme: 'harness-block', privileges: { standard: true, secure: true } }
])

/**
 * 關閉 app 的時間預算：TaskManager.shutdown 分兩段（等執行／報告整理／收尾操作結束、寫入狀態），
 * 每段最多 SHUTDOWN_STEP_MS，合計 2.4 秒，在硬上限 SHUTDOWN_HARD_LIMIT_MS 之內。
 * 驗證指令被中止後 0.5 秒內會被 SIGKILL，也在預算之內。
 */
const SHUTDOWN_STEP_MS = 1200
const SHUTDOWN_HARD_LIMIT_MS = 3000

let mainWindow: BrowserWindow | null = null
let tasks: TaskManager | null = null

const devUrl = () => (is.dev ? process.env.ELECTRON_RENDERER_URL : undefined)

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#eef0f3',
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      sandbox: true,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // 新視窗一律拒絕；https 連結交給系統瀏覽器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 主視窗不離開 app 本身（開發時允許 Vite 的 HMR 重新載入）
  win.webContents.on('will-navigate', (e, url) => {
    const dev = devUrl()
    if (!(dev && url.startsWith(dev))) e.preventDefault()
  })
  const dev = devUrl()
  if (dev) void win.loadURL(dev)
  else void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  return win
}

async function start() {
  electronApp.setAppUserModelId('com.harness.app')
  // renderer 與自訂區塊都不需要相機、麥克風、通知等權限，一律拒絕
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  // 必須在 detectClaude 之前：從 Finder 啟動時 PATH 不含 homebrew / nvm
  await applyLoginShellPath()

  const repo = new Repository(
    new Store(join(app.getPath('userData'), 'harness')),
    app.getPath('home')
  )
  const git = new GitService()
  const detect = async () => detectClaude(execCapture, (await repo.getSettings()).claudePath)
  // 同時有多次重新偵測（重新檢查、改 claude 路徑、視窗取得焦點）時只採用最後開始的那次
  const claude = createClaudeStatusCache(detect, await detect())
  const claudeStatus = (refresh?: boolean) => claude.status(refresh)
  const emit = (e: AppEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(APP_EVENT_CHANNEL, e)
  }

  const tm = new TaskManager({
    repo,
    git,
    emit,
    queryFn: query as unknown as QueryFn,
    createToolServer: createHarnessServer,
    getClaudePath: () => claude.current().path,
    verify: runVerification
  })
  await tm.init()
  tasks = tm

  protocol.handle('harness-block', async (req) => {
    const notFound = () => new Response('not found', { status: 404 })
    const target = parseBlockUrl(req.url)
    if (!target) return notFound()
    try {
      const report = await tm.getReport(target.taskId, target.version)
      const block = report.input.custom_blocks.find((b) => b.id === target.blockId)
      if (!block) return notFound()
      return new Response(wrapBlockHtml(block), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': BLOCK_CSP,
          'x-content-type-options': 'nosniff'
        }
      })
    } catch {
      return notFound()
    }
  })

  registerIpc({
    win: () => mainWindow,
    repo,
    git,
    tasks: tm,
    claudeStatus,
    emitRepos: (repos) => emit({ type: 'repos', repos })
  })

  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}

app
  .whenReady()
  .then(start)
  .catch((err: unknown) => {
    console.error('[Harness] 啟動失敗', err)
    dialog.showErrorBox('Harness 無法啟動', err instanceof Error ? err.message : String(err))
    app.exit(1)
  })

// 關閉前中止所有執行（有時間上限，不讓關閉卡住）；被中止的任務標為已中斷，下次啟動可「繼續」。
// 收尾後用 app.exit 而不是再呼叫 app.quit：由 SIGTERM 觸發、又被 preventDefault 擋下的關閉，
// 在 macOS 上再 app.quit() 只會關掉視窗、程序不會結束。
let quitting = false
app.on('before-quit', (e) => {
  if (!tasks) return
  e.preventDefault()
  if (quitting) return
  quitting = true
  const hardLimit = new Promise((r) => setTimeout(r, SHUTDOWN_HARD_LIMIT_MS))
  void Promise.race([
    tasks.shutdown(SHUTDOWN_STEP_MS).catch((err) => console.error(err)),
    hardLimit
  ]).finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

**Step 8: preload**

```ts
// src/preload/index.ts
// sandbox 下的 preload：只能 import electron 與 @shared/*（會被打包成單一 CJS 檔）
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { APP_EVENT_CHANNEL, type AppEvent, type HarnessBridge } from '@shared/ipc'

const bridge: HarnessBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: AppEvent) => cb(ev)
    ipcRenderer.on(APP_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(APP_EVENT_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('harness', bridge)
```

```ts
// src/preload/index.d.ts
import type { HarnessBridge } from '@shared/ipc'

declare global {
  interface Window {
    harness: HarnessBridge
  }
}
export {}
```

注意 preload 是 sandbox 下的 CJS，`@shared/ipc` 只用到常數與型別，會被打包進 preload（`out/preload/index.cjs` 只 `require("electron")`）。模板的 `@electron-toolkit/preload` 不再使用：`npm uninstall @electron-toolkit/preload`。

**Step 9: 驗證**

Run: `npx vitest run tests/main/ipcGuards.test.ts tests/main/blockHtml.test.ts` → 68 passed
Run: `npx vitest run tests/main/taskManager.test.ts tests/main/verifyRunner.test.ts` → 60 passed（含 5 個 shutdown 測試、4 個中止驗證指令的測試）
Run: `npm test`、`npm run typecheck`、`npm run lint`（0 errors）
Run: `npx electron-vite build` → `out/preload/index.cjs` 只 require `electron`
Run: `npm run dev` → 視窗正常開啟；在 DevTools Console 執行 `await window.harness.invoke('claude:status')` → 回傳 `{ found: true, loggedIn: true, subscriptionType: 'max', ... }`；`await window.harness.invoke('tasks:list')` → `[]`；`await window.harness.invoke('tasks:timeline', '../x')` → 拒絕（無效的任務 id）；`window.electron` 為 `undefined`

**Step 10: Commit**

```bash
git add package.json package-lock.json src/main src/preload src/shared tests docs/plans
git commit -m "feat(main): wire IPC, sandboxed custom block protocol and preload bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Phase 4：Renderer（src/renderer/src）

**元件慣例：**
- 元件以 selector 訂閱 store（`useStore((s) => s.x)`，要多個欄位時用 `useStore(useShallow((s) => ({ ... })))`，`useShallow` 來自 `zustand/react/shallow`）；action 個別選取（`const act = useStore((s) => s.act)`）。**不要呼叫沒有 selector 的 `useStore()`**，否則任何狀態變動都會讓元件重繪。
- 不在 effect 裡同步 setState（react-hooks 7 的 `set-state-in-effect` 是 error）：需要「依某個值重置」的狀態，存成「選擇 + 它所屬的鍵」，畫面上的值在 render 時推導（例如 `picked?.key === key ? picked.value : 預設值`），或用 `key` 讓元件重建。

畫面樣式以 `docs/design/*.dc.html` 為準：每個元件的間距、圓角、字級對照設計稿的 inline style，顏色只用 Task 2 的 tokens。下列程式碼已依設計稿換算成 Tailwind class。

### Task 26：API 封裝、全域 store、階段工具

**Files:**
- Create: `src/renderer/src/api.ts`
- Create: `src/renderer/src/store.ts`
- Create: `src/renderer/src/lib/stage.ts`
- Create: `src/renderer/src/lib/ime.ts`（輸入法選字中的 Enter／Esc：不送出、不儲存、不關閉）
- Create: `src/renderer/src/components/ui.tsx`
- Modify: `src/renderer/src/styles/app.css`（補 `line-strong`、`brand-halo`、`review-soft`、`danger-soft` 四個 token，取代 Tailwind 預設色）
- Test: `tests/renderer/stage.test.ts`、`tests/renderer/store.test.ts`、`tests/renderer/api.test.ts`、`tests/renderer/ime.test.ts`

**Step 1: 寫失敗測試**

```ts
// tests/renderer/stage.test.ts
import { describe, expect, test } from 'vitest'
import { currentStage, reachable, taskStatusLabel } from '@renderer/lib/stage'
import { makeTask } from '../fixtures/task'

describe('stage', () => {
  test('依狀態決定目前階段', () => {
    expect(currentStage(makeTask({ status: 'clarifying' }))).toBe('clarify')
    expect(currentStage(makeTask({ status: 'spec_review' }))).toBe('spec')
    expect(currentStage(makeTask({ status: 'implementing' }))).toBe('implement')
    expect(currentStage(makeTask({ status: 'reviewing' }))).toBe('report')
    expect(currentStage(makeTask({ status: 'discarded', specs: [] }))).toBe('clarify')
  })

  test('可回看已經過的階段；有報告時實作中也能看報告', () => {
    const t = makeTask({ status: 'implementing', reportVersions: [1] })
    expect(reachable(t, 'clarify')).toBe(true)
    expect(reachable(t, 'report')).toBe(true)
    expect(reachable(makeTask({ status: 'clarifying' }), 'spec')).toBe(false)
  })

  test('側欄狀態文字', () => {
    expect(taskStatusLabel(makeTask({ runState: 'waiting_permission' })).text).toBe('等你核准指令')
    expect(
      taskStatusLabel(
        makeTask({
          status: 'implementing',
          plan: [
            { id: 's1', title: 'a', status: 'done' },
            { id: 's2', title: 'b', status: 'running' }
          ]
        })
      ).text
    ).toBe('實作中 · 1/2')
    expect(taskStatusLabel(makeTask({ status: 'reviewing', reportVersions: [1, 2] })).text).toBe(
      '待審閱報告 · v2'
    )
    expect(
      taskStatusLabel(
        makeTask({
          questions: [
            {
              id: 'q1',
              text: '?',
              options: [],
              allowFreeText: true,
              status: 'answered',
              followups: [],
              askedAt: ''
            },
            {
              id: 'q2',
              text: '?',
              options: [],
              allowFreeText: true,
              status: 'open',
              followups: [],
              askedAt: ''
            }
          ]
        })
      ).text
    ).toBe('釐清中 · 問題 2')
  })
})
```

```ts
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
```

```ts
// tests/renderer/api.test.ts
import { describe, expect, test } from 'vitest'
import { errorText } from '@renderer/api'

describe('errorText', () => {
  test('去掉 Electron 加上的 remote method 前綴', () => {
    expect(
      errorText(new Error("Error invoking remote method 'tasks:create': Error: 無效的需求"))
    ).toBe('無效的需求')
    expect(errorText(new Error('一般錯誤'))).toBe('一般錯誤')
    expect(errorText('字串')).toBe('字串')
  })
})
```

```ts
// tests/renderer/ime.test.ts
import { describe, expect, test, vi } from 'vitest'
import { blockImeSubmit, isComposing, isImeEnter } from '@renderer/lib/ime'

/** React 鍵盤事件裡用到的欄位 */
const keyEvent = (key: string, native: { isComposing?: boolean; keyCode?: number } = {}) => ({
  key,
  nativeEvent: { isComposing: native.isComposing ?? false, keyCode: native.keyCode ?? 0 },
  preventDefault: vi.fn()
})

describe('ime', () => {
  test('輸入法組字中的按鍵：isComposing，或 compositionend 先到時只剩 keyCode 229', () => {
    expect(isComposing(keyEvent('Enter', { isComposing: true }))).toBe(true)
    expect(isComposing(keyEvent('Enter', { keyCode: 229 }))).toBe(true)
    expect(isComposing(keyEvent('Enter', { keyCode: 13 }))).toBe(false)
  })

  test('isImeEnter 只認組字中的 Enter', () => {
    expect(isImeEnter(keyEvent('Enter', { isComposing: true }))).toBe(true)
    expect(isImeEnter(keyEvent('Escape', { isComposing: true }))).toBe(false)
    expect(isImeEnter(keyEvent('Enter'))).toBe(false)
  })

  test('blockImeSubmit 只取消組字中 Enter 的預設動作（表單不會隱式送出）', () => {
    const composing = keyEvent('Enter', { keyCode: 229 })
    blockImeSubmit(composing)
    expect(composing.preventDefault).toHaveBeenCalled()
    const normal = keyEvent('Enter', { keyCode: 13 })
    blockImeSubmit(normal)
    expect(normal.preventDefault).not.toHaveBeenCalled()
  })
})
```

**Step 2: 確認失敗** — `npx vitest run tests/renderer` → FAIL

**Step 3: api.ts**

```ts
// src/renderer/src/api.ts
import type { AppEvent, IpcApi, IpcChannel } from '@shared/ipc'

export function call<C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>) {
  return window.harness.invoke(channel, ...args)
}

export function onEvent(cb: (e: AppEvent) => void) {
  return window.harness.onEvent(cb)
}

/** 主程序丟出的錯誤會被包成 `Error invoking remote method '<channel>': Error: <訊息>`，只留訊息 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
```

**Step 4: store.ts**

```ts
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
  feedback: Record<string, FeedbackItem[]>
  /** id 每次遞增：同樣的錯誤再出現一次也會重新計時 */
  toast?: { id: number; text: string }
  /** 訂閱主程序事件並載入初始資料；回傳取消訂閱（給 useEffect 的 cleanup 用） */
  init(): () => void
  apply(e: AppEvent): void
  open(view: View): Promise<void>
  act<T>(fn: () => Promise<T>): Promise<T | undefined>
  setActiveBranch(taskId: string, branchId?: string): void
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
```

`store.init()` 同步訂閱事件、回傳取消訂閱函式，資料在背景載入（App 的 `useEffect` 直接回傳它當 cleanup，StrictMode 重跑時不會重複訂閱）；載入失敗時仍設 `ready` 並顯示 toast。`open()` 讀時間軸失敗時走 `act` 顯示 toast。視窗重新取得焦點（`window` 的 `focus`）時，若 Claude Code 未就緒就以 `claude:status(true)` 重新偵測，最多每 5 秒一次（`recheckClaude`），使用者到終端機登入後回來不必手動按「重新檢查」；init 回傳的 cleanup 也會移除這個監聽。`open()` 讀取時間軸期間收到的即時事件先暫存，快照回來後接在後面（以 id 去重、保持順序）；同一任務讀取中不會重複讀取。初始快照與載入期間從事件收到的任務合併，同一任務保留 `updatedAt` 較新的。每份時間軸的事件 id 以 `WeakMap<陣列, Set>` 快取來去重。`toast` 是 `{ id, text }`，同樣的錯誤再出現也會重新計時。`resetStoreInternals()` 給測試清掉節流與讀取中狀態。

**Step 5: lib/stage.ts 與 lib/ime.ts**

```ts
// src/renderer/src/lib/stage.ts
import type { Task } from '@shared/types'
import type { Tone } from '../components/ui'

export type Stage = 'clarify' | 'spec' | 'implement' | 'report'
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'clarify', label: '釐清' },
  { id: 'spec', label: '規格' },
  { id: 'implement', label: '實作' },
  { id: 'report', label: '報告' }
]
const ORDER: Stage[] = ['clarify', 'spec', 'implement', 'report']

export function currentStage(t: Task): Stage {
  switch (t.status) {
    case 'clarifying':
      return 'clarify'
    case 'spec_review':
      return 'spec'
    case 'implementing':
      return 'implement'
    case 'reviewing':
    case 'done':
      return 'report'
    case 'discarded':
      return t.reportVersions.length
        ? 'report'
        : t.plan.length
          ? 'implement'
          : t.specs.length
            ? 'spec'
            : 'clarify'
  }
}

export function reachable(t: Task, s: Stage): boolean {
  if (s === 'report') return t.reportVersions.length > 0
  return ORDER.indexOf(s) <= ORDER.indexOf(currentStage(t))
}

export function taskStatusLabel(t: Task): { text: string; tone: Tone } {
  if (t.runState === 'waiting_permission') return { text: '等你核准指令', tone: 'progress' }
  if (t.runState === 'error') return { text: '發生錯誤', tone: 'danger' }
  if (t.runState === 'interrupted') return { text: '已中斷', tone: 'danger' }
  switch (t.status) {
    case 'clarifying': {
      const idx = t.questions.findIndex((q) => q.status === 'open')
      return {
        text: `釐清中 · 問題 ${idx >= 0 ? idx + 1 : Math.max(1, t.questions.length)}`,
        tone: 'brand'
      }
    }
    case 'spec_review':
      return { text: '規格待核准', tone: 'brand' }
    case 'implementing': {
      if (t.runState === 'finalizing') return { text: '整理報告中', tone: 'progress' }
      const done = t.plan.filter((s) => s.status === 'done').length
      return {
        text: t.plan.length ? `實作中 · ${done}/${t.plan.length}` : '實作中',
        tone: 'progress'
      }
    }
    case 'reviewing':
      return { text: `待審閱報告 · v${t.reportVersions.at(-1)}`, tone: 'review' }
    case 'done':
      return { text: t.prUrl ? '已開 PR' : '已合併', tone: 'muted' }
    case 'discarded':
      return { text: '已丟棄', tone: 'muted' }
  }
}
```

使用者用注音等輸入法打中文：之後所有「按 Enter 送出」的輸入框（Composer、分岔、反問、修改意見、留言、設定頁）都用這裡的判斷，選字時的 Enter／Esc 不送出、不儲存、不關閉。

```ts
// src/renderer/src/lib/ime.ts
// 使用者用注音、倉頡等輸入法打中文：選字時的按鍵屬於「組字」——Enter 是確認候選字、
// Esc 是取消組字，不能拿來送出表單、儲存或關閉輸入框。
import type { KeyboardEvent } from 'react'

type KeyLike = Pick<KeyboardEvent, 'key'> & {
  nativeEvent: Pick<globalThis.KeyboardEvent, 'isComposing' | 'keyCode'>
}

/**
 * 這個按鍵是否屬於輸入法組字。組字中的 keydown 帶 isComposing；
 * 有些情況（例如 compositionend 比 keydown 先到）isComposing 已是 false，但 keyCode 仍是 229。
 */
export const isComposing = (e: KeyLike) =>
  e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229

/** 輸入法確認候選字的 Enter */
export const isImeEnter = (e: KeyLike) => e.key === 'Enter' && isComposing(e)

/**
 * 給「按 Enter 隱式送出」的表單輸入框用的 onKeyDown：
 * 選字中的 Enter 取消預設動作，表單不會被送出。
 */
export function blockImeSubmit(e: KeyLike & Pick<KeyboardEvent, 'preventDefault'>) {
  if (isImeEnter(e)) e.preventDefault()
}
```

**Step 6: components/ui.tsx**

先安裝 `npm i tailwind-merge`：`cx` 用它合併 class，呼叫端傳入的 className 才能可靠地覆蓋元件預設值（Tailwind 產生的 CSS 順序不看 class 先後，例如 `text-[13px]` 和 `text-sm` 同時存在時誰贏不一定）。檔案同時匯出非元件（`cx`、`Icons` 等），以檔頭註解關閉 `react-refresh/only-export-components`。

```tsx
// src/renderer/src/components/ui.tsx
// 共用的 UI 元件與樣式常數。這裡同時匯出 cx／TONE_TEXT／Icons 等非元件，
// 改這個檔時 Vite 會整頁重新載入而不是 fast refresh，換來各畫面只需一個 import 來源。
/* eslint-disable react-refresh/only-export-components */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, SVGProps } from 'react'
import { extendTailwindMerge } from 'tailwind-merge'

// 讓呼叫端傳入的 className 能覆蓋元件預設的 class（例如 Button 的 h-11 被 h-[42px] 取代）。
// Tailwind 產生的 CSS 順序不看 class 寫的先後，同一屬性的兩個 class 誰贏不一定，所以要先合併掉。
const twMerge = extendTailwindMerge({
  extend: { theme: { shadow: ['card', 'raised', 'focus', 'tab', 'dialog'] } }
})
export const cx = (...c: (string | false | null | undefined)[]) =>
  twMerge(c.filter(Boolean).join(' '))

type Variant = 'primary' | 'secondary' | 'dark' | 'ghost' | 'danger'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white font-medium hover:bg-brand-hover',
  secondary: 'bg-fill text-ink-2 hover:bg-chip',
  dark: 'bg-ink text-white font-medium hover:bg-ink-2',
  ghost: 'bg-transparent text-ink-2 hover:bg-fill',
  danger: 'bg-transparent text-danger hover:bg-danger-soft'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-9 rounded-[10px] px-3 text-xs' : 'h-11 rounded-xl px-4 text-[13px]',
        VARIANTS[variant],
        className
      )}
      {...p}
    />
  )
}

export function Panel({ className, ...p }: HTMLAttributes<HTMLElement>) {
  return <section className={cx('rounded-2xl bg-surface shadow-card', className)} {...p} />
}

export type Tone = 'neutral' | 'brand' | 'decision' | 'progress' | 'review' | 'danger' | 'muted'
const TONES: Record<Tone, string> = {
  neutral: 'bg-fill text-ink-2',
  brand: 'bg-brand-soft text-brand-ink',
  decision: 'bg-decision text-decision-ink',
  progress: 'bg-decision text-progress',
  review: 'bg-review-soft text-review',
  danger: 'bg-danger-soft text-danger',
  muted: 'bg-fill text-muted'
}
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-2',
  brand: 'text-brand',
  decision: 'text-decision-ink',
  progress: 'text-progress',
  review: 'text-review',
  danger: 'text-danger',
  muted: 'text-muted'
}

export function Pill({
  tone = 'neutral',
  className,
  children
}: {
  tone?: Tone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="處理中"
      className={cx(
        'inline-block size-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent',
        className
      )}
    />
  )
}

export function Avatar() {
  return (
    <span
      aria-hidden
      className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand"
    >
      C
    </span>
  )
}

export const inputClass =
  'h-[42px] rounded-xl border border-line bg-surface px-3.5 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-brand'
export const textareaClass =
  'rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-muted-2 focus:border-brand'

type IconProps = SVGProps<SVGSVGElement>
const svg = (p: IconProps, children: ReactNode) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...p}
  >
    {children}
  </svg>
)
export const Icons = {
  Plus: (p: IconProps) => svg(p, <path d="M12 5v14M5 12h14" />),
  Check: (p: IconProps) => svg(p, <path d="M5 12l5 5L20 7" />),
  Branch: (p: IconProps) =>
    svg(
      p,
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="7" r="2" />
        <path d="M6 7v10M18 9c0 5-6 4-12 8" />
      </>
    ),
  Send: (p: IconProps) => svg(p, <path d="M12 19V5M5 12l7-7 7 7" />),
  Stop: (p: IconProps) =>
    svg(p, <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />),
  Arrow: (p: IconProps) => svg(p, <path d="M5 12h14M13 6l6 6-6 6" />),
  Back: (p: IconProps) => svg(p, <path d="M15 6l-6 6 6 6" />),
  Folder: (p: IconProps) =>
    svg(p, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  Info: (p: IconProps) =>
    svg(
      p,
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </>
    ),
  Comment: (p: IconProps) =>
    svg(p, <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />),
  X: (p: IconProps) => svg(p, <path d="M6 6l12 12M18 6L6 18" />)
}
```

**Step 7: 確認通過** — `npx vitest run tests/renderer` → 全部通過；`npm run typecheck` PASS

**Step 8: Commit**

```bash
git add src/renderer/src tests/renderer
git commit -m "feat(ui): add api bridge, global store, stage helpers and ui primitives

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 27：App 外框、側欄、階段切換、Markdown、Toast

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/components/Sidebar.tsx`、`StageNav.tsx`、`Markdown.tsx`、`Toast.tsx`
- Create: `src/renderer/src/screens/TaskScreen.tsx`（暫時只顯示標題，後續 Task 填入各階段）
- Modify: `src/renderer/src/styles/app.css`（`@layer base` 補設計稿的全域連結色）、`tests/renderer/setup.ts`（每個測試後 `cleanup`）
- Test: `tests/renderer/shell.test.tsx`

**Step 0: 寫測試（先失敗）**

```tsx
// tests/renderer/shell.test.tsx
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => null),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import App from '@renderer/App'
import { Markdown } from '@renderer/components/Markdown'
import { Sidebar } from '@renderer/components/Sidebar'
import { Toast } from '@renderer/components/Toast'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

const repos = [
  { id: 'r1', name: 'shop-api', path: '/Users/me/shop-api', addedAt: '' },
  { id: 'r2', name: 'web-dashboard', path: '/Users/me/web', addedAt: '' }
]

const realInit = useStore.getState().init

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({
    init: realInit,
    ready: true,
    repos,
    tasks: {},
    timelines: {},
    view: { kind: 'new' },
    toast: undefined,
    claude: { found: true, loggedIn: true },
    settings: {
      defaultModel: 'claude-opus-5-5',
      worktreeRoot: '/wt',
      branchPrefix: 'harness/',
      alwaysAllowedCommands: [],
      loadProjectSettings: false
    }
  })
})

describe('Sidebar', () => {
  const tasks = {
    a: makeTask({
      id: 'a',
      repoId: 'r1',
      title: '登入失敗鎖定',
      createdAt: '2026-10-07T02:00:00Z'
    }),
    b: makeTask({
      id: 'b',
      repoId: 'r2',
      title: '匯出 CSV',
      status: 'reviewing',
      reportVersions: [1],
      createdAt: '2026-10-07T01:00:00Z'
    }),
    c: makeTask({ id: 'c', repoId: 'r2', title: '修正時區', createdAt: '2026-10-07T00:00:00Z' }),
    gone: makeTask({ id: 'gone', repoId: 'r1', title: '已丟棄的任務', status: 'discarded' })
  }

  test('展開目前任務所在的 repo，其他 repo 收合只顯示數量', () => {
    useStore.setState({ tasks, view: { kind: 'task', taskId: 'a' } })
    render(<Sidebar />)
    const shop = screen.getByRole('button', { name: /shop-api/ })
    const web = screen.getByRole('button', { name: /web-dashboard/ })
    expect(shop).toHaveAttribute('aria-expanded', 'true')
    expect(web).toHaveAttribute('aria-expanded', 'false')
    expect(web).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: /登入失敗鎖定/ })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByText('釐清中 · 問題 1')).toBeInTheDocument()
    expect(screen.queryByText('匯出 CSV')).not.toBeInTheDocument()
    expect(screen.queryByText('已丟棄的任務')).not.toBeInTheDocument()
  })

  test('點 repo 標題展開，點任務切換畫面', async () => {
    useStore.setState({ tasks, view: { kind: 'task', taskId: 'a' } })
    render(<Sidebar />)
    await userEvent.click(screen.getByRole('button', { name: /web-dashboard/ }))
    expect(screen.getByText('待審閱報告 · v1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /匯出 CSV/ }))
    expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'b' })
    expect(call).toHaveBeenCalledWith('tasks:timeline', 'b')
  })

  test('新任務、加入 repo、設定', async () => {
    useStore.setState({ tasks, view: { kind: 'task', taskId: 'a' } })
    render(<Sidebar />)
    await userEvent.click(screen.getByRole('button', { name: '加入 repo' }))
    expect(call).toHaveBeenCalledWith('repos:pick')
    await userEvent.click(screen.getByRole('button', { name: /設定/ }))
    expect(useStore.getState().view).toEqual({ kind: 'settings' })
    await userEvent.click(screen.getByRole('button', { name: '新任務' }))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
  })

  test('底部顯示 Claude Code 狀態', () => {
    const { rerender } = render(<Sidebar />)
    expect(screen.getByRole('button', { name: /設定/ })).toHaveTextContent('Opus 5.5 · 訂閱方案')
    act(() => useStore.setState({ claude: { found: false, loggedIn: false } }))
    rerender(<Sidebar />)
    expect(screen.getByRole('button', { name: /設定/ })).toHaveTextContent('Claude Code 未就緒')
  })
})

describe('Sidebar 焦點', () => {
  test('焦點換到手動收合的 repo 裡的任務時，那個 repo 重新展開', async () => {
    useStore.setState({
      tasks: {
        a: makeTask({ id: 'a', repoId: 'r1', title: '任務 A', createdAt: '2026-10-07T02:00:00Z' }),
        b: makeTask({ id: 'b', repoId: 'r2', title: '任務 B', createdAt: '2026-10-07T01:00:00Z' })
      },
      view: { kind: 'task', taskId: 'a' }
    })
    render(<Sidebar />)
    const web = screen.getByRole('button', { name: /web-dashboard/ })
    await userEvent.click(web) // 展開 r2
    await userEvent.click(web) // 再手動收合 r2
    expect(web).toHaveAttribute('aria-expanded', 'false')
    act(() => useStore.setState({ view: { kind: 'task', taskId: 'b' } }))
    expect(screen.getByRole('button', { name: /web-dashboard/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: /任務 B/ })).toHaveAttribute('aria-current', 'page')
  })
})

describe('TaskScreen / StageNav', () => {
  const stage = (name: RegExp) =>
    within(screen.getByRole('navigation', { name: '任務階段' })).getByRole('button', { name })

  test('可回看已經過的階段；狀態改變時回到目前階段', async () => {
    useStore.setState({ tasks: { a: makeTask({ id: 'a', status: 'spec_review' }) } })
    render(<TaskScreen taskId="a" />)
    expect(stage(/規格/)).toHaveAttribute('aria-current', 'step')
    expect(stage(/規格/)).toHaveAttribute('aria-pressed', 'true')
    expect(stage(/實作/)).toBeDisabled()
    await userEvent.click(stage(/釐清/))
    expect(stage(/釐清/)).toHaveAttribute('aria-pressed', 'true')
    expect(stage(/規格/)).toHaveAttribute('aria-pressed', 'false')
    expect(stage(/規格/)).toHaveAttribute('aria-current', 'step')
    act(() => useStore.setState({ tasks: { a: makeTask({ id: 'a', status: 'implementing' }) } }))
    expect(stage(/實作/)).toHaveAttribute('aria-pressed', 'true')
  })

  test('App 換任務時回到該任務的目前階段', async () => {
    useStore.setState({
      init: () => () => {},
      tasks: {
        a: makeTask({ id: 'a', repoId: 'r1', title: '任務 A', status: 'spec_review' }),
        b: makeTask({ id: 'b', repoId: 'r1', title: '任務 B', status: 'spec_review' })
      },
      timelines: { a: [], b: [] },
      view: { kind: 'task', taskId: 'a' }
    })
    render(<App />)
    expect(screen.getByText('shop-api · 任務 A')).toBeInTheDocument()
    await userEvent.click(stage(/釐清/))
    expect(stage(/釐清/)).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: /任務 B/ }))
    expect(screen.getByText('shop-api · 任務 B')).toBeInTheDocument()
    expect(stage(/規格/)).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Toast', () => {
  test('顯示錯誤，可關閉，8 秒後自動消失；同樣的錯誤再出現會重新計時', () => {
    vi.useFakeTimers()
    try {
      act(() => useStore.getState().showToast('出錯了'))
      render(<Toast />)
      expect(screen.getByRole('alert')).toHaveTextContent('出錯了')
      act(() => vi.advanceTimersByTime(6000))
      act(() => useStore.getState().showToast('出錯了'))
      act(() => vi.advanceTimersByTime(6000))
      expect(screen.getByRole('alert')).toHaveTextContent('出錯了')
      act(() => vi.advanceTimersByTime(2000))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      act(() => useStore.getState().showToast('又出錯了'))
      act(() => screen.getByRole('button', { name: '關閉' }).click())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Markdown', () => {
  test('連結交給系統瀏覽器開啟', async () => {
    render(<Markdown text={'看 [文件](https://example.com) 與 `code`'} />)
    await userEvent.click(screen.getByRole('link', { name: '文件' }))
    expect(call).toHaveBeenCalledWith('shell:openExternal', 'https://example.com')
    expect(screen.getByText('code').tagName).toBe('CODE')
  })

  test('不渲染原始 HTML，javascript: 連結失效', async () => {
    const { container } = render(
      <Markdown
        text={
          '<img src="x" onerror="alert(1)"><script>alert(2)</script>\n\n[點我](javascript:alert(3))'
        }
      />
    )
    expect(container.querySelector('img, script')).toBeNull()
    const link = screen.getByText('點我')
    expect(link.getAttribute('href') ?? '').not.toMatch(/javascript:/i)
    await userEvent.click(link)
    expect(call).not.toHaveBeenCalled()
  })
})
```

側欄依設計稿：目前任務所在的 repo（沒有打開任務時是最新任務的 repo）展開、粗體、徽章為品牌色；其他 repo 收合只顯示任務數，點標題可展開／收合（`aria-expanded`）。焦點換到另一個任務時，清掉該任務所在 repo 的手動收合（render 期間比對前一個焦點來調整 state）。StageNav 是 `<nav>` 裡的按鈕：`aria-current="step"` 標目前階段、`aria-pressed` 標正在顯示的階段，陰影用 `shadow-tab` token。TaskScreen 的「回看階段」以 `taskId:status` 為鍵記在 state 裡，換任務或狀態前進時自然回到目前階段（不在 effect 裡 setState，符合 react-hooks 7 的 `set-state-in-effect`）。

**Step 1: Markdown.tsx**

```tsx
// src/renderer/src/components/Markdown.tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { call } from '../api'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 [&_:is(h1,h2,h3,h4)]:m-0 [&_:is(h1,h2,h3,h4)]:font-bold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:m-0 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                // 不在 app 視窗裡導覽；https 連結由主程序交給系統瀏覽器
                e.preventDefault()
                if (href) void call('shell:openExternal', href)
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-xl bg-code p-3 text-[12.5px] text-code-ink [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-code-ink">
              {children}
            </pre>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
```

**Step 2: Sidebar.tsx（對照 `docs/design/StyleB.dc.html` 的 `<nav>`）**

```tsx
// src/renderer/src/components/Sidebar.tsx
// 對照 docs/design/StyleB.dc.html、B1-NewTask.dc.html 的 <nav>
import { useState } from 'react'
import { MODELS, type Task } from '@shared/types'
import { call } from '../api'
import { taskStatusLabel } from '../lib/stage'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { Button, cx, Icons, TONE_TEXT } from './ui'

function RepoBadge({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex size-[22px] flex-none items-center justify-center rounded-md text-[11px]',
        active ? 'bg-brand-soft text-brand' : 'bg-chip text-muted'
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function TaskItem({ task, active, onClick }: { task: Task; active: boolean; onClick: () => void }) {
  const s = taskStatusLabel(task)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex cursor-pointer flex-col rounded-xl px-3 py-2.5 text-left',
        active ? 'bg-surface shadow-raised' : 'hover:bg-surface/60'
      )}
    >
      <span className={cx('text-[13px]', active ? 'font-medium text-ink' : 'text-ink-2')}>
        {task.title}
      </span>
      <span className={cx('text-xs', TONE_TEXT[s.tone])}>{s.text}</span>
    </button>
  )
}

export function Sidebar() {
  const { repos, tasks, view, claude, settings } = useStore(
    useShallow((s) => ({
      repos: s.repos,
      tasks: s.tasks,
      view: s.view,
      claude: s.claude,
      settings: s.settings
    }))
  )
  const open = useStore((s) => s.open)
  const act = useStore((s) => s.act)
  // 使用者手動展開／收合過的 repo；沒動過的依「目前焦點」決定
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const list = Object.values(tasks)
    .filter((t) => t.status !== 'discarded')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const activeId = view.kind === 'task' ? view.taskId : undefined
  // 焦點任務：目前打開的任務，否則是最新的任務；它所在的 repo 預設展開
  const focus = list.find((t) => t.id === activeId) ?? list[0]
  const focusRepo = focus?.repoId
  // 焦點換到另一個任務時，清掉它所在 repo 的手動收合，讓那個 repo 一定看得到
  // （React 文件建議的「render 期間依前一個值調整 state」，不用 effect）
  const [prevFocus, setPrevFocus] = useState(focus?.id)
  if (prevFocus !== focus?.id) {
    setPrevFocus(focus?.id)
    if (focusRepo && focusRepo in toggled) {
      const rest = { ...toggled }
      delete rest[focusRepo]
      setToggled(rest)
    }
  }
  const model = MODELS.find((m) => m.id === settings?.defaultModel)?.label ?? ''
  return (
    <nav
      aria-label="Repo 與任務"
      className="flex w-[236px] flex-none flex-col gap-[18px] px-1.5 py-2"
    >
      <Button
        variant="primary"
        className={cx(
          'h-[42px] text-sm',
          view.kind === 'new' && 'shadow-[0_0_0_3px_var(--color-brand-halo)]'
        )}
        aria-current={view.kind === 'new' ? 'page' : undefined}
        onClick={() => void open({ kind: 'new' })}
      >
        <Icons.Plus />
        新任務
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto">
        {repos.map((r) => {
          const ts = list.filter((t) => t.repoId === r.id)
          const expanded = toggled[r.id] ?? r.id === focusRepo
          return (
            <div key={r.id} className="flex flex-col gap-1">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setToggled((s) => ({ ...s, [r.id]: !expanded }))}
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[13px]',
                  expanded ? 'font-bold text-ink' : 'text-ink-2'
                )}
              >
                <RepoBadge name={r.name} active={expanded} />
                <span className="min-w-0 truncate">{r.name}</span>
                {!expanded && ts.length > 0 && (
                  <span className="ml-auto text-xs text-muted-2">{ts.length}</span>
                )}
              </button>
              {expanded &&
                ts.map((t) => (
                  <TaskItem
                    key={t.id}
                    task={t}
                    active={t.id === activeId}
                    onClick={() => void open({ kind: 'task', taskId: t.id })}
                  />
                ))}
            </div>
          )
        })}
        <button
          type="button"
          className="flex h-10 flex-none cursor-pointer items-center gap-2 px-2.5 text-[13px] text-muted hover:text-ink"
          onClick={() => void act(() => call('repos:pick'))}
        >
          <Icons.Plus width={14} height={14} />
          加入 repo
        </button>
      </div>
      <button
        type="button"
        onClick={() => void open({ kind: 'settings' })}
        aria-current={view.kind === 'settings' ? 'page' : undefined}
        className="flex cursor-pointer items-center gap-2.5 rounded-xl bg-chip p-3 text-left text-xs text-ink-2"
      >
        <span
          aria-hidden
          className={cx('size-2 flex-none rounded-full', claude?.loggedIn ? 'bg-ok' : 'bg-danger')}
        />
        {claude?.loggedIn ? `${model} · 訂閱方案` : 'Claude Code 未就緒'}
        <span className="ml-auto text-muted">設定</span>
      </button>
    </nav>
  )
}
```

**Step 3: StageNav.tsx**

```tsx
// src/renderer/src/components/StageNav.tsx
import type { Task } from '@shared/types'
import { currentStage, reachable, type Stage, STAGES } from '../lib/stage'
import { cx } from './ui'

export function StageNav({
  task,
  shown,
  onSelect
}: {
  task: Task
  shown: Stage
  onSelect: (s: Stage) => void
}) {
  const current = currentStage(task)
  const order = STAGES.map((s) => s.id)
  return (
    <nav
      aria-label="任務階段"
      className="ml-auto flex items-center gap-1 rounded-full bg-fill p-1 text-xs"
    >
      {STAGES.map((s, i) => {
        const can = reachable(task, s.id)
        const passed = order.indexOf(s.id) < order.indexOf(current)
        return (
          <button
            key={s.id}
            type="button"
            // aria-current 標出任務目前所在的階段，aria-pressed 標出畫面正在顯示的階段
            aria-current={s.id === current ? 'step' : undefined}
            aria-pressed={shown === s.id}
            disabled={!can}
            onClick={() => onSelect(s.id)}
            className={cx(
              'rounded-full px-3 py-1 disabled:cursor-default',
              shown === s.id
                ? 'bg-surface font-medium text-brand shadow-tab'
                : can
                  ? 'cursor-pointer text-brand hover:bg-surface/60'
                  : 'text-muted-2'
            )}
          >
            {passed && shown !== s.id ? '✓' : i + 1} {s.label}
          </button>
        )
      })}
    </nav>
  )
}
```

**Step 4: Toast.tsx**

```tsx
// src/renderer/src/components/Toast.tsx
import { useEffect } from 'react'
import { useStore } from '../store'
import { Icons } from './ui'

export const TOAST_MS = 8000

export function Toast() {
  const toast = useStore((s) => s.toast)
  const dismissToast = useStore((s) => s.dismissToast)
  // 以 id 為依賴：同樣的錯誤再出現一次（新的 id）也會重新計時
  const id = toast?.id
  useEffect(() => {
    if (id === undefined) return
    const t = setTimeout(dismissToast, TOAST_MS)
    return () => clearTimeout(t)
  }, [id, dismissToast])
  if (!toast) return null
  return (
    <div
      role="alert"
      className="fixed right-5 bottom-5 z-50 flex max-w-md items-start gap-3 rounded-2xl bg-ink px-4 py-3 text-[13px] text-white shadow-dialog"
    >
      <span className="flex-1 whitespace-pre-wrap">{toast.text}</span>
      <button
        type="button"
        aria-label="關閉"
        onClick={dismissToast}
        className="mt-0.5 cursor-pointer text-white/70 hover:text-white"
      >
        <Icons.X width={14} height={14} />
      </button>
    </div>
  )
}
```

**Step 5: TaskScreen.tsx（骨架）**

```tsx
// src/renderer/src/screens/TaskScreen.tsx
import { useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  // 使用者回看的階段，只對選它時的任務與狀態有效；換任務或狀態前進就回到目前階段
  const [picked, setPicked] = useState<{ key: string; stage: Stage } | null>(null)
  if (!task) return null
  const key = `${taskId}:${task.status}`
  const current = currentStage(task)
  const shown = picked?.key === key ? picked.stage : current
  const nav = (
    <StageNav
      task={task}
      shown={shown}
      onSelect={(s) => setPicked(s === current ? null : { key, stage: s })}
    />
  )
  // Task 29–33 依 shown 切換到 ClarifyScreen / SpecScreen / ImplementScreen / ReportScreen
  return (
    <main className="flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
        <span className="text-lg font-bold">{task.title}</span>
        {nav}
      </div>
    </main>
  )
}
```

**Step 6: App.tsx**

```tsx
// src/renderer/src/App.tsx
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
import { TaskScreen } from './screens/TaskScreen'
import { type State, useStore } from './store'

/** 視窗用 hiddenInset 標題列：這一條是拖曳區，左側留給紅綠燈 */
function TitleBar({ title }: { title: string }) {
  return (
    <div className="drag flex h-11 flex-none items-center justify-center px-20 text-xs text-muted select-none">
      <span className="truncate">{title}</span>
    </div>
  )
}

/** 標題列文字（選出字串，任務其他欄位變動時不必重繪 App） */
function titleOf(s: State): string {
  if (s.view.kind === 'settings') return '設定'
  if (s.view.kind === 'new') return '新任務'
  const task = s.tasks[s.view.taskId]
  const repo = task && s.repos.find((r) => r.id === task.repoId)
  return [repo?.name, task?.title].filter(Boolean).join(' · ')
}

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const view = useStore((s) => s.view)
  const title = useStore(titleOf)
  useEffect(() => init(), [init])
  if (!ready)
    return (
      <div className="drag flex h-full items-center justify-center text-muted select-none">
        載入中…
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <TitleBar title={title} />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <Sidebar />
        <div className="flex min-w-0 flex-1 gap-3">
          {/* key：換任務時重建，回看階段等畫面狀態不會帶到下一個任務 */}
          {view.kind === 'task' && <TaskScreen key={view.taskId} taskId={view.taskId} />}
          {/* Task 28 加入 NewTaskScreen，Task 34 加入 SettingsScreen */}
        </div>
      </div>
      <Toast />
    </div>
  )
}
```

**Step 7: 驗證**

Run: `npx vitest run tests/renderer` → PASS
Run: `npm run typecheck` → PASS
Run: `npm run dev` → 左側欄出現「新任務」按鈕、「加入 repo」、底部 Claude 狀態；點「加入 repo」選一個 git 資料夾後出現在側欄。

**Step 8: Commit**

```bash
git add src/renderer/src tests/renderer
git commit -m "feat(ui): add app shell, sidebar, stage nav, markdown and toast

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 28：新任務畫面

**Files:**
- Create: `src/renderer/src/screens/NewTaskScreen.tsx`
- Create: `src/renderer/src/components/ClaudeBanner.tsx`
- Modify: `src/renderer/src/App.tsx`（`view.kind === 'new'` 時渲染 `<NewTaskScreen />`）
- Test: `tests/renderer/newTask.test.tsx`

**Step 0: 寫測試（先失敗）**

```tsx
// tests/renderer/newTask.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { NewTaskScreen } from '@renderer/screens/NewTaskScreen'
import { useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

const repos = [
  { id: 'r1', name: 'shop-api', path: '/Users/me/Github/shop-api', addedAt: '' },
  { id: 'r2', name: 'web-dashboard', path: '/Users/me/Github/web', addedAt: '' }
]
const branches: Record<string, { branches: string[]; current: string }> = {
  r1: { branches: ['main', 'develop'], current: 'develop' },
  r2: { branches: ['trunk'], current: 'trunk' },
  r3: { branches: ['main'], current: 'main' }
}
let replies: Record<string, (...args: never[]) => unknown>

beforeEach(() => {
  replies = {
    'repos:branches': (id: string) => branches[id],
    'tasks:create': () => makeTask({ id: 'new1' }),
    'tasks:timeline': () => [],
    'repos:pick': () => null,
    'claude:status': () => ({ found: true, loggedIn: true })
  }
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string, ...args: never[]) =>
    replies[ch](...args)) as typeof call)
  useStore.setState({
    ready: true,
    repos,
    tasks: {},
    timelines: {},
    view: { kind: 'new' },
    toast: undefined,
    claude: { found: true, loggedIn: true },
    settings: {
      defaultModel: 'claude-sonnet-5-5',
      worktreeRoot: '/wt',
      branchPrefix: 'harness/',
      alwaysAllowedCommands: [],
      loadProjectSettings: false
    }
  })
})

const start = () => screen.getByRole('button', { name: /開始釐清/ })

describe('NewTaskScreen', () => {
  test('預設選第一個 repo、目前分支與設定的預設模型', async () => {
    render(<NewTaskScreen />)
    expect(screen.getByRole('heading', { name: '想改什麼？' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /shop-api/ })).toBeChecked()
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('develop'))
    // 選取的 repo 卡片顯示路徑與目前分支（設計稿 B1）
    expect(screen.getByText('~/Github/shop-api · develop')).toBeInTheDocument()
    expect(screen.getByText('~/Github/web')).toBeInTheDocument()
    expect(screen.getByLabelText('模型')).toHaveValue('claude-sonnet-5-5')
    expect(start()).toBeDisabled()
  })

  test('填寫需求後建立任務並打開它', async () => {
    render(<NewTaskScreen />)
    await userEvent.click(screen.getByRole('radio', { name: /web-dashboard/ }))
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('trunk'))
    await userEvent.type(screen.getByLabelText('需求'), '加上登入失敗鎖定')
    await userEvent.selectOptions(screen.getByLabelText('模型'), 'claude-opus-5-5')
    await userEvent.click(start())
    expect(call).toHaveBeenCalledWith('tasks:create', {
      repoId: 'r2',
      request: '加上登入失敗鎖定',
      baseBranch: 'trunk',
      model: 'claude-opus-5-5'
    })
    await waitFor(() => expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'new1' }))
  })

  test('建立失敗時顯示錯誤並留在原畫面', async () => {
    replies['tasks:create'] = () => {
      throw new Error('尚未登入')
    }
    render(<NewTaskScreen />)
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('develop'))
    await userEvent.type(screen.getByLabelText('需求'), '需求')
    await userEvent.click(start())
    await waitFor(() => expect(useStore.getState().toast?.text).toContain('尚未登入'))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
    expect(start()).toBeEnabled()
  })

  test('沒有 repo 時無法開始；選擇資料夾後選取新加入的 repo', async () => {
    useStore.setState({ repos: [] })
    replies['repos:pick'] = () => {
      const r3 = { id: 'r3', name: 'new-repo', path: '/tmp/new-repo', addedAt: '' }
      useStore.setState({ repos: [...repos, r3] })
      return r3
    }
    render(<NewTaskScreen />)
    await userEvent.type(screen.getByLabelText('需求'), '需求')
    expect(start()).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /選擇其他資料夾/ }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /new-repo/ })).toBeChecked())
    await waitFor(() => expect(start()).toBeEnabled())
  })

  test('Claude Code 未登入時顯示提示並停用開始', async () => {
    useStore.setState({ claude: { found: true, loggedIn: false, error: '尚未登入 Claude Code' } })
    render(<NewTaskScreen />)
    await userEvent.type(screen.getByLabelText('需求'), '需求')
    expect(screen.getByRole('alert')).toHaveTextContent('尚未登入 Claude Code')
    expect(start()).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    expect(call).toHaveBeenCalledWith('claude:status', true)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    await waitFor(() => expect(start()).toBeEnabled())
  })

  test('切換 repo 後，上一個 repo 較慢回來的分支不會蓋掉目前的', async () => {
    let slowReply!: (v: { branches: string[]; current: string }) => void
    replies['repos:branches'] = (id: string) =>
      id === 'r1' ? new Promise((r) => (slowReply = r)) : branches[id]
    render(<NewTaskScreen />)
    await userEvent.click(screen.getByRole('radio', { name: /web-dashboard/ }))
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('trunk'))
    slowReply({ branches: ['main', 'old'], current: 'old' })
    await new Promise((r) => setTimeout(r, 0))
    const select = screen.getByLabelText('從哪個分支開始')
    expect(select).toHaveValue('trunk')
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(['trunk'])
  })

  test('重新檢查進行中時按鈕停用', async () => {
    useStore.setState({ claude: { found: true, loggedIn: false, error: '尚未登入 Claude Code' } })
    let done!: (v: unknown) => void
    replies['claude:status'] = () => new Promise((r) => (done = r))
    render(<NewTaskScreen />)
    await userEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    expect(screen.getByRole('button', { name: '檢查中…' })).toBeDisabled()
    done({ found: true, loggedIn: false, error: '還是沒登入' })
    await waitFor(() => expect(screen.getByRole('button', { name: '重新檢查' })).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent('還是沒登入')
  })
})
```

選取的 repo、分支清單與分支選擇都以「是哪個 repo 的」為鍵存在 state，畫面上的值由它們推導（不在 effect 裡同步 setState）：選的 repo 不在清單裡時用第一個；分支清單只對載入它的 repo 有效；目前分支不在清單裡（detached HEAD）時用第一個分支。沒有 repo 時顯示提示文字。

**Step 1: ClaudeBanner.tsx**（Claude Code 未就緒時顯示）

```tsx
// src/renderer/src/components/ClaudeBanner.tsx
// Claude Code 未就緒（找不到或未登入）時顯示；登入後按「重新檢查」更新狀態
import { useState } from 'react'
import { call } from '../api'
import { useStore } from '../store'
import { Button, Icons } from './ui'

export function ClaudeBanner() {
  const claude = useStore((s) => s.claude)
  const act = useStore((s) => s.act)
  const [checking, setChecking] = useState(false)
  if (claude?.loggedIn) return null
  const recheck = async () => {
    setChecking(true)
    await act(async () => useStore.setState({ claude: await call('claude:status', true) }))
    setChecking(false)
  }
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger"
    >
      <Icons.Info className="flex-none" />
      <span className="flex-1">{claude?.error ?? '正在檢查 Claude Code…'}</span>
      <Button size="sm" disabled={checking} onClick={() => void recheck()}>
        {checking ? '檢查中…' : '重新檢查'}
      </Button>
    </div>
  )
}
```

**Step 2: NewTaskScreen.tsx（對照 `docs/design/B1-NewTask.dc.html`）**

```tsx
// src/renderer/src/screens/NewTaskScreen.tsx
// 對照 docs/design/B1-NewTask.dc.html
import { useEffect, useState } from 'react'
import { MODELS, type ModelId } from '@shared/types'
import { call } from '../api'
import { ClaudeBanner } from '../components/ClaudeBanner'
import { Button, cx, Icons, inputClass, textareaClass } from '../components/ui'
import { useStore } from '../store'

/** 把家目錄縮寫成 ~，卡片上比較好讀 */
const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')

export function NewTaskScreen() {
  const repos = useStore((s) => s.repos)
  const defaultModel = useStore((s) => s.settings?.defaultModel)
  const loggedIn = useStore((s) => !!s.claude?.loggedIn)
  const act = useStore((s) => s.act)
  const open = useStore((s) => s.open)
  const [picked, setPicked] = useState<string>()
  const [request, setRequest] = useState('')
  const [branchInfo, setBranchInfo] = useState<{
    repoId: string
    branches: string[]
    current: string
  }>()
  const [baseChoice, setBaseChoice] = useState<{ repoId: string; value: string }>()
  const [model, setModel] = useState<ModelId>(defaultModel ?? 'claude-opus-5-5')
  const [busy, setBusy] = useState(false)

  // 選的 repo 不在清單裡（還沒選、或剛被移除）時用第一個
  const repoId = repos.some((r) => r.id === picked) ? picked : repos[0]?.id
  // 分支清單與選擇只對載入它的 repo 有效，切換 repo 時不會沿用上一個 repo 的分支
  const info = repoId && branchInfo?.repoId === repoId ? branchInfo : undefined
  const branches = info?.branches ?? []
  const choice = repoId && baseChoice?.repoId === repoId ? baseChoice.value : undefined
  // 目前分支不在清單裡（例如 detached HEAD）時用第一個分支
  const base =
    choice ?? (info && (branches.includes(info.current) ? info.current : branches[0])) ?? ''

  useEffect(() => {
    if (!repoId) return
    let live = true
    void act(async () => {
      const r = await call('repos:branches', repoId)
      if (live) setBranchInfo({ repoId, ...r })
    })
    return () => {
      live = false
    }
  }, [repoId, act])

  const ready = loggedIn && !!repoId && !!request.trim() && !!base && !busy

  const submit = async () => {
    if (!ready || !repoId) return
    setBusy(true)
    const task = await act(() => call('tasks:create', { repoId, request, baseBranch: base, model }))
    setBusy(false)
    if (task) await open({ kind: 'task', taskId: task.id })
  }

  const pickFolder = () =>
    void act(async () => {
      const r = await call('repos:pick')
      if (r) setPicked(r.id)
    })

  return (
    <main className="flex min-w-0 flex-1 flex-col items-center overflow-y-auto rounded-2xl bg-surface px-7 py-14 shadow-card">
      <div className="flex w-full max-w-[680px] flex-col gap-7">
        <ClaudeBanner />
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[26px] font-bold">想改什麼？</h1>
          <span className="text-muted">
            選一個 repo，用一兩句話描述需求。Claude 會先讀程式碼，再用問題跟你釐清細節。
          </span>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-[13px] font-medium">Repo</legend>
          {repos.length > 0 ? (
            <div className="grid grid-cols-2 gap-2.5">
              {repos.map((r) => {
                const on = repoId === r.id
                return (
                  <label
                    key={r.id}
                    className={cx(
                      'flex cursor-pointer items-center gap-3 rounded-[14px] p-3.5',
                      on ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2'
                    )}
                  >
                    <input
                      type="radio"
                      name="repo"
                      checked={on}
                      onChange={() => setPicked(r.id)}
                      className="accent-brand"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{r.name}</span>
                      <span
                        className={cx(
                          'truncate font-mono text-[11px]',
                          on ? 'text-brand-muted' : 'text-muted'
                        )}
                        title={r.path}
                      >
                        {shortPath(r.path)}
                        {on && info?.current ? ` · ${info.current}` : ''}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <span className="text-[13px] text-muted">還沒有加入 repo，先選一個 git 資料夾。</span>
          )}
          <button
            type="button"
            onClick={pickFolder}
            className="flex h-10 cursor-pointer items-center gap-2 self-start rounded-xl border border-dashed border-line-strong bg-surface px-3.5 text-[13px] text-ink-2 hover:bg-fill-2"
          >
            <Icons.Folder width={14} height={14} />
            選擇其他資料夾…
          </button>
        </fieldset>

        <label className="flex flex-col gap-2.5">
          <span className="text-[13px] font-medium">需求</span>
          <textarea
            rows={5}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="例如：登入 API 要加上失敗次數限制，連續失敗太多次就鎖帳號。"
            className={cx(
              textareaClass,
              'resize-y rounded-[14px] px-4 py-3.5 text-sm leading-[1.65]'
            )}
          />
        </label>

        <div className="flex flex-wrap gap-4">
          <label className="flex min-w-[200px] flex-1 flex-col gap-2">
            <span className="text-[13px] font-medium">從哪個分支開始</span>
            <select
              value={base}
              onChange={(e) => repoId && setBaseChoice({ repoId, value: e.target.value })}
              disabled={!branches.length}
              className={cx(inputClass, 'px-3 text-sm')}
            >
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[200px] flex-1 flex-col gap-2">
            <span className="text-[13px] font-medium">模型</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelId)}
              className={cx(inputClass, 'px-3 text-sm')}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}（{m.hint}）
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3 rounded-xl bg-fill-2 px-3.5 py-3 text-[13px] text-ink-2">
          <Icons.Info className="flex-none text-brand" />
          <span>
            Harness 會建立獨立的 git worktree。釐清階段 Claude 只會讀檔案；規格經你核准後，才會在
            worktree 裡改程式碼。
          </span>
        </div>

        <Button
          variant="primary"
          className="h-[46px] self-end px-6 text-sm"
          disabled={!ready}
          onClick={() => void submit()}
        >
          {busy ? '建立中…' : '開始釐清'}
          <Icons.Arrow />
        </Button>
      </div>
    </main>
  )
}
```

**Step 2.5: App.tsx** — 加上 `import { NewTaskScreen } from './screens/NewTaskScreen'`，內容區改為：

```tsx
          {view.kind === 'new' && <NewTaskScreen />}
          {/* key：換任務時重建，回看階段等畫面狀態不會帶到下一個任務 */}
          {view.kind === 'task' && <TaskScreen key={view.taskId} taskId={view.taskId} />}
          {/* Task 34 加入 SettingsScreen */}
```

**Step 3: 驗證**

Run: `npx vitest run tests/renderer` → PASS
Run: `npm run typecheck` → PASS
Run: `npm run dev` → 新任務畫面與設計稿一致；未加入 repo 時「開始釐清」為停用。

**Step 4: Commit**

```bash
git add src/renderer/src tests/renderer package.json package-lock.json
git commit -m "feat(ui): add new task screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 29：問題卡片與時間軸

**Files:**
- Create: `src/renderer/src/lib/timeline.ts`（工具摘要、使用者訊息的可讀文字、`useTimeline`）
- Create: `src/renderer/src/lib/usePending.ts`（按鈕觸發的 IPC 進行中狀態與防連點）
- Create: `src/renderer/src/components/QuestionCard.tsx`
- Create: `src/renderer/src/components/Timeline.tsx`
- Modify: `src/renderer/src/lib/stage.ts`（補 `isBusy`、`awaitingCounterReply`）
- Modify: `src/renderer/src/components/ui.tsx`（`Spinner` 加 `decorative`、新增常駐 live region `LiveStatus`）
- Modify: `src/renderer/src/components/Markdown.tsx`（`memo`，設定提到模組層級）
- Create: `tests/fixtures/hold.ts`（讓 mock 的下一次呼叫停在進行中）
- Test: `tests/renderer/QuestionCard.test.tsx`、`tests/renderer/Timeline.test.tsx`

**Step 1: 寫失敗測試**

```ts
// tests/fixtures/hold.ts
import { act } from '@testing-library/react'

/**
 * 讓 mock 的下一次呼叫停在進行中（測試 IPC 進行中的按鈕狀態與連點），
 * 回傳讓它完成的函式（包在 act 裡，完成後的狀態更新會套用到畫面）。
 */
export function holdNextCall(mock: { mockImplementationOnce: (impl: never) => unknown }) {
  let release: (v?: unknown) => void = () => {}
  const impl = () =>
    new Promise((r) => {
      release = r
    })
  mock.mockImplementationOnce(impl as never)
  return (value?: unknown) => act(async () => release(value))
}
```

```tsx
// tests/renderer/QuestionCard.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => ({ id: 'b1' })),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { AnsweredQuestionRow, QuestionCard } from '@renderer/components/QuestionCard'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Question } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const q: Question = {
  id: 'q3',
  text: '達到上限後要怎麼處理？',
  status: 'open',
  allowFreeText: true,
  askedAt: '',
  options: [
    { id: 'lock15', label: '鎖定 15 分鐘', description: '自動解除' },
    { id: 'email', label: 'email 重設才解鎖' }
  ],
  recommendedOptionId: 'lock15',
  followups: [
    { role: 'user', text: '會洩漏帳號嗎？' },
    { role: 'assistant', text: '一律回 429 就不會。' }
  ]
}
const task = makeTask({ questions: [q] })

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({ activeBranch: {}, toast: undefined })
})

describe('QuestionCard', () => {
  test('預設選建議選項，確認後送出答案', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.getByRole('radiogroup', { name: '達到上限後要怎麼處理？' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /鎖定 15 分鐘/ })).toBeChecked()
    expect(screen.getByText('建議')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /email/ }))
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: 'email',
      text: undefined
    })
  })

  test('Claude 對反問的回答以 Markdown 呈現', () => {
    const md: Question = {
      ...q,
      followups: [
        { role: 'user', text: '423 還是 429？' },
        { role: 'assistant', text: '**建議 429**\n\n- 搭配 `Retry-After`' }
      ]
    }
    render(<QuestionCard task={makeTask({ questions: [md] })} question={md} />)
    expect(screen.getByText('建議 429').tagName).toBe('STRONG')
    expect(screen.getByText('Retry-After').tagName).toBe('CODE')
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument()
  })

  test('選「其他」時送出自由文字', async () => {
    render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('radio', { name: /其他/ }))
    expect(screen.getByRole('button', { name: '確認答案' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: '自己描述' }), '鎖 30 分鐘')
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: undefined,
      text: '鎖 30 分鐘'
    })
  })

  test('選了的選項被 Claude 更新卡片時拿掉，就回到建議選項', async () => {
    const { rerender } = render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('radio', { name: /email/ }))
    expect(screen.getByRole('radio', { name: /email/ })).toBeChecked()
    const updated: Question = {
      ...q,
      options: [{ id: 'captcha', label: '改要求驗證碼' }, q.options[0]],
      recommendedOptionId: 'captcha'
    }
    rerender(<QuestionCard task={makeTask({ questions: [updated] })} question={updated} />)
    expect(screen.getByRole('radio', { name: /改要求驗證碼/ })).toBeChecked()
    expect(screen.queryByRole('radio', { name: /email/ })).not.toBeInTheDocument()
  })

  test('補充說明預設收起，按「＋ 補充說明」展開並移入焦點', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.queryByRole('textbox', { name: '補充說明' })).not.toBeInTheDocument()
    const reveal = screen.getByRole('button', { name: '＋ 補充說明' })
    expect(reveal).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(reveal)
    expect(screen.getByRole('textbox', { name: '補充說明' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: '＋ 補充說明' })).not.toBeInTheDocument()
  })

  test('選一般選項時可附補充說明，與「其他」的描述分開；有內容就保持展開', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.queryByRole('textbox', { name: '自己描述' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '＋ 補充說明' }))
    await userEvent.type(screen.getByRole('textbox', { name: '補充說明' }), '要寫稽核日誌')
    await userEvent.click(screen.getByRole('radio', { name: /其他/ }))
    expect(screen.queryByRole('textbox', { name: '補充說明' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '＋ 補充說明' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '自己描述' })).toHaveValue('')
    await userEvent.click(screen.getByRole('radio', { name: /鎖定 15 分鐘/ }))
    expect(screen.getByRole('textbox', { name: '補充說明' })).toHaveValue('要寫稽核日誌')
    expect(screen.getByRole('textbox', { name: '補充說明' })).not.toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: 'lock15',
      text: '要寫稽核日誌'
    })
  })

  test('Claude 改成不允許自由文字後，不送出之前打的補充說明', async () => {
    const { rerender } = render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('button', { name: '＋ 補充說明' }))
    await userEvent.type(screen.getByRole('textbox', { name: '補充說明' }), '要寫稽核日誌')
    const strict: Question = { ...q, allowFreeText: false }
    rerender(<QuestionCard task={makeTask({ questions: [strict] })} question={strict} />)
    expect(screen.queryByRole('textbox', { name: '補充說明' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '＋ 補充說明' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /其他/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', {
      optionId: 'lock15',
      text: undefined
    })
  })

  test('確認答案送出中停用，連點只送一次', async () => {
    const release = holdNextCall(vi.mocked(call))
    render(<QuestionCard task={task} question={q} />)
    const confirm = screen.getByRole('button', { name: '確認答案' })
    await userEvent.dblClick(confirm)
    expect(call).toHaveBeenCalledTimes(1)
    expect(confirm).toBeDisabled()
    await release()
    expect(confirm).toBeEnabled()
  })

  test('顯示反問紀錄並可再次反問', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.getByText('你反問了 1 次')).toBeInTheDocument()
    expect(screen.getByText('一律回 429 就不會。')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '反問' }), '那 IP 呢？{Enter}')
    expect(call).toHaveBeenCalledWith('tasks:counter', 't1', 'q3', '那 IP 呢？')
    expect(screen.getByRole('textbox', { name: '反問' })).toHaveValue('')
  })

  test('反問：輸入法選字中的 Enter 不送出', async () => {
    render(<QuestionCard task={task} question={q} />)
    const input = screen.getByRole('textbox', { name: '反問' })
    await userEvent.type(input, '那 IP 呢')
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
    expect(call).not.toHaveBeenCalledWith('tasks:counter', 't1', 'q3', '那 IP 呢')
    expect(input).toHaveValue('那 IP 呢')
  })

  test('反問送出後等待回答時，在常駐的 live region 顯示處理中', () => {
    const waiting: Question = {
      ...q,
      followups: [...q.followups, { role: 'user', text: '那 IP 呢？' }]
    }
    const { rerender } = render(<QuestionCard task={task} question={waiting} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('')
    rerender(<QuestionCard task={{ ...task, runState: 'running' }} question={waiting} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Claude 正在回答…')
    expect(screen.getByRole('textbox', { name: '反問' })).toBeDisabled()
  })

  test('升級成分岔並切到新分岔', async () => {
    render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('button', { name: '升級成分岔' }))
    expect(call).toHaveBeenCalledWith('branch:open', 't1', {
      title: '達到上限後要怎麼處理？',
      fromQuestionId: 'q3'
    })
    expect(useStore.getState().activeBranch.t1).toBe('b1')
  })

  test('升級成分岔進行中停用，連點只開一個', async () => {
    const release = holdNextCall(vi.mocked(call))
    render(<QuestionCard task={task} question={q} />)
    const upgrade = screen.getByRole('button', { name: '升級成分岔' })
    await userEvent.dblClick(upgrade)
    expect(call).toHaveBeenCalledTimes(1)
    expect(upgrade).toBeDisabled()
    await release({ id: 'b9' })
    expect(useStore.getState().activeBranch.t1).toBe('b9')
    expect(upgrade).toBeEnabled()
  })

  test('已經從這個問題分出分岔時，改成查看分岔', async () => {
    const withBranch = makeTask({
      questions: [q],
      branches: [
        {
          id: 'b4',
          title: '上限處理',
          fromQuestionId: 'q3',
          status: 'open',
          running: false,
          createdAt: ''
        }
      ]
    })
    render(<QuestionCard task={withBranch} question={q} />)
    expect(screen.queryByRole('button', { name: '升級成分岔' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '查看分岔' }))
    expect(useStore.getState().activeBranch.t1).toBe('b4')
    expect(call).not.toHaveBeenCalled()
  })

  test('Claude 執行中時停用操作', () => {
    render(<QuestionCard task={{ ...task, runState: 'running' }} question={q} />)
    expect(screen.getByRole('button', { name: '確認答案' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '升級成分岔' })).toBeDisabled()
  })

  test('唯讀時不能作答也沒有反問欄', () => {
    render(<QuestionCard task={task} question={q} readOnly />)
    expect(screen.getByRole('radio', { name: /鎖定 15 分鐘/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '確認答案' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '反問' })).not.toBeInTheDocument()
  })
})

describe('AnsweredQuestionRow', () => {
  test('只有自由文字的答案', () => {
    render(
      <AnsweredQuestionRow
        question={{ ...q, status: 'answered', answer: { text: '鎖 30 分鐘' } }}
      />
    )
    expect(screen.getByText('鎖 30 分鐘')).toBeInTheDocument()
  })

  test('顯示問題與答案（選項加補充）', () => {
    render(
      <AnsweredQuestionRow
        question={{ ...q, status: 'answered', answer: { optionId: 'lock15', text: '但要記錄' } }}
      />
    )
    expect(screen.getByText('達到上限後要怎麼處理？')).toBeInTheDocument()
    expect(screen.getByText('鎖定 15 分鐘；但要記錄')).toBeInTheDocument()
  })
})
```

```tsx
// tests/renderer/Timeline.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { RunStatus, Timeline } from '@renderer/components/Timeline'
import { toolSummary, userTextDisplay } from '@renderer/lib/timeline'
import { resetStoreInternals, useStore } from '@renderer/store'
import { BRANCH_RULES, msg } from '@shared/protocol'
import type { TimelineEvent } from '@shared/types'
import { makeTask } from '../fixtures/task'

let seq = 0
const ev = (over: Partial<TimelineEvent>): TimelineEvent => ({
  id: `e${++seq}`,
  ts: '',
  channel: 'main',
  kind: 'system',
  ...over
})

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({ activeBranch: {}, toast: undefined })
})

describe('userTextDisplay', () => {
  test('一般文字原樣顯示', () => {
    expect(userTextDisplay('加上登入失敗鎖定')).toBe('加上登入失敗鎖定')
  })

  test('協定訊息轉成可讀文字，不露出分岔規則', () => {
    const open = userTextDisplay(msg.branchOpen('計數存放位置', '來源問題：存哪裡？'))
    expect(open).toBe('開始討論：計數存放位置')
    expect(open).not.toContain(BRANCH_RULES.split('\n')[0])
    expect(userTextDisplay(msg.answer('q1', 'redis', 'Redis'))).toBe('回答：Redis')
    expect(userTextDisplay(msg.counterQuestion('q1', '會洩漏嗎？'))).toBe('反問：會洩漏嗎？')
    expect(userTextDisplay(msg.conclude())).toBe('請 Claude 整理這個分岔的結論')
    expect(userTextDisplay(msg.resume())).toBe('繼續執行')
    expect(userTextDisplay(msg.specApproved())).toBe('核准規格，開始實作')
    expect(
      userTextDisplay(
        msg.branchConclusion('b1', { decision: '用 Redis', rationale: '共享', deferred: [] })
      )
    ).toBe('帶回分岔結論\n決策：用 Redis\n原因：共享')
  })

  test('缺必要屬性的協定訊息照原文顯示', () => {
    expect(userTextDisplay('[answer] Redis')).toBe('[answer] Redis')
    expect(userTextDisplay('[counter_question] 會洩漏嗎？')).toBe('[counter_question] 會洩漏嗎？')
    expect(userTextDisplay('[branch_conclusion] 決策：x')).toBe('[branch_conclusion] 決策：x')
  })

  test('任何文字裡的分岔規則都不顯示', () => {
    expect(userTextDisplay(`${BRANCH_RULES}\n\n請比較 Redis 與 DB`)).toBe('請比較 Redis 與 DB')
    expect(userTextDisplay(`[todo] ${BRANCH_RULES}`)).not.toContain('Harness 規則')
  })

  test('不認得的標籤照原文顯示', () => {
    expect(userTextDisplay('[todo] 記得寫測試')).toBe('[todo] 記得寫測試')
  })
})

describe('toolSummary', () => {
  test('工具名稱與目標', () => {
    expect(toolSummary({ id: 'x', name: 'Read', input: { file_path: 'src/a.ts' } })).toBe(
      '讀取 src/a.ts'
    )
    expect(toolSummary({ id: 'x', name: 'mcp__foo' })).toBe('mcp__foo')
  })

  test('worktree 內的絕對路徑顯示成相對路徑', () => {
    const read = { id: 'x', name: 'Read', input: { file_path: '/wt/t1/src/a.ts' } }
    expect(toolSummary(read, '/wt/t1')).toBe('讀取 src/a.ts')
    expect(toolSummary(read, '/other')).toBe('讀取 /wt/t1/src/a.ts')
  })
})

describe('Timeline', () => {
  const q = {
    id: 'q1',
    text: '計數要以什麼為單位？',
    status: 'answered' as const,
    allowFreeText: false,
    askedAt: '',
    options: [{ id: 'combo', label: '帳號 + IP 組合' }],
    answer: { optionId: 'combo' },
    followups: []
  }
  const task = makeTask({
    questions: [q],
    branches: [
      { id: 'b1', title: '計數存放位置', status: 'concluded', running: false, createdAt: '' }
    ],
    decisions: [
      {
        id: 'd1',
        text: '使用既有 Redis',
        rationale: '多台機器要共享狀態',
        source: { type: 'branch', ref: 'b1' }
      }
    ]
  })

  test('依 channel 篩選並呈現各種事件', async () => {
    const events = [
      ev({ kind: 'user_text', text: '登入 API 要加上失敗次數限制' }),
      ev({
        kind: 'tool_call',
        tool: { id: 't1', name: 'Read', input: { file_path: 'src/auth/login.ts' } }
      }),
      ev({ kind: 'tool_call', tool: { id: 't2', name: 'Read', input: { file_path: 'src/x.ts' } } }),
      ev({ kind: 'tool_call', tool: { id: 't3', name: 'Grep', input: { pattern: 'rateLimit' } } }),
      ev({ kind: 'assistant_text', text: '我看過 `login.ts` 了。' }),
      ev({ kind: 'question', ref: 'q1' }),
      ev({ kind: 'decision', ref: 'd1' }),
      ev({ kind: 'spec', ref: '1' }),
      ev({ channel: 'branch:b1', kind: 'assistant_text', text: '分岔裡的回覆' })
    ]
    const onOpenStage = vi.fn()
    render(<Timeline task={task} channel="main" events={events} onOpenStage={onOpenStage} />)
    expect(screen.getByText('登入 API 要加上失敗次數限制')).toBeInTheDocument()
    expect(screen.queryByText('分岔裡的回覆')).not.toBeInTheDocument()
    const tools = screen.getByRole('button', { name: '讀取 2 次 · 搜尋內容 1 次' })
    expect(tools).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(tools)
    expect(screen.getByText('讀取 src/auth/login.ts')).toBeInTheDocument()
    expect(screen.getByText('計數要以什麼為單位？')).toBeInTheDocument()
    expect(screen.getByText('帳號 + IP 組合')).toBeInTheDocument()
    expect(screen.getByText('分岔「計數存放位置」的結論')).toBeInTheDocument()
    expect(screen.getByText('原因：多台機器要共享狀態')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /規格草稿 v1/ }))
    expect(onOpenStage).toHaveBeenCalledWith('spec')
  })

  test('工具錯誤、系統訊息、報告與非分岔決策', async () => {
    const onOpenStage = vi.fn()
    const t = makeTask({
      decisions: [
        { id: 'd2', text: '沿用既有錯誤碼', source: { type: 'implementation', ref: 's1' } }
      ]
    })
    render(
      <Timeline
        task={t}
        channel="main"
        onOpenStage={onOpenStage}
        events={[
          ev({ kind: 'tool_result', text: 'ENOENT: no such file' }),
          ev({ kind: 'system', text: '已切換到 Sonnet 5.5' }),
          ev({ kind: 'decision', ref: 'd2' }),
          ev({ kind: 'report', ref: '2' })
        ]}
      />
    )
    expect(screen.getByText('工具錯誤：ENOENT: no such file')).toBeInTheDocument()
    expect(screen.getByText('已切換到 Sonnet 5.5')).toBeInTheDocument()
    expect(screen.getByText('決策')).toBeInTheDocument()
    expect(screen.getByText('沿用既有錯誤碼')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /變更報告 v2/ }))
    expect(onOpenStage).toHaveBeenCalledWith('report')
  })

  test('工具列表的路徑相對於 worktree；使用者拒絕的工具顯示已拒絕', async () => {
    render(
      <Timeline
        task={makeTask()}
        channel="main"
        events={[
          ev({
            kind: 'tool_call',
            tool: { id: 'r1', name: 'Read', input: { file_path: '/tmp/wt/t1/src/a.ts' } }
          }),
          ev({
            kind: 'tool_result',
            text: '先不要讀網頁',
            tool: { id: 'w1', name: '', isError: true, denied: true }
          })
        ]}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: '讀取 1 次' }))
    expect(screen.getByText('讀取 src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('已拒絕：先不要讀網頁')).toBeInTheDocument()
    expect(screen.queryByText(/工具錯誤/)).not.toBeInTheDocument()
  })

  test('重新提問的問題只在最後一次出現的位置顯示卡片', () => {
    const open = { ...q, status: 'open' as const, answer: undefined }
    render(
      <Timeline
        task={{ ...task, questions: [open] }}
        channel="main"
        events={[
          ev({ kind: 'question', ref: 'q1' }),
          ev({ kind: 'assistant_text', text: '我想再確認一次' }),
          ev({ kind: 'question', ref: 'q1' })
        ]}
      />
    )
    expect(screen.getAllByRole('button', { name: '確認答案' })).toHaveLength(1)
    const card = screen.getByRole('radiogroup').closest('section')!
    expect(
      screen.getByText('我想再確認一次').compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('開放中的問題顯示成卡片', () => {
    const open = { ...q, status: 'open' as const, answer: undefined }
    render(
      <Timeline
        task={{ ...task, questions: [open] }}
        channel="main"
        events={[ev({ kind: 'question', ref: 'q1' })]}
      />
    )
    expect(screen.getByRole('button', { name: '確認答案' })).toBeInTheDocument()
  })

  test('從 Claude 的訊息分岔', async () => {
    const onBranchFrom = vi.fn()
    render(
      <Timeline
        task={task}
        channel="main"
        events={[ev({ kind: 'assistant_text', text: '有幾件事要先確認。' })]}
        onBranchFrom={onBranchFrom}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
    expect(onBranchFrom).toHaveBeenCalledWith('有幾件事要先確認。')
  })

  test('正在開分岔時停用分岔按鈕', () => {
    render(
      <Timeline
        task={task}
        channel="main"
        events={[ev({ kind: 'assistant_text', text: '有幾件事要先確認。' })]}
        onBranchFrom={() => {}}
        branchPending
      />
    )
    expect(screen.getByRole('button', { name: '從這則訊息分岔' })).toBeDisabled()
  })

  test('使用者訊息若是協定訊息，顯示可讀文字', () => {
    render(
      <Timeline
        task={task}
        channel="main"
        events={[ev({ kind: 'user_text', text: msg.branchOpen('通知', '') })]}
      />
    )
    expect(screen.getByText('開始討論：通知')).toBeInTheDocument()
    expect(screen.queryByText(/Harness 規則/)).not.toBeInTheDocument()
  })
})

describe('RunStatus', () => {
  test('中斷時可繼續', async () => {
    const onResume = vi.fn()
    render(<RunStatus task={makeTask({ runState: 'interrupted' })} onResume={onResume} />)
    expect(screen.getByRole('alert')).toHaveTextContent('上一次執行被中斷了。')
    await userEvent.click(screen.getByRole('button', { name: '繼續' }))
    expect(onResume).toHaveBeenCalled()
  })

  test('執行中在常駐的 live region 顯示處理中；quiet 時不顯示', () => {
    const { rerender } = render(<RunStatus task={makeTask()} onResume={() => {}} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('')
    rerender(<RunStatus task={makeTask({ runState: 'running' })} onResume={() => {}} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Claude 正在處理…')
    rerender(<RunStatus task={makeTask({ runState: 'running' })} onResume={() => {}} quiet />)
    expect(status).toHaveTextContent('')
  })

  test('只反映主線的錯誤，分岔的錯誤不出現在這裡', () => {
    const branchFailed = makeTask({
      branches: [
        { id: 'b1', title: 'x', status: 'open', running: false, createdAt: '', error: '分岔失敗' }
      ]
    })
    const { rerender } = render(<RunStatus task={branchFailed} onResume={() => {}} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    rerender(<RunStatus task={{ ...branchFailed, error: '主線失敗' }} onResume={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('主線失敗')
    expect(screen.queryByRole('button', { name: '繼續' })).not.toBeInTheDocument()
  })
})
```

**Step 2: 確認失敗**

**Step 3: lib/timeline.ts、usePending.ts、stage.ts 的忙碌判斷**

元件檔只匯出元件（react-refresh 規則），工具摘要、訊息文字與 `useTimeline` 放在 `lib/timeline.ts`。時間軸上的使用者訊息多半是主程序寫入的顯示文字；遇到協定訊息（`[branch_open] …` 等）且帶有該有的屬性時才轉成可讀文字，並且無論如何都去掉 `BRANCH_RULES` 之類給 Claude 的指示。

```ts
// src/renderer/src/lib/timeline.ts
import {
  BRANCH_RULES,
  msgDisplay,
  parseTagged,
  type Tagged
} from '@shared/protocol'
import type { TimelineEvent } from '@shared/types'
import { useStore } from '../store'

const TOOL_LABEL: Record<string, string> = {
  Read: '讀取',
  Glob: '搜尋檔名',
  Grep: '搜尋內容',
  Edit: '編輯',
  Write: '寫入',
  MultiEdit: '編輯',
  NotebookEdit: '編輯',
  Bash: '指令',
  WebFetch: '讀取網頁',
  WebSearch: '搜尋網路',
  Agent: '子代理',
  Task: '子代理',
  TodoWrite: '待辦',
  ToolSearch: '載入工具'
}

export type ToolCall = NonNullable<TimelineEvent['tool']>

export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name

/** worktree 內的絕對路徑顯示成相對路徑（Claude Code 的檔案工具都用絕對路徑）；其他原樣回傳 */
export function relativeTo(root: string, p: string): string {
  const base = root.endsWith('/') ? root : `${root}/`
  return p.startsWith(base) ? p.slice(base.length) : p
}

/** 工具呼叫的對象（檔案、指令、網址…），沒有就是空字串；給了 root 就把其中的路徑顯示成相對路徑 */
export function toolTarget(tool: Pick<ToolCall, 'input'>, root?: string): string {
  const i = tool.input ?? {}
  const target = String(i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? '')
  return root ? relativeTo(root, target) : target
}

/** 工具呼叫的一行摘要，例如「讀取 src/auth/login.ts」 */
export function toolSummary(tool: ToolCall, root?: string): string {
  const target = toolTarget(tool, root)
  return `${toolLabel(tool.name)}${target ? ` ${target}` : ''}`
}

const RULE_LINES = BRANCH_RULES.split('\n')

/** 去掉混進文字裡的分岔規則（給 Claude 的指示，不給使用者看）；沒有就原樣回傳 */
function stripRules(text: string): string {
  let out = text
  for (const line of RULE_LINES) out = out.split(line).join('')
  return out === text ? text : out.replace(/\n{3,}/g, '\n\n').trim()
}

/** 協定訊息轉成可讀文字；格式不符（缺必要屬性、不認得的標籤）時回傳 undefined */
function describeTagged(t: Tagged): string | undefined {
  switch (t.tag) {
    case 'answer':
      return t.attrs.question_id ? `回答：${t.body}` : undefined
    case 'counter_question':
      return t.attrs.question_id ? `反問：${t.body}` : undefined
    case 'branch_open': {
      const title = /^主題：(.*)$/m.exec(t.body)?.[1]?.trim()
      return title ? `開始討論：${title}` : '開始分岔討論'
    }
    case 'conclude':
      return '請 Claude 整理這個分岔的結論'
    case 'branch_conclusion':
      return t.attrs.branch ? `帶回分岔結論\n${t.body}` : undefined
    case 'spec_feedback':
      return msgDisplay.specFeedback(t.body)
    case 'spec_approved':
      return msgDisplay.specApproved
    case 'report_feedback':
      return `報告回饋：\n${t.body}`
    case 'resume':
      return msgDisplay.resume
    default:
      return undefined
  }
}

/**
 * 時間軸上使用者訊息的顯示文字。主程序多半已寫入給人看的版本，
 * 但舊資料或使用者直接送出的協定訊息（`[tag ...] 內容`）在這裡轉成可讀文字。
 * 格式不符的照原文顯示；無論如何都不顯示 `BRANCH_RULES` 這類給 Claude 的指示。
 */
export function userTextDisplay(text: string): string {
  const t = parseTagged(text)
  return stripRules((t && describeTagged(t)) ?? text)
}

/**
 * 每個問題最後一次出現在時間軸上的事件 id。Claude 重新提問已回答的問題時時間軸會再出現一次，
 * 卡片只畫在最後一次的位置。
 */
export function latestQuestionEvents(events: TimelineEvent[]): Set<string> {
  const last = new Map<string, string>()
  for (const e of events) if (e.kind === 'question' && e.ref) last.set(e.ref, e.id)
  return new Set(last.values())
}

const EMPTY: TimelineEvent[] = []

/** 任務的時間軸（還沒載入時是空陣列） */
export function useTimeline(taskId: string): TimelineEvent[] {
  return useStore((s) => s.timelines[taskId]) ?? EMPTY
}
```

會觸發 IPC 的按鈕（升級成分岔、從訊息分岔、帶回主線、確認答案…）用 `usePending` 在呼叫進行中停用，連點也只送一次：

```ts
// src/renderer/src/lib/usePending.ts
import { useRef, useState } from 'react'

/**
 * 按鈕觸發的非同步操作（IPC）進行中時回報 pending，並擋掉重複觸發（例如連點兩下）。
 * ref 是同步的守門，state 讓畫面把按鈕停用。
 */
export function usePending() {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const run = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined
    inFlight.current = true
    setPending(true)
    try {
      return await fn()
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return [pending, run] as const
}
```

```ts
// src/renderer/src/lib/stage.ts（附加；import 改為 `import type { Question, Task } from '@shared/types'`）
/**
 * 主線正在執行（含等待核准、整理報告）。此時 UI 停用作答、反問與分岔：
 * 主程序在主線執行中會拒絕開分岔；作答與反問雖然會被當成插話送進這一輪，
 * 但等這一輪停下來再開放，回答才不會和 Claude 正在進行的回覆交錯。
 */
export function isBusy(t: Task): boolean {
  return (
    t.runState === 'running' || t.runState === 'waiting_permission' || t.runState === 'finalizing'
  )
}

/** 使用者反問後正在等 Claude 回答（問題卡片自己會顯示等待中） */
export function awaitingCounterReply(t: Task, q: Question): boolean {
  return isBusy(t) && q.status === 'open' && q.followups.at(-1)?.role === 'user'
}
```

**Step 4: ui.tsx 的 LiveStatus 與 Markdown 的 memo**

處理中的文字放在常駐的 `role="status" aria-live="polite"` 區域裡（沒有狀態時保持空的但不移除），螢幕閱讀器才會在狀態出現時唸出。

```tsx
// src/renderer/src/components/ui.tsx（取代原本的 Spinner）
/** decorative：旁邊已有文字說明（例如放在 LiveStatus 裡）時不再自己宣告狀態 */
export function Spinner({ className, decorative }: { className?: string; decorative?: boolean }) {
  return (
    <span
      {...(decorative ? { 'aria-hidden': true } : { role: 'status', 'aria-label': '處理中' })}
      className={cx(
        'inline-block size-3.5 flex-none animate-spin rounded-full border-2 border-brand border-t-transparent',
        className
      )}
    />
  )
}

/**
 * 常駐的 live region：有 text 時顯示轉圈與文字，沒有時保持空的但不移除，
 * 讓螢幕閱讀器在狀態出現或改變時唸出來。
 */
export function LiveStatus({ text, className }: { text?: string | false; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx('flex items-center gap-2 text-muted', className)}
    >
      {text && (
        <>
          <Spinner decorative />
          {text}
        </>
      )}
    </div>
  )
}
```

時間軸每次重繪（新事件、輸入框打字）時，內容沒變的訊息不重新解析 Markdown：

```tsx
// src/renderer/src/components/Markdown.tsx
import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { call } from '../api'

const PLUGINS = [remarkGfm]
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        // 不在 app 視窗裡導覽；https 連結由主程序交給系統瀏覽器
        e.preventDefault()
        if (href) void call('shell:openExternal', href)
      }}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-xl bg-code p-3 text-[12.5px] text-code-ink [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-code-ink">
      {children}
    </pre>
  )
}

/** memo：時間軸重繪（例如打字、新事件）時，內容沒變的訊息不重新解析 Markdown */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 [&_:is(h1,h2,h3,h4)]:m-0 [&_:is(h1,h2,h3,h4)]:font-bold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:m-0 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
```

**Step 5: QuestionCard.tsx（對照 `StyleB.dc.html` 的「目前問題」section）**

選擇存成「使用者點的選項」，畫面上的值在 render 時推導：Claude 用同一個 question_id 更新卡片後，若原選項不見了就回到建議選項。「其他」的描述與一般選項的「補充說明」分開保存；補充說明預設收起在「＋ 補充說明」按鈕後面（設計稿沒有這一欄），已有內容就保持展開；Claude 改成不允許自由文字後，補充說明不送出。已經從這個問題分出分岔時，「升級成分岔」改成「查看分岔」。

```tsx
// src/renderer/src/components/QuestionCard.tsx
import { type FormEvent, useId, useRef, useState } from 'react'
import type { Question, Task } from '@shared/types'
import { call } from '../api'
import { blockImeSubmit } from '../lib/ime'
import { awaitingCounterReply, isBusy } from '../lib/stage'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import { Button, cx, Icons, inputClass, LiveStatus, textareaClass } from './ui'

const OTHER = '__other'

const optionClass = (on: boolean) =>
  cx(
    'flex cursor-pointer gap-2.5 rounded-[14px] p-3.5 has-[:disabled]:cursor-default',
    on ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2'
  )

export function QuestionCard({
  task,
  question: q,
  readOnly
}: {
  task: Task
  question: Question
  readOnly?: boolean
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const titleId = useId()
  // 使用者點選的選項；Claude 更新卡片後選項可能不見了，此時回到預設（render 時推導）
  const [picked, setPicked] = useState<string>()
  // 選「其他」時的答案，與選一般選項時的補充說明分開保存
  const [otherText, setOtherText] = useState('')
  const [note, setNote] = useState('')
  // 補充說明預設收起（設計稿沒有這一欄），按「＋ 補充說明」才展開；已有內容就保持展開
  const [noteOpen, setNoteOpen] = useState(false)
  const focusNote = useRef(false)
  const [counter, setCounter] = useState('')
  const [answering, runAnswer] = usePending()
  const [upgrading, runUpgrade] = usePending()

  const ids = q.options.map((o) => o.id)
  const valid = (id?: string): id is string =>
    !!id && (ids.includes(id) || (id === OTHER && q.allowFreeText))
  const fallback = valid(q.recommendedOptionId)
    ? q.recommendedOptionId
    : (ids[0] ?? (q.allowFreeText ? OTHER : undefined))
  const selected = valid(picked) ? picked : fallback

  const busy = isBusy(task)
  const disabled = readOnly || busy || q.status !== 'open'
  const waitingCounter = awaitingCounterReply(task, q)
  const counted = q.followups.filter((f) => f.role === 'user').length
  const index = task.questions.findIndex((x) => x.id === q.id) + 1
  // 已經從這個問題分出去的分岔：按鈕改成切過去看，不再開新的
  const existing = task.branches.find((b) => b.fromQuestionId === q.id)
  const canConfirm = !!selected && (selected !== OTHER || !!otherText.trim())

  const confirm = () =>
    runAnswer(() =>
      act(() =>
        call(
          'tasks:answer',
          task.id,
          q.id,
          selected === OTHER
            ? { optionId: undefined, text: otherText.trim() }
            : // Claude 改成不允許自由文字後，之前打的補充說明不送出
              { optionId: selected, text: (q.allowFreeText && note.trim()) || undefined }
        )
      )
    )
  const ask = (e: FormEvent) => {
    e.preventDefault()
    const text = counter.trim()
    if (!text || busy) return
    setCounter('')
    void act(() => call('tasks:counter', task.id, q.id, text))
  }
  const upgrade = () =>
    runUpgrade(async () => {
      const b = await act(() =>
        call('branch:open', task.id, { title: q.text.slice(0, 30), fromQuestionId: q.id })
      )
      if (b) setActiveBranch(task.id, b.id)
    })

  return (
    <section
      aria-labelledby={titleId}
      className="ml-10 flex flex-col gap-3.5 rounded-[18px] bg-surface p-5 shadow-focus"
    >
      <div className="flex flex-col gap-0.5">
        {index > 0 && <span className="text-xs font-medium text-brand">問題 {index}</span>}
        <span id={titleId} className="text-[17px] font-bold">
          {q.text}
        </span>
        {q.context && <span className="text-[13px] text-muted">{q.context}</span>}
      </div>

      <div role="radiogroup" aria-labelledby={titleId} className="grid grid-cols-2 gap-2.5">
        {q.options.map((o) => {
          const recommended = o.id === q.recommendedOptionId
          return (
            <label key={o.id} className={optionClass(selected === o.id)}>
              <input
                type="radio"
                name={`q-${q.id}`}
                checked={selected === o.id}
                onChange={() => setPicked(o.id)}
                disabled={disabled}
                className="mt-[5px] flex-none accent-brand"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium">{o.label}</span>
                {(o.description || recommended) && (
                  <span className={cx('text-xs', recommended ? 'text-brand-muted' : 'text-muted')}>
                    {recommended && <span className="font-medium">建議</span>}
                    {recommended && o.description && ' · '}
                    {o.description}
                  </span>
                )}
              </span>
            </label>
          )
        })}
        {q.allowFreeText && (
          <label className={optionClass(selected === OTHER)}>
            <input
              type="radio"
              name={`q-${q.id}`}
              checked={selected === OTHER}
              onChange={() => setPicked(OTHER)}
              disabled={disabled}
              className="mt-[5px] flex-none accent-brand"
            />
            <span className="text-muted">其他，自己描述…</span>
          </label>
        )}
      </div>

      {q.allowFreeText && selected === OTHER && (
        <label className="flex flex-col">
          <span className="sr-only">自己描述</span>
          <textarea
            rows={2}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            disabled={disabled}
            placeholder="描述你的答案"
            className={textareaClass}
          />
        </label>
      )}
      {q.allowFreeText &&
        selected !== undefined &&
        selected !== OTHER &&
        !readOnly &&
        (noteOpen || note ? (
          <label className="flex flex-col">
            <span className="sr-only">補充說明</span>
            <textarea
              // 剛按下「＋ 補充說明」時把焦點移進來（按鈕已經消失）
              ref={(el) => {
                if (el && focusNote.current) {
                  focusNote.current = false
                  el.focus()
                }
              }}
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={disabled}
              placeholder="補充說明（選填）"
              className={cx(textareaClass, 'resize-y')}
            />
          </label>
        ) : (
          <button
            type="button"
            aria-expanded={false}
            disabled={disabled}
            onClick={() => {
              focusNote.current = true
              setNoteOpen(true)
            }}
            className="cursor-pointer self-start text-xs text-muted hover:text-brand disabled:cursor-default disabled:opacity-50"
          >
            ＋ 補充說明
          </button>
        ))}

      {q.followups.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-[14px] bg-fill-2 px-3.5 py-3 text-[13px]">
          <span className="text-xs font-medium text-muted">你反問了 {counted} 次</span>
          {q.followups.map((f, i) => (
            <div key={i} className="flex gap-2">
              {f.role === 'user' ? (
                <span className="flex-none text-muted">你</span>
              ) : (
                <span className="flex-none font-medium text-brand">
                  <span aria-hidden>C</span>
                  <span className="sr-only">Claude</span>
                </span>
              )}
              {f.role === 'user' ? (
                <span className="min-w-0 whitespace-pre-wrap">{f.text}</span>
              ) : (
                // Claude 的回答常用粗體、清單與程式碼，和時間軸一樣以 Markdown 呈現
                <div className="min-w-0 flex-1">
                  <Markdown text={f.text} />
                </div>
              )}
            </div>
          ))}
          <LiveStatus text={waitingCounter && 'Claude 正在回答…'} />
        </div>
      )}

      {!readOnly && q.status === 'open' && (
        <form onSubmit={ask} className="flex flex-wrap items-center gap-2.5">
          <label className="flex min-w-[220px] flex-1">
            <span className="sr-only">反問</span>
            <input
              value={counter}
              onChange={(e) => setCounter(e.target.value)}
              onKeyDown={blockImeSubmit}
              disabled={busy}
              placeholder="還有疑問？在這裡反問…"
              className={cx(inputClass, 'flex-1')}
            />
          </label>
          {existing ? (
            <Button
              className="h-[42px] px-3.5"
              onClick={() => setActiveBranch(task.id, existing.id)}
            >
              查看分岔
            </Button>
          ) : (
            <Button
              className="h-[42px] px-3.5"
              disabled={busy || upgrading}
              onClick={() => void upgrade()}
            >
              升級成分岔
            </Button>
          )}
          <Button
            variant="primary"
            className="h-[42px] px-5"
            disabled={disabled || answering || !canConfirm}
            onClick={() => void confirm()}
          >
            確認答案
          </Button>
        </form>
      )}
    </section>
  )
}

/** 已回答的問題：時間軸上收成一列 */
export function AnsweredQuestionRow({ question: q }: { question: Question }) {
  const label = q.answer?.optionId
    ? q.options.find((o) => o.id === q.answer?.optionId)?.label
    : undefined
  return (
    <div className="ml-10 flex items-center gap-2.5 rounded-xl bg-fill-2 px-4 py-2.5 text-[13px]">
      <Icons.Check className="flex-none text-brand" strokeWidth={2.5} aria-hidden />
      <span className="text-muted">{q.text}</span>
      <span className="ml-auto text-right font-medium">
        {[label, q.answer?.text].filter(Boolean).join('；')}
      </span>
    </div>
  )
}
```

**Step 6: Timeline.tsx**

時間軸只顯示指定 channel 的事件；連續的工具呼叫合併成一列摘要（以 `useMemo` 依事件與 channel 計算）。`RunStatus` 只看主線（`task.runState`／`task.error`），分岔的錯誤記在 `Branch.error`，由分岔面板顯示。

```tsx
// src/renderer/src/components/Timeline.tsx
import { useMemo, useState } from 'react'
import type { Channel, Task, TimelineEvent } from '@shared/types'
import {
  latestQuestionEvents,
  type ToolCall,
  toolLabel,
  toolSummary,
  userTextDisplay
} from '../lib/timeline'
import { Markdown } from './Markdown'
import { AnsweredQuestionRow, QuestionCard } from './QuestionCard'
import { Avatar, cx, Icons, LiveStatus } from './ui'

type ToolEvent = TimelineEvent & { tool: ToolCall }
type Item = { kind: 'event'; e: TimelineEvent } | { kind: 'tools'; events: ToolEvent[] }

/** 連續的工具呼叫合併成一組 */
function group(events: TimelineEvent[]): Item[] {
  const out: Item[] = []
  for (const e of events) {
    const last = out.at(-1)
    if (e.kind === 'tool_call' && e.tool) {
      const te = e as ToolEvent
      if (last?.kind === 'tools') last.events.push(te)
      else out.push({ kind: 'tools', events: [te] })
    } else out.push({ kind: 'event', e })
  }
  return out
}

function ToolGroup({ events, root }: { events: ToolEvent[]; root: string }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const e of events) {
    const l = toolLabel(e.tool.name)
    counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  return (
    <div className="ml-10 flex flex-col gap-1 text-xs text-muted-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="cursor-pointer self-start hover:text-ink"
      >
        {[...counts].map(([l, n]) => `${l} ${n} 次`).join(' · ')}{' '}
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open &&
        events.map((e) => (
          <code key={e.id} className="self-start break-all">
            {toolSummary(e.tool, root)}
          </code>
        ))}
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[78%] self-end rounded-[18px_18px_6px_18px] bg-fill px-4 py-3 whitespace-pre-wrap">
      {userTextDisplay(text)}
    </div>
  )
}

export function Timeline({
  task,
  channel,
  events,
  readOnly,
  onBranchFrom,
  branchPending,
  onOpenStage
}: {
  task: Task
  channel: Channel
  events: TimelineEvent[]
  readOnly?: boolean
  onBranchFrom?: (text: string) => void
  /** 正在開分岔：停用所有「從這則訊息分岔」按鈕，避免重複開 */
  branchPending?: boolean
  onOpenStage?: (stage: 'spec' | 'report') => void
}) {
  const { items, latest } = useMemo(() => {
    const list = events.filter((e) => e.channel === channel)
    return { items: group(list), latest: latestQuestionEvents(list) }
  }, [events, channel])
  return (
    <div className="flex flex-col gap-5">
      {items.map((it) => {
        if (it.kind === 'tools')
          return <ToolGroup key={it.events[0].id} events={it.events} root={task.worktreePath} />
        const e = it.e
        switch (e.kind) {
          case 'user_text':
            return <UserBubble key={e.id} text={e.text ?? ''} />
          case 'assistant_text':
            return (
              <div key={e.id} className="group flex gap-3">
                <Avatar />
                <div className="min-w-0 flex-1">
                  <Markdown text={e.text ?? ''} />
                </div>
                {onBranchFrom && !readOnly && (
                  <button
                    type="button"
                    aria-label="從這則訊息分岔"
                    title="從這則訊息分岔"
                    disabled={branchPending}
                    onClick={() => onBranchFrom(e.text ?? '')}
                    className="flex h-7 flex-none cursor-pointer items-center rounded-lg px-2 text-muted opacity-0 group-hover:opacity-100 hover:bg-fill focus-visible:opacity-100 disabled:cursor-default disabled:opacity-40"
                  >
                    <Icons.Branch width={14} height={14} />
                  </button>
                )}
              </div>
            )
          case 'question': {
            const q = task.questions.find((x) => x.id === e.ref)
            // 重新提問過的問題只在最後一次出現的位置畫卡片
            if (!q || !latest.has(e.id)) return null
            return q.status === 'open' ? (
              <QuestionCard key={e.id} task={task} question={q} readOnly={readOnly} />
            ) : (
              <AnsweredQuestionRow key={e.id} question={q} />
            )
          }
          case 'decision': {
            const d = task.decisions.find((x) => x.id === e.ref)
            if (!d) return null
            const b =
              d.source.type === 'branch'
                ? task.branches.find((x) => x.id === d.source.ref)
                : undefined
            return (
              <div
                key={e.id}
                className="ml-10 flex flex-col gap-1.5 rounded-[14px] bg-decision px-4 py-3.5"
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-decision-ink">
                  <Icons.Branch width={14} height={14} />
                  {d.source.type === 'branch'
                    ? `分岔「${b?.title ?? d.source.ref}」的結論`
                    : '決策'}
                </span>
                <span>{d.text}</span>
                {d.rationale && (
                  <span className="text-[13px] text-decision-body">原因：{d.rationale}</span>
                )}
                {!!d.deferred?.length && (
                  <span className="text-[13px] text-decision-body">
                    延後：{d.deferred.join('；')}
                  </span>
                )}
              </div>
            )
          }
          case 'spec':
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpenStage?.('spec')}
                className="ml-10 cursor-pointer self-start rounded-xl bg-brand-tint px-4 py-2.5 text-[13px] text-brand-ink hover:bg-brand-soft"
              >
                規格草稿 v{e.ref} 已產生 → 查看
              </button>
            )
          case 'report':
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpenStage?.('report')}
                className="ml-10 cursor-pointer self-start rounded-xl bg-review-soft px-4 py-2.5 text-[13px] text-review"
              >
                變更報告 v{e.ref} 已產生 → 查看
              </button>
            )
          case 'tool_result':
            return (
              <div
                key={e.id}
                className={cx(
                  'ml-10 line-clamp-4 text-xs break-all whitespace-pre-wrap',
                  e.tool?.denied ? 'text-muted' : 'text-danger'
                )}
              >
                {e.tool?.denied ? '已拒絕' : '工具錯誤'}：{e.text}
              </div>
            )
          case 'system':
            return (
              <div
                key={e.id}
                className="self-center rounded-full bg-fill px-3 py-1 text-xs text-muted"
              >
                {e.text}
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}

/**
 * 主線的執行狀態：常駐的 live region 顯示處理中，錯誤另外用 alert。
 * 只看主線（task.runState / task.error）；分岔的錯誤記在 Branch.error，由分岔面板顯示。
 * quiet：問題卡片已經在顯示「Claude 正在回答…」時不再重複顯示處理中。
 */
export function RunStatus({
  task,
  onResume,
  quiet
}: {
  task: Task
  onResume: () => void
  quiet?: boolean
}) {
  const progress =
    task.runState === 'running'
      ? 'Claude 正在處理…'
      : task.runState === 'finalizing'
        ? '正在整理 diff 並執行驗證指令…'
        : undefined
  const failed = task.runState === 'interrupted' || task.runState === 'error' || !!task.error
  const canResume = task.runState === 'interrupted' || task.runState === 'error'
  return (
    <>
      <LiveStatus text={!quiet && progress} className="ml-10 text-[13px]" />
      {failed && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] text-danger"
        >
          <span className="flex-1">
            {task.runState === 'interrupted' ? '上一次執行被中斷了。' : (task.error ?? '發生錯誤')}
          </span>
          {canResume && (
            <button
              type="button"
              onClick={onResume}
              className="cursor-pointer font-medium underline"
            >
              繼續
            </button>
          )}
        </div>
      )}
    </>
  )
}
```

**Step 7: 確認通過** — `npx vitest run tests/renderer/QuestionCard.test.tsx tests/renderer/Timeline.test.tsx` → 31 passed

**Step 8: Commit**

```bash
git add src/renderer/src/components src/renderer/src/lib tests/fixtures/hold.ts tests/renderer/QuestionCard.test.tsx tests/renderer/Timeline.test.tsx docs/plans
git commit -m "feat(ui): add question card with counter-questions and timeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 30：分岔面板與釐清畫面

**Files:**
- Create: `src/renderer/src/lib/useStickToBottom.ts`
- Create: `src/renderer/src/components/BranchPanel.tsx`
- Create: `src/renderer/src/components/Composer.tsx`
- Create: `src/renderer/src/screens/ClarifyScreen.tsx`
- Modify: `src/renderer/src/screens/TaskScreen.tsx`
- Test: `tests/renderer/BranchPanel.test.tsx`、`tests/renderer/ClarifyScreen.test.tsx`、`tests/renderer/useStickToBottom.test.tsx`

**Step 1: 寫失敗測試**

```tsx
// tests/renderer/BranchPanel.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { BranchPanel } from '@renderer/components/BranchPanel'
import { resetStoreInternals, useStore } from '@renderer/store'
import { msg } from '@shared/protocol'
import type { Branch, TimelineEvent } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const concluded: Branch = {
  id: 'b1',
  title: '計數存放位置',
  status: 'concluded',
  running: false,
  createdAt: '',
  conclusion: { decision: '用 Redis', rationale: 'x', deferred: [] }
}
const concluding: Branch = {
  id: 'b2',
  title: '通知使用者',
  fromQuestionId: 'q2',
  status: 'concluding',
  running: false,
  createdAt: '',
  conclusion: { decision: '寄通知信', rationale: '避免騷擾', deferred: ['重設連結'] }
}
const open: Branch = { ...concluding, status: 'open', conclusion: undefined }
const task = makeTask({ branches: [concluded, concluding] })

const ev = (id: string, over: Partial<TimelineEvent>): TimelineEvent => ({
  id,
  ts: '',
  channel: 'branch:b2',
  kind: 'user_text',
  ...over
})
const talk = [
  ev('e1', { text: msg.branchOpen('通知使用者', '') }),
  ev('e2', { kind: 'assistant_text', text: '會有騷擾的風險。' }),
  ev('e3', { channel: 'main', kind: 'assistant_text', text: '主線的訊息' })
]

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({ activeBranch: { t1: 'b2' }, timelines: { t1: [] }, toast: undefined })
})

test('沒有分岔時顯示說明', () => {
  useStore.setState({ activeBranch: {} })
  render(<BranchPanel task={makeTask()} events={[]} />)
  expect(screen.getByRole('complementary', { name: '分岔討論' })).toHaveTextContent('還沒有分岔')
})

test('顯示結論預覽，確認後帶回主線', async () => {
  render(<BranchPanel task={task} events={[]} />)
  expect(screen.getByText('帶回主線的結論（預覽）')).toBeInTheDocument()
  expect(screen.getByText('寄通知信')).toBeInTheDocument()
  expect(screen.getByText(/重設連結/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '確認並帶回主線' }))
  expect(call).toHaveBeenCalledWith('branch:confirm', 't1', 'b2', undefined)
  await userEvent.click(screen.getByRole('button', { name: '重新整理結論' }))
  expect(call).toHaveBeenCalledWith('branch:conclude', 't1', 'b2')
})

test('分岔訊息：輸入法選字中的 Enter 不送出', async () => {
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  const input = screen.getByRole('textbox', { name: '分岔訊息' })
  await userEvent.type(input, '再想想')
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
  expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
  expect(call).not.toHaveBeenCalledWith('tasks:send', 't1', 'branch:b2', '再想想')
  expect(input).toHaveValue('再想想')
})

test('在分岔中送出訊息，Claude 回覆過後可以帶回主線', async () => {
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  expect(screen.getByText('開始討論：通知使用者')).toBeInTheDocument()
  expect(screen.getByText('會有騷擾的風險。')).toBeInTheDocument()
  expect(screen.queryByText('主線的訊息')).not.toBeInTheDocument()
  await userEvent.type(screen.getByRole('textbox', { name: '分岔訊息' }), '再想想{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'branch:b2', '再想想')
  expect(screen.getByRole('textbox', { name: '分岔訊息' })).toHaveValue('')
  await userEvent.click(screen.getByRole('button', { name: '帶回主線' }))
  expect(call).toHaveBeenCalledWith('branch:conclude', 't1', 'b2')
})

test('Claude 還沒在分岔回覆前不能帶回主線；執行中停用輸入', () => {
  const { rerender } = render(
    <BranchPanel task={{ ...task, branches: [open] }} events={talk.slice(0, 1)} />
  )
  expect(screen.getByRole('button', { name: '帶回主線' })).toBeDisabled()
  rerender(<BranchPanel task={{ ...task, branches: [{ ...open, running: true }] }} events={talk} />)
  expect(screen.getByRole('textbox', { name: '分岔訊息' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '帶回主線' })).toBeDisabled()
  expect(screen.getByText('Claude 正在回覆…')).toBeInTheDocument()
})

test('切換分岔；已帶回的分岔只能看', async () => {
  render(<BranchPanel task={task} events={[]} />)
  const chip = screen.getByRole('button', { name: /計數存放位置 · 已帶回/ })
  expect(chip).toHaveAttribute('aria-pressed', 'false')
  await userEvent.click(chip)
  expect(useStore.getState().activeBranch.t1).toBe('b1')
  expect(chip).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText('已帶回主線的結論')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '分岔訊息' })).not.toBeInTheDocument()
})

test('記住的分岔不存在時，改顯示還沒帶回的分岔', () => {
  useStore.setState({ activeBranch: { t1: 'gone' } })
  render(<BranchPanel task={task} events={[]} />)
  expect(screen.getByRole('button', { name: /通知使用者/ })).toHaveAttribute('aria-pressed', 'true')
})

test('唯讀時不能送出或帶回', () => {
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} readOnly />)
  expect(screen.queryByRole('textbox', { name: '分岔訊息' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '帶回主線' })).not.toBeInTheDocument()
})

test('帶回主線進行中停用，連點只送一次', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<BranchPanel task={{ ...task, branches: [open] }} events={talk} />)
  const button = screen.getByRole('button', { name: '帶回主線' })
  await userEvent.dblClick(button)
  expect(call).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  await release()
  expect(button).toBeEnabled()
})

test('確認並帶回主線、重新整理結論進行中都停用，連點只送一次', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<BranchPanel task={task} events={[]} />)
  const confirm = screen.getByRole('button', { name: '確認並帶回主線' })
  const again = screen.getByRole('button', { name: '重新整理結論' })
  await userEvent.dblClick(confirm)
  expect(call).toHaveBeenCalledTimes(1)
  expect(confirm).toBeDisabled()
  expect(again).toBeDisabled()
  await release()
  expect(confirm).toBeEnabled()
  const release2 = holdNextCall(vi.mocked(call))
  await userEvent.dblClick(again)
  expect(call).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenLastCalledWith('branch:conclude', 't1', 'b2')
  await release2()
})

test('分岔的執行錯誤顯示在分岔面板', () => {
  render(
    <BranchPanel task={{ ...task, branches: [{ ...open, error: '分岔執行失敗' }] }} events={talk} />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('分岔執行失敗')
})

test('分岔裡的工具錯誤以錯誤樣式顯示；處理中在常駐的 live region', () => {
  const { rerender } = render(
    <BranchPanel
      task={{ ...task, branches: [open] }}
      events={[...talk, ev('e4', { kind: 'tool_result', text: 'EACCES' })]}
    />
  )
  expect(screen.getByText('工具錯誤：EACCES')).toHaveClass('text-danger')
  const status = screen.getByRole('status')
  expect(status).toHaveTextContent('')
  rerender(<BranchPanel task={{ ...task, branches: [{ ...open, running: true }] }} events={talk} />)
  expect(screen.getByRole('status')).toBe(status)
  expect(status).toHaveTextContent('Claude 正在回覆…')
})
```

```tsx
// tests/renderer/ClarifyScreen.test.tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => ({ id: 'b1' })),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { ClarifyScreen } from '@renderer/screens/ClarifyScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { TimelineEvent } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const events: TimelineEvent[] = [
  { id: 'e1', ts: '', channel: 'main', kind: 'user_text', text: '加上登入失敗鎖定' },
  { id: 'e2', ts: '', channel: 'main', kind: 'assistant_text', text: '有幾件事要先確認。' }
]

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({ activeBranch: {}, timelines: { t1: events }, toast: undefined })
})

test('顯示主線時間軸，從輸入框送出訊息', async () => {
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(screen.getByText('加上登入失敗鎖定')).toBeInTheDocument()
  expect(screen.getByRole('complementary', { name: '分岔討論' })).toBeInTheDocument()
  const send = screen.getByRole('button', { name: '送出' })
  expect(send).toBeDisabled()
  await userEvent.type(screen.getByRole('textbox', { name: '訊息' }), '也要記錄稽核日誌{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'main', '也要記錄稽核日誌')
  expect(screen.getByRole('textbox', { name: '訊息' })).toHaveValue('')
})

test('從 Claude 的訊息開分岔並切過去', async () => {
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly={false} onOpenStage={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: '從這則訊息分岔' }))
  expect(call).toHaveBeenCalledWith('branch:open', 't1', {
    title: '有幾件事要先確認。',
    seed: '針對這段內容深入討論：\n有幾件事要先確認。'
  })
  expect(useStore.getState().activeBranch.t1).toBe('b1')
})

test('開分岔進行中停用分岔按鈕，連點只開一個', async () => {
  const release = holdNextCall(vi.mocked(call))
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly={false} onOpenStage={() => {}} />)
  const button = screen.getByRole('button', { name: '從這則訊息分岔' })
  await userEvent.dblClick(button)
  expect(call).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  await release({ id: 'b3' })
  expect(useStore.getState().activeBranch.t1).toBe('b3')
  expect(button).toBeEnabled()
})

test('等反問的回答時只在卡片顯示處理中，不重複顯示', () => {
  const task = makeTask({
    runState: 'running',
    questions: [
      {
        id: 'q1',
        text: '要鎖多久？',
        status: 'open',
        allowFreeText: true,
        askedAt: '',
        options: [{ id: 'a', label: '15 分鐘' }],
        followups: [{ role: 'user', text: '可以依帳號調整嗎？' }]
      }
    ]
  })
  useStore.setState({
    timelines: {
      t1: [...events, { id: 'e3', ts: '', channel: 'main', kind: 'question', ref: 'q1' }]
    }
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(screen.getByText('Claude 正在回答…')).toBeInTheDocument()
  expect(screen.queryByText('Claude 正在處理…')).not.toBeInTheDocument()
})

test('分岔的錯誤只出現在分岔面板，不在主線', () => {
  const task = makeTask({
    branches: [
      { id: 'b1', title: '通知', status: 'open', running: false, createdAt: '', error: '分岔失敗' }
    ]
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(within(screen.getByRole('main')).queryByRole('alert')).not.toBeInTheDocument()
  expect(
    within(screen.getByRole('complementary', { name: '分岔討論' })).getByRole('alert')
  ).toHaveTextContent('分岔失敗')
})

test('Claude 執行中不能從訊息分岔，但仍可插話', () => {
  render(
    <ClarifyScreen
      task={makeTask({ runState: 'running' })}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
    />
  )
  expect(screen.queryByRole('button', { name: '從這則訊息分岔' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '訊息' })).toBeEnabled()
})

test('唯讀時沒有輸入框', () => {
  render(<ClarifyScreen task={makeTask()} nav={null} readOnly onOpenStage={() => {}} />)
  expect(screen.queryByRole('textbox', { name: '訊息' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '從這則訊息分岔' })).not.toBeInTheDocument()
})

test('TaskScreen：釐清中的任務顯示釐清畫面；回看釐清時唯讀', async () => {
  useStore.setState({ tasks: { t1: makeTask() } })
  const { unmount } = render(<TaskScreen taskId="t1" />)
  expect(screen.getByRole('textbox', { name: '訊息' })).toBeInTheDocument()
  unmount()
  useStore.setState({ tasks: { t1: makeTask({ status: 'spec_review' }) } })
  render(<TaskScreen taskId="t1" />)
  await userEvent.click(screen.getByRole('button', { name: /釐清/ }))
  expect(screen.getByText('加上登入失敗鎖定')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '訊息' })).not.toBeInTheDocument()
})

test('TaskScreen：已丟棄的任務即使停在釐清也唯讀', () => {
  useStore.setState({ tasks: { t1: makeTask({ status: 'discarded' }) } })
  render(<TaskScreen taskId="t1" />)
  expect(screen.getByText('加上登入失敗鎖定')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '訊息' })).not.toBeInTheDocument()
})
```

```tsx
// tests/renderer/useStickToBottom.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useStickToBottom } from '@renderer/lib/useStickToBottom'

function List({ version, resetKey }: { version: number; resetKey: string }) {
  const { ref, onScroll, stick } = useStickToBottom<HTMLDivElement>(version, resetKey)
  return (
    <>
      <div data-testid="list" ref={ref} onScroll={onScroll} />
      <button type="button" onClick={stick}>
        送出
      </button>
    </>
  )
}

/** jsdom 沒有版面：手動給捲動區高度 */
function sized(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
  return el
}

test('內容變多時捲到底；使用者往上捲後不打擾，換對話或自己送出後再黏到底', () => {
  const { rerender } = render(<List version={0} resetKey="a" />)
  const list = sized(screen.getByTestId('list'))
  rerender(<List version={1} resetKey="a" />)
  expect(list.scrollTop).toBe(1000)

  list.scrollTop = 0
  fireEvent.scroll(list)
  rerender(<List version={2} resetKey="a" />)
  expect(list.scrollTop).toBe(0)

  rerender(<List version={2} resetKey="b" />)
  expect(list.scrollTop).toBe(1000)

  list.scrollTop = 0
  fireEvent.scroll(list)
  fireEvent.click(screen.getByRole('button', { name: '送出' }))
  rerender(<List version={3} resetKey="b" />)
  expect(list.scrollTop).toBe(1000)
})
```

**Step 2: 確認失敗**

**Step 3: useStickToBottom.ts 與 Composer.tsx**

對話區內容變多時自動捲到底，使用者往上捲時不打擾；換一段對話（`resetKey`）或使用者自己送出訊息（`stick()`）後重新黏在底部。只在 layout effect 與事件處理裡讀寫 ref；回傳值直接解構，把 `ref` 給 JSX 的 `ref`，react-hooks 7 的 `refs` 規則才不會誤判。

```ts
// src/renderer/src/lib/useStickToBottom.ts
import { type UIEvent, useLayoutEffect, useRef } from 'react'

/** 距離底部多少 px 以內算「在底部」 */
const THRESHOLD = 80

/**
 * 對話捲動區：內容變多時自動捲到底，但使用者往上捲去看舊訊息時不打擾。
 * `version` 變了代表內容可能變了（例如事件數、任務的 updatedAt）；
 * `resetKey` 變了代表換了一段對話（例如換分岔），重新黏在底部。
 * 使用者自己送出訊息時呼叫 `stick()`，之後的回覆一定看得到。
 */
export function useStickToBottom<T extends HTMLElement>(version: unknown, resetKey?: unknown) {
  const ref = useRef<T>(null)
  const sticking = useRef(true)
  const lastKey = useRef(resetKey)
  // 在瀏覽器繪製前捲動，不會先閃一下舊的位置
  useLayoutEffect(() => {
    if (lastKey.current !== resetKey) {
      lastKey.current = resetKey
      sticking.current = true
    }
    const el = ref.current
    if (el && sticking.current) el.scrollTop = el.scrollHeight
  }, [version, resetKey])
  const onScroll = (e: UIEvent<T>) => {
    const el = e.currentTarget
    sticking.current = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD
  }
  const stick = () => {
    sticking.current = true
  }
  return { ref, onScroll, stick }
}
```

```tsx
// src/renderer/src/components/Composer.tsx
import { type FormEvent, type ReactNode, useState } from 'react'
import { blockImeSubmit } from '../lib/ime'
import { Icons } from './ui'

/** 畫面底部的圓角輸入列（對照 `StyleB.dc.html` 底部的訊息框） */
export function Composer({
  placeholder,
  disabled,
  onSend,
  extra,
  label = '訊息'
}: {
  placeholder: string
  disabled?: boolean
  onSend: (text: string) => void
  extra?: ReactNode
  label?: string
}) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || disabled) return
    onSend(text.trim())
    setText('')
  }
  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 rounded-full bg-fill py-2 pr-2 pl-[18px]"
    >
      <label className="flex flex-1">
        <span className="sr-only">{label}</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={blockImeSubmit}
          placeholder={placeholder}
          disabled={disabled}
          className="h-8 flex-1 border-none bg-transparent text-ink outline-none placeholder:text-muted-2"
        />
      </label>
      {extra}
      <button
        type="submit"
        aria-label="送出"
        disabled={disabled || !text.trim()}
        className="flex size-10 flex-none cursor-pointer items-center justify-center rounded-full bg-brand text-white hover:bg-brand-hover disabled:cursor-default disabled:opacity-40"
      >
        <Icons.Send />
      </button>
    </form>
  )
}
```

**Step 4: BranchPanel.tsx（對照 `StyleB.dc.html` 的 `<aside>`）**

輸入框拆成自己的小元件，打字時不重繪訊息列表。「帶回主線」要等 Claude 在分岔裡回覆過才能按；結論預覽出現後（`concluding`）可以「重新整理結論」或「確認並帶回主線」；這些按鈕在 IPC 進行中停用。分岔的執行錯誤（`Branch.error`）顯示在面板裡。

```tsx
// src/renderer/src/components/BranchPanel.tsx
import { type FormEvent, useState } from 'react'
import type { Branch, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { userTextDisplay } from '../lib/timeline'
import { blockImeSubmit } from '../lib/ime'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import { Button, cx, inputClass, LiveStatus } from './ui'

function statusText(b: Branch) {
  if (b.status === 'concluded') return '已帶回'
  if (b.running) return '討論中'
  if (b.status === 'concluding') return '待確認'
  return '進行中'
}

/** 分岔的輸入框：打字的狀態留在這裡，不會讓整個面板（訊息列表）跟著重繪 */
function BranchInput({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || disabled) return
    setText('')
    onSend(t)
  }
  return (
    <form onSubmit={submit} className="flex">
      <label className="flex flex-1">
        <span className="sr-only">分岔訊息</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={blockImeSubmit}
          disabled={disabled}
          placeholder="繼續在分岔裡討論…"
          className={cx(inputClass, 'flex-1')}
        />
      </label>
    </form>
  )
}

function BranchMessage({ e }: { e: TimelineEvent }) {
  switch (e.kind) {
    case 'user_text':
      return (
        <div className="max-w-[88%] self-end rounded-[16px_16px_6px_16px] bg-fill px-3.5 py-2.5 whitespace-pre-wrap">
          {userTextDisplay(e.text ?? '')}
        </div>
      )
    case 'assistant_text':
      return <Markdown text={e.text ?? ''} />
    case 'tool_result':
      return (
        <div className="line-clamp-4 text-xs break-all whitespace-pre-wrap text-danger">
          工具錯誤：{e.text}
        </div>
      )
    case 'system':
      return <div className="self-center text-xs text-muted">{e.text}</div>
    default:
      return null
  }
}

export function BranchPanel({
  task,
  events,
  readOnly
}: {
  task: Task
  events: TimelineEvent[]
  readOnly?: boolean
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const picked = useStore((s) => s.activeBranch[task.id])
  // 帶回主線／重新整理／確認：IPC 進行中停用按鈕，避免連點送出兩次
  const [acting, runAction] = usePending()
  // 使用者選的分岔不存在（例如開分岔失敗被撤回）時，改顯示還沒帶回的分岔或最後一個
  const b =
    task.branches.find((x) => x.id === picked) ??
    task.branches.find((x) => x.status !== 'concluded') ??
    task.branches.at(-1)
  const branchId = b?.id
  const list = branchId ? events.filter((e) => e.channel === `branch:${branchId}`) : []
  const replied = list.some((e) => e.kind === 'assistant_text')
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${list.length}:${task.updatedAt}`, branchId)
  const fromIndex = b?.fromQuestionId
    ? task.questions.findIndex((q) => q.id === b.fromQuestionId) + 1
    : 0

  const send = (text: string) => {
    if (!b) return
    stick()
    void act(() => call('tasks:send', task.id, `branch:${b.id}`, text))
  }
  const conclude = (id: string) =>
    void runAction(() => act(() => call('branch:conclude', task.id, id)))
  const confirm = (id: string) =>
    void runAction(() => act(() => call('branch:confirm', task.id, id, undefined)))

  return (
    <aside
      aria-label="分岔討論"
      className="flex w-[340px] flex-none flex-col rounded-2xl bg-surface shadow-card"
    >
      <div className="flex flex-col gap-2.5 px-5 pt-[18px] pb-3">
        <span className="text-[15px] font-bold">分岔討論</span>
        {task.branches.length === 0 ? (
          <span className="text-[13px] text-muted">
            還沒有分岔。在 Claude 的訊息旁或問題卡片上按「分岔」，就能另開一段討論，結論再帶回主線。
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {task.branches.map((x) => (
              <button
                key={x.id}
                type="button"
                aria-pressed={x.id === b?.id}
                onClick={() => setActiveBranch(task.id, x.id)}
                className={cx(
                  'cursor-pointer rounded-full px-2.5 py-1',
                  x.id === b?.id ? 'bg-brand-soft font-medium text-brand-ink' : 'bg-fill text-muted'
                )}
              >
                {x.title} · {statusText(x)}
              </button>
            ))}
          </div>
        )}
      </div>

      {b && (
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-2 text-[13px]"
          >
            {fromIndex > 0 && (
              <span className="text-xs text-muted-2">
                從問題 {fromIndex} 分出，帶著主線的上下文
              </span>
            )}
            {list.map((e) => (
              <BranchMessage key={e.id} e={e} />
            ))}
            <LiveStatus text={b.running && 'Claude 正在回覆…'} />
            {b.error && (
              <div role="alert" className="rounded-xl bg-danger-soft px-3.5 py-3 text-danger">
                {b.error}
              </div>
            )}
            {b.conclusion && (
              <div className="flex flex-col gap-1 rounded-[14px] bg-decision px-3.5 py-3">
                <span className="text-xs font-medium text-decision-ink">
                  {b.status === 'concluded' ? '已帶回主線的結論' : '帶回主線的結論（預覽）'}
                </span>
                <span>{b.conclusion.decision}</span>
                {b.conclusion.rationale && (
                  <span className="text-decision-body">原因：{b.conclusion.rationale}</span>
                )}
                {b.conclusion.deferred.length > 0 && (
                  <span className="text-decision-body">
                    延後：{b.conclusion.deferred.join('；')}
                  </span>
                )}
              </div>
            )}
          </div>

          {!readOnly && b.status !== 'concluded' && (
            <div className="flex flex-col gap-2.5 px-5 pt-3.5 pb-5">
              <BranchInput disabled={b.running} onSend={send} />
              {b.status === 'concluding' ? (
                // 看過預覽後可能又討論了幾句：可以請 Claude 重新整理結論
                <div className="flex gap-2">
                  <Button disabled={b.running || acting} onClick={() => conclude(b.id)}>
                    重新整理結論
                  </Button>
                  <Button
                    variant="dark"
                    className="flex-1"
                    disabled={b.running || acting}
                    onClick={() => confirm(b.id)}
                  >
                    確認並帶回主線
                  </Button>
                </div>
              ) : (
                <Button
                  variant="dark"
                  disabled={b.running || acting || !replied}
                  onClick={() => conclude(b.id)}
                >
                  帶回主線
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  )
}
```

**Step 5: ClarifyScreen.tsx（對照 `StyleB.dc.html` 的 `<main>`）**

```tsx
// src/renderer/src/screens/ClarifyScreen.tsx
import type { ReactNode } from 'react'
import type { Task } from '@shared/types'
import { call } from '../api'
import { BranchPanel } from '../components/BranchPanel'
import { Composer } from '../components/Composer'
import { RunStatus, Timeline } from '../components/Timeline'
import { awaitingCounterReply, isBusy } from '../lib/stage'
import { useTimeline } from '../lib/timeline'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'

export function ClarifyScreen({
  task,
  nav,
  readOnly,
  onOpenStage
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
  onOpenStage: (s: 'spec' | 'report') => void
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const events = useTimeline(task.id)
  // 卡片內容（反問回覆等）只改 task 不加事件，所以也看 updatedAt
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${events.length}:${task.updatedAt}`, task.id)
  // 主線執行中不能分岔（主程序會拒絕），但可以插話
  const busy = isBusy(task)
  // 問題卡片在等反問的回答時自己會顯示等待中，底部就不再重複顯示「處理中」
  const cardWaiting = task.questions.some((q) => awaitingCounterReply(task, q))
  const [branching, runBranch] = usePending()
  const branchFrom = (text: string) =>
    runBranch(async () => {
      const title = text
        .replace(/[`*_#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24)
      const b = await act(() =>
        call('branch:open', task.id, {
          title,
          seed: `針對這段內容深入討論：\n${text.slice(0, 600)}`
        })
      )
      if (b) setActiveBranch(task.id, b.id)
    })
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
          <span className="text-lg font-bold">{task.title}</span>
          {nav}
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6"
        >
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-5">
            <Timeline
              task={task}
              channel="main"
              events={events}
              readOnly={readOnly}
              onBranchFrom={busy ? undefined : (t) => void branchFrom(t)}
              branchPending={branching}
              onOpenStage={onOpenStage}
            />
            <RunStatus
              task={task}
              quiet={cardWaiting}
              onResume={() => void act(() => call('run:resume', task.id))}
            />
          </div>
        </div>
        {!readOnly && (
          <div className="px-7 pb-[22px]">
            <div className="mx-auto max-w-[800px]">
              <Composer
                placeholder="補充需求或直接回答…"
                onSend={(t) => {
                  stick()
                  void act(() => call('tasks:send', task.id, 'main', t))
                }}
              />
            </div>
          </div>
        )}
      </main>
      <BranchPanel task={task} events={events} readOnly={readOnly} />
    </>
  )
}
```

**Step 6: TaskScreen 切換到 ClarifyScreen**

```tsx
// src/renderer/src/screens/TaskScreen.tsx
import { useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'
import { ClarifyScreen } from './ClarifyScreen'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  // 使用者回看的階段，只對選它時的任務與狀態有效；換任務或狀態前進就回到目前階段
  const [picked, setPicked] = useState<{ key: string; stage: Stage } | null>(null)
  if (!task) return null
  const key = `${taskId}:${task.status}`
  const current = currentStage(task)
  const shown = picked?.key === key ? picked.stage : current
  const openStage = (s: Stage) => setPicked(s === current ? null : { key, stage: s })
  const nav = <StageNav task={task} shown={shown} onSelect={openStage} />
  // 已丟棄的任務停在哪個階段都只能看
  const ended = task.status === 'discarded' || task.status === 'done'
  if (shown === 'clarify')
    return (
      <ClarifyScreen
        task={task}
        nav={nav}
        readOnly={ended || current !== 'clarify'}
        onOpenStage={openStage}
      />
    )
  // Task 31–33 補上其他階段
  return <ClarifyScreen task={task} nav={nav} readOnly onOpenStage={openStage} />
}
```

**Step 7: 確認通過** — `npx vitest run tests/renderer` 全部通過；`npm run typecheck`、`npm run lint` PASS

**Step 8: 手動驗證（真實 Claude）**

`npm run dev` → 加入一個小 repo → 新任務輸入「在 README 加上安裝說明」→ 確認：時間軸出現需求、Claude 讀檔摘要、問題卡片；反問後卡片內出現回答；按「升級成分岔」右側出現分岔並有 Claude 回覆；「帶回主線」→「確認並帶回主線」後主線出現黃色決策。

**Step 9: Commit**

```bash
git add src/renderer/src tests/renderer/BranchPanel.test.tsx tests/renderer/ClarifyScreen.test.tsx tests/renderer/useStickToBottom.test.tsx docs/plans
git commit -m "feat(ui): add clarify screen with branch panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 31：規格核准畫面

**Files:**
- Create: `src/renderer/src/screens/SpecScreen.tsx`
- Modify: `src/renderer/src/components/Markdown.tsx`（加上 `InlineCode`）
- Modify: `src/renderer/src/screens/TaskScreen.tsx`
- Test: `tests/renderer/SpecScreen.test.tsx`

規格頁依 `docs/design/B3-Spec.dc.html`：左邊是規格（摘要、包含／不包含、決策與來源、實作步驟、驗收條件），底部固定核准列，右邊是釐清紀錄。

- 核准與要求修改共用一個 `usePending`：其中一個送出中兩個都停用，連點只送一次。修改意見用 `<form>`，Enter 也能送出；送出成功才清空（送出期間又改了內容就保留），失敗時保留內容並由 `act` 顯示 toast。
- 修改意見還沒送出就按核准：先提醒，按「放棄意見並核准」才核准（連點核准鈕也不會直接核准）；提醒記下當時的文字，文字改了就要重新確認（render 時推導）。
- Claude 還在這一輪（`isBusy`）時停用兩個按鈕，並在核准列用 `LiveStatus` 說明原因。
- 多個版本時「v2」換成版本下拉選單；選擇存成「選擇 + 當時的最新版本」，Claude 提出新版時自動回到最新版（render 時推導，不在 effect 裡 setState）。看舊版本時停用核准與要求修改（兩者都是針對最新版），並提供「回到 vN」；「根據 N 個問題、M 個分岔整理」是目前的釐清紀錄，看舊版本時不顯示。
- 已核准後回看（目前階段是實作或報告）時標示「已核准的規格」，沒有核准列。
- 規格條目裡的反引號用 `InlineCode` 顯示成 `<code>`（設計稿的決策與步驟都有程式碼片段）。決策列表是 `<ul aria-labelledby>`，邊框用 `chip` token。
- 釐清紀錄：已回答的問題（含反問次數）與分岔；帶回的分岔指向規格中引用它的決策（「→ D2」）。設計稿的「回到對話繼續補充」改成「查看釐清對話」：規格待核准時釐清畫面只能回看，要補充需求請用「要求修改」。

**Step 1: 寫失敗測試**

```tsx
// tests/renderer/SpecScreen.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { SpecScreen } from '@renderer/screens/SpecScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Spec, Task } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const spec = (version: number, over: Partial<Spec> = {}): Spec => ({
  version,
  title: '以帳號 + IP 計數的登入失敗鎖定',
  summary: '同一帳號從同一 IP 連續登入失敗 5 次，就鎖定 15 分鐘。',
  inScope: ['失敗計數與鎖定的中介層'],
  outOfScope: ['後台手動解鎖介面'],
  decisions: [
    { id: 'd1', text: '計數單位為帳號 + IP 組合', source: { type: 'question', ref: 'q1' } },
    { id: 'd2', text: '計數存在 `lockout:{userId}`', source: { type: 'branch', ref: 'b1' } },
    { id: 'd3', text: '錯誤訊息放進 i18n', source: { type: 'implementation', ref: '' } }
  ],
  steps: ['新增 `src/auth/lockout.ts`', '在 login.ts 掛上 lockoutGuard'],
  acceptance: ['第 6 次請求回 429'],
  createdAt: '',
  ...over
})

const specTask = (over: Partial<Task> = {}) =>
  makeTask({
    status: 'spec_review',
    specs: [spec(1)],
    questions: [
      {
        id: 'q1',
        text: '計數單位',
        options: [{ id: 'combo', label: '帳號 + IP 組合' }],
        allowFreeText: true,
        status: 'answered',
        answer: { optionId: 'combo', text: '共用 IP 也分開算' },
        followups: [
          { role: 'user', text: '共用 IP 呢？' },
          { role: 'assistant', text: '會分開算。' }
        ],
        askedAt: ''
      },
      {
        id: 'q2',
        text: '還沒回答的問題',
        options: [],
        allowFreeText: true,
        status: 'open',
        followups: [],
        askedAt: ''
      }
    ],
    branches: [
      {
        id: 'b1',
        title: '計數存放位置',
        status: 'concluded',
        running: false,
        conclusion: { decision: '用既有 Redis', rationale: '', deferred: [] },
        createdAt: ''
      },
      { id: 'b2', title: '通知使用者', status: 'open', running: false, createdAt: '' }
    ],
    ...over
  })

const renderSpec = (task: Task, readOnly = false) =>
  render(<SpecScreen task={task} nav={null} readOnly={readOnly} onOpenStage={() => {}} />)

beforeEach(() => {
  vi.mocked(call).mockReset()
  vi.mocked(call).mockResolvedValue(undefined)
  resetStoreInternals()
  useStore.setState({ timelines: {}, toast: undefined })
})

test('顯示規格內容與每個決策的來源', () => {
  renderSpec(specTask())
  expect(
    screen.getByRole('heading', { name: '以帳號 + IP 計數的登入失敗鎖定' })
  ).toBeInTheDocument()
  expect(screen.getByText(/規格草稿/)).toHaveTextContent('根據 1 個問題、1 個分岔整理')
  expect(screen.getByText('• 失敗計數與鎖定的中介層')).toBeInTheDocument()
  expect(screen.getByText('• 後台手動解鎖介面')).toBeInTheDocument()
  const decisions = screen.getByRole('list', { name: '決策' })
  const rows = within(decisions).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual([
    'D1計數單位為帳號 + IP 組合問題 1',
    'D2計數存在 lockout:{userId}分岔',
    'D3錯誤訊息放進 i18n實作'
  ])
  // 反引號包住的內容顯示成程式碼
  expect(within(rows[1]).getByText('lockout:{userId}').tagName).toBe('CODE')
  expect(screen.getByText('src/auth/lockout.ts').tagName).toBe('CODE')
  expect(screen.getByText('• 第 6 次請求回 429')).toBeInTheDocument()
})

test('釐清紀錄列出已回答的問題與分岔', () => {
  renderSpec(specTask())
  const aside = screen.getByRole('complementary', { name: '釐清紀錄' })
  expect(within(aside).getByText('問題 1 · 計數單位')).toBeInTheDocument()
  expect(within(aside).getByText('帳號 + IP 組合；共用 IP 也分開算')).toBeInTheDocument()
  expect(within(aside).getByText('含 1 次反問')).toBeInTheDocument()
  expect(within(aside).queryByText(/還沒回答的問題/)).not.toBeInTheDocument()
  // 帶回的分岔指向規格裡引用它的決策
  expect(within(aside).getByText('分岔 · 計數存放位置')).toBeInTheDocument()
  expect(within(aside).getByText('→ D2')).toBeInTheDocument()
  expect(within(aside).getByText('尚未帶回')).toBeInTheDocument()
})

test('核准規格；進行中停用按鈕，連點只送一次', async () => {
  const release = holdNextCall(vi.mocked(call))
  renderSpec(specTask())
  const approve = screen.getByRole('button', { name: '核准並開始實作' })
  await userEvent.dblClick(approve)
  expect(call).toHaveBeenCalledTimes(1)
  expect(call).toHaveBeenCalledWith('spec:approve', 't1')
  expect(approve).toBeDisabled()
  expect(screen.getByRole('button', { name: '要求修改' })).toBeDisabled()
  await release()
  expect(approve).toBeEnabled()
})

test('要求修改：沒有內容時停用；送出後清空，Enter 也能送出', async () => {
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  const button = screen.getByRole('button', { name: '要求修改' })
  expect(button).toBeDisabled()
  await userEvent.type(input, '   ')
  expect(button).toBeDisabled()
  await userEvent.clear(input)
  await userEvent.type(input, '上限改成 10 次')
  await userEvent.click(button)
  expect(call).toHaveBeenCalledWith('spec:requestChanges', 't1', '上限改成 10 次')
  expect(input).toHaveValue('')
  await userEvent.type(input, '鎖定改 30 分鐘{Enter}')
  expect(call).toHaveBeenLastCalledWith('spec:requestChanges', 't1', '鎖定改 30 分鐘')
})

test('要求修改：輸入法選字中的 Enter 不送出', async () => {
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改成十次')
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false)
  expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false)
  expect(call).not.toHaveBeenCalledWith('spec:requestChanges', 't1', '上限改成十次')
  expect(input).toHaveValue('上限改成十次')
})

test('要求修改失敗時保留內容並顯示錯誤', async () => {
  vi.mocked(call).mockRejectedValueOnce(new Error('任務正在收尾，請稍候'))
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改成 10 次{Enter}')
  expect(input).toHaveValue('上限改成 10 次')
  expect(useStore.getState().toast?.text).toContain('任務正在收尾')
})

test('Claude 還在執行時不能核准或要求修改，並說明原因', async () => {
  renderSpec(specTask({ runState: 'running' }))
  await userEvent.type(screen.getByRole('textbox', { name: '修改意見' }), '改')
  expect(screen.getByRole('button', { name: '要求修改' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Claude 正在處理')
})

test('可切換版本；看舊版本時不能核准；Claude 提出新版時回到最新版', async () => {
  const task = specTask({ specs: [spec(1, { title: '第一版' }), spec(2, { title: '第二版' })] })
  const { rerender } = renderSpec(task)
  expect(screen.getByRole('heading', { name: '第二版' })).toBeInTheDocument()
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '規格版本' }), 'v1')
  expect(screen.getByRole('heading', { name: '第一版' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeDisabled()
  expect(screen.getByText(/正在看 v1（舊版本）/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '回到 v2' }))
  expect(screen.getByRole('heading', { name: '第二版' })).toBeInTheDocument()

  await userEvent.selectOptions(screen.getByRole('combobox', { name: '規格版本' }), 'v1')
  rerender(
    <SpecScreen
      task={{ ...task, specs: [...task.specs, spec(3, { title: '第三版' })] }}
      nav={null}
      readOnly={false}
      onOpenStage={() => {}}
    />
  )
  expect(screen.getByRole('heading', { name: '第三版' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeEnabled()
})

test('唯讀（已核准後回看）時沒有核准列，標示為已核准的規格', () => {
  renderSpec(specTask({ status: 'implementing' }), true)
  expect(screen.queryByRole('button', { name: '核准並開始實作' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '修改意見' })).not.toBeInTheDocument()
  expect(screen.getByText(/已核准的規格/)).toBeInTheDocument()
})

test('從釐清紀錄回到釐清對話', async () => {
  const onOpenStage = vi.fn()
  render(<SpecScreen task={specTask()} nav={null} readOnly={false} onOpenStage={onOpenStage} />)
  await userEvent.click(screen.getByRole('button', { name: '查看釐清對話' }))
  expect(onOpenStage).toHaveBeenCalledWith('clarify')
})

test('TaskScreen：規格待核准時顯示規格畫面', () => {
  useStore.setState({ tasks: { t1: specTask() } })
  render(<TaskScreen taskId="t1" />)
  expect(
    screen.getByRole('heading', { name: '以帳號 + IP 計數的登入失敗鎖定' })
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核准並開始實作' })).toBeInTheDocument()
})

test('TaskScreen：已丟棄的任務停在規格時唯讀', () => {
  useStore.setState({ tasks: { t1: specTask({ status: 'discarded' }) } })
  render(<TaskScreen taskId="t1" />)
  expect(
    screen.getByRole('heading', { name: '以帳號 + IP 計數的登入失敗鎖定' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '核准並開始實作' })).not.toBeInTheDocument()
  expect(screen.getByText(/規格草稿/)).toBeInTheDocument()
})

test('看舊版本時不顯示根據幾個問題整理（那是目前的釐清紀錄）', async () => {
  renderSpec(specTask({ specs: [spec(1, { title: '第一版' }), spec(2, { title: '第二版' })] }))
  expect(screen.getByText(/規格草稿/)).toHaveTextContent('根據 1 個問題、1 個分岔整理')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '規格版本' }), 'v1')
  expect(screen.getByText(/規格草稿/)).not.toHaveTextContent('根據')
})

test('修改意見還沒送出就按核准：先提醒，確認放棄才核准', async () => {
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改 10 次')
  await userEvent.click(screen.getByRole('button', { name: '核准並開始實作' }))
  expect(call).not.toHaveBeenCalled()
  expect(screen.getByText(/修改意見還沒送出/)).toBeInTheDocument()
  // 改了內容就重新確認
  await userEvent.type(input, '，鎖 30 分鐘')
  expect(screen.queryByText(/修改意見還沒送出/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '核准並開始實作' }))
  await userEvent.click(screen.getByRole('button', { name: '放棄意見並核准' }))
  expect(call).toHaveBeenCalledWith('spec:approve', 't1')
})

test('送出修改意見期間又改了內容就保留', async () => {
  const release = holdNextCall(vi.mocked(call))
  renderSpec(specTask())
  const input = screen.getByRole('textbox', { name: '修改意見' })
  await userEvent.type(input, '上限改 10 次{Enter}')
  expect(call).toHaveBeenCalledWith('spec:requestChanges', 't1', '上限改 10 次')
  await userEvent.type(input, '，還有鎖 30 分鐘')
  await release()
  expect(input).toHaveValue('上限改 10 次，還有鎖 30 分鐘')
})
```

**Step 2: 確認失敗** — `npx vitest run tests/renderer/SpecScreen.test.tsx` → FAIL（模組不存在）

**Step 3: Markdown.tsx 加上 InlineCode**

```tsx
/** 單行文字（規格條目、步驟標題）：只把反引號包住的部分顯示成程式碼，其餘照原文 */
export function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`\n]+`)/)
        .map((part, i) => (i % 2 === 1 ? <code key={i}>{part.slice(1, -1)}</code> : part || null))}
    </>
  )
}
```

**Step 4: SpecScreen.tsx（對照 `docs/design/B3-Spec.dc.html`）**

```tsx
// src/renderer/src/screens/SpecScreen.tsx
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import type { DecisionSource, Spec, Task } from '@shared/types'
import { call } from '../api'
import { InlineCode } from '../components/Markdown'
import { Button, cx, inputClass, LiveStatus, Pill } from '../components/ui'
import { blockImeSubmit } from '../lib/ime'
import { currentStage, isBusy } from '../lib/stage'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'

function SourcePill({ task, source }: { task: Task; source: DecisionSource }) {
  if (source.type === 'branch') return <Pill tone="decision">分岔</Pill>
  if (source.type === 'question') {
    const i = task.questions.findIndex((q) => q.id === source.ref)
    return <Pill>{i >= 0 ? `問題 ${i + 1}` : '問題'}</Pill>
  }
  return <Pill tone="muted">實作</Pill>
}

/** 右側的釐清紀錄：已回答的問題與分岔（分岔指向規格裡引用它的決策） */
function ClarifyLog({
  task,
  spec,
  onOpenClarify
}: {
  task: Task
  spec: Spec
  onOpenClarify: () => void
}) {
  const answered = task.questions.filter((q) => q.status === 'answered')
  return (
    <aside
      aria-label="釐清紀錄"
      className="flex w-[320px] flex-none flex-col gap-3 overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card"
    >
      <span className="text-[15px] font-bold">釐清紀錄</span>
      <div className="flex flex-col gap-2.5 text-[13px]">
        {answered.length === 0 && task.branches.length === 0 && (
          <span className="text-muted">沒有回答過的問題或分岔。</span>
        )}
        {answered.map((q) => {
          const label = q.answer?.optionId
            ? q.options.find((o) => o.id === q.answer?.optionId)?.label
            : undefined
          const asked = q.followups.filter((f) => f.role === 'user').length
          return (
            <div key={q.id} className="flex flex-col gap-0.5 rounded-xl bg-fill-2 p-3">
              <span className="text-muted">
                問題 {task.questions.indexOf(q) + 1} · {q.text}
              </span>
              <span className="font-medium">
                {[label, q.answer?.text].filter(Boolean).join('；')}
              </span>
              {asked > 0 && <span className="text-xs text-muted">含 {asked} 次反問</span>}
            </div>
          )
        })}
        {task.branches.map((b) => {
          const d = spec.decisions.find((x) => x.source.type === 'branch' && x.source.ref === b.id)
          return (
            <div key={b.id} className="flex flex-col gap-0.5 rounded-xl bg-decision p-3">
              <span className="text-decision-ink">分岔 · {b.title}</span>
              <span>
                {d
                  ? `→ ${d.id.toUpperCase()}`
                  : b.conclusion
                    ? `→ ${b.conclusion.decision}`
                    : '尚未帶回'}
              </span>
            </div>
          )
        })}
      </div>
      {/* 規格待核准時釐清對話只能回看；要補充需求請用「要求修改」 */}
      <button
        type="button"
        onClick={onOpenClarify}
        className="mt-1 cursor-pointer self-start text-[13px] text-brand hover:text-brand-hover"
      >
        查看釐清對話
      </button>
    </aside>
  )
}

export function SpecScreen({
  task,
  nav,
  readOnly,
  onOpenStage
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
  onOpenStage: (s: 'clarify') => void
}) {
  const act = useStore((s) => s.act)
  const decisionsId = useId()
  // 使用者選的版本只在「最新版本」沒變時有效；Claude 提出新版規格時自動顯示最新版
  const latest = task.specs.length
  const [picked, setPicked] = useState<{ latest: number; version: number }>()
  const version = picked?.latest === latest ? picked.version : latest
  const [feedback, setFeedback] = useState('')
  // 修改意見還沒送出就按核准時記下那段文字；文字改了就要重新確認（render 時推導）
  const [confirmFor, setConfirmFor] = useState<string>()
  // 核准與要求修改共用：其中一個送出中時兩個都停用
  const [pending, run] = usePending()
  const spec = task.specs[version - 1] ?? task.specs.at(-1)

  const header = (
    <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
      <span className="text-lg font-bold">{task.title}</span>
      {nav}
    </div>
  )
  if (!spec)
    return (
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        {header}
        <div className="px-7 text-muted">還沒有規格。</div>
      </main>
    )

  const answered = task.questions.filter((q) => q.status === 'answered').length
  const concluded = task.branches.filter((b) => b.status === 'concluded').length
  const stage = currentStage(task)
  const approved = stage === 'implement' || stage === 'report'
  const viewingOld = spec.version !== latest
  // Claude 還在這一輪（例如剛提出規格、還沒結束）：等它停下來再核准或要求修改
  const busy = isBusy(task)
  const blocked = pending || busy || viewingOld

  const unsent = feedback.trim()
  const confirming = !!unsent && confirmFor === unsent
  // 修改意見還沒送出就按核准：先提醒，按「放棄意見並核准」才真的核准（連點核准鈕也不會）
  const approve = (discardFeedback = false) => {
    if (unsent && !discardFeedback) {
      setConfirmFor(unsent)
      return
    }
    void run(() => act(() => call('spec:approve', task.id)))
  }
  const requestChanges = (e: FormEvent) => {
    e.preventDefault()
    const text = feedback.trim()
    if (!text || blocked) return
    void run(async () => {
      const ok = await act(async () => {
        await call('spec:requestChanges', task.id, text)
        return true
      })
      // 送出期間又改了內容就保留
      if (ok) setFeedback((cur) => (cur.trim() === text ? '' : cur))
    })
  }

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        {header}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6">
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-[22px]">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-brand">
                {approved && !viewingOld ? '已核准的規格' : '規格草稿'}{' '}
                {task.specs.length > 1 ? (
                  <select
                    aria-label="規格版本"
                    value={spec.version}
                    onChange={(e) => setPicked({ latest, version: Number(e.target.value) })}
                    className="cursor-pointer rounded-md bg-fill px-1.5 py-0.5 outline-none focus-visible:shadow-[0_0_0_2px_var(--color-brand)]"
                  >
                    {task.specs.map((s) => (
                      <option key={s.version} value={s.version}>
                        v{s.version}
                      </option>
                    ))}
                  </select>
                ) : (
                  `v${spec.version}`
                )}
                {/* 釐清紀錄是目前的狀態，不一定是舊版本當時的依據 */}
                {!viewingOld && ` · 根據 ${answered} 個問題、${concluded} 個分岔整理`}
              </span>
              <h1 className="m-0 text-2xl font-bold">{spec.title}</h1>
              <span className="text-ink-2">
                <InlineCode text={spec.summary} />
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5 rounded-[14px] bg-brand-tint p-4">
                <span className="text-[13px] font-bold text-brand-ink">包含</span>
                {spec.inScope.map((s, i) => (
                  <span key={i} className="text-[13px]">
                    • <InlineCode text={s} />
                  </span>
                ))}
              </div>
              <div className="flex flex-col gap-1.5 rounded-[14px] bg-fill-2 p-4">
                <span className="text-[13px] font-bold text-ink-2">不包含</span>
                {spec.outOfScope.length ? (
                  spec.outOfScope.map((s, i) => (
                    <span key={i} className="text-[13px] text-ink-2">
                      • <InlineCode text={s} />
                    </span>
                  ))
                ) : (
                  <span className="text-[13px] text-muted">—</span>
                )}
              </div>
            </div>

            {spec.decisions.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span id={decisionsId} className="text-[15px] font-bold">
                  決策
                </span>
                <ul
                  aria-labelledby={decisionsId}
                  className="m-0 flex list-none flex-col overflow-hidden rounded-[14px] p-0 shadow-[0_0_0_1px_var(--color-chip)]"
                >
                  {spec.decisions.map((d, i) => (
                    <li
                      key={d.id}
                      className={cx(
                        'grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-3',
                        i < spec.decisions.length - 1 && 'border-b border-line-soft'
                      )}
                    >
                      <span className="font-mono text-xs text-muted">{d.id.toUpperCase()}</span>
                      <span>
                        <InlineCode text={d.text} />
                      </span>
                      <SourcePill task={task} source={d.source} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              <span className="text-[15px] font-bold">實作步驟</span>
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {spec.steps.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex size-6 flex-none items-center justify-center rounded-full bg-fill text-xs">
                      {i + 1}
                    </span>
                    <span>
                      <InlineCode text={s} />
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[15px] font-bold">驗收條件</span>
              {spec.acceptance.map((a, i) => (
                <span key={i} className="text-[13px]">
                  • <InlineCode text={a} />
                </span>
              ))}
            </div>
          </div>
        </div>

        {!readOnly && task.status === 'spec_review' && (
          <div className="rounded-b-2xl border-t border-line-soft bg-surface px-7 py-4">
            <form
              onSubmit={requestChanges}
              className="mx-auto flex max-w-[800px] flex-wrap items-center gap-2.5"
            >
              <label className="flex flex-[1_1_260px]">
                <span className="sr-only">修改意見</span>
                <input
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={blockImeSubmit}
                  placeholder="哪裡要改？例如：上限改成 10 次"
                  className={cx(inputClass, 'h-11 flex-1')}
                />
              </label>
              <Button type="submit" disabled={blocked || !feedback.trim()}>
                要求修改
              </Button>
              <Button
                variant="primary"
                className="px-5"
                disabled={blocked}
                onClick={() => approve()}
              >
                核准並開始實作
              </Button>
            </form>
            <div className="mx-auto mt-2 max-w-[800px] text-xs text-muted">
              {viewingOld ? (
                <>
                  正在看 v{spec.version}（舊版本），核准與修改意見都是針對最新的 v{latest}。{' '}
                  <button
                    type="button"
                    onClick={() => setPicked(undefined)}
                    className="cursor-pointer text-brand hover:text-brand-hover"
                  >
                    回到 v{latest}
                  </button>
                </>
              ) : confirming ? (
                <span className="text-decision-ink">
                  修改意見還沒送出。要放棄這段意見直接核准，或先按「要求修改」送出。{' '}
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => approve(true)}
                    className="cursor-pointer font-medium text-brand hover:text-brand-hover disabled:cursor-default disabled:opacity-50"
                  >
                    放棄意見並核准
                  </button>
                </span>
              ) : (
                <>
                  核准後 Claude 會在 worktree <code className="break-all">{task.worktreePath}</code>
                  （分支 <code>{task.branch}</code>）中修改程式碼。
                </>
              )}
            </div>
            <LiveStatus
              text={busy && 'Claude 正在處理，這一輪結束後就能核准或要求修改'}
              className={cx('mx-auto max-w-[800px] text-xs', busy && 'mt-2')}
            />
          </div>
        )}
      </main>

      <ClarifyLog task={task} spec={spec} onOpenClarify={() => onOpenStage('clarify')} />
    </>
  )
}
```

**Step 5: TaskScreen 加入規格頁** — 在 `switch (shown)` 加上 `case 'spec': return <SpecScreen task={task} nav={nav} readOnly={readOnly} onOpenStage={openStage} />`（`readOnly = ended || shown !== current`，完整檔案見 Task 32 Step 8）。

**Step 6: 確認通過** — `npx vitest run tests/renderer` 全部通過；`npm run typecheck`、`npm run lint` PASS

**Step 7: 手動驗證** — 在釐清中回答到 Claude 提出規格，畫面自動切到規格頁，可要求修改（回到釐清）與核准（進入實作）。

**Step 8: Commit**

```bash
git add src/renderer/src tests/renderer/SpecScreen.test.tsx docs/plans
git commit -m "feat(ui): add spec review screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 32：實作進度畫面與指令核准對話框

**Files:**
- Create: `src/renderer/src/lib/permission.ts`（對話框的內容、停用時間）
- Create: `src/renderer/src/components/PermissionDialog.tsx`
- Create: `src/renderer/src/screens/ImplementScreen.tsx`
- Modify: `src/renderer/src/lib/timeline.ts`（`implementEvents`）
- Modify: `src/renderer/src/components/ui.tsx`（`Avatar` 可傳 `className`）
- Modify: `src/renderer/src/components/Composer.tsx`（`inputRef`：對話框關掉後焦點回到輸入框）
- Modify: `src/renderer/src/styles/app.css`（補 `code-muted` token：深色區塊裡的次要文字）
- Modify: `src/renderer/src/screens/ClarifyScreen.tsx`、`src/renderer/src/screens/SpecScreen.tsx`（顯示核准對話框）
- Modify: `src/renderer/src/screens/TaskScreen.tsx`
- Test: `tests/renderer/PermissionDialog.test.tsx`、`tests/renderer/ImplementScreen.test.tsx`、`tests/renderer/ClarifyScreen.test.tsx`、`tests/renderer/SpecScreen.test.tsx`

實作頁依 `docs/design/B4-Implement.dc.html`：進度條、步驟（完成／進行中／待做），進行中的步驟裡列出最近的工具呼叫，下面是這一段實作的對話，底部插話框與停止；右邊是變更檔案、本任務已允許的指令與 worktree。

- **實作從哪裡開始**：實作頁只顯示最後一個實作起點（核准規格或送出報告回饋寫入的 user_text 帶 `ref: IMPLEMENT_START_REF`，見 Task 5）之後的主線事件；整份時間軸都沒有標記的舊任務才用 `legacyImplementStart` 比對文字。找不到起點（剛核准、訊息還沒寫入）時是空的，不會閃出釐清階段的對話。
- **核准對話框**（`PendingPermission` → `PermissionDialog`，以請求 id 為 key：請求排隊時換下一個會重設勾選、拒絕原因與停用時間）
  - 出現後 500ms 內（`APPROVAL_ARM_MS`）停用「允許」「拒絕並說明」「送出拒絕」：連點「允許」時第二下不會核准到下一個排隊的請求，對話框突然出現在游標下也不會被誤按。允許／拒絕用 `usePending`。
  - 焦點：出現時移到對話框本身（使用者可能正在輸入框打字；刻意不放在「允許」上，免得按 Enter 就核准），下一個請求出現時移到新的對話框；請求都處理完後還給原本的位置，原本沒有焦點或拿不到（還被遮罩擋住）時交給畫面的 `fallbackFocus`（插話框）。`aria-describedby` 指向指令／目標區塊；拒絕模式按 Esc 回到按鈕。
  - 有等待中的請求時，遮罩後面的內容（標題、捲動區、插話框）包在 `display: contents` 的 `inert` 容器裡，鍵盤與滑鼠都碰不到。
  - 分岔提出的請求（`request.channel`）標題寫成「分岔「名稱」想…」。
  - Bash：顯示 `$ 指令`、cwd、原因（`description`）；有 `suggestedPattern` 才有「本任務內都允許」勾選框；串接的指令沒有樣式，改說明只能逐次核准。
  - Edit／Write／MultiEdit／NotebookEdit：主程序只對 `.git`、`.claude/`、`.mcp.json` 詢問，所以顯示相對路徑、工具名稱、說明「這個檔案會影響 Claude 的權限或 git 設定」，以及要寫入的內容（Write 全文、Edit 的 `-`／`+` 取代前後）；超過 1500 字先顯示開頭，按「顯示完整內容」展開。
  - WebFetch 顯示網址與用途（`prompt`），WebSearch 顯示搜尋字詞，其他工具顯示 JSON。
  - 釐清中 Claude（主線或分岔）讀網頁、搜尋網路也會要求核准，所以釐清頁與規格頁也掛 `PendingPermission`（規格頁連「還沒有規格」的畫面也有）；回看其他階段時有請求一樣會跳出（請求會卡住 Claude，不能只在實作頁看得到）。
- **進行中的步驟**：列出最近 8 個工具呼叫，路徑相對於 worktree；等待核准的呼叫比較早、不在其中時列最近 7 個＋它（放在最後一列）。等待核准的呼叫以請求的 `toolUseId` 對應（舊資料沒有 id 時找最近一個相同的呼叫）並標「等待核准」；使用者拒絕的標「已拒絕」（`tool.denied`），其他錯誤標「失敗」。還沒列出步驟（剛開始讀程式碼）或步驟之間 Claude 仍在執行時，另顯示「正在規劃步驟／最近的動作」。步驟狀態：等待核准、進行中、等你回答（有畫出來的開放問題）、暫停中。
- **問題卡片**：這段實作裡出現的問題照時間軸位置畫（重新提問過的只畫最後一次）；開放中但這段實作沒出現過的問題（例如核准前提出、還沒回答）放在最上方，不會沒有地方回答。
- **對話**：插話（標「你插話」）、Claude 的回覆、問題卡片與系統訊息；捲動區用 `useStickToBottom`。
- **插話與停止**：整理報告中主程序不接受主線訊息，插話框停用；停止只在執行中顯示，用 `usePending`。
- **變更檔案**：執行中每 5 秒重新讀取 `tasks:changedFiles`（上一次讀完才排下一次），停下來時再讀一次就不再輪詢；從來沒讀到時顯示「無法讀取變更」。設計稿的「新增／修改」標籤需要檔案狀態，`DiffStats` 只有增刪行數，改顯示每個檔案的 +／−。
- 標題下的分支名稱旁設計稿有經過時間，沒有可靠的開始時間來源，先不顯示。
- 顏色只用 tokens：遮罩 `bg-ink/28`（= `rgba(28,36,48,0.28)`），cwd 文字 `code-muted`，待做步驟的圓圈 `line-strong`。

**Step 1: 寫失敗測試**

```tsx
// tests/renderer/PermissionDialog.test.tsx
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { PendingPermission, PermissionDialog } from '@renderer/components/PermissionDialog'
import { APPROVAL_ARM_MS, PREVIEW_COLLAPSED } from '@renderer/lib/permission'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { PermissionRequest, Task } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

const req: PermissionRequest = {
  id: 'p1',
  taskId: 't1',
  channel: 'main',
  toolName: 'Bash',
  input: { command: 'npm test -- auth', description: '跑 auth 測試' },
  suggestedPattern: 'npm test *',
  createdAt: ''
}
const next: PermissionRequest = {
  ...req,
  id: 'p2',
  input: { command: 'npm run lint' },
  suggestedPattern: 'npm run *'
}

// 對話框剛出現時按鈕先停用一小段時間，測試用假時鐘跳過
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
const armed = () => act(() => vi.advanceTimersByTimeAsync(APPROVAL_ARM_MS))
const renderDialog = async (r: PermissionRequest = req) => {
  const view = render(<PermissionDialog request={r} cwd="/wt" />)
  await armed()
  return view
}

/** 畫面上的輸入框＋核准對話框（模擬實作頁：對話框關掉後焦點回到插話框） */
function Screen({ task }: { task: Task }) {
  const composer = useRef<HTMLInputElement>(null)
  return (
    <>
      <input aria-label="插話" ref={composer} />
      <input aria-label="分岔訊息" />
      <PendingPermission task={task} fallbackFocus={() => composer.current} />
    </>
  )
}

beforeEach(() => {
  // shouldAdvanceTime：Testing Library 內部的 setTimeout(0) 照常推進（它只會推 Jest 的假時鐘）
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.mocked(call).mockReset()
  vi.mocked(call).mockResolvedValue(undefined)
  resetStoreInternals()
  useStore.setState({ toast: undefined })
})
afterEach(() => {
  vi.useRealTimers()
})

test('顯示指令與原因，勾選後允許並記住樣式', async () => {
  await renderDialog()
  const u = user()
  const dialog = screen.getByRole('dialog', { name: 'Claude 想執行這個指令' })
  expect(dialog).toHaveAccessibleDescription(/\$ npm test -- auth.*cwd: \/wt/)
  expect(screen.getByText(/跑 auth 測試/)).toBeInTheDocument()
  await u.click(screen.getByRole('checkbox', { name: /本任務內都允許/ }))
  await u.click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', {
    allow: true,
    rememberPattern: 'npm test *'
  })
})

test('沒有勾選時只允許這一次', async () => {
  await renderDialog()
  await user().click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: true })
})

test('拒絕並說明', async () => {
  await renderDialog()
  const u = user()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await u.type(screen.getByRole('textbox', { name: '拒絕原因' }), '先不要跑')
  await u.click(screen.getByRole('button', { name: '送出拒絕' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', {
    allow: false,
    message: '先不要跑'
  })
})

test('拒絕原因：輸入法選字中按 Esc 不離開拒絕模式', async () => {
  await renderDialog()
  const u = user()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  const reason = screen.getByRole('textbox', { name: '拒絕原因' })
  await u.type(reason, '先不要')
  fireEvent.keyDown(reason, { key: 'Escape', isComposing: true })
  fireEvent.keyDown(reason, { key: 'Escape', keyCode: 229 })
  expect(screen.getByRole('textbox', { name: '拒絕原因' })).toHaveValue('先不要')
})

test('不寫原因也能拒絕；返回或按 Esc 離開拒絕模式', async () => {
  await renderDialog()
  const u = user()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  expect(screen.getByRole('textbox', { name: '拒絕原因' })).toHaveFocus()
  await u.click(screen.getByRole('button', { name: '返回' }))
  expect(screen.queryByRole('textbox', { name: '拒絕原因' })).not.toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('textbox', { name: '拒絕原因' })).not.toBeInTheDocument()
  expect(screen.getByRole('dialog')).toHaveFocus()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await u.click(screen.getByRole('button', { name: '送出拒絕' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: false })
})

test('送出中停用按鈕，連點只送一次', async () => {
  await renderDialog()
  const release = holdNextCall(vi.mocked(call))
  const allow = screen.getByRole('button', { name: '允許' })
  await user().dblClick(allow)
  expect(call).toHaveBeenCalledTimes(1)
  expect(allow).toBeDisabled()
  expect(screen.getByRole('button', { name: '拒絕並說明' })).toBeDisabled()
  await release()
  expect(allow).toBeEnabled()
})

test('新的請求出現後先停用一下：連點不會核准到下一個請求', async () => {
  const u = user()
  const { rerender } = render(<PendingPermission task={makeTask({ pendingPermission: req })} />)
  // 剛出現時也停用
  expect(screen.getByRole('button', { name: '允許' })).toBeDisabled()
  await armed()
  await u.click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledTimes(1)
  // 主程序顯示下一個請求；使用者的第二下點擊落在新的對話框上
  rerender(<PendingPermission task={makeTask({ pendingPermission: next })} />)
  const allow = screen.getByRole('button', { name: '允許' })
  expect(allow).toBeDisabled()
  expect(screen.getByRole('button', { name: '拒絕並說明' })).toBeDisabled()
  await u.click(allow)
  expect(call).toHaveBeenCalledTimes(1)
  await armed()
  expect(allow).toBeEnabled()
})

test('核准失敗（請求已失效）時顯示錯誤', async () => {
  vi.mocked(call).mockRejectedValueOnce(new Error('這個核准請求已經失效'))
  await renderDialog()
  await user().click(screen.getByRole('button', { name: '允許' }))
  expect(useStore.getState().toast?.text).toContain('已經失效')
})

test('串接的指令不能記住樣式', async () => {
  await renderDialog({
    ...req,
    input: { command: 'npm test && rm -rf dist' },
    suggestedPattern: undefined
  })
  expect(screen.getByText('$ npm test && rm -rf dist')).toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.getByText(/只能逐次核准/)).toBeInTheDocument()
})

test('修改受保護的檔案：顯示工具、相對路徑、說明與要寫入的內容', async () => {
  await renderDialog({
    ...req,
    toolName: 'Edit',
    input: {
      file_path: '/wt/.claude/settings.json',
      old_string: '"allow": []',
      new_string: '"allow": ["Bash(*)"]'
    },
    suggestedPattern: undefined
  })
  expect(screen.getByRole('dialog', { name: 'Claude 想修改這個檔案' })).toBeInTheDocument()
  expect(screen.getByText('.claude/settings.json')).toBeInTheDocument()
  expect(screen.getByText('Edit · cwd: /wt')).toBeInTheDocument()
  expect(screen.getByText('這個檔案會影響 Claude 的權限或 git 設定')).toBeInTheDocument()
  expect(screen.getByLabelText('要寫入的內容')).toHaveTextContent(
    '- "allow": [] + "allow": ["Bash(*)"]'
  )
  expect(screen.queryByRole('button', { name: /顯示完整內容/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
})

test('內容很長時先顯示開頭，可以展開完整內容', async () => {
  const content = `${'a'.repeat(PREVIEW_COLLAPSED)}TAIL`
  await renderDialog({
    ...req,
    toolName: 'Write',
    input: { file_path: '/wt/.git/hooks/pre-commit', content },
    suggestedPattern: undefined
  })
  const preview = screen.getByLabelText('要寫入的內容')
  expect(preview).not.toHaveTextContent('TAIL')
  await user().click(screen.getByRole('button', { name: /顯示完整內容/ }))
  expect(preview).toHaveTextContent('TAIL')
  expect(screen.queryByRole('button', { name: /顯示完整內容/ })).not.toBeInTheDocument()
})

test('WebFetch 顯示網址與用途；WebSearch 顯示搜尋字詞', async () => {
  const { unmount } = await renderDialog({
    ...req,
    toolName: 'WebFetch',
    input: { url: 'https://example.com/docs', prompt: '找出 API 的速率限制' },
    suggestedPattern: undefined
  })
  expect(screen.getByRole('dialog', { name: 'Claude 想讀取這個網頁' })).toBeInTheDocument()
  expect(screen.getByText('https://example.com/docs')).toBeInTheDocument()
  expect(screen.getByText('WebFetch')).toBeInTheDocument()
  expect(screen.getByText('用途：找出 API 的速率限制')).toBeInTheDocument()
  unmount()
  await renderDialog({ ...req, toolName: 'WebSearch', input: { query: 'redis ttl' } })
  expect(screen.getByRole('dialog', { name: 'Claude 想搜尋網路' })).toBeInTheDocument()
  expect(screen.getByText('redis ttl')).toBeInTheDocument()
})

test('分岔提出的請求標出是哪個分岔', () => {
  render(
    <PendingPermission
      task={makeTask({
        branches: [{ id: 'b1', title: '查資料', status: 'open', running: true, createdAt: '' }],
        pendingPermission: {
          ...req,
          channel: 'branch:b1',
          toolName: 'WebFetch',
          input: { url: 'https://example.com' },
          suggestedPattern: undefined
        }
      })}
    />
  )
  expect(screen.getByRole('dialog', { name: '分岔「查資料」想讀取這個網頁' })).toBeInTheDocument()
})

test('出現時把焦點移到對話框（不直接停在「允許」上）', () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  expect(screen.getByRole('dialog')).toHaveFocus()
})

test('PendingPermission：換下一個請求時重設狀態，焦點移到新的對話框', async () => {
  const u = user()
  const { rerender } = render(<PendingPermission task={makeTask()} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  rerender(<PendingPermission task={makeTask({ pendingPermission: req })} />)
  await armed()
  await u.click(screen.getByRole('checkbox'))
  expect(screen.getByRole('checkbox')).toBeChecked()
  const first = screen.getByRole('dialog')
  rerender(<PendingPermission task={makeTask({ pendingPermission: next })} />)
  expect(screen.getByText('$ npm run lint')).toBeInTheDocument()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('dialog')).not.toBe(first)
  expect(screen.getByRole('dialog')).toHaveFocus()
  await armed()
  await u.click(screen.getByRole('button', { name: '拒絕並說明' }))
  rerender(<PendingPermission task={makeTask({ pendingPermission: { ...next, id: 'p3' } })} />)
  expect(screen.getByRole('button', { name: '允許' })).toBeInTheDocument()
  expect(screen.getByText('cwd: /tmp/wt/t1')).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toHaveFocus()
})

test('請求都處理完後，焦點回到使用者原本所在的地方', () => {
  const { rerender } = render(<Screen task={makeTask()} />)
  screen.getByRole('textbox', { name: '分岔訊息' }).focus()
  rerender(<Screen task={makeTask({ pendingPermission: req })} />)
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<Screen task={makeTask()} />)
  expect(screen.getByRole('textbox', { name: '分岔訊息' })).toHaveFocus()
})

test('原本沒有焦點時，請求處理完後焦點移到插話框', () => {
  const { rerender } = render(<Screen task={makeTask({ pendingPermission: req })} />)
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<Screen task={makeTask({ pendingPermission: next })} />)
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<Screen task={makeTask()} />)
  expect(screen.getByRole('textbox', { name: '插話' })).toHaveFocus()
})
```

```tsx
// tests/renderer/ImplementScreen.test.tsx
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { implementEvents } from '@renderer/lib/timeline'
import { ImplementScreen } from '@renderer/screens/ImplementScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import { IMPLEMENT_START_REF, msgDisplay } from '@shared/protocol'
import type { DiffStats, PermissionRequest, Question, Task, TimelineEvent } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeTask } from '../fixtures/task'

let seq = 0
const ev = (over: Partial<TimelineEvent>): TimelineEvent => ({
  id: `e${++seq}`,
  ts: '',
  channel: 'main',
  kind: 'system',
  ...over
})
const tool = (name: string, input: Record<string, unknown>, id = `t${++seq}`) =>
  ev({ kind: 'tool_call', tool: { id, name, input } })

const stats: DiffStats = {
  files: 2,
  additions: 101,
  deletions: 12,
  perFile: [
    { path: 'src/auth/lockout.ts', additions: 68, deletions: 3 },
    { path: 'src/auth/login.ts', additions: 33, deletions: 9 }
  ]
}

const events: TimelineEvent[] = [
  ev({ kind: 'user_text', text: '加上登入失敗鎖定' }),
  ev({ kind: 'assistant_text', text: '釐清階段的回覆' }),
  ev({ kind: 'user_text', text: msgDisplay.specApproved, ref: IMPLEMENT_START_REF }),
  tool('Read', { file_path: 'src/http/errors.ts' }),
  ev({ kind: 'assistant_text', text: '開始實作' }),
  ev({ kind: 'user_text', text: '錯誤訊息放進 i18n' }),
  ev({ channel: 'branch:b1', kind: 'assistant_text', text: '分岔裡的訊息' }),
  tool('Bash', { command: 'npm test -- auth' }, 'bash1'),
  ev({ kind: 'tool_result', text: 'exit 1', tool: { id: 'bash1', name: '', isError: true } }),
  tool('Edit', { file_path: '/tmp/wt/t1/src/auth/login.ts' })
]

const implTask = (over: Partial<Task> = {}) =>
  makeTask({
    status: 'implementing',
    runState: 'running',
    plan: [
      { id: 's1', title: '新增 lockout 模組', status: 'done' },
      { id: 's2', title: '統一錯誤回應為 `429`', status: 'running' },
      { id: 's3', title: '通知信模板', status: 'pending' }
    ],
    ...over
  })

const renderImpl = (task: Task, readOnly = false) =>
  render(<ImplementScreen task={task} nav={null} readOnly={readOnly} />)
const callsOf = (channel: string) => vi.mocked(call).mock.calls.filter((c) => c[0] === channel)

beforeEach(() => {
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (channel: string) =>
    channel === 'tasks:changedFiles' ? stats : undefined) as never)
  resetStoreInternals()
  useStore.setState({ timelines: { t1: events }, toast: undefined, activeBranch: {} })
})

describe('implementEvents', () => {
  test('取最後一個實作起點（核准規格或送出報告回饋）之後的主線事件', () => {
    const list = implementEvents(events)
    expect(list[0].kind).toBe('tool_call')
    expect(list.some((e) => e.text === '釐清階段的回覆')).toBe(false)
    expect(list.some((e) => e.channel !== 'main')).toBe(false)
    const again = [
      ...events,
      ev({ kind: 'user_text', text: '送出整體意見', ref: IMPLEMENT_START_REF }),
      // 使用者打出一樣的字（有 ref 的新時間軸不看文字）
      ev({ kind: 'assistant_text', text: '第二輪' }),
      ev({ kind: 'user_text', text: msgDisplay.specApproved }),
      ev({ kind: 'assistant_text', text: '第二輪' })
    ]
    expect(implementEvents(again).map((e) => e.text)).toEqual([
      '第二輪',
      msgDisplay.specApproved,
      '第二輪'
    ])
  })

  test('舊時間軸（整份都沒有標記）用顯示文字找起點', () => {
    const legacy = [
      ev({ kind: 'user_text', text: '加上登入失敗鎖定' }),
      ev({ kind: 'user_text', text: msgDisplay.specApproved }),
      ev({ kind: 'assistant_text', text: '開始實作' })
    ]
    expect(implementEvents(legacy).map((e) => e.text)).toEqual(['開始實作'])
  })

  test('還沒有開始實作的訊息時是空的', () => {
    expect(implementEvents(events.slice(0, 2))).toEqual([])
  })
})

test('顯示進度、步驟、進行中步驟的工具與這一段的對話', async () => {
  renderImpl(implTask())
  expect(screen.getByRole('progressbar', { name: '進度' })).toHaveAttribute('aria-valuenow', '1')
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getByText('429').tagName).toBe('CODE')
  expect(within(step).getByText('進行中')).toBeInTheDocument()
  const rows = within(step).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual([
    '讀取src/http/errors.ts',
    '指令npm test -- auth失敗',
    '編輯src/auth/login.ts'
  ])
  expect(screen.getByText('新增 lockout 模組')).toBeInTheDocument()
  expect(screen.getByText('通知信模板')).toBeInTheDocument()
  expect(screen.getByText('開始實作')).toBeInTheDocument()
  expect(screen.getByText('錯誤訊息放進 i18n')).toBeInTheDocument()
  expect(screen.getByText('你插話')).toBeInTheDocument()
  expect(screen.queryByText('釐清階段的回覆')).not.toBeInTheDocument()
  expect(screen.queryByText('加上登入失敗鎖定')).not.toBeInTheDocument()
  expect(screen.queryByText('分岔裡的訊息')).not.toBeInTheDocument()
  expect(screen.queryByText(msgDisplay.specApproved)).not.toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('還沒有步驟時，最近的動作仍然看得到', async () => {
  renderImpl(implTask({ plan: [] }))
  expect(screen.getByText('0 / ?')).toBeInTheDocument()
  const recent = screen.getByRole('region', { name: '最近的動作' })
  expect(within(recent).getByText('src/http/errors.ts')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('等待核准：步驟與對應的指令標示等待核准，並顯示核准對話框', async () => {
  renderImpl(
    implTask({
      runState: 'waiting_permission',
      pendingPermission: {
        id: 'p1',
        taskId: 't1',
        channel: 'main',
        toolName: 'Bash',
        input: { command: 'npm test -- auth' },
        suggestedPattern: 'npm test *',
        createdAt: ''
      }
    })
  )
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getAllByText('等待核准')).toHaveLength(2)
  expect(within(step).getAllByRole('listitem')[1]).toHaveTextContent('等待核准')
  const dialog = screen.getByRole('dialog', { name: 'Claude 想執行這個指令' })
  expect(within(dialog).getByText('cwd: /tmp/wt/t1')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('插話送到主線；停止中斷執行，連點只送一次', async () => {
  renderImpl(implTask())
  await userEvent.type(screen.getByRole('textbox', { name: '插話' }), '順便改錯誤訊息{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'main', '順便改錯誤訊息')
  const release = holdNextCall(vi.mocked(call))
  const stop = screen.getByRole('button', { name: '停止' })
  await userEvent.dblClick(stop)
  expect(callsOf('run:stop')).toEqual([['run:stop', 't1', 'main']])
  expect(stop).toBeDisabled()
  await release()
})

test('沒有在執行時不顯示停止；整理報告中不能插話', async () => {
  const { rerender } = renderImpl(implTask({ runState: 'idle' }))
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  rerender(
    <ImplementScreen task={implTask({ runState: 'finalizing' })} nav={null} readOnly={false} />
  )
  expect(screen.getByRole('textbox', { name: '插話' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  expect(screen.getByText('正在整理 diff 並執行驗證指令…')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('Claude 在實作中提問時顯示問題卡片', async () => {
  useStore.setState({
    timelines: { t1: [...events, ev({ kind: 'question', ref: 'q9' })] }
  })
  renderImpl(
    implTask({
      runState: 'idle',
      questions: [
        {
          id: 'q9',
          text: '通知信要用哪個模板？',
          options: [{ id: 'a', label: '沿用密碼重設的模板' }],
          allowFreeText: true,
          status: 'open',
          followups: [],
          askedAt: ''
        }
      ]
    })
  )
  expect(screen.getByRole('radiogroup', { name: '通知信要用哪個模板？' })).toBeInTheDocument()
  expect(
    within(screen.getByRole('region', { name: '進行中的步驟' })).getByText('等你回答')
  ).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('變更檔案：列出每個檔案；執行結束時再讀一次', async () => {
  const { rerender } = renderImpl(implTask())
  const aside = screen.getByRole('complementary', { name: '變更檔案' })
  expect(await within(aside).findByText('src/auth/lockout.ts')).toBeInTheDocument()
  expect(within(aside).getByText('+101')).toBeInTheDocument()
  expect(within(aside).getByText('−12')).toBeInTheDocument()
  expect(callsOf('tasks:changedFiles')).toEqual([['tasks:changedFiles', 't1']])
  rerender(<ImplementScreen task={implTask({ runState: 'idle' })} nav={null} readOnly={false} />)
  await vi.waitFor(() => expect(callsOf('tasks:changedFiles')).toHaveLength(2))
})

test('讀不到變更時顯示說明', async () => {
  vi.mocked(call).mockImplementation((async (channel: string) => {
    if (channel === 'tasks:changedFiles') throw new Error('worktree 不存在')
  }) as never)
  renderImpl(implTask({ runState: 'idle' }))
  expect(await screen.findByText('無法讀取變更')).toBeInTheDocument()
})

test('已允許的指令與 worktree；在 Finder 開啟', async () => {
  renderImpl(implTask({ runState: 'idle', allowedCommands: ['npm test *', 'git diff *'] }))
  const aside = screen.getByRole('complementary', { name: '變更檔案' })
  expect(within(aside).getByText('npm test *')).toBeInTheDocument()
  expect(within(aside).getByText('git diff *')).toBeInTheDocument()
  expect(within(aside).getByText('/tmp/wt/t1')).toBeInTheDocument()
  await userEvent.click(within(aside).getByRole('button', { name: '在 Finder 開啟' }))
  expect(call).toHaveBeenCalledWith('shell:showInFolder', '/tmp/wt/t1')
})

test('唯讀時沒有輸入框與停止按鈕', async () => {
  renderImpl(implTask(), true)
  expect(screen.queryByRole('textbox', { name: '插話' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('TaskScreen：實作中顯示實作畫面', async () => {
  useStore.setState({ tasks: { t1: implTask() } })
  render(<TaskScreen taskId="t1" />)
  expect(screen.getByRole('region', { name: '進行中的步驟' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '插話' })).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

const perm = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'p1',
  taskId: 't1',
  channel: 'main',
  toolName: 'Bash',
  input: { command: 'npm test' },
  suggestedPattern: 'npm test *',
  createdAt: '',
  ...over
})
const openQuestion = (id: string, text: string): Question => ({
  id,
  text,
  options: [{ id: 'a', label: '帳號的 email' }],
  allowFreeText: true,
  status: 'open',
  followups: [],
  askedAt: ''
})
const start = ev({ kind: 'user_text', text: msgDisplay.specApproved, ref: IMPLEMENT_START_REF })

test('等待核准的工具以 toolUseId 對應；使用者拒絕過的標「已拒絕」', async () => {
  useStore.setState({
    timelines: {
      t1: [
        start,
        tool('Bash', { command: 'npm test' }, 'tu-a'),
        tool('Bash', { command: 'rm -rf dist' }, 'tu-d'),
        ev({
          kind: 'tool_result',
          text: '先不要刪',
          tool: { id: 'tu-d', name: '', isError: true, denied: true }
        }),
        tool('Bash', { command: 'npm test' }, 'tu-b')
      ]
    }
  })
  renderImpl(
    implTask({ runState: 'waiting_permission', pendingPermission: perm({ toolUseId: 'tu-a' }) })
  )
  const rows = within(screen.getByRole('region', { name: '進行中的步驟' })).getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual([
    '指令npm test等待核准',
    '指令rm -rf dist已拒絕',
    '指令npm test'
  ])
  await screen.findByText('src/auth/lockout.ts')
})

test('等待核准的工具不在最近 8 個裡時仍然列出來（最近 7 個＋它）', async () => {
  const many = Array.from({ length: 9 }, (_, i) => tool('Read', { file_path: `src/f${i}.ts` }))
  useStore.setState({
    timelines: { t1: [start, tool('Bash', { command: 'npm test' }, 'tu-old'), ...many] }
  })
  renderImpl(
    implTask({ runState: 'waiting_permission', pendingPermission: perm({ toolUseId: 'tu-old' }) })
  )
  const rows = within(screen.getByRole('region', { name: '進行中的步驟' })).getAllByRole('listitem')
  expect(rows).toHaveLength(8)
  expect(rows[0]).toHaveTextContent('src/f2.ts')
  expect(rows.at(-1)).toHaveTextContent('指令npm test等待核准')
  await screen.findByText('src/auth/lockout.ts')
})

test('沒有在這段實作裡出現過的開放問題，顯示在最上方', async () => {
  useStore.setState({ timelines: { t1: [ev({ kind: 'question', ref: 'q7' }), ...events] } })
  renderImpl(implTask({ runState: 'idle', questions: [openQuestion('q7', '通知信寄給誰？')] }))
  const card = screen.getByRole('radiogroup', { name: '通知信寄給誰？' })
  expect(
    card.compareDocumentPosition(screen.getByText('新增 lockout 模組')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getByText('等你回答')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('沒有開放中的問題時步驟顯示暫停中', async () => {
  renderImpl(implTask({ runState: 'idle' }))
  const step = screen.getByRole('region', { name: '進行中的步驟' })
  expect(within(step).getByText('暫停中')).toBeInTheDocument()
  await screen.findByText('src/auth/lockout.ts')
})

test('重新提問的問題只顯示一張卡片', async () => {
  useStore.setState({
    timelines: {
      t1: [
        ...events,
        ev({ kind: 'question', ref: 'q9' }),
        ev({ kind: 'assistant_text', text: '再確認一次' }),
        ev({ kind: 'question', ref: 'q9' })
      ]
    }
  })
  renderImpl(implTask({ runState: 'idle', questions: [openQuestion('q9', '模板用哪個？')] }))
  expect(screen.getAllByRole('radiogroup', { name: '模板用哪個？' })).toHaveLength(1)
  await screen.findByText('src/auth/lockout.ts')
})

test('有等待中的核准請求時遮罩後面不能操作；處理完焦點回到插話框', async () => {
  const { rerender } = renderImpl(
    implTask({ runState: 'waiting_permission', pendingPermission: perm() })
  )
  const input = screen.getByRole('textbox', { name: '插話' })
  expect(input.closest('[inert]')).not.toBeNull()
  expect(screen.getByRole('region', { name: '進行中的步驟' }).closest('[inert]')).not.toBeNull()
  expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
  expect(screen.getByRole('dialog')).toHaveFocus()
  rerender(<ImplementScreen task={implTask()} nav={null} readOnly={false} />)
  expect(input.closest('[inert]')).toBeNull()
  expect(input).toHaveFocus()
  await screen.findByText('src/auth/lockout.ts')
})

describe('變更檔案的輪詢', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

  test('執行中每 5 秒重新讀取；停下來時讀最後一次，之後不再輪詢', async () => {
    const { rerender } = renderImpl(implTask())
    await tick(0)
    expect(callsOf('tasks:changedFiles')).toHaveLength(1)
    await tick(5000)
    expect(callsOf('tasks:changedFiles')).toHaveLength(2)
    await tick(5000)
    expect(callsOf('tasks:changedFiles')).toHaveLength(3)
    rerender(<ImplementScreen task={implTask({ runState: 'idle' })} nav={null} readOnly={false} />)
    await tick(0)
    expect(callsOf('tasks:changedFiles')).toHaveLength(4)
    await tick(20000)
    expect(callsOf('tasks:changedFiles')).toHaveLength(4)
  })
})
```

`tests/renderer/ClarifyScreen.test.tsx` 加上：

```tsx
test('釐清中 Claude 要讀網頁時也顯示核准對話框', () => {
  const task = makeTask({
    runState: 'waiting_permission',
    pendingPermission: {
      id: 'p1',
      taskId: 't1',
      channel: 'main',
      toolName: 'WebFetch',
      input: { url: 'https://example.com/docs', prompt: '查 API 限制' },
      createdAt: ''
    }
  })
  render(<ClarifyScreen task={task} nav={null} readOnly={false} onOpenStage={() => {}} />)
  expect(
    within(screen.getByRole('main')).getByRole('dialog', { name: 'Claude 想讀取這個網頁' })
  ).toBeInTheDocument()
})
```

`tests/renderer/SpecScreen.test.tsx` 加上：

```tsx
test('回看規格時有等待中的核准請求也會顯示', () => {
  renderSpec(
    specTask({
      status: 'implementing',
      runState: 'waiting_permission',
      pendingPermission: {
        id: 'p1',
        taskId: 't1',
        channel: 'main',
        toolName: 'Bash',
        input: { command: 'npm test' },
        suggestedPattern: 'npm test *',
        createdAt: ''
      }
    }),
    true
  )
  expect(screen.getByRole('dialog', { name: 'Claude 想執行這個指令' })).toBeInTheDocument()
})

test('還沒有規格時也顯示核准對話框', () => {
  renderSpec(
    specTask({
      specs: [],
      runState: 'waiting_permission',
      pendingPermission: {
        id: 'p1',
        taskId: 't1',
        channel: 'main',
        toolName: 'WebSearch',
        input: { query: 'redis ttl' },
        createdAt: ''
      }
    })
  )
  expect(screen.getByText('還沒有規格。')).toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Claude 想搜尋網路' })).toBeInTheDocument()
})
```

**Step 2: 確認失敗** — `npx vitest run tests/renderer/PermissionDialog.test.tsx tests/renderer/ImplementScreen.test.tsx` → FAIL

**Step 3: lib/timeline.ts 與 lib/permission.ts**

`lib/timeline.ts` 的 `@shared/protocol` import 加上 `legacyImplementStart`、`startsImplementation`，並在 `latestQuestionEvents` 之前加上：

```ts
/**
 * 這一段實作的主線事件：最後一個實作起點（核准規格或送出報告回饋）之後（不含那則訊息）。
 * 還沒有起點（例如剛核准、訊息還沒寫進時間軸）時是空的，不會顯示釐清階段的對話。
 * 起點看 user_text 的 ref；整份時間軸都沒有標記（加上標記之前的任務）才比對顯示文字。
 */
export function implementEvents(events: TimelineEvent[]): TimelineEvent[] {
  const main = events.filter((e) => e.channel === 'main')
  const isStart = main.some(startsImplementation) ? startsImplementation : legacyImplementStart
  const start = main.findLastIndex((e) => isStart(e))
  return start < 0 ? [] : main.slice(start + 1)
}
```

```ts
// src/renderer/src/lib/permission.ts
import type { PermissionRequest, Task } from '@shared/types'
import { relativeTo } from './timeline'

/**
 * 核准對話框出現後按鈕先停用的時間：連點「允許」時第二下不會落在下一個排隊的請求上，
 * 對話框突然出現在游標下時也不會被誤按。
 */
export const APPROVAL_ARM_MS = 500
/** 要寫入的內容先顯示前幾個字，其餘按「顯示完整內容」展開 */
export const PREVIEW_COLLAPSED = 1500

/** 修改這些工具的請求只會出現在 .git／.claude／.mcp.json（主程序只對這些路徑詢問） */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 要寫入的內容：Write 的全文、Edit 的取代前後（- / + 開頭） */
export function writePreview(input: Record<string, unknown>): string | undefined {
  const lines = (prefix: string, s?: string) =>
    s === undefined ? [] : s.split('\n').map((l) => `${prefix} ${l}`)
  const edit = (e: Record<string, unknown>) =>
    [...lines('-', str(e.old_string)), ...lines('+', str(e.new_string))].join('\n')
  const text =
    str(input.content) ??
    str(input.new_source) ??
    (Array.isArray(input.edits)
      ? input.edits.filter(isRecord).map(edit).join('\n…\n')
      : str(input.new_string) !== undefined
        ? edit(input)
        : undefined)
  return text || undefined
}

/** 提出請求的是誰：主線是 Claude，分岔標出分岔名稱 */
export function requesterOf(task: Task, r: PermissionRequest): string | undefined {
  if (!r.channel.startsWith('branch:')) return undefined
  const id = r.channel.slice('branch:'.length)
  return task.branches.find((b) => b.id === id)?.title ?? id
}

export interface RequestView {
  title: string
  /** 深色區塊的主要內容：指令、檔案路徑、網址… */
  code: string
  /** 深色區塊的第二行（工具名稱、cwd） */
  sub?: string
  /** Claude 給的原因或用途 */
  reason?: string
  warning?: string
  preview?: string
}

/** 核准對話框的內容；branch 是提出請求的分岔名稱（主線不給） */
export function describeRequest(r: PermissionRequest, cwd: string, branch?: string): RequestView {
  const who = branch === undefined ? 'Claude ' : `分岔「${branch}」`
  const i = r.input
  if (r.toolName === 'Bash') {
    const description = str(i.description)
    return {
      title: `${who}想執行這個指令`,
      code: `$ ${str(i.command) ?? ''}`,
      sub: `cwd: ${cwd}`,
      reason: description && `原因：${description}`
    }
  }
  if (WRITE_TOOLS.has(r.toolName)) {
    const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? ''
    return {
      title: `${who}想修改這個檔案`,
      code: relativeTo(cwd, path),
      sub: `${r.toolName} · cwd: ${cwd}`,
      warning: '這個檔案會影響 Claude 的權限或 git 設定',
      preview: writePreview(i)
    }
  }
  if (r.toolName === 'WebFetch') {
    const prompt = str(i.prompt)
    return {
      title: `${who}想讀取這個網頁`,
      code: str(i.url) ?? '',
      sub: 'WebFetch',
      reason: prompt && `用途：${prompt}`
    }
  }
  if (r.toolName === 'WebSearch')
    return { title: `${who}想搜尋網路`, code: str(i.query) ?? '', sub: 'WebSearch' }
  return {
    title: `${who}想使用 ${r.toolName}`,
    code: JSON.stringify(i, null, 2),
    sub: `cwd: ${cwd}`
  }
}
```

**Step 4: ui.tsx、Composer.tsx 與 app.css**

`Avatar` 接受 `className`（以 `cx` 合併，實作頁用 `size-6 text-[11px]`）；`Composer` 接受 `inputRef?: Ref<HTMLInputElement>` 並傳給 `<input ref>`；`app.css` 的 `@theme` 在 `--color-code-ink` 後加上 `--color-code-muted: #a9b3bf;`。

**Step 5: PermissionDialog.tsx（對照 `B4-Implement.dc.html` 的 dialog）**

```tsx
// src/renderer/src/components/PermissionDialog.tsx
import { type KeyboardEvent, useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import type { PermissionRequest, Task } from '@shared/types'
import { call } from '../api'
import { isComposing } from '../lib/ime'
import { APPROVAL_ARM_MS, describeRequest, PREVIEW_COLLAPSED, requesterOf } from '../lib/permission'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { Button, cx, Icons, textareaClass } from './ui'

/** 對話框關掉後焦點要去的地方（原本的位置拿不到焦點時），例如畫面的插話框 */
type FocusTarget = () => HTMLElement | null | undefined

/** 對照 `B4-Implement.dc.html` 的 dialog；蓋在所在的 `<main>`（需要 relative）上 */
export function PermissionDialog({
  request: r,
  cwd,
  branch,
  fallbackFocus
}: {
  request: PermissionRequest
  cwd: string
  /** 提出請求的分岔名稱；主線的請求不給 */
  branch?: string
  fallbackFocus?: FocusTarget
}) {
  const act = useStore((s) => s.act)
  const titleId = useId()
  const codeId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  // 剛出現時先停用核准與拒絕：連點「允許」時第二下不會落在下一個請求上
  const [armed, setArmed] = useState(false)
  const [remember, setRemember] = useState(false)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [pending, run] = usePending()
  const v = describeRequest(r, cwd, branch)
  const locked = pending || !armed

  useEffect(() => {
    const t = setTimeout(() => setArmed(true), APPROVAL_ARM_MS)
    return () => clearTimeout(t)
  }, [])

  const restoreFocus = useEffectEvent((prev: Element | null) => {
    if (prev instanceof HTMLElement && prev !== document.body && prev.isConnected) prev.focus()
    // 原本的位置不在了或拿不到焦點（例如還被遮罩擋住）時交給畫面決定
    if (!document.activeElement || document.activeElement === document.body)
      fallbackFocus?.()?.focus()
  })
  // 出現時把焦點移進對話框（使用者可能正在輸入框打字）；刻意不放在「允許」上，免得按 Enter 就核准。
  // 關掉時把焦點還給原本的位置；下一個排隊的請求出現時會再把焦點移到新的對話框。
  useEffect(() => {
    const prev = document.activeElement
    dialogRef.current?.focus()
    return () => restoreFocus(prev)
  }, [])

  const leaveDeny = () => {
    // 先把焦點放回對話框，拒絕原因的輸入框消失後焦點才不會掉到 body
    dialogRef.current?.focus()
    setDenying(false)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    // 拒絕原因輸入中、輸入法選字時的 Esc 是取消組字，不離開拒絕模式
    if (e.key === 'Escape' && denying && !isComposing(e)) {
      e.stopPropagation()
      leaveDeny()
    }
  }

  const resolve = (allow: boolean) =>
    run(() =>
      act(() =>
        call(
          'permission:resolve',
          r.taskId,
          r.id,
          allow
            ? {
                allow: true,
                ...(remember && r.suggestedPattern ? { rememberPattern: r.suggestedPattern } : {})
              }
            : { allow: false, ...(reason.trim() ? { message: reason.trim() } : {}) }
        )
      )
    )

  const longPreview = !!v.preview && v.preview.length > PREVIEW_COLLAPSED
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-ink/28 p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={codeId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-[20px] bg-surface p-6 shadow-dialog outline-none"
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-decision-ink">需要你的核准</span>
          <span id={titleId} className="text-lg font-bold">
            {v.title}
          </span>
        </div>
        <div
          id={codeId}
          className="flex flex-col gap-1.5 rounded-xl bg-code px-4 py-3.5 font-mono text-[13px] text-code-ink"
        >
          <span className="break-all whitespace-pre-wrap">{v.code}</span>
          {v.sub && <span className="text-[11px] break-all text-code-muted">{v.sub}</span>}
        </div>
        {v.warning && (
          <span className="flex items-start gap-2 text-[13px] text-decision-ink">
            <Icons.Info className="mt-[3px] flex-none" width={14} height={14} />
            {v.warning}
          </span>
        )}
        {v.preview && (
          <div className="flex flex-col gap-1.5">
            <pre
              aria-label="要寫入的內容"
              className={cx(
                'm-0 overflow-auto rounded-xl bg-fill-2 px-3.5 py-2.5 font-mono text-xs break-all whitespace-pre-wrap text-ink-2',
                expanded ? 'max-h-80' : 'max-h-40'
              )}
            >
              {longPreview && !expanded ? `${v.preview.slice(0, PREVIEW_COLLAPSED)}…` : v.preview}
            </pre>
            {longPreview && !expanded && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="cursor-pointer self-start text-xs text-brand hover:text-brand-hover"
              >
                顯示完整內容（共 {v.preview.length} 字）
              </button>
            )}
          </div>
        )}
        {v.reason && <span className="text-[13px] text-ink-2">{v.reason}</span>}
        {r.suggestedPattern ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <input
              type="checkbox"
              checked={remember}
              disabled={pending}
              onChange={(e) => setRemember(e.target.checked)}
              className="size-4 flex-none accent-brand"
            />
            <span>
              本任務內都允許 <code>{r.suggestedPattern}</code>
            </span>
          </label>
        ) : (
          r.toolName === 'Bash' && (
            <span className="text-xs text-muted">這個指令含有串接、重導或變數，只能逐次核准。</span>
          )
        )}
        {denying ? (
          <div className="flex flex-col gap-2.5">
            <textarea
              aria-label="拒絕原因"
              rows={2}
              // 使用者按了「拒絕並說明」才出現，直接把焦點放進來
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="告訴 Claude 為什麼不行、該怎麼做（選填，Esc 返回）"
              className={textareaClass}
            />
            <div className="flex justify-end gap-2.5">
              <Button disabled={pending} onClick={leaveDeny}>
                返回
              </Button>
              <Button variant="dark" disabled={locked} onClick={() => void resolve(false)}>
                送出拒絕
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2.5">
            <Button className="px-[18px]" disabled={locked} onClick={() => setDenying(true)}>
              拒絕並說明
            </Button>
            <Button
              variant="primary"
              className="px-[22px]"
              disabled={locked}
              onClick={() => void resolve(true)}
            >
              允許
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 任務有等待中的核准請求時蓋在畫面上。請求依序排隊（task.pendingPermission 是最早的一個），
 * 以 id 為 key：換下一個請求時勾選、拒絕原因、停用時間都重新開始，焦點也移到新的對話框。
 * fallbackFocus：請求都處理完、原本的位置拿不到焦點時，焦點要去的地方（例如插話框）。
 */
export function PendingPermission({
  task,
  fallbackFocus
}: {
  task: Task
  fallbackFocus?: FocusTarget
}) {
  const r = task.pendingPermission
  if (!r) return null
  return (
    <PermissionDialog
      key={r.id}
      request={r}
      cwd={task.worktreePath}
      branch={requesterOf(task, r)}
      fallbackFocus={fallbackFocus}
    />
  )
}
```

**Step 6: ImplementScreen.tsx（對照 `B4-Implement.dc.html`）**

```tsx
// src/renderer/src/screens/ImplementScreen.tsx
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { msgDisplay } from '@shared/protocol'
import type { DiffStats, PlanStep, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { Composer } from '../components/Composer'
import { InlineCode, Markdown } from '../components/Markdown'
import { PendingPermission } from '../components/PermissionDialog'
import { AnsweredQuestionRow, QuestionCard } from '../components/QuestionCard'
import { RunStatus } from '../components/Timeline'
import { Avatar, Button, cx, Icons, Pill, Spinner } from '../components/ui'
import { isBusy } from '../lib/stage'
import {
  implementEvents,
  latestQuestionEvents,
  type ToolCall,
  toolLabel,
  toolSummary,
  toolTarget,
  userTextDisplay,
  useTimeline
} from '../lib/timeline'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'

type ToolEvent = TimelineEvent & { tool: ToolCall }
/** 工具呼叫的結果：失敗，或使用者在核准對話框拒絕 */
type ToolOutcome = 'failed' | 'denied'
const isToolCall = (e: TimelineEvent): e is ToolEvent => e.kind === 'tool_call' && !!e.tool
/** 進行中的步驟裡列出最近幾個工具呼叫 */
const RECENT_TOOLS = 8
/** Claude 執行中每隔多久重新讀取變更檔案 */
const CHANGED_FILES_POLL_MS = 5000

function ToolRows({
  tools,
  root,
  waitingId,
  outcomes
}: {
  tools: ToolEvent[]
  /** worktree：路徑顯示成相對於它 */
  root: string
  waitingId?: string
  outcomes: Map<string, ToolOutcome>
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
      {tools.map((e) => {
        const waiting = e.id === waitingId
        const target = toolTarget(e.tool, root)
        const outcome = outcomes.get(e.tool.id)
        return (
          <li
            key={e.id}
            className={cx(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5',
              waiting ? 'bg-decision' : 'bg-fill-2'
            )}
          >
            <span
              className={cx(
                'w-11 flex-none font-mono text-[11px]',
                waiting ? 'text-decision-ink' : 'text-muted'
              )}
            >
              {toolLabel(e.tool.name)}
            </span>
            <code className="min-w-0 truncate" title={target}>
              {target}
            </code>
            {waiting ? (
              <span className="ml-auto flex-none text-xs text-decision-ink">等待核准</span>
            ) : outcome === 'denied' ? (
              <span className="ml-auto flex-none text-xs text-muted">已拒絕</span>
            ) : (
              outcome === 'failed' && (
                <span className="ml-auto flex-none text-xs text-danger">失敗</span>
              )
            )}
          </li>
        )
      })}
    </ul>
  )
}

function StepRow({ step, index }: { step: PlanStep; index: number }) {
  const done = step.status === 'done'
  return (
    <div
      className={cx(
        'flex items-center gap-3 rounded-[14px] px-4 py-3',
        done ? 'bg-fill-2' : 'text-muted'
      )}
    >
      {done ? (
        <span className="flex size-6 flex-none items-center justify-center rounded-full bg-brand text-white">
          <Icons.Check width={12} height={12} strokeWidth={3} />
          <span className="sr-only">已完成</span>
        </span>
      ) : (
        <span className="flex size-6 flex-none items-center justify-center rounded-full text-xs shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]">
          {index + 1}
        </span>
      )}
      <span className="flex-1">
        <InlineCode text={step.title} />
      </span>
      {step.status === 'blocked' && <Pill tone="danger">卡住</Pill>}
    </div>
  )
}

/** 主線的對話：插話、Claude 的回覆、實作中的提問與系統訊息（工具呼叫列在步驟裡） */
function ChatItem({ task, e, readOnly }: { task: Task; e: TimelineEvent; readOnly: boolean }) {
  switch (e.kind) {
    case 'user_text': {
      const text = e.text ?? ''
      return (
        <div className="max-w-[78%] self-end rounded-[18px_18px_6px_18px] bg-fill px-3.5 py-2.5 text-[13px] whitespace-pre-wrap">
          {text !== msgDisplay.resume && (
            <span className="block text-[11px] text-muted">你插話</span>
          )}
          {userTextDisplay(text)}
        </div>
      )
    }
    case 'assistant_text':
      return (
        <div className="flex gap-2.5 text-[13px]">
          <Avatar className="size-6 text-[11px]" />
          <div className="min-w-0 flex-1">
            <Markdown text={e.text ?? ''} />
          </div>
        </div>
      )
    case 'question': {
      const q = task.questions.find((x) => x.id === e.ref)
      if (!q) return null
      return q.status === 'open' ? (
        <QuestionCard task={task} question={q} readOnly={readOnly} />
      ) : (
        <AnsweredQuestionRow question={q} />
      )
    }
    case 'system':
      return (
        <div className="self-center rounded-full bg-fill px-3 py-1 text-xs text-muted">
          {e.text}
        </div>
      )
    default:
      return null
  }
}

/** 執行中定期重新讀取（未提交的變更也算）；停下來時再讀一次就不再輪詢 */
function ChangedFiles({ taskId, live }: { taskId: string; live: boolean }) {
  const [state, setState] = useState<{ stats?: DiffStats; failed?: boolean }>({})
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const stats = await call('tasks:changedFiles', taskId)
        if (alive) setState({ stats })
      } catch {
        // 讀過一次就保留上一份；從來沒讀到才顯示說明
        if (alive) setState((s) => ({ ...s, failed: true }))
      }
      if (alive && live) timer = setTimeout(() => void load(), CHANGED_FILES_POLL_MS)
    }
    void load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [taskId, live])
  const { stats } = state
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-bold">變更檔案</span>
        {stats && (
          <span className="font-mono text-xs">
            <span className="text-ok">+{stats.additions}</span>{' '}
            <span className="text-danger">−{stats.deletions}</span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 text-[13px]">
        {stats?.perFile.map((f) => (
          <div
            key={f.path}
            className="flex items-center gap-2 rounded-[10px] bg-fill-2 px-2.5 py-2"
          >
            <code className="min-w-0 truncate bg-transparent p-0" title={f.path}>
              {f.path}
            </code>
            <span className="ml-auto flex-none font-mono text-[11px]">
              <span className="text-ok">+{f.additions}</span>{' '}
              <span className="text-danger">−{f.deletions}</span>
            </span>
          </div>
        ))}
        {stats && stats.files === 0 && <span className="text-muted">還沒有變更</span>}
        {!stats && state.failed && <span className="text-muted">無法讀取變更</span>}
      </div>
    </>
  )
}

export function ImplementScreen({
  task,
  nav,
  readOnly
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
}) {
  const act = useStore((s) => s.act)
  const timeline = useTimeline(task.id)
  const events = useMemo(() => implementEvents(timeline), [timeline])
  // 步驟與卡片只改 task 不加事件，所以也看 updatedAt
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${events.length}:${task.updatedAt}`, task.id)
  const [stopping, runStop] = usePending()
  const [showing, runShow] = usePending()
  const [, runResume] = usePending()
  const composerRef = useRef<HTMLInputElement>(null)

  const busy = isBusy(task)
  const running = task.runState === 'running' || task.runState === 'waiting_permission'
  const total = task.plan.length
  const done = task.plan.filter((s) => s.status === 'done').length
  const runningIdx = task.plan.findIndex((s) => s.status === 'running')

  // 等待核准的請求以 toolUseId 對應時間軸上的工具呼叫；舊資料沒有 id 時找最近一個相同的呼叫
  const p = task.pendingPermission
  const allTools = events.filter(isToolCall)
  const waitingTool = p?.toolUseId ? allTools.findLast((e) => e.tool.id === p.toolUseId) : undefined
  const recent = allTools.slice(-RECENT_TOOLS)
  // 等待核准的呼叫比較早、不在最近幾個裡時，仍然列在最後一列（最近 7 個＋它）
  const tools =
    waitingTool && !recent.includes(waitingTool)
      ? [...allTools.slice(-(RECENT_TOOLS - 1)), waitingTool]
      : recent
  const outcomes = new Map<string, ToolOutcome>(
    events
      .filter((e) => e.kind === 'tool_result' && e.tool?.isError)
      .map((e) => [e.tool!.id, e.tool!.denied ? 'denied' : 'failed'])
  )
  // 重新提問過的問題只在最後一次出現的位置畫卡片
  const latest = latestQuestionEvents(events)
  const chat = events.filter(
    (e) =>
      e.kind === 'user_text' ||
      e.kind === 'assistant_text' ||
      e.kind === 'system' ||
      (e.kind === 'question' && latest.has(e.id))
  )
  const isOpen = (id?: string) => task.questions.some((q) => q.id === id && q.status === 'open')
  // 這段實作裡沒有出現過的開放問題（例如核准前提出、還沒回答）放在最上方，才不會沒有地方回答
  const asked = new Set(chat.filter((e) => e.kind === 'question').map((e) => e.ref))
  const orphanQuestions = task.questions.filter((q) => q.status === 'open' && !asked.has(q.id))
  const waitingForAnswer =
    orphanQuestions.length > 0 || chat.some((e) => e.kind === 'question' && isOpen(e.ref))
  const waitingId = !p
    ? undefined
    : p.toolUseId
      ? waitingTool?.id
      : tools.findLast(
          (e) => toolSummary(e.tool) === toolSummary({ id: '', name: p.toolName, input: p.input })
        )?.id

  const status =
    task.runState === 'waiting_permission' ? (
      <Pill tone="decision">等待核准</Pill>
    ) : task.runState === 'running' ? (
      <Pill tone="brand">進行中</Pill>
    ) : waitingForAnswer ? (
      <Pill tone="decision">等你回答</Pill>
    ) : (
      <Pill tone="muted">暫停中</Pill>
    )
  const toolList = tools.length > 0 && (
    <div className="pr-4 pb-3.5 pl-[52px]">
      <ToolRows tools={tools} root={task.worktreePath} waitingId={waitingId} outcomes={outcomes} />
    </div>
  )

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        {/* 有等待中的核准請求時，遮罩後面的內容不能用鍵盤或滑鼠操作 */}
        <div className="contents" inert={!!task.pendingPermission}>
          <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
            <div className="flex min-w-0 flex-col">
              <span className="text-lg font-bold">{task.title}</span>
              <span className="truncate font-mono text-[11px] text-muted">{task.branch}</span>
            </div>
            {nav}
          </div>

          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6"
          >
            <div className="mx-auto flex w-full max-w-[800px] flex-col gap-2.5">
              <div className="mb-1.5 flex items-center gap-3">
                <span className="text-[13px] text-muted">進度</span>
                <span
                  role="progressbar"
                  aria-label="進度"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={done}
                  aria-valuetext={total ? `${done} / ${total}` : '還沒有步驟'}
                  className="flex h-1.5 flex-1 rounded-[3px] bg-line-soft"
                >
                  <span
                    className="rounded-[3px] bg-brand transition-[width]"
                    style={{ width: `${total ? (done / total) * 100 : 0}%` }}
                  />
                </span>
                <span className="font-mono text-xs">
                  {done} / {total || '?'}
                </span>
              </div>

              {orphanQuestions.map((q) => (
                <QuestionCard key={q.id} task={task} question={q} readOnly={readOnly} />
              ))}

              {task.plan.map((s, i) =>
                i === runningIdx ? (
                  <section
                    key={s.id}
                    aria-label="進行中的步驟"
                    className="overflow-hidden rounded-2xl shadow-focus"
                  >
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <span className="flex size-6 flex-none items-center justify-center rounded-full text-xs font-bold text-brand shadow-[inset_0_0_0_2px_var(--color-brand)]">
                        {i + 1}
                      </span>
                      <span className="flex-1 font-medium">
                        <InlineCode text={s.title} />
                      </span>
                      {status}
                    </div>
                    {toolList}
                  </section>
                ) : (
                  <StepRow key={s.id} step={s} index={i} />
                )
              )}

              {/* 還沒列出步驟（剛開始讀程式碼）或步驟之間：仍然看得到 Claude 在做什麼 */}
              {runningIdx < 0 && busy && tools.length > 0 && (
                <section
                  aria-label="最近的動作"
                  className="overflow-hidden rounded-2xl shadow-focus"
                >
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <span className="flex size-6 flex-none items-center justify-center">
                      <Spinner decorative />
                    </span>
                    <span className="flex-1 font-medium">
                      {total ? '最近的動作' : '正在規劃步驟'}
                    </span>
                    {status}
                  </div>
                  {toolList}
                </section>
              )}

              {chat.map((e) => (
                <ChatItem key={e.id} task={task} e={e} readOnly={readOnly} />
              ))}

              <RunStatus
                task={task}
                onResume={() => void runResume(() => act(() => call('run:resume', task.id)))}
              />
            </div>
          </div>

          {!readOnly && (
            <div className="px-7 pb-[22px]">
              <div className="mx-auto max-w-[800px]">
                <Composer
                  inputRef={composerRef}
                  label="插話"
                  placeholder="插話給 Claude…"
                  // 整理報告時主程序不接受主線訊息
                  disabled={task.runState === 'finalizing'}
                  onSend={(t) => {
                    stick()
                    void act(() => call('tasks:send', task.id, 'main', t))
                  }}
                  extra={
                    running && (
                      <button
                        type="button"
                        disabled={stopping}
                        onClick={() =>
                          void runStop(() => act(() => call('run:stop', task.id, 'main')))
                        }
                        className="flex h-10 flex-none cursor-pointer items-center gap-1.5 rounded-full bg-surface px-4 text-[13px] text-danger disabled:cursor-default disabled:opacity-50"
                      >
                        <Icons.Stop width={12} height={12} />
                        停止
                      </button>
                    )
                  }
                />
              </div>
            </div>
          )}
        </div>

        <PendingPermission task={task} fallbackFocus={() => composerRef.current} />
      </main>

      <aside
        aria-label="變更檔案"
        className="flex w-[320px] flex-none flex-col gap-3.5 overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card"
      >
        <ChangedFiles taskId={task.id} live={busy} />
        <div className="h-px flex-none bg-line-soft" />
        <div className="flex flex-col gap-2 text-[13px]">
          <span className="font-bold">本任務已允許的指令</span>
          <div className="flex flex-wrap gap-1.5">
            {task.allowedCommands.length ? (
              task.allowedCommands.map((c) => <code key={c}>{c}</code>)
            ) : (
              <span className="text-muted">（只有設定中的永遠允許清單）</span>
            )}
          </div>
        </div>
        <div className="h-px flex-none bg-line-soft" />
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-bold">Worktree</span>
          <span className="font-mono text-[11px] break-all text-ink-2">{task.worktreePath}</span>
          <Button
            size="sm"
            className="self-start"
            disabled={showing}
            onClick={() =>
              void runShow(() => act(() => call('shell:showInFolder', task.worktreePath)))
            }
          >
            在 Finder 開啟
          </Button>
        </div>
      </aside>
    </>
  )
}
```

**Step 7: 釐清頁與規格頁也顯示核准對話框**

ClarifyScreen 最終版：

```tsx
// src/renderer/src/screens/ClarifyScreen.tsx
import { type ReactNode, useRef } from 'react'
import type { Task } from '@shared/types'
import { call } from '../api'
import { BranchPanel } from '../components/BranchPanel'
import { Composer } from '../components/Composer'
import { PendingPermission } from '../components/PermissionDialog'
import { RunStatus, Timeline } from '../components/Timeline'
import { awaitingCounterReply, isBusy } from '../lib/stage'
import { useTimeline } from '../lib/timeline'
import { usePending } from '../lib/usePending'
import { useStickToBottom } from '../lib/useStickToBottom'
import { useStore } from '../store'

export function ClarifyScreen({
  task,
  nav,
  readOnly,
  onOpenStage
}: {
  task: Task
  nav: ReactNode
  readOnly: boolean
  onOpenStage: (s: 'spec' | 'report') => void
}) {
  const act = useStore((s) => s.act)
  const setActiveBranch = useStore((s) => s.setActiveBranch)
  const events = useTimeline(task.id)
  // 卡片內容（反問回覆等）只改 task 不加事件，所以也看 updatedAt
  const {
    ref: scrollRef,
    onScroll,
    stick
  } = useStickToBottom<HTMLDivElement>(`${events.length}:${task.updatedAt}`, task.id)
  // 主線執行中不能分岔（主程序會拒絕），但可以插話
  const busy = isBusy(task)
  // 問題卡片在等反問的回答時自己會顯示等待中，底部就不再重複顯示「處理中」
  const cardWaiting = task.questions.some((q) => awaitingCounterReply(task, q))
  const [branching, runBranch] = usePending()
  const composerRef = useRef<HTMLInputElement>(null)
  const branchFrom = (text: string) =>
    runBranch(async () => {
      const title = text
        .replace(/[`*_#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 24)
      const b = await act(() =>
        call('branch:open', task.id, {
          title,
          seed: `針對這段內容深入討論：\n${text.slice(0, 600)}`
        })
      )
      if (b) setActiveBranch(task.id, b.id)
    })
  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        {/* 有等待中的核准請求時，遮罩後面的內容不能用鍵盤或滑鼠操作 */}
        <div className="contents" inert={!!task.pendingPermission}>
          <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
            <span className="text-lg font-bold">{task.title}</span>
            {nav}
          </div>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6"
          >
            <div className="mx-auto flex w-full max-w-[800px] flex-col gap-5">
              <Timeline
                task={task}
                channel="main"
                events={events}
                readOnly={readOnly}
                onBranchFrom={busy ? undefined : (t) => void branchFrom(t)}
                branchPending={branching}
                onOpenStage={onOpenStage}
              />
              <RunStatus
                task={task}
                quiet={cardWaiting}
                onResume={() => void act(() => call('run:resume', task.id))}
              />
            </div>
          </div>
          {!readOnly && (
            <div className="px-7 pb-[22px]">
              <div className="mx-auto max-w-[800px]">
                <Composer
                  inputRef={composerRef}
                  placeholder="補充需求或直接回答…"
                  onSend={(t) => {
                    stick()
                    void act(() => call('tasks:send', task.id, 'main', t))
                  }}
                />
              </div>
            </div>
          )}
        </div>
        {/* 釐清中 Claude（主線或分岔）要讀網頁、搜尋網路時也要核准 */}
        <PendingPermission task={task} fallbackFocus={() => composerRef.current} />
      </main>
      <BranchPanel task={task} events={events} readOnly={readOnly} />
    </>
  )
}
```

SpecScreen：`<main>` 裡的標題、捲動區與核准列包進 `<div className="contents" inert={masked}>`（`masked = !!task.pendingPermission`），`</main>` 前加上 `<PendingPermission task={task} fallbackFocus={() => feedbackRef.current} />`（`feedbackRef` 掛在修改意見的 `<input>`）；「還沒有規格」的畫面同樣包 `inert` 並加上 `<PendingPermission task={task} />`。

**Step 8: TaskScreen 加入實作頁**

```tsx
// src/renderer/src/screens/TaskScreen.tsx
import { useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'
import { ClarifyScreen } from './ClarifyScreen'
import { ImplementScreen } from './ImplementScreen'
import { SpecScreen } from './SpecScreen'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  // 使用者回看的階段，只對選它時的任務與狀態有效；換任務或狀態前進就回到目前階段
  const [picked, setPicked] = useState<{ key: string; stage: Stage } | null>(null)
  if (!task) return null
  const key = `${taskId}:${task.status}`
  const current = currentStage(task)
  const shown = picked?.key === key ? picked.stage : current
  const openStage = (s: Stage) => setPicked(s === current ? null : { key, stage: s })
  const nav = <StageNav task={task} shown={shown} onSelect={openStage} />
  // 已丟棄的任務停在哪個階段都只能看
  const ended = task.status === 'discarded' || task.status === 'done'
  const readOnly = ended || shown !== current
  switch (shown) {
    case 'clarify':
      return <ClarifyScreen task={task} nav={nav} readOnly={readOnly} onOpenStage={openStage} />
    case 'spec':
      return <SpecScreen task={task} nav={nav} readOnly={readOnly} onOpenStage={openStage} />
    case 'implement':
      return <ImplementScreen task={task} nav={nav} readOnly={readOnly} />
    default:
      // Task 33 補上報告
      return <ClarifyScreen task={task} nav={nav} readOnly onOpenStage={openStage} />
  }
}
```

**Step 9: 確認通過** — `npm test` 全部通過；`npm run typecheck`、`npm run lint` PASS

**Step 10: 手動驗證** — 核准規格後進入實作頁：進度與步驟更新、shell 指令跳出核准框、勾選後同樣指令不再詢問、拒絕的指令標「已拒絕」、插話會出現在時間軸、停止按鈕可中斷；修改 `.claude/settings.json` 時對話框顯示路徑、說明與要寫入的內容；連點「允許」不會核准到下一個請求。

**Step 11: Commit**

```bash
git add src tests docs/plans
git commit -m "feat(ui): add implementation screen with command approval dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 33：變更報告畫面

**Files:**
- Create: `src/shared/blockHtml.ts`（Task 25 的 `BLOCK_CSP`／`wrapBlockHtml` 移到這裡：匯出 HTML 的 srcdoc 也用同一份包裝）
- Modify: `src/main/report/blockHtml.ts`（改成 re-export）、`tests/main/blockHtml.test.ts`
- Modify: `src/renderer/src/styles/app.css`（補 diff 與架構圖用的 tokens）、`src/renderer/src/components/ui.tsx`（`Icons.Minus`、`Icons.Chevron`）
- Create: `src/renderer/src/lib/format.ts`
- Create: `src/renderer/src/report/anchors.ts`、`blocks.ts`、`comments.tsx`、`diffFiles.ts`
- Create: `src/renderer/src/report/ArchitectureDiagram.tsx`
- Create: `src/renderer/src/report/CustomBlockFrame.tsx`
- Create: `src/renderer/src/report/DiffView.tsx`
- Create: `src/renderer/src/report/ReportView.tsx`
- Create: `src/renderer/src/report/FeedbackPanel.tsx`
- Create: `src/renderer/src/report/exportHtml.tsx`
- Create: `src/renderer/src/screens/ReportScreen.tsx`
- Modify: `src/renderer/src/screens/TaskScreen.tsx`
- Modify: `src/main/agent/prompts.ts`、`tests/main/prompts.test.ts`（Task 19：區塊高度、`file:` 錨點）
- Modify: `tests/fixtures/report.ts`（`sampleDiff`、`makeReport`、`bigDiff`）
- Test: `tests/renderer/DiffView.test.tsx`、`tests/renderer/ArchitectureDiagram.test.tsx`、`tests/renderer/CustomBlockFrame.test.tsx`、`tests/renderer/ReportScreen.test.tsx`、`tests/renderer/exportHtml.test.tsx`、`tests/renderer/format.test.ts`

**行為重點：**
- 只有「待審閱且正在看最新版本」可以留言；依回饋修改中（implementing）回看報告、已完成、已丟棄、看舊版本都只能看。回饋清單與送出回饋只在待審閱時出現；看舊版本時回饋仍是針對最新版本送出。
- 回饋錨點（主程序原樣轉給 Claude）：`section:overview|architecture|limitations`、`decision:<id>`、`block:<id>`、`file:<路徑>`（每個檔頭的「對此檔案留言」，刪除或二進位檔也可以）、`diff:<路徑>:<新檔行號>`。刪除的行沒有新檔行號，不能對那一行留言。留言加入或取消後，焦點回到打開它的按鈕。
- diff 選取的檔案只有一份 state：ReportScreen 的 `diffFocus`（版本、路徑、行），ReportView／DiffView 都是受控的；沒有選時預設第一個不是鎖定檔或產生檔（`package-lock.json`、`yarn.lock`、`pnpm-lock.yaml`、`*.min.js`、`dist/`、`build/`）的檔案。改名的檔案標出「從 <舊路徑> 改名」。
- 大 diff：`FileDiff`／`HunkRows` 用 `memo`，段落說明用 `useMemo` 排好，待送出的回饋以錨點為鍵放進 Map；超過 1500 行的檔案先畫前 300 行，附「顯示全部（共 N 行）」，從回饋清單跳到截斷範圍外的行時自動展開。匯出時超過 3000 行的檔案與鎖定檔只放「此檔案變更 N 行，未包含在匯出中」。
- 段落說明（`file_notes[].hunks`，行號是新檔的）放在範圍內第一個顯示出來的行之前；範圍內沒有任何顯示出來的行就列在檔案說明下方，不會消失。
- 架構圖是有 viewBox 的 SVG（方塊在 foreignObject 裡），寬度 `min(原寬, 原寬 / 兩張圖較寬者 × 100%)`：前後兩張用同樣的比例縮放，最小 0.6 倍（再窄就水平捲動），匯出檔沒有 script 也一樣。只有對應到變更檔案的方塊可以點；連線畫到方塊邊緣，每張圖的箭頭 marker id 不重複，連線另外以 sr-only 清單（「A → B（標籤）」）給螢幕閱讀器。
- 讀取報告失敗的錯誤以版本為鍵；換到某個版本（或按重試）時清掉它的錯誤並重新讀取。決策的問題來源按鈕名稱為「問題 N（查看釐清對話）」。
- 自訂區塊：`harness-block://` + `sandbox="allow-scripts"`（沒有 same-origin），只接受 `e.source === iframe.contentWindow` 的高度訊息，高度夾在 80–1600。包裝量的是包住內容的 flow-root 容器高度（`documentElement.scrollHeight` 至少是 iframe 目前的高度，內容變矮時縮不回來）。
- 收尾操作（送出回饋、開 PR、合併、丟棄）共用一個 `usePending`；開 PR／合併／丟棄失敗的原因（例如合併衝突）留在面板上；PR 開好但瀏覽器打不開只用 toast 提示。丟棄要再確認一次；已完成的任務清除 worktree 後提示「已清除 worktree」，這次開著畫面時不再顯示按鈕。
- 匯出 HTML：按下匯出才以 `import('react-dom/server')` 載入（獨立的 chunk），`renderToStaticMarkup` 靜態渲染（React 轉義所有報告文字），沒有 `data-anchor` 屬性，沒有任何按鈕／輸入框，所有檔案的 diff 依序列出（太長的檔案只放摘要），自訂區塊用同一份包裝放進 `<iframe sandbox="allow-scripts" srcdoc>`；整份檔案有 `default-src 'none'` 的 CSP（srcdoc 會繼承），字型檔不打包，唯一的 script 是依區塊回報調整 iframe 高度。待送出的回饋不會出現在匯出檔。檔名去掉控制字元與不能用在檔名的字元，`.html` 前最多 80 個字元。

**Step 1: 寫失敗測試**

`tests/fixtures/report.ts` 加上（檔頭補 `import type { Report } from '@shared/types'`）：

```ts
/** 兩個檔案的 diff：新增 lockout.ts（4 行）、login.ts 改一行加一行 */
export const sampleDiff = `diff --git a/src/auth/lockout.ts b/src/auth/lockout.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/auth/lockout.ts
@@ -0,0 +1,4 @@
+export const MAX_ATTEMPTS = 5
+export const LOCK_TTL_SECONDS = 15 * 60
+
+export async function registerFailure() {}
diff --git a/src/auth/login.ts b/src/auth/login.ts
index 2222222..3333333 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,3 +10,4 @@ export async function login() {
   const user = await find()
-  check(user)
+  await lockoutGuard(user)
+  check(user)
   return user
`

/** 畫面測試用的完整報告：file_notes 對應 sampleDiff 的行號 */
export function makeReport(over: Partial<Report> = {}): Report {
  return {
    version: 1,
    taskId: 't1',
    input: {
      ...sampleReport,
      file_notes: [
        {
          path: 'src/auth/lockout.ts',
          why: '獨立計數邏輯',
          hunks: [{ line_start: 2, line_end: 2, why: 'TTL 用 EXPIRE' }]
        },
        { path: 'src/auth/login.ts', why: '登入前先檢查鎖定', hunks: [] }
      ]
    },
    diff: sampleDiff,
    stats: {
      files: 2,
      additions: 6,
      deletions: 1,
      perFile: [
        { path: 'src/auth/lockout.ts', additions: 4, deletions: 0 },
        { path: 'src/auth/login.ts', additions: 2, deletions: 1 }
      ]
    },
    verification: [
      { command: 'npm test', exitCode: 0, durationMs: 3200, outputTail: 'Tests  48 passed' },
      {
        command: 'npm run lint',
        exitCode: 1,
        durationMs: 1500,
        outputTail: 'error  no-unused-vars'
      },
      {
        command: 'npm run e2e',
        exitCode: null,
        durationMs: 0,
        outputTail: '',
        skipped: '這個指令在實作期間沒有被核准過，Harness 未自動執行'
      }
    ],
    commit: 'abc1234def',
    createdAt: '2026-10-07T06:20:00.000Z',
    ...over
  }
}

/** 一個新增 n 行的檔案（測試大 diff 的截斷與匯出摘要） */
export function bigDiff(path: string, n: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${n} @@`,
    ...Array.from({ length: n }, (_, i) => `+line ${i + 1}`),
    ''
  ].join('\n')
}
```

```tsx
// tests/renderer/DiffView.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { DiffView } from '@renderer/report/DiffView'
import { useStore } from '@renderer/store'
import { bigDiff, makeReport } from '../fixtures/report'

/** DiffView 的選取由外部控制：測試用一個有 state 的外層 */
function Controlled(props: Omit<ComponentProps<typeof DiffView>, 'selected' | 'onSelect'>) {
  const [selected, setSelected] = useState<string>()
  return <DiffView {...props} selected={selected} onSelect={setSelected} />
}

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1
+const b = 2
 export {}
`
beforeEach(() => useStore.setState({ feedback: {} }))

test('顯示檔案說明與段落原因，點行號留下回饋', async () => {
  render(
    <DiffView
      taskId="t1"
      diff={diff}
      perFile={[{ path: 'src/a.ts', additions: 1, deletions: 0 }]}
      notes={[
        { path: 'src/a.ts', why: '加上 b', hunks: [{ line_start: 2, line_end: 2, why: '新常數' }] }
      ]}
    />
  )
  expect(screen.getByText(/加上 b/)).toBeInTheDocument()
  expect(screen.getByText(/新常數/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對第 2 行留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '改成常數檔{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: '改成常數檔' }
  ])
  expect(screen.getByText('改成常數檔')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '回饋' })).not.toBeInTheDocument()
})

test('段落說明放在範圍內第一個顯示的行之前；範圍內沒有顯示的行就列在檔案說明下', () => {
  render(
    <DiffView
      taskId="t1"
      diff={diff}
      perFile={[]}
      notes={[
        {
          path: 'src/a.ts',
          why: '加上 b',
          hunks: [
            { line_start: 2, line_end: 9, why: '範圍從新增的行開始' },
            { line_start: 40, line_end: 42, why: '不在 diff 裡的行' }
          ]
        }
      ]}
    />
  )
  expect(screen.getByText(/為什麼（第 2–9 行）/).parentElement).toHaveTextContent(
    '範圍從新增的行開始'
  )
  expect(screen.getByText(/第 40–42 行/).parentElement).toHaveTextContent('不在 diff 裡的行')
})

test('再點一次已留言的行可以修改，Esc 取消', async () => {
  useStore.setState({
    feedback: { t1: [{ anchor: 'diff:src/a.ts:3', label: 'src/a.ts:3', text: '舊的意見' }] }
  })
  render(<DiffView taskId="t1" diff={diff} perFile={[]} notes={[]} />)
  expect(screen.getByText('回饋 · 第 3 行')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對第 3 行留言' }))
  const input = screen.getByRole('textbox', { name: '回饋' })
  expect(input).toHaveValue('舊的意見')
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('textbox', { name: '回饋' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對第 3 行留言' }))
  await userEvent.clear(screen.getByRole('textbox', { name: '回饋' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '新的意見{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'diff:src/a.ts:3', label: 'src/a.ts:3', text: '新的意見' }
  ])
})

test('唯讀時沒有留言按鈕、不顯示待送出的回饋，行號顯示新檔行號', () => {
  useStore.setState({
    feedback: { t1: [{ anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: '待送出' }] }
  })
  const { container } = render(
    <DiffView taskId="t1" diff={diff} perFile={[]} notes={[]} readOnly />
  )
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
  expect(screen.queryByText('待送出')).not.toBeInTheDocument()
  const gutters = [...container.querySelectorAll('[data-line]')].map((e) => e.textContent)
  expect(gutters).toEqual(['1', '2', '3'])
})

test('切換檔案；檔案標籤附增刪行數；刪除的行顯示舊檔行號', async () => {
  const report = makeReport()
  render(
    <Controlled
      taskId="t1"
      diff={report.diff}
      perFile={report.stats.perFile}
      notes={report.input.file_notes}
    />
  )
  const files = screen.getByRole('group', { name: '變更的檔案' })
  expect(
    within(files)
      .getAllByRole('button')
      .map((b) => b.textContent)
  ).toEqual(['src/auth/lockout.ts +4', 'src/auth/login.ts +2 −1'])
  expect(screen.getByText(/獨立計數邏輯/)).toBeInTheDocument()
  await userEvent.click(within(files).getByRole('button', { name: /login\.ts/ }))
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.getByText(/登入前先檢查鎖定/)).toBeInTheDocument()
  expect(screen.queryByText(/獨立計數邏輯/)).not.toBeInTheDocument()
  // 新檔第 11 行可以留言；刪除的那一行沒有新檔行號，顯示舊檔第 11 行、不能留言
  expect(screen.getAllByRole('button', { name: '對第 11 行留言' })).toHaveLength(1)
  expect(screen.getByText('- check(user)', { exact: false }).previousSibling).toHaveTextContent(
    '11'
  )
})

test('二進位檔案不顯示內容；沒有變更時顯示說明', () => {
  const bin = `diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`
  const { unmount } = render(
    <DiffView
      taskId="t1"
      diff={bin}
      perFile={[{ path: 'logo.png', additions: 0, deletions: 0 }]}
      notes={[]}
    />
  )
  expect(screen.getByText('二進位檔案，不顯示內容')).toBeInTheDocument()
  // 二進位檔的增刪行數都是 0，不顯示
  expect(screen.getByRole('button', { name: 'logo.png' })).toBeInTheDocument()
  unmount()
  render(<DiffView taskId="t1" diff="" perFile={[]} notes={[]} />)
  expect(screen.getByText('沒有程式碼變更')).toBeInTheDocument()
})

test('匯出（static）時依序列出每個檔案，沒有任何按鈕', () => {
  const report = makeReport()
  render(
    <DiffView
      taskId="t1"
      diff={report.diff}
      perFile={report.stats.perFile}
      notes={report.input.file_notes}
      isStatic
    />
  )
  expect(screen.getByText(/獨立計數邏輯/)).toBeInTheDocument()
  expect(screen.getByText(/登入前先檢查鎖定/)).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: /src\/auth\/login\.ts/ })).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('對整個檔案留言（二進位檔也可以）；加入或取消後焦點回到按鈕', async () => {
  const bin = `diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`
  render(<DiffView taskId="t1" diff={bin} perFile={[]} notes={[]} />)
  const button = screen.getByRole('button', { name: '對此檔案留言' })
  await userEvent.click(button)
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '換成 SVG{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'file:logo.png', label: 'logo.png', text: '換成 SVG' }
  ])
  expect(screen.getByText('回饋 · 整個檔案')).toBeInTheDocument()
  expect(button).toHaveFocus()
})

test('行號留言按 Esc 取消後，焦點回到行號', async () => {
  render(<DiffView taskId="t1" diff={diff} perFile={[]} notes={[]} />)
  const line = screen.getByRole('button', { name: '對第 2 行留言' })
  await userEvent.click(line)
  expect(screen.getByRole('textbox', { name: '回饋' })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  expect(line).toHaveFocus()
})

test('改名的檔案標出原本的路徑', () => {
  const renamed = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-export const a = 1
+export const a = 2
`
  render(<DiffView taskId="t1" diff={renamed} perFile={[]} notes={[]} />)
  expect(screen.getByText('src/old.ts').parentElement).toHaveTextContent('從 src/old.ts 改名')
  expect(screen.getByText('改名')).toBeInTheDocument()
})

test('預設選第一個不是鎖定檔或產生檔的檔案', () => {
  const d = [
    bigDiff('package-lock.json', 3),
    bigDiff('dist/app.min.js', 2),
    bigDiff('src/a.ts', 1)
  ].join('')
  render(<Controlled taskId="t1" diff={d} perFile={[]} notes={[]} />)
  expect(screen.getByRole('button', { name: 'src/a.ts' })).toHaveAttribute('aria-pressed', 'true')
  // 全部都是產生的檔案時選第一個
  render(<DiffView taskId="t2" diff={bigDiff('yarn.lock', 1)} perFile={[]} notes={[]} />)
  expect(screen.getByRole('button', { name: 'yarn.lock' })).toHaveAttribute('aria-pressed', 'true')
})

test('2 萬行的檔案只畫前 300 行，附上顯示全部的按鈕', () => {
  const { container } = render(
    <DiffView taskId="t1" diff={bigDiff('src/huge.ts', 20000)} perFile={[]} notes={[]} />
  )
  expect(container.querySelectorAll('[data-line]')).toHaveLength(300)
  // 大量 DOM 時 *ByRole 要算每個按鈕的名稱，非常慢：改用文字查詢
  expect(screen.getByText('顯示全部（共 20000 行）')).toBeInTheDocument()
})

test('超過 1500 行才截斷；按顯示全部後全部畫出來', () => {
  const { container, unmount } = render(
    <DiffView taskId="t1" diff={bigDiff('src/a.ts', 1500)} perFile={[]} notes={[]} />
  )
  expect(container.querySelectorAll('[data-line]')).toHaveLength(1500)
  expect(screen.queryByText(/顯示全部/)).not.toBeInTheDocument()
  unmount()
  const r = render(
    <DiffView taskId="t1" diff={bigDiff('src/a.ts', 1501)} perFile={[]} notes={[]} />
  )
  expect(r.container.querySelectorAll('[data-line]')).toHaveLength(300)
  fireEvent.click(screen.getByText('顯示全部（共 1501 行）'))
  expect(r.container.querySelectorAll('[data-line]')).toHaveLength(1501)
})

test('要捲到的行在截斷範圍外時自動展開', () => {
  const { container } = render(
    <DiffView
      taskId="t1"
      diff={bigDiff('src/a.ts', 1600)}
      perFile={[]}
      notes={[]}
      selected="src/a.ts"
      focusLine={1200}
    />
  )
  expect(container.querySelector('[data-anchor="diff:src/a.ts:1200"]')).toBeInTheDocument()
  expect(screen.queryByText(/顯示全部/)).not.toBeInTheDocument()
})

test('匯出時鎖定檔與超過 3000 行的檔案只放摘要，也沒有錨點屬性', () => {
  const d = [
    bigDiff('package-lock.json', 10),
    bigDiff('src/huge.ts', 3001),
    bigDiff('src/a.ts', 3000)
  ].join('')
  const { container } = render(<DiffView taskId="t1" diff={d} perFile={[]} notes={[]} isStatic />)
  expect(screen.getByText('此檔案變更 10 行，未包含在匯出中')).toBeInTheDocument()
  expect(screen.getByText('此檔案變更 3001 行，未包含在匯出中')).toBeInTheDocument()
  expect(container.querySelectorAll('[data-line]')).toHaveLength(3000)
  expect(container.querySelector('[data-anchor]')).toBeNull()
})
```

```tsx
// tests/renderer/ArchitectureDiagram.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { ArchitectureDiagram } from '@renderer/report/ArchitectureDiagram'
import { sampleReport } from '../fixtures/report'

test('畫出節點與連線，點節點回呼檔案', async () => {
  const onSelect = vi.fn()
  const { container } = render(
    <ArchitectureDiagram graph={sampleReport.architecture.after} onSelectFile={onSelect} />
  )
  expect(screen.getByRole('button', { name: /lockoutGuard/ })).toBeInTheDocument()
  expect(container.querySelectorAll('line')).toHaveLength(2)
  await userEvent.click(screen.getByRole('button', { name: /lockoutGuard/ }))
  expect(onSelect).toHaveBeenCalledWith('src/auth/lockout.ts')
})

test('只有對應到變更檔案的節點可以點；節點標出狀態', async () => {
  const onSelect = vi.fn()
  render(
    <ArchitectureDiagram
      graph={sampleReport.architecture.after}
      onSelectFile={onSelect}
      changedFiles={new Set(['src/auth/lockout.ts'])}
    />
  )
  expect(screen.getByRole('button', { name: 'lockoutGuard（新增）' })).toBeInTheDocument()
  // Client 沒有檔案、login.ts 的檔案不在 diff 裡：不是按鈕
  expect(screen.queryByRole('button', { name: /Client/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /login\.ts/ })).not.toBeInTheDocument()
  expect(screen.getByText('login.ts')).toBeInTheDocument()
  expect(screen.getByText('（修改）')).toBeInTheDocument()
})

test('沒有 onSelectFile（匯出）時節點都不是按鈕；同一頁兩張圖的箭頭 id 不重複', () => {
  const { container } = render(
    <>
      <ArchitectureDiagram graph={sampleReport.architecture.before} />
      <ArchitectureDiagram graph={sampleReport.architecture.after} />
    </>
  )
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  const ids = [...container.querySelectorAll('marker')].map((m) => m.id)
  expect(new Set(ids).size).toBe(2)
  for (const line of container.querySelectorAll('line')) {
    expect(ids.map((id) => `url(#${id})`)).toContain(line.getAttribute('marker-end'))
  }
})

test('略過指向自己的連線', () => {
  const { container } = render(
    <ArchitectureDiagram
      graph={{
        nodes: [
          { id: 'a', label: 'A', status: 'unchanged', files: [] },
          { id: 'b', label: 'B', status: 'added', files: [] }
        ],
        edges: [
          { from: 'a', to: 'a' },
          { from: 'a', to: 'b', label: '呼叫' }
        ]
      }}
    />
  )
  expect(container.querySelectorAll('line')).toHaveLength(1)
  expect(screen.getByText('呼叫')).toBeInTheDocument()
  expect(screen.getByText('A → B（呼叫）')).toBeInTheDocument()
})

test('連線另外列給螢幕閱讀器；圖有名稱', () => {
  render(<ArchitectureDiagram graph={sampleReport.architecture.after} label="之後的架構" />)
  expect(screen.getByRole('group', { name: '之後的架構' })).toBeInTheDocument()
  expect(screen.getByText('Client → lockoutGuard').closest('.sr-only')).not.toBeNull()
  expect(screen.getByText('lockoutGuard → login.ts')).toBeInTheDocument()
})
```

```tsx
// tests/renderer/CustomBlockFrame.test.tsx
import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { CustomBlockFrame } from '@renderer/report/CustomBlockFrame'

const post = (data: unknown, source: Window | null) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })

test('以獨立 scheme 載入、只允許 script（不給 same-origin）', () => {
  render(<CustomBlockFrame taskId="t1" version={2} id="state-machine" title="鎖定狀態機" />)
  const frame = screen.getByTitle('鎖定狀態機')
  expect(frame.tagName).toBe('IFRAME')
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  expect(frame).toHaveAttribute('src', 'harness-block://report/t1/2/state-machine')
})

test('只接受自己 iframe 回報的高度，並限制在合理範圍', async () => {
  render(
    <>
      <CustomBlockFrame taskId="t1" version={1} id="a" title="A" />
      <CustomBlockFrame taskId="t1" version={1} id="b" title="B" />
    </>
  )
  const a = screen.getByTitle('A') as HTMLIFrameElement
  const b = screen.getByTitle('B') as HTMLIFrameElement
  const initial = a.style.height
  await post({ type: 'harness-block-height', id: 'a', height: 480 }, a.contentWindow)
  expect(a.style.height).toBe('480px')
  expect(b.style.height).toBe(initial)
  // 別的 iframe 冒用 id、來源不是 iframe、格式不對：都忽略
  await post({ type: 'harness-block-height', id: 'a', height: 300 }, b.contentWindow)
  await post({ type: 'harness-block-height', id: 'a', height: 300 }, window)
  await post({ type: 'harness-block-height', id: 'b', height: 300 }, a.contentWindow)
  await post({ type: 'harness-block-height', id: 'a', height: Number.NaN }, a.contentWindow)
  await post(null, a.contentWindow)
  expect(a.style.height).toBe('480px')
  await post({ type: 'harness-block-height', id: 'a', height: 99999 }, a.contentWindow)
  expect(a.style.height).toBe('1600px')
  await post({ type: 'harness-block-height', id: 'a', height: 1 }, a.contentWindow)
  expect(a.style.height).toBe('80px')
})
```

```tsx
// tests/renderer/ReportScreen.test.tsx
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
import { call } from '@renderer/api'
import { ReportScreen } from '@renderer/screens/ReportScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Report, Task } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeReport } from '../fixtures/report'
import { makeTask } from '../fixtures/task'

let replies: Record<string, (...args: never[]) => unknown>

const reviewTask = (over: Partial<Task> = {}) =>
  makeTask({
    status: 'reviewing',
    reportVersions: [1],
    questions: [
      {
        id: 'q1',
        text: '計數單位',
        options: [],
        allowFreeText: true,
        status: 'answered',
        followups: [],
        askedAt: ''
      }
    ],
    ...over
  })

const renderReport = (task: Task, readOnly = false, onOpenStage = vi.fn()) => {
  useStore.setState({ tasks: { [task.id]: task } })
  return render(
    <ReportScreen task={task} nav={null} readOnly={readOnly} onOpenStage={onOpenStage} />
  )
}
const loaded = () => screen.findByRole('heading', { name: '登入流程多了一道鎖定關卡' })
const panel = () => screen.getByRole('complementary', { name: '回饋與收尾' })

beforeEach(() => {
  replies = {
    'report:get': (_taskId: string, version: number) => makeReport({ version }),
    'report:feedback': () => undefined,
    'report:saveHtml': () => '/Users/me/報告.html',
    'finish:pr': () => 'https://github.com/me/shop/pull/7',
    'finish:merge': () => undefined,
    'finish:discard': () => undefined,
    'shell:openExternal': () => undefined
  }
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string, ...args: never[]) =>
    replies[ch](...args)) as typeof call)
  resetStoreInternals()
  useStore.setState({ tasks: {}, timelines: {}, feedback: {}, toast: undefined })
})

test('讀取最新版本報告並顯示各區塊', async () => {
  renderReport(reviewTask({ reportVersions: [1, 2] }))
  await loaded()
  expect(call).toHaveBeenCalledWith('report:get', 't1', 2)
  const overview = screen.getByRole('region', { name: '概觀' })
  expect(within(overview).getByText('變更檔案').nextSibling).toHaveTextContent('2')
  expect(within(overview).getByText('行數').nextSibling).toHaveTextContent('+6 −1')
  // 略過的指令不算在分母
  expect(within(overview).getByText('驗證').nextSibling).toHaveTextContent('1 / 2 通過')
  expect(within(overview).getByText('決策').nextSibling).toHaveTextContent('1')

  const arch = screen.getByRole('region', { name: '架構前後對照' })
  expect(within(arch).getByText('之前')).toBeInTheDocument()
  expect(within(arch).getByRole('button', { name: 'lockoutGuard（新增）' })).toBeInTheDocument()

  const decisions = screen.getByRole('region', { name: '決策與原因' })
  expect(within(decisions).getByText('計數存在 Redis')).toBeInTheDocument()
  expect(within(decisions).getByText('來自分岔')).toBeInTheDocument()
  expect(within(decisions).getByText('多台機器共享')).toBeInTheDocument()

  const block = screen.getByRole('region', { name: '鎖定狀態機' })
  expect(within(block).getByTitle('鎖定狀態機')).toHaveAttribute(
    'src',
    'harness-block://report/t1/2/state-machine'
  )

  const limits = screen.getByRole('region', { name: '限制與後續' })
  expect(within(limits).getByText('Redis 掛掉時放行')).toBeInTheDocument()
  expect(within(limits).getByText('後台解鎖')).toBeInTheDocument()

  const diff = screen.getByRole('region', { name: '程式碼變更' })
  expect(within(diff).getByText(/獨立計數邏輯/)).toBeInTheDocument()

  const tests = screen.getByRole('region', { name: '測試結果' })
  expect(within(tests).getByText('通過 · 3.2 秒')).toBeInTheDocument()
  expect(within(tests).getByText('失敗（exit 1）· 1.5 秒')).toBeInTheDocument()
  // 失敗的輸出預設展開；略過的列出原因
  expect(within(tests).getByText('error no-unused-vars').closest('details')).toHaveAttribute('open')
  expect(within(tests).getByText('Tests 48 passed').closest('details')).not.toHaveAttribute('open')
  expect(within(tests).getByText(/沒有被核准過/)).toBeInTheDocument()
})

test('對區塊與決策留言會出現在回饋清單，可以刪除', async () => {
  renderReport(reviewTask())
  await loaded()
  expect(within(panel()).getByText('0 則待送出')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對「架構前後對照」留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), 'Redis 也畫出來{Enter}')
  await userEvent.click(screen.getByRole('button', { name: '對決策 D1 留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '說明 TTL{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'section:architecture', label: '架構前後對照', text: 'Redis 也畫出來' },
    { anchor: 'decision:d1', label: 'D1 計數存在 Redis', text: '說明 TTL' }
  ])
  expect(within(panel()).getByText('2 則待送出')).toBeInTheDocument()
  expect(within(panel()).getByText('區塊 · 架構前後對照')).toBeInTheDocument()
  expect(within(panel()).getByText('決策 · D1 計數存在 Redis')).toBeInTheDocument()
  // 留過的意見也顯示在原位置
  expect(
    within(screen.getByRole('region', { name: '架構前後對照' })).getByText('Redis 也畫出來')
  ).toBeInTheDocument()
  await userEvent.click(
    within(panel()).getByRole('button', { name: '刪除對「架構前後對照」的回饋' })
  )
  expect(useStore.getState().feedback.t1.map((f) => f.anchor)).toEqual(['decision:d1'])
})

test('送出回饋：沒有內容時停用；送出中停用、連點只送一次；成功後清空', async () => {
  renderReport(reviewTask())
  await loaded()
  const send = within(panel()).getByRole('button', { name: '送出回饋，產生 v2' })
  expect(send).toBeDisabled()
  useStore
    .getState()
    .addFeedback('t1', { anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: 'x' })
  await userEvent.type(within(panel()).getByRole('textbox', { name: /整體意見/ }), '  整體  ')
  const release = holdNextCall(vi.mocked(call))
  await userEvent.dblClick(send)
  expect(call).toHaveBeenCalledWith(
    'report:feedback',
    't1',
    [{ anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: 'x' }],
    '整體'
  )
  expect(vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:feedback')).toHaveLength(1)
  expect(send).toBeDisabled()
  expect(within(panel()).getByRole('button', { name: '開 Pull Request' })).toBeDisabled()
  await release()
  expect(useStore.getState().feedback.t1).toEqual([])
  expect(within(panel()).getByRole('textbox', { name: /整體意見/ })).toHaveValue('')
})

test('只有整體意見也能送出；失敗時保留內容', async () => {
  replies['report:feedback'] = () => {
    throw new Error('Claude 正在執行')
  }
  renderReport(reviewTask())
  await loaded()
  await userEvent.type(within(panel()).getByRole('textbox', { name: /整體意見/ }), '改名')
  expect(within(panel()).getByText(/整體意見還沒送出/)).toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '送出回饋，產生 v2' }))
  expect(call).toHaveBeenCalledWith('report:feedback', 't1', [], '改名')
  expect(useStore.getState().toast?.text).toBe('Claude 正在執行')
  expect(within(panel()).getByRole('textbox', { name: /整體意見/ })).toHaveValue('改名')
})

test('PR 開好但瀏覽器打不開：不算開 PR 失敗', async () => {
  replies['shell:openExternal'] = () => {
    throw new Error('無法開啟瀏覽器')
  }
  renderReport(reviewTask())
  await loaded()
  await userEvent.click(within(panel()).getByRole('button', { name: '開 Pull Request' }))
  await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法開啟瀏覽器'))
  expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
})

test('開 PR 後用瀏覽器打開 PR 網址', async () => {
  renderReport(reviewTask())
  await loaded()
  await userEvent.click(within(panel()).getByRole('button', { name: '開 Pull Request' }))
  expect(call).toHaveBeenCalledWith('finish:pr', 't1')
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('shell:openExternal', 'https://github.com/me/shop/pull/7')
  )
})

test('還有未送出的回饋時提醒；合併失敗時在面板顯示 git 的訊息', async () => {
  replies['finish:merge'] = () => {
    throw new Error('git merge: CONFLICT (content): Merge conflict in src/auth/login.ts')
  }
  renderReport(reviewTask())
  await loaded()
  useStore.getState().addFeedback('t1', { anchor: 'section:overview', label: '概觀', text: 'x' })
  expect(await within(panel()).findByText(/還有 1 則回饋沒送出/)).toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '合併到 main' }))
  expect(call).toHaveBeenCalledWith('finish:merge', 't1')
  const alert = await within(panel()).findByRole('alert')
  expect(alert).toHaveTextContent('合併失敗')
  expect(alert).toHaveTextContent('Merge conflict in src/auth/login.ts')
})

test('丟棄 worktree 要再確認一次，可以取消', async () => {
  renderReport(reviewTask())
  await loaded()
  await userEvent.click(within(panel()).getByRole('button', { name: '丟棄 worktree' }))
  expect(call).not.toHaveBeenCalledWith('finish:discard', 't1')
  expect(within(panel()).getByText(/harness\/t1/)).toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '取消' }))
  await userEvent.click(within(panel()).getByRole('button', { name: '丟棄 worktree' }))
  await userEvent.click(within(panel()).getByRole('button', { name: '確定丟棄' }))
  expect(call).toHaveBeenCalledWith('finish:discard', 't1')
})

test('依回饋修改中（implementing）回看報告：只能看', async () => {
  renderReport(reviewTask({ status: 'implementing', runState: 'running' }), true)
  await loaded()
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /送出回饋/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '開 Pull Request' })).not.toBeInTheDocument()
  expect(within(panel()).getByText(/Claude 正在依回饋修改，完成後會產生 v2/)).toBeInTheDocument()
})

test('切換版本：讀取該版本；舊版本只能看，可以回到最新版', async () => {
  renderReport(reviewTask({ reportVersions: [1, 2] }))
  await loaded()
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '版本' }), '1')
  await waitFor(() => expect(call).toHaveBeenCalledWith('report:get', 't1', 1))
  expect(await screen.findByText(/正在看 v1（舊版本）/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
  // 回饋仍然可以針對最新版本送出
  expect(within(panel()).getByRole('button', { name: '送出回饋，產生 v3' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '回到 v2' }))
  expect(screen.getByRole('combobox', { name: '版本' })).toHaveValue('2')
  expect(screen.getByRole('button', { name: '對「概觀」留言' })).toBeInTheDocument()
  // 讀過的版本不再重新讀取
  expect(vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:get')).toHaveLength(2)
})

test('讀取失敗時顯示原因與重試', async () => {
  let fail = true
  replies['report:get'] = (_t: string, version: number) => {
    if (fail) throw new Error('找不到報告 v1')
    return makeReport({ version })
  }
  renderReport(reviewTask())
  expect(await screen.findByText(/找不到報告 v1/)).toBeInTheDocument()
  fail = false
  await userEvent.click(screen.getByRole('button', { name: '重試' }))
  await loaded()
})

test('讀取失敗的版本：換到別的版本再回來會重新讀取，不顯示舊的錯誤', async () => {
  let failV1 = true
  replies['report:get'] = (_t: string, version: number) => {
    if (version === 1 && failV1) throw new Error('暫時讀不到')
    return makeReport({ version })
  }
  renderReport(reviewTask({ reportVersions: [1, 2] }))
  await loaded()
  await userEvent.selectOptions(screen.getByRole('combobox'), '1')
  expect(await screen.findByText(/暫時讀不到/)).toBeInTheDocument()
  failV1 = false
  await userEvent.selectOptions(screen.getByRole('combobox'), '2')
  expect(screen.queryByText(/暫時讀不到/)).not.toBeInTheDocument()
  await userEvent.selectOptions(screen.getByRole('combobox'), '1')
  expect(screen.queryByText(/暫時讀不到/)).not.toBeInTheDocument()
  expect(await screen.findByText(/正在看 v1（舊版本）/)).toBeInTheDocument()
  expect(
    vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:get' && c[2] === 1)
  ).toHaveLength(2)
})

test('匯出 HTML：送出自含的 HTML 與安全的檔名', async () => {
  renderReport(reviewTask({ title: '登入/鎖定' }))
  await loaded()
  const button = screen.getByRole('button', { name: '匯出 HTML' })
  const release = holdNextCall(vi.mocked(call))
  await userEvent.dblClick(button)
  expect(button).toBeDisabled()
  // react-dom/server 是按下匯出才載入：等 HTML 產生、送出後再讓它完成
  await waitFor(() =>
    expect(vi.mocked(call).mock.calls.some((c) => c[0] === 'report:saveHtml')).toBe(true)
  )
  await release('/Users/me/報告.html')
  const calls = vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:saveHtml')
  expect(calls).toHaveLength(1)
  const [, name, html] = calls[0] as unknown as [string, string, string]
  expect(name).toBe('登入-鎖定-變更報告-v1.html')
  expect(html).toMatch(/^<!doctype html>/)
  expect(html).toContain('登入流程多了一道鎖定關卡')
  expect(useStore.getState().toast?.text).toBe('已匯出：/Users/me/報告.html')
})

test('點決策的問題來源打開釐清階段；點架構節點切換到對應檔案', async () => {
  const onOpenStage = vi.fn()
  const report = makeReport()
  report.input.decisions = [
    { ...report.input.decisions[0], id: 'd2', source: { type: 'question', ref: 'q1' } }
  ]
  replies['report:get'] = () => report
  renderReport(reviewTask(), false, onOpenStage)
  await loaded()
  await userEvent.click(screen.getByRole('button', { name: '問題 1（查看釐清對話）' }))
  expect(onOpenStage).toHaveBeenCalledWith('clarify')
  const files = screen.getByRole('group', { name: '變更的檔案' })
  expect(within(files).getByRole('button', { name: /lockout\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await userEvent.click(screen.getAllByRole('button', { name: 'login.ts（修改）' })[0])
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('點回饋清單裡的程式碼回饋會切換到那個檔案', async () => {
  renderReport(reviewTask())
  await loaded()
  useStore.getState().addFeedback('t1', {
    anchor: 'diff:src/auth/login.ts:11',
    label: 'src/auth/login.ts:11',
    text: '改用 await'
  })
  await userEvent.click(await within(panel()).findByText('程式碼 · src/auth/login.ts:11'))
  const files = screen.getByRole('group', { name: '變更的檔案' })
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.getByText('回饋 · 第 11 行')).toBeInTheDocument()
})

test('已完成：顯示 PR 連結與清除 worktree', async () => {
  renderReport(reviewTask({ status: 'done', prUrl: 'https://github.com/me/shop/pull/7' }), true)
  await loaded()
  expect(screen.queryByRole('button', { name: /送出回饋/ })).not.toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '開啟 Pull Request' }))
  expect(call).toHaveBeenCalledWith('shell:openExternal', 'https://github.com/me/shop/pull/7')
  await userEvent.click(within(panel()).getByRole('button', { name: '清除 worktree' }))
  await userEvent.click(within(panel()).getByRole('button', { name: '確定清除' }))
  expect(call).toHaveBeenCalledWith('finish:discard', 't1')
  // 清除後提示，這次開著畫面時不再顯示按鈕
  await waitFor(() => expect(useStore.getState().toast?.text).toBe('已清除 worktree'))
  expect(within(panel()).queryByRole('button', { name: '清除 worktree' })).not.toBeInTheDocument()
})

test('TaskScreen：待審閱顯示報告；依回饋修改中可以回看報告但只能看', async () => {
  useStore.setState({ tasks: { t1: reviewTask() } })
  const { unmount } = render(<TaskScreen taskId="t1" />)
  await loaded()
  expect(screen.getByRole('button', { name: '對「概觀」留言' })).toBeInTheDocument()
  unmount()
  const report: Report = makeReport()
  replies['report:get'] = () => report
  replies['tasks:timeline'] = () => []
  replies['tasks:changedFiles'] = () => ({ files: 0, additions: 0, deletions: 0, perFile: [] })
  useStore.setState({
    tasks: { t1: reviewTask({ status: 'implementing', runState: 'running' }) },
    timelines: { t1: [] }
  })
  render(<TaskScreen taskId="t1" />)
  await userEvent.click(screen.getByRole('button', { name: /報告/ }))
  await loaded()
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
})

test('對整個檔案留言：清單標成「檔案」，點它切換到那個檔案；關掉留言後焦點回到按鈕', async () => {
  renderReport(reviewTask())
  await loaded()
  const files = screen.getByRole('group', { name: '變更的檔案' })
  await userEvent.click(within(files).getByRole('button', { name: /login\.ts/ }))
  await userEvent.click(screen.getByRole('button', { name: '對此檔案留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '拆成兩個函式{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'file:src/auth/login.ts', label: 'src/auth/login.ts', text: '拆成兩個函式' }
  ])
  expect(screen.getByRole('button', { name: '對此檔案留言' })).toHaveFocus()
  await userEvent.click(within(files).getByRole('button', { name: /lockout\.ts/ }))
  await userEvent.click(within(panel()).getByText('檔案 · src/auth/login.ts'))
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  // 區塊留言按 Esc 關掉後，焦點也回到留言按鈕
  const overview = screen.getByRole('button', { name: '對「概觀」留言' })
  await userEvent.click(overview)
  await userEvent.keyboard('{Escape}')
  expect(overview).toHaveFocus()
})
```

```tsx
// tests/renderer/exportHtml.test.tsx
import { expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { buildReportHtml, exportFileName } from '@renderer/report/exportHtml'
import { useStore } from '@renderer/store'
import { BLOCK_CSP } from '@shared/blockHtml'
import { bigDiff, makeReport } from '../fixtures/report'
import { makeTask } from '../fixtures/task'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

test('匯出的 HTML 自含、轉義所有報告文字、沒有互動控制', async () => {
  // 待送出的回饋不應該出現在匯出檔
  useStore.setState({
    feedback: { t1: [{ anchor: 'diff:src/auth/login.ts:11', label: 'x', text: '私人意見' }] }
  })
  const report = makeReport()
  report.input.overview = {
    headline: '<img src=x onerror=alert(1)>標題',
    summary: '</style><script>alert(2)</script>'
  }
  const task = makeTask({ status: 'reviewing', reportVersions: [1], title: '鎖定 <b>&</b>' })
  const html = await buildReportHtml(task, report)
  expect(html).toMatch(/^<!doctype html>/)
  expect(html).not.toContain('<img src=x')
  expect(html).not.toContain('<script>alert(2)')
  expect(html).toContain('<title>鎖定 &lt;b&gt;&amp;&lt;/b&gt; · 變更報告 v1</title>')
  expect(html).not.toContain('私人意見')

  const doc = parse(html)
  // 不能連網
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
  expect(csp?.getAttribute('content')).toContain("default-src 'none'")
  expect(doc.querySelectorAll('link, script[src], img[src^="http"]')).toHaveLength(0)
  expect(doc.querySelector('h1')?.textContent).toBe('<img src=x onerror=alert(1)>標題')
  expect(doc.querySelectorAll('button, input, textarea, select, form')).toHaveLength(0)
  // 匯出檔不需要回饋清單用的錨點
  expect(doc.querySelectorAll('[data-anchor]')).toHaveLength(0)
  // 所有檔案的 diff 都在（沒有切換檔案的按鈕可用）
  expect(doc.body.textContent).toContain('獨立計數邏輯')
  expect(doc.body.textContent).toContain('登入前先檢查鎖定')

  const frames = doc.querySelectorAll('iframe')
  expect(frames).toHaveLength(1)
  const frame = frames[0]
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.hasAttribute('src')).toBe(false)
  const srcdoc = frame.getAttribute('srcdoc') ?? ''
  expect(srcdoc).toContain('<div>正常 → 鎖定</div>')
  expect(srcdoc).toContain(`content="${BLOCK_CSP}"`)
})

test('匯出檔名去掉控制字元與不能用在檔名的字元，並限制長度', () => {
  expect(exportFileName(makeTask({ title: 'a/b:c*?"<>|d\n e' }), 3)).toBe(
    'a-b-c------d e-變更報告-v3.html'
  )
  expect(exportFileName(makeTask({ title: 'x\u0000\u0007y\u007f' }), 1)).toBe(
    'x y-變更報告-v1.html'
  )
  expect(exportFileName(makeTask({ title: '  ' }), 1)).toBe('任務-變更報告-v1.html')
  const long = exportFileName(makeTask({ title: '登入'.repeat(100) + '😀' }), 12)
  expect(long.endsWith('-變更報告-v12.html')).toBe(true)
  expect(Array.from(long.replace(/\.html$/, ''))).toHaveLength(80)
})

test('前後兩張架構圖用同樣的比例縮放（匯出檔沒有 script 也一樣）', async () => {
  const report = makeReport()
  // 之後的圖有一層並排兩個方塊：寬 400；之前的圖寬 180
  report.input.architecture.after = {
    nodes: [
      ...report.input.architecture.after.nodes,
      { id: 'redis', label: 'Redis', status: 'unchanged', files: [] }
    ],
    edges: [...report.input.architecture.after.edges, { from: 'guard', to: 'redis' }]
  }
  const html = await buildReportHtml(makeTask(), report)
  const widths = [...parse(html).querySelectorAll('svg[role="group"]')].map((svg) =>
    svg.getAttribute('style')
  )
  expect(widths).toEqual([
    'width:min(180px, 45%);min-width:108px',
    'width:min(400px, 100%);min-width:240px'
  ])
})

test('大 diff：超過 3000 行的檔案與鎖定檔只放摘要，匯出檔維持小', async () => {
  const report = makeReport({
    diff:
      bigDiff('src/generated/huge.ts', 20000) +
      bigDiff('package-lock.json', 40) +
      bigDiff('src/a.ts', 2),
    stats: { files: 3, additions: 20042, deletions: 0, perFile: [] }
  })
  const html = await buildReportHtml(makeTask(), report)
  expect(html).toContain('此檔案變更 20000 行，未包含在匯出中')
  expect(html).toContain('此檔案變更 40 行，未包含在匯出中')
  expect(html).toContain('line 2')
  expect(html).not.toContain('line 2999')
  expect(html.length).toBeLessThan(60_000)
})
```

```ts
// tests/renderer/format.test.ts
import { expect, test } from 'vitest'
import { shortTime } from '@renderer/lib/format'

test('以本地時間顯示月/日 時:分，補零', () => {
  expect(shortTime(new Date(2026, 9, 7, 14, 5).toISOString())).toBe('10/07 14:05')
  expect(shortTime(new Date(2026, 0, 3, 9, 0).toISOString())).toBe('01/03 09:00')
})

test('無法解析的時間回傳空字串', () => {
  expect(shortTime('')).toBe('')
  expect(shortTime('not a date')).toBe('')
})
```

`tests/main/prompts.test.ts` 的清單補上 `'file:檔案路徑'` 與 `'高度由內容決定，不要使用 vh 或 100% 高度'`。

`tests/main/blockHtml.test.ts` 加上：

```ts
test('回報包住內容的容器高度（不是 scrollHeight：那至少是 iframe 目前的高度，縮不回來）', () => {
  const html = wrapBlockHtml({ id: 'a', title: 't', html: '<p>x</p>' })
  expect(html).toContain('<div id="harness-block-root" style="display:flow-root"><p>x</p></div>')
  expect(html).toContain('observe(root)')
  expect(html).not.toContain('scrollHeight')
})
```

**Step 2: 確認失敗**

Run: `npx vitest run tests/renderer/DiffView.test.tsx tests/renderer/ArchitectureDiagram.test.tsx tests/renderer/CustomBlockFrame.test.tsx tests/renderer/ReportScreen.test.tsx tests/renderer/exportHtml.test.tsx tests/renderer/format.test.ts tests/main/blockHtml.test.ts tests/main/prompts.test.ts` → FAIL（模組不存在、提示缺字）

**Step 3: 共用的區塊包裝、tokens 與圖示**

```ts
// src/shared/blockHtml.ts
// 主程序以 harness-block:// 提供自訂區塊、renderer 匯出 HTML 時放進 srcdoc，兩邊用同一份包裝。

/** 自訂區塊只能用 inline 的 style／script 與 data: 圖片字型，不能連網、不能送表單 */
export const BLOCK_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

/**
 * 回報的高度量的是包住內容的容器（flow-root，子元素的 margin 也算在內），
 * 不是 documentElement.scrollHeight：後者至少是 iframe 目前的高度，內容變矮時 iframe 就縮不回來。
 */
export function wrapBlockHtml(block: { id: string; title: string; html: string }): string {
  // 避免 id 裡的 `</script>` 提早結束 script（id 已經過 zod 檢查，這裡再保險一次）
  const id = JSON.stringify(block.id).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BLOCK_CSP}">
<title>${escapeHtml(block.title)}</title>
<style>html,body{margin:0;background:transparent;color:#1c2430;font-family:'Noto Sans TC',-apple-system,'PingFang TC',sans-serif;font-size:14px;line-height:1.6}</style>
</head><body><div id="harness-block-root" style="display:flow-root">${block.html}</div>
<script>(function(){var root=document.getElementById("harness-block-root");var post=function(){parent.postMessage({type:"harness-block-height",id:${id},height:Math.ceil(root.getBoundingClientRect().height)},"*")};new ResizeObserver(post).observe(root);addEventListener("load",post);post()})()</script>
</body></html>`
}
```

`src/main/report/blockHtml.ts` 刪掉 `BLOCK_CSP`、`escapeHtml`、`wrapBlockHtml`，改成 re-export（`parseBlockUrl` 不變）：

```ts
// src/main/report/blockHtml.ts
import { isSafeId } from '../ipcGuards'

export { BLOCK_CSP, wrapBlockHtml } from '@shared/blockHtml'
```

`src/renderer/src/styles/app.css` 的 `@theme` 補上（`brand-deep` 放在 `brand-halo` 後面，其餘放在 `code-muted` 後面）：

```css
  --color-brand-deep: #134e4a;
  --color-code-line: #7d8794;
  --color-diff-add: #22c55e;
  --color-diff-del: #ef4444;
  --color-diff-flag: #facc15;
  --color-connector: #8a93a0;
```

`src/renderer/src/components/ui.tsx` 的 `Icons` 補上：

```tsx
  Minus: (p: IconProps) => svg(p, <path d="M6 12h12" />),
  Chevron: (p: IconProps) => svg(p, <path d="M9 6l6 6-6 6" />)
```

```ts
// src/renderer/src/lib/format.ts

const pad = (n: number) => String(n).padStart(2, '0')

/** 報告等的產生時間（本地時間），例如 10/07 14:20；無法解析時回傳空字串 */
export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
```

`src/main/agent/prompts.ts`（Task 19）的 submit_report 寫法改成：custom_blocks 一行結尾補「；高度由內容決定，不要使用 vh 或 100% 高度。」，[report_feedback] 的錨點例子改成「diff:檔案路徑:行號（新版檔案的行號）、file:檔案路徑（整個檔案）、decision:D1、section:architecture、block:id」。

**Step 4: ArchitectureDiagram.tsx**

```tsx
// src/renderer/src/report/ArchitectureDiagram.tsx
import { useId } from 'react'
import { BOX_H, BOX_W, layoutGraph } from '@shared/layout'
import type { ReportInput } from '@shared/report'
import { cx } from '../components/ui'

type Graph = ReportInput['architecture']['after']
type GraphNode = Graph['nodes'][number]

const STATUS_CLASS = {
  added: 'bg-brand font-medium text-white',
  modified: 'bg-surface shadow-[inset_0_0_0_2px_var(--color-review)]',
  unchanged: 'bg-surface'
} as const
const STATUS_LABEL = { added: '新增', modified: '修改', unchanged: '未變' } as const
/** 縮小的下限；欄位再窄就水平捲動 */
const MIN_SCALE = 0.6
/** 箭頭與方塊之間留的空隙 */
const GAP = 3

/** 從方塊中心沿 (dx, dy) 走到方塊邊緣，佔整段中心距離的比例 */
function edgeT(dx: number, dy: number) {
  const tx = dx ? BOX_W / 2 / Math.abs(dx) : Infinity
  const ty = dy ? BOX_H / 2 / Math.abs(dy) : Infinity
  return Math.min(tx, ty)
}

/**
 * 架構圖：自動分層排版，整張是一個有 viewBox 的 SVG，用 CSS 寬度縮放（匯出 HTML 沒有 script 也一樣）。
 * 寬度是 min(原寬, 原寬 / fitWidth × 100%)：前後兩張給同一個 fitWidth，縮放比例就相同。
 * 方塊放在 foreignObject 裡（HTML 才能截斷文字）；有 onSelectFile 時，對應到變更檔案的方塊可以點。
 */
export function ArchitectureDiagram({
  graph,
  label,
  fitWidth,
  onSelectFile,
  changedFiles
}: {
  graph: Graph
  /** 給螢幕閱讀器的名稱，例如「之後的架構」 */
  label?: string
  /** 和另一張圖一起縮放時，兩張圖裡比較寬的寬度 */
  fitWidth?: number
  onSelectFile?: (path: string) => void
  /** 這次變更的檔案；有給的話，只有檔案在裡面的方塊可以點 */
  changedFiles?: ReadonlySet<string>
}) {
  const markerId = useId()
  const { nodes, width, height } = layoutGraph(graph.nodes, graph.edges)
  const fit = Math.max(width, fitWidth ?? width)
  const pos = new Map(nodes.map((n) => [n.node.id, n]))
  const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]))
  const edges = graph.edges.filter((e) => e.from !== e.to && pos.has(e.from) && pos.has(e.to))
  const targetOf = (node: GraphNode) =>
    changedFiles ? node.files.find((f) => changedFiles.has(f)) : node.files[0]

  return (
    <div className="overflow-x-auto">
      <svg
        role="group"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="mx-auto block h-auto max-w-full"
        style={{
          width: `min(${width}px, ${+((width / fit) * 100).toFixed(3)}%)`,
          minWidth: width * MIN_SCALE
        }}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" className="fill-connector" />
          </marker>
        </defs>
        <g aria-hidden>
          {edges.map((e, i) => {
            const a = pos.get(e.from)!
            const b = pos.get(e.to)!
            // 從起點方塊的邊緣畫到終點方塊的邊緣（沿兩個中心的連線）
            const ax = a.x + BOX_W / 2
            const ay = a.y + BOX_H / 2
            const dx = b.x + BOX_W / 2 - ax
            const dy = b.y + BOX_H / 2 - ay
            const len = Math.hypot(dx, dy)
            const t0 = edgeT(dx, dy) + GAP / len
            const t1 = 1 - edgeT(dx, dy) - GAP / len
            if (t1 <= t0) return null
            const x1 = ax + dx * t0
            const y1 = ay + dy * t0
            const x2 = ax + dx * t1
            const y2 = ay + dy * t1
            return (
              <g key={i}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  className="stroke-connector"
                  strokeWidth={1.5}
                  markerEnd={`url(#${markerId})`}
                />
                {e.label && (
                  <text
                    x={(x1 + x2) / 2 + 6}
                    y={(y1 + y2) / 2 + 4}
                    className="fill-muted text-[11px]"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
        {nodes.map(({ node, x, y }) => {
          const target = onSelectFile && targetOf(node)
          const className = cx(
            'flex size-full items-center justify-center rounded-xl px-2.5 text-[13px]',
            STATUS_CLASS[node.status]
          )
          const title = node.files.join('\n') || undefined
          const text = <span className="min-w-0 truncate">{node.label}</span>
          return (
            <foreignObject key={node.id} x={x} y={y} width={BOX_W} height={BOX_H}>
              {target ? (
                <button
                  type="button"
                  title={title}
                  aria-label={`${node.label}（${STATUS_LABEL[node.status]}）`}
                  onClick={() => onSelectFile?.(target)}
                  className={cx(
                    className,
                    'cursor-pointer hover:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand'
                  )}
                >
                  {text}
                </button>
              ) : (
                <div title={title} className={className}>
                  {text}
                  <span className="sr-only">（{STATUS_LABEL[node.status]}）</span>
                </div>
              )}
            </foreignObject>
          )
        })}
      </svg>
      {/* 連線只畫在圖上；螢幕閱讀器改唸這份清單 */}
      {edges.length > 0 && (
        <ul className="sr-only">
          {edges.map((e, i) => (
            <li key={i}>
              {labelOf.get(e.from)} → {labelOf.get(e.to)}
              {e.label && `（${e.label}）`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

**Step 5: CustomBlockFrame.tsx 與 blocks.ts**

```ts
// src/renderer/src/report/blocks.ts
// 自訂區塊 iframe 的高度規則：畫面上的 CustomBlockFrame 與匯出 HTML 的小段 script 共用。

/** 自訂區塊 iframe 的高度範圍：區塊回報的高度夾在這之間 */
export const BLOCK_MIN_H = 80
export const BLOCK_MAX_H = 1600
/** 區塊還沒回報高度前的預設高度（匯出檔沒有 script 可跑時也用這個） */
export const BLOCK_DEFAULT_H = 220

/** 區塊回報的高度：只接受有限的數字，並夾在範圍內；格式不對回傳 undefined */
export function blockHeight(data: unknown, id: string): number | undefined {
  const d = data as { type?: unknown; id?: unknown; height?: unknown } | null
  if (!d || d.type !== 'harness-block-height' || d.id !== id) return undefined
  if (typeof d.height !== 'number' || !Number.isFinite(d.height)) return undefined
  return Math.min(Math.max(d.height, BLOCK_MIN_H), BLOCK_MAX_H)
}
```

```tsx
// src/renderer/src/report/CustomBlockFrame.tsx
import { useEffect, useRef, useState } from 'react'
import { BLOCK_DEFAULT_H, blockHeight } from './blocks'

/**
 * 以獨立的 harness-block:// scheme + sandbox iframe 呈現 Claude 產生的 HTML：
 * 只給 allow-scripts（不給 same-origin，拿不到 renderer 與 preload），主程序回應的 CSP 禁止連網。
 * 高度由區塊自己回報；只接受來自這個 iframe 的訊息。
 */
export function CustomBlockFrame({
  taskId,
  version,
  id,
  title
}: {
  taskId: string
  version: number
  id: string
  title: string
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(BLOCK_DEFAULT_H)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current
      if (!frame || e.source === null || e.source !== frame.contentWindow) return
      const h = blockHeight(e.data, id)
      if (h !== undefined) setHeight(h)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [id])
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={`harness-block://report/${taskId}/${version}/${id}`}
      className="block w-full rounded-2xl border-0 bg-fill-2"
      style={{ height }}
    />
  )
}
```

**Step 6: 錨點、留言元件、大 diff 規則與 DiffView.tsx**

```ts
// src/renderer/src/report/anchors.ts
// 回饋錨點（主程序原樣轉給 Claude）：section:<id>、decision:<id>、block:<id>、
// file:<路徑>（整個檔案）、diff:<路徑>:<新檔行號>
import type { FeedbackItem } from '@shared/types'

export const diffAnchor = (path: string, line: number) => `diff:${path}:${line}`
export const fileAnchor = (path: string) => `file:${path}`

/** 指向 diff 的錨點對應的檔案與行號（路徑本身可能含冒號，所以行號取最後一個冒號之後） */
export function anchorTarget(anchor: string): { path: string; line?: number } | undefined {
  if (anchor.startsWith('file:')) return { path: anchor.slice('file:'.length) }
  if (!anchor.startsWith('diff:')) return undefined
  const rest = anchor.slice('diff:'.length)
  const i = rest.lastIndexOf(':')
  const line = Number(rest.slice(i + 1))
  return i > 0 && Number.isInteger(line) ? { path: rest.slice(0, i), line } : undefined
}

const KIND: Record<string, string> = {
  diff: '程式碼',
  file: '檔案',
  decision: '決策',
  block: '視覺化',
  section: '區塊'
}

/** 回饋清單上的標題，例如「程式碼 · src/a.ts:12」 */
export function feedbackTitle(f: FeedbackItem): string {
  const kind = KIND[f.anchor.slice(0, f.anchor.indexOf(':'))]
  return kind ? `${kind} · ${f.label}` : f.label
}
```

```ts
// src/renderer/src/report/diffFiles.ts
// 大 diff 的處理：自動產生的檔案、截斷與匯出摘要的門檻
import type { DiffFile } from '@shared/diff'

/** 畫面上超過這麼多行的檔案先只顯示前 TRUNCATED_LINES 行，按「顯示全部」才全部畫出來 */
export const TRUNCATE_OVER = 1500
export const TRUNCATED_LINES = 300
/** 匯出時超過這麼多行的檔案只放一行摘要（鎖定檔一律只放摘要） */
export const EXPORT_OVER = 3000

const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export const isLockfile = (path: string) => LOCKFILES.has(baseName(path))

/** 鎖定檔、壓縮過的 js、dist/ 與 build/ 底下的檔案 */
export function isGenerated(path: string): boolean {
  return isLockfile(path) || path.endsWith('.min.js') || /(^|\/)(dist|build)\//.test(path)
}

/** 預設選取的檔案：第一個不是自動產生的檔案；全部都是的話取第一個 */
export function defaultFile(files: DiffFile[]): DiffFile | undefined {
  return files.find((f) => !isGenerated(f.path)) ?? files[0]
}

/** 檔案 diff 的行數（新增、刪除與上下文行，不含段落標頭） */
export const lineCount = (file: DiffFile) => file.hunks.reduce((n, h) => n + h.lines.length, 0)
```

```tsx
// src/renderer/src/report/comments.tsx
// 報告上的留言：留言按鈕、輸入框，以及已經留下（還沒送出）的回饋
import { type FormEvent, useState } from 'react'
import { cx, Icons } from '../components/ui'
import { blockImeSubmit, isComposing } from '../lib/ime'

export function CommentButton({
  label,
  text = '留言',
  onClick,
  className
}: {
  /** 螢幕閱讀器唸的名稱（例如「對「概觀」留言」）；不給就用按鈕上的文字 */
  label?: string
  text?: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        'flex h-7 flex-none cursor-pointer items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-fill hover:text-ink',
        className
      )}
    >
      <Icons.Comment width={13} height={13} />
      {text}
    </button>
  )
}

/**
 * 輸入一則回饋：Enter 加入、Esc 取消；dark 用在程式碼區塊裡。
 * 加入或取消後，焦點回到打開它的按鈕（輸入框出現前的焦點）。
 */
export function CommentForm({
  initial = '',
  placeholder,
  dark,
  onSubmit,
  onCancel,
  className
}: {
  initial?: string
  placeholder: string
  dark?: boolean
  onSubmit: (text: string) => void
  onCancel: () => void
  className?: string
}) {
  const [text, setText] = useState(initial)
  // 第一次 render 時輸入框還沒取得焦點：這時的焦點就是按下的「留言」或行號按鈕
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const close = (fn: () => void) => {
    fn()
    if (opener?.isConnected) opener.focus()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    if (value) close(() => onSubmit(value))
  }
  return (
    <form onSubmit={submit} className={cx('flex items-center gap-2 font-sans', className)}>
      <input
        // 按了「留言」就是要打字
        autoFocus
        aria-label="回饋"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 輸入法選字中的 Enter／Esc 屬於組字：不加入、不取消
          blockImeSubmit(e)
          if (e.key === 'Escape' && !isComposing(e)) close(onCancel)
        }}
        placeholder={placeholder}
        className={cx(
          'h-9 min-w-0 flex-1 rounded-lg px-3 text-[13px] text-ink outline-none placeholder:text-muted-2',
          dark ? 'bg-surface' : 'border border-line bg-surface focus:border-brand'
        )}
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="h-9 flex-none cursor-pointer rounded-lg bg-brand px-3 text-xs font-medium text-white hover:bg-brand-hover disabled:cursor-default disabled:opacity-50"
      >
        加入
      </button>
      <button
        type="button"
        onClick={() => close(onCancel)}
        className={cx(
          'h-9 flex-none cursor-pointer px-1.5 text-xs',
          dark ? 'text-code-muted hover:text-white' : 'text-muted hover:text-ink'
        )}
      >
        取消
      </button>
    </form>
  )
}

/** 已經留下、等著跟其他回饋一起送出的意見（對照 B5 程式碼下方的黃色便條） */
export function FeedbackNote({
  title,
  text,
  className
}: {
  title: string
  text: string
  className?: string
}) {
  return (
    <div
      className={cx(
        'flex gap-2.5 rounded-xl bg-note px-3.5 py-3 font-sans text-[13px] leading-relaxed text-ink',
        className
      )}
    >
      <span
        aria-hidden
        className="flex size-6 flex-none items-center justify-center rounded-full bg-ink text-[11px] text-white"
      >
        你
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-note-ink">{title}</span>
        <span className="break-words whitespace-pre-wrap">{text}</span>
      </span>
    </div>
  )
}
```

```tsx
// src/renderer/src/report/DiffView.tsx
import { memo, useCallback, useMemo, useState } from 'react'
import { type DiffFile, type DiffHunk, parseUnifiedDiff } from '@shared/diff'
import type { ReportInput } from '@shared/report'
import type { DiffStats } from '@shared/types'
import { InlineCode } from '../components/Markdown'
import { cx, Pill } from '../components/ui'
import { useStore } from '../store'
import { diffAnchor, fileAnchor } from './anchors'
import { CommentButton, CommentForm, FeedbackNote } from './comments'
import {
  defaultFile,
  EXPORT_OVER,
  isLockfile,
  lineCount,
  TRUNCATE_OVER,
  TRUNCATED_LINES
} from './diffFiles'

type Note = ReportInput['file_notes'][number]
type HunkNote = Note['hunks'][number]
type PerFile = DiffStats['perFile']
/** 正在對哪裡留言：新檔行號，或整個檔案 */
type Commenting = number | 'file'

const EMPTY_NOTES: HunkNote[] = []

/**
 * 段落說明（行號是新檔的）放在範圍內第一個顯示出來的行之前（鍵為 `段落:行`）；
 * 範圍內沒有任何顯示出來的行（例如只刪除、或 Claude 給的行號不在 diff 裡）就列在檔案說明下方。
 */
function placeHunkNotes(file: DiffFile, notes: HunkNote[]) {
  const before = new Map<string, HunkNote[]>()
  const placed = new Set<HunkNote>()
  file.hunks.forEach((h, hi) =>
    h.lines.forEach((l, li) => {
      if (l.newNo === undefined) return
      for (const n of notes) {
        if (placed.has(n) || l.newNo < n.line_start || l.newNo > n.line_end) continue
        placed.add(n)
        const key = `${hi}:${li}`
        before.set(key, [...(before.get(key) ?? []), n])
      }
    })
  )
  return { before, rest: notes.filter((n) => !placed.has(n)) }
}

/** 檔案標籤上的增刪行數；二進位檔（都是 0）不顯示 */
const statText = (s?: PerFile[number]) =>
  s && (s.additions || s.deletions)
    ? ` +${s.additions}${s.deletions ? ` −${s.deletions}` : ''}`
    : ''

const STATUS_LABEL: Partial<Record<DiffFile['status'], string>> = {
  added: '新增',
  deleted: '刪除',
  renamed: '改名'
}

/** 一個段落的行。memo：打開某一行的留言時，其他段落不重新 render */
const HunkRows = memo(function HunkRows({
  path,
  hunk,
  hunkIndex,
  limit,
  notesBefore,
  feedback,
  commenting,
  isStatic,
  interactive,
  onOpen,
  onSubmit,
  onCancel
}: {
  path: string
  hunk: DiffHunk
  hunkIndex: number
  /** 只畫前幾行（截斷顯示時） */
  limit: number
  notesBefore: Map<string, HunkNote[]>
  /** 待送出的回饋，以錨點為鍵；唯讀時沒有 */
  feedback?: Map<string, string>
  /** 正在留言的行（只有在這個段落裡時才給） */
  commenting?: number
  isStatic?: boolean
  interactive: boolean
  onOpen: (line: number) => void
  onSubmit: (line: number, text: string) => void
  onCancel: () => void
}) {
  return (
    <div>
      <div className="px-3 whitespace-pre text-code-line">{hunk.header}</div>
      {hunk.lines.slice(0, limit).map((l, li) => {
        const n = l.newNo
        const anchor = n !== undefined ? diffAnchor(path, n) : undefined
        const fb = anchor ? feedback?.get(anchor) : undefined
        return (
          <div key={li} data-anchor={isStatic ? undefined : anchor}>
            {notesBefore.get(`${hunkIndex}:${li}`)?.map((x, i) => (
              <div
                key={i}
                className="mx-3 my-1 rounded-lg bg-brand-deep px-3 py-1.5 font-sans text-xs leading-relaxed text-brand-soft"
              >
                <span className="font-medium">
                  為什麼（第 {x.line_start}–{x.line_end} 行）：
                </span>
                <InlineCode text={x.why} />
              </div>
            ))}
            <div
              className={cx(
                'grid grid-cols-[52px_minmax(0,1fr)]',
                l.type === 'add' && 'bg-diff-add/14',
                l.type === 'del' && 'bg-diff-del/16',
                fb !== undefined && 'bg-diff-flag/22 shadow-[inset_3px_0_0_var(--color-diff-flag)]'
              )}
            >
              {n !== undefined && interactive ? (
                <button
                  type="button"
                  data-line
                  aria-label={`對第 ${n} 行留言`}
                  onClick={() => onOpen(n)}
                  className="cursor-pointer pr-3 text-right text-code-line hover:text-white"
                >
                  {n}
                </button>
              ) : (
                // 刪除的行沒有新檔行號：顯示舊檔行號，顏色淡一點
                <span
                  data-line
                  className={cx(
                    'pr-3 text-right select-none',
                    n === undefined ? 'text-code-line/60' : 'text-code-line'
                  )}
                >
                  {n ?? l.oldNo}
                </span>
              )}
              <span className="whitespace-pre">
                {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
                {l.text}
              </span>
            </div>
            {n !== undefined && commenting === n ? (
              <CommentForm
                dark
                initial={fb}
                placeholder="這一行要怎麼改？"
                onSubmit={(text) => onSubmit(n, text)}
                onCancel={onCancel}
                className="my-1.5 mr-3 ml-[52px]"
              />
            ) : (
              fb !== undefined && (
                <FeedbackNote
                  title={`回饋 · 第 ${n} 行`}
                  text={fb}
                  className="my-1.5 mr-3 ml-[52px]"
                />
              )
            )}
          </div>
        )
      })}
    </div>
  )
})

const notice = (text: string) => (
  <div className="rounded-xl bg-fill-2 px-3.5 py-3 text-[13px] text-muted">{text}</div>
)

/**
 * 一個檔案的 diff：檔頭（狀態、改名、對整個檔案留言）、檔案說明、段落說明、每一行。
 * memo：報告其他地方的狀態（例如區塊留言）改變時不重新 render 整個 diff。
 * 很長的檔案先只畫前 TRUNCATED_LINES 行；匯出時太長的檔案與鎖定檔只放摘要。
 */
const FileDiff = memo(function FileDiff({
  taskId,
  file,
  note,
  stats,
  readOnly,
  isStatic,
  focusLine
}: {
  taskId: string
  file: DiffFile
  note?: Note
  stats?: PerFile[number]
  readOnly?: boolean
  isStatic?: boolean
  /** 要捲到的行（從回饋清單跳過來）：在截斷的範圍外時自動展開 */
  focusLine?: number
}) {
  const items = useStore((s) => s.feedback[taskId])
  const addFeedback = useStore((s) => s.addFeedback)
  const [commenting, setCommenting] = useState<Commenting>()
  const [expanded, setExpanded] = useState(false)
  const interactive = !readOnly && !isStatic
  const { before, rest } = useMemo(
    () => placeHunkNotes(file, note?.hunks ?? EMPTY_NOTES),
    [file, note]
  )
  // 唯讀（舊版本、回看、匯出）不顯示待送出的回饋：那些是針對最新版本留的
  const feedback = useMemo(
    () => (interactive ? new Map(items?.map((f) => [f.anchor, f.text])) : undefined),
    [items, interactive]
  )
  const total = useMemo(() => lineCount(file), [file])
  const path = file.path

  const openLine = useCallback((line: number) => setCommenting(line), [])
  const cancel = useCallback(() => setCommenting(undefined), [])
  const submitLine = useCallback(
    (line: number, text: string) => {
      addFeedback(taskId, { anchor: diffAnchor(path, line), label: `${path}:${line}`, text })
      setCommenting(undefined)
    },
    [addFeedback, taskId, path]
  )

  const truncated = !isStatic && total > TRUNCATE_OVER
  const showAll =
    !truncated ||
    expanded ||
    (focusLine !== undefined && focusIndex(file, focusLine) >= TRUNCATED_LINES)
  const summarized = isStatic && (isLockfile(path) || total > EXPORT_OVER)
  const fileFeedback = feedback?.get(fileAnchor(path))
  const limits = hunkLimits(file, showAll ? Infinity : TRUNCATED_LINES)

  return (
    <div className="flex flex-col gap-3.5">
      <div data-anchor={isStatic ? undefined : fileAnchor(path)} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {/* 匯出時沒有檔案標籤，檔名用標題 */}
          {isStatic ? (
            <h3 className="m-0 font-mono text-[13px] font-medium">
              {path}
              <span className="font-normal text-muted">{statText(stats)}</span>
            </h3>
          ) : (
            <span className="font-mono text-[13px] font-medium">{path}</span>
          )}
          {STATUS_LABEL[file.status] && <Pill tone="muted">{STATUS_LABEL[file.status]}</Pill>}
          {file.status === 'renamed' && file.oldPath && (
            <span className="text-xs text-muted">
              從 <code>{file.oldPath}</code> 改名
            </span>
          )}
          {interactive && (
            <CommentButton
              text="對此檔案留言"
              onClick={() => setCommenting('file')}
              className="ml-auto"
            />
          )}
        </div>
        {commenting === 'file' ? (
          <CommentForm
            initial={fileFeedback}
            placeholder={`對 ${path} 整個檔案的回饋…`}
            onSubmit={(text) => {
              addFeedback(taskId, { anchor: fileAnchor(path), label: path, text })
              setCommenting(undefined)
            }}
            onCancel={cancel}
          />
        ) : (
          fileFeedback !== undefined && <FeedbackNote title="回饋 · 整個檔案" text={fileFeedback} />
        )}
      </div>
      {(note || rest.length > 0) && (
        <div className="flex flex-col gap-1 rounded-xl bg-brand-tint px-3.5 py-3 text-[13px] text-brand-deep">
          {note && (
            <div>
              <span className="font-bold">為什麼：</span>
              <InlineCode text={note.why} />
            </div>
          )}
          {rest.map((n, i) => (
            <div key={i}>
              <span className="font-medium">
                第 {n.line_start}–{n.line_end} 行：
              </span>
              <InlineCode text={n.why} />
            </div>
          ))}
        </div>
      )}
      {file.binary ? (
        notice('二進位檔案，不顯示內容')
      ) : file.hunks.length === 0 ? (
        notice(
          file.status === 'added'
            ? '新增的空白檔案'
            : file.status === 'deleted'
              ? '刪除的空白檔案'
              : '只有檔名或權限變更'
        )
      ) : summarized ? (
        notice(`此檔案變更 ${total} 行，未包含在匯出中`)
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl bg-code py-1.5 font-mono text-[12.5px] leading-[1.8] text-code-ink">
            {file.hunks.map((h, hi) => {
              const limit = limits[hi]
              if (limit === 0) return null
              const here =
                typeof commenting === 'number' && h.lines.some((l) => l.newNo === commenting)
                  ? commenting
                  : undefined
              return (
                <HunkRows
                  key={hi}
                  path={path}
                  hunk={h}
                  hunkIndex={hi}
                  limit={limit}
                  notesBefore={before}
                  feedback={feedback}
                  commenting={here}
                  isStatic={isStatic}
                  interactive={interactive}
                  onOpen={openLine}
                  onSubmit={submitLine}
                  onCancel={cancel}
                />
              )
            })}
          </div>
          {!showAll && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="cursor-pointer self-start rounded-lg bg-fill px-3 py-1.5 text-xs text-ink-2 hover:bg-chip"
            >
              顯示全部（共 {total} 行）
            </button>
          )}
        </>
      )}
    </div>
  )
})

/** 截斷顯示時每個段落畫幾行：從頭開始一共畫 max 行 */
function hunkLimits(file: DiffFile, max: number): number[] {
  let remaining = max
  return file.hunks.map((h) => {
    const n = Math.min(h.lines.length, remaining)
    remaining -= n
    return n
  })
}

/** 某個新檔行號在檔案 diff 裡是第幾行（找不到時回傳 -1） */
function focusIndex(file: DiffFile, line: number): number {
  let i = 0
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.newNo === line) return i
      i++
    }
  }
  return -1
}

/**
 * 程式碼變更：上方是檔案標籤，下方是選取檔案的 diff。選取的檔案由外部控制（selected／onSelect），
 * 沒有選或選的檔案不在 diff 裡時，預設第一個不是自動產生的檔案。
 * isStatic（匯出 HTML）時沒有 script 可以切換，依序列出所有檔案。
 */
export function DiffView({
  taskId,
  diff,
  perFile,
  notes,
  selected,
  focusLine,
  onSelect,
  readOnly,
  isStatic
}: {
  taskId: string
  diff: string
  perFile: PerFile
  notes: Note[]
  selected?: string
  /** 選取檔案裡要捲到的行（從回饋清單跳過來） */
  focusLine?: number
  onSelect?: (path: string) => void
  readOnly?: boolean
  isStatic?: boolean
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  const file = files.find((f) => f.path === selected) ?? defaultFile(files)
  const statsOf = (path: string) => perFile.find((p) => p.path === path)
  const noteOf = (path: string) => notes.find((n) => n.path === path)

  if (!file) return <span className="text-[13px] text-muted">沒有程式碼變更</span>
  if (isStatic)
    return (
      <div className="flex flex-col gap-7">
        {files.map((f) => (
          <FileDiff
            key={f.path}
            taskId={taskId}
            file={f}
            note={noteOf(f.path)}
            stats={statsOf(f.path)}
            readOnly
            isStatic
          />
        ))}
      </div>
    )
  return (
    <div className="flex flex-col gap-3.5">
      <div role="group" aria-label="變更的檔案" className="flex flex-wrap gap-1.5 text-xs">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            aria-pressed={f.path === file.path}
            onClick={() => onSelect?.(f.path)}
            className={cx(
              'cursor-pointer rounded-full px-3 py-1.5 font-mono',
              f.path === file.path ? 'bg-ink text-white' : 'bg-fill hover:bg-chip'
            )}
          >
            {f.path}
            {statText(statsOf(f.path))}
          </button>
        ))}
      </div>
      {/* key：換檔案時關掉正在輸入的留言、收起展開的長檔案 */}
      <FileDiff
        key={file.path}
        taskId={taskId}
        file={file}
        note={noteOf(file.path)}
        readOnly={readOnly}
        focusLine={file.path === selected ? focusLine : undefined}
      />
    </div>
  )
}
```

**Step 7: ReportView.tsx**（對照 `B5-Report.dc.html`；`isStatic` 給匯出用，不含互動控制）

```tsx
// src/renderer/src/report/ReportView.tsx
// 對照 docs/design/B5-Report.dc.html 的 <main>；isStatic 給匯出 HTML 用，不含任何互動控制
import { type ReactNode, useState } from 'react'
import { layoutGraph } from '@shared/layout'
import { wrapBlockHtml } from '@shared/blockHtml'
import type { ReportInput } from '@shared/report'
import type { Report, Task, VerificationResult } from '@shared/types'
import { InlineCode } from '../components/Markdown'
import { cx, Icons, Pill } from '../components/ui'
import { shortTime } from '../lib/format'
import { useStore } from '../store'
import { ArchitectureDiagram } from './ArchitectureDiagram'
import { BLOCK_DEFAULT_H } from './blocks'
import { CommentButton, CommentForm, FeedbackNote } from './comments'
import { CustomBlockFrame } from './CustomBlockFrame'
import { DiffView } from './DiffView'

type Decision = ReportInput['decisions'][number]
type Limitation = ReportInput['limitations'][number]

/** 報告的一個區塊（白底卡片）；data-anchor 讓回饋清單可以捲到這裡 */
function Section({
  id,
  anchor,
  title,
  tag,
  end,
  subtitle,
  className,
  children
}: {
  id: string
  anchor?: string
  title: string
  /** 緊接在標題後面（例如「Claude 自訂視覺化」） */
  tag?: ReactNode
  /** 靠右（圖例、留言按鈕） */
  end?: ReactNode
  subtitle?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section
      id={`report-${id}`}
      data-anchor={anchor}
      aria-label={title}
      className={cx('flex flex-col gap-4 rounded-2xl bg-surface p-7 shadow-card', className)}
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="m-0 text-lg font-bold">{title}</h2>
          {tag}
          {end && <div className="ml-auto flex items-center gap-3">{end}</div>}
        </div>
        {subtitle && <span className="text-xs text-muted">{subtitle}</span>}
      </div>
      {children}
    </section>
  )
}

/** 某個錨點的留言：正在輸入時顯示輸入框，否則顯示已留下的意見（沒有就不顯示） */
function CommentSlot({
  taskId,
  anchor,
  label,
  open,
  onClose
}: {
  taskId: string
  anchor: string
  label: string
  open: boolean
  onClose: () => void
}) {
  const existing = useStore((s) => s.feedback[taskId]?.find((f) => f.anchor === anchor)?.text)
  const addFeedback = useStore((s) => s.addFeedback)
  if (open)
    return (
      <CommentForm
        initial={existing}
        placeholder={`對「${label}」的回饋…`}
        onSubmit={(text) => {
          addFeedback(taskId, { anchor, label, text })
          onClose()
        }}
        onCancel={onClose}
      />
    )
  return existing === undefined ? null : <FeedbackNote title="回饋" text={existing} />
}

function Stat({
  label,
  className,
  labelClass,
  children
}: {
  label: string
  className?: string
  labelClass?: string
  children: ReactNode
}) {
  return (
    <div className={cx('flex flex-col rounded-[14px] bg-fill-2 px-4 py-3.5', className)}>
      <span className={cx('text-xs text-muted', labelClass)}>{label}</span>
      <span className="text-2xl font-bold">{children}</span>
    </div>
  )
}

function DecisionSource({
  task,
  source,
  onOpenQuestion
}: {
  task: Task
  source: Decision['source']
  onOpenQuestion?: () => void
}) {
  if (source.type === 'branch') return <Pill tone="decision">來自分岔</Pill>
  if (source.type === 'implementation') return <Pill tone="muted">實作中決定</Pill>
  const i = task.questions.findIndex((q) => q.id === source.ref)
  const label = i >= 0 ? `問題 ${i + 1}` : '問題'
  // 點了打開釐清階段（回看當時的問答）
  return onOpenQuestion ? (
    <button
      type="button"
      aria-label={`${label}（查看釐清對話）`}
      onClick={onOpenQuestion}
      className="cursor-pointer"
    >
      <Pill className="hover:bg-chip">{label}</Pill>
    </button>
  ) : (
    <Pill>{label}</Pill>
  )
}

const SEVERITY: Record<Limitation['severity'], { box: string; body: string; tag: string }> = {
  high: { box: 'bg-danger-soft', body: 'text-ink-2', tag: 'text-danger' },
  medium: { box: 'bg-decision', body: 'text-decision-body', tag: 'text-decision-ink' },
  low: { box: 'bg-fill-2', body: 'text-muted', tag: 'text-muted' }
}
const SEVERITY_LABEL: Record<Limitation['severity'], string> = {
  high: '高風險',
  medium: '中風險',
  low: '低風險'
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`

function VerificationRow({ v }: { v: VerificationResult }) {
  const state = v.skipped ? 'skipped' : v.exitCode === 0 ? 'passed' : 'failed'
  const status = v.skipped
    ? v.skipped
    : v.exitCode === 0
      ? `通過 · ${seconds(v.durationMs)}`
      : v.exitCode === null
        ? `未完成 · ${seconds(v.durationMs)}`
        : `失敗（exit ${v.exitCode}）· ${seconds(v.durationMs)}`
  const row = (
    <>
      {state === 'passed' ? (
        <Icons.Check className="flex-none text-brand" strokeWidth={2.5} />
      ) : state === 'failed' ? (
        <Icons.X className="flex-none text-danger" strokeWidth={2.5} />
      ) : (
        <Icons.Minus className="flex-none text-muted" strokeWidth={2.5} />
      )}
      <code className="min-w-0 truncate bg-transparent p-0" title={v.command}>
        {v.command}
      </code>
      <span
        className={cx(
          'ml-auto min-w-0 text-right text-xs',
          state === 'passed' ? 'text-brand-ink' : state === 'failed' ? 'text-danger' : 'text-muted'
        )}
      >
        {status}
      </span>
    </>
  )
  const box = cx(
    'rounded-xl px-3.5 py-3',
    state === 'passed' ? 'bg-brand-tint' : state === 'failed' ? 'bg-danger-soft' : 'bg-fill-2'
  )
  if (!v.outputTail) return <div className={cx(box, 'flex items-center gap-3')}>{row}</div>
  // 失敗的輸出預設展開
  return (
    <details className={cx(box, 'group')} open={state === 'failed'}>
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        {row}
        <Icons.Chevron
          width={14}
          height={14}
          className="flex-none text-muted transition-transform group-open:rotate-90"
        />
      </summary>
      <pre className="mt-2.5 mb-0 max-h-64 overflow-auto rounded-lg bg-code p-3 font-mono text-xs whitespace-pre-wrap text-code-ink">
        {v.outputTail}
      </pre>
    </details>
  )
}

export function ReportView({
  task,
  report,
  isStatic,
  canComment,
  diffFile,
  diffLine,
  onDiffFile,
  onOpenQuestion
}: {
  task: Task
  report: Report
  /** 匯出 HTML：沒有按鈕、所有檔案的 diff 都列出來、自訂區塊用 srcdoc */
  isStatic?: boolean
  /** 可以留言（待審閱且正在看最新版本） */
  canComment?: boolean
  /** diff 選取的檔案與要捲到的行（由 ReportScreen 控制） */
  diffFile?: string
  diffLine?: number
  onDiffFile?: (path: string) => void
  onOpenQuestion?: () => void
}) {
  const r = report.input
  const [commentOn, setCommentOn] = useState<string>()
  const commentable = !isStatic && !!canComment
  // 匯出檔不需要回饋清單捲動用的錨點
  const anchorAttr = (anchor: string) => (isStatic ? undefined : anchor)
  // 前後兩張架構圖用同樣的比例縮放
  const fitWidth = Math.max(
    ...(['before', 'after'] as const).map(
      (side) => layoutGraph(r.architecture[side].nodes, r.architecture[side].edges).width
    )
  )
  const changed = new Set(report.stats.perFile.map((f) => f.path))
  const ran = report.verification.filter((v) => !v.skipped)
  const passed = ran.filter((v) => v.exitCode === 0).length
  const skipped = report.verification.length - ran.length
  const allPassed = ran.length > 0 && passed === ran.length

  const button = (anchor: string, label: string, aria = `對「${label}」留言`) =>
    commentable && <CommentButton label={aria} onClick={() => setCommentOn(anchor)} />
  const slot = (anchor: string, label: string) =>
    commentable && (
      <CommentSlot
        taskId={task.id}
        anchor={anchor}
        label={label}
        open={commentOn === anchor}
        onClose={() => setCommentOn(undefined)}
      />
    )
  const jumpToFile = (path: string) => {
    onDiffFile?.(path)
    document.getElementById('report-diff')?.scrollIntoView?.({ behavior: 'smooth' })
  }

  return (
    <div className="flex flex-col gap-3">
      <section
        id="report-overview"
        data-anchor={anchorAttr('section:overview')}
        aria-label="概觀"
        className="flex flex-col gap-[18px] rounded-2xl bg-surface p-7 shadow-card"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-brand">概觀</span>
            <span className="ml-auto">{button('section:overview', '概觀')}</span>
          </div>
          {slot('section:overview', '概觀')}
          <h1 className="m-0 text-[26px] leading-snug font-bold">{r.overview.headline}</h1>
          <span className="max-w-[720px] whitespace-pre-wrap text-ink-2">
            <InlineCode text={r.overview.summary} />
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
          <Stat label="變更檔案">{report.stats.files}</Stat>
          <Stat label="行數">
            <span className="text-ok">+{report.stats.additions}</span>{' '}
            <span className="text-lg text-danger">−{report.stats.deletions}</span>
          </Stat>
          <Stat
            label="驗證"
            className={ran.length === 0 ? '' : allPassed ? 'bg-brand-tint' : 'bg-danger-soft'}
            labelClass={allPassed ? 'text-brand-muted' : undefined}
          >
            <span className={allPassed ? 'text-brand-ink' : ran.length ? 'text-danger' : ''}>
              {ran.length ? `${passed} / ${ran.length} 通過` : '未執行'}
            </span>
            {skipped > 0 && (
              <span className="ml-1.5 text-xs font-normal text-muted">略過 {skipped}</span>
            )}
          </Stat>
          <Stat label="決策" className="bg-decision" labelClass="text-decision-ink">
            {r.decisions.length}
          </Stat>
        </div>
      </section>

      <Section
        id="arch"
        anchor={anchorAttr('section:architecture')}
        title="架構前後對照"
        end={
          <>
            <span className="flex gap-3 text-xs text-ink-2">
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-brand" />
                新增
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-surface shadow-[inset_0_0_0_2px_var(--color-review)]" />
                修改
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-3 rounded bg-line-soft" />
                未變
              </span>
            </span>
            {button('section:architecture', '架構前後對照')}
          </>
        }
      >
        {slot('section:architecture', '架構前後對照')}
        <div className="grid grid-cols-2 gap-4">
          {(['before', 'after'] as const).map((side) => (
            <div key={side} className="flex min-w-0 flex-col gap-3 rounded-2xl bg-fill-2 p-5">
              <span
                className={cx(
                  'text-[13px] font-bold',
                  side === 'after' ? 'text-brand' : 'text-muted'
                )}
              >
                {side === 'before' ? '之前' : '之後'}
              </span>
              <ArchitectureDiagram
                graph={r.architecture[side]}
                label={side === 'before' ? '之前的架構' : '之後的架構'}
                fitWidth={fitWidth}
                changedFiles={changed}
                onSelectFile={isStatic ? undefined : jumpToFile}
              />
            </div>
          ))}
        </div>
        {!isStatic && (
          <span className="text-[13px] text-muted">點有變更的方塊可以跳到對應的程式碼變更。</span>
        )}
      </Section>

      <Section id="decisions" title="決策與原因">
        {r.decisions.length === 0 ? (
          <span className="text-[13px] text-muted">沒有記錄的決策</span>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {r.decisions.map((d) => {
              const anchor = `decision:${d.id}`
              const label = `${d.id.toUpperCase()} ${d.title}`
              return (
                <div
                  key={d.id}
                  data-anchor={anchorAttr(anchor)}
                  className="flex min-w-0 flex-col gap-2 rounded-[14px] p-4 shadow-[0_0_0_1px_var(--color-chip)]"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted">{d.id.toUpperCase()}</span>
                    <span className="min-w-0 font-bold">
                      <InlineCode text={d.title} />
                    </span>
                    <span className="ml-auto flex flex-none items-center gap-1">
                      <DecisionSource
                        task={task}
                        source={d.source}
                        onOpenQuestion={isStatic ? undefined : onOpenQuestion}
                      />
                      {button(anchor, label, `對決策 ${d.id.toUpperCase()} 留言`)}
                    </span>
                  </div>
                  {d.chosen && (
                    <div className="text-[13px]">
                      <span className="mr-2 font-medium text-brand">選擇</span>
                      <InlineCode text={d.chosen} />
                    </div>
                  )}
                  {d.rejected.length > 0 && (
                    <div className="text-[13px] text-muted">
                      <span className="mr-2 font-medium">捨棄</span>
                      <InlineCode text={d.rejected.join('；')} />
                    </div>
                  )}
                  {d.rationale && (
                    <div className="rounded-[10px] bg-fill-2 px-3 py-2.5 text-[13px] text-ink-2">
                      <InlineCode text={d.rationale} />
                    </div>
                  )}
                  {slot(anchor, label)}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {r.custom_blocks.map((b) => (
        <Section
          key={b.id}
          id={`block-${b.id}`}
          anchor={anchorAttr(`block:${b.id}`)}
          title={b.title}
          tag={<Pill>Claude 自訂視覺化</Pill>}
          end={button(`block:${b.id}`, b.title)}
        >
          {slot(`block:${b.id}`, b.title)}
          {isStatic ? (
            // 匯出檔：同一份包裝（CSP 禁止連網、回報高度）放進 srcdoc，一樣只給 allow-scripts
            <iframe
              title={b.title}
              sandbox="allow-scripts"
              srcDoc={wrapBlockHtml(b)}
              data-block={b.id}
              className="block w-full rounded-2xl border-0 bg-fill-2"
              style={{ height: BLOCK_DEFAULT_H }}
            />
          ) : (
            // key：換版本時重新載入、高度重新計算
            <CustomBlockFrame
              key={`${report.version}:${b.id}`}
              taskId={task.id}
              version={report.version}
              id={b.id}
              title={b.title}
            />
          )}
        </Section>
      ))}

      <section
        id="report-limits"
        data-anchor={anchorAttr('section:limitations')}
        aria-label="限制與後續"
        className="flex flex-col gap-4 rounded-2xl bg-surface p-7 shadow-card"
      >
        {slot('section:limitations', '限制與後續')}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex items-center">
              <h2 className="m-0 text-lg font-bold">限制與風險</h2>
              <span className="ml-auto">{button('section:limitations', '限制與後續')}</span>
            </div>
            {r.limitations.length ? (
              r.limitations.map((l, i) => (
                <div
                  key={i}
                  className={cx('rounded-xl px-3.5 py-3 text-[13px]', SEVERITY[l.severity].box)}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">
                      <InlineCode text={l.title} />
                    </span>
                    <span className={cx('ml-auto flex-none text-xs', SEVERITY[l.severity].tag)}>
                      {SEVERITY_LABEL[l.severity]}
                    </span>
                  </div>
                  <span className={SEVERITY[l.severity].body}>
                    <InlineCode text={l.detail} />
                  </span>
                </div>
              ))
            ) : (
              <span className="text-[13px] text-muted">沒有已知的限制</span>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2.5">
            <h2 className="m-0 text-lg font-bold">後續工作</h2>
            {r.followups.length ? (
              r.followups.map((f, i) => (
                <div key={i} className="rounded-xl bg-fill-2 px-3.5 py-3 text-[13px]">
                  <InlineCode text={f.title} />
                  {f.detail && (
                    <span className="text-muted">
                      ：<InlineCode text={f.detail} />
                    </span>
                  )}
                </div>
              ))
            ) : (
              <span className="text-[13px] text-muted">沒有</span>
            )}
          </div>
        </div>
      </section>

      <Section
        id="diff"
        title="程式碼變更"
        tag={
          <span className="text-xs text-muted">
            每段變更都附上「為什麼改」{commentable && '；點行號可以留下回饋'}
          </span>
        }
      >
        <DiffView
          taskId={task.id}
          diff={report.diff}
          perFile={report.stats.perFile}
          notes={r.file_notes}
          selected={diffFile}
          focusLine={diffLine}
          onSelect={onDiffFile}
          readOnly={!commentable}
          isStatic={isStatic}
        />
      </Section>

      <Section
        id="tests"
        title="測試結果"
        subtitle="由 Harness 在 worktree 中實際執行，不是 Claude 的自述。"
      >
        <div className="flex flex-col gap-1.5 text-[13px]">
          {report.verification.length === 0 && (
            <span className="text-muted">Claude 沒有提供驗證指令</span>
          )}
          {report.verification.map((v, i) => (
            <VerificationRow key={i} v={v} />
          ))}
        </div>
      </Section>
    </div>
  )
}

/** 匯出檔最上方的標題（畫面上這些資訊在 ReportScreen 的標題列） */
export function ExportHeader({ task, report }: { task: Task; report: Report }) {
  return (
    <header className="mb-3 flex flex-col gap-1 rounded-2xl bg-surface px-7 py-[18px] shadow-card">
      <span className="text-lg font-bold">{task.title}</span>
      <span className="text-xs text-muted">
        變更報告 v{report.version} · {shortTime(report.createdAt)} · 分支 <code>{task.branch}</code>{' '}
        → <code>{task.baseBranch}</code>
        {report.commit && (
          <>
            {' '}
            · commit <code>{report.commit.slice(0, 7)}</code>
          </>
        )}
      </span>
    </header>
  )
}
```

**Step 8: FeedbackPanel.tsx**

```tsx
// src/renderer/src/report/FeedbackPanel.tsx
// 對照 docs/design/B5-Report.dc.html 的 <aside>：待送出的回饋、整體意見、收尾（PR／合併／丟棄）
import { useState } from 'react'
import type { Task } from '@shared/types'
import { call, errorText } from '../api'
import { Button, cx, Icons, textareaClass } from '../components/ui'
import { isBusy } from '../lib/stage'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { feedbackTitle } from './anchors'

export function FeedbackPanel({
  task,
  onJump
}: {
  task: Task
  /** 點回饋清單的項目：捲到報告上對應的位置 */
  onJump?: (anchor: string) => void
}) {
  const items = useStore((s) => s.feedback[task.id]) ?? []
  const removeFeedback = useStore((s) => s.removeFeedback)
  const act = useStore((s) => s.act)
  const showToast = useStore((s) => s.showToast)
  const [overall, setOverall] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // 已完成的任務清除過 worktree：任務本身沒有記錄，這次開著畫面時就不再顯示按鈕
  const [cleared, setCleared] = useState(false)
  // 收尾失敗的原因（例如合併衝突）留在面板上，不只是幾秒就消失的 toast
  const [failure, setFailure] = useState<{ title: string; text: string }>()
  // 送出回饋與收尾操作共用：其中一個進行中時全部停用（主程序也只允許一個收尾操作）
  const [pending, run] = usePending()
  const blocked = pending || isBusy(task)
  const reviewing = task.status === 'reviewing'
  const done = task.status === 'done'
  const latest = task.reportVersions.at(-1) ?? 0
  const unsent = items.length > 0 || !!overall.trim()

  const send = () =>
    run(async () => {
      const sent = items
      const note = overall.trim()
      const ok = await act(async () => {
        await call('report:feedback', task.id, sent, note || undefined)
        return true
      })
      if (!ok) return
      // 只清掉送出的那些（送出期間又改過的保留）
      const now = useStore.getState().feedback[task.id] ?? []
      for (const f of sent) {
        if (now.some((x) => x.anchor === f.anchor && x.text === f.text))
          removeFeedback(task.id, f.anchor)
      }
      setOverall((cur) => (cur.trim() === note ? '' : cur))
    })

  const finish = (title: string, fn: () => Promise<unknown>) =>
    run(async () => {
      setFailure(undefined)
      try {
        await fn()
      } catch (e) {
        setFailure({ title, text: errorText(e) })
      }
    })
  const openPr = () =>
    finish('開 PR 失敗', async () => {
      const url = await call('finish:pr', task.id)
      // PR 已經開了：瀏覽器打不開只提示，不算開 PR 失敗
      await act(() => call('shell:openExternal', url))
    })
  const merge = () => finish('合併失敗', () => call('finish:merge', task.id))
  const discard = () =>
    finish(done ? '清除 worktree 失敗' : '丟棄失敗', async () => {
      await call('finish:discard', task.id)
      setConfirmDiscard(false)
      if (done) {
        setCleared(true)
        showToast('已清除 worktree')
      }
    })

  return (
    <aside
      aria-label="回饋與收尾"
      className="flex max-h-full w-[300px] flex-none flex-col gap-3.5 self-start overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card"
    >
      {reviewing && (
        <>
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-bold">回饋</span>
            <span className="text-xs text-muted">{items.length} 則待送出</span>
          </div>
          <div className="flex flex-col gap-2 text-[13px]">
            {items.length === 0 && (
              <span className="text-muted">
                在報告的區塊、決策或程式碼行號上按「留言」，留下的意見會先列在這裡，一起送出。
              </span>
            )}
            {items.map((f) => (
              <div key={f.anchor} className="flex items-start gap-1 rounded-xl bg-note p-3">
                <button
                  type="button"
                  onClick={() => onJump?.(f.anchor)}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left text-ink"
                >
                  <span className="text-xs break-all text-note-ink">{feedbackTitle(f)}</span>
                  <span className="break-words whitespace-pre-wrap">{f.text}</span>
                </button>
                <button
                  type="button"
                  aria-label={`刪除對「${f.label}」的回饋`}
                  onClick={() => removeFeedback(task.id, f.anchor)}
                  className="-mt-0.5 -mr-1 flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-note-ink hover:bg-diff-flag/30"
                >
                  <Icons.X width={12} height={12} />
                </button>
              </div>
            ))}
          </div>
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">整體意見（選填）</span>
            <textarea
              rows={3}
              value={overall}
              onChange={(e) => setOverall(e.target.value)}
              placeholder="其他想調整的地方…"
              className={cx(textareaClass, 'resize-y')}
            />
          </label>
          <Button variant="primary" disabled={blocked || !unsent} onClick={() => void send()}>
            送出回饋，產生 v{latest + 1}
          </Button>
          <div className="h-px flex-none bg-line-soft" />
          <span className="text-[15px] font-bold">滿意了？</span>
          {unsent && (
            <span className="text-xs text-decision-ink">
              {items.length
                ? `還有 ${items.length} 則回饋${overall.trim() ? '與整體意見' : ''}沒送出`
                : '整體意見還沒送出'}
              ；開 PR 或合併不會送出。
            </span>
          )}
          <Button variant="dark" disabled={blocked} onClick={() => void openPr()}>
            開 Pull Request
          </Button>
          <Button className="text-ink" disabled={blocked} onClick={() => void merge()}>
            合併到 {task.baseBranch}
          </Button>
        </>
      )}

      {task.status === 'implementing' && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[15px] font-bold">修改中</span>
          <span className="text-muted">
            Claude 正在依回饋修改，完成後會產生 v{latest + 1}。這份報告只能看。
          </span>
        </div>
      )}

      {done && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[15px] font-bold">已完成</span>
          {task.prUrl ? (
            <button
              type="button"
              onClick={() => void act(() => call('shell:openExternal', task.prUrl!))}
              className="cursor-pointer self-start text-brand underline hover:text-brand-hover"
            >
              開啟 Pull Request
            </button>
          ) : (
            <span className="text-muted">已合併到 {task.baseBranch}。</span>
          )}
        </div>
      )}

      {task.status === 'discarded' && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[15px] font-bold">已丟棄</span>
          <span className="text-muted">worktree 與分支已刪除，報告仍然可以看與匯出。</span>
        </div>
      )}

      {task.status !== 'discarded' &&
        !(done && cleared) &&
        (confirmDiscard ? (
          <div className="flex flex-col gap-2.5 rounded-xl bg-danger-soft p-3 text-[13px]">
            <span className="text-danger">
              {done
                ? `確定要刪除 worktree 與本機分支 ${task.branch}？已開的 PR 或已合併的內容不受影響。`
                : `確定要丟棄？worktree 與分支 ${task.branch} 都會刪除，無法復原。`}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="bg-danger font-medium text-white hover:bg-danger/90"
                disabled={pending}
                onClick={() => void discard()}
              >
                {done ? '確定清除' : '確定丟棄'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="danger"
            className="h-10"
            disabled={pending}
            onClick={() => setConfirmDiscard(true)}
          >
            {done ? '清除 worktree' : '丟棄 worktree'}
          </Button>
        ))}

      {failure && (
        <div
          role="alert"
          className="flex max-h-60 flex-col gap-1 overflow-auto rounded-xl bg-danger-soft px-3 py-2.5 text-[13px]"
        >
          <span className="font-medium text-danger">{failure.title}</span>
          <span className="font-mono text-xs break-words whitespace-pre-wrap text-ink-2">
            {failure.text}
          </span>
        </div>
      )}
    </aside>
  )
}
```

**Step 9: exportHtml.tsx**

```tsx
// src/renderer/src/report/exportHtml.tsx
// 匯出單一自含的 HTML：靜態渲染 ReportView（React 會轉義所有報告文字）＋ 目前頁面的 CSS。
// react-dom/server 只有匯出時才用到：按下匯出才載入（獨立的 chunk）。
import type { Report, Task } from '@shared/types'
import { BLOCK_MAX_H, BLOCK_MIN_H } from './blocks'
import { ExportHeader, ReportView } from './ReportView'

/** 匯出檔不能連網；自訂區塊的 srcdoc 會繼承這份 CSP（再加上區塊自己的） */
export const EXPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

/** 匯出檔唯一的 script：依自訂區塊回報的高度調整 iframe（只認自己頁面上的 iframe） */
const RESIZE_SCRIPT = `addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="harness-block-height"||typeof d.height!=="number"||!isFinite(d.height))return;var f=document.querySelectorAll("iframe[data-block]");for(var i=0;i<f.length;i++){if(f[i].contentWindow===e.source&&f[i].getAttribute("data-block")===d.id)f[i].style.height=Math.min(Math.max(d.height,${BLOCK_MIN_H}),${BLOCK_MAX_H})+"px"}})`

/** 目前頁面的所有 CSS 規則；字型檔不打包（改用字型堆疊裡的系統字型） */
function collectCss(): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // 跨來源的樣式表讀不到，略過
    }
    for (const rule of Array.from(rules)) {
      if (rule.cssText.startsWith('@font-face')) continue
      out.push(rule.cssText)
    }
  }
  // 放在 <style> 裡：避免規則文字提早結束標籤
  return out.join('\n').replace(/<\/style/gi, '<\\/style')
}

/** 匯出檔名（不含 .html）的長度上限 */
const MAX_NAME = 80

/** 匯出檔名：去掉控制字元與不能用在檔名的字元，太長時截短標題 */
export function exportFileName(task: Task, version: number): string {
  const suffix = `-變更報告-v${version}`
  const cleaned = task.title
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  // 以字元（code point）截短，不會切開 emoji 等兩個 UTF-16 單位的字
  const room = MAX_NAME - Array.from(suffix).length
  const title = Array.from(cleaned).slice(0, room).join('').trim() || '任務'
  return `${title}${suffix}.html`
}

export async function buildReportHtml(task: Task, report: Report): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const body = renderToStaticMarkup(
    <>
      <ExportHeader task={task} report={report} />
      <ReportView task={task} report={report} isStatic />
    </>
  )
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(`${task.title} · 變更報告 v${report.version}`)}</title>
<style>${collectCss()}</style>
</head><body><div style="max-width:1100px;margin:0 auto;padding:24px">${body}</div>
<script>${RESIZE_SCRIPT}</script>
</body></html>`
}
```

**Step 10: ReportScreen.tsx**（版本選單與「匯出 HTML」在標題列，對照設計稿）

```tsx
// src/renderer/src/screens/ReportScreen.tsx
import { type ReactNode, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Report, Task } from '@shared/types'
import { call, errorText } from '../api'
import { Button, Spinner } from '../components/ui'
import { shortTime } from '../lib/format'
import { usePending } from '../lib/usePending'
import { anchorTarget } from '../report/anchors'
import { buildReportHtml, exportFileName } from '../report/exportHtml'
import { FeedbackPanel } from '../report/FeedbackPanel'
import { ReportView } from '../report/ReportView'
import { useStore } from '../store'

export function ReportScreen({
  task,
  nav,
  readOnly,
  onOpenStage
}: {
  task: Task
  nav: ReactNode
  /** 回看（依回饋修改中、已完成或已丟棄）：不能留言 */
  readOnly: boolean
  onOpenStage: (s: 'clarify') => void
}) {
  const act = useStore((s) => s.act)
  const showToast = useStore((s) => s.showToast)
  const latest = task.reportVersions.at(-1) ?? 0
  // 使用者選的版本只在「最新版本」沒變時有效；產生新版報告時自動切到最新版（不在 effect 裡 setState）
  const [picked, setPicked] = useState<{ latest: number; version: number }>()
  const version = picked?.latest === latest ? picked.version : latest
  // 報告產生後不會再變：讀過的版本留著，切回來不必重讀
  const [reports, setReports] = useState<Record<number, Report>>({})
  // 讀取失敗的原因，以版本為鍵；換到某個版本（或按重試）時清掉它的錯誤，就會重新讀取
  const [errors, setErrors] = useState<Record<number, string>>({})
  // diff 選取的檔案與要捲到的行：唯一的來源，只對選它時的版本有效
  const [diffFocus, setDiffFocus] = useState<{ version: number; path: string; line?: number }>()
  const [exporting, runExport] = usePending()
  const report = reports[version]
  const has = !!report
  const loadError = errors[version]
  const failed = loadError !== undefined

  useEffect(() => {
    if (!version || has || failed) return
    // 結果以版本為鍵存放：途中換了版本也不會放錯地方
    void (async () => {
      try {
        const r = await call('report:get', task.id, version)
        setReports((m) => ({ ...m, [version]: r }))
      } catch (e) {
        setErrors((m) => ({ ...m, [version]: errorText(e) }))
      }
    })()
  }, [task.id, version, has, failed])

  const clearError = (v: number) =>
    setErrors((m) => {
      if (!(v in m)) return m
      const rest = { ...m }
      delete rest[v]
      return rest
    })
  /** 換到某個版本（undefined：最新版）；之前讀取失敗的話重新讀取 */
  const goTo = (v?: number) => {
    clearError(v ?? latest)
    setPicked(v === undefined ? undefined : { latest, version: v })
  }

  const viewingOld = version !== latest
  const canComment = !readOnly && task.status === 'reviewing' && !viewingOld

  const exportHtml = () =>
    report &&
    runExport(() =>
      act(async () => {
        const html = await buildReportHtml(task, report)
        const path = await call('report:saveHtml', exportFileName(task, report.version), html)
        if (path) showToast(`已匯出：${path}`)
      })
    )

  /** 回饋都是對最新版本留的：切回最新版、選到那個檔案（與行），再捲到留言的位置 */
  const jump = (anchor: string) => {
    flushSync(() => {
      if (viewingOld) goTo()
      const target = anchorTarget(anchor)
      if (target) setDiffFocus({ version: latest, ...target })
    })
    const el = [...document.querySelectorAll<HTMLElement>('[data-anchor]')].find(
      (e) => e.dataset.anchor === anchor
    )
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex flex-col gap-2 rounded-2xl bg-surface px-7 py-[18px] shadow-card">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-lg font-bold">{task.title}</span>
            {nav}
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                版本
                <select
                  value={version}
                  onChange={(e) => goTo(Number(e.target.value))}
                  className="h-[34px] cursor-pointer rounded-[10px] border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-brand"
                >
                  {task.reportVersions.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                      {reports[v] && ` · ${shortTime(reports[v].createdAt)}`}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                className="h-[34px]"
                disabled={!report || exporting}
                onClick={() => void exportHtml()}
              >
                匯出 HTML
              </Button>
            </div>
          </div>
          {viewingOld && (
            <div className="text-xs text-muted">
              正在看 v{version}（舊版本），只能看；留言請到最新的 v{latest}。{' '}
              <button
                type="button"
                onClick={() => goTo()}
                className="cursor-pointer text-brand hover:text-brand-hover"
              >
                回到 v{latest}
              </button>
            </div>
          )}
        </div>
        {report ? (
          <ReportView
            // key：換版本時重設正在輸入的留言等畫面狀態
            key={version}
            task={task}
            report={report}
            canComment={canComment}
            diffFile={diffFocus?.version === version ? diffFocus.path : undefined}
            diffLine={diffFocus?.version === version ? diffFocus.line : undefined}
            onDiffFile={(path) => setDiffFocus({ version, path })}
            onOpenQuestion={() => onOpenStage('clarify')}
          />
        ) : failed ? (
          <div className="flex items-center gap-3 rounded-2xl bg-surface p-7 text-[13px] shadow-card">
            <span className="text-danger">
              無法讀取報告 v{version}：{loadError}
            </span>
            <Button size="sm" onClick={() => clearError(version)}>
              重試
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-2xl bg-surface p-7 text-muted shadow-card">
            <Spinner />
            載入報告…
          </div>
        )}
      </div>
      <FeedbackPanel task={task} onJump={jump} />
    </>
  )
}
```

**Step 11: TaskScreen 完成切換**

TaskScreen 最終版：

```tsx
// src/renderer/src/screens/TaskScreen.tsx
import { useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'
import { ClarifyScreen } from './ClarifyScreen'
import { ImplementScreen } from './ImplementScreen'
import { ReportScreen } from './ReportScreen'
import { SpecScreen } from './SpecScreen'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  // 使用者回看的階段，只對選它時的任務與狀態有效；換任務或狀態前進就回到目前階段
  const [picked, setPicked] = useState<{ key: string; stage: Stage } | null>(null)
  if (!task) return null
  const key = `${taskId}:${task.status}`
  const current = currentStage(task)
  const shown = picked?.key === key ? picked.stage : current
  const openStage = (s: Stage) => setPicked(s === current ? null : { key, stage: s })
  const nav = <StageNav task={task} shown={shown} onSelect={openStage} />
  // 已丟棄的任務停在哪個階段都只能看
  const ended = task.status === 'discarded' || task.status === 'done'
  const readOnly = ended || shown !== current
  switch (shown) {
    case 'clarify':
      return <ClarifyScreen task={task} nav={nav} readOnly={readOnly} onOpenStage={openStage} />
    case 'spec':
      return <SpecScreen task={task} nav={nav} readOnly={readOnly} onOpenStage={openStage} />
    case 'implement':
      return <ImplementScreen task={task} nav={nav} readOnly={readOnly} />
    case 'report':
      // 依回饋修改中（implementing）回看報告時只能看；送出回饋只在待審閱時
      return <ReportScreen task={task} nav={nav} readOnly={readOnly} onOpenStage={openStage} />
  }
}
```

**Step 12: 確認通過** — `npm test` 全部通過；`npm run typecheck`、`npm run lint` PASS

**Step 13: Commit**

```bash
git add src/shared/blockHtml.ts src/main/report/blockHtml.ts tests/main/blockHtml.test.ts
git commit -m "refactor: share the custom block wrapper and size blocks by their content

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add src/renderer/src/styles/app.css src/renderer/src/components/ui.tsx src/renderer/src/report/{anchors.ts,blocks.ts,comments.tsx,diffFiles.ts,ArchitectureDiagram.tsx,CustomBlockFrame.tsx,DiffView.tsx} tests/fixtures/report.ts tests/renderer/{DiffView,ArchitectureDiagram,CustomBlockFrame}.test.tsx
git commit -m "feat(ui): add architecture diagram, custom block frame and commentable diff view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add src/renderer/src docs/plans tests/renderer src/main/agent/prompts.ts tests/main/prompts.test.ts
git commit -m "feat(ui): add change report screen with feedback, finish actions and HTML export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 34：設定畫面

**Files:**
- Create: `src/shared/commandPattern.ts`（`normalizeCommand`、`hasShellOperators` 從 Task 12 的 `src/main/permissions/commandPattern.ts` 移過來：權限判斷與設定頁的輸入檢查用同一份）
- Modify: `src/main/permissions/commandPattern.ts`（改用共用的版本，`hasShellOperators` 照樣 re-export，gate／taskManager 不用改）
- Modify（主程序，完整程式碼已併入各 Task）：`src/main/store/repository.ts`（Task 10：`updateSettings`、`cachedSettings`）、`src/main/claude/detect.ts`（Task 16：`createClaudeStatusCache`）、`src/main/tasks/taskManager.ts`（Task 21：`getAllowedPatterns` 讀即時設定）、`src/main/ipcGuards.ts`／`src/main/ipc.ts`／`src/main/index.ts`（Task 25：分支前綴規則、worktree 路徑正規化、依序寫入、只採用最新的偵測）；測試見各 Task 的 `repository`／`detect`／`taskManager`／`ipcGuards` 測試
- Modify: `src/renderer/src/store.ts`（Task 26：`settingsReturn`，打開設定時記住原本的畫面）、`tests/renderer/store.test.ts`
- Create: `src/renderer/src/lib/allowedCommands.ts`
- Create: `src/renderer/src/screens/SettingsScreen.tsx`
- Modify: `src/renderer/src/App.tsx`（`view.kind === 'settings'` 時渲染，並隱藏 Sidebar）
- Modify: 輸入法保護（`lib/ime.ts` 在 Task 26 建立）：`Composer.tsx`、`BranchPanel.tsx`、`QuestionCard.tsx`、`SpecScreen.tsx`、`report/comments.tsx`、`PermissionDialog.tsx`（各 Task 的程式碼已更新），測試加在各自的測試檔
- Test: `tests/renderer/allowedCommands.test.ts`、`tests/renderer/SettingsScreen.test.tsx`、`tests/renderer/imeInputs.test.tsx`

**行為重點：**
- 版面對照 `docs/design/B6-Settings.dc.html`：設定頁自帶左欄（返回＋四個分類），所以 App 在設定頁不顯示 Sidebar。「返回」回到打開設定前的畫面（store 的 `settingsReturn`；那個任務已不存在時回到新任務）。
- 左欄的分類以 `aria-current="location"` 標示目前區塊：點分類時捲到該區（`scroll-mt-9`；偏好減少動態時不用平滑捲動）並把焦點移到區塊（鍵盤操作時顯示焦點框），以點的分類為準（最後幾區捲不到頂端）；使用者自己捲動（滾輪、觸控、鍵盤）或在內容區按下指標後改依捲動位置判斷，捲到底時是最後一區。
- 設定變更經由 `useSaveSettings` 排隊一次送一個（主程序的 `Repository.updateSettings` 也依序合併寫入）；回傳的完整設定寫回 store。
- 儲存中不讓控制項失去焦點：按鈕用 `aria-disabled`（外觀同停用）並忽略點擊；單選與勾選儲存中不停用（連點時每次都送，依序處理，畫面顯示最後點選的值）；文字欄位儲存中 `readOnly` ＋ `aria-busy`，按 Enter 直接儲存、焦點留在欄位。新增指令成功後焦點回到輸入框。
- 失焦（或 Enter）才儲存的文字欄位（claude 路徑、worktree 位置、分支前綴）：沒有修改就不送；儲存失敗時**保留使用者輸入的內容**，在欄位下方以 `role="alert"` 顯示主程序的錯誤（例如「worktree 位置必須是絕對路徑」「分支前綴不符合 git 分支名稱規則」），欄位標 `aria-invalid`，`aria-describedby` 同時指向錯誤與說明；Esc 還原成目前的設定值。輸入狀態存成 `draft`（`null` 代表顯示目前的設定值），不在 effect 裡同步。畫面已卸載（例如儲存途中離開設定頁）才失敗的儲存改用 toast。
- claude 路徑留空代表自動偵測（送空字串，主程序存成 undefined）；主程序在 `claudePath` 改變時已重新偵測，renderer 存好後只讀回 `claude:status`（不帶 refresh）。「重新檢查」才帶 `true` 重新偵測。還沒有偵測結果時以中性樣式顯示「正在檢查」。
- 單選（預設模型）與勾選（載入專案設定）點了就存，失敗時回到原值並以 toast 顯示錯誤。
- 權限區塊的前三列是固定規則（worktree 內讀寫自動允許、修改 `.git`／`.claude`／`.mcp.json` 需要核准、shell 指令需要核准），只顯示「固定」標籤，不是開關。移除允許的指令後，進行中的對話輪也立即適用（TaskManager 讀 `cachedSettings()`）。
- 永遠允許的指令：新增前先正規化空白；空白輸入時「新增」標示停用；和清單中的樣式相同（忽略空白差異）或含 `` ; & | ` < > $ `` 的樣式不能加入（後者永遠不會生效），錯誤以 `role="alert"` 顯示並保留輸入；已知危險的樣式（`rm *`、`rm -rf *`、`git push *`、`git diff *`、`git log *`、`curl *`、`sudo …`）說明原因、只有一個字加上 ` *`（例如 `npm *`）或 `*` 不在結尾時只提醒，都仍可加入。清單下方說明比對規則。清單以指令字串為 key（主程序存檔時去掉重複）。
- 分支前綴下方說明分支名稱的樣子（例如 `harness/20261008-1a2b3c4d`）。
- 輸入法安全（使用者用注音等輸入法打中文）：選字時按的 Enter 是確認候選字、Esc 是取消組字。所有「按 Enter 送出」的輸入框（設定頁的文字欄位與新增指令、Composer、分岔訊息、反問、修改意見、報告留言）遇到組字中的 Enter（`isComposing` 或 keyCode 229）都不送出、不儲存：靠表單隱式送出的輸入框在 onKeyDown 用 `blockImeSubmit` 取消預設動作；自己處理按鍵的（設定頁文字欄位、留言的 Esc、核准對話框拒絕原因的 Esc）先檢查 `isComposing`。只用 textarea 的輸入（需求、自由回答、補充說明、整體回饋、拒絕原因）Enter 本來就是換行，不會送出。
- 設計稿 worktree 位置旁的「選擇…」按鈕需要新的資料夾選擇 IPC，這個 Task 不做（直接輸入絕對路徑）。

**Step 1: 寫失敗測試**

```ts
// tests/renderer/allowedCommands.test.ts
import { describe, expect, test } from 'vitest'
import { checkNewPattern } from '@renderer/lib/allowedCommands'

const existing = ['git status', 'ls *']

describe('checkNewPattern', () => {
  test('去掉多餘空白；空白輸入沒有樣式', () => {
    expect(checkNewPattern('  npm   test  * ', existing)).toEqual({ pattern: 'npm test *' })
    expect(checkNewPattern('   ', existing)).toEqual({ pattern: '' })
  })

  test('和清單中的樣式相同（忽略空白差異）就不能加入', () => {
    expect(checkNewPattern('git   status', existing).error).toBe('「git status」已經在清單中')
    expect(checkNewPattern(' ls  * ', [' ls   * ']).error).toBe('「ls *」已經在清單中')
  })

  test.each(['npm test && rm -rf /', 'cat a | head', 'echo $HOME', 'ls > out', 'a; b'])(
    '含串接或重導符號的「%s」不能加入',
    (c) => expect(checkNewPattern(c, existing).error).toMatch('一律需要核准')
  )

  test.each(['npm *', 'git *', 'make *'])('只有一個字加上 * 的「%s」提醒範圍很廣', (c) => {
    const r = checkNewPattern(c, existing)
    expect(r.error).toBeUndefined()
    expect(r.warning).toBe(`「${c}」會允許所有 ${c.slice(0, -2)} 開頭的指令，範圍很廣`)
  })

  test.each([
    ['rm *', '刪除任何檔案'],
    ['rm -rf *', '刪除任何檔案'],
    ['git push *', '推送到遠端'],
    ['git diff *', '--output'],
    ['git log *', '--output'],
    ['curl *', '網路'],
    ['sudo *', '管理員權限'],
    ['sudo  npm   test *', '管理員權限']
  ])('已知危險的「%s」說明原因，仍可加入', (c, reason) => {
    const r = checkNewPattern(c, existing)
    expect(r.error).toBeUndefined()
    expect(r.warning).toContain(reason)
    expect(r.warning).toContain(`「${r.pattern}」`)
  })

  test('* 不在結尾時提醒會當成一般字元', () => {
    expect(checkNewPattern('npm run test:*', existing).warning).toMatch('其他位置的 *')
    expect(checkNewPattern('*', existing).warning).toMatch('其他位置的 *')
  })

  test('一般樣式沒有錯誤也沒有提醒', () => {
    expect(checkNewPattern('npm test *', existing)).toEqual({ pattern: 'npm test *' })
    expect(checkNewPattern('npm run lint', existing)).toEqual({ pattern: 'npm run lint' })
  })
})
```

```tsx
// tests/renderer/SettingsScreen.test.tsx
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
import type { Settings } from '@shared/types'
import { call } from '@renderer/api'
import App from '@renderer/App'
import { SettingsScreen } from '@renderer/screens/SettingsScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'
// 用主程序真正的檢查，錯誤訊息和實際 IPC 回傳的一樣
import { validateSettingsPatch } from '../../src/main/ipcGuards'

const initial: Settings = {
  defaultModel: 'claude-opus-5-5',
  worktreeRoot: '/Users/me/.harness/worktrees',
  branchPrefix: 'harness/',
  alwaysAllowedCommands: ['git status', 'git diff', 'ls *'],
  loadProjectSettings: true
}
let stored: Settings
let replies: Record<string, (...args: never[]) => unknown>

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const callsOf = (channel: string) => vi.mocked(call).mock.calls.filter(([ch]) => ch === channel)
const setCalls = () => callsOf('settings:set')
const saveFails = (message = '無法寫入設定檔') => {
  replies['settings:set'] = () => {
    throw new Error(message)
  }
}
/** settings:set 等到回傳的 gate 打開才回應；match 可只擋特定的 patch */
function holdSettingsSet(match: (patch: Partial<Settings>) => boolean = () => true) {
  const gate = deferred()
  const save = replies['settings:set']
  replies['settings:set'] = async (patch: never) => {
    if (match(patch)) await gate.promise
    return save(patch)
  }
  return gate
}

beforeEach(() => {
  stored = { ...initial }
  replies = {
    'settings:set': (patch: Partial<Settings>) => {
      stored = { ...stored, ...validateSettingsPatch(patch) }
      return stored
    },
    'settings:get': () => stored,
    'claude:status': () => useStore.getState().claude,
    'tasks:timeline': () => []
  }
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string, ...args: never[]) =>
    replies[ch](...args)) as typeof call)
  resetStoreInternals()
  useStore.setState({
    init: () => () => {},
    ready: true,
    repos: [],
    tasks: {},
    timelines: {},
    view: { kind: 'settings' },
    settingsReturn: undefined,
    toast: undefined,
    claude: {
      found: true,
      loggedIn: true,
      path: '/usr/local/bin/claude',
      version: '2.1.0 (Claude Code)',
      subscriptionType: 'max',
      email: 'me@example.com'
    },
    settings: initial
  })
})

const region = (name: string) => screen.getByRole('region', { name })
const addInput = () => screen.getByLabelText('新增指令')
const addButton = () => screen.getByRole('button', { name: '新增' })
const radio = (name: RegExp) => screen.getByRole('radio', { name })
const projectBox = () => screen.getByRole('checkbox', { name: /載入 repo 的 CLAUDE.md/ })

describe('SettingsScreen：Claude 帳號', () => {
  test('顯示登入狀態、路徑、版本與帳號；重新檢查會重新偵測', async () => {
    render(<SettingsScreen />)
    const account = region('Claude 帳號')
    expect(within(account).getByText('已透過 Claude Code 登入 · Max 方案')).toBeInTheDocument()
    expect(within(account).getByText('/usr/local/bin/claude')).toBeInTheDocument()
    expect(within(account).getByText('2.1.0 (Claude Code)')).toBeInTheDocument()
    expect(within(account).getByText('me@example.com')).toBeInTheDocument()

    replies['claude:status'] = () => ({
      found: true,
      loggedIn: false,
      error: '尚未登入，請在終端機執行 claude 並完成登入。'
    })
    await userEvent.click(within(account).getByRole('button', { name: '重新檢查' }))
    expect(call).toHaveBeenCalledWith('claude:status', true)
    const error = await within(account).findByText('尚未登入，請在終端機執行 claude 並完成登入。')
    expect(error).toHaveClass('text-danger')
  })

  test('重新檢查進行中：按鈕保留焦點、標示停用並忽略再次點擊', async () => {
    const gate = deferred()
    replies['claude:status'] = async () => {
      await gate.promise
      return useStore.getState().claude
    }
    render(<SettingsScreen />)
    const button = screen.getByRole('button', { name: '重新檢查' })
    await userEvent.click(button)
    expect(button).toHaveTextContent('檢查中…')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveFocus()
    await userEvent.click(button)
    expect(callsOf('claude:status')).toHaveLength(1)
    await act(async () => gate.resolve())
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'))
    expect(button).toHaveTextContent('重新檢查')
    expect(button).toHaveFocus()
  })

  test('還沒有偵測結果時以中性樣式顯示「正在檢查」', () => {
    useStore.setState({ claude: undefined })
    render(<SettingsScreen />)
    expect(screen.getByText('正在檢查 Claude Code…')).not.toHaveClass('text-danger')
  })

  test('claude 路徑失焦時儲存並讀回偵測結果；清空改回自動偵測', async () => {
    replies['claude:status'] = () => ({
      found: true,
      loggedIn: false,
      path: '/opt/claude',
      error: '無法讀取 Claude Code 狀態：spawn ENOENT'
    })
    render(<SettingsScreen />)
    const field = screen.getByLabelText('claude 執行檔路徑')
    await userEvent.type(field, ' /opt/claude ')
    await userEvent.tab()
    expect(call).toHaveBeenCalledWith('settings:set', { claudePath: '/opt/claude' })
    // 主程序在 settings:set 時已重新偵測，只讀回狀態、不再要求重新偵測
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('claude:status'))
    expect(await screen.findByText('無法讀取 Claude Code 狀態：spawn ENOENT')).toBeInTheDocument()
    expect(field).toHaveValue('/opt/claude')

    await userEvent.clear(field)
    await userEvent.tab()
    expect(call).toHaveBeenCalledWith('settings:set', { claudePath: '' })
    await waitFor(() => expect(useStore.getState().settings?.claudePath).toBeUndefined())
    expect(field).toHaveValue('')
  })
})

describe('SettingsScreen：模型與專案設定', () => {
  test('點選模型即儲存；儲存中選項不停用，焦點留在選項上', async () => {
    const gate = holdSettingsSet()
    render(<SettingsScreen />)
    expect(radio(/Opus 5.5/)).toBeChecked()
    await userEvent.click(radio(/Sonnet 5.5/))
    expect(call).toHaveBeenCalledWith('settings:set', { defaultModel: 'claude-sonnet-5-5' })
    // 儲存中先顯示新的選擇
    expect(radio(/Sonnet 5.5/)).toBeChecked()
    expect(radio(/Sonnet 5.5/)).toHaveFocus()
    expect(radio(/Opus 5.5/)).toBeEnabled()
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-busy', 'true')
    await act(async () => gate.resolve())
    await waitFor(() =>
      expect(useStore.getState().settings?.defaultModel).toBe('claude-sonnet-5-5')
    )
    expect(radio(/Sonnet 5.5/)).toBeChecked()
    expect(radio(/Sonnet 5.5/)).toHaveFocus()
    expect(screen.getByRole('radiogroup')).not.toHaveAttribute('aria-busy')
  })

  test('模型儲存失敗時回到原值並顯示 toast', async () => {
    saveFails()
    render(<SettingsScreen />)
    await userEvent.click(radio(/Sonnet 5.5/))
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))
    expect(radio(/Opus 5.5/)).toBeChecked()
    expect(radio(/Sonnet 5.5/)).toHaveFocus()
  })

  test('載入專案設定：勾選即儲存且保留焦點；失敗時回到原值並顯示 toast', async () => {
    render(<SettingsScreen />)
    const box = projectBox()
    expect(box).toBeChecked()
    await userEvent.click(box)
    expect(call).toHaveBeenCalledWith('settings:set', { loadProjectSettings: false })
    await waitFor(() => expect(box).not.toBeChecked())
    expect(box).toHaveFocus()

    saveFails()
    await userEvent.click(box)
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))
    expect(box).not.toBeChecked()
    expect(box).toHaveFocus()
  })

  test('設定變更依序送出：前一個完成前不送下一個', async () => {
    const gate = holdSettingsSet((patch) => 'defaultModel' in patch)
    render(<SettingsScreen />)
    await userEvent.click(radio(/Sonnet 5.5/))
    await userEvent.click(projectBox())
    expect(setCalls()).toHaveLength(1)
    await act(async () => gate.resolve())
    await waitFor(() => expect(setCalls()).toHaveLength(2))
    await waitFor(() =>
      expect(useStore.getState().settings).toMatchObject({
        defaultModel: 'claude-sonnet-5-5',
        loadProjectSettings: false
      })
    )
  })
})

describe('SettingsScreen：權限', () => {
  test('固定的權限規則只是說明，不是開關', () => {
    render(<SettingsScreen />)
    const perm = region('實作階段權限')
    expect(within(perm).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(perm).getAllByText('固定')).toHaveLength(3)
    expect(within(perm).getByText('worktree 內的檔案讀寫自動允許')).toBeInTheDocument()
    expect(within(perm).getByText('shell 指令需要核准')).toBeInTheDocument()
    expect(within(perm).getByText('.mcp.json')).toBeInTheDocument()
    // 清單下方說明樣式規則與串接指令
    expect(within(perm).getByText(/一律需要核准/)).toBeInTheDocument()
  })

  test('新增指令時正規化空白，成功後清空輸入且焦點回到輸入框', async () => {
    render(<SettingsScreen />)
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await userEvent.type(addInput(), '   ')
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(addButton())
    expect(setCalls()).toHaveLength(0)
    await userEvent.type(addInput(), 'npm   test *')
    expect(addButton()).not.toHaveAttribute('aria-disabled')
    await userEvent.click(addButton())
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff', 'ls *', 'npm test *']
    })
    await waitFor(() => expect(addInput()).toHaveValue(''))
    expect(addInput()).toHaveFocus()
    expect(screen.getByRole('button', { name: '移除 npm test *' })).toBeInTheDocument()

    // 用 Enter 新增時焦點本來就在輸入框
    await userEvent.type(addInput(), 'npm run lint{Enter}')
    await waitFor(() => expect(addInput()).toHaveValue(''))
    expect(addInput()).toHaveFocus()
    expect(screen.getByRole('button', { name: '移除 npm run lint' })).toBeInTheDocument()
  })

  test('重複或含串接符號的樣式不能加入，錯誤顯示在輸入框下方', async () => {
    render(<SettingsScreen />)
    await userEvent.type(addInput(), 'git  status{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('「git status」已經在清單中')
    expect(addInput()).toHaveAttribute('aria-invalid', 'true')
    expect(addInput()).toHaveValue('git  status')
    // 修改輸入時清掉錯誤
    await userEvent.clear(addInput())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.type(addInput(), 'npm test && rm -rf /{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('一律需要核准')
    expect(setCalls()).toHaveLength(0)
  })

  test('範圍很廣或已知危險的樣式只提醒，仍可加入', async () => {
    render(<SettingsScreen />)
    await userEvent.type(addInput(), 'git push *')
    expect(screen.getByText(/「git push \*」會允許把變更推送到遠端/)).toBeInTheDocument()
    await userEvent.clear(addInput())
    await userEvent.type(addInput(), 'npm *')
    expect(screen.getByText('「npm *」會允許所有 npm 開頭的指令，範圍很廣')).toBeInTheDocument()
    expect(addButton()).not.toHaveAttribute('aria-disabled')
    await userEvent.click(addButton())
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff', 'ls *', 'npm *']
    })
    await waitFor(() => expect(screen.queryByText(/範圍很廣/)).not.toBeInTheDocument())
  })

  test('新增時儲存失敗：顯示錯誤並保留輸入', async () => {
    saveFails()
    render(<SettingsScreen />)
    await userEvent.type(addInput(), 'npm test *{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('無法寫入設定檔')
    expect(addInput()).toHaveValue('npm test *')
    expect(addInput()).toHaveFocus()
    expect(useStore.getState().settings?.alwaysAllowedCommands).toEqual(
      initial.alwaysAllowedCommands
    )
  })

  test('移除指令；儲存中清單按鈕標示停用並忽略點擊，完成後焦點回到輸入框', async () => {
    const gate = holdSettingsSet()
    render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('button', { name: '移除 ls *' }))
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff']
    })
    const other = screen.getByRole('button', { name: '移除 git status' })
    expect(other).toHaveAttribute('aria-disabled', 'true')
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(other)
    expect(setCalls()).toHaveLength(1)
    await act(async () => gate.resolve())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '移除 ls *' })).not.toBeInTheDocument()
    )
    expect(other).not.toHaveAttribute('aria-disabled')
    expect(addInput()).toHaveFocus()
  })

  test('清單是空的時說明每個指令都會詢問', () => {
    useStore.setState({ settings: { ...initial, alwaysAllowedCommands: [] } })
    render(<SettingsScreen />)
    expect(screen.getByText('清單是空的，每個 shell 指令都會先詢問你。')).toBeInTheDocument()
  })
})

describe('SettingsScreen：Worktree 與分支', () => {
  test('相對路徑儲存失敗時保留輸入並顯示錯誤，修正後儲存', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('Worktree 存放位置')
    await userEvent.clear(field)
    await userEvent.type(field, 'worktrees')
    await userEvent.tab()
    expect(await screen.findByRole('alert')).toHaveTextContent('worktree 位置必須是絕對路徑')
    expect(field).toHaveValue('worktrees')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    // 錯誤與說明都在欄位的描述裡
    expect(field).toHaveAccessibleDescription(
      /worktree 位置必須是絕對路徑.*必須是絕對路徑。只影響之後建立的任務/
    )
    expect(useStore.getState().settings?.worktreeRoot).toBe('/Users/me/.harness/worktrees')

    await userEvent.clear(field)
    await userEvent.type(field, '/tmp/wt/{Enter}')
    // 主程序正規化路徑（去掉結尾的 /），欄位顯示正規化後的值
    await waitFor(() => expect(useStore.getState().settings?.worktreeRoot).toBe('/tmp/wt'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(field).toHaveValue('/tmp/wt')
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  test('Enter 直接儲存：儲存中欄位唯讀並標示忙碌，焦點留在欄位', async () => {
    const gate = holdSettingsSet()
    render(<SettingsScreen />)
    const field = screen.getByLabelText('Worktree 存放位置')
    await userEvent.clear(field)
    await userEvent.type(field, '/tmp/wt{Enter}')
    expect(setCalls()).toHaveLength(1)
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveAttribute('aria-busy', 'true')
    expect(field).toBeEnabled()
    await act(async () => gate.resolve())
    await waitFor(() => expect(field).not.toHaveAttribute('readonly'))
    expect(field).not.toHaveAttribute('aria-busy')
    expect(field).toHaveFocus()
    expect(useStore.getState().settings?.worktreeRoot).toBe('/tmp/wt')
    // 已儲存，之後失焦不再送出
    await userEvent.tab()
    expect(setCalls()).toHaveLength(1)
  })

  test('輸入法選字中的 Enter 與 Esc 不儲存、不還原；新增指令也不送出', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    await userEvent.clear(field)
    await userEvent.type(field, '功能/')
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    // 儲存是排隊後才送出：先讓排隊的工作跑完再檢查
    await act(async () => {})
    expect(setCalls()).toHaveLength(0)
    expect(field).toHaveValue('功能/')
    // 一般的 Esc 才還原（之後失焦不會儲存）
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveValue('harness/')

    await userEvent.type(addInput(), '測試')
    expect(fireEvent.keyDown(addInput(), { key: 'Enter', isComposing: true })).toBe(false)
    expect(fireEvent.keyDown(addInput(), { key: 'Enter', keyCode: 229 })).toBe(false)
    expect(setCalls()).toHaveLength(0)
    expect(addInput()).toHaveValue('測試')
  })

  test('Esc 還原成目前的設定值；沒有修改時失焦不儲存', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    await userEvent.click(field)
    await userEvent.tab()
    expect(setCalls()).toHaveLength(0)
    await userEvent.type(field, 'x{Escape}')
    expect(field).toHaveValue('harness/')
    await userEvent.tab()
    expect(setCalls()).toHaveLength(0)
  })

  test('分支前綴清空時保留空白輸入並顯示錯誤', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    await userEvent.clear(field)
    await userEvent.tab()
    expect(await screen.findByRole('alert')).toHaveTextContent('分支前綴必須是非空白的文字')
    expect(field).toHaveValue('')
    expect(useStore.getState().settings?.branchPrefix).toBe('harness/')
  })

  test('分支前綴不符合 git 分支名稱規則時顯示錯誤；說明顯示分支名稱的樣子', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    expect(field).toHaveAccessibleDescription(/例如 harness\/20261008-1a2b3c4d/)
    await userEvent.clear(field)
    await userEvent.type(field, 'my branch/{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('分支前綴不符合 git 分支名稱規則')
    expect(field).toHaveValue('my branch/')
    expect(useStore.getState().settings?.branchPrefix).toBe('harness/')
  })

  test('離開設定頁後才失敗的儲存改用 toast 告知', async () => {
    const failLater = () => {
      const gate = deferred()
      replies['settings:set'] = async () => {
        await gate.promise
        throw new Error('無法寫入設定檔')
      }
      return gate
    }
    let gate = failLater()
    const first = render(<SettingsScreen />)
    await userEvent.type(screen.getByLabelText('分支名稱前綴'), 'x{Enter}')
    first.unmount()
    await act(async () => gate.resolve())
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))

    useStore.setState({ toast: undefined })
    gate = failLater()
    const second = render(<SettingsScreen />)
    await userEvent.type(addInput(), 'npm test *{Enter}')
    second.unmount()
    await act(async () => gate.resolve())
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))
  })
})

describe('SettingsScreen：版面與導覽', () => {
  const navLink = (name: string) =>
    within(screen.getByRole('navigation', { name: '設定分類' })).getByRole('link', { name })
  const current = () =>
    within(screen.getByRole('navigation', { name: '設定分類' }))
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'location')
      .map((a) => a.textContent)

  /** jsdom 沒有版面：給捲動區與各區塊固定的位置，回傳「捲到某處並觸發 scroll」 */
  function mockLayout() {
    const main = screen.getByRole('main')
    let top = 0
    const offsets = { account: 0, model: 400, perm: 700, workspace: 1100 }
    Object.defineProperties(main, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1400 },
      scrollTop: { configurable: true, get: () => top, set: (v: number) => (top = v) }
    })
    main.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    for (const [id, offset] of Object.entries(offsets))
      document.getElementById(`settings-${id}`)!.getBoundingClientRect = () =>
        ({ top: offset - top }) as DOMRect
    return (to: number) => {
      top = to
      fireEvent.scroll(main)
    }
  }

  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView
    delete (window as Partial<Window>).matchMedia
  })

  test('設定頁取代側欄；左欄標示目前分類，返回回到新任務', async () => {
    render(<App />)
    expect(screen.queryByRole('navigation', { name: 'Repo 與任務' })).not.toBeInTheDocument()
    expect(navLink('Claude 帳號')).toHaveAttribute('aria-current', 'location')
    await userEvent.click(navLink('權限'))
    expect(current()).toEqual(['權限'])
    expect(region('實作階段權限')).toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
    expect(screen.getByRole('navigation', { name: 'Repo 與任務' })).toBeInTheDocument()
  })

  test('返回回到打開設定前的畫面；那個任務已不存在時回到新任務', async () => {
    useStore.setState({
      tasks: { a: makeTask({ id: 'a' }) },
      settingsReturn: { kind: 'task', taskId: 'a' }
    })
    const { unmount } = render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'a' })
    unmount()

    useStore.setState({
      view: { kind: 'settings' },
      settingsReturn: { kind: 'task', taskId: 'gone' }
    })
    render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
  })

  test('捲動時標示目前分類；捲到底時是最後一個', () => {
    render(<SettingsScreen />)
    const scrollTo = mockLayout()
    scrollTo(0)
    expect(current()).toEqual(['Claude 帳號'])
    scrollTo(250)
    expect(current()).toEqual(['模型'])
    scrollTo(520)
    expect(current()).toEqual(['權限'])
    scrollTo(800)
    expect(current()).toEqual(['Worktree 與專案設定'])
  })

  test('點左欄後以點的分類為準；捲動滑鼠或在內容區按下後改看捲動位置', async () => {
    render(<SettingsScreen />)
    const scrollTo = mockLayout()
    await userEvent.click(navLink('模型'))
    // 點選觸發的捲動（例如捲到底）不改變標示
    scrollTo(800)
    expect(current()).toEqual(['模型'])
    fireEvent.wheel(screen.getByRole('main'))
    expect(current()).toEqual(['Worktree 與專案設定'])

    await userEvent.click(navLink('權限'))
    expect(current()).toEqual(['權限'])
    fireEvent.pointerDown(screen.getByText('每個任務建立時也可以單獨選擇。'))
    expect(current()).toEqual(['Worktree 與專案設定'])
  })

  test('點左欄時平滑捲動；偏好減少動態時直接跳過去', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<SettingsScreen />)
    await userEvent.click(navLink('模型'))
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' })
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia
    await userEvent.click(navLink('權限'))
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'start' })
  })

  test('設定沒有載入時可以重新載入', async () => {
    useStore.setState({ settings: undefined })
    render(<SettingsScreen />)
    expect(screen.getByText(/無法載入設定/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重新載入' }))
    expect(call).toHaveBeenCalledWith('settings:get')
    expect(await screen.findByRole('region', { name: '模型' })).toBeInTheDocument()
  })
})
```

```tsx
// tests/renderer/imeInputs.test.tsx
// 使用者用注音等輸入法打中文：選字時按 Enter 是確認候選字，不能送出、儲存或關閉輸入框
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { Composer } from '@renderer/components/Composer'
import { CommentForm } from '@renderer/report/comments'

/** fireEvent 回傳 false 代表預設動作被取消（瀏覽器不會隱式送出表單） */
const composingEnter = (el: Element) => fireEvent.keyDown(el, { key: 'Enter', isComposing: true })
const enter229 = (el: Element) => fireEvent.keyDown(el, { key: 'Enter', keyCode: 229 })

describe('輸入法選字中的 Enter', () => {
  test('Composer：選字中的 Enter 不送出，選完再按 Enter 才送出', async () => {
    const onSend = vi.fn()
    render(<Composer placeholder="輸入訊息" onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '訊息' })
    await userEvent.type(input, '你好')
    expect(composingEnter(input)).toBe(false)
    expect(enter229(input)).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('你好')
    // 一般的 Enter 不取消預設動作，表單照常送出
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })).toBe(true)
    await userEvent.type(input, '{Enter}')
    expect(onSend).toHaveBeenCalledWith('你好')
  })

  test('留言輸入框：選字中的 Enter 不加入、Esc 不取消', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<CommentForm placeholder="寫下回饋" onSubmit={onSubmit} onCancel={onCancel} />)
    const input = screen.getByRole('textbox', { name: '回饋' })
    await userEvent.type(input, '這裡要改')
    expect(composingEnter(input)).toBe(false)
    expect(enter229(input)).toBe(false)
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    await userEvent.type(input, '{Enter}')
    expect(onSubmit).toHaveBeenCalledWith('這裡要改')
  })
})
```

主程序與 store 的測試見 Task 10／16／23／25／26 的測試區塊（`updateSettings`／`cachedSettings`、`createClaudeStatusCache`、執行中移除允許的指令、分支前綴與 worktree 路徑、`settingsReturn`）。

**Step 2: 確認失敗**

Run: `npx vitest run tests/renderer/allowedCommands.test.ts tests/renderer/SettingsScreen.test.tsx tests/renderer/imeInputs.test.tsx tests/renderer/store.test.ts tests/main/repository.test.ts tests/main/detect.test.ts tests/main/ipcGuards.test.ts tests/main/taskManager.test.ts` → FAIL

**Step 3: 共用的指令正規化與串接判斷**

```ts
// src/shared/commandPattern.ts
// 指令樣式的共用規則：主程序的權限判斷與設定頁的輸入檢查用同一份

/** 去掉前後空白並把連續空白合併成一個 */
export const normalizeCommand = (s: string) => s.trim().replace(/\s+/g, ' ')

/** 串接、重導、命令替換、變數展開或換行都視為需要人工核准 */
export function hasShellOperators(command: string): boolean {
  return /[;&|`<>$\n\r]/.test(command)
}
```

```ts
// src/main/permissions/commandPattern.ts
import { hasShellOperators, normalizeCommand as normalize } from '@shared/commandPattern'

export { hasShellOperators }

export function matchesPattern(command: string, pattern: string): boolean {
  const c = normalize(command)
  const p = normalize(pattern)
  if (!p) return false
  if (p.endsWith(' *')) {
    const prefix = p.slice(0, -2)
    return c === prefix || c.startsWith(`${prefix} `)
  }
  return c === p
}

export function suggestPattern(command: string): string {
  const parts = normalize(command).split(' ')
  return `${parts.slice(0, Math.min(2, parts.length)).join(' ')} *`
}
```

**Step 4: 主程序與 store** — 依 Task 10（`repository.ts`）、Task 16（`detect.ts`）、Task 21（`getAllowedPatterns`）、Task 25（`ipcGuards.ts`、`ipc.ts`、`index.ts`）、Task 26（`store.ts`）目前的程式碼修改。

**Step 5: lib/allowedCommands.ts**

```ts
// src/renderer/src/lib/allowedCommands.ts
// 設定頁「永遠允許的指令」新增前的檢查（比對規則見 src/main/permissions/commandPattern.ts）
import { hasShellOperators, normalizeCommand } from '@shared/commandPattern'

export interface PatternCheck {
  /** 正規化後要存的樣式；空字串代表還沒輸入 */
  pattern: string
  /** 不能加入的原因 */
  error?: string
  /** 可以加入，但要提醒使用者的事（已知危險、範圍很廣、* 不在結尾） */
  warning?: string
}

/** 已知會造成破壞或能寫到 worktree 以外的樣式：可以加入，但說明原因 */
const DANGEROUS: Record<string, string> = {
  'rm *': '會允許刪除任何檔案',
  'rm -rf *': '會允許遞迴刪除任何檔案',
  'git push *': '會允許把變更推送到遠端',
  'git diff *': '會允許 git diff 帶 --output，把結果寫到 worktree 以外的檔案',
  'git log *': '會允許 git log 帶 --output，把結果寫到 worktree 以外的檔案',
  'curl *': '會允許任意網路請求，也能下載或上傳檔案'
}

export function checkNewPattern(raw: string, existing: string[]): PatternCheck {
  const pattern = normalizeCommand(raw)
  if (!pattern) return { pattern }
  if (existing.some((c) => normalizeCommand(c) === pattern))
    return { pattern, error: `「${pattern}」已經在清單中` }
  // 含串接或重導的指令一律詢問，這種樣式永遠不會生效
  if (hasShellOperators(pattern))
    return { pattern, error: '含有 ; & | ` < > $ 的指令一律需要核准，加進清單也不會生效' }
  if (pattern.split(' ')[0] === 'sudo')
    return { pattern, warning: `「${pattern}」會允許以管理員權限執行指令，請確認真的需要` }
  if (DANGEROUS[pattern])
    return { pattern, warning: `「${pattern}」${DANGEROUS[pattern]}，請確認真的需要` }
  const wildcard = pattern.endsWith(' *')
  const prefix = wildcard ? pattern.slice(0, -2) : pattern
  if (prefix.includes('*'))
    return { pattern, warning: '只有結尾的「 *」代表任意參數，其他位置的 * 會當成一般字元比對' }
  if (wildcard && !prefix.includes(' '))
    return {
      pattern,
      warning: `「${pattern}」會允許所有 ${prefix} 開頭的指令，範圍很廣`
    }
  return { pattern }
}
```

**Step 6: SettingsScreen.tsx（對照 `docs/design/B6-Settings.dc.html`）**

```tsx
// src/renderer/src/screens/SettingsScreen.tsx
// 對照 docs/design/B6-Settings.dc.html
import {
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState
} from 'react'
import { type ClaudeStatus, MODELS, type Settings } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { call, errorText } from '../api'
import { Button, cx, Icons, inputClass, Pill } from '../components/ui'
import { checkNewPattern } from '../lib/allowedCommands'
import { blockImeSubmit, isComposing } from '../lib/ime'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'

type Save = (patch: Partial<Settings>) => Promise<Settings>

/**
 * 儲存中的按鈕用 aria-disabled 而不是 disabled：停用的按鈕會失去焦點，
 * 鍵盤使用者會被丟回頁首。外觀與停用相同，點擊由各按鈕自己忽略。
 */
const pendingLook = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50'
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

const SECTIONS = [
  { id: 'account', label: 'Claude 帳號' },
  { id: 'model', label: '模型' },
  { id: 'perm', label: '權限' },
  { id: 'workspace', label: 'Worktree 與專案設定' }
] as const
type SectionId = (typeof SECTIONS)[number]['id']
const sectionDomId = (id: SectionId) => `settings-${id}`
const sectionTitleId = (id: SectionId) => `settings-${id}-title`

/** 捲動位置對應的分類：區塊頂端進入上方三分之一就算目前分類；捲到底時是最後一個 */
function sectionInView(main: HTMLElement): SectionId {
  if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) return SECTIONS.at(-1)!.id
  const line = main.getBoundingClientRect().top + main.clientHeight / 3
  let current: SectionId = SECTIONS[0].id
  for (const s of SECTIONS) {
    const el = document.getElementById(sectionDomId(s.id))
    if (el && el.getBoundingClientRect().top <= line) current = s.id
  }
  return current
}

/**
 * 依序送出設定變更：主程序的 settings:set 是「讀取 → 合併 → 寫入」，
 * 兩個同時送出會讓後寫入的蓋掉先寫入的欄位，所以排隊一次送一個。
 * 成功時更新 store；失敗時把錯誤丟回呼叫端，由各欄位決定怎麼顯示。
 */
function useSaveSettings(): Save {
  const tail = useRef<Promise<unknown>>(Promise.resolve())
  return useCallback((patch: Partial<Settings>) => {
    const run = tail.current.then(async () => {
      const next = await call('settings:set', patch)
      useStore.setState({ settings: next })
      return next
    })
    tail.current = run.catch(() => undefined)
    return run
  }, [])
}

/**
 * 儲存失敗的回報：畫面還在時交給 onError 顯示在欄位旁；
 * 已經卸載（例如儲存途中離開設定頁）就改用 toast，錯誤才不會無聲消失。
 */
function useSaveErrorReporter(onError: (text: string) => void) {
  const mounted = useRef(false)
  const showToast = useStore((s) => s.showToast)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return (e: unknown) => {
    const text = errorText(e)
    if (mounted.current) onError(text)
    else showToast(text)
  }
}

/**
 * 點一下就生效的選項（單選、勾選）：儲存期間先顯示最後點選的值，失敗時回到原值並以 toast 顯示錯誤。
 * 儲存中不停用選項（停用會讓焦點消失）；連點時每次都送出，由 useSaveSettings 依序處理。
 */
function useInstantSetting<K extends keyof Settings>(key: K, saved: Settings[K], save: Save) {
  const act = useStore((s) => s.act)
  // 最後一次點選的值；它的儲存結束（且之後沒有再點）時清掉，改顯示 store 裡的設定
  const [latest, setLatest] = useState<{ value: Settings[K]; seq: number }>()
  const seq = useRef(0)
  const set = async (value: Settings[K]) => {
    const mine = ++seq.current
    setLatest({ value, seq: mine })
    await act(() => save({ [key]: value } as Partial<Settings>))
    setLatest((l) => (l?.seq === mine ? undefined : l))
  }
  return {
    value: latest ? latest.value : saved,
    saving: !!latest,
    set: (value: Settings[K]) => void set(value)
  }
}

/** 左欄分類對應的區塊；tabIndex 讓點左欄後焦點移到這裡 */
function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <section
      id={sectionDomId(id)}
      aria-labelledby={sectionTitleId(id)}
      tabIndex={-1}
      className="flex scroll-mt-9 flex-col gap-3 rounded-lg outline-none focus-visible:shadow-[0_0_0_6px_var(--color-surface),0_0_0_8px_var(--color-brand)]"
    >
      <h2 id={sectionTitleId(id)} className="m-0 text-[15px] font-bold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * 失焦或按 Enter 時儲存的文字設定。儲存失敗時保留輸入的內容並在下方顯示錯誤，
 * 按 Esc 還原成目前的設定值。儲存中欄位唯讀（不停用，按 Enter 儲存時焦點留在欄位）。
 */
function TextSetting({
  label,
  saved,
  onSave,
  placeholder,
  hint
}: {
  label: string
  saved: string
  onSave: (value: string) => Promise<unknown>
  placeholder?: string
  hint?: ReactNode
}) {
  // null：沒有未儲存的修改，顯示目前的設定值
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const [saving, run] = usePending()
  const report = useSaveErrorReporter(setError)
  const id = useId()
  const commit = async () => {
    if (draft === null) return
    const value = draft.trim()
    if (value === saved) {
      setDraft(null)
      setError(undefined)
      return
    }
    await run(async () => {
      try {
        await onSave(value)
        setDraft(null)
        setError(undefined)
      } catch (e) {
        report(e)
      }
    })
  }
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ')
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input
        id={id}
        value={draft ?? saved}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          // 輸入法選字中的 Enter／Esc 屬於組字，不儲存、不還原
          if (isComposing(e)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          } else if (e.key === 'Escape' && !saving) {
            setDraft(null)
            setError(undefined)
          }
        }}
        readOnly={saving}
        aria-busy={saving || undefined}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cx(
          inputClass,
          'h-10 rounded-[10px] px-3 font-mono text-xs aria-busy:bg-fill-2 aria-busy:text-muted',
          error && 'border-danger focus:border-danger'
        )}
      />
      {error && (
        <span id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      {hint && (
        <span id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      )}
    </div>
  )
}

/** 「Max」這類方案名稱首字大寫；沒有資料時顯示「訂閱方案」 */
const planLabel = (type?: string) =>
  type ? `${type.slice(0, 1).toUpperCase()}${type.slice(1)} 方案` : '訂閱方案'

function AccountSection({
  claude,
  claudePath,
  save
}: {
  claude?: ClaudeStatus
  claudePath: string
  save: Save
}) {
  const act = useStore((s) => s.act)
  const [checking, runCheck] = usePending()
  // 還沒有偵測結果時是「檢查中」，用中性樣式，不當成錯誤
  const state = !claude ? 'checking' : claude.loggedIn ? 'ok' : 'error'
  const recheck = () => {
    if (checking) return
    void runCheck(() =>
      act(async () => useStore.setState({ claude: await call('claude:status', true) }))
    )
  }
  // 主程序在 claudePath 改變時已重新偵測，這裡只需讀回最新狀態
  const saveClaudePath = async (value: string) => {
    await save({ claudePath: value })
    await act(async () => useStore.setState({ claude: await call('claude:status') }))
  }
  return (
    <Section id="account" title="Claude 帳號">
      <div
        className={cx(
          'flex flex-wrap items-center gap-3.5 rounded-[14px] p-4',
          { ok: 'bg-brand-tint', checking: 'bg-fill-2', error: 'bg-danger-soft' }[state]
        )}
      >
        <span
          aria-hidden
          className={cx(
            'size-2.5 flex-none rounded-full',
            { ok: 'bg-ok', checking: 'bg-muted-2', error: 'bg-danger' }[state]
          )}
        />
        <span role="status" className="flex min-w-0 flex-[1_1_240px] flex-col">
          <span className={cx('font-medium', state === 'error' && 'text-danger')}>
            {state === 'ok'
              ? `已透過 Claude Code 登入 · ${planLabel(claude?.subscriptionType)}`
              : (claude?.error ?? '正在檢查 Claude Code…')}
          </span>
          <span className={cx('text-xs', state === 'ok' ? 'text-brand-muted' : 'text-muted')}>
            使用本機 Claude Code 的登入憑證，不需要 API key
          </span>
        </span>
        <Button
          aria-disabled={checking || undefined}
          onClick={recheck}
          className={cx(
            'h-[38px] rounded-[10px] bg-surface px-3.5 text-ink hover:bg-fill',
            pendingLook
          )}
        >
          {checking ? '檢查中…' : '重新檢查'}
        </Button>
      </div>
      <dl className="m-0 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 px-1 text-[13px]">
        <dt className="text-muted">Claude Code</dt>
        <dd className="m-0 min-w-0">
          {claude?.path ? <code className="break-all">{claude.path}</code> : '—'}
        </dd>
        <dt className="text-muted">版本</dt>
        <dd className="m-0 font-mono text-xs">{claude?.version ?? '—'}</dd>
        {claude?.email && (
          <>
            <dt className="text-muted">帳號</dt>
            <dd className="m-0 min-w-0 break-all">{claude.email}</dd>
          </>
        )}
      </dl>
      <span className="text-xs text-muted">
        尚未登入時，會請你在終端機執行 <code>claude</code> 完成登入。
      </span>
      <TextSetting
        label="claude 執行檔路徑"
        saved={claudePath}
        onSave={saveClaudePath}
        placeholder="自動偵測"
        hint="留空時從登入 shell 的 PATH 尋找 claude。"
      />
    </Section>
  )
}

function ModelSection({ settings, save }: { settings: Settings; save: Save }) {
  const model = useInstantSetting('defaultModel', settings.defaultModel, save)
  return (
    <Section id="model" title="模型">
      <div
        role="radiogroup"
        aria-labelledby={sectionTitleId('model')}
        aria-busy={model.saving || undefined}
        className="grid grid-cols-2 gap-2.5"
      >
        {MODELS.map((m) => {
          const on = model.value === m.id
          return (
            <label
              key={m.id}
              className={cx(
                'flex cursor-pointer gap-2.5 rounded-[14px] p-3.5',
                on ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2'
              )}
            >
              <input
                type="radio"
                name="defaultModel"
                checked={on}
                onChange={() => model.set(m.id)}
                className="mt-[5px] accent-brand"
              />
              <span className="flex flex-col">
                <span className="font-medium">{m.label}</span>
                <span className={cx('text-xs', on ? 'text-brand-muted' : 'text-muted')}>
                  {m.hint}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      <span className="text-xs text-muted">每個任務建立時也可以單獨選擇。</span>
    </Section>
  )
}

/** 固定的權限規則：只說明，不能關閉 */
function FixedRule({ title, detail }: { title: ReactNode; detail: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3.5">
      <span className="flex flex-1 flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted">{detail}</span>
      </span>
      <Pill tone="brand" className="flex-none">
        固定
      </Pill>
    </div>
  )
}

function AllowedCommands({ list, save }: { list: string[]; save: Save }) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const [saving, run] = usePending()
  const report = useSaveErrorReporter(setError)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const check = checkNewPattern(input, list)
  const warning = !error && check.warning
  const canAdd = !saving && !!check.pattern

  const update = (next: string[]) =>
    run(async () => {
      try {
        await save({ alwaysAllowedCommands: next })
        setError(undefined)
        return true
      } catch (e) {
        report(e)
        return false
      }
    })
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!canAdd) return
    if (check.error) {
      setError(check.error)
      return
    }
    if (await update([...list, check.pattern])) {
      setInput('')
      // 按「新增」按鈕時焦點在按鈕上：回到輸入框，方便接著輸入下一個
      inputRef.current?.focus()
    }
  }
  const remove = async (c: string) => {
    if (saving) return
    // 移除的按鈕會消失，把焦點交給輸入框
    if (await update(list.filter((x) => x !== c))) inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      <span id={`${id}-label`} className="text-[13px] font-medium">
        永遠允許的指令
      </span>
      {list.length > 0 ? (
        <ul aria-labelledby={`${id}-label`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {list.map((c) => (
            <li
              key={c}
              className="flex items-center gap-1.5 rounded-full bg-fill py-1 pr-1.5 pl-2.5 font-mono text-xs"
            >
              {c}
              <button
                type="button"
                aria-label={`移除 ${c}`}
                aria-disabled={saving || undefined}
                onClick={() => void remove(c)}
                className={cx(
                  'flex size-[22px] cursor-pointer items-center justify-center rounded-full text-muted hover:bg-chip hover:text-ink',
                  pendingLook
                )}
              >
                <Icons.X width={10} height={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-xs text-muted">清單是空的，每個 shell 指令都會先詢問你。</span>
      )}
      <form onSubmit={(e) => void add(e)} className="flex gap-2">
        <input
          ref={inputRef}
          aria-label="新增指令"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setError(undefined)
          }}
          onKeyDown={blockImeSubmit}
          placeholder="例如 npm test *"
          spellCheck={false}
          readOnly={saving}
          aria-busy={saving || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error && `${id}-error`, warning && `${id}-warning`, `${id}-hint`]
            .filter(Boolean)
            .join(' ')}
          className={cx(
            inputClass,
            'h-[38px] min-w-0 flex-1 rounded-[10px] px-3 font-mono text-xs',
            error && 'border-danger focus:border-danger'
          )}
        />
        <Button
          type="submit"
          aria-disabled={!canAdd || undefined}
          className={cx('h-[38px] rounded-[10px] px-3.5 text-ink', pendingLook)}
        >
          新增
        </Button>
      </form>
      {/* 訊息之間用 margin 而不是 gap：常駐的空 live region 不會多佔一格間距 */}
      <div className="flex flex-col text-xs">
        {error && (
          <span id={`${id}-error`} role="alert" className="mb-2.5 text-danger">
            {error}
          </span>
        )}
        {/* 常駐的 live region：提醒出現或改變時唸出來 */}
        <div aria-live="polite">
          {warning && (
            <p
              id={`${id}-warning`}
              className="m-0 mb-2.5 rounded-[10px] bg-decision px-3 py-2 text-decision-ink"
            >
              {warning}
            </p>
          )}
        </div>
        <span id={`${id}-hint`} className="text-muted">
          以空格加 <code>*</code> 結尾可接任意參數（<code>npm test *</code> 也允許{' '}
          <code>npm test --watch</code>），否則要完全相同。含 ; &amp; | ` &lt; &gt; $
          或換行的指令一律需要核准。
        </span>
      </div>
    </div>
  )
}

function PermissionSection({ settings, save }: { settings: Settings; save: Save }) {
  return (
    <Section id="perm" title="實作階段權限">
      <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_var(--color-chip)]">
        <FixedRule title="worktree 內的檔案讀寫自動允許" detail="worktree 以外的檔案一律拒絕" />
        <FixedRule
          title={
            <>
              修改 <code>.git</code>、<code>.claude</code> 與 <code>.mcp.json</code> 需要核准
            </>
          }
          detail="這些檔案會改變 git 或 Claude 的行為，即使在 worktree 內也會先詢問"
        />
        <FixedRule title="shell 指令需要核准" detail="下方清單中的指令不必詢問" />
        <AllowedCommands list={settings.alwaysAllowedCommands} save={save} />
      </div>
    </Section>
  )
}

function WorkspaceSection({ settings, save }: { settings: Settings; save: Save }) {
  const loadProject = useInstantSetting('loadProjectSettings', settings.loadProjectSettings, save)
  return (
    <Section id="workspace" title="Worktree 與專案設定">
      <TextSetting
        label="Worktree 存放位置"
        saved={settings.worktreeRoot}
        onSave={(v) => save({ worktreeRoot: v })}
        hint="必須是絕對路徑。只影響之後建立的任務，已有的 worktree 不會搬移。"
      />
      <TextSetting
        label="分支名稱前綴"
        saved={settings.branchPrefix}
        onSave={(v) => save({ branchPrefix: v })}
        hint={`新任務的分支名稱是前綴加上日期與代號，例如 ${settings.branchPrefix}20261008-1a2b3c4d；需符合 git 分支名稱規則。`}
      />
      <label className="flex cursor-pointer items-center gap-3 rounded-[14px] px-4 py-3.5 shadow-[0_0_0_1px_var(--color-chip)]">
        <span className="flex flex-1 flex-col">
          <span className="font-medium">載入 repo 的 CLAUDE.md 與 .claude 設定</span>
          <span className="text-xs text-muted">
            包含專案的 skills 與 MCP；不載入 ~/.claude 的 hooks 與 plugins
          </span>
        </span>
        <input
          type="checkbox"
          checked={loadProject.value}
          aria-busy={loadProject.saving || undefined}
          onChange={(e) => loadProject.set(e.target.checked)}
          className="size-[18px] flex-none accent-brand"
        />
      </label>
    </Section>
  )
}

export function SettingsScreen() {
  const { settings, claude } = useStore(
    useShallow((s) => ({ settings: s.settings, claude: s.claude }))
  )
  const act = useStore((s) => s.act)
  const open = useStore((s) => s.open)
  // 返回打開設定前的畫面；那個任務已不存在時回到新任務
  const back = useStore((s) => {
    const r = s.settingsReturn
    return r?.kind === 'task' && !s.tasks[r.taskId] ? undefined : r
  })
  const save = useSaveSettings()
  // 目前分類：點左欄時以點的那個為準（目標可能捲不到頂端），
  // 使用者自己捲動（滾輪、觸控、鍵盤）或在內容區按下指標後改看捲動位置
  const [spied, setSpied] = useState<SectionId>('account')
  const [clicked, setClicked] = useState<SectionId | null>(null)
  const active = clicked ?? spied
  const release = () => setClicked(null)

  const jump = (e: MouseEvent<HTMLAnchorElement>, id: SectionId) => {
    e.preventDefault()
    setClicked(id)
    const el = document.getElementById(sectionDomId(id))
    el?.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
    el?.focus({ preventScroll: true })
  }
  const reload = () =>
    void act(async () => useStore.setState({ settings: await call('settings:get') }))

  return (
    <>
      <nav aria-label="設定分類" className="flex w-[236px] flex-none flex-col gap-1 px-1.5 py-2">
        <button
          type="button"
          onClick={() => void open(back ?? { kind: 'new' })}
          className="mb-3 flex h-10 cursor-pointer items-center gap-2 px-2.5 text-[13px] text-ink-2 hover:text-ink"
        >
          <Icons.Back width={14} height={14} />
          返回
        </button>
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${sectionDomId(s.id)}`}
            onClick={(e) => jump(e, s.id)}
            aria-current={active === s.id ? 'location' : undefined}
            className={cx(
              'rounded-xl px-3 py-2.5 text-[13px] no-underline',
              active === s.id
                ? 'bg-surface font-medium text-ink shadow-raised hover:text-ink'
                : 'text-ink-2 hover:bg-surface/60 hover:text-ink'
            )}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <main
        onScroll={(e) => setSpied(sectionInView(e.currentTarget))}
        onWheel={release}
        onTouchMove={release}
        onKeyDown={release}
        onPointerDown={release}
        className="min-w-0 flex-1 overflow-y-auto rounded-2xl bg-surface px-7 py-9 shadow-card"
      >
        <div className="mx-auto flex max-w-[680px] flex-col gap-8">
          <h1 className="m-0 text-2xl font-bold">設定</h1>
          {settings ? (
            <>
              <AccountSection claude={claude} claudePath={settings.claudePath ?? ''} save={save} />
              <ModelSection settings={settings} save={save} />
              <PermissionSection settings={settings} save={save} />
              <WorkspaceSection settings={settings} save={save} />
            </>
          ) : (
            <div className="flex items-center gap-3 text-muted">
              無法載入設定。
              <Button size="sm" onClick={reload}>
                重新載入
              </Button>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
```

**Step 7: App.tsx**（設定頁隱藏 Sidebar 並渲染 SettingsScreen；完整檔案）

```tsx
// src/renderer/src/App.tsx
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
import { NewTaskScreen } from './screens/NewTaskScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { TaskScreen } from './screens/TaskScreen'
import { type State, useStore } from './store'

/** 視窗用 hiddenInset 標題列：這一條是拖曳區，左側留給紅綠燈 */
function TitleBar({ title }: { title: string }) {
  return (
    <div className="drag flex h-11 flex-none items-center justify-center px-20 text-xs text-muted select-none">
      <span className="truncate">{title}</span>
    </div>
  )
}

/** 標題列文字（選出字串，任務其他欄位變動時不必重繪 App） */
function titleOf(s: State): string {
  if (s.view.kind === 'settings') return '設定'
  if (s.view.kind === 'new') return '新任務'
  const task = s.tasks[s.view.taskId]
  const repo = task && s.repos.find((r) => r.id === task.repoId)
  return [repo?.name, task?.title].filter(Boolean).join(' · ')
}

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const view = useStore((s) => s.view)
  const title = useStore(titleOf)
  useEffect(() => init(), [init])
  if (!ready)
    return (
      <div className="drag flex h-full items-center justify-center text-muted select-none">
        載入中…
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <TitleBar title={title} />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        {/* 設定頁自帶左欄（分類與返回） */}
        {view.kind !== 'settings' && <Sidebar />}
        <div className="flex min-w-0 flex-1 gap-3">
          {view.kind === 'new' && <NewTaskScreen />}
          {/* key：換任務時重建，回看階段等畫面狀態不會帶到下一個任務 */}
          {view.kind === 'task' && <TaskScreen key={view.taskId} taskId={view.taskId} />}
          {view.kind === 'settings' && <SettingsScreen />}
        </div>
      </div>
      <Toast />
    </div>
  )
}
```

**Step 8: 確認通過** — `npm test` 全部通過；`npm run typecheck`、`npm run lint` PASS

**Step 9: 手動驗證** — 從任務頁進入設定：新增／移除允許的指令、切換模型與載入專案設定後重開 app 仍保留；worktree 位置輸入相對路徑時欄位下方顯示錯誤且保留輸入，改成絕對路徑後儲存；分支前綴輸入含空白的值時顯示錯誤；claude 路徑填不存在的路徑時帳號區顯示偵測錯誤，清空後回到自動偵測；用鍵盤操作時焦點不會在儲存後跳走；「返回」回到原本的任務；用注音輸入法在各輸入框選字時按 Enter 只會確認候選字，不會送出。

**Step 10: Commit**

```bash
git add src/shared/commandPattern.ts src/main/permissions/commandPattern.ts
git commit -m "refactor: share command normalization and shell operator check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add src/main tests/main
git commit -m "fix(main): serialize settings updates, validate branch prefix and keep the latest Claude detection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add src/renderer/src docs/plans tests/renderer
git commit -m "feat(ui): add settings screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 35：示範 repo 與完整流程驗證（真實 Claude）

**Files:**
- Create: `scripts/create-demo-repo.sh`
- Create: `scripts/e2e/driver.mjs`、`scripts/e2e/run.mjs`（手動端對端驗證的驅動程式：Playwright 的 Electron 支援，不屬於 `npm test`）
- Modify: `package.json`（devDependency `playwright`）、`eslint.config.mjs`（`scripts/**/*.mjs` 不要求回傳型別）
- Create: `docs/verification.md`（記錄驗證結果）

驅動程式用 `HARNESS_USER_DATA_DIR`（Task 25）把資料放在暫存資料夾，預先寫好 `settings.json` 的 `worktreeRoot`，以 stub 取代原生的選資料夾／存檔對話框；啟動後在 `127.0.0.1:47123` 接收一段段 async JS（可用 `page`、`shot`、`state`、`waitIdle` 等 helper），由 `run.mjs` 送出。示範 repo 另含 `.claude/settings.json` 的 allow 規則（`Bash(npm test:*)`、`Edit`），用來驗證 PreToolUse hook 仍會要求核准、釐清階段仍不能改檔。

**Step 1: 示範 repo 腳本**

```bash
#!/usr/bin/env bash
# scripts/create-demo-repo.sh — 建立一個小型 Node 專案供端對端驗證
# 用法：scripts/create-demo-repo.sh [目標資料夾]（預設 ~/harness-demo）
set -euo pipefail
DIR="${1:-$HOME/harness-demo}"
# 只覆蓋之前由這個腳本建立的資料夾，避免打錯路徑時刪掉其他東西
if [ -e "$DIR" ] && ! grep -qs '"name": "harness-demo"' "$DIR/package.json"; then
  echo "拒絕覆蓋：$DIR 已存在且不是示範 repo" >&2
  exit 1
fi
rm -rf "$DIR" && mkdir -p "$DIR/src" "$DIR/test" "$DIR/.claude"
cd "$DIR"
cat > package.json <<'JSON'
{ "name": "harness-demo", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > src/login.js <<'JS'
const users = new Map([['alice', 'secret']])
export function login(username, password) {
  if (users.get(username) === password) return { ok: true }
  return { ok: false, status: 401 }
}
JS
cat > test/login.test.js <<'JS'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { login } from '../src/login.js'
test('正確密碼可以登入', () => assert.deepEqual(login('alice', 'secret'), { ok: true }))
test('錯誤密碼回 401', () => assert.equal(login('alice', 'x').status, 401))
JS
# 專案層級的 allow 規則：用來驗證 Harness 的 PreToolUse hook 仍會要求核准 npm test、釐清階段仍不能改檔
cat > .claude/settings.json <<'JSON'
{ "permissions": { "allow": ["Bash(npm test:*)", "Bash(npm test)", "Edit"] } }
JSON
printf '# harness-demo\n' > README.md
git init -q -b main && git add -A && git commit -q -m "init demo"
echo "demo repo: $DIR"
```

```bash
chmod +x scripts/create-demo-repo.sh && ./scripts/create-demo-repo.sh
```

**Step 2: 自動化檢查全部通過**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: 全部通過。lint 有錯誤就修正後再跑。

**Step 3: 手動走完整流程（`npm run dev`），逐項打勾並記錄到 `docs/verification.md`**

1. 設定頁顯示「已透過 Claude Code 登入 · max」。
2. 加入 `~/harness-demo`，新任務輸入：「登入連續失敗 3 次就鎖定帳號 1 分鐘」，模型 Opus 5.5。
3. 時間軸出現讀檔摘要，接著出現問題卡片（建議選項有「建議」標記）。
4. 對問題反問一次 → 卡片內出現 Claude 的回答，卡片選項或建議更新。
5. 在某則 Claude 訊息上按分岔 → 右側面板出現分岔並有回覆 → 帶回主線 → 確認 → 主線出現黃色決策。
6. 回答到 Claude 提出規格 → 自動切到規格頁；要求修改一次 → 出現 v2；核准。
7. 實作頁：步驟清單更新；`npm test` 跳出核准框 → 勾選「本任務內都允許 npm test *」→ 允許；之後同樣指令不再詢問。
8. 實作中插話「錯誤訊息用繁體中文」→ Claude 有回應並調整。
9. 報告頁：概觀數字、架構前後圖（新增節點為青綠色）、決策卡片（可回到對應問題）、限制、diff 每檔有「為什麼」、測試結果顯示 Harness 實跑 `npm test` 通過；若有自訂視覺化區塊，iframe 正常顯示且高度自適應。
10. 在某一行 diff 留回饋、在一個決策留回饋 → 送出 → 任務回到實作 → 產生報告 v2，版本下拉可切換 v1/v2。
11. 匯出 HTML → 用瀏覽器打開，版面完整、沒有互動按鈕。
12. 合併到 main → `git -C ~/harness-demo log --oneline` 看得到 merge commit；任務顯示「已合併」。
13. 另開一個任務後在釐清中關閉 app，再開啟 → 任務顯示「已中斷」，按「繼續」可續接。
14. 再開一個任務 → 按「丟棄 worktree」兩次確認 → worktree 資料夾與分支被刪除，任務從側欄消失。
15. 示範 repo 的 `.claude/settings.json` 允許 `npm test` 與 `Edit`：實作中 `npm test` 仍跳出 Harness 的核准框；釐清中 Claude 改檔被拒絕，核准規格前 worktree 保持乾淨。
16. 寫入 `.git`、`.claude/`、`.mcp.json` 時跳出核准（自然發生才驗證，不刻意要求）。

每一項失敗時：使用 @superpowers:systematic-debugging 找原因、補測試、修正，再重跑該項。

**Step 4: Commit**

```bash
git add scripts docs/verification.md package.json package-lock.json eslint.config.mjs
git commit -m "test: add demo repo script and end-to-end verification record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 完成條件

- `npm test`、`npm run typecheck`、`npm run lint` 全部通過。
- `docs/verification.md` 的檢查項目全部打勾（第 16 項沒有自然發生時註明）。
- `npm run dev` 可在本機啟動並使用訂閱方案的 Claude Code 完成一輪「釐清 → 規格 → 實作 → 報告 → 回饋 → 合併」。
