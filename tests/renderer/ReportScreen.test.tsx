// tests/renderer/ReportScreen.test.tsx
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
import { call } from '@renderer/api'
import { ReportScreen } from '@renderer/screens/ReportScreen'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { Report, Task } from '@shared/types'
import { holdNextCall } from '../fixtures/hold'
import { makeReport } from '../fixtures/report'
import { makeTask } from '../fixtures/task'

let replies: Record<string, (...args: never[]) => unknown>

const reviewTask = (over: Partial<Task> = {}) =>
  makeTask({
    status: 'reviewing',
    reportVersions: [1],
    questions: [
      {
        id: 'q1',
        text: '計數單位',
        options: [],
        allowFreeText: true,
        status: 'answered',
        followups: [],
        askedAt: ''
      }
    ],
    ...over
  })

const renderReport = (task: Task, readOnly = false, onOpenStage = vi.fn()) => {
  useStore.setState({ tasks: { [task.id]: task } })
  return render(
    <ReportScreen task={task} nav={null} readOnly={readOnly} onOpenStage={onOpenStage} />
  )
}
const loaded = () => screen.findByRole('heading', { name: '登入流程多了一道鎖定關卡' })
const panel = () => screen.getByRole('complementary', { name: '回饋與收尾' })

beforeEach(() => {
  replies = {
    'report:get': (_taskId: string, version: number) => makeReport({ version }),
    'report:feedback': () => undefined,
    'report:saveHtml': () => '/Users/me/報告.html',
    'finish:pr': () => 'https://github.com/me/shop/pull/7',
    'finish:merge': () => undefined,
    'finish:discard': () => undefined,
    'shell:openExternal': () => undefined
  }
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string, ...args: never[]) =>
    replies[ch](...args)) as typeof call)
  resetStoreInternals()
  useStore.setState({ tasks: {}, timelines: {}, feedback: {}, toast: undefined })
})

test('讀取最新版本報告並顯示各區塊', async () => {
  renderReport(reviewTask({ reportVersions: [1, 2] }))
  await loaded()
  expect(call).toHaveBeenCalledWith('report:get', 't1', 2)
  const overview = screen.getByRole('region', { name: '概觀' })
  expect(within(overview).getByText('變更檔案').nextSibling).toHaveTextContent('4')
  expect(within(overview).getByText('行數').nextSibling).toHaveTextContent('+12 −1')
  // 略過的指令不算在分母
  expect(within(overview).getByText('驗證').nextSibling).toHaveTextContent('1 / 2 通過')
  expect(within(overview).getByText('決策').nextSibling).toHaveTextContent('1')

  const arch = screen.getByRole('region', { name: '架構前後對照' })
  expect(within(arch).getByText('之前')).toBeInTheDocument()
  expect(within(arch).getByRole('button', { name: 'lockoutGuard（新增）' })).toBeInTheDocument()

  const decisions = screen.getByRole('region', { name: '決策與原因' })
  expect(within(decisions).getByText('計數存在 Redis')).toBeInTheDocument()
  expect(within(decisions).getByText('來自分岔')).toBeInTheDocument()
  expect(within(decisions).getByText('多台機器共享')).toBeInTheDocument()

  const block = screen.getByRole('region', { name: '鎖定狀態機' })
  expect(within(block).getByTitle('鎖定狀態機')).toHaveAttribute(
    'src',
    'harness-block://report/t1/2/state-machine'
  )

  const limits = screen.getByRole('region', { name: '限制與後續' })
  expect(within(limits).getByText('Redis 掛掉時放行')).toBeInTheDocument()
  expect(within(limits).getByText('後台解鎖')).toBeInTheDocument()

  const diff = screen.getByRole('region', { name: '程式碼變更' })
  expect(within(diff).getByText(/獨立計數邏輯/)).toBeInTheDocument()

  const tests = screen.getByRole('region', { name: '測試結果' })
  expect(within(tests).getByText('通過 · 3.2 秒')).toBeInTheDocument()
  expect(within(tests).getByText('失敗（exit 1）· 1.5 秒')).toBeInTheDocument()
  // 失敗的輸出預設展開；略過的列出原因
  expect(within(tests).getByText('error no-unused-vars').closest('details')).toHaveAttribute('open')
  expect(within(tests).getByText('Tests 48 passed').closest('details')).not.toHaveAttribute('open')
  expect(within(tests).getByText(/沒有被核准過/)).toBeInTheDocument()
})

