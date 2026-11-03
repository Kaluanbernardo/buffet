# Gasto dividido e reembolso: proposta

> Status: **aprovada e implementada** (`supabase/migrations/20261103120000_buffet_split_reimburse.sql`). Todos os valores e nomes de gastos aqui são fictícios.
>
> O que foi decidido e muda o texto abaixo:
> 1. A célula do calendário mostra o valor cheio, com um ponto nos dias com gasto dividido.
> 2. Parcelado dividido ficou de fora: não existe `--plan`, e o banco recusa dividir uma parcela.
> 3. Marcar dividido e reembolso funciona no CLI **e** por botões no PWA, pelas mesmas funções SQL (`public.buffet_tx_*`).
> 4. O "desfazer" da exclusão no app agora restaura todas as colunas. Por isso "Excluir gasto" só some em linhas com reembolso registrado; dividido sem reembolso pode ser excluído. O banco também recusa apagar linha com reembolso.

## Parte 1: em linguagem simples

### A ideia

Você paga uma conta inteira e a outra pessoa devolve a parte dela depois. O app precisa contar duas histórias sem se confundir:

- **Antes de receber:** o dinheiro saiu todo da sua conta, então o gasto conta inteiro. A parte da outra pessoa aparece em **A receber**.
- **Depois de receber:** o gasto passa a contar só a sua parte em todas as somas. O dinheiro devolvido volta para o saldo em caixa.

O lançamento original nunca é alterado: o valor cheio continua registrado, e o histórico continua mostrando o que de fato foi pago.

### Exemplo: "Aluguel exemplo", R$ 1.000,00 no PIX, dividido 50%

| Momento | Saldo em caixa | Gasto do mês | A receber | Como aparece na lista |
|---|---|---|---|---|
| Lançou como dividido | −1.000,00 | 1.000,00 | 500,00 | R$ 1.000,00 · **Dividido** · a receber R$ 500,00 |
| Avisou que recebeu | +500,00 | 500,00 | 0,00 | R$ 1.000,00 · **Reembolsado** · sua parte R$ 500,00 |

### Exemplo no crédito: "Mercado exemplo", R$ 200,00 no cartão, dividido 50%

| Momento | Saldo em caixa | Fatura | Gasto do mês | A receber |
|---|---|---|---|---|
| Lançou como dividido | não muda | 200,00 | 200,00 | 100,00 |
| Avisou que recebeu | +100,00 | **continua 200,00** | 100,00 | 0,00 |
| Pagou a fatura | −200,00 | paga | 100,00 | 0,00 |

A fatura continua cheia porque o banco vai cobrar o valor inteiro. No fim, saíram R$ 100,00 do seu caixa, que é a sua parte.

### Como você usa, no chat

- **"Gastei 1.000 de aluguel no PIX, dividido"**: lança já como dividido, 50% por padrão.
- **"Aquele mercado de ontem era dividido, minha parte é 60%"**: marca depois de lançado.
- **"Recebi o aluguel"**: registra o reembolso, atualiza o saldo e limpa o A receber.
- **"Quanto tenho a receber?"**: mostra a lista e o total, que também aparecem na tela Hoje, junto do saldo em caixa.
- **"Desfaz o reembolso"** ou **"não era dividido"**: volta atrás, inclusive no saldo.

### Regras que valem a pena conhecer

1. **O reembolso muda o mês do gasto, não o mês em que chegou.** O aluguel de outubro devolvido em novembro reduz o total de **outubro**, então um mês já encerrado pode mudar. Novembro não muda.
2. **Orçamento:** enquanto o dinheiro não volta, a categoria conta o valor cheio. Se o limite de Moradia considerar só a sua parte, ela fica estourada até o reembolso.
3. **Reembolso não é renda.** Não entra em "Renda do mês" nem em "pronto para atribuir".
4. **O dinheiro volta para a conta do saldo por padrão**, mesmo que o gasto tenha sido em outra conta ou no cartão. Se ele entrou em outro lugar, é só avisar, e o saldo não muda.
5. **Reembolso parcial funciona.** Se de R$ 500,00 chegaram R$ 300,00, o gasto conta R$ 700,00, faltam R$ 200,00 a receber e a etiqueta vira "Reembolso parcial".
6. **Se a outra pessoa não vai devolver o resto,** basta ajustar a sua parte para o que ficou valendo, e o A receber zera.

