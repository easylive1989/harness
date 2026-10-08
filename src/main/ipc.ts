// src/main/ipc.ts
// 把 IpcApi 的每個 channel 對應到實作；這裡只做對應與輸入檢查，邏輯放在各模組
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { type BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { CreateTaskInput, IpcApi, IpcChannel } from '@shared/ipc'
import type { ClaudeStatus, ModelOption, Repo } from '@shared/types'
import type { GitService } from './git/gitService'
import {
  assertChannel,
  assertEffort,
  assertId,
  assertImageRef,
  assertImages,
  assertModel,
  assertPermissionMode,
  assertRunOptionsPatch,
  assertString,
  assertVersion,
  assertWorkspace,
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
  models: (refresh?: boolean) => Promise<ModelOption[]>
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
    'claude:models': (refresh) => d.models(refresh === true),
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
    'repos:remove': (repoId) => d.tasks.removeRepo(assertId(repoId, 'repo')),
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
        images: assertImages(raw.images),
        baseBranch: assertString(raw.baseBranch, 'base branch', { max: 255 }),
        model: assertModel(raw.model),
        effort: raw.effort === undefined ? 'auto' : assertEffort(raw.effort),
        permissionMode:
          raw.permissionMode === undefined ? 'manual' : assertPermissionMode(raw.permissionMode),
        workspace: raw.workspace === undefined ? 'worktree' : assertWorkspace(raw.workspace)
      }
      await ensureClaudeReady(d.claudeStatus)
      return d.tasks.createTask(input)
    },
    'tasks:timeline': (taskId) => d.tasks.timeline(task(taskId)),
    'tasks:send': (taskId, channel, msg, rawImages) => {
      const images = assertImages(rawImages)
      // 有附加圖片時可以不寫文字
      const body = assertString(msg, '訊息', { allowEmpty: images.length > 0 })
      return d.tasks.sendMessage(task(taskId), assertChannel(channel), body, images)
    },
    'tasks:answer': (taskId, qid, answer) =>
      d.tasks.answerQuestion(task(taskId), ref(qid, '問題 id'), answer),
    'tasks:counter': (taskId, qid, msg) =>
      d.tasks.counterQuestion(task(taskId), ref(qid, '問題 id'), text(msg)),
    'tasks:setRunOptions': (taskId, patch) =>
      d.tasks.setRunOptions(task(taskId), assertRunOptionsPatch(patch)),
    'tasks:changedFiles': (taskId) => d.tasks.changedFiles(task(taskId)),
    'attachments:read': (taskId, image) => d.tasks.readImage(task(taskId), assertImageRef(image)),
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
