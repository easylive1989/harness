// tests/e2e/flows.ts — 情境共用的資料與步驟：示範 repo 的「登入失敗鎖定」需求，
// 從新任務一路走到釐清、規格、實作與報告。各個 spec 從需要的階段開始接手。
import type { FakeAction, FakeTurn } from '../../src/main/e2e/fakeClaude'
import {
  askUser,
  bash,
  expect,
  type Harness,
  proposeSpec,
  say,
  submitReport,
  tool,
  updatePlan
} from './fixtures'

export const REQUEST = '登入連續失敗 3 次就鎖定帳號'

export const QUESTION = {
  question_id: 'q1',
  question: '鎖定期間再登入要回什麼狀態碼？',
  options: [
    { id: 's423', label: '423 Locked', description: '明確表示帳號被鎖定' },
    { id: 's429', label: '429 Too Many Requests', description: '當成請求太頻繁' }
  ],
  recommended_option_id: 's423'
}

export const SPEC_TITLE = '登入失敗鎖定'

export const spec = (extra: Record<string, unknown> = {}) => ({
  title: SPEC_TITLE,
  summary: '同一個帳號連續輸錯 3 次密碼後鎖定，鎖定期間回 423。',
  in_scope: ['src/login.js 記錄連續失敗次數', '新增 test/lockout.test.js'],
  out_of_scope: ['鎖定時間到期後自動解鎖'],
  decisions: [{ id: 'D1', text: '鎖定期間回 423', source: { type: 'question', ref: 'q1' } }],
  tests: [
    {
      id: 'p1',
      name: '連續失敗 3 次後鎖定',
      // 單元測試不會列在規格與報告上：這裡要看到測試卡片，標成整合測試
      kind: 'integration',
      change: 'added',
      scenario: 'alice 已經連續輸錯 3 次',
      expected: '用正確密碼登入仍回 423',
      file: 'test/lockout.test.js'
    }
  ],
  steps: ['記錄連續失敗次數', '加上測試'],
  acceptance: ['npm test 通過'],
  ...extra
})

const LOGIN_OLD = `export function login(username, password) {
  if (users.get(username) === password) return { ok: true }
  return { ok: false, status: 401 }
}`

const LOGIN_NEW = `const failures = new Map()
export function login(username, password) {
  if ((failures.get(username) ?? 0) >= 3) return { ok: false, status: 423 }
  if (users.get(username) === password) {
    failures.delete(username)
    return { ok: true }
  }
  failures.set(username, (failures.get(username) ?? 0) + 1)
  return { ok: false, status: 401 }
}`

export const LOCKOUT_TEST_NAME = '連續失敗 3 次後鎖定'

const LOCKOUT_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { login } from '../src/login.js'

