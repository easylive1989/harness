// tests/renderer/newTask.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { NewTaskScreen } from '@renderer/screens/NewTaskScreen'
import { useStore } from '@renderer/store'
import { makeTask } from '../fixtures/task'

const repos = [
  { id: 'r1', name: 'shop-api', path: '/Users/me/Github/shop-api', addedAt: '' },
  { id: 'r2', name: 'web-dashboard', path: '/Users/me/Github/web', addedAt: '' }
]
const branches: Record<string, { branches: string[]; current: string }> = {
  r1: { branches: ['main', 'develop'], current: 'develop' },
  r2: { branches: ['trunk'], current: 'trunk' },
  r3: { branches: ['main'], current: 'main' }
}
let replies: Record<string, (...args: never[]) => unknown>

beforeEach(() => {
  replies = {
    'repos:branches': (id: string) => branches[id],
    'tasks:create': () => makeTask({ id: 'new1' }),
    'tasks:timeline': () => [],
    'repos:pick': () => null,
    'claude:status': () => ({ found: true, loggedIn: true })
  }
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string, ...args: never[]) =>
    replies[ch](...args)) as typeof call)
  useStore.setState({
    ready: true,
    repos,
    tasks: {},
    timelines: {},
    view: { kind: 'new' },
    toast: undefined,
    claude: { found: true, loggedIn: true },
    settings: {
      defaultModel: 'claude-sonnet-5-5',
      defaultWorkspace: 'worktree',
      worktreeRoot: '/wt',
      branchPrefix: 'harness/',
      alwaysAllowedCommands: [],
      loadProjectSettings: false
    }
  })
})

const start = () => screen.getByRole('button', { name: /開始釐清/ })

describe('NewTaskScreen', () => {
  test('預設選第一個 repo、目前分支與設定的預設模型', async () => {
    render(<NewTaskScreen />)
    expect(screen.getByRole('heading', { name: '想改什麼？' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /shop-api/ })).toBeChecked()
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('develop'))
    // 選取的 repo 卡片顯示路徑與目前分支（設計稿 B1）
    expect(screen.getByText('~/Github/shop-api · develop')).toBeInTheDocument()
    expect(screen.getByText('~/Github/web')).toBeInTheDocument()
    expect(screen.getByLabelText('模型')).toHaveValue('claude-sonnet-5-5')
    expect(start()).toBeDisabled()
  })

  test('填寫需求後建立任務並打開它', async () => {
    render(<NewTaskScreen />)
    await userEvent.click(screen.getByRole('radio', { name: /web-dashboard/ }))
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('trunk'))
    await userEvent.type(screen.getByLabelText('需求'), '加上登入失敗鎖定')
    await userEvent.selectOptions(screen.getByLabelText('模型'), 'claude-opus-5-5')
    await userEvent.click(start())
    expect(call).toHaveBeenCalledWith('tasks:create', {
      repoId: 'r2',
      request: '加上登入失敗鎖定',
      images: [],
      baseBranch: 'trunk',
      model: 'claude-opus-5-5',
      workspace: 'worktree'
    })
    await waitFor(() => expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'new1' }))
  })

  test('工作方式預設用設定的值；改選 branch 後建立任務帶 workspace=branch', async () => {
    useStore.setState({
      settings: { ...useStore.getState().settings!, defaultWorkspace: 'branch' }
    })
    const { unmount } = render(<NewTaskScreen />)
    expect(screen.getByRole('radio', { name: /^Branch/ })).toBeChecked()
    expect(screen.getByText(/會在原 repo 資料夾切換到新分支/)).toBeInTheDocument()
    unmount()

    useStore.setState({
      settings: { ...useStore.getState().settings!, defaultWorkspace: 'worktree' }
    })
    render(<NewTaskScreen />)
    expect(screen.getByRole('radio', { name: /^Worktree/ })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: /^Branch/ }))
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('develop'))
    await userEvent.type(screen.getByLabelText('需求'), '需求')
    await userEvent.click(start())
    expect(call).toHaveBeenCalledWith(
      'tasks:create',
      expect.objectContaining({ repoId: 'r1', baseBranch: 'develop', workspace: 'branch' })
    )
  })

  test('建立失敗時顯示錯誤並留在原畫面', async () => {
    replies['tasks:create'] = () => {
      throw new Error('尚未登入')
    }
    render(<NewTaskScreen />)
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('develop'))
    await userEvent.type(screen.getByLabelText('需求'), '需求')
    await userEvent.click(start())
    await waitFor(() => expect(useStore.getState().toast?.text).toContain('尚未登入'))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
    expect(start()).toBeEnabled()
  })

  test('沒有 repo 時無法開始；選擇資料夾後選取新加入的 repo', async () => {
    useStore.setState({ repos: [] })
    replies['repos:pick'] = () => {
      const r3 = { id: 'r3', name: 'new-repo', path: '/tmp/new-repo', addedAt: '' }
      useStore.setState({ repos: [...repos, r3] })
      return r3
    }
    render(<NewTaskScreen />)
    await userEvent.type(screen.getByLabelText('需求'), '需求')
    expect(start()).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /選擇其他資料夾/ }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /new-repo/ })).toBeChecked())
    await waitFor(() => expect(start()).toBeEnabled())
  })

  test('Claude Code 未登入時顯示提示並停用開始', async () => {
    useStore.setState({ claude: { found: true, loggedIn: false, error: '尚未登入 Claude Code' } })
    render(<NewTaskScreen />)
    await userEvent.type(screen.getByLabelText('需求'), '需求')
    expect(screen.getByRole('alert')).toHaveTextContent('尚未登入 Claude Code')
    expect(start()).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    expect(call).toHaveBeenCalledWith('claude:status', true)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    await waitFor(() => expect(start()).toBeEnabled())
  })

  test('切換 repo 後，上一個 repo 較慢回來的分支不會蓋掉目前的', async () => {
    let slowReply!: (v: { branches: string[]; current: string }) => void
    replies['repos:branches'] = (id: string) =>
      id === 'r1' ? new Promise((r) => (slowReply = r)) : branches[id]
    render(<NewTaskScreen />)
    await userEvent.click(screen.getByRole('radio', { name: /web-dashboard/ }))
    await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('trunk'))
    slowReply({ branches: ['main', 'old'], current: 'old' })
    await new Promise((r) => setTimeout(r, 0))
    const select = screen.getByLabelText('從哪個分支開始')
    expect(select).toHaveValue('trunk')
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(['trunk'])
  })

  test('重新檢查進行中時按鈕停用', async () => {
    useStore.setState({ claude: { found: true, loggedIn: false, error: '尚未登入 Claude Code' } })
    let done!: (v: unknown) => void
    replies['claude:status'] = () => new Promise((r) => (done = r))
    render(<NewTaskScreen />)
    await userEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    expect(screen.getByRole('button', { name: '檢查中…' })).toBeDisabled()
    done({ found: true, loggedIn: false, error: '還是沒登入' })
    await waitFor(() => expect(screen.getByRole('button', { name: '重新檢查' })).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent('還是沒登入')
  })
})
