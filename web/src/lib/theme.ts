import { useCallback, useEffect, useSyncExternalStore } from 'react'

/**
 * Light/dark. Preference is 'system' until the user picks; resolved theme lands on <html data-theme>, which
 * index.css keys its light tokens off. index.html runs the same resolve inline so first paint never flashes.
 */
export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'buffet_theme'
const GROUND: Record<Theme, string> = { dark: '#0e1116', light: '#f4f5f7' }
const media = () => window.matchMedia('(prefers-color-scheme: light)')

const readPref = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}
const resolve = (p: ThemePref): Theme => (p === 'system' ? (media().matches ? 'light' : 'dark') : p)

let pref = readPref()
const listeners = new Set<() => void>()

function apply() {
  const t = resolve(pref)
  const root = document.documentElement
  root.dataset.theme = t
  root.style.colorScheme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', GROUND[t])
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function useTheme() {
  const current = useSyncExternalStore(subscribe, () => `${pref}:${resolve(pref)}`)
  const [p, t] = current.split(':') as [ThemePref, Theme]

  // Follow the OS while on 'system'.
  useEffect(() => {
    const m = media()
    const on = () => { if (pref === 'system') apply() }
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])

  const setPref = useCallback((next: ThemePref) => {
    pref = next
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch { /* private mode */ }
    apply()
  }, [])
  const toggle = useCallback(() => setPref(resolve(pref) === 'dark' ? 'light' : 'dark'), [setPref])

  return { pref: p, theme: t, setPref, toggle }
}

apply()
