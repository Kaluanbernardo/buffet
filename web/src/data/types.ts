// Mirrors supabase/migrations/*_buffet_init.sql (buffet_* tables). Keep in sync.
export type Category = string
export interface Transaction {
  id: string; date: string; amount: number; merchant: string; category: Category; bank?: string; note?: string
  /** buffet_subscriptions.id when this spend is a subscription's charge for a cycle (the ↻ badge). */
  subscription_id?: string
  /** How it was paid; bank = the institution. credit → part of a card bill (bill_month), never cash until pay-bill. */
  method?: PayMethod
  /** credit only: the bill (due month, "2026-11") it lands in — derived from the card's cycle. */
  bill_month?: string
  /** One row per installment (option A): the plan (buffet_debts kind='installments') and which k of installments_total. */
  debt_id?: string; installment_no?: number
}
export type PayMethod = 'debit' | 'pix' | 'credit' | 'cash'
/**
 * buffet_subscriptions — a commitment, never money: it says what is expected (amount, cycle, next charge). The real
 * charge is a Transaction with subscription_id, so it counts once, as spend. Never add these to a spend total.
 */
export type SubCycle = 'monthly' | 'yearly'
export type SubStatus = 'active' | 'paused' | 'canceled'
export interface Subscription {
  id: string; name: string; amount: number; cycle: SubCycle; next_due: string; bank?: string; category: Category
  status: SubStatus; remind_days: number; match?: string; cancel_hint?: string; note?: string
  /** First charge; its day anchors the cycle (31 → 28/fev → 31/mar). */
  started_on?: string; canceled_on?: string
}
/** buffet_card_payments — paying a card bill moves money, it isn't spending: never part of any spend total. Read-only in the app (chat writes via `buffet pay-bill`). */
export interface CardPayment { id: string; date: string; amount: number; card_bank: string; paid_from?: string; note?: string
  /** Which bill this paid ("2026-11"); absent on payments from before bills were tracked. */
  bill_month?: string }
/** Soft grouping on Orçamento (YNAB-style category groups). Missing = derived from the category name. */
export type BudgetGroup = 'essenciais' | 'lifestyle' | 'metas'
export interface Budget { category: Category; monthly_limit: number; group?: BudgetGroup }
/**
 * kind='installments': a credit-card purchase in N parts — its installments are real Transactions (debt_id), paid by the
 * card bill, so the plan itself never adds to a total. kind='bill': the bill amount the bank's app shows (reported) for
 * card+first_bill. kind='loan': a debt outside the card, paid one installment at a time ("Marcar parcela paga").
 */
export type DebtKind = 'installments' | 'bill' | 'loan'
export interface Debt { id: string; description: string; bank: string; installment_amount: number; installments_paid: number; installments_total: number; due_day: number
  kind?: DebtKind; card?: string; total_amount?: number; purchase_date?: string; first_bill?: string }
export interface Reserve { id: string; name: string; target: number; current: number }
export interface Investment { id: string; name: string; kind: string; institution: string; amount: number }
/** credit: the card's cycle (purchase on/after closing_day goes to the next bill; due_day = when the bill is due). */
export interface Bank { name: string; status: 'active' | 'planned'; credit?: { closing_day: number; due_day: number } }
export interface AppConfig {
  categories: Category[]; banks: Bank[]
  /** buffet_app_config.cash_balance — read-only in the app (set by the chat); null/absent = unknown. */
  cash_balance?: number | null
}
export interface BuffetData {
  transactions: Transaction[]; cardPayments: CardPayment[]; subscriptions: Subscription[]; budgets: Budget[]; debts: Debt[]; reserves: Reserve[]; investments: Investment[]; config: AppConfig
  /** "Renda do mês" per month key ("2026-10" → 8500). A month without an entry repeats the last one. */
  incomes: Record<string, number>
  /** False while the subscriptions migration isn't applied on Supabase: the screen explains, nothing syncs. */
  subscriptionsReady?: boolean
}
