-- Assinaturas (research/subscriptions-proposal.md, opção A). A assinatura é um compromisso, nunca soma em gasto:
-- a cobrança real continua em buffet_transactions, ligada por buffet_transactions.subscription_id.
-- Aditiva: o PWA antigo ignora a coluna nova e o upsert dele não a apaga (só manda as colunas que conhece).
create table if not exists public.buffet_subscriptions (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  name text not null,                                           -- "Netflix"
  amount numeric(12,2) not null check (amount > 0),             -- valor esperado por ciclo
  cycle text not null default 'monthly' check (cycle in ('monthly', 'yearly')),
  next_due date not null,                                       -- próxima cobrança esperada
  bank text,                                                    -- cartão/conta onde cai ("Nubank")
  category text not null default 'Assinaturas',                 -- categoria do gasto gerado
  status text not null default 'active' check (status in ('active', 'paused', 'canceled')),
  remind_days int not null default 2 check (remind_days between 0 and 30),
  match text,                                                   -- trecho do merchant p/ vincular sozinho ("meli")
  cancel_hint text,                                             -- "app › Conta › Cancelar" ou URL
  note text,
  started_on date,                                              -- 1ª cobrança; o dia dela ancora o ciclo (31 → 28/fev → 31/mar)
  canceled_on date,
  source text not null default 'bot' check (source in ('app', 'bot')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists buffet_subscriptions_user_due_idx on public.buffet_subscriptions (user_id, status, next_due);

alter table public.buffet_transactions
  add column if not exists subscription_id text references public.buffet_subscriptions (id) on delete set null;
create index if not exists buffet_transactions_subscription_idx on public.buffet_transactions (subscription_id)
  where subscription_id is not null;

-- Próxima cobrança depois de p_next_due, um ciclo à frente, no dia p_anchor (limitado ao fim do mês).
-- Com p_charged_on: uma cobrança bem anterior ao ciclo atual (> 15 dias, ou 60 nas anuais) é histórico e não avança.
-- Espelhada em web/src/data/derive.ts (subAdvance); o CLI chama esta.
create or replace function public.buffet_sub_advance(p_next_due date, p_cycle text, p_anchor int default null, p_charged_on date default null)
returns date
language sql immutable
set search_path = ''
as $$
  select case
    when p_charged_on is not null and p_charged_on < p_next_due - case p_cycle when 'yearly' then 60 else 15 end then p_next_due
    else least(
      (date_trunc('month', p_next_due::timestamp) + case p_cycle when 'yearly' then interval '1 year' else interval '1 month' end)::date
        + (coalesce(p_anchor, extract(day from p_next_due)::int) - 1),
      (date_trunc('month', p_next_due::timestamp) + case p_cycle when 'yearly' then interval '13 months' else interval '2 months' end
        - interval '1 day')::date)
  end
$$;

-- Avança até a primeira data >= p_ref (retomar uma assinatura pausada há meses).
create or replace function public.buffet_sub_roll(p_next_due date, p_cycle text, p_anchor int, p_ref date)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  d date := p_next_due;
begin
  while d < p_ref loop
    d := public.buffet_sub_advance(d, p_cycle, p_anchor);
  end loop;
  return d;
end
$$;

revoke execute on function public.buffet_sub_advance(date, text, int, date) from public, anon;
revoke execute on function public.buffet_sub_roll(date, text, int, date) from public, anon;
grant execute on function public.buffet_sub_advance(date, text, int, date) to authenticated, bot;
grant execute on function public.buffet_sub_roll(date, text, int, date) to authenticated, bot;

-- RLS + grants iguais ao init. O app apaga (Excluir); o bot não: cancela por status (buffet sub cancel).
alter table public.buffet_subscriptions enable row level security;
revoke all on public.buffet_subscriptions from public, anon, authenticated, bot;
grant select, insert, update on public.buffet_subscriptions to authenticated, bot;
grant delete on public.buffet_subscriptions to authenticated;
drop policy if exists owner_all on public.buffet_subscriptions;
create policy owner_all on public.buffet_subscriptions for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists bot_all on public.buffet_subscriptions;
create policy bot_all on public.buffet_subscriptions for all to bot using (true) with check (true);
