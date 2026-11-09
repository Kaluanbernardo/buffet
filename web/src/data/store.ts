/**
 * Data abstraction. With VITE_SUPABASE_* = Supabase (buffet_* tables in the shared fitness project; the chat writes
 * there too via scripts/buffet). Without = F0 localStorage. Screens only use useBuffet().
 */
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BudgetGroup, BuffetData, NotificationRefund, ReviewAction, SplitAction, Subscription, Transaction } from './types'
import { applyReview, applySplit } from './derive'
import { DEFAULT_CATEGORIES, seed } from './seed'
import { setValuesHidden, valuesHidden } from '../lib/format'
import { supabase } from '../lib/supabase'

export interface DataStore {
  load(): Promise<BuffetData>
  save(data: BuffetData): Promise<void>
  /** Splitting and reimbursing run on their own (never through save): they also move cash_balance, atomically. */
  split(action: SplitAction): Promise<void>
  /** Confirming, editing or discarding a spend that came from a notification: same, on its own (cash and bill move with it). */
  review(action: ReviewAction): Promise<void>
  /** Remote stores re-load when the app comes back to the foreground (picks up expenses logged from the chat). */
  remote?: boolean
}

const KEY = 'buffet_data_v1'

const GROUPS: BudgetGroup[] = ['essenciais', 'lifestyle', 'metas']

/**
 * Bring any older saved shape up to date without losing rows: missing collections come from the seed,
 * `incomes` (added with the YNAB-style budget) starts empty and drops non-numeric entries, every configured
 * category gets a budget row, and an unknown `group` falls back to the default for that category.
 */
/** Saved list plus any default category it predates (e.g. Mercado, Doação, Fitness), kept before Outros. */
export const withDefaults = (cats: string[] = []) => {
  const missing = DEFAULT_CATEGORIES.filter((c) => !cats.includes(c))
  if (missing.length === 0) return cats
  const at = cats.indexOf('Outros')
  return at < 0 ? [...cats, ...missing.filter((c) => c !== 'Outros'), ...(missing.includes('Outros') ? ['Outros'] : [])] : [...cats.slice(0, at), ...missing, ...cats.slice(at)]
}

export function migrate(raw: Partial<BuffetData>): BuffetData {
  const base = seed()
  const d = { ...base, ...raw, config: { ...base.config, ...raw.config } } as BuffetData
  d.config.categories = withDefaults(d.config.categories)
  const incomes: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw.incomes ?? {})) if (/^\d{4}-\d{2}$/.test(k) && Number.isFinite(v) && v >= 0) incomes[k] = v
  const budgets = (Array.isArray(d.budgets) ? d.budgets : []).map((b) =>
    (b.group && !GROUPS.includes(b.group) ? { category: b.category, monthly_limit: b.monthly_limit } : b))
  for (const c of d.config.categories) if (!budgets.some((b) => b.category === c)) budgets.push({ category: c, monthly_limit: 0 })
  return { ...d, budgets, incomes, subscriptions: Array.isArray(d.subscriptions) ? d.subscriptions : [] }
}

export const localStore: DataStore = {
  async load() {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        const data = migrate(JSON.parse(raw))
        localStorage.setItem(KEY, JSON.stringify(data))
        return data
      }
    } catch { /* corrupted → reseed */ }
    const s = seed()
    localStorage.setItem(KEY, JSON.stringify(s))
    return s
  },
  async save(data) { localStorage.setItem(KEY, JSON.stringify(data)) },
  async split(action) { await this.save(applySplit(await this.load(), action)) },
  async review(action) { await this.save(applyReview(await this.load(), action)) },
}

type Row = Record<string, unknown>
const num = (v: unknown) => Number(v ?? 0)
const str = (v: unknown) => (v == null ? '' : String(v))
const opt = (v: unknown) => (v == null || v === '' ? undefined : String(v))

/**
 * One synced collection: app items ⇄ table rows, keyed by `key` (row column = item field). `toRow` holds what the app
 * edits, so an edit never overwrites what only the chat writes. `insertRow`: every column, for a row the database doesn't
 * have — a new one, or a deleted one coming back through "Desfazer".
 */
type Spec<T> = { table: string; key: string; stamp?: boolean; items: (d: BuffetData) => T[]; toRow: (x: T) => Row; insertRow?: (x: T) => Row; keyOf: (x: T) => string }