### O que fica de fora

Nesta versão não há tela para dividir ou reembolsar, nem controle de várias pessoas, nem histórico de cada pagamento parcial (só o total recebido e a última data). Também não há cobrança ou lembrete automático para a outra pessoa.

## Parte 2: técnica

### Modelo

Tudo fica em colunas novas de `buffet_transactions`, sem tabela nova. Depois do reembolso, o gasto efetivo se resume a uma conta: **`effective = amount − reimbursed_amount`**. O valor antes do reembolso, o parcial e o final saem da mesma fórmula.

```sql
-- Aditiva: o PWA antigo ignora as colunas e o upsert dele não as apaga.
alter table public.buffet_transactions
  add column if not exists split_share_pct numeric(5,2)                -- SUA parte; null = não dividido
    check (split_share_pct > 0 and split_share_pct < 100),
  add column if not exists reimbursed_amount numeric(12,2)             -- acumulado recebido
    check (reimbursed_amount > 0),
  add column if not exists reimbursed_cash numeric(12,2),              -- quanto disso entrou no cash_balance
  add column if not exists reimbursed_at date;                         -- último recebimento

alter table public.buffet_transactions
  add column if not exists partner_amount numeric(12,2)
    generated always as (round(amount * (100 - split_share_pct) / 100, 2)) stored,
  add column if not exists effective_amount numeric(12,2)
    generated always as (amount - coalesce(reimbursed_amount, 0)) stored,
  add constraint buffet_tx_reimbursed_le_partner
    check (coalesce(reimbursed_amount, 0) <= coalesce(partner_amount, 0));
```

Este SQL **não foi executado**: aqui só há o cliente `psql`, sem servidor, e não testei contra o banco real. Testar a migration em um branch antes de aplicar.

| Decisão | Por quê |
|---|---|
| `reimbursed_cash` além de `reimbursed_amount` | O desfazer precisa saber quanto entrou no saldo. Com `--no-cash` ou parciais mistos, os dois valores diferem. Um `--restore-cash` manual, como no `del-bill`, permitiria erro silencioso no saldo. |
| `effective_amount` gerada no banco | Quem soma por SQL (`buffet sql`, relatórios do chat) usa a coluna, sem repetir a fórmula. |
| `partner_amount` gerada e só lida pelo app | O arredondamento fica em um lugar só: `round` do Postgres e `Math.round` em float podem divergir no meio centavo. O centavo ímpar vai para a outra pessoa (R$ 100,01 a 50% → 50,01). |
| Constraint `reimbursed ≤ partner` | Barra no banco um reembolso maior que a parte, um `unsplit` com dinheiro já recebido e uma nova `--share` abaixo do já recebido. |

**Estado derivado, sem coluna de status:**

- `dividido`: `split_share_pct` preenchido e `reimbursed_amount` nulo
- `parcial`: `0 < reimbursed_amount < partner_amount`
- `reembolsado`: `reimbursed_amount = partner_amount`

Os grants de `buffet_transactions` são por tabela (`buffet_init.sql:110`), então as colunas novas não pedem grant novo.

### CLI (`scripts/buffet`)

```text
buffet expense 1000 --merchant "Aluguel exemplo" --category Moradia --pix --split [--share 50]
buffet split <id|busca> [--share 50] [--plan]          marca ou ajusta a sua parte; não mexe no caixa
buffet unsplit <id|busca> [--plan]                     só sem reembolso registrado
buffet reimburse <id|busca> [--amount v] [--date d] [--no-cash]    padrão: tudo o que falta
buffet unreimburse <id|busca>                          zera o reembolso e devolve reimbursed_cash
buffet receivable                                      lista e total a receber
```

- **`--share` é sempre a SUA parte, em %.** No `expense`, só `--share` já implica `--split`. `expense_plan` (`:335`) grava o mesmo campo em todas as parcelas.
- **`resolve_tx(chave)`**, no molde de `resolve_sub` (`:697`), aceita id exato, prefixo de id ou trecho do merchant, sem acentos ou maiúsculas. O alvo varia por comando:
  - `split`: não divididos dos últimos 60 dias
  - `reimburse`: com saldo a receber
  - `unsplit` e `unreimburse`: divididos e com reembolso, respectivamente
