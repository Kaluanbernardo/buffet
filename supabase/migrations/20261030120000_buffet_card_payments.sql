-- Pagamento de fatura não é gasto (research/bill-payment-design.md, opção B): tabela própria, fora de todas as
-- somas de buffet_transactions. card_bank = cartão quitado; paid_from = conta de onde o dinheiro saiu (caixa).
create table if not exists public.buffet_card_payments (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  date date not null,
  amount numeric(12,2) not null check (amount > 0),
  card_bank text not null,
  paid_from text,
  debt_id text references public.buffet_debts (id) on delete set null,
  note text,
  source text not null default 'bot' check (source in ('app', 'bot')),
  created_at timestamptz not null default now()
);
create index if not exists buffet_card_payments_user_date_idx on public.buffet_card_payments (user_id, date desc);

-- Já existem no banco (criadas fora das migrations); registra no repo. No-op em produção.
alter table public.buffet_app_config
  add column if not exists cash_balance numeric(12,2),
  add column if not exists cash_balance_bank text;

-- RLS + grants iguais ao init; o bot também apaga (buffet del-bill).
alter table public.buffet_card_payments enable row level security;
revoke all on public.buffet_card_payments from public, anon, authenticated, bot;
grant select, insert, update, delete on public.buffet_card_payments to authenticated, bot;
drop policy if exists owner_all on public.buffet_card_payments;
create policy owner_all on public.buffet_card_payments for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists bot_all on public.buffet_card_payments;
create policy bot_all on public.buffet_card_payments for all to bot using (true) with check (true);
