// src/preload/index.ts
// sandbox 下的 preload：只能 import electron 與 @shared/*（會被打包成單一 CJS 檔）
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { APP_EVENT_CHANNEL, type AppEvent, type HarnessBridge } from '@shared/ipc'

const bridge: HarnessBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: AppEvent) => cb(ev)
    ipcRenderer.on(APP_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(APP_EVENT_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('harness', bridge)
