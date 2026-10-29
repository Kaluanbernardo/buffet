import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useBuffet } from '../data/store'
import { fmtDate, money, today, uid } from '../lib/format'

export default function Gastos() {
  const { data, update } = useBuffet()
  const [f, setF] = useState({ amount: '', merchant: '', category: data.config.categories[0], date: today() })
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(f.amount.replace(',', '.'))
    if (!amount || !f.merchant) return
    update((d) => ({ ...d, transactions: [{ id: uid(), amount, merchant: f.merchant, category: f.category, date: f.date }, ...d.transactions] }))
    setF({ ...f, amount: '', merchant: '' })
  }
  const list = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date))
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Gastos</h1>
      <form onSubmit={add} className="card grid grid-cols-2 gap-2">
        <input className="input money" inputMode="decimal" placeholder="Valor (R$)" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <input className="input" placeholder="Estabelecimento" value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} />
        <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {data.config.categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        <input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        <button className="btn col-span-2">Adicionar</button>
      </form>
      <div className="card divide-y divide-[#222A35] p-0">
        {list.length === 0 && <p className="p-4 text-gray-400 text-sm">Nenhum gasto ainda.</p>}
        {list.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="truncate font-medium">{t.merchant}</p>
              <p className="text-xs text-gray-400">{t.category} · {fmtDate(t.date)}</p>
            </div>
            <span className="money font-semibold">{money(t.amount)}</span>
            <button aria-label="Excluir" className="text-gray-500" onClick={() => update((d) => ({ ...d, transactions: d.transactions.filter((x) => x.id !== t.id) }))}><Trash2 size={16} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
