// tests/renderer/attachments.test.tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('@renderer/api', () => ({
  call: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  errorText: String
}))
import { call } from '@renderer/api'
import { BranchPanel } from '@renderer/components/BranchPanel'
import { Composer } from '@renderer/components/Composer'
import { Timeline } from '@renderer/components/Timeline'
import { NewTaskScreen } from '@renderer/screens/NewTaskScreen'
import { resetStoreInternals, useStore } from '@renderer/store'
import type { TimelineEvent } from '@shared/types'
import { makeTask } from '../fixtures/task'

/** 內容 'png!' 的 base64 */
const PNG_DATA = 'cG5nIQ=='
const png = (name = 'shot.png') => new File(['png!'], name, { type: 'image/png' })
const previews = () => screen.queryAllByRole('img', { name: /shot|附加的圖片|^p\d+\.png$/ })

beforeEach(() => {
  vi.mocked(call).mockReset()
  vi.mocked(call).mockImplementation((async (ch: string) => {
    if (ch === 'repos:branches') return { branches: ['main'], current: 'main' }
    if (ch === 'tasks:create') return makeTask({ id: 'new1' })
    if (ch === 'attachments:read') return `data:image/png;base64,${PNG_DATA}`
    return undefined
  }) as typeof call)
  resetStoreInternals()
  useStore.setState({
    ready: true,
    repos: [{ id: 'r1', name: 'shop-api', path: '/Users/me/shop-api', addedAt: '' }],
    tasks: {},
    timelines: { t1: [] },
    activeBranch: { t1: 'b1' },
    branchDrafts: {},
    view: { kind: 'new' },
    toast: undefined,
    claude: { found: true, loggedIn: true }
  })
})

describe('Composer 附加圖片', () => {
  test('貼上截圖：顯示縮圖，可以只送圖片；送出後清空', async () => {
    const onSend = vi.fn()
    render(<Composer placeholder="說點什麼" onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: '訊息' })
    expect(screen.getByRole('button', { name: '送出' })).toBeDisabled()
    fireEvent.paste(input, { clipboardData: { files: [png()] } })
    await waitFor(() => expect(previews()).toHaveLength(1))
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(onSend).toHaveBeenCalledWith('', [
      { mediaType: 'image/png', data: PNG_DATA, name: 'shot.png' }
    ])
    expect(previews()).toHaveLength(0)
  })

  test('只有文字的貼上照常進輸入框，不當成附件', async () => {
    render(<Composer placeholder="說點什麼" onSend={() => {}} />)
    const input = screen.getByRole('textbox', { name: '訊息' })
    const notPrevented = fireEvent.paste(input, { clipboardData: { files: [] } })
    expect(notPrevented).toBe(true)
    expect(screen.queryByRole('list', { name: '附加的圖片' })).not.toBeInTheDocument()
  })

  test('拖放圖片加入；移除縮圖後不會送出', async () => {
    const onSend = vi.fn()
    render(<Composer placeholder="說點什麼" onSend={onSend} />)
    const form = screen.getByRole('textbox', { name: '訊息' }).closest('form')!
    fireEvent.drop(form, { dataTransfer: { files: [png()], types: ['Files'] } })
    await waitFor(() => expect(previews()).toHaveLength(1))
    await userEvent.click(screen.getByRole('button', { name: '移除圖片「shot.png」' }))
    expect(previews()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '送出' })).toBeDisabled()
  })

  test('選擇檔案：不支援的格式、超過 5 MB 與超過 10 張都顯示錯誤，不加入', async () => {
    render(<Composer placeholder="說點什麼" onSend={() => {}} />)
    const picker = screen.getByTestId('attach-input')
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    await userEvent.upload(picker, [svg, big], { applyAccept: false })
    expect(screen.getByRole('alert')).toHaveTextContent('「a.svg」不是 PNG、JPEG、GIF 或 WebP 圖片')
    expect(screen.getByRole('alert')).toHaveTextContent('「big.png」超過 5 MB')
    expect(screen.queryByRole('list', { name: '附加的圖片' })).not.toBeInTheDocument()

    const many = Array.from({ length: 11 }, (_, i) => png(`p${i}.png`))
    await userEvent.upload(picker, many)
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: '附加的圖片' })).getAllByRole('img')
      ).toHaveLength(10)
    )
    expect(screen.getByRole('alert')).toHaveTextContent('一則訊息最多附加 10 張圖片')
  })

  test('「附加圖片」按鈕打開檔案選擇；輸入框停用時一起停用', () => {
    const { rerender } = render(<Composer placeholder="說點什麼" onSend={() => {}} />)
    const picker = screen.getByTestId('attach-input') as HTMLInputElement
    const click = vi.spyOn(picker, 'click')
    fireEvent.click(screen.getByRole('button', { name: '附加圖片' }))
    expect(click).toHaveBeenCalled()
    expect(picker.accept).toBe('image/png,image/jpeg,image/gif,image/webp')
    rerender(<Composer placeholder="說點什麼" disabled onSend={() => {}} />)
    expect(screen.getByRole('button', { name: '附加圖片' })).toBeDisabled()
  })
})

test('新任務：需求附加的圖片隨 tasks:create 送出', async () => {
  render(<NewTaskScreen />)
  await waitFor(() => expect(screen.getByLabelText('從哪個分支開始')).toHaveValue('main'))
  await userEvent.type(screen.getByLabelText('需求'), '照截圖修版面')
  await userEvent.upload(screen.getByTestId('attach-input'), png())
  await waitFor(() => expect(previews()).toHaveLength(1))
  await userEvent.click(screen.getByRole('button', { name: /開始釐清/ }))
  expect(call).toHaveBeenCalledWith(
    'tasks:create',
    expect.objectContaining({
      request: '照截圖修版面',
      images: [{ mediaType: 'image/png', data: PNG_DATA, name: 'shot.png' }]
    })
  )
})

test('分岔討論：貼上圖片後連同文字送到分岔', async () => {
  const task = makeTask({
    branches: [{ id: 'b1', title: '版面', status: 'open', running: false, createdAt: '' }]
  })
  render(<BranchPanel task={task} events={[]} />)
  const input = screen.getByRole('textbox', { name: '分岔訊息' })
  fireEvent.paste(input, { clipboardData: { files: [png()] } })
  await waitFor(() => expect(previews()).toHaveLength(1))
  await userEvent.type(input, '這裡跑版{Enter}')
  expect(call).toHaveBeenCalledWith('tasks:send', 't1', 'branch:b1', '這裡跑版', [
    { mediaType: 'image/png', data: PNG_DATA, name: 'shot.png' }
  ])
})

test('時間軸：使用者訊息附帶的圖片向主程序讀取後顯示', async () => {
  const image = { id: 'img1', mediaType: 'image/png' as const, name: 'shot.png' }
  const events: TimelineEvent[] = [
    { id: 'e1', ts: '', channel: 'main', kind: 'user_text', text: '看這張', images: [image] }
  ]
  render(<Timeline task={makeTask()} channel="main" events={events} />)
  const img = await screen.findByRole('img', { name: 'shot.png' })
  expect(img).toHaveAttribute('src', `data:image/png;base64,${PNG_DATA}`)
  expect(call).toHaveBeenCalledWith('attachments:read', 't1', image)
  expect(screen.getByText('看這張')).toBeInTheDocument()
})
