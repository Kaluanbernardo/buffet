import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySplit, owedOf, partnerOf, receivable, spendOf, splitState } from '../src/data/derive'
import type { BuffetData, SplitAction, Transaction } from '../src/data/types'

// Synthetic numbers only.
const REF = '2030-06-15'
const base = (o: Partial<Transaction> = {}): Transaction => ({ id: 'a1', date: '2030-06-10', merchant: 'Loja teste', category: 'Mercado', amount: 100, ...o })
const data = (transactions: Transaction[], cash: number | null = 500, cardPayments: BuffetData['cardPayments'] = []): BuffetData => ({
  transactions, cardPayments, subscriptions: [], budgets: [], debts: [], reserves: [], investments: [], incomes: {},
  config: { categories: [], banks: [], cash_balance: cash },
})
const run = (d: BuffetData, ...as: SplitAction[]) => as.reduce(applySplit, d)
const row = (d: BuffetData, id = 'a1') => d.transactions.find((t) => t.id === id)!
const root = resolve(__dirname, '../..')

describe('reembolso integral (parte 0%)', () => {
  it('share 0: partner = amount, owed = amount, spend stays full, cash unchanged, one row', () => {
    const d = run(data([base()]), { kind: 'split', id: 'a1', share: 0 })
    const t = row(d)
    expect(d.transactions).toHaveLength(1)
    expect(t.split_share_pct).toBe(0)
    expect(t.partner_amount).toBe(100)
    expect(partnerOf(100, 0)).toBe(100)
    expect(owedOf(t)).toBe(100)
    expect(spendOf(t)).toBe(100)
    expect(d.config.cash_balance).toBe(500)
    expect(receivable(d, REF)).toMatchObject({ total: 100, rows: [t] })
  })

  it('marking the same row share 0 again keeps one row and the cash', () => {
    const once = run(data([base()]), { kind: 'split', id: 'a1', share: 0 })
    const twice = run(once, { kind: 'split', id: 'a1', share: 0 })
    expect(twice.transactions).toHaveLength(1)
    expect(row(twice)).toEqual(row(once))
    expect(twice.config.cash_balance).toBe(500)
  })

  it('rejects 100 and negative shares, accepts 0', () => {
    const d = data([base()])
    expect(() => applySplit(d, { kind: 'split', id: 'a1', share: 100 })).toThrow()
    expect(() => applySplit(d, { kind: 'split', id: 'a1', share: -1 })).toThrow()
    expect(() => applySplit(d, { kind: 'split', id: 'a1', share: NaN })).toThrow()
    expect(() => applySplit(d, { kind: 'split', id: 'a1', share: 0 })).not.toThrow()
  })

  it('partial 15, then the rest, then a repeated reimburse throws without touching cash', () => {
    const d0 = run(data([base()]), { kind: 'split', id: 'a1', share: 0 })
    const d1 = run(d0, { kind: 'reimburse', id: 'a1', amount: 15, date: REF, cash: true })
    expect(owedOf(row(d1))).toBe(85)
    expect(spendOf(row(d1))).toBe(85)
    expect(d1.config.cash_balance).toBe(515)
    expect(splitState(row(d1))).toBe('partial')
    const d2 = run(d1, { kind: 'reimburse', id: 'a1', date: REF, cash: true })
    expect(owedOf(row(d2))).toBe(0)
    expect(spendOf(row(d2))).toBe(0)
    expect(d2.config.cash_balance).toBe(600)
    expect(splitState(row(d2))).toBe('reimbursed')
    expect(receivable(d2, REF).rows).toHaveLength(0)
    expect(() => applySplit(d2, { kind: 'reimburse', id: 'a1', amount: 85, date: REF, cash: true })).toThrow()
    expect(() => applySplit(d2, { kind: 'reimburse', id: 'a1', date: REF, cash: true })).toThrow()
    expect(d2.config.cash_balance).toBe(600)
  })

  it('unreimburse gives back reimbursed_cash once and owed returns to the full amount', () => {
    const d = run(data([base()]), { kind: 'split', id: 'a1', share: 0 }, { kind: 'reimburse', id: 'a1', amount: 40, date: REF, cash: true })
    expect(d.config.cash_balance).toBe(540)
    expect(row(d).reimbursed_cash).toBe(40)
    const u = applySplit(d, { kind: 'unreimburse', id: 'a1' })
    expect(u.config.cash_balance).toBe(500)
    expect(owedOf(row(u))).toBe(100)
    expect(spendOf(row(u))).toBe(100)
    expect(() => applySplit(u, { kind: 'unreimburse', id: 'a1' })).toThrow()
    expect(u.config.cash_balance).toBe(500)
  })

  it('cash is untouched when not requested or when cash_balance is null', () => {
    const noCash = run(data([base()]), { kind: 'split', id: 'a1', share: 0 }, { kind: 'reimburse', id: 'a1', amount: 15, date: REF, cash: false })
    expect(noCash.config.cash_balance).toBe(500)
    expect(row(noCash).reimbursed_cash).toBe(0)
    const nullCash = run(data([base()], null), { kind: 'split', id: 'a1', share: 0 }, { kind: 'reimburse', id: 'a1', amount: 15, date: REF, cash: true })
    expect(nullCash.config.cash_balance).toBeNull()
    expect(owedOf(row(nullCash))).toBe(85)
  })

  it('lowering the share to 0 after a partial reimbursement raises owed', () => {
    const d = run(data([base()]), { kind: 'split', id: 'a1', share: 50 }, { kind: 'reimburse', id: 'a1', amount: 15, date: REF, cash: true },
      { kind: 'split', id: 'a1', share: 0 })
    expect(owedOf(row(d))).toBe(85)
    expect(d.config.cash_balance).toBe(515)
  })
})

