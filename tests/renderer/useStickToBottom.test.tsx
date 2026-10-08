// tests/renderer/useStickToBottom.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useStickToBottom } from '@renderer/lib/useStickToBottom'

function List({ version, resetKey, count }: { version: number; resetKey: string; count?: number }) {
  const { ref, onScroll, stick } = useStickToBottom<HTMLDivElement>(version, resetKey, count)
  return (
    <>
      <div data-testid="list" ref={ref} onScroll={onScroll} />
      <button type="button" onClick={stick}>
        送出
      </button>
    </>
  )
}

/** jsdom 沒有版面：手動給捲動區高度 */
function sized(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
  return el
}

test('內容變多時捲到底；使用者往上捲後不打擾，換對話或自己送出後再黏到底', () => {
  const { rerender } = render(<List version={0} resetKey="a" />)
  const list = sized(screen.getByTestId('list'))
  rerender(<List version={1} resetKey="a" />)
  expect(list.scrollTop).toBe(1000)

  list.scrollTop = 0
  fireEvent.scroll(list)
  rerender(<List version={2} resetKey="a" />)
  expect(list.scrollTop).toBe(0)

  rerender(<List version={2} resetKey="b" />)
  expect(list.scrollTop).toBe(1000)

  list.scrollTop = 0
  fireEvent.scroll(list)
  fireEvent.click(screen.getByRole('button', { name: '送出' }))
  rerender(<List version={3} resetKey="b" />)
  expect(list.scrollTop).toBe(1000)
})

test('從空變成有內容（重開 app 後第一次讀進時間軸）時一定捲到底，之後才依使用者的捲動', () => {
  const { rerender } = render(<List version={0} resetKey="a" count={0} />)
  const list = sized(screen.getByTestId('list'))
  // 還在讀取（空的）時收到捲動事件，「黏在底部」被關掉了
  list.scrollTop = 0
  fireEvent.scroll(list)
  rerender(<List version={1} resetKey="a" count={5} />)
  expect(list.scrollTop).toBe(1000)
  // 之後使用者往上捲去看舊訊息就不打擾
  list.scrollTop = 0
  fireEvent.scroll(list)
  rerender(<List version={2} resetKey="a" count={6} />)
  expect(list.scrollTop).toBe(0)
  // 換一段對話（例如換分岔）且新的對話也是先空再有內容：一樣捲到底
  rerender(<List version={3} resetKey="b" count={0} />)
  list.scrollTop = 0
  fireEvent.scroll(list)
  rerender(<List version={4} resetKey="b" count={2} />)
  expect(list.scrollTop).toBe(1000)
})
