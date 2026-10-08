// src/main/permissions/commandPattern.ts
import { hasShellOperators, normalizeCommand as normalize } from '@shared/commandPattern'

export { hasShellOperators }

export function matchesPattern(command: string, pattern: string): boolean {
  const c = normalize(command)
  const p = normalize(pattern)
  if (!p) return false
  if (p.endsWith(' *')) {
    const prefix = p.slice(0, -2)
    return c === prefix || c.startsWith(`${prefix} `)
  }
  return c === p
}

export function suggestPattern(command: string): string {
  const parts = normalize(command).split(' ')
  return `${parts.slice(0, Math.min(2, parts.length)).join(' ')} *`
}
