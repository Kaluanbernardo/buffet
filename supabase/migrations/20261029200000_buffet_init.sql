-- Buffet tables in the shared fitness Supabase project (public.buffet_*), same security model as fitness:
-- dono único via public.is_owner() (app_config.owner_uuid), role `bot` para o CLI (scripts/buffet), anon sem acesso.
-- Substitui os rascunhos nunca aplicados (init + budget_groups_incomes).
-- Aplicar: scripts/apply_migrations_https.py (registra em public._buffet_migrations).

-- user_id: o app (authenticated) grava auth.uid(); o bot (sem JWT) cai no owner_uuid.
-- Sem FK para auth.users: o bot não enxerga o schema auth.
create or replace function public.buffet_owner()
returns uuid
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(auth.uid(), (select c.owner_uuid from public.app_config c limit 1))
$$;
revoke execute on function public.buffet_owner() from public, anon;
grant execute on function public.buffet_owner() to authenticated, bot;

-- ids em text (default uuid): aceita ids já gerados no aparelho e os do data/expenses.jsonl (import idempotente).
create table if not exists public.buffet_transactions (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  date date not null,
  amount numeric(12,2) not null,
  merchant text not null,
  category text not null,
  bank text,
  note text,
  source text not null default 'bot' check (source in ('app', 'bot')),
  created_at timestamptz not null default now()
);
create index if not exists buffet_transactions_user_date_idx on public.buffet_transactions (user_id, date desc);

create table if not exists public.buffet_budgets (
  user_id uuid not null default public.buffet_owner(),
  category text not null,
  monthly_limit numeric(12,2) not null default 0,
  group_name text check (group_name in ('essenciais', 'lifestyle', 'metas')),
  source text not null default 'bot' check (source in ('app', 'bot')),
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

create table if not exists public.buffet_debts (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  description text not null,
  bank text,
  installment_amount numeric(12,2) not null default 0,
  installments_paid int not null default 0,
  installments_total int not null default 1,
  due_day int check (due_day between 1 and 31),
  source text not null default 'bot' check (source in ('app', 'bot')),
  created_at timestamptz not null default now()
);

create table if not exists public.buffet_reserves (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  name text not null,
  target numeric(12,2) not null default 0,
  current numeric(12,2) not null default 0,
  source text not null default 'bot' check (source in ('app', 'bot')),
  updated_at timestamptz not null default now()
);

create table if not exists public.buffet_investments (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  name text not null,
  kind text,
  institution text,
  amount numeric(14,2) not null default 0,
  source text not null default 'bot' check (source in ('app', 'bot')),
  updated_at timestamptz not null default now()
);

-- "Renda do mês" (YNAB-style).
create table if not exists public.buffet_incomes (
  user_id uuid not null default public.buffet_owner(),
  month char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  amount numeric(12,2) not null check (amount >= 0),
  source text not null default 'bot' check (source in ('app', 'bot')),
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

create table if not exists public.buffet_app_config (
  user_id uuid primary key default public.buffet_owner(),
  categories text[] not null default array['Alimentação','Transporte','Moradia','Saúde','Lazer','Assinaturas','Educação','Outros'],
  banks jsonb not null default '[{"name":"Nubank","status":"active"},{"name":"Neon","status":"active"},{"name":"Inter","status":"active"},{"name":"XP","status":"planned"}]',
  source text not null default 'bot' check (source in ('app', 'bot')),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS + grants (igual fitness/20261027120200_security.sql)
do $$
declare
  t text;
  app_tables text[] := array[
    'buffet_transactions', 'buffet_budgets', 'buffet_debts', 'buffet_reserves',
    'buffet_investments', 'buffet_incomes', 'buffet_app_config'
  ];
  -- o app sincroniza remoções de todas as coleções; o bot só apaga lançamentos
  app_deletable text[] := array['buffet_transactions', 'buffet_budgets', 'buffet_debts', 'buffet_reserves', 'buffet_investments', 'buffet_incomes'];
begin
  foreach t in array app_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, bot', t);
    execute format('grant select, insert, update on public.%I to authenticated, bot', t);
    if t = any (app_deletable) then
      execute format('grant delete on public.%I to authenticated', t);
    end if;
    if t = 'buffet_transactions' then
      execute format('grant delete on public.%I to bot', t);
    end if;

    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated
                    using ((select public.is_owner())) with check ((select public.is_owner()))', t);
    execute format('drop policy if exists bot_all on public.%I', t);
    execute format('create policy bot_all on public.%I for all to bot using (true) with check (true)', t);
  end loop;
end $$;
