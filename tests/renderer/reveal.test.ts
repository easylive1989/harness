// tests/renderer/reveal.test.ts
import { afterEach, expect, test, vi } from 'vitest'
import { FLASH_MS, flash, reveal } from '@renderer/lib/reveal'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('reveal：捲過去並把焦點移過去（不多一個 Tab 停留點）', () => {
  const el = document.createElement('div')
  document.body.append(el)
  el.scrollIntoView = vi.fn()
  reveal(el)
  expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
  expect(el.tabIndex).toBe(-1)
  expect(el).toHaveFocus()
  el.remove()
})

test('reveal：使用者要求減少動態時直接跳過去，不平滑捲動', () => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === '(prefers-reduced-motion: reduce)'
  }))
  const el = document.createElement('div')
  el.scrollIntoView = vi.fn()
  reveal(el, 'start')
  expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
})

test('flash：短暫標示 2 秒；再標示一次會重新計時', () => {
  vi.useFakeTimers()
  const el = document.createElement('div')
  flash(el)
  expect(el).toHaveAttribute('data-flash')
  vi.advanceTimersByTime(FLASH_MS - 500)
  flash(el)
  vi.advanceTimersByTime(600)
  expect(el).toHaveAttribute('data-flash')
  vi.advanceTimersByTime(FLASH_MS)
  expect(el).not.toHaveAttribute('data-flash')
  expect(FLASH_MS).toBe(2000)
})
