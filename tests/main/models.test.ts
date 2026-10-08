// tests/main/models.test.ts
import { describe, expect, test, vi } from 'vitest'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { FALLBACK_MODELS } from '@shared/types'
import {
  createModelCache,
  fetchModels,
  type ModelQueryFn,
  toModelOptions
} from '../../src/main/claude/models'

const INFOS: ModelInfo[] = [
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: '品質最好',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAutoMode: true
  },
  {
    value: 'claude-haiku-5-5',
    displayName: 'Haiku 5.5',
    description: '最快',
    supportsEffort: false,
    supportsAutoMode: false
  }
] as ModelInfo[]

/** 假的 query：不輸出任何訊息，supportedModels 回傳指定結果；記下收到的 options */
function fakeQuery(models: () => Promise<ModelInfo[]>) {
  const seen: Parameters<ModelQueryFn>[0][] = []
  const fn: ModelQueryFn = (params) => {
    seen.push(params)
    return Object.assign(
      (async function* () {
        // 查詢模型時不輸出任何訊息
      })(),
      { supportedModels: models }
    )
  }
  return { fn, seen }
}

describe('toModelOptions', () => {
  test('轉成選單用的清單：別名對應的完整 id、支援的 effort 與 auto 模式', () => {
    expect(toModelOptions(INFOS)).toEqual([
      {
        id: 'opus',
        resolvedId: 'claude-opus-5-5',
        label: 'Opus 5.5',
        hint: '品質最好',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        autoMode: true
      },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: '最快', efforts: [], autoMode: false }
    ])
  })

  test('沒有 effort 資訊時不過濾；略過沒有 id 的項目', () => {
    expect(
      toModelOptions([
        { value: 'x', displayName: '', description: '' },
        { value: '' }
      ] as ModelInfo[])
    ).toEqual([{ id: 'x', label: 'x', hint: '' }])
  })
})

describe('fetchModels', () => {
  test('不送訊息、不開工具與設定，查完就 abort', async () => {
    const { fn, seen } = fakeQuery(async () => INFOS)
    const list = await fetchModels(fn, { pathToClaudeCodeExecutable: '/bin/claude' })
    expect(list.map((m) => m.id)).toEqual(['opus', 'claude-haiku-5-5'])
    expect(seen[0].options).toMatchObject({
      pathToClaudeCodeExecutable: '/bin/claude',
      tools: [],
      settingSources: [],
      persistSession: false
    })
    expect(seen[0].options.abortController!.signal.aborted).toBe(true)
  })

  test('逾時時拋錯', async () => {
    const { fn } = fakeQuery(() => new Promise(() => {}))
    await expect(fetchModels(fn, {}, 10)).rejects.toThrow('逾時')
  })
})

describe('createModelCache', () => {
  test('成功時快取，refresh 才重新查詢', async () => {
    const fetch = vi.fn(async () => toModelOptions(INFOS))
    const get = createModelCache(fetch)
    const first = await get()
    expect(first.map((m) => m.id)).toEqual(['opus', 'claude-haiku-5-5'])
    expect(await get()).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    await get(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('同時的呼叫共用同一次查詢', async () => {
    const fetch = vi.fn(async () => toModelOptions(INFOS))
    const get = createModelCache(fetch)
    await Promise.all([get(), get()])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('查詢失敗或清單是空的時回傳內建清單，且下次再查', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi
      .fn<() => Promise<ReturnType<typeof toModelOptions>>>()
      .mockRejectedValueOnce(new Error('not logged in'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(toModelOptions(INFOS))
    const get = createModelCache(fetch)
    expect(await get()).toBe(FALLBACK_MODELS)
    expect(await get()).toBe(FALLBACK_MODELS)
    expect((await get()).map((m) => m.id)).toEqual(['opus', 'claude-haiku-5-5'])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('有快取後查詢失敗時保留上次的清單', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi
      .fn<() => Promise<ReturnType<typeof toModelOptions>>>()
      .mockResolvedValueOnce(toModelOptions(INFOS))
      .mockRejectedValueOnce(new Error('timeout'))
    const get = createModelCache(fetch)
    const first = await get()
    expect(await get(true)).toBe(first)
  })
})
