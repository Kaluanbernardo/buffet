import type { Bank, Budget, BudgetGroup, BuffetData, CardPayment, Debt, PayMethod, ReviewAction, SplitAction, SubCycle, Subscription, Transaction } from './types'
import { addDays, monthClock, monthKey, parseISO, shiftMonth, today } from '../lib/format'

const cents = (v: number) => Math.round(v * 100) / 100

// ---------------------------------------------------------------- dividido e reembolso

type Spendable = { amount: number; reimbursed_amount?: number }
/** What this row weighs in spend totals. Mirrors the effective_amount column — keep the two equal. Bills and subscription prices keep `amount`. */
export const spendOf = (t: Spendable) => cents(t.amount - (t.reimbursed_amount ?? 0))
/** What is still to be received for this row. */
export const owedOf = (t: Transaction) => (t.partner_amount == null ? 0 : cents(t.partner_amount - (t.reimbursed_amount ?? 0)))
/** The other person's part. Mirrors the partner_amount column, in whole units so half a cent rounds the way Postgres does. */
export const partnerOf = (amount: number, share: number) => Math.round(Math.round(amount * 100) * (10000 - Math.round(share * 100)) / 10000) / 100

export type SplitState = 'split' | 'partial' | 'reimbursed'
/** Derived, no column. */
export const splitState = (t: Transaction): SplitState | null =>
  t.split_share_pct == null ? null : !t.reimbursed_amount ? 'split' : owedOf(t) > 0 ? 'partial' : 'reimbursed'

/** A receber: rows that already happened and still have money to come; a future date counts once it arrives. */
export function receivable(data: BuffetData, ref = today()) {
  const rows = data.transactions.filter((t) => isPosted(t, ref) && owedOf(t) > 0).sort((a, b) => a.date.localeCompare(b.date))
  return { rows, total: cents(rows.reduce((s, t) => s + owedOf(t), 0)) }
}

/** Same rules as public.buffet_tx_* for the device-only store (no database): see supabase/migrations/*_buffet_split_reimburse.sql. */
export function applySplit(data: BuffetData, a: SplitAction): BuffetData {
  const t = data.transactions.find((x) => x.id === a.id)
  if (!t) throw new Error('gasto não encontrado')
  let next: Transaction = t
  let cash = data.config.cash_balance ?? null
  const got = t.reimbursed_amount ?? 0
  const clearReimbursed = { reimbursed_amount: undefined, reimbursed_cash: undefined, reimbursed_at: undefined }
  if (a.kind === 'split') {
    if (t.debt_id) throw new Error('parcela de plano não pode ser dividida')
    if (!(a.share >= 0 && a.share < 100)) throw new Error('a sua parte precisa ficar entre 0% e 100%')
    const partner = partnerOf(t.amount, a.share)
    if (partner <= 0) throw new Error('com essa divisão não sobra nada a receber')
    if (partner < got) throw new Error(`a parte da outra pessoa (${partner}) ficaria menor que o já recebido (${got})`)
    next = { ...t, split_share_pct: a.share, partner_amount: partner }
  } else if (a.kind === 'unsplit') {
    if (t.split_share_pct == null) throw new Error('esse gasto não está dividido')
    if (t.reimbursed_amount != null) throw new Error('esse gasto tem reembolso registrado: desfaça o reembolso antes')
    next = { ...t, split_share_pct: undefined, partner_amount: undefined }
  } else if (a.kind === 'reimburse') {
    if (t.split_share_pct == null) throw new Error('esse gasto não está dividido')
    const owed = owedOf(t)
    if (owed <= 0) throw new Error('esse gasto já foi todo reembolsado')
    const v = a.amount ?? owed
    if (!(v > 0) || v > owed) throw new Error(`valor (${v}) maior que o que falta receber (${owed})`)
    const inCash = a.cash && cash != null ? v : 0
    if (inCash && cash != null) cash = cents(cash + inCash)
    next = { ...t, reimbursed_amount: cents(got + v), reimbursed_cash: cents((t.reimbursed_cash ?? 0) + inCash), reimbursed_at: a.date ?? today() }
  } else {
    if (t.reimbursed_amount == null) throw new Error('esse gasto não tem reembolso registrado')
    if (cash != null) cash = cents(cash - (t.reimbursed_cash ?? 0))
    next = { ...t, ...clearReimbursed }
  }
  return { ...data, config: { ...data.config, cash_balance: cash }, transactions: data.transactions.map((x) => (x.id === t.id ? next : x)) }
}

