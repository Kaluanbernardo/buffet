import { useEffect, useRef, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import {
  UtensilsCrossed, Bus, House, HeartPulse, Ticket, Repeat, GraduationCap, Shapes, X, type LucideIcon,
} from 'lucide-react'

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Alimentação: UtensilsCrossed, Transporte: Bus, Moradia: House, Saúde: HeartPulse,
  Lazer: Ticket, Assinaturas: Repeat, Educação: GraduationCap,
}

/**
 * Data hues, chart marks only (legend dots, share bars) — never text, never icons. Fixed per category so a
 * filter never repaints survivors. Six dark-surface steps validated as a set (adjacent CVD ΔE ≥ 8.4 on
 * #151a21); status green/red stay out so "over" and "on pace" keep their meaning. Others fold to neutral.
 */
const CAT_COLORS: Record<string, string> = {
  Alimentação: '#3987e5', Transporte: '#d95926', Moradia: '#199e70',
  Saúde: '#c98500', Lazer: '#d55181', Assinaturas: '#9085e9',
}
export const NEUTRAL_MARK = '#5b6675'
export const catColor = (category: string) => CAT_COLORS[category] ?? NEUTRAL_MARK

/** Neutral disc with a grey outline icon; categories are identified by shape, never by hue. */
export function CategoryIcon({ category, size = 36 }: { category: string; size?: number }) {
  const Icon = CATEGORY_ICONS[category] ?? Shapes
  return (
    <span aria-hidden className="grid flex-none place-items-center rounded-full bg-raised text-muted" style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.47)} strokeWidth={1.75} />
    </span>
  )
}

/** The cloche: Buffet's mark. */
export function BrandMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <circle cx="16" cy="7.5" r="2" fill="currentColor" />
      <path d="M5 22a11 11 0 0 1 22 0Z" fill="currentColor" />
      <rect x="2.5" y="24" width="27" height="2.6" rx="1.3" fill="currentColor" />
    </svg>
  )
}

export function ScreenHeader({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </header>
  )
}

export function Section({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mt-8 ${className}`}>
      <div className="mb-3 flex items-baseline justify-between px-1">
        <h2 className="text-[17px] font-bold tracking-[-0.01em]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[20px] border border-dashed border-control px-5 py-6 text-center">
      <p className="text-sm text-muted text-balance">{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral'
export const toneFor = (spent: number, limit: number, elapsed: number): Tone => {
  if (limit <= 0) return 'neutral'
  if (spent > limit) return 'bad'
  if (spent / limit > Math.min(1, elapsed + 0.12)) return 'warn'
  return 'ok'
}
const FILL: Record<Tone, string> = { ok: 'bg-accent', warn: 'bg-warning', bad: 'bg-negative', neutral: 'bg-muted' }

/**
 * Plan track: as long as the limit, the spent part filled, and a 1px "hoje" tick at the fraction of the
 * month already gone — fill past the tick means spending ahead of pace.
 */
export function PlanTrack({ spent, limit, elapsed, tone, height = 8, label }: {
  spent: number; limit: number; elapsed?: number; tone: Tone; height?: number; label: string
}) {
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0
  return (
    <div className="relative" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(spent, limit)}>
      <div className="overflow-hidden rounded-full bg-raised" style={{ height }}>
        {pct > 0 && <div className={`h-full rounded-full ${FILL[tone]} transition-[width] duration-500`} style={{ width: `${pct}%` }} />}
      </div>
      {elapsed !== undefined && limit > 0 && (
        <span aria-hidden className="absolute w-[2px] rounded-full bg-ink/80" style={{ left: `calc(${elapsed * 100}% - 1px)`, top: -3, height: height + 6 }} />
      )}
    </div>
  )
}

/** Bottom sheet on a native <dialog>: focus trap, Esc and backdrop close come from the platform. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      {open && (
        <div className="px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+20px)]">
          <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-control" />
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold tracking-[-0.01em]">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Fechar" className="grid size-10 place-items-center rounded-full text-muted hover:bg-raised">
              <X size={20} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}

/** The eye: masks every money value app-wide; the choice persists on this device. */
export function HideValuesButton({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={hidden} aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'}
      className="grid size-11 flex-none place-items-center rounded-full border border-line text-muted transition-colors hover:bg-raised hover:text-ink">
      {hidden ? <EyeOff size={19} /> : <Eye size={19} />}
    </button>
  )
}
