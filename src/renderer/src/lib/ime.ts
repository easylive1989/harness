// src/renderer/src/lib/ime.ts
// 使用者用注音、倉頡等輸入法打中文：選字時的按鍵屬於「組字」——Enter 是確認候選字、
// Esc 是取消組字，不能拿來送出表單、儲存或關閉輸入框。
import type { KeyboardEvent } from 'react'

type KeyLike = Pick<KeyboardEvent, 'key'> & {
  nativeEvent: Pick<globalThis.KeyboardEvent, 'isComposing' | 'keyCode'>
}

/**
 * 這個按鍵是否屬於輸入法組字。組字中的 keydown 帶 isComposing；
 * 有些情況（例如 compositionend 比 keydown 先到）isComposing 已是 false，但 keyCode 仍是 229。
 */
export const isComposing = (e: KeyLike) =>
  e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229

/** 輸入法確認候選字的 Enter */
export const isImeEnter = (e: KeyLike) => e.key === 'Enter' && isComposing(e)

/**
 * 給「按 Enter 隱式送出」的表單輸入框用的 onKeyDown：
 * 選字中的 Enter 取消預設動作，表單不會被送出。
 */
export function blockImeSubmit(e: KeyLike & Pick<KeyboardEvent, 'preventDefault'>) {
  if (isImeEnter(e)) e.preventDefault()
}
