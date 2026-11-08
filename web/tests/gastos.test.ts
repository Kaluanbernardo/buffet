import { describe, expect, it } from 'vitest'
import { categoryShare, methodCategoryFlow, owedOf, PAY_ORIGIN_LABEL, payMatches, payOrigin, spendOf, spendScope, treemapRects, type PayFilter } from '../src/data/derive'
import { CAT_COLORS, NEUTRAL_MARK, catColor } from '../src/lib/colors'
import type { BuffetData, PayMethod, Transaction } from '../src/data/types'

// Synthetic numbers only.
const REF = '2030-06-15'
let n = 0
const tx = (o: Partial<Transaction> & { amount: number }): Transaction => ({ id: `t${++n}`, date: '2030-06-10', merchant: 'Loja teste', category: 'Mercado', ...o })
const data = (transactions: Transaction[], cardPayments: BuffetData['cardPayments'] = []): BuffetData => ({
  transactions, cardPayments, subscriptions: [], budgets: [], debts: [], reserves: [], investments: [], incomes: {},
  config: { categories: [], banks: [] },
})
const total = (rows: Transaction[]) => Math.round(rows.reduce((s, t) => s + spendOf(t), 0) * 100) / 100
const cents = (v: number) => Math.round(v * 100) / 100
const flowTotal = (rows: Transaction[]) => methodCategoryFlow(rows).total

describe('categoryShare', () => {
  it('lists every category, keeps a real Outros row and emits no synthetic tail bucket', () => {
    const cats = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Outros']
    const slices = categoryShare(cats.map((category, i) => tx({ category, amount: 100 - i * 10 })))
    expect(slices.map((s) => s.key).sort()).toEqual([...cats].sort())
    expect(slices.some((s) => /^(outras|others)$/i.test(s.key))).toBe(false)
    expect(slices.find((s) => s.key === 'Outros')?.value).toBe(30)
    expect(slices.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1)
  })

  it('keeps unknown names as separate rows', () => {
    const slices = categoryShare([tx({ category: 'Zeta', amount: 5 }), tx({ category: 'Eta', amount: 5 })])
    expect(slices.map((s) => s.key)).toEqual(['Eta', 'Zeta'])
  })
})

describe('category colors', () => {
  it('keeps the previous hex values for known categories', () => {
    expect({ ...CAT_COLORS, Outros: undefined }).toMatchObject({
      Alimentação: '#2097ed', Transporte: '#a87848', Moradia: '#1b9b70', Saúde: '#98982c', Lazer: '#e363ae', Assinaturas: '#6e57e1',
      Educação: '#3b7689', Vestimenta: '#9848a8', Mercado: '#558217', Doação: '#c31078', Fitness: '#756432', Jogos: '#d8572a',
      'Pró-vida': '#2fa3a3', 'Telefonia e internet': '#5b6ee1', Pet: '#b5651d', Impostos: '#7a4fb8',
    })
    expect(NEUTRAL_MARK).toBe('#5b6675')
  })

  it('gives Outros a stable colour distinct from every other one', () => {
    const others = Object.entries(CAT_COLORS).filter(([k]) => k !== 'Outros').map(([, v]) => v)
    expect(catColor('Outros')).toBe(catColor('Outros'))
    expect(others).not.toContain(catColor('Outros'))
    expect(catColor('Outros')).not.toBe(NEUTRAL_MARK)
  })

  it('falls back deterministically, per name, without the neutral', () => {
    expect(catColor('Inventada')).toBe(catColor('Inventada'))
    expect(catColor('Inventada')).not.toBe(catColor('Outra inventada'))
    expect(catColor('Inventada')).not.toBe(NEUTRAL_MARK)
  })
})

