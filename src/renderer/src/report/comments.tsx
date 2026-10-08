// src/renderer/src/report/comments.tsx
// 報告上的留言：留言按鈕、輸入框，以及已經留下（還沒送出）的回饋
import { type FormEvent, useState } from 'react'
import { cx, Icons } from '../components/ui'

export function CommentButton({
  label,
  text = '留言',
  onClick,
  className
}: {
  /** 螢幕閱讀器唸的名稱（例如「對「概觀」留言」）；不給就用按鈕上的文字 */
  label?: string
  text?: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        'flex h-7 flex-none cursor-pointer items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-fill hover:text-ink',
        className
      )}
    >
      <Icons.Comment width={13} height={13} />
      {text}
    </button>
  )
}

/**
 * 輸入一則回饋：Enter 加入、Esc 取消；dark 用在程式碼區塊裡。
 * 加入或取消後，焦點回到打開它的按鈕（輸入框出現前的焦點）。
 */
export function CommentForm({
  initial = '',
  placeholder,
  dark,
  onSubmit,
  onCancel,
  className
}: {
  initial?: string
  placeholder: string
  dark?: boolean
  onSubmit: (text: string) => void
  onCancel: () => void
  className?: string
}) {
  const [text, setText] = useState(initial)
  // 第一次 render 時輸入框還沒取得焦點：這時的焦點就是按下的「留言」或行號按鈕
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const close = (fn: () => void) => {
    fn()
    if (opener?.isConnected) opener.focus()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    if (value) close(() => onSubmit(value))
  }
  return (
    <form onSubmit={submit} className={cx('flex items-center gap-2 font-sans', className)}>
      <input
        // 按了「留言」就是要打字
        autoFocus
        aria-label="回饋"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close(onCancel)
        }}
        placeholder={placeholder}
        className={cx(
          'h-9 min-w-0 flex-1 rounded-lg px-3 text-[13px] text-ink outline-none placeholder:text-muted-2',
          dark ? 'bg-surface' : 'border border-line bg-surface focus:border-brand'
        )}
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="h-9 flex-none cursor-pointer rounded-lg bg-brand px-3 text-xs font-medium text-white hover:bg-brand-hover disabled:cursor-default disabled:opacity-50"
      >
        加入
      </button>
      <button
        type="button"
        onClick={() => close(onCancel)}
        className={cx(
          'h-9 flex-none cursor-pointer px-1.5 text-xs',
          dark ? 'text-code-muted hover:text-white' : 'text-muted hover:text-ink'
        )}
      >
        取消
      </button>
    </form>
  )
}

/** 已經留下、等著跟其他回饋一起送出的意見（對照 B5 程式碼下方的黃色便條） */
export function FeedbackNote({
  title,
  text,
  className
}: {
  title: string
  text: string
  className?: string
}) {
  return (
    <div
      className={cx(
        'flex gap-2.5 rounded-xl bg-note px-3.5 py-3 font-sans text-[13px] leading-relaxed text-ink',
        className
      )}
    >
      <span
        aria-hidden
        className="flex size-6 flex-none items-center justify-center rounded-full bg-ink text-[11px] text-white"
      >
        你
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-note-ink">{title}</span>
        <span className="break-words whitespace-pre-wrap">{text}</span>
      </span>
    </div>
  )
}
