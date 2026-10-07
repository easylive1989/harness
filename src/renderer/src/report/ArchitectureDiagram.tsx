// src/renderer/src/report/ArchitectureDiagram.tsx
import { useEffect, useId, useRef, useState } from 'react'
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
/** 圖比欄寬寬時縮小到塞得下，但不小於這個比例（再寬就水平捲動） */
const MIN_SCALE = 0.6
/** 箭頭與方塊之間留的空隙 */
const GAP = 3

/** 從方塊中心沿 (dx, dy) 走到方塊邊緣，佔整段中心距離的比例 */
function edgeT(dx: number, dy: number) {
  const tx = dx ? BOX_W / 2 / Math.abs(dx) : Infinity
  const ty = dy ? BOX_H / 2 / Math.abs(dy) : Infinity
  return Math.min(tx, ty)
}

/** 量容器寬度，算出讓整張圖塞進去的縮放比例（沒有 ResizeObserver 時不縮放） */
function useFitScale(width: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState<number>()
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setAvail(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = avail && width > avail ? Math.max(MIN_SCALE, avail / width) : 1
  return { ref, scale }
}

/**
 * 架構圖：自動分層排版，方塊是 HTML（可以點、可以截斷文字），連線畫在下面的 SVG。
 * 有 onSelectFile 時，對應到變更檔案的方塊可以點（跳到那個檔案的 diff）。
 */
export function ArchitectureDiagram({
  graph,
  onSelectFile,
  changedFiles
}: {
  graph: Graph
  onSelectFile?: (path: string) => void
  /** 這次變更的檔案；有給的話，只有檔案在裡面的方塊可以點 */
  changedFiles?: ReadonlySet<string>
}) {
  const markerId = useId()
  const { nodes, width, height } = layoutGraph(graph.nodes, graph.edges)
  const { ref, scale } = useFitScale(width)
  const pos = new Map(nodes.map((n) => [n.node.id, n]))
  const targetOf = (node: GraphNode) =>
    changedFiles ? node.files.find((f) => changedFiles.has(f)) : node.files[0]

  return (
    <div ref={ref} className="overflow-x-auto">
      <div className="mx-auto" style={{ width: width * scale, height: height * scale }}>
        <div
          className="relative origin-top-left"
          style={{ width, height, transform: scale < 1 ? `scale(${scale})` : undefined }}
        >
          <svg width={width} height={height} className="absolute inset-0" aria-hidden>
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
            {graph.edges.map((e, i) => {
              const a = pos.get(e.from)
              const b = pos.get(e.to)
              if (!a || !b || a === b) return null
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
          </svg>
          {nodes.map(({ node, x, y }) => {
            const target = onSelectFile && targetOf(node)
            const className = cx(
              'absolute flex items-center justify-center rounded-xl px-2.5 text-[13px]',
              STATUS_CLASS[node.status]
            )
            const style = { left: x, top: y, width: BOX_W, height: BOX_H }
            const title = node.files.join('\n') || undefined
            const label = <span className="min-w-0 truncate">{node.label}</span>
            return target ? (
              <button
                key={node.id}
                type="button"
                title={title}
                aria-label={`${node.label}（${STATUS_LABEL[node.status]}）`}
                onClick={() => onSelectFile?.(target)}
                className={cx(
                  className,
                  'cursor-pointer hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'
                )}
                style={style}
              >
                {label}
              </button>
            ) : (
              <div key={node.id} title={title} className={className} style={style}>
                {label}
                <span className="sr-only">（{STATUS_LABEL[node.status]}）</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