test('對區塊與決策留言會出現在回饋清單，可以刪除', async () => {
  renderReport(reviewTask())
  await loaded()
  expect(within(panel()).getByText('0 則待送出')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對「架構前後對照」留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), 'Redis 也畫出來{Enter}')
  await userEvent.click(screen.getByRole('button', { name: '對決策 D1 留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '說明 TTL{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'section:architecture', label: '架構前後對照', text: 'Redis 也畫出來' },
    { anchor: 'decision:d1', label: 'D1 計數存在 Redis', text: '說明 TTL' }
  ])
  expect(within(panel()).getByText('2 則待送出')).toBeInTheDocument()
  expect(within(panel()).getByText('區塊 · 架構前後對照')).toBeInTheDocument()
  expect(within(panel()).getByText('決策 · D1 計數存在 Redis')).toBeInTheDocument()
  // 留過的意見也顯示在原位置
  expect(
    within(screen.getByRole('region', { name: '架構前後對照' })).getByText('Redis 也畫出來')
  ).toBeInTheDocument()
  await userEvent.click(
    within(panel()).getByRole('button', { name: '刪除對「架構前後對照」的回饋' })
  )
  expect(useStore.getState().feedback.t1.map((f) => f.anchor)).toEqual(['decision:d1'])
})

test('送出回饋：沒有內容時停用；送出中停用、連點只送一次；成功後清空', async () => {
  renderReport(reviewTask())
  await loaded()
  const send = within(panel()).getByRole('button', { name: '送出回饋，產生 v2' })
  expect(send).toBeDisabled()
  useStore
    .getState()
    .addFeedback('t1', { anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: 'x' })
  await userEvent.type(within(panel()).getByRole('textbox', { name: /整體意見/ }), '  整體  ')
  const release = holdNextCall(vi.mocked(call))
  await userEvent.dblClick(send)
  expect(call).toHaveBeenCalledWith(
    'report:feedback',
    't1',
    [{ anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: 'x' }],
    '整體'
  )
  expect(vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:feedback')).toHaveLength(1)
  expect(send).toBeDisabled()
  expect(within(panel()).getByRole('button', { name: '開 Pull Request' })).toBeDisabled()
  await release()
  expect(useStore.getState().feedback.t1).toEqual([])
  expect(within(panel()).getByRole('textbox', { name: /整體意見/ })).toHaveValue('')
})

test('只有整體意見也能送出；失敗時保留內容', async () => {
  replies['report:feedback'] = () => {
    throw new Error('Claude 正在執行')
  }
  renderReport(reviewTask())
  await loaded()
  await userEvent.type(within(panel()).getByRole('textbox', { name: /整體意見/ }), '改名')
  expect(within(panel()).getByText(/整體意見還沒送出/)).toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '送出回饋，產生 v2' }))
  expect(call).toHaveBeenCalledWith('report:feedback', 't1', [], '改名')
  expect(useStore.getState().toast?.text).toBe('Claude 正在執行')
  expect(within(panel()).getByRole('textbox', { name: /整體意見/ })).toHaveValue('改名')
})

test('PR 開好但瀏覽器打不開：不算開 PR 失敗', async () => {
  replies['shell:openExternal'] = () => {
    throw new Error('無法開啟瀏覽器')
  }
  renderReport(reviewTask())
  await loaded()
  await userEvent.click(within(panel()).getByRole('button', { name: '開 Pull Request' }))
  await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法開啟瀏覽器'))
  expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
})

test('開 PR 後用瀏覽器打開 PR 網址', async () => {
  renderReport(reviewTask())
  await loaded()
  await userEvent.click(within(panel()).getByRole('button', { name: '開 Pull Request' }))
  expect(call).toHaveBeenCalledWith('finish:pr', 't1')
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('shell:openExternal', 'https://github.com/me/shop/pull/7')
  )
})

test('還有未送出的回饋時提醒；合併失敗時在面板顯示 git 的訊息', async () => {
  replies['finish:merge'] = () => {
    throw new Error('git merge: CONFLICT (content): Merge conflict in src/auth/login.ts')
  }
  renderReport(reviewTask())
  await loaded()
  useStore.getState().addFeedback('t1', { anchor: 'section:overview', label: '概觀', text: 'x' })
  expect(await within(panel()).findByText(/還有 1 則回饋沒送出/)).toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '合併到 main' }))
  expect(call).toHaveBeenCalledWith('finish:merge', 't1')
  const alert = await within(panel()).findByRole('alert')
  expect(alert).toHaveTextContent('合併失敗')
  expect(alert).toHaveTextContent('Merge conflict in src/auth/login.ts')
})

test('丟棄 worktree 要再確認一次，可以取消', async () => {
  renderReport(reviewTask())
  await loaded()
  await userEvent.click(within(panel()).getByRole('button', { name: '丟棄 worktree' }))
  expect(call).not.toHaveBeenCalledWith('finish:discard', 't1')
  expect(within(panel()).getByText(/harness\/t1/)).toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '取消' }))
  await userEvent.click(within(panel()).getByRole('button', { name: '丟棄 worktree' }))
  await userEvent.click(within(panel()).getByRole('button', { name: '確定丟棄' }))
  expect(call).toHaveBeenCalledWith('finish:discard', 't1')
})

