// tests/renderer/SettingsScreen.test.tsx
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))
import type { Settings } from '@shared/types'
import { call } from '@renderer/api'
import App from '@renderer/App'
import { SettingsScreen } from '@renderer/screens/SettingsScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
// 用主程序真正的檢查，錯誤訊息和實際 IPC 回傳的一樣
import { validateSettingsPatch } from '../../src/main/ipcGuards'

const initial: Settings = {
  defaultModel: 'claude-opus-5-5',
  worktreeRoot: '/Users/me/.harness/worktrees',
  branchPrefix: 'harness/',
  alwaysAllowedCommands: ['git status', 'git diff', 'ls *'],
  loadProjectSettings: true
}
let stored: Settings
let replies: Record<string, (...args: never[]) => unknown>

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const setCalls = () => vi.mocked(call).mock.calls.filter(([ch]) => ch === 'settings:set')

beforeEach(() => {
  stored = { ...initial }
  replies = {
    'settings:set': (patch: Partial<Settings>) => {
      stored = { ...stored, ...validateSettingsPatch(patch) }
      return stored
    },
    'settings:get': () => stored,
    'claude:status': () => useStore.getState().claude
  }
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string, ...args: never[]) =>
    replies[ch](...args)) as typeof call)
  resetStoreInternals()
  useStore.setState({
    init: () => () => {},
    ready: true,
    repos: [],
    tasks: {},
    timelines: {},
    view: { kind: 'settings' },
    toast: undefined,
    claude: {
      found: true,
      loggedIn: true,
      path: '/usr/local/bin/claude',
      version: '2.1.0 (Claude Code)',
      subscriptionType: 'max',
      email: 'me@example.com'
    },
    settings: initial
  })
})

const region = (name: string) => screen.getByRole('region', { name })
const addInput = () => screen.getByLabelText('新增指令')
const addButton = () => screen.getByRole('button', { name: '新增' })

describe('SettingsScreen：Claude 帳號', () => {
  test('顯示登入狀態、路徑、版本與帳號；重新檢查會重新偵測', async () => {
    render(<SettingsScreen />)
    const account = region('Claude 帳號')
    expect(within(account).getByText('已透過 Claude Code 登入 · Max 方案')).toBeInTheDocument()
    expect(within(account).getByText('/usr/local/bin/claude')).toBeInTheDocument()
    expect(within(account).getByText('2.1.0 (Claude Code)')).toBeInTheDocument()
    expect(within(account).getByText('me@example.com')).toBeInTheDocument()

    replies['claude:status'] = () => ({
      found: true,
      loggedIn: false,
      error: '尚未登入，請在終端機執行 claude 並完成登入。'
    })
    await userEvent.click(within(account).getByRole('button', { name: '重新檢查' }))
    expect(call).toHaveBeenCalledWith('claude:status', true)
    expect(
      await within(account).findByText('尚未登入，請在終端機執行 claude 並完成登入。')
    ).toBeInTheDocument()
  })

  test('claude 路徑失焦時儲存並讀回偵測結果；清空改回自動偵測', async () => {
    replies['claude:status'] = () => ({
      found: true,
      loggedIn: false,
      path: '/opt/claude',
      error: '無法讀取 Claude Code 狀態：spawn ENOENT'
    })
    render(<SettingsScreen />)
    const field = screen.getByLabelText('claude 執行檔路徑')
    await userEvent.type(field, ' /opt/claude ')
    await userEvent.tab()
    expect(call).toHaveBeenCalledWith('settings:set', { claudePath: '/opt/claude' })
    // 主程序在 settings:set 時已重新偵測，只讀回狀態、不再要求重新偵測
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('claude:status'))
    expect(await screen.findByText('無法讀取 Claude Code 狀態：spawn ENOENT')).toBeInTheDocument()
    expect(field).toHaveValue('/opt/claude')

    await userEvent.clear(field)
    await userEvent.tab()
    expect(call).toHaveBeenCalledWith('settings:set', { claudePath: '' })
    await waitFor(() => expect(useStore.getState().settings?.claudePath).toBeUndefined())
    expect(field).toHaveValue('')
  })
})

