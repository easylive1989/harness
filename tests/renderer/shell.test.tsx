// tests/renderer/shell.test.tsx
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(async () => null),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import App from '@renderer/App'
import { Markdown } from '@renderer/components/Markdown'
import { Sidebar } from '@renderer/components/Sidebar'
import { Toast } from '@renderer/components/Toast'
import { TaskScreen } from '@renderer/screens/TaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

const repos = [
  { id: 'r1', name: 'shop-api', path: '/Users/me/shop-api', addedAt: '' },
  { id: 'r2', name: 'web-dashboard', path: '/Users/me/web', addedAt: '' }
]

const realInit = useStore.getState().init

beforeEach(() => {
  vi.mocked(call).mockClear()
  resetStoreInternals()
  useStore.setState({
    init: realInit,
    ready: true,
    repos,
    tasks: {},
    timelines: {},
    view: { kind: 'new' },
    toast: undefined,
    claude: { found: true, loggedIn: true },
    settings: {
      defaultModel: 'claude-opus-5-5',
      worktreeRoot: '/wt',
      branchPrefix: 'harness/',
      alwaysAllowedCommands: [],
      loadProjectSettings: false
    }
  })
})

describe('Sidebar', () => {
  const tasks = {
    a: makeTask({
      id: 'a',
      repoId: 'r1',
      title: '登入失敗鎖定',
      createdAt: '2026-10-07T02:00:00Z'
    }),
    b: makeTask({
      id: 'b',
      repoId: 'r2',
      title: '匯出 CSV',
      status: 'reviewing',
      reportVersions: [1],
      createdAt: '2026-10-07T01:00:00Z'
    }),
    c: makeTask({ id: 'c', repoId: 'r2', title: '修正時區', createdAt: '2026-10-07T00:00:00Z' }),
    gone: makeTask({ id: 'gone', repoId: 'r1', title: '已丟棄的任務', status: 'discarded' })
  }

  test('展開目前任務所在的 repo，其他 repo 收合只顯示數量', () => {
    useStore.setState({ tasks, view: { kind: 'task', taskId: 'a' } })
    render(<Sidebar />)
    const shop = screen.getByRole('button', { name: /shop-api/ })
    const web = screen.getByRole('button', { name: /web-dashboard/ })
    expect(shop).toHaveAttribute('aria-expanded', 'true')
    expect(web).toHaveAttribute('aria-expanded', 'false')
    expect(web).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: /登入失敗鎖定/ })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByText('釐清中 · 問題 1')).toBeInTheDocument()
    expect(screen.queryByText('匯出 CSV')).not.toBeInTheDocument()
    expect(screen.queryByText('已丟棄的任務')).not.toBeInTheDocument()
  })

  test('點 repo 標題展開，點任務切換畫面', async () => {
    useStore.setState({ tasks, view: { kind: 'task', taskId: 'a' } })
    render(<Sidebar />)
    await userEvent.click(screen.getByRole('button', { name: /web-dashboard/ }))
    expect(screen.getByText('待審閱報告 · v1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /匯出 CSV/ }))
    expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'b' })
    expect(call).toHaveBeenCalledWith('tasks:timeline', 'b')
  })

  test('新任務、加入 repo、設定', async () => {
    useStore.setState({ tasks, view: { kind: 'task', taskId: 'a' } })
    render(<Sidebar />)
    await userEvent.click(screen.getByRole('button', { name: '加入 repo' }))
    expect(call).toHaveBeenCalledWith('repos:pick')
    await userEvent.click(screen.getByRole('button', { name: /設定/ }))
    expect(useStore.getState().view).toEqual({ kind: 'settings' })
    await userEvent.click(screen.getByRole('button', { name: '新任務' }))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
  })

  test('底部顯示 Claude Code 狀態', () => {
    const { rerender } = render(<Sidebar />)
    expect(screen.getByRole('button', { name: /設定/ })).toHaveTextContent('Opus 5.5 · 訂閱方案')
    act(() => useStore.setState({ claude: { found: false, loggedIn: false } }))
    rerender(<Sidebar />)
    expect(screen.getByRole('button', { name: /設定/ })).toHaveTextContent('Claude Code 未就緒')
  })
})

