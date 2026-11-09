import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, HandCoins, Percent, Split as SplitIcon, Undo2 } from 'lucide-react'
import { useBuffet } from '../data/store'
import type { SplitAction, Transaction } from '../data/types'
import { owedOf, partnerOf, splitState, spendOf, type SplitState } from '../data/derive'
import { dayLabel, money, parseMoney, today } from '../lib/format'
import { useActions } from './Actions'
import { CategoryIcon } from './ui'

const TAG: Record<SplitState, { label: string; tone: string }> = {
  split: { label: 'Dividido', tone: 'pill-neutral' },
  partial: { label: 'Reembolso parcial', tone: 'pill-warn' },
  reimbursed: { label: 'Reembolsado', tone: 'pill-ok' },
}

const FULL_LABEL = 'Reembolsável integral'

/** Tag + what it means for this row; the row itself keeps showing the full amount. */
export function SplitLine({ t }: { t: Transaction }) {
  const state = splitState(t)
  if (!state) return null
  // Share 0 is a real split (the other person owes it all), not "not split": until something is received, say so.
  const label = state === 'split' && t.split_share_pct === 0 ? FULL_LABEL : TAG[state].label
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-faint">
      <span className={`pill ${TAG[state].tone}`}>{label}</span>
      <span className="money">{state === 'reimbursed' ? `sua parte ${money(spendOf(t))}` : `a receber ${money(owedOf(t))}`}</span>
    </p>
  )
}

/** Runs one operation with the "busy" and error state every form here needs. Failures are shown; nothing is assumed done. */
function useSplitRun() {
  const { splitAction } = useBuffet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: SplitAction) => {
    setBusy(true); setError(null)
    try { await splitAction(action); return true }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false }
    finally { setBusy(false) }
  }
  return { busy, error, run }
}

/** Toast with an undo that runs another operation, reporting a failed undo the same way. */
function useSplitToast() {
  const { splitAction } = useBuffet()
  const { notify } = useActions()
  return (msg: string, undo?: SplitAction) => notify({
    msg,
    undo: undo && (() => { splitAction(undo).catch((e: unknown) => notify({ msg: `Não deu para desfazer: ${e instanceof Error ? e.message : String(e)}` })) }),
  })
}

const FormError = ({ children }: { children: ReactNode }) => children ? <p role="alert" className="text-sm text-negative">{children}</p> : null

function SplitForm({ tx, onDone, onCancel }: { tx: Transaction; onDone: () => void; onCancel: () => void }) {
  const toast = useSplitToast()
  const { busy, error, run } = useSplitRun()
  const [text, setText] = useState(String(tx.split_share_pct ?? 50).replace('.', ','))
  const share = parseMoney(text)
  const ok = share >= 0 && share < 100   // 0 = fully reimbursable; empty text parses to NaN
  const partner = ok ? partnerOf(tx.amount, share) : 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok || !(await run({ kind: 'split', id: tx.id, share }))) return
    toast(`${tx.merchant} dividido: a receber ${money(partner)}`,
      tx.split_share_pct == null ? { kind: 'unsplit', id: tx.id } : { kind: 'split', id: tx.id, share: tx.split_share_pct })
    onDone()
  }
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <div>
        <label htmlFor="split-share" className="label">Sua parte (%)</label>
        <div className="relative">
          <input id="split-share" inputMode="decimal" autoComplete="off" className="input money pr-10" aria-invalid={!ok}
            value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ''))} />
          <Percent size={15} aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-faint" />
        </div>
      </div>
      {ok && share === 0
        ? <p className="money text-sm text-muted">Reembolso integral: sua parte é <span className="font-semibold text-ink">{money(0)}</span> e <span className="font-semibold text-ink">{money(partner)}</span> ficam a receber. O saldo não muda agora.</p>
        : ok
        ? <p className="money text-sm text-muted">De {money(tx.amount)}, sua parte é <span className="font-semibold text-ink">{money(tx.amount - partner)}</span> e <span className="font-semibold text-ink">{money(partner)}</span> ficam a receber. O saldo não muda agora.</p>
        : <p className="text-sm text-negative">Informe um percentual entre 0 e 100.</p>}
      <FormError>{error}</FormError>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost h-12" onClick={onCancel}>Voltar</button>
        <button className="btn" disabled={busy}>{busy ? 'Salvando…' : 'Dividir'}</button>
      </div>
    </form>
  )
}

function ReceiveForm({ tx, onDone, onCancel }: { tx: Transaction; onDone: () => void; onCancel: () => void }) {
  const { data } = useBuffet()
  const toast = useSplitToast()
  const { busy, error, run } = useSplitRun()
  const owed = owedOf(tx)
  const [text, setText] = useState(owed.toFixed(2).replace('.', ','))
  const [date, setDate] = useState(today())
  const hasBalance = data.config.cash_balance != null
  const [cash, setCash] = useState(hasBalance)
  const raw = parseMoney(text)
  const amount = Math.round(raw * 100) / 100
  const ok = amount > 0 && amount <= owed
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok || !(await run({ kind: 'reimburse', id: tx.id, amount, date, cash }))) return
    // Undo clears the whole reimbursement, so it can only stand in for this one when it is the first.
    toast(`${money(amount)} de ${tx.merchant} recebido`, tx.reimbursed_amount == null ? { kind: 'unreimburse', id: tx.id } : undefined)
    onDone()
  }
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <p className="money text-sm text-muted">{tx.merchant} · {money(tx.amount)} · falta receber <span className="font-semibold text-ink">{money(owed)}</span></p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="rc-amount" className="label">Valor recebido</label>
          <input id="rc-amount" inputMode="decimal" autoComplete="off" className="input money" aria-invalid={!ok}
            value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ''))} />
        </div>
        <div>
          <label htmlFor="rc-date" className="label">Data</label>
          <input id="rc-date" type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
        </div>
      </div>
      {!ok && <p className="money text-sm text-negative">Informe um valor maior que zero e de até {money(owed)}.</p>}
      <label className={`flex items-start gap-3 text-sm ${hasBalance ? '' : 'text-faint'}`}>
        <input type="checkbox" className="mt-0.5 size-[18px] flex-none accent-(--color-accent)" checked={cash} disabled={!hasBalance} onChange={(e) => setCash(e.target.checked)} />
        <span>{hasBalance ? 'Entrou na conta do saldo: somar ao saldo em caixa' : 'Saldo em caixa não informado: o reembolso não mexe nele'}</span>
      </label>
      <FormError>{error}</FormError>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost h-12" onClick={onCancel}>Voltar</button>
        <button className="btn" disabled={busy}>{busy ? 'Salvando…' : 'Registrar'}</button>
      </div>
    </form>
  )
}

