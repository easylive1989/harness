# Harness 實作計畫

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 建一個個人用的 Electron 桌面 app，讓使用者選 repo、用問題卡片與分岔和 Claude 釐清需求、核准規格後由 Claude 在 git worktree 實作，最後以 HTML 報告呈現架構、決策、限制、diff 與測試結果並可回饋迭代。

**Architecture:** Electron 主程序以 `@anthropic-ai/claude-agent-sdk` 驅動本機已登入（訂閱方案）的 Claude Code；app 透過 in-process MCP 工具（`ask_user`、`propose_spec`、`update_plan`、`conclude_branch`、`submit_report`）取得結構化資料，以 `canUseTool` 控制權限。每一輪對話是一個 `query()`（串流輸入以支援插話），以 `resume`／`forkSession` 續接與分岔。任務狀態、時間軸、報告以 JSON 存在 userData。Renderer 是 React + Tailwind v4，依設計稿 B「瓷白」實作。

**Tech Stack:** Electron 39、electron-vite 5、React 19、TypeScript 5.9、Tailwind CSS 4、zustand、zod 4、@anthropic-ai/claude-agent-sdk 0.3.292、Vitest、React Testing Library、git / gh CLI。

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
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['tests/shared/**/*.test.ts', 'tests/main/**/*.test.ts', 'tests/sanity.test.ts'] } },
      { extends: true, test: { name: 'dom', environment: 'jsdom', include: ['tests/renderer/**/*.test.{ts,tsx}'], setupFiles: ['tests/renderer/setup.ts'] } }
    ]
  }
})
```

建立 `tests/renderer/setup.ts`：

```ts
import '@testing-library/jest-dom/vitest'
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

  --color-brand: #0f766e;
  --color-brand-hover: #115e59;
  --color-brand-ink: #0f5f58;
  --color-brand-tint: #ecf6f4;
  --color-brand-soft: #d5ebe8;
  --color-brand-ring: #cfe3e0;
  --color-brand-muted: #3f5f5b;

  --color-decision: #fdf6e7;
  --color-decision-ink: #8a5300;
  --color-decision-body: #5c4a2a;
  --color-progress: #9a5b00;
  --color-progress-bar: #c27c0e;
  --color-review: #2563eb;
  --color-danger: #b42318;
  --color-ok: #15803d;
  --color-note: #fef9c3;
  --color-note-ink: #713f12;
  --color-code: #1c2430;
  --color-code-ink: #e7ecef;

  --shadow-card: 0 1px 3px rgba(16, 24, 40, 0.06);
  --shadow-raised: 0 1px 2px rgba(16, 24, 40, 0.06), 0 2px 8px rgba(16, 24, 40, 0.05);
  --shadow-focus: 0 0 0 1px #cfe3e0, 0 6px 24px rgba(15, 118, 110, 0.1);
  --shadow-dialog: 0 20px 60px rgba(16, 24, 40, 0.25);
}

@layer base {
  html, body, #root { height: 100%; }
  body { margin: 0; background: var(--color-canvas); color: var(--color-ink); font-family: var(--font-sans); font-size: 14px; line-height: 1.65; -webkit-font-smoothing: antialiased; }
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
  createdAt: string
}

export interface PermissionRequest {
  id: string
  taskId: string
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
  tool?: { id: string; name: string; input?: Record<string, unknown>; isError?: boolean }
  /** question id / decision id / spec 版本 / report 版本 */
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

const id = z.string().regex(/^[a-z0-9_-]+$/)

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

Run: `npx vitest run tests/shared/report.test.ts` → Expected: 7 passed
Run: `npm run typecheck` → PASS

**Step 6: Commit**

```bash
git add src/shared tests/fixtures tests/shared
git commit -m "feat(shared): add domain types and report schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5：結構化訊息協定

使用者對 Claude 的回應以 `[tag key=value] 內容` 格式送出（見設計文件 3.3）。

**Files:**
- Create: `src/shared/protocol.ts`
- Test: `tests/shared/protocol.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import { msg, parseTagged } from '@shared/protocol'

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
```

**Step 2: 確認失敗** — Run: `npx vitest run tests/shared/protocol.test.ts` → FAIL

**Step 3: 實作**

```ts
// src/shared/protocol.ts
import type { BranchConclusion, FeedbackItem } from './types'

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

**Step 4: 確認通過** — Run: `npx vitest run tests/shared/protocol.test.ts` → 6 passed

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
- Create: `src/main/store/repository.ts`
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
  constructor(
    private store: Store,
    private home: string
  ) {}

  async getSettings(): Promise<Settings> {
    return {
      ...defaultSettings(this.home),
      ...(await this.store.readJson<Partial<Settings>>('settings.json', {}))
    }
  }
  saveSettings(s: Settings) {
    return this.store.writeJson('settings.json', s)
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
  createPermissionGate,
  createPreToolUseHook,
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
    expect((await call('Glob', { pattern: 'src/../lib/*.ts' })).behavior).toBe('allow')
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
const ALWAYS = new Set(['TodoWrite', 'Task', 'Agent'])
const NEEDS_APPROVAL = new Set(['WebFetch', 'WebSearch'])
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const

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
  if (p.startsWith('~')) return undefined
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

/** Glob 的 pattern 是絕對路徑、~ 開頭或含 .. 時，必須解析後仍在 worktree 內 */
function globEscapes(root: string, input: Record<string, unknown>): boolean {
  const pattern = input.pattern
  if (pattern === undefined) return false
  if (typeof pattern !== 'string' || pattern.startsWith('~')) return true
  if (!isAbsolute(pattern) && !pattern.split(/[\\/]/).includes('..')) return false
  const base = typeof input.path === 'string' ? resolve(root, input.path) : root
  return !isInside(root, resolve(base, pattern))
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
  return async (toolName, input, { signal, mcpServer }) => {
    if (signal.aborted) return deny('已取消')
    const e = evaluateTool(toolName, input, ctx, { mcpServer })
    if (e.decision === 'allow') return allow(input)
    if (e.decision === 'deny') return deny(e.message ?? `Harness 不允許使用 ${toolName}`)

    const d = await ctx.requestApproval(
      { toolName, input, suggestedPattern: e.suggestedPattern },
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
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { GitService, parseNumstat } from '../../src/main/git/gitService'

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
      files: 2, additions: 2, deletions: 0,
      perFile: [{ path: 'a.txt', additions: 1, deletions: 0 }, { path: 'b.txt', additions: 1, deletions: 0 }]
    })
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
  })
})

describe('parseNumstat', () => {
  test('二進位檔以 0 計', () => {
    expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n')).toEqual({
      files: 2, additions: 3, deletions: 1,
      perFile: [{ path: 'a.ts', additions: 3, deletions: 1 }, { path: 'img.png', additions: 0, deletions: 0 }]
    })
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/git/gitService.ts
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { DiffStats } from '@shared/types'

const pexec = promisify(execFile)

export class CommandError extends Error {
  constructor(readonly command: string, readonly stderr: string) {
    super(`${command} 失敗：${stderr.trim()}`)
  }
}

export async function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await pexec(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new CommandError(`${cmd} ${args.join(' ')}`, err.stderr || err.message)
  }
}

/** core.quotePath=false：非 ASCII 路徑原樣輸出，不用八進位跳脫 */
const git = (cwd: string, ...args: string[]) =>
  runCommand('git', ['-c', 'core.quotePath=false', ...args], cwd)

export function parseNumstat(out: string): DiffStats {
  const perFile = out.split('\n').filter(Boolean).map((line) => {
    const [a, d, ...rest] = line.split('\t')
    return { path: rest.join('\t'), additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d) }
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
    try { return (await git(dir, 'rev-parse', '--is-inside-work-tree')).trim() === 'true' } catch { return false }
  }

  async repoRoot(dir: string) { return (await git(dir, 'rev-parse', '--show-toplevel')).trim() }

  async branches(repo: string) {
    return (await git(repo, 'branch', '--format=%(refname:short)')).split('\n').map((s) => s.trim()).filter(Boolean)
  }

  async currentBranch(repo: string) { return (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim() }

  async createWorktree(repo: string, worktreePath: string, branch: string, base: string) {
    await mkdir(dirname(worktreePath), { recursive: true })
    await git(repo, 'worktree', 'add', '-b', branch, worktreePath, base)
  }

  async commitAll(wt: string, message: string): Promise<string | null> {
    await git(wt, 'add', '-A')
    if (!(await git(wt, 'diff', '--cached', '--name-only')).trim()) return null
    await git(wt, 'commit', '-q', '-m', message)
    return (await git(wt, 'rev-parse', 'HEAD')).trim()
  }

  diff(wt: string, base: string) { return git(wt, 'diff', `${base}...HEAD`) }

  async diffStats(wt: string, base: string) { return parseNumstat(await git(wt, 'diff', '--numstat', `${base}...HEAD`)) }

  /** 含未 commit 與未追蹤檔案，相對於 base 的統計（實作中的「變更檔案」面板用） */
  async workingStats(wt: string, base: string) {
    await git(wt, 'add', '-A', '-N')
    const mergeBase = (await git(wt, 'merge-base', base, 'HEAD')).trim()
    return parseNumstat(await git(wt, 'diff', '--numstat', mergeBase))
  }

  async merge(repo: string, branch: string, base: string) {
    if ((await git(repo, 'status', '--porcelain')).trim()) {
      throw new CommandError('git status', '原 repo 有未提交的變更，請先處理後再合併')
    }
    const current = await this.currentBranch(repo)
    if (current !== base) throw new CommandError('git rev-parse', `原 repo 目前在 ${current}，請切回 ${base} 再合併`)
    await git(repo, 'merge', '--no-ff', branch, '-m', `Merge ${branch}`)
  }

  async removeWorktree(repo: string, wt: string, branch: string) {
    await git(repo, 'worktree', 'remove', '--force', wt).catch(() => git(repo, 'worktree', 'prune'))
    await git(repo, 'branch', '-D', branch)
  }

  async pushAndOpenPr(wt: string, branch: string, base: string, title: string, body: string): Promise<string> {
    await git(wt, 'push', '-u', 'origin', branch)
    const out = await runCommand('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], wt)
    return out.trim().split('\n').pop() ?? ''
  }
}

export type GitLike = Pick<GitService,
  'isRepo' | 'repoRoot' | 'branches' | 'currentBranch' | 'createWorktree' | 'commitAll' |
  'diff' | 'diffStats' | 'workingStats' | 'merge' | 'removeWorktree' | 'pushAndOpenPr'>
```

**Step 4: 確認通過** — `npx vitest run tests/main/gitService.test.ts` → 5 passed

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

export function runShell(cwd: string, command: string, timeoutMs = 10 * 60_000): Promise<VerificationResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], { cwd, env: process.env })
    let out = ''
    const onData = (b: Buffer) => { out = (out + b.toString()).slice(-8000) }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      out += '\n[Harness] 執行逾時，已終止'
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ command, exitCode: code, durationMs: Date.now() - started, outputTail: out.slice(-4000) })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ command, exitCode: null, durationMs: Date.now() - started, outputTail: String(err) })
    })
  })
}

export async function runVerification(
  cwd: string, commands: string[], isAllowed: (command: string) => boolean, timeoutMs?: number
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = []
  for (const command of commands) {
    if (!isAllowed(command)) {
      results.push({ command, exitCode: null, durationMs: 0, outputTail: '', skipped: '這個指令在實作期間沒有被核准過，Harness 未自動執行' })
      continue
    }
    results.push(await runShell(cwd, command, timeoutMs))
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
- Create: `src/main/claude/detect.ts`
- Test: `tests/main/detect.test.ts`

**Step 1: 寫失敗測試**

```ts
import { describe, expect, test } from 'vitest'
import { detectClaude, type Exec } from '../../src/main/claude/detect'

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
    const s = await detectClaude(fakeExec({
      'command -v claude': '/u/.local/bin/claude\n',
      'claude --version': '2.1.292 (Claude Code)\n',
      'claude auth status': JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: 'a@b' })
    }))
    expect(s).toEqual({ found: true, path: '/u/.local/bin/claude', version: '2.1.292 (Claude Code)', loggedIn: true, subscriptionType: 'max', email: 'a@b', error: undefined })
  })

  test('使用設定指定的路徑', async () => {
    const s = await detectClaude(fakeExec({
      '/opt/claude --version': '1', '/opt/claude auth status': '{"loggedIn":true}'
    }), '/opt/claude')
    expect(s.path).toBe('/opt/claude')
  })

  test('找不到 claude', async () => {
    const s = await detectClaude(fakeExec({ 'command -v claude': new Error('no') }))
    expect(s.found).toBe(false)
    expect(s.error).toContain('找不到')
  })

  test('未登入', async () => {
    const s = await detectClaude(fakeExec({
      'command -v claude': '/c', '/c --version': '1', '/c auth status': '{"loggedIn":false}'
    }))
    expect(s.loggedIn).toBe(false)
    expect(s.error).toContain('登入')
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/claude/detect.ts
import { execFile } from 'node:child_process'
import type { ClaudeStatus } from '@shared/types'

export type Exec = (cmd: string, args: string[]) => Promise<string>

/** 執行指令並回傳 stdout；非 0 結束時若有 stdout 也回傳（`claude auth status` 未登入時會這樣） */
export const execCapture: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error(stderr || err.message))
      else resolve(stdout)
    })
  })

const shell = () => process.env.SHELL || '/bin/zsh'

export async function detectClaude(exec: Exec, explicitPath?: string): Promise<ClaudeStatus> {
  let path = explicitPath
  if (!path) {
    try { path = (await exec(shell(), ['-lc', 'command -v claude'])).trim() || undefined } catch { path = undefined }
  }
  if (!path) return { found: false, loggedIn: false, error: '找不到 claude 指令，請先安裝 Claude Code。' }
  try {
    const version = (await exec(path, ['--version'])).trim()
    const auth = JSON.parse(await exec(path, ['auth', 'status'])) as { loggedIn?: boolean; subscriptionType?: string; email?: string }
    const loggedIn = !!auth.loggedIn
    return {
      found: true, path, version, loggedIn,
      subscriptionType: auth.subscriptionType, email: auth.email,
      error: loggedIn ? undefined : '尚未登入，請在終端機執行 claude 並完成登入。'
    }
  } catch (e) {
    return { found: true, path, loggedIn: false, error: `無法讀取 Claude Code 狀態：${(e as Error).message}` }
  }
}

/** 從 Finder 啟動時 PATH 不含 homebrew / nvm，改用 login shell 的 PATH */
export async function applyLoginShellPath(exec: Exec = execCapture) {
  try {
    const p = (await exec(shell(), ['-ilc', 'printf "%s" "$PATH"'])).trim()
    if (p) process.env.PATH = p
  } catch { /* 保留原本的 PATH */ }
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
- Test: `tests/main/harnessTools.test.ts`

**Step 1: 寫失敗測試**（直接測 handler，不經過 MCP）

```ts
import { describe, expect, test, vi } from 'vitest'
import { createToolHandlers, type ToolSink } from '../../src/main/tools/harnessTools'
import { sampleReport } from '../fixtures/report'

function sink(over: Partial<ToolSink> = {}): ToolSink {
  return { askUser: vi.fn(), proposeSpec: vi.fn(), updatePlan: vi.fn(), concludeBranch: vi.fn(), submitReport: vi.fn(), ...over }
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

  test('sink 丟錯時轉成 isError', async () => {
    const s = sink({ proposeSpec: vi.fn(async () => { throw new Error('無法在 implementing 狀態執行 SPEC_PROPOSED') }) })
    const r = await createToolHandlers(s).propose_spec({ title: 't', summary: 's', in_scope: [], out_of_scope: [], decisions: [], steps: ['a'], acceptance: ['b'] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('implementing')
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/tools/harnessTools.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { DecisionSourceSchema, type ReportInput, ReportInputSchema, ReportInputShape } from '@shared/report'

const id = z.string().regex(/^[a-z0-9_-]+$/)

export const askUserShape = {
  question_id: id.describe('問題 ID（小寫英數），更新同一張卡片時沿用'),
  question: z.string().min(1).describe('一個具體的問題'),
  options: z.array(z.object({ id, label: z.string().min(1), description: z.string().optional() })).max(6)
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
  steps: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['pending', 'running', 'done', 'blocked']) })).min(1)
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

export type HarnessToolName = 'ask_user' | 'propose_spec' | 'update_plan' | 'conclude_branch' | 'submit_report'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] })
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true })

async function guard(fn: () => Promise<Result>): Promise<Result> {
  try { return await fn() } catch (e) { return fail(`Harness 無法處理：${(e as Error).message}`) }
}

export function createToolHandlers(sink: ToolSink) {
  return {
    ask_user: (a: AskUserArgs) => guard(async () => {
      await sink.askUser(a)
      return ok('問題已顯示給使用者。請立刻結束這一輪，不要再輸出其他內容，等待使用者以 [answer …] 或 [counter_question …] 回覆。')
    }),
    propose_spec: (a: ProposeSpecArgs) => guard(async () => {
      await sink.proposeSpec(a)
      return ok('規格草稿已交給使用者審閱。請結束這一輪，等待 [spec_approved] 或 [spec_feedback …]。')
    }),
    update_plan: (a: UpdatePlanArgs) => guard(async () => {
      await sink.updatePlan(a)
      return ok('進度已更新。')
    }),
    conclude_branch: (a: ConcludeBranchArgs) => guard(async () => {
      await sink.concludeBranch(a)
      return ok('結論已交給使用者確認。請結束這一輪。')
    }),
    submit_report: (raw: unknown) => guard(async () => {
      const parsed = ReportInputSchema.safeParse(raw)
      if (!parsed.success) return fail(`報告格式有誤，請修正後重新呼叫 submit_report：\n${z.prettifyError(parsed.error)}`)
      await sink.submitReport(parsed.data)
      return ok('報告已提交，Harness 會整理 diff 並實際執行驗證指令。請結束這一輪。')
    })
  }
}

const DESCRIPTIONS: Record<HarnessToolName, string> = {
  ask_user: '向使用者提出一個需要釐清的問題，以問題卡片呈現。一次只問一題，呼叫後立刻結束這一輪。用相同 question_id 再呼叫可更新卡片。',
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
    conclude_branch: tool('conclude_branch', DESCRIPTIONS.conclude_branch, concludeBranchShape, h.conclude_branch),
    submit_report: tool('submit_report', DESCRIPTIONS.submit_report, ReportInputShape, h.submit_report)
  }
  return createSdkMcpServer({ name: 'harness', version: '1.0.0', tools: names.map((n) => all[n]) })
}
```

若 `tool()` 對 handler 型別推論報錯（MCP `CallToolResult` 與 `Result` 不相容），把 `Result` 改為 `import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'`。

**Step 4: 確認通過**、`npm run typecheck` PASS

**Step 5: Commit**

```bash
git add src/main/tools tests/main/harnessTools.test.ts
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
  for (const s of ['mcp__harness__ask_user', 'mcp__harness__propose_spec', 'mcp__harness__update_plan', 'mcp__harness__submit_report',
    '[answer', '[counter_question', '[branch_conclusion', '[spec_approved]', '[spec_feedback', '[report_feedback', '[resume]', '繁體中文']) {
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
- custom_blocks：只有在圖比文字清楚時才加（狀態機、資料流、時序等）。使用自含的 HTML 與 inline CSS，不可載入任何外部資源；寬度自適應、淺色背景。
- 收到 [report_feedback] 時，依回饋修改程式碼並重新呼叫 submit_report 產生新版本。

### 中斷
- 收到 [resume] 時，先檢查目前 worktree 的狀態，再從中斷的地方繼續。
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
import { describe, expect, test } from 'vitest'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentRun, mapMessage, type QueryFn, type RunnerEvent } from '../../src/main/agent/agentRun'

const m = (x: unknown) => x as SDKMessage

describe('mapMessage', () => {
  test('init → session', () => {
    expect(mapMessage(m({ type: 'system', subtype: 'init', session_id: 's1' }))).toEqual([{ type: 'session', sessionId: 's1' }])
  })
  test('assistant 的文字與 tool_use', () => {
    expect(mapMessage(m({ type: 'assistant', parent_tool_use_id: null, message: { content: [
      { type: 'text', text: '你好' }, { type: 'text', text: '  ' },
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } }
    ] } }))).toEqual([
      { type: 'assistant_text', text: '你好' },
      { type: 'tool_call', id: 'tu1', name: 'Read', input: { file_path: 'a' } }
    ])
  })
  test('子代理的訊息略過', () => {
    expect(mapMessage(m({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'hi' }] } }))).toEqual([])
  })
  test('tool_result', () => {
    expect(mapMessage(m({ type: 'user', parent_tool_use_id: null, message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'denied' }] }
    ] } }))).toEqual([{ type: 'tool_result', id: 'tu1', isError: true, text: 'denied' }])
  })
  test('result', () => {
    expect(mapMessage(m({ type: 'result', subtype: 'success', is_error: false }))).toEqual([{ type: 'turn_end', ok: true }])
    expect(mapMessage(m({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }))).toEqual([{ type: 'turn_end', ok: false, error: 'boom' }])
  })
  test('rate limit 只有非 allowed 才回報', () => {
    expect(mapMessage(m({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))).toEqual([])
    const [e] = mapMessage(m({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791400000 } }))
    expect(e.type).toBe('rate_limit')
  })
})

describe('AgentRun', () => {
  test('送出第一則訊息、轉發事件，turn_end 後關閉輸入', async () => {
    const prompts: string[] = []
    const fake: QueryFn = ({ prompt }) => {
      const gen = (async function* () {
        for await (const u of prompt as AsyncIterable<SDKUserMessage>) {
          prompts.push(String(u.message.content))
          yield m({ type: 'system', subtype: 'init', session_id: 's1' })
          yield m({ type: 'result', subtype: 'success', is_error: false })
        }
      })()
      return Object.assign(gen, { interrupt: async () => undefined })
    }
    const events: RunnerEvent[] = []
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'hello' }, (e) => events.push(e))
    await run.done
    expect(prompts).toEqual(['hello'])
    expect(events.map((e) => e.type)).toEqual(['session', 'turn_end'])
    expect(run.active).toBe(false)
    expect(run.send('late')).toBe(false)
  })

  test('執行中可以插話', async () => {
    const prompts: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fake: QueryFn = ({ prompt }) => {
      const gen = (async function* () {
        const it = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
        prompts.push(String((await it.next()).value.message.content))
        await gate
        prompts.push(String((await it.next()).value.message.content))
        yield m({ type: 'result', subtype: 'success', is_error: false })
      })()
      return Object.assign(gen, { interrupt: async () => undefined })
    }
    const run = new AgentRun(fake, { options: {}, firstPrompt: 'a' }, () => {})
    expect(run.send('b')).toBe(true)
    release()
    await run.done
    expect(prompts).toEqual(['a', 'b'])
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作**

```ts
// src/main/agent/agentRun.ts
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './asyncQueue'

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) =>
  AsyncIterable<SDKMessage> & { interrupt(): Promise<unknown> }

