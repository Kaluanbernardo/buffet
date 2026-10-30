# Pagamento de fatura ≠ gasto — proposta de modelo

> Status: **implementada a opção B** em 30/10/2026 (migrations `20261030120000`, `20261030120100`). O texto abaixo é a proposta original.
> Data: 30/10/2026.

## 1. O problema

Hoje tudo em `buffet_transactions` é gasto. Cada linha entra em todos os totais:

| Onde | O que soma |
|---|---|
| `scripts/buffet list` | `total` = soma de todas as linhas do período |
| `derive.ts › monthSummary` | `spent`, `spentBy` por categoria, `orphan`, `left`, `perDay`, `over` |
| Hoje | card do mês, barra de categorias (`categoryShare(m.tx)`), faixa diária (`dailySpend`), "Gastos recentes" |
| Gastos | total do período, donut, barras Dia/Semana/Mês, chips de categoria |
| Orçamento | gasto por categoria contra o limite |
| CSV (`lib/csv.ts`) | todas as linhas, sem coluna de tipo |

Pagar a fatura não é consumo: o dinheiro sai da conta corrente para quitar uma dívida com o cartão. As compras que geraram a fatura **já foram** (ou deveriam ter sido) lançadas uma a uma. Contar a fatura de novo é **contagem dupla**.

### Estado real do banco (consulta só de leitura, 30/10)

- Já existe uma fatura lançada como gasto:
  `1ea29ba2-…` · 30/10 · **R$ 767,79** · merchant "Fatura cartão" · categoria **Outros** · bank **Inter** · note "pagamento de fatura".
  Com isso o gasto de outubro aparece como R$ 875,35, quando o valor certo é R$ 107,56, e "Outros" estoura o orçamento.
- `buffet_app_config` tem as colunas **`cash_balance`** (12.097,41) e **`cash_balance_bank`** ("Nubank"), mas **nenhuma migration do repo cria essas colunas**. O schema do banco está à frente do repo e isso precisa ser registrado na migration.
- O `cash_balance` foi atualizado 6 s depois do lançamento da fatura. Tudo indica que o chat já descontou os R$ 767,79 do saldo à mão. A migration de dados **não deve** descontar de novo.
- Não há triggers nas tabelas `buffet_*`. Hoje o `cash_balance` é um número informado à mão, não é calculado.

### Por que o `cash_balance` é o "inverso" dos gastos

| Evento | Gasto do mês? | Mexe no caixa (conta corrente)? |
|---|---|---|
| Compra no débito ou Pix | sim | sim, na data |
| Compra no cartão de crédito | sim, na data da compra | **não** na data |
| Pagamento da fatura | **não** | **sim**, na data do pagamento |

Para os totais de gasto, a fatura precisa sair da conta. Para o caixa, ela é justamente a linha que importa. O modelo precisa servir aos dois usos.

---

## 2. Alternativas

### Opção A: coluna `kind` em `buffet_transactions` (recomendada)

```sql
kind text not null default 'expense' check (kind in ('expense', 'bill_payment'))
paid_from text   -- conta de onde o dinheiro saiu (opcional; só faz sentido em bill_payment)
```
- `bank` passa a significar **qual cartão** teve a fatura paga. Isso bate com a linha existente ("Inter") e com o filtro por banco.
- `paid_from` guarda a conta pagadora (ex.: "Nubank"), que é o que importa para o caixa.
- A lista de valores aceita crescer depois (`transfer`, `refund`, `income`) sem mudar a forma da tabela.
- Uma view `buffet_expenses` (`security_invoker`) com `where kind = 'expense'` serve para SQL ad-hoc. No front, um único helper `expenses(tx)` em `derive.ts`.

**Prós**
- Um extrato só: a fatura continua aparecendo na linha do tempo (como no app do Nubank), só que fora dos totais.
- Migration aditiva, com default `'expense'`. Nada quebra se o PWA antigo continuar no ar por alguns minutos.
- O `store.ts` atual já preserva colunas que não conhece: o `upsert` só envia as colunas de `toRow`, então `kind` não é apagado. A sincronização de remoções continua igual.
- O delete do CLI (`buffet del`) funciona para os dois tipos.

