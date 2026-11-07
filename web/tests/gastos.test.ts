import { describe, expect, it } from 'vitest'
import { categoryFlow, categoryShare, flowBands, owedOf, payMatches, spendOf, spendScope, type PayFilter } from '../src/data/derive'
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
const days = ['2030-06-01', '2030-06-02', '2030-06-03']

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

describe('category flow', () => {
  const rows = [
    tx({ date: days[0], category: 'Mercado', amount: 30 }), tx({ date: days[1], category: 'Mercado', amount: 10 }),
    tx({ date: days[1], category: 'Outros', amount: 20 }), tx({ date: days[2], category: 'Pet', amount: 40 }),
    tx({ date: '2030-07-01', category: 'Jogos', amount: 99 }), // outside the window
  ]
  const flow = categoryFlow(rows, days, (d) => d)

  it('includes every category in the window, Outros as its own row', () => {
    expect([...flow.cats].sort()).toEqual(['Mercado', 'Outros', 'Pet'])
    expect(flow.totals).toEqual([30, 30, 40])
  })

  it('stacked area starts every point at 0', () => {
    const { bands, base, min } = flowBands(flow, 'area')
    expect(base).toEqual([0, 0, 0])
    expect(bands[0].lo).toEqual([0, 0, 0])
    expect(min).toBe(0)
    expect(bands.map((b) => b.cat).sort()).toEqual(['Mercado', 'Outros', 'Pet'])
    expect(bands[bands.length - 1].hi).toEqual(flow.totals)
  })

  it('streamgraph is centred: baseline is minus half the day total', () => {
    const { bands, base, min, max } = flowBands(flow, 'stream')
    expect(base).toEqual([-15, -15, -20])
    expect(bands[0].lo).toEqual(base)
    expect(bands[bands.length - 1].hi).toEqual([15, 15, 20])
    expect(min).toBe(-20)
    expect(max).toBe(20)
    expect(bands.map((b) => b.cat).sort()).toEqual(['Mercado', 'Outros', 'Pet'])
  })

  it('can group by month', () => {
    const f = categoryFlow(rows, ['2030-06', '2030-07'], (d) => d.slice(0, 7))
    expect(f.totals).toEqual([100, 99])
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
    return { t, w: categoryFlow([t], [t.date], (d) => d).totals[0], share: categoryShare([t])[0].value }
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
