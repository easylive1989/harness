// 實作中插話：Claude 這一輪還沒結束時送出的訊息，進到同一段執行
import { expect, say, test } from './fixtures'
import { driveToImplement, plan } from './flows'

test('執行中插話，Claude 在同一段執行收到', async ({ h }) => {
  const { page } = h
  const first = await driveToImplement(h)
  // Claude 還在這一輪（還沒回覆）時插話
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible()
  const input = page.getByRole('textbox', { name: '插話' })
  await input.fill('錯誤訊息用繁體中文')
  await input.press('Enter')
  await expect(page.getByText('你插話錯誤訊息用繁體中文')).toBeVisible()

  await h.claude.reply(first, [plan('running'), say('收到，先改 login。')])
  await h.claude.result(first)

  const second = await h.claude.nextTurn()
  expect(second).toMatchObject({ run: first.run, text: '錯誤訊息用繁體中文' })
  await h.claude.reply(second, [say('好，錯誤訊息改成繁體中文。')])
  await h.claude.result(second)

  await expect(page.getByText('好，錯誤訊息改成繁體中文。')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0)
  const t = h.task()
  expect(t).toMatchObject({ status: 'implementing', runState: 'idle' })
  expect(t.plan.map((s) => s.status)).toEqual(['done', 'running'])
})