/**
 * Synced collections, in write order: subscriptions before transactions so a new subscription exists before a
 * spend points at it. Without the subscriptions migration (`subs` false) that table is skipped and
 * subscription_id stays out of the transaction rows (upsert leaves columns it doesn't send untouched).
 */
const txRow = (t: Transaction, subs: boolean): Row => ({ id: t.id, date: t.date, amount: t.amount, merchant: t.merchant, category: t.category, bank: t.bank ?? null, note: t.note ?? null,
  ...(subs ? { subscription_id: t.subscription_id ?? null } : {}) })

const makeSpecs = (subs: boolean): Spec<any>[] => [
  ...(subs ? [{ table: 'buffet_subscriptions', stamp: true, key: 'id', items: (d: BuffetData) => d.subscriptions, keyOf: (x: Subscription) => x.id,
    toRow: (x: Subscription) => ({ id: x.id, name: x.name, amount: x.amount, cycle: x.cycle, next_due: x.next_due, bank: x.bank || null,
      category: x.category, status: x.status, remind_days: x.remind_days, match: x.match || null, cancel_hint: x.cancel_hint || null,
      note: x.note || null, started_on: x.started_on || null, canceled_on: x.canceled_on || null }) }] : []),
  { table: 'buffet_transactions', key: 'id', items: (d) => d.transactions, keyOf: (t) => t.id,
    toRow: (t) => txRow(t, subs),
    // partner_amount and effective_amount are generated by the database.
    insertRow: (t) => ({ ...txRow(t, subs), method: t.method ?? null, bill_month: t.bill_month ?? null, debt_id: t.debt_id ?? null, installment_no: t.installment_no ?? null,
      split_share_pct: t.split_share_pct ?? null, reimbursed_amount: t.reimbursed_amount ?? null, reimbursed_cash: t.reimbursed_cash ?? null, reimbursed_at: t.reimbursed_at ?? null,
      // Only rows that came from a notification carry these (they exist once its migration is applied).
      ...(t.review_status ? { review_status: t.review_status, notification_id: t.notification_id ?? null, cash_debited: t.cash_debited ?? null } : {}),
      source: t.source ?? 'app', created_at: t.created_at ?? new Date().toISOString() }) },
  { table: 'buffet_budgets', stamp: true, key: 'category', items: (d) => d.budgets, keyOf: (b) => b.category,
    toRow: (b) => ({ category: b.category, monthly_limit: b.monthly_limit, group_name: b.group ?? null }) },
  { table: 'buffet_debts', key: 'id', items: (d) => d.debts, keyOf: (x) => x.id,
    toRow: (x) => ({ id: x.id, description: x.description, bank: x.bank || null, installment_amount: x.installment_amount,
      installments_paid: x.installments_paid, installments_total: x.installments_total, due_day: x.due_day || null }) },
  { table: 'buffet_reserves', stamp: true, key: 'id', items: (d) => d.reserves, keyOf: (x) => x.id,
    toRow: (x) => ({ id: x.id, name: x.name, target: x.target, current: x.current }) },
  { table: 'buffet_investments', stamp: true, key: 'id', items: (d) => d.investments, keyOf: (x) => x.id,
    toRow: (x) => ({ id: x.id, name: x.name, kind: x.kind || null, institution: x.institution || null, amount: x.amount }) },
  { table: 'buffet_incomes', stamp: true, key: 'month', items: (d) => Object.entries(d.incomes).map(([month, amount]) => ({ month, amount })), keyOf: (x) => x.month,
    toRow: (x) => ({ month: x.month, amount: x.amount }) },
  { table: 'buffet_app_config', stamp: true, key: 'user_id', items: (d) => (d.config ? [d.config] : []), keyOf: () => 'config',
    toRow: (c) => ({ categories: c.categories, banks: c.banks }) },
]

/** PostgREST/Postgres "no such table": the subscriptions migration hasn't been applied yet. */
const missingTable = (e: { code?: string; message: string }) =>
  e.code === 'PGRST205' || e.code === '42P01' || /does not exist|schema cache/i.test(e.message)

/**
 * Supabase store. save() diffs against the last loaded/saved snapshot and only upserts changed items / deletes
 * removed ones (source='app'), so rows the chat inserted meanwhile are never overwritten by a stale full copy.
 * First load on a fresh account (no buffet_app_config row) carries over this device's F0 localStorage data once.
 */
