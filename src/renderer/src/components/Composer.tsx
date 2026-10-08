// src/renderer/src/components/Composer.tsx
import { type FormEvent, type ReactNode, type Ref, useState } from 'react'
import { blockImeSubmit } from '../lib/ime'
import { Icons } from './ui'

/** 畫面底部的圓角輸入列（對照 `StyleB.dc.html` 底部的訊息框） */
export function Composer({
  placeholder,
  disabled,
  onSend,
  extra,
  label = '訊息',
  inputRef
}: {
  placeholder: string
  disabled?: boolean
  onSend: (text: string) => void
  extra?: ReactNode
  label?: string
  /** 畫面需要把焦點放回輸入框時用（例如核准對話框關掉後） */
  inputRef?: Ref<HTMLInputElement>
}) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || disabled) return
    onSend(text.trim())
    setText('')
  }
  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 rounded-full bg-fill py-2 pr-2 pl-[18px]"
    >
      <label className="flex flex-1">
        <span className="sr-only">{label}</span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={blockImeSubmit}
          placeholder={placeholder}
          disabled={disabled}
          className="h-8 flex-1 border-none bg-transparent text-ink outline-none placeholder:text-muted-2"
        />
      </label>
      {extra}
      <button
        type="submit"
        aria-label="送出"
        disabled={disabled || !text.trim()}
        className="flex size-10 flex-none cursor-pointer items-center justify-center rounded-full bg-brand text-white hover:bg-brand-hover disabled:cursor-default disabled:opacity-40"
      >
        <Icons.Send />
      </button>
    </form>
  )
}
