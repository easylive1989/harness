// 從標題列的「⋯」丟棄任務：worktree 與分支刪除、任務從側欄消失、回到新任務頁
import { existsSync } from 'node:fs'
import { askUser, expect, type Harness, test } from './fixtures'
import { QUESTION, REQUEST, startTask } from './flows'

async function discard(h: Harness, { running = false } = {}) {
  const { page } = h
  const t = h.task()
  await page.getByRole('button', { name: '任務動作' }).click()
  const menu = page.getByRole('group', { name: '任務動作' })
  await menu.getByRole('button', { name: '丟棄任務' }).click()
  await expect(menu).toContainText(`worktree 與分支 ${t.branch} 都會刪除，無法復原。`)
  if (running) await expect(menu).toContainText('Claude 正在執行，會先停止。')
  await menu.getByRole('button', { name: '確定丟棄' }).click()

  await expect(page.getByRole('heading', { name: '想改什麼？' })).toBeVisible()
  await expect(page.getByText(`已丟棄任務「${REQUEST}」`)).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Repo 與任務' })).not.toContainText(REQUEST)
  expect(h.task()).toMatchObject({ status: 'discarded', runState: 'idle' })
  expect(existsSync(t.worktreePath)).toBe(false)
  expect(h.git(h.demo, 'branch', '--list', t.branch)).toBe('')
  expect(h.git(h.demo, 'worktree', 'list', '--porcelain')).not.toContain(t.worktreePath)
  // 原 repo 沒有變動
  expect(h.git(h.demo, 'log', '--format=%s', 'main')).toBe('init demo\n')
  expect(h.git(h.demo, 'status', '--porcelain')).toBe('')
}

test('釐清中有開放的問題時丟棄', async ({ h }) => {
  const first = await startTask(h)
  await h.claude.reply(first, [askUser(QUESTION)])
  await h.claude.result(first)
  await discard(h)
})

test('Claude 執行中丟棄：先停止這一輪', async ({ h }) => {
  const first = await startTask(h)
  await expect(h.page.getByText('Claude 正在處理…')).toBeVisible()
  await discard(h, { running: true })
  expect(await h.claude.result(first)).toEqual({ outcomes: [], interrupted: true })
})
