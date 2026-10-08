// src/renderer/src/screens/SettingsScreen.tsx
// 對照 docs/design/B6-Settings.dc.html
import {
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState
} from 'react'
import { type ClaudeStatus, MODELS, type Settings } from '@shared/types'
import { useShallow } from 'zustand/react/shallow'
import { call, errorText } from '../api'
import { Button, cx, Icons, inputClass, Pill } from '../components/ui'
import { checkNewPattern } from '../lib/allowedCommands'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'

type Save = (patch: Partial<Settings>) => Promise<Settings>

const SECTIONS = [
  { id: 'account', label: 'Claude 帳號' },
  { id: 'model', label: '模型' },
  { id: 'perm', label: '權限' },
  { id: 'workspace', label: 'Worktree 與專案設定' }
] as const
type SectionId = (typeof SECTIONS)[number]['id']
const sectionDomId = (id: SectionId) => `settings-${id}`
const sectionTitleId = (id: SectionId) => `settings-${id}-title`

/** 捲動位置對應的分類：區塊頂端進入上方三分之一就算目前分類；捲到底時是最後一個 */
function sectionInView(main: HTMLElement): SectionId {
  if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) return SECTIONS.at(-1)!.id
  const line = main.getBoundingClientRect().top + main.clientHeight / 3
  let current: SectionId = SECTIONS[0].id
  for (const s of SECTIONS) {
    const el = document.getElementById(sectionDomId(s.id))
    if (el && el.getBoundingClientRect().top <= line) current = s.id
  }
  return current
}

/**
 * 依序送出設定變更：主程序的 settings:set 是「讀取 → 合併 → 寫入」，
 * 兩個同時送出會讓後寫入的蓋掉先寫入的欄位，所以排隊一次送一個。
 * 成功時更新 store；失敗時把錯誤丟回呼叫端，由各欄位決定怎麼顯示。
 */
function useSaveSettings(): Save {
  const tail = useRef<Promise<unknown>>(Promise.resolve())
  return useCallback((patch: Partial<Settings>) => {
    const run = tail.current.then(async () => {
      const next = await call('settings:set', patch)
      useStore.setState({ settings: next })
      return next
    })
    tail.current = run.catch(() => undefined)
    return run
  }, [])
}

/** 點一下就生效的選項（單選、勾選）：儲存期間先顯示新值，失敗時回到原值並以 toast 顯示錯誤 */
function useInstantSetting<K extends keyof Settings>(key: K, saved: Settings[K], save: Save) {
  const act = useStore((s) => s.act)
  const [saving, run] = usePending()
  const [next, setNext] = useState<Settings[K]>(saved)
  const set = (value: Settings[K]) => {
    setNext(value)
    void run(() => act(() => save({ [key]: value } as Partial<Settings>)))
  }
  return { value: saving ? next : saved, saving, set }
}

/** 左欄分類對應的區塊；tabIndex 讓點左欄後焦點移到這裡 */
function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <section
      id={sectionDomId(id)}
      aria-labelledby={sectionTitleId(id)}
      tabIndex={-1}
      className="flex scroll-mt-9 flex-col gap-3 outline-none"
    >
      <h2 id={sectionTitleId(id)} className="m-0 text-[15px] font-bold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * 失焦或按 Enter 時儲存的文字設定。儲存失敗時保留輸入的內容並在下方顯示錯誤，
 * 按 Esc 還原成目前的設定值。
 */
function TextSetting({
  label,
  saved,
  onSave,
  placeholder,
  hint
}: {
  label: string
  saved: string
  onSave: (value: string) => Promise<unknown>
  placeholder?: string
  hint?: ReactNode
}) {
  // null：沒有未儲存的修改，顯示目前的設定值
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const [saving, run] = usePending()
  const id = useId()
  const commit = async () => {
    if (draft === null) return
    const value = draft.trim()
    if (value === saved) {
      setDraft(null)
      setError(undefined)
      return
    }
    await run(async () => {
      try {
        await onSave(value)
        setDraft(null)
        setError(undefined)
      } catch (e) {
        setError(errorText(e))
      }
    })
  }
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input
        id={id}
        value={draft ?? saved}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            setDraft(null)
            setError(undefined)
          }
        }}
        disabled={saving}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(
          inputClass,
          'h-10 rounded-[10px] px-3 font-mono text-xs disabled:bg-fill-2',
          error && 'border-danger focus:border-danger'
        )}
      />
      {error && (
        <span id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      {hint && (
        <span id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      )}
    </div>
  )
}

