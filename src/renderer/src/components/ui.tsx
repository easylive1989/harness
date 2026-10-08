// src/renderer/src/components/ui.tsx
// 共用的 UI 元件與樣式常數。這裡同時匯出 cx／TONE_TEXT／Icons 等非元件，
// 改這個檔時 Vite 會整頁重新載入而不是 fast refresh，換來各畫面只需一個 import 來源。
/* eslint-disable react-refresh/only-export-components */
import type { ComponentProps, HTMLAttributes, ReactNode, SVGProps } from 'react'
import { extendTailwindMerge } from 'tailwind-merge'

// 讓呼叫端傳入的 className 能覆蓋元件預設的 class（例如 Button 的 h-11 被 h-[42px] 取代）。
// Tailwind 產生的 CSS 順序不看 class 寫的先後，同一屬性的兩個 class 誰贏不一定，所以要先合併掉。
const twMerge = extendTailwindMerge({
  extend: { theme: { shadow: ['card', 'raised', 'focus', 'tab', 'dialog'] } }
})
export const cx = (...c: (string | false | null | undefined)[]) =>
  twMerge(c.filter(Boolean).join(' '))

type Variant = 'primary' | 'secondary' | 'dark' | 'ghost' | 'danger'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white font-medium hover:bg-brand-hover',
  secondary: 'bg-fill text-ink-2 hover:bg-chip',
  dark: 'bg-ink text-white font-medium hover:bg-ink-2',
  ghost: 'bg-transparent text-ink-2 hover:bg-fill',
  danger: 'bg-transparent text-danger hover:bg-danger-soft'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...p
}: ComponentProps<'button'> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-9 rounded-[10px] px-3 text-xs' : 'h-11 rounded-xl px-4 text-[13px]',
        VARIANTS[variant],
        className
      )}
      {...p}
    />
  )
}

export function Panel({ className, ...p }: HTMLAttributes<HTMLElement>) {
  return <section className={cx('rounded-2xl bg-surface shadow-card', className)} {...p} />
}

export type Tone =
  'neutral' | 'brand' | 'decision' | 'progress' | 'review' | 'warn' | 'danger' | 'muted'
const TONES: Record<Tone, string> = {
  neutral: 'bg-fill text-ink-2',
  brand: 'bg-brand-soft text-brand-ink',
  decision: 'bg-decision text-decision-ink',
  progress: 'bg-decision text-progress',
  review: 'bg-review-soft text-review',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  muted: 'bg-fill text-muted'
}
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-2',
  brand: 'text-brand',
  decision: 'text-decision-ink',
  progress: 'text-progress',
  review: 'text-review',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-muted'
}

export function Pill({
  tone = 'neutral',
  className,
  title,
  children
}: {
  tone?: Tone
  className?: string
  /** 滑過時的說明（例如使用者指示的摘錄） */
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * 決策來源「你的指示」（規格回饋、插話或報告回饋中直接給的指示）：
 * Claude 摘錄的指示滑過時看得到，螢幕閱讀器也唸得到（title 只有滑鼠看得到）
 */
export function UserInstructionPill({ excerpt }: { excerpt?: string }) {
  return (
    <Pill tone="brand" title={excerpt || undefined}>
      你的指示
      {excerpt && <span className="sr-only">：{excerpt}</span>}
    </Pill>
  )
}

/** decorative：旁邊已有文字說明（例如放在 LiveStatus 裡）時不再自己宣告狀態 */
export function Spinner({ className, decorative }: { className?: string; decorative?: boolean }) {
  return (
    <span
      {...(decorative ? { 'aria-hidden': true } : { role: 'status', 'aria-label': '處理中' })}
      className={cx(
        'inline-block size-3.5 flex-none animate-spin rounded-full border-2 border-brand border-t-transparent',
        className
      )}
    />
  )
}

/**
 * 常駐的 live region：有 text 時顯示轉圈與文字，沒有時保持空的但不移除，
 * 讓螢幕閱讀器在狀態出現或改變時唸出來。
 */
export function LiveStatus({ text, className }: { text?: string | false; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx('flex items-center gap-2 text-muted', className)}
    >
      {text && (
        <>
          <Spinner decorative />
          {text}
        </>
      )}
    </div>
  )
}

export function Avatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex size-7 flex-none items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand',
        className
      )}
    >
      C
    </span>
  )
}

export const inputClass =
  'h-[42px] rounded-xl border border-line bg-surface px-3.5 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-brand'
export const textareaClass =
  'rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-muted-2 focus:border-brand'

type IconProps = SVGProps<SVGSVGElement>
const svg = (p: IconProps, children: ReactNode) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...p}
  >
    {children}
  </svg>
)
export const Icons = {
  Plus: (p: IconProps) => svg(p, <path d="M12 5v14M5 12h14" />),
  Check: (p: IconProps) => svg(p, <path d="M5 12l5 5L20 7" />),
  Branch: (p: IconProps) =>
    svg(
      p,
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="7" r="2" />
        <path d="M6 7v10M18 9c0 5-6 4-12 8" />
      </>
    ),
  Send: (p: IconProps) => svg(p, <path d="M12 19V5M5 12l7-7 7 7" />),
  Stop: (p: IconProps) =>
    svg(p, <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />),
  Arrow: (p: IconProps) => svg(p, <path d="M5 12h14M13 6l6 6-6 6" />),
  Back: (p: IconProps) => svg(p, <path d="M15 6l-6 6 6 6" />),
  Folder: (p: IconProps) =>
    svg(p, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  Info: (p: IconProps) =>
    svg(
      p,
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </>
    ),
  Comment: (p: IconProps) =>
    svg(p, <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />),
  X: (p: IconProps) => svg(p, <path d="M6 6l12 12M18 6L6 18" />),
  Minus: (p: IconProps) => svg(p, <path d="M6 12h12" />),
  Chevron: (p: IconProps) => svg(p, <path d="M9 6l6 6-6 6" />)
}
