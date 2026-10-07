// src/shared/layout.ts
export const BOX_W = 180
export const BOX_H = 44
export const GAP_X = 40
export const GAP_Y = 56

export interface LaidOutNode<N> {
  node: N
  layer: number
  index: number
  x: number
  y: number
}

export function layoutGraph<N extends { id: string }>(
  nodes: N[],
  edges: { from: string; to: string }[]
) {
  const layer = new Map(nodes.map((nd) => [nd.id, 0]))
  for (let i = 0; i < nodes.length; i++) {
    let changed = false
    for (const e of edges) {
      if (e.from === e.to || !layer.has(e.from) || !layer.has(e.to)) continue
      const want = layer.get(e.from)! + 1
      if (want > layer.get(e.to)! && want < nodes.length) {
        layer.set(e.to, want)
        changed = true
      }
    }
    if (!changed) break
  }

  const rows = new Map<number, N[]>()
  for (const nd of nodes) {
    const l = layer.get(nd.id)!
    rows.set(l, [...(rows.get(l) ?? []), nd])
  }
  const maxRow = Math.max(1, ...[...rows.values()].map((r) => r.length))
  const width = maxRow * BOX_W + (maxRow - 1) * GAP_X

  const laid: LaidOutNode<N>[] = []
  for (const [l, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const rowW = row.length * BOX_W + (row.length - 1) * GAP_X
    const x0 = (width - rowW) / 2
    row.forEach((node, index) =>
      laid.push({ node, layer: l, index, x: x0 + index * (BOX_W + GAP_X), y: l * (BOX_H + GAP_Y) })
    )
  }
  const layers = rows.size ? Math.max(...rows.keys()) + 1 : 0
  return { nodes: laid, width, height: layers * BOX_H + Math.max(0, layers - 1) * GAP_Y }
}
