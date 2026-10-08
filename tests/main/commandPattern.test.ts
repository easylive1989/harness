import { describe, expect, test } from 'vitest'
import {
  hasShellOperators,
  matchesPattern,
  suggestPattern
} from '../../src/main/permissions/commandPattern'

describe('matchesPattern', () => {
  test('完全相同', () => expect(matchesPattern('git status', 'git status')).toBe(true))
  test('結尾 * 比對前綴加參數', () => {
    expect(matchesPattern('npm test -- auth', 'npm test *')).toBe(true)
    expect(matchesPattern('npm test', 'npm test *')).toBe(true)
    expect(matchesPattern('npm testing', 'npm test *')).toBe(false)
  })
  test('多餘空白會被正規化', () =>
    expect(matchesPattern('  git   diff  HEAD ', 'git diff *')).toBe(true))
  test('空樣式不比對', () => expect(matchesPattern('ls', '')).toBe(false))
})

describe('hasShellOperators', () => {
  test.each([
    'a && b',
    'a; b',
    'a | b',
    'echo $(x)',
    'echo `x`',
    'a > f',
    'a\nb',
    'a\rb',
    'echo $HOME',
    'npm test -- ${X}'
  ])('%s 有串接', (c) => {
    expect(hasShellOperators(c)).toBe(true)
  })
  test('一般指令沒有', () => expect(hasShellOperators('npm test -- --run auth')).toBe(false))
})

describe('suggestPattern', () => {
  test.each([
    ['npm test -- auth', 'npm test *'],
    ['  npm   run build ', 'npm run *'],
    ['git status', 'git status *'],
    ['ls', 'ls *']
  ])('%s → %s', (c, p) => expect(suggestPattern(c)).toBe(p))

  // 這些指令換個參數就可能刪檔、把結果寫到 worktree 外、連網或推送：只建議記住完全相同的指令
  test.each([
    ['git diff', 'git diff'],
    ['git diff --stat HEAD~1', 'git diff --stat HEAD~1'],
    ['git  log  -5', 'git log -5'],
    ['git push origin main', 'git push origin main'],
    ['rm -rf build', 'rm -rf build'],
    ['curl -s https://example.com', 'curl -s https://example.com'],
    ['sudo apt install jq', 'sudo apt install jq']
  ])('危險的指令只建議完全相同的指令：%s → %s', (c, p) => {
    expect(suggestPattern(c)).toBe(p)
    expect(matchesPattern(c, suggestPattern(c))).toBe(true)
  })
})
