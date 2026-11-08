import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { PAY_ORIGIN_LABEL, treemapRects, type SankeyFlow, type Slice } from '../data/derive'
import { dayLabel, money, moneyCompact, today } from '../lib/format'
import { catColor, NEUTRAL_MARK } from './ui'

const pct = (share: number) => `${Math.round(share * 100)}%`
const sliceColor = catColor

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
      <Legend slices={slices} hot={hot} setHot={setHot} onPick={onPick} className="mt-3.5" />
    </div>
  )
}

/** Name · value · share rows shared by the share bar and the donut; rows are buttons when `onPick` is set. */
export function Legend({ slices, hot, setHot, onPick, className = '' }: {
  slices: Slice[]; hot: string | null; setHot: (k: string | null) => void; onPick?: (key: string) => void; className?: string
}) {
  return (
    <ul className={`space-y-0.5 ${className}`}>
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
            {onPick
              ? <button type="button" className={cls} onClick={() => onPick(s.key)} onFocus={() => setHot(s.key)} onBlur={() => setHot(null)}>{body}</button>
              : <div className={cls}>{body}</div>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Category donut: same slices, colours and legend as the share bar, total in the hole. Segments keep a
 * 2px gap so neighbouring hues never touch; hovering a segment or legend row highlights the pair.
 */
export function Donut({ slices, label, caption, onPick }: { slices: Slice[]; label: string; caption: string; onPick?: (key: string) => void }) {
  const [hot, setHot] = useState<string | null>(null)
  const size = 132, stroke = 16, r = (size - stroke) / 2, c = 2 * Math.PI * r
  const gap = slices.length > 1 ? 2 : 0
  const total = slices.reduce((s, x) => s + x.value, 0)
  const cur = slices.find((s) => s.key === hot)
  let at = 0
  return (
    <div className="@container"><div className="flex flex-col items-center gap-4 @md:flex-row">
      <div className="relative grid flex-none place-items-center" style={{ width: size, height: size }} role="img"
        aria-label={`${label}: ${slices.map((s) => `${s.key} ${pct(s.share)}`).join(', ')}`}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden>
          {slices.map((s) => {
            const len = Math.max(0.5, s.share * c - gap)
            const el = (
              <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={sliceColor(s.key)} strokeWidth={stroke}
                strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-at}
                onPointerEnter={() => setHot(s.key)} onPointerLeave={() => setHot(null)}
                className="transition-opacity duration-150" opacity={hot && hot !== s.key ? 0.35 : 1} />
            )
            at += s.share * c
            return el
          })}
        </svg>
        <div aria-hidden className="absolute inset-0 grid place-content-center px-5 text-center">
          <span className="money text-[15px] leading-tight font-bold">{moneyCompact(cur ? cur.value : total)}</span>
          <span className="mt-0.5 truncate text-[11px] text-faint">{cur ? cur.key : caption}</span>
        </div>
      </div>
      <Legend slices={slices} hot={hot} setHot={setHot} onPick={onPick} className="w-full min-w-0 @md:flex-1" />
    </div></div>
  )
}

/**
 * Daily spend strip: one bar per day, today in accent, others in quiet ink. An optional dashed line marks
 * the daily allowance (plan ÷ days). Pointer / arrow keys move a readout above the plot; a hidden table
 * carries every value for screen readers.
 */
export function DailyBars({ days, allowance, from, to = 'Hoje', label = `Gastos por dia nos últimos ${days.length} dias` }: {
  days: { date: string; day: number; total: number }[]; allowance?: number; from?: string; to?: string; label?: string
}) {
  const t = today()
  const ti = days.findIndex((d) => d.date === t)
  const rest = ti >= 0 ? ti : days.length - 1
  const [sel, setSel] = useState(rest)
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
        <span className="money font-semibold">{cur.total > 0 ? money(cur.total) : <span className="font-normal text-faint">{cur.date > t ? 'ainda não chegou' : 'sem gastos'}</span>}</span>
      </div>
      <svg viewBox={`0 -4 ${W} ${H + 4}`} preserveAspectRatio="none" className="block h-[80px] w-full touch-pan-y outline-none"
        tabIndex={0} role="img" aria-label={`${label}, total ${money(total)}. Use as setas para navegar.`}
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setSel(rest)} onKeyDown={key}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--color-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const isToday = i === ti
          const h = d.total > 0 ? Math.max(3, H - y(d.total)) : 1.5
          return (
            <rect key={d.date} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(2, bw / 2)}
              fill={isToday ? 'var(--color-accent)' : d.total > 0 ? 'var(--color-muted)' : 'var(--color-control)'}
              opacity={d.date > t ? 0.35 : i === sel || isToday ? 1 : d.total > 0 ? 0.55 : 1} />
          )
        })}
        {allowance !== undefined && allowance > 0 && (
          <line x1={0} x2={W} y1={y(allowance)} y2={y(allowance)} stroke="var(--color-ink)" strokeOpacity={0.5}
            strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
        <rect x={sel * (bw + gap) - gap / 2} y={-4} width={bw + gap} height={H + 4} fill="var(--color-ink)" opacity={0.06} />
      </svg>
      <div className="mt-2 flex justify-between text-xs text-faint">
        <span className="first-letter:uppercase">{from ?? dayLabel(days[0].date)}</span>
        {allowance !== undefined && allowance > 0 && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block w-3.5 border-t border-dashed border-ink/50" />
            <span className="money">{moneyCompact(allowance)}/dia no plano</span>
          </span>
        )}
        <span className="first-letter:uppercase">{to}</span>
      </div>
      <table className="sr-only">
        <caption>Gastos por dia</caption>
        <tbody>{days.map((d) => <tr key={d.date}><th scope="row">{d.date}</th><td>{money(d.total)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']

/**
 * Week seg → dom: this week's bar in front, last week's as a hollow outline behind it, on one shared
 * scale. Today in accent; days still to come stay empty. Pointer / arrows move the readout.
 */
export function WeekBars({ days, prev }: { days: { date: string; total: number }[]; prev?: { date: string; total: number }[] }) {
  const t = today()
  const ti = days.findIndex((d) => d.date === t)
  const rest = ti >= 0 ? ti : 6
  const [sel, setSel] = useState(rest)
  const W = 300, H = 96, slot = W / 7, bw = slot * 0.46
  const max = Math.max(1, ...days.map((d) => d.total), ...(prev ?? []).map((d) => d.total))
  const h = (v: number) => (v > 0 ? Math.max(3, (v / max) * H) : 0)
  const cur = days[sel]
  const before = prev?.[sel]

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setSel(Math.max(0, Math.min(6, Math.floor(((e.clientX - r.left) / r.width) * 7))))
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSel((i) => Math.min(6, i + 1)) }
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm" aria-live="polite">
        <span className="text-muted first-letter:uppercase">{dayLabel(cur.date)}</span>
        <span className="money text-right">
          {cur.date > t ? <span className="text-faint">ainda não chegou</span>
            : cur.total > 0 ? <span className="font-semibold">{money(cur.total)}</span> : <span className="text-faint">sem gastos</span>}
          {before && <span className="text-faint"> · antes {money(before.total)}</span>}
        </span>
      </div>
      <svg viewBox={`0 -4 ${W} ${H + 4}`} preserveAspectRatio="none" className="block h-[100px] w-full touch-pan-y outline-none"
        tabIndex={0} role="img" aria-label={`Gastos por dia da semana${prev ? ', comparados com a semana anterior' : ''}. Use as setas para navegar.`}
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setSel(rest)} onKeyDown={key}>
        <rect x={sel * slot} y={-4} width={slot} height={H + 4} fill="var(--color-ink)" opacity={0.06} rx={4} />
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--color-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const x = i * slot + (slot - bw) / 2
          const p = prev?.[i]?.total ?? 0
          const future = d.date > t
          return (
            <g key={d.date}>
              {p > 0 && (
                <rect x={x + bw * 0.22} y={H - h(p)} width={bw} height={h(p)} rx={2} fill="none"
                  stroke="var(--color-faint)" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
              )}
              {d.total > 0 ? (
                <rect x={x - bw * 0.22} y={H - h(d.total)} width={bw} height={h(d.total)} rx={2}
                  fill={i === ti ? 'var(--color-accent)' : 'var(--color-muted)'} opacity={i === sel || i === ti ? 1 : 0.7} />
              ) : (
                <rect x={x - bw * 0.22} y={H - 1.5} width={bw} height={1.5} fill="var(--color-control)" opacity={future ? 0.4 : 1} />
              )}
            </g>
          )
        })}
      </svg>
      <div className="mt-2 grid grid-cols-7 text-center text-xs text-faint">
        {days.map((d, i) => <span key={d.date} className={i === ti ? 'font-semibold text-accent' : ''}>{WEEKDAYS[i]}</span>)}
      </div>
      {prev && (
        <div className="mt-3 flex gap-4 text-xs text-faint">
          <span className="flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-[3px] bg-muted" />Esta semana</span>
          <span className="flex items-center gap-1.5"><span aria-hidden className="inline-block size-2.5 rounded-[3px] border border-dashed border-faint" />Semana anterior</span>
        </div>
      )}
      <table className="sr-only">
        <caption>Gastos por dia da semana</caption>
        <thead><tr><th>Dia</th><th>Valor</th>{prev && <th>Semana anterior</th>}</tr></thead>
        <tbody>{days.map((d, i) => <tr key={d.date}><th scope="row">{d.date}</th><td>{money(d.total)}</td>{prev && <td>{money(prev[i]?.total ?? 0)}</td>}</tr>)}</tbody>
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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)
const HALO = { paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.45)', strokeWidth: 2.5, strokeLinejoin: 'round' } as const
const EMPTY = <p className="py-6 text-center text-sm text-faint">Sem gastos para mostrar.</p>

