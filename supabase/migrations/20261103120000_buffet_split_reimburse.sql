-- Gasto dividido e reembolso (research/split-reimburse-proposal.md).
-- O lançamento nunca muda: amount continua cheio. Depois do reembolso, o gasto efetivo é amount − reimbursed_amount.
-- Faturas e preço de assinatura seguem somando amount; somas de gasto usam effective_amount.
-- Aditiva: o PWA antigo ignora as colunas novas e o upsert dele não as apaga (só manda as colunas que conhece).
alter table public.buffet_transactions
  add column if not exists split_share_pct numeric(5,2),       -- a SUA parte, em %; null = não dividido
  add column if not exists reimbursed_amount numeric(12,2),    -- acumulado recebido; null = nada recebido
  add column if not exists reimbursed_cash numeric(12,2),      -- quanto disso entrou no cash_balance (o desfazer devolve só isso)
  add column if not exists reimbursed_at date;                 -- último recebimento

alter table public.buffet_transactions
  add column if not exists partner_amount numeric(12,2)        -- parte da outra pessoa; o centavo ímpar fica com ela
    generated always as (round(amount * (100 - split_share_pct) / 100, 2)) stored,
  add column if not exists effective_amount numeric(12,2)      -- quanto a linha pesa nas somas de gasto
    generated always as (amount - coalesce(reimbursed_amount, 0)) stored;

alter table public.buffet_transactions
  drop constraint if exists buffet_tx_split_share_range,
  add constraint buffet_tx_split_share_range check (split_share_pct > 0 and split_share_pct < 100),
  -- Parcelado dividido está fora de escopo: a linha de um plano não pode ser dividida.
  drop constraint if exists buffet_tx_split_not_installment,
  add constraint buffet_tx_split_not_installment check (split_share_pct is null or debt_id is null),
  -- Barra reembolso maior que a parte, unsplit com dinheiro recebido e nova parte abaixo do já recebido.
  drop constraint if exists buffet_tx_reimbursed_le_partner,
  add constraint buffet_tx_reimbursed_le_partner check (coalesce(reimbursed_amount, 0) <= coalesce(partner_amount, 0)),
  -- Os três campos do reembolso andam juntos, e o caixa nunca recebeu mais do que foi reembolsado.
  drop constraint if exists buffet_tx_reimbursed_consistent,
  add constraint buffet_tx_reimbursed_consistent check (
    (reimbursed_amount is null and reimbursed_cash is null and reimbursed_at is null)
    or (reimbursed_amount > 0 and reimbursed_cash >= 0 and reimbursed_cash <= reimbursed_amount and reimbursed_at is not null));

-- Apagar uma linha reembolsada deixaria no saldo um dinheiro sem lançamento. Vale para o CLI, o app e versões antigas do app.
create or replace function public.buffet_tx_block_reimbursed_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.reimbursed_amount is not null then
    raise exception 'esse gasto tem reembolso registrado: desfaça o reembolso antes de apagar' using errcode = 'P0001';
  end if;
  return old;
end
$$;
revoke execute on function public.buffet_tx_block_reimbursed_delete() from public, anon, authenticated;
drop trigger if exists buffet_tx_block_reimbursed_delete on public.buffet_transactions;
create trigger buffet_tx_block_reimbursed_delete before delete on public.buffet_transactions
  for each row execute function public.buffet_tx_block_reimbursed_delete();

-- ---------------------------------------------------------------- operações (CLI e app usam as mesmas)
-- Security invoker: rodam com o papel de quem chama, então valem RLS e grants. owner_all deixa só o dono (authenticated) e
-- bot_all deixa o CLI; para qualquer outro usuário a linha não aparece e a função responde "não encontrado". Anon não executa.
-- Cada função é uma transação só, e travam sempre a linha do gasto antes da linha do saldo.

-- Resultado comum: o estado do gasto, o saldo atual e, em cash_delta, quanto esta chamada moveu no saldo.
create or replace function public.buffet_tx_result(t public.buffet_transactions, p_cash_delta numeric)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'date', t.date, 'merchant', t.merchant, 'amount', t.amount, 'split_share_pct', t.split_share_pct,
    'partner_amount', t.partner_amount, 'reimbursed_amount', t.reimbursed_amount, 'reimbursed_cash', t.reimbursed_cash,
    'reimbursed_at', t.reimbursed_at, 'effective_amount', t.effective_amount,
    'owed', coalesce(t.partner_amount, 0) - coalesce(t.reimbursed_amount, 0), 'cash_delta', p_cash_delta,
    'cash_balance', (select c.cash_balance from public.buffet_app_config c where c.user_id = t.user_id))
$$;

-- Marca como dividido ou ajusta a sua parte. Não mexe no saldo.
create or replace function public.buffet_tx_split(p_id text, p_share numeric default 50)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  t public.buffet_transactions;
  v_share numeric := round(p_share, 2);   -- mesma escala da coluna, para a conta aqui bater com partner_amount
  v_partner numeric;
