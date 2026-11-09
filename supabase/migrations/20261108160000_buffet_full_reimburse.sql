-- Reembolso integral: a SUA parte pode ser 0% (a outra pessoa deve o valor todo).
-- Só afrouxa o limite inferior da parte e recria buffet_tx_split. Nada muda no saldo ao marcar a divisão.
-- Mantém: 100% continua recusado, parcela de plano (debt_id) não pode ser dividida e as colunas geradas ficam como estão
-- (com parte 0, partner_amount = amount e effective_amount segue amount − reimbursed_amount).

alter table public.buffet_transactions
  drop constraint if exists buffet_tx_split_share_range,
  add constraint buffet_tx_split_share_range check (split_share_pct >= 0 and split_share_pct < 100);

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
  -- Parcela de plano (debt_id) continua fora: parcelado dividido não existe.
  if t.debt_id is not null then raise exception 'parcela de plano não pode ser dividida' using errcode = 'P0001'; end if;
  if v_share is null or v_share < 0 or v_share >= 100 then
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

-- create or replace mantém os grants, mas repete por segurança.
revoke execute on function public.buffet_tx_split(text, numeric) from public, anon;
grant execute on function public.buffet_tx_split(text, numeric) to authenticated, bot;

notify pgrst, 'reload schema';
