// tests/fixtures/report.ts
import type { ReportInput } from '@shared/report'
import type { Report } from '@shared/types'

export const sampleReport: ReportInput = {
  overview: { headline: '登入流程多了一道鎖定關卡', summary: '在 IP 限流之後加入 lockoutGuard。' },
  planned_skipped: [],
  tests: [
    {
      id: 't1',
      file: 'src/auth/lockout.test.ts',
      name: '連續失敗 5 次後鎖定帳號',
      kind: 'unit',
      change: 'added',
      scenario: '同一帳號連續輸錯密碼 5 次 → 第 6 次登入 → 回 423，而且不再檢查密碼',
      line: 3
    },
    {
      id: 't2',
      file: 'src/auth/login.test.ts',
      name: '錯誤密碼回 401',
      kind: 'integration',
      change: 'modified',
      scenario: '帳號沒有被鎖定時輸錯密碼 → 登入 → 仍然回 401',
      why: '登入前多了鎖定檢查，測試要先準備一個沒有被鎖定的帳號'
    }
  ],
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
      edges: [
        { from: 'client', to: 'guard' },
        { from: 'guard', to: 'login' }
      ]
    }
  },
  decisions: [
    {
      id: 'd1',
      title: '計數存在 Redis',
      chosen: '既有 Redis',
      rejected: ['in-memory'],
      rationale: '多台機器共享',
      source: { type: 'branch', ref: 'b1' }
    }
  ],
  limitations: [{ title: 'Redis 掛掉時放行', detail: 'fail-open', severity: 'medium' }],
  followups: [{ title: '後台解鎖', detail: '' }],
  file_notes: [
    {
      path: 'src/auth/lockout.ts',
      why: '獨立計數邏輯',
      hunks: [{ line_start: 12, line_end: 20, why: 'TTL 用 EXPIRE' }]
    }
  ],
  verification: [{ command: 'npm test' }],
  custom_blocks: [{ id: 'state-machine', title: '鎖定狀態機', html: '<div>正常 → 鎖定</div>' }]
}

/**
 * 四個檔案的 diff：新增 lockout.ts（4 行）、login.ts 改一行加一行，
 * 新增測試檔 lockout.test.ts（5 行）、既有測試檔 login.test.ts 加一行
 */
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
diff --git a/src/auth/lockout.test.ts b/src/auth/lockout.test.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/auth/lockout.test.ts
@@ -0,0 +1,5 @@
+import { test } from 'vitest'
+
+test('連續失敗 5 次後鎖定帳號', async () => {
+  // 失敗 5 次後，第 6 次回 423
+})
diff --git a/src/auth/login.test.ts b/src/auth/login.test.ts
index 5555555..6666666 100644
--- a/src/auth/login.test.ts
+++ b/src/auth/login.test.ts
@@ -1,3 +1,4 @@
 test('錯誤密碼回 401', async () => {
+  await unlock('alice')
   expect((await login('alice', 'x')).status).toBe(401)
 })
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
      files: 4,
      additions: 12,
      deletions: 1,
      perFile: [
        { path: 'src/auth/lockout.ts', additions: 4, deletions: 0 },
        { path: 'src/auth/login.ts', additions: 2, deletions: 1 },
        { path: 'src/auth/lockout.test.ts', additions: 5, deletions: 0 },
        { path: 'src/auth/login.test.ts', additions: 1, deletions: 0 }
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