begin
  select * into t from public.buffet_transactions x where x.id = p_id for update;
  if not found then raise exception 'gasto não encontrado' using errcode = 'P0002'; end if;
  if t.debt_id is not null then raise exception 'parcela de plano não pode ser dividida' using errcode = 'P0001'; end if;
  if v_share is null or v_share <= 0 or v_share >= 100 then
    raise exception 'a sua parte precisa ficar entre 0%% e 100%%' using errcode = 'P0001';
  end if;
  v_partner := round(t.amount * (100 - v_share) / 100, 2);
  if v_partner <= 0 then raise exception 'com essa divisão não sobra nada a receber' using errcode = 'P0001'; end if;
  if v_partner < coalesce(t.reimbursed_amount, 0) then
    raise exception 'a parte da outra pessoa (%) ficaria menor que o já recebido (%)', v_partner, t.reimbursed_amount using errcode = 'P0001';
  end if;
  update public.buffet_transactions x set split_share_pct = v_share where x.id = p_id returning * into t;
  return public.buffet_tx_result(t, 0);
end
$$;

-- Desfaz a divisão. Só sem reembolso registrado. Não mexe no saldo.
create or replace function public.buffet_tx_unsplit(p_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  t public.buffet_transactions;
begin
  select * into t from public.buffet_transactions x where x.id = p_id for update;
  if not found then raise exception 'gasto não encontrado' using errcode = 'P0002'; end if;
  if t.split_share_pct is null then raise exception 'esse gasto não está dividido' using errcode = 'P0001'; end if;
  if t.reimbursed_amount is not null then
    raise exception 'esse gasto tem reembolso registrado: desfaça o reembolso antes' using errcode = 'P0001';
  end if;
  update public.buffet_transactions x set split_share_pct = null where x.id = p_id returning * into t;
  return public.buffet_tx_result(t, 0);
end
$$;

-- Registra um recebimento: tudo o que falta (p_amount null) ou parte. Soma ao saldo, salvo p_cash = false.
-- Com cash_balance nulo, nada entra no saldo e reimbursed_cash não cresce, para o desfazer não subtrair o que nunca entrou.
create or replace function public.buffet_tx_reimburse(p_id text, p_amount numeric default null, p_date date default null, p_cash boolean default true)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  t public.buffet_transactions;
  v_owed numeric;
  v numeric;
  v_cash numeric := 0;
begin
  select * into t from public.buffet_transactions x where x.id = p_id for update;
  if not found then raise exception 'gasto não encontrado' using errcode = 'P0002'; end if;
  if t.split_share_pct is null then raise exception 'esse gasto não está dividido' using errcode = 'P0001'; end if;
  v_owed := t.partner_amount - coalesce(t.reimbursed_amount, 0);
  if v_owed <= 0 then raise exception 'esse gasto já foi todo reembolsado' using errcode = 'P0001'; end if;
  v := coalesce(p_amount, v_owed);
  if v <= 0 or v <> round(v, 2) then raise exception 'valor inválido: %', v using errcode = 'P0001'; end if;
  if v > v_owed then raise exception 'valor (%) maior que o que falta receber (%)', v, v_owed using errcode = 'P0001'; end if;
  if coalesce(p_cash, true) then
    update public.buffet_app_config c set cash_balance = c.cash_balance + v, updated_at = now()
      where c.user_id = t.user_id and c.cash_balance is not null;
    if found then v_cash := v; end if;
  end if;
  update public.buffet_transactions x
     set reimbursed_amount = coalesce(x.reimbursed_amount, 0) + v,
         reimbursed_cash = coalesce(x.reimbursed_cash, 0) + v_cash,
         reimbursed_at = coalesce(p_date, (now() at time zone 'America/Sao_Paulo')::date)
   where x.id = p_id returning * into t;
  return public.buffet_tx_result(t, v_cash);
end
$$;

-- Zera o reembolso e tira do saldo exatamente o que entrou (reimbursed_cash). O gasto continua dividido.
create or replace function public.buffet_tx_unreimburse(p_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  t public.buffet_transactions;
  v_cash numeric;
begin
  select * into t from public.buffet_transactions x where x.id = p_id for update;
  if not found then raise exception 'gasto não encontrado' using errcode = 'P0002'; end if;
  if t.reimbursed_amount is null then raise exception 'esse gasto não tem reembolso registrado' using errcode = 'P0001'; end if;
  v_cash := coalesce(t.reimbursed_cash, 0);
  if v_cash > 0 then
    update public.buffet_app_config c set cash_balance = c.cash_balance - v_cash, updated_at = now()
      where c.user_id = t.user_id and c.cash_balance is not null;
  end if;
  update public.buffet_transactions x
     set reimbursed_amount = null, reimbursed_cash = null, reimbursed_at = null
   where x.id = p_id returning * into t;
  return public.buffet_tx_result(t, -v_cash);
end
$$;

revoke execute on function public.buffet_tx_result(public.buffet_transactions, numeric) from public, anon;
revoke execute on function public.buffet_tx_split(text, numeric) from public, anon;
revoke execute on function public.buffet_tx_unsplit(text) from public, anon;
revoke execute on function public.buffet_tx_reimburse(text, numeric, date, boolean) from public, anon;
revoke execute on function public.buffet_tx_unreimburse(text) from public, anon;
grant execute on function public.buffet_tx_result(public.buffet_transactions, numeric) to authenticated, bot;
grant execute on function public.buffet_tx_split(text, numeric) to authenticated, bot;
grant execute on function public.buffet_tx_unsplit(text) to authenticated, bot;
grant execute on function public.buffet_tx_reimburse(text, numeric, date, boolean) to authenticated, bot;
grant execute on function public.buffet_tx_unreimburse(text) to authenticated, bot;

-- O PostgREST precisa enxergar as colunas e as funções novas para o app usá-las.
notify pgrst, 'reload schema';