describe('Sidebar 焦點', () => {
  test('焦點換到手動收合的 repo 裡的任務時，那個 repo 重新展開', async () => {
    useStore.setState({
      tasks: {
        a: makeTask({ id: 'a', repoId: 'r1', title: '任務 A', createdAt: '2026-10-07T02:00:00Z' }),
        b: makeTask({ id: 'b', repoId: 'r2', title: '任務 B', createdAt: '2026-10-07T01:00:00Z' })
      },
      view: { kind: 'task', taskId: 'a' }
    })
    render(<Sidebar />)
    const web = screen.getByRole('button', { name: /web-dashboard/ })
    await userEvent.click(web) // 展開 r2
    await userEvent.click(web) // 再手動收合 r2
    expect(web).toHaveAttribute('aria-expanded', 'false')
    act(() => useStore.setState({ view: { kind: 'task', taskId: 'b' } }))
    expect(screen.getByRole('button', { name: /web-dashboard/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: /任務 B/ })).toHaveAttribute('aria-current', 'page')
  })
})

describe('TaskScreen / StageNav', () => {
  const stage = (name: RegExp) =>
    within(screen.getByRole('navigation', { name: '任務階段' })).getByRole('button', { name })

  test('可回看已經過的階段；狀態改變時回到目前階段', async () => {
    useStore.setState({ tasks: { a: makeTask({ id: 'a', status: 'spec_review' }) } })
    render(<TaskScreen taskId="a" />)
    expect(stage(/規格/)).toHaveAttribute('aria-current', 'step')
    expect(stage(/規格/)).toHaveAttribute('aria-pressed', 'true')
    expect(stage(/實作/)).toBeDisabled()
    await userEvent.click(stage(/釐清/))
    expect(stage(/釐清/)).toHaveAttribute('aria-pressed', 'true')
    expect(stage(/規格/)).toHaveAttribute('aria-pressed', 'false')
    expect(stage(/規格/)).toHaveAttribute('aria-current', 'step')
    act(() => useStore.setState({ tasks: { a: makeTask({ id: 'a', status: 'implementing' }) } }))
    expect(stage(/實作/)).toHaveAttribute('aria-pressed', 'true')
  })

  test('App 換任務時回到該任務的目前階段', async () => {
    useStore.setState({
      init: () => () => {},
      tasks: {
        a: makeTask({ id: 'a', repoId: 'r1', title: '任務 A', status: 'spec_review' }),
        b: makeTask({ id: 'b', repoId: 'r1', title: '任務 B', status: 'spec_review' })
      },
      timelines: { a: [], b: [] },
      view: { kind: 'task', taskId: 'a' }
    })
    render(<App />)
    expect(screen.getByText('shop-api · 任務 A')).toBeInTheDocument()
    await userEvent.click(stage(/釐清/))
    expect(stage(/釐清/)).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: /任務 B/ }))
    expect(screen.getByText('shop-api · 任務 B')).toBeInTheDocument()
    expect(stage(/規格/)).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Toast', () => {
  test('顯示錯誤，可關閉，8 秒後自動消失；同樣的錯誤再出現會重新計時', () => {
    vi.useFakeTimers()
    try {
      act(() => useStore.getState().showToast('出錯了'))
      render(<Toast />)
      expect(screen.getByRole('alert')).toHaveTextContent('出錯了')
      act(() => vi.advanceTimersByTime(6000))
      act(() => useStore.getState().showToast('出錯了'))
      act(() => vi.advanceTimersByTime(6000))
      expect(screen.getByRole('alert')).toHaveTextContent('出錯了')
      act(() => vi.advanceTimersByTime(2000))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      act(() => useStore.getState().showToast('又出錯了'))
      act(() => screen.getByRole('button', { name: '關閉' }).click())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Markdown', () => {
  test('連結交給系統瀏覽器開啟', async () => {
    render(<Markdown text={'看 [文件](https://example.com) 與 `code`'} />)
    await userEvent.click(screen.getByRole('link', { name: '文件' }))
    expect(call).toHaveBeenCalledWith('shell:openExternal', 'https://example.com')
    expect(screen.getByText('code').tagName).toBe('CODE')
  })

  test('不渲染原始 HTML，javascript: 連結失效', async () => {
    const { container } = render(
      <Markdown
        text={
          '<img src="x" onerror="alert(1)"><script>alert(2)</script>\n\n[點我](javascript:alert(3))'
        }
      />
    )
    expect(container.querySelector('img, script')).toBeNull()
    const link = screen.getByText('點我')
    expect(link.getAttribute('href') ?? '').not.toMatch(/javascript:/i)
    await userEvent.click(link)
    expect(call).not.toHaveBeenCalled()
  })
})
