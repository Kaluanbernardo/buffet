const HIDE_KEY = 'buffet_hide_values'
/** "Ocultar valores" (Nubank's eye): read by every money formatter; the store re-renders screens on change. */
let hidden = (() => { try { return localStorage.getItem(HIDE_KEY) === '1' } catch { return false } })()
export const valuesHidden = () => hidden
export const setValuesHidden = (v: boolean) => {
  hidden = v
  try { localStorage.setItem(HIDE_KEY, v ? '1' : '0') } catch { /* private mode */ }
}
export const MASK = 'R$ ••••'

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
export const money = (v: number) => (hidden ? MASK : brl.format(v))
/** Without decimals, for capacity figures in sublines ("de R$ 3.000"). */
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
export const money0 = (v: number) => (hidden ? MASK : brl0.format(v))
/** Compact form for chart labels only ("R$ 1,2 mil"). */
const brlC = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 })
export const moneyCompact = (v: number) => (hidden ? MASK : brlC.format(v))
export const monthKey = (d: string | Date = new Date()) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 7)
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
export const fmtDate = (iso: string) => iso.split('-').reverse().join('/')
export const uid = () => crypto.randomUUID()

/** Parse "29,47", "1.234,56" or "29.47" into a number (NaN when empty/invalid). */
export const parseMoney = (s: string) => {
  const t = s.trim().replace(/\s|R\$/g, '')
  if (!t) return NaN
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t
  return Number(norm)
}

export const parseISO = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d) }

/** "Hoje", "Ontem", or "seg., 26 de out." */
export const dayLabel = (iso: string) => {
  const t = today()
  if (iso === t) return 'Hoje'
  const diff = Math.round((parseISO(t).getTime() - parseISO(iso).getTime()) / 86400000)
  if (diff === 1) return 'Ontem'
  return parseISO(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })
}

/**
 * Month position in São Paulo time: day of month, days in month, fraction elapsed (counting today).
 * A past month reads as finished (day = days, nothing left); `current` says whether it is this month.
 */
export const monthClock = (mk = monthKey(today())) => {
  const [y, m] = mk.split('-').map(Number)
  const days = new Date(y, m, 0).getDate()
  const name = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long' })
  const t = today()
  const current = monthKey(t) === mk
  const d = current ? Number(t.slice(8, 10)) : mk < monthKey(t) ? days : 0
  return { day: d, days, left: days - d + (current ? 1 : 0), elapsed: d / days, name, year: y, current }
}

/** ISO date shifted by n days. */
export const addDays = (iso: string, n: number) => {
  const d = parseISO(iso)
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('sv-SE')
}

/** Monday of the week containing `iso` (weeks run seg–dom, as on Brazilian calendars at work). */
export const weekStart = (iso: string) => addDays(iso, -((parseISO(iso).getDay() + 6) % 7))

/** "26 out – 1 nov" for the week starting on `start`. */
export const weekRange = (start: string) => {
  const f = (iso: string) => parseISO(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }).replace(/\.| de/g, '')
  return `${f(start)} – ${f(addDays(start, 6))}`
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "out/26" — short month + 2-digit year, for payoff dates. */
export const shortMonth = (y: number, m0: number) => {
  const d = new Date(y, m0, 1)
  return `${d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}/${String(d.getFullYear()).slice(2)}`
}

/** "Outubro" or "Outubro de 2025" (year only when not the current one). */
export const monthName = (mk: string) => {
  const [y, m] = mk.split('-').map(Number)
  const s = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: y === Number(today().slice(0, 4)) ? undefined : 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Month key shifted by n months ("2026-10" + -1 → "2026-09"). */
export const shiftMonth = (mk: string, n: number) => {
  const [y, m] = mk.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
