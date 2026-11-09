/**
 * Edge Function: recebe as notificações de banco que o MacroDroid envia e cria gastos pendentes de revisão.
 * Passo a passo e decisões: docs/captura-notificacoes.md. A lógica fica em ../_shared (testada no web/tests).
 *
 * Deploy (o MacroDroid não manda JWT do Supabase; quem autentica é o header X-Buffet-Ingest-Secret):
 *   supabase secrets set BUFFET_INGEST_SECRET=<INGEST_SECRET>
 *   supabase functions deploy buffet-ingest-notification --no-verify-jwt
 * SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY o runtime já fornece. A service_role só existe aqui, no servidor.
 */
import { handleIngest } from '../_shared/ingest.ts'
import type { CategoryContext, HistoryRow, LearnedRow, SubRow } from '../_shared/category.ts'

const BASE = Deno.env.get('SUPABASE_URL') ?? ''
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
// Chave nova (sb_secret_…) vai só no apikey; a legada (JWT) também no Authorization.
const auth: Record<string, string> = KEY.startsWith('sb_') ? { apikey: KEY } : { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { ...init, headers: { ...auth, 'content-type': 'application/json', ...init.headers } })
  if (!r.ok) throw new Error(`${path.split('?')[0]}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
  return await r.json() as T
}

/** Lista, ou vazia em vez de erro: sem histórico a categoria cai nas regras, e o gasto entra do mesmo jeito. */
async function list<T>(path: string): Promise<T[]> {
  try { return await rest<T[]>(path) } catch (e) { console.warn(String(e)); return [] }
}

async function loadContext(key: string | null): Promise<CategoryContext> {
  const [cfg, history, subscriptions, confirmed] = await Promise.all([
    list<{ categories: string[] }>('buffet_app_config?select=categories&limit=1'),
    list<HistoryRow>('buffet_transactions?select=merchant,category,date&or=(review_status.is.null,review_status.eq.confirmed)&order=date.desc&limit=1500'),
    list<SubRow>('buffet_subscriptions?select=name,match,category,status&status=eq.active'),
    key ? list<{ id: string }>(`buffet_notification_inbox?select=id&status=eq.confirmed&merchant_key=eq.${encodeURIComponent(key)}&order=received_at.desc&limit=20`)
      : Promise.resolve([]),
  ])
  const learned: LearnedRow[] = confirmed.length && key
    ? (await list<HistoryRow>(`buffet_transactions?select=merchant,category,date&notification_id=in.(${confirmed.map((r) => `"${r.id}"`).join(',')})`))
        .map((r) => ({ ...r, merchantKey: key }))
    : []
  return { categories: cfg[0]?.categories ?? [], history, subscriptions, learned }
}

Deno.serve((req) => handleIngest(req, {
  secret: Deno.env.get('BUFFET_INGEST_SECRET'),
  loadContext,
  ingest: (p) => rest<Record<string, unknown>>('rpc/buffet_notif_ingest', { method: 'POST', body: JSON.stringify({ p }) }),
  log: (m) => console.log(m),
}))
