-- Parcelas materializadas + faturas (research/installments-bills-proposal.md, opção A).
-- Gasto continua = linhas de buffet_transactions (uma por parcela, inclusive futuras). Fatura = linhas method='credit'
-- agrupadas por (bank, bill_month); o valor "informado pelo banco" fica numa buffet_debts kind='bill'.
-- Aditiva: o PWA antigo ignora as colunas novas e o upsert dele não as apaga (só manda as colunas que conhece).
alter table public.buffet_transactions
  add column if not exists method text check (method in ('debit', 'pix', 'credit', 'cash')),
  add column if not exists bill_month char(7) check (bill_month ~ '^\d{4}-\d{2}$'),        -- só credit: fatura em que entra
  add column if not exists debt_id text references public.buffet_debts (id) on delete cascade,  -- plano de parcelas
  add column if not exists installment_no int check (installment_no >= 1);                -- k de debts.installments_total
create index if not exists buffet_transactions_bill_idx on public.buffet_transactions (user_id, bank, bill_month)
  where bill_month is not null;
create unique index if not exists buffet_transactions_installment_uq on public.buffet_transactions (debt_id, installment_no)
  where debt_id is not null;

alter table public.buffet_debts
  add column if not exists kind text not null default 'installments' check (kind in ('installments', 'bill', 'loan')),
  add column if not exists card text,                    -- cartão de crédito ("Nubank"); bank fica como veio
  add column if not exists total_amount numeric(12,2),   -- installments: valor da compra (a última parcela absorve o arredondamento)
  add column if not exists purchase_date date,
  add column if not exists first_bill char(7) check (first_bill ~ '^\d{4}-\d{2}$');  -- installments: fatura da parcela 1 · bill: a própria fatura

alter table public.buffet_card_payments
  add column if not exists bill_month char(7) check (bill_month ~ '^\d{4}-\d{2}$');   -- qual fatura foi quitada

-- Fatura (mês de vencimento AAAA-MM) em que cai uma compra de crédito feita em p_date, para um cartão que fecha no dia
-- p_closing e vence no dia p_due. A compra entra no primeiro fechamento DEPOIS da data (no dia do fechamento já vai para
-- a próxima). Vencimento depois do fechamento no calendário → mesmo mês; senão, mês seguinte.
-- Fechamento 4, vencimento 11: 31/10 → 2026-11 · 04/11 → 2026-12. Espelhada em web/src/data/derive.ts (billMonth).
create or replace function public.buffet_bill_month(p_closing int, p_due int, p_date date)
returns char(7)
language sql immutable
set search_path = ''
as $$
  select to_char(date_trunc('month', p_date::timestamp)
    + case when extract(day from p_date)::int < p_closing then interval '0 month' else interval '1 month' end
    + case when p_due > p_closing then interval '0 month' else interval '1 month' end, 'YYYY-MM')
$$;
revoke execute on function public.buffet_bill_month(int, int, date) from public, anon;
grant execute on function public.buffet_bill_month(int, int, date) to authenticated, bot;

-- O bot cancela/estorna um plano (buffet del-plan): o cascade leva as parcelas junto.
grant delete on public.buffet_debts to bot;
