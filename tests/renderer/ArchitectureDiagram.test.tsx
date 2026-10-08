// tests/renderer/ArchitectureDiagram.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { ArchitectureDiagram } from '@renderer/report/ArchitectureDiagram'
import { sampleReport } from '../fixtures/report'

test('畫出節點與連線，點節點回呼檔案', async () => {
  const onSelect = vi.fn()
  const { container } = render(
    <ArchitectureDiagram graph={sampleReport.architecture.after} onSelectFile={onSelect} />
  )
  expect(screen.getByRole('button', { name: /lockoutGuard/ })).toBeInTheDocument()
  expect(container.querySelectorAll('line')).toHaveLength(2)
  await userEvent.click(screen.getByRole('button', { name: /lockoutGuard/ }))
  expect(onSelect).toHaveBeenCalledWith('src/auth/lockout.ts')
})

test('只有對應到變更檔案的節點可以點；節點標出狀態', async () => {
  const onSelect = vi.fn()
  render(
    <ArchitectureDiagram
      graph={sampleReport.architecture.after}
      onSelectFile={onSelect}
      changedFiles={new Set(['src/auth/lockout.ts'])}
    />
  )
  expect(screen.getByRole('button', { name: 'lockoutGuard（新增）' })).toBeInTheDocument()
  // Client 沒有檔案、login.ts 的檔案不在 diff 裡：不是按鈕
  expect(screen.queryByRole('button', { name: /Client/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /login\.ts/ })).not.toBeInTheDocument()
  expect(screen.getByText('login.ts')).toBeInTheDocument()
  expect(screen.getByText('（修改）')).toBeInTheDocument()
})

test('沒有 onSelectFile（匯出）時節點都不是按鈕；同一頁兩張圖的箭頭 id 不重複', () => {
  const { container } = render(
    <>
      <ArchitectureDiagram graph={sampleReport.architecture.before} />
      <ArchitectureDiagram graph={sampleReport.architecture.after} />
    </>
  )
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  const ids = [...container.querySelectorAll('marker')].map((m) => m.id)
  expect(new Set(ids).size).toBe(2)
  for (const line of container.querySelectorAll('line')) {
    expect(ids.map((id) => `url(#${id})`)).toContain(line.getAttribute('marker-end'))
  }
})

test('略過指向自己的連線', () => {
  const { container } = render(
    <ArchitectureDiagram
      graph={{
        nodes: [
          { id: 'a', label: 'A', status: 'unchanged', files: [] },
          { id: 'b', label: 'B', status: 'added', files: [] }
        ],
        edges: [
          { from: 'a', to: 'a' },
          { from: 'a', to: 'b', label: '呼叫' }
        ]
      }}
    />
  )
  expect(container.querySelectorAll('line')).toHaveLength(1)
  expect(screen.getByText('呼叫')).toBeInTheDocument()
  expect(screen.getByText('A → B（呼叫）')).toBeInTheDocument()
})

test('連線另外列給螢幕閱讀器；圖有名稱', () => {
  render(<ArchitectureDiagram graph={sampleReport.architecture.after} label="之後的架構" />)
  expect(screen.getByRole('group', { name: '之後的架構' })).toBeInTheDocument()
  expect(screen.getByText('Client → lockoutGuard').closest('.sr-only')).not.toBeNull()
  expect(screen.getByText('lockoutGuard → login.ts')).toBeInTheDocument()
})
