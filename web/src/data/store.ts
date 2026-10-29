/**
 * Data abstraction. F0 = localStorage. F1 = Supabase (buffet_* tables in the shared fitness project):
 * implement DataStore with supabase-js and swap `store` below — screens only use useBuffet().
 */
import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { BudgetGroup, BuffetData } from './types'
import { seed } from './seed'
import { setValuesHidden, valuesHidden } from '../lib/format'

export interface DataStore {
  load(): Promise<BuffetData>
  save(data: BuffetData): Promise<void>
}

const KEY = 'buffet_data_v1'

const GROUPS: BudgetGroup[] = ['essenciais', 'lifestyle', 'metas']

/**
 * Bring any older saved shape up to date without losing rows: missing collections come from the seed,
 * `incomes` (added with the YNAB-style budget) starts empty and drops non-numeric entries, every configured
 * category gets a budget row, and an unknown `group` falls back to the default for that category.
 */
export function migrate(raw: Partial<BuffetData>): BuffetData {
  const base = seed()
  const d = { ...base, ...raw, config: { ...base.config, ...raw.config } } as BuffetData
  const incomes: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw.incomes ?? {})) if (/^\d{4}-\d{2}$/.test(k) && Number.isFinite(v) && v >= 0) incomes[k] = v
  const budgets = (Array.isArray(d.budgets) ? d.budgets : []).map((b) =>
    (b.group && !GROUPS.includes(b.group) ? { category: b.category, monthly_limit: b.monthly_limit } : b))
  for (const c of d.config.categories) if (!budgets.some((b) => b.category === c)) budgets.push({ category: c, monthly_limit: 0 })
  return { ...d, budgets, incomes }
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
}

export const store: DataStore = localStore

type Ctx = {
  data: BuffetData; update: (fn: (d: BuffetData) => BuffetData) => void
  /** Values masked ("Ocultar valores"); in the context so every screen re-renders on toggle. */
  hidden: boolean; toggleHidden: () => void
}
const BuffetCtx = createContext<Ctx | null>(null)

export function BuffetProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<BuffetData | null>(null)
  useEffect(() => { store.load().then(setData) }, [])
  const update = useCallback((fn: (d: BuffetData) => BuffetData) => {
    setData((prev) => { if (!prev) return prev; const next = fn(prev); void store.save(next); return next })
  }, [])
  const [hidden, setHidden] = useState(valuesHidden)
  const toggleHidden = useCallback(() => setHidden((h) => { setValuesHidden(!h); return !h }), [])
  if (!data) return null
  return createElement(BuffetCtx.Provider, { value: { data, update, hidden, toggleHidden } }, children)
}

export function useBuffet() {
  const c = useContext(BuffetCtx)
  if (!c) throw new Error('useBuffet fora do BuffetProvider')
  return c
}