/** 「Max」這類方案名稱首字大寫；沒有資料時顯示「訂閱方案」 */
const planLabel = (type?: string) =>
  type ? `${type.slice(0, 1).toUpperCase()}${type.slice(1)} 方案` : '訂閱方案'

function AccountSection({
  claude,
  claudePath,
  save
}: {
  claude?: ClaudeStatus
  claudePath: string
  save: Save
}) {
  const act = useStore((s) => s.act)
  const [checking, runCheck] = usePending()
  const ok = !!claude?.loggedIn
  const recheck = () =>
    void runCheck(() =>
      act(async () => useStore.setState({ claude: await call('claude:status', true) }))
    )
  // 主程序在 claudePath 改變時已重新偵測，這裡只需讀回最新狀態
  const saveClaudePath = async (value: string) => {
    await save({ claudePath: value })
    await act(async () => useStore.setState({ claude: await call('claude:status') }))
  }
  return (
    <Section id="account" title="Claude 帳號">
      <div
        className={cx(
          'flex flex-wrap items-center gap-3.5 rounded-[14px] p-4',
          ok ? 'bg-brand-tint' : 'bg-danger-soft'
        )}
      >
        <span
          aria-hidden
          className={cx('size-2.5 flex-none rounded-full', ok ? 'bg-ok' : 'bg-danger')}
        />
        <span role="status" className="flex min-w-0 flex-[1_1_240px] flex-col">
          <span className={cx('font-medium', !ok && 'text-danger')}>
            {ok
              ? `已透過 Claude Code 登入 · ${planLabel(claude?.subscriptionType)}`
              : (claude?.error ?? '正在檢查 Claude Code…')}
          </span>
          <span className={cx('text-xs', ok ? 'text-brand-muted' : 'text-muted')}>
            使用本機 Claude Code 的登入憑證，不需要 API key
          </span>
        </span>
        <Button
          disabled={checking}
          onClick={recheck}
          className="h-[38px] rounded-[10px] bg-surface px-3.5 text-ink hover:bg-fill"
        >
          {checking ? '檢查中…' : '重新檢查'}
        </Button>
      </div>
      <dl className="m-0 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 px-1 text-[13px]">
        <dt className="text-muted">Claude Code</dt>
        <dd className="m-0 min-w-0">
          {claude?.path ? <code className="break-all">{claude.path}</code> : '—'}
        </dd>
        <dt className="text-muted">版本</dt>
        <dd className="m-0 font-mono text-xs">{claude?.version ?? '—'}</dd>
        {claude?.email && (
          <>
            <dt className="text-muted">帳號</dt>
            <dd className="m-0 min-w-0 break-all">{claude.email}</dd>
          </>
        )}
      </dl>
      <span className="text-xs text-muted">
        尚未登入時，會請你在終端機執行 <code>claude</code> 完成登入。
      </span>
      <TextSetting
        label="claude 執行檔路徑"
        saved={claudePath}
        onSave={saveClaudePath}
        placeholder="自動偵測"
        hint="留空時從登入 shell 的 PATH 尋找 claude。"
      />
    </Section>
  )
}

