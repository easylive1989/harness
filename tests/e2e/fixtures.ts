// tests/e2e/fixtures.ts — 端對端測試的共用設定
//
// 每個測試一個獨立的暫存資料夾：userData（HARNESS_USER_DATA_DIR）、worktree 位置與示範 repo
// （scripts/create-demo-repo.sh），不碰使用者真正的資料。app 以 HARNESS_E2E_FAKE_CLAUDE=1 啟動，
// 測試用 `claude` 控制假 Claude（src/main/e2e/fakeClaude.ts）每一輪要回什麼。
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test as base,
  type TestInfo
} from '@playwright/test'
import type {
  FakeAction,
  FakeClaudeController,
  FakeTurn,
  FakeTurnResult
} from '../../src/main/e2e/fakeClaude'
import type { Task } from '../../src/shared/types'

export { expect }

const root = fileURLToPath(new URL('../..', import.meta.url))
const MAIN = join(root, 'out/main/index.js')

/** git 的身分：示範 repo 與報告的 commit 不依賴這台電腦的 git 設定 */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Harness E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'Harness E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.com'
}

// ───────── 假 Claude 的動作 ─────────

export const say = (text: string): FakeAction => ({ type: 'text', text })
export const tool = (name: string, input: Record<string, unknown>): FakeAction => ({
  type: 'tool',
  name,
  input
})
const harness = (name: string) => (input: Record<string, unknown>) =>
  tool(`mcp__harness__${name}`, input)
export const askUser = harness('ask_user')
export const proposeSpec = harness('propose_spec')
export const updatePlan = harness('update_plan')
export const concludeBranch = harness('conclude_branch')
export const submitReport = harness('submit_report')
export const bash = (command: string) => tool('Bash', { command })
export const fail = (message: string): FakeAction => ({ type: 'error', message })

/**
 * 控制假 Claude：透過 electronApp.evaluate 呼叫 main 程序 globalThis 上的控制器。
 * evaluate 的函式會被序列化到 main 程序執行，不能用到外面的變數（參數另外傳）。
 */
export class Claude {
  constructor(private readonly app: () => ElectronApplication) {}

  /** 等 app 送給 Claude 的下一則訊息 */
  nextTurn(timeoutMs = 15_000): Promise<FakeTurn> {
    return this.app().evaluate(
      (_e, t) => (globalThis as unknown as Fake).__harnessFakeClaude.nextTurn(t),
      timeoutMs
    )
  }

  /** 指定這一輪要做的事（不等它做完） */
  reply(turn: FakeTurn, actions: FakeAction[]): Promise<void> {
    return this.app().evaluate(
      (_e, a) => (globalThis as unknown as Fake).__harnessFakeClaude.reply(a.id, a.actions),
      { id: turn.id, actions }
    )
  }

  /** 等這一輪做完 */
  result(turn: FakeTurn, timeoutMs = 60_000): Promise<FakeTurnResult> {
    return this.app().evaluate(
      (_e, a) => (globalThis as unknown as Fake).__harnessFakeClaude.turnResult(a.id, a.t),
      { id: turn.id, t: timeoutMs }
    )
  }

  /** 等下一則訊息、確認內容，回覆並等這一輪做完；工具呼叫預設都要成功 */
  async respond(
    expected: string | RegExp,
    actions: FakeAction[],
    { allowToolErrors = false } = {}
  ): Promise<{ turn: FakeTurn; result: FakeTurnResult }> {
    const turn = await this.nextTurn()
    if (typeof expected === 'string') expect(turn.text).toContain(expected)
    else expect(turn.text).toMatch(expected)
    await this.reply(turn, actions)
    const result = await this.result(turn)
    if (!allowToolErrors) expect(result.outcomes.filter((o) => o.isError)).toEqual([])
    return { turn, result }
  }

  /** 還沒交給測試的回合 */
  waiting(): Promise<FakeTurn[]> {
    return this.app().evaluate(() => (globalThis as unknown as Fake).__harnessFakeClaude.waiting())
  }
}

type Fake = { __harnessFakeClaude: FakeClaudeController }

// ───────── 每個測試的 app ─────────

export interface Harness {
  /** 這個測試的暫存資料夾 */
  dir: string
  /** 示範 repo（main 分支、init demo 一個 commit） */
  demo: string
  dataDir: string
  worktrees: string
  app: ElectronApplication
  page: Page
  claude: Claude
  /** 關閉 app 再以同樣的資料啟動（page 與 app 換成新的） */
  restart(): Promise<void>
  /** 讓下一次「選擇資料夾」對話框直接回傳 p */
  stubOpenDialog(p: string): Promise<void>
  /** 讓下一次「儲存」對話框直接回傳 p */
  stubSaveDialog(p: string): Promise<void>
  /** 所有任務（直接讀 userData 裡的 task.json），新的在前 */
  tasks(): Task[]
  /** 最新的任務 */
  task(): Task
  git(cwd: string, ...args: string[]): string
}

