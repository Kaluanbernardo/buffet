import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Repeat } from 'lucide-react'
import { useBuffet } from '../data/store'
import type { SubCycle, Subscription, Transaction } from '../data/types'
import { advanced, CYCLE_LABEL, daysFrom, linkCandidates, perMonth, rolled, subAdvance, subDueLabel, subState, type SubFlag } from '../data/derive'
import { dayLabel, fmtDate, money, parseMoney, plural, today, uid } from '../lib/format'
import { Columns, Empty, Section, Segmented, Sheet } from '../components/ui'
import { useActions } from '../components/Actions'

const PILL: Record<SubFlag, string> = {
  missing: 'pill-bad', late: 'pill-warn', soon: 'pill-warn', later: 'pill-neutral', paused: 'pill-neutral', canceled: 'pill-neutral',
}
const CYCLES: { key: SubCycle; label: string }[] = [{ key: 'monthly', label: 'Mensal' }, { key: 'yearly', label: 'Anual' }]

/** The ↻ disc that marks a subscription everywhere (list, Hoje, Gastos). */
export function SubIcon({ size = 36 }: { size?: number }) {
  return (
    <span aria-hidden className="grid flex-none place-items-center rounded-full bg-raised text-muted" style={{ width: size, height: size }}>
      <Repeat size={Math.round(size * 0.47)} strokeWidth={1.75} />
    </span>
  )
}

type Mode = { kind: 'detail' | 'charge' | 'edit'; id: string } | { kind: 'new'; from?: Transaction } | null

