// tests/renderer/CustomBlockFrame.test.tsx
import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { CustomBlockFrame } from '@renderer/report/CustomBlockFrame'

const post = (data: unknown, source: Window | null) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })

test('以獨立 scheme 載入、只允許 script（不給 same-origin）', () => {
  render(<CustomBlockFrame taskId="t1" version={2} id="state-machine" title="鎖定狀態機" />)
  const frame = screen.getByTitle('鎖定狀態機')
  expect(frame.tagName).toBe('IFRAME')
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  expect(frame).toHaveAttribute('src', 'harness-block://report/t1/2/state-machine')
})

test('只接受自己 iframe 回報的高度，並限制在合理範圍', async () => {
  render(
    <>
      <CustomBlockFrame taskId="t1" version={1} id="a" title="A" />
      <CustomBlockFrame taskId="t1" version={1} id="b" title="B" />
    </>
  )
  const a = screen.getByTitle('A') as HTMLIFrameElement
  const b = screen.getByTitle('B') as HTMLIFrameElement
  const initial = a.style.height
  await post({ type: 'harness-block-height', id: 'a', height: 480 }, a.contentWindow)
  expect(a.style.height).toBe('480px')
  expect(b.style.height).toBe(initial)
  // 別的 iframe 冒用 id、來源不是 iframe、格式不對：都忽略
  await post({ type: 'harness-block-height', id: 'a', height: 300 }, b.contentWindow)
  await post({ type: 'harness-block-height', id: 'a', height: 300 }, window)
  await post({ type: 'harness-block-height', id: 'b', height: 300 }, a.contentWindow)
  await post({ type: 'harness-block-height', id: 'a', height: Number.NaN }, a.contentWindow)
  await post(null, a.contentWindow)
  expect(a.style.height).toBe('480px')
  await post({ type: 'harness-block-height', id: 'a', height: 99999 }, a.contentWindow)
  expect(a.style.height).toBe('1600px')
  await post({ type: 'harness-block-height', id: 'a', height: 1 }, a.contentWindow)
  expect(a.style.height).toBe('80px')
})
