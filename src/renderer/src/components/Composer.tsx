// src/renderer/src/components/Composer.tsx
import { type FormEvent, type ReactNode, type Ref, useState } from 'react'
import type { ImageInput } from '@shared/images'
import type { Channel } from '@shared/types'
import { call } from '../api'
import { blockImeSubmit } from '../lib/ime'
import { useImageAttachments } from '../lib/useImageAttachments'
import { usePending } from '../lib/usePending'
import { useStore } from '../store'
import { AttachButton, AttachmentPreview } from './Attachments'
import { cx, Icons } from './ui'

/**
 * 停止 Claude 在這個 channel（主線或分岔）的這一輪（`run:stop`）。
 * 停止進行中停用，連點只送一次；放在輸入列旁（Composer 的 extra 或分岔的輸入框旁）。
 */
export function StopButton({
  taskId,
  channel,
  className
}: {
  taskId: string
  channel: Channel
  className?: string
}) {
  const act = useStore((s) => s.act)
  const [stopping, run] = usePending()
  return (
    <button
      type="button"
      disabled={stopping}
      onClick={() => void run(() => act(() => call('run:stop', taskId, channel)))}
      className={cx(
        'flex h-10 flex-none cursor-pointer items-center gap-1.5 rounded-full bg-surface px-4 text-[13px] text-danger disabled:cursor-default disabled:opacity-50',
        className
      )}
    >
      <Icons.Stop width={12} height={12} />
      停止
    </button>
  )
}

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
  /** images：附加的圖片（貼上、拖放或選擇檔案），沒有時是空陣列 */
  onSend: (text: string, images: ImageInput[]) => void
  extra?: ReactNode
  label?: string
  /** 畫面需要把焦點放回輸入框時用（例如核准對話框關掉後） */
  inputRef?: Ref<HTMLInputElement>
}) {
  const [text, setText] = useState('')
  const attach = useImageAttachments()
  const empty = !text.trim() && !attach.items.length
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (empty || disabled) return
    onSend(text.trim(), attach.images)
    setText('')
    attach.clear()
  }
  return (
    <form
      onSubmit={submit}
      {...attach.bind}
      className={cx(
        'flex flex-col gap-2 bg-fill py-2 pr-2 pl-[18px]',
        attach.items.length || attach.error ? 'rounded-[22px] pt-3' : 'rounded-full'
      )}
    >
      <AttachmentPreview items={attach.items} error={attach.error} onRemove={attach.remove} />
      <div className="flex items-center gap-2">
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
        <AttachButton onFiles={(f) => void attach.add(f)} disabled={disabled} />
        {extra}
        <button
          type="submit"
          aria-label="送出"
          disabled={disabled || empty}
          className="flex size-10 flex-none cursor-pointer items-center justify-center rounded-full bg-brand text-white hover:bg-brand-hover disabled:cursor-default disabled:opacity-40"
        >
          <Icons.Send />
        </button>
      </div>
    </form>
  )
}