test('${LOCKOUT_TEST_NAME}', () => {
  for (let i = 0; i < 3; i++) assert.equal(login('alice', 'x').status, 401)
  assert.equal(login('alice', 'secret').status, 423)
})
`

/** 實作的檔案變更：改 src/login.js、新增 test/lockout.test.js */
export const editLogin = (cwd: string) =>
  tool('Edit', { file_path: `${cwd}/src/login.js`, old_string: LOGIN_OLD, new_string: LOGIN_NEW })
export const writeLockoutTest = (cwd: string) =>
  tool('Write', { file_path: `${cwd}/test/lockout.test.js`, content: LOCKOUT_TEST })

export const plan = (status: 'pending' | 'running' | 'done') =>
  updatePlan({
    steps: [
      { id: 's1', title: '記錄連續失敗次數', status: status === 'pending' ? 'pending' : 'done' },
      { id: 's2', title: '加上測試', status }
    ]
  })

export const REPORT_HEADLINE = '登入連續失敗 3 次會鎖定帳號'

export const report = (extra: Record<string, unknown> = {}) => ({
  overview: { headline: REPORT_HEADLINE, summary: 'login 記錄連續失敗次數，第 4 次起回 423。' },
  tests: [
    {
      id: 't1',
      file: 'test/lockout.test.js',
      name: LOCKOUT_TEST_NAME,
      // 單元測試不會列在規格與報告上：這裡要看到測試卡片，標成整合測試
      kind: 'integration',
      change: 'added',
      scenario: 'alice 已經連續輸錯 3 次',
      expected: '用正確密碼登入仍回 423',
      line: 5,
      planned: 'p1'
    }
  ],
  architecture: {
    before: {
      nodes: [{ id: 'login', label: 'login()', status: 'unchanged', files: ['src/login.js'] }]
    },
    after: {
      nodes: [
        { id: 'login', label: 'login()', status: 'modified', files: ['src/login.js'] },
        { id: 'failures', label: '失敗次數', status: 'added' }
      ],
      edges: [{ from: 'login', to: 'failures', label: '記錄' }]
    }
  },
  decisions: [
    {
      id: 'D1',
      title: '鎖定期間回 423',
      chosen: '423 Locked',
      rejected: ['429'],
      rationale: '問題 1 選了 423',
      source: { type: 'question', ref: 'q1' }
    }
  ],
  file_notes: [{ path: 'src/login.js', why: '記錄連續失敗次數', hunks: [] }],
  verification: [{ command: 'npm test' }],
  ...extra
})

/** 實作這一輪的動作：步驟、改檔、npm test（要核准）、提交報告 */
export const implementActions = (cwd: string, reportInput = report()): FakeAction[] => [
  plan('running'),
  editLogin(cwd),
  writeLockoutTest(cwd),
  bash('npm test'),
  plan('done'),
  submitReport(reportInput)
]

// ───────── 介面操作 ─────────

/** 新任務頁：用 stub 的對話框加入示範 repo，輸入需求並開始；回傳 Claude 收到的第一則訊息 */
export async function startTask(h: Harness, request = REQUEST): Promise<FakeTurn> {
  const { page } = h
  await h.stubOpenDialog(h.demo)
  await page.getByRole('button', { name: '選擇其他資料夾…' }).click()
  await expect(page.getByRole('radio', { name: /harness-demo/ })).toBeChecked()
  await page.getByLabel('需求').fill(request)
  await page.getByRole('button', { name: '開始釐清' }).click()
  const turn = await h.claude.nextTurn()
  expect(turn.text).toBe(request)
  expect(turn.resume).toBeUndefined()
  return turn
}

export const questionCard = (h: Harness, text = QUESTION.question) =>
  h.page.getByRole('region', { name: text })

/** 在問題卡片選一個選項並確認 */
export async function answer(h: Harness, optionLabel: string, text = QUESTION.question) {
  const card = questionCard(h, text)
  await card.getByRole('radio', { name: optionLabel }).check()
  await card.getByRole('button', { name: '確認答案' }).click()
}

/** 開始任務 → Claude 讀檔並問 q1 → 回答 423 → Claude 提出規格；停在規格頁 */
export async function driveToSpec(h: Harness) {
  const first = await startTask(h)
  await h.claude.reply(first, [
    say('我先看過 `src/login.js` 了。'),
    tool('Read', { file_path: `${first.cwd}/src/login.js` }),
    askUser(QUESTION)
  ])
  await h.claude.result(first)
  await answer(h, '423 Locked')
  await h.claude.respond('[answer question_id=q1 option=s423] 423 Locked', [proposeSpec(spec())])
  await expect(h.page.getByRole('heading', { name: SPEC_TITLE })).toBeVisible()
  return first
}

/** 一路走到核准規格；回傳實作的第一輪（還沒回覆） */
export async function driveToImplement(h: Harness): Promise<FakeTurn> {
  await driveToSpec(h)
  await h.page.getByRole('button', { name: '核准並開始實作' }).click()
  const turn = await h.claude.nextTurn()
  expect(turn.text).toMatch(/^\[spec_approved\]/)
  return turn
}

export const permissionDialog = (h: Harness) => h.page.getByRole('dialog')

/**
 * 等出現一個新的核准請求（id 和 previous 不同），回傳它的 id。
 * 同一個指令連續要求核准時，對話框長得一樣，只能從 task.json 分辨是不是下一個請求
 * （主程序先推送畫面、再寫入磁碟，讀到新的請求時畫面已經收到了）
 */
export async function nextPermission(h: Harness, previous?: string): Promise<string> {
  let id: string | undefined
  await expect
    .poll(() => {
      id = h.task().pendingPermission?.id
      return id !== undefined && id !== previous
    })
    .toBe(true)
  await expect(permissionDialog(h)).toBeVisible()
  return id!
}

/** 在核准對話框按允許（remember：勾「本任務內都允許」） */
export async function allow(h: Harness, { remember = false } = {}) {
  const dialog = permissionDialog(h)
  await expect(dialog).toBeVisible()
  if (remember) await dialog.getByRole('checkbox', { name: /本任務內都允許/ }).check()
  // 對話框剛出現時會停用按鈕一下（防連點），click 會等它可以按
  await dialog.getByRole('button', { name: '允許' }).click()
}

/** 一路走到報告 v1（npm test 核准一次）；停在報告頁 */
export async function driveToReport(h: Harness) {
  const turn = await driveToImplement(h)
  await h.claude.reply(turn, implementActions(turn.cwd))
  await allow(h)
  const result = await h.claude.result(turn)
  expect(result.outcomes.filter((o) => o.isError)).toEqual([])
  await expect(h.page.getByRole('region', { name: '概觀' })).toContainText(REPORT_HEADLINE, {
    timeout: 60_000
  })
  return turn
}
