import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useBuffet } from '../data/store'
import { money, parseMoney, today, uid } from '../lib/format'
import { CategoryIcon, Sheet } from './ui'

type Toast = { msg: string; undo?: () => void }
type Actions = { openNew: () => void; notify: (t: Toast) => void }
const ActionsCtx = createContext<Actions | null>(null)

export function useActions() {
  const c = useContext(ActionsCtx)
  if (!c) throw new Error('useActions fora do ActionsProvider')
  return c
}

/** App-wide actions: the "Novo gasto" sheet (reachable from any screen) and a single undo toast. */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<(Toast & { id: number }) | null>(null)
  const timer = useRef<number>(undefined)
  const notify = useCallback((t: Toast) => {
    setToast({ ...t, id: Date.now() })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), 5000)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const openNew = useCallback(() => setOpen(true), [])

  return (
    <ActionsCtx.Provider value={{ openNew, notify }}>
      {children}
      <Sheet open={open} onClose={() => setOpen(false)} title="Novo gasto">
        <NewExpenseForm onDone={(msg, undo) => { setOpen(false); notify({ msg, undo }) }} />
      </Sheet>
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+84px)] z-40 flex justify-center px-4">
        {toast && (
          <div key={toast.id} className="toast pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-line bg-raised px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,.4)]">
            <p className="flex-1 text-sm">{toast.msg}</p>
            {toast.undo && (
              <button className="link" onClick={() => { toast.undo?.(); setToast(null) }}>Desfazer</button>
            )}
          </div>
        )}
      </div>
    </ActionsCtx.Provider>
  )
}

function NewExpenseForm({ onDone }: { onDone: (msg: string, undo: () => void) => void }) {
  const { data, update } = useBuffet()
  const banks = data.config.banks.filter((b) => b.status === 'active').map((b) => b.name)
  const [f, setF] = useState({ amount: '', merchant: '', category: data.config.categories[0], date: today(), bank: banks[0] ?? '' })
  const [tried, setTried] = useState(false)
  const amount = parseMoney(f.amount)
  const amountOk = Number.isFinite(amount) && amount > 0
  const merchantOk = f.merchant.trim().length > 0

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!amountOk || !merchantOk) return
    const id = uid()
    const value = Math.round(amount * 100) / 100
    update((d) => ({
      ...d,
      transactions: [{ id, amount: value, merchant: f.merchant.trim(), category: f.category, date: f.date, bank: f.bank || undefined }, ...d.transactions],
    }))
    onDone(`${money(value)} em ${f.merchant.trim()} lançado`, () =>
      update((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== id) })))
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div>
        <label htmlFor="nv-amount" className="label">Valor</label>
        <div className="flex items-baseline gap-2 border-b border-control pb-2 focus-within:border-accent">
          <span className="text-2xl font-semibold text-muted">R$</span>
          <input
            id="nv-amount" data-autofocus inputMode="decimal" autoComplete="off" placeholder="0,00"
            aria-invalid={tried && !amountOk}
            className="money w-full bg-transparent text-[40px] leading-none font-bold tracking-[-0.03em] outline-none placeholder:text-faint"
            value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.,]/g, '') })}
          />
        </div>
        {tried && !amountOk && <p className="mt-2 text-sm text-negative">Informe um valor maior que zero.</p>}
      </div>

      <div>
        <label htmlFor="nv-merchant" className="label">Onde</label>
        <input id="nv-merchant" className="input" placeholder="Ex.: Mangará, Uber, farmácia" autoComplete="off"
          aria-invalid={tried && !merchantOk} value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} />
        {tried && !merchantOk && <p className="mt-2 text-sm text-negative">Diga onde foi o gasto.</p>}
      </div>

      <fieldset>
        <legend className="label">Categoria</legend>
        <div className="-mx-1 grid grid-cols-4 gap-1">
          {data.config.categories.map((c) => {
            const on = c === f.category
            return (
              <button type="button" key={c} aria-pressed={on} onClick={() => setF({ ...f, category: c })}
                className={`flex flex-col items-center gap-1.5 rounded-2xl px-1 py-2.5 text-[12px] font-semibold transition-colors ${on ? 'bg-raised text-ink ring-1 ring-accent' : 'text-muted hover:bg-raised/60'}`}>
                <CategoryIcon category={c} size={34} />
                <span className="w-full truncate text-center">{c}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="nv-date" className="label">Data</label>
          <input id="nv-date" type="date" className="input" value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value || today() })} />
        </div>
        <div>
          <label htmlFor="nv-bank" className="label">Conta</label>
          <select id="nv-bank" className="input" value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })}>
            {banks.map((b) => <option key={b}>{b}</option>)}
            <option value="">Outra</option>
          </select>
        </div>
      </div>

      <button className="btn w-full">Lançar gasto{amountOk ? ` de ${money(amount)}` : ''}</button>
    </form>
  )
}