export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; isError: boolean; text: string }
  | { type: 'turn_end'; ok: boolean; error?: string }
  | { type: 'rate_limit'; message: string }

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }
type Loose = {
  type: string; subtype?: string; session_id?: string; parent_tool_use_id?: string | null
  message?: { content?: string | Block[] }; is_error?: boolean; errors?: string[]
  rate_limit_info?: { status: string; resetsAt?: number }
}

const blockText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: Block) => (x.type === 'text' ? x.text ?? '' : '')).join('') : ''

export function mapMessage(raw: SDKMessage): RunnerEvent[] {
  const m = raw as unknown as Loose
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' && m.session_id ? [{ type: 'session', sessionId: m.session_id }] : []
    case 'assistant': {
      if (m.parent_tool_use_id) return []
      const content = Array.isArray(m.message?.content) ? m.message.content : []
      return content.flatMap((b): RunnerEvent[] => {
        if (b.type === 'text' && b.text?.trim()) return [{ type: 'assistant_text', text: b.text }]
        if (b.type === 'tool_use') return [{ type: 'tool_call', id: b.id ?? '', name: b.name ?? '', input: (b.input ?? {}) as Record<string, unknown> }]
        return []
      })
    }
    case 'user': {
      if (m.parent_tool_use_id || !Array.isArray(m.message?.content)) return []
      return m.message.content.flatMap((b): RunnerEvent[] =>
        b.type === 'tool_result' ? [{ type: 'tool_result', id: b.tool_use_id ?? '', isError: !!b.is_error, text: blockText(b.content) }] : [])
    }
    case 'result': {
      const ok = m.subtype === 'success' && !m.is_error
      return [ok ? { type: 'turn_end', ok } : { type: 'turn_end', ok, error: (m.errors ?? []).join('\n') || m.subtype }]
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info
      if (!info || info.status === 'allowed') return []
      const when = info.resetsAt ? `，約 ${new Date(info.resetsAt * 1000).toLocaleString('zh-TW')} 重置` : ''
      return [{ type: 'rate_limit', message: info.status === 'rejected' ? `已達到訂閱方案的用量上限${when}。` : `即將達到訂閱方案的用量上限${when}。` }]
    }
    default:
      return []
  }
}

export function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage
}

export interface RunConfig { options: Options; firstPrompt: string }

/** 一輪對話：送出第一則訊息，可插話，收到 result 後關閉輸入讓程序結束 */
export class AgentRun {
  private queue = new AsyncQueue<SDKUserMessage>()
  private q: ReturnType<QueryFn>
  private ended = false
  readonly done: Promise<void>

  constructor(queryFn: QueryFn, cfg: RunConfig, onEvent: (e: RunnerEvent) => void) {
    this.queue.push(userMessage(cfg.firstPrompt))
    this.q = queryFn({ prompt: this.queue, options: cfg.options })
    this.done = (async () => {
      try {
        for await (const msg of this.q) {
          for (const e of mapMessage(msg)) {
            onEvent(e)
            if (e.type === 'turn_end') this.closeInput()
          }
        }
      } finally {
        this.ended = true
        this.closeInput()
      }
    })()
  }

  get active() { return !this.ended && !this.queue.isClosed }

  send(text: string): boolean {
    if (!this.active) return false
    this.queue.push(userMessage(text))
    return true
  }

  async interrupt() {
    await this.q.interrupt().catch(() => undefined)
    this.closeInput()
  }

  private closeInput() { if (!this.queue.isClosed) this.queue.close() }
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

```ts
// tests/main/fakeClaude.ts
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from '../../src/main/agent/agentRun'
import type { GitLike } from '../../src/main/git/gitService'
import type { ToolSink } from '../../src/main/tools/harnessTools'

export interface ScriptCtx { call: number; prompt: string; options: Options; sink: ToolSink }
export type Script = (ctx: ScriptCtx) => Promise<unknown[] | void>

export const assistantText = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } })

/** 假的 Claude：每次 query() 讀第一則訊息、送 init、執行 script（可呼叫 sink），最後送 result */
export class FakeClaude {
  calls: { prompt: string; options: Options }[] = []
  script: Script = async () => []
  private lastSink?: ToolSink

  createToolServer = (sink: ToolSink) => {
    this.lastSink = sink
    return { type: 'sdk', name: 'harness' } as never
  }

  queryFn: QueryFn = ({ prompt, options }) => {
    const sink = this.lastSink!
    const call = this.calls.length
    const self = this
    const gen = (async function* () {
      const it = prompt[Symbol.asyncIterator]()
      const first = await it.next()
      const text = String((first.value as SDKUserMessage).message.content)
      self.calls.push({ prompt: text, options })
      const sessionId = options.forkSession ? `fork-${call}` : (options.resume ?? `sess-${call}`)
      yield { type: 'system', subtype: 'init', session_id: sessionId } as unknown as SDKMessage
      for (const msg of (await self.script({ call, prompt: text, options, sink })) ?? []) yield msg as SDKMessage
      await new Promise((r) => setTimeout(r, 40))
      yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage
    })()
    return Object.assign(gen, { interrupt: async () => undefined })
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
    createWorktree: async (_repo, wt, branch, base) => { calls.push(`worktree ${wt} ${branch} ${base}`) },
    commitAll: async () => 'abc123',
    diff: async () => 'diff --git a/a.ts b/a.ts\n',
    diffStats: async () => ({ files: 1, additions: 2, deletions: 0, perFile: [{ path: 'a.ts', additions: 2, deletions: 0 }] }),
    workingStats: async () => ({ files: 0, additions: 0, deletions: 0, perFile: [] }),
    merge: async (_repo, branch, base) => { calls.push(`merge ${branch} ${base}`) },
    removeWorktree: async (_repo, wt, branch) => { calls.push(`remove ${wt} ${branch}`) },
    pushAndOpenPr: async () => 'https://github.com/me/shop-api/pull/1'
  }
}

export async function until(cond: () => boolean, ms = 2000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('until: timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
```

**Step 2: 寫失敗測試（本 Task 的部分）**

```ts
// tests/main/taskManager.test.ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { AppEvent } from '@shared/ipc'
import { Repository } from '../../src/main/store/repository'
import { Store } from '../../src/main/store/store'
import { TaskManager } from '../../src/main/tasks/taskManager'
import { assistantText, FakeClaude, fakeGit } from './fakeClaude'

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'harness-tm-'))
  const repo = new Repository(new Store(root), '/home/me')
  await repo.saveRepos([{ id: 'r1', name: 'shop-api', path: '/repos/shop-api', addedAt: 'x' }])
  const claude = new FakeClaude()
  const git = fakeGit()
  const events: AppEvent[] = []
  const verify = vi.fn(async (_cwd: string, commands: string[]) =>
    commands.map((command) => ({ command, exitCode: 0, durationMs: 1, outputTail: 'ok' })))
  let n = 0
  const tm = new TaskManager({
    repo, git, queryFn: claude.queryFn, createToolServer: claude.createToolServer,
    getClaudePath: () => '/bin/claude', emit: (e) => events.push(e), verify,
    newId: () => `id${++n}`, now: () => '2026-10-07T10:00:00.000Z'
  })
  await tm.init()
  const create = async () => {
    const t = await tm.createTask({ repoId: 'r1', request: '加上登入失敗鎖定', baseBranch: 'main', model: 'claude-opus-5-5' })
    await tm.whenIdle(t.id)
    return t.id
  }
  return { tm, claude, git, events, verify, repo, create }
}

const askQ1 = { question_id: 'q1', question: '計數單位？', options: [{ id: 'acct', label: '帳號' }, { id: 'acct_ip', label: '帳號 + IP' }], allow_free_text: true }

describe('TaskManager：建立任務與釐清', () => {
  test('建立 worktree、送出需求、記下 session', async () => {
    const { tm, claude, git, create } = await setup()
    const id = await create()
    const t = tm.get(id)
    expect(git.calls[0]).toBe(`worktree /home/me/.harness/worktrees/shop-api/20261007-${id} harness/20261007-${id} main`)
    expect(claude.calls[0].prompt).toBe('加上登入失敗鎖定')
    expect(claude.calls[0].options).toMatchObject({ cwd: t.worktreePath, model: 'claude-opus-5-5', settingSources: ['project'], pathToClaudeCodeExecutable: '/bin/claude' })
    expect(claude.calls[0].options.resume).toBeUndefined()
    expect(t).toMatchObject({ status: 'clarifying', runState: 'idle', mainSessionId: 'sess-0' })
  })

  test('ask_user 建立問題卡片；回答後以 resume 送出 [answer]', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => { if (call === 0) await sink.askUser(askQ1) }
    const id = await create()
    expect(tm.get(id).questions[0]).toMatchObject({ id: 'q1', status: 'open', options: askQ1.options })
    expect((await tm.timeline(id)).map((e) => e.kind)).toEqual(['user_text', 'question'])

    await tm.answerQuestion(id, 'q1', { optionId: 'acct_ip' })
    await tm.whenIdle(id)
    expect(tm.get(id).questions[0]).toMatchObject({ status: 'answered', answer: { optionId: 'acct_ip' } })
    expect(claude.calls[1].prompt).toBe('[answer question_id=q1 option=acct_ip] 帳號 + IP')
    expect(claude.calls[1].options.resume).toBe('sess-0')
  })

  test('反問：回答文字進入卡片，Claude 以同一 question_id 更新卡片', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => { if (call === 0) await sink.askUser(askQ1) }
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
    expect((await tm.timeline(id)).slice(-2).map((e) => [e.kind, e.text])).toEqual([['user_text', '補充：只針對 /login'], ['assistant_text', '好的']])
  })
})
```

> 註：反問測試用 `setTimeout` 讓 askUser 晚於文字事件發生，模擬真實的「先文字、後工具」順序；FakeClaude 在送出 result 前會等 40ms，確保延遲的 askUser 落在同一輪內。

**Step 3: 確認失敗** — `npx vitest run tests/main/taskManager.test.ts` → FAIL

**Step 4: 實作 TaskManager（本 Task 先實作下列成員，後續 Task 再補）**

```ts
// src/main/tasks/taskManager.ts
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AppEvent, CreateTaskInput } from '@shared/ipc'
import { msg } from '@shared/protocol'
import type { ReportInput } from '@shared/report'
import type {
  Branch, BranchConclusion, Channel, FeedbackItem, PermissionDecision, Report, Task, TimelineEvent, VerificationResult
} from '@shared/types'
import { AgentRun, type QueryFn, type RunnerEvent } from '../agent/agentRun'
import { MAIN_SYSTEM_APPEND } from '../agent/prompts'
import type { GitLike } from '../git/gitService'
import { matchesPattern } from '../permissions/commandPattern'
import {
  type ApprovalRequest,
  createPermissionGate,
  createPreToolUseHook,
  type GateContext
} from '../permissions/gate'
import type { Repository } from '../store/repository'
import type { HarnessToolName, ToolSink } from '../tools/harnessTools'
import { prBody } from './prBody'
import { phaseOf, transition } from './stateMachine'

type McpServer = NonNullable<Options['mcpServers']>[string]

export interface TaskManagerDeps {
  repo: Repository
  git: GitLike
  queryFn: QueryFn
  createToolServer: (sink: ToolSink, tools: HarnessToolName[]) => McpServer
  getClaudePath: () => string | undefined
  emit: (e: AppEvent) => void
  verify: (cwd: string, commands: string[], isAllowed: (c: string) => boolean) => Promise<VerificationResult[]>
  now?: () => string
  newId?: () => string
}

const MAIN_TOOLS: HarnessToolName[] = ['ask_user', 'propose_spec', 'update_plan', 'submit_report']
const runKey = (taskId: string, channel: Channel) => `${taskId}|${channel}`
const branchIdOf = (channel: Channel) => (channel.startsWith('branch:') ? channel.slice('branch:'.length) : undefined)
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class TaskManager {
  private tasks = new Map<string, Task>()
  private runs = new Map<string, AgentRun>()
  private permissionWaiters = new Map<string, { taskId: string; resolve: (d: PermissionDecision) => void }>()
  private chains = new Map<string, Promise<unknown>>()
  private saves = new Map<string, Promise<void>>()
  private pendingCounter = new Map<string, string>()
  private finalizing = new Map<string, Promise<void>>()
  private readonly now: () => string
  private readonly newId: () => string

  constructor(private d: TaskManagerDeps) {
    this.now = d.now ?? (() => new Date().toISOString())
    this.newId = d.newId ?? (() => randomUUID().slice(0, 8))
  }

  // ───────── 讀取 ─────────

  async init() {
    for (const t of await this.d.repo.listTasks()) {
      if (t.runState === 'running' || t.runState === 'waiting_permission' || t.runState === 'finalizing') {
        t.runState = 'interrupted'
        t.pendingPermission = undefined
        t.branches.forEach((b) => { b.running = false })
        await this.d.repo.saveTask(t)
      }
      this.tasks.set(t.id, t)
    }
  }

  list(): Task[] {
    return [...this.tasks.values()].map((t) => structuredClone(t)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(taskId: string): Task {
    const t = this.tasks.get(taskId)
    if (!t) throw new Error(`找不到任務 ${taskId}`)
    return t
  }

  timeline(taskId: string) { return this.d.repo.readTimeline(taskId) }

  /** 等這個任務的所有執行、事件與報告整理結束（測試用，也用於關閉 app 前） */
  async whenIdle(taskId: string) {
    for (let i = 0; i < 50; i++) {
      const runs = [...this.runs.entries()].filter(([k]) => k.startsWith(`${taskId}|`)).map(([, r]) => r.done.catch(() => undefined))
      await Promise.all([...runs, this.finalizing.get(taskId)])
      await this.chains.get(taskId)
      await this.saves.get(taskId)
      await new Promise((r) => setTimeout(r, 0))
      const busy = [...this.runs.keys()].some((k) => k.startsWith(`${taskId}|`)) || this.finalizing.has(taskId)
      if (!busy) return
    }
  }

  // ───────── 內部工具 ─────────

  private enqueue<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(taskId) ?? Promise.resolve()
    const next = prev.then(fn)
    this.chains.set(taskId, next.catch(() => undefined))
    return next
  }

  private async update(taskId: string, fn: (t: Task) => void): Promise<Task> {
    const t = this.get(taskId)
    fn(t)
    t.updatedAt = this.now()
    const snapshot = structuredClone(t)
    const prev = this.saves.get(taskId) ?? Promise.resolve()
    const save = prev.then(() => this.d.repo.saveTask(snapshot))
    this.saves.set(taskId, save.catch(() => undefined))
    this.d.emit({ type: 'task', task: snapshot })
    await save
    return snapshot
  }

  private async addTimeline(taskId: string, e: Omit<TimelineEvent, 'id' | 'ts'>) {
    const event: TimelineEvent = { id: this.newId(), ts: this.now(), ...e }
    await this.d.repo.appendTimeline(taskId, event)
    this.d.emit({ type: 'timeline', taskId, event })
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
      id, repoId: repo.id, title: request.split('\n')[0].slice(0, 40), request,
      baseBranch: input.baseBranch, branch, worktreePath, model: input.model,
      status: 'clarifying', runState: 'idle',
      questions: [], decisions: [], specs: [], plan: [], branches: [],
      allowedCommands: [], approvedCommands: [], reportVersions: [],
      createdAt: now, updatedAt: now
    }
    this.tasks.set(id, task)
    await this.d.repo.saveTask(task)
    this.d.emit({ type: 'task', task: structuredClone(task) })
    await this.send(id, 'main', request)
    return structuredClone(this.get(id))
  }

  async send(taskId: string, channel: Channel, text: string, opts: { display?: string; silent?: boolean } = {}) {
    const t = this.get(taskId)
    if (t.status === 'done' || t.status === 'discarded') throw new Error('任務已結束')
    if (!opts.silent) await this.addTimeline(taskId, { channel, kind: 'user_text', text: opts.display ?? text })
    if (this.runs.get(runKey(taskId, channel))?.send(text)) return
    await this.startTurn(taskId, channel, text)
  }

  private async startTurn(taskId: string, channel: Channel, prompt: string) {
    const t = this.get(taskId)
    const settings = await this.d.repo.getSettings()
    const branchId = branchIdOf(channel)
    const branch = branchId ? t.branches.find((b) => b.id === branchId) : undefined
    if (branchId && !branch) throw new Error(`找不到分岔 ${branchId}`)
    const resume = branch ? branch.sessionId ?? t.mainSessionId : t.mainSessionId
    if (branch && !resume) throw new Error('主線尚未建立 session，無法分岔')

    const gateCtx: GateContext = {
      getPhase: () => (branch ? 'branch' : phaseOf(this.get(taskId).status)),
      worktreePath: t.worktreePath,
      getAllowedPatterns: () => [...settings.alwaysAllowedCommands, ...this.get(taskId).allowedCommands],
      requestApproval: (req, signal) => this.requestApproval(taskId, req, signal),
      onApproved: (command, pattern) => {
        void this.update(taskId, (x) => {
          if (command && !x.approvedCommands.includes(command)) x.approvedCommands.push(command)
          if (pattern && !x.allowedCommands.includes(pattern)) x.allowedCommands.push(pattern)
        })
      }
    }
    const canUseTool = createPermissionGate(gateCtx)

    const options: Options = {
      cwd: t.worktreePath,
      model: t.model,
      resume,
      forkSession: branch && !branch.sessionId ? true : undefined,
      settingSources: settings.loadProjectSettings ? ['project'] : [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: MAIN_SYSTEM_APPEND },
      mcpServers: { harness: this.d.createToolServer(this.sinkFor(taskId, channel), branch ? ['conclude_branch'] : MAIN_TOOLS) },
      canUseTool,
      // 專案設定的 allow 規則會在 canUseTool 之前生效；硬性規則放在 PreToolUse hook 才不會被繞過
      hooks: { PreToolUse: [{ hooks: [createPreToolUseHook(gateCtx)] }] },
      pathToClaudeCodeExecutable: this.d.getClaudePath()
    }

    const run = new AgentRun(this.d.queryFn, { options, firstPrompt: prompt }, (e) => {
      void this.enqueue(taskId, () => this.onRunnerEvent(taskId, channel, e))
    })
    this.runs.set(runKey(taskId, channel), run)
    await this.update(taskId, (x) => {
      if (branchId) {
        const b = x.branches.find((bb) => bb.id === branchId)
        if (b) b.running = true
      } else {
        x.runState = 'running'
        x.error = undefined
      }
    })
    run.done.then(
      () => this.onRunDone(taskId, channel, run),
      (err: unknown) => this.onRunDone(taskId, channel, run, err)
    )
  }

  private onRunDone(taskId: string, channel: Channel, run: AgentRun, err?: unknown) {
    return this.enqueue(taskId, async () => {
      const key = runKey(taskId, channel)
      if (this.runs.get(key) === run) this.runs.delete(key)
      const branchId = branchIdOf(channel)
      if (!branchId) this.pendingCounter.delete(taskId)
      await this.update(taskId, (t) => {
        if (branchId) {
          const b = t.branches.find((x) => x.id === branchId)
          if (b) b.running = false
        } else if (t.runState === 'running' || t.runState === 'waiting_permission') {
          t.runState = 'idle'
        }
        if (err) {
          t.error = errorMessage(err)
          if (!branchId) t.runState = 'error'
        }
      })
    })
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
          await this.addTimeline(taskId, { channel, kind: 'tool_call', tool: { id: e.id, name: e.name, input: e.input } })
        }
        return
      case 'tool_result':
        if (e.isError) await this.addTimeline(taskId, { channel, kind: 'tool_result', text: e.text.slice(0, 2000), tool: { id: e.id, name: '', isError: true } })
        return
      case 'turn_end':
        if (!e.ok) await this.update(taskId, (t) => { t.error = e.error || 'Claude 執行失敗' })
        return
      case 'rate_limit':
        await this.addTimeline(taskId, { channel, kind: 'system', text: e.message })
    }
  }

  // ───────── 工具回呼 ─────────

  private sinkFor(taskId: string, channel: Channel): ToolSink {
    return {
      askUser: (a) => this.enqueue(taskId, async () => {
        if (this.pendingCounter.get(taskId) === a.question_id) this.pendingCounter.delete(taskId)
        let created = false
        await this.update(taskId, (t) => {
          const fields = {
            text: a.question, options: a.options, recommendedOptionId: a.recommended_option_id,
            allowFreeText: a.allow_free_text, context: a.context
          }
          const q = t.questions.find((x) => x.id === a.question_id)
          if (q) Object.assign(q, fields, { status: 'open' as const })
          else {
            created = true
            t.questions.push({ id: a.question_id, ...fields, status: 'open', followups: [], askedAt: this.now() })
          }
        })
        if (created) await this.addTimeline(taskId, { channel, kind: 'question', ref: a.question_id })
      }),
      proposeSpec: (a) => this.enqueue(taskId, async () => {
        let version = 0
        await this.update(taskId, (t) => {
          const next = transition(t.status, 'SPEC_PROPOSED')
          version = t.specs.length + 1
          t.specs.push({
            version, title: a.title, summary: a.summary, inScope: a.in_scope, outOfScope: a.out_of_scope,
            decisions: a.decisions, steps: a.steps, acceptance: a.acceptance, createdAt: this.now()
          })
          t.title = a.title
          t.status = next
        })
        await this.addTimeline(taskId, { channel: 'main', kind: 'spec', ref: String(version) })
      }),
      updatePlan: (a) => this.enqueue(taskId, async () => {
        await this.update(taskId, (t) => { t.plan = a.steps })
      }),
      concludeBranch: (a) => this.enqueue(taskId, async () => {
        const branchId = branchIdOf(channel)
        if (!branchId) throw new Error('conclude_branch 只能在分岔中使用')
        await this.update(taskId, (t) => {
          const b = t.branches.find((x) => x.id === branchId)
          if (!b) throw new Error(`找不到分岔 ${branchId}`)
          b.conclusion = { decision: a.decision, rationale: a.rationale, deferred: a.deferred }
          b.status = 'concluding'
        })
      }),
      submitReport: (input) => this.enqueue(taskId, async () => {
        if (this.get(taskId).status !== 'implementing') throw new Error('只有實作階段可以提交報告')
        const run = this.runs.get(runKey(taskId, 'main'))
        await this.update(taskId, (t) => { t.runState = 'finalizing' })
        const job = this.finalizeReport(taskId, input, run).finally(() => this.finalizing.delete(taskId))
        this.finalizing.set(taskId, job)
      })
    }
  }

  // ───────── 問題卡片 ─────────

  async answerQuestion(taskId: string, questionId: string, answer: { optionId?: string; text?: string }) {
    const q = this.get(taskId).questions.find((x) => x.id === questionId)
    if (!q) throw new Error(`找不到問題 ${questionId}`)
    const label = answer.optionId ? q.options.find((o) => o.id === answer.optionId)?.label : undefined
    await this.update(taskId, (t) => {
      const qq = t.questions.find((x) => x.id === questionId)!
      qq.status = 'answered'
      qq.answer = answer
    })
    const body = [label, answer.text?.trim()].filter(Boolean).join('；')
    await this.send(taskId, 'main', msg.answer(questionId, answer.optionId, body), { silent: true })
  }

  async counterQuestion(taskId: string, questionId: string, text: string) {
    if (!this.get(taskId).questions.some((x) => x.id === questionId)) throw new Error(`找不到問題 ${questionId}`)
    await this.update(taskId, (t) => { t.questions.find((x) => x.id === questionId)!.followups.push({ role: 'user', text }) })
    this.pendingCounter.set(taskId, questionId)
    await this.send(taskId, 'main', msg.counterQuestion(questionId, text), { silent: true })
  }

  // 以下成員在 Task 22–24 補上：openBranch、concludeBranch、confirmBranch、approveSpec、requestSpecChanges、
  // requestApproval、resolvePermission、stop、resume、finalizeReport、submitReportFeedback、createPullRequest、
  // merge、discard、changedFiles
}
```

本 Task 為了能編譯，先加上暫時的 stub（Task 23、24 會取代）：

```ts
  private requestApproval(_taskId: string, _req: ApprovalRequest, _signal: AbortSignal): Promise<PermissionDecision> {
    return Promise.resolve({ allow: false, message: '尚未實作' })
  }
  private async finalizeReport(_taskId: string, _input: ReportInput, _run?: AgentRun) {}
```

並暫時建立 `src/main/tasks/prBody.ts`：`export function prBody(): string { return '' }`（Task 24 取代）。未使用的 import 先註解掉以通過 lint/typecheck。

**Step 5: 依測試檔下方註記，簡化反問測試並在 FakeClaude 加入 40ms 延遲。確認通過**

Run: `npx vitest run tests/main/taskManager.test.ts` → 4 passed

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
    claude.script = async ({ call, sink }) => { if (call === 0) await sink.askUser(askQ1) }
    const id = await create()
    await tm.counterQuestion(id, 'q1', '差在哪？')
    await tm.whenIdle(id)