function ModelSection({ settings, save }: { settings: Settings; save: Save }) {
  const model = useInstantSetting('defaultModel', settings.defaultModel, save)
  return (
    <Section id="model" title="模型">
      <div
        role="radiogroup"
        aria-labelledby={sectionTitleId('model')}
        className="grid grid-cols-2 gap-2.5"
      >
        {MODELS.map((m) => {
          const on = model.value === m.id
          return (
            <label
              key={m.id}
              className={cx(
                'flex cursor-pointer gap-2.5 rounded-[14px] p-3.5',
                on ? 'bg-brand-tint shadow-[0_0_0_2px_var(--color-brand)]' : 'bg-fill-2'
              )}
            >
              <input
                type="radio"
                name="defaultModel"
                checked={on}
                disabled={model.saving}
                onChange={() => model.set(m.id)}
                className="mt-[5px] accent-brand"
              />
              <span className="flex flex-col">
                <span className="font-medium">{m.label}</span>
                <span className={cx('text-xs', on ? 'text-brand-muted' : 'text-muted')}>
                  {m.hint}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      <span className="text-xs text-muted">每個任務建立時也可以單獨選擇。</span>
    </Section>
  )
}

/** 固定的權限規則：只說明，不能關閉 */
function FixedRule({ title, detail }: { title: ReactNode; detail: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3.5">
      <span className="flex flex-1 flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted">{detail}</span>
      </span>
      <Pill tone="brand" className="flex-none">
        固定
      </Pill>
    </div>
  )
}

function AllowedCommands({ list, save }: { list: string[]; save: Save }) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const [saving, run] = usePending()
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const check = checkNewPattern(input, list)
  const warning = !error && check.warning

  const update = (next: string[]) =>
    run(async () => {
      try {
        await save({ alwaysAllowedCommands: next })
        setError(undefined)
        return true
      } catch (e) {
        setError(errorText(e))
        return false
      }
    })
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!check.pattern) return
    if (check.error) {
      setError(check.error)
      return
    }
    if (await update([...list, check.pattern])) setInput('')
  }
  const remove = async (c: string) => {
    // 移除的按鈕會消失，把焦點交給輸入框
    if (await update(list.filter((x) => x !== c))) inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      <span id={`${id}-label`} className="text-[13px] font-medium">
        永遠允許的指令
      </span>
      {list.length > 0 ? (
        <ul aria-labelledby={`${id}-label`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {list.map((c, i) => (
            <li
              key={`${i}:${c}`}
              className="flex items-center gap-1.5 rounded-full bg-fill py-1 pr-1.5 pl-2.5 font-mono text-xs"
            >
              {c}
              <button
                type="button"
                aria-label={`移除 ${c}`}
                disabled={saving}
                onClick={() => void remove(c)}
                className="flex size-[22px] cursor-pointer items-center justify-center rounded-full text-muted hover:bg-chip hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icons.X width={10} height={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-xs text-muted">清單是空的，每個 shell 指令都會先詢問你。</span>
      )}
      <form onSubmit={(e) => void add(e)} className="flex gap-2">
        <input
          ref={inputRef}
          aria-label="新增指令"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setError(undefined)
          }}
          placeholder="例如 npm test *"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error && `${id}-error`, warning && `${id}-warning`, `${id}-hint`]
            .filter(Boolean)
            .join(' ')}
          className={cx(
            inputClass,
            'h-[38px] min-w-0 flex-1 rounded-[10px] px-3 font-mono text-xs',
            error && 'border-danger focus:border-danger'
          )}
        />
        <Button
          type="submit"
          disabled={saving || !check.pattern}
          className="h-[38px] rounded-[10px] px-3.5 text-ink"
        >
          新增
        </Button>
      </form>
      {/* 訊息之間用 margin 而不是 gap：常駐的空 live region 不會多佔一格間距 */}
      <div className="flex flex-col text-xs">
        {error && (
          <span id={`${id}-error`} role="alert" className="mb-2.5 text-danger">
            {error}
          </span>
        )}
        {/* 常駐的 live region：提醒出現或改變時唸出來 */}
        <div aria-live="polite">
          {warning && (
            <p
              id={`${id}-warning`}
              className="m-0 mb-2.5 rounded-[10px] bg-decision px-3 py-2 text-decision-ink"
            >
              {warning}
            </p>
          )}
        </div>
        <span id={`${id}-hint`} className="text-muted">
          以空格加 <code>*</code> 結尾可接任意參數（<code>npm test *</code> 也允許{' '}
          <code>npm test --watch</code>），否則要完全相同。含 ; &amp; | ` &lt; &gt; $
          或換行的指令一律需要核准。
        </span>
      </div>
    </div>
  )
}

function PermissionSection({ settings, save }: { settings: Settings; save: Save }) {
  return (
    <Section id="perm" title="實作階段權限">
      <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_var(--color-chip)]">
        <FixedRule title="worktree 內的檔案讀寫自動允許" detail="worktree 以外的檔案一律拒絕" />
        <FixedRule
          title={
            <>
              修改 <code>.git</code>、<code>.claude</code> 與 <code>.mcp.json</code> 需要核准
            </>
          }
          detail="這些檔案會改變 git 或 Claude 的行為，即使在 worktree 內也會先詢問"
        />
        <FixedRule title="shell 指令需要核准" detail="下方清單中的指令不必詢問" />
        <AllowedCommands list={settings.alwaysAllowedCommands} save={save} />
      </div>
    </Section>
  )
}

function WorkspaceSection({ settings, save }: { settings: Settings; save: Save }) {
  const loadProject = useInstantSetting('loadProjectSettings', settings.loadProjectSettings, save)
  return (
    <Section id="workspace" title="Worktree 與專案設定">
      <TextSetting
        label="Worktree 存放位置"
        saved={settings.worktreeRoot}
        onSave={(v) => save({ worktreeRoot: v })}
        hint="必須是絕對路徑。只影響之後建立的任務，已有的 worktree 不會搬移。"
      />
      <TextSetting
        label="分支名稱前綴"
        saved={settings.branchPrefix}
        onSave={(v) => save({ branchPrefix: v })}
      />
      <label className="flex cursor-pointer items-center gap-3 rounded-[14px] px-4 py-3.5 shadow-[0_0_0_1px_var(--color-chip)]">
        <span className="flex flex-1 flex-col">
          <span className="font-medium">載入 repo 的 CLAUDE.md 與 .claude 設定</span>
          <span className="text-xs text-muted">
            包含專案的 skills 與 MCP；不載入 ~/.claude 的 hooks 與 plugins
          </span>
        </span>
        <input
          type="checkbox"
          checked={loadProject.value}
          disabled={loadProject.saving}
          onChange={(e) => loadProject.set(e.target.checked)}
          className="size-[18px] flex-none accent-brand"
        />
      </label>
    </Section>
  )
}

export function SettingsScreen() {
  const { settings, claude } = useStore(
    useShallow((s) => ({ settings: s.settings, claude: s.claude }))
  )
  const act = useStore((s) => s.act)
  const open = useStore((s) => s.open)
  const save = useSaveSettings()
  // 目前分類：點左欄時以點的那個為準（目標可能捲不到頂端），使用者自己捲動後改看捲動位置
  const [spied, setSpied] = useState<SectionId>('account')
  const [clicked, setClicked] = useState<SectionId | null>(null)
  const active = clicked ?? spied
  const release = () => setClicked(null)

  const jump = (e: MouseEvent<HTMLAnchorElement>, id: SectionId) => {
    e.preventDefault()
    setClicked(id)
    const el = document.getElementById(sectionDomId(id))
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    el?.focus({ preventScroll: true })
  }
  const reload = () =>
    void act(async () => useStore.setState({ settings: await call('settings:get') }))

  return (
    <>
      <nav aria-label="設定分類" className="flex w-[236px] flex-none flex-col gap-1 px-1.5 py-2">
        <button
          type="button"
          onClick={() => void open({ kind: 'new' })}
          className="mb-3 flex h-10 cursor-pointer items-center gap-2 px-2.5 text-[13px] text-ink-2 hover:text-ink"
        >
          <Icons.Back width={14} height={14} />
          返回
        </button>
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${sectionDomId(s.id)}`}
            onClick={(e) => jump(e, s.id)}
            aria-current={active === s.id ? 'location' : undefined}
            className={cx(
              'rounded-xl px-3 py-2.5 text-[13px] no-underline',
              active === s.id
                ? 'bg-surface font-medium text-ink shadow-raised hover:text-ink'
                : 'text-ink-2 hover:bg-surface/60 hover:text-ink'
            )}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <main
        onScroll={(e) => setSpied(sectionInView(e.currentTarget))}
        onWheel={release}
        onTouchMove={release}
        onKeyDown={release}
        onPointerDown={(e) => e.target === e.currentTarget && release()}
        className="min-w-0 flex-1 overflow-y-auto rounded-2xl bg-surface px-7 py-9 shadow-card"
      >
        <div className="mx-auto flex max-w-[680px] flex-col gap-8">
          <h1 className="m-0 text-2xl font-bold">設定</h1>
          {settings ? (
            <>
              <AccountSection claude={claude} claudePath={settings.claudePath ?? ''} save={save} />
              <ModelSection settings={settings} save={save} />
              <PermissionSection settings={settings} save={save} />
              <WorkspaceSection settings={settings} save={save} />
            </>
          ) : (
            <div className="flex items-center gap-3 text-muted">
              無法載入設定。
              <Button size="sm" onClick={reload}>
                重新載入
              </Button>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
