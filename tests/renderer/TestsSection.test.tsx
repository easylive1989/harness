// tests/renderer/TestsSection.test.tsx
// 報告的「新增的測試」區塊：排在概觀之後、情境說明、驗證結果、跳到 diff、未說明的測試檔、留言
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
import { call } from '@renderer/api'
import { ReportScreen } from '@renderer/screens/ReportScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Report } from '@shared/types'
import { bigDiff, makeReport, sampleDiff } from '../fixtures/report'
import { makeTask } from '../fixtures/task'

let report: Report
const scrolled = vi.fn()
/** 只有程式碼、沒有測試檔的 diff */
const srcDiff = sampleDiff.slice(0, sampleDiff.indexOf('diff --git a/src/auth/lockout.test.ts'))

const task = makeTask({ status: 'reviewing', reportVersions: [1] })
const renderReport = (readOnly = false) => {
  useStore.setState({ tasks: { [task.id]: task } })
  return render(<ReportScreen task={task} nav={null} readOnly={readOnly} onOpenStage={vi.fn()} />)
}
const loaded = () => screen.findByRole('heading', { name: '登入流程多了一道鎖定關卡' })
const section = () => screen.getByRole('region', { name: '新增的測試' })
/** 某個測試項目（以名稱找到它的卡片） */
const item = (name: string) =>
  within(section()).getByText(name).closest<HTMLElement>('[data-anchor]')!
const files = () => screen.getByRole('group', { name: '變更的檔案' })
const pressed = () =>
  within(files())
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent
/** 最後一次捲動的目標元素的錨點 */
const lastScrolled = () =>
  (scrolled.mock.contexts.at(-1) as HTMLElement | undefined)?.dataset.anchor

beforeEach(() => {
  report = makeReport()
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string) =>
    ch === 'report:get' ? report : undefined) as typeof call)
  resetStoreInternals()
  useStore.setState({ tasks: {}, timelines: {}, feedback: {}, toast: undefined })
  scrolled.mockReset()
  Element.prototype.scrollIntoView = scrolled
})
afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView
})

test('新增的測試排在概觀之後、其他區塊之前，列出名稱、檔案、類型、情境與修改原因', async () => {
  const { container } = renderReport()
  await loaded()
  const order = [...container.querySelectorAll('section[aria-label]')].map((s) =>
    s.getAttribute('aria-label')
  )
  expect(order.slice(0, 3)).toEqual(['概觀', '新增的測試', '架構前後對照'])

  const added = item('連續失敗 5 次後鎖定帳號')
  expect(added).toHaveAttribute('data-anchor', 'test:t1')
  expect(within(added).getByText('src/auth/lockout.test.ts:3')).toBeInTheDocument()
  expect(within(added).getByText('新增')).toBeInTheDocument()
  expect(within(added).getByText('單元')).toBeInTheDocument()
  expect(added).toHaveTextContent(
    '情境同一帳號連續輸錯密碼 5 次 → 第 6 次登入 → 回 423，而且不再檢查密碼'
  )
  expect(within(added).queryByText('為什麼改')).not.toBeInTheDocument()

  const modified = item('錯誤密碼回 401')
  expect(within(modified).getByText('src/auth/login.test.ts')).toBeInTheDocument()
  expect(within(modified).getByText('修改')).toBeInTheDocument()
  expect(within(modified).getByText('整合')).toBeInTheDocument()
  expect(modified).toHaveTextContent('為什麼改登入前多了鎖定檢查，測試要先準備一個沒有被鎖定的帳號')

  // 概觀多一格「新增測試」：只算新增的，修改的另外標
  const overview = screen.getByRole('region', { name: '概觀' })
  expect(within(overview).getByText('新增測試').nextSibling).toHaveTextContent('1修改 1')
  // 沒有未說明的測試檔、也有新增測試：不顯示提醒
  expect(within(section()).queryByText('未說明')).not.toBeInTheDocument()
  expect(within(section()).queryByText('這次沒有新增測試')).not.toBeInTheDocument()
})

test('驗證結果：不捏造逐個測試的結果，多個指令時顯示整體並連到測試結果', async () => {
  renderReport()
  await loaded()
  // fixture：npm test 通過、lint 失敗、e2e 略過
  const added = item('連續失敗 5 次後鎖定帳號')
  expect(added).toHaveTextContent('驗證：1 / 2 通過 · 略過 1')
  await userEvent.click(within(added).getByRole('button', { name: '查看測試結果' }))
  expect(scrolled.mock.contexts.at(-1)).toBe(document.getElementById('report-tests'))
})

test('只有一個驗證指令時顯示它的結果；輸出提到測試檔時顯示那個指令的結果', async () => {
  report = makeReport({
    verification: [
      { command: 'npm test', exitCode: 1, durationMs: 10, outputTail: 'Tests  1 failed' }
    ]
  })
  const { unmount } = renderReport()
  await loaded()
  expect(item('連續失敗 5 次後鎖定帳號')).toHaveTextContent('驗證：npm test 失敗（exit 1）')
  expect(item('錯誤密碼回 401')).toHaveTextContent('驗證：npm test 失敗（exit 1）')
  unmount()

  report = makeReport({
    verification: [
      { command: 'npm run lint', exitCode: 1, durationMs: 10, outputTail: 'error' },
      {
        command: 'npx vitest run',
        exitCode: 0,
        durationMs: 10,
        outputTail: ' ✓ src/auth/lockout.test.ts (1 test)\n Tests  1 passed'
      }
    ]
  })
  renderReport()
  await loaded()
  expect(item('連續失敗 5 次後鎖定帳號')).toHaveTextContent('驗證：npx vitest run 通過')
  expect(item('錯誤密碼回 401')).toHaveTextContent('驗證：1 / 2 通過')
})

