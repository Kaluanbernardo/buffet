import { useState } from 'react'
import { auth } from '../lib/auth'

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true)
    const ok = await auth.login(pw)
    setBusy(false)
    if (ok) onSuccess(); else setErr(true)
  }
  return (
    <div className="min-h-screen grid place-items-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Buffet</h1>
          <p className="text-sm text-gray-400">Finanças pessoais</p>
        </div>
        <label className="block text-sm">Usuário<input className="input mt-1 opacity-70" value="Kaluan" readOnly /></label>
        <label className="block text-sm">Senha<input className="input mt-1" type="password" autoFocus value={pw} onChange={(e) => { setPw(e.target.value); setErr(false) }} /></label>
        {err && <p className="text-sm text-red-400">Senha incorreta.</p>}
        <button className="btn w-full" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  )
}
