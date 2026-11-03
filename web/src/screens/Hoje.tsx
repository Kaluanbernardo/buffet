import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useBuffet } from '../data/store'
import { bills, categoryShare, dailySpend, daysFrom, daysUntilDue, dueLabel, isOpen, monthSummary, posted, receivable, subDueLabel } from '../data/derive'
import { dayLabel, money, money0, monthKey, plural, shortMonth } from '../lib/format'
import { CategoryIcon, Columns, Empty, HideValuesButton, PlanTrack, ScreenHeader, Section, Sheet, ThemeButton, toneFor } from '../components/ui'
import { DailyBars, ShareBar } from '../components/charts'
import { useActions } from '../components/Actions'
import { ReceivableList, SplitLine } from '../components/Split'
import { SubIcon } from './Assinaturas'

export default function Hoje() {
  const { data, hidden, toggleHidden } = useBuffet()
  const { openNew } = useActions()
  const navigate = useNavigate()
  // Spend = what already happened: future installments (one row per month) stay out until their date.
  const live = posted(data)
  const m = monthSummary(live)
  const { clock } = m
  const hasPlan = m.limit > 0
  const tone = toneFor(m.spent, m.limit, clock.elapsed)
  const owed = receivable(data)
  const [owedOpen, setOwedOpen] = useState(false)
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
  const recent = [...live.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4)
  const share = categoryShare(m.tx)
  const billsPaid = data.cardPayments.filter((b) => monthKey(b.date) === m.mk).reduce((s, b) => s + b.amount, 0)
  const daily = dailySpend(live.transactions, 30)
  // Unpaid card bills (open/closed — card installments are paid through them), loans, and active subscriptions not yet
  // charged this cycle (next_due only moves on a charge/skip), soonest first.
  type Due = { key: string; to: string; title: string; detail: string; amount: number; inDays: number; label: string; sub: boolean }
  const billMonth = (mk: string) => shortMonth(Number(mk.slice(0, 4)), Number(mk.slice(5)) - 1)
  const dues: Due[] = [
    ...bills(data).unpaid.filter((b) => b.state !== 'future').map((b) => {
      const inDays = daysFrom(b.due)
      return { key: `${b.card}-${b.month}`, to: '/dividas', title: `Fatura ${b.card}`, amount: b.total, inDays, sub: false,
        label: inDays < 0 ? `Venceu há ${-inDays} ${-inDays === 1 ? 'dia' : 'dias'}` : dueLabel(inDays),
        detail: `${billMonth(b.month)} · ${b.state === 'open' ? 'aberta' : 'fechada'} · vence ${b.due.slice(8)}/${b.due.slice(5, 7)}` }
    }),
    ...data.debts.filter((d) => isOpen(d) && (d.kind === 'loan' || (d.kind !== 'bill' && !data.transactions.some((t) => t.debt_id === d.id)))).map((d) => {
      const inDays = daysUntilDue(d.due_day)
      return { key: d.id, to: '/dividas', title: d.description, amount: d.installment_amount, inDays, label: dueLabel(inDays), sub: false,
        detail: `${d.bank} · dia ${d.due_day} · parcela ${Math.min(d.installments_paid + 1, d.installments_total)}/${d.installments_total}` }
    }),
    ...data.subscriptions.filter((s) => s.status === 'active' && daysFrom(s.next_due) <= 31).map((s) => {
      const inDays = daysFrom(s.next_due)
      return { key: s.id, to: '/dividas?tab=assinaturas', title: s.name, amount: s.amount, inDays, label: subDueLabel(s, inDays), sub: true,
        detail: `Assinatura${s.bank ? ` · ${s.bank}` : ''} · ${s.next_due.slice(8)}/${s.next_due.slice(5, 7)}` }
    }),
  ].sort((a, b) => a.inDays - b.inDays).slice(0, 4)

  return (
    <div>
      <ScreenHeader title="Hoje" sub={<span className="first-letter:uppercase inline-block">{dateLine}</span>}
        action={<div className="flex gap-2 md:hidden"><ThemeButton /><HideValuesButton hidden={hidden} onToggle={toggleHidden} /></div>} />

      <Columns template="lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" main={<>
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
        {billsPaid > 0 && (
          <p className="money mt-4 text-[13px] text-faint">Faturas pagas em {clock.name}: {money(billsPaid)} · fora dos gastos</p>
        )}
        {/* From 768px the side rail carries "Novo gasto" on every screen. */}
        <button className="btn mt-5 w-full md:hidden" onClick={openNew}>Novo gasto</button>
      </section>

      {/* Cash on hand (buffet_app_config.cash_balance) */}
      <section className="card mt-3 flex items-baseline justify-between gap-3 px-4 py-3.5" aria-label="Saldo em caixa">
        <span className="text-sm font-semibold text-muted">Saldo em caixa</span>
        <span className="money font-semibold">{data.config.cash_balance == null ? <span className="text-faint">—</span> : money(data.config.cash_balance)}</span>
      </section>

      {/* Money others still owe on split spends. Not in the balance until it arrives. */}
      {owed.total > 0 && (
        <button type="button" onClick={() => setOwedOpen(true)} aria-haspopup="dialog"
          className="card mt-3 flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-raised">
          <span className="min-w-0 text-sm font-semibold text-muted">A receber<span className="font-normal text-faint"> · {plural(owed.rows.length, 'gasto', 'gastos')}</span></span>
          <span className="money flex flex-none items-center gap-1.5 font-semibold">{money(owed.total)}<ChevronRight size={16} className="text-faint" aria-hidden /></span>
        </button>
      )}

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

      </>} side={<>
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
                  <SplitLine t={t} />
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
          <Empty>Nenhuma fatura, parcela nem assinatura a vencer. Bom sinal.</Empty>
        ) : (
          <ul className="card divide-y divide-rule px-4">
            {dues.map((d) => (
              <li key={d.key}>
                <Link to={d.to} className="flex items-center gap-3 py-3">
                  {d.sub && <SubIcon size={32} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{d.title}</p>
                    <p className="truncate text-[13px] text-faint">{d.detail}</p>
                  </div>
                  <div className="flex-none text-right">
                    <p className="money font-semibold">{d.amount > 0 ? money(d.amount) : <span className="text-faint">—</span>}</p>
                    <p className={`text-xs ${d.inDays < -3 ? 'text-negative font-semibold' : d.inDays <= 3 ? 'text-warning font-semibold' : 'text-faint'}`}>{d.label}</p>
                  </div>
                  <ChevronRight size={16} className="flex-none text-faint" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      </>} />

      <Sheet open={owedOpen && owed.rows.length > 0} onClose={() => setOwedOpen(false)} title="A receber">
        <ReceivableList rows={owed.rows} total={owed.total} onClose={() => setOwedOpen(false)} />
      </Sheet>
    </div>
  )
}