/** Dívidas › Assinaturas: commitments (never spend). A charge is a real gasto linked by subscription_id. */
export default function Assinaturas() {
  const { data, update } = useBuffet()
  const { notify } = useActions()
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>(null)

  // Gastos › ⋯ › "Acompanhar como assinatura" lands here with ?from=<tx id>.
  const from = params.get('from')
  useEffect(() => {
    if (!from) return
    const t = data.transactions.find((x) => x.id === from)
    if (t && !t.subscription_id) setMode({ kind: 'new', from: t })
    setParams((p) => { p.delete('from'); return p }, { replace: true })
  }, [from, data.transactions, setParams])

  if (data.subscriptionsReady === false) {
    return (
      <Empty>
        Assinaturas ainda não estão ativas: a migration <span className="font-semibold text-ink">buffet_subscriptions</span> está pendente no Supabase.
        Depois de aplicada, recarregue o app.
      </Empty>
    )
  }

  const rows = data.subscriptions.map((s) => ({ s, st: subState(s, data.transactions) }))
  const active = rows.filter((r) => r.s.status === 'active').sort((a, b) => a.s.next_due.localeCompare(b.s.next_due))
  const rest = rows.filter((r) => r.s.status !== 'active').sort((a, b) => a.s.name.localeCompare(b.s.name))
  const monthly = active.reduce((x, r) => x + perMonth(r.s), 0)
  const attention = active.filter((r) => r.st.attention).length
  const current = mode && mode.kind !== 'new' ? data.subscriptions.find((s) => s.id === mode.id) : undefined

  const setSub = (s: Subscription) => update((d) => ({ ...d, subscriptions: d.subscriptions.map((x) => (x.id === s.id ? s : x)) }))
  const act = (msg: string, next: Subscription, prev: Subscription) => { setSub(next); notify({ msg, undo: () => setSub(prev) }) }

  const list = (items: typeof rows) => (
    <ul className="card divide-y divide-rule px-4">
      {items.map(({ s, st }) => (
        <li key={s.id} className="flex items-center gap-3 py-3">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setMode({ kind: 'detail', id: s.id })}>
            <SubIcon />
            <div className="min-w-0 flex-1">
              <p className={`truncate font-semibold ${s.status === 'canceled' ? 'text-muted line-through decoration-faint' : ''}`}>{s.name}</p>
              <p className="truncate text-[13px] text-faint">{[s.status === 'active' ? fmtDate(s.next_due).slice(0, 5) : null, s.bank ?? 'sem cartão', s.cycle === 'yearly' ? 'anual' : null].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex-none text-right">
              <p className="money font-semibold">{money(s.amount)}</p>
              <span className={`pill mt-1 ${PILL[st.flag]}`}>{subDueLabel(s, st.inDays)}</span>
            </div>
          </button>
          {s.status === 'active' && st.inDays <= s.remind_days && (
            <button className="btn-ghost h-9 flex-none px-3 text-[13px]" onClick={() => setMode({ kind: 'charge', id: s.id })}>Cobrou?</button>
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <>
      <Columns template="lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" main={<div className="lg:sticky lg:top-9">
        <section className="card grid grid-cols-2 divide-x divide-rule">
          <div className="p-4">
            <p className="text-sm font-semibold text-muted">Assinaturas por mês</p>
            <p className="money mt-1 text-[22px] leading-none font-extrabold tracking-[-0.03em]">{money(monthly)}</p>
          </div>
          <div className="p-4">
            <p className="text-sm font-semibold text-muted">Por ano</p>
            <p className="money mt-1 text-[22px] leading-none font-bold tracking-[-0.03em] text-muted">{money(monthly * 12)}</p>
            <p className="mt-1.5 text-xs text-faint">{plural(active.length, 'ativa', 'ativas')}{attention ? ` · ${attention} pede${attention > 1 ? 'm' : ''} atenção` : ''}</p>
          </div>
        </section>
        <p className="mt-3 px-1 text-xs text-faint text-pretty">Compromisso, não gasto: o valor só entra nos gastos quando a cobrança é lançada.</p>
        <button className="btn mt-4 w-full" onClick={() => setMode({ kind: 'new' })}><Plus size={18} strokeWidth={2.5} />Nova assinatura</button>
      </div>} side={<>
        <Section title="Ativas">
          {active.length === 0
            ? <Empty action={<button className="link" onClick={() => setMode({ kind: 'new' })}>Cadastrar assinatura</button>}>Nenhuma assinatura acompanhada ainda.</Empty>
            : list(active)}
        </Section>
        {rest.length > 0 && <Section title="Pausadas e canceladas">{list(rest)}</Section>}
      </>} />

      <Sheet open={mode !== null && (mode.kind === 'new' || Boolean(current))} onClose={() => setMode(null)}
        title={mode?.kind === 'new' ? 'Nova assinatura' : mode?.kind === 'edit' ? 'Editar assinatura' : mode?.kind === 'charge' ? `${current?.name ?? ''} cobrou?` : current?.name ?? ''}>
        {mode?.kind === 'new' && <SubForm from={mode.from} onDone={(s, tx) => {
          update((d) => ({ ...d, subscriptions: [s, ...d.subscriptions], transactions: tx ? d.transactions.map((x) => (x.id === tx ? { ...x, subscription_id: s.id } : x)) : d.transactions }))
          setMode(null)
          notify({ msg: `${s.name} cadastrada`, undo: () => update((d) => ({ ...d, subscriptions: d.subscriptions.filter((x) => x.id !== s.id),
            transactions: d.transactions.map((x) => (x.subscription_id === s.id ? { ...x, subscription_id: undefined } : x)) })) })
        }} />}
        {mode?.kind === 'edit' && current && <SubForm sub={current} onDone={(s) => { act(`${s.name} atualizada`, s, current); setMode({ kind: 'detail', id: s.id }) }} />}
        {mode?.kind === 'charge' && current && <ChargeFlow sub={current} onDone={() => setMode(null)} />}
        {mode?.kind === 'detail' && current && (
          <Detail sub={current} tx={data.transactions}
            onCharge={() => setMode({ kind: 'charge', id: current.id })}
            onEdit={() => setMode({ kind: 'edit', id: current.id })}
            onStatus={(status) => {
              const next: Subscription = status === 'active' ? { ...rolled(current), status, canceled_on: undefined }
                : { ...current, status, ...(status === 'canceled' ? { canceled_on: today() } : {}) }
              act(`${current.name} ${status === 'active' ? 'retomada' : status === 'paused' ? 'pausada' : 'cancelada'}`, next, current)
              setMode(null)
            }} />
        )}
      </Sheet>
    </>
  )
}

function Detail({ sub: s, tx, onCharge, onEdit, onStatus }: {
  sub: Subscription; tx: Transaction[]; onCharge: () => void; onEdit: () => void; onStatus: (s: Subscription['status']) => void
}) {
  const st = subState(s, tx)
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="money text-[30px] leading-none font-extrabold tracking-[-0.03em]">{money(s.amount)}</p>
          <p className="mt-1.5 text-sm text-muted">{CYCLE_LABEL[s.cycle].adj} · {s.bank ?? 'sem cartão'} · {s.category}</p>
        </div>
        <span className={`pill ${PILL[st.flag]}`}>{subDueLabel(s, st.inDays)}</span>
      </div>
      {s.status === 'active' && <p className="text-sm text-muted">Próxima cobrança: <span className="font-semibold text-ink">{fmtDate(s.next_due)}</span>
        {s.cycle === 'yearly' && <> · {money(perMonth(s))}/mês</>}</p>}
      {st.priceChanged !== null && <p className="money text-sm text-warning">Última cobrança veio {money(st.priceChanged)}, diferente do cadastrado.</p>}
      {st.flag === 'missing' && <p className="text-sm text-negative">A cobrança não apareceu. Cancelou ou ainda não lançou?</p>}
      {s.status === 'canceled' && s.cancel_hint && <p className="text-sm text-muted">Como cancelar: {s.cancel_hint}</p>}
      {s.note && <p className="text-sm text-muted">{s.note}</p>}

      <div>
        <div className="mb-2 flex items-baseline justify-between text-[13px]">
          <h3 className="font-bold text-muted">Cobranças</h3>
          {st.yearTotal > 0 && <span className="money text-faint">{money(st.yearTotal)} em {today().slice(0, 4)}</span>}
        </div>
        {st.charges.length === 0 ? <p className="text-sm text-faint">Nenhuma cobrança vinculada ainda.</p> : (
          <ul className="divide-y divide-rule rounded-2xl border border-line px-3">
            {st.charges.slice(0, 6).map((t) => (
              <li key={t.id} className="flex justify-between gap-3 py-2 text-sm">
                <span className="text-muted first-letter:uppercase">{dayLabel(t.date)}</span>
                <span className="money font-semibold">{money(t.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-2">
        {s.status === 'active' && <button className="btn w-full" onClick={onCharge}>Cobrou?</button>}
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-ghost h-11" onClick={onEdit}>Editar</button>
          {s.status === 'active'
            ? <button className="btn-ghost h-11" onClick={() => onStatus('paused')}>Pausar</button>
            : <button className="btn-ghost h-11" onClick={() => onStatus('active')}>Retomar</button>}
        </div>
        {s.status !== 'canceled' && (
          <button className="btn-ghost h-11 text-negative" onClick={() => onStatus('canceled')}>Cancelar assinatura</button>
        )}
        {s.status !== 'canceled' && s.cancel_hint && <p className="px-1 text-xs text-faint">Como cancelar no serviço: {s.cancel_hint}</p>}
      </div>
    </div>
  )
}

/** "Cobrou?": lançar the charge as a gasto, vincular an existing one, or skip the cycle (não cobrou). */
function ChargeFlow({ sub: s, onDone }: { sub: Subscription; onDone: () => void }) {
  const { data, update } = useBuffet()
  const { notify } = useActions()
  const [amount, setAmount] = useState(String(s.amount).replace('.', ','))
  const [date, setDate] = useState(s.next_due < today() ? s.next_due : today())
  const [keepPrice, setKeepPrice] = useState(true)
  const value = parseMoney(amount)
  const ok = Number.isFinite(value) && value > 0
  const differs = ok && Math.abs(value - s.amount) >= 0.005
  const candidates = linkCandidates(s, data.transactions).slice(0, 4)
  const snapshot = () => ({ subs: data.subscriptions, txs: data.transactions })
  const restore = (x: ReturnType<typeof snapshot>) => () => update((d) => ({ ...d, subscriptions: x.subs, transactions: x.txs }))

  const launch = (e: FormEvent) => {
    e.preventDefault()
    if (!ok) return
    const before = snapshot()
    const v = Math.round(value * 100) / 100
    const t: Transaction = { id: uid(), date, amount: v, merchant: s.name, category: s.category, bank: s.bank, subscription_id: s.id }
    const next = { ...advanced(s, date), ...(differs && keepPrice ? { amount: v } : {}) }
    update((d) => ({ ...d, transactions: [t, ...d.transactions], subscriptions: d.subscriptions.map((x) => (x.id === s.id ? next : x)) }))
    onDone()
    notify({ msg: `${money(v)} de ${s.name} lançado · próxima ${fmtDate(next.next_due).slice(0, 5)}`, undo: restore(before) })
  }
  const link = (t: Transaction) => {
    const before = snapshot()
    const next = advanced(s, t.date)
    update((d) => ({ ...d, transactions: d.transactions.map((x) => (x.id === t.id ? { ...x, subscription_id: s.id } : x)), subscriptions: d.subscriptions.map((x) => (x.id === s.id ? next : x)) }))
    onDone()
    notify({ msg: `${t.merchant} vinculado a ${s.name}`, undo: restore(before) })
  }
  const skip = () => {
    const before = snapshot()
    const next = advanced(s)
    update((d) => ({ ...d, subscriptions: d.subscriptions.map((x) => (x.id === s.id ? next : x)) }))
    onDone()
    notify({ msg: `${s.name}: ciclo pulado · próxima ${fmtDate(next.next_due).slice(0, 5)}`, undo: restore(before) })
  }

  return (
    <div className="space-y-6">
      <form onSubmit={launch} noValidate className="space-y-4">
        <h3 className="text-sm font-bold text-muted">Lançar a cobrança</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="sc-amount" className="label">Valor</label>
            <input id="sc-amount" data-autofocus inputMode="decimal" className="input money" aria-invalid={!ok}
              value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} />
          </div>
          <div>
            <label htmlFor="sc-date" className="label">Data</label>
            <input id="sc-date" type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
          </div>
        </div>
        {differs && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={keepPrice} onChange={(e) => setKeepPrice(e.target.checked)} className="size-4 accent-accent" />
            Atualizar o valor da assinatura para {money(value)}
          </label>
        )}
        <button className="btn w-full" disabled={!ok}>Lançar{ok ? ` ${money(value)}` : ''} como gasto</button>
      </form>

      <div>
        <h3 className="mb-2 text-sm font-bold text-muted">Ou vincular um gasto já lançado</h3>
        {candidates.length === 0 ? <p className="text-sm text-faint">Nenhum gasto parecido perto de {fmtDate(s.next_due).slice(0, 5)}.</p> : (
          <ul className="divide-y divide-rule rounded-2xl border border-line">
            {candidates.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => link(t)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-raised/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{t.merchant}</p>
                    <p className="text-[13px] text-faint first-letter:uppercase">{dayLabel(t.date)}{t.bank ? ` · ${t.bank}` : ''}</p>
                  </div>
                  <span className="money font-semibold">{money(t.amount)}</span>
                  <span className="link text-[13px]">Vincular</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-rule pt-4">
        <button type="button" className="btn-ghost h-11 w-full" onClick={skip}>Não cobrou neste ciclo</button>
        <p className="mt-2 px-1 text-xs text-faint">Pula para {fmtDate(advanced(s).next_due)} sem lançar nada.</p>
      </div>
    </div>
  )
}

/** Add/edit. From a gasto (Gastos › ⋯) it starts with its merchant, value, card and date, and links that gasto. */
function SubForm({ sub, from, onDone }: { sub?: Subscription; from?: Transaction; onDone: (s: Subscription, linkTx?: string) => void }) {
  const { data } = useBuffet()
  const banks = data.config.banks.filter((b) => b.status === 'active').map((b) => b.name)
  const cats = data.config.categories
  const defCat = cats.includes('Assinaturas') ? 'Assinaturas' : from?.category ?? cats[0]
  const [f, setF] = useState(() => ({
    name: sub?.name ?? from?.merchant ?? '',
    amount: sub ? String(sub.amount).replace('.', ',') : from ? String(from.amount).replace('.', ',') : '',
    cycle: sub?.cycle ?? 'monthly' as SubCycle,
    next_due: sub?.next_due ?? (from ? subAdvance(from.date, 'monthly') : subAdvance(today(), 'monthly')),
    bank: sub?.bank ?? from?.bank ?? banks[0] ?? '',
    category: sub?.category ?? defCat,
    remind_days: String(sub?.remind_days ?? 2),
    match: sub?.match ?? '',
    cancel_hint: sub?.cancel_hint ?? '',
    note: sub?.note ?? '',
  }))
  const [tried, setTried] = useState(false)
  const amount = parseMoney(f.amount)
  const amountOk = Number.isFinite(amount) && amount > 0
  const nameOk = f.name.trim().length > 0
  const remind = Math.min(30, Math.max(0, Math.round(Number(f.remind_days) || 0)))
  // A new subscription from a gasto: the next charge is one cycle after it (recomputed when the cycle flips).
  const setCycle = (cycle: SubCycle) => setF({ ...f, cycle, ...(!sub && from ? { next_due: subAdvance(from.date, cycle) } : {}) })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!amountOk || !nameOk || !f.next_due) return
    const s: Subscription = {
      ...(sub ?? { id: uid(), status: 'active' as const, started_on: from?.date ?? f.next_due }),
      name: f.name.trim(), amount: Math.round(amount * 100) / 100, cycle: f.cycle, next_due: f.next_due,
      bank: f.bank || undefined, category: f.category, remind_days: remind,
      match: f.match.trim() || undefined, cancel_hint: f.cancel_hint.trim() || undefined, note: f.note.trim() || undefined,
    }
    onDone(s, from?.id)
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {from && <p className="rounded-2xl bg-raised px-3 py-2.5 text-[13px] text-muted">
        A partir de <span className="font-semibold text-ink">{from.merchant}</span> · <span className="money">{money(from.amount)}</span> · {fmtDate(from.date)}. Esse gasto fica vinculado como cobrança.
      </p>}
      <div>
        <label htmlFor="sf-name" className="label">Nome</label>
        <input id="sf-name" data-autofocus className="input" placeholder="Ex.: Netflix, Spotify" autoComplete="off" aria-invalid={tried && !nameOk}
          value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        {tried && !nameOk && <p className="mt-2 text-sm text-negative">Dê um nome à assinatura.</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="sf-amount" className="label">Valor</label>
          <input id="sf-amount" inputMode="decimal" className="input money" placeholder="0,00" aria-invalid={tried && !amountOk}
            value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.,]/g, '') })} />
        </div>
        <div>
          <label htmlFor="sf-next" className="label">Próxima cobrança</label>
          <input id="sf-next" type="date" className="input" value={f.next_due} onChange={(e) => setF({ ...f, next_due: e.target.value })} />
        </div>
      </div>
      {tried && !amountOk && <p className="-mt-2 text-sm text-negative">Informe um valor maior que zero.</p>}
      <Segmented value={f.cycle} options={CYCLES} onChange={setCycle} label="Ciclo" />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="sf-bank" className="label">Cartão</label>
          <select id="sf-bank" className="input" value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })}>
            {[...new Set([...banks, ...(f.bank && !banks.includes(f.bank) ? [f.bank] : [])])].map((b) => <option key={b}>{b}</option>)}
            <option value="">Sem cartão</option>
          </select>
        </div>
        <div>
          <label htmlFor="sf-cat" className="label">Categoria</label>
          <select id="sf-cat" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {[...new Set([...cats, f.category])].map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="sf-remind" className="label">Lembrar (dias antes)</label>
          <input id="sf-remind" inputMode="numeric" className="input" value={f.remind_days} onChange={(e) => setF({ ...f, remind_days: e.target.value.replace(/\D/g, '') })} />
        </div>
        <div>
          <label htmlFor="sf-match" className="label">Aparece na fatura como</label>
          <input id="sf-match" className="input" placeholder={f.name || 'Ex.: meli'} autoComplete="off" value={f.match} onChange={(e) => setF({ ...f, match: e.target.value })} />
        </div>
      </div>
      <div>
        <label htmlFor="sf-hint" className="label">Como cancelar</label>
        <input id="sf-hint" className="input" placeholder="Ex.: app › Conta › Assinatura" autoComplete="off" value={f.cancel_hint} onChange={(e) => setF({ ...f, cancel_hint: e.target.value })} />
      </div>
      <div>
        <label htmlFor="sf-note" className="label">Nota</label>
        <input id="sf-note" className="input" autoComplete="off" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      <p className="text-xs text-faint">{f.cycle === 'yearly' && amountOk ? `Equivale a ${money(amount / 12)}/mês. ` : ''}
        {f.next_due && daysFrom(f.next_due) < 0 ? 'A próxima cobrança já passou: ela vai aparecer como vencida.' : ''}</p>
      <button className="btn w-full">{sub ? 'Salvar' : 'Acompanhar assinatura'}</button>
    </form>
  )
}
