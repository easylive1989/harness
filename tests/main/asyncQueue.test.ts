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

  test('close 後 push 丟錯', () => {
    const q = new AsyncQueue<number>()
    q.close()
    expect(() => q.push(1)).toThrow()
  })
})
