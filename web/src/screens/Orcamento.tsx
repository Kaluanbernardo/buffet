import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Pencil } from 'lucide-react'
import { useBuffet } from '../data/store'
import { GROUPS, monthSummary, type Slice } from '../data/derive'
import type { BudgetGroup } from '../data/types'
import { money, money0, monthKey, monthName, parseMoney, shiftMonth, today } from '../lib/format'
import { AvailablePill, CategoryIcon, PeriodSwitcher, PlanTrack, ScreenHeader, Sheet, toneFor } from '../components/ui'
import { ShareBar } from '../components/charts'
import { useActions } from '../components/Actions'

const r2 = (v: number) => Math.round(v * 100) / 100
const fmtInput = (v: number) => (v ? v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '')

type Cat = ReturnType<typeof monthSummary>['cats'][number]

export default function Orcamento() {
  const { data, update, hidden, toggleHidden } = useBuffet()
  const { notify } = useActions()
  const current = monthKey(today())
  const first = useMemo(() => data.transactions.reduce((min, t) => (monthKey(t.date) < min ? monthKey(t.date) : min),
    Object.keys(data.incomes).reduce((min, k) => (k < min ? k : min), current)), [data.transactions, data.incomes, current])
  const [mk, setMk] = useState(current)
  const m = monthSummary(data, mk)
  const { clock } = m
  const [editing, setEditing] = useState<string | null>(null)
  const [incomeOpen, setIncomeOpen] = useState(false)
  const month = monthName(mk).toLowerCase()

  // How the plan is split: limit per category as a share of the month's total (largest first).
  const plan: Slice[] = m.budgeted.map((c) => ({ key: c.category, value: c.limit, share: c.limit / m.limit })).sort((a, b) => b.value - a.value)

  const saveLimit = (category: string, monthly_limit: number, group: BudgetGroup) => {
    const prev = data.budgets.find((b) => b.category === category)
    if (!prev) return
    const prevGroup = m.cats.find((c) => c.category === category)?.group
    if (prev.monthly_limit === monthly_limit && prevGroup === group) return
    update((d) => ({ ...d, budgets: d.budgets.map((b) => (b.category === category ? { ...b, monthly_limit, group } : b)) }))
    notify({
      msg: prev.monthly_limit === monthly_limit ? `${category} movida para ${GROUPS.find((g) => g.key === group)?.label}` : `${category}: ${money(monthly_limit)} por mês`,
      undo: () => update((d) => ({ ...d, budgets: d.budgets.map((b) => (b.category === category ? prev : b)) })),
    })
  }

  const saveIncome = (v: number | null) => {
    const before = data.incomes[mk]
    update((d) => {
      const incomes = { ...d.incomes }
      if (v === null) delete incomes[mk]; else incomes[mk] = v
      return { ...d, incomes }
    })
    notify({
      msg: v === null ? `Renda de ${month} removida` : `Renda de ${month}: ${money(v)}`,
      undo: () => update((d) => {
        const incomes = { ...d.incomes }
        if (before === undefined) delete incomes[mk]; else incomes[mk] = before
        return { ...d, incomes }
      }),
    })
  }

  const cat = m.cats.find((c) => c.category === editing) ?? null

  return (
    <div>
      <ScreenHeader
        title="Orçamento"
        sub={m.limit > 0
          ? <span className="money">{money(m.spent)} de {money0(m.limit)} em {month} · {m.left >= 0 ? `${clock.current ? 'restam' : 'sobraram'} ${money(m.left)}` : <span className="text-negative">{money(-m.left)} acima</span>}</span>
          : 'Dê um trabalho a cada real: informe a renda e distribua entre as categorias.'}
      />

      <PeriodSwitcher label={monthName(mk)} prevDisabled={mk <= first} nextDisabled={mk >= current}
        onPrev={() => setMk(shiftMonth(mk, -1))} onNext={() => setMk(shiftMonth(mk, 1))} className="mb-4" />

      <AssignHero m={m} month={month} onEditIncome={() => setIncomeOpen(true)} />

      {plan.length > 0 && (
        <section className="card mt-4 p-4" aria-labelledby="plan-split">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="plan-split" className="text-sm font-semibold text-muted">Divisão do plano</h2>
            <span className="money text-sm font-semibold">{money0(m.limit)}/mês</span>
          </div>
          <ShareBar slices={plan} label="Divisão do plano mensal por categoria" />
        </section>
      )}

      {clock.current && (
        <div className="mt-6 mb-1 flex items-center gap-2 px-1 text-xs text-faint">
          <span aria-hidden className="inline-block h-3 w-[2px] rounded-full bg-ink/80" />
          Marca de hoje: dia {clock.day} de {clock.days}. Barra além dela = gastando acima do ritmo.
        </div>
      )}

      {GROUPS.map((g) => {
        const rows = m.cats.filter((c) => c.group === g.key)
          // Risk first: overspent, then closest to the limit, then categories with spend but no limit.
          .sort((a, b) => (b.limit > 0 ? b.spent / b.limit : b.spent > 0 ? 0.5 : -1) - (a.limit > 0 ? a.spent / a.limit : a.spent > 0 ? 0.5 : -1))
        if (rows.length === 0) return null
        const assigned = r2(rows.reduce((s, c) => s + c.limit, 0))
        const left = r2(rows.filter((c) => c.limit > 0).reduce((s, c) => s + c.left, 0))
        return (
          <section key={g.key} className="mt-6" aria-labelledby={`grp-${g.key}`}>
            <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
              <div className="min-w-0">
                <h2 id={`grp-${g.key}`} className="text-[17px] font-bold tracking-[-0.01em]">{g.label}</h2>
                <p className="text-xs text-faint">{g.hint}</p>
              </div>
              {assigned > 0 && (
                <p className="money flex-none text-right text-[13px] text-muted">
                  {money0(assigned)} atribuído<br />
                  <span className={left < 0 ? 'font-semibold text-negative' : 'text-faint'}>{left < 0 ? `${money(-left)} acima` : `${money(left)} disponível`}</span>
                </p>
              )}
            </div>
            <ul className="card divide-y divide-rule">
              {rows.map((c) => <CategoryRow key={c.category} c={c} elapsed={clock.current ? clock.elapsed : undefined} share={m.limit > 0 ? c.limit / m.limit : 0}
                tone={toneFor(c.spent, c.limit, clock.elapsed)} onOpen={() => setEditing(c.category)} />)}
            </ul>
          </section>
        )
      })}

      {m.orphan > 0 && (
        <p className="money mt-4 rounded-2xl border border-dashed border-control px-4 py-3 text-sm text-muted">
          Sem orçamento · <span className="font-semibold text-warning">{money(m.orphan)}</span> em categorias que não estão mais na lista.
        </p>
      )}

      <p className="mt-4 px-1 text-xs text-faint">Toque numa categoria para atribuir. Os limites valem para todo mês; a renda é de cada mês.</p>

      <Sheet open={cat !== null} onClose={() => setEditing(null)} title={cat ? `Atribuir · ${cat.category}` : 'Atribuir'}>
        {cat && (hidden
          ? <HiddenNote onShow={toggleHidden} />
          : <AssignForm key={cat.category} c={cat} toAssign={m.toAssign} month={month}
              onSave={(v, g) => { saveLimit(cat.category, v, g); setEditing(null) }} />)}
      </Sheet>

      <Sheet open={incomeOpen} onClose={() => setIncomeOpen(false)} title={`Renda de ${month}`}>
        {incomeOpen && (hidden
          ? <HiddenNote onShow={toggleHidden} />
          : <IncomeForm initial={m.income?.amount ?? 0} own={data.incomes[mk] !== undefined} assigned={m.limit}
              onSave={(v) => { saveIncome(v); setIncomeOpen(false) }} />)}
      </Sheet>
    </div>
  )
}

