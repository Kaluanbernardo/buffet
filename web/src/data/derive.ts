import type { Budget, BudgetGroup, BuffetData, Debt } from './types'
import { addDays, monthClock, monthKey, today } from '../lib/format'

const cents = (v: number) => Math.round(v * 100) / 100

/** Everything the month screens read, computed once from the rows. Defaults to the current month. */
export function monthSummary(data: BuffetData, mk = monthKey(today())) {
  const clock = monthClock(mk)
  const tx = data.transactions.filter((t) => monthKey(t.date) === mk)
  const spentBy = new Map<string, number>()
  for (const t of tx) spentBy.set(t.category, cents((spentBy.get(t.category) ?? 0) + t.amount))
  const spent = cents(tx.reduce((s, t) => s + t.amount, 0))

  const cats = data.budgets.map((b) => {
    const s = spentBy.get(b.category) ?? 0
    return { category: b.category, limit: b.monthly_limit, spent: s, left: cents(b.monthly_limit - s), group: groupOf(b) }
  })
  // Spend in a category that has no budget row (renamed or removed) must still show up somewhere.
  const orphan = cents([...spentBy].filter(([c]) => !data.budgets.some((b) => b.category === c)).reduce((s, [, v]) => s + v, 0))
  const budgeted = cats.filter((c) => c.limit > 0)
  const limit = cents(budgeted.reduce((s, c) => s + c.limit, 0))
  // Spending in categories without a limit still counts against the month.
  const left = cents(limit - spent)
  const perDay = limit > 0 && left > 0 && clock.left > 0 ? cents(left / clock.left) : 0
  const income = incomeFor(data, mk)
  // YNAB "Ready to Assign": income given no job yet. Null until a renda exists for the month.
  const toAssign = income ? cents(income.amount - limit) : null
  return { mk, clock, tx, spent, cats, budgeted, limit, left, perDay, orphan, income, toAssign, over: budgeted.filter((c) => c.spent > c.limit) }
}

/**
 * Renda for a month: its own entry, or the most recent earlier one carried forward (salary rarely changes).
 * `carried` names the source month so the UI can say "repetida de setembro".
 */
export function incomeFor(data: BuffetData, mk: string): { amount: number; carried: string | null } | null {
  if (data.incomes[mk] !== undefined) return { amount: data.incomes[mk], carried: null }
  const prev = Object.keys(data.incomes).filter((k) => k < mk).sort().pop()
  return prev ? { amount: data.incomes[prev], carried: prev } : null
}

export const GROUPS: { key: BudgetGroup; label: string; hint: string }[] = [
  { key: 'essenciais', label: 'Essenciais', hint: 'Contas que não dá para pular' },
  { key: 'lifestyle', label: 'Estilo de vida', hint: 'Escolhas do dia a dia' },
  { key: 'metas', label: 'Metas', hint: 'Dinheiro com destino futuro' },
]
const DEFAULT_GROUP: Record<string, BudgetGroup> = {
  Moradia: 'essenciais', Alimentação: 'essenciais', Transporte: 'essenciais', Saúde: 'essenciais',
  Lazer: 'lifestyle', Assinaturas: 'lifestyle', Outros: 'lifestyle', Educação: 'metas',
}
export const groupOf = (b: Budget): BudgetGroup => b.group ?? DEFAULT_GROUP[b.category] ?? 'lifestyle'

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

type Day = { date: string; day: number; total: number }
const byDate = (tx: { date: string; amount: number }[]) => {
  const by = new Map<string, number>()
  for (const t of tx) by.set(t.date, (by.get(t.date) ?? 0) + t.amount)
  return by
}
const dayRow = (by: Map<string, number>, iso: string): Day => ({ date: iso, day: Number(iso.slice(8, 10)), total: cents(by.get(iso) ?? 0) })

/** Total spent per calendar day for the last `n` days, oldest first, today last. */
export function dailySpend(tx: { date: string; amount: number }[], n = 30): Day[] {
  const by = byDate(tx)
  const t = today()
  return Array.from({ length: n }, (_, i) => dayRow(by, addDays(t, i - (n - 1))))
}

/** Every day of month `mk` (1st → last), including days still to come. */
export function monthDays(tx: { date: string; amount: number }[], mk: string): Day[] {
  const by = byDate(tx)
  const [y, m] = mk.split('-').map(Number)
  const n = new Date(y, m, 0).getDate()
  return Array.from({ length: n }, (_, i) => dayRow(by, `${mk}-${String(i + 1).padStart(2, '0')}`))
}

/** Seven days seg → dom starting at `start` (a Monday). */
export const weekDays = (tx: { date: string; amount: number }[], start: string): Day[] => {
  const by = byDate(tx)
  return Array.from({ length: 7 }, (_, i) => dayRow(by, addDays(start, i)))
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
