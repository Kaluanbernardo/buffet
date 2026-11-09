import { describe, expect, it } from 'vitest'
import { applyReview, isPending, monthSummary, owedOf, pendingOf, spendOf } from '../src/data/derive'
import type { BuffetData, Transaction } from '../src/data/types'

// Synthetic numbers only. Pending rows come from the database; this is the device-only fallback and the derived views.
const tx = (o: Partial<Transaction> & { id: string }): Transaction => ({ date: '2030-06-10', merchant: 'Loja teste', category: 'Mercado', amount: 25, ...o })
const pend = (o: Partial<Transaction> & { id: string }) => tx({ review_status: 'pending', source: 'notificacao', notification_id: `n-${o.id}`, ...o })
const data = (transactions: Transaction[], cash: number | null = 975): BuffetData => ({
  transactions, cardPayments: [], subscriptions: [], budgets: [], debts: [], reserves: [], investments: [], incomes: {},
  config: { categories: ['Mercado', 'Alimentação', 'Outros'], banks: [], cash_balance: cash },
  refunds: [{ id: 'r1', posted_at: '2030-06-10T15:00:00Z', amount: 9, merchant: 'LOJA EXEMPLO' }],
})
const row = (d: BuffetData, id: string) => d.transactions.find((t) => t.id === id)

describe('pendentes nos totais', () => {
  it('pendente conta no mês como qualquer gasto; pendingOf soma, conta duplicatas e traz os estornos', () => {
    const d = data([tx({ id: 'm1', amount: 10 }), pend({ id: 'p1', cash_debited: 25, method: 'debit' }), pend({ id: 'p2', amount: 5, possible_duplicate_of: 'm1', date: '2030-06-09' })])
    expect(monthSummary(d, '2030-06').spent).toBe(40)
    const p = pendingOf(d)
    expect(p.rows.map((t) => t.id)).toEqual(['p2', 'p1'])
    expect(p).toMatchObject({ total: 30, duplicates: 1 })
    expect(p.refunds).toHaveLength(1)
    expect(isPending(row(d, 'm1')!)).toBe(false)
  })
})

describe('applyReview (store local)', () => {
  it('confirmar muda só o status e tira a marca de duplicata', () => {
    const d = applyReview(data([pend({ id: 'p1', possible_duplicate_of: 'x' })]), { kind: 'review', id: 'p1', patch: {}, confirm: true })
    expect(row(d, 'p1')).toMatchObject({ review_status: 'confirmed', possible_duplicate_of: undefined, amount: 25, category: 'Mercado' })
    expect(d.config.cash_balance).toBe(975)
  })

  it('edita nome/categoria/nota, divide e registra reembolso; sem confirmar continua pendente', () => {
    const d = applyReview(data([pend({ id: 'p1', amount: 40 })]),
      { kind: 'review', id: 'p1', patch: { merchant: ' Restaurante ', category: 'Alimentação', note: 'almoço', share: 50, reimburse: null, reimburse_cash: true }, confirm: false })
    const t = row(d, 'p1')!
    expect(t).toMatchObject({ merchant: 'Restaurante', category: 'Alimentação', note: 'almoço', split_share_pct: 50, reimbursed_amount: 20, review_status: 'pending' })
    expect(spendOf(t)).toBe(20)
    expect(owedOf(t)).toBe(0)
    expect(d.config.cash_balance).toBe(995)
  })

  it('descartar devolve cash_debited (se houver saldo) e tira a linha', () => {
    const d = applyReview(data([pend({ id: 'p1', cash_debited: 25 }), tx({ id: 'm1' })]), { kind: 'discard', id: 'p1' })
    expect(d.transactions.map((t) => t.id)).toEqual(['m1'])
    expect(d.config.cash_balance).toBe(1000)
    expect(applyReview(data([pend({ id: 'p1', cash_debited: 25 })], null), { kind: 'discard', id: 'p1' }).config.cash_balance).toBeNull()
  })

  it('recusa o que o banco recusa', () => {
    const d = data([pend({ id: 'p1', split_share_pct: 50, partner_amount: 12.5, reimbursed_amount: 5, reimbursed_cash: 5, reimbursed_at: '2030-06-10' }),
      tx({ id: 'm1' }), pend({ id: 'c1', review_status: 'confirmed' })])
    expect(() => applyReview(d, { kind: 'discard', id: 'p1' })).toThrow(/reembolso/)
    expect(() => applyReview(d, { kind: 'discard', id: 'c1' })).toThrow(/pendente/)
    expect(() => applyReview(d, { kind: 'review', id: 'm1', patch: {}, confirm: true })).toThrow(/não veio de notificação/)
    expect(() => applyReview(d, { kind: 'review', id: 'c1', patch: { method: 'pix' }, confirm: true })).toThrow(/banco de dados/)
    expect(() => applyReview(d, { kind: 'review', id: 'c1', patch: { merchant: ' ' }, confirm: true })).toThrow(/vazio/)
    expect(() => applyReview(d, { kind: 'discard', id: 'nada' })).toThrow(/não encontrado/)
  })

  it('confirmar vários de uma vez e dispensar estorno', () => {
    const d = applyReview(data([pend({ id: 'p1' }), pend({ id: 'p2' })]), { kind: 'confirm', ids: ['p1', 'p2'] })
    expect(pendingOf(d).rows).toHaveLength(0)
    expect(applyReview(d, { kind: 'dismiss', id: 'r1' }).refunds).toEqual([])
  })
})