describe('methodCategoryFlow', () => {
  const rows = [
    tx({ method: 'credit', category: 'Mercado', amount: 30 }), tx({ method: 'credit', category: 'Pet', amount: 10 }),
    tx({ method: 'debit', category: 'Mercado', amount: 20 }), tx({ method: 'pix', category: 'Pet', amount: 5.5 }),
    tx({ method: 'cash', category: 'Outros', amount: 4.5 }), tx({ category: 'Lazer', amount: 12 }),
  ]
  const flow = methodCategoryFlow(rows)

  it('conserves the total across links, origins, categories and categoryShare', () => {
    const sum = (xs: { value: number }[]) => cents(xs.reduce((s, x) => s + x.value, 0))
    expect(flow.total).toBe(82)
    expect(sum(flow.links)).toBe(flow.total)
    expect(sum(flow.origins)).toBe(flow.total)
    expect(sum(flow.categories)).toBe(flow.total)
    expect(sum(categoryShare(rows))).toBe(flow.total)
    expect(flow.categories.map((c) => c.key)).toEqual(categoryShare(rows).map((s) => s.key))
  })

  it('orders origins crédito, débito, pix, dinheiro, não informada and drops empty ones', () => {
    expect(flow.origins.map((o) => o.key)).toEqual(['credit', 'debit', 'pix', 'cash', 'unknown'])
    expect(flow.origins.map((o) => o.label)).toEqual(['Crédito', 'Débito', 'PIX', 'Dinheiro', 'Forma não informada'])
    const some = methodCategoryFlow([tx({ method: 'pix', amount: 1 }), tx({ method: 'credit', amount: 1 })])
    expect(some.origins.map((o) => o.key)).toEqual(['credit', 'pix'])
  })

  it('links each method to the category of the same row', () => {
    const link = (source: string, category: string) => flow.links.find((l) => l.source === source && l.category === category)?.value
    expect(link('credit', 'Mercado')).toBe(30)
    expect(link('debit', 'Mercado')).toBe(20)
    expect(link('pix', 'Pet')).toBe(5.5)
    expect(link('credit', 'Pet')).toBe(10)
    expect(link('debit', 'Pet')).toBeUndefined()
  })

  it('weighs split rows by amount minus reimbursed: none, partial, full', () => {
    const split = { split_share_pct: 60, partner_amount: 40, method: 'pix' as const }
    const w = (r?: number) => methodCategoryFlow([tx({ amount: 100, ...split, ...(r === undefined ? {} : { reimbursed_amount: r }) })])
    expect(w().links[0].value).toBe(100)
    expect(w(15).links[0].value).toBe(85)
    expect(w(40).links[0].value).toBe(60)
    expect(w(40).total).toBe(60)
  })

  it('reads a missing method as "não informada", even with bank or bill_month set', () => {
    expect(payOrigin({})).toBe('unknown')
    expect(payOrigin({ method: 'cash' })).toBe('cash')
    expect(PAY_ORIGIN_LABEL.unknown).toBe('Forma não informada')
    const f = methodCategoryFlow([tx({ amount: 10 }), tx({ amount: 5, bank: 'Banco teste' }), tx({ amount: 7, bill_month: '2030-07' })])
    expect(f.links).toEqual([{ source: 'unknown', category: 'Mercado', value: 22 }])
    expect(f.origins).toEqual([{ key: 'unknown', label: 'Forma não informada', value: 22 }])
  })

  it('keeps a real Outros and invents no Outras bucket', () => {
    const cats = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Outros']
    const f = methodCategoryFlow(cats.map((category, i) => tx({ category, amount: 100 - i * 10, method: 'debit' })))
    expect(f.categories.map((c) => c.key).sort()).toEqual([...cats].sort())
    expect(f.categories.some((c) => /^(outras|others)$/i.test(c.key))).toBe(false)
    expect(f.links.find((l) => l.category === 'Outros')?.value).toBe(30)
  })

  it('ignores rows with no spend left', () => {
    const f = methodCategoryFlow([tx({ amount: 50, reimbursed_amount: 50, method: 'pix' }), tx({ amount: 0 }), tx({ amount: 8, method: 'debit' })])
    expect(f.links).toEqual([{ source: 'debit', category: 'Mercado', value: 8 }])
    expect(methodCategoryFlow([])).toEqual({ origins: [], categories: [], links: [], total: 0 })
  })

  it('counts a credit expense and not a card bill payment', () => {
    const d = data([tx({ method: 'credit', amount: 80, bill_month: '2030-07' })], [{ id: 'p1', date: '2030-06-12', amount: 500, card_bank: 'Banco teste' }])
    const f = methodCategoryFlow(spendScope(d, 'todos', REF))
    expect(f.links).toEqual([{ source: 'credit', category: 'Mercado', value: 80 }])
    expect(f.total).toBe(80)
  })

  it('leaves a future installment out', () => {
    const plan = { debt_id: 'd1', category: 'Vestimenta', method: 'credit' as const }
    const d = data([tx({ ...plan, date: '2030-06-10', amount: 100 }), tx({ ...plan, date: '2030-07-10', amount: 100 })])
    expect(flowTotal(spendScope(d, 'todos', REF))).toBe(100)
  })

  it('shows cash only under Todos', () => {
    const d = data([tx({ method: 'cash', amount: 9 }), tx({ method: 'pix', amount: 4 })])
    expect(methodCategoryFlow(spendScope(d, 'todos', REF)).origins.map((o) => o.key)).toEqual(['pix', 'cash'])
    for (const f of ['credit', 'debit', 'pix'] as const) {
      expect(methodCategoryFlow(spendScope(d, f, REF)).origins.some((o) => o.key === 'cash')).toBe(false)
    }
  })

  it('category and payment filters change both charts together', () => {
    const d = data(rows)
    const apply = (pay: PayFilter, cat: string | null) => spendScope(d, pay, REF).filter((t) => !cat || t.category === cat)
    const both = (pay: PayFilter, cat: string | null) => {
      const r = apply(pay, cat)
      return { tree: categoryShare(r).reduce((s, x) => s + x.value, 0), sankey: methodCategoryFlow(r).total, keys: categoryShare(r).map((s) => s.key), cats: methodCategoryFlow(r).categories.map((c) => c.key) }
    }
    const all = both('todos', null)
    expect(cents(all.tree)).toBe(all.sankey)
    const mercado = both('todos', 'Mercado')
    expect(mercado).toMatchObject({ sankey: 50, keys: ['Mercado'], cats: ['Mercado'] })
    const credit = both('credit', null)
    expect(credit).toMatchObject({ sankey: 40, keys: ['Mercado', 'Pet'], cats: ['Mercado', 'Pet'] })
    expect(methodCategoryFlow(apply('credit', null)).origins.map((o) => o.key)).toEqual(['credit'])
    const both2 = both('credit', 'Pet')
    expect(both2).toMatchObject({ sankey: 10, keys: ['Pet'], cats: ['Pet'] })
  })
})