// ---------------------------------------------------------------- pendentes de notificação

/** Came from a bank notification and wasn't reviewed yet. It counts in every total like any row; screens show a marker. */
export const isPending = (t: Transaction) => t.review_status === 'pending'

/** Pendentes de revisão (oldest first), what they weigh, how many look like a spend logged by hand, and refunds waiting. */
export function pendingOf(data: BuffetData) {
  const rows = data.transactions.filter(isPending).sort((a, b) => a.date.localeCompare(b.date) || (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  return { rows, total: cents(rows.reduce((s, t) => s + spendOf(t), 0)), duplicates: rows.filter((t) => t.possible_duplicate_of).length,
    refunds: data.refunds ?? [] }
}

/**
 * Same rules as public.buffet_tx_review / buffet_tx_discard / buffet_notif_dismiss for the device-only store (pending rows only
 * come from the database, so this is the fallback). Changing amount, method, bank or date needs the cash account and card
 * cycles the database keeps: refused here.
 */
export function applyReview(data: BuffetData, a: ReviewAction): BuffetData {
  if (a.kind === 'dismiss') return { ...data, refunds: (data.refunds ?? []).filter((r) => r.id !== a.id) }
  if (a.kind === 'confirm') return a.ids.reduce((d, id) => applyReview(d, { kind: 'review', id, patch: {}, confirm: true }), data)
  const t = data.transactions.find((x) => x.id === a.id)
  if (!t) throw new Error('gasto não encontrado')
  if (a.kind === 'discard') {
    if (!isPending(t)) throw new Error('só dá para descartar gasto pendente de revisão')
    if (t.reimbursed_amount != null) throw new Error('esse gasto tem reembolso registrado: desfaça o reembolso antes')
    const cash = data.config.cash_balance ?? null
    const back = cash != null ? t.cash_debited ?? 0 : 0
    return { ...data, config: { ...data.config, cash_balance: cash == null ? cash : cents(cash + back) }, transactions: data.transactions.filter((x) => x.id !== t.id) }
  }
  if (t.review_status == null) throw new Error('esse gasto não veio de notificação')
  const p = a.patch
  const moves = (p.amount !== undefined && p.amount !== t.amount) || (p.method !== undefined && p.method !== t.method)
    || (p.bank !== undefined && p.bank !== t.bank) || (p.date !== undefined && p.date !== t.date)
  if (moves) throw new Error('mudar valor, meio, banco ou data de um pendente só com o banco de dados')
  if (p.merchant !== undefined && !p.merchant.trim()) throw new Error('estabelecimento vazio')
  if (p.category !== undefined && !p.category.trim()) throw new Error('categoria vazia')
  let d: BuffetData = { ...data, transactions: data.transactions.map((x) => (x.id !== t.id ? x : {
    ...x, ...(p.merchant !== undefined ? { merchant: p.merchant.trim() } : {}), ...(p.category !== undefined ? { category: p.category.trim() } : {}),
    ...('note' in p ? { note: p.note?.trim() || undefined } : {}) })) }
  if ('share' in p) d = p.share == null ? (t.split_share_pct != null ? applySplit(d, { kind: 'unsplit', id: t.id }) : d) : applySplit(d, { kind: 'split', id: t.id, share: p.share })
  if ('reimburse' in p) d = applySplit(d, { kind: 'reimburse', id: t.id, amount: p.reimburse ?? undefined, cash: p.reimburse_cash ?? true })
  if (a.confirm) d = { ...d, transactions: d.transactions.map((x) => (x.id === t.id ? { ...x, review_status: 'confirmed' as const, possible_duplicate_of: undefined } : x)) }
  return d
}

/** Everything the month screens read, computed once from the rows. Defaults to the current month. */
export function monthSummary(data: BuffetData, mk = monthKey(today())) {
  const clock = monthClock(mk)
  const tx = data.transactions.filter((t) => monthKey(t.date) === mk)
  const spentBy = new Map<string, number>()
  for (const t of tx) spentBy.set(t.category, cents((spentBy.get(t.category) ?? 0) + spendOf(t)))
  const spent = cents(tx.reduce((s, t) => s + spendOf(t), 0))

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
  Lazer: 'lifestyle', Assinaturas: 'lifestyle', Vestimenta: 'lifestyle', Mercado: 'essenciais', Doação: 'metas', Fitness: 'essenciais', Jogos: 'lifestyle', 'Pró-vida': 'metas', 'Telefonia e internet': 'essenciais', Pet: 'essenciais', Impostos: 'essenciais', Outros: 'lifestyle', Educação: 'metas',
}
export const groupOf = (b: Budget): BudgetGroup => b.group ?? DEFAULT_GROUP[b.category] ?? 'lifestyle'

export const isOpen = (d: Debt) => d.installments_paid < d.installments_total

/**
 * Rows already spent (date <= today). Installments are materialized one row per month (option A), so later parcels sit
 * in the table with future dates: lists of "what happened" (Hoje, Gastos) read only these; the rest is "agendada".
 */
export const isPosted = (t: Transaction, ref = today()) => t.date <= ref
export const posted = (data: BuffetData): BuffetData => {
  const t = today()
  return { ...data, transactions: data.transactions.filter((x) => isPosted(x, t)) }
}

// ---------------------------------------------------------------- cartões e faturas

type Cycle = NonNullable<Bank['credit']>
export const creditCards = (data: BuffetData) => data.config.banks.filter((b): b is Bank & { credit: Cycle } => Boolean(b.credit?.closing_day && b.credit?.due_day))

/**
 * Bill (due month "AAAA-MM") a credit purchase on `iso` lands in: the first closing after the date (on the closing day
 * it already goes to the next one); due after closing in the calendar → same month, else the month after.
 * Mirrors public.buffet_bill_month (supabase/migrations/*_buffet_installments_bills.sql) — keep the two equal.
 */
export function billMonth(c: Cycle, iso: string) {
  const day = Number(iso.slice(8, 10))
  return shiftMonth(iso.slice(0, 7), (day < c.closing_day ? 0 : 1) + (c.due_day > c.closing_day ? 0 : 1))
}
const onDay = (mk: string, d: number) => { const [y, m] = mk.split('-').map(Number); return iso(y, m - 1, Math.min(d, lastDay(y, m - 1))) }
export const billDue = (c: Cycle, mk: string) => onDay(mk, c.due_day)
export const billClose = (c: Cycle, mk: string) => onDay(c.due_day > c.closing_day ? mk : shiftMonth(mk, -1), c.closing_day)

export type BillState = 'paid' | 'closed' | 'open' | 'future'
export interface Bill {
  card: string; month: string; due: string; close: string; state: BillState
  /** Credit rows with this bill_month (à vista + installments). */
  items: Transaction[]; detailed: number; installments: number
  /** What the bank's app shows (debts kind='bill'), when told. */
  reported: number | null; reportedDebt?: Debt
  /** max(reported, detailed) — never the two added. */
  total: number; undetailed: number
  payments: CardPayment[]
  /** Active subscriptions on this card whose next charge falls in this bill and isn't logged yet: forecast, never summed. */
  forecast: Subscription[]
}

const sum = (xs: { amount: number }[]) => cents(xs.reduce((s, x) => s + x.amount, 0))

/** Every bill of `card` that has something in it, oldest first. Paid = a payment for the month, or reported debt marked paid. */
export function cardBills(data: BuffetData, card: string, c: Cycle, ref = today()): Bill[] {
  const same = (v?: string) => (v ?? '').toLowerCase() === card.toLowerCase()
  const items = data.transactions.filter((t) => t.method === 'credit' && t.bill_month && same(t.bank))
  const reported = data.debts.filter((d) => d.kind === 'bill' && d.first_bill && same(d.card))
  const forecast = data.subscriptions.filter((s) => s.status === 'active' && same(s.bank))
  const opened = billMonth(c, ref)
  const months = [...new Set([...items.map((t) => t.bill_month!), ...reported.map((d) => d.first_bill!)])].sort()
  return months.map((m) => {
    const its = items.filter((t) => t.bill_month === m).sort((a, b) => a.date.localeCompare(b.date))
    const rep = reported.find((d) => d.first_bill === m)
    const detailed = sum(its)
    const total = cents(Math.max(rep?.installment_amount ?? 0, detailed))
    const payments = data.cardPayments.filter((p) => p.bill_month === m && same(p.card_bank))
    const paid = payments.length > 0 || Boolean(rep && !isOpen(rep))
    return {
      card, month: m, due: billDue(c, m), close: billClose(c, m), items: its, detailed, installments: sum(its.filter((t) => t.debt_id)),
      reported: rep ? rep.installment_amount : null, reportedDebt: rep, total, undetailed: cents(total - detailed), payments,
      state: paid ? 'paid' : m < opened ? 'closed' : m === opened ? 'open' : 'future',
      forecast: forecast.filter((s) => billMonth(c, s.next_due) === m && !its.some((t) => t.subscription_id === s.id && t.date === s.next_due)),
    }
  })
}

/** All credit cards' bills, plus what's committed: every unpaid bill's total (reported or detailed, never both). */
export function bills(data: BuffetData) {
  const cards = creditCards(data).map((b) => ({ name: b.name, cycle: b.credit, bills: cardBills(data, b.name, b.credit) }))
  const unpaid = cards.flatMap((c) => c.bills.filter((b) => b.state !== 'paid'))
  const now = unpaid.filter((b) => b.state !== 'future')
  const later = unpaid.filter((b) => b.state === 'future')
  const lastInst = unpaid.filter((b) => b.installments > 0).map((b) => b.month).sort().pop() ?? null
  return { cards, unpaid, committed: sum(unpaid.map((b) => ({ amount: b.total }))), now: sum(now.map((b) => ({ amount: b.total }))),
    later: sum(later.map((b) => ({ amount: b.total }))), freeAfter: lastInst }
}

/**
 * An installment plan from its materialized rows: paid = installment_no <= installments_paid (pay-bill keeps it), next
 * unpaid parcel, what's left and the last bill. Plans without rows (old/app-made) fall back to `payoff`.
 */
export function planOf(d: Debt, tx: Transaction[]) {
  const rows = tx.filter((t) => t.debt_id === d.id).sort((a, b) => (a.installment_no ?? 0) - (b.installment_no ?? 0))
  const left = rows.filter((t) => (t.installment_no ?? 0) > d.installments_paid)
  return { rows, left, next: left[0] ?? null, owed: sum(left), last: rows[rows.length - 1]?.bill_month ?? null, total: d.total_amount ?? sum(rows) }
}

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
/** Spend by category, largest first (ties by name). Every category with spend gets its own slice — nothing folds into a tail bucket. */
export function categoryShare(tx: (Spendable & { category: string })[]): Slice[] {
  const by = new Map<string, number>()
  for (const t of tx) by.set(t.category, cents((by.get(t.category) ?? 0) + spendOf(t)))
  const sorted = [...by].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const total = cents(sorted.reduce((s, [, v]) => s + v, 0))
  return sorted.map(([key, value]) => ({ key, value, share: value / total }))
}

// ---------------------------------------------------------------- filtro de pagamento e série por categoria

export type PayFilter = 'todos' | PayMethod
export const PAY_FILTERS: { key: PayFilter; label: string }[] = [
  { key: 'todos', label: 'Todos' }, { key: 'credit', label: 'Crédito' }, { key: 'debit', label: 'Débito' }, { key: 'pix', label: 'PIX' },
]
/** "Todos" keeps everything (method unknown or cash included); a specific method keeps exactly that method, so an unknown one is never read as debit or PIX. */
export const payMatches = (t: { method?: PayMethod }, f: PayFilter) => f === 'todos' || t.method === f

/**
 * The spend Gastos works on: rows already spent (isPosted — later installments stay out) in the chosen payment method.
 * Card bill payments live in data.cardPayments, not here, and a plan's principal is no row at all: only its installments.
 */
export const spendScope = (data: BuffetData, pay: PayFilter = 'todos', ref = today()) =>
  data.transactions.filter((t) => isPosted(t, ref) && payMatches(t, pay))

// ---------------------------------------------------------------- treemap e sankey

export type PayOrigin = 'credit' | 'debit' | 'pix' | 'cash' | 'unknown'
export const PAY_ORIGIN_LABEL: Record<PayOrigin, string> = {
  credit: 'Crédito', debit: 'Débito', pix: 'PIX', cash: 'Dinheiro', unknown: 'Forma não informada',
}
const ORIGINS = Object.keys(PAY_ORIGIN_LABEL) as PayOrigin[]
/** Where the money came from, read only from the row's own method — never inferred from bank, bill_month or income. */
export const payOrigin = (t: { method?: PayMethod }): PayOrigin => t.method ?? 'unknown'

export interface SankeyLink { source: PayOrigin; category: string; value: number }
export interface SankeyFlow {
  origins: { key: PayOrigin; label: string; value: number }[]
  categories: { key: string; value: number }[]
  links: SankeyLink[]
  total: number
}
/**
 * Spend (spendOf) by payment method → category. Origins follow the fixed order of PAY_ORIGIN_LABEL and drop out when empty;
 * categories follow categoryShare (largest, then name). Rows with no spend left are ignored.
 */
export function methodCategoryFlow(tx: (Spendable & { category: string; method?: PayMethod })[]): SankeyFlow {
  const by = new Map<string, number>()
  for (const t of tx) {
    const v = Math.round(spendOf(t) * 100)
    if (v <= 0) continue
    const k = `${payOrigin(t)}\u0000${t.category}`
    by.set(k, (by.get(k) ?? 0) + v)
  }
  const cats = categoryShare(tx)
  const links: SankeyLink[] = []
  for (const source of ORIGINS) {
    for (const c of cats) {
      const v = by.get(`${source}\u0000${c.key}`)
      if (v) links.push({ source, category: c.key, value: v / 100 })
    }
  }
  const origins = ORIGINS.map((key) => ({ key, label: PAY_ORIGIN_LABEL[key], value: cents(links.filter((l) => l.source === key).reduce((s, l) => s + l.value, 0)) })).filter((o) => o.value > 0)
  return { origins, categories: cats.map(({ key, value }) => ({ key, value })), links, total: cents(links.reduce((s, l) => s + l.value, 0)) }
}

export interface TreemapRect { key: string; x: number; y: number; w: number; h: number; value: number }
/** Squarified treemap (Bruls et al.): rectangles of area proportional to value that tile the `width` × `height` box. */
export function treemapRects(slices: { key: string; value: number }[], width: number, height: number): TreemapRect[] {
  const items = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
  const sum = items.reduce((s, x) => s + x.value, 0)
  if (!(width > 0 && height > 0) || sum <= 0) return []
  const k = (width * height) / sum
  const out: TreemapRect[] = []
  let x = 0, y = 0, w = width, h = height
  // Worst aspect ratio of a row of areas laid along a side of length `side`.
  const worst = (areas: number[], side: number) => {
    const s = areas.reduce((a, b) => a + b, 0)
    return Math.max(...areas.map((a) => Math.max((side * side * a) / (s * s), (s * s) / (side * side * a))))
  }
  let i = 0
  while (i < items.length) {
    const side = Math.min(w, h)
    const row = [i]
    let areas = [items[i].value * k]
    while (i + row.length < items.length) {
      const next = [...areas, items[i + row.length].value * k]
      if (worst(next, side) > worst(areas, side)) break
      areas = next
      row.push(i + row.length)
    }
    const used = areas.reduce((a, b) => a + b, 0)
    const last = i + row.length >= items.length
    if (w >= h) { // row is a column on the left, filling the height
      const colW = last ? w : used / h
      let yy = y
      row.forEach((r, j) => { const hh = j === row.length - 1 ? y + h - yy : areas[j] / colW; out.push({ key: items[r].key, x, y: yy, w: colW, h: hh, value: items[r].value }); yy += hh })
      x += colW; w -= colW
    } else { // row is a strip on top, filling the width
      const rowH = last ? h : used / w
      let xx = x
      row.forEach((r, j) => { const ww = j === row.length - 1 ? x + w - xx : areas[j] / rowH; out.push({ key: items[r].key, x: xx, y, w: ww, h: rowH, value: items[r].value }); xx += ww })
      y += rowH; h -= rowH
    }
    i += row.length
  }
  return out
}

type Day = { date: string; day: number; total: number }
type Dated = Spendable & { date: string }
const byDate = (tx: Dated[], weigh: (t: Dated) => number = spendOf) => {
  const by = new Map<string, number>()
  for (const t of tx) by.set(t.date, (by.get(t.date) ?? 0) + weigh(t))
  return by
}
const dayRow = (by: Map<string, number>, iso: string): Day => ({ date: iso, day: Number(iso.slice(8, 10)), total: cents(by.get(iso) ?? 0) })

/** Total spent per calendar day for the last `n` days, oldest first, today last. */
export function dailySpend(tx: Dated[], n = 30): Day[] {
  const by = byDate(tx)
  const t = today()
  return Array.from({ length: n }, (_, i) => dayRow(by, addDays(t, i - (n - 1))))
}

/** Every day of month `mk` (1st → last), including days still to come. `weigh` = what a row adds to its day (default: the spend). */
export function monthDays(tx: Dated[], mk: string, weigh?: (t: Dated) => number): Day[] {
  const by = byDate(tx, weigh)
  const [y, m] = mk.split('-').map(Number)
  const n = new Date(y, m, 0).getDate()
  return Array.from({ length: n }, (_, i) => dayRow(by, `${mk}-${String(i + 1).padStart(2, '0')}`))
}

/** Seven days seg → dom starting at `start` (a Monday). */
export const weekDays = (tx: Dated[], start: string): Day[] => {
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

// ---------------------------------------------------------------- assinaturas

export const CYCLE_LABEL: Record<SubCycle, { adj: string; per: string }> = {
  monthly: { adj: 'mensal', per: 'mês' }, yearly: { adj: 'anual', per: 'ano' },
}

/** What a subscription commits per month (yearly ÷ 12). A projection, never spend. */
export const perMonth = (s: Subscription) => cents(s.cycle === 'yearly' ? s.amount / 12 : s.amount)

const lastDay = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate()
const iso = (y: number, m0: number, d: number) => `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/**
 * Next charge after `next`, one cycle on, on the anchor day (the first charge's day, capped at month end).
 * With `chargedOn`: a charge from well before this cycle (> 15 days, 60 for yearly) is history and doesn't advance.
 * Mirrors public.buffet_sub_advance (supabase/migrations/*_buffet_subscriptions.sql) — keep the two equal.
 */
export function subAdvance(next: string, cycle: SubCycle, anchor?: number, chargedOn?: string) {
  if (chargedOn && chargedOn < addDays(next, -(cycle === 'yearly' ? 60 : 15))) return next
  const [y, m, d] = next.split('-').map(Number)
  const t = new Date(y, m - 1 + (cycle === 'yearly' ? 12 : 1), 1)
  return iso(t.getFullYear(), t.getMonth(), Math.min(anchor ?? d, lastDay(t.getFullYear(), t.getMonth())))
}
export const anchorOf = (s: Subscription) => (s.started_on ? Number(s.started_on.slice(8, 10)) : undefined)
/** The subscription after one charge (or a skip, without `chargedOn`). */
export const advanced = (s: Subscription, chargedOn?: string): Subscription => ({ ...s, next_due: subAdvance(s.next_due, s.cycle, anchorOf(s), chargedOn) })
/** Rolled forward to the first date >= `ref` (resuming after a long pause). */
export function rolled(s: Subscription, ref = today()): Subscription {
  let next = s.next_due
  for (let i = 0; next < ref && i < 600; i++) next = subAdvance(next, s.cycle, anchorOf(s))
  return { ...s, next_due: next }
}

/** Whole days from today to `iso` (negative = past). */
export const daysFrom = (to: string, from = today()) => Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86400000)

export type SubFlag = 'missing' | 'late' | 'soon' | 'later' | 'paused' | 'canceled'
/**
 * Everything derived (no columns): days to the next charge, the state pill, the linked charges (history),
 * and whether the last real charge came at another price. "Não apareceu" = active, 3+ days past next_due.
 */
export function subState(s: Subscription, tx: Transaction[]) {
  const charges = tx.filter((t) => t.subscription_id === s.id).sort((a, b) => b.date.localeCompare(a.date))
  const last = charges[0]
  const inDays = daysFrom(s.next_due)
  const flag: SubFlag = s.status !== 'active' ? s.status
    : inDays < -3 ? 'missing' : inDays < 0 ? 'late' : inDays <= s.remind_days ? 'soon' : 'later'
  const priceChanged = last && Math.abs(last.amount - s.amount) >= 0.005 ? last.amount : null
  const year = today().slice(0, 4)
  const yearTotal = cents(charges.filter((t) => t.date.startsWith(year)).reduce((x, t) => x + spendOf(t), 0))
  return { charges, last, inDays, flag, priceChanged, yearTotal, attention: flag === 'missing' || flag === 'late' || priceChanged !== null }
}

/** "Em 2 dias", "Cobra hoje", "Venceu há 2 dias", "Não apareceu", "Renova 15/jan" (yearly, far off). */
export function subDueLabel(s: Subscription, inDays: number) {
  if (s.status === 'paused') return 'Pausada'
  if (s.status === 'canceled') return 'Cancelada'
  if (inDays < -3) return 'Não apareceu'
  if (inDays < 0) return inDays === -1 ? 'Venceu ontem' : `Venceu há ${-inDays} dias`
  if (inDays === 0) return 'Cobra hoje'
  if (inDays === 1) return 'Cobra amanhã'
  if (s.cycle === 'yearly' && inDays > 31) return `Renova ${parseISO(s.next_due).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }).replace('.', '').replace(' de ', '/')}`
  return `Em ${inDays} dias`
}

const fold = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
/** Does this spend's merchant contain the subscription's match (or name)? Accent- and case-blind. */
export const merchantMatches = (s: Subscription, merchant: string) => {
  const needle = fold(s.match || s.name)
  return needle.length > 0 && fold(merchant).includes(needle)
}

/** "Vincular gasto…": unlinked spends within ±7 days of the charge date, at a price within ±15% or with a matching merchant. */
export function linkCandidates(s: Subscription, tx: Transaction[]) {
  return tx.filter((t) => !t.subscription_id && Math.abs(daysFrom(t.date, s.next_due)) <= 7
    && (Math.abs(t.amount - s.amount) <= s.amount * 0.15 || merchantMatches(s, t.merchant)))
    .sort((a, b) => Number(merchantMatches(s, b.merchant)) - Number(merchantMatches(s, a.merchant)) || Math.abs(daysFrom(a.date, s.next_due)) - Math.abs(daysFrom(b.date, s.next_due)))
}
