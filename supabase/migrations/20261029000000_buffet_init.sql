-- DRAFT — NOT APPLIED. Buffet tables for the shared fitness Supabase project.
-- Tables live in `public` with `buffet_` prefix (no extra schema grants / exposed schemas needed).
-- Every row is owned by auth.uid(); RLS restricts access to the owner.

create table if not exists public.buffet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  amount numeric(12,2) not null,
  merchant text not null,
  category text not null,
  bank text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists buffet_transactions_user_date_idx on public.buffet_transactions (user_id, date desc);

create table if not exists public.buffet_budgets (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category text not null,
  monthly_limit numeric(12,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

create table if not exists public.buffet_debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  description text not null,
  bank text,
  installment_amount numeric(12,2) not null default 0,
  installments_paid int not null default 0,
  installments_total int not null default 1,
  due_day int check (due_day between 1 and 31),
  created_at timestamptz not null default now()
);

create table if not exists public.buffet_reserves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  target numeric(12,2) not null default 0,
  current numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.buffet_investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  kind text,
  institution text,
  amount numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.buffet_app_config (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  categories text[] not null default array['Alimentação','Transporte','Moradia','Saúde','Lazer','Assinaturas','Educação','Outros'],
  banks jsonb not null default '[{"name":"Nubank","status":"active"},{"name":"Neon","status":"active"},{"name":"Inter","status":"active"},{"name":"XP","status":"planned"}]',
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['buffet_transactions','buffet_budgets','buffet_debts','buffet_reserves','buffet_investments','buffet_app_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
