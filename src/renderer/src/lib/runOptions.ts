// src/renderer/src/lib/runOptions.ts
import {
  findModel,
  fitRunOptions,
  type ModelOption,
  type RunOptions,
  type Task
} from '@shared/types'

/** 目前的模型不在清單裡（設定了舊模型、或帳號清單改變）時也列出來，選單才不會顯示成別的模型 */
export function modelChoices(models: ModelOption[], current: string): ModelOption[] {
  return findModel(models, current)
    ? models
    : [...models, { id: current, label: current, hint: '' }]
}

/** 套用修改：換模型時把新模型不支援的 effort／權限模式改回預設 */
export function applyRunOptions(
  models: ModelOption[],
  value: RunOptions,
  patch: Partial<RunOptions>
): RunOptions {
  const next = { ...value, ...patch }
  return {
    ...next,
    ...fitRunOptions(findModel(models, next.model), next.effort, next.permissionMode)
  }
}

/** 任務目前的執行選項；舊任務沒有欄位時視為 effort Auto、手動核准 */
export const taskRunOptions = (task: Task): RunOptions => ({
  model: task.model,
  effort: task.effort ?? 'auto',
  permissionMode: task.permissionMode ?? 'manual'
})