describe('treemapRects', () => {
  const slices = [{ key: 'A', value: 50 }, { key: 'B', value: 30 }, { key: 'C', value: 12 }, { key: 'D', value: 5 }, { key: 'E', value: 3 }]
  const area = (r: { w: number; h: number }) => r.w * r.h

  it('fills the box with areas proportional to value', () => {
    const W = 320, H = 180
    const rects = treemapRects(slices, W, H)
    expect(rects.map((r) => r.key).sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
    const sum = rects.reduce((s, r) => s + area(r), 0)
    expect(Math.abs(sum - W * H) / (W * H)).toBeLessThan(0.01)
    for (const r of rects) {
      const want = r.value / 100
      expect(Math.abs(area(r) / (W * H) - want)).toBeLessThan(0.01)
      expect(r.x).toBeGreaterThanOrEqual(-1e-6)
      expect(r.y).toBeGreaterThanOrEqual(-1e-6)
      expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-6)
      expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-6)
    }
  })

  it('does not overlap', () => {
    const rects = treemapRects(slices, 300, 200)
    for (const a of rects) for (const b of rects) {
      if (a === b) continue
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      expect(ox > 1e-6 && oy > 1e-6).toBe(false)
    }
  })

  it('handles one slice, empty and all-zero input', () => {
    expect(treemapRects([{ key: 'A', value: 7 }], 100, 50)).toEqual([{ key: 'A', x: 0, y: 0, w: 100, h: 50, value: 7 }])
    expect(treemapRects([], 100, 50)).toEqual([])
    expect(treemapRects([{ key: 'A', value: 0 }], 100, 50)).toEqual([])
    expect(treemapRects(slices, 0, 50)).toEqual([])
  })
})

