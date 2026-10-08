// src/renderer/src/components/Attachments.tsx
// 附加圖片：輸入框的「選擇圖片」按鈕與縮圖列，以及時間軸上訊息附帶的圖片
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IMAGE_MEDIA_TYPES, type ImageRef } from '@shared/images'
import { call } from '../api'
import type { Attachment } from '../lib/useImageAttachments'
import { cx, Icons } from './ui'

/** 「選擇圖片」按鈕：開啟系統的檔案選擇視窗 */
export function AttachButton({
  onFiles,
  disabled,
  className
}: {
  onFiles: (files: File[]) => void
  disabled?: boolean
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        aria-label="附加圖片"
        title="附加圖片（也可以直接貼上或拖進來）"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={cx(
          'flex size-10 flex-none cursor-pointer items-center justify-center rounded-full text-muted hover:bg-fill-2 hover:text-ink disabled:cursor-default disabled:opacity-40',
          className
        )}
      >
        <Icons.Image />
      </button>
      {/* 放在表單外：只有一個文字輸入框的表單（分岔輸入框）才能照常用 Enter 送出 */}
      {createPortal(
        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_MEDIA_TYPES.join(',')}
          multiple
          hidden
          data-testid="attach-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            // 清掉選擇：再選同一個檔案也會觸發 change
            e.target.value = ''
            if (files.length) onFiles(files)
          }}
        />,
        document.body
      )}
    </>
  )
}

/** 還沒送出的附加圖片：縮圖與移除按鈕；錯誤訊息顯示在下面 */
export function AttachmentPreview({
  items,
  error,
  onRemove,
  className
}: {
  items: Attachment[]
  error?: string
  onRemove: (key: string) => void
  className?: string
}) {
  if (!items.length && !error) return null
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {items.length > 0 && (
        <ul aria-label="附加的圖片" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {items.map((x) => (
            <li key={x.key} className="relative">
              <img
                src={x.url}
                alt={x.image.name ?? '附加的圖片'}
                className="size-14 rounded-lg object-cover shadow-[0_0_0_1px_var(--color-line)]"
              />
              <button
                type="button"
                aria-label={`移除圖片${x.image.name ? `「${x.image.name}」` : ''}`}
                onClick={() => onRemove(x.key)}
                className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full bg-ink text-white"
              >
                <Icons.X width={10} height={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  )
}

/** 讀過的圖片（data URL）：時間軸重繪或切換畫面時不再向主程序要一次 */
const cache = new Map<string, string>()

function MessageImage({ taskId, image }: { taskId: string; image: ImageRef }) {
  const key = `${taskId}/${image.id}`
  const [url, setUrl] = useState(() => cache.get(key))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (cache.has(key)) return
    let live = true
    call('attachments:read', taskId, image).then(
      (u) => {
        cache.set(key, u)
        if (live) setUrl(u)
      },
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [key, taskId, image])
  const alt = image.name ?? '附加的圖片'
  if (failed)
    return (
      <span className="flex size-24 items-center justify-center rounded-lg bg-fill-2 text-xs text-muted">
        圖片無法顯示
      </span>
    )
  if (!url) return <span aria-label={alt} className="size-24 rounded-lg bg-fill-2" />
  return (
    <img
      src={url}
      alt={alt}
      title={alt}
      className="max-h-40 max-w-60 rounded-lg object-contain shadow-[0_0_0_1px_var(--color-line)]"
    />
  )
}

/** 使用者訊息附帶的圖片 */
export function MessageImages({
  taskId,
  images,
  className
}: {
  taskId: string
  images?: ImageRef[]
  className?: string
}) {
  if (!images?.length) return null
  return (
    <div className={cx('flex flex-wrap gap-2 whitespace-normal', className)}>
      {images.map((img) => (
        <MessageImage key={img.id} taskId={taskId} image={img} />
      ))}
    </div>
  )
}
