import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Home, Receipt, PiggyBank, CreditCard, MoreHorizontal } from 'lucide-react'
import { auth } from './lib/auth'
import { BuffetProvider } from './data/store'
import Login from './screens/Login'
import Hoje from './screens/Hoje'
import Gastos from './screens/Gastos'
import Orcamento from './screens/Orcamento'
import Dividas from './screens/Dividas'
import Mais from './screens/Mais'

const tabs = [
  { to: '/', label: 'Hoje', Icon: Home },
  { to: '/gastos', label: 'Gastos', Icon: Receipt },
  { to: '/orcamento', label: 'Orçamento', Icon: PiggyBank },
  { to: '/dividas', label: 'Dívidas', Icon: CreditCard },
  { to: '/mais', label: 'Mais', Icon: MoreHorizontal },
]

function NotConfigured() {
  return (
    <div className="min-h-screen grid place-items-center p-6 text-center">
      <div className="card max-w-sm">
        <h1 className="text-xl font-semibold mb-2">Quase lá — falta configurar a senha</h1>
        <p className="text-sm text-gray-400">Defina <code>VITE_APP_PASSWORD_HASH</code> (SHA-256 hex) no <code>.env.local</code> ou no secret do GitHub e gere o build de novo.</p>
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
        <main className="mx-auto max-w-lg px-4 pt-6 pb-28">
          <Routes>
            <Route path="/" element={<Hoje />} />
            <Route path="/gastos" element={<Gastos />} />
            <Route path="/orcamento" element={<Orcamento />} />
            <Route path="/dividas" element={<Dividas />} />
            <Route path="/mais" element={<Mais onLogout={logout} />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
        <nav className="fixed bottom-0 inset-x-0 bg-[#0E1116]/95 backdrop-blur border-t border-[#222A35] pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto max-w-lg grid grid-cols-5">
            {tabs.map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} end className={({ isActive }) => `flex flex-col items-center gap-1 py-3 text-xs ${isActive ? 'text-emerald-400' : 'text-gray-400'}`}>
                <Icon size={20} />{label}
              </NavLink>
            ))}
          </div>
        </nav>
      </BuffetProvider>
    </HashRouter>
  )
}
