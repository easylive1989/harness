import { describe, expect, test } from 'vitest'
import { AsyncQueue } from '../../src/main/agent/asyncQueue'

describe('AsyncQueue', () => {
  test('先 push 後讀、先讀後 push 都可以，close 後結束', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    const it = q[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 1, done: false })
    const pending = it.next()
    q.push(2)
    expect(await pending).toEqual({ value: 2, done: false })
    const end = it.next()
    q.close()
    expect((await end).done).toBe(true)
    expect(q.isClosed).toBe(true)
  })

  test('close 會結束所有等待中的讀取', async () => {
    const q = new AsyncQueue<number>()
    const it = q[Symbol.asyncIterator]()
    const a = it.next()
    const b = it.next()
    q.close()
    expect((await a).done).toBe(true)
    expect((await b).done).toBe(true)
  })

  test('close 前 push 的項目仍會被讀完', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    const seen: number[] = []
    for await (const n of q) seen.push(n)
    expect(seen).toEqual([1, 2])
  })

  test('close 後 push 丟錯', () => {
    const q = new AsyncQueue<number>()
    q.close()
    expect(() => q.push(1)).toThrow()
  })
})
