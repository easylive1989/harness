// src/renderer/src/api.ts
import type { AppEvent, IpcApi, IpcChannel } from '@shared/ipc'

export function call<C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>) {
  return window.harness.invoke(channel, ...args)
}

export function onEvent(cb: (e: AppEvent) => void) {
  return window.harness.onEvent(cb)
}

/** 主程序丟出的錯誤會被包成 `Error invoking remote method '<channel>': Error: <訊息>`，只留訊息 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