    claude.script = async () => [assistantText('Redis 可以共享狀態')]
    const b = await tm.openBranch(id, { title: '計數存放位置', fromQuestionId: 'q1', seed: 'Redis 和 in-memory 差在哪？' })
    await tm.whenIdle(id)
    const forkCall = claude.calls.at(-1)!
    expect(forkCall.options).toMatchObject({ resume: 'sess-0', forkSession: true })
    expect(forkCall.prompt).toContain('[branch_open]')
    expect(forkCall.prompt).toContain('來源問題：計數單位？')
    expect(forkCall.prompt).toContain('使用者：差在哪？')
    expect(tm.get(id).branches[0]).toMatchObject({ id: b.id, sessionId: expect.stringMatching(/^fork-/), running: false })
    const tl = await tm.timeline(id)
    expect(tl.filter((e) => e.channel === `branch:${b.id}`).map((e) => e.kind)).toEqual(['user_text', 'assistant_text'])

    claude.script = async ({ sink }) => { await sink.concludeBranch({ decision: '用 Redis', rationale: '多台機器', deferred: [] }) }
    await tm.concludeBranch(id, b.id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.options).toMatchObject({ resume: tm.get(id).branches[0].sessionId })
    expect(claude.calls.at(-1)!.options.forkSession).toBeUndefined()
    expect(tm.get(id).branches[0]).toMatchObject({ status: 'concluding', conclusion: { decision: '用 Redis' } })

    claude.script = async () => []
    await tm.confirmBranch(id, b.id)
    await tm.whenIdle(id)
    const t = tm.get(id)
    expect(t.branches[0].status).toBe('concluded')
    expect(t.decisions[0]).toMatchObject({ id: 'd1', text: '用 Redis', source: { type: 'branch', ref: b.id } })
    expect(claude.calls.at(-1)!.prompt).toBe(`[branch_conclusion branch=${b.id}] 決策：用 Redis\n原因：多台機器`)
    expect(claude.calls.at(-1)!.options.resume).toBe('sess-0')
    expect((await tm.timeline(id)).at(-1)).toMatchObject({ channel: 'main', kind: 'decision', ref: 'd1' })
  })

  test('主線還沒有 session 時不能分岔', async () => {
    const { tm, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x' }))
    await tm.init()
    await expect(tm.openBranch('x', { title: 't' })).rejects.toThrow('回覆至少一次')
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作（加到 TaskManager）**

```ts
  // ───────── 分岔 ─────────

  async openBranch(taskId: string, input: { title: string; fromQuestionId?: string; seed?: string }): Promise<Branch> {
    const t = this.get(taskId)
    if (!t.mainSessionId) throw new Error('請等 Claude 在主線回覆至少一次後再分岔')
    if (this.runs.get(runKey(taskId, 'main'))?.active) throw new Error('主線正在執行，請等它停下來再分岔')
    const q = input.fromQuestionId ? t.questions.find((x) => x.id === input.fromQuestionId) : undefined
    const seed = [
      input.seed?.trim(),
      q && `來源問題：${q.text}`,
      q?.followups.length ? `之前的反問：\n${q.followups.map((f) => `${f.role === 'user' ? '使用者' : 'Claude'}：${f.text}`).join('\n')}` : undefined
    ].filter(Boolean).join('\n')
    const branch: Branch = { id: `b${t.branches.length + 1}`, title: input.title.trim() || '分岔討論', fromQuestionId: input.fromQuestionId, status: 'open', running: false, createdAt: this.now() }
    await this.update(taskId, (x) => { x.branches.push(branch) })
    await this.send(taskId, `branch:${branch.id}`, msg.branchOpen(branch.title, seed), { display: input.seed?.trim() || `開始討論：${branch.title}` })
    return structuredClone(branch)
  }

  async concludeBranch(taskId: string, branchId: string) {
    if (!this.get(taskId).branches.some((b) => b.id === branchId)) throw new Error(`找不到分岔 ${branchId}`)
    await this.send(taskId, `branch:${branchId}`, msg.conclude(), { silent: true })
  }

  async confirmBranch(taskId: string, branchId: string, edited?: BranchConclusion) {
    const t = this.get(taskId)
    const b = t.branches.find((x) => x.id === branchId)
    if (!b) throw new Error(`找不到分岔 ${branchId}`)
    const c = edited ?? b.conclusion
    if (!c) throw new Error('分岔還沒有結論')
    const decisionId = `d${t.decisions.length + 1}`
    await this.update(taskId, (x) => {
      const bb = x.branches.find((y) => y.id === branchId)!
      bb.conclusion = c
      bb.status = 'concluded'
      x.decisions.push({ id: decisionId, text: c.decision, rationale: c.rationale, deferred: c.deferred, source: { type: 'branch', ref: branchId } })
    })
    await this.addTimeline(taskId, { channel: 'main', kind: 'decision', ref: decisionId })
    await this.send(taskId, 'main', msg.branchConclusion(branchId, c), { silent: true })
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

```ts
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { until } from './fakeClaude'

const spec = { title: '帳號鎖定', summary: 's', in_scope: ['a'], out_of_scope: [], decisions: [], steps: ['實作'], acceptance: ['測試通過'] }

describe('TaskManager：規格與實作', () => {
  test('propose_spec → spec_review；要求修改回到 clarifying；核准進入 implementing', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => { if (call === 0) await sink.proposeSpec(spec) }
    const id = await create()
    expect(tm.get(id)).toMatchObject({ status: 'spec_review', title: '帳號鎖定' })
    expect(tm.get(id).specs[0].version).toBe(1)

    claude.script = async ({ sink }) => { await sink.proposeSpec({ ...spec, summary: 's2' }) }
    await tm.requestSpecChanges(id, '上限改 10 次')
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toBe('[spec_feedback] 上限改 10 次')
    expect(tm.get(id)).toMatchObject({ status: 'spec_review' })
    expect(tm.get(id).specs).toHaveLength(2)

    claude.script = async ({ sink }) => { await sink.updatePlan({ steps: [{ id: 's1', title: '寫程式', status: 'running' }] }) }
    await tm.approveSpec(id)
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toContain('[spec_approved]')
    expect(tm.get(id).status).toBe('implementing')
    expect(tm.get(id).plan).toEqual([{ id: 's1', title: '寫程式', status: 'running' }])
  })

  test('shell 指令等待核准，核准並記住樣式', async () => {
    const { tm, claude, create } = await setup()
    claude.script = async ({ call, sink }) => { if (call === 0) await sink.proposeSpec(spec) }
    const id = await create()
    let result: PermissionResult | undefined
    claude.script = async ({ options }) => {
      result = await options.canUseTool!('Bash', { command: 'npm test -- auth' }, { signal: new AbortController().signal } as never)
    }
    await tm.approveSpec(id)
    await until(() => !!tm.get(id).pendingPermission)
    const req = tm.get(id).pendingPermission!
    expect(req).toMatchObject({ toolName: 'Bash', suggestedPattern: 'npm test *' })
    expect(tm.get(id).runState).toBe('waiting_permission')
    await tm.resolvePermission(id, req.id, { allow: true, rememberPattern: 'npm test *' })
    await tm.whenIdle(id)
    expect(result?.behavior).toBe('allow')
    expect(tm.get(id)).toMatchObject({ allowedCommands: ['npm test *'], approvedCommands: ['npm test -- auth'], runState: 'idle' })
    expect(tm.get(id).pendingPermission).toBeUndefined()
  })

  test('執行中插話會送進同一輪', async () => {
    const { tm, claude, create } = await setup()
    const id = await create()
    let release!: () => void
    claude.script = async () => { await new Promise<void>((r) => { release = r }) }
    await tm.send(id, 'main', '開始')
    await until(() => tm.get(id).runState === 'running' && !!release)
    const before = claude.calls.length
    await tm.send(id, 'main', '順便改錯誤訊息')
    expect(claude.calls.length).toBe(before)
    release()
    await tm.whenIdle(id)
    expect((await tm.timeline(id)).filter((e) => e.kind === 'user_text').map((e) => e.text)).toContain('順便改錯誤訊息')
  })

  test('init 把執行中的任務標為中斷；resume 送出 [resume]', async () => {
    const { tm, claude, repo } = await setup()
    const { makeTask } = await import('../fixtures/task')
    await repo.saveTask(makeTask({ id: 'x', runState: 'running', mainSessionId: 's9' }))
    await tm.init()
    expect(tm.get('x').runState).toBe('interrupted')
    await tm.resume('x')
    await tm.whenIdle('x')
    expect(claude.calls.at(-1)).toMatchObject({ prompt: expect.stringContaining('[resume]'), options: { resume: 's9' } })
  })
})
```

**Step 2: 確認失敗**

**Step 3: 實作（加到 TaskManager，並刪除 Task 21 的 requestApproval stub）**

```ts
  // ───────── 規格 ─────────

  async approveSpec(taskId: string) {
    await this.update(taskId, (t) => { t.status = transition(t.status, 'SPEC_APPROVED') })
    await this.send(taskId, 'main', msg.specApproved(), { display: '核准規格，開始實作' })
  }

  async requestSpecChanges(taskId: string, text: string) {
    if (!text.trim()) throw new Error('請說明要修改的地方')
    await this.update(taskId, (t) => { t.status = transition(t.status, 'SPEC_CHANGES_REQUESTED') })
    await this.send(taskId, 'main', msg.specFeedback(text.trim()), { display: `要求修改規格：${text.trim()}` })
  }

  // ───────── 指令核准 ─────────

  private requestApproval(taskId: string, req: ApprovalRequest, signal: AbortSignal): Promise<PermissionDecision> {
    if (signal.aborted) return Promise.resolve({ allow: false, message: '已取消' })
    const id = this.newId()
    return new Promise((resolve) => {
      let settled = false
      const finish = (d: PermissionDecision) => {
        if (settled) return
        settled = true
        this.permissionWaiters.delete(id)
        void this.update(taskId, (t) => {
          if (t.pendingPermission?.id === id) t.pendingPermission = undefined
          if (t.runState === 'waiting_permission') t.runState = 'running'
        })
        resolve(d)
      }
      this.permissionWaiters.set(id, { taskId, resolve: finish })
      signal.addEventListener('abort', () => finish({ allow: false, message: '已取消' }), { once: true })
      void this.update(taskId, (t) => {
        t.pendingPermission = { id, taskId, toolName: req.toolName, input: req.input, suggestedPattern: req.suggestedPattern, createdAt: this.now() }
        t.runState = 'waiting_permission'
      })
    })
  }

  async resolvePermission(taskId: string, requestId: string, decision: PermissionDecision) {
    const w = this.permissionWaiters.get(requestId)
    if (!w || w.taskId !== taskId) throw new Error('這個核准請求已經失效')
    w.resolve(decision)
  }

  // ───────── 停止與續接 ─────────

  async stop(taskId: string, channel: Channel) {
    for (const [id, w] of this.permissionWaiters) {
      if (w.taskId === taskId && channel === 'main') { w.resolve({ allow: false, message: '使用者停止了執行' }); this.permissionWaiters.delete(id) }
    }
    await this.runs.get(runKey(taskId, channel))?.interrupt()
  }

  async resume(taskId: string) {
    await this.send(taskId, 'main', msg.resume(), { display: '繼續執行' })
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
- Modify: `src/main/tasks/taskManager.ts`
- Modify: `src/main/tasks/prBody.ts`
- Test: `tests/main/taskManager.test.ts`、`tests/main/prBody.test.ts`

**Step 1: prBody 測試**

```ts
// tests/main/prBody.test.ts
import { expect, test } from 'vitest'
import { prBody } from '../../src/main/tasks/prBody'
import { sampleReport } from '../fixtures/report'

test('PR 內文包含摘要、決策、限制與驗證結果', () => {
  const body = prBody({
    version: 1, taskId: 't', input: sampleReport, diff: '', createdAt: 'x',
    stats: { files: 2, additions: 10, deletions: 1, perFile: [] },
    verification: [{ command: 'npm test', exitCode: 0, durationMs: 10, outputTail: '' }, { command: 'npm run lint', exitCode: 1, durationMs: 5, outputTail: '' }]
  })
  expect(body).toContain('## 摘要')
  expect(body).toContain('在 IP 限流之後加入 lockoutGuard。')
  expect(body).toContain('- **計數存在 Redis**：既有 Redis（原因：多台機器共享）')
  expect(body).toContain('- Redis 掛掉時放行：fail-open')
  expect(body).toContain('- ✅ `npm test`')
  expect(body).toContain('- ❌ `npm run lint`')
  expect(body).toContain('由 Harness 產生')
})
```

**Step 2: prBody 實作**

```ts
// src/main/tasks/prBody.ts
import type { Report } from '@shared/types'

export function prBody(r: Report): string {
  const i = r.input
  const lines = [
    '## 摘要', i.overview.summary, '',
    '## 決策', ...i.decisions.map((d) => `- **${d.title}**：${d.chosen}（原因：${d.rationale}）`), ''
  ]
  if (i.limitations.length) lines.push('## 限制與風險', ...i.limitations.map((l) => `- ${l.title}：${l.detail}`), '')
  if (i.followups.length) lines.push('## 後續工作', ...i.followups.map((f) => `- ${f.title}${f.detail ? `：${f.detail}` : ''}`), '')
  if (r.verification.length) {
    lines.push('## 驗證', ...r.verification.map((v) => `- ${v.skipped ? '⏭️' : v.exitCode === 0 ? '✅' : '❌'} \`${v.command}\``), '')
  }
  lines.push(`變更：${r.stats.files} 個檔案，+${r.stats.additions} −${r.stats.deletions}`, '', '— 由 Harness 產生（Claude Code）')
  return lines.join('\n')
}
```

**Step 3: TaskManager 測試**

```ts
import { sampleReport } from '../fixtures/report'

async function toImplementing() {
  const ctx = await setup()
  ctx.claude.script = async ({ call, sink }) => { if (call === 0) await sink.proposeSpec(spec) }
  const id = await ctx.create()
  ctx.claude.script = async () => []
  await ctx.tm.approveSpec(id)
  await ctx.tm.whenIdle(id)
  return { ...ctx, id }
}

describe('TaskManager：報告與收尾', () => {
  test('submit_report → commit、diff、驗證、存報告、進入 reviewing', async () => {
    const { tm, claude, verify, repo, id } = await toImplementing()
    tm.get(id).approvedCommands.push('npm test') // get() 回傳內部物件，模擬實作中核准過 npm test
    claude.script = async ({ sink }) => { await sink.submitReport(sampleReport) }
    await tm.send(id, 'main', '完成了嗎？')
    await tm.whenIdle(id)
    const t = tm.get(id)
    expect(t).toMatchObject({ status: 'reviewing', runState: 'idle', reportVersions: [1] })
    const r = await repo.getReport(id, 1)
    expect(r).toMatchObject({ version: 1, commit: 'abc123', stats: { files: 1 } })
    expect(verify).toHaveBeenCalledWith(t.worktreePath, ['npm test'], expect.any(Function))
    const isAllowed = verify.mock.calls[0][2] as (c: string) => boolean
    expect(isAllowed('npm test')).toBe(true)
    expect(isAllowed('rm -rf /')).toBe(false)
    expect((await tm.timeline(id)).at(-1)).toMatchObject({ kind: 'report', ref: '1' })
  })

  test('回饋 → implementing，送出 [report_feedback]；再次提交產生 v2', async () => {
    const { tm, claude, id } = await toImplementing()
    claude.script = async ({ sink }) => { await sink.submitReport(sampleReport) }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    await tm.submitReportFeedback(id, [{ anchor: 'diff:a.ts:3', label: 'a.ts:3', text: '改常數' }])
    await tm.whenIdle(id)
    expect(claude.calls.at(-1)!.prompt).toBe('[report_feedback] - (diff:a.ts:3) 改常數')
    expect(tm.get(id).reportVersions).toEqual([1, 2])
    expect(tm.get(id).status).toBe('reviewing')
  })

  test('開 PR 與合併都會結束任務', async () => {
    const { tm, claude, git, id } = await toImplementing()
    claude.script = async ({ sink }) => { await sink.submitReport(sampleReport) }
    await tm.send(id, 'main', '完成')
    await tm.whenIdle(id)
    expect(await tm.createPullRequest(id)).toBe('https://github.com/me/shop-api/pull/1')
    expect(tm.get(id)).toMatchObject({ status: 'done', prUrl: 'https://github.com/me/shop-api/pull/1' })
    await expect(tm.merge(id)).rejects.toThrow()
    expect(git.calls.some((c) => c.startsWith('merge'))).toBe(false)
  })

  test('丟棄會移除 worktree', async () => {
    const { tm, git, id } = await toImplementing()
    await tm.discard(id)
    expect(tm.get(id).status).toBe('discarded')
    expect(git.calls.at(-1)).toBe(`remove ${tm.get(id).worktreePath} ${tm.get(id).branch}`)
  })
})
```

**Step 4: 確認失敗**

**Step 5: 實作（加到 TaskManager，取代 finalizeReport stub）**

```ts
  // ───────── 報告 ─────────

  private async finalizeReport(taskId: string, input: ReportInput, run?: AgentRun) {
    try {
      await run?.done.catch(() => undefined)
      const t = this.get(taskId)
      const version = t.reportVersions.length + 1
      const commit = (await this.d.git.commitAll(t.worktreePath, `${t.title}（Harness 報告 v${version}）`)) ?? undefined
      const [diff, stats] = await Promise.all([this.d.git.diff(t.worktreePath, t.baseBranch), this.d.git.diffStats(t.worktreePath, t.baseBranch)])
      const settings = await this.d.repo.getSettings()
      const patterns = [...settings.alwaysAllowedCommands, ...t.allowedCommands]
      const verification = await this.d.verify(
        t.worktreePath,
        input.verification.map((v) => v.command),
        (c) => t.approvedCommands.includes(c) || patterns.some((p) => matchesPattern(c, p))
      )
      const report: Report = { version, taskId, input, diff, stats, verification, commit, createdAt: this.now() }
      await this.d.repo.saveReport(report)
      await this.update(taskId, (x) => {
        x.reportVersions.push(version)
        x.status = transition(x.status, 'REPORT_SUBMITTED')
        x.runState = 'idle'
      })
      await this.addTimeline(taskId, { channel: 'main', kind: 'report', ref: String(version) })
    } catch (e) {
      await this.update(taskId, (x) => { x.runState = 'error'; x.error = `整理報告失敗：${errorMessage(e)}` })
    }
  }

  getReport(taskId: string, version: number) { return this.d.repo.getReport(taskId, version) }

  async submitReportFeedback(taskId: string, items: FeedbackItem[], overall?: string) {
    if (!items.length && !overall?.trim()) throw new Error('請至少留一則回饋')
    await this.update(taskId, (t) => { t.status = transition(t.status, 'REPORT_FEEDBACK') })
    await this.send(taskId, 'main', msg.reportFeedback(items, overall?.trim()), { display: `送出 ${items.length} 則報告回饋${overall?.trim() ? '與整體意見' : ''}` })
  }

  // ───────── 收尾 ─────────

  private async repoOf(t: Task) {
    const repo = (await this.d.repo.listRepos()).find((r) => r.id === t.repoId)
    if (!repo) throw new Error('找不到 repo')
    return repo
  }

  async createPullRequest(taskId: string): Promise<string> {
    const t = this.get(taskId)
    if (t.status !== 'reviewing') throw new Error('只有待審閱的任務可以開 PR')
    const report = await this.d.repo.getReport(taskId, t.reportVersions.at(-1)!)
    const url = await this.d.git.pushAndOpenPr(t.worktreePath, t.branch, t.baseBranch, t.specs.at(-1)?.title ?? t.title, prBody(report))
    await this.update(taskId, (x) => { x.prUrl = url; x.status = transition(x.status, 'FINISHED') })
    return url
  }

  async merge(taskId: string) {
    const t = this.get(taskId)
    if (t.status !== 'reviewing') throw new Error('只有待審閱的任務可以合併')
    await this.d.git.merge((await this.repoOf(t)).path, t.branch, t.baseBranch)
    await this.update(taskId, (x) => { x.status = transition(x.status, 'FINISHED') })
  }

  async discard(taskId: string) {
    const t = this.get(taskId)
    for (const key of [...this.runs.keys()].filter((k) => k.startsWith(`${taskId}|`))) {
      await this.stop(taskId, key.split('|')[1] as Channel)
    }
    await this.d.git.removeWorktree((await this.repoOf(t)).path, t.worktreePath, t.branch)
    await this.update(taskId, (x) => {
      if (x.status !== 'done') x.status = 'discarded'
      x.runState = 'idle'
      x.pendingPermission = undefined
    })
  }

  async changedFiles(taskId: string) {
    const t = this.get(taskId)
    return this.d.git.workingStats(t.worktreePath, t.baseBranch)
  }
