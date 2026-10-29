import { useMemo, useState } from 'react'
import { Download, Eye, EyeOff, LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePref } from '../lib/theme'
import { useBuffet } from '../data/store'
import { money, money0, monthKey, monthName, parseMoney, plural, today } from '../lib/format'
import { download, monthCsv } from '../lib/csv'
import { BrandMark, Empty, ScreenHeader, Section } from '../components/ui'
import { useActions } from '../components/Actions'
import type { Reserve } from '../data/types'

const fmtInput = (v: number) => (v ? v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '')

const THEMES: { key: ThemePref; label: string; Icon: typeof Sun }[] = [
  { key: 'system', label: 'Sistema', Icon: Monitor },
  { key: 'light', label: 'Claro', Icon: Sun },
  { key: 'dark', label: 'Escuro', Icon: Moon },
]

export default function Mais({ onLogout }: { onLogout: () => void }) {
  const { data, update, hidden, toggleHidden } = useBuffet()
  const { notify } = useActions()
  const { pref, setPref } = useTheme()
  const invested = data.investments.reduce((s, i) => s + i.amount, 0)
  const reserved = data.reserves.reduce((s, r) => s + r.current, 0)
  const current = monthKey(today())
  const months = useMemo(() => [...new Set([current, ...data.transactions.map((t) => monthKey(t.date))])].sort().reverse(), [data.transactions, current])
  const [mk, setMk] = useState(current)

  const setReserve = (r: Reserve, field: 'target' | 'current', raw: string) => {
    const n = parseMoney(raw)
    const v = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
    if (v === r[field]) return
    update((d) => ({ ...d, reserves: d.reserves.map((x) => (x.id === r.id ? { ...x, [field]: v } : x)) }))
    notify({
      msg: field === 'target' ? `Meta de ${r.name}: ${v ? money0(v) : 'sem meta'}` : `${r.name}: ${money(v)} guardados`,
      undo: () => update((d) => ({ ...d, reserves: d.reserves.map((x) => (x.id === r.id ? { ...x, [field]: r[field] } : x)) })),
    })
  }

  const exportCsv = () => {
    const { csv, count } = monthCsv(data.transactions, mk)
    download(`buffet-gastos-${mk}.csv`, csv)
    notify({ msg: `${plural(count, 'gasto exportado', 'gastos exportados')} de ${monthName(mk).toLowerCase()}` })
  }

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
            const missing = Math.max(0, r.target - r.current)
            return (
              <li key={`${r.id}-${hidden}`} className="py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-semibold">{r.name}</span>
                  <span className="money flex-none text-sm text-muted">
                    {r.target > 0 ? (missing > 0 ? `${Math.round(pct)}% · faltam ${money0(missing)}` : 'Meta batida') : 'sem meta'}
                  </span>
                </div>
                <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-raised" role="meter" aria-label={r.name} aria-valuemin={0} aria-valuemax={r.target} aria-valuenow={r.current}>
                  {pct > 0 && <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {(['current', 'target'] as const).map((field) => (
                    <div key={field}>
                      <label htmlFor={`rs-${r.id}-${field}`} className="label">{field === 'target' ? 'Meta' : 'Guardado'}</label>
                      <div className="relative">
                        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-faint">R$</span>
                        <input id={`rs-${r.id}-${field}`} inputMode="decimal" placeholder={hidden ? '••••' : '0'} autoComplete="off"
                          disabled={hidden} aria-description={hidden ? 'valor oculto' : undefined}
                          className="input money h-10 pl-9 text-right text-[15px] font-semibold"
                          defaultValue={hidden ? '' : fmtInput(r[field])}
                          onBlur={(e) => setReserve(r, field, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
                      </div>
                    </div>
                  ))}
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

      <Section title="Aparência">
        <div className="card p-4">
          <p id="theme-label" className="font-semibold">Tema</p>
          <p className="text-[13px] text-faint">“Sistema” acompanha o claro/escuro do aparelho.</p>
          <div role="radiogroup" aria-labelledby="theme-label" className="mt-3 grid grid-cols-3 gap-1 rounded-full border border-line bg-ground p-1">
            {THEMES.map(({ key, label, Icon }) => {
              const on = pref === key
              return (
                <button key={key} type="button" role="radio" aria-checked={on} onClick={() => setPref(key)}
                  className={`flex h-10 items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition-colors ${on ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink'}`}>
                  <Icon size={16} />{label}
                </button>
              )
            })}
          </div>
        </div>
      </Section>

      <Section title="Privacidade e dados">
        <div className="card divide-y divide-rule px-4">
          <div className="flex items-center gap-3 py-3.5">
            <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-raised text-muted">
              {hidden ? <EyeOff size={17} /> : <Eye size={17} />}
            </span>
            <div className="min-w-0 flex-1">
              <p id="hide-label" className="font-semibold">Ocultar valores</p>
              <p className="text-[13px] text-faint">Troca os valores por R$ •••• em todas as telas.</p>
            </div>
            <button type="button" role="switch" aria-checked={hidden} aria-labelledby="hide-label" onClick={toggleHidden}
              className={`relative h-7 w-12 flex-none rounded-full transition-colors ${hidden ? 'bg-accent' : 'bg-control'}`}>
              <span aria-hidden className={`absolute top-1 left-1 size-5 rounded-full bg-knob shadow-sm transition-transform ${hidden ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <div className="py-3.5">
            <p className="font-semibold">Exportar gastos</p>
            <p className="text-[13px] text-faint">Planilha CSV do mês, pronta para Excel ou Google Planilhas.</p>
            <div className="mt-3 flex gap-2">
              <select aria-label="Mês para exportar" className="input h-11 flex-1" value={mk} onChange={(e) => setMk(e.target.value)}>
                {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
              </select>
              <button type="button" className="btn-ghost h-11 flex-none" onClick={exportCsv}><Download size={17} />Baixar CSV</button>
            </div>
          </div>
        </div>
      </Section>

      <section className="mt-10 border-t border-line pt-6">
        <button className="btn-ghost w-full border-negative/40 text-negative hover:bg-negative-tint" onClick={onLogout}>
          <LogOut size={18} />Sair
        </button>
        <p className="mt-3 text-center text-xs text-faint">Os dados ficam salvos neste aparelho.</p>
        <div className="mt-8 flex items-center justify-center gap-2 text-faint">
          <BrandMark size={16} />
          <span className="text-xs font-semibold">Buffet · v0.2</span>
        </div>
      </section>
    </div>
  )
}