export function supabaseStore(sb: SupabaseClient): DataStore {
  let last: BuffetData | null = null
  let uid = ''
  let ready = true
  const fetchAll = async (table: string) => {
    const { data, error } = await sb.from(table).select('*')
    if (error) throw new Error(`${table}: ${error.message}`)
    return (data ?? []) as Row[]
  }
  /** Refunds waiting for review. Auxiliary: without the migration (or on any error) the list is empty and the app loads anyway. */
  const loadRefunds = async (): Promise<NotificationRefund[]> => {
    const { data, error } = await sb.from('buffet_notification_inbox').select('id, posted_at, bank, amount, merchant, title, body')
      .eq('status', 'refund').order('posted_at', { ascending: false }).limit(50)
    if (error) { if (!missingTable(error)) console.error(`buffet_notification_inbox: ${error.message}`); return [] }
    return (data ?? []).map((r: Row) => ({ id: str(r.id), posted_at: str(r.posted_at), bank: opt(r.bank), amount: r.amount == null ? undefined : num(r.amount),
      merchant: opt(r.merchant), title: opt(r.title), body: opt(r.body) }))
  }
  return {
    remote: true,
    async load() {
      uid = (await sb.auth.getUser()).data.user?.id ?? ''
      // Probe subscriptions first: until its migration runs the app keeps working without them.
      const probe = await sb.from('buffet_subscriptions').select('*')
      if (probe.error && !missingTable(probe.error)) throw new Error(`buffet_subscriptions: ${probe.error.message}`)
      ready = !probe.error
      const subs = (probe.data ?? []) as Row[]
      // Card payments are only read (not a Spec): the app never writes or deletes them.
      const tables = ['buffet_transactions', 'buffet_budgets', 'buffet_debts', 'buffet_reserves', 'buffet_investments', 'buffet_incomes', 'buffet_app_config', 'buffet_card_payments']
      const [tx, budgets, debts, reserves, investments, incomes, config, bills] = await Promise.all(tables.map(fetchAll))
      const refunds = await loadRefunds()
      const cfg = config[0]
      const data = migrate({
        subscriptionsReady: ready,
        transactions: tx.map((r) => ({ id: str(r.id), date: str(r.date), amount: num(r.amount), merchant: str(r.merchant), category: str(r.category), bank: opt(r.bank), note: opt(r.note),
          ...(r.subscription_id ? { subscription_id: str(r.subscription_id) } : {}),
          // Read-only in the app (the chat writes them): not in toRow, so the app's upserts never clear them.
          ...(r.method ? { method: str(r.method) as Transaction['method'] } : {}), ...(r.bill_month ? { bill_month: str(r.bill_month) } : {}),
          ...(r.debt_id ? { debt_id: str(r.debt_id), installment_no: num(r.installment_no) } : {}),
          ...(r.split_share_pct == null ? {} : { split_share_pct: num(r.split_share_pct), partner_amount: num(r.partner_amount) }),
          ...(r.reimbursed_amount == null ? {} : { reimbursed_amount: num(r.reimbursed_amount), reimbursed_cash: num(r.reimbursed_cash), reimbursed_at: str(r.reimbursed_at) }),
          // From a notification: written by the Edge Function, reviewed through public.buffet_tx_review/discard only.
          ...(r.review_status === 'pending' || r.review_status === 'confirmed' ? { review_status: r.review_status, notification_id: opt(r.notification_id),
            cash_debited: num(r.cash_debited), ...(r.possible_duplicate_of ? { possible_duplicate_of: str(r.possible_duplicate_of) } : {}) } : {}),
          source: r.source === 'bot' || r.source === 'notificacao' ? r.source : 'app' as const, created_at: str(r.created_at) })),
        subscriptions: subs.map((r) => ({ id: str(r.id), name: str(r.name), amount: num(r.amount), cycle: r.cycle === 'yearly' ? 'yearly' : 'monthly',
          next_due: str(r.next_due), bank: opt(r.bank), category: str(r.category) || 'Assinaturas',
          status: r.status === 'paused' || r.status === 'canceled' ? r.status : 'active', remind_days: num(r.remind_days),
          match: opt(r.match), cancel_hint: opt(r.cancel_hint), note: opt(r.note), started_on: opt(r.started_on), canceled_on: opt(r.canceled_on) })),
        refunds,
        cardPayments: bills.map((r) => ({ id: str(r.id), date: str(r.date), amount: num(r.amount), card_bank: str(r.card_bank), paid_from: opt(r.paid_from), note: opt(r.note), bill_month: opt(r.bill_month) })),
        budgets: budgets.map((r) => ({ category: str(r.category), monthly_limit: num(r.monthly_limit), ...(r.group_name ? { group: r.group_name as BudgetGroup } : {}) })),
        debts: debts.map((r) => ({ id: str(r.id), description: str(r.description), bank: str(r.bank), installment_amount: num(r.installment_amount),
          installments_paid: num(r.installments_paid), installments_total: num(r.installments_total) || 1, due_day: num(r.due_day) || 1,
          kind: r.kind === 'bill' || r.kind === 'loan' ? r.kind : 'installments', card: opt(r.card),
          total_amount: r.total_amount == null ? undefined : num(r.total_amount), purchase_date: opt(r.purchase_date), first_bill: opt(r.first_bill) })),
        reserves: reserves.map((r) => ({ id: str(r.id), name: str(r.name), target: num(r.target), current: num(r.current) })),
        investments: investments.map((r) => ({ id: str(r.id), name: str(r.name), kind: str(r.kind), institution: str(r.institution), amount: num(r.amount) })),
        incomes: Object.fromEntries(incomes.map((r) => [str(r.month), num(r.amount)])),
        ...(cfg ? { config: { categories: withDefaults(cfg.categories as string[]), banks: cfg.banks as BuffetData['config']['banks'],
          cash_balance: cfg.cash_balance == null || !Number.isFinite(Number(cfg.cash_balance)) ? null : Number(cfg.cash_balance) } } : {}),
      })
      if (cfg) { last = data; return data }
      // Fresh account: seed config/budgets (or this device's F0 data) and write it all.
      let local: Partial<BuffetData> = {}
      try { local = JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { /* ignore */ }
      const base = migrate({ ...seed(), ...local })
      const ids = new Set(data.transactions.map((t) => t.id))
      const first: BuffetData = { ...base, cardPayments: data.cardPayments, transactions: [...data.transactions, ...base.transactions.filter((t) => !ids.has(t.id) && !t.id.startsWith('seed-'))] }
      last = { ...data, config: undefined as unknown as BuffetData['config'] }   // config row doesn't exist yet → gets written
      await this.save(first)
      return first
    },
    async save(next) {
      const prev = last
      const now = new Date().toISOString()
      for (const s of makeSpecs(ready)) {
        const before = new Map((prev ? s.items(prev) : []).map((x) => [s.keyOf(x), JSON.stringify(s.toRow(x))]))
        const items = s.items(next)
        const onConflict = s.key === 'id' || s.key === 'user_id' ? s.key : `user_id,${s.key}`
        const write = async (rows: Row[]) => {
          if (!rows.length) return
          const { error } = await sb.from(s.table).upsert(rows.map((r) => ({ user_id: uid, source: 'app', ...(s.stamp ? { updated_at: now } : {}), ...r })), { onConflict })
          if (error) throw new Error(`${s.table}: ${error.message}`)
        }
        // Two batches: one upsert fills the columns a row leaves out with null, so edits can't share one with full rows.
        await write(items.filter((x) => !before.has(s.keyOf(x))).map((x) => (s.insertRow ?? s.toRow)(x)))
        await write(items.filter((x) => { const b = before.get(s.keyOf(x)); return b !== undefined && b !== JSON.stringify(s.toRow(x)) }).map((x) => ({ ...s.toRow(x), source: 'app' })))
        const keep = new Set(items.map(s.keyOf))
        const removed = [...before.keys()].filter((k) => !keep.has(k))
        if (removed.length && s.key !== 'user_id') {
          const { error } = await sb.from(s.table).delete().in(s.key, removed)
          if (error) throw new Error(`${s.table}: ${error.message}`)
        }
      }
      last = next
    },
    async split(a) {
      const { error } = await (
        a.kind === 'split' ? sb.rpc('buffet_tx_split', { p_id: a.id, p_share: a.share })
        : a.kind === 'unsplit' ? sb.rpc('buffet_tx_unsplit', { p_id: a.id })
        : a.kind === 'reimburse' ? sb.rpc('buffet_tx_reimburse', { p_id: a.id, p_amount: a.amount ?? null, p_date: a.date ?? null, p_cash: a.cash })
        : sb.rpc('buffet_tx_unreimburse', { p_id: a.id }))
      if (error) throw new Error(error.message)
    },
    async review(a) {
      const call = (fn: string, args: Record<string, unknown>) => sb.rpc(fn, args).then(({ error }) => { if (error) throw new Error(error.message) })
      if (a.kind === 'review') await call('buffet_tx_review', { p_id: a.id, p_patch: a.patch, p_confirm: a.confirm })
      else if (a.kind === 'discard') await call('buffet_tx_discard', { p_id: a.id })
      else if (a.kind === 'dismiss') await call('buffet_notif_dismiss', { p_id: a.id })
      else for (const id of a.ids) await call('buffet_tx_review', { p_id: id, p_patch: {}, p_confirm: true })
    },
  }
}

export const store: DataStore = supabase ? supabaseStore(supabase) : localStore

type Ctx = {
  data: BuffetData; update: (fn: (d: BuffetData) => BuffetData) => void
  /** Runs after pending saves, then reloads, so the screen shows what the database now holds. Rejects if it didn't happen. */
  splitAction: (action: SplitAction) => Promise<void>
  /** Same contract, for pending spends from notifications (confirm/edit/discard, dismiss a refund). */
  reviewAction: (action: ReviewAction) => Promise<void>
  /** Last failed save/load (remote store), shown as a banner. */
  syncError: string | null
  /** Values masked ("Ocultar valores"); in the context so every screen re-renders on toggle. */
  hidden: boolean; toggleHidden: () => void
}
const BuffetCtx = createContext<Ctx | null>(null)

export function BuffetProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<BuffetData | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // Saves (and foreground re-loads) run one at a time, in order.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = useCallback((job: () => Promise<void>) => {
    queue.current = queue.current.then(job).then(() => setSyncError(null), (e: unknown) => {
      console.error(e); setSyncError(e instanceof Error ? e.message : String(e))
    })
  }, [])
  useEffect(() => {
    enqueue(async () => setData(await store.load()))
    if (!store.remote) return
    const onVisible = () => { if (document.visibilityState === 'visible') enqueue(async () => setData(await store.load())) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enqueue])
  const update = useCallback((fn: (d: BuffetData) => BuffetData) => {
    setData((prev) => { if (!prev) return prev; const next = fn(prev); enqueue(() => store.save(next)); return next })
  }, [enqueue])
  // A database operation that moves money: after pending saves, then a reload so the screen shows what the database holds.
  const remote = useCallback((op: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    queue.current = queue.current.then(async () => {
      try { await op() } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return }
      // It happened; a failed reload only delays seeing it.
      try { setData(await store.load()); setSyncError(null) } catch (e) { console.error(e); setSyncError(e instanceof Error ? e.message : String(e)) }
      resolve()
    })
  }), [])
  const splitAction = useCallback((action: SplitAction) => remote(() => store.split(action)), [remote])
  const reviewAction = useCallback((action: ReviewAction) => remote(() => store.review(action)), [remote])
  const [hidden, setHidden] = useState(valuesHidden)
  const toggleHidden = useCallback(() => setHidden((h) => { setValuesHidden(!h); return !h }), [])
  if (!data) {
    return syncError
      ? createElement('div', { className: 'min-h-dvh grid place-items-center p-6' },
          createElement('div', { className: 'card max-w-sm p-6', role: 'alert' },
            createElement('h1', { className: 'mb-2 text-xl font-bold' }, 'Não deu para carregar os dados'),
            createElement('p', { className: 'text-sm text-muted' }, syncError),
            createElement('button', { className: 'btn mt-4 w-full', onClick: () => location.reload() }, 'Tentar de novo')))
      : null
  }
  return createElement(BuffetCtx.Provider, { value: { data, update, splitAction, reviewAction, syncError, hidden, toggleHidden } }, children)
}

export function useBuffet() {
  const c = useContext(BuffetCtx)
  if (!c) throw new Error('useBuffet fora do BuffetProvider')
  return c
}
