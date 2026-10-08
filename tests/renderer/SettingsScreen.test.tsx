// tests/renderer/SettingsScreen.test.tsx
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
import { makeTask } from '../fixtures/task'
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
const callsOf = (channel: string) => vi.mocked(call).mock.calls.filter(([ch]) => ch === channel)
const setCalls = () => callsOf('settings:set')
const saveFails = (message = '無法寫入設定檔') => {
  replies['settings:set'] = () => {
    throw new Error(message)
  }
}
/** settings:set 等到回傳的 gate 打開才回應；match 可只擋特定的 patch */
function holdSettingsSet(match: (patch: Partial<Settings>) => boolean = () => true) {
  const gate = deferred()
  const save = replies['settings:set']
  replies['settings:set'] = async (patch: never) => {
    if (match(patch)) await gate.promise
    return save(patch)
  }
  return gate
}

beforeEach(() => {
  stored = { ...initial }
  replies = {
    'settings:set': (patch: Partial<Settings>) => {
      stored = { ...stored, ...validateSettingsPatch(patch) }
      return stored
    },
    'settings:get': () => stored,
    'claude:status': () => useStore.getState().claude,
    'tasks:timeline': () => []
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
    settingsReturn: undefined,
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
const radio = (name: RegExp) => screen.getByRole('radio', { name })
const projectBox = () => screen.getByRole('checkbox', { name: /載入 repo 的 CLAUDE.md/ })

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
    const error = await within(account).findByText('尚未登入，請在終端機執行 claude 並完成登入。')
    expect(error).toHaveClass('text-danger')
  })

  test('重新檢查進行中：按鈕保留焦點、標示停用並忽略再次點擊', async () => {
    const gate = deferred()
    replies['claude:status'] = async () => {
      await gate.promise
      return useStore.getState().claude
    }
    render(<SettingsScreen />)
    const button = screen.getByRole('button', { name: '重新檢查' })
    await userEvent.click(button)
    expect(button).toHaveTextContent('檢查中…')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveFocus()
    await userEvent.click(button)
    expect(callsOf('claude:status')).toHaveLength(1)
    await act(async () => gate.resolve())
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'))
    expect(button).toHaveTextContent('重新檢查')
    expect(button).toHaveFocus()
  })

  test('還沒有偵測結果時以中性樣式顯示「正在檢查」', () => {
    useStore.setState({ claude: undefined })
    render(<SettingsScreen />)
    expect(screen.getByText('正在檢查 Claude Code…')).not.toHaveClass('text-danger')
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
  test('點選模型即儲存；儲存中選項不停用，焦點留在選項上', async () => {
    const gate = holdSettingsSet()
    render(<SettingsScreen />)
    expect(radio(/Opus 5.5/)).toBeChecked()
    await userEvent.click(radio(/Sonnet 5.5/))
    expect(call).toHaveBeenCalledWith('settings:set', { defaultModel: 'claude-sonnet-5-5' })
    // 儲存中先顯示新的選擇
    expect(radio(/Sonnet 5.5/)).toBeChecked()
    expect(radio(/Sonnet 5.5/)).toHaveFocus()
    expect(radio(/Opus 5.5/)).toBeEnabled()
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-busy', 'true')
    await act(async () => gate.resolve())
    await waitFor(() =>
      expect(useStore.getState().settings?.defaultModel).toBe('claude-sonnet-5-5')
    )
    expect(radio(/Sonnet 5.5/)).toBeChecked()
    expect(radio(/Sonnet 5.5/)).toHaveFocus()
    expect(screen.getByRole('radiogroup')).not.toHaveAttribute('aria-busy')
  })

  test('模型儲存失敗時回到原值並顯示 toast', async () => {
    saveFails()
    render(<SettingsScreen />)
    await userEvent.click(radio(/Sonnet 5.5/))
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))
    expect(radio(/Opus 5.5/)).toBeChecked()
    expect(radio(/Sonnet 5.5/)).toHaveFocus()
  })

  test('載入專案設定：勾選即儲存且保留焦點；失敗時回到原值並顯示 toast', async () => {
    render(<SettingsScreen />)
    const box = projectBox()
    expect(box).toBeChecked()
    await userEvent.click(box)
    expect(call).toHaveBeenCalledWith('settings:set', { loadProjectSettings: false })
    await waitFor(() => expect(box).not.toBeChecked())
    expect(box).toHaveFocus()

    saveFails()
    await userEvent.click(box)
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))
    expect(box).not.toBeChecked()
    expect(box).toHaveFocus()
  })

  test('設定變更依序送出：前一個完成前不送下一個', async () => {
    const gate = holdSettingsSet((patch) => 'defaultModel' in patch)
    render(<SettingsScreen />)
    await userEvent.click(radio(/Sonnet 5.5/))
    await userEvent.click(projectBox())
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
    expect(within(perm).getByText(/與 git hooks 需要核准/)).toBeInTheDocument()
    expect(within(perm).getByText(/Harness 自動 commit 時不執行 git hook/)).toBeInTheDocument()
    // 清單下方說明樣式規則與串接指令
    expect(within(perm).getByText(/一律需要核准/)).toBeInTheDocument()
  })

  test('新增指令時正規化空白，成功後清空輸入且焦點回到輸入框', async () => {
    render(<SettingsScreen />)
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await userEvent.type(addInput(), '   ')
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(addButton())
    expect(setCalls()).toHaveLength(0)
    await userEvent.type(addInput(), 'npm   test *')
    expect(addButton()).not.toHaveAttribute('aria-disabled')
    await userEvent.click(addButton())
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff', 'ls *', 'npm test *']
    })
    await waitFor(() => expect(addInput()).toHaveValue(''))
    expect(addInput()).toHaveFocus()
    expect(screen.getByRole('button', { name: '移除 npm test *' })).toBeInTheDocument()

    // 用 Enter 新增時焦點本來就在輸入框
    await userEvent.type(addInput(), 'npm run lint{Enter}')
    await waitFor(() => expect(addInput()).toHaveValue(''))
    expect(addInput()).toHaveFocus()
    expect(screen.getByRole('button', { name: '移除 npm run lint' })).toBeInTheDocument()
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

  test('範圍很廣或已知危險的樣式只提醒，仍可加入', async () => {
    render(<SettingsScreen />)
    await userEvent.type(addInput(), 'git push *')
    expect(screen.getByText(/「git push \*」會允許把變更推送到遠端/)).toBeInTheDocument()
    await userEvent.clear(addInput())
    await userEvent.type(addInput(), 'npm *')
    expect(screen.getByText('「npm *」會允許所有 npm 開頭的指令，範圍很廣')).toBeInTheDocument()
    expect(addButton()).not.toHaveAttribute('aria-disabled')
    await userEvent.click(addButton())
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff', 'ls *', 'npm *']
    })
    await waitFor(() => expect(screen.queryByText(/範圍很廣/)).not.toBeInTheDocument())
  })

  test('新增時儲存失敗：顯示錯誤並保留輸入', async () => {
    saveFails()
    render(<SettingsScreen />)
    await userEvent.type(addInput(), 'npm test *{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('無法寫入設定檔')
    expect(addInput()).toHaveValue('npm test *')
    expect(addInput()).toHaveFocus()
    expect(useStore.getState().settings?.alwaysAllowedCommands).toEqual(
      initial.alwaysAllowedCommands
    )
  })

  test('移除指令；儲存中清單按鈕標示停用並忽略點擊，完成後焦點回到輸入框', async () => {
    const gate = holdSettingsSet()
    render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('button', { name: '移除 ls *' }))
    expect(call).toHaveBeenCalledWith('settings:set', {
      alwaysAllowedCommands: ['git status', 'git diff']
    })
    const other = screen.getByRole('button', { name: '移除 git status' })
    expect(other).toHaveAttribute('aria-disabled', 'true')
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(other)
    expect(setCalls()).toHaveLength(1)
    await act(async () => gate.resolve())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '移除 ls *' })).not.toBeInTheDocument()
    )
    expect(other).not.toHaveAttribute('aria-disabled')
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
    // 錯誤與說明都在欄位的描述裡
    expect(field).toHaveAccessibleDescription(
      /worktree 位置必須是絕對路徑.*必須是絕對路徑。只影響之後建立的任務/
    )
    expect(useStore.getState().settings?.worktreeRoot).toBe('/Users/me/.harness/worktrees')

    await userEvent.clear(field)
    await userEvent.type(field, '/tmp/wt/{Enter}')
    // 主程序正規化路徑（去掉結尾的 /），欄位顯示正規化後的值
    await waitFor(() => expect(useStore.getState().settings?.worktreeRoot).toBe('/tmp/wt'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(field).toHaveValue('/tmp/wt')
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  test('Enter 直接儲存：儲存中欄位唯讀並標示忙碌，焦點留在欄位', async () => {
    const gate = holdSettingsSet()
    render(<SettingsScreen />)
    const field = screen.getByLabelText('Worktree 存放位置')
    await userEvent.clear(field)
    await userEvent.type(field, '/tmp/wt{Enter}')
    expect(setCalls()).toHaveLength(1)
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveAttribute('aria-busy', 'true')
    expect(field).toBeEnabled()
    await act(async () => gate.resolve())
    await waitFor(() => expect(field).not.toHaveAttribute('readonly'))
    expect(field).not.toHaveAttribute('aria-busy')
    expect(field).toHaveFocus()
    expect(useStore.getState().settings?.worktreeRoot).toBe('/tmp/wt')
    // 已儲存，之後失焦不再送出
    await userEvent.tab()
    expect(setCalls()).toHaveLength(1)
  })

  test('輸入法選字中的 Enter 與 Esc 不儲存、不還原；新增指令也不送出', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    await userEvent.clear(field)
    await userEvent.type(field, '功能/')
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    // 儲存是排隊後才送出：先讓排隊的工作跑完再檢查
    await act(async () => {})
    expect(setCalls()).toHaveLength(0)
    expect(field).toHaveValue('功能/')
    // 一般的 Esc 才還原（之後失焦不會儲存）
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveValue('harness/')

    await userEvent.type(addInput(), '測試')
    expect(fireEvent.keyDown(addInput(), { key: 'Enter', isComposing: true })).toBe(false)
    expect(fireEvent.keyDown(addInput(), { key: 'Enter', keyCode: 229 })).toBe(false)
    expect(setCalls()).toHaveLength(0)
    expect(addInput()).toHaveValue('測試')
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

  test('分支前綴不符合 git 分支名稱規則時顯示錯誤；說明顯示分支名稱的樣子', async () => {
    render(<SettingsScreen />)
    const field = screen.getByLabelText('分支名稱前綴')
    expect(field).toHaveAccessibleDescription(/例如 harness\/20261008-1a2b3c4d/)
    await userEvent.clear(field)
    await userEvent.type(field, 'my branch/{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('分支前綴不符合 git 分支名稱規則')
    expect(field).toHaveValue('my branch/')
    expect(useStore.getState().settings?.branchPrefix).toBe('harness/')
  })

  test('離開設定頁後才失敗的儲存改用 toast 告知', async () => {
    const failLater = () => {
      const gate = deferred()
      replies['settings:set'] = async () => {
        await gate.promise
        throw new Error('無法寫入設定檔')
      }
      return gate
    }
    let gate = failLater()
    const first = render(<SettingsScreen />)
    await userEvent.type(screen.getByLabelText('分支名稱前綴'), 'x{Enter}')
    first.unmount()
    await act(async () => gate.resolve())
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))

    useStore.setState({ toast: undefined })
    gate = failLater()
    const second = render(<SettingsScreen />)
    await userEvent.type(addInput(), 'npm test *{Enter}')
    second.unmount()
    await act(async () => gate.resolve())
    await waitFor(() => expect(useStore.getState().toast?.text).toBe('無法寫入設定檔'))
  })
})

