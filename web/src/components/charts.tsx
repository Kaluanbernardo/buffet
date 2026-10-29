import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { OTHER_SLICE, type Slice } from '../data/derive'
import { dayLabel, money, moneyCompact } from '../lib/format'
import { catColor, NEUTRAL_MARK } from './ui'

const pct = (share: number) => `${Math.round(share * 100)}%`
const sliceColor = (key: string) => (key === OTHER_SLICE ? NEUTRAL_MARK : catColor(key))

/**
 * 100% stacked share bar + legend. Segments are separated by a 2px surface gap; the legend carries name,
 * value and share in text ink, so identity never rests on colour alone. Hovering a segment or a legend
 * row highlights the pair.
 */
export function ShareBar({ slices, label, onPick }: { slices: Slice[]; label: string; onPick?: (key: string) => void }) {
  const [hot, setHot] = useState<string | null>(null)
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img"
        aria-label={`${label}: ${slices.map((s) => `${s.key} ${pct(s.share)}`).join(', ')}`}>
        {slices.map((s) => (
          <span key={s.key} onPointerEnter={() => setHot(s.key)} onPointerLeave={() => setHot(null)}
            className="h-full min-w-[3px] transition-opacity duration-150"
            style={{ flexGrow: s.share, flexBasis: 0, background: sliceColor(s.key), opacity: hot && hot !== s.key ? 0.35 : 1 }} />
        ))}
      </div>
      <ul className="mt-3.5 space-y-0.5">
        {slices.map((s) => {
          const body = (<>
            <span aria-hidden className="size-2.5 flex-none rounded-[3px]" style={{ background: sliceColor(s.key) }} />
            <span className="min-w-0 flex-1 truncate text-left">{s.key}</span>
            <span className="money flex-none font-semibold">{money(s.value)}</span>
            <span className="money w-10 flex-none text-right text-faint">{pct(s.share)}</span>
          </>)
          const cls = `flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-sm transition-colors ${hot === s.key ? 'bg-raised' : ''}`
          return (
            <li key={s.key} onPointerEnter={() => setHot(s.key)} onPointerLeave={() => setHot(null)}>
              {onPick && s.key !== OTHER_SLICE
                ? <button type="button" className={cls} onClick={() => onPick(s.key)} onFocus={() => setHot(s.key)} onBlur={() => setHot(null)}>{body}</button>
                : <div className={cls}>{body}</div>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Daily spend strip: one bar per day, today in accent, others in quiet ink. An optional dashed line marks
 * the daily allowance (plan ÷ days). Pointer / arrow keys move a readout above the plot; a hidden table
 * carries every value for screen readers.
 */
export function DailyBars({ days, allowance }: { days: { date: string; day: number; total: number }[]; allowance?: number }) {
  const [sel, setSel] = useState(days.length - 1)
  const W = 300, H = 76, gap = 2
  const max = Math.max(1, allowance ?? 0, ...days.map((d) => d.total))
  const bw = (W - gap * (days.length - 1)) / days.length
  const y = (v: number) => H - (v / max) * H
  const cur = days[sel] ?? days[days.length - 1]
  const total = days.reduce((s, d) => s + d.total, 0)

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setSel(Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - r.left) / r.width) * days.length))))
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSel((i) => Math.min(days.length - 1, i + 1)) }
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm" aria-live="polite">
        <span className="text-muted first-letter:uppercase">{dayLabel(cur.date)}</span>
        <span className="money font-semibold">{cur.total > 0 ? money(cur.total) : <span className="font-normal text-faint">sem gastos</span>}</span>
      </div>
      <svg viewBox={`0 -4 ${W} ${H + 4}`} preserveAspectRatio="none" className="block h-[80px] w-full touch-pan-y outline-none"
        tabIndex={0} role="img" aria-label={`Gastos por dia nos últimos ${days.length} dias, total ${money(total)}. Use as setas para navegar.`}
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setSel(days.length - 1)} onKeyDown={key}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--color-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const isToday = i === days.length - 1
          const h = d.total > 0 ? Math.max(3, H - y(d.total)) : 1.5
          return (
            <rect key={d.date} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(2, bw / 2)}
              fill={isToday ? 'var(--color-accent)' : d.total > 0 ? 'var(--color-muted)' : 'var(--color-control)'}
              opacity={i === sel || isToday ? 1 : d.total > 0 ? 0.55 : 1} />
          )
        })}
        {allowance !== undefined && allowance > 0 && (
          <line x1={0} x2={W} y1={y(allowance)} y2={y(allowance)} stroke="var(--color-ink)" strokeOpacity={0.5}
            strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
        <rect x={sel * (bw + gap) - gap / 2} y={-4} width={bw + gap} height={H + 4} fill="var(--color-ink)" opacity={0.06} />
      </svg>
      <div className="mt-2 flex justify-between text-xs text-faint">
        <span className="first-letter:uppercase">{dayLabel(days[0].date)}</span>
        {allowance !== undefined && allowance > 0 && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-3.5 border-t border-dashed border-ink/50" />
            <span className="money">{moneyCompact(allowance)}/dia no plano</span>
          </span>
        )}
        <span>Hoje</span>
      </div>
      <table className="sr-only">
        <caption>Gastos por dia</caption>
        <tbody>{days.map((d) => <tr key={d.date}><th scope="row">{d.date}</th><td>{money(d.total)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

/** Progress ring for installments: paid / total, centre shows "X/Y". */
export function Ring({ value, total, size = 52, label }: { value: number; total: number; size?: number; label: string }) {
  const r = (size - 6) / 2
  const c = 2 * Math.PI * r
  const f = total > 0 ? Math.min(1, value / total) : 0
  return (
    <div className="relative grid flex-none place-items-center" style={{ width: size, height: size }}
      role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-raised)" strokeWidth={5} />
        {f > 0 && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={f >= 1 ? 'var(--color-accent)' : 'var(--color-ink)'} strokeOpacity={f >= 1 ? 1 : 0.8}
            strokeWidth={5} strokeLinecap="round" strokeDasharray={`${c * f} ${c}`} className="transition-[stroke-dasharray] duration-500" />
        )}
      </svg>
      <span aria-hidden className="money absolute text-[12px] font-bold">{value}/{total}</span>
    </div>
  )
}
