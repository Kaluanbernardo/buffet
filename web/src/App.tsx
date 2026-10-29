import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { House, ReceiptText, PiggyBank, CalendarClock, Ellipsis } from 'lucide-react'
import { auth } from './lib/auth'
import { BuffetProvider } from './data/store'
import { ActionsProvider } from './components/Actions'
import { BrandMark } from './components/ui'
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
          <main className="mx-auto max-w-lg px-4 pt-[calc(env(safe-area-inset-top)+20px)] pb-[calc(env(safe-area-inset-bottom)+104px)]">
            <Routes>
              <Route path="/" element={<Hoje />} />
              <Route path="/gastos" element={<Gastos />} />
              <Route path="/orcamento" element={<Orcamento />} />
              <Route path="/dividas" element={<Dividas />} />
              <Route path="/mais" element={<Mais onLogout={logout} />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </main>
          <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ground pb-[env(safe-area-inset-bottom)]">
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
        </ActionsProvider>
      </BuffetProvider>
    </HashRouter>
  )
}
