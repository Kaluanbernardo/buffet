import type { BuffetData, Debt } from './types'
import { monthClock, monthKey, today } from '../lib/format'

const cents = (v: number) => Math.round(v * 100) / 100

/** Everything the month screens read, computed once from the rows. */
export function monthSummary(data: BuffetData) {
  const clock = monthClock()
  const mk = monthKey(today())
  const tx = data.transactions.filter((t) => monthKey(t.date) === mk)
  const spentBy = new Map<string, number>()
  for (const t of tx) spentBy.set(t.category, cents((spentBy.get(t.category) ?? 0) + t.amount))
  const spent = cents(tx.reduce((s, t) => s + t.amount, 0))

  const cats = data.budgets.map((b) => {
    const s = spentBy.get(b.category) ?? 0
    return { category: b.category, limit: b.monthly_limit, spent: s, left: cents(b.monthly_limit - s) }
  })
  const budgeted = cats.filter((c) => c.limit > 0)
  const limit = cents(budgeted.reduce((s, c) => s + c.limit, 0))
  // Spending in categories without a limit still counts against the month.
  const left = cents(limit - spent)
  const perDay = limit > 0 && left > 0 ? cents(left / clock.left) : 0
  return { clock, tx, spent, cats, budgeted, limit, left, perDay, over: budgeted.filter((c) => c.spent > c.limit) }
}

export const isOpen = (d: Debt) => d.installments_paid < d.installments_total

/** Days until the next due date, from today (0 = vence hoje). */
export function daysUntilDue(dueDay: number) {
  const { day, days } = monthClock()
  if (dueDay >= day) return Math.min(dueDay, days) - day
  const [y, m] = today().split('-').map(Number)
  const nextDays = new Date(y, m + 1, 0).getDate()
  return days - day + Math.min(dueDay, nextDays)
}

export const dueLabel = (n: number) => (n === 0 ? 'Vence hoje' : n === 1 ? 'Vence amanhã' : `Em ${n} dias`)

export type Slice = { key: string; value: number; share: number }
/** Spend by category, largest first; past `k` slices the tail folds into "Outras" (never a generated colour). */
export function categoryShare(tx: { category: string; amount: number }[], k = 4): Slice[] {
  const by = new Map<string, number>()
  for (const t of tx) by.set(t.category, cents((by.get(t.category) ?? 0) + t.amount))
  const total = [...by.values()].reduce((s, v) => s + v, 0)
  if (total <= 0) return []
  const sorted = [...by].sort((a, b) => b[1] - a[1])
  const head = sorted.length > k + 1 ? sorted.slice(0, k) : sorted
  const rest = sorted.slice(head.length).reduce((s, [, v]) => s + v, 0)
  const out = head.map(([key, value]) => ({ key, value, share: value / total }))
  if (rest > 0) out.push({ key: OTHER_SLICE, value: cents(rest), share: rest / total })
  return out
}
export const OTHER_SLICE = 'Outras'

/** Total spent per calendar day for the last `n` days, oldest first, today last. */
export function dailySpend(tx: { date: string; amount: number }[], n = 30) {
  const [y, m, d] = today().split('-').map(Number)
  const by = new Map<string, number>()
  for (const t of tx) by.set(t.date, (by.get(t.date) ?? 0) + t.amount)
  return Array.from({ length: n }, (_, i) => {
    const dt = new Date(y, m - 1, d - (n - 1 - i))
    const iso = dt.toLocaleDateString('sv-SE')
    return { date: iso, day: dt.getDate(), total: cents(by.get(iso) ?? 0) }
  })
}

/**
 * Installments still to pay and the month the last one falls in. If this month's due day hasn't
 * passed, the next installment is this month; otherwise it is next month.
 */
export function payoff(d: Debt) {
  const left = Math.max(0, d.installments_total - d.installments_paid)
  const { day } = monthClock()
  const [y, m] = today().split('-').map(Number)
  const first = d.due_day >= day ? 0 : 1
  const last = new Date(y, m - 1 + first + left - 1, 1)
  return { left, owed: cents(left * d.installment_amount), year: last.getFullYear(), month: last.getMonth() }
}
