import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { Store } from '../../src/main/store/store'

let root: string
let store: Store
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-store-'))
  store = new Store(root)
})

describe('Store', () => {
  test('不存在的 JSON 回傳 fallback', async () => {
    expect(await store.readJson('a/b.json', { x: 1 })).toEqual({ x: 1 })
  })

  test('writeJson 會建立資料夾並可讀回', async () => {
    await store.writeJson('a/b.json', { y: 2 })
    expect(await store.readJson('a/b.json', null)).toEqual({ y: 2 })
  })

  test('jsonl append 與讀取，略過壞掉的行', async () => {
    await store.appendJsonl('t/log.jsonl', { n: 1 })
    await store.appendJsonl('t/log.jsonl', { n: 2 })
    await writeFile(
      join(root, 't/log.jsonl'),
      (await readFile(join(root, 't/log.jsonl'), 'utf8')) + '{"n":'
    )
    expect(await store.readJsonl('t/log.jsonl')).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('list 回傳子項目，資料夾不存在時回傳空陣列', async () => {
    expect(await store.list('tasks')).toEqual([])
    await mkdir(join(root, 'tasks/a'), { recursive: true })
    expect(await store.list('tasks')).toEqual(['a'])
  })
})
