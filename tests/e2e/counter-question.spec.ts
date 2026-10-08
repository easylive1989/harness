// 問題卡片上反問：Claude 的回答出現在卡片裡（Markdown），並用同一個 question_id 更新建議
import { askUser, expect, say, test } from './fixtures'
import { QUESTION, questionCard, startTask } from './flows'

test('反問後卡片內顯示回答，建議改到新的選項', async ({ h }) => {
  const first = await startTask(h)
  await h.claude.reply(first, [askUser(QUESTION)])
  await h.claude.result(first)

  const card = questionCard(h)
  await expect(card.getByRole('radio', { name: /423 Locked.*建議/ })).toBeChecked()
  await card.getByRole('textbox', { name: '反問' }).fill('423 和 429 哪個比較常見？')
  await card.getByRole('textbox', { name: '反問' }).press('Enter')

  await h.claude.respond('[counter_question question_id=q1] 423 和 429 哪個比較常見？', [
    say('**429** 比較常見，用戶端多半已經會處理重試。'),
    askUser({ ...QUESTION, recommended_option_id: 's429' })
  ])

  await expect(card).toContainText('你反問了 1 次')
  await expect(card).toContainText('423 和 429 哪個比較常見？')
  // 回答以 Markdown 呈現（粗體），不是原始的 ** 符號
  await expect(card.locator('strong', { hasText: '429' })).toBeVisible()
  await expect(card).not.toContainText('**429**')
  // 卡片留在原位更新：建議換成 429、預設選到它，畫面上只有一張卡片
  await expect(card.getByRole('radio', { name: /429 Too Many Requests.*建議/ })).toBeChecked()
  await expect(h.page.getByRole('region', { name: QUESTION.question })).toHaveCount(1)
  // 回答寫進卡片，不另外出現在時間軸
  await expect(h.page.getByText('比較常見，用戶端多半已經會處理重試。')).toHaveCount(1)

  const q = h.task().questions[0]
  expect(q.recommendedOptionId).toBe('s429')
  expect(q.followups.map((f) => f.role)).toEqual(['user', 'assistant'])
})
