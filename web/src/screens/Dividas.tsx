import { useBuffet } from '../data/store'
import { daysUntilDue, dueLabel, isOpen, payoff } from '../data/derive'
import { money, plural, shortMonth } from '../lib/format'
import { Columns, Empty, ScreenHeader, Section } from '../components/ui'
import { Ring } from '../components/charts'
import { useActions } from '../components/Actions'
import type { Debt } from '../data/types'

export default function Dividas() {
  const { data, update } = useBuffet()
  const { notify } = useActions()
  const open = data.debts.filter(isOpen).map((d) => ({ ...d, inDays: daysUntilDue(d.due_day), end: payoff(d) })).sort((a, b) => a.inDays - b.inDays)
  const done = data.debts.filter((d) => !isOpen(d))
  const monthly = open.reduce((s, d) => s + d.installment_amount, 0)
  const balance = open.reduce((s, d) => s + d.installment_amount * (d.installments_total - d.installments_paid), 0)
  // The month the last open installment falls in: "livre de parcelas em mar/27".
  const free = open.reduce<{ year: number; month: number } | null>((acc, d) =>
    !acc || d.end.year * 12 + d.end.month > acc.year * 12 + acc.month ? d.end : acc, null)
  const paidAll = data.debts.reduce((s, d) => s + Math.min(d.installments_paid, d.installments_total), 0)
  const totalAll = data.debts.reduce((s, d) => s + d.installments_total, 0)

  const pay = (d: Debt) => {
    const step = (n: number) => update((x) => ({ ...x, debts: x.debts.map((y) => (y.id === d.id ? { ...y, installments_paid: n } : y)) }))
    step(d.installments_paid + 1)
    notify({ msg: `Parcela ${d.installments_paid + 1}/${d.installments_total} de ${d.description} paga`, undo: () => step(d.installments_paid) })
  }

  return (
    <div>
      <ScreenHeader title="Dívidas" sub={open.length ? `${plural(open.length, 'compromisso', 'compromissos')} em aberto` : 'Nada em aberto'} />

      <Columns template="lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" main={<div className="lg:sticky lg:top-9">
      <section className="card grid grid-cols-2 divide-x divide-rule">
        <div className="p-4">
          <p className="text-sm font-semibold text-muted">Parcelas por mês</p>
          <p className="money mt-1 text-[22px] leading-none font-extrabold tracking-[-0.03em]">{money(monthly)}</p>
        </div>
        <div className="p-4">
          <p className="text-sm font-semibold text-muted">Saldo a pagar</p>
          <p className="money mt-1 text-[22px] leading-none font-bold tracking-[-0.03em] text-muted">{money(balance)}</p>
          {free && <p className="mt-1.5 text-xs text-faint">livre em {shortMonth(free.year, free.month)}</p>}
        </div>
      </section>

      {totalAll > 0 && open.length > 0 && (
        <div className="mt-3 px-1">
          <div className="flex items-baseline justify-between text-xs text-faint">
            <span>Progresso geral</span>
            <span className="money">{paidAll} de {plural(totalAll, 'parcela', 'parcelas')} pagas</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised" role="meter" aria-label="Parcelas pagas no total"
            aria-valuemin={0} aria-valuemax={totalAll} aria-valuenow={paidAll}>
            {paidAll > 0 && <div className="h-full rounded-full bg-accent" style={{ width: `${(paidAll / totalAll) * 100}%` }} />}
          </div>
        </div>
      )}

      <p className="mt-6 hidden px-1 text-xs text-faint lg:block">A importação automática de faturas chega com Open Finance.</p>
      </div>} side={<>
      <Section title="Em aberto">
        {open.length === 0 ? (
          <Empty>Nenhuma parcela em aberto.</Empty>
        ) : (
          <ul className="card divide-y divide-rule px-4">
            {open.map((d) => {
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

      <p className="mt-6 px-1 text-xs text-faint lg:hidden">A importação automática de faturas chega com Open Finance.</p>
      </>} />
    </div>
  )
}
