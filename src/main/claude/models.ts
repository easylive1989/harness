// src/main/claude/models.ts
// 登入帳號可用的模型：向 Claude Code 查詢（SDK 的 supportedModels），取不到時用內建清單
import type { ModelInfo, Options } from '@anthropic-ai/claude-agent-sdk'
import { EFFORT_LEVELS, FALLBACK_MODELS, type ModelOption } from '@shared/types'

export type ModelQueryFn = (params: {
  prompt: AsyncIterable<never>
  options: Options
}) => AsyncIterable<unknown> & { supportedModels(): Promise<ModelInfo[]> }

export function toModelOptions(infos: ModelInfo[]): ModelOption[] {
  return infos
    .filter((m) => typeof m.value === 'string' && m.value)
    .map((m) => ({
      id: m.value,
      ...(m.resolvedModel && m.resolvedModel !== m.value ? { resolvedId: m.resolvedModel } : {}),
      label: m.displayName || m.value,
      hint: m.description ?? '',
      // supportsEffort 明確為 false 時不能選 effort；沒有等級清單就不知道（不過濾）
      ...(m.supportsEffort === false
        ? { efforts: [] }
        : m.supportedEffortLevels
          ? { efforts: EFFORT_LEVELS.filter((l) => m.supportedEffortLevels!.includes(l)) }
          : {}),
      ...(m.supportsAutoMode !== undefined ? { autoMode: m.supportsAutoMode } : {})
    }))
}

/** 不送任何訊息的輸入：只等 abort，讓查詢期間 session 保持開著 */
function idleInput(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<never>>((resolve) => {
          if (signal.aborted) resolve({ done: true, value: undefined })
          else
            signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), {
              once: true
            })
        })
    })
  }
}

/** 啟動一個不送訊息的 Claude Code session，只查詢可用模型，查完就結束 */
export async function fetchModels(
  queryFn: ModelQueryFn,
  options: Pick<Options, 'pathToClaudeCodeExecutable' | 'env' | 'cwd'>,
  timeoutMs = 20_000
): Promise<ModelOption[]> {
  const ac = new AbortController()
  const q = queryFn({
    prompt: idleInput(ac.signal),
    options: {
      ...options,
      abortController: ac,
      tools: [],
      settingSources: [],
      persistSession: false
    }
  })
  // 讀掉輸出，結束（含 abort 造成的錯誤）不影響查詢結果
  void (async () => {
    try {
      for await (const _ of q) void _
    } catch {
      /* 查詢結束時 abort */
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const infos = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('查詢可用模型逾時')), timeoutMs)
      })
    ])
    return toModelOptions(infos)
  } finally {
    clearTimeout(timer)
    ac.abort()
  }
}

/**
 * 快取查到的模型清單。查詢失敗或清單是空的時回傳上次的結果（沒有就是內建清單），且不快取，
 * 下次呼叫會再查一次；同時有多個呼叫時共用同一次查詢。
 */
export function createModelCache(fetch: () => Promise<ModelOption[]>) {
  let cached: ModelOption[] | undefined
  let pending: Promise<ModelOption[]> | undefined
  return (refresh = false): Promise<ModelOption[]> => {
    if (cached && !refresh) return Promise.resolve(cached)
    pending ??= fetch()
      .then((list) => (list.length ? (cached = list) : (cached ?? FALLBACK_MODELS)))
      .catch((e: unknown) => {
        console.warn('[Harness] 無法取得可用模型，使用內建清單', e)
        return cached ?? FALLBACK_MODELS
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}
