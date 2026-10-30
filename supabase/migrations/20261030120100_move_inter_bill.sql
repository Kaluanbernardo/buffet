-- Fatura do Inter de 30/10 (R$ 767,79) lançada como gasto em "Outros": muda para buffet_card_payments, mesmo id.
-- paid_from = Nubank (cash_balance_bank). cash_balance NÃO muda: o chat já descontou à mão no lançamento.
-- Idempotente: só apaga de buffet_transactions o que já está em buffet_card_payments.
insert into public.buffet_card_payments (id, user_id, date, amount, card_bank, paid_from, note, source, created_at)
select t.id, t.user_id, t.date, t.amount, coalesce(t.bank, 'Inter'), 'Nubank', t.note, t.source, t.created_at
  from public.buffet_transactions t
 where t.id = '1ea29ba2-ca2f-4da1-87c6-f9e714c9b513'
on conflict (id) do nothing;

delete from public.buffet_transactions t
 using public.buffet_card_payments p
 where t.id = p.id and t.id = '1ea29ba2-ca2f-4da1-87c6-f9e714c9b513';
