/**
 * Data abstraction. F0 = localStorage. F1 = Supabase (buffet_* tables in the shared fitness project):
 * implement DataStore with supabase-js and swap `store` below — screens only use useBuffet().
 */
import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { BuffetData } from './types'
import { seed } from './seed'
import { setValuesHidden, valuesHidden } from '../lib/format'

export interface DataStore {
  load(): Promise<BuffetData>
  save(data: BuffetData): Promise<void>
}

const KEY = 'buffet_data_v1'

export const localStore: DataStore = {
  async load() {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) return { ...seed(), ...JSON.parse(raw) } as BuffetData
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
