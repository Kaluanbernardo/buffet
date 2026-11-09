import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import { useBuffet } from '../data/store'
import type { NotificationRefund, ReviewAction, ReviewPatch, Transaction } from '../data/types'
import { isPending, PAY_ORIGIN_LABEL, partnerOf, pendingOf, payOrigin } from '../data/derive'
import { dayLabel, money, parseMoney, plural } from '../lib/format'
import { useActions } from './Actions'
import { FormError } from './Split'
import { CategoryIcon, Segmented, Sheet } from './ui'

/**
 * Gastos que chegaram pelas notificações do banco (docs/captura-notificacoes.md). Já contam em todos os totais; aqui eles
 * são confirmados, editados ou descartados — sempre pelo banco (public.buffet_tx_review/discard), que acerta saldo e fatura.
 */

/** "Pendente" (e "Possível duplicata") abaixo da linha. Some quando o gasto é confirmado. */
export function PendingTag({ t }: { t: Transaction }) {
  if (!isPending(t)) return null
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-faint">
      <span className="pill pill-warn">Pendente</span>
      {t.possible_duplicate_of && <span className="pill pill-bad">Possível duplicata</span>}
      <span>via notificação</span>
    </p>
  )
}

const METHODS = [{ key: 'credit', label: 'Crédito' }, { key: 'debit', label: 'Débito' }, { key: 'pix', label: 'PIX' }] as const
type Method = (typeof METHODS)[number]['key']
const BANK_LABEL: Record<string, string> = { nubank: 'Nubank', inter: 'Inter', neon: 'Neon' }
/** The day in Brasília of a timestamp (posted_at comes in UTC). */
const spDate = (ts: string) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
const where = (t: Transaction) => [PAY_ORIGIN_LABEL[payOrigin(t)], t.bank].filter(Boolean).join(' · ')

function useReviewRun() {
  const { reviewAction } = useBuffet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: ReviewAction) => {
    setBusy(true); setError(null)
    try { await reviewAction(action); return true }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false }
    finally { setBusy(false) }
  }
  return { busy, error, run }
}

/** What leaving tells the user: debit/PIX give the money back to the balance; credit leaves the bill. */
const discardMsg = (t: Transaction) =>
  `${t.merchant} descartado${t.cash_debited ? `: ${money(t.cash_debited)} voltaram ao saldo` : t.bill_month ? ': saiu da fatura' : ''}`

/** Confirmar · Revisar · Descartar (este pede um segundo toque: não tem desfazer). */
function RowActions({ tx, onEdit, onDone }: { tx: Transaction; onEdit: () => void; onDone?: () => void }) {
  const { notify } = useActions()
  const { busy, error, run } = useReviewRun()
  const [sure, setSure] = useState(false)
  const confirm = async () => {
    if (await run({ kind: 'review', id: tx.id, patch: {}, confirm: true })) { notify({ msg: `${tx.merchant} confirmado` }); onDone?.() }
  }
  const discard = async () => {
    if (!sure) { setSure(true); return }
    if (await run({ kind: 'discard', id: tx.id })) { notify({ msg: discardMsg(tx) }); onDone?.() }
  }
  return (
    <>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <button className="btn-ghost h-10 px-2" disabled={busy} onClick={confirm}><Check size={15} />Confirmar</button>
        <button className="btn-ghost h-10 px-2" disabled={busy} onClick={onEdit}><Pencil size={15} />Revisar</button>
        <button className="btn-ghost h-10 px-2 text-negative" disabled={busy} onClick={discard} onBlur={() => setSure(false)}>
          <Trash2 size={15} />{sure ? 'Descartar?' : 'Descartar'}
        </button>
      </div>
      <FormError>{error}</FormError>
    </>
  )
}

/** "Parece o mesmo que…": the spend logged by hand that this one matches (same amount, up to a day apart). */
function DuplicateNote({ tx }: { tx: Transaction }) {
  const { data } = useBuffet()
  const other = data.transactions.find((t) => t.id === tx.possible_duplicate_of)
  if (!tx.possible_duplicate_of) return null
  return (
    <p className="mt-2 rounded-xl bg-negative-tint px-3 py-2 text-[13px] text-negative text-pretty">
      {other
        ? <>Parece o mesmo que <span className="font-semibold">{other.merchant}</span> · <span className="money">{money(other.amount)}</span> · {dayLabel(other.date).toLowerCase()}, lançado {other.source === 'bot' ? 'pelo chat' : 'no app'}. Se for, descarte este.</>
        : <>Parece um gasto já lançado com o mesmo valor. Se for, descarte este.</>}
    </p>
  )
}

