// src/renderer/src/report/ArchitectureDiagram.tsx
import { useId } from 'react'
import { BOX_H, BOX_W, layoutGraph } from '@shared/layout'
import type { ReportInput } from '@shared/report'
import { cx } from '../components/ui'

type Graph = ReportInput['architecture']['after']
type GraphNode = Graph['nodes'][number]

const STATUS_CLASS = {
  added: 'bg-brand font-medium text-white',
  modified: 'bg-surface shadow-[inset_0_0_0_2px_var(--color-review)]',
  unchanged: 'bg-surface'
} as const
const STATUS_LABEL = { added: '新增', modified: '修改', unchanged: '未變' } as const
/**
 * 縮小的下限：前後兩欄並排時，每欄至少要放得下這個比例的圖，否則上下排列（ReportView）；
 * 上下排列後欄位仍然太窄才水平捲動
 */
export const MIN_SCALE = 0.6
/** 箭頭與方塊之間留的空隙 */
const GAP = 3

/** 從方塊中心沿 (dx, dy) 走到方塊邊緣，佔整段中心距離的比例 */
function edgeT(dx: number, dy: number) {
  const tx = dx ? BOX_W / 2 / Math.abs(dx) : Infinity
  const ty = dy ? BOX_H / 2 / Math.abs(dy) : Infinity
  return Math.min(tx, ty)
}

/**
 * 架構圖：自動分層排版，整張是一個有 viewBox 的 SVG，用 CSS 寬度縮放（匯出 HTML 沒有 script 也一樣）。
 * 寬度是 min(原寬, 原寬 / fitWidth × 100%)：前後兩張給同一個 fitWidth，縮放比例就相同。
 * 方塊放在 foreignObject 裡（HTML 才能截斷文字）；有 onSelectFile 時，對應到變更檔案的方塊可以點。
 */
export function ArchitectureDiagram({
  graph,
  label,
  fitWidth,
  onSelectFile,
  changedFiles
}: {
  graph: Graph
  /** 給螢幕閱讀器的名稱，例如「之後的架構」 */
  label?: string
  /** 和另一張圖一起縮放時，兩張圖裡比較寬的寬度 */
  fitWidth?: number
  onSelectFile?: (path: string) => void
  /** 這次變更的檔案；有給的話，只有檔案在裡面的方塊可以點 */
  changedFiles?: ReadonlySet<string>
}) {
  const markerId = useId()
  const { nodes, width, height } = layoutGraph(graph.nodes, graph.edges)
  const fit = Math.max(width, fitWidth ?? width)
  const pos = new Map(nodes.map((n) => [n.node.id, n]))
  const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]))
  const edges = graph.edges.filter((e) => e.from !== e.to && pos.has(e.from) && pos.has(e.to))
  const targetOf = (node: GraphNode) =>
    changedFiles ? node.files.find((f) => changedFiles.has(f)) : node.files[0]

  return (
    <div className="overflow-x-auto">
      <svg
        role="group"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="mx-auto block h-auto max-w-full"
        style={{
          width: `min(${width}px, ${+((width / fit) * 100).toFixed(3)}%)`,
          minWidth: width * MIN_SCALE
        }}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" className="fill-connector" />
          </marker>
        </defs>
        <g aria-hidden>
          {edges.map((e, i) => {
            const a = pos.get(e.from)!
            const b = pos.get(e.to)!
            // 從起點方塊的邊緣畫到終點方塊的邊緣（沿兩個中心的連線）
            const ax = a.x + BOX_W / 2
            const ay = a.y + BOX_H / 2
            const dx = b.x + BOX_W / 2 - ax
            const dy = b.y + BOX_H / 2 - ay
            const len = Math.hypot(dx, dy)
            const t0 = edgeT(dx, dy) + GAP / len
            const t1 = 1 - edgeT(dx, dy) - GAP / len
            if (t1 <= t0) return null
            const x1 = ax + dx * t0
            const y1 = ay + dy * t0
            const x2 = ax + dx * t1
            const y2 = ay + dy * t1
            return (
              <g key={i}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  className="stroke-connector"
                  strokeWidth={1.5}
                  markerEnd={`url(#${markerId})`}
                />
                {e.label && (
                  <text
                    x={(x1 + x2) / 2 + 6}
                    y={(y1 + y2) / 2 + 4}
                    className="fill-muted text-[11px]"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
        {nodes.map(({ node, x, y }) => {
          const target = onSelectFile && targetOf(node)
          const className = cx(
            'flex size-full items-center justify-center rounded-xl px-2.5 text-[13px]',
            STATUS_CLASS[node.status]
          )
          const title = node.files.join('\n') || undefined
          const text = <span className="min-w-0 truncate">{node.label}</span>
          return (
            <foreignObject key={node.id} x={x} y={y} width={BOX_W} height={BOX_H}>
              {target ? (
                <button
                  type="button"
                  title={title}
                  aria-label={`${node.label}（${STATUS_LABEL[node.status]}）`}
                  onClick={() => onSelectFile?.(target)}
                  className={cx(
                    className,
                    'cursor-pointer hover:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand'
                  )}
                >
                  {text}
                </button>
              ) : (
                <div title={title} className={className}>
                  {text}
                  <span className="sr-only">（{STATUS_LABEL[node.status]}）</span>
                </div>
              )}
            </foreignObject>
          )
        })}
      </svg>
      {/* 連線只畫在圖上；螢幕閱讀器改唸這份清單 */}
      {edges.length > 0 && (
        <ul className="sr-only">
          {edges.map((e, i) => (
            <li key={i}>
              {labelOf.get(e.from)} → {labelOf.get(e.to)}
              {e.label && `（${e.label}）`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