**Contras**
- Toda soma tem que lembrar de filtrar. Isso se resolve com **um ponto único**: `monthSummary` já entrega `m.tx`, então basta filtrar ali e expor as faturas em separado. Gastos usa `data.transactions` direto e precisa do mesmo helper.
- `category` é `not null`, então a fatura precisa de uma categoria. Proposta: `'Fatura'`, fora de `config.categories` para não ganhar linha de orçamento. Os cálculos ignoram a categoria quando `kind ≠ expense`.

### Opção B: tabela separada `buffet_card_payments`

```sql
create table public.buffet_card_payments (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  date date not null, amount numeric(12,2) not null check (amount > 0),
  card_bank text not null, paid_from text, debt_id text, note text,
  source text not null default 'bot' check (source in ('app','bot')),
  created_at timestamptz not null default now()
);
```

**Prós**
- Não tem como somar por engano: nenhum cálculo de gasto muda.
- Semântica limpa, com espaço para ligar a fatura a `buffet_debts` (`debt_id`) e mostrar "fatura paga" em Dívidas.

**Contras**
- Mais peças: nova tabela com RLS e grants (incluir no `do $$` do init), novo `Spec` no `store.ts`, novo tipo, novo comando de delete no CLI (o bot só pode apagar `buffet_transactions`).
- Para mostrar a fatura no extrato de Gastos é preciso juntar duas coleções (union) na UI.
- Não generaliza: estorno, transferência entre contas e renda pediriam mais uma tabela cada.
- A linha existente precisa **mudar de tabela** (insert + delete), o que é mais arriscado que um `update`.

### Opção C: categoria especial "Fatura" (zero schema)

Marcar como fatura pela categoria (`category = 'Fatura'`) e excluir essa categoria das somas.

**Prós**
- Nenhuma migration. É o mais rápido (5 minutos).
- Parecido com o YNAB, que tem um grupo de categorias "Credit Card Payments".

**Contras**
- Classificação feita por texto: um typo ("fatura", "Fatura cartão") escapa do filtro. Hoje o `pcategory` do CLI **aceita qualquer categoria** com só um aviso.
- Mistura duas dimensões (o que comprei × que tipo de movimento é). Um estorno de Lazer, por exemplo, não teria onde ficar.
- Se "Fatura" entrar em `config.categories`, o `migrate()` cria uma linha de orçamento para ela e ela aparece como chip em Novo lançamento. Então ela precisa ficar fora da config e virar caso especial em vários lugares.
- No YNAB isso funciona porque existe um modelo de **contas** por baixo. Aqui não existe.

### Comparação rápida

| | A · `kind` | B · tabela própria | C · categoria |
|---|---|---|---|
| Risco de contar por engano | médio (mitigado por helper e view) | nenhum | alto |
| Tamanho da mudança | pequeno | médio | mínimo |
| Fatura visível no extrato | sim, de graça | precisa de union | sim |
| Generaliza (estorno, transferência) | sim | não | não |
| Migra a linha existente | `update` | move a linha | `update` |

---

## 3. Impacto de cada opção

### CLI (`scripts/buffet`)

| | A | B | C |
|---|---|---|---|
| Novo comando | `buffet pay-bill <valor> --card Inter [--from Nubank] [--date d] [--note t]` → insere `kind='bill_payment'`, `merchant='Fatura Inter'`, `category='Fatura'` | `pay-bill` insere em `buffet_card_payments`; `del-bill <id>` (precisa de grant de delete para o bot) | `pay-bill` = `expense --category Fatura` |
| `expense` | sem mudança (default `expense`); **aviso** se o merchant ou a nota bater com `/fatura/i`: "use buffet pay-bill" | igual a A | igual a A |
| `list` | coluna `kind`; `total` só com gastos; linha extra "pagamentos de fatura: R$ X (fora do total)" | lista duas tabelas | filtra por categoria |
| `import-jsonl` | aceita `"kind"` opcional | ramifica por tabela | sem mudança |
| `sql` livre | usar `buffet_expenses` | sem cuidado especial | lembrar do `where` |

### PWA: totais e gráficos

