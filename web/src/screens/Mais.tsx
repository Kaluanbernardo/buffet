import { LogOut } from 'lucide-react'
import { useBuffet } from '../data/store'
import { money, money0 } from '../lib/format'
import { BrandMark, Empty, ScreenHeader, Section } from '../components/ui'

export default function Mais({ onLogout }: { onLogout: () => void }) {
  const { data } = useBuffet()
  const invested = data.investments.reduce((s, i) => s + i.amount, 0)
  const reserved = data.reserves.reduce((s, r) => s + r.current, 0)

  return (
    <div>
      <ScreenHeader title="Mais" sub="Reserva, investimentos e contas" />

      <section className="card grid grid-cols-2 divide-x divide-rule">
        <div className="p-4">
          <p className="text-sm font-semibold text-muted">Guardado</p>
          <p className="money mt-1 text-[22px] leading-none font-extrabold tracking-[-0.03em]">{money(reserved)}</p>
        </div>
        <div className="p-4">
          <p className="text-sm font-semibold text-muted">Investido</p>
          <p className="money mt-1 text-[22px] leading-none font-extrabold tracking-[-0.03em]">{money(invested)}</p>
        </div>
      </section>

      <Section title="Reserva">
        <ul className="card divide-y divide-rule px-4">
          {data.reserves.map((r) => {
            const pct = r.target > 0 ? Math.min(100, (r.current / r.target) * 100) : 0
            return (
              <li key={r.id} className="py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-semibold">{r.name}</span>
                  <span className="money flex-none text-sm text-muted">{r.target > 0 ? `${Math.round(pct)}%` : 'sem meta'}</span>
                </div>
                <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-raised" role="meter" aria-label={r.name} aria-valuemin={0} aria-valuemax={r.target} aria-valuenow={r.current}>
                  {pct > 0 && <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />}
                </div>
                <div className="money mt-2 flex justify-between text-xs text-faint">
                  <span>{money(r.current)}</span>
                  <span>{r.target > 0 ? `meta ${money0(r.target)}` : 'defina uma meta'}</span>
                </div>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title="Investimentos">
        {data.investments.length === 0 ? (
          <Empty>Nenhum investimento cadastrado. A XP entra aqui quando a conta abrir.</Empty>
        ) : (
          <ul className="card divide-y divide-rule px-4">
            {data.investments.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{i.name}</p>
                  <p className="text-[13px] text-faint">{i.kind} · {i.institution}</p>
                </div>
                <span className="money flex-none font-semibold">{money(i.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Contas">
        <ul className="card divide-y divide-rule px-4">
          {data.config.banks.map((b) => (
            <li key={b.name} className="flex items-center justify-between gap-3 py-3.5">
              <span className="flex items-center gap-3 font-semibold">
                <span aria-hidden className="grid size-9 place-items-center rounded-full bg-raised text-sm font-bold text-muted">{b.name[0]}</span>
                {b.name}
              </span>
              <span className={`pill ${b.status === 'active' ? 'pill-ok' : 'pill-warn'}`}>{b.status === 'active' ? 'Ativa' : 'No radar'}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-[20px] border border-line px-4 py-3.5">
          <div>
            <p className="font-semibold">Open Finance</p>
            <p className="text-[13px] text-faint">Importar extratos e faturas automaticamente.</p>
          </div>
          <span className="pill pill-neutral">Em breve</span>
        </div>
      </Section>

      <section className="mt-10 border-t border-line pt-6">
        <button className="btn-ghost w-full border-negative/40 text-negative hover:bg-negative-tint" onClick={onLogout}>
          <LogOut size={18} />Sair
        </button>
        <p className="mt-3 text-center text-xs text-faint">Os dados ficam salvos neste aparelho.</p>
        <div className="mt-8 flex items-center justify-center gap-2 text-faint">
          <BrandMark size={16} />
          <span className="text-xs font-semibold">Buffet · v0.1</span>
        </div>
      </section>
    </div>
  )
}