- **Busca ambígua aborta e lista as opções** (data, valor e prefixo). Com dois meses de aluguel em aberto, `reimburse aluguel` não escolhe sozinho, porque o comando move dinheiro.
- **Tudo em um único comando SQL com CTEs**, como `pay-bill`, porque `bot()` recusa mais de um comando:

```sql
with t as (
  update public.buffet_transactions x
     set reimbursed_amount = coalesce(x.reimbursed_amount, 0) + :v,
         reimbursed_cash   = coalesce(x.reimbursed_cash, 0) + :v_caixa,   -- 0 com --no-cash
         reimbursed_at     = :data
   where x.id = :id and x.split_share_pct is not null
     and coalesce(x.reimbursed_amount, 0) + :v <= x.partner_amount
  returning x.*),
c as (
  update public.buffet_app_config c set cash_balance = c.cash_balance + :v_caixa, updated_at = now()
    from t where c.cash_balance is not null and :v_caixa > 0
  returning c.cash_balance)
select t.id, t.amount, t.effective_amount, (select cash_balance from c) as cash_balance from t
```

- **Sem linha retornada, o comando dá erro**, e isso também impede registrar o mesmo reembolso duas vezes.
- **Com `cash_balance` nulo,** o CLI avisa e trata como `--no-cash`. Assim, o desfazer não subtrai um valor que nunca entrou.
- **`unreimburse` lê o valor antigo em um CTE `o` antes do update,** porque `returning` só devolve os valores novos. Depois faz `cash_balance − o.reimbursed_cash`.
- **`del` (`:367`) e `del-plan` (`:589`) recusam linhas com reembolso** e pedem `unreimburse` antes. Sem isso, o dinheiro devolvido ficaria no saldo sem lançamento correspondente.

### Helper único e onde ele entra

Em `web/src/data/derive.ts`, ao lado das outras funções espelhadas no SQL:

```ts
/** Quanto esta linha pesa nas somas de gasto. Espelha a coluna effective_amount: manter iguais. */
export const spendOf = (t: Pick<Transaction, 'amount' | 'reimbursed_amount'>) => cents(t.amount - (t.reimbursed_amount ?? 0))
/** Quanto ainda falta receber desta linha. */
export const owedOf = (t: Transaction) => (t.partner_amount == null ? 0 : cents(t.partner_amount - (t.reimbursed_amount ?? 0)))
/** A receber: só linhas já ocorridas; parcela futura entra quando chegar a data. */
export const receivable = (data: BuffetData) => { /* isPosted && owedOf(t) > 0 → { rows, total } */ }
```

**Trocar `amount` pelo helper (`spendOf`):**

| Local | O que soma |
|---|---|
| `derive.ts:11-12` (`monthSummary`) | total e categorias do mês. Alimenta Hoje, Orçamento e o limite diário sem mais mudanças. |
| `derive.ts:158` (`categoryShare`) | donut e barra de divisão |
| `derive.ts:173` (`byDate`) | `dailySpend`, `monthDays`, `weekDays`: gráficos, semana, faixa de dias, comparação semanal |
| `derive.ts:261` (`subState.yearTotal`) | total no ano de uma assinatura |
| `Gastos.tsx:62` | total do cabeçalho |
| `Gastos.tsx:84` | total do mês em "Tudo" |
| `Gastos.tsx:176` | subtotal do dia na lista |
| `Gastos.tsx:208` | total das agendadas |
| `Gastos.tsx:398` (`HistoryPanel`) | barras por mês |
| `Gastos.tsx:436` (`MonthPicker`) | totais do seletor de mês |
| `scripts/buffet:406-407` (`cmd_list`) | total e agendadas: `effective_amount`, mais uma coluna "parte" |
| `README.md:36` | exemplo com `sum(amount)` passa para `sum(effective_amount)` |

**Já corrigidos, por receberem dados derivados dos itens acima:** `Hoje.tsx:39`, `:41`, `:129`; `WeekPanel`, `MonthPanel`; `charts.tsx:65`, `:112`; `Orcamento.tsx:24`.

