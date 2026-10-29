const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
export const money = (v: number) => brl.format(v)
/** Without decimals, for capacity figures in sublines ("de R$ 3.000"). */
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
export const money0 = (v: number) => brl0.format(v)
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

const parseISO = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d) }

/** "Hoje", "Ontem", or "seg., 26 de out." */
export const dayLabel = (iso: string) => {
  const t = today()
  if (iso === t) return 'Hoje'
  const diff = Math.round((parseISO(t).getTime() - parseISO(iso).getTime()) / 86400000)
  if (diff === 1) return 'Ontem'
  return parseISO(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Month position in São Paulo time: day of month, days in month, fraction elapsed (counting today). */
export const monthClock = () => {
  const [y, m, d] = today().split('-').map(Number)
  const days = new Date(y, m, 0).getDate()
  const name = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long' })
  return { day: d, days, left: days - d + 1, elapsed: d / days, name, year: y }
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
