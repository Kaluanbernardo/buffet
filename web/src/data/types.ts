// Mirrors supabase/migrations/*_buffet_init.sql (buffet_* tables). Keep in sync.
export type Category = string
export interface Transaction { id: string; date: string; amount: number; merchant: string; category: Category; bank?: string; note?: string }
/** Soft grouping on Orçamento (YNAB-style category groups). Missing = derived from the category name. */
export type BudgetGroup = 'essenciais' | 'lifestyle' | 'metas'
export interface Budget { category: Category; monthly_limit: number; group?: BudgetGroup }
export interface Debt { id: string; description: string; bank: string; installment_amount: number; installments_paid: number; installments_total: number; due_day: number }
export interface Reserve { id: string; name: string; target: number; current: number }
export interface Investment { id: string; name: string; kind: string; institution: string; amount: number }
export interface Bank { name: string; status: 'active' | 'planned' }
export interface AppConfig {
  categories: Category[]; banks: Bank[]
  /** buffet_app_config.cash_balance — read-only in the app (set by the chat); null/absent = unknown. */
  cash_balance?: number | null
}
export interface BuffetData {
  transactions: Transaction[]; budgets: Budget[]; debts: Debt[]; reserves: Reserve[]; investments: Investment[]; config: AppConfig
  /** "Renda do mês" per month key ("2026-10" → 8500). A month without an entry repeats the last one. */
  incomes: Record<string, number>
}
