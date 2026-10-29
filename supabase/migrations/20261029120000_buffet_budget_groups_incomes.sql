-- DRAFT — NOT APPLIED. YNAB-style budget: category groups + monthly income ("Renda do mês").
-- Mirrors web/src/data/types.ts (Budget.group, BuffetData.incomes).

alter table public.buffet_budgets
  add column if not exists group_name text check (group_name in ('essenciais', 'lifestyle', 'metas'));

create table if not exists public.buffet_incomes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month char(7) not null check (month ~ '^\d{4}-\d{2}$'),
  amount numeric(12,2) not null check (amount >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

alter table public.buffet_incomes enable row level security;
drop policy if exists owner_all on public.buffet_incomes;
create policy owner_all on public.buffet_incomes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