test('沒有驗證指令或全部略過時照實顯示', async () => {
  report = makeReport({ verification: [] })
  const { unmount } = renderReport()
  await loaded()
  expect(item('錯誤密碼回 401')).toHaveTextContent('驗證：沒有驗證指令')
  unmount()
  report = makeReport({
    verification: [
      { command: 'npm test', exitCode: null, durationMs: 0, outputTail: '', skipped: '未核准' }
    ]
  })
  renderReport()
  await loaded()
  expect(item('錯誤密碼回 401')).toHaveTextContent('驗證：npm test 未執行')
})

test('點測試跳到 diff 裡的測試檔；有行號時捲到那一行', async () => {
  renderReport()
  await loaded()
  expect(pressed()).toMatch(/^src\/auth\/lockout\.ts/)
  await userEvent.click(within(section()).getByText('src/auth/lockout.test.ts:3'))
  expect(pressed()).toMatch(/^src\/auth\/lockout\.test\.ts/)
  expect(lastScrolled()).toBe('diff:src/auth/lockout.test.ts:3')
  // 沒有行號：捲到那個檔案
  await userEvent.click(within(section()).getByText('src/auth/login.test.ts'))
  expect(pressed()).toMatch(/^src\/auth\/login\.test\.ts/)
  expect(lastScrolled()).toBe('file:src/auth/login.test.ts')
})

test('測試檔不在這次的變更裡時不能點，並註明', async () => {
  report = makeReport()
  report.input.tests = [
    { ...report.input.tests[0], file: 'src/auth/gone.test.ts', line: undefined }
  ]
  renderReport()
  await loaded()
  const added = item('連續失敗 5 次後鎖定帳號')
  expect(within(added).queryByRole('button', { name: /gone/ })).not.toBeInTheDocument()
  expect(added).toHaveTextContent('src/auth/gone.test.ts（不在這次的變更中）')
})

test('Claude 沒說明的測試檔列在區塊最後，標「未說明」，點了也會跳到 diff', async () => {
  report = makeReport({ diff: sampleDiff + bigDiff('tests/e2e/lockout.spec.ts', 3) })
  renderReport()
  await loaded()
  const rest = within(section()).getByText('tests/e2e/lockout.spec.ts')
  const row = rest.closest('li')!
  expect(within(row).getByText('未說明')).toBeInTheDocument()
  expect(within(row).getByText('新增')).toBeInTheDocument()
  // 在說明過的測試之後
  expect(
    item('錯誤密碼回 401').compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  await userEvent.click(rest)
  expect(pressed()).toMatch(/^tests\/e2e\/lockout\.spec\.ts/)
  expect(lastScrolled()).toBe('file:tests/e2e/lockout.spec.ts')
})

test('沒有新增測試：提醒樣式，附上 Claude 說明的原因；概觀顯示 0', async () => {
  report = makeReport({ diff: srcDiff })
  report.input.tests = []
  report.input.tests_note = '這次只調整錯誤訊息的文案'
  const { unmount } = renderReport()
  await loaded()
  const notice = within(section()).getByText('這次沒有新增測試').parentElement!
  expect(notice).toHaveTextContent('這次只調整錯誤訊息的文案')
  const overview = screen.getByRole('region', { name: '概觀' })
  expect(within(overview).getByText('新增測試').nextSibling).toHaveTextContent(/^0$/)
  unmount()

  // 沒有說明原因；只有修改既有測試也算沒有新增
  report = makeReport({ diff: srcDiff })
  report.input.tests = [report.input.tests[1]]
  renderReport()
  await loaded()
  expect(within(section()).getByText('這次沒有新增測試').parentElement).toHaveTextContent(
    'Claude 沒有說明原因'
  )
  // 修改的測試仍然列出
  expect(item('錯誤密碼回 401')).toBeInTheDocument()
})

test('沒有說明任何測試、但 diff 裡有新的測試檔：不說「沒有新增測試」', async () => {
  report = makeReport()
  report.input.tests = []
  renderReport()
  await loaded()
  expect(within(section()).queryByText('這次沒有新增測試')).not.toBeInTheDocument()
  expect(within(section()).getByText('Claude 沒有說明新增的測試')).toBeInTheDocument()
  expect(within(section()).getAllByText('未說明')).toHaveLength(2)
})

test('對測試與區塊留言：回饋清單標成「測試 · 名稱」，點它捲到那個測試', async () => {
  renderReport()
  await loaded()
  await userEvent.click(
    screen.getByRole('button', { name: '對測試「連續失敗 5 次後鎖定帳號」留言' })
  )
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '補一個解鎖後的情境{Enter}')
  await userEvent.click(screen.getByRole('button', { name: '對「新增的測試」留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '缺少 e2e{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'test:t1', label: '連續失敗 5 次後鎖定帳號', text: '補一個解鎖後的情境' },
    { anchor: 'section:tests', label: '新增的測試', text: '缺少 e2e' }
  ])
  // 留過的意見顯示在原位置
  expect(
    within(item('連續失敗 5 次後鎖定帳號')).getByText('補一個解鎖後的情境')
  ).toBeInTheDocument()
  const panel = screen.getByRole('complementary', { name: '回饋與收尾' })
  expect(within(panel).getByText('區塊 · 新增的測試')).toBeInTheDocument()
  await userEvent.click(within(panel).getByText('測試 · 連續失敗 5 次後鎖定帳號'))
  expect(lastScrolled()).toBe('test:t1')
})

test('只能看時沒有留言按鈕，但仍可以跳到 diff', async () => {
  renderReport(true)
  await loaded()
  expect(within(section()).queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
  await userEvent.click(within(section()).getByText('src/auth/login.test.ts'))
  expect(pressed()).toMatch(/^src\/auth\/login\.test\.ts/)
})
