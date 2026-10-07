// src/renderer/src/report/CustomBlockFrame.tsx
import { useEffect, useRef, useState } from 'react'
import { BLOCK_DEFAULT_H, blockHeight } from './blocks'

/**
 * 以獨立的 harness-block:// scheme + sandbox iframe 呈現 Claude 產生的 HTML：
 * 只給 allow-scripts（不給 same-origin，拿不到 renderer 與 preload），主程序回應的 CSP 禁止連網。
 * 高度由區塊自己回報；只接受來自這個 iframe 的訊息。
 */
export function CustomBlockFrame({
  taskId,
  version,
  id,
  title
}: {
  taskId: string
  version: number
  id: string
  title: string
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(BLOCK_DEFAULT_H)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current
      if (!frame || e.source === null || e.source !== frame.contentWindow) return
      const h = blockHeight(e.data, id)
      if (h !== undefined) setHeight(h)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [id])
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={`harness-block://report/${taskId}/${version}/${id}`}
      className="block w-full rounded-2xl border-0 bg-fill-2"
      style={{ height }}
    />
  )
}
