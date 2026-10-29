import { useBuffet } from '../data/store'
import { money } from '../lib/format'

export default function Mais({ onLogout }: { onLogout: () => void }) {
  const { data } = useBuffet()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Mais</h1>
      <section className="card space-y-3">
        <h2 className="font-semibold">Reserva</h2>
        {data.reserves.map((r) => {
          const pct = r.target > 0 ? Math.min(100, (r.current / r.target) * 100) : 0
          return (
            <div key={r.id}>
              <div className="flex justify-between text-sm"><span>{r.name}</span><span className="money text-gray-400">{money(r.current)} / {money(r.target)}</span></div>
              <div className="h-2 rounded-full bg-[#222A35] mt-1 overflow-hidden"><div className="h-full bg-emerald-400" style={{ width: `${pct}%` }} /></div>
            </div>
          )
        })}
      </section>
      <section className="card space-y-2">
        <h2 className="font-semibold">Investimentos</h2>
        {data.investments.length === 0 && <p className="text-sm text-gray-400">Nenhum investimento cadastrado.</p>}
        {data.investments.map((i) => (
          <div key={i.id} className="flex justify-between text-sm"><span>{i.name} <span className="text-gray-500">· {i.institution}</span></span><span className="money">{money(i.amount)}</span></div>
        ))}
      </section>
      <section className="card space-y-2">
        <h2 className="font-semibold">Config — Bancos</h2>
        {data.config.banks.map((b) => (
          <div key={b.name} className="flex justify-between text-sm"><span>{b.name}</span>
            <span className={b.status === 'active' ? 'text-emerald-400' : 'text-amber-400'}>{b.status === 'active' ? 'Ativo' : 'Planejado'}</span></div>
        ))}
        <button className="btn-ghost w-full mt-2" onClick={() => alert('Open Finance: em breve.')}>Conectar Open Finance (em breve)</button>
      </section>
      <button className="btn-ghost w-full text-red-400" onClick={onLogout}>Sair</button>
    </div>
  )
}
