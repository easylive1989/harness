// 主流程：加入 repo → 釐清 → 規格 → 實作 → 報告 → 合併
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import {
  allow,
  driveToSpec,
  implementActions,
  LOCKOUT_TEST_NAME,
  QUESTION,
  REPORT_HEADLINE,
  SPEC_TITLE
} from './flows'

test('從加入 repo 到合併：每個階段的畫面與 git 結果', async ({ h }) => {
  const { page } = h

  // 釐清：讀檔、問題卡片（建議選項有標記）→ 回答 → 規格
  await driveToSpec(h)
  const t = h.task()
  expect(t.status).toBe('spec_review')
  expect(t.worktreePath).toBe(join(h.worktrees, 'harness-demo', t.branch.replace(/^harness\//, '')))
  expect(t.questions[0]).toMatchObject({
    id: 'q1',
    status: 'answered',
    answer: { optionId: 's423' }
  })
  // 釐清階段 worktree 沒有任何變更
  expect(h.git(t.worktreePath, 'status', '--porcelain')).toBe('')

  // 規格頁：預計測試、決策來源指回問題 1
  await expect(page.getByRole('list', { name: '預計新增的測試' })).toContainText(LOCKOUT_TEST_NAME)
  await expect(page.getByRole('button', { name: '問題 1（查看釐清對話）' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '釐清紀錄' })).toContainText(
    QUESTION.question
  )
  await page.getByRole('button', { name: '核准並開始實作' }).click()

  // 實作：步驟、檔案變更、npm test 要核准
  const turn = await h.claude.nextTurn()
  expect(turn.text).toContain('[spec_approved]')
  expect(turn.resume).toBe(t.mainSessionId)
  await h.claude.reply(turn, implementActions(turn.cwd))
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('npm test')
  await allow(h)
  const result = await h.claude.result(turn)
  expect(result.outcomes.map((o) => [o.name, o.isError])).toEqual([
    ['mcp__harness__update_plan', false],
    ['Edit', false],
    ['Write', false],
    ['Bash', false],
    ['mcp__harness__update_plan', false],
    ['mcp__harness__submit_report', false]
  ])

  // 報告：概觀、新增的測試、由 Harness 重跑的驗證、diff
  const overview = page.getByRole('region', { name: '概觀' })
  await expect(overview).toContainText(REPORT_HEADLINE, { timeout: 60_000 })
  await expect(overview).toContainText('1 / 1 通過')
  await expect(page.getByRole('region', { name: '新增的測試' })).toContainText(LOCKOUT_TEST_NAME)
  await expect(page.getByRole('region', { name: '決策與原因' })).toContainText('鎖定期間回 423')
  await expect(page.getByRole('region', { name: '程式碼變更' })).toContainText('src/login.js')
  const results = page.getByRole('region', { name: '測試結果' })
  await expect(results).toContainText('npm test')
  await expect(results).toContainText('通過')

  const reviewing = h.task()
  expect(reviewing).toMatchObject({ status: 'reviewing', reportVersions: [1], runState: 'idle' })
  // 報告的 commit 在任務分支上，原 repo 的 main 還沒變
  expect(h.git(reviewing.worktreePath, 'log', '-1', '--format=%s')).toBe(
    `${SPEC_TITLE}（Harness 報告 v1）\n`
  )
  expect(h.git(h.demo, 'log', '--format=%s', 'main')).toBe('init demo\n')

  // 合併
  await page.getByRole('button', { name: '合併到 main' }).click()
  await expect(page.getByRole('complementary', { name: '回饋與收尾' })).toContainText(
    '已合併到 main。'
  )
  expect(h.task().status).toBe('done')
  expect(h.git(h.demo, 'log', '--format=%s', 'main')).toContain(`${SPEC_TITLE}（Harness 報告 v1）`)
  expect(existsSync(join(h.demo, 'test/lockout.test.js'))).toBe(true)
  expect(await h.claude.waiting()).toEqual([])
})
