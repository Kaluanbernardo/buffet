/**
 * Auth abstraction. With VITE_SUPABASE_* = Supabase Auth (same e-mail/password as fitness; RLS is_owner()).
 * Without = F0 PasswordGate (SHA-256 of password vs VITE_APP_PASSWORD_HASH, session in sessionStorage).
 */
import { supabase } from './supabase'

export interface AuthAdapter {
  /** 'supabase' asks for e-mail too. */
  kind: 'password' | 'supabase'
  configured(): boolean
  isAuthed(): Promise<boolean>
  /** null = ok, otherwise a pt-BR error message. */
  login(password: string, email?: string): Promise<string | null>
  logout(): Promise<void>
}

const KEY = 'buffet_authed'

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const passwordAuth: AuthAdapter = {
  kind: 'password',
  configured: () => !!import.meta.env.VITE_APP_PASSWORD_HASH,
  isAuthed: async () => sessionStorage.getItem(KEY) === '1',
  async login(pw) {
    const expected = (import.meta.env.VITE_APP_PASSWORD_HASH ?? '').trim().toLowerCase()
    if (!expected) return 'Senha não configurada.'
    if ((await sha256Hex(pw)) !== expected) return 'Senha incorreta. Confira e tente de novo.'
    sessionStorage.setItem(KEY, '1')
    return null
  },
  logout: async () => sessionStorage.removeItem(KEY),
}

export const supabaseAuth = (sb: NonNullable<typeof supabase>): AuthAdapter => ({
  kind: 'supabase',
  configured: () => true,
  isAuthed: async () => !!(await sb.auth.getSession()).data.session,
  async login(password, email = '') {
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password })
    if (!error) return null
    return error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message
  },
  logout: async () => { await sb.auth.signOut() },
})

export const auth: AuthAdapter = supabase ? supabaseAuth(supabase) : passwordAuth
