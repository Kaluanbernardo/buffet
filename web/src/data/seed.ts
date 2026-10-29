import type { BuffetData } from './types'
import { today } from '../lib/format'

export const DEFAULT_CATEGORIES = ['Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer', 'Assinaturas', 'Educação', 'Outros']

export const seed = (): BuffetData => ({
  transactions: [{ id: 'seed-1', date: today(), amount: 29.47, merchant: 'Mangará', category: 'Alimentação', bank: 'Nubank' }],
  budgets: DEFAULT_CATEGORIES.map((category) => ({ category, monthly_limit: 0 })),
  debts: [
    { id: 'seed-d1', description: 'Exemplo — parcela cartão', bank: 'Nubank', installment_amount: 0, installments_paid: 0, installments_total: 1, due_day: 10 },
  ],
  reserves: [{ id: 'seed-r1', name: 'Reserva de emergência', target: 0, current: 0 }],
  investments: [],
  incomes: {},
  config: {
    categories: DEFAULT_CATEGORIES,
    banks: [
      { name: 'Nubank', status: 'active' }, { name: 'Neon', status: 'active' },
      { name: 'Inter', status: 'active' }, { name: 'XP', status: 'planned' },
    ],
  },
})
