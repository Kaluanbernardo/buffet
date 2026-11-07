import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, CalendarDays, MoreHorizontal, Plus, Repeat, Search, Trash2, X } from 'lucide-react'
import { useBuffet } from '../data/store'
import type { CardPayment, Transaction } from '../data/types'
import { categoryFlow, categoryShare, isPosted, monthDays, monthSummary, PAY_FILTERS, payMatches, posted, spendOf, spendScope, weekDays, type FlowMode, type PayFilter } from '../data/derive'
import { addDays, dayLabel, money, monthKey, monthName, parseISO, plural, shiftMonth, today, valuesHidden, weekRange, weekStart } from '../lib/format'
import { catColor, CategoryIcon, Columns, Empty, PeriodSwitcher, ScreenHeader, Segmented, Sheet } from '../components/ui'
import { CategoryFlow, DailyBars, Donut, WeekBars } from '../components/charts'
import { useActions } from '../components/Actions'
import { SplitActions, SplitLine } from '../components/Split'

/** Day totals in the strip: "86", "1,2 mil" — the R$ is implied. */
const num = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })

type View = 'dia' | 'semana' | 'mes' | 'tudo'
const VIEWS: { key: View; label: string }[] = [{ key: 'dia', label: 'Dia' }, { key: 'semana', label: 'Semana' }, { key: 'mes', label: 'Mês' }, { key: 'tudo', label: 'Tudo' }]
type Mode = 'lista' | 'cal'
const MODES: { key: Mode; label: string }[] = [{ key: 'lista', label: 'Lista' }, { key: 'cal', label: 'Calendário' }]
const FLOW_MODES: { key: FlowMode; label: string }[] = [{ key: 'area', label: 'Área empilhada' }, { key: 'stream', label: 'Streamgraph' }]
/** "Tudo" renders this many months at a time; scrolling to the end loads the next batch. */
const MONTH_BATCH = 3

const norm = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

