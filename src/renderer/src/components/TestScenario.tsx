// src/renderer/src/components/TestScenario.tsx
// 規格的預計測試與報告的測試共用：情境／預期行為兩行，以及沒有列出的單元測試數量
import { InlineCode } from './Markdown'

/** 測試的情境（given）與預期行為（then）；舊資料沒有預期行為時只顯示情境 */
export function TestScenario({ scenario, expected }: { scenario: string; expected?: string }) {
  return (
    <div className="flex flex-col gap-1 text-[13px]">
      <div>
        <span className="mr-2 font-medium text-brand">情境</span>
        <InlineCode text={scenario} />
      </div>
      {expected && (
        <div>
          <span className="mr-2 font-medium text-brand">預期行為</span>
          <InlineCode text={expected} />
        </div>
      )}
    </div>
  )
}

/** 列表沒有列出的單元測試數量 */
export function HiddenUnitTests({ count }: { count: number }) {
  if (!count) return null
  return <span className="text-xs text-muted">另有 {count} 個單元測試未列出。</span>
}
