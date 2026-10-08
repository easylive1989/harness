// src/renderer/src/lib/useImageAttachments.ts
// 輸入框的附加圖片：貼上、拖放與選擇檔案共用同一套檢查
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from 'react'
import { type ImageInput, isImageMediaType, MAX_IMAGE_BYTES, MAX_IMAGES } from '@shared/images'

export interface Attachment {
  key: string
  image: ImageInput
  /** 縮圖用的 data URL */
  url: string
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('讀取圖片失敗'))
    reader.readAsDataURL(file)
  })
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * 不支援的格式、超過大小或張數上限的檔案不加入，並顯示錯誤（其他的照常加入）。
 * 回傳的 bind 放在輸入框外層的 form（貼上與拖放事件都會冒泡到這裡）。
 */
export function useImageAttachments() {
  const [items, setItems] = useState<Attachment[]>([])
  const [error, setError] = useState<string>()
  // 連續加入（例如很快貼上兩次）時用最新的張數判斷上限
  const count = useRef(0)
  const seq = useRef(0)

  const add = useCallback(async (files: File[]) => {
    const errors: string[] = []
    const accepted: File[] = []
    for (const f of files) {
      const label = f.name ? `「${f.name}」` : '圖片'
      if (!isImageMediaType(f.type)) errors.push(`${label}不是 PNG、JPEG、GIF 或 WebP 圖片`)
      else if (f.size > MAX_IMAGE_BYTES) errors.push(`${label}超過 5 MB`)
      else if (count.current + accepted.length >= MAX_IMAGES)
        errors.push(`一則訊息最多附加 ${MAX_IMAGES} 張圖片`)
      else accepted.push(f)
    }
    count.current += accepted.length
    setError(errors.length ? [...new Set(errors)].join('；') : undefined)
    if (!accepted.length) return
    try {
      const added = await Promise.all(
        accepted.map(async (f): Promise<Attachment> => {
          const url = await readDataUrl(f)
          return {
            key: `img${++seq.current}`,
            url,
            image: {
              mediaType: f.type as ImageInput['mediaType'],
              data: url.slice(url.indexOf(',') + 1),
              ...(f.name ? { name: f.name } : {})
            }
          }
        })
      )
      setItems((prev) => [...prev, ...added])
    } catch {
      count.current -= accepted.length
      setError('讀取圖片失敗')
    }
  }, [])

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const next = prev.filter((x) => x.key !== key)
      count.current = next.length
      return next
    })
    setError(undefined)
  }, [])

  const clear = useCallback(() => {
    count.current = 0
    setItems([])
    setError(undefined)
  }, [])

  const bind = {
    onPaste: (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      // 只有文字的貼上照常進輸入框
      if (!files.length) return
      e.preventDefault()
      void add(files)
    },
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    },
    onDrop: (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      void add(files)
    }
  }

  return { items, images: items.map((x) => x.image), error, add, remove, clear, bind }
}
