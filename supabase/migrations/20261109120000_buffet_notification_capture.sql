-- Captura de gastos pelas notificações do Android (docs/captura-notificacoes.md).
-- MacroDroid → Edge Function buffet-ingest-notification (segredo em header) → public.buffet_notif_ingest (service_role).
--
-- Toda notificação recebida vira uma linha em buffet_notification_inbox: o payload bruto e o que o parser entendeu.
-- Compra (crédito/débito) e PIX enviado viram um gasto em buffet_transactions com review_status = 'pending', que já entra
-- em todas as somas (com marcador no app) e é revisado no PWA ou no CLI (buffet pending | review | confirm | discard).
-- PIX recebido, propaganda, fatura e recusa ficam só no inbox (status 'ignored'). Estorno fica no inbox como 'refund' e
-- não cria nada sozinho: o usuário decide no que ele mexe.
--
-- Caixa: débito/PIX pendente já desconta o cash_balance (o dinheiro saiu) quando o banco é a conta do saldo, e guarda quanto
-- descontou em cash_debited; descartar devolve exatamente isso. Crédito entra na fatura pelo ciclo do cartão (bill_month) e
-- não mexe no caixa; descartar apaga a linha e ela sai da fatura junto.
--
-- Dedup: (1) o mesmo payload (sha256 de app|título|texto|timestamp) só entra uma vez; (2) mesma compra (banco, tipo, valor,
-- estabelecimento) em até 2 minutos é a mesma notificação repostada; (3) um gasto lançado à mão (chat/app) com o mesmo valor a
-- até 1 dia de um pendente marca o pendente como possível duplicata (possible_duplicate_of), e vice-versa. Nada é apagado
-- sozinho: o usuário confirma ou descarta.
--
-- Aditiva: o PWA antigo ignora as colunas novas e o upsert dele não as apaga (só manda as colunas que conhece).

create table if not exists public.buffet_notification_inbox (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  received_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count int not null default 1,                       -- quantas vezes o mesmo payload chegou
  payload jsonb not null,                                  -- como chegou (o segredo vem em header e nunca é gravado)
  payload_hash text not null,
  app text,
  title text,
  body text,
  posted_at timestamptz not null,                          -- hora da notificação; sem timestamp no payload, a da chegada
  bank text check (bank in ('nubank', 'inter', 'neon', 'desconhecido')),
  kind text not null check (kind in ('purchase', 'pix_out', 'pix_in', 'refund', 'declined', 'bill', 'promo', 'unknown')),
  method text check (method in ('debit', 'pix', 'credit')),
  amount numeric(12,2) check (amount > 0),
  merchant text,                                           -- como o banco escreveu
  merchant_key text,                                       -- sem acento/caixa/pontuação: liga a categoria aprendida
  card_last4 text,
  installments int check (installments >= 1),
  dedup_key text,                                          -- banco|tipo|centavos|merchant_key
  status text not null default 'new' check (status in
    ('new', 'created', 'confirmed', 'discarded', 'duplicate', 'ignored', 'refund', 'dismissed')),
  reason text,                                             -- por que foi ignorada / o que o parser deduziu
  duplicate_of text references public.buffet_notification_inbox (id) on delete set null,
  parser_version int,
  unique (user_id, payload_hash)
);
create index if not exists buffet_notification_inbox_dedup_idx on public.buffet_notification_inbox (user_id, dedup_key, posted_at)
  where dedup_key is not null;
create index if not exists buffet_notification_inbox_status_idx on public.buffet_notification_inbox (user_id, status, received_at desc);
create index if not exists buffet_notification_inbox_learned_idx on public.buffet_notification_inbox (user_id, merchant_key)
  where status = 'confirmed';

alter table public.buffet_transactions
  add column if not exists review_status text check (review_status in ('pending', 'confirmed')),   -- null = não veio de notificação
  add column if not exists notification_id text references public.buffet_notification_inbox (id) on delete set null,
  add column if not exists cash_debited numeric(12,2) check (cash_debited >= 0),                     -- quanto a entrada tirou do caixa
  add column if not exists possible_duplicate_of text references public.buffet_transactions (id) on delete set null;
create unique index if not exists buffet_transactions_notification_uq on public.buffet_transactions (notification_id)
  where notification_id is not null;