describe('SettingsScreen：版面與導覽', () => {
  const navLink = (name: string) =>
    within(screen.getByRole('navigation', { name: '設定分類' })).getByRole('link', { name })
  const current = () =>
    within(screen.getByRole('navigation', { name: '設定分類' }))
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'location')
      .map((a) => a.textContent)

  /** jsdom 沒有版面：給捲動區與各區塊固定的位置，回傳「捲到某處並觸發 scroll」 */
  function mockLayout() {
    const main = screen.getByRole('main')
    let top = 0
    const offsets = { account: 0, model: 400, perm: 700, workspace: 1100 }
    Object.defineProperties(main, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1400 },
      scrollTop: { configurable: true, get: () => top, set: (v: number) => (top = v) }
    })
    main.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    for (const [id, offset] of Object.entries(offsets))
      document.getElementById(`settings-${id}`)!.getBoundingClientRect = () =>
        ({ top: offset - top }) as DOMRect
    return (to: number) => {
      top = to
      fireEvent.scroll(main)
    }
  }

  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView
    delete (window as Partial<Window>).matchMedia
  })

  test('設定頁取代側欄；左欄標示目前分類，返回回到新任務', async () => {
    render(<App />)
    expect(screen.queryByRole('navigation', { name: 'Repo 與任務' })).not.toBeInTheDocument()
    expect(navLink('Claude 帳號')).toHaveAttribute('aria-current', 'location')
    await userEvent.click(navLink('權限'))
    expect(current()).toEqual(['權限'])
    expect(region('實作階段權限')).toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
    expect(screen.getByRole('navigation', { name: 'Repo 與任務' })).toBeInTheDocument()
  })

  test('返回回到打開設定前的畫面；那個任務已不存在時回到新任務', async () => {
    useStore.setState({
      tasks: { a: makeTask({ id: 'a' }) },
      settingsReturn: { kind: 'task', taskId: 'a' }
    })
    const { unmount } = render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(useStore.getState().view).toEqual({ kind: 'task', taskId: 'a' })
    unmount()

    useStore.setState({
      view: { kind: 'settings' },
      settingsReturn: { kind: 'task', taskId: 'gone' }
    })
    render(<SettingsScreen />)
    await userEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(useStore.getState().view).toEqual({ kind: 'new' })
  })

  test('捲動時標示目前分類；捲到底時是最後一個', () => {
    render(<SettingsScreen />)
    const scrollTo = mockLayout()
    scrollTo(0)
    expect(current()).toEqual(['Claude 帳號'])
    scrollTo(250)
    expect(current()).toEqual(['模型'])
    scrollTo(520)
    expect(current()).toEqual(['權限'])
    scrollTo(800)
    expect(current()).toEqual(['Worktree 與專案設定'])
  })

  test('點左欄後以點的分類為準；捲動滑鼠或在內容區按下後改看捲動位置', async () => {
    render(<SettingsScreen />)
    const scrollTo = mockLayout()
    await userEvent.click(navLink('模型'))
    // 點選觸發的捲動（例如捲到底）不改變標示
    scrollTo(800)
    expect(current()).toEqual(['模型'])
    fireEvent.wheel(screen.getByRole('main'))
    expect(current()).toEqual(['Worktree 與專案設定'])

    await userEvent.click(navLink('權限'))
    expect(current()).toEqual(['權限'])
    fireEvent.pointerDown(screen.getByText('每個任務建立時也可以單獨選擇。'))
    expect(current()).toEqual(['Worktree 與專案設定'])
  })

  test('點左欄時平滑捲動；偏好減少動態時直接跳過去', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    render(<SettingsScreen />)
    await userEvent.click(navLink('模型'))
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' })
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia
    await userEvent.click(navLink('權限'))
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'start' })
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
