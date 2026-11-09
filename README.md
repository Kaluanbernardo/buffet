# Buffet Kaluan

PWA pessoal de finanças (pt-BR, BRL). Publicado em **https://kaluanbernardo.github.io/buffet/**.

## Rodar local
```bash
cd web
cp .env.example .env.local   # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (os mesmos do fitness)
npm install
npm run dev                  # http://localhost:5173/buffet/
```
Com `VITE_SUPABASE_*` o login é o mesmo e-mail/senha do app de treino (Supabase Auth) e os dados vêm do banco.
Sem eles, o app cai no gate de senha antigo (`VITE_APP_PASSWORD_HASH`, SHA-256 hex) com dados só no aparelho:
```bash
printf '%s' 'minha-senha' | sha256sum | cut -d' ' -f1
```

## Deploy (GitHub Pages)
1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets → Actions: `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (mesmos valores do fitness; só a anon key, **nunca** a service role).
   Sem eles o build usa `VITE_APP_PASSWORD_HASH` (fallback).
3. Push em `main` → workflow `.github/workflows/pages.yml` publica `web/dist`.

No primeiro login com Supabase, se a conta ainda não tem `buffet_app_config`, os dados que estavam no `localStorage`
daquele aparelho são enviados uma vez (lançamentos com id novo, dívidas, reservas, orçamento, renda).

## Chat → banco → PWA (`scripts/buffet`)
O assistente lança gastos direto no Supabase, como o `fit` do fitness: `scripts/buffet` roda cada comando pela
Management API em `begin; set local role bot; …; commit;` (RLS + grants do role `bot`, `source='bot'`,
`user_id` = dono via `public.buffet_owner()`). O app recarrega os dados ao voltar para o primeiro plano.
```bash
scripts/buffet expense 97,13 --merchant Bar --category Lazer [--date ontem] [--bank Nubank] [--note "..."]
scripts/buffet list                      # mês atual; --date 29/10 ou --month 2026-10
scripts/buffet del <id>                  # desfaz um lançamento errado
scripts/buffet import-jsonl data/expenses.jsonl   # idempotente pelo id
scripts/buffet sql "select category, sum(effective_amount) from buffet_transactions group by 1"
```
Quando o Kaluan disser no chat "gastei 32 no mercado no Nubank", o assistente roda `buffet expense 32 --merchant Mercado
--category Alimentação --bank Nubank` e confirma com o id/total de `buffet list`.

**Fatura de cartão não é gasto** (as compras já entraram uma a uma): vai para `buffet_card_payments`, fora de todos os
totais e gráficos; no PWA aparece apagada no extrato de Gastos ("Fatura Inter · Não conta como gasto") e numa linha
discreta no card do mês em Hoje. "Paguei a fatura do Inter com o Nubank" →
```bash
scripts/buffet pay-bill 70,16 --card Inter --from Nubank   # debita o cash_balance se --from = cash_balance_bank
scripts/buffet pay-bill 500 --card Inter --no-cash          # só registra, sem mexer no saldo
scripts/buffet del-bill <id> [--restore-cash]               # desfaz; --restore-cash devolve ao saldo
```
`buffet expense` avisa quando o estabelecimento/nota fala em "fatura". Desenho: `research/bill-payment-design.md` (opção B).

**Meio de pagamento e parcelas** (`research/installments-bills-proposal.md`, opção A). `method` (debit/pix/credit) fica
separado de `bank` (a instituição). Débito/PIX descontam o `cash_balance` no mesmo comando; crédito entra na fatura
(`bill_month`) pelo ciclo do cartão em `buffet_app_config.banks[].credit` e só sai do caixa no `pay-bill`. Parcelado =
um plano em `buffet_debts` + **uma linha de gasto por parcela** (datas futuras; a última absorve o arredondamento).
Fatura = linhas `credit` agrupadas por `(bank, bill_month)`; o valor que o app do banco mostra fica numa
`buffet_debts kind='bill'` e a fatura vale `max(informado, detalhado)` — nunca a soma dos dois.
```bash
scripts/buffet expense 5 --merchant Café --category Alimentação --debit         # desconta o saldo
scripts/buffet expense 36,00 --merchant Uber --category Transporte --credit Nubank
scripts/buffet expense 100 --merchant Tênis --category Vestimenta --credit Nubank --x 10   # plano + 10 linhas
scripts/buffet bill                      # fatura aberta: itens, não detalhado, total, saldo depois de pagar
scripts/buffet bills                     # faturas a pagar + comprometido + "livre de parcelas depois de"
scripts/buffet bill set 100 --card Nubank            # valor informado pelo banco (fatura aberta)
scripts/buffet pay-bill 100 --card Nubank --from Nubank   # marca a fatura paga + installments_paid dos planos
scripts/buffet card set Nubank --closing 4 --due 11 · plans · del-plan <id> [--from AAAA-MM]
```
**Gasto dividido e reembolso** (`research/split-reimburse-proposal.md`). O lançamento guarda sempre o valor cheio. Em toda
soma de gasto entra `effective_amount` (`amount − reimbursed_amount`, gerada no banco; no app, `spendOf`), então o gasto conta
inteiro até o dinheiro voltar e depois só a sua parte. Fatura e preço de assinatura continuam com `amount`, porque o banco cobra
tudo. Reembolso não é renda e reduz o mês do gasto, não o mês em que chegou. "Gastei 1.000 de aluguel no PIX, dividido"; "recebi
o aluguel"; "quanto tenho a receber?" →
```bash
scripts/buffet expense 1000 --merchant "Aluguel exemplo" --category Moradia --pix --split [--share 50]
scripts/buffet split aluguel [--share 60]     # marca ou ajusta a SUA parte, em %; não mexe no caixa
scripts/buffet split aluguel --share 0        # reembolso integral: sua parte 0%, a outra pessoa deve o valor todo; não mexe no caixa
scripts/buffet unsplit aluguel                # só sem reembolso registrado
scripts/buffet reimburse aluguel [--amount 300] [--date d] [--no-cash]   # padrão: tudo o que falta; soma ao cash_balance
scripts/buffet unreimburse aluguel            # zera o reembolso e tira do cash_balance só o que tinha entrado
scripts/buffet receivable                     # lista e total a receber
```
`--share 0` é o caso reembolsável por inteiro: num gasto de 100 ("Aluguel exemplo"), a receber 100; o caixa e o gasto contado só
mudam quando o `reimburse` registra o que entrou (100 cheio ou em partes). `--share 100` e negativos seguem recusados.
`<gasto>` = id, começo do id ou trecho do merchant; busca ambígua aborta e lista as opções. CLI e PWA (menu "…" em Gastos e
"A receber" em Hoje) usam as mesmas funções SQL, `public.buffet_tx_split|unsplit|reimburse|unreimburse`: security invoker, valem
RLS e grants, e gasto e saldo mudam na mesma transação. Parcela de plano não pode ser dividida, e linha com reembolso não pode ser
apagada (o banco recusa; desfaça o reembolso antes). No calendário, a célula do dia mostra o valor cheio com um ponto, e o total
do mês mostra o efetivo.

No PWA, linhas com data futura ficam fora de Hoje e dos totais de Gastos (aparecem como "Agendadas" no mês);
Dívidas tem as abas Faturas | Parcelas | Assinaturas. Token:
`$SUPABASE_ACCESS_TOKEN` ou `/home/box/.secrets/supabase_access_token` (nunca impresso). `BUFFET_ROLLBACK=1` testa sem gravar.

## Captura por notificação (MacroDroid → Edge Function)
Cada notificação de compra/PIX do Nubank vira um **gasto pendente de revisão** (`review_status='pending'`), que já conta nos totais
com marcador. Débito/PIX da conta do saldo já descontam o `cash_balance` (`cash_debited`); crédito entra na fatura pelo ciclo do
cartão; descartar desfaz os dois. Notificação repetida não duplica, e o que também foi lançado pelo chat fica marcado como possível
duplicata. Passo a passo (MacroDroid, secret, deploy) e decisões: `docs/captura-notificacoes.md`.
```bash
scripts/buffet pending [--inbox 30]          # pendentes + estornos; --inbox: o que cada notificação virou
scripts/buffet review <gasto> --category Alimentação [--merchant X] [--debit|--pix|--credit Nubank] [--split] [--keep-pending]
scripts/buffet confirm <gasto> | --all       # --all pula possível duplicata
scripts/buffet discard <gasto>               # devolve o caixa, tira da fatura; com id de estorno, só dispensa
```
No PWA: cartão **Pendentes de revisão** em Hoje (Confirmar · Revisar · Descartar) e tag "Pendente" nas linhas de Gastos.

## Migrations
`supabase/migrations/*.sql` → `scripts/apply_migrations_https.py [--dry-run]` (Management API; registra em
`public._buffet_migrations`, separado do `_migrations` do fitness porque as versions colidem no mesmo projeto).
Segurança igual ao fitness: `owner_all` (authenticated + `is_owner()`), `bot_all` (role `bot`), anon sem acesso.

## Instalar no Android
Abra a URL no Chrome → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").

## Arquitetura
- `web/src/lib/auth.ts` — `AuthAdapter`: Supabase Auth quando há `VITE_SUPABASE_*`; senão gate de senha (`sessionStorage`).
- `web/src/data/store.ts` — `DataStore`: `supabaseStore` (tabelas `public.buffet_*`; `save` só grava o que mudou,
  `source='app'`) ou `localStore` (F0).
- `supabase/migrations/` — tabelas `public.buffet_*` aplicadas no projeto do fitness (`qlphmxjehsexuxspspaw`).
- `supabase/functions/buffet-ingest-notification` — Edge Function da captura; parser, categoria e handler em `supabase/functions/_shared` (testados em `web/tests/notificacoes*.test.ts`, com o SQL rodando de verdade no PGlite).
- Ícones: `npm run icons` (Python + Pillow) gera `web/public/icons/*.png`.