export default function Gastos() {
  const { data, update } = useBuffet()
  const { openNew, notify } = useActions()
  const current = monthKey(today())
  const first = useMemo(() => data.transactions.reduce((min, t) => (monthKey(t.date) < min ? monthKey(t.date) : min), current), [data.transactions, current])
  const [params, setParams] = useSearchParams()
  const cat = params.get('cat')
  const setCat = (c: string | null) => setParams((p) => { if (c) p.set('cat', c); else p.delete('cat'); return p }, { replace: true })
  const listView: View = (['dia', 'semana', 'mes', 'tudo'] as const).find((v) => v === params.get('v')) ?? 'mes'
  const setView = (v: View) => setParams((p) => { p.set('v', v); p.delete('m'); return p }, { replace: true })
  const pay: PayFilter = PAY_FILTERS.find((f) => f.key === params.get('pay'))?.key ?? 'todos'
  const setPay = (f: PayFilter) => setParams((p) => { if (f !== 'todos') p.set('pay', f); else p.delete('pay'); return p }, { replace: true })
  const [flowMode, setFlowMode] = useState<FlowMode>('area')
  const mode: Mode = params.get('m') === 'cal' ? 'cal' : 'lista'
  const setMode = (m: Mode) => setParams((p) => { if (m === 'cal') p.set('m', 'cal'); else p.delete('m'); return p }, { replace: true })
  // The calendar is a month of days: underneath it behaves as "Dia" (the list shows the tapped day).
  const view: View = mode === 'cal' ? 'dia' : listView
  const [picker, setPicker] = useState(false)
  const [months, setMonths] = useState(MONTH_BATCH)
  const [mk, setMk] = useState(current)
  const t = today()
  const [day, setDay] = useState(t)
  const [wk, setWk] = useState(weekStart(t))
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<Transaction | null>(null)
  const navigate = useNavigate()
  const subName = (id: string) => data.subscriptions.find((s) => s.id === id)?.name

  // Period first (the chosen day, week or month), then category and search on top of it. Only rows dated up to today:
  // future installments (one row per month) are listed apart as "Agendadas", outside every total.
  // The payment filter sits at the root, so list, calendar, day strip, charts and history all read the same rows.
  const done = spendScope(data, pay, t)
  const inMonth = done.filter((x) => monthKey(x.date) === mk)
  const wkEnd = addDays(wk, 6)
  const inWeek = done.filter((x) => x.date >= wk && x.date <= wkEnd)
  const scope = view === 'semana' ? inWeek : view === 'tudo' ? done : inMonth
  const usedCats = [...new Set(scope.map((x) => x.category))].sort((a, b) => data.config.categories.indexOf(a) - data.config.categories.indexOf(b))
  if (cat && !usedCats.includes(cat)) usedCats.push(cat)
  const needle = norm(q.trim())
  const matches = (x: Transaction) => (!cat || x.category === cat) && (!needle || norm(x.merchant).includes(needle) || norm(x.note ?? '').includes(needle))
  const shown = scope.filter(matches)
  const list = (view === 'dia' ? shown.filter((x) => x.date === day) : shown).sort((a, b) => b.date.localeCompare(a.date))
  const total = list.reduce((s, x) => s + spendOf(x), 0)
  const scheduled = view === 'mes' ? data.transactions.filter((x) => !isPosted(x, t) && payMatches(x, pay) && monthKey(x.date) === mk && matches(x)).sort((a, b) => a.date.localeCompare(b.date)) : []
  const filtered = Boolean(cat || needle || pay !== 'todos')
  // Card bill payments sit in the timeline, muted and outside every total (they aren't spending). No category → hidden under a chip.
  const inPeriod = (x: { date: string }) => (view === 'tudo' ? true : view === 'dia' ? x.date === day : view === 'semana' ? x.date >= wk && x.date <= wkEnd : monthKey(x.date) === mk)
  // They carry no payment method, so a specific method leaves them out like any other row without one.
  const bills = cat || pay !== 'todos' ? [] : data.cardPayments.filter((b) => inPeriod(b) && (!needle || norm(`fatura ${b.card_bank} ${b.note ?? ''}`).includes(needle)))

  const firstWeek = weekStart(`${first}-01`)
  const pickMonth = (n: number) => goMonth(shiftMonth(mk, n))
  const goMonth = (next: string) => {
    setMk(next)
    setDay(next === current ? t : `${next}-${String(new Date(Number(next.slice(0, 4)), Number(next.slice(5)), 0).getDate()).padStart(2, '0')}`)
  }
  const periodName = view === 'tudo' ? 'no histórico' : view === 'dia' ? dayLabel(day).toLowerCase() : view === 'semana' ? (wk === weekStart(t) ? 'nesta semana' : `na semana ${weekRange(wk)}`) : monthName(mk).toLowerCase()

  type Row = { tx: Transaction } | { bill: CardPayment }
  const days = new Map<string, Row[]>()
  const rows: [string, Row][] = [...list.map((tx) => [tx.date, { tx }] as [string, Row]), ...bills.map((bill) => [bill.date, { bill }] as [string, Row])]
  for (const [date, r] of rows.sort((a, b) => b[0].localeCompare(a[0]))) days.set(date, [...(days.get(date) ?? []), r])
  // "Tudo": the newest `months` months with rows, a month heading above each; the rest loads on scroll.
  const dayMonths = [...new Set([...days.keys()].map(monthKey))]
  const visibleDays = view === 'tudo' ? [...days].filter(([date]) => dayMonths.indexOf(monthKey(date)) < months) : [...days]
  const monthTotal = (m: string) => list.reduce((s, x) => s + (monthKey(x.date) === m ? spendOf(x) : 0), 0)
  const more = view === 'tudo' && dayMonths.length > months
  const monthLabel = (
    <button type="button" onClick={() => setPicker(true)} aria-haspopup="dialog" aria-label={`${monthName(mk)} — escolher mês ou ano`}
      className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 transition-colors hover:bg-raised">
      <CalendarDays size={16} aria-hidden className="text-faint" />{monthName(mk)}
    </button>
  )

  const unlink = (t: Transaction) => {
    const set = (sid?: string) => update((d) => ({ ...d, transactions: d.transactions.map((x) => (x.id === t.id ? { ...x, subscription_id: sid } : x)) }))
    set(undefined)
    notify({ msg: `${t.merchant} desvinculado da assinatura`, undo: () => set(t.subscription_id) })
  }
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
      <Segmented value={mode} options={MODES} onChange={setMode} label="Ver gastos como" />
      {mode === 'lista' && <div className="mt-2"><Segmented value={listView} options={VIEWS} onChange={setView} label="Agrupar gastos por" /></div>}
      <div className="mt-3">
        {view === 'tudo' ? null : view === 'semana' ? (
          <PeriodSwitcher unit="Semana" label={wk === weekStart(t) ? 'Esta semana' : wk === addDays(weekStart(t), -7) ? 'Semana passada' : weekRange(wk)}
            prevDisabled={wk <= firstWeek} nextDisabled={wk >= weekStart(t)} onPrev={() => setWk(addDays(wk, -7))} onNext={() => setWk(addDays(wk, 7))} />
        ) : (
          <PeriodSwitcher label={monthLabel} prevDisabled={mk <= first} nextDisabled={mk >= current} onPrev={() => pickMonth(-1)} onNext={() => pickMonth(1)} />
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

      <div className="mb-3"><Segmented value={pay} options={PAY_FILTERS} onChange={setPay} label="Filtrar por forma de pagamento" /></div>

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

      {mode === 'cal' && <MonthCalendar key={mk} mk={mk} tx={inMonth.filter(matches)} value={day} onChange={setDay} />}
      {view === 'tudo' && <HistoryPanel tx={shown} first={first} onPick={(m) => { goMonth(m); setView('mes') }} />}
      {mode === 'lista' && view === 'dia' && <DayStrip key={mk} days={monthDays(inMonth.filter(matches), mk)} value={day} onChange={setDay} />}
      {view === 'semana' && <WeekPanel key={wk} start={wk} tx={done.filter(matches)} />}
      {view === 'mes' && <MonthPanel key={mk} mk={mk} tx={shown} onPick={(c) => setCat(c === cat ? null : c)} />}
      <FlowPanel tx={shown} view={view} mk={mk} wk={wk} mode={flowMode} onMode={setFlowMode} onPick={(c) => setCat(c === cat ? null : c)} />
      </>} side={<>

      {list.length === 0 && bills.length === 0 && scheduled.length === 0 ? (
        filtered ? (
          <Empty action={<button className="link" onClick={() => { setQ(''); setCat(null); setPay('todos') }}>Limpar filtros</button>}>
            Nada encontrado {view === 'mes' ? 'em ' : ''}{periodName} com esses filtros.
          </Empty>
        ) : (
          <Empty action={<button className="link" onClick={openNew}>Lançar gasto</button>}>
            Nenhum gasto {view === 'mes' ? 'em ' : ''}{periodName}. Quando lançar, ele aparece aqui agrupado por dia.
          </Empty>
        )
      ) : (
        <div className="space-y-6">
          {visibleDays.map(([date, items], i) => (
            <section key={date}>
              {view === 'tudo' && (i === 0 || monthKey(visibleDays[i - 1][0]) !== monthKey(date)) && (
                <div className={`mb-3 flex items-baseline justify-between border-b border-line px-1 pb-2 ${i === 0 ? '' : 'pt-2'}`}>
                  <h2 className="text-[17px] font-bold tracking-[-0.01em]">{monthName(monthKey(date))}</h2>
                  <span className="money text-sm font-semibold text-muted">{money(monthTotal(monthKey(date)))}</span>
                </div>
              )}
              <div className="mb-2 flex items-baseline justify-between px-1 text-[13px]">
                <h3 className="font-bold text-muted first-letter:uppercase">{dayLabel(date)}</h3>
                {items.some((r) => 'tx' in r) && <span className="money text-faint">{money(items.reduce((s, r) => s + ('tx' in r ? spendOf(r.tx) : 0), 0))}</span>}
              </div>
              <ul className="card divide-y divide-rule">
                {items.map((r) => {
                  if ('bill' in r) return <BillRow key={r.bill.id} bill={r.bill} />
                  const t = r.tx
                  return (
                    <li key={t.id} className="group flex items-center gap-3 py-3 pr-1.5 pl-4">
                      <CategoryIcon category={t.category} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 font-semibold">
                          <span className="truncate">{t.merchant}</span>
                          {t.subscription_id && <Repeat size={13} strokeWidth={2.25} className="flex-none text-muted" aria-label={`Assinatura${subName(t.subscription_id) ? ` ${subName(t.subscription_id)}` : ''}`} />}
                        </p>
                        <p className="truncate text-[13px] text-faint">{t.category}{t.bank ? ` · ${t.bank}` : ''}{t.note ? ` · ${t.note}` : ''}</p>
                        <SplitLine t={t} />
                      </div>
                      <span className="money flex-none font-semibold">{money(t.amount)}</span>
                      <button aria-label={`Ações de ${t.merchant}`} onClick={() => setMenu(t)}
                        className="grid size-10 flex-none place-items-center rounded-full text-faint transition-colors hover:bg-raised hover:text-ink">
                        <MoreHorizontal size={18} />
                      </button>
                    </li>
                    )
                })}
              </ul>
            </section>
          ))}
          {more && <LoadMore onMore={() => setMonths((n) => n + MONTH_BATCH)} />}
          {scheduled.length > 0 && (
            <section aria-labelledby="scheduled-h">
              <div className="mb-2 flex items-baseline justify-between px-1 text-[13px]">
                <h2 id="scheduled-h" className="font-bold text-muted">Agendadas</h2>
                <span className="money text-faint">{money(scheduled.reduce((s, x) => s + spendOf(x), 0))} · fora do total</span>
              </div>
              <ul className="card divide-y divide-rule">
                {scheduled.map((x) => (
                  <li key={x.id} className="flex items-center gap-3 py-3 pr-4 pl-4 text-muted">
                    <CategoryIcon category={x.category} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{x.merchant}</p>
                      <p className="truncate text-[13px] text-faint">{dayLabel(x.date)}{x.bank ? ` · ${x.bank}` : ''}{x.note ? ` · ${x.note}` : ''}</p>
                    </div>
                    <span className="money flex-none">{money(x.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      </>} />

      <Sheet open={picker} onClose={() => setPicker(false)} title="Escolher mês">
        {picker && <MonthPicker value={mk} first={first} last={current} tx={done}
          onPick={(m) => { goMonth(m); if (mode === 'lista' && listView !== 'mes' && listView !== 'dia') setView('mes'); setPicker(false) }}
          onAll={mode === 'lista' ? () => { setView('tudo'); setPicker(false) } : undefined} />}
      </Sheet>

      <Sheet open={menu !== null} onClose={() => setMenu(null)} title={menu?.merchant ?? ''}>
        {menu && (
          <SplitActions tx={menu} onClose={() => setMenu(null)} summary={
            <p className="money mb-2 text-sm text-muted">{money(menu.amount)} · {dayLabel(menu.date)} · {menu.category}
              {menu.subscription_id && <> · ↻ {subName(menu.subscription_id) ?? 'assinatura'}</>}</p>}>
            {data.subscriptionsReady !== false && (menu.subscription_id ? (
              <>
                <button className="btn-ghost h-11 justify-start px-4" onClick={() => { setMenu(null); navigate('/dividas?tab=assinaturas') }}><Repeat size={16} />Ver assinatura</button>
                <button className="btn-ghost h-11 justify-start px-4" onClick={() => { unlink(menu); setMenu(null) }}>Desvincular da assinatura</button>
              </>
            ) : (
              <button className="btn-ghost h-11 justify-start px-4" data-autofocus
                onClick={() => { setMenu(null); navigate(`/dividas?tab=assinaturas&from=${encodeURIComponent(menu.id)}`) }}>
                <Repeat size={16} />Acompanhar como assinatura
              </button>
            ))}
            {/* Deleting would leave the received money in the balance with no row behind it. */}
            {menu.reimbursed_amount == null
              ? <button className="btn-ghost h-11 justify-start px-4 text-negative" onClick={() => { remove(menu); setMenu(null) }}><Trash2 size={16} />Excluir gasto</button>
              : <p className="px-1 pt-1 text-[13px] text-faint">Para excluir, desfaça o reembolso antes.</p>}
          </SplitActions>
        )}
      </Sheet>
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
  const m = monthSummary(posted(data), mk)
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

/**
 * Categorias ao longo do tempo, na mesma seleção da lista: os 7 dias da semana, os dias do mês (Dia, Mês e Calendário) ou
 * um ponto por mês no histórico. Área empilhada tem eixo em reais; streamgraph só mostra a forma, o valor vem no toque.
 */
function FlowPanel({ tx, view, mk, wk, mode, onMode, onPick }: {
  tx: Transaction[]; view: View; mk: string; wk: string; mode: FlowMode; onMode: (m: FlowMode) => void; onPick: (c: string) => void
}) {
  const monthly = view === 'tudo'
  const keys = monthly ? [...new Set(tx.map((x) => monthKey(x.date)))].sort()
    : view === 'semana' ? Array.from({ length: 7 }, (_, i) => addDays(wk, i)) : monthDays([], mk).map((d) => d.date)
  const flow = categoryFlow(tx, keys, monthly ? monthKey : (d) => d)
  const slices = categoryShare(tx.filter((x) => keys.includes(monthly ? monthKey(x.date) : x.date)))
  if (flow.cats.length === 0) return null
  const labels = keys.map((k) => (monthly ? monthName(k) : dayLabel(k)))
  const name = monthly ? 'no histórico' : view === 'semana' ? `na semana ${weekRange(wk)}` : `em ${monthName(mk).toLowerCase()}`
  const from = monthly ? labels[0] : view === 'semana' ? labels[0] : `1º de ${monthName(mk).split(' ')[0].toLowerCase()}`
  const to = monthly ? labels[labels.length - 1] : view === 'semana' ? labels[6] : `dia ${keys.length}`
  return (
    <section className="card mb-5 p-4" aria-label="Categorias ao longo do tempo">
      <div className="mb-3"><Segmented value={mode} options={FLOW_MODES} onChange={onMode} label="Tipo de gráfico de categorias" /></div>
      <CategoryFlow key={`${view}-${mk}-${wk}-${mode}-${keys.length}-${flow.cats.join()}`} flow={flow} mode={mode} labels={labels} slices={slices} from={from} to={to}
        label={`Gastos por categoria ${name}, ${mode === 'area' ? 'área empilhada' : 'streamgraph'}`} onPick={onPick} />
    </section>
  )
}

const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']

/**
 * Calendário: the month as a seg → dom grid. Each day shows what left that day at full value, with a dot when a split
 * spend is in it; the total on top is the spend (your part once reimbursed), so with a reimbursed row the cells add up
 * to more than it. The tint deepens with the amount (relative to the month's biggest day). Tap a day → its list.
 */
function MonthCalendar({ mk, tx, value, onChange }: { mk: string; tx: Transaction[]; value: string; onChange: (d: string) => void }) {
  const t = today()
  const lead = (parseISO(`${mk}-01`).getDay() + 6) % 7
  const days = monthDays(tx, mk, (x) => x.amount)
  const max = Math.max(0, ...days.map((d) => d.total))
  const total = tx.reduce((s, x) => s + spendOf(x), 0)
  const splitDays = new Set(tx.filter((x) => x.split_share_pct != null).map((x) => x.date))
  return (
    <section className="card mb-5 p-3 sm:p-4" aria-label={`Calendário de ${monthName(mk).toLowerCase()}`}>
      <div className="mb-3 flex items-baseline justify-between px-1">
        <p className="text-sm font-semibold text-muted">{plural(days.filter((d) => d.total > 0).length, 'dia com gasto', 'dias com gasto')}</p>
        <p className="money text-[15px] font-bold">{money(total)}</p>
      </div>
      <div aria-hidden className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-faint uppercase">
        {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
      </div>
      <div role="radiogroup" aria-label="Escolher dia" className="grid grid-cols-7 gap-1">
        {Array.from({ length: lead }, (_, i) => <span key={`pad-${i}`} aria-hidden />)}
        {days.map((d) => {
          const on = d.date === value
          const future = d.date > t
          const heat = !on && d.total > 0 && max > 0 ? Math.round(6 + (d.total / max) * 22) : 0
          return (
            <button key={d.date} type="button" role="radio" aria-checked={on} disabled={future} onClick={() => onChange(d.date)}
              aria-label={`${dayLabel(d.date)}: ${d.total > 0 ? money(d.total) : 'sem gastos'}${splitDays.has(d.date) ? ', inclui gasto dividido' : ''}`}
              style={heat ? { background: `color-mix(in srgb, var(--color-ink) ${heat}%, var(--color-surface))` } : undefined}
              className={`relative flex aspect-square min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl border transition-colors disabled:opacity-35 sm:aspect-[5/4] ${on ? 'border-ink bg-ink text-ground' : d.date === t ? 'border-accent' : 'border-transparent hover:border-control'}`}>
              {splitDays.has(d.date) && <span aria-hidden className={`absolute top-1 right-1 size-1.5 rounded-full ${on ? 'bg-ground' : 'bg-accent'}`} />}
              <span className={`text-[15px] leading-none font-bold ${d.date === t && !on ? 'text-accent' : ''}`}>{d.day}</span>
              <span aria-hidden className={`money h-3 text-[10px] leading-none font-semibold ${on ? '' : d.total > 0 ? 'text-ink' : 'text-faint'}`}>
                {future || d.total === 0 ? '' : valuesHidden() ? '••' : num.format(d.total < 1000 ? Math.round(d.total) : d.total)}
              </span>
            </button>
          )
        })}
      </div>
      {splitDays.size > 0 && (
        <p className="mt-3 flex items-center gap-2 px-1 text-xs text-faint">
          <span aria-hidden className="size-1.5 flex-none rounded-full bg-accent" />Tem gasto dividido: o dia mostra o valor cheio.
        </p>
      )}
    </section>
  )
}

/** Tudo: one row per month (newest first) with its total against the biggest month; tap jumps to that month. */
function HistoryPanel({ tx, first, onPick }: { tx: Transaction[]; first: string; onPick: (mk: string) => void }) {
  const by = new Map<string, number>()
  for (const x of tx) by.set(monthKey(x.date), (by.get(monthKey(x.date)) ?? 0) + spendOf(x))
  const rows = [...by].sort((a, b) => b[0].localeCompare(a[0]))
  if (rows.length === 0) return null
  const max = Math.max(...rows.map(([, v]) => v))
  const total = rows.reduce((s, [, v]) => s + v, 0)
  return (
    <section className="card mb-5 p-4" aria-label="Gastos por mês">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">Desde {monthName(first).toLowerCase()}</p>
          <p className="money text-[22px] leading-tight font-extrabold tracking-[-0.03em]">{money(total)}</p>
        </div>
        <p className="money text-right text-[13px] text-muted">média por mês<br /><span className="font-semibold text-ink">{money(total / rows.length)}</span></p>
      </div>
      <ul className="-mx-2 max-h-[22rem] overflow-y-auto">
        {rows.map(([m, v]) => (
          <li key={m}>
            <button type="button" onClick={() => onPick(m)} className="grid w-full grid-cols-[6.5rem_1fr_auto] items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-raised">
              <span className="truncate text-sm font-semibold">{monthName(m)}</span>
              <span aria-hidden className="h-2 overflow-hidden rounded-full bg-raised">
                <span className="block h-full rounded-full bg-muted" style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
              </span>
              <span className="money text-sm text-muted">{money(v)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Month/year jump: years newest first, a 4×3 grid of months each; months outside the history are disabled. */
function MonthPicker({ value, first, last, tx, onPick, onAll }: {
  value: string; first: string; last: string; tx: Transaction[]; onPick: (mk: string) => void; onAll?: () => void
}) {
  const [y0, y1] = [Number(first.slice(0, 4)), Number(last.slice(0, 4))]
  const [year, setYear] = useState(Number(value.slice(0, 4)))
  const totals = new Map<string, number>()
  for (const x of tx) totals.set(monthKey(x.date), (totals.get(monthKey(x.date)) ?? 0) + spendOf(x))
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y1 - i)
  return (
    <div className="grid gap-4">
      {years.length > 1 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Ano">
          {years.map((y) => (
            <button key={y} type="button" role="radio" aria-checked={y === year} onClick={() => setYear(y)}
              className={`h-9 flex-none rounded-full border px-4 text-sm font-semibold transition-colors ${y === year ? 'border-ink bg-ink text-ground' : 'border-control text-muted hover:text-ink'}`}>
              {y}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {Array.from({ length: 12 }, (_, i) => {
          const m = `${year}-${String(i + 1).padStart(2, '0')}`
          const off = m < first || m > last
          const on = m === value
          const v = totals.get(m) ?? 0
          return (
            <button key={m} type="button" disabled={off} onClick={() => onPick(m)} aria-current={on ? 'date' : undefined} {...(on ? { 'data-autofocus': true } : {})}
              className={`flex h-16 flex-col items-center justify-center gap-0.5 rounded-2xl border transition-colors disabled:opacity-30 ${on ? 'border-ink bg-ink text-ground' : 'border-line bg-surface hover:border-control'}`}>
              <span className="text-sm font-bold capitalize">{new Date(year, i, 1).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</span>
              <span className={`money text-[11px] ${on ? '' : 'text-faint'}`}>{off ? '' : v > 0 ? (valuesHidden() ? '••' : num.format(Math.round(v))) : '–'}</span>
            </button>
          )
        })}
      </div>
      {onAll && <button type="button" className="btn-ghost h-11 px-4" onClick={onAll}>Ver todo o histórico</button>}
    </div>
  )
}

/** Infinite scroll for "Tudo": loads the next months when this reaches the viewport; the button is the fallback. */
function LoadMore({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) onMore() }, { rootMargin: '400px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [onMore])
  return <button ref={ref} type="button" className="btn-ghost h-11 w-full px-4" onClick={onMore}>Carregar meses anteriores</button>
}
