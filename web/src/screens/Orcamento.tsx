import { useBuffet } from '../data/store'

export default function Orcamento() {
  const { data, update } = useBuffet()
  const set = (category: string, v: string) => {
    const monthly_limit = parseFloat(v.replace(',', '.')) || 0
    update((d) => ({ ...d, budgets: d.budgets.map((b) => (b.category === category ? { ...b, monthly_limit } : b)) }))
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Orçamento</h1>
      <p className="text-sm text-gray-400">Limite mensal por categoria (R$).</p>
      <div className="card space-y-3">
        {data.budgets.map((b) => (
          <label key={b.category} className="flex items-center justify-between gap-3">
            <span>{b.category}</span>
            <input className="input money w-32 text-right" inputMode="decimal" defaultValue={b.monthly_limit || ''} placeholder="0,00" onBlur={(e) => set(b.category, e.target.value)} />
          </label>
        ))}
      </div>
    </div>
  )
}