/**
 * Revisar: estabelecimento, categoria, meio (corrige o parser: o saldo e a fatura acompanham), nota, dividido e o que já
 * voltou. Salvar confirma — tudo numa chamada ao banco.
 */
export function ReviewForm({ tx, onDone, onCancel }: { tx: Transaction; onDone: () => void; onCancel: () => void }) {
  const { data } = useBuffet()
  const { notify } = useActions()
  const { busy, error, run } = useReviewRun()
  const cats = data.config.categories.includes(tx.category) ? data.config.categories : [...data.config.categories, tx.category]
  const [merchant, setMerchant] = useState(tx.merchant)
  const [category, setCategory] = useState(tx.category)
  const [method, setMethod] = useState<Method>(tx.method === 'debit' || tx.method === 'pix' ? tx.method : 'credit')
  const [note, setNote] = useState(tx.note ?? '')
  const locked = tx.reimbursed_amount != null   // with money received the split can't be undone here
  const [split, setSplit] = useState(tx.split_share_pct != null)
  const [shareText, setShareText] = useState(String(tx.split_share_pct ?? 50).replace('.', ','))
  const [gotText, setGotText] = useState('')
  const hasBalance = data.config.cash_balance != null
  const [gotCash, setGotCash] = useState(hasBalance)
  const share = parseMoney(shareText)
  const shareOk = !split || (share >= 0 && share < 100)
  const partner = split && shareOk ? partnerOf(tx.amount, share) : 0
  const got = gotText.trim() ? Math.round(parseMoney(gotText) * 100) / 100 : 0
  const gotOk = !gotText.trim() || (got > 0 && got <= partner - (tx.reimbursed_amount ?? 0))
  const merchantOk = merchant.trim().length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!merchantOk || !shareOk || !gotOk) return
    const patch: ReviewPatch = {}
    if (merchant.trim() !== tx.merchant) patch.merchant = merchant.trim()
    if (category !== tx.category) patch.category = category
    if ((note.trim() || null) !== (tx.note ?? null)) patch.note = note.trim() || null
    if (method !== tx.method) patch.method = method
    if (split && share !== tx.split_share_pct) patch.share = share
    if (!split && tx.split_share_pct != null) patch.share = null
    if (split && got > 0) { patch.reimburse = got; patch.reimburse_cash = gotCash }
    if (!(await run({ kind: 'review', id: tx.id, patch, confirm: true }))) return
    notify({ msg: `${merchant.trim()} confirmado` })
    onDone()
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <p className="money text-sm text-muted">{money(tx.amount)} · {dayLabel(tx.date)} · via notificação</p>
      <div>
        <label htmlFor="rv-merchant" className="label">Onde</label>
        <input id="rv-merchant" className="input" autoComplete="off" aria-invalid={!merchantOk} value={merchant} onChange={(e) => setMerchant(e.target.value)} />
      </div>
      <fieldset>
        <legend className="label">Categoria</legend>
        <div className="-mx-1 grid grid-cols-4 gap-1">
          {cats.map((c) => (
            <button type="button" key={c} aria-pressed={c === category} onClick={() => setCategory(c)}
              className={`flex flex-col items-center gap-1.5 rounded-2xl px-1 py-2.5 text-[12px] font-semibold transition-colors ${c === category ? 'bg-raised text-ink ring-1 ring-accent' : 'text-muted hover:bg-raised/60'}`}>
              <CategoryIcon category={c} size={30} />
              <span className="w-full truncate text-center">{c}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <div>
        <p className="label">Como pagou</p>
        <Segmented value={method} options={[...METHODS]} onChange={setMethod} label="Como pagou" />
        {method !== tx.method && (
          <p className="mt-2 text-[13px] text-muted">{method === 'credit' ? 'Vai para a fatura; o que tinha saído do saldo volta.' : 'Sai do saldo em caixa (se for a conta do saldo) e deixa a fatura.'}</p>
        )}
      </div>
      <div>
        <label htmlFor="rv-note" className="label">Nota</label>
        <input id="rv-note" className="input" autoComplete="off" placeholder="Ex.: presente, almoço do time" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <label className={`flex items-start gap-3 text-sm ${locked ? 'text-faint' : ''}`}>
        <input type="checkbox" className="mt-0.5 size-[18px] flex-none accent-(--color-accent)" checked={split} disabled={locked} onChange={(e) => setSplit(e.target.checked)} />
        <span>Dividido com outra pessoa{locked ? ' (tem reembolso registrado)' : ''}</span>
      </label>
      {split && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rv-share" className="label">Sua parte (%)</label>
            <input id="rv-share" inputMode="decimal" autoComplete="off" className="input money" aria-invalid={!shareOk} value={shareText}
              onChange={(e) => setShareText(e.target.value.replace(/[^\d.,]/g, ''))} />
          </div>
          <div>
            <label htmlFor="rv-got" className="label">Já recebi (opcional)</label>
            <input id="rv-got" inputMode="decimal" autoComplete="off" className="input money" placeholder="0,00" aria-invalid={!gotOk} value={gotText}
              onChange={(e) => setGotText(e.target.value.replace(/[^\d.,]/g, ''))} />
          </div>
          <p className="money col-span-2 text-[13px] text-muted">
            {shareOk ? <>A receber <span className="font-semibold text-ink">{money(partner)}</span>{got > 0 && gotOk ? <>; registrando {money(got)} agora</> : null}.</> : 'Informe um percentual entre 0 e 100.'}
            {!gotOk && <span className="text-negative"> O recebido não pode passar do que falta.</span>}
          </p>
          {got > 0 && (
            <label className={`col-span-2 flex items-start gap-3 text-sm ${hasBalance ? '' : 'text-faint'}`}>
              <input type="checkbox" className="mt-0.5 size-[18px] flex-none accent-(--color-accent)" checked={gotCash} disabled={!hasBalance} onChange={(e) => setGotCash(e.target.checked)} />
              <span>{hasBalance ? 'Entrou na conta do saldo: somar ao saldo em caixa' : 'Saldo em caixa não informado: o reembolso não mexe nele'}</span>
            </label>
          )}
        </div>
      )}
      <FormError>{error}</FormError>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost h-12" onClick={onCancel}>Voltar</button>
        <button className="btn" disabled={busy || !merchantOk}>{busy ? 'Salvando…' : 'Salvar e confirmar'}</button>
      </div>
    </form>
  )
}