describe('SettingsScreen：模型與專案設定', () => {
  test('點選模型即儲存為預設模型', async () => {
    render(<SettingsScreen />)
    expect(screen.getByRole('radio', { name: /Opus 5.5/ })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: /Sonnet 5.5/ }))
    expect(call).toHaveBeenCalledWith('settings:set', { defaultModel: 'claude-sonnet-5-5' })
    await waitFor(() =>
      expect(useStore.getState().settings?.defaultModel).toBe('claude-sonnet-5-5')
    )
    expect(screen.getByRole('radio', { name: /Sonnet 5.5/ })).toBeChecked()
  })

  test('載入專案設定：勾選即儲存；失敗時回到原值並顯示 toast', async () => {
    render(<SettingsScreen />)
    const box = screen.getByRole('checkbox', { name: /載入 repo 的 CLAUDE.md/ })
    expect(box).toBeChecked()
    await userEvent.click(box)
    expect(call).toHaveBeenCalledWith('settings:set', { loadProjectSettings: false })
    await waitFor(() => expect(box).not.toBeChecked())

    replies['settings:set'] = () => {
      throw new Error('無法寫入設定檔')
    }
    await userEvent.click(box)
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))
    expect(box).not.toBeChecked()
  })

  test('設定變更依序送出：前一個完成前不送下一個', async () => {
    const gate = deferred()
    const save = replies['settings:set']
    replies['settings:set'] = async (patch: never) => {
      if ('defaultModel' in (patch as object)) await gate.promise
      return save(patch)
    }
    render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('radio', { name: /Sonnet 5.5/ }))
    // 儲存中先顯示新的選擇，並停用選項
    expect(screen.getByRole('radio', { name: /Sonnet 5.5/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Opus 5.5/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /載入 repo 的 CLAUDE.md/ }))
    expect(setCalls()).toHaveLength(1)
    await act(async () => gate.resolve())
    await waitFor(() => expect(setCalls()).toHaveLength(2))
    await waitFor(() =>
      expect(useStore.getState().settings).toMatchObject({
        defaultModel: 'claude-sonnet-5-5',
        loadProjectSettings: false
      })
    )
  })
})

describe('SettingsScreen：權限', () => {
  test('固定的權限規則只是說明，不是開關', () => {
    render(<SettingsScreen />)
    const perm = region('實作階段權限')
    expect(within(perm).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(perm).getAllByText('固定')).toHaveLength(3)
    expect(within(perm).getByText('worktree 內的檔案讀寫自動允許')).toBeInTheDocument()
    expect(within(perm).getByText('shell 指令需要核准')).toBeInTheDocument()
    expect(within(perm).getByText('.mcp.json')).toBeInTheDocument()
    // 清單下方說明樣式規則與串接指令
    expect(within(perm).getByText(/一律需要核准/)).toBeInTheDocument()
  })

  test('新增指令時正規化空白，成功後清空輸入', async () => {
    render(<SettingsScreen />)
    expect(addButton()).toBeDisabled()
    await userEvent.type(addInput(), '   ')
    expect(addButton()).toBeDisabled()
    await userEvent.type(addInput(), 'npm   test *')
    await userEvent.click(addButton())
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff', 'ls *', 'npm test *']
    })
    await waitFor(() => expect(addInput()).toHaveValue(''))
    expect(screen.getByRole('button', { name: '移除 npm test *' })).toBeInTheDocument()
  })

  test('重複或含串接符號的樣式不能加入，錯誤顯示在輸入框下方', async () => {
    render(<SettingsScreen />)
    await userEvent.type(addInput(), 'git  status{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('「git status」已經在清單中')
    expect(addInput()).toHaveAttribute('aria-invalid', 'true')
    expect(addInput()).toHaveValue('git  status')
    // 修改輸入時清掉錯誤
    await userEvent.clear(addInput())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.type(addInput(), 'npm test && rm -rf /{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('一律需要核准')
    expect(setCalls()).toHaveLength(0)
  })

  test('範圍很廣的樣式只提醒，仍可加入', async () => {
    render(<SettingsScreen />)
    await userEvent.type(addInput(), 'npm *')
    expect(screen.getByText('「npm *」會允許所有 npm 開頭的指令，範圍很廣')).toBeInTheDocument()
    expect(addButton()).toBeEnabled()
    await userEvent.click(addButton())
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff', 'ls *', 'npm *']
    })
    await waitFor(() => expect(screen.queryByText(/範圍很廣/)).not.toBeInTheDocument())
  })

  test('移除指令；儲存中停用清單按鈕，完成後焦點回到輸入框', async () => {
    const gate = deferred()
    const save = replies['settings:set']
    replies['settings:set'] = async (patch: never) => {
      await gate.promise
      return save(patch)
    }
    render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('button', { name: '移除 ls *' }))
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff']
    })
    expect(screen.getByRole('button', { name: '移除 git status' })).toBeDisabled()
    await act(async () => gate.resolve())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '移除 ls *' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: '移除 git status' })).toBeEnabled()
    expect(addInput()).toHaveFocus()
  })

  test('清單是空的時說明每個指令都會詢問', () => {
    useStore.setState({ settings: { ...initial, alwaysAllowedCommands: [] } })
    render(<SettingsScreen />)
    expect(screen.getByText('清單是空的，每個 shell 指令都會先詢問你。')).toBeInTheDocument()
  })
})

