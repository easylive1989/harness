// tests/renderer/DiffView.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ComponentProps, useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { DiffView } from '@renderer/report/DiffView'
import { useStore } from '@renderer/store'
import { bigDiff, makeReport } from '../fixtures/report'

/** DiffView 的選取由外部控制：測試用一個有 state 的外層 */
function Controlled(props: Omit<ComponentProps<typeof DiffView>, 'selected' | 'onSelect'>) {
  const [selected, setSelected] = useState<string>()
  return <DiffView {...props} selected={selected} onSelect={setSelected} />
}

const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1
+const b = 2
 export {}
`
beforeEach(() => useStore.setState({ feedback: {} }))

test('顯示檔案說明與段落原因，點行號留下回饋', async () => {
  render(
    <DiffView
      taskId="t1"
      diff={diff}
      perFile={[{ path: 'src/a.ts', additions: 1, deletions: 0 }]}
      notes={[
        { path: 'src/a.ts', why: '加上 b', hunks: [{ line_start: 2, line_end: 2, why: '新常數' }] }
      ]}
    />
  )
  expect(screen.getByText(/加上 b/)).toBeInTheDocument()
  expect(screen.getByText(/新常數/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對第 2 行留言' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '改成常數檔{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: '改成常數檔' }
  ])
  expect(screen.getByText('改成常數檔')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '回饋' })).not.toBeInTheDocument()
})

test('段落說明放在範圍內第一個顯示的行之前；範圍內沒有顯示的行就列在檔案說明下', () => {
  render(
    <DiffView
      taskId="t1"
      diff={diff}
      perFile={[]}
      notes={[
        {
          path: 'src/a.ts',
          why: '加上 b',
          hunks: [
            { line_start: 2, line_end: 9, why: '範圍從新增的行開始' },
            { line_start: 40, line_end: 42, why: '不在 diff 裡的行' }
          ]
        }
      ]}
    />
  )
  expect(screen.getByText(/為什麼（第 2–9 行）/).parentElement).toHaveTextContent(
    '範圍從新增的行開始'
  )
  expect(screen.getByText(/第 40–42 行/).parentElement).toHaveTextContent('不在 diff 裡的行')
})

test('再點一次已留言的行可以修改，Esc 取消', async () => {
  useStore.setState({
    feedback: { t1: [{ anchor: 'diff:src/a.ts:3', label: 'src/a.ts:3', text: '舊的意見' }] }
  })
  render(<DiffView taskId="t1" diff={diff} perFile={[]} notes={[]} />)
  expect(screen.getByText('回饋 · 第 3 行')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對第 3 行留言' }))
  const input = screen.getByRole('textbox', { name: '回饋' })
  expect(input).toHaveValue('舊的意見')
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('textbox', { name: '回饋' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '對第 3 行留言' }))
  await userEvent.clear(screen.getByRole('textbox', { name: '回饋' }))
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '新的意見{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'diff:src/a.ts:3', label: 'src/a.ts:3', text: '新的意見' }
  ])
})

test('唯讀時沒有留言按鈕、不顯示待送出的回饋，行號顯示新檔行號', () => {
  useStore.setState({
    feedback: { t1: [{ anchor: 'diff:src/a.ts:2', label: 'src/a.ts:2', text: '待送出' }] }
  })
  const { container } = render(
    <DiffView taskId="t1" diff={diff} perFile={[]} notes={[]} readOnly />
  )
  expect(screen.queryByRole('button', { name: /留言/ })).not.toBeInTheDocument()
  expect(screen.queryByText('待送出')).not.toBeInTheDocument()
  const gutters = [...container.querySelectorAll('[data-line]')].map((e) => e.textContent)
  expect(gutters).toEqual(['1', '2', '3'])
})

test('切換檔案；檔案標籤附增刪行數；刪除的行顯示舊檔行號', async () => {
  const report = makeReport()
  render(
    <Controlled
      taskId="t1"
      diff={report.diff}
      perFile={report.stats.perFile}
      notes={report.input.file_notes}
    />
  )
  const files = screen.getByRole('group', { name: '變更的檔案' })
  expect(
    within(files)
      .getAllByRole('button')
      .map((b) => b.textContent)
  ).toEqual([
    'src/auth/lockout.ts +4',
    'src/auth/login.ts +2 −1',
    'src/auth/lockout.test.ts +5',
    'src/auth/login.test.ts +1'
  ])
  expect(screen.getByText(/獨立計數邏輯/)).toBeInTheDocument()
  await userEvent.click(within(files).getByRole('button', { name: /login\.ts/ }))
  expect(within(files).getByRole('button', { name: /login\.ts/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.getByText(/登入前先檢查鎖定/)).toBeInTheDocument()
  expect(screen.queryByText(/獨立計數邏輯/)).not.toBeInTheDocument()
  // 新檔第 11 行可以留言；刪除的那一行沒有新檔行號，顯示舊檔第 11 行、不能留言
  expect(screen.getAllByRole('button', { name: '對第 11 行留言' })).toHaveLength(1)
  expect(screen.getByText('- check(user)', { exact: false }).previousSibling).toHaveTextContent(
    '11'
  )
})

test('二進位檔案不顯示內容；沒有變更時顯示說明', () => {
  const bin = `diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`
  const { unmount } = render(
    <DiffView
      taskId="t1"
      diff={bin}
      perFile={[{ path: 'logo.png', additions: 0, deletions: 0 }]}
      notes={[]}
    />
  )
  expect(screen.getByText('二進位檔案，不顯示內容')).toBeInTheDocument()
  // 二進位檔的增刪行數都是 0，不顯示
  expect(screen.getByRole('button', { name: 'logo.png' })).toBeInTheDocument()
  unmount()
  render(<DiffView taskId="t1" diff="" perFile={[]} notes={[]} />)
  expect(screen.getByText('沒有程式碼變更')).toBeInTheDocument()
})

test('匯出（static）時依序列出每個檔案，沒有任何按鈕', () => {
  const report = makeReport()
  render(
    <DiffView
      taskId="t1"
      diff={report.diff}
      perFile={report.stats.perFile}
      notes={report.input.file_notes}
      isStatic
    />
  )
  expect(screen.getByText(/獨立計數邏輯/)).toBeInTheDocument()
  expect(screen.getByText(/登入前先檢查鎖定/)).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: /src\/auth\/login\.ts/ })).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('對整個檔案留言（二進位檔也可以）；加入或取消後焦點回到按鈕', async () => {
  const bin = `diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`
  render(<DiffView taskId="t1" diff={bin} perFile={[]} notes={[]} />)
  const button = screen.getByRole('button', { name: '對此檔案留言' })
  await userEvent.click(button)
  await userEvent.type(screen.getByRole('textbox', { name: '回饋' }), '換成 SVG{Enter}')
  expect(useStore.getState().feedback.t1).toEqual([
    { anchor: 'file:logo.png', label: 'logo.png', text: '換成 SVG' }
  ])
  expect(screen.getByText('回饋 · 整個檔案')).toBeInTheDocument()
  expect(button).toHaveFocus()
})

test('行號留言按 Esc 取消後，焦點回到行號', async () => {
  render(<DiffView taskId="t1" diff={diff} perFile={[]} notes={[]} />)
  const line = screen.getByRole('button', { name: '對第 2 行留言' })
  await userEvent.click(line)
  expect(screen.getByRole('textbox', { name: '回饋' })).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  expect(line).toHaveFocus()
})

test('改名的檔案標出原本的路徑', () => {
  const renamed = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1 @@
-export const a = 1
+export const a = 2
`
  render(<DiffView taskId="t1" diff={renamed} perFile={[]} notes={[]} />)
  expect(screen.getByText('src/old.ts').parentElement).toHaveTextContent('從 src/old.ts 改名')
  expect(screen.getByText('改名')).toBeInTheDocument()
})

