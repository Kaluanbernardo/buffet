import { useBuffet } from '../data/store'
import { bills, daysFrom, daysUntilDue, dueLabel, isOpen, payoff, planOf, type Bill, type BillState } from '../data/derive'
import { dayLabel, money, plural, shortMonth } from '../lib/format'
import { useSearchParams } from 'react-router-dom'
import { Columns, Empty, ScreenHeader, Section, Segmented } from '../components/ui'
import { Ring } from '../components/charts'
import { useActions } from '../components/Actions'
import type { Debt, Transaction } from '../data/types'
import Assinaturas from './Assinaturas'

type Tab = 'faturas' | 'parcelas' | 'assinaturas'
const TABS: { key: Tab; label: string }[] = [{ key: 'faturas', label: 'Faturas' }, { key: 'parcelas', label: 'Parcelas' }, { key: 'assinaturas', label: 'Assinaturas' }]

/** "nov/26" from "2026-11". */
const mon = (mk: string) => shortMonth(Number(mk.slice(0, 4)), Number(mk.slice(5)) - 1)
const ddmm = (iso: string) => `${iso.slice(8)}/${iso.slice(5, 7)}`

/** Plans with materialized rows are paid through the card bill; the rest (loans, old entries) keep "Marcar parcela paga". */
const isPlan = (d: Debt, tx: Transaction[]) => d.kind !== 'bill' && d.kind !== 'loan' && tx.some((t) => t.debt_id === d.id)
const isLoan = (d: Debt, tx: Transaction[]) => d.kind !== 'bill' && !isPlan(d, tx)

/** Dívidas: Faturas | Parcelas | Assinaturas (?tab=parcelas|assinaturas, so Hoje and Gastos can deep-link). */
export default function Dividas() {
  const { data } = useBuffet()
  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.find((t) => t.key === params.get('tab'))?.key ?? 'faturas'
  const setTab = (t: Tab) => setParams((p) => { if (t === 'faturas') p.delete('tab'); else p.set('tab', t); return p }, { replace: true })
  const plans = data.debts.filter((d) => isOpen(d) && isPlan(d, data.transactions)).length
  const loans = data.debts.filter((d) => isOpen(d) && isLoan(d, data.transactions)).length
  const cards = bills(data).cards.length
  const subs = data.subscriptions.filter((s) => s.status === 'active').length
  const sub = tab === 'faturas'
    ? (cards ? `${plural(plans, 'parcelado', 'parcelados')} · ${plural(cards, 'cartão', 'cartões')}` : 'Nenhum cartão de crédito configurado')
    : tab === 'parcelas'
      ? (plans + loans ? `${plural(plans + loans, 'compromisso', 'compromissos')} em aberto` : 'Nada em aberto')
      : (subs ? `${plural(subs, 'assinatura ativa', 'assinaturas ativas')}` : 'Nenhuma assinatura ativa')
  return (
    <div>
      <ScreenHeader title="Dívidas" sub={sub} />
      <div className="mb-5 max-w-md md:mb-7"><Segmented value={tab} options={TABS} onChange={setTab} label="Tipo de compromisso" /></div>
      {tab === 'faturas' ? <Faturas /> : tab === 'parcelas' ? <Parcelas /> : <Assinaturas />}
    </div>
  )
}

// ---------------------------------------------------------------- faturas

const STATE: Record<BillState, { label: string; pill: string }> = {
  open: { label: 'Aberta', pill: 'pill-neutral' }, closed: { label: 'Fechada', pill: 'pill-warn' },
  future: { label: 'Próxima', pill: 'pill-neutral' }, paid: { label: 'Paga', pill: 'pill-ok' },
}

