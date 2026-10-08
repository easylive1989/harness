// 釐清階段只能讀：Edit 與 Bash 被 Harness 的規則擋下（即使示範 repo 的 .claude/settings.json 允許），
// 時間軸顯示「已阻擋」而不是錯誤，也不會跳出核准框，worktree 保持乾淨
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { askUser, bash, expect, test, tool } from './fixtures'
import { QUESTION, startTask } from './flows'

test('釐清中 Claude 改檔與執行指令都被阻擋', async ({ h }) => {
  const { page } = h
  const first = await startTask(h)
  const readme = join(first.cwd, 'README.md')
  await h.claude.reply(first, [
    tool('Edit', { file_path: readme, old_string: '# harness-demo', new_string: '# 改掉' }),
    bash('npm test'),
    askUser(QUESTION)
  ])
  const { outcomes } = await h.claude.result(first)

  expect(outcomes.map((o) => [o.name, o.isError])).toEqual([
    ['Edit', true],
    ['Bash', true],
    ['mcp__harness__ask_user', false]
  ])
  expect(outcomes[0].text).toContain('目前不是實作階段，不能修改檔案')
  expect(outcomes[1].text).toContain('目前不是實作階段，不能執行指令')

  // 時間軸：中性的「已阻擋：原因」，不帶 SDK 的 hook error 前綴，不是紅色的工具錯誤
  await expect(page.getByText(/^已阻擋：目前不是實作階段，不能修改檔案/)).toBeVisible()
  await expect(page.getByText(/^已阻擋：目前不是實作階段，不能執行指令/)).toBeVisible()
  await expect(page.getByText(/^工具錯誤：/)).toHaveCount(0)
  await expect(page.getByText(/hook error/)).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('region', { name: QUESTION.question })).toBeVisible()

  expect(readFileSync(readme, 'utf8')).toBe('# harness-demo\n')
  expect(h.git(first.cwd, 'status', '--porcelain')).toBe('')
  expect(h.task().status).toBe('clarifying')
})
