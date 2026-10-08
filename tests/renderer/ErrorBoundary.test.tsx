// tests/renderer/ErrorBoundary.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'

let broken = true
function Flaky() {
  if (broken) throw new Error('Cannot read properties of undefined')
  return <span>正常的畫面</span>
}

beforeEach(() => {
  broken = true
  // React 與 componentDidCatch 都會把錯誤印到 console
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

test('子元件拋錯時顯示錯誤訊息，不是空白', () => {
  render(
    <ErrorBoundary>
      <Flaky />
    </ErrorBoundary>
  )
  const alert = screen.getByRole('alert')
  expect(alert).toHaveTextContent('這個畫面發生錯誤')
  expect(alert).toHaveTextContent('Cannot read properties of undefined')
  expect(screen.getByRole('button', { name: '重新載入視窗' })).toBeInTheDocument()
})

test('再試一次：問題排除後回到原本的畫面', async () => {
  render(
    <ErrorBoundary>
      <Flaky />
    </ErrorBoundary>
  )
  broken = false
  await userEvent.click(screen.getByRole('button', { name: '再試一次' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('正常的畫面')).toBeInTheDocument()
})

test('沒有錯誤時直接顯示子元件', () => {
  broken = false
  render(
    <ErrorBoundary>
      <Flaky />
    </ErrorBoundary>
  )
  expect(screen.getByText('正常的畫面')).toBeInTheDocument()
})
