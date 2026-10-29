import { useBuffet } from '../data/store'
import { money, monthKey } from '../lib/format'

export default function Hoje() {
  const { data } = useBuffet()
  const mk = monthKey()
  const tx = data.transactions.filter((t) => monthKey(t.date) === mk)
  const total = tx.reduce((s, t) => s + t.amount, 0)
  const byCat = (c: string) => tx.filter((t) => t.category === c).reduce((s, t) => s + t.amount, 0)
  const day = new Date().getDate()
  const upcoming = data.debts.filter((d) => d.installments_paid < d.installments_total && d.due_day >= day).length
  const mes = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Hoje</h1>
      <div className="card">
        <p className="text-sm text-gray-400 capitalize">Gasto em {mes}</p>
        <p className="money text-3xl font-bold">{money(total)}</p>
        <p className="text-sm text-gray-400 mt-1">{upcoming} vencimento(s) até o fim do mês</p>
      </div>
      <div className="card space-y-3">
        <h2 className="font-semibold">Orçamento</h2>
        {data.budgets.map((b) => {
          const spent = byCat(b.category)
          const pct = b.monthly_limit > 0 ? Math.min(100, (spent / b.monthly_limit) * 100) : 0
          const over = b.monthly_limit > 0 && spent > b.monthly_limit
          return (
            <div key={b.category}>
              <div className="flex justify-between text-sm"><span>{b.category}</span>
                <span className="money text-gray-400">{money(spent)}{b.monthly_limit > 0 && ` / ${money(b.monthly_limit)}`}</span></div>
              <div className="h-2 rounded-full bg-[#222A35] mt-1 overflow-hidden">
                <div className={`h-full ${over ? 'bg-red-400' : 'bg-emerald-400'}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
