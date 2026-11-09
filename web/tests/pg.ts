/**
 * Postgres de verdade (PGlite, em memória) com o mínimo do Supabase que as migrations usam: roles anon/authenticated/bot/
 * service_role, auth.uid() lido de request.jwt.claim.sub, public.app_config (owner_uuid) e public.is_owner() — como no
 * projeto do fitness. Aplica supabase/migrations/*.sql em ordem. Só dados sintéticos.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

export const OWNER = '11111111-1111-4111-8111-111111111111'
export const OTHER = '22222222-2222-4222-8222-222222222222'
const MIGRATIONS = resolve(__dirname, '../../supabase/migrations')

const SUPABASE_STUB = `
create role anon nologin; create role authenticated nologin; create role bot nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, bot, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, bot, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.app_config (owner_uuid uuid not null);
insert into public.app_config values ('${OWNER}');
create function public.is_owner() returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and auth.uid() = (select c.owner_uuid from public.app_config c limit 1) $$;
grant execute on function public.is_owner() to authenticated;
`

export type Role = 'postgres' | 'anon' | 'authenticated' | 'bot' | 'service_role'

/** Aplica as migrations (em ordem) que passam no filtro. */
export async function applyMigrations(db: PGlite, keep: (file: string) => boolean = () => true) {
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql') && keep(x)).sort()) await db.exec(readFileSync(resolve(MIGRATIONS, f), 'utf8'))
}

/** PGlite com o stub do Supabase. Datas e timestamps como texto, como a Management API e o PostgREST devolvem. */
export async function stubDb() {
  const asText = (v: string) => v
  const db = new PGlite({ parsers: { 1082: asText, 1114: asText, 1184: asText } })
  await db.exec(SUPABASE_STUB)
  return db
}

export async function freshDb() {
  const db = await stubDb()
  await applyMigrations(db)
  /** Uma transação como `role` (e, para authenticated, com o JWT de `sub`), como o PostgREST/CLI fazem. */
  const as = async <T = Record<string, unknown>>(role: Role, sql: string, params: unknown[] = [], sub = OWNER): Promise<T[]> =>
    db.transaction(async (tx) => {
      if (role !== 'postgres') await tx.exec(`set local role ${role}`)
      if (role === 'authenticated') await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub])
      return (await tx.query<T>(sql, params)).rows
    })
  const one = async <T = Record<string, unknown>>(role: Role, sql: string, params: unknown[] = [], sub?: string) => (await as<T>(role, sql, params, sub))[0]
  /** Zera os dados (as migrations ficam): um banco por arquivo de teste, limpo entre os testes. */
  const reset = () => db.exec(`truncate public.buffet_transactions, public.buffet_notification_inbox, public.buffet_debts,
    public.buffet_card_payments, public.buffet_subscriptions, public.buffet_app_config cascade`)
  return { db, as, one, reset }
}
export type Db = Awaited<ReturnType<typeof freshDb>>
