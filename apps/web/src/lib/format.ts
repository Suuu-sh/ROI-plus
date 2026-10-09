const yenFmt = new Intl.NumberFormat('ja-JP')

export const yen = (n: number | null | undefined) => (n == null ? '—' : `¥${yenFmt.format(Math.round(n))}`)
export const signedYen = (n: number | null | undefined) =>
  n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}¥${yenFmt.format(Math.abs(Math.round(n)))}`
export const pct = (n: number | null | undefined, digits = 1) => (n == null ? '—' : `${(n * 100).toFixed(digits)}%`)
export const signedPct = (n: number | null | undefined, digits = 1) =>
  n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n * 100).toFixed(digits)}%`
export const odds = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}`)
export const num = (n: number | null | undefined, digits = 2) => (n == null ? '—' : n.toFixed(digits))
export const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-pos' : 'text-neg')

export function todayJst(): string {
  const d = new Date(Date.now() + 9 * 3600_000)
  return d.toISOString().slice(0, 10)
}

export function timeOf(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16) || '—'
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
}

export function freshness(min: number | null | undefined) {
  if (min == null) return '不明'
  if (min < 1) return '1分未満'
  if (min < 60) return `${Math.round(min)}分前`
  if (min < 60 * 24) return `${Math.round(min / 60)}時間前`
  return `${Math.round(min / 1440)}日前`
}