/**
 * Category treemap: one mosaic, area = spend. Name and compact amount sit inside the blocks big enough for them; the legend
 * below carries every category with its full value, and the line above reads out the touched block. Tap filters.
 */
export function Treemap({ slices, label, onPick }: { slices: Slice[]; label: string; onPick?: (key: string) => void }) {
  const [hot, setHot] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const W = 340, H = 210
  const rects = treemapRects(slices, W, H)
  if (rects.length === 0) return EMPTY
  const total = slices.reduce((s, x) => s + x.value, 0)
  const at = slices.find((x) => x.key === (hot ?? sel))
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm" aria-live="polite">
        <span className="min-w-0 truncate text-muted">{at ? at.key : 'Total'}</span>
        <span className="money flex-none font-semibold">{money(at ? at.value : total)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img"
        aria-label={`${label}: ${slices.map((x) => `${x.key} ${money(x.value)}`).join(', ')}`}>
        {rects.map((r) => {
          const w = Math.max(0, r.w - 2), h = Math.max(0, r.h - 2)
          const text = w >= 56 && h >= 30
          return (
            <g key={r.key} onPointerEnter={() => setHot(r.key)} onPointerLeave={() => setHot(null)} onPointerDown={() => setSel(r.key)}
              onClick={() => onPick?.(r.key)} className={`transition-opacity duration-150 ${onPick ? 'cursor-pointer' : ''}`} opacity={hot && hot !== r.key ? 0.45 : 1}>
              <title>{`${r.key}: ${money(r.value)}`}</title>
              <rect x={r.x + 1} y={r.y + 1} width={w} height={h} rx={4} fill={catColor(r.key)} />
              {text && (
                <text x={r.x + 7} y={r.y + 17} fill="#fff" fontSize={11} fontWeight={700} style={HALO}>
                  {clip(r.key, Math.floor((w - 10) / 5.8))}
                  <tspan x={r.x + 7} dy={14} fontSize={10} fontWeight={600} className="money">{moneyCompact(r.value)}</tspan>
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <Legend slices={slices} hot={hot} setHot={setHot} onPick={onPick} className="mt-3.5" />
      <table className="sr-only">
        <caption>{label}</caption>
        <thead><tr><th>Categoria</th><th>Valor</th></tr></thead>
        <tbody>{slices.map((x) => <tr key={x.key}><th scope="row">{x.key}</th><td>{money(x.value)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

type Hot = { kind: 'link'; i: number } | { kind: 'cat'; key: string } | { kind: 'origin'; key: string }

/**
 * Sankey, payment method → category. Left bars are the methods, right bars the categories, ribbons the spend of one method in
 * one category (thickness = value on a single scale). Tiny nodes keep a minimum height; the readout and tooltips carry the true
 * amount. Tap a category bar or ribbon to filter by it.
 */
export function Sankey({ flow, label, onPick }: { flow: SankeyFlow; label: string; onPick?: (key: string) => void }) {
  const [hot, setHot] = useState<Hot | null>(null)
  const [sel, setSel] = useState<Hot | null>(null)
  if (flow.links.length === 0 || flow.total <= 0) return EMPTY

  const W = 420, bw = 8, xl = 136, xr = W - 144 - bw, minH = 4, gap = 6, row = 24
  const H = Math.min(520, Math.max(180, Math.max(flow.origins.length, flow.categories.length) * row))
  // One scale for both columns: the tighter column decides, the other is centred.
  const place = <T extends { key: string; value: number }>(nodes: T[], scale: number) => {
    const hs = nodes.map((n) => Math.max(minH, n.value * scale))
    const used = hs.reduce((a, b) => a + b, 0) + gap * (nodes.length - 1)
    let y = Math.max(0, (H - used) / 2)
    return new Map(nodes.map((n, i) => { const o = { y, h: hs[i] }; y += hs[i] + gap; return [n.key, o] as const }))
  }
  // Largest scale at which both columns (with minimum heights and gaps) still fit in H.
  const scaleFor = (nodes: { value: number }[]) => {
    let scale = (H - gap * (nodes.length - 1)) / flow.total
    for (let k = 0; k < 6; k++) {
      const tiny = nodes.filter((n) => n.value * scale < minH)
      const room = H - gap * (nodes.length - 1) - tiny.length * minH
      const big = nodes.reduce((s, n) => s + (n.value * scale < minH ? 0 : n.value), 0)
      if (big <= 0 || room <= 0) break
      scale = room / big
    }
    return scale
  }
  const scale = Math.min(scaleFor(flow.origins), scaleFor(flow.categories))
  const left = place(flow.origins, scale)
  const right = place(flow.categories, scale)

  // Ribbons stack inside each node in link order (origin-major, so categories see origins in method order).
  const start = (nodes: { key: string; value: number }[], pos: Map<string, { y: number; h: number }>) =>
    new Map(nodes.map((n) => [n.key, pos.get(n.key)!.y + (pos.get(n.key)!.h - n.value * scale) / 2]))
  const fromOff = start(flow.origins, left), toOff = start(flow.categories, right)
  const ribbons = flow.links.map((l, i) => {
    const t = Math.max(0.75, l.value * scale)
    const ya = fromOff.get(l.source)!, yb = toOff.get(l.category)!
    fromOff.set(l.source, ya + l.value * scale)
    toOff.set(l.category, yb + l.value * scale)
    const x0 = xl + bw, x1 = xr, m = (x0 + x1) / 2
    return { i, l, d: `M${x0},${ya}C${m},${ya} ${m},${yb} ${x1},${yb}L${x1},${yb + t}C${m},${yb + t} ${m},${ya + t} ${x0},${ya + t}Z` }
  })

  // One label per node (two lines), kept apart when nodes are too small for them.
  const labels = (nodes: { key: string }[], pos: Map<string, { y: number; h: number }>) => {
    const ys = nodes.map((n) => pos.get(n.key)!.y + pos.get(n.key)!.h / 2)
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + row - 2)
    const over = (ys[ys.length - 1] ?? 0) + row / 2 - H
    if (over > 0) for (let i = ys.length - 1; i >= 0; i--) { ys[i] -= over; if (i > 0) ys[i - 1] = Math.min(ys[i - 1], ys[i] - (row - 2)) }
    return ys
  }
  const lys = labels(flow.origins, left), rys = labels(flow.categories, right)

  const cur = hot ?? sel
  const touches = (r: { l: { source: string; category: string }; i: number }) =>
    !cur || (cur.kind === 'link' ? cur.i === r.i : cur.kind === 'cat' ? cur.key === r.l.category : cur.key === r.l.source)
  const readout = !cur ? { name: 'Total', value: flow.total }
    : cur.kind === 'link' ? { name: `${PAY_ORIGIN_LABEL[flow.links[cur.i].source]} → ${flow.links[cur.i].category}`, value: flow.links[cur.i].value }
    : cur.kind === 'cat' ? { name: cur.key, value: flow.categories.find((c) => c.key === cur.key)?.value ?? 0 }
    : { name: PAY_ORIGIN_LABEL[cur.key as keyof typeof PAY_ORIGIN_LABEL], value: flow.origins.find((o) => o.key === cur.key)?.value ?? 0 }
  const on = (h: Hot) => ({ onPointerEnter: () => setHot(h), onPointerLeave: () => setHot(null), onPointerDown: () => setSel(h) })
  const pick = (c: string) => ({ onClick: () => onPick?.(c), className: `transition-opacity duration-150 ${onPick ? 'cursor-pointer' : ''}` })

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm" aria-live="polite">
        <span className="min-w-0 truncate text-muted">{readout.name}</span>
        <span className="money flex-none font-semibold">{money(readout.value)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img"
        aria-label={`${label}: ${flow.links.map((l) => `${PAY_ORIGIN_LABEL[l.source]} para ${l.category} ${money(l.value)}`).join(', ')}`}>
        {ribbons.map((r) => (
          <path key={r.i} d={r.d} fill={catColor(r.l.category)} opacity={cur ? (touches(r) ? 0.8 : 0.12) : 0.5} {...on({ kind: 'link', i: r.i })} {...pick(r.l.category)}>
            <title>{`${PAY_ORIGIN_LABEL[r.l.source]} → ${r.l.category}: ${money(r.l.value)}`}</title>
          </path>
        ))}
        {flow.origins.map((o, k) => {
          const p = left.get(o.key)!
          return (
            <g key={o.key} {...on({ kind: 'origin', key: o.key })}>
              <title>{`${o.label}: ${money(o.value)}`}</title>
              <rect x={xl} y={p.y} width={bw} height={p.h} rx={2} fill={NEUTRAL_MARK} />
              <text x={xl - 6} y={lys[k] - 2} textAnchor="end" fontSize={10.5} fontWeight={600} fill="var(--color-ink)">{clip(o.label, 24)}</text>
              <text x={xl - 6} y={lys[k] + 10} textAnchor="end" fontSize={10} fill="var(--color-muted)" className="money">{moneyCompact(o.value)}</text>
            </g>
          )
        })}
        {flow.categories.map((c, k) => {
          const p = right.get(c.key)!
          return (
            <g key={c.key} {...on({ kind: 'cat', key: c.key })} {...pick(c.key)}>
              <title>{`${c.key}: ${money(c.value)}`}</title>
              <rect x={xr} y={p.y} width={bw} height={p.h} rx={2} fill={catColor(c.key)} />
              <text x={xr + bw + 6} y={rys[k] - 2} fontSize={10.5} fontWeight={600} fill="var(--color-ink)">{clip(c.key, 24)}</text>
              <text x={xr + bw + 6} y={rys[k] + 10} fontSize={10} fill="var(--color-muted)" className="money">{moneyCompact(c.value)}</text>
            </g>
          )
        })}
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead><tr><th>Forma de pagamento</th><th>Categoria</th><th>Valor</th></tr></thead>
        <tbody>{flow.links.map((l) => <tr key={`${l.source}-${l.category}`}><th scope="row">{PAY_ORIGIN_LABEL[l.source]}</th><td>{l.category}</td><td>{money(l.value)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}
