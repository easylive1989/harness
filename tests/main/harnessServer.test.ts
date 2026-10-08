import { describe, expect, test, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return { ...actual, createSdkMcpServer: vi.fn(actual.createSdkMcpServer) }
})

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { createHarnessServer, type ToolSink } from '../../src/main/tools/harnessTools'

const sink = {
  askUser: vi.fn(),
  proposeSpec: vi.fn(),
  updatePlan: vi.fn(),
  concludeBranch: vi.fn(),
  submitReport: vi.fn()
} satisfies ToolSink

describe('createHarnessServer', () => {
  test('harness 工具一律放進 prompt，不藏在 tool search 後面（否則 Claude 會猜參數格式）', () => {
    createHarnessServer(sink, ['ask_user', 'propose_spec'])
    const opts = vi.mocked(createSdkMcpServer).mock.calls.at(-1)![0]
    expect(opts.name).toBe('harness')
    expect(opts.alwaysLoad).toBe(true)
    expect(opts.tools?.map((t) => t.name)).toEqual(['ask_user', 'propose_spec'])
  })
})