function readTasks(dataDir: string): Task[] {
  const dir = join(dataDir, 'tasks')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((id) => {
      try {
        return [JSON.parse(readFileSync(join(dir, id, 'task.json'), 'utf8')) as Task]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function attachFailure(h: Harness | undefined, testInfo: TestInfo, dir: string) {
  if (!h) return
  try {
    await testInfo.attach('screenshot', {
      body: await h.page.screenshot(),
      contentType: 'image/png'
    })
  } catch {
    /* 視窗可能已經關了 */
  }
  try {
    await testInfo.attach('waiting-turns', {
      body: JSON.stringify(await h.claude.waiting(), null, 2),
      contentType: 'application/json'
    })
  } catch {
    /* app 可能已經關了 */
  }
  const log = join(dir, 'app.log')
  if (existsSync(log)) await testInfo.attach('app.log', { path: log, contentType: 'text/plain' })
  const tasks = readTasks(join(dir, 'userData', 'harness'))
  if (tasks.length)
    await testInfo.attach('tasks.json', {
      body: JSON.stringify(tasks, null, 2),
      contentType: 'application/json'
    })
}

export const test = base.extend<{ h: Harness }>({
  // 第二個參數不叫 use：ESLint 的 react-hooks 規則會把 use(...) 當成 React 的 use
  // eslint-disable-next-line no-empty-pattern
  h: async ({}, provide, testInfo) => {
    if (!existsSync(MAIN))
      throw new Error('找不到 out/main/index.js：請先執行 npx electron-vite build')
    // realpath：macOS 的 /var 是 /private/var 的 symlink，git 回報的是解開後的路徑
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-e2e-')))
    const userData = join(dir, 'userData')
    const dataDir = join(userData, 'harness')
    const worktrees = join(dir, 'worktrees')
    const demo = join(dir, 'harness-demo')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(worktrees, { recursive: true })
    execFileSync(join(root, 'scripts/create-demo-repo.sh'), [demo], {
      env: { ...process.env, ...GIT_ENV },
      stdio: 'ignore'
    })
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({ worktreeRoot: worktrees }, null, 2)
    )
    const logLines: string[] = []
    const flushLog = () => writeFileSync(join(dir, 'app.log'), logLines.join('\n'))

    let app!: ElectronApplication
    let page!: Page
    const launch = async () => {
      app = await electron.launch({
        args: [MAIN],
        cwd: root,
        env: {
          ...process.env,
          ...GIT_ENV,
          HARNESS_USER_DATA_DIR: userData,
          HARNESS_E2E_FAKE_CLAUDE: '1'
        } as Record<string, string>
      })
      const proc = app.process()
      proc.stdout?.on('data', (d) => logLines.push(`[main] ${String(d).trimEnd()}`))
      proc.stderr?.on('data', (d) => logLines.push(`[main!] ${String(d).trimEnd()}`))
      page = await app.firstWindow()
      page.on('console', (m) => logLines.push(`[renderer:${m.type()}] ${m.text()}`))
      page.on('pageerror', (e) => logLines.push(`[renderer!] ${e.stack ?? String(e)}`))
      await page.waitForLoadState('domcontentloaded')
      const actual = await app.evaluate(({ app: a }) => a.getPath('userData'))
      if (resolve(actual) !== resolve(userData))
        throw new Error(`userData 不是暫存資料夾：${actual}`)
      // 等 renderer 載入完（側欄出現）
      await expect(page.getByRole('button', { name: '新任務' })).toBeVisible()
    }
    const close = async () => {
      if (!app) return
      await app.close()
    }
    await launch()

    const h: Harness = {
      dir,
      demo,
      dataDir,
      worktrees,
      get app() {
        return app
      },
      get page() {
        return page
      },
      claude: new Claude(() => app),
      async restart() {
        await close()
        await launch()
      },
      async stubOpenDialog(p) {
        await app.evaluate(({ dialog }, target) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [target]
          })) as unknown as typeof dialog.showOpenDialog
        }, p)
      },
      async stubSaveDialog(p) {
        await app.evaluate(({ dialog }, target) => {
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath: target
          })) as unknown as typeof dialog.showSaveDialog
        }, p)
      },
      tasks: () => readTasks(dataDir),
      task() {
        const t = readTasks(dataDir)[0]
        if (!t) throw new Error('還沒有任務')
        return t
      },
      git: (cwd, ...args) =>
        execFileSync('git', ['-C', cwd, ...args], {
          encoding: 'utf8',
          env: { ...process.env, ...GIT_ENV }
        })
    }

    let failed = true
    try {
      await provide(h)
      failed = testInfo.status !== testInfo.expectedStatus
    } finally {
      flushLog()
      if (failed) await attachFailure(h, testInfo, dir)
      await close().catch(() => undefined)
      // 失敗時留著暫存資料夾方便查看
      if (failed) console.log(`[e2e] 測試失敗，資料留在 ${dir}`)
      else rmSync(dir, { recursive: true, force: true })
    }
  }
})
