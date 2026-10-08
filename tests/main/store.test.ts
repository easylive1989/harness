import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
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

  test('list 略過以 . 開頭的項目', async () => {
    await mkdir(join(root, 'tasks/a'), { recursive: true })
    await writeFile(join(root, 'tasks/.DS_Store'), '')
    expect(await store.list('tasks')).toEqual(['a'])
  })

  test('路徑中間是檔案（ENOTDIR）時視為不存在', async () => {
    await writeFile(join(root, 'f'), '')
    expect(await store.readJson('f/x.json', 'fb')).toBe('fb')
    expect(await store.readJsonl('f/x.jsonl')).toEqual([])
    expect(await store.list('f/sub')).toEqual([])
  })

  test('上一行寫到一半時，append 會從新的一行開始', async () => {
    await store.appendJsonl('t/log.jsonl', { n: 1 })
    await writeFile(
      join(root, 't/log.jsonl'),
      (await readFile(join(root, 't/log.jsonl'), 'utf8')) + '{"n":'
    )
    await store.appendJsonl('t/log.jsonl', { n: 2 })
    expect(await store.readJsonl('t/log.jsonl')).toEqual([{ n: 1 }, { n: 2 }])
  })

  test('writeJson 失敗時清掉暫存檔', async () => {
    await mkdir(join(root, 'd/sub'), { recursive: true })
    await expect(store.writeJson('d', { x: 1 })).rejects.toThrow()
    expect((await readdir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  test('路徑不能跳出 store 根目錄', async () => {
    await expect(store.readJson('../x.json', null)).rejects.toThrow('超出')
    await expect(store.writeJson('a/../../evil.json', {})).rejects.toThrow('超出')
    await expect(store.appendJsonl('/etc/x.jsonl', {})).rejects.toThrow('超出')
    await expect(store.list('..')).rejects.toThrow('超出')
    await expect(store.remove('..')).rejects.toThrow('超出')
  })

  test('remove 刪掉整個資料夾；不存在時不算錯', async () => {
    await store.writeJson('tasks/a/task.json', { id: 'a' })
    await store.appendJsonl('tasks/a/timeline.jsonl', { n: 1 })
    await store.writeJson('tasks/b/task.json', { id: 'b' })
    await store.remove('tasks/a')
    expect(await store.list('tasks')).toEqual(['b'])
    await expect(store.remove('tasks/a')).resolves.toBeUndefined()
  })

  test('remove 不能刪 store 根目錄本身', async () => {
    await store.writeJson('repos.json', [])
    await expect(store.remove('.')).rejects.toThrow('不能刪除')
    await expect(store.remove('tasks/..')).rejects.toThrow('不能刪除')
    expect(await store.readJson('repos.json', null)).toEqual([])
  })
})
