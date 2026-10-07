// src/renderer/src/lib/format.ts

const pad = (n: number) => String(n).padStart(2, '0')

/** 報告等的產生時間（本地時間），例如 10/07 14:20；無法解析時回傳空字串 */
export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
