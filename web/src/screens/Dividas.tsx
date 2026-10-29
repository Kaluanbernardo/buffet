import { useBuffet } from '../data/store'
import { money } from '../lib/format'

export default function Dividas() {
  const { data } = useBuffet()
  const monthly = data.debts.filter((d) => d.installments_paid < d.installments_total).reduce((s, d) => s + d.installment_amount, 0)
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Dívidas</h1>
      <div className="card"><p className="text-sm text-gray-400">Parcelas no mês</p><p className="money text-2xl font-bold">{money(monthly)}</p></div>
      <div className="card divide-y divide-[#222A35] p-0">
        {data.debts.map((d) => (
          <div key={d.id} className="px-4 py-3 flex justify-between">
            <div><p className="font-medium">{d.description}</p>
              <p className="text-xs text-gray-400">{d.bank} · {d.installments_paid}/{d.installments_total} · vence dia {d.due_day}</p></div>
            <span className="money font-semibold">{money(d.installment_amount)}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-500">Importação de faturas virá com Open Finance / Supabase.</p>
    </div>
  )
}
