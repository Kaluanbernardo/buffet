-- Sincronização diária com o Meu Pluggy (docs/pluggy-sync.md, scripts/buffet pluggy-sync).
--
-- buffet_pluggy_seen é o livro de tudo o que o sync já decidiu, uma linha por transação do Pluggy, inclusive o que não vira
-- gasto. O id do gasto sozinho não basta: entrada e transferência não têm linha em buffet_transactions, e um gasto apagado ou
-- descartado voltaria no dia seguinte. Quem está aqui não é processado de novo.
--
-- Aditiva: nenhuma coluna ou regra existente muda. O bot ganha insert no inbox para o estorno do Pluggy aparecer em
-- "Estornos recebidos"; ele continua sem poder apagar nada do inbox.

create table if not exists public.buffet_pluggy_seen (
  id text primary key,                                     -- id da transação no Pluggy
  user_id uuid not null default public.buffet_owner(),
  outcome text not null check (outcome in
    ('expense', 'possible_duplicate', 'card_payment', 'income', 'skipped', 'refund_paired', 'refund_review', 'known', 'baseline')),
  reason text,                                             -- por que foi ignorada
  bank text,
  amount numeric(12,2),
  date date,
  paired_with text,                                        -- estorno: a compra casada (uma compra só casa com um estorno)
  first_seen_at timestamptz not null default now()
);
create index if not exists buffet_pluggy_seen_user_idx on public.buffet_pluggy_seen (user_id, first_seen_at desc);

alter table public.buffet_pluggy_seen enable row level security;
revoke all on public.buffet_pluggy_seen from public, anon, authenticated, bot;
grant select on public.buffet_pluggy_seen to authenticated;
grant select, insert on public.buffet_pluggy_seen to bot;
drop policy if exists owner_all on public.buffet_pluggy_seen;
create policy owner_all on public.buffet_pluggy_seen for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists bot_all on public.buffet_pluggy_seen;
create policy bot_all on public.buffet_pluggy_seen for all to bot using (true) with check (true);

grant insert on public.buffet_notification_inbox to bot;

notify pgrst, 'reload schema';