describe('SettingsScreen：Worktree 與分支', () => {
  test('相對路徑儲存失敗時保留輸入並顯示錯誤，修正後儲存', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('Worktree 存放位置')
    await userEvent.clear(field)
    await userEvent.type(field, 'worktrees')
    await userEvent.tab()
    expect(await screen.findByRole('alert')).toHaveTextContent('worktree 位置必須是絕對路徑')
    expect(field).toHaveValue('worktrees')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(useStore.getState().settings?.worktreeRoot).toBe('/Users/me/.harness/worktrees')

    await userEvent.clear(field)
    await userEvent.type(field, '/tmp/wt{Enter}')
    await waitFor(() => expect(useStore.getState().settings?.worktreeRoot).toBe('/tmp/wt'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(field).toHaveValue('/tmp/wt')
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  test('Esc 還原成目前的設定值；沒有修改時失焦不儲存', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    await userEvent.click(field)
    await userEvent.tab()
    expect(setCalls()).toHaveLength(0)
    await userEvent.type(field, 'x{Escape}')
    expect(field).toHaveValue('harness/')
    await userEvent.tab()
    expect(setCalls()).toHaveLength(0)
  })

  test('分支前綴清空時保留空白輸入並顯示錯誤', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    await userEvent.clear(field)
    await userEvent.tab()
    expect(await screen.findByRole('alert')).toHaveTextContent('分支前綴必須是非空白的文字')
    expect(field).toHaveValue('')
    expect(useStore.getState().settings?.branchPrefix).toBe('harness/')
  })
})

describe('SettingsScreen：版面與導覽', () => {
  test('設定頁取代側欄；左欄標示目前分類，返回回到新任務', async () => {
    render(<App />)
    expect(screen.queryByRole('navigation', { name: 'Repo 與任務' })).not.toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: '設定分類' })
    const link = (name: string) => within(nav).getByRole('link', { name })
    expect(link('Claude 帳號')).toHaveAttribute('aria-current', 'location')
    await userEvent.click(link('權限'))
    expect(link('權限')).toHaveAttribute('aria-current', 'location')
    expect(link('Claude 帳號')).not.toHaveAttribute('aria-current')
    expect(region('實作階段權限')).toHaveFocus()

    await userEvent.click(within(nav).getByRole('button', { name: '返回' }))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
    expect(screen.getByRole('navigation', { name: 'Repo 與任務' })).toBeInTheDocument()
  })

  test('設定沒有載入時可以重新載入', async () => {
    useStore.setState({ settings: undefined })
    render(<SettingsScreen />)
    expect(screen.getByText(/無法載入設定/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重新載入' }))
    expect(call).toHaveBeenCalledWith('settings:get')
    expect(await screen.findByRole('region', { name: '模型' })).toBeInTheDocument()
  })
})
