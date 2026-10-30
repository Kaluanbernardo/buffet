import { useState, type FormEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { auth } from '../lib/auth'
import { BrandMark } from '../components/ui'

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const withEmail = auth.kind === 'supabase'
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (withEmail && !email.trim()) { setErr('Digite o e-mail para entrar.'); return }
    if (!pw) { setErr('Digite a senha para entrar.'); return }
    setBusy(true)
    const msg = await auth.login(pw, email)
    setBusy(false)
    if (msg) setErr(msg); else onSuccess()
  }
  return (
    <div className="flex min-h-dvh flex-col px-6 pt-[max(env(safe-area-inset-top),12vh)] pb-[calc(env(safe-area-inset-bottom)+24px)]">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col">
        <div className="text-accent"><BrandMark size={52} /></div>
        <h1 className="mt-6 text-[44px] leading-none font-extrabold tracking-[-0.04em]">Buffet</h1>
        <p className="mt-3 text-lg text-muted text-balance">O mês inteiro numa mesa só: gastos, parcelas e reserva.</p>

        <form onSubmit={submit} noValidate className="mt-auto space-y-4 pt-12">
          {withEmail ? (
            <div>
              <label htmlFor="email" className="label">E-mail</label>
              <input id="email" className="input h-[52px]" type="email" autoFocus autoComplete="username" inputMode="email"
                value={email} onChange={(e) => { setEmail(e.target.value); setErr(null) }} />
              <p className="mt-2 text-[13px] text-faint">Mesmo login do app de treino.</p>
            </div>
          ) : (<>
            <input type="text" name="username" autoComplete="username" value="kaluan" readOnly hidden />
            <div className="flex items-center gap-3">
              <span aria-hidden className="grid size-10 place-items-center rounded-full bg-raised font-bold text-muted">K</span>
              <div>
                <p className="font-semibold">Kaluan</p>
                <p className="text-[13px] text-faint">Acesso deste aparelho</p>
              </div>
            </div>
          </>)}
          <div>
            <label htmlFor="pw" className="label">Senha</label>
            <div className="relative">
              <input
                id="pw" className="input h-[52px] pr-12" type={show ? 'text' : 'password'} autoFocus={!withEmail} autoComplete="current-password"
                aria-invalid={!!err} aria-describedby={err ? 'pw-err' : undefined}
                value={pw} onChange={(e) => { setPw(e.target.value); setErr(null) }}
              />
              <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
                className="absolute top-1/2 right-1.5 grid size-10 -translate-y-1/2 place-items-center rounded-full text-muted hover:text-ink">
                {show ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {err && <p id="pw-err" role="alert" className="mt-2 text-sm text-negative">{err}</p>}
          </div>
          <button className="btn h-[52px] w-full" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        </form>
      </div>
    </div>
  )
}