**A** (arquivos tocados):
- `data/types.ts`: `Transaction.kind?: 'expense' | 'bill_payment'`, `paid_from?: string`.
- `data/store.ts`: ler `kind` e `paid_from` no `load`, enviar no `toRow`.
- `data/derive.ts`: `export const isExpense = (t) => (t.kind ?? 'expense') === 'expense'`. `monthSummary` filtra `tx` por `isExpense` e expõe `bills` (faturas do mês) e `billsTotal`. Assim `spent`, `cats`, `orphan`, `perDay`, `over`, `categoryShare(m.tx)` e `dailySpend` ficam corretos sem mais nada.
- `screens/Gastos.tsx`: `scope` usa `isExpense` para total, gráficos e chips. No extrato, a fatura aparece **apagada**, com ícone de transferência e a legenda "Fatura Inter · não conta como gasto", sem entrar no total do dia. É o mesmo padrão do Nubank, em que "Pagamento de fatura" aparece no extrato da conta mas não no resumo de gastos.
- `screens/Hoje.tsx`: "Gastos recentes" igual a Gastos. Opcionalmente, uma linha discreta no card do mês: "Faturas pagas: R$ 767,79".
- `lib/csv.ts`: nova coluna `tipo`.
- `components/Actions.tsx` (fase 2): seletor "Gasto | Pagar fatura" no Novo lançamento.

**B**: novo `Spec` e tipo `CardPayment[]`; gráficos sem mudança; o extrato precisa intercalar as duas listas.
**C**: um `filter(c => c.category !== 'Fatura')` em `derive.ts` e Gastos, com exclusões explícitas no `migrate()` e nos chips.

### `cash_balance`

Nas três opções o `cash_balance` continua sendo um **número informado** (snapshot), como hoje. O que muda é como o chat ou CLI o mantém:

- **A/B, fase 1 (recomendada):** `buffet pay-bill … --from Nubank` grava `paid_from`. Se `paid_from = cash_balance_bank`, o mesmo comando debita o saldo **de forma atômica**, numa CTE só, o que respeita a regra "um comando por chamada" do bot:
  ```sql
  with p as (insert into public.buffet_transactions (...) values (...) returning amount, paid_from)
  update public.buffet_app_config c set cash_balance = c.cash_balance - p.amount, updated_at = now()
  from p where p.paid_from = c.cash_balance_bank returning c.cash_balance
  ```
  Uma flag `--no-cash` pula o débito. `buffet del` de uma fatura avisa: "saldo não foi restaurado; ajuste com …".
- **Fase 2 (opcional, só se fizer falta):** saldo **ancorado**: `cash_balance` + `cash_balance_at` (data do snapshot), e o app mostra `snapshot − Σ saídas da conta depois da âncora`. Isso exige saber o meio de pagamento de cada gasto (débito ou crédito), que hoje não existe. Por isso fica fora da proposta mínima.
- **C** não tem onde guardar a conta pagadora sem usar a nota. Esse é mais um ponto contra.

**Gasto no cartão não deve debitar o caixa.** Se no futuro o chat passar a debitar o saldo a cada `expense`, isso só vale para débito ou Pix.

---

## 4. Recomendação: **Opção A** (`kind` + `paid_from`)

1. **Contas a pagar no estilo do YNAB, sem precisar modelar contas:** no YNAB a compra no cartão já é o gasto (sai da categoria na hora) e o pagamento da fatura é transferência, sem impacto no orçamento. A Opção A reproduz exatamente esse efeito (o gasto entra na compra, a fatura entra com `kind` neutro) sem trazer o modelo de contas inteiro do YNAB.
2. **Extrato único no estilo do Nubank:** a fatura continua visível na linha do tempo, que é onde o Kaluan vai procurar ("paguei a fatura?"), mas não entra no resumo.
3. **Menor mudança segura:** migration aditiva com default, `update` de uma linha, e o `store.ts` atual já convive com a coluna nova.
4. **Base para o próximo passo:** `transfer` (Nubank → Inter), `refund` e `income` cabem no mesmo `check`, e `buffet_incomes` pode um dia virar `kind='income'`.