describe('legacy shares still work', () => {
  it.each([[50, 50], [60, 40]])('share %i: partner %i, reimburse capped at partner', (share, partner) => {
    const d = run(data([base()]), { kind: 'split', id: 'a1', share })
    expect(row(d).partner_amount).toBe(partner)
    expect(partnerOf(100, share)).toBe(partner)
    expect(owedOf(row(d))).toBe(partner)
    expect(() => applySplit(d, { kind: 'reimburse', id: 'a1', amount: partner + 1, date: REF, cash: true })).toThrow()
    const paid = run(d, { kind: 'reimburse', id: 'a1', date: REF, cash: true })
    expect(paid.config.cash_balance).toBe(500 + partner)
    expect(spendOf(row(paid))).toBe(100 - partner)
  })
})

describe('what stays out', () => {
  it('a debt_id row cannot be split and stays as it was', () => {
    const d = data([base({ debt_id: 'plano-teste' })])
    expect(() => applySplit(d, { kind: 'split', id: 'a1', share: 0 })).toThrow(/plano/)
    expect(() => applySplit(d, { kind: 'split', id: 'a1', share: 50 })).toThrow(/plano/)
    expect(row(d).split_share_pct).toBeUndefined()
    expect(row(d).partner_amount).toBeUndefined()
  })

  it('future rows are not receivable until their date; a card payment never is', () => {
    const d = run(data([base(), base({ id: 'f1', date: '2030-07-20' })], 500, [{ id: 'cp1', date: '2030-06-12', amount: 40 } as BuffetData['cardPayments'][number]]),
      { kind: 'split', id: 'a1', share: 0 }, { kind: 'split', id: 'f1', share: 0 })
    expect(receivable(d, REF).rows.map((t) => t.id)).toEqual(['a1'])
    expect(receivable(d, REF).total).toBe(100)
    expect(receivable(d, '2030-07-20').rows.map((t) => t.id)).toEqual(['a1', 'f1'])
    expect(receivable(d, REF).rows.some((t) => t.id === 'cp1')).toBe(false)
  })

  it('splitState treats share 0 as a split, not as null', () => {
    expect(splitState(base())).toBeNull()
    expect(splitState(base({ split_share_pct: 0, partner_amount: 100 }))).toBe('split')
    expect(splitState(base({ split_share_pct: 0, partner_amount: 100, reimbursed_amount: 15 }))).toBe('partial')
  })
})

describe('migration and CLI (source only)', () => {
  const sql = readFileSync(resolve(root, 'supabase/migrations/20261108160000_buffet_full_reimburse.sql'), 'utf8')

  it('migration relaxes the share check to allow 0 and still refuses installments', () => {
    expect(sql).toContain('split_share_pct >= 0 and split_share_pct < 100')
    expect(sql).toContain('v_share < 0 or v_share >= 100')
    expect(sql).toContain('v_partner <= 0')
    expect(sql).toMatch(/t\.debt_id is not null then raise exception 'parcela de plano não pode ser dividida'/)
    expect(sql).not.toMatch(/generated always/)
  })

  it('the historical migration is untouched', () => {
    const old = readFileSync(resolve(root, 'supabase/migrations/20261103120000_buffet_split_reimburse.sql'), 'utf8')
    expect(old).toContain('split_share_pct > 0 and split_share_pct < 100')
  })

  it('pshare accepts 0 and rejects 100 and negatives', () => {
    const py = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("buffet_cli", sys.argv[1])
spec = importlib.util.spec_from_loader("buffet_cli", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
out = [m.pshare("0"), m.pshare("0,5"), m.pshare("50"), m.pshare("99.99"), m.pshare(None)]
for bad in ("100", "-1", "abc"):
    try:
        m.pshare(bad); out.append("no-exit")
    except SystemExit:
        out.append("exit")
print(out)
`
    const r = spawnSync('python3', ['-I', '-B', '-c', py, resolve(root, 'scripts/buffet')], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout.trim()).toBe("[0.0, 0.5, 50.0, 99.99, 50.0, 'exit', 'exit', 'exit']")
  })

  it('the CLI still refuses --split together with --x', () => {
    expect(readFileSync(resolve(root, 'scripts/buffet'), 'utf8')).toContain('share is not None and o.get("x")')
  })
})