test('預設選第一個不是鎖定檔或產生檔的檔案', () => {
  const d = [
    bigDiff('package-lock.json', 3),
    bigDiff('dist/app.min.js', 2),
    bigDiff('src/a.ts', 1)
  ].join('')
  render(<Controlled taskId="t1" diff={d} perFile={[]} notes={[]} />)
  expect(screen.getByRole('button', { name: 'src/a.ts' })).toHaveAttribute('aria-pressed', 'true')
  // 全部都是產生的檔案時選第一個
  render(<DiffView taskId="t2" diff={bigDiff('yarn.lock', 1)} perFile={[]} notes={[]} />)
  expect(screen.getByRole('button', { name: 'yarn.lock' })).toHaveAttribute('aria-pressed', 'true')
})

test('2 萬行的檔案只畫前 300 行，附上顯示全部的按鈕', () => {
  const { container } = render(
    <DiffView taskId="t1" diff={bigDiff('src/huge.ts', 20000)} perFile={[]} notes={[]} />
  )
  expect(container.querySelectorAll('[data-line]')).toHaveLength(300)
  // 大量 DOM 時 *ByRole 要算每個按鈕的名稱，非常慢：改用文字查詢
  expect(screen.getByText('顯示全部（共 20000 行）')).toBeInTheDocument()
})

test('超過 1500 行才截斷；按顯示全部後全部畫出來', () => {
  const { container, unmount } = render(
    <DiffView taskId="t1" diff={bigDiff('src/a.ts', 1500)} perFile={[]} notes={[]} />
  )
  expect(container.querySelectorAll('[data-line]')).toHaveLength(1500)
  expect(screen.queryByText(/顯示全部/)).not.toBeInTheDocument()
  unmount()
  const r = render(
    <DiffView taskId="t1" diff={bigDiff('src/a.ts', 1501)} perFile={[]} notes={[]} />
  )
  expect(r.container.querySelectorAll('[data-line]')).toHaveLength(300)
  fireEvent.click(screen.getByText('顯示全部（共 1501 行）'))
  expect(r.container.querySelectorAll('[data-line]')).toHaveLength(1501)
})

test('要捲到的行在截斷範圍外時自動展開', () => {
  const { container } = render(
    <DiffView
      taskId="t1"
      diff={bigDiff('src/a.ts', 1600)}
      perFile={[]}
      notes={[]}
      selected="src/a.ts"
      focusLine={1200}
    />
  )
  expect(container.querySelector('[data-anchor="diff:src/a.ts:1200"]')).toBeInTheDocument()
  expect(screen.queryByText(/顯示全部/)).not.toBeInTheDocument()
})

test('匯出時鎖定檔與超過 3000 行的檔案只放摘要，也沒有錨點屬性', () => {
  const d = [
    bigDiff('package-lock.json', 10),
    bigDiff('src/huge.ts', 3001),
    bigDiff('src/a.ts', 3000)
  ].join('')
  const { container } = render(<DiffView taskId="t1" diff={d} perFile={[]} notes={[]} isStatic />)
  expect(screen.getByText('此檔案變更 10 行，未包含在匯出中')).toBeInTheDocument()
  expect(screen.getByText('此檔案變更 3001 行，未包含在匯出中')).toBeInTheDocument()
  expect(container.querySelectorAll('[data-line]')).toHaveLength(3000)
  expect(container.querySelector('[data-anchor]')).toBeNull()
})
