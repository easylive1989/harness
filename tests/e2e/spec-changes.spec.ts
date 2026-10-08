// 規格要求修改：回到釐清、Claude 收到意見後提出 v2；可以回看 v1，核准的是最新版
import { expect, proposeSpec, test } from './fixtures'
import { driveToSpec, spec } from './flows'

test('要求修改規格後產生 v2，回看 v1 不能核准，核准 v2 進入實作', async ({ h }) => {
  const { page } = h
  await driveToSpec(h)

  await page.getByRole('textbox', { name: '修改意見' }).fill('一併擋掉空密碼')
  await page.getByRole('button', { name: '要求修改' }).click()

  const turn = await h.claude.nextTurn()
  expect(turn.text).toBe('[spec_feedback] 一併擋掉空密碼')
  // 等 Claude 回覆的期間任務回到釐清
  expect(h.task().status).toBe('clarifying')
  await expect(page.getByText('要求修改規格：一併擋掉空密碼')).toBeVisible()
  const v2 = spec({
    summary: '連續輸錯 3 次鎖定，空密碼直接拒絕。',
    decisions: [
      { id: 'D1', text: '鎖定期間回 423', source: { type: 'question', ref: 'q1' } },
      { id: 'D2', text: '空密碼直接回 400', source: { type: 'user', ref: '一併擋掉空密碼' } }
    ]
  })
  await h.claude.reply(turn, [proposeSpec(v2)])
  await h.claude.result(turn)

  const version = page.getByRole('combobox', { name: '規格版本' })
  await expect(version).toHaveValue('2')
  await expect(page.getByText('空密碼直接回 400')).toBeVisible()
  // 使用者在規格回饋中直接給的指示
  await expect(page.getByText('你的指示')).toBeVisible()

  // 回看 v1：只能看，核准與修改都針對最新版
  await version.selectOption('1')
  await expect(page.getByText('正在看 v1（舊版本）')).toBeVisible()
  await expect(page.getByText('空密碼直接回 400')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '核准並開始實作' })).toBeDisabled()
  await page.getByRole('button', { name: '回到 v2' }).click()
  await expect(version).toHaveValue('2')

  await page.getByRole('button', { name: '核准並開始實作' }).click()
  const implement = await h.claude.nextTurn()
  expect(implement.text).toMatch(/^\[spec_approved\]/)
  const t = h.task()
  expect(t.status).toBe('implementing')
  expect(t.specs.map((s) => s.version)).toEqual([1, 2])
})
