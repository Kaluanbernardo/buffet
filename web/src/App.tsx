import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { House, ReceiptText, PiggyBank, CalendarClock, Ellipsis, Plus } from 'lucide-react'
import { auth } from './lib/auth'
import { BuffetProvider, useBuffet } from './data/store'
import { ActionsProvider, useActions } from './components/Actions'
import { BrandMark, HideValuesButton, ThemeButton } from './components/ui'
import Login from './screens/Login'
import Hoje from './screens/Hoje'
import Gastos from './screens/Gastos'
import Orcamento from './screens/Orcamento'
import Dividas from './screens/Dividas'
import Mais from './screens/Mais'

const tabs = [
  { to: '/', label: 'Hoje', Icon: House },
  { to: '/gastos', label: 'Gastos', Icon: ReceiptText },
  { to: '/orcamento', label: 'Orçamento', Icon: PiggyBank },
  { to: '/dividas', label: 'Dívidas', Icon: CalendarClock },
  { to: '/mais', label: 'Mais', Icon: Ellipsis },
]

function NotConfigured() {
  return (
    <div className="min-h-dvh grid place-items-center p-6">
      <div className="card max-w-sm p-6">
        <BrandMark size={32} className="text-accent" />
        <h1 className="mt-4 mb-2 text-xl font-bold">Quase lá: falta configurar a senha</h1>
        <p className="text-sm text-muted">Defina <code>VITE_APP_PASSWORD_HASH</code> (SHA-256 hex) no <code>.env.local</code> ou no secret do GitHub e gere o build de novo.</p>
      </div>
    </div>
  )
}

function SyncBanner() {
  const { syncError } = useBuffet()
  if (!syncError) return null
  return (
    <p role="alert" className="fixed inset-x-0 top-0 z-40 bg-negative px-4 pt-[calc(env(safe-area-inset-top)+8px)] pb-2 text-center text-[13px] font-semibold text-white md:left-(--rail)">
      Não sincronizou: {syncError}. A mudança aparece aqui, mas pode não ter sido salva.
    </p>
  )
}

/** Phones: thumb-reach tab bar. Hidden from 768px, where the side rail takes over. */
function BottomNav() {
  return (
    <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ground pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="mx-auto grid max-w-lg grid-cols-5">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end
            className={({ isActive }) => `relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors ${isActive ? 'text-ink' : 'text-faint hover:text-muted'}`}>
            {({ isActive }) => (<>
              <span aria-hidden className={`absolute top-0 h-[2px] w-6 rounded-full bg-accent transition-opacity ${isActive ? 'opacity-100' : 'opacity-0'}`} />
              <Icon size={22} strokeWidth={isActive ? 2.25 : 1.75} />
              {label}
            </>)}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

/**
 * Tablet and up: a fixed side rail. 768–1023 it is a compact column of icon + label (the bottom bar stood
 * on end); from 1024 it opens into a labelled sidebar with the wordmark and "Novo gasto" spelled out.
 * App-wide toggles (tema, ocultar valores) live at its foot, so every screen reaches them.
 */
function SideNav() {
  const { openNew } = useActions()
  const { hidden, toggleHidden } = useBuffet()
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-(--rail) flex-col border-r border-line bg-ground pt-[calc(env(safe-area-inset-top)+20px)] pb-5 md:flex">
      <div className="flex items-center justify-center gap-2.5 lg:justify-start lg:px-6">
        <BrandMark size={26} className="text-accent" />
        <span className="hidden text-[19px] font-extrabold tracking-[-0.03em] lg:inline">Buffet</span>
      </div>

      <div className="mt-7 px-3 lg:px-4">
        <button type="button" onClick={openNew} aria-label="Novo gasto" aria-keyshortcuts="N"
          className="btn mx-auto size-12 p-0 lg:h-11 lg:w-full lg:justify-between lg:px-4">
          <span className="flex items-center gap-2"><Plus size={20} strokeWidth={2.5} /><span className="hidden lg:inline">Novo gasto</span></span>
          <kbd aria-hidden className="hidden h-5 min-w-5 place-items-center rounded-md bg-accent-ink/15 px-1 font-sans text-[11px] font-bold lg:grid">N</kbd>
        </button>
      </div>

      <nav aria-label="Principal" className="mt-6 flex flex-col gap-1 px-3 lg:px-4">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end
            className={({ isActive }) => `flex flex-col items-center gap-1 rounded-2xl py-2.5 text-[11px] font-semibold transition-colors lg:h-11 lg:flex-row lg:gap-3 lg:rounded-full lg:px-3.5 lg:py-0 lg:text-[15px] ${isActive ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'}`}>
            {({ isActive }) => (<>
              <Icon size={21} strokeWidth={isActive ? 2.25 : 1.75} className={isActive ? 'text-accent' : ''} />
              {label}
            </>)}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2 px-3 lg:flex-row lg:px-6">
        <ThemeButton />
        <HideValuesButton hidden={hidden} onToggle={toggleHidden} />
      </div>
    </aside>
  )
}

/** "N" opens Novo gasto from anywhere on a keyboard, unless focus is in a field or a sheet is open. */
function useNewShortcut() {
  const { openNew } = useActions()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable="true"], dialog[open]')) return
      e.preventDefault()
      openNew()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openNew])
}

function Shell({ onLogout }: { onLogout: () => void }) {
  useNewShortcut()
  return (
    <>
      <SyncBanner />
      <SideNav />
      <main className="px-4 pt-[calc(env(safe-area-inset-top)+20px)] pb-[calc(env(safe-area-inset-bottom)+104px)] md:pt-[calc(env(safe-area-inset-top)+36px)] md:pr-8 md:pb-16 md:pl-[calc(var(--rail)+32px)] lg:pr-10 lg:pl-[calc(var(--rail)+40px)]">
        <div className="mx-auto max-w-lg md:max-w-2xl lg:max-w-[68rem]">
          <Routes>
            <Route path="/" element={<Hoje />} />
            <Route path="/gastos" element={<Gastos />} />
            <Route path="/orcamento" element={<Orcamento />} />
            <Route path="/dividas" element={<Dividas />} />
            <Route path="/mais" element={<Mais onLogout={onLogout} />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </div>
      </main>
      <BottomNav />
    </>
  )
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  useEffect(() => { auth.isAuthed().then(setAuthed) }, [])
  if (!auth.configured()) return <NotConfigured />
  if (authed === null) return null
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />
  const logout = async () => { await auth.logout(); setAuthed(false) }
  return (
    <HashRouter>
      <BuffetProvider>
        <ActionsProvider>
          <Shell onLogout={logout} />
        </ActionsProvider>
      </BuffetProvider>
    </HashRouter>
  )
}
