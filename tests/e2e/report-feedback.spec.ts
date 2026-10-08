// 報告回饋：對 diff 的一行與一個決策留言 → 送出 → Claude 修改並提交 v2；回看 v1 只能看；匯出 HTML
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, submitReport, test, tool } from './fixtures'
import { driveToReport, report, REPORT_HEADLINE } from './flows'

const V2_HEADLINE = '鎖定時回傳 retryAfter'

test('回饋產生 v2、切換版本、匯出 HTML', async ({ h }) => {
  const { page } = h
  await driveToReport(h)

  // 對 src/login.js 第 4 行（鎖定時的回傳）留言
  const diff = page.getByRole('region', { name: '程式碼變更' })
  await diff.getByRole('button', { name: /^src\/login\.js/ }).click()
  await diff.getByRole('button', { name: '對第 4 行留言' }).click()
  await diff.getByRole('textbox', { name: '回饋' }).fill('423 也要帶 retryAfter')
  await diff.getByRole('textbox', { name: '回饋' }).press('Enter')
  await expect(diff).toContainText('回饋 · 第 4 行')

  // 對決策 D1 留言
  const decisions = page.getByRole('region', { name: '決策與原因' })
  await decisions.getByRole('button', { name: '對決策 D1 留言' }).click()
  await decisions.getByRole('textbox', { name: '回饋' }).fill('說明為什麼不用 429')
  await decisions.getByRole('textbox', { name: '回饋' }).press('Enter')

  const panel = page.getByRole('complementary', { name: '回饋與收尾' })
  await expect(panel).toContainText('2 則待送出')
  await panel.getByRole('button', { name: '送出回饋，產生 v2' }).click()

  const turn = await h.claude.nextTurn()
  expect(turn.text).toMatch(/^\[report_feedback\]/)
  expect(turn.text).toContain('- (diff:src/login.js:4) 423 也要帶 retryAfter')
  expect(turn.text).toContain('- (decision:D1) 說明為什麼不用 429')
  expect(h.task().status).toBe('implementing')
  // 回到實作階段的畫面
  await expect(
    page.getByRole('navigation', { name: '任務階段' }).getByRole('button', { name: /實作/ })
  ).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('textbox', { name: '插話' })).toBeVisible()

  await h.claude.reply(turn, [
    tool('Edit', {
      file_path: `${turn.cwd}/src/login.js`,
      old_string: 'return { ok: false, status: 423 }',
      new_string: 'return { ok: false, status: 423, retryAfter: 60 }'
    }),
    submitReport(
      report({
        overview: { headline: V2_HEADLINE, summary: '鎖定時回傳 retryAfter: 60。' },
        decisions: [
          {
            id: 'D1',
            title: '鎖定期間回 423',
            chosen: '423 Locked',
            rejected: ['429'],
            rationale: '429 表示請求太頻繁，不是帳號狀態',
            source: { type: 'user', ref: '說明為什麼不用 429' }
          }
        ]
      })
    )
  ])
  await h.claude.result(turn)

  // v2：最新版本、可以留言；npm test 在本任務核准過，由 Harness 重跑
  const overview = page.getByRole('region', { name: '概觀' })
  await expect(overview).toContainText(V2_HEADLINE, { timeout: 60_000 })
  await expect(overview).toContainText('1 / 1 通過')
  const version = page.getByRole('combobox', { name: '版本' })
  await expect(version).toHaveValue('2')
  expect(h.task()).toMatchObject({ status: 'reviewing', reportVersions: [1, 2] })

  // 回看 v1：只能看
  await version.selectOption('1')
  await expect(overview).toContainText(REPORT_HEADLINE)
  await expect(page.getByText('正在看 v1（舊版本），只能看')).toBeVisible()
  await expect(page.getByRole('button', { name: '對決策 D1 留言' })).toHaveCount(0)
  await page.getByRole('button', { name: '回到 v2' }).click()
  await expect(overview).toContainText(V2_HEADLINE)

  // 匯出 v2：沒有按鈕與輸入框的靜態 HTML
  const file = join(h.dir, 'report-v2.html')
  await h.stubSaveDialog(file)
  await page.getByRole('button', { name: '匯出 HTML' }).click()
  await expect(page.getByText(`已匯出：${file}`)).toBeVisible()
  expect(existsSync(file)).toBe(true)
  const html = readFileSync(file, 'utf8')
  expect(html).toContain(V2_HEADLINE)
  expect(html).toContain('retryAfter: 60')
  expect(html).not.toMatch(/<(button|input|textarea)\b/)
})
