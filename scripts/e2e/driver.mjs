#!/usr/bin/env node
// scripts/e2e/driver.mjs — 手動端對端驗證用的 Harness 驅動程式（不屬於 npm test）
//
// 以 Playwright 的 Electron 支援啟動建置好的 app（out/main/index.js），資料全部放在 E2E 資料夾：
//   <dir>/userData    HARNESS_USER_DATA_DIR（settings.json 預先指定 worktreeRoot）
//   <dir>/worktrees   任務的 worktree
//   <dir>/harness-demo 示範 repo（scripts/create-demo-repo.sh 建立）
//   <dir>/shots       截圖；<dir>/exports 匯出的 HTML；<dir>/app.log 主程序與 renderer 的輸出
//   <dir>/token       指令伺服器的權杖（隨機產生，權限 0600，driver 結束時刪除）
//
// 啟動後在 127.0.0.1:<port> 聽指令：POST /run 的內容是一段 async JS，可用下方 helpers，
// 回傳值以 JSON 傳回。指令能操作 app 與這台電腦，所以伺服器只接受：POST、路徑 /run 或 /quit、
// Host 是 127.0.0.1:<port>、沒有 Origin（瀏覽器發出的請求都有）、x-harness-e2e-token 等於
// <dir>/token 的請求，其他一律拒絕。用 scripts/e2e/run.mjs 送指令（它會讀 <dir>/token），例如：
//   node scripts/e2e/run.mjs --dir <E2E 資料夾> 'await shot("01-settings"); return await state()'
//
// 用法：
//   npx electron-vite build
//   node scripts/e2e/driver.mjs --dir <E2E 資料夾> [--port 47123] [--fresh]
// --fresh 會刪掉 <dir> 下的 userData、worktrees 與示範 repo 重新建立。
import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const dir = opt('dir')
if (!dir) {
  console.error('用法：node scripts/e2e/driver.mjs --dir <E2E 資料夾> [--port 47123] [--fresh]')
  process.exit(1)
}
const port = Number(opt('port', '47123'))
const paths = {
  userData: join(dir, 'userData'),
  worktrees: join(dir, 'worktrees'),
  demo: join(dir, 'harness-demo'),
  shots: join(dir, 'shots'),
  exports: join(dir, 'exports')
}
const dataDir = join(paths.userData, 'harness')
const tokenFile = join(dir, 'token')
const token = randomBytes(32).toString('hex')
const TOKEN_HEADER = 'x-harness-e2e-token'

function prepare() {
  if (args.includes('--fresh')) {
    for (const p of [paths.userData, paths.worktrees]) rmSync(p, { recursive: true, force: true })
    if (existsSync(paths.demo)) rmSync(paths.demo, { recursive: true, force: true })
  }
  for (const p of [paths.shots, paths.exports, paths.worktrees, dataDir])
    mkdirSync(p, { recursive: true })
  if (!existsSync(paths.demo)) {
    execFileSync(join(root, 'scripts/create-demo-repo.sh'), [paths.demo], { stdio: 'inherit' })
  }
  const settingsFile = join(dataDir, 'settings.json')
  if (!existsSync(settingsFile)) {
    writeFileSync(settingsFile, JSON.stringify({ worktreeRoot: paths.worktrees }, null, 2))
  }
}

const log = createWriteStream(join(dir, 'app.log'), { flags: 'a' })
const stamp = () => new Date().toISOString().slice(11, 19)
const logLine = (src, text) => log.write(`[${stamp()}] ${src} ${text}\n`)

let app
let page

async function launch() {
  app = await electron.launch({
    args: [join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, HARNESS_USER_DATA_DIR: paths.userData }
  })
  const proc = app.process()
  proc.stdout?.on('data', (d) => logLine('main', String(d).trimEnd()))
  proc.stderr?.on('data', (d) => logLine('main!', String(d).trimEnd()))
  page = await app.firstWindow()
  page.on('console', (m) => logLine(`renderer:${m.type()}`, m.text()))
  page.on('pageerror', (e) => logLine('renderer!', e.stack ?? String(e)))
  await page.waitForLoadState('domcontentloaded')
  // 確認真的用了暫存的 userData
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  if (resolve(userData) !== resolve(paths.userData))
    throw new Error(`userData 不是暫存資料夾：${userData}`)
  logLine('driver', `launched, userData=${userData}`)
}

async function close() {
  if (!app) return
  const a = app
  app = undefined
  page = undefined
  await a.close()
}

// ───────── helpers（指令裡可直接使用）─────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 截圖到 <dir>/shots/<name>.png，回傳路徑 */
async function shot(name, options = {}) {
  const file = join(paths.shots, `${name}.png`)
  await page.screenshot({ path: file, ...options })
  return file
}

/** 畫面上看得到的文字（預設整個 body） */
const text = (selector = 'body') => page.locator(selector).first().innerText()

/** 讓下一次「選擇資料夾」對話框直接回傳 p */
const stubOpen = (p) =>
  app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, p)