```

**Step 6: 確認通過** — `npx vitest run tests/main` → 全部通過；`npm run typecheck` PASS

**Step 7: Commit**

```bash
git add src/main/tasks tests/main/taskManager.test.ts tests/main/prBody.test.ts
git commit -m "feat(main): finalize reports, handle feedback, PR, merge and discard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 25：主程序組裝：IPC、自訂區塊 protocol、preload

**Files:**
- Create: `src/main/report/blockHtml.ts`
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`、`src/preload/index.d.ts`
- Test: `tests/main/blockHtml.test.ts`

**Step 1: blockHtml 測試**

```ts
import { expect, test } from 'vitest'
import { BLOCK_CSP, wrapBlockHtml } from '../../src/main/report/blockHtml'

test('包住區塊 HTML 並回報高度', () => {
  const html = wrapBlockHtml({ id: 'state-machine', title: 't', html: '<div id="x">hi</div>' })
  expect(html).toContain('<div id="x">hi</div>')
  expect(html).toContain('"harness-block-height"')
  expect(html).toContain('"state-machine"')
  expect(html.startsWith('<!doctype html>')).toBe(true)
})

test('CSP 禁止網路', () => {
  expect(BLOCK_CSP).toContain("default-src 'none'")
  expect(BLOCK_CSP).not.toContain('http')
})
```

**Step 2: blockHtml 實作**

```ts
// src/main/report/blockHtml.ts
export const BLOCK_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:"

export function wrapBlockHtml(block: { id: string; title: string; html: string }): string {
  const id = JSON.stringify(block.id)
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;color:#1c2430;font-family:'Noto Sans TC',-apple-system,'PingFang TC',sans-serif;font-size:14px;line-height:1.6}</style>
</head><body>${block.html}
<script>(function(){var post=function(){parent.postMessage({type:"harness-block-height",id:${id},height:document.documentElement.scrollHeight},"*")};new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post()})()</script>
</body></html>`
}
```

**Step 3: ipc.ts（把 IpcApi 的每個 channel 對應到實作）**

```ts
// src/main/ipc.ts
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcApi, IpcChannel } from '@shared/ipc'
import type { ClaudeStatus, Repo } from '@shared/types'
import type { GitService } from './git/gitService'
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

type Handlers = { [C in IpcChannel]: (...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<ReturnType<IpcApi[C]>> }

export function registerIpc(d: IpcDeps) {
  const handlers: Handlers = {
    'claude:status': (refresh) => d.claudeStatus(refresh),
    'settings:get': () => d.repo.getSettings(),
    'settings:set': async (patch) => {
      const next = { ...(await d.repo.getSettings()), ...patch }
      await d.repo.saveSettings(next)
      if ('claudePath' in patch) await d.claudeStatus(true)
      return next
    },
    'repos:list': () => d.repo.listRepos(),
    'repos:pick': async () => {
      const w = d.win()
      const res = w ? await dialog.showOpenDialog(w, { properties: ['openDirectory'], title: '選擇 git repo' }) : { canceled: true, filePaths: [] }
      if (res.canceled || !res.filePaths[0]) return null
      if (!(await d.git.isRepo(res.filePaths[0]))) throw new Error('這個資料夾不是 git repo')
      const root = await d.git.repoRoot(res.filePaths[0])
      const repos = await d.repo.listRepos()
      const existing = repos.find((r) => r.path === root)
      if (existing) return existing
      const repo: Repo = { id: randomUUID().slice(0, 8), name: basename(root), path: root, addedAt: new Date().toISOString() }
      await d.repo.saveRepos([...repos, repo])
      d.emitRepos([...repos, repo])
      return repo
    },
    'repos:branches': async (repoId) => {
      const r = (await d.repo.listRepos()).find((x) => x.id === repoId)
      if (!r) throw new Error('找不到 repo')
      return { branches: await d.git.branches(r.path), current: await d.git.currentBranch(r.path) }
    },
    'tasks:list': () => d.tasks.list(),
    'tasks:create': (input) => d.tasks.createTask(input),
    'tasks:timeline': (taskId) => d.tasks.timeline(taskId),
    'tasks:send': (taskId, channel, text) => d.tasks.send(taskId, channel, text),
    'tasks:answer': (taskId, qid, answer) => d.tasks.answerQuestion(taskId, qid, answer),
    'tasks:counter': (taskId, qid, text) => d.tasks.counterQuestion(taskId, qid, text),
    'tasks:changedFiles': (taskId) => d.tasks.changedFiles(taskId),
    'branch:open': (taskId, input) => d.tasks.openBranch(taskId, input),
    'branch:conclude': (taskId, branchId) => d.tasks.concludeBranch(taskId, branchId),
    'branch:confirm': (taskId, branchId, edited) => d.tasks.confirmBranch(taskId, branchId, edited),
    'spec:approve': (taskId) => d.tasks.approveSpec(taskId),
    'spec:requestChanges': (taskId, text) => d.tasks.requestSpecChanges(taskId, text),
    'run:stop': (taskId, channel) => d.tasks.stop(taskId, channel),
    'run:resume': (taskId) => d.tasks.resume(taskId),
    'permission:resolve': (taskId, requestId, decision) => d.tasks.resolvePermission(taskId, requestId, decision),
    'report:get': (taskId, version) => d.tasks.getReport(taskId, version),
    'report:feedback': (taskId, items, overall) => d.tasks.submitReportFeedback(taskId, items, overall),
    'report:saveHtml': async (suggestedName, html) => {
      const w = d.win()
      if (!w) return null
      const res = await dialog.showSaveDialog(w, { defaultPath: suggestedName, filters: [{ name: 'HTML', extensions: ['html'] }] })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, html)
      return res.filePath
    },
    'finish:pr': (taskId) => d.tasks.createPullRequest(taskId),
    'finish:merge': (taskId) => d.tasks.merge(taskId),
    'finish:discard': (taskId) => d.tasks.discard(taskId),
    'shell:showInFolder': (path) => { shell.showItemInFolder(path) },
    'shell:openExternal': async (url) => { if (/^https:\/\//.test(url)) await shell.openExternal(url) }
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }
}
```

**Step 4: main/index.ts**

```ts
// src/main/index.ts
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, protocol, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { APP_EVENT_CHANNEL, type AppEvent } from '@shared/ipc'
import type { ClaudeStatus } from '@shared/types'
import type { QueryFn } from './agent/agentRun'
import { applyLoginShellPath, detectClaude, execCapture } from './claude/detect'
import { GitService } from './git/gitService'
import { registerIpc } from './ipc'
import { BLOCK_CSP, wrapBlockHtml } from './report/blockHtml'
import { Repository } from './store/repository'
import { Store } from './store/store'
import { TaskManager } from './tasks/taskManager'
import { createHarnessServer } from './tools/harnessTools'
import { runVerification } from './verify/verifyRunner'

protocol.registerSchemesAsPrivileged([{ scheme: 'harness-block', privileges: { standard: true, secure: true } }])

let mainWindow: BrowserWindow | null = null

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 700, show: false,
    titleBarStyle: 'hiddenInset', backgroundColor: '#eef0f3',
    webPreferences: { preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)), sandbox: true, contextIsolation: true }
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!(is.dev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))) e.preventDefault()
  })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  return win
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.harness.app')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  await applyLoginShellPath()

  const repo = new Repository(new Store(join(app.getPath('userData'), 'harness')), app.getPath('home'))
  const git = new GitService()
  let claude: ClaudeStatus = await detectClaude(execCapture, (await repo.getSettings()).claudePath)
  const claudeStatus = async (refresh?: boolean) => {
    if (refresh) claude = await detectClaude(execCapture, (await repo.getSettings()).claudePath)
    return claude
  }
  const emit = (e: AppEvent) => mainWindow?.webContents.send(APP_EVENT_CHANNEL, e)

  const tasks = new TaskManager({
    repo, git, emit,
    queryFn: query as unknown as QueryFn,
    createToolServer: createHarnessServer,
    getClaudePath: () => claude.path,
    verify: runVerification
  })
  await tasks.init()

  protocol.handle('harness-block', async (req) => {
    const [taskId, version, blockId] = new URL(req.url).pathname.split('/').filter(Boolean)
    try {
      const report = await tasks.getReport(taskId, Number(version))
      const block = report.input.custom_blocks.find((b) => b.id === blockId)
      if (!block) return new Response('not found', { status: 404 })
      return new Response(wrapBlockHtml(block), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': BLOCK_CSP } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  registerIpc({ win: () => mainWindow, repo, git, tasks, claudeStatus, emitRepos: (repos) => emit({ type: 'repos', repos }) })

  mainWindow = createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

**Step 5: preload**

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { APP_EVENT_CHANNEL, type AppEvent, type HarnessBridge } from '@shared/ipc'

const bridge: HarnessBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: AppEvent) => cb(ev)
    ipcRenderer.on(APP_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(APP_EVENT_CHANNEL, listener)
  }
}

contextBridge.exposeInMainWorld('harness', bridge)
```

```ts
// src/preload/index.d.ts
import type { HarnessBridge } from '@shared/ipc'

declare global {
  interface Window { harness: HarnessBridge }
}
export {}
```

注意 preload 是 sandbox 下的 CJS，`@shared/ipc` 只用到常數與型別，會被打包進 preload，沒問題。

**Step 6: 驗證**

Run: `npx vitest run tests/main/blockHtml.test.ts` → 2 passed
Run: `npm run typecheck` → PASS
Run: `npm run dev` → 視窗正常開啟；在 DevTools Console 執行 `await window.harness.invoke('claude:status')` → 回傳 `{ found: true, loggedIn: true, subscriptionType: 'max', ... }`；`await window.harness.invoke('tasks:list')` → `[]`

**Step 7: Commit**

```bash
git add src/main src/preload tests/main/blockHtml.test.ts
git commit -m "feat(main): wire IPC, sandboxed custom block protocol and preload bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Phase 4：Renderer（src/renderer/src）

畫面樣式以 `docs/design/*.dc.html` 為準：每個元件的間距、圓角、字級對照設計稿的 inline style，顏色只用 Task 2 的 tokens。下列程式碼已依設計稿換算成 Tailwind class。

### Task 26：API 封裝、全域 store、階段工具

**Files:**
- Create: `src/renderer/src/api.ts`
- Create: `src/renderer/src/store.ts`
- Create: `src/renderer/src/lib/stage.ts`
- Create: `src/renderer/src/components/ui.tsx`
- Test: `tests/renderer/stage.test.ts`、`tests/renderer/store.test.ts`

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
    expect(taskStatusLabel(makeTask({ status: 'implementing', plan: [{ id: 's1', title: 'a', status: 'done' }, { id: 's2', title: 'b', status: 'running' }] })).text).toBe('實作中 · 1/2')
    expect(taskStatusLabel(makeTask({ status: 'reviewing', reportVersions: [1, 2] })).text).toBe('待審閱報告 · v2')
    expect(taskStatusLabel(makeTask({ questions: [{ id: 'q1', text: '?', options: [], allowFreeText: true, status: 'answered', followups: [], askedAt: '' }, { id: 'q2', text: '?', options: [], allowFreeText: true, status: 'open', followups: [], askedAt: '' }] })).text).toBe('釐清中 · 問題 2')
  })
})
```

```ts
// tests/renderer/store.test.ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({ call: vi.fn(), onEvent: vi.fn(() => () => {}) }))
import { useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

beforeEach(() => useStore.setState({ tasks: {}, timelines: {}, feedback: {} }))

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
    expect(useStore.getState().feedback.a).toEqual([{ anchor: 'diff:a.ts:3', label: 'a.ts:3', text: 'y' }])
    s.removeFeedback('a', 'diff:a.ts:3')
    expect(useStore.getState().feedback.a).toEqual([])
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
  init(): Promise<void>
  apply(e: AppEvent): void
  open(view: View): Promise<void>
  act<T>(fn: () => Promise<T>): Promise<T | undefined>
  setActiveBranch(taskId: string, branchId?: string): void
  addFeedback(taskId: string, item: FeedbackItem): void
  removeFeedback(taskId: string, anchor: string): void
  clearFeedback(taskId: string): void
  dismissToast(): void
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  repos: [],
  tasks: {},
  timelines: {},
  view: { kind: 'new' },
  activeBranch: {},
  feedback: {},

  async init() {
    onEvent((e) => get().apply(e))
    const [claude, settings, repos, tasks] = await Promise.all([
      call('claude:status'), call('settings:get'), call('repos:list'), call('tasks:list')
    ])
    set({ claude, settings, repos, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), ready: true })
    const first = tasks.find((t) => t.status !== 'discarded' && t.status !== 'done')
    if (first) await get().open({ kind: 'task', taskId: first.id })
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
      const events = await call('tasks:timeline', view.taskId)
      set((s) => ({ timelines: { ...s.timelines, [view.taskId]: events } }))
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

  setActiveBranch: (taskId, branchId) => set((s) => ({ activeBranch: { ...s.activeBranch, [taskId]: branchId } })),
  addFeedback: (taskId, item) => set((s) => ({
    feedback: { ...s.feedback, [taskId]: [...(s.feedback[taskId] ?? []).filter((f) => f.anchor !== item.anchor), item] }
  })),
  removeFeedback: (taskId, anchor) => set((s) => ({ feedback: { ...s.feedback, [taskId]: (s.feedback[taskId] ?? []).filter((f) => f.anchor !== anchor) } })),
  clearFeedback: (taskId) => set((s) => ({ feedback: { ...s.feedback, [taskId]: [] } })),
  dismissToast: () => set({ toast: undefined })
}))
```

**Step 5: lib/stage.ts**

```ts
// src/renderer/src/lib/stage.ts
import type { Task } from '@shared/types'
import type { Tone } from '../components/ui'

export type Stage = 'clarify' | 'spec' | 'implement' | 'report'
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'clarify', label: '釐清' }, { id: 'spec', label: '規格' }, { id: 'implement', label: '實作' }, { id: 'report', label: '報告' }
]
const ORDER: Stage[] = ['clarify', 'spec', 'implement', 'report']

export function currentStage(t: Task): Stage {
  switch (t.status) {
    case 'clarifying': return 'clarify'
    case 'spec_review': return 'spec'
    case 'implementing': return 'implement'
    case 'reviewing':
    case 'done': return 'report'
    case 'discarded': return t.reportVersions.length ? 'report' : t.plan.length ? 'implement' : t.specs.length ? 'spec' : 'clarify'
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
      return { text: `釐清中 · 問題 ${idx >= 0 ? idx + 1 : Math.max(1, t.questions.length)}`, tone: 'brand' }
    }
    case 'spec_review': return { text: '規格待核准', tone: 'brand' }
    case 'implementing': {
      if (t.runState === 'finalizing') return { text: '整理報告中', tone: 'progress' }
      const done = t.plan.filter((s) => s.status === 'done').length
      return { text: t.plan.length ? `實作中 · ${done}/${t.plan.length}` : '實作中', tone: 'progress' }
    }
    case 'reviewing': return { text: `待審閱報告 · v${t.reportVersions.at(-1)}`, tone: 'review' }
    case 'done': return { text: t.prUrl ? '已開 PR' : '已合併', tone: 'muted' }
    case 'discarded': return { text: '已丟棄', tone: 'muted' }
  }
}
```

**Step 6: components/ui.tsx**

```tsx
// src/renderer/src/components/ui.tsx
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, SVGProps } from 'react'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type Variant = 'primary' | 'secondary' | 'dark' | 'ghost' | 'danger'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white font-medium hover:bg-brand-hover',
  secondary: 'bg-fill text-ink-2 hover:bg-chip',
  dark: 'bg-ink text-white font-medium hover:bg-black',
  ghost: 'bg-transparent text-ink-2 hover:bg-fill',
  danger: 'bg-transparent text-danger hover:bg-red-50'
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-9 rounded-[10px] px-3 text-xs' : 'h-11 rounded-xl px-4 text-[13px]',
        VARIANTS[variant], className
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
  neutral: 'bg-fill text-ink-2', brand: 'bg-brand-soft text-brand-ink', decision: 'bg-decision text-decision-ink',
  progress: 'bg-decision text-progress', review: 'bg-blue-50 text-review', danger: 'bg-red-50 text-danger', muted: 'bg-fill text-muted'
}
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-2', brand: 'text-brand', decision: 'text-decision-ink', progress: 'text-progress',
  review: 'text-review', danger: 'text-danger', muted: 'text-muted'
}

export function Pill({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs', TONES[tone], className)}>{children}</span>
}

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-label="處理中" className={cx('inline-block size-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent', className)} />
}

export function Avatar() {
  return <span aria-hidden className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand">C</span>
}

export const inputClass = 'h-[42px] rounded-xl border border-line bg-surface px-3.5 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-brand'
export const textareaClass = 'rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-muted-2 focus:border-brand'

type IconProps = SVGProps<SVGSVGElement>
const svg = (p: IconProps, children: ReactNode) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>{children}</svg>
)
export const Icons = {
  Plus: (p: IconProps) => svg(p, <path d="M12 5v14M5 12h14" />),
  Check: (p: IconProps) => svg(p, <path d="M5 12l5 5L20 7" />),
  Branch: (p: IconProps) => svg(p, <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-6 4-12 8" /></>),
  Send: (p: IconProps) => svg(p, <path d="M12 19V5M5 12l7-7 7 7" />),
  Stop: (p: IconProps) => svg(p, <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />),
  Arrow: (p: IconProps) => svg(p, <path d="M5 12h14M13 6l6 6-6 6" />),
  Back: (p: IconProps) => svg(p, <path d="M15 6l-6 6 6 6" />),
  Folder: (p: IconProps) => svg(p, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  Info: (p: IconProps) => svg(p, <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>),
  Comment: (p: IconProps) => svg(p, <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />),
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

**Step 1: Markdown.tsx**

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { call } from '../api'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_p]:m-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={(e) => { e.preventDefault(); if (href) void call('shell:openExternal', href) }}>{children}</a>
          ),
          pre: ({ children }) => <pre className="overflow-x-auto rounded-xl bg-code p-3 text-[12.5px] text-code-ink [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-code-ink">{children}</pre>
        }}
      >{text}</ReactMarkdown>
    </div>
  )
}
```

**Step 2: Sidebar.tsx（對照 `docs/design/StyleB.dc.html` 的 `<nav>`）**

```tsx
import { MODELS, type Task } from '@shared/types'
import { call } from '../api'
import { taskStatusLabel } from '../lib/stage'
import { useStore } from '../store'
import { Button, cx, Icons, TONE_TEXT } from './ui'

function RepoBadge({ name, active }: { name: string; active: boolean }) {
  return (
    <span className={cx('flex size-[22px] items-center justify-center rounded-md text-[11px]', active ? 'bg-brand-soft text-brand' : 'bg-chip text-muted')}>
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
      className={cx('flex flex-col rounded-xl px-3 py-2.5 text-left', active ? 'bg-surface shadow-raised' : 'hover:bg-white/60')}
    >
      <span className={cx('text-[13px]', active ? 'font-medium text-ink' : 'text-ink-2')}>{task.title}</span>
      <span className={cx('text-xs', TONE_TEXT[s.tone])}>{s.text}</span>
    </button>
  )
}

export function Sidebar() {
  const { repos, tasks, view, open, claude, settings, act } = useStore()
  const list = Object.values(tasks).filter((t) => t.status !== 'discarded').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const model = MODELS.find((m) => m.id === settings?.defaultModel)?.label ?? ''
  return (
    <nav aria-label="Repo 與任務" className="flex w-[236px] flex-none flex-col gap-[18px] px-1.5 py-2">
      <Button variant="primary" className="h-[42px]" onClick={() => void open({ kind: 'new' })}><Icons.Plus />新任務</Button>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto">
        {repos.map((r) => {
          const ts = list.filter((t) => t.repoId === r.id)
          const hasActive = ts.some((t) => view.kind === 'task' && view.taskId === t.id)
          return (
            <div key={r.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-2.5 py-1 text-[13px] font-bold">
                <RepoBadge name={r.name} active={hasActive} />{r.name}
                <span className="ml-auto text-xs font-normal text-muted-2">{ts.length || ''}</span>
              </div>
              {ts.map((t) => (
                <TaskItem key={t.id} task={t} active={view.kind === 'task' && view.taskId === t.id} onClick={() => void open({ kind: 'task', taskId: t.id })} />
              ))}
            </div>
          )
        })}
        <button type="button" className="flex h-10 items-center gap-2 px-2.5 text-[13px] text-muted hover:text-ink" onClick={() => void act(() => call('repos:pick'))}>
          <Icons.Plus width={14} height={14} />加入 repo
        </button>
      </div>
      <button type="button" onClick={() => void open({ kind: 'settings' })} className="flex items-center gap-2.5 rounded-xl bg-chip p-3 text-left text-xs text-ink-2">
        <span className={cx('size-2 rounded-full', claude?.loggedIn ? 'bg-green-600' : 'bg-danger')} />
        {claude?.loggedIn ? `${model} · 訂閱方案` : 'Claude Code 未就緒'}
        <span className="ml-auto text-muted">設定</span>
      </button>
    </nav>
  )
}
```

**Step 3: StageNav.tsx**

```tsx
import type { Task } from '@shared/types'
import { currentStage, reachable, type Stage, STAGES } from '../lib/stage'
import { cx } from './ui'

export function StageNav({ task, shown, onSelect }: { task: Task; shown: Stage; onSelect: (s: Stage) => void }) {
  const current = currentStage(task)
  const order = STAGES.map((s) => s.id)
  return (
    <div role="tablist" aria-label="任務階段" className="ml-auto flex items-center gap-1 rounded-full bg-fill p-1 text-xs">
      {STAGES.map((s, i) => {
        const can = reachable(task, s.id)
        const passed = order.indexOf(s.id) < order.indexOf(current)
        return (
          <button
            key={s.id} type="button" role="tab" aria-selected={shown === s.id} disabled={!can}
            onClick={() => onSelect(s.id)}
            className={cx('rounded-full px-3 py-1', shown === s.id ? 'bg-surface font-medium text-brand shadow-[0_1px_2px_rgba(16,24,40,0.08)]' : can ? 'text-brand' : 'text-muted-2')}
          >
            {passed && shown !== s.id ? '✓' : i + 1} {s.label}
          </button>
        )
      })}
    </div>
  )
}
```

**Step 4: Toast.tsx**

```tsx
import { useEffect } from 'react'
import { useStore } from '../store'
import { Icons } from './ui'

export function Toast() {
  const { toast, dismissToast } = useStore()
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dismissToast, 8000)
    return () => clearTimeout(t)
  }, [toast, dismissToast])
  if (!toast) return null
  return (
    <div role="alert" className="fixed right-5 bottom-5 z-50 flex max-w-md items-start gap-3 rounded-2xl bg-ink px-4 py-3 text-[13px] text-white shadow-dialog">
      <span className="flex-1 whitespace-pre-wrap">{toast}</span>
      <button type="button" aria-label="關閉" onClick={dismissToast} className="text-white/70 hover:text-white"><Icons.X width={14} height={14} /></button>
    </div>
  )
}
```

**Step 5: TaskScreen.tsx（骨架）**

```tsx
import { useEffect, useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  const [stage, setStage] = useState<Stage | null>(null)
  useEffect(() => setStage(null), [taskId, task?.status])
  if (!task) return null
  const shown = stage ?? currentStage(task)
  const nav = <StageNav task={task} shown={shown} onSelect={(s) => setStage(s === currentStage(task) ? null : s)} />
  // Task 29–33 依 shown 切換到 ClarifyScreen / SpecScreen / ImplementScreen / ReportScreen
  return <main className="flex-1 rounded-2xl bg-surface p-7 shadow-card"><div className="flex items-center gap-4"><span className="text-lg font-bold">{task.title}</span>{nav}</div></main>
}
```

**Step 6: App.tsx**

```tsx
import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Toast } from './components/Toast'
import { TaskScreen } from './screens/TaskScreen'
import { useStore } from './store'

function TitleBar({ title }: { title: string }) {
  return <div className="drag flex h-11 flex-none items-center justify-center text-xs text-muted">{title}</div>
}

export default function App() {
  const { ready, init, view, tasks, repos } = useStore()
  useEffect(() => { void init() }, [init])
  if (!ready) return <div className="flex h-full items-center justify-center text-muted">載入中…</div>
  const task = view.kind === 'task' ? tasks[view.taskId] : undefined
  const repo = task ? repos.find((r) => r.id === task.repoId) : undefined
  const title = view.kind === 'settings' ? '設定' : view.kind === 'new' ? '新任務' : `${repo?.name ?? ''} · ${task?.title ?? ''}`
  return (
    <div className="flex h-full flex-col">
      <TitleBar title={title} />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <Sidebar />
        <div className="flex min-w-0 flex-1 gap-3">
          {view.kind === 'task' && <TaskScreen taskId={view.taskId} />}
          {/* Task 28 加入 NewTaskScreen，Task 34 加入 SettingsScreen */}
        </div>
      </div>
      <Toast />
    </div>
  )
}
```

**Step 7: 驗證**

Run: `npm run typecheck` → PASS
Run: `npm run dev` → 左側欄出現「新任務」按鈕、「加入 repo」、底部 Claude 狀態；點「加入 repo」選一個 git 資料夾後出現在側欄。

**Step 8: Commit**

```bash
git add src/renderer/src
git commit -m "feat(ui): add app shell, sidebar, stage nav, markdown and toast

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 28：新任務畫面

