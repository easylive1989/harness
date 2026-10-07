// tests/fixtures/hold.ts
import { act } from '@testing-library/react'

/**
 * 讓 mock 的下一次呼叫停在進行中（測試 IPC 進行中的按鈕狀態與連點），
 * 回傳讓它完成的函式（包在 act 裡，完成後的狀態更新會套用到畫面）。
 */
export function holdNextCall(mock: { mockImplementationOnce: (impl: never) => unknown }) {
  let release: (v?: unknown) => void = () => {}
  const impl = () =>
    new Promise((r) => {
      release = r
    })
  mock.mockImplementationOnce(impl as never)
  return (value?: unknown) => act(async () => release(value))
}
