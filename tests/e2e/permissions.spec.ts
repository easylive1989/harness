// 實作中的指令核准：只允許一次、本任務內都允許（之後同類指令不再詢問）、拒絕並說明
import { bash, expect, say, test } from './fixtures'
import { allow, driveToImplement, nextPermission, permissionDialog } from './flows'

test('允許一次、記住樣式、拒絕並說明', async ({ h }) => {
  const { page } = h
  const turn = await driveToImplement(h)
  await h.claude.reply(turn, [
    bash('npm test'),
    bash('npm test'),
    bash('npm test -- --test-reporter=dot'),
    bash('git ls-files'),
    say('改用 Glob 找檔案。'),
    bash('node --version')
  ])
  const dialog = permissionDialog(h)

  // 1. 只允許一次
  const first = await nextPermission(h)
  await expect(dialog).toContainText('npm test')
  await expect(
    dialog.getByRole('checkbox', { name: '本任務內都允許 npm test *' })
  ).not.toBeChecked()
  await allow(h)

  // 2. 同一個指令再問一次；這次勾「本任務內都允許」
  const second = await nextPermission(h, first)
  await allow(h, { remember: true })

  // 3. 符合 npm test * 的指令不再詢問；下一個核准框是 git ls-files
  const third = await nextPermission(h, second)
  await expect(dialog).toContainText('git ls-files')
  await dialog.getByRole('button', { name: '拒絕並說明' }).click()
  await dialog.getByRole('textbox', { name: '拒絕原因' }).fill('不需要，用 Glob 就好')
  await dialog.getByRole('button', { name: '送出拒絕' }).click()

  // 4. 等下一個核准（node --version）時，最近的動作列出前面的結果：git ls-files 已拒絕
  await nextPermission(h, third)
  await expect(dialog).toContainText('node --version')
  const recent = page.getByRole('region', { name: '最近的動作' })
  await expect(recent.getByRole('listitem').filter({ hasText: 'git ls-files' })).toContainText(
    '已拒絕'
  )
  await expect(recent.getByRole('listitem').filter({ hasText: 'node --version' })).toContainText(
    '等待核准'
  )
  await expect(page.getByRole('complementary', { name: '變更檔案' })).toContainText('npm test *')
  await allow(h)

  const { outcomes } = await h.claude.result(turn)
  expect(outcomes.map((o) => [o.name, o.isError])).toEqual([
    ['Bash', false],
    ['Bash', false],
    ['Bash', false],
    ['Bash', true],
    ['Bash', false]
  ])
  // Claude 收到使用者填的原因
  expect(outcomes[3].text).toBe('不需要，用 Glob 就好')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('改用 Glob 找檔案。')).toBeVisible()

  const t = h.task()
  expect(t.allowedCommands).toEqual(['npm test *'])
  expect(t.approvedCommands).toEqual(['npm test', 'node --version'])
  expect(t.pendingPermission).toBeUndefined()
})