test('依回饋修改中（implementing）回看報告：只能看', async () => {
  renderReport(reviewTask({ status: 'implementing', runState: 'running' }), true)
  await loaded()
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /送出回饋/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '開 Pull Request' })).not.toBeInTheDocument()
  expect(within(panel()).getByText(/Claude 正在依回饋修改，完成後會產生 v2/)).toBeInTheDocument()
})

test('切換版本：讀取該版本；舊版本只能看，可以回到最新版', async () => {
  renderReport(reviewTask({ reportVersions: [1, 2] }))
  await loaded()
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '版本' }), '1')
  await waitFor(() => expect(call).toHaveBeenCalledWith('report:get', 't1', 1))
  expect(await screen.findByText(/正在看 v1（舊版本）/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
  // 回饋仍然可以針對最新版本送出
  expect(within(panel()).getByRole('button', { name: '送出回饋，產生 v3' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '回到 v2' }))
  expect(screen.getByRole('combobox', { name: '版本' })).toHaveValue('2')
  expect(screen.getByRole('button', { name: '對「概觀」留言' })).toBeInTheDocument()
  // 讀過的版本不再重新讀取
  expect(vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:get')).toHaveLength(2)
})

test('讀取失敗時顯示原因與重試', async () => {
  let fail = true
  replies['report:get'] = (_t: string, version: number) => {
    if (fail) throw new Error('找不到報告 v1')
    return makeReport({ version })
  }
  renderReport(reviewTask())
  expect(await screen.findByText(/找不到報告 v1/)).toBeInTheDocument()
  fail = false
  await userEvent.click(screen.getByRole('button', { name: '重試' }))
  await loaded()
})

test('讀取失敗的版本：換到別的版本再回來會重新讀取，不顯示舊的錯誤', async () => {
  let failV1 = true
  replies['report:get'] = (_t: string, version: number) => {
    if (version === 1 && failV1) throw new Error('暫時讀不到')
    return makeReport({ version })
  }
  renderReport(reviewTask({ reportVersions: [1, 2] }))
  await loaded()
  await userEvent.selectOptions(screen.getByRole('combobox'), '1')
  expect(await screen.findByText(/暫時讀不到/)).toBeInTheDocument()
  failV1 = false
  await userEvent.selectOptions(screen.getByRole('combobox'), '2')
  expect(screen.queryByText(/暫時讀不到/)).not.toBeInTheDocument()
  await userEvent.selectOptions(screen.getByRole('combobox'), '1')
  expect(screen.queryByText(/暫時讀不到/)).not.toBeInTheDocument()
  expect(await screen.findByText(/正在看 v1（舊版本）/)).toBeInTheDocument()
  expect(
    vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:get' && c[2] === 1)
  ).toHaveLength(2)
})

test('匯出 HTML：送出自含的 HTML 與安全的檔名', async () => {
  renderReport(reviewTask({ title: '登入/鎖定' }))
  await loaded()
  const button = screen.getByRole('button', { name: '匯出 HTML' })
  const release = holdNextCall(vi.mocked(call))
  await userEvent.dblClick(button)
  expect(button).toBeDisabled()
  // react-dom/server 是按下匯出才載入：等 HTML 產生、送出後再讓它完成
  await waitFor(() =>
    expect(vi.mocked(call).mock.calls.some((c) => c[0] === 'report:saveHtml')).toBe(true)
  )
  await release('/Users/me/報告.html')
  const calls = vi.mocked(call).mock.calls.filter((c) => c[0] === 'report:saveHtml')
  expect(calls).toHaveLength(1)
  const [, name, html] = calls[0] as unknown as [string, string, string]
  expect(name).toBe('登入-鎖定-變更報告-v1.html')
  expect(html).toMatch(/^<!doctype html>/)
  expect(html).toContain('登入流程多了一道鎖定關卡')
  expect(useStore.getState().toast?.text).toBe('已匯出：/Users/me/報告.html')
})

test('點決策的問題來源打開釐清階段；點架構節點切換到對應檔案', async () => {
  const onOpenStage = vi.fn()
  const report = makeReport()
  report.input.decisions = [
    { ...report.input.decisions[0], id: 'd2', source: { type: 'question', ref: 'q1' } }
  ]
  replies['report:get'] = () => report
  renderReport(reviewTask(), false, onOpenStage)
  await loaded()
  await userEvent.click(screen.getByRole('button', { name: '問題 1（查看釐清對話）' }))
  expect(onOpenStage).toHaveBeenCalledWith('clarify')
  const files = screen.getByRole('group', { name: '變更的檔案' })
  expect(within(files).getByRole('button', { name: /lockout\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await userEvent.click(screen.getAllByRole('button', { name: 'login.ts（修改）' })[0])
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('決策來源：使用者的指示顯示「你的指示」，實作中自己做的決定顯示「實作中決定」', async () => {
  const report = makeReport()
  const d = report.input.decisions[0]
  report.input.decisions = [
    { ...d, id: 'd5', title: '錯誤訊息用中文', source: { type: 'user', ref: '插話：用繁體中文' } },
    { ...d, id: 'd6', title: '抽出常數', source: { type: 'implementation', ref: '' } }
  ]
  replies['report:get'] = () => report
  renderReport(reviewTask())
  await loaded()
  const decisions = screen.getByRole('region', { name: '決策與原因' })
  expect(within(decisions).getByText('你的指示')).toHaveAttribute('title', '插話：用繁體中文')
  expect(within(decisions).getByText('實作中決定')).toBeInTheDocument()
  expect(within(decisions).queryByText(/^問題/)).not.toBeInTheDocument()
})

test('點回饋清單裡的程式碼回饋會切換到那個檔案', async () => {
  renderReport(reviewTask())
  await loaded()
  useStore.getState().addFeedback('t1', {
    anchor: 'diff:src/auth/login.ts:11',
    label: 'src/auth/login.ts:11',
    text: '改用 await'
  })
  await userEvent.click(await within(panel()).findByText('程式碼 · src/auth/login.ts:11'))
  const files = screen.getByRole('group', { name: '變更的檔案' })
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.getByText('回饋 · 第 11 行')).toBeInTheDocument()
})

test('已完成：顯示 PR 連結與清除 worktree', async () => {
  renderReport(reviewTask({ status: 'done', prUrl: 'https://github.com/me/shop/pull/7' }), true)
  await loaded()
  expect(screen.queryByRole('button', { name: /送出回饋/ })).not.toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: '開啟 Pull Request' }))
  expect(call).toHaveBeenCalledWith('shell:openExternal', 'https://github.com/me/shop/pull/7')
  await userEvent.click(within(panel()).getByRole('button', { name: '清除 worktree' }))
  await userEvent.click(within(panel()).getByRole('button', { name: '確定清除' }))
  expect(call).toHaveBeenCalledWith('finish:discard', 't1')
  // 清除後提示，這次開著畫面時不再顯示按鈕
  await waitFor(() => expect(useStore.getState().toast?.text).toBe('已清除 worktree'))
  expect(within(panel()).queryByRole('button', { name: '清除 worktree' })).not.toBeInTheDocument()
})

test('TaskScreen：待審閱顯示報告；依回饋修改中可以回看報告但只能看', async () => {
  useStore.setState({ tasks: { t1: reviewTask() } })
  const { unmount } = render(<TaskScreen taskId="t1" />)
  await loaded()
  expect(screen.getByRole('button', { name: '對「概觀」留言' })).toBeInTheDocument()
  unmount()
  const report: Report = makeReport()
  replies['report:get'] = () => report
  replies['tasks:timeline'] = () => []
  replies['tasks:changedFiles'] = () => ({ files: 0, additions: 0, deletions: 0, perFile: [] })
  useStore.setState({
    tasks: { t1: reviewTask({ status: 'implementing', runState: 'running' }) },
    timelines: { t1: [] }
  })
  render(<TaskScreen taskId="t1" />)
  await userEvent.click(screen.getByRole('button', { name: /報告/ }))
  await loaded()
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
})

test('對整個檔案留言：清單標成「檔案」，點它切換到那個檔案；關掉留言後焦點回到按鈕', async () => {
  renderReport(reviewTask())
  await loaded()
  const files = screen.getByRole('group', { name: '變更的檔案' })
  await userEvent.click(within(files).getByRole('button', { name: /login\.ts/ }))
  await userEvent.click(screen.getByRole('button', { name: '對此檔案留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '拆成兩個函式{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'file:src/auth/login.ts', label: 'src/auth/login.ts', text: '拆成兩個函式' }
  ])
  expect(screen.getByRole('button', { name: '對此檔案留言' })).toHaveFocus()
  await userEvent.click(within(files).getByRole('button', { name: /lockout\.ts/ }))
  await userEvent.click(within(panel()).getByText('檔案 · src/auth/login.ts'))
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  // 區塊留言按 Esc 關掉後，焦點也回到留言按鈕
  const overview = screen.getByRole('button', { name: '對「概觀」留言' })
  await userEvent.click(overview)
  await userEvent.keyboard('{Escape}')
  expect(overview).toHaveFocus()
})
