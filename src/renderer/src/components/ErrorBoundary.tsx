// src/renderer/src/components/ErrorBoundary.tsx
// 畫面繪製時拋錯：顯示錯誤與重試／重新載入，而不是整片空白。
// 任務資料都存在主程序與磁碟上，重新載入視窗不會遺失。
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, cx } from './ui'

interface Props {
  children: ReactNode
  className?: string
}

export class ErrorBoundary extends Component<Props, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Harness] 畫面發生錯誤', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        className={cx(
          'flex min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-2xl bg-surface p-8 shadow-card',
          this.props.className
        )}
      >
        <span className="text-[15px] font-bold">這個畫面發生錯誤</span>
        <span className="text-[13px] text-muted">
          任務的資料都存在磁碟上，不會因此遺失。可以再試一次，或重新載入視窗。
        </span>
        <pre className="max-h-48 max-w-[640px] overflow-auto rounded-xl bg-danger-soft px-3 py-2.5 font-mono text-xs break-words whitespace-pre-wrap text-ink-2">
          {error.message || String(error)}
        </pre>
        <div className="flex gap-2">
          <Button onClick={() => this.setState({ error: undefined })}>再試一次</Button>
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新載入視窗
          </Button>
        </div>
      </div>
    )
  }
}
