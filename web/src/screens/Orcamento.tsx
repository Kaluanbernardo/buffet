import { useState } from 'react'
import { Check } from 'lucide-react'
import { useBuffet } from '../data/store'
import { monthSummary } from '../data/derive'
import { money, money0, parseMoney } from '../lib/format'
import { CategoryIcon, PlanTrack, ScreenHeader, toneFor } from '../components/ui'

export default function Orcamento() {
  const { data, update } = useBuffet()
  const m = monthSummary(data)
  const { clock } = m
  const [saved, setSaved] = useState<string | null>(null)

  const set = (category: string, v: string) => {
    const n = parseMoney(v)
    const monthly_limit = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
    const prev = data.budgets.find((b) => b.category === category)?.monthly_limit ?? 0
    if (prev === monthly_limit) return
    update((d) => ({ ...d, budgets: d.budgets.map((b) => (b.category === category ? { ...b, monthly_limit } : b)) }))
    setSaved(category)
    window.setTimeout(() => setSaved((s) => (s === category ? null : s)), 1800)
  }

  return (
    <div>
      <ScreenHeader
        title="Orçamento"
        sub={m.limit > 0
          ? <span className="money">{money(m.spent)} de {money0(m.limit)} em {clock.name} · {m.left >= 0 ? `restam ${money(m.left)}` : <span className="text-negative">{money(-m.left)} acima</span>}</span>
          : 'Defina um limite mensal por categoria. Categorias sem limite ficam de fora do plano.'}
      />

      <div className="mb-3 flex items-center gap-2 px-1 text-xs text-faint">
        <span aria-hidden className="inline-block h-3 w-[2px] rounded-full bg-ink/80" />
        Marca de hoje: dia {clock.day} de {clock.days}. Barra além dela = gastando acima do ritmo.
      </div>

      <ul className="card divide-y divide-rule px-4">
        {m.cats.map((c) => {
          const t = toneFor(c.spent, c.limit, clock.elapsed)
          const id = `lim-${c.category}`
          return (
            <li key={c.category} className="py-4">
              <div className="flex items-center gap-3">
                <CategoryIcon category={c.category} />
                <div className="min-w-0 flex-1">
                  <label htmlFor={id} className="block truncate font-semibold">{c.category}</label>
                  <p className="money text-[13px] text-faint">
                    {c.limit > 0
                      ? <>{money(c.spent)} · <span className={t === 'bad' ? 'text-negative font-semibold' : t === 'warn' ? 'text-warning' : 'text-muted'}>{c.left >= 0 ? `restam ${money(c.left)}` : `${money(-c.left)} acima`}</span></>
                      : c.spent > 0 ? `${money(c.spent)} · sem limite` : 'Sem limite'}
                  </p>
                </div>
                <div className="relative w-[7.5rem] flex-none">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-faint">R$</span>
                  <input
                    id={id} inputMode="decimal" placeholder="0" autoComplete="off"
                    className="input money h-10 pl-9 text-right text-[15px] font-semibold"
                    defaultValue={c.limit ? c.limit.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : ''}
                    onBlur={(e) => set(c.category, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  />
                  {saved === c.category && (
                    <span className="absolute -bottom-5 right-1 flex items-center gap-1 text-[11px] font-semibold text-accent"><Check size={12} />Salvo</span>
                  )}
                </div>
              </div>
              {c.limit > 0 && (
                <div className="mt-3 pl-12">
                  <PlanTrack spent={c.spent} limit={c.limit} elapsed={clock.elapsed} tone={t} label={c.category} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-4 px-1 text-xs text-faint">Os limites valem para todo mês e são salvos ao sair do campo.</p>
    </div>
  )
}
