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
scripts/buffet expense 107,56 --merchant Bar --category Lazer [--date ontem] [--bank Nubank] [--note "..."]
scripts/buffet list                      # mês atual; --date 29/10 ou --month 2026-10
scripts/buffet del <id>                  # desfaz um lançamento errado
scripts/buffet import-jsonl data/expenses.jsonl   # idempotente pelo id
scripts/buffet sql "select category, sum(amount) from buffet_transactions group by 1"
```
Quando o Kaluan disser no chat "gastei 32 no mercado no Nubank", o assistente roda `buffet expense 32 --merchant Mercado
--category Alimentação --bank Nubank` e confirma com o id/total de `buffet list`.

**Fatura de cartão não é gasto** (as compras já entraram uma a uma): vai para `buffet_card_payments`, fora de todos os
totais e gráficos; no PWA aparece apagada no extrato de Gastos ("Fatura Inter · Não conta como gasto") e numa linha
discreta no card do mês em Hoje. "Paguei a fatura do Inter com o Nubank" →
```bash
scripts/buffet pay-bill 767,79 --card Inter --from Nubank   # debita o cash_balance se --from = cash_balance_bank
scripts/buffet pay-bill 500 --card Inter --no-cash          # só registra, sem mexer no saldo
scripts/buffet del-bill <id> [--restore-cash]               # desfaz; --restore-cash devolve ao saldo
```
`buffet expense` avisa quando o estabelecimento/nota fala em "fatura". Desenho: `research/bill-payment-design.md` (opção B). Token:
`$SUPABASE_ACCESS_TOKEN` ou `/home/box/.secrets/supabase_access_token` (nunca impresso). `BUFFET_ROLLBACK=1` testa sem gravar.

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
- Ícones: `npm run icons` (Python + Pillow) gera `web/public/icons/*.png`.