**Files:**
- Create: `src/renderer/src/screens/NewTaskScreen.tsx`
- Create: `src/renderer/src/components/ClaudeBanner.tsx`
- Modify: `src/renderer/src/App.tsx`（`view.kind === 'new'` 時渲染 `<NewTaskScreen />`）

**Step 1: ClaudeBanner.tsx**（Claude Code 未就緒時顯示）

```tsx
import { useStore } from '../store'
import { call } from '../api'
import { Button, Icons } from './ui'

export function ClaudeBanner() {
  const { claude, act } = useStore()
  if (claude?.loggedIn) return null
  return (
    <div role="alert" className="flex items-center gap-3 rounded-xl bg-red-50 px-3.5 py-3 text-[13px] text-danger">
      <Icons.Info />
      <span className="flex-1">{claude?.error ?? '正在檢查 Claude Code…'}</span>
      <Button size="sm" onClick={() => void act(async () => useStore.setState({ claude: await call('claude:status', true) }))}>重新檢查</Button>
    </div>
  )
}
```

**Step 2: NewTaskScreen.tsx（對照 `docs/design/B1-NewTask.dc.html`）**

```tsx
import { useEffect, useState } from 'react'
import { MODELS, type ModelId } from '@shared/types'
import { call } from '../api'
import { ClaudeBanner } from '../components/ClaudeBanner'
import { Button, cx, Icons, inputClass, textareaClass } from '../components/ui'
import { useStore } from '../store'

export function NewTaskScreen() {
  const { repos, settings, claude, act, open } = useStore()
  const [repoId, setRepoId] = useState(repos[0]?.id)
  const [request, setRequest] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [model, setModel] = useState<ModelId>(settings?.defaultModel ?? 'claude-opus-5-5')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (!repoId && repos[0]) setRepoId(repos[0].id) }, [repos, repoId])
  useEffect(() => {
    if (!repoId) return
    void act(async () => {
      const r = await call('repos:branches', repoId)
      setBranches(r.branches)
      setBase(r.current)
    })
  }, [repoId, act])

  const submit = async () => {
    if (!repoId || !request.trim()) return
    setBusy(true)
    const task = await act(() => call('tasks:create', { repoId, request, baseBranch: base, model }))
    setBusy(false)
    if (task) await open({ kind: 'task', taskId: task.id })
  }

  return (
    <main className="flex flex-1 flex-col items-center overflow-y-auto rounded-2xl bg-surface px-7 py-14 shadow-card">
      <div className="flex w-full max-w-[680px] flex-col gap-7">
        <ClaudeBanner />
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[26px] font-bold">想改什麼？</h1>
          <span className="text-muted">選一個 repo，用一兩句話描述需求。Claude 會先讀程式碼，再用問題跟你釐清細節。</span>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-[13px] font-medium">Repo</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {repos.map((r) => (
              <label key={r.id} className={cx('flex cursor-pointer items-center gap-3 rounded-[14px] p-3.5', repoId === r.id ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2')}>
                <input type="radio" name="repo" checked={repoId === r.id} onChange={() => setRepoId(r.id)} className="accent-brand" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{r.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{r.path}</span>
                </span>
              </label>
            ))}
          </div>
          <button type="button" onClick={() => void act(async () => { const r = await call('repos:pick'); if (r) setRepoId(r.id) })}
            className="flex h-10 items-center gap-2 self-start rounded-xl border border-dashed border-[#b8c0cc] bg-surface px-3.5 text-[13px] text-ink-2">
            <Icons.Folder width={14} height={14} />選擇其他資料夾…
          </button>
        </fieldset>

        <label className="flex flex-col gap-2.5">
          <span className="text-[13px] font-medium">需求</span>
          <textarea rows={5} value={request} onChange={(e) => setRequest(e.target.value)}
            placeholder="例如：登入 API 要加上失敗次數限制，連續失敗太多次就鎖帳號。" className={cx(textareaClass, 'rounded-[14px] px-4 py-3.5 text-sm')} />
        </label>

        <div className="flex flex-wrap gap-4">
          <label className="flex min-w-[200px] flex-1 flex-col gap-2">
            <span className="text-[13px] font-medium">從哪個分支開始</span>
            <select value={base} onChange={(e) => setBase(e.target.value)} className={inputClass}>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="flex min-w-[200px] flex-1 flex-col gap-2">
            <span className="text-[13px] font-medium">模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value as ModelId)} className={inputClass}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}（{m.hint}）</option>)}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3 rounded-xl bg-fill-2 px-3.5 py-3 text-[13px] text-ink-2">
          <Icons.Info className="flex-none text-brand" />
          <span>Harness 會建立獨立的 git worktree。釐清階段 Claude 只會讀檔案；規格經你核准後，才會在 worktree 裡改程式碼。</span>
        </div>

        <Button variant="primary" className="h-[46px] self-end px-6" disabled={!claude?.loggedIn || !repoId || !request.trim() || !base || busy} onClick={() => void submit()}>
          {busy ? '建立中…' : '開始釐清'}<Icons.Arrow />
        </Button>
      </div>
    </main>
  )
}
```

**Step 3: 驗證**

Run: `npm run typecheck` → PASS
Run: `npm run dev` → 新任務畫面與設計稿一致；未加入 repo 時「開始釐清」為停用。

**Step 4: Commit**

```bash
git add src/renderer/src
git commit -m "feat(ui): add new task screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 29：問題卡片與時間軸

**Files:**
- Create: `src/renderer/src/components/QuestionCard.tsx`
- Create: `src/renderer/src/components/Timeline.tsx`
- Test: `tests/renderer/QuestionCard.test.tsx`

**Step 1: 寫失敗測試**

```tsx
// tests/renderer/QuestionCard.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({ call: vi.fn(async () => ({ id: 'b1' })), onEvent: vi.fn(() => () => {}), errorText: String }))
import { call } from '@renderer/api'
import { QuestionCard } from '@renderer/components/QuestionCard'
import type { Question } from '@shared/types'
import { makeTask } from '../fixtures/task'

const q: Question = {
  id: 'q3', text: '達到上限後要怎麼處理？', status: 'open', allowFreeText: true, askedAt: '',
  options: [{ id: 'lock15', label: '鎖定 15 分鐘', description: '自動解除' }, { id: 'email', label: 'email 重設才解鎖' }],
  recommendedOptionId: 'lock15',
  followups: [{ role: 'user', text: '會洩漏帳號嗎？' }, { role: 'assistant', text: '一律回 429 就不會。' }]
}
const task = makeTask({ questions: [q] })

beforeEach(() => vi.mocked(call).mockClear())

describe('QuestionCard', () => {
  test('預設選建議選項，確認後送出答案', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.getByRole('radio', { name: /鎖定 15 分鐘/ })).toBeChecked()
    expect(screen.getByText('建議')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /email/ }))
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', { optionId: 'email', text: undefined })
  })

  test('選「其他」時送出自由文字', async () => {
    render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('radio', { name: /其他/ }))
    await userEvent.type(screen.getByRole('textbox', { name: '自己描述' }), '鎖 30 分鐘')
    await userEvent.click(screen.getByRole('button', { name: '確認答案' }))
    expect(call).toHaveBeenCalledWith('tasks:answer', 't1', 'q3', { optionId: undefined, text: '鎖 30 分鐘' })
  })

  test('顯示反問紀錄並可再次反問', async () => {
    render(<QuestionCard task={task} question={q} />)
    expect(screen.getByText('一律回 429 就不會。')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '反問' }), '那 IP 呢？{Enter}')
    expect(call).toHaveBeenCalledWith('tasks:counter', 't1', 'q3', '那 IP 呢？')
  })

  test('升級成分岔', async () => {
    render(<QuestionCard task={task} question={q} />)
    await userEvent.click(screen.getByRole('button', { name: '升級成分岔' }))
    expect(call).toHaveBeenCalledWith('branch:open', 't1', { title: '達到上限後要怎麼處理？', fromQuestionId: 'q3' })
  })

  test('Claude 執行中時停用操作', () => {
    render(<QuestionCard task={{ ...task, runState: 'running' }} question={q} />)
    expect(screen.getByRole('button', { name: '確認答案' })).toBeDisabled()
  })
})
```

**Step 2: 確認失敗**

**Step 3: QuestionCard.tsx（對照 `StyleB.dc.html` 的「目前問題」section）**

```tsx
import { type FormEvent, useState } from 'react'
import type { Question, Task } from '@shared/types'
import { call } from '../api'
import { useStore } from '../store'
import { Avatar, Button, cx, inputClass, Spinner, textareaClass } from './ui'

const OTHER = '__other'

