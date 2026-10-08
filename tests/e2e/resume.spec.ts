// Claude 執行到一半時關閉 app：重新啟動後任務標為「已中斷」，按繼續續接同一個 session
import { askUser, expect, test } from './fixtures'
import { QUESTION, questionCard, REQUEST, startTask } from './flows'

test('關閉 app 時中斷的任務，重新啟動後可以繼續', async ({ h }) => {
  const first = await startTask(h)
  // Claude 還沒回覆（執行中）就關閉 app
  await expect(h.page.getByText('Claude 正在處理…')).toBeVisible()
  await h.restart()
  const { page } = h

  expect(h.task()).toMatchObject({ runState: 'interrupted', mainSessionId: first.sessionId })
  const sidebar = page.getByRole('navigation', { name: 'Repo 與任務' })
  await expect(sidebar).toContainText('已中斷')
  await sidebar.getByRole('button', { name: new RegExp(REQUEST) }).click()

  const alert = page.getByRole('alert').filter({ hasText: '上一次執行被中斷了。' })
  await expect(alert).toBeVisible()
  await alert.getByRole('button', { name: '繼續' }).click()

  const resumed = await h.claude.nextTurn()
  expect(resumed.text).toMatch(/^\[resume\]/)
  expect(resumed.resume).toBe(first.sessionId)
  await h.claude.reply(resumed, [askUser(QUESTION)])
  await h.claude.result(resumed)

  await expect(questionCard(h)).toBeVisible()
  await expect(alert).toHaveCount(0)
  await expect(page.getByText('繼續執行')).toBeVisible()
  expect(h.task().runState).toBe('idle')
})