/** "Disponível para atribuir": renda do mês − soma dos limites. The one number YNAB keeps on top. */
function AssignHero({ m, month, onEditIncome }: { m: ReturnType<typeof monthSummary>; month: string; onEditIncome: () => void }) {
  if (!m.income) {
    return (
      <section className="card p-5" aria-labelledby="assign-label">
        <p id="assign-label" className="text-sm font-semibold text-muted">Disponível para atribuir</p>
        <p className="mt-2 text-sm text-muted text-pretty">
          Informe quanto entrou em {month}. O Buffet mostra quanto ainda falta distribuir entre as categorias.
        </p>
        <button className="btn mt-4 w-full" onClick={onEditIncome}>Informar renda do mês</button>
      </section>
    )
  }
  const v = m.toAssign ?? 0
  const state = v > 0 ? 'left' : v < 0 ? 'over' : 'done'
  return (
    <section className={`card p-5 ${state === 'over' ? 'border-negative/40' : ''}`} aria-labelledby="assign-label">
      <p id="assign-label" className="text-sm font-semibold text-muted">
        {state === 'over' ? 'Atribuído além da renda' : 'Disponível para atribuir'}
      </p>
      <p className={`money mt-1 text-[38px] leading-none font-extrabold tracking-[-0.035em] ${state === 'left' ? 'text-accent' : state === 'over' ? 'text-negative' : ''}`}>
        {money(Math.abs(v))}
      </p>
      <p className={`mt-2 text-sm ${state === 'over' ? 'text-negative' : 'text-muted'}`}>
        {state === 'left' && 'Ainda sem destino. Atribua a uma categoria ou meta.'}
        {state === 'done' && 'Cada real da renda tem um destino. Tudo atribuído.'}
        {state === 'over' && 'Os limites passam da renda. Reduza alguma categoria.'}
      </p>
      <dl className="money mt-4 grid grid-cols-2 gap-3 border-t border-rule pt-4 text-sm">
        <div>
          <dt className="text-faint">Renda do mês</dt>
          <dd>
            <button type="button" onClick={onEditIncome} className="group -mx-1 flex items-center gap-1.5 rounded-lg px-1 font-semibold hover:bg-raised" aria-label={`Editar renda de ${month}`}>
              {money(m.income.amount)}<Pencil size={13} className="text-faint group-hover:text-ink" aria-hidden />
            </button>
            {m.income.carried && <span className="block text-xs text-faint">repetida de {monthName(m.income.carried).toLowerCase()}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-faint">Atribuído</dt>
          <dd className="font-semibold">{money(m.limit)}</dd>
        </div>
      </dl>
      {m.income.amount > 0 && (
        <div className="mt-4">
          <PlanTrack spent={m.limit} limit={m.income.amount} tone={state === 'over' ? 'bad' : 'ok'} height={6} label="Renda atribuída" />
          <p className="mt-1.5 text-xs text-faint">{Math.round((m.limit / m.income.amount) * 100)}% da renda atribuída</p>
        </div>
      )}
    </section>
  )
}

function CategoryRow({ c, elapsed, share, tone, onOpen }: { c: Cat; elapsed?: number; share: number; tone: ReturnType<typeof toneFor>; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full px-4 py-3.5 text-left transition-colors hover:bg-raised/50"
        aria-label={`${c.category}: atribuir limite`}>
        <div className="flex items-center gap-3">
          <CategoryIcon category={c.category} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{c.category}</p>
            <p className="money truncate text-[13px] text-faint">
              {c.limit > 0 ? <>{money(c.spent)} de {money0(c.limit)}</> : 'Toque para definir um limite'}
            </p>
          </div>
          <AvailablePill left={c.left} limit={c.limit} spent={c.spent} tone={tone} />
          <ChevronRight size={16} className="-mr-1 flex-none text-faint" aria-hidden />
        </div>
        {c.limit > 0 && (
          <div className="mt-3 flex items-center gap-3 pl-12">
            <div className="flex-1"><PlanTrack spent={c.spent} limit={c.limit} elapsed={elapsed} tone={tone} label={c.category} /></div>
            <span className="money flex-none text-xs text-faint">{Math.round(share * 100)}% do plano</span>
          </div>
        )}
      </button>
    </li>
  )
}

function HiddenNote({ onShow }: { onShow: () => void }) {
  return (
    <div className="pb-2 text-center">
      <p className="text-sm text-muted">Os valores estão ocultos. Mostre-os para editar.</p>
      <button className="btn mt-4 w-full" onClick={onShow}>Mostrar valores</button>
    </div>
  )
}

/** Tap a category → adjust its monthly limit and see, live, what it does to "para atribuir". */
function AssignForm({ c, toAssign, month, onSave }: { c: Cat; toAssign: number | null; month: string; onSave: (v: number, g: BudgetGroup) => void }) {
  const navigate = useNavigate()
  const [raw, setRaw] = useState(fmtInput(c.limit))
  const [group, setGroup] = useState<BudgetGroup>(c.group)
  const n = parseMoney(raw)
  const value = raw.trim() === '' ? 0 : Number.isFinite(n) && n >= 0 ? r2(n) : null
  const delta = value === null ? 0 : r2(value - c.limit)
  const after = toAssign === null ? null : r2(toAssign - delta)
  const leftAfter = value === null ? c.left : r2(value - c.spent)
  const set = (v: number) => setRaw(fmtInput(Math.max(0, r2(v))))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value !== null) onSave(value, group)
  }

  const quick: { label: string; v: number }[] = [
    ...(c.spent > c.limit ? [{ label: `Cobrir ${money0(Math.ceil(c.spent - c.limit))}`, v: Math.ceil(c.spent) }] : []),
    ...(toAssign !== null && toAssign > 0 ? [{ label: `+ ${money0(toAssign)} (tudo)`, v: (value ?? c.limit) + toAssign }] : []),
    { label: '+ R$ 50', v: (value ?? c.limit) + 50 },
    { label: '+ R$ 100', v: (value ?? c.limit) + 100 },
    ...(c.spent > 0 ? [{ label: 'Igual ao gasto', v: Math.ceil(c.spent) }] : []),
  ]

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div>
        <label htmlFor="as-limit" className="label">Limite mensal</label>
        <div className="flex items-baseline gap-2 border-b border-control pb-2 focus-within:border-accent">
          <span className="text-2xl font-semibold text-muted">R$</span>
          <input id="as-limit" data-autofocus inputMode="decimal" autoComplete="off" placeholder="0" aria-invalid={value === null}
            className="money w-full bg-transparent text-[40px] leading-none font-bold tracking-[-0.03em] outline-none placeholder:text-faint"
            value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^\d.,]/g, ''))} />
        </div>
        <p className="money mt-2 text-sm text-muted">
          Gasto em {month}: {money(c.spent)} · {leftAfter >= 0 ? <span className="text-accent">{money(leftAfter)} disponível</span> : <span className="text-negative">{money(-leftAfter)} acima</span>}
        </p>
      </div>

      <div className="-mx-1 flex flex-wrap gap-2">
        {quick.map((q) => (
          <button key={q.label} type="button" onClick={() => set(q.v)}
            className="money h-9 rounded-full border border-control px-3.5 text-sm font-semibold text-muted transition-colors hover:text-ink">{q.label}</button>
        ))}
      </div>

      {after !== null && (
        <div className="money rounded-2xl bg-raised px-4 py-3 text-sm" aria-live="polite">
          <p className="text-faint">Para atribuir</p>
          <p className="mt-0.5 font-semibold">
            {money(toAssign ?? 0)} <span className="text-faint">→</span>{' '}
            <span className={after < 0 ? 'text-negative' : after === 0 ? '' : 'text-accent'}>{after < 0 ? `${money(-after)} além da renda` : money(after)}</span>
          </p>
        </div>
      )}

      <fieldset>
        <legend className="label">Grupo</legend>
        <div className="grid grid-cols-3 gap-1 rounded-full border border-line p-1" role="radiogroup">
          {GROUPS.map((g) => (
            <button key={g.key} type="button" role="radio" aria-checked={group === g.key} onClick={() => setGroup(g.key)}
              className={`h-9 truncate rounded-full px-2 text-[13px] font-semibold transition-colors ${group === g.key ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}>{g.label}</button>
          ))}
        </div>
      </fieldset>

      <div className="flex gap-3">
        <button type="button" className="btn-ghost h-12 flex-1 rounded-full font-semibold" onClick={() => navigate(`/gastos?cat=${encodeURIComponent(c.category)}`)}>Ver gastos</button>
        <button className="btn flex-[2]" disabled={value === null}>Salvar</button>
      </div>
    </form>
  )
}

function IncomeForm({ initial, own, assigned, onSave }: { initial: number; own: boolean; assigned: number; onSave: (v: number | null) => void }) {
  const [raw, setRaw] = useState(fmtInput(initial))
  const n = parseMoney(raw)
  const ok = Number.isFinite(n) && n >= 0
  const v = ok ? r2(n) : 0
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) onSave(v) }} noValidate className="space-y-5">
      <div>
        <label htmlFor="inc" className="label">Quanto entrou no mês (salário, extras)</label>
        <div className="flex items-baseline gap-2 border-b border-control pb-2 focus-within:border-accent">
          <span className="text-2xl font-semibold text-muted">R$</span>
          <input id="inc" data-autofocus inputMode="decimal" autoComplete="off" placeholder="0,00" aria-invalid={raw !== '' && !ok}
            className="money w-full bg-transparent text-[40px] leading-none font-bold tracking-[-0.03em] outline-none placeholder:text-faint"
            value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^\d.,]/g, ''))} />
        </div>
        {ok && (
          <p className={`money mt-2 text-sm ${v - assigned < 0 ? 'text-negative' : 'text-muted'}`} aria-live="polite">
            {v - assigned >= 0 ? `Sobram ${money(v - assigned)} para atribuir` : `Limites passam a renda em ${money(assigned - v)}`}
          </p>
        )}
        <p className="mt-2 text-xs text-faint">Fica salva só neste aparelho. Meses sem renda repetem a última informada.</p>
      </div>
      <div className="flex gap-3">
        {own && <button type="button" className="btn-ghost h-12 flex-1 rounded-full font-semibold" onClick={() => onSave(null)}>Remover</button>}
        <button className="btn flex-[2]" disabled={!ok}>Salvar renda</button>
      </div>
    </form>
  )
}
