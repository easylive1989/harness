// src/shared/diff.ts
export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}
export interface DiffHunk {
  header: string
  lines: DiffLine[]
}
export interface DiffFile {
  path: string
  /** 只有 status 為 'renamed' 時才有 */
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  hunks: DiffHunk[]
  binary: boolean
}

const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`
const GIT_HEADER = new RegExp(`^diff --git (${QUOTED}|a/.+) (${QUOTED}|b/.+)$`)
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }

/** 解開 git 的 C 風格引號路徑；八進位跳脫是 UTF-8 位元組 */
export function unquotePath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s
  const enc = new TextEncoder()
  const bytes: number[] = []
  for (const m of s.slice(1, -1).matchAll(/\\([0-7]{1,3}|[\s\S])|[^\\]+/g)) {
    const esc = m[1]
    if (esc === undefined) bytes.push(...enc.encode(m[0]))
    else if (/^[0-7]+$/.test(esc)) bytes.push(parseInt(esc, 8) & 0xff)
    else if (esc in C_ESCAPES) bytes.push(C_ESCAPES[esc])
    else bytes.push(...enc.encode(esc))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** `a/x`、`"b/x"`、`/dev/null`（可能帶 git 補上的結尾 tab）→ 路徑；/dev/null 回傳 null */
function sidePath(raw: string): string | null {
  const p = unquotePath(raw.replace(/\t.*$/, ''))
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  /** 本檔案 `---` 行的路徑，供 `+++ /dev/null`（刪除）沿用 */
  let minusPath: string | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = GIT_HEADER.exec(line)
      file = { path: m ? (sidePath(m[2]) ?? '') : '', status: 'modified', hunks: [], binary: false }
      files.push(file)
      hunk = undefined
      minusPath = null
      continue
    }
    if (!file) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = unquotePath(line.slice('rename from '.length))
      } else if (line.startsWith('rename to '))
        file.path = unquotePath(line.slice('rename to '.length))
      else if (line.startsWith('Binary files')) file.binary = true
      else if (line.startsWith('--- ')) {
        minusPath = sidePath(line.slice(4))
        if (minusPath === null) file.status = 'added'
      } else if (line.startsWith('+++ ')) {
        const p = sidePath(line.slice(4))
        if (p !== null) file.path = p
        else {
          file.status = 'deleted'
          if (minusPath !== null) file.path = minusPath
        }
      }
      continue
    }
    if (line.startsWith('+')) hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
    else if (line.startsWith('-'))
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
    else if (line.startsWith(' '))
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  return files
}