/** 讓下一次「儲存」對話框直接回傳 p */
const stubSave = (p) =>
  app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, p)

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 所有任務（直接讀 userData 裡的 task.json） */
function tasks() {
  const tdir = join(dataDir, 'tasks')
  if (!existsSync(tdir)) return []
  return readdirSync(tdir)
    .map((id) => readJson(join(tdir, id, 'task.json')))
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const task = (id) => (id ? tasks().find((t) => t.id === id) : tasks()[0])

function timeline(id) {
  const t = task(id)
  if (!t) return []
  const file = join(dataDir, 'tasks', t.id, 'timeline.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** 任務狀態摘要：輪詢與判斷下一步用 */
function state(id) {
  const t = task(id)
  if (!t) return undefined
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    runState: t.runState,
    error: t.error,
    openQuestions: t.questions
      .filter((q) => q.status === 'open')
      .map((q) => ({
        id: q.id,
        text: q.text,
        options: q.options.map((o) => `${o.id}: ${o.label}`),
        recommended: q.recommendedOptionId,
        followups: q.followups.length
      })),
    answered: t.questions.filter((q) => q.status === 'answered').length,
    pendingPermission: t.pendingPermission && {
      tool: t.pendingPermission.toolName,
      input: t.pendingPermission.input,
      suggestedPattern: t.pendingPermission.suggestedPattern
    },
    branches: t.branches.map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status,
      running: b.running,
      error: b.error
    })),
    decisions: t.decisions.length,
    specs: t.specs.length,
    plan: t.plan.map((s) => `${s.id}:${s.status}`),
    allowedCommands: t.allowedCommands,
    approvedCommands: t.approvedCommands,
    reportVersions: t.reportVersions,
    worktreePath: t.worktreePath,
    branch: t.branch
  }
}

/** 等到 pred(state) 成立（每 3 秒檢查，預設最多 9 分鐘），回傳最後的狀態 */
async function waitFor(pred, { timeout = 540_000, id, label = '' } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    last = state(id)
    if (last && pred(last)) return last
    await sleep(3000)
  }
  throw new Error(`等待逾時 ${label}：${JSON.stringify(last)}`)
}

/** 等 Claude 這一輪停下來（idle／error／interrupted，或在等核准） */
const waitIdle = (opts = {}) =>
  waitFor((s) => s.runState !== 'running' && s.runState !== 'finalizing', {
    label: 'idle',
    ...opts
  })

/** 在 cwd 執行 git，回傳 stdout */
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })

const helpers = () => ({
  app,
  page,
  paths,
  dataDir,
  sleep,
  shot,
  text,
  stubOpen,
  stubSave,
  tasks,
  task,
  timeline,
  state,
  waitFor,
  waitIdle,
  git,
  readJson,
  // 指令開始時的 page / app 在重新啟動後就失效：restart() 之後的操作請放在下一個指令
  restart: async () => {
    await close()
    await launch()
    return 'restarted'
  },
  close,
  launch
})

// ───────── 指令伺服器 ─────────

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

async function runCode(code) {
  const h = helpers()
  const names = Object.keys(h)
  const fn = new AsyncFunction(...names, code)
  return fn(...names.map((n) => h[n]))
}

/** 權杖寫到 <dir>/token，只有自己讀得到；先刪掉舊檔，權限才一定是 0600 */
function writeToken() {
  rmSync(tokenFile, { force: true })
  writeFileSync(tokenFile, token, { mode: 0o600 })
}
const removeToken = () => rmSync(tokenFile, { force: true })

const sameToken = (got) => {
  const a = Buffer.from(typeof got === 'string' ? got : '')
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 不接受的請求回傳 [狀態碼, 原因]；接受時 undefined */
function rejection(req) {
  if (req.method !== 'POST') return [405, '只接受 POST']
  if (req.url !== '/run' && req.url !== '/quit') return [404, '沒有這個路徑']
  // 瀏覽器發出的請求都帶 Origin（網頁不能用 fetch 對本機伺服器下指令）；Host 不對時可能是 DNS rebinding
  if (req.headers.origin !== undefined) return [403, '拒絕瀏覽器發出的請求']
  if (req.headers.host !== `127.0.0.1:${port}`) return [403, 'Host 不正確']
  if (!sameToken(req.headers[TOKEN_HEADER])) return [401, '權杖不正確']
  return undefined
}

prepare()
writeToken()
process.on('exit', removeToken)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
await launch()

let busy = Promise.resolve()
createServer((req, res) => {
  const bad = rejection(req)
  if (bad) {
    logLine('driver', `rejected ${req.method} ${req.url}: ${bad[1]}`)
    res.writeHead(bad[0], {
      'content-type': 'application/json; charset=utf-8',
      connection: 'close'
    })
    res.end(JSON.stringify({ ok: false, error: bad[1] }))
    req.resume()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    // 指令依序執行
    busy = busy.then(async () => {
      const started = Date.now()
      let out
      try {
        if (req.url === '/quit') {
          await close()
          out = { ok: true, result: 'bye' }
          setTimeout(() => process.exit(0), 100)
        } else {
          logLine('driver', `run: ${body.slice(0, 200).replace(/\n/g, ' ')}`)
          out = { ok: true, result: await runCode(body) }
        }
      } catch (e) {
        out = { ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }
      }
      out.ms = Date.now() - started
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(out, null, 2))
    })
  })
}).listen(port, '127.0.0.1', () => {
  console.log(
    `[e2e] app 已啟動；指令伺服器 http://127.0.0.1:${port}（E2E 資料夾 ${dir}，權杖 ${tokenFile}）`
  )
})
