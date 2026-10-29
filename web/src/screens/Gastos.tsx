import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useBuffet } from '../data/store'
import type { Transaction } from '../data/types'
import { dayLabel, money, monthKey, plural, today } from '../lib/format'
import { CategoryIcon, Empty, ScreenHeader } from '../components/ui'
import { useActions } from '../components/Actions'

const monthName = (mk: string) => {
  const [y, m] = mk.split('-').map(Number)
  const s = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: y === new Date().getFullYear() ? undefined : 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function Gastos() {
  const { data, update } = useBuffet()
  const { openNew, notify } = useActions()
  const current = monthKey(today())
  const months = useMemo(() => {
    const set = new Set([current, ...data.transactions.map((t) => monthKey(t.date))])
    return [...set].sort().reverse()
  }, [data.transactions, current])
  const [mk, setMk] = useState(current)
  const [cat, setCat] = useState<string | null>(null)

  const inMonth = data.transactions.filter((t) => monthKey(t.date) === mk)
  const usedCats = [...new Set(inMonth.map((t) => t.category))]
  const list = inMonth.filter((t) => !cat || t.category === cat).sort((a, b) => b.date.localeCompare(a.date))
  const total = list.reduce((s, t) => s + t.amount, 0)

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

      <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Filtros">
        {months.length > 1 && (
          <select aria-label="Mês" className="input h-9 w-auto flex-none rounded-full py-0 pl-3.5 text-sm font-semibold" value={mk} onChange={(e) => { setMk(e.target.value); setCat(null) }}>
            {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
        )}
        {usedCats.length > 1 && [null, ...usedCats].map((c) => (
          <button key={c ?? 'all'} aria-pressed={cat === c} onClick={() => setCat(c)}
            className={`h-9 flex-none rounded-full border px-3.5 text-sm font-semibold transition-colors ${cat === c ? 'border-ink bg-ink text-ground' : 'border-control text-muted hover:text-ink'}`}>
            {c ?? 'Tudo'}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <Empty action={<button className="link" onClick={openNew}>Lançar gasto</button>}>
          Nenhum gasto em {monthName(mk).toLowerCase()}. Quando lançar, ele aparece aqui agrupado por dia.
        </Empty>
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
