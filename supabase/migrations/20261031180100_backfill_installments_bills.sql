-- Backfill da opção A com os dados de 31/10 (respostas do Kaluan à proposta): "Cartão" = Nubank; Nubank fecha 4 e
-- vence 11; a Fatura Nubank aberta é R$ 2.243 e já inclui as compras de 30–31/10; Sapatos 10x e Terno 6x viram planos
-- com as parcelas 2..N materializadas (a última absorve o arredondamento: Terno 5 × 83,32 + 83,30).
-- Idempotente: só toca linhas ainda sem method/kind e não duplica parcelas (unique debt_id + installment_no).

-- Ciclo do cartão no jsonb de bancos (sem tabela nova).
update public.buffet_app_config c set banks = (
  select jsonb_agg(case when b->>'name' = 'Nubank' and b->'credit' is null
    then b || '{"credit":{"closing_day":4,"due_day":11}}'::jsonb else b end order by o)
  from jsonb_array_elements(c.banks) with ordinality as e(b, o)), updated_at = now()
where exists (select 1 from jsonb_array_elements(c.banks) b where b->>'name' = 'Nubank' and b->'credit' is null);

-- Meio de pagamento separado da instituição.
update public.buffet_transactions set method = 'debit', bank = 'Nubank' where method is null and bank = 'Débito';
update public.buffet_transactions set method = 'pix', bank = 'Nubank' where method is null and bank = 'PIX';
update public.buffet_transactions set method = 'credit', bank = 'Nubank' where method is null and bank = 'Cartão';
update public.buffet_transactions set method = 'credit' where method is null and bank = 'Nubank' and note ilike '%crédito%';
update public.buffet_transactions set bill_month = public.buffet_bill_month(4, 11, date)
where method = 'credit' and bank = 'Nubank' and bill_month is null;

-- Dívidas: a fatura informada e os dois planos.
update public.buffet_debts set kind = 'bill', card = 'Nubank', first_bill = '2026-11', description = 'Fatura Nubank'
where id = '766d2544-aa7f-4aae-b520-f03dffb24101';
update public.buffet_debts set kind = 'installments', bank = 'Nubank', card = 'Nubank', total_amount = 689.00,
  purchase_date = '2026-10-31', first_bill = '2026-11'
where id = '9223f49e-82e8-4a8d-a949-57aef6767434';
update public.buffet_debts set kind = 'installments', bank = 'Nubank', card = 'Nubank', total_amount = 499.90,
  purchase_date = '2026-10-31', first_bill = '2026-11'
where id = 'dd6c6557-e953-49a5-81c1-664e7f7ec214';

-- Parcela 1 (já lançada à mão) ligada ao plano.
update public.buffet_transactions set debt_id = '9223f49e-82e8-4a8d-a949-57aef6767434', installment_no = 1
where id = '393a032f-2d14-4c51-b74b-18a86dfc1026' and debt_id is null;
update public.buffet_transactions set debt_id = 'dd6c6557-e953-49a5-81c1-664e7f7ec214', installment_no = 1
where id = '5690b46e-1897-48b1-8e2a-4f899194a06f' and debt_id is null;

-- Parcelas 2..N: data = compra + (k − 1) meses (fim do mês limitado pelo Postgres), fatura = first_bill + (k − 1).
insert into public.buffet_transactions (user_id, date, amount, merchant, category, bank, note, source, method, bill_month, debt_id, installment_no)
select d.user_id, (d.purchase_date + (k - 1) * interval '1 month')::date,
  case when k = d.installments_total then d.total_amount - (k - 1) * d.installment_amount else d.installment_amount end,
  d.description, 'Vestimenta', 'Nubank',
  'parcela ' || k || '/' || d.installments_total || ' de R$ ' || replace(to_char(d.total_amount, 'FM999G990D00'), '.', ','),
  'bot', 'credit', to_char(to_date(d.first_bill, 'YYYY-MM') + (k - 1) * interval '1 month', 'YYYY-MM'), d.id, k
from public.buffet_debts d, generate_series(2, d.installments_total) k
where d.id in ('9223f49e-82e8-4a8d-a949-57aef6767434', 'dd6c6557-e953-49a5-81c1-664e7f7ec214')
  and d.total_amount is not null
on conflict do nothing;