export function QuestionCard({ task, question: q, readOnly }: { task: Task; question: Question; readOnly?: boolean }) {
  const { act, setActiveBranch } = useStore()
  const [selected, setSelected] = useState<string>(q.recommendedOptionId ?? q.options[0]?.id ?? OTHER)
  const [freeText, setFreeText] = useState('')
  const [counter, setCounter] = useState('')
  const busy = task.runState === 'running' || task.runState === 'waiting_permission' || task.runState === 'finalizing'
  const disabled = readOnly || busy || q.status !== 'open'
  const waitingCounter = busy && q.followups.at(-1)?.role === 'user'

  const confirm = () => act(() => call('tasks:answer', task.id, q.id, {
    optionId: selected === OTHER ? undefined : selected,
    text: freeText.trim() || undefined
  }))
  const ask = (e: FormEvent) => {
    e.preventDefault()
    if (!counter.trim()) return
    const text = counter.trim()
    setCounter('')
    void act(() => call('tasks:counter', task.id, q.id, text))
  }
  const upgrade = async () => {
    const b = await act(() => call('branch:open', task.id, { title: q.text.slice(0, 30), fromQuestionId: q.id }))
    if (b) setActiveBranch(task.id, b.id)
  }

  return (
    <section aria-label={`問題：${q.text}`} className="ml-10 flex flex-col gap-3.5 rounded-[18px] bg-surface p-5 shadow-focus">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-brand">問題 {task.questions.indexOf(q) + 1}</span>
        <span className="text-[17px] font-bold">{q.text}</span>
        {q.context && <span className="text-[13px] text-muted">{q.context}</span>}
      </div>

      <div role="radiogroup" className="grid grid-cols-2 gap-2.5">
        {q.options.map((o) => (
          <label key={o.id} className={cx('flex cursor-pointer gap-2.5 rounded-[14px] p-3.5', selected === o.id ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2')}>
            <input type="radio" name={`q-${q.id}`} checked={selected === o.id} onChange={() => setSelected(o.id)} disabled={disabled} className="mt-1.5 accent-brand" />
            <span className="flex flex-col gap-1">
              <span className="font-medium">{o.label}</span>
              {(o.description || o.id === q.recommendedOptionId) && (
                <span className="text-xs text-brand-muted">
                  {o.id === q.recommendedOptionId && <span className="mr-1 font-medium">建議</span>}
                  {o.description}
                </span>
              )}
            </span>
          </label>
        ))}
        {q.allowFreeText && (
          <label className={cx('flex cursor-pointer gap-2.5 rounded-[14px] p-3.5', selected === OTHER ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2')}>
            <input type="radio" name={`q-${q.id}`} checked={selected === OTHER} onChange={() => setSelected(OTHER)} disabled={disabled} className="mt-1.5 accent-brand" />
            <span className="text-muted">其他，自己描述…</span>
          </label>
        )}
      </div>

      {(selected === OTHER || freeText) && (
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">自己描述</span>
          <textarea aria-label="自己描述" rows={2} value={freeText} onChange={(e) => setFreeText(e.target.value)} disabled={disabled}
            placeholder={selected === OTHER ? '描述你的答案' : '補充說明（選填）'} className={textareaClass} />
        </label>
      )}

      {q.followups.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-[14px] bg-fill-2 px-3.5 py-3 text-[13px]">
          <span className="text-xs font-medium text-muted">你反問了 {q.followups.filter((f) => f.role === 'user').length} 次</span>
          {q.followups.map((f, i) => (
            <div key={i} className="flex gap-2">
              {f.role === 'user' ? <span className="flex-none text-muted">你</span> : <Avatar />}
              <span className="whitespace-pre-wrap">{f.text}</span>
            </div>
          ))}
          {waitingCounter && <span className="flex items-center gap-2 text-muted"><Spinner />Claude 正在回答…</span>}
        </div>
      )}

      {!readOnly && q.status === 'open' && (
        <form onSubmit={ask} className="flex flex-wrap items-center gap-2.5">
          <label className="flex min-w-[220px] flex-1">
            <span className="sr-only">反問</span>
            <input aria-label="反問" value={counter} onChange={(e) => setCounter(e.target.value)} disabled={busy}
              placeholder="還有疑問？在這裡反問…" className={cx(inputClass, 'flex-1')} />
          </label>
          <Button disabled={busy} onClick={() => void upgrade()}>升級成分岔</Button>
          <Button variant="primary" disabled={disabled || (selected === OTHER && !freeText.trim())} onClick={() => void confirm()}>確認答案</Button>
        </form>
      )}
    </section>
  )
}

export function AnsweredQuestionRow({ question: q, onOpen }: { question: Question; onOpen?: () => void }) {
  const label = q.answer?.optionId ? q.options.find((o) => o.id === q.answer?.optionId)?.label : undefined
  return (
    <button type="button" onClick={onOpen} className="ml-10 flex items-center gap-2.5 rounded-xl bg-fill-2 px-4 py-2.5 text-left text-[13px]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand)" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M5 12l5 5L20 7" /></svg>
      <span className="text-muted">{q.text}</span>
      <span className="ml-auto font-medium">{[label, q.answer?.text].filter(Boolean).join('；')}</span>
    </button>
  )
}
```

**Step 4: Timeline.tsx**

時間軸只顯示指定 channel 的事件；連續的工具呼叫合併成一列摘要。

```tsx
import { useState } from 'react'
import { parseTagged } from '@shared/protocol'
import type { Channel, Task, TimelineEvent } from '@shared/types'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import { AnsweredQuestionRow, QuestionCard } from './QuestionCard'
import { Avatar, Icons, Spinner } from './ui'

const TOOL_LABEL: Record<string, string> = { Read: '讀取', Glob: '搜尋檔名', Grep: '搜尋內容', Edit: '編輯', Write: '寫入', MultiEdit: '編輯', Bash: '指令', WebFetch: '讀取網頁', WebSearch: '搜尋網路', Agent: '子代理', Task: '子代理', TodoWrite: '待辦' }

export function toolSummary(tool: NonNullable<TimelineEvent['tool']>): string {
  const i = tool.input ?? {}
  const target = (i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? '') as string
  return `${TOOL_LABEL[tool.name] ?? tool.name}${target ? ` ${String(target)}` : ''}`
}

type Item = { kind: 'event'; e: TimelineEvent } | { kind: 'tools'; events: TimelineEvent[] }

function group(events: TimelineEvent[]): Item[] {
  const out: Item[] = []
  for (const e of events) {
    const last = out.at(-1)
    if (e.kind === 'tool_call') {
      if (last?.kind === 'tools') last.events.push(e)
      else out.push({ kind: 'tools', events: [e] })
    } else out.push({ kind: 'event', e })
  }
  return out
}

function ToolGroup({ events }: { events: TimelineEvent[] }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const e of events) { const l = TOOL_LABEL[e.tool!.name] ?? e.tool!.name; counts.set(l, (counts.get(l) ?? 0) + 1) }
  return (
    <div className="ml-10 flex flex-col gap-1 text-xs text-muted">
      <button type="button" onClick={() => setOpen(!open)} className="self-start hover:text-ink">
        {[...counts].map(([l, n]) => `${l} ${n} 次`).join(' · ')} {open ? '▴' : '▾'}
      </button>
      {open && events.map((e) => <code key={e.id} className="self-start">{toolSummary(e.tool!)}</code>)}
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  const tagged = parseTagged(text)
  const shown = tagged ? tagged.body.split('\n')[0] : text
  return <div className="max-w-[78%] self-end whitespace-pre-wrap rounded-[18px_18px_6px_18px] bg-fill px-4 py-3">{shown}</div>
}

export function Timeline({ task, channel, events, readOnly, onBranchFrom, onOpenStage }: {
  task: Task
  channel: Channel
  events: TimelineEvent[]
  readOnly?: boolean
  onBranchFrom?: (text: string) => void
  onOpenStage?: (stage: 'spec' | 'report') => void
}) {
  const decisions = task.decisions
  const items = group(events.filter((e) => e.channel === channel))
  return (
    <div className="flex flex-col gap-5">
      {items.map((it, idx) => {
        if (it.kind === 'tools') return <ToolGroup key={it.events[0].id} events={it.events} />
        const e = it.e
        switch (e.kind) {
          case 'user_text': return <UserBubble key={e.id} text={e.text ?? ''} />
          case 'assistant_text': return (
            <div key={e.id} className="group flex gap-3">
              <Avatar />
              <div className="min-w-0 flex-1"><Markdown text={e.text ?? ''} /></div>
              {onBranchFrom && !readOnly && (
                <button type="button" aria-label="從這則訊息分岔" onClick={() => onBranchFrom(e.text ?? '')}
                  className="invisible h-7 flex-none rounded-lg px-2 text-xs text-muted group-hover:visible hover:bg-fill"><Icons.Branch width={14} height={14} /></button>
              )}
            </div>
          )
          case 'question': {
            const q = task.questions.find((x) => x.id === e.ref)
            if (!q) return null
            return q.status === 'open' ? <QuestionCard key={e.id} task={task} question={q} readOnly={readOnly} /> : <AnsweredQuestionRow key={e.id} question={q} />
          }
          case 'decision': {
            const d = decisions.find((x) => x.id === e.ref)
            if (!d) return null
            const b = task.branches.find((x) => x.id === d.source.ref)
            return (
              <div key={e.id} className="ml-10 flex flex-col gap-1.5 rounded-[14px] bg-decision px-4 py-3.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-decision-ink"><Icons.Branch width={14} height={14} />分岔「{b?.title ?? d.source.ref}」的結論</span>
                <span>{d.text}</span>
                {d.rationale && <span className="text-[13px] text-decision-body">原因：{d.rationale}</span>}
                {!!d.deferred?.length && <span className="text-[13px] text-decision-body">延後：{d.deferred.join('；')}</span>}
              </div>
            )
          }
          case 'spec': return (
            <button key={e.id} type="button" onClick={() => onOpenStage?.('spec')} className="ml-10 self-start rounded-xl bg-brand-tint px-4 py-2.5 text-[13px] text-brand-ink">
              規格草稿 v{e.ref} 已產生 → 查看
            </button>
          )
          case 'report': return (
            <button key={e.id} type="button" onClick={() => onOpenStage?.('report')} className="ml-10 self-start rounded-xl bg-blue-50 px-4 py-2.5 text-[13px] text-review">
              變更報告 v{e.ref} 已產生 → 查看
            </button>
          )
          case 'tool_result': return <div key={e.id} className="ml-10 text-xs text-danger">工具錯誤：{e.text}</div>
          case 'system': return <div key={e.id} className="self-center rounded-full bg-fill px-3 py-1 text-xs text-muted">{e.text}</div>
          default: return <span key={idx} />
        }
      })}
    </div>
  )
}

export function RunStatus({ task, onResume }: { task: Task; onResume: () => void }) {
  if (task.runState === 'running') return <div className="ml-10 flex items-center gap-2 text-[13px] text-muted"><Spinner />Claude 正在處理…</div>
  if (task.runState === 'finalizing') return <div className="ml-10 flex items-center gap-2 text-[13px] text-muted"><Spinner />正在整理 diff 並執行驗證指令…</div>
  if (task.runState === 'interrupted' || task.runState === 'error' || task.error) {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-xl bg-red-50 px-3.5 py-3 text-[13px] text-danger">
        <span className="flex-1">{task.runState === 'interrupted' ? '上一次執行被中斷了。' : task.error ?? '發生錯誤'}</span>
        {(task.runState === 'interrupted' || task.runState === 'error') && <button type="button" onClick={onResume} className="font-medium underline">繼續</button>}
      </div>
    )
  }
  return null
}

export function useTimeline(taskId: string) {
  return useStore((s) => s.timelines[taskId]) ?? []
}
```

**Step 5: 確認通過** — `npx vitest run tests/renderer/QuestionCard.test.tsx` → 5 passed

**Step 6: Commit**

```bash
git add src/renderer/src/components tests/renderer/QuestionCard.test.tsx
git commit -m "feat(ui): add question card with counter-questions and timeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 30：分岔面板與釐清畫面

**Files:**
- Create: `src/renderer/src/components/BranchPanel.tsx`
- Create: `src/renderer/src/components/Composer.tsx`
- Create: `src/renderer/src/screens/ClarifyScreen.tsx`
- Modify: `src/renderer/src/screens/TaskScreen.tsx`
- Test: `tests/renderer/BranchPanel.test.tsx`

**Step 1: 寫失敗測試**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({ call: vi.fn(async () => undefined), onEvent: vi.fn(() => () => {}), errorText: String }))
import { call } from '@renderer/api'
import { BranchPanel } from '@renderer/components/BranchPanel'
import { useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

const task = makeTask({
  branches: [
    { id: 'b1', title: '計數存放位置', status: 'concluded', running: false, createdAt: '', conclusion: { decision: '用 Redis', rationale: 'x', deferred: [] } },
    { id: 'b2', title: '通知使用者', status: 'concluding', running: false, createdAt: '', conclusion: { decision: '寄通知信', rationale: '避免騷擾', deferred: ['重設連結'] } }
  ]
})

beforeEach(() => { vi.mocked(call).mockClear(); useStore.setState({ activeBranch: { t1: 'b2' }, timelines: { t1: [] } }) })

test('顯示結論預覽，確認後帶回主線', async () => {
  render(<BranchPanel task={task} events={[]} />)
  expect(screen.getByText('寄通知信')).toBeInTheDocument()
  expect(screen.getByText(/重設連結/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '確認並帶回主線' }))
  expect(call).toHaveBeenCalledWith('branch:confirm', 't1', 'b2', undefined)
})

test('在分岔中送出訊息', async () => {
  useStore.setState({ activeBranch: { t1: 'b2' } })
  render(<BranchPanel task={{ ...task, branches: [{ ...task.branches[1], status: 'open', conclusion: undefined }] }} events={[]} />)
  await userEvent.type(screen.getByRole('textbox', { name: '分岔訊息' }), '再想想{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'branch:b2', '再想想')
  await userEvent.click(screen.getByRole('button', { name: '帶回主線' }))
  expect(call).toHaveBeenCalledWith('branch:conclude', 't1', 'b2')
})
```

**Step 2: 確認失敗**

**Step 3: Composer.tsx**

```tsx
import { type FormEvent, type ReactNode, useState } from 'react'
import { cx, Icons } from './ui'

export function Composer({ placeholder, disabled, onSend, extra, label = '訊息' }: {
  placeholder: string; disabled?: boolean; onSend: (text: string) => void; extra?: ReactNode; label?: string
}) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || disabled) return
    onSend(text.trim())
    setText('')
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-2 rounded-full bg-fill py-2 pr-2 pl-[18px]">
      <label className="flex flex-1">
        <span className="sr-only">{label}</span>
        <input aria-label={label} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder}
          className="h-8 flex-1 border-none bg-transparent text-ink outline-none placeholder:text-muted-2" />
      </label>
      {extra}
      <button type="submit" aria-label="送出" disabled={disabled || !text.trim()}
        className={cx('flex size-10 items-center justify-center rounded-full bg-brand text-white disabled:opacity-40')}>
        <Icons.Send />
      </button>
    </form>
  )
}
```

**Step 4: BranchPanel.tsx（對照 `StyleB.dc.html` 的 `<aside>`）**

```tsx
import { type FormEvent, useState } from 'react'
import type { Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { useStore } from '../store'
import { Markdown } from './Markdown'
import { Button, cx, inputClass, Spinner } from './ui'

export function BranchPanel({ task, events, readOnly }: { task: Task; events: TimelineEvent[]; readOnly?: boolean }) {
  const { act, activeBranch, setActiveBranch } = useStore()
  const [text, setText] = useState('')
  const activeId = activeBranch[task.id] ?? task.branches.find((b) => b.status !== 'concluded')?.id ?? task.branches.at(-1)?.id
  const b = task.branches.find((x) => x.id === activeId)
  const channel = b ? (`branch:${b.id}` as const) : undefined
  const list = channel ? events.filter((e) => e.channel === channel) : []

  const send = (e: FormEvent) => {
    e.preventDefault()
    if (!b || !text.trim()) return
    const t = text.trim()
    setText('')
    void act(() => call('tasks:send', task.id, `branch:${b.id}`, t))
  }

  return (
    <aside aria-label="分岔討論" className="flex w-[340px] flex-none flex-col rounded-2xl bg-surface shadow-card">
      <div className="flex flex-col gap-2.5 px-5 pt-[18px] pb-3">
        <span className="text-[15px] font-bold">分岔討論</span>
        {task.branches.length === 0 ? (
          <span className="text-[13px] text-muted">還沒有分岔。在 Claude 的訊息旁或問題卡片上按「分岔」，就能另開一段討論，結論再帶回主線。</span>
        ) : (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {task.branches.map((x) => (
              <button key={x.id} type="button" onClick={() => setActiveBranch(task.id, x.id)}
                className={cx('rounded-full px-2.5 py-1', x.id === activeId ? 'bg-brand-soft font-medium text-brand-ink' : 'bg-fill text-muted')}>
                {x.title} · {x.status === 'concluded' ? '已帶回' : x.running ? '討論中' : '進行中'}
              </button>
            ))}
          </div>
        )}
      </div>

      {b && (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-2 text-[13px]">
            {b.fromQuestionId && <span className="text-xs text-muted-2">從問題 {task.questions.findIndex((q) => q.id === b.fromQuestionId) + 1} 分出，帶著主線的上下文</span>}
            {list.map((e) => e.kind === 'user_text'
              ? <div key={e.id} className="max-w-[88%] self-end whitespace-pre-wrap rounded-[16px_16px_6px_16px] bg-fill px-3.5 py-2.5">{e.text}</div>
              : e.kind === 'assistant_text' ? <Markdown key={e.id} text={e.text ?? ''} />
              : null)}
            {b.running && <span className="flex items-center gap-2 text-muted"><Spinner />Claude 正在回覆…</span>}
            {b.conclusion && (
              <div className="flex flex-col gap-1 rounded-[14px] bg-decision px-3.5 py-3">
                <span className="text-xs font-medium text-decision-ink">{b.status === 'concluded' ? '已帶回主線的結論' : '帶回主線的結論（預覽）'}</span>
                <span>{b.conclusion.decision}</span>
                <span className="text-decision-body">原因：{b.conclusion.rationale}</span>
                {b.conclusion.deferred.length > 0 && <span className="text-decision-body">延後：{b.conclusion.deferred.join('；')}</span>}
              </div>
            )}
          </div>

          {!readOnly && b.status !== 'concluded' && (
            <div className="flex flex-col gap-2.5 px-5 pt-3.5 pb-5">
              <form onSubmit={send} className="flex">
                <label className="flex flex-1">
                  <span className="sr-only">分岔訊息</span>
                  <input aria-label="分岔訊息" value={text} onChange={(e) => setText(e.target.value)} disabled={b.running}
                    placeholder="繼續在分岔裡討論…" className={cx(inputClass, 'flex-1')} />
                </label>
              </form>
              {b.status === 'concluding' ? (
                <Button variant="dark" disabled={b.running} onClick={() => void act(() => call('branch:confirm', task.id, b.id, undefined))}>確認並帶回主線</Button>
              ) : (
                <Button variant="dark" disabled={b.running || list.length < 2} onClick={() => void act(() => call('branch:conclude', task.id, b.id))}>帶回主線</Button>
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
import type { ReactNode } from 'react'
import type { Task } from '@shared/types'
import { call } from '../api'
import { BranchPanel } from '../components/BranchPanel'
import { Composer } from '../components/Composer'
import { RunStatus, Timeline, useTimeline } from '../components/Timeline'
import { useStore } from '../store'

export function ClarifyScreen({ task, nav, readOnly, onOpenStage }: { task: Task; nav: ReactNode; readOnly: boolean; onOpenStage: (s: 'spec' | 'report') => void }) {
  const { act, setActiveBranch } = useStore()
  const events = useTimeline(task.id)
  const busy = task.runState === 'running'
  const branchFrom = async (text: string) => {
    const title = text.replace(/\s+/g, ' ').slice(0, 24)
    const b = await act(() => call('branch:open', task.id, { title, seed: `針對這段內容深入討論：\n${text.slice(0, 600)}` }))
    if (b) setActiveBranch(task.id, b.id)
  }
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
          <span className="text-lg font-bold">{task.title}</span>
          {nav}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6">
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-5">
            <Timeline task={task} channel="main" events={events} readOnly={readOnly}
              onBranchFrom={busy ? undefined : (t) => void branchFrom(t)} onOpenStage={onOpenStage} />
            <RunStatus task={task} onResume={() => void act(() => call('run:resume', task.id))} />
          </div>
        </div>
        {!readOnly && (
          <div className="px-7 pb-[22px]">
            <div className="mx-auto max-w-[800px]">
              <Composer placeholder="補充需求或直接回答…" onSend={(t) => void act(() => call('tasks:send', task.id, 'main', t))} />
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

把 TaskScreen 的 return 改為：

```tsx
  const openStage = (s: Stage) => setStage(s)
  if (shown === 'clarify') return <ClarifyScreen task={task} nav={nav} readOnly={currentStage(task) !== 'clarify'} onOpenStage={openStage} />
  // Task 31–33 補上其他階段
  return <ClarifyScreen task={task} nav={nav} readOnly onOpenStage={openStage} />
```

**Step 7: 確認通過** — `npx vitest run tests/renderer` 全部通過；`npm run typecheck` PASS

**Step 8: 手動驗證（真實 Claude）**

`npm run dev` → 加入一個小 repo → 新任務輸入「在 README 加上安裝說明」→ 確認：時間軸出現需求、Claude 讀檔摘要、問題卡片；反問後卡片內出現回答；按「升級成分岔」右側出現分岔並有 Claude 回覆；「帶回主線」→「確認並帶回主線」後主線出現黃色決策。

**Step 9: Commit**

```bash
git add src/renderer/src tests/renderer/BranchPanel.test.tsx
git commit -m "feat(ui): add clarify screen with branch panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 31：規格核准畫面

**Files:**
- Create: `src/renderer/src/screens/SpecScreen.tsx`
- Modify: `src/renderer/src/screens/TaskScreen.tsx`

**Step 1: SpecScreen.tsx（對照 `docs/design/B3-Spec.dc.html`）**

```tsx
import { type ReactNode, useState } from 'react'
import type { DecisionSource, Task } from '@shared/types'
import { call } from '../api'
import { Button, cx, inputClass, Pill } from '../components/ui'
import { useStore } from '../store'

function SourcePill({ task, source }: { task: Task; source: DecisionSource }) {
  if (source.type === 'branch') return <Pill tone="decision">分岔</Pill>
  if (source.type === 'question') {
    const i = task.questions.findIndex((q) => q.id === source.ref)
    return <Pill>問題 {i >= 0 ? i + 1 : source.ref}</Pill>
  }
  return <Pill tone="muted">實作</Pill>
}

export function SpecScreen({ task, nav, readOnly }: { task: Task; nav: ReactNode; readOnly: boolean }) {
  const { act } = useStore()
  const [version, setVersion] = useState(task.specs.length)
  const [feedback, setFeedback] = useState('')
  const spec = task.specs[version - 1] ?? task.specs.at(-1)
  if (!spec) return <main className="flex-1 rounded-2xl bg-surface p-7 shadow-card">{nav}還沒有規格。</main>
  const answered = task.questions.filter((q) => q.status === 'answered')

  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
          <span className="text-lg font-bold">{task.title}</span>
          {nav}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6">
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-[22px]">
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-2 text-xs font-medium text-brand">
                規格草稿
                {task.specs.length > 1 ? (
                  <select aria-label="規格版本" value={spec.version} onChange={(e) => setVersion(Number(e.target.value))} className="rounded-md bg-fill px-1.5 py-0.5">
                    {task.specs.map((s) => <option key={s.version} value={s.version}>v{s.version}</option>)}
                  </select>
                ) : ` v${spec.version}`}
                · 根據 {answered.length} 個問題、{task.branches.length} 個分岔整理
              </span>
              <h1 className="m-0 text-2xl font-bold">{spec.title}</h1>
              <span className="text-ink-2">{spec.summary}</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5 rounded-[14px] bg-brand-tint p-4">
                <span className="text-[13px] font-bold text-brand-ink">包含</span>
                {spec.inScope.map((s, i) => <span key={i} className="text-[13px]">• {s}</span>)}
              </div>
              <div className="flex flex-col gap-1.5 rounded-[14px] bg-fill-2 p-4">
                <span className="text-[13px] font-bold text-ink-2">不包含</span>
                {spec.outOfScope.length ? spec.outOfScope.map((s, i) => <span key={i} className="text-[13px] text-ink-2">• {s}</span>) : <span className="text-[13px] text-muted">—</span>}
              </div>
            </div>

            {spec.decisions.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span className="text-[15px] font-bold">決策</span>
                <div className="flex flex-col overflow-hidden rounded-[14px] shadow-[0_0_0_1px_#e5e8ed]">
                  {spec.decisions.map((d, i) => (
                    <div key={d.id} className={cx('grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2 px-3.5 py-3', i < spec.decisions.length - 1 && 'border-b border-line-soft')}>
                      <span className="font-mono text-xs text-muted">{d.id.toUpperCase()}</span>
                      <span>{d.text}</span>
                      <SourcePill task={task} source={d.source} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              <span className="text-[15px] font-bold">實作步驟</span>
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {spec.steps.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex size-6 flex-none items-center justify-center rounded-full bg-fill text-xs">{i + 1}</span><span>{s}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[15px] font-bold">驗收條件</span>
              {spec.acceptance.map((a, i) => <span key={i} className="text-[13px]">• {a}</span>)}
            </div>
          </div>
        </div>

        {!readOnly && task.status === 'spec_review' && (
          <div className="rounded-b-2xl border-t border-line-soft bg-surface px-7 py-4">
            <div className="mx-auto flex max-w-[800px] flex-wrap items-center gap-2.5">
              <label className="flex min-w-[260px] flex-1">
                <span className="sr-only">修改意見</span>
                <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="哪裡要改？例如：上限改成 10 次" className={cx(inputClass, 'h-11 flex-1')} />
              </label>
              <Button disabled={!feedback.trim() || task.runState === 'running'} onClick={() => void act(async () => { await call('spec:requestChanges', task.id, feedback); setFeedback('') })}>要求修改</Button>
              <Button variant="primary" disabled={task.runState === 'running'} onClick={() => void act(() => call('spec:approve', task.id))}>核准並開始實作</Button>
            </div>
            <div className="mx-auto mt-2 max-w-[800px] text-xs text-muted">
              核准後 Claude 會在 worktree <code>{task.worktreePath}</code>（分支 <code>{task.branch}</code>）中修改程式碼。
            </div>
          </div>
        )}
      </main>

      <aside aria-label="釐清紀錄" className="flex w-[320px] flex-none flex-col gap-3 overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card">
        <span className="text-[15px] font-bold">釐清紀錄</span>
        <div className="flex flex-col gap-2.5 text-[13px]">
          {answered.map((q) => {
            const label = q.answer?.optionId ? q.options.find((o) => o.id === q.answer?.optionId)?.label : undefined
            return (
              <div key={q.id} className="flex flex-col gap-0.5 rounded-xl bg-fill-2 p-3">
                <span className="text-muted">問題 {task.questions.indexOf(q) + 1} · {q.text}</span>
                <span className="font-medium">{[label, q.answer?.text].filter(Boolean).join('；')}</span>
                {q.followups.some((f) => f.role === 'user') && <span className="text-xs text-muted">含 {q.followups.filter((f) => f.role === 'user').length} 次反問</span>}
              </div>
            )
          })}
          {task.branches.map((b) => (
            <div key={b.id} className="flex flex-col gap-0.5 rounded-xl bg-decision p-3">
              <span className="text-decision-ink">分岔 · {b.title}</span>
              <span>{b.conclusion ? `→ ${b.conclusion.decision}` : '尚未帶回'}</span>
            </div>
          ))}
        </div>
      </aside>
    </>
  )
}
```

**Step 2: TaskScreen 加入**

```tsx
  if (shown === 'spec') return <SpecScreen task={task} nav={nav} readOnly={currentStage(task) !== 'spec'} />
```

**Step 3: 驗證** — `npm run typecheck` PASS；手動：在釐清中回答到 Claude 提出規格，畫面自動切到規格頁，可要求修改與核准。

**Step 4: Commit**

```bash
git add src/renderer/src
git commit -m "feat(ui): add spec review screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 32：實作進度畫面與指令核准對話框

**Files:**
- Create: `src/renderer/src/components/PermissionDialog.tsx`
- Create: `src/renderer/src/screens/ImplementScreen.tsx`
- Modify: `src/renderer/src/screens/TaskScreen.tsx`
- Test: `tests/renderer/PermissionDialog.test.tsx`

**Step 1: 寫失敗測試**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({ call: vi.fn(async () => undefined), onEvent: vi.fn(() => () => {}), errorText: String }))
import { call } from '@renderer/api'
import { PermissionDialog } from '@renderer/components/PermissionDialog'
import type { PermissionRequest } from '@shared/types'

const req: PermissionRequest = { id: 'p1', taskId: 't1', toolName: 'Bash', input: { command: 'npm test -- auth', description: '跑 auth 測試' }, suggestedPattern: 'npm test *', createdAt: '' }
beforeEach(() => vi.mocked(call).mockClear())

test('顯示指令與原因，勾選後允許並記住樣式', async () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  expect(screen.getByText('$ npm test -- auth')).toBeInTheDocument()
  expect(screen.getByText(/跑 auth 測試/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('checkbox'))
  await userEvent.click(screen.getByRole('button', { name: '允許' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: true, rememberPattern: 'npm test *' })
})

test('拒絕並說明', async () => {
  render(<PermissionDialog request={req} cwd="/wt" />)
  await userEvent.click(screen.getByRole('button', { name: '拒絕並說明' }))
  await userEvent.type(screen.getByRole('textbox', { name: '拒絕原因' }), '先不要跑')
  await userEvent.click(screen.getByRole('button', { name: '送出拒絕' }))
  expect(call).toHaveBeenCalledWith('permission:resolve', 't1', 'p1', { allow: false, message: '先不要跑' })
})
```

**Step 2: 確認失敗**

**Step 3: PermissionDialog.tsx（對照 `B4-Implement.dc.html` 的 dialog）**

```tsx
import { useState } from 'react'
import type { PermissionRequest } from '@shared/types'
import { call } from '../api'
import { useStore } from '../store'
import { Button, textareaClass } from './ui'

export function PermissionDialog({ request: r, cwd }: { request: PermissionRequest; cwd: string }) {
  const { act } = useStore()
  const [remember, setRemember] = useState(false)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const command = typeof r.input.command === 'string' ? r.input.command : undefined
  const description = typeof r.input.description === 'string' ? r.input.description : undefined
  const resolve = (allow: boolean) => act(() => call('permission:resolve', r.taskId, r.id, allow
    ? { allow: true, ...(remember && r.suggestedPattern ? { rememberPattern: r.suggestedPattern } : {}) }
    : { allow: false, message: reason.trim() || undefined }))

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[rgba(28,36,48,0.28)] p-6">
      <div role="dialog" aria-modal="true" aria-label="指令核准" className="flex w-full max-w-[480px] flex-col gap-4 rounded-[20px] bg-surface p-6 shadow-dialog">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-decision-ink">需要你的核准</span>
          <span className="text-lg font-bold">{command ? 'Claude 想執行這個指令' : `Claude 想使用 ${r.toolName}`}</span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl bg-code px-4 py-3.5 font-mono text-[13px] text-code-ink">
          <span className="whitespace-pre-wrap break-all">{command ? `$ ${command}` : JSON.stringify(r.input, null, 2)}</span>
          <span className="text-[11px] text-[#a9b3bf]">cwd: {cwd}</span>
        </div>
        {description && <span className="text-[13px] text-ink-2">原因：{description}</span>}
        {r.suggestedPattern && (
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-brand" />
            本任務內都允許 <code>{r.suggestedPattern}</code>
          </label>
        )}
        {denying ? (
          <div className="flex flex-col gap-2.5">
            <textarea aria-label="拒絕原因" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="告訴 Claude 為什麼不行、該怎麼做" className={textareaClass} />
            <div className="flex justify-end gap-2.5">
              <Button onClick={() => setDenying(false)}>返回</Button>
              <Button variant="dark" onClick={() => void resolve(false)}>送出拒絕</Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2.5">
            <Button onClick={() => setDenying(true)}>拒絕並說明</Button>
            <Button variant="primary" className="px-[22px]" onClick={() => void resolve(true)}>允許</Button>
          </div>
        )}
      </div>
    </div>
  )
}
```

**Step 4: ImplementScreen.tsx（對照 `B4-Implement.dc.html`）**

```tsx
import { type ReactNode, useEffect, useState } from 'react'
import type { DiffStats, Task, TimelineEvent } from '@shared/types'
import { call } from '../api'
import { Composer } from '../components/Composer'
import { Markdown } from '../components/Markdown'
import { PermissionDialog } from '../components/PermissionDialog'
import { QuestionCard } from '../components/QuestionCard'
import { RunStatus, toolSummary, useTimeline } from '../components/Timeline'
import { Avatar, cx, Icons, Pill } from '../components/ui'
import { useStore } from '../store'

/** 取最後一次 [spec_approved] / [report_feedback] 之後的主線事件 */
function sinceImplementStart(events: TimelineEvent[]) {
  const main = events.filter((e) => e.channel === 'main')
  let start = 0
  main.forEach((e, i) => { if (e.kind === 'user_text' && /^(核准規格|送出 \d+ 則報告回饋)/.test(e.text ?? '')) start = i + 1 })
  return main.slice(start)
}

function ChangedFiles({ task }: { task: Task }) {
  const [stats, setStats] = useState<DiffStats>()
  useEffect(() => {
    let alive = true
    const load = () => call('tasks:changedFiles', task.id).then((s) => { if (alive) setStats(s) }).catch(() => undefined)
    void load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [task.id])
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-bold">變更檔案</span>
        {stats && <span className="font-mono text-xs"><span className="text-ok">+{stats.additions}</span> <span className="text-danger">−{stats.deletions}</span></span>}
      </div>
      <div className="flex flex-col gap-1 text-[13px]">
        {stats?.perFile.map((f) => (
          <div key={f.path} className="flex items-center gap-2 rounded-[10px] bg-fill-2 px-2.5 py-2">
            <code className="truncate bg-transparent p-0">{f.path}</code>
            <span className="ml-auto flex-none font-mono text-[11px]"><span className="text-ok">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span></span>
          </div>
        ))}
        {stats && stats.files === 0 && <span className="text-muted">還沒有變更</span>}
      </div>
    </>
  )
}

export function ImplementScreen({ task, nav, readOnly }: { task: Task; nav: ReactNode; readOnly: boolean }) {
  const { act } = useStore()
  const events = sinceImplementStart(useTimeline(task.id))
  const done = task.plan.filter((s) => s.status === 'done').length
  const runningIdx = task.plan.findIndex((s) => s.status === 'running')
  const tools = events.filter((e) => e.kind === 'tool_call').slice(-8)
  const chat = events.filter((e) => e.kind === 'user_text' || e.kind === 'assistant_text' || e.kind === 'system')
  const openQuestion = task.questions.find((q) => q.status === 'open')
  const running = task.runState === 'running' || task.runState === 'waiting_permission'

  return (
    <>
      <main className="relative flex min-w-0 flex-1 flex-col rounded-2xl bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-4 px-7 py-[18px]">
          <div className="flex flex-col">
            <span className="text-lg font-bold">{task.title}</span>
            <span className="font-mono text-[11px] text-muted">{task.branch}</span>
          </div>
          {nav}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-6">
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-2.5">
            <div className="mb-1.5 flex items-center gap-3">
              <span className="text-[13px] text-muted">進度</span>
              <span className="flex h-1.5 flex-1 rounded bg-line-soft">
                <span className="rounded bg-brand" style={{ width: `${task.plan.length ? (done / task.plan.length) * 100 : 0}%` }} />
              </span>
              <span className="font-mono text-xs">{done} / {task.plan.length || '?'}</span>
            </div>

            {openQuestion && <QuestionCard task={task} question={openQuestion} readOnly={readOnly} />}

            {task.plan.map((s, i) => {
              if (i === runningIdx) {
                return (
                  <section key={s.id} aria-label="進行中的步驟" className="overflow-hidden rounded-2xl shadow-focus">
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <span className="flex size-6 flex-none items-center justify-center rounded-full text-xs font-bold text-brand shadow-[inset_0_0_0_2px_var(--color-brand)]">{i + 1}</span>
                      <span className="flex-1 font-medium">{s.title}</span>
                      {task.runState === 'waiting_permission' ? <Pill tone="decision">等待核准</Pill> : <Pill tone="brand">進行中</Pill>}
                    </div>
                    <div className="flex flex-col gap-0.5 pr-4 pb-3.5 pl-[52px] text-[13px]">
                      {tools.map((e) => (
                        <div key={e.id} className="flex items-center gap-2.5 rounded-lg bg-fill-2 px-2.5 py-1.5">
                          <code className="truncate bg-transparent p-0">{toolSummary(e.tool!)}</code>
                        </div>
                      ))}
                    </div>
                  </section>
                )
              }
              return (
                <div key={s.id} className={cx('flex items-center gap-3 rounded-[14px] px-4 py-3', s.status === 'done' ? 'bg-fill-2' : 'text-muted')}>
                  {s.status === 'done'
                    ? <span className="flex size-6 flex-none items-center justify-center rounded-full bg-brand text-white"><Icons.Check width={12} height={12} strokeWidth={3} /></span>
                    : <span className="flex size-6 flex-none items-center justify-center rounded-full text-xs shadow-[inset_0_0_0_1.5px_#c3c9d2]">{i + 1}</span>}
                  <span className="flex-1">{s.title}</span>
                  {s.status === 'blocked' && <Pill tone="danger">卡住</Pill>}
                </div>
              )
            })}

            {chat.map((e) => e.kind === 'user_text'
              ? <div key={e.id} className="max-w-[78%] self-end whitespace-pre-wrap rounded-[18px_18px_6px_18px] bg-fill px-3.5 py-2.5 text-[13px]">{e.text}</div>
              : e.kind === 'system' ? <div key={e.id} className="self-center rounded-full bg-fill px-3 py-1 text-xs text-muted">{e.text}</div>
              : <div key={e.id} className="flex gap-2.5 text-[13px]"><Avatar /><div className="min-w-0 flex-1"><Markdown text={e.text ?? ''} /></div></div>)}

            <RunStatus task={task} onResume={() => void act(() => call('run:resume', task.id))} />
          </div>
        </div>

        {!readOnly && (
          <div className="px-7 pb-[22px]">
            <div className="mx-auto max-w-[800px]">
              <Composer label="插話" placeholder="插話給 Claude…" onSend={(t) => void act(() => call('tasks:send', task.id, 'main', t))}
                extra={running ? (
                  <button type="button" onClick={() => void act(() => call('run:stop', task.id, 'main'))}
                    className="flex h-10 items-center gap-1.5 rounded-full bg-surface px-4 text-[13px] text-danger"><Icons.Stop width={12} height={12} />停止</button>
                ) : undefined} />
            </div>
          </div>
        )}

        {task.pendingPermission && !readOnly && <PermissionDialog request={task.pendingPermission} cwd={task.worktreePath} />}
      </main>

      <aside aria-label="變更檔案" className="flex w-[320px] flex-none flex-col gap-3.5 overflow-y-auto rounded-2xl bg-surface px-5 py-[18px] shadow-card">
        <ChangedFiles task={task} />
        <div className="h-px bg-line-soft" />
        <div className="flex flex-col gap-2 text-[13px]">
          <span className="font-bold">本任務已允許的指令</span>
          <div className="flex flex-wrap gap-1.5">
            {task.allowedCommands.length ? task.allowedCommands.map((c) => <code key={c}>{c}</code>) : <span className="text-muted">（只有設定中的永遠允許清單）</span>}
          </div>
        </div>
        <div className="h-px bg-line-soft" />
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-bold">Worktree</span>
          <span className="font-mono text-[11px] break-all text-ink-2">{task.worktreePath}</span>
          <button type="button" onClick={() => void call('shell:showInFolder', task.worktreePath)} className="h-9 self-start rounded-[10px] bg-fill px-3 text-xs text-ink-2">在 Finder 開啟</button>
        </div>
      </aside>
    </>
  )
}
```

**Step 5: TaskScreen 加入**

```tsx
  if (shown === 'implement') return <ImplementScreen task={task} nav={nav} readOnly={currentStage(task) !== 'implement'} />
```

**Step 6: 確認通過** — `npx vitest run tests/renderer` 全部通過；`npm run typecheck` PASS

**Step 7: 手動驗證** — 核准規格後進入實作頁：進度與步驟更新、shell 指令跳出核准框、勾選後同樣指令不再詢問、插話會出現在時間軸、停止按鈕可中斷。

**Step 8: Commit**

```bash
git add src/renderer/src tests/renderer/PermissionDialog.test.tsx
git commit -m "feat(ui): add implementation screen with command approval dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 33：變更報告畫面

**Files:**
- Create: `src/renderer/src/report/ArchitectureDiagram.tsx`
- Create: `src/renderer/src/report/CustomBlockFrame.tsx`
- Create: `src/renderer/src/report/DiffView.tsx`
- Create: `src/renderer/src/report/ReportView.tsx`
- Create: `src/renderer/src/report/FeedbackPanel.tsx`
- Create: `src/renderer/src/report/exportHtml.tsx`
- Create: `src/renderer/src/screens/ReportScreen.tsx`
- Modify: `src/renderer/src/screens/TaskScreen.tsx`
- Test: `tests/renderer/DiffView.test.tsx`、`tests/renderer/ArchitectureDiagram.test.tsx`

**Step 1: 寫失敗測試**

```tsx
// tests/renderer/DiffView.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({ call: vi.fn(), onEvent: vi.fn(() => () => {}), errorText: String }))
import { DiffView } from '@renderer/report/DiffView'
import { useStore } from '@renderer/store'

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
  render(<DiffView taskId="t1" diff={diff} perFile={[{ path: 'src/a.ts', additions: 1, deletions: 0 }]}
    notes={[{ path: 'src/a.ts', why: '加上 b', hunks: [{ line_start: 2, line_end: 2, why: '新常數' }] }]} />)
  expect(screen.getByText(/加上 b/)).toBeInTheDocument()
  expect(screen.getByText(/新常數/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對第 2 行留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '改成常數檔{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([{ anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: '改成常數檔' }])
  expect(screen.getByText('改成常數檔')).toBeInTheDocument()
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
  const { container } = render(<ArchitectureDiagram graph={sampleReport.architecture.after} onSelectFile={onSelect} />)
  expect(screen.getByRole('button', { name: /lockoutGuard/ })).toBeInTheDocument()
  expect(container.querySelectorAll('line')).toHaveLength(2)
  await userEvent.click(screen.getByRole('button', { name: /lockoutGuard/ }))
  expect(onSelect).toHaveBeenCalledWith('src/auth/lockout.ts')
})
```

**Step 2: 確認失敗**

**Step 3: ArchitectureDiagram.tsx**

```tsx
import { BOX_H, BOX_W, layoutGraph } from '@shared/layout'
import type { ReportInput } from '@shared/report'
import { cx } from '../components/ui'

type Graph = ReportInput['architecture']['after']
const STATUS_CLASS = {
  added: 'bg-brand text-white font-medium',
  modified: 'bg-surface shadow-[inset_0_0_0_2px_#2563eb]',
  unchanged: 'bg-surface'
} as const
const STATUS_LABEL = { added: '新增', modified: '修改', unchanged: '未變' } as const

export function ArchitectureDiagram({ graph, onSelectFile }: { graph: Graph; onSelectFile?: (path: string) => void }) {
  const { nodes, width, height } = layoutGraph(graph.nodes, graph.edges)
  const pos = new Map(nodes.map((n) => [n.node.id, n]))
  return (
    <div className="overflow-x-auto">
      <div className="relative mx-auto" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0" aria-hidden>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#8a93a0" />
            </marker>
          </defs>
          {graph.edges.map((e, i) => {
            const a = pos.get(e.from)
            const b = pos.get(e.to)
            if (!a || !b) return null
            const down = b.y > a.y
            const x1 = a.x + BOX_W / 2
            const y1 = down ? a.y + BOX_H : a.y + BOX_H / 2
            const x2 = b.x + BOX_W / 2
            const y2 = down ? b.y : b.y + BOX_H / 2
            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#8a93a0" strokeWidth={1.5} markerEnd="url(#arrow)" />
                {e.label && <text x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2} fontSize={11} fill="#5b6472">{e.label}</text>}
              </g>
            )
          })}
        </svg>
        {nodes.map(({ node, x, y }) => (
          <button
            key={node.id} type="button" title={node.files.join('\n')}
            aria-label={`${node.label}（${STATUS_LABEL[node.status]}）`}
            onClick={() => node.files[0] && onSelectFile?.(node.files[0])}
            className={cx('absolute flex items-center justify-center truncate rounded-xl px-2 text-[13px]', STATUS_CLASS[node.status])}
            style={{ left: x, top: y, width: BOX_W, height: BOX_H }}
          >
            {node.label}
          </button>
        ))}
      </div>
    </div>
  )
}
```

**Step 4: CustomBlockFrame.tsx**

```tsx
import { useEffect, useRef, useState } from 'react'

/** 以獨立 protocol + sandbox iframe 呈現 Claude 產生的 HTML，不給 same-origin、禁止網路 */
export function CustomBlockFrame({ taskId, version, id, title }: { taskId: string; version: number; id: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(220)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return
      const d = e.data as { type?: string; id?: string; height?: number }
      if (d?.type === 'harness-block-height' && d.id === id && typeof d.height === 'number') setHeight(Math.min(Math.max(d.height, 80), 1600))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [id])
  return (
    <iframe
      ref={ref} title={title} sandbox="allow-scripts"
      src={`harness-block://report/${taskId}/${version}/${id}`}
      className="w-full rounded-2xl border-0 bg-fill-2" style={{ height }}
    />
  )
}
```

**Step 5: DiffView.tsx**

```tsx
import { type FormEvent, useMemo, useState } from 'react'
import { parseUnifiedDiff } from '@shared/diff'
import type { ReportInput } from '@shared/report'
import type { DiffStats } from '@shared/types'
import { useStore } from '../store'
import { cx } from '../components/ui'

type Note = ReportInput['file_notes'][number]

export function DiffView({ taskId, diff, perFile, notes, selected: controlled, onSelect, readOnly }: {
  taskId: string; diff: string; perFile: DiffStats['perFile']; notes: Note[]
  selected?: string; onSelect?: (path: string) => void; readOnly?: boolean
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  const [own, setOwn] = useState(files[0]?.path)
  const selected = controlled ?? own
  const select = (p: string) => { setOwn(p); onSelect?.(p) }
  const file = files.find((f) => f.path === selected) ?? files[0]
  const note = notes.find((n) => n.path === file?.path)
  const { feedback, addFeedback } = useStore()
  const items = feedback[taskId] ?? []
  const [commenting, setCommenting] = useState<number>()
  const [text, setText] = useState('')

  if (!file) return <span className="text-muted">沒有程式碼變更</span>

  const submit = (e: FormEvent, line: number) => {
    e.preventDefault()
    if (!text.trim()) return
    addFeedback(taskId, { anchor: `diff:${file.path}:${line}`, label: `${file.path}:${line}`, text: text.trim() })
    setText('')
    setCommenting(undefined)
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap gap-1.5 text-xs">
        {files.map((f) => {
          const s = perFile.find((p) => p.path === f.path)
          return (
            <button key={f.path} type="button" onClick={() => select(f.path)}
              className={cx('rounded-full px-3 py-1.5 font-mono', f.path === file.path ? 'bg-ink text-white' : 'bg-fill')}>
              {f.path}{s ? ` +${s.additions}${s.deletions ? ` −${s.deletions}` : ''}` : ''}
            </button>
          )
        })}
      </div>
      {note && <div className="rounded-xl bg-brand-tint px-3.5 py-3 text-[13px] text-[#134e4a]"><span className="font-bold">為什麼：</span>{note.why}</div>}
      <div className="overflow-x-auto rounded-xl bg-code font-mono text-[12.5px] leading-[1.8] text-code-ink">
        {file.hunks.map((h, hi) => (
          <div key={hi}>
            <div className="px-3 text-[#7d8794]">{h.header}</div>
            {h.lines.map((l, li) => {
              const lineNo = l.newNo
              const hunkNote = lineNo !== undefined ? note?.hunks.find((x) => x.line_start === lineNo) : undefined
              const fb = lineNo !== undefined ? items.find((f) => f.anchor === `diff:${file.path}:${lineNo}`) : undefined
              return (
                <div key={li}>
                  {hunkNote && <div className="mx-3 my-1 rounded-lg bg-[#134e4a] px-3 py-1.5 font-sans text-[12px] text-[#d5ebe8]">為什麼（{hunkNote.line_start}–{hunkNote.line_end} 行）：{hunkNote.why}</div>}
                  <div className={cx('grid grid-cols-[52px_minmax(0,1fr)]', l.type === 'add' && 'bg-[rgba(34,197,94,0.14)]', l.type === 'del' && 'bg-[rgba(239,68,68,0.16)]', fb && 'shadow-[inset_3px_0_0_#facc15]')}>
                    {lineNo !== undefined && !readOnly ? (
                      <button type="button" aria-label={`對第 ${lineNo} 行留言`} onClick={() => setCommenting(lineNo)} className="pr-3 text-right text-[#7d8794] hover:text-white">{lineNo}</button>
                    ) : <span className="pr-3 text-right text-[#4f5864]">{l.oldNo}</span>}
                    <span className="whitespace-pre">{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</span>
                  </div>
                  {fb && <div className="ml-[52px] flex gap-2.5 rounded-lg bg-note px-3 py-2 font-sans text-[13px] text-ink"><span className="text-xs text-note-ink">回饋</span>{fb.text}</div>}
                  {commenting === lineNo && lineNo !== undefined && (
                    <form onSubmit={(e) => submit(e, lineNo)} className="ml-[52px] flex gap-2 p-2 font-sans">
                      <input autoFocus aria-label="回饋" value={text} onChange={(e) => setText(e.target.value)} placeholder="這一行要怎麼改？"
                        className="h-9 flex-1 rounded-lg border-none bg-white px-3 text-[13px] text-ink outline-none" />
                      <button type="button" onClick={() => setCommenting(undefined)} className="px-2 text-xs text-[#a9b3bf]">取消</button>
                    </form>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Step 6: ReportView.tsx**（對照 `B5-Report.dc.html`；`static` 模式給匯出用，不含互動控制）

```tsx
import { type ReactNode, useState } from 'react'
import type { Report, Task } from '@shared/types'
import { ArchitectureDiagram } from './ArchitectureDiagram'
import { CustomBlockFrame } from './CustomBlockFrame'
import { DiffView } from './DiffView'
import { useStore } from '../store'
import { cx, Icons, Pill } from '../components/ui'

function Section({ id, title, tag, children, onComment, className }: { id: string; title: string; tag?: ReactNode; children: ReactNode; onComment?: () => void; className?: string }) {
  return (
    <section id={`report-${id}`} className={cx('flex flex-col gap-4 rounded-2xl bg-surface p-7 shadow-card', className)}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-lg font-bold">{title}</span>{tag}
        {onComment && <button type="button" aria-label={`對「${title}」留言`} onClick={onComment} className="ml-auto flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:bg-fill"><Icons.Comment width={14} height={14} />留言</button>}
      </div>
      {children}
    </section>
  )
}

function SectionComment({ taskId, anchor, label, onDone }: { taskId: string; anchor: string; label: string; onDone: () => void }) {
  const { addFeedback } = useStore()
  const [text, setText] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { addFeedback(taskId, { anchor, label, text: text.trim() }); onDone() } }} className="flex gap-2">
      <input autoFocus aria-label="回饋" value={text} onChange={(e) => setText(e.target.value)} placeholder={`對「${label}」的回饋…`} className="h-10 flex-1 rounded-xl border border-line px-3 text-[13px] outline-none focus:border-brand" />
      <button type="button" onClick={onDone} className="px-2 text-xs text-muted">取消</button>
    </form>
  )
}

export function ReportView({ task, report, isStatic, onOpenQuestion }: { task: Task; report: Report; isStatic?: boolean; onOpenQuestion?: () => void }) {
  const r = report.input
  const [diffFile, setDiffFile] = useState<string>()
  const [commentOn, setCommentOn] = useState<string>()
  const passed = report.verification.filter((v) => v.exitCode === 0).length
  const ran = report.verification.filter((v) => !v.skipped).length
  const comment = (anchor: string) => (isStatic ? undefined : () => setCommentOn(anchor))
  const commentBox = (anchor: string, label: string) => commentOn === anchor && <SectionComment taskId={task.id} anchor={anchor} label={label} onDone={() => setCommentOn(undefined)} />
  const jumpTo = (path: string) => { setDiffFile(path); document.getElementById('report-diff')?.scrollIntoView({ behavior: 'smooth' }) }

  return (
    <div className="flex flex-col gap-3">
      <Section id="overview" title="概觀" onComment={comment('section:overview')}>
        {commentBox('section:overview', '概觀')}
        <h1 className="m-0 text-[26px] font-bold">{r.overview.headline}</h1>
        <p className="m-0 max-w-[720px] text-ink-2">{r.overview.summary}</p>
        <div className="grid grid-cols-4 gap-2.5">
          <div className="flex flex-col rounded-[14px] bg-fill-2 px-4 py-3.5"><span className="text-xs text-muted">變更檔案</span><span className="text-2xl font-bold">{report.stats.files}</span></div>
          <div className="flex flex-col rounded-[14px] bg-fill-2 px-4 py-3.5"><span className="text-xs text-muted">行數</span><span className="text-2xl font-bold"><span className="text-ok">+{report.stats.additions}</span> <span className="text-lg text-danger">−{report.stats.deletions}</span></span></div>
          <div className={cx('flex flex-col rounded-[14px] px-4 py-3.5', ran && passed === ran ? 'bg-brand-tint' : 'bg-red-50')}><span className="text-xs text-muted">驗證</span><span className="text-2xl font-bold">{passed} / {ran} 通過</span></div>
          <div className="flex flex-col rounded-[14px] bg-decision px-4 py-3.5"><span className="text-xs text-decision-ink">決策</span><span className="text-2xl font-bold">{r.decisions.length}</span></div>
        </div>
      </Section>

      <Section id="arch" title="架構前後對照" onComment={comment('section:architecture')}
        tag={<span className="ml-auto flex gap-3 text-xs text-ink-2">
          <span className="flex items-center gap-1.5"><span className="size-3 rounded bg-brand" />新增</span>
          <span className="flex items-center gap-1.5"><span className="size-3 rounded bg-surface shadow-[inset_0_0_0_2px_#2563eb]" />修改</span>
          <span className="flex items-center gap-1.5"><span className="size-3 rounded bg-line-soft" />未變</span>
        </span>}>
        {commentBox('section:architecture', '架構')}
        <div className="grid grid-cols-2 gap-4">
          {(['before', 'after'] as const).map((side) => (
            <div key={side} className="flex flex-col gap-3 rounded-2xl bg-fill-2 p-5">
              <span className={cx('text-[13px] font-bold', side === 'after' ? 'text-brand' : 'text-muted')}>{side === 'before' ? '之前' : '之後'}</span>
              <ArchitectureDiagram graph={r.architecture[side]} onSelectFile={isStatic ? undefined : jumpTo} />
            </div>
          ))}
        </div>
      </Section>

      <Section id="decisions" title="決策與原因">
        <div className="grid grid-cols-2 gap-3">
          {r.decisions.map((d) => (
            <div key={d.id} className="flex flex-col gap-2 rounded-[14px] p-4 shadow-[0_0_0_1px_#e5e8ed]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted">{d.id.toUpperCase()}</span>
                <span className="font-bold">{d.title}</span>
                <span className="ml-auto">
                  {d.source.type === 'branch' ? <Pill tone="decision">來自分岔</Pill>
                    : d.source.type === 'question' ? <button type="button" onClick={onOpenQuestion}><Pill>問題 {task.questions.findIndex((q) => q.id === d.source.ref) + 1 || d.source.ref}</Pill></button>
                    : <Pill tone="muted">實作中決定</Pill>}
                </span>
              </div>
              <div className="text-[13px]"><span className="font-medium text-brand">選擇</span>　{d.chosen}</div>
              {d.rejected.length > 0 && <div className="text-[13px] text-muted"><span className="font-medium">捨棄</span>　{d.rejected.join('；')}</div>}
              <div className="rounded-[10px] bg-fill-2 px-3 py-2.5 text-[13px] text-ink-2">{d.rationale}</div>
              {!isStatic && <button type="button" onClick={() => setCommentOn(`decision:${d.id}`)} className="self-start text-xs text-muted hover:text-ink">留言</button>}
              {commentBox(`decision:${d.id}`, `決策 ${d.id}`)}
            </div>
          ))}
        </div>
      </Section>

      {r.custom_blocks.map((b) => (
        <Section key={b.id} id={`block-${b.id}`} title={b.title} tag={<Pill>Claude 自訂視覺化</Pill>} onComment={comment(`block:${b.id}`)}>
          {commentBox(`block:${b.id}`, b.title)}
          {isStatic
            ? <iframe title={b.title} sandbox="allow-scripts" srcDoc={b.html} className="h-[360px] w-full rounded-2xl border-0 bg-fill-2" />
            : <CustomBlockFrame taskId={task.id} version={report.version} id={b.id} title={b.title} />}
        </Section>
      ))}

      <section id="report-limits" className="grid grid-cols-2 gap-4 rounded-2xl bg-surface p-7 shadow-card">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center"><span className="text-lg font-bold">限制與風險</span>
            {!isStatic && <button type="button" aria-label="對「限制與風險」留言" onClick={() => setCommentOn('section:limitations')} className="ml-auto text-xs text-muted">留言</button>}</div>
          {commentBox('section:limitations', '限制與風險')}
          {r.limitations.length ? r.limitations.map((l, i) => (
            <div key={i} className={cx('rounded-xl px-3.5 py-3 text-[13px]', l.severity === 'high' ? 'bg-red-50' : l.severity === 'medium' ? 'bg-decision' : 'bg-fill-2')}>
              <span className="font-medium">{l.title}</span><br /><span className="text-ink-2">{l.detail}</span>
            </div>
          )) : <span className="text-[13px] text-muted">沒有已知限制</span>}
        </div>
        <div className="flex flex-col gap-2.5">
          <span className="text-lg font-bold">後續工作</span>
          {r.followups.length ? r.followups.map((f, i) => (
            <div key={i} className="rounded-xl bg-fill-2 px-3.5 py-3 text-[13px]">{f.title}{f.detail && <span className="text-muted">：{f.detail}</span>}</div>
          )) : <span className="text-[13px] text-muted">—</span>}
        </div>
      </section>

      <Section id="diff" title="程式碼變更" tag={<span className="text-xs text-muted">每段變更都附上「為什麼改」{!isStatic && '；點行號可以留下回饋'}</span>}>
        <DiffView taskId={task.id} diff={report.diff} perFile={report.stats.perFile} notes={r.file_notes} selected={diffFile} onSelect={setDiffFile} readOnly={isStatic} />
      </Section>

      <Section id="tests" title="測試結果" tag={<span className="text-xs text-muted">由 Harness 在 worktree 中實際執行</span>}>
        <div className="flex flex-col gap-1.5 text-[13px]">
          {report.verification.length === 0 && <span className="text-muted">Claude 沒有提供驗證指令</span>}
          {report.verification.map((v, i) => (
            <details key={i} className={cx('rounded-xl px-3.5 py-3', v.skipped ? 'bg-fill-2' : v.exitCode === 0 ? 'bg-brand-tint' : 'bg-red-50')}>
              <summary className="flex cursor-pointer items-center gap-3">
                <span aria-hidden>{v.skipped ? '⏭' : v.exitCode === 0 ? '✓' : '✗'}</span>
                <code className="bg-transparent p-0">{v.command}</code>
                <span className="ml-auto text-xs">{v.skipped ?? (v.exitCode === 0 ? `通過 · ${(v.durationMs / 1000).toFixed(1)} 秒` : `失敗（exit ${v.exitCode ?? '—'}）`)}</span>
              </summary>
              {v.outputTail && <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-code p-3 text-xs whitespace-pre-wrap text-code-ink">{v.outputTail}</pre>}
            </details>
          ))}
        </div>
      </Section>
    </div>
  )
}
```

**Step 7: FeedbackPanel.tsx**

```tsx
import { useState } from 'react'
import type { Task } from '@shared/types'
import { call } from '../api'
import { useStore } from '../store'
import { Button, Icons, textareaClass } from '../components/ui'

export function FeedbackPanel({ task, onExport }: { task: Task; onExport: () => void }) {
  const { feedback, removeFeedback, clearFeedback, act } = useStore()
  const items = feedback[task.id] ?? []
  const [overall, setOverall] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const reviewing = task.status === 'reviewing'

  const send = () => act(async () => {
    await call('report:feedback', task.id, items, overall)
    clearFeedback(task.id)
    setOverall('')
  })
  const pr = () => act(async () => { const url = await call('finish:pr', task.id); await call('shell:openExternal', url) })

  return (
    <aside aria-label="回饋與收尾" className="sticky top-0 flex w-[300px] flex-none flex-col gap-3.5 self-start rounded-2xl bg-surface px-5 py-[18px] shadow-card">
      {reviewing && (
        <>
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-bold">回饋</span>
            <span className="text-xs text-muted">{items.length} 則待送出</span>
          </div>
          <div className="flex flex-col gap-2 text-[13px]">
            {items.length === 0 && <span className="text-muted">在報告的區塊、決策或程式碼行上按「留言」。</span>}
            {items.map((f) => (
              <div key={f.anchor} className="flex gap-2 rounded-xl bg-note p-3">
                <span className="flex flex-1 flex-col gap-0.5"><span className="text-xs text-note-ink">{f.label}</span>{f.text}</span>
                <button type="button" aria-label={`刪除對 ${f.label} 的回饋`} onClick={() => removeFeedback(task.id, f.anchor)} className="self-start text-note-ink"><Icons.X width={12} height={12} /></button>
              </div>
            ))}
          </div>
          <label className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium">整體意見（選填）</span>
            <textarea rows={3} value={overall} onChange={(e) => setOverall(e.target.value)} placeholder="其他想調整的地方…" className={textareaClass} />
          </label>
          <Button variant="primary" disabled={!items.length && !overall.trim()} onClick={() => void send()}>送出回饋，產生 v{task.reportVersions.length + 1}</Button>
          <div className="h-px bg-line-soft" />
          <span className="text-[15px] font-bold">滿意了？</span>
          <Button variant="dark" onClick={() => void pr()}>開 Pull Request</Button>
          <Button onClick={() => void act(() => call('finish:merge', task.id))}>合併到 {task.baseBranch}</Button>
        </>
      )}
      {task.status === 'done' && (
        <div className="flex flex-col gap-2 text-[13px]">
          <span className="text-[15px] font-bold">已完成</span>
          {task.prUrl
            ? <button type="button" className="self-start text-brand underline" onClick={() => void call('shell:openExternal', task.prUrl!)}>開啟 Pull Request</button>
            : <span className="text-muted">已合併到 {task.baseBranch}。</span>}
        </div>
      )}
      <Button size="sm" onClick={onExport}>匯出 HTML</Button>
      {task.status !== 'discarded' && (
        <Button variant="danger" size="sm" onClick={() => (confirmDiscard ? void act(() => call('finish:discard', task.id)) : setConfirmDiscard(true))}>
          {confirmDiscard ? '確定要刪除 worktree 與分支？' : task.status === 'done' ? '清除 worktree' : '丟棄 worktree'}
        </Button>
      )}
    </aside>
  )
}
```

**Step 8: exportHtml.tsx**

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import type { Report, Task } from '@shared/types'
import { ReportView } from './ReportView'

function collectCss(): string {
  let css = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try { css += Array.from(sheet.cssRules).map((r) => r.cssText).join('\n') } catch { /* 跨來源樣式表略過 */ }
  }
  return css.replace(/url\([^)]*\.(woff2?|ttf)[^)]*\)/g, 'local("PingFang TC")')
}

export function buildReportHtml(task: Task, report: Report): string {
  const body = renderToStaticMarkup(<ReportView task={task} report={report} isStatic />)
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${task.title.replace(/</g, '&lt;')} · 變更報告 v${report.version}</title><style>${collectCss()}</style></head>
<body style="background:#eef0f3;padding:24px"><div style="max-width:1100px;margin:0 auto">${body}</div></body></html>`
}
```

**Step 9: ReportScreen.tsx**

```tsx
import { type ReactNode, useEffect, useState } from 'react'
import type { Report, Task } from '@shared/types'
import { call } from '../api'
import { buildReportHtml } from '../report/exportHtml'
import { FeedbackPanel } from '../report/FeedbackPanel'
import { ReportView } from '../report/ReportView'
import { Spinner } from '../components/ui'
import { useStore } from '../store'

export function ReportScreen({ task, nav, onOpenStage }: { task: Task; nav: ReactNode; onOpenStage: (s: 'clarify') => void }) {
  const { act } = useStore()
  const latest = task.reportVersions.at(-1) ?? 0
  const [version, setVersion] = useState(latest)
  const [report, setReport] = useState<Report>()
  useEffect(() => setVersion(latest), [latest])
  useEffect(() => {
    if (!version) return
    let alive = true
    void act(async () => { const r = await call('report:get', task.id, version); if (alive) setReport(r) })
    return () => { alive = false }
  }, [task.id, version, act])

  const exportHtml = () => report && act(() => call('report:saveHtml', `${task.title}-報告-v${report.version}.html`, buildReportHtml(task, report)))

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-surface px-7 py-[18px] shadow-card">
          <span className="text-lg font-bold">{task.title}</span>
          {nav}
          {task.reportVersions.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-muted">版本
              <select value={version} onChange={(e) => setVersion(Number(e.target.value))} className="h-[34px] rounded-[10px] border border-line bg-surface px-2.5 text-xs text-ink">
                {task.reportVersions.map((v) => <option key={v} value={v}>v{v}</option>)}
              </select>
            </label>
          )}
        </div>
        {report ? <ReportView task={task} report={report} onOpenQuestion={() => onOpenStage('clarify')} /> : <div className="flex items-center gap-2 p-7 text-muted"><Spinner />載入報告…</div>}
      </div>
      <FeedbackPanel task={task} onExport={() => void exportHtml()} />
    </>
  )
}
```

**Step 10: TaskScreen 完成切換**

TaskScreen 最終版：

```tsx
import { useEffect, useState } from 'react'
import { StageNav } from '../components/StageNav'
import { currentStage, type Stage } from '../lib/stage'
import { useStore } from '../store'
import { ClarifyScreen } from './ClarifyScreen'
import { ImplementScreen } from './ImplementScreen'
import { ReportScreen } from './ReportScreen'
import { SpecScreen } from './SpecScreen'

export function TaskScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks[taskId])
  const [stage, setStage] = useState<Stage | null>(null)
  useEffect(() => setStage(null), [taskId, task?.status])
  if (!task) return null
  const current = currentStage(task)
  const shown = stage ?? current
  const select = (s: Stage) => setStage(s === current ? null : s)
  const nav = <StageNav task={task} shown={shown} onSelect={select} />
  switch (shown) {
    case 'clarify': return <ClarifyScreen task={task} nav={nav} readOnly={current !== 'clarify'} onOpenStage={select} />
    case 'spec': return <SpecScreen task={task} nav={nav} readOnly={current !== 'spec'} />
    case 'implement': return <ImplementScreen task={task} nav={nav} readOnly={current !== 'implement'} />
    case 'report': return <ReportScreen task={task} nav={nav} onOpenStage={select} />
  }
}
```

**Step 11: 確認通過** — `npx vitest run tests/renderer` 全部通過；`npm run typecheck` PASS

**Step 12: Commit**

```bash
git add src/renderer/src tests/renderer
git commit -m "feat(ui): add change report with architecture diff, decisions, custom blocks and feedback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 34：設定畫面

**Files:**
- Create: `src/renderer/src/screens/SettingsScreen.tsx`
- Modify: `src/renderer/src/App.tsx`（`view.kind === 'settings'` 時渲染）

**Step 1: SettingsScreen.tsx（對照 `docs/design/B6-Settings.dc.html`）**

```tsx
import { useState } from 'react'
import { MODELS, type Settings } from '@shared/types'
import { call } from '../api'
import { Button, cx, Icons, inputClass } from '../components/ui'
import { useStore } from '../store'

export function SettingsScreen() {
  const { settings, claude, act, open } = useStore()
  const [newCmd, setNewCmd] = useState('')
  if (!settings) return null
  const save = (patch: Partial<Settings>) => act(async () => useStore.setState({ settings: await call('settings:set', patch) }))
  const refresh = () => act(async () => useStore.setState({ claude: await call('claude:status', true) }))

  return (
    <>
      <nav aria-label="設定分類" className="flex w-[236px] flex-none flex-col gap-1 px-1.5 py-2">
        <button type="button" onClick={() => void open({ kind: 'new' })} className="mb-3 flex h-10 items-center gap-2 px-2.5 text-[13px] text-ink-2"><Icons.Back width={14} height={14} />返回</button>
        {[['account', 'Claude 帳號'], ['model', '模型'], ['perm', '權限'], ['workspace', 'Worktree 與專案設定']].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-xl px-3 py-2.5 text-[13px] text-ink-2 no-underline hover:bg-white/60">{label}</a>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto rounded-2xl bg-surface px-7 py-9 shadow-card">
        <div className="mx-auto flex max-w-[680px] flex-col gap-8">
          <h1 className="m-0 text-2xl font-bold">設定</h1>

          <section id="account" className="flex flex-col gap-3">
            <span className="text-[15px] font-bold">Claude 帳號</span>
            <div className={cx('flex flex-wrap items-center gap-3.5 rounded-[14px] p-4', claude?.loggedIn ? 'bg-brand-tint' : 'bg-red-50')}>
              <span className={cx('size-2.5 rounded-full', claude?.loggedIn ? 'bg-green-600' : 'bg-danger')} />
              <span className="flex flex-1 flex-col">
                <span className="font-medium">{claude?.loggedIn ? `已透過 Claude Code 登入 · ${claude.subscriptionType ?? '訂閱方案'}` : claude?.error ?? '未就緒'}</span>
                <span className="text-xs text-muted">使用本機 Claude Code 的登入憑證，不需要 API key</span>
              </span>
              <Button size="sm" onClick={() => void refresh()}>重新檢查</Button>
            </div>
            <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 px-1 text-[13px]">
              <span className="text-muted">Claude Code</span><code className="justify-self-start">{claude?.path ?? '—'}</code>
              <span className="text-muted">版本</span><span className="font-mono text-xs">{claude?.version ?? '—'}</span>
              {claude?.email && <><span className="text-muted">帳號</span><span>{claude.email}</span></>}
            </div>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="font-medium">claude 執行檔路徑（留空自動偵測）</span>
              <input defaultValue={settings.claudePath ?? ''} onBlur={(e) => void save({ claudePath: e.target.value.trim() || undefined })} className={cx(inputClass, 'font-mono text-xs')} />
            </label>
          </section>

          <section id="model" className="flex flex-col gap-3">
            <span className="text-[15px] font-bold">預設模型</span>
            <div className="grid grid-cols-2 gap-2.5">
              {MODELS.map((m) => (
                <label key={m.id} className={cx('flex cursor-pointer gap-2.5 rounded-[14px] p-3.5', settings.defaultModel === m.id ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2')}>
                  <input type="radio" name="model" checked={settings.defaultModel === m.id} onChange={() => void save({ defaultModel: m.id })} className="mt-1.5 accent-brand" />
                  <span className="flex flex-col"><span className="font-medium">{m.label}</span><span className="text-xs text-muted">{m.hint}</span></span>
                </label>
              ))}
            </div>
            <span className="text-xs text-muted">每個任務建立時也可以單獨選擇。</span>
          </section>

          <section id="perm" className="flex flex-col gap-3">
            <span className="text-[15px] font-bold">實作階段權限</span>
            <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#e5e8ed]">
              <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3.5">
                <span className="flex flex-1 flex-col"><span className="font-medium">worktree 內的檔案讀寫自動允許</span><span className="text-xs text-muted">worktree 以外的檔案一律拒絕</span></span>
                <Icons.Check className="text-brand" />
              </div>
              <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3.5">
                <span className="flex flex-1 flex-col"><span className="font-medium">shell 指令需要核准</span><span className="text-xs text-muted">下方清單中的指令永遠允許；含 &&、;、| 的指令一律詢問</span></span>
                <Icons.Check className="text-brand" />
              </div>
              <div className="flex flex-col gap-2.5 px-4 py-3.5">
                <span className="text-[13px] font-medium">永遠允許的指令</span>
                <div className="flex flex-wrap gap-1.5">
                  {settings.alwaysAllowedCommands.map((c) => (
                    <span key={c} className="flex items-center gap-1.5 rounded-full bg-fill py-1 pr-1.5 pl-2.5 font-mono text-xs">
                      {c}
                      <button type="button" aria-label={`移除 ${c}`} onClick={() => void save({ alwaysAllowedCommands: settings.alwaysAllowedCommands.filter((x) => x !== c) })} className="flex size-[22px] items-center justify-center rounded-full text-muted hover:bg-chip"><Icons.X width={10} height={10} /></button>
                    </span>
                  ))}
                </div>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const c = newCmd.trim(); if (c && !settings.alwaysAllowedCommands.includes(c)) void save({ alwaysAllowedCommands: [...settings.alwaysAllowedCommands, c] }); setNewCmd('') }}>
                  <input aria-label="新增指令" value={newCmd} onChange={(e) => setNewCmd(e.target.value)} placeholder="例如 npm test *" className={cx(inputClass, 'h-[38px] flex-1 font-mono text-xs')} />
                  <Button size="sm" type="submit" className="h-[38px]">新增</Button>
                </form>
              </div>
            </div>
          </section>

          <section id="workspace" className="flex flex-col gap-3">
            <span className="text-[15px] font-bold">Worktree 與專案設定</span>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="font-medium">Worktree 存放位置</span>
              <input defaultValue={settings.worktreeRoot} onBlur={(e) => e.target.value.trim() && void save({ worktreeRoot: e.target.value.trim() })} className={cx(inputClass, 'font-mono text-xs')} />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="font-medium">分支名稱前綴</span>
              <input defaultValue={settings.branchPrefix} onBlur={(e) => void save({ branchPrefix: e.target.value.trim() })} className={cx(inputClass, 'font-mono text-xs')} />
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-[14px] px-4 py-3.5 shadow-[0_0_0_1px_#e5e8ed]">
              <span className="flex flex-1 flex-col"><span className="font-medium">載入 repo 的 CLAUDE.md 與 .claude 設定</span><span className="text-xs text-muted">包含專案的 skills 與 MCP；不載入 ~/.claude 的 hooks 與 plugins</span></span>
              <input type="checkbox" checked={settings.loadProjectSettings} onChange={(e) => void save({ loadProjectSettings: e.target.checked })} className="size-[18px] accent-brand" />
            </label>
          </section>
        </div>
      </main>
    </>
  )
}
```

**Step 2: App.tsx 加入** `{view.kind === 'new' && <NewTaskScreen />}`、`{view.kind === 'settings' && <SettingsScreen />}`；settings 時隱藏 Sidebar（設定頁自帶左欄）：`{view.kind !== 'settings' && <Sidebar />}`。

**Step 3: 驗證** — `npm run typecheck` PASS；手動：修改設定後重開 app 仍保留。

**Step 4: Commit**

```bash
git add src/renderer/src
git commit -m "feat(ui): add settings screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## Phase 5：端對端驗證

### Task 35：示範 repo 與完整流程驗證（真實 Claude）

**Files:**
- Create: `scripts/create-demo-repo.sh`
- Create: `docs/verification.md`（記錄驗證結果）

**Step 1: 示範 repo 腳本**

```bash
#!/usr/bin/env bash
# scripts/create-demo-repo.sh — 建立一個小型 Node 專案供端對端驗證
set -euo pipefail
DIR="${1:-$HOME/harness-demo}"
rm -rf "$DIR" && mkdir -p "$DIR/src" "$DIR/test"
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

每一項失敗時：使用 @superpowers:systematic-debugging 找原因、補測試、修正，再重跑該項。

**Step 4: Commit**

```bash
git add scripts docs/verification.md
git commit -m "test: add demo repo script and end-to-end verification record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 完成條件

- `npm test`、`npm run typecheck`、`npm run lint` 全部通過。
- `docs/verification.md` 的 14 項全部打勾。
- `npm run dev` 可在本機啟動並使用訂閱方案的 Claude Code 完成一輪「釐清 → 規格 → 實作 → 報告 → 回饋 → 合併」。
