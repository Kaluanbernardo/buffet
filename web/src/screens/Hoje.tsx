import { Link, useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useBuffet } from '../data/store'
import { categoryShare, dailySpend, daysUntilDue, dueLabel, isOpen, monthSummary } from '../data/derive'
import { dayLabel, money, money0, plural } from '../lib/format'
import { CategoryIcon, Empty, HideValuesButton, PlanTrack, ScreenHeader, Section, ThemeButton, toneFor } from '../components/ui'
import { DailyBars, ShareBar } from '../components/charts'
import { useActions } from '../components/Actions'

export default function Hoje() {
  const { data, hidden, toggleHidden } = useBuffet()
  const { openNew } = useActions()
  const navigate = useNavigate()
  const m = monthSummary(data)
  const { clock } = m
  const hasPlan = m.limit > 0
  const tone = toneFor(m.spent, m.limit, clock.elapsed)
  const dateLine = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' })

  const finding = (() => {
    if (!hasPlan) return null
    if (m.left < 0) return `Você passou ${money(-m.left)} do plano de ${clock.name}.`
    if (m.over.length) {
      const o = m.over[0]
      return `${o.category} passou ${money(o.spent - o.limit)} do limite${m.over.length > 1 ? ` (e mais ${m.over.length - 1})` : ''}.`
    }
    const usedPct = Math.round((m.spent / m.limit) * 100)
    const timePct = Math.round(clock.elapsed * 100)
    return usedPct <= timePct
      ? `No ritmo: ${usedPct}% do plano usado com ${timePct}% do mês passado.`
      : `Acima do ritmo: ${usedPct}% do plano usado com ${timePct}% do mês passado.`
  })()

  const cats = m.cats.filter((c) => c.limit > 0 || c.spent > 0).sort((a, b) => b.spent / (b.limit || 1) - a.spent / (a.limit || 1))
  const recent = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4)
  const share = categoryShare(m.tx)
  const daily = dailySpend(data.transactions, 30)
  const dues = data.debts.filter(isOpen).map((d) => ({ ...d, inDays: daysUntilDue(d.due_day) })).sort((a, b) => a.inDays - b.inDays).slice(0, 3)

  return (
    <div>
      <ScreenHeader title="Hoje" sub={<span className="first-letter:uppercase inline-block">{dateLine}</span>}
        action={<div className="flex gap-2"><ThemeButton /><HideValuesButton hidden={hidden} onToggle={toggleHidden} /></div>} />

      {/* 1 · The month's decision number */}
      <section className="card p-5" aria-labelledby="hero-label">
        <p id="hero-label" className="text-sm font-semibold text-muted">
          {hasPlan ? (m.left >= 0 ? `Restam em ${clock.name}` : `Acima do plano de ${clock.name}`) : `Gasto em ${clock.name}`}
        </p>
        <p className={`money mt-1 text-[38px] leading-none font-extrabold tracking-[-0.035em] ${hasPlan && m.left < 0 ? 'text-negative' : ''}`}>
          {money(hasPlan ? Math.abs(m.left) : m.spent)}
        </p>
        {hasPlan ? (
          <>
            <p className="money mt-2 text-sm text-muted">{money(m.spent)} gastos de {money0(m.limit)}</p>
            {m.perDay > 0 && (
              <p className="money mt-0.5 text-sm text-muted">
                Dá <span className="font-semibold text-ink">{money(m.perDay)} por dia</span> nos {plural(clock.left, 'dia', 'dias')} que faltam
              </p>
            )}
            <div className="mt-5">
              <PlanTrack spent={m.spent} limit={m.limit} elapsed={clock.elapsed} tone={tone} height={10} label={`Plano de ${clock.name}`} />
              <div className="mt-2 flex justify-between text-xs text-faint">
                <span>1º de {clock.name}</span>
                <span>dia {clock.day} de {clock.days}</span>
              </div>
            </div>
            {finding && (
              <p className={`mt-4 border-t border-rule pt-4 text-sm ${tone === 'bad' ? 'text-negative' : tone === 'warn' ? 'text-warning' : 'text-muted'}`}>{finding}</p>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm text-muted text-pretty">
            Defina limites no <Link to="/orcamento" className="link">Orçamento</Link> para ver quanto ainda pode gastar por dia.
          </p>
        )}
        <button className="btn mt-5 w-full" onClick={openNew}>Novo gasto</button>
      </section>

      {/* Cash on hand (buffet_app_config.cash_balance) */}
      <section className="card mt-3 flex items-baseline justify-between gap-3 px-4 py-3.5" aria-label="Saldo em caixa">
        <span className="text-sm font-semibold text-muted">Saldo em caixa</span>
        <span className="money font-semibold">{data.config.cash_balance == null ? <span className="text-faint">—</span> : money(data.config.cash_balance)}</span>
      </section>

      {/* 2 · Where the month went */}
      <Section title={`Para onde foi em ${clock.name}`}>
        {share.length === 0 ? (
          <Empty>Os gastos do mês aparecem aqui divididos por categoria.</Empty>
        ) : (
          <div className="card p-4">
            <ShareBar slices={share} label={`Divisão dos gastos de ${clock.name}`}
              onPick={(c) => navigate(`/gastos?cat=${encodeURIComponent(c)}`)} />
          </div>
        )}
      </Section>

      {/* 3 · Daily rhythm */}
      <Section title="Últimos 30 dias" action={<span className="money text-sm text-muted">{money(daily.reduce((s, d) => s + d.total, 0))}</span>}>
        <div className="card p-4">
          <DailyBars days={daily} allowance={hasPlan ? m.limit / clock.days : undefined} />
        </div>
      </Section>

      {/* 4 · Categories */}
      <Section title="Categorias" action={<Link to="/orcamento" className="link">Ajustar</Link>}>
        {cats.length === 0 ? (
          <Empty>Sem gastos nem limites neste mês ainda.</Empty>
        ) : (
          <ul className="card divide-y divide-rule px-4">
            {cats.slice(0, 5).map((c) => {
              const t = toneFor(c.spent, c.limit, clock.elapsed)
              return (
                <li key={c.category} className="py-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-semibold">{c.category}</span>
                    <span className="money flex-none text-sm">
                      {c.limit > 0
                        ? <span className={t === 'bad' ? 'text-negative font-semibold' : 'text-muted'}>{c.left >= 0 ? `restam ${money(c.left)}` : `${money(-c.left)} acima`}</span>
                        : <span className="text-muted">{money(c.spent)} · sem limite</span>}
                    </span>
                  </div>
                  {c.limit > 0 && (
                    <div className="mt-2 flex items-center gap-3">
                      <div className="flex-1"><PlanTrack spent={c.spent} limit={c.limit} elapsed={clock.elapsed} tone={t} height={6} label={c.category} /></div>
                      <span className="money w-10 flex-none text-right text-xs text-faint">{Math.round((c.spent / c.limit) * 100)}%</span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {/* 5 · Recent spending */}
      <Section title="Últimos gastos" action={recent.length > 0 && <Link to="/gastos" className="link">Ver todos</Link>}>
        {recent.length === 0 ? (
          <Empty action={<button className="link" onClick={openNew}>Lançar o primeiro gasto</button>}>Nenhum gasto lançado ainda.</Empty>
        ) : (
          <ul className="card divide-y divide-rule px-4">
            {recent.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-3">
                <CategoryIcon category={t.category} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{t.merchant}</p>
                  <p className="text-[13px] text-faint">{dayLabel(t.date)} · {t.category}</p>
                </div>
                <span className="money flex-none font-semibold">{money(t.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 6 · Upcoming dues */}
      <Section title="Próximos vencimentos" action={<Link to="/dividas" className="link">Dívidas</Link>}>
        {dues.length === 0 ? (
          <Empty>Nenhuma parcela em aberto. Bom sinal.</Empty>
        ) : (
          <ul className="card divide-y divide-rule px-4">
            {dues.map((d) => (
              <li key={d.id}>
                <Link to="/dividas" className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{d.description}</p>
                    <p className="text-[13px] text-faint">{d.bank} · dia {d.due_day} · parcela {Math.min(d.installments_paid + 1, d.installments_total)}/{d.installments_total}</p>
                  </div>
                  <div className="flex-none text-right">
                    <p className="money font-semibold">{d.installment_amount > 0 ? money(d.installment_amount) : <span className="text-faint">—</span>}</p>
                    <p className={`text-xs ${d.inDays <= 3 ? 'text-warning font-semibold' : 'text-faint'}`}>{dueLabel(d.inDays)}</p>
                  </div>
                  <ChevronRight size={16} className="flex-none text-faint" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