O risco de "esquecer o filtro" se controla com **um helper (`isExpense`) e uma view (`buffet_expenses`)**, mais um teste rápido: o gasto de outubro precisa dar R$ 107,56 depois da reclassificação.

### Pergunta para o Kaluan antes de aplicar

> **As compras do cartão estão sendo lançadas uma a uma?**
> A fatura do Inter (R$ 767,79) foi paga em 30/10, mas o Buffet só existe desde 29/10, então essas compras são de antes e nunca foram lançadas. Tirar a fatura dos gastos é o correto (outubro fica em R$ 107,56). A partir de agora, porém, se alguma compra no cartão **não** for lançada, ela some dos gastos. Se a ideia for lançar só a fatura (sem detalhar as compras), a alternativa é tratar a fatura como gasto em "Cartão (não detalhado)". Nesse caso a separação não vale para esse cartão.

Mais duas confirmações:
- A fatura de 30/10 foi paga **de qual conta**? O `cash_balance_bank` é Nubank e o cartão é Inter. A proposta é `paid_from = 'Nubank'`.
- O saldo de R$ 12.097,41 **já** está com os R$ 767,79 descontados? Pelo horário parece que sim. Se estiver, a migração não mexe no saldo.

---

## 5. Migração mínima (se ele disser sim)

**Ordem:** schema → CLI → PWA → dados. Cada passo funciona sozinho, porque o default `'expense'` mantém o comportamento atual.

1. **Migration** `supabase/migrations/20261030120000_buffet_tx_kind.sql`, aplicada com `scripts/apply_migrations_https.py --dry-run` e depois sem `--dry-run`:
   ```sql
   -- Pagamento de fatura não é gasto: kind discrimina; paid_from = conta pagadora.
   alter table public.buffet_transactions
     add column if not exists kind text not null default 'expense'
       check (kind in ('expense', 'bill_payment')),
     add column if not exists paid_from text;

   -- Já existem no banco (criadas fora das migrations); registra no repo. No-op em produção.
   alter table public.buffet_app_config
     add column if not exists cash_balance numeric(12,2),
     add column if not exists cash_balance_bank text;

   -- Só gastos, para SQL ad-hoc (RLS das tabelas vale via security_invoker).
   create or replace view public.buffet_expenses with (security_invoker = true) as
     select * from public.buffet_transactions where kind = 'expense';
   revoke all on public.buffet_expenses from public, anon;
   grant select on public.buffet_expenses to authenticated, bot;
   ```
   Os grants de coluna não mudam: o bot e o authenticated já têm `insert` e `update` na tabela inteira.

2. **CLI:** `pay-bill` (com débito atômico opcional do `cash_balance`), `list` com coluna `kind` e total só de gastos, aviso de `/fatura/i` no `expense`, `kind` no `import-jsonl`, README atualizado ("paguei a fatura do Inter" → `buffet pay-bill 767,79 --card Inter --from Nubank`).

3. **PWA:** `types.ts`, `store.ts` (`kind` e `paid_from` no load e no `toRow`), `isExpense` em `derive.ts` aplicado em `monthSummary` e Gastos, linha "não conta como gasto" no extrato, coluna `tipo` no CSV. Validar com `npm run build` e conferir Hoje, Gastos e Orçamento de outubro.

4. **Dados** (uma linha, depois das respostas acima; testar antes com `BUFFET_ROLLBACK=1`):
   ```sql
   update public.buffet_transactions
      set kind = 'bill_payment', category = 'Fatura', merchant = 'Fatura Inter', paid_from = 'Nubank'
    where id = '1ea29ba2-ca2f-4da1-87c6-f9e714c9b513'
   returning id, kind, amount, bank, paid_from
   ```
   O `cash_balance` não é alterado.

5. **Conferência:** `buffet list --month 2026-10` dá total R$ 107,56, com a fatura listada à parte. Hoje mostra R$ 107,56 gastos, e "Outros" deixa de aparecer estourado no Orçamento.

**Rollback:** `update … set kind='expense'` na linha, mais `drop view buffet_expenses` e `alter table … drop column kind, drop column paid_from` (o PWA e o CLI antigos ignoram as colunas).
