// tests/shared/models.test.ts
import { describe, expect, test } from 'vitest'
import { findModel, type ModelOption, modelLabel } from '@shared/types'

// SDK 實際回傳的樣子：default 與 opus 兩個別名都對應到同一個完整 id
const MODELS: ModelOption[] = [
  { id: 'default', resolvedId: 'claude-opus-5-5', label: 'Default (recommended)', hint: '' },
  { id: 'opus', resolvedId: 'claude-opus-5-5', label: 'Opus 5.5', hint: '' },
  { id: 'sonnet', resolvedId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', hint: '' }
]

describe('findModel', () => {
  test('完整 id 對到多個別名時，用指名模型的別名而不是 default', () => {
    expect(findModel(MODELS, 'claude-opus-5-5')?.id).toBe('opus')
    expect(findModel(MODELS, 'claude-sonnet-5-5')?.id).toBe('sonnet')
  })

  test('id 完全相同時優先；只有 default 對得到時仍用它', () => {
    expect(findModel(MODELS, 'default')?.id).toBe('default')
    expect(findModel(MODELS, 'claude-opus-4-8')?.id).toBe('claude-opus-4-8')
    expect(findModel(MODELS.slice(0, 1), 'claude-opus-5-5')?.id).toBe('default')
    expect(findModel(MODELS, 'claude-haiku-5-5')).toBeUndefined()
  })
})

test('modelLabel：設定存完整 id 時顯示模型名稱', () => {
  expect(modelLabel(MODELS, 'claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel(MODELS, 'opus')).toBe('Opus 5.5')
  // 清單裡沒有：用內建清單的名稱，再沒有就顯示 id
  expect(modelLabel(MODELS, 'claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(modelLabel(MODELS, 'claude-x')).toBe('claude-x')
})
