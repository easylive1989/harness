// src/main/store/store.ts
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

// ENOTDIR：路徑中間是檔案（例如 tasks/.DS_Store/task.json），一樣視為不存在
const isMissing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 檔案存在、非空且最後一個字元不是換行（上次寫到一半） */
async function endsMidLine(file: string): Promise<boolean> {
  let fh
  try {
    fh = await open(file, 'r')
  } catch (e) {
    if (isMissing(e)) return false
    throw e
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) return false
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] !== 0x0a
  } finally {
    await fh.close()
  }
}

export class Store {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private path(rel: string) {
    const p = resolve(this.root, rel)
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error(`路徑超出資料夾範圍：${rel}`)
    }
    return p
  }

  async readJson<T>(rel: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path(rel), 'utf8')) as T
    } catch (e) {
      if (isMissing(e)) return fallback
      throw e
    }
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    const file = this.path(rel)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2))
      await rename(tmp, file)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
  }

  /** 寫入二進位檔（附加的圖片）；先寫暫存檔再改名，和 writeJson 一樣不會留下寫到一半的檔案 */
  async writeBuffer(rel: string, data: Buffer): Promise<void> {
    const file = this.path(rel)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, data)
      await rename(tmp, file)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
  }

  readBuffer(rel: string): Promise<Buffer> {
    return readFile(this.path(rel))
  }

  async appendJsonl(rel: string, obj: unknown): Promise<void> {
    const file = this.path(rel)
    await mkdir(dirname(file), { recursive: true })
    const lead = (await endsMidLine(file)) ? '\n' : ''
    await appendFile(file, `${lead}${JSON.stringify(obj)}\n`)
  }

  async readJsonl<T>(rel: string): Promise<T[]> {
    let text: string
    try {
      text = await readFile(this.path(rel), 'utf8')
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
    const out: T[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        /* 寫到一半的行，略過 */
      }
    }
    return out
  }

  async list(relDir: string): Promise<string[]> {
    try {
      return (await readdir(this.path(relDir))).filter((name) => !name.startsWith('.'))
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
  }
}