create index if not exists buffet_transactions_pending_idx on public.buffet_transactions (user_id, date)
  where review_status = 'pending';

-- Quem gravou: 'notificacao' = a Edge Function. A origem durável é notification_id (o app reescreve source ao editar).
-- O check do init não tem nome explícito: tira qualquer check sobre source, seja qual for o nome, antes de pôr o novo.
do $$
declare
  c text;
begin
  for c in select x.conname from pg_constraint x
            where x.conrelid = 'public.buffet_transactions'::regclass and x.contype = 'c'
              and pg_get_constraintdef(x.oid) ~ '\msource\M'
  loop
    execute format('alter table public.buffet_transactions drop constraint %I', c);
  end loop;
end $$;
alter table public.buffet_transactions
  add constraint buffet_transactions_source_check check (source in ('app', 'bot', 'notificacao'));

-- ---------------------------------------------------------------- travas
-- Pendente só sai por buffet_tx_discard, que devolve o caixa e marca o inbox. Vale para o CLI (buffet del), o app e versões antigas.
create or replace function public.buffet_tx_block_pending_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.review_status = 'pending' then
    raise exception 'gasto pendente de revisão: descarte (buffet discard) para devolver o caixa, ou confirme antes de apagar'
      using errcode = 'P0001';
  end if;
  return old;
end
$$;
revoke execute on function public.buffet_tx_block_pending_delete() from public, anon, authenticated;
drop trigger if exists buffet_tx_block_pending_delete on public.buffet_transactions;
create trigger buffet_tx_block_pending_delete before delete on public.buffet_transactions
  for each row execute function public.buffet_tx_block_pending_delete();

-- Gasto lançado à mão (chat ou app) com o mesmo valor a até 1 dia de um pendente ainda sem par: marca o pendente.
-- Parcelado: a parcela 1 compara o valor da compra (a notificação mostra o total). Um pendente aponta para um gasto só.
create or replace function public.buffet_tx_flag_pending_duplicate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_amount numeric := new.amount;
begin
  if new.notification_id is not null or new.review_status is not null then return null; end if;
  if new.debt_id is not null then
    if new.installment_no is distinct from 1 then return null; end if;
    select coalesce(d.total_amount, new.amount) into v_amount from public.buffet_debts d where d.id = new.debt_id;
  end if;
  update public.buffet_transactions p set possible_duplicate_of = new.id
   where p.id = (select x.id from public.buffet_transactions x
                  where x.user_id = new.user_id and x.review_status = 'pending' and x.possible_duplicate_of is null
                    and x.id <> new.id and x.amount = v_amount and abs(x.date - new.date) <= 1
                  order by abs(x.date - new.date), x.created_at
                  limit 1);
  return null;
end
$$;
revoke execute on function public.buffet_tx_flag_pending_duplicate() from public, anon, authenticated;
drop trigger if exists buffet_tx_flag_pending_duplicate on public.buffet_transactions;
create trigger buffet_tx_flag_pending_duplicate after insert on public.buffet_transactions
  for each row execute function public.buffet_tx_flag_pending_duplicate();

