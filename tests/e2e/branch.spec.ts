// 從 Claude 的訊息開分岔、討論、帶回主線：結論成為主線的決策，分岔換成 Claude 給的主題
import { askUser, concludeBranch, expect, say, test } from './fixtures'
import { QUESTION, questionCard, startTask } from './flows'

const MESSAGE = '鎖定可以從第 3 次失敗開始計時，也可以每次失敗都重新計時。'
const CONCLUSION = '從第 3 次失敗開始計時 1 分鐘'

test('分岔討論後帶回主線，主線收到結論並記成決策', async ({ h }) => {
  const { page } = h
  const first = await startTask(h)
  await h.claude.reply(first, [say(MESSAGE), askUser(QUESTION)])
  await h.claude.result(first)
  const mainSession = h.task().mainSessionId
  expect(mainSession).toBeTruthy()

  // 從訊息分岔：先問想討論什麼，送出才建立分岔
  const message = page.getByText(MESSAGE)
  await message.hover()
  await page.getByRole('button', { name: '從這則訊息分岔' }).click()
  const form = page.getByRole('form', { name: '新分岔' })
  await expect(form).toContainText(MESSAGE)
  await form.getByRole('textbox', { name: '想針對這段討論什麼？' }).fill('計時起點要怎麼算？')
  await form.getByRole('button', { name: '開始討論' }).click()

  const panel = page.getByRole('complementary', { name: '分岔討論' })
  const opened = await h.claude.nextTurn()
  expect(opened).toMatchObject({ kind: 'branch', resume: mainSession })
  // 分岔是從主線的 session fork 出來的新 session
  expect(opened.sessionId).not.toBe(mainSession)
  expect(opened.text).toMatch(/^\[branch_open\]/)
  expect(opened.text).toContain('計時起點要怎麼算？')
  await h.claude.reply(opened, [say('建議從第 3 次失敗開始計時，比較好實作。')])
  await h.claude.result(opened)
  await expect(panel).toContainText('建議從第 3 次失敗開始計時，比較好實作。')

  // 帶回主線：Claude 整理結論並給主題 → 預覽 → 確認
  await panel.getByRole('button', { name: '帶回主線' }).click()
  await h.claude.respond('[conclude]', [
    concludeBranch({
      title: '鎖定計時起點',
      decision: CONCLUSION,
      rationale: '實作簡單，行為好預測',
      deferred: ['每次失敗都重新計時']
    })
  ])
  await expect(panel).toContainText('帶回主線的結論（預覽）')
  await expect(panel.getByRole('button', { name: '鎖定計時起點 · 待確認' })).toBeVisible()
  await panel.getByRole('button', { name: '確認並帶回主線' }).click()

  const back = await h.claude.nextTurn()
  expect(back).toMatchObject({ kind: 'main', resume: mainSession })
  expect(back.text).toMatch(/^\[branch_conclusion branch=b1\]/)
  expect(back.text).toContain(`決策：${CONCLUSION}`)
  expect(back.text).toContain('延後：每次失敗都重新計時')
  // Claude 帶著結論重新提問
  await h.claude.reply(back, [askUser(QUESTION)])
  await h.claude.result(back)

  await expect(panel.getByRole('button', { name: '鎖定計時起點 · 已帶回' })).toBeVisible()
  await expect(page.getByText('分岔「鎖定計時起點」的結論')).toBeVisible()
  await expect(page.getByText(`原因：實作簡單，行為好預測`).first()).toBeVisible()
  // 重新提問的卡片只畫在最新的位置
  await expect(questionCard(h)).toHaveCount(1)

  const t = h.task()
  expect(t.branches[0]).toMatchObject({ id: 'b1', title: '鎖定計時起點', status: 'concluded' })
  expect(t.decisions[0]).toMatchObject({ text: CONCLUSION, source: { type: 'branch', ref: 'b1' } })
})