describe('payment filter', () => {
  const methods: (PayMethod | undefined)[] = ['credit', 'debit', 'pix', 'cash', undefined]
  const rows = methods.map((method, i) => tx({ method, amount: 10 + i }))
  const pick = (f: PayFilter) => spendScope(data(rows), f, REF).map((t) => t.method)

  it('todos keeps every method, including cash and unknown', () => {
    expect(pick('todos')).toEqual(methods)
  })
  it.each(['credit', 'debit', 'pix'] as const)('%s is exact', (f) => {
    expect(pick(f)).toEqual([f])
  })
  it('does not read an unknown method as debit or pix, and cash is only in todos', () => {
    expect(payMatches({}, 'debit')).toBe(false)
    expect(payMatches({}, 'pix')).toBe(false)
    expect(payMatches({}, 'credit')).toBe(false)
    expect(payMatches({ method: 'cash' }, 'todos')).toBe(true)
    for (const f of ['credit', 'debit', 'pix'] as const) expect(payMatches({ method: 'cash' }, f)).toBe(false)
  })
})

describe('spend scope', () => {
  it('counts a credit expense by default and never a card bill payment', () => {
    const d = data([tx({ method: 'credit', amount: 80, bill_month: '2030-07' })], [{ id: 'p1', date: '2030-06-12', amount: 500, card_bank: 'Banco teste' }])
    const scope = spendScope(d, 'todos', REF)
    expect(scope).toHaveLength(1)
    expect(total(scope)).toBe(80)
  })

  it('leaves a future installment out of the current period and counts the one in it once, without the principal', () => {
    const plan = { debt_id: 'd1', category: 'Vestimenta', method: 'credit' as const }
    const rows = [
      tx({ ...plan, date: '2030-05-10', amount: 100, installment_no: 1 }),
      tx({ ...plan, date: '2030-06-10', amount: 100, installment_no: 2 }),
      tx({ ...plan, date: '2030-07-10', amount: 100, installment_no: 3 }),
    ]
    const d = { ...data(rows), debts: [{ id: 'd1', description: 'Plano teste', bank: 'Banco teste', installment_amount: 100, installments_paid: 1, installments_total: 3, due_day: 10, kind: 'installments' as const, total_amount: 300 }] }
    const scope = spendScope(d, 'todos', REF)
    const june = scope.filter((t) => t.date.startsWith('2030-06'))
    expect(scope.map((t) => t.installment_no)).toEqual([1, 2])
    expect(june.map((t) => t.installment_no)).toEqual([2])
    expect(total(june)).toBe(100)
    expect(categoryShare(june)).toEqual([{ key: 'Vestimenta', value: 100, share: 1 }])
  })
})

describe('split rows weigh through spendOf', () => {
  const split = { split_share_pct: 60, partner_amount: 40 } // contractual personal share would be 60
  const weight = (r?: number) => {
    const t = tx({ amount: 100, ...split, ...(r === undefined ? {} : { reimbursed_amount: r }) })
    return { t, w: flowTotal([t]), share: categoryShare([t])[0].value }
  }

  it('unpaid: the full amount', () => {
    const { w, share } = weight()
    expect([w, share]).toEqual([100, 100])
  })
  it('partial reimbursement: amount minus reimbursed_amount', () => {
    const { t, w, share } = weight(15)
    expect([w, share]).toEqual([85, 85])
    expect(w).not.toBe(60) // not the contractual share
    expect(w).not.toBe(60 - 15) // not share minus reimbursement
    expect(owedOf(t)).toBe(25) // A receber stays the pending partner portion
  })
  it('full reimbursement: amount minus reimbursed_amount', () => {
    const { t, w, share } = weight(40)
    expect([w, share]).toEqual([60, 60])
    expect(owedOf(t)).toBe(0)
  })
})