function Faturas() {
  const { data } = useBuffet()
  const b = bills(data)
  if (b.cards.length === 0) {
    return <Empty>Nenhum cartão com ciclo configurado. Pelo chat: <code className="text-ink">buffet card set Nubank --closing 4 --due 11</code></Empty>
  }
  const peak = Math.max(...b.unpaid.map((x) => x.total), 1)
  const paidBills = [...data.cardPayments].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 5)
  return (
    <Columns template="lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" main={<div className="lg:sticky lg:top-9">
      <section className="card p-4" aria-labelledby="committed-h">
        <p id="committed-h" className="text-sm font-semibold text-muted">Comprometido no cartão</p>
        <p className="money mt-1 text-[28px] leading-none font-extrabold tracking-[-0.03em]">{money(b.committed)}</p>
        <p className="money mt-2 text-[13px] text-muted">em aberto {money(b.now)} · próximas {money(b.later)}</p>
        {b.freeAfter && <p className="mt-0.5 text-[13px] text-faint">livre de parcelas depois de {mon(b.freeAfter)}</p>}
        {b.unpaid.length > 1 && (
          <div className="mt-4 flex h-16 items-end gap-1" role="img"
            aria-label={`Faturas a pagar por mês: ${b.unpaid.map((x) => `${mon(x.month)} ${money(x.total)}`).join(', ')}`}>
            {b.unpaid.map((x) => (
              <div key={`${x.card}-${x.month}`} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <div className={`w-full rounded-sm ${x.state === 'future' ? 'bg-control' : 'bg-accent'}`}
                  style={{ height: `${Math.max(3, (x.total / peak) * 44)}px` }} />
                <span aria-hidden className="text-[10px] leading-none text-faint">{mon(x.month).slice(0, 3)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <p className="mt-3 px-1 text-xs text-faint text-pretty">
        Fatura = compras no crédito pelo mês em que vencem. Parcelas entram uma por fatura; o valor informado pelo banco vale quando for maior que o detalhado.
      </p>
    </div>} side={<>
      {b.cards.map((c) => {
        const unpaid = c.bills.filter((x) => x.state !== 'paid')
        const now = unpaid.filter((x) => x.state !== 'future')
        return (
          <Section key={c.name} title={`${c.name} · fecha dia ${c.cycle.closing_day} · vence dia ${c.cycle.due_day}`}>
            {unpaid.length === 0 ? <Empty>Nenhuma fatura a pagar.</Empty> : (
              <ul className="card divide-y divide-rule px-4">
                {now.map((x, i) => <li key={x.month} className="py-4"><BillDetail bill={x} cash={i === 0 ? data.config.cash_balance : null} /></li>)}
                {groupFuture(unpaid.filter((x) => x.state === 'future')).map((g) => <li key={g[0].month} className="py-3.5"><FutureRow group={g} /></li>)}
              </ul>
            )}
          </Section>
        )
      })}
      {paidBills.length > 0 && (
        <Section title="Pagas">
          <ul className="card divide-y divide-rule px-4">
            {paidBills.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-muted">Fatura {p.card_bank}{p.bill_month ? ` · ${mon(p.bill_month)}` : ''}</p>
                  <p className="truncate text-[13px] text-faint">paga {dayLabel(p.date).toLowerCase()}{p.paid_from ? ` de ${p.paid_from}` : ''}</p>
                </div>
                <span className="money flex-none text-muted">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>} />
  )
}

/** Open or closed bill: what's in it (undetailed, à vista, each installment, forecast subscriptions) and the cash after paying. */
function BillDetail({ bill: x, cash }: { bill: Bill; cash?: number | null }) {
  const inDays = daysFrom(x.due)
  const close = daysFrom(x.close)
  const spot = x.items.filter((t) => !t.debt_id)
  const inst = x.items.filter((t) => t.debt_id)
  const plans = useBuffet().data.debts
  const of = (t: Transaction) => plans.find((d) => d.id === t.debt_id)?.installments_total
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{mon(x.month)} <span className={`pill ml-1.5 ${STATE[x.state].pill}`}>{STATE[x.state].label}</span></p>
          <p className="text-[13px] text-faint">
            {x.state === 'open' && close >= 0 ? `fecha ${close === 0 ? 'hoje' : close === 1 ? 'amanhã' : `em ${close} dias`} · ` : ''}
            vence {ddmm(x.due)}{inDays < 0 ? ` · venceu há ${plural(-inDays, 'dia', 'dias')}` : inDays <= 3 ? ` · ${dueLabel(inDays).toLowerCase()}` : ''}
          </p>
        </div>
        <p className="money flex-none text-[19px] font-extrabold tracking-[-0.02em]">{money(x.total)}</p>
      </div>
      <dl className="mt-3 grid gap-1.5 text-[13px]">
        {x.reported !== null && x.undetailed > 0 && (
          <Line label="Não detalhado (antes do Buffet)" value={money(x.undetailed)} muted />
        )}
        {spot.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 text-muted">
              <span>À vista · {plural(spot.length, 'compra', 'compras')} <span className="text-faint group-open:hidden">▸</span></span>
              <span className="money">{money(spot.reduce((s, t) => s + t.amount, 0))}</span>
            </summary>
            <ul className="mt-1.5 grid gap-1 border-l border-rule pl-3 text-faint">
              {spot.map((t) => (
                <li key={t.id} className="flex justify-between gap-3">
                  <span className="truncate">{ddmm(t.date)} · {t.merchant}{t.subscription_id ? ' ↻' : ''}</span>
                  <span className="money flex-none">{money(t.amount)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {inst.map((t) => <Line key={t.id} label={`${t.merchant} · parcela ${t.installment_no}/${of(t) ?? '?'}`} value={money(t.amount)} />)}
        {x.forecast.map((s) => <Line key={s.id} label={`${s.name} ↻ · previsto ${ddmm(s.next_due)}`} value={money(s.amount)} muted />)}
      </dl>
      {x.reported !== null && <p className="mt-2 text-xs text-faint">Total = valor informado pelo banco{x.forecast.length ? '; previstos não somam' : ''}.</p>}
      {cash != null && (
        <p className="money mt-2 border-t border-rule pt-2 text-[13px] text-muted">
          Saldo {money(cash)} → depois de pagar <span className="font-semibold text-ink">{money(cash - x.total)}</span>
        </p>
      )}
    </>
  )
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${muted ? 'text-faint' : 'text-muted'}`}>
      <dt className="truncate">{label}</dt>
      <dd className="money flex-none">{value}</dd>
    </div>
  )
}

/** Consecutive future bills with the same total and the same plans fold into one row ("jan/27 – mar/27"). */
function groupFuture(xs: Bill[]): Bill[][] {
  const key = (b: Bill) => `${b.total}|${b.items.map((t) => `${t.debt_id ?? t.id}`).sort().join(',')}|${b.forecast.length}`
  const out: Bill[][] = []
  for (const b of xs) {
    const last = out[out.length - 1]
    if (last && key(last[0]) === key(b) && b.items.every((t) => t.debt_id)) last.push(b)
    else out.push([b])
  }
  return out
}

function FutureRow({ group }: { group: Bill[] }) {
  const { data } = useBuffet()
  const first = group[0]
  const lastB = group[group.length - 1]
  const of = (t: Transaction) => data.debts.find((d) => d.id === t.debt_id)?.installments_total
  const what = group.length === 1
    ? first.items.map((t) => (t.debt_id ? `${t.merchant} ${t.installment_no}/${of(t) ?? '?'}` : t.merchant)).join(' · ')
    : [...new Set(first.items.map((t) => t.merchant))].join(' · ')
  const forecast = first.forecast.reduce((s, f) => s + f.amount, 0)
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-semibold">{group.length === 1 ? mon(first.month) : `${mon(first.month)} – ${mon(lastB.month)}`}
          <span className="ml-1.5 text-[13px] font-normal text-faint">{group.length === 1 ? `vence ${ddmm(first.due)}` : `${group.length} faturas`}</span></p>
        <p className="truncate text-[13px] text-faint">{what}{forecast > 0 && group.length === 1 ? ` · + ${money(forecast)} previsto` : ''}</p>
      </div>
      <p className="money flex-none font-semibold">{money(first.total)}{group.length > 1 && <span className="text-[13px] font-normal text-faint"> cada</span>}</p>
    </div>
  )
}

// ---------------------------------------------------------------- parcelas

function Parcelas() {
  const { data, update } = useBuffet()
  const { notify } = useActions()
  const tx = data.transactions
  // Card plans: their installments are rows paid through the bill — summed here only from those rows, never on top of the bill.
  const plans = data.debts.filter((d) => isPlan(d, tx)).map((d) => ({ d, p: planOf(d, tx) }))
  const openPlans = plans.filter((x) => x.p.left.length > 0).sort((a, b) => (a.p.last ?? '').localeCompare(b.p.last ?? ''))
  const loans = data.debts.filter((d) => isOpen(d) && isLoan(d, tx)).map((d) => ({ ...d, inDays: daysUntilDue(d.due_day), end: payoff(d) })).sort((a, b) => a.inDays - b.inDays)
  const done = [...plans.filter((x) => x.p.left.length === 0).map((x) => x.d), ...data.debts.filter((d) => !isOpen(d) && isLoan(d, tx))]
  const nextBills = openPlans.reduce((s, x) => s + (x.p.next?.amount ?? 0), 0) + loans.reduce((s, d) => s + d.installment_amount, 0)
  const owed = openPlans.reduce((s, x) => s + x.p.owed, 0) + loans.reduce((s, d) => s + d.end.owed, 0)
  const lastMk = [...openPlans.map((x) => x.p.last ?? ''), ...loans.map((d) => `${d.end.year}-${String(d.end.month + 1).padStart(2, '0')}`)].sort().pop()

  const pay = (d: Debt) => {
    const step = (n: number) => update((x) => ({ ...x, debts: x.debts.map((y) => (y.id === d.id ? { ...y, installments_paid: n } : y)) }))
    step(d.installments_paid + 1)
    notify({ msg: `Parcela ${d.installments_paid + 1}/${d.installments_total} de ${d.description} paga`, undo: () => step(d.installments_paid) })
  }

  return (
    <Columns template="lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" main={<div className="lg:sticky lg:top-9">
      <section className="card grid grid-cols-2 divide-x divide-rule">
        <div className="p-4">
          <p className="text-sm font-semibold text-muted">Na próxima fatura</p>
          <p className="money mt-1 text-[22px] leading-none font-extrabold tracking-[-0.03em]">{money(nextBills)}</p>
          <p className="mt-1.5 text-xs text-faint">só parcelas</p>
        </div>
        <div className="p-4">
          <p className="text-sm font-semibold text-muted">Faltam</p>
          <p className="money mt-1 text-[22px] leading-none font-bold tracking-[-0.03em] text-muted">{money(owed)}</p>
          {lastMk && <p className="mt-1.5 text-xs text-faint">livre em {mon(lastMk)}</p>}
        </div>
      </section>
      <p className="mt-3 px-1 text-xs text-faint text-pretty">Parcelas no cartão são pagas pela fatura (aba Faturas); aqui é a visão por compra, não some com a fatura.</p>
    </div>} side={<>
      <Section title="Em aberto">
        {openPlans.length === 0 && loans.length === 0 ? <Empty>Nenhuma parcela em aberto.</Empty> : (
          <ul className="card divide-y divide-rule px-4">
            {openPlans.map(({ d, p }) => {
              const paid = d.installments_total - p.left.length
              const lastRow = p.rows[p.rows.length - 1]
              const odd = lastRow && Math.abs(lastRow.amount - d.installment_amount) >= 0.005
              return (
                <li key={d.id} className="py-4">
                  <div className="flex items-start gap-3.5">
                    <Ring value={paid} total={d.installments_total} label={`Parcelas pagas de ${d.description}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{d.description}</p>
                          <p className="money text-[13px] text-faint">{d.card ?? d.bank} · {money(p.total)} em {d.installments_total}x</p>
                        </div>
                        <p className="money flex-none font-bold">{money(d.installment_amount)}</p>
                      </div>
                      <p className="money mt-2 text-[13px] text-muted">
                        {paid}/{d.installments_total} pagas
                        {p.next && <> · próxima <span className="font-semibold text-ink">{mon(p.next.bill_month ?? p.next.date.slice(0, 7))} ({p.next.installment_no}/{d.installments_total})</span></>}
                      </p>
                      <p className="money text-[13px] text-faint">faltam {money(p.owed)}{p.last && <> · última em {mon(p.last)}{odd && <> ({money(lastRow.amount)})</>}</>}</p>
                      <details className="mt-2 text-[13px]">
                        <summary className="link cursor-pointer list-none">Ver cronograma</summary>
                        <ol className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-faint sm:grid-cols-3">
                          {p.rows.map((t) => (
                            <li key={t.id} className={`money flex justify-between gap-2 ${(t.installment_no ?? 0) <= d.installments_paid ? 'line-through' : ''}`}>
                              <span>{t.installment_no}/{d.installments_total} {t.bill_month ? mon(t.bill_month) : ddmm(t.date)}</span>
                              <span>{money(t.amount)}</span>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </div>
                  </div>
                </li>
              )
            })}
            {loans.map((d) => {
              const soon = d.inDays <= 3
              const next = Math.min(d.installments_paid + 1, d.installments_total)
              return (
                <li key={d.id} className="py-4">
                  <div className="flex items-start gap-3.5">
                    <Ring value={d.installments_paid} total={d.installments_total} label={`Parcelas pagas de ${d.description}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{d.description}</p>
                          <p className="text-[13px] text-faint">{d.bank} · todo dia {d.due_day}</p>
                        </div>
                        <div className="flex-none text-right">
                          <p className="money font-bold">{d.installment_amount > 0 ? money(d.installment_amount) : <span className="text-faint">—</span>}</p>
                          <span className={`pill mt-1 ${soon ? 'pill-warn' : 'pill-neutral'}`}>{dueLabel(d.inDays)}</span>
                        </div>
                      </div>
                      <p className="money mt-2 text-[13px] text-muted">
                        Parcela <span className="font-semibold text-ink">{next} de {d.installments_total}</span>
                        {d.installment_amount > 0 && <> · faltam {money(d.end.owed)}</>}
                        {' · '}quita em {shortMonth(d.end.year, d.end.month)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button className="btn-ghost h-9 px-3.5 text-[13px]" onClick={() => pay(d)}>Marcar parcela {next} paga</button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {done.length > 0 && (
        <Section title="Quitadas">
          <ul className="card divide-y divide-rule px-4">
            {done.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                <span className="truncate text-muted">{d.description}</span>
                <span className="pill pill-ok">Quitada</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>} />
  )
}
