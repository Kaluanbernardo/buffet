import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, Plus, Search, Trash2, X } from 'lucide-react'
import { useBuffet } from '../data/store'
import type { CardPayment, Transaction } from '../data/types'
import { categoryShare, monthDays, monthSummary, weekDays } from '../data/derive'
import { addDays, dayLabel, money, monthKey, monthName, parseISO, plural, shiftMonth, today, valuesHidden, weekRange, weekStart } from '../lib/format'
import { catColor, CategoryIcon, Columns, Empty, PeriodSwitcher, ScreenHeader, Segmented } from '../components/ui'
import { DailyBars, Donut, WeekBars } from '../components/charts'
import { useActions } from '../components/Actions'

/** Day totals in the strip: "86", "1,2 mil" — the R$ is implied. */
const num = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })

type View = 'dia' | 'semana' | 'mes'
const VIEWS: { key: View; label: string }[] = [{ key: 'dia', label: 'Dia' }, { key: 'semana', label: 'Semana' }, { key: 'mes', label: 'Mês' }]

const norm = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

export default function Gastos() {
  const { data, update } = useBuffet()
  const { openNew, notify } = useActions()
  const current = monthKey(today())
  const first = useMemo(() => data.transactions.reduce((min, t) => (monthKey(t.date) < min ? monthKey(t.date) : min), current), [data.transactions, current])
  const [params, setParams] = useSearchParams()
  const cat = params.get('cat')
  const setCat = (c: string | null) => setParams((p) => { if (c) p.set('cat', c); else p.delete('cat'); return p }, { replace: true })
  const view: View = (['dia', 'semana', 'mes'] as const).find((v) => v === params.get('v')) ?? 'mes'
  const setView = (v: View) => setParams((p) => { p.set('v', v); return p }, { replace: true })
  const [mk, setMk] = useState(current)
  const t = today()
  const [day, setDay] = useState(t)
  const [wk, setWk] = useState(weekStart(t))
  const [q, setQ] = useState('')

  // Period first (the chosen day, week or month), then category and search on top of it.
  const inMonth = data.transactions.filter((x) => monthKey(x.date) === mk)
  const wkEnd = addDays(wk, 6)
  const inWeek = data.transactions.filter((x) => x.date >= wk && x.date <= wkEnd)
  const scope = view === 'semana' ? inWeek : inMonth
  const usedCats = [...new Set(scope.map((x) => x.category))].sort((a, b) => data.config.categories.indexOf(a) - data.config.categories.indexOf(b))
  if (cat && !usedCats.includes(cat)) usedCats.push(cat)
  const needle = norm(q.trim())
  const matches = (x: Transaction) => (!cat || x.category === cat) && (!needle || norm(x.merchant).includes(needle) || norm(x.note ?? '').includes(needle))
  const shown = scope.filter(matches)
  const list = (view === 'dia' ? shown.filter((x) => x.date === day) : shown).sort((a, b) => b.date.localeCompare(a.date))
  const total = list.reduce((s, x) => s + x.amount, 0)
  const filtered = Boolean(cat || needle)
  // Card bill payments sit in the timeline, muted and outside every total (they aren't spending). No category → hidden under a chip.
  const inPeriod = (x: { date: string }) => (view === 'dia' ? x.date === day : view === 'semana' ? x.date >= wk && x.date <= wkEnd : monthKey(x.date) === mk)
  const bills = cat ? [] : data.cardPayments.filter((b) => inPeriod(b) && (!needle || norm(`fatura ${b.card_bank} ${b.note ?? ''}`).includes(needle)))

  const firstWeek = weekStart(`${first}-01`)
  const pickMonth = (n: number) => {
    const next = shiftMonth(mk, n)
    setMk(next)
    setDay(next === current ? t : `${next}-${String(new Date(Number(next.slice(0, 4)), Number(next.slice(5)), 0).getDate()).padStart(2, '0')}`)
  }
  const periodName = view === 'dia' ? dayLabel(day).toLowerCase() : view === 'semana' ? (wk === weekStart(t) ? 'nesta semana' : `na semana ${weekRange(wk)}`) : monthName(mk).toLowerCase()

  type Row = { tx: Transaction } | { bill: CardPayment }
  const days = new Map<string, Row[]>()
  const rows: [string, Row][] = [...list.map((tx) => [tx.date, { tx }] as [string, Row]), ...bills.map((bill) => [bill.date, { bill }] as [string, Row])]
  for (const [date, r] of rows.sort((a, b) => b[0].localeCompare(a[0]))) days.set(date, [...(days.get(date) ?? []), r])

  const remove = (t: Transaction) => {
    update((d) => ({ ...d, transactions: d.transactions.filter((x) => x.id !== t.id) }))
    notify({ msg: `${t.merchant} removido`, undo: () => update((d) => ({ ...d, transactions: [t, ...d.transactions] })) })
  }

  return (
    <div>
      <ScreenHeader
        title="Gastos"
        sub={<span className="money">{plural(list.length, 'lançamento', 'lançamentos')} · <span className="text-ink font-semibold">{money(total)}</span></span>}
        action={<button className="btn h-11 px-4 md:hidden" onClick={openNew}><Plus size={18} strokeWidth={2.5} />Novo</button>}
      />

      <Columns template="lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]" main={<>
      <Segmented value={view} options={VIEWS} onChange={setView} label="Agrupar gastos por" />
      <div className="mt-3">
        {view === 'semana' ? (
          <PeriodSwitcher unit="Semana" label={wk === weekStart(t) ? 'Esta semana' : wk === addDays(weekStart(t), -7) ? 'Semana passada' : weekRange(wk)}
            prevDisabled={wk <= firstWeek} nextDisabled={wk >= weekStart(t)} onPrev={() => setWk(addDays(wk, -7))} onNext={() => setWk(addDays(wk, 7))} />
        ) : (
          <PeriodSwitcher label={monthName(mk)} prevDisabled={mk <= first} nextDisabled={mk >= current} onPrev={() => pickMonth(-1)} onNext={() => pickMonth(1)} />
        )}
      </div>

      <div className="relative mb-3">
        <Search size={17} aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
        <input type="search" aria-label="Buscar por estabelecimento" placeholder="Buscar estabelecimento" autoComplete="off"
          className="input h-11 pr-11 pl-10" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && (
          <button type="button" aria-label="Limpar busca" onClick={() => setQ('')}
            className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-faint hover:text-ink">
            <X size={16} />
          </button>
        )}
      </div>

      {usedCats.length > 0 && (
        <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0" role="group" aria-label="Filtrar por categoria">
          {[null, ...usedCats].map((c) => (
            <button key={c ?? 'all'} aria-pressed={cat === c} onClick={() => setCat(c)}
              className={`flex h-9 flex-none items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors ${cat === c ? 'border-ink bg-ink text-ground' : 'border-control text-muted hover:text-ink'}`}>
              {c && <span aria-hidden className="size-2 rounded-full" style={{ background: catColor(c) }} />}
              {c ?? 'Todas'}
            </button>
          ))}
        </div>
      )}

      {view === 'dia' && <DayStrip key={mk} days={monthDays(inMonth.filter(matches), mk)} value={day} onChange={setDay} />}
      {view === 'semana' && <WeekPanel key={wk} start={wk} tx={data.transactions.filter(matches)} />}
      {view === 'mes' && <MonthPanel key={mk} mk={mk} tx={shown} onPick={(c) => setCat(c === cat ? null : c)} />}
      </>} side={<>

      {list.length === 0 && bills.length === 0 ? (
        filtered ? (
          <Empty action={<button className="link" onClick={() => { setQ(''); setCat(null) }}>Limpar filtros</button>}>
            Nada encontrado {view === 'mes' ? 'em ' : ''}{periodName} com esses filtros.
          </Empty>
        ) : (
          <Empty action={<button className="link" onClick={openNew}>Lançar gasto</button>}>
            Nenhum gasto {view === 'mes' ? 'em ' : ''}{periodName}. Quando lançar, ele aparece aqui agrupado por dia.
          </Empty>
        )
      ) : (
        <div className="space-y-6">
          {[...days].map(([date, items]) => (
            <section key={date}>
              <div className="mb-2 flex items-baseline justify-between px-1 text-[13px]">
                <h2 className="font-bold text-muted first-letter:uppercase">{dayLabel(date)}</h2>
                {items.some((r) => 'tx' in r) && <span className="money text-faint">{money(items.reduce((s, r) => s + ('tx' in r ? r.tx.amount : 0), 0))}</span>}
              </div>
              <ul className="card divide-y divide-rule">
                {items.map((r) => {
                  if ('bill' in r) return <BillRow key={r.bill.id} bill={r.bill} />
                  const t = r.tx
                  return (
                    <li key={t.id} className="group flex items-center gap-3 py-3 pr-1.5 pl-4">
                      <CategoryIcon category={t.category} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{t.merchant}</p>
                        <p className="truncate text-[13px] text-faint">{t.category}{t.bank ? ` · ${t.bank}` : ''}{t.note ? ` · ${t.note}` : ''}</p>
                      </div>
                      <span className="money flex-none font-semibold">{money(t.amount)}</span>
                      <button aria-label={`Excluir ${t.merchant}`} onClick={() => remove(t)}
                        className="grid size-10 flex-none place-items-center rounded-full text-faint transition-colors hover:bg-negative-tint hover:text-negative">
                        <Trash2 size={16} />
                      </button>
                    </li>
                    )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      </>} />
    </div>
  )
}

/** A card bill payment in the timeline: muted, transfer icon, says it's outside the totals. Removal goes through the chat (buffet del-bill). */
function BillRow({ bill }: { bill: CardPayment }) {
  return (
    <li className="flex items-center gap-3 py-3 pr-4 pl-4 text-muted">
      <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full border border-dashed border-control text-faint">
        <ArrowLeftRight size={16} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">Fatura {bill.card_bank}</p>
        <p className="truncate text-[13px] text-faint">Não conta como gasto{bill.paid_from ? ` · ${bill.paid_from}` : ''}</p>
      </div>
      <span className="money flex-none text-faint">{money(bill.amount)}</span>
    </li>
  )
}

/** Dia: horizontal calendar strip of the month, each day with its total; the chosen day's list sits below. */
function DayStrip({ days, value, onChange }: { days: { date: string; day: number; total: number }[]; value: string; onChange: (d: string) => void }) {
  const t = today()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }) }, [])
  return (
    <div ref={ref} role="radiogroup" aria-label="Escolher dia" className="-mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
      {days.map((d) => {
        const on = d.date === value
        const future = d.date > t
        return (
          <button key={d.date} type="button" role="radio" aria-checked={on} disabled={future} onClick={() => onChange(d.date)}
            aria-label={`${dayLabel(d.date)}: ${d.total > 0 ? money(d.total) : 'sem gastos'}`}
            className={`flex w-[52px] flex-none flex-col items-center gap-1 rounded-2xl border py-2 transition-colors disabled:opacity-35 ${on ? 'border-ink bg-ink text-ground' : 'border-line bg-surface text-muted hover:text-ink'}`}>
            <span className="text-[11px] font-semibold uppercase">{parseISO(d.date).toLocaleDateString('pt-BR', { weekday: 'short' }).slice(0, 3)}</span>
            <span className={`text-[17px] leading-none font-bold ${d.date === t && !on ? 'text-accent' : ''}`}>{d.day}</span>
            <span aria-hidden className={`money h-3.5 text-[10px] leading-none font-semibold ${on ? '' : d.total > 0 ? 'text-ink' : 'text-faint'}`}>
              {future ? '' : d.total > 0 ? (valuesHidden() ? '••' : num.format(d.total < 1000 ? Math.round(d.total) : d.total)) : '–'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Semana: seg → dom bars against last week, plus the change in words. */
function WeekPanel({ start, tx }: { start: string; tx: Transaction[] }) {
  const days = weekDays(tx, start)
  const prev = weekDays(tx, addDays(start, -7))
  const t = today()
  // Compare like with like: in the current week only the days already lived.
  const upto = days.filter((d) => d.date <= t).length
  const sum = (xs: { total: number }[]) => xs.reduce((s, d) => s + d.total, 0)
  const now = sum(days.slice(0, upto))
  const before = sum(prev.slice(0, upto))
  const hasPrev = prev.some((d) => d.total > 0)
  const diff = before > 0 ? (now - before) / before : null
  return (
    <section className="card mb-5 p-4" aria-label={`Semana ${weekRange(start)}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">{weekRange(start)}</p>
          <p className="money text-[22px] leading-tight font-extrabold tracking-[-0.03em]">{money(sum(days))}</p>
        </div>
        {hasPrev && (
          <p className="money text-right text-[13px] text-muted">
            {diff === null ? <>semana anterior<br />{money(before)}</>
              : <><span className={diff > 0.05 ? 'font-semibold text-warning' : diff < -0.05 ? 'font-semibold text-accent' : 'font-semibold'}>
                  {diff > 0 ? '+' : diff < 0 ? '−' : ''}{Math.abs(Math.round(diff * 100))}%
                </span> vs semana anterior<br /><span className="text-faint">{upto < 7 ? `mesmos ${upto} dias: ` : ''}{money(before)}</span></>}
          </p>
        )}
      </div>
      <WeekBars days={days} prev={hasPrev ? prev : undefined} />
    </section>
  )
}

/** Mês: category donut (tap filters) + one bar per day with the plan's daily allowance. */
function MonthPanel({ mk, tx, onPick }: { mk: string; tx: Transaction[]; onPick: (c: string) => void }) {
  const { data } = useBuffet()
  const share = categoryShare(tx)
  const m = monthSummary(data, mk)
  const days = monthDays(tx, mk)
  if (share.length === 0) return null
  const name = monthName(mk).toLowerCase()
  return (
    <section className="card mb-5 space-y-5 p-4" aria-label={`Resumo de ${name}`}>
      <Donut slices={share} label={`Gastos de ${name} por categoria`} caption={`em ${monthName(mk).split(' ')[0].toLowerCase()}`} onPick={onPick} />
      <div className="border-t border-rule pt-4">
        <DailyBars days={days} allowance={m.limit > 0 ? m.limit / m.clock.days : undefined}
          from={`1º de ${m.clock.name}`} to={`dia ${m.clock.days}`} label={`Gastos por dia em ${name}`} />
      </div>
    </section>
  )
}