**Continuam com `amount` cheio, de propósito:**

| Local | Motivo |
|---|---|
| `derive.ts:96` (`sum`), `:109`, `:114`, `:140` | fatura e planos: o banco cobra o valor cheio. **Não colocar o helper dentro de `sum`.** |
| `Dividas.tsx:146`, `:152`, `:158`, `:224`, `:225` | idem |
| `scripts/buffet:468`, `:475` (`card_bills`), `:578` (`plans`) | idem |
| `derive.ts:259`, `:287`; `scripts/buffet:729`, `:757` | preço da assinatura e vínculo: comparam com o preço cobrado |
| `Gastos.tsx:192`, `:218`, `:237`; `Hoje.tsx:180`; `Assinaturas.tsx:166`, `:265` | valor exibido na linha. As linhas de `Gastos.tsx:192` e `Hoje.tsx:180` ganham etiqueta + "sua parte". |

**Revisão semanal:** não achei esse recurso no repositório. O equivalente aqui é o `WeekPanel`, já coberto por `byDate`. Se ela roda pelo chat ou por uma rotina externa, precisa somar `effective_amount`; `sum(amount)` continuaria contando o valor cheio sem dar erro.

### Mudanças no app

- **`types.ts` e `store.ts:134-138`:** ler as colunas novas no `load`, somente leitura e fora do `toRow`, como `method` e `bill_month`. O `save` por diff continua sem tocar nelas.
- **`Hoje.tsx:111`:** linha "A receber" junto do saldo em caixa, só quando houver valor; ao tocar, abre um `Sheet` com a lista.
- **`Gastos.tsx:190-192` e `Hoje.tsx:177-180`:** etiquetas Dividido, Reembolso parcial e Reembolsado, mais "sua parte".
- **`Gastos.tsx:250`:** esconder "Excluir gasto" em linhas divididas e indicar o chat. O app não pode ajustar `cash_balance`, e o "desfazer" da exclusão regrava a linha só com o que está no `toRow`, perdendo a divisão.
- **`lib/csv.ts:11`:** `valor` continua cheio; entra a coluna `sua_parte`.

> **Bug existente, fora deste escopo:** esse mesmo "desfazer" já apaga `method`, `bill_month` e `debt_id` hoje. Um gasto no crédito excluído e restaurado some da fatura. Vale corrigir à parte.

### Ordem e verificação

1. Aplicar a migration (é aditiva), depois publicar o CLI, depois o PWA. Até o PWA novo sair, o app antigo mostra valores cheios.
2. Testar cada comando do CLI com `BUFFET_ROLLBACK=1`, que executa e desfaz.
3. Fazer um ciclo completo com uma linha fictícia de R$ 1,00, débito e crédito: lançar, dividir, reembolsar, parcial, desfazer e apagar. Conferir que o saldo volta ao valor inicial.
4. O `web` não tem script de testes: rodar `npm run build` e conferir à mão Hoje, Gastos (todas as visões), Orçamento e Dívidas.

## Perguntas em aberto

1. **O que a célula do calendário mostra?** O pedido diz que o calendário mostra o valor cheio e que os totais do dia contam só a sua parte, e a célula é as duas coisas. **Recomendo:** célula com valor cheio e um pontinho; a faixa de dias, o total do mês no calendário e o subtotal na lista com a sua parte. A consequência é que as células deixam de somar o total exibido. Isso exige passar um parâmetro em `monthDays` e o total separado para `MonthCalendar` (`Gastos.tsx:147`, `:362`). A alternativa, mais simples, é a célula também mostrar a sua parte, e o valor cheio aparecer só na lista ao tocar no dia.
2. **Parcelado dividido entra agora?** **Recomendo que sim, só com `--plan`:** `split --plan` marca todas as parcelas, e cada uma entra no A receber quando chega a data e é reembolsada individualmente. Sem isso, o CLI recusaria parcelas por enquanto.
3. **Só pelo chat nesta versão?** **Recomendo que sim.** No app, `cash_balance` é somente leitura e não há como atualizar o saldo junto com o reembolso em uma única operação. Um botão "Recebi" exigiria uma função no banco, o que pode ficar para depois se fizer falta.
