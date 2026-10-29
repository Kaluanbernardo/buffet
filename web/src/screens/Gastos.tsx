import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus, Search, Trash2, X } from 'lucide-react'
import { useBuffet } from '../data/store'
import type { Transaction } from '../data/types'
import { dayLabel, money, monthKey, monthName, plural, shiftMonth, today } from '../lib/format'
import { catColor, CategoryIcon, Empty, ScreenHeader } from '../components/ui'
import { useActions } from '../components/Actions'

const norm = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

export default function Gastos() {
  const { data, update } = useBuffet()
  const { openNew, notify } = useActions()
  const current = monthKey(today())
  const first = useMemo(() => data.transactions.reduce((min, t) => (monthKey(t.date) < min ? monthKey(t.date) : min), current), [data.transactions, current])
  const [params, setParams] = useSearchParams()
  const cat = params.get('cat')
  const setCat = (c: string | null) => setParams((p) => { if (c) p.set('cat', c); else p.delete('cat'); return p }, { replace: true })
  const [mk, setMk] = useState(current)
  const [q, setQ] = useState('')

  const inMonth = data.transactions.filter((t) => monthKey(t.date) === mk)
  const usedCats = [...new Set(inMonth.map((t) => t.category))].sort((a, b) => data.config.categories.indexOf(a) - data.config.categories.indexOf(b))
  if (cat && !usedCats.includes(cat)) usedCats.push(cat)
  const needle = norm(q.trim())
  const list = inMonth
    .filter((t) => (!cat || t.category === cat) && (!needle || norm(t.merchant).includes(needle) || norm(t.note ?? '').includes(needle)))
    .sort((a, b) => b.date.localeCompare(a.date))
  const total = list.reduce((s, t) => s + t.amount, 0)
  const filtered = Boolean(cat || needle)

  const days = new Map<string, Transaction[]>()
  for (const t of list) days.set(t.date, [...(days.get(t.date) ?? []), t])

  const remove = (t: Transaction) => {
    update((d) => ({ ...d, transactions: d.transactions.filter((x) => x.id !== t.id) }))
    notify({ msg: `${t.merchant} removido`, undo: () => update((d) => ({ ...d, transactions: [t, ...d.transactions] })) })
  }

  return (
    <div>
      <ScreenHeader
        title="Gastos"
        sub={<span className="money">{plural(list.length, 'lançamento', 'lançamentos')} · <span className="text-ink font-semibold">{money(total)}</span></span>}
        action={<button className="btn h-11 px-4" onClick={openNew}><Plus size={18} strokeWidth={2.5} />Novo</button>}
      />

      <div className="mb-3 flex items-center justify-between gap-2 rounded-full border border-line bg-surface p-1">
        <button type="button" aria-label="Mês anterior" disabled={mk <= first} onClick={() => setMk(shiftMonth(mk, -1))}
          className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent">
          <ChevronLeft size={20} />
        </button>
        <p className="text-[15px] font-bold" aria-live="polite">{monthName(mk)}</p>
        <button type="button" aria-label="Próximo mês" disabled={mk >= current} onClick={() => setMk(shiftMonth(mk, 1))}
          className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent">
          <ChevronRight size={20} />
        </button>
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
        <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Filtrar por categoria">
          {[null, ...usedCats].map((c) => (
            <button key={c ?? 'all'} aria-pressed={cat === c} onClick={() => setCat(c)}
              className={`flex h-9 flex-none items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors ${cat === c ? 'border-ink bg-ink text-ground' : 'border-control text-muted hover:text-ink'}`}>
              {c && <span aria-hidden className="size-2 rounded-full" style={{ background: catColor(c) }} />}
              {c ?? 'Todas'}
            </button>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        filtered ? (
          <Empty action={<button className="link" onClick={() => { setQ(''); setCat(null) }}>Limpar filtros</button>}>
            Nada encontrado em {monthName(mk).toLowerCase()} com esses filtros.
          </Empty>
        ) : (
          <Empty action={<button className="link" onClick={openNew}>Lançar gasto</button>}>
            Nenhum gasto em {monthName(mk).toLowerCase()}. Quando lançar, ele aparece aqui agrupado por dia.
          </Empty>
        )
      ) : (
        <div className="space-y-6">
          {[...days].map(([date, items]) => (
            <section key={date}>
              <div className="mb-2 flex items-baseline justify-between px-1 text-[13px]">
                <h2 className="font-bold text-muted first-letter:uppercase">{dayLabel(date)}</h2>
                <span className="money text-faint">{money(items.reduce((s, t) => s + t.amount, 0))}</span>
              </div>
              <ul className="card divide-y divide-rule">
                {items.map((t) => (
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
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
