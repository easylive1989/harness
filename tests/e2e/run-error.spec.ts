// Claude 這一輪以錯誤結束（例如用量上限）：畫面顯示原因與「繼續」，繼續後續接同一個 session
import { askUser, expect, fail, test } from './fixtures'
import { QUESTION, questionCard, startTask } from './flows'

test('執行錯誤時顯示原因，按繼續後恢復', async ({ h }) => {
  const { page } = h
  const first = await startTask(h)
  await h.claude.reply(first, [fail('已達到訂閱方案的用量上限')])
  await h.claude.result(first)

  const alert = page.getByRole('alert').filter({ hasText: '已達到訂閱方案的用量上限' })
  await expect(alert).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Repo 與任務' })).toContainText('發生錯誤')
  expect(h.task()).toMatchObject({ runState: 'error', error: '已達到訂閱方案的用量上限' })

  await alert.getByRole('button', { name: '繼續' }).click()
  const resumed = await h.claude.nextTurn()
  expect(resumed.text).toMatch(/^\[resume\]/)
  expect(resumed.resume).toBe(first.sessionId)
  await h.claude.reply(resumed, [askUser(QUESTION)])
  await h.claude.result(resumed)

  await expect(questionCard(h)).toBeVisible()
  await expect(alert).toHaveCount(0)
  const t = h.task()
  expect(t.runState).toBe('idle')
  expect(t.error).toBeUndefined()
})