/**
 * A spend's menu: `summary`, the split actions, then `children` (the other items). Installment rows can't be split, so
 * they see no split actions. A form replaces the whole menu while it's open; the sheet closes once the database has answered.
 */
export function SplitActions({ tx, onClose, summary, children }: { tx: Transaction; onClose: () => void; summary: ReactNode; children: ReactNode }) {
  const toast = useSplitToast()
  const { busy, error, run } = useSplitRun()
  const [form, setForm] = useState<'split' | 'receive' | null>(null)
  const state = splitState(tx)
  if (form === 'split') return <SplitForm tx={tx} onDone={onClose} onCancel={() => setForm(null)} />
  if (form === 'receive') return <ReceiveForm tx={tx} onDone={onClose} onCancel={() => setForm(null)} />

  const unsplit = async () => {
    if (!(await run({ kind: 'unsplit', id: tx.id }))) return
    toast(`${tx.merchant} não é mais dividido`, { kind: 'split', id: tx.id, share: tx.split_share_pct! })
    onClose()
  }
  const unreimburse = async () => {
    if (!(await run({ kind: 'unreimburse', id: tx.id }))) return
    const got = tx.reimbursed_amount!, cash = tx.reimbursed_cash ?? 0
    // Can be redone in one step only when all of it, or none of it, had entered the balance.
    const redo = cash === 0 || cash === got
    toast(`Reembolso desfeito${cash > 0 ? `: ${money(cash)} saíram do saldo` : ''}`,
      redo ? { kind: 'reimburse', id: tx.id, amount: got, date: tx.reimbursed_at, cash: cash > 0 } : undefined)
    onClose()
  }
  // Same operation as the form with 0%; marking a row that is already 0% changes nothing.
  const fullReimburse = async () => {
    if (!(await run({ kind: 'split', id: tx.id, share: 0 }))) return
    toast(`${tx.merchant} reembolsável integral: a receber ${money(partnerOf(tx.amount, 0))}`,
      tx.split_share_pct == null ? { kind: 'unsplit', id: tx.id } : { kind: 'split', id: tx.id, share: tx.split_share_pct })
    onClose()
  }
  const row = 'btn-ghost h-11 justify-start px-4'
  return (
    <div className="grid gap-2">
      {summary}
      {!tx.debt_id && !state && (
        <button className={row} onClick={() => setForm('split')}><SplitIcon size={16} />Dividir gasto</button>
      )}
      {(state === 'split' || state === 'partial') && (
        <button className={row} data-autofocus onClick={() => setForm('receive')}><HandCoins size={16} /><span className="money">Recebi {money(owedOf(tx))}</span></button>
      )}
      {state && <button className={row} onClick={() => setForm('split')}><Percent size={16} />Ajustar divisão</button>}
      {!tx.debt_id && (
        <button className={row} disabled={busy} onClick={fullReimburse}><HandCoins size={16} /><span className="money">Reembolsável integral (sua parte 0%, a receber {money(partnerOf(tx.amount, 0))})</span></button>
      )}
      {state === 'split' && <button className={row} disabled={busy} onClick={unsplit}><Undo2 size={16} />Não é dividido</button>}
      {tx.reimbursed_amount != null && (
        <button className={row} disabled={busy} onClick={unreimburse}><Undo2 size={16} /><span className="money">Desfazer reembolso de {money(tx.reimbursed_amount)}</span></button>
      )}
      <FormError>{error}</FormError>
      {children}
    </div>
  )
}

/** A receber: every spend with money to come; "Recebi" opens the form in place of the list. The sheet closes after it, so the undo toast shows. */
export function ReceivableList({ rows, total, onClose }: { rows: Transaction[]; total: number; onClose: () => void }) {
  const [receiving, setReceiving] = useState<string | null>(null)
  const tx = rows.find((t) => t.id === receiving)
  if (tx) return <ReceiveForm tx={tx} onDone={onClose} onCancel={() => setReceiving(null)} />
  return (
    <div className="grid grid-cols-1 gap-3">
      <p className="money text-[30px] leading-none font-extrabold tracking-[-0.03em]">{money(total)}</p>
      <p className="text-sm text-muted text-pretty">Entra no saldo em caixa quando você marcar como recebido. Até lá, o gasto conta inteiro.</p>
      <ul className="divide-y divide-rule">
        {rows.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-3">
            <CategoryIcon category={t.category} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{t.merchant}</p>
              <p className="money truncate text-[13px] text-faint">{dayLabel(t.date)} · {money(t.amount)}</p>
              <p className="money text-[13px] font-semibold text-ink">a receber {money(owedOf(t))}</p>
            </div>
            <button className="btn-ghost h-10 flex-none px-3.5" onClick={() => setReceiving(t.id)}><Check size={15} />Recebi</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
