/**
 * Auth abstraction. F0 = PasswordGate (SHA-256 of password vs VITE_APP_PASSWORD_HASH, session in sessionStorage).
 * F1 = Supabase Auth (same project as fitness): implement AuthAdapter with supabase.auth and swap `auth` below.
 */
export interface AuthAdapter {
  configured(): boolean
  isAuthed(): Promise<boolean>
  login(password: string): Promise<boolean>
  logout(): Promise<void>
}

const KEY = 'buffet_authed'

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const passwordAuth: AuthAdapter = {
  configured: () => !!import.meta.env.VITE_APP_PASSWORD_HASH,
  isAuthed: async () => sessionStorage.getItem(KEY) === '1',
  async login(pw) {
    const expected = (import.meta.env.VITE_APP_PASSWORD_HASH ?? '').trim().toLowerCase()
    if (!expected) return false
    const ok = (await sha256Hex(pw)) === expected
    if (ok) sessionStorage.setItem(KEY, '1')
    return ok
  },
  logout: async () => sessionStorage.removeItem(KEY),
}

export const auth: AuthAdapter = passwordAuth
