import { describe, expect, test } from 'vitest'
import { BOX_H, BOX_W, GAP_X, GAP_Y, layoutGraph } from '@shared/layout'

const n = (id: string) => ({ id })

describe('layoutGraph', () => {
  test('直線鏈每個節點一層', () => {
    const r = layoutGraph(
      [n('a'), n('b'), n('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' }
      ]
    )
    expect(r.nodes.map((x) => [x.node.id, x.layer])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2]
    ])
    expect(r.height).toBe(3 * BOX_H + 2 * GAP_Y)
    expect(r.width).toBe(BOX_W)
  })

  test('同一層的節點並排並置中', () => {
    const r = layoutGraph(
      [n('a'), n('b'), n('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' }
      ]
    )
    const b = r.nodes.find((x) => x.node.id === 'b')!
    const c = r.nodes.find((x) => x.node.id === 'c')!
    const a = r.nodes.find((x) => x.node.id === 'a')!
    expect(b.layer).toBe(1)
    expect(c.layer).toBe(1)
    expect(c.x - b.x).toBe(BOX_W + GAP_X)
    expect(a.x).toBe((r.width - BOX_W) / 2)
  })

  test('有環時仍會結束', () => {
    const r = layoutGraph(
      [n('a'), n('b')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }
      ]
    )
    expect(r.nodes).toHaveLength(2)
  })

  test('忽略指向不存在節點的邊', () => {
    const r = layoutGraph([n('a')], [{ from: 'a', to: 'zzz' }])
    expect(r.nodes[0].layer).toBe(0)
  })
})