-- ---------------------------------------------------------------- entrada (só a Edge Function, com a service_role)
-- p: payload (jsonb bruto), payload_hash, app, title, body, posted_at, bank, kind, method, amount_cents, merchant,
--    merchant_key, card_last4, installments, dedup_key, parser_version, reason, display_merchant, category, note.
-- O parser e a categoria sugerida ficam na Edge Function (supabase/functions/_shared, com testes); aqui fica o que precisa
-- ser atômico: dedup, gasto, caixa e marca de duplicata, numa transação só.
create or replace function public.buffet_notif_ingest(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  n public.buffet_notification_inbox;
  t public.buffet_transactions;
  c public.buffet_app_config;
  v_amount numeric := round((p->>'amount_cents')::numeric / 100, 2);
  v_bank text := case p->>'bank' when 'nubank' then 'Nubank' when 'inter' then 'Inter' when 'neon' then 'Neon' end;
  v_dup text;
  v_match text;
  v_date date;
  v_bill text;
  v_cy jsonb;
  v_cash numeric := 0;
  v_note text;
begin
  if p->>'payload_hash' is null or p->'payload' is null or p->>'kind' is null then
    raise exception 'payload, payload_hash e kind são obrigatórios' using errcode = 'P0001';
  end if;
  -- Serializa notificações iguais que chegam juntas (o MacroDroid às vezes dispara duas no mesmo segundo).
  perform pg_advisory_xact_lock(hashtextextended('buffet_notif:' || coalesce(p->>'dedup_key', p->>'payload_hash'), 0));

  insert into public.buffet_notification_inbox (payload, payload_hash, app, title, body, posted_at, bank, kind, method, amount,
                                                merchant, merchant_key, card_last4, installments, dedup_key, parser_version, reason)
  values (p->'payload', p->>'payload_hash', p->>'app', p->>'title', p->>'body', coalesce((p->>'posted_at')::timestamptz, now()),
          p->>'bank', p->>'kind', p->>'method', v_amount, p->>'merchant', p->>'merchant_key', p->>'card_last4',
          (p->>'installments')::int, p->>'dedup_key', (p->>'parser_version')::int, p->>'reason')
  on conflict (user_id, payload_hash) do nothing
  returning * into n;

  -- (1) O mesmo payload de novo (retry do MacroDroid, notificação reenviada): só conta.
  if not found then
    update public.buffet_notification_inbox x set seen_count = x.seen_count + 1, last_seen_at = now()
     where x.user_id = public.buffet_owner() and x.payload_hash = p->>'payload_hash'
    returning * into n;
    return jsonb_build_object('status', 'duplicate', 'reason', 'mesma notificação já recebida', 'inbox_id', n.id,
      'first_status', n.status, 'transaction_id', (select x.id from public.buffet_transactions x where x.notification_id = n.id));
  end if;

  -- (2) Mesma compra em até 2 minutos com outro payload (notificação atualizada/repostada com outro timestamp).
  if n.dedup_key is not null then
    select x.id into v_dup from public.buffet_notification_inbox x
     where x.user_id = n.user_id and x.id <> n.id and x.dedup_key = n.dedup_key and x.status <> 'duplicate'
       and abs(extract(epoch from (x.posted_at - n.posted_at))) <= 120
     order by abs(extract(epoch from (x.posted_at - n.posted_at)))
     limit 1;
    if v_dup is not null then
      update public.buffet_notification_inbox x set status = 'duplicate', duplicate_of = v_dup,
             reason = 'mesma compra (banco, valor e estabelecimento) em até 2 minutos'
       where x.id = n.id returning * into n;
      return jsonb_build_object('status', 'duplicate', 'reason', n.reason, 'inbox_id', n.id, 'duplicate_of', v_dup,
        'transaction_id', (select x.id from public.buffet_transactions x where x.notification_id = v_dup));
    end if;
  end if;

  -- Só compra e PIX enviado, de banco conhecido e com valor, viram gasto. Estorno fica para o usuário decidir.
  if n.kind not in ('purchase', 'pix_out') or v_amount is null or v_bank is null then
    update public.buffet_notification_inbox x
       set status = case when n.kind = 'refund' and v_amount is not null then 'refund' else 'ignored' end,
           reason = case
             when n.kind in ('purchase', 'pix_out') and v_amount is null then 'sem valor no texto'
             when n.kind in ('purchase', 'pix_out') then 'app/banco desconhecido'
             else coalesce(n.reason, n.kind) end
     where x.id = n.id returning * into n;
    return jsonb_build_object('status', n.status, 'reason', n.reason, 'inbox_id', n.id);
  end if;

  v_date := (n.posted_at at time zone 'America/Sao_Paulo')::date;
  select * into c from public.buffet_app_config x where x.user_id = n.user_id for update;
  if n.method = 'credit' then
    -- Fatura pelo ciclo do cartão (buffet_app_config.banks[].credit); sem ciclo, fica de fora de fatura e avisa na nota.
    select b->'credit' into v_cy from jsonb_array_elements(coalesce(c.banks, '[]'::jsonb)) b
     where lower(b->>'name') = lower(v_bank) limit 1;
    if (v_cy->>'closing_day') is not null and (v_cy->>'due_day') is not null then
      v_bill := public.buffet_bill_month((v_cy->>'closing_day')::int, (v_cy->>'due_day')::int, v_date);
    end if;
  elsif c.cash_balance is not null and lower(v_bank) = lower(c.cash_balance_bank) then
    -- Débito/PIX da conta do saldo: o dinheiro já saiu, então o pendente já desconta (descartar devolve).
    update public.buffet_app_config x set cash_balance = x.cash_balance - v_amount, updated_at = now() where x.user_id = n.user_id;
    v_cash := v_amount;
  end if;

  -- (3) Já lançado à mão? Mesmo valor a até 1 dia, ainda sem pendente apontando para ele.
  select x.id into v_match from public.buffet_transactions x
   where x.user_id = n.user_id and x.notification_id is null and x.review_status is null
     and abs(x.date - v_date) <= 1
     and (x.amount = v_amount or (x.installment_no = 1 and exists (
           select 1 from public.buffet_debts d where d.id = x.debt_id and d.total_amount = v_amount)))
     and not exists (select 1 from public.buffet_transactions y where y.possible_duplicate_of = x.id)
   order by abs(x.date - v_date), x.created_at desc
   limit 1;

  v_note := nullif(concat_ws(' · ',
    nullif(p->>'note', ''),
    case when n.installments > 1 then format('parcelado em %sx na notificação: para virar plano, descarte e lance com --x %s',
                                             n.installments, n.installments) end,
    case when n.method = 'credit' and v_bill is null then format('%s sem ciclo de cartão: não entrou em fatura', v_bank) end), '');

  insert into public.buffet_transactions (date, amount, merchant, category, bank, method, bill_month, note, source,
                                          review_status, notification_id, cash_debited, possible_duplicate_of)
  values (v_date, v_amount, coalesce(nullif(trim(p->>'display_merchant'), ''), nullif(trim(n.merchant), ''), 'Sem descrição'),
          coalesce(nullif(trim(p->>'category'), ''), 'Outros'), v_bank, n.method, v_bill, v_note, 'notificacao',
          'pending', n.id, v_cash, v_match)
  returning * into t;
  update public.buffet_notification_inbox x set status = 'created' where x.id = n.id;

  return jsonb_build_object('status', 'created', 'inbox_id', n.id, 'transaction_id', t.id, 'date', t.date, 'amount', t.amount,
    'merchant', t.merchant, 'category', t.category, 'method', t.method, 'bank', t.bank, 'bill_month', t.bill_month,
    'cash_delta', -v_cash, 'possible_duplicate_of', v_match);
end
$$;

-- ---------------------------------------------------------------- revisão (CLI e app usam as mesmas)
-- Security invoker, como buffet_tx_*: valem RLS e grants; travam a linha do gasto antes da linha do saldo.

-- Edita e/ou confirma um gasto que veio de notificação. p_patch: só as chaves presentes mudam.
--   merchant, category, note (null limpa), amount, date, method (debit|pix|credit), bank
--   share (número = dividir com a SUA parte em %, null = desfazer a divisão), reimburse (número, ou null = tudo o que falta),
--   reimburse_cash (padrão true)
-- Mudou valor, meio, banco ou data: refaz o efeito no caixa (devolve cash_debited, desconta de novo se for débito/PIX da conta
-- do saldo) e a fatura (bill_month pelo ciclo do cartão). p_confirm = false edita sem confirmar.
create or replace function public.buffet_tx_review(p_id text, p_patch jsonb default '{}', p_confirm boolean default true)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  t public.buffet_transactions;
  c public.buffet_app_config;
  p jsonb := coalesce(p_patch, '{}'::jsonb);
  v_key text;
  v_amount numeric;
  v_method text;
  v_bank text;
  v_date date;
  v_bill text;
  v_cy jsonb;
  v_cash numeric := 0;
  v_delta numeric := 0;
  r jsonb;
begin
  select * into t from public.buffet_transactions x where x.id = p_id for update;
  if not found then raise exception 'gasto não encontrado' using errcode = 'P0002'; end if;
  if t.review_status is null then raise exception 'esse gasto não veio de notificação' using errcode = 'P0001'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'p_patch precisa ser um objeto' using errcode = 'P0001'; end if;
  select k into v_key from jsonb_object_keys(p) k
   where k not in ('merchant', 'category', 'note', 'amount', 'date', 'method', 'bank', 'share', 'reimburse', 'reimburse_cash') limit 1;
  if v_key is not null then raise exception 'campo desconhecido: %', v_key using errcode = 'P0001'; end if;
  if p ? 'merchant' and nullif(trim(p->>'merchant'), '') is null then raise exception 'estabelecimento vazio' using errcode = 'P0001'; end if;
  if p ? 'category' and nullif(trim(p->>'category'), '') is null then raise exception 'categoria vazia' using errcode = 'P0001'; end if;

  v_amount := coalesce((p->>'amount')::numeric, t.amount);
  if v_amount <= 0 or v_amount <> round(v_amount, 2) then raise exception 'valor inválido: %', v_amount using errcode = 'P0001'; end if;
  v_method := case when p ? 'method' then p->>'method' else t.method end;
  if v_method is null or v_method not in ('debit', 'pix', 'credit') then
    raise exception 'meio inválido: % (debit, pix ou credit)', v_method using errcode = 'P0001';
  end if;
  v_bank := case when p ? 'bank' then nullif(trim(p->>'bank'), '') else t.bank end;
  v_date := coalesce((p->>'date')::date, t.date);

  if v_amount <> t.amount or v_method is distinct from t.method or v_bank is distinct from t.bank or v_date <> t.date then
    if t.debt_id is not null then raise exception 'parcela de plano não pode ser revisada aqui' using errcode = 'P0001'; end if;
    select * into c from public.buffet_app_config x where x.user_id = t.user_id for update;
    if v_method in ('debit', 'pix') and c.cash_balance is not null and lower(v_bank) = lower(c.cash_balance_bank) then
      v_cash := v_amount;
    end if;
    if c.cash_balance is not null then
      v_delta := coalesce(t.cash_debited, 0) - v_cash;     -- > 0 volta ao caixa
      if v_delta <> 0 then
        update public.buffet_app_config x set cash_balance = x.cash_balance + v_delta, updated_at = now() where x.user_id = t.user_id;
      end if;
    else
      v_cash := 0;                                          -- sem saldo informado não há o que devolver nem descontar
    end if;
    if v_method = 'credit' then
      select b->'credit' into v_cy from jsonb_array_elements(coalesce(c.banks, '[]'::jsonb)) b
       where lower(b->>'name') = lower(v_bank) limit 1;
      if (v_cy->>'closing_day') is not null and (v_cy->>'due_day') is not null then
        v_bill := public.buffet_bill_month((v_cy->>'closing_day')::int, (v_cy->>'due_day')::int, v_date);
      end if;
    end if;
    update public.buffet_transactions x
       set amount = v_amount, method = v_method, bank = v_bank, date = v_date, bill_month = v_bill, cash_debited = v_cash
     where x.id = p_id;
  end if;

  update public.buffet_transactions x
     set merchant = case when p ? 'merchant' then trim(p->>'merchant') else x.merchant end,
         category = case when p ? 'category' then trim(p->>'category') else x.category end,
         note = case when p ? 'note' then nullif(trim(p->>'note'), '') else x.note end
   where x.id = p_id;

  -- Divisão e reembolso: as mesmas funções do CLI e do app, na mesma transação.
  if p ? 'share' then
    if jsonb_typeof(p->'share') = 'null' then
      if t.split_share_pct is not null then perform public.buffet_tx_unsplit(p_id); end if;
    else
      perform public.buffet_tx_split(p_id, (p->>'share')::numeric);
    end if;
  end if;
  if p ? 'reimburse' then
    r := public.buffet_tx_reimburse(p_id, (p->>'reimburse')::numeric, null, coalesce((p->>'reimburse_cash')::boolean, true));
    v_delta := v_delta + coalesce((r->>'cash_delta')::numeric, 0);
  end if;

  if p_confirm then
    -- Confirmar é dizer "é um gasto de verdade": a marca de possível duplicata sai junto.
    update public.buffet_transactions x set review_status = 'confirmed', possible_duplicate_of = null where x.id = p_id;
    update public.buffet_notification_inbox n set status = 'confirmed' where n.id = t.notification_id;
  end if;
  select * into t from public.buffet_transactions x where x.id = p_id;
  return public.buffet_tx_result(t, v_delta) || jsonb_build_object('category', t.category, 'method', t.method, 'bank', t.bank,
    'bill_month', t.bill_month, 'review_status', t.review_status, 'cash_debited', t.cash_debited,
    'possible_duplicate_of', t.possible_duplicate_of);
end
$$;

-- Descarta um pendente: devolve ao caixa o que ele descontou, apaga a linha (e com ela o item da fatura) e marca o inbox.
create or replace function public.buffet_tx_discard(p_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  t public.buffet_transactions;
  v_cash numeric := 0;
begin
  select * into t from public.buffet_transactions x where x.id = p_id for update;
  if not found then raise exception 'gasto não encontrado' using errcode = 'P0002'; end if;
  if t.review_status is distinct from 'pending' then
    raise exception 'só dá para descartar gasto pendente de revisão (confirmado: use buffet del)' using errcode = 'P0001';
  end if;
  if t.reimbursed_amount is not null then
    raise exception 'esse gasto tem reembolso registrado: desfaça o reembolso antes' using errcode = 'P0001';
  end if;
  if coalesce(t.cash_debited, 0) > 0 then
    update public.buffet_app_config c set cash_balance = c.cash_balance + t.cash_debited, updated_at = now()
     where c.user_id = t.user_id and c.cash_balance is not null;
    if found then v_cash := t.cash_debited; end if;
  end if;
  -- Sai de 'pending' para a trava de exclusão deixar passar; a linha é apagada em seguida, na mesma transação.
  update public.buffet_transactions x set review_status = null, cash_debited = 0 where x.id = p_id;
  delete from public.buffet_transactions x where x.id = p_id;
  update public.buffet_notification_inbox n set status = 'discarded' where n.id = t.notification_id;
  return jsonb_build_object('id', t.id, 'date', t.date, 'merchant', t.merchant, 'amount', t.amount, 'method', t.method,
    'bank', t.bank, 'bill_month', t.bill_month, 'cash_delta', v_cash,
    'cash_balance', (select c.cash_balance from public.buffet_app_config c where c.user_id = t.user_id));
end
$$;

-- Tira um estorno da lista de revisão (ele nunca criou nada).
create or replace function public.buffet_notif_dismiss(p_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  n public.buffet_notification_inbox;
begin
  update public.buffet_notification_inbox x set status = 'dismissed' where x.id = p_id and x.status = 'refund' returning * into n;
  if not found then raise exception 'estorno não encontrado ou já dispensado' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', n.id, 'status', n.status, 'amount', n.amount, 'merchant', n.merchant);
end
$$;

-- ---------------------------------------------------------------- RLS + grants (igual ao init)
alter table public.buffet_notification_inbox enable row level security;
revoke all on public.buffet_notification_inbox from public, anon, authenticated, bot;
-- O app e o CLI leem e mudam status (dispensar estorno); só a Edge Function (service_role) insere. Ninguém apaga: é o histórico.
grant select, update on public.buffet_notification_inbox to authenticated, bot;
grant select, insert, update on public.buffet_notification_inbox to service_role;
drop policy if exists owner_all on public.buffet_notification_inbox;
create policy owner_all on public.buffet_notification_inbox for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists bot_all on public.buffet_notification_inbox;
create policy bot_all on public.buffet_notification_inbox for all to bot using (true) with check (true);

-- A Edge Function usa a service_role (bypassa RLS). Explícito, para não depender dos default privileges do projeto.
grant select, insert, update on public.buffet_transactions to service_role;
grant select, update on public.buffet_app_config to service_role;
grant select on public.buffet_subscriptions, public.buffet_debts to service_role;
grant execute on function public.buffet_owner() to service_role;
grant execute on function public.buffet_bill_month(int, int, date) to service_role;

-- Entrada: só a service_role. Anon (a chave pública do PWA) e o dono não criam gasto por aqui.
revoke execute on function public.buffet_notif_ingest(jsonb) from public, anon, authenticated, bot;
grant execute on function public.buffet_notif_ingest(jsonb) to service_role;
revoke execute on function public.buffet_tx_review(text, jsonb, boolean) from public, anon;
revoke execute on function public.buffet_tx_discard(text) from public, anon;
revoke execute on function public.buffet_notif_dismiss(text) from public, anon;
grant execute on function public.buffet_tx_review(text, jsonb, boolean) to authenticated, bot;
grant execute on function public.buffet_tx_discard(text) to authenticated, bot;
grant execute on function public.buffet_notif_dismiss(text) to authenticated, bot;

notify pgrst, 'reload schema';
