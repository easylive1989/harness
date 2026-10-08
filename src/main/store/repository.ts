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
    // 開發期間資料的相容：較早的報告沒有 tests（之後才加的欄位），補上預設值，畫面與 PR 內文都不必再判斷
    return { ...r, input: { ...r.input, tests: r.input.tests ?? [] } }
  }
}
