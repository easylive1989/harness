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
import { BLOCK_CSP, parseBlockUrl, wrapBlockHtml } from './report/blockHtml'
import { Repository } from './store/repository'
import { Store } from './store/store'
import { TaskManager } from './tasks/taskManager'
import { createHarnessServer } from './tools/harnessTools'
import { runVerification } from './verify/verifyRunner'

// 自訂區塊用獨立的 scheme：iframe 不和 renderer 同源，也拿不到 preload 的 bridge
protocol.registerSchemesAsPrivileged([
  { scheme: 'harness-block', privileges: { standard: true, secure: true } }
])

/** 關閉 app 時等執行停下來的上限（TaskManager 內每個階段各自也有上限） */
const SHUTDOWN_TIMEOUT_MS = 3000

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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.harness.app')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))
  // 必須在 detectClaude 之前：從 Finder 啟動時 PATH 不含 homebrew / nvm
  await applyLoginShellPath()

  const repo = new Repository(
    new Store(join(app.getPath('userData'), 'harness')),
    app.getPath('home')
  )
  const git = new GitService()
  let claude: ClaudeStatus = await detectClaude(execCapture, (await repo.getSettings()).claudePath)
  const claudeStatus = async (refresh?: boolean) => {
    if (refresh) claude = await detectClaude(execCapture, (await repo.getSettings()).claudePath)
    return claude
  }
  const emit = (e: AppEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(APP_EVENT_CHANNEL, e)
  }

  const tm = new TaskManager({
    repo,
    git,
    emit,
    queryFn: query as unknown as QueryFn,
    createToolServer: createHarnessServer,
    getClaudePath: () => claude.path,
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
  const hardLimit = new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS))
  void Promise.race([tasks.shutdown().catch((err) => console.error(err)), hardLimit]).finally(() =>
    app.exit(0)
  )
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