/** The Gastos menu for a pending row: summary, the three actions, the form in place when revising. */
export function PendingActions({ tx, summary, onClose }: { tx: Transaction; summary: ReactNode; onClose: () => void }) {
  const [editing, setEditing] = useState(false)
  if (editing) return <ReviewForm tx={tx} onDone={onClose} onCancel={() => setEditing(false)} />
  return (
    <div className="grid gap-2">
      {summary}
      <PendingTag t={tx} />
      <DuplicateNote tx={tx} />
      {tx.note && <p className="text-[13px] text-faint">{tx.note}</p>}
      <p className="text-[13px] text-muted text-pretty">
        {tx.cash_debited ? `Já saiu do saldo em caixa (${money(tx.cash_debited)}).` : tx.bill_month ? 'Já está na fatura.' : 'Não mexeu no saldo.'} Descartar desfaz isso.
      </p>
      <RowActions tx={tx} onEdit={() => setEditing(true)} onDone={onClose} />
    </div>
  )
}

function RefundItem({ r }: { r: NotificationRefund }) {
  const { notify } = useActions()
  const { busy, error, run } = useReviewRun()
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">Estorno{r.merchant ? ` · ${r.merchant}` : ''}</p>
          <p className="truncate text-[13px] text-faint">{dayLabel(spDate(r.posted_at))}{r.bank ? ` · ${BANK_LABEL[r.bank] ?? r.bank}` : ''}</p>
        </div>
        {r.amount != null && <span className="money flex-none font-semibold">{money(r.amount)}</span>}
        <button className="btn-ghost h-10 flex-none px-3.5" disabled={busy}
          onClick={async () => { if (await run({ kind: 'dismiss', id: r.id })) notify({ msg: 'Estorno dispensado' }) }}>Dispensar</button>
      </div>
      <FormError>{error}</FormError>
    </li>
  )
}

