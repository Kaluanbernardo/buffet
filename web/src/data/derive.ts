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
