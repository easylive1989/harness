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
  assertVersion,
  ensureClaudeReady,
  pickSettingsPatch
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

export function registerIpc(d: IpcDeps) {
  const handlers: Handlers = {
    'claude:status': (refresh) => d.claudeStatus(refresh === true),
    'settings:get': () => d.repo.getSettings(),
    'settings:set': async (raw) => {
      const patch = pickSettingsPatch(raw)
      const next = { ...(await d.repo.getSettings()), ...patch }
      await d.repo.saveSettings(next)
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
      return { branches: await d.git.branches(r.path), current: await d.git.currentBranch(r.path) }
    },
    'tasks:list': () => d.tasks.list(),
    'tasks:create': async (input: CreateTaskInput) => {
      assertId(input?.repoId, 'repo')
      await ensureClaudeReady(d.claudeStatus)
      return d.tasks.createTask(input)
    },
    'tasks:timeline': (taskId) => d.tasks.timeline(task(taskId)),
    'tasks:send': (taskId, channel, text) =>
      d.tasks.send(task(taskId), assertChannel(channel), text),
    'tasks:answer': (taskId, qid, answer) => d.tasks.answerQuestion(task(taskId), qid, answer),
    'tasks:counter': (taskId, qid, text) => d.tasks.counterQuestion(task(taskId), qid, text),
    'tasks:changedFiles': (taskId) => d.tasks.changedFiles(task(taskId)),
    'branch:open': (taskId, input) => d.tasks.openBranch(task(taskId), input),
    'branch:conclude': (taskId, branchId) => d.tasks.concludeBranch(task(taskId), branchId),
    'branch:confirm': (taskId, branchId, edited) =>
      d.tasks.confirmBranch(task(taskId), branchId, edited),
    'spec:approve': (taskId) => d.tasks.approveSpec(task(taskId)),
    'spec:requestChanges': (taskId, text) => d.tasks.requestSpecChanges(task(taskId), text),
    'run:stop': (taskId, channel) => d.tasks.stop(task(taskId), assertChannel(channel)),
    'run:resume': (taskId) => d.tasks.resume(task(taskId)),
    'permission:resolve': (taskId, requestId, decision) =>
      d.tasks.resolvePermission(task(taskId), requestId, decision),
    'report:get': (taskId, version) => d.tasks.getReport(task(taskId), assertVersion(version)),
    'report:feedback': (taskId, items, overall) =>
      d.tasks.submitReportFeedback(task(taskId), items, overall),
    'report:saveHtml': async (suggestedName, html) => {
      const w = d.win()
      if (!w) return null
      const res = await dialog.showSaveDialog(w, {
        defaultPath: suggestedName,
        filters: [{ name: 'HTML', extensions: ['html'] }]
      })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, html)
      return res.filePath
    },
    'finish:pr': (taskId) => d.tasks.createPullRequest(task(taskId)),
    'finish:merge': (taskId) => d.tasks.merge(task(taskId)),
    'finish:discard': (taskId) => d.tasks.discard(task(taskId)),
    'shell:showInFolder': (path) => {
      if (typeof path === 'string' && path) shell.showItemInFolder(path)
    },
    'shell:openExternal': async (url) => {
      if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url)
    }
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_e, ...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(...args)
    )
  }
}
