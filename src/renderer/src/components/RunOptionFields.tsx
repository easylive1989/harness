// src/renderer/src/components/RunOptionFields.tsx
// 模型、effort、權限模式的選單：新任務畫面與任務標題列的「執行選項」共用
import {
  EFFORTS,
  effortsFor,
  findModel,
  PERMISSION_MODES,
  type RunOptions,
  supportsAutoMode
} from '@shared/types'
import { applyRunOptions, modelChoices, selectedModelId } from '../lib/runOptions'
import { useStore } from '../store'
import { cx, inputClass } from './ui'

export function RunOptionFields({
  value,
  onChange,
  disabled,
  className
}: {
  value: RunOptions
  onChange: (next: RunOptions) => void
  disabled?: boolean
  className?: string
}) {
  const models = useStore((s) => s.models)
  const model = findModel(models, value.model)
  const efforts = effortsFor(model)
  const autoOk = supportsAutoMode(model)
  const set = (patch: Partial<RunOptions>) => onChange(applyRunOptions(models, value, patch))
  const field = 'flex min-w-[180px] flex-1 flex-col gap-2'
  return (
    <div className={cx('flex flex-wrap gap-4', className)}>
      <label className={field}>
        <span className="text-[13px] font-medium">模型</span>
        <select
          value={selectedModelId(models, value.model)}
          disabled={disabled}
          onChange={(e) => set({ model: e.target.value })}
          className={cx(inputClass, 'px-3 text-sm')}
        >
          {modelChoices(models, value.model).map((m) => (
            <option key={m.id} value={m.id}>
              {m.hint ? `${m.label}（${m.hint}）` : m.label}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        <span className="text-[13px] font-medium">Effort</span>
        <select
          value={value.effort}
          disabled={disabled}
          onChange={(e) => set({ effort: e.target.value as RunOptions['effort'] })}
          className={cx(inputClass, 'px-3 text-sm')}
        >
          {EFFORTS.filter((e) => efforts.includes(e.id)).map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        <span className="text-[13px] font-medium">權限模式</span>
        <select
          value={value.permissionMode}
          disabled={disabled}
          onChange={(e) => set({ permissionMode: e.target.value as RunOptions['permissionMode'] })}
          className={cx(inputClass, 'px-3 text-sm')}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id} disabled={m.id === 'auto' && !autoOk}>
              {m.id === 'auto' && !autoOk ? `${m.label}（這個模型不支援）` : m.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
