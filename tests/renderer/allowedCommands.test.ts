// tests/renderer/allowedCommands.test.ts
import { describe, expect, test } from 'vitest'
import { checkNewPattern } from '@renderer/lib/allowedCommands'

const existing = ['git status', 'ls *']

describe('checkNewPattern', () => {
  test('去掉多餘空白；空白輸入沒有樣式', () => {
    expect(checkNewPattern('  npm   test  * ', existing)).toEqual({ pattern: 'npm test *' })
    expect(checkNewPattern('   ', existing)).toEqual({ pattern: '' })
  })

  test('和清單中的樣式相同（忽略空白差異）就不能加入', () => {
    expect(checkNewPattern('git   status', existing).error).toBe('「git status」已經在清單中')
    expect(checkNewPattern(' ls  * ', [' ls   * ']).error).toBe('「ls *」已經在清單中')
  })

  test.each(['npm test && rm -rf /', 'cat a | head', 'echo $HOME', 'ls > out', 'a; b'])(
    '含串接或重導符號的「%s」不能加入',
    (c) => expect(checkNewPattern(c, existing).error).toMatch('一律需要核准')
  )

  test.each(['npm *', 'git *', 'make *'])('只有一個字加上 * 的「%s」提醒範圍很廣', (c) => {
    const r = checkNewPattern(c, existing)
    expect(r.error).toBeUndefined()
    expect(r.warning).toBe(`「${c}」會允許所有 ${c.slice(0, -2)} 開頭的指令，範圍很廣`)
  })

  test.each([
    ['rm *', '刪除任何檔案'],
    ['rm -rf *', '刪除任何檔案'],
    ['git push *', '推送到遠端'],
    ['git diff *', '--output'],
    ['git log *', '--output'],
    ['curl *', '網路'],
    ['sudo *', '管理員權限'],
    ['sudo  npm   test *', '管理員權限']
  ])('已知危險的「%s」說明原因，仍可加入', (c, reason) => {
    const r = checkNewPattern(c, existing)
    expect(r.error).toBeUndefined()
    expect(r.warning).toContain(reason)
    expect(r.warning).toContain(`「${r.pattern}」`)
  })

  test('* 不在結尾時提醒會當成一般字元', () => {
    expect(checkNewPattern('npm run test:*', existing).warning).toMatch('其他位置的 *')
    expect(checkNewPattern('*', existing).warning).toMatch('其他位置的 *')
  })

  test('一般樣式沒有錯誤也沒有提醒', () => {
    expect(checkNewPattern('npm test *', existing)).toEqual({ pattern: 'npm test *' })
    expect(checkNewPattern('npm run lint', existing)).toEqual({ pattern: 'npm run lint' })
  })
})