/** Every pending spend with its actions, "confirm the rest" and refunds waiting. One row's form replaces the list while open. */
export function PendingList() {
  const { data } = useBuffet()
  const { notify } = useActions()
  const p = pendingOf(data)
  const [editing, setEditing] = useState<string | null>(null)
  const { busy, error, run } = useReviewRun()
  const tx = p.rows.find((t) => t.id === editing)
  if (tx) return <ReviewForm tx={tx} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
  const clean = p.rows.filter((t) => !t.possible_duplicate_of)
  const confirmAll = async () => {
    if (await run({ kind: 'confirm', ids: clean.map((t) => t.id) })) notify({ msg: `${plural(clean.length, 'gasto confirmado', 'gastos confirmados')}` })
  }
  return (
    <div className="grid gap-3">
      {p.rows.length > 0 && (
        <>
          <p className="money text-[30px] leading-none font-extrabold tracking-[-0.03em]">{money(p.total)}</p>
          <p className="text-sm text-muted text-pretty">Chegaram pelas notificações do banco e já contam nos totais. Débito e PIX já saíram do saldo em caixa; crédito já está na fatura. Descartar desfaz isso.</p>
          <ul className="divide-y divide-rule">
            {p.rows.map((t) => (
              <li key={t.id} className="py-3">
                <div className="flex items-center gap-3">
                  <CategoryIcon category={t.category} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{t.merchant}</p>
                    <p className="truncate text-[13px] text-faint">{dayLabel(t.date)} · {t.category} · {where(t)}</p>
                  </div>
                  <span className="money flex-none font-semibold">{money(t.amount)}</span>
                </div>
                <DuplicateNote tx={t} />
                {t.note && <p className="mt-1 text-[13px] text-faint">{t.note}</p>}
                <RowActions tx={t} onEdit={() => setEditing(t.id)} />
              </li>
            ))}
          </ul>
          {clean.length > 1 && (
            <button className="btn" disabled={busy} onClick={confirmAll}>
              {busy ? 'Confirmando…' : `Confirmar os ${clean.length}${clean.length < p.rows.length ? ' sem aviso' : ''}`}
            </button>
          )}
          <FormError>{error}</FormError>
        </>
      )}
      {p.refunds.length > 0 && (
        <section aria-labelledby="refunds-h" className={p.rows.length ? 'border-t border-rule pt-3' : ''}>
          <h3 id="refunds-h" className="text-sm font-bold text-muted">Estornos recebidos</h3>
          <p className="mt-1 text-[13px] text-faint text-pretty">Nada foi alterado. Se for de um gasto já lançado, ajuste ou exclua ele em Gastos e depois dispense aqui.</p>
          <ul className="divide-y divide-rule">{p.refunds.map((r) => <RefundItem key={r.id} r={r} />)}</ul>
        </section>
      )}
    </div>
  )
}

/** Hoje: the count and total waiting for review; opens the list. Hidden when there's nothing. */
export function PendingCard() {
  const { data } = useBuffet()
  const p = pendingOf(data)
  const [open, setOpen] = useState(false)
  const n = p.rows.length + p.refunds.length
  const parts = [
    p.rows.length ? <span key="t">já contam nos totais</span> : null,
    p.duplicates ? <span key="d" className="text-negative">{plural(p.duplicates, 'possível duplicata', 'possíveis duplicatas')}</span> : null,
    p.refunds.length ? <span key="r">{plural(p.refunds.length, 'estorno', 'estornos')}</span> : null,
  ].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))
  return (
    <>
      {n > 0 && <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"
        className="card mt-3 flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-raised">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-muted">
            Pendentes de revisão{p.rows.length > 0 && <span className="font-normal text-faint"> · {plural(p.rows.length, 'gasto', 'gastos')}</span>}
          </span>
          <span className="block text-[13px] text-faint">{parts}</span>
        </span>
        <span className="money flex flex-none items-center gap-1.5 font-semibold">
          {p.rows.length > 0 && money(p.total)}<ChevronRight size={16} className="text-faint" aria-hidden />
        </span>
      </button>}
      {/* Closes by itself when the last one is reviewed (the dialog's close event resets `open`). */}
      <Sheet open={open && n > 0} onClose={() => setOpen(false)} title="Pendentes de revisão">
        <PendingList />
      </Sheet>
    </>
  )
}
