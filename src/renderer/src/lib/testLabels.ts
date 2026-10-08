// src/renderer/src/lib/testLabels.ts
// 測試的類型與新增／修改的標籤：規格的預計測試與報告的測試共用
import type { TestNote } from '@shared/report'

export const TEST_KIND_LABEL: Record<TestNote['kind'], string> = {
  unit: '單元',
  integration: '整合',
  e2e: '端對端',
  other: '其他'
}

export const TEST_CHANGE_LABEL: Record<TestNote['change'], string> = {
  added: '新增',
  modified: '修改'
}
