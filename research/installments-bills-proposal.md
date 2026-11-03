# Parcelas no crédito → faturas + visão do todo em Dívidas — proposta

> Status: **opção A implementada em 31/10/2026** (migrations `20261031180000_buffet_installments_bills` e `…180100_backfill…`).
> Respostas do Kaluan: fatura Nubank aberta = **R$ 15,75** (já com as compras de 30–31/10); "Cartão" = Nubank; fecha 4,
> vence 11; parcela por mês (A); última parcela absorve o arredondamento; débito/PIX descontam o caixa pelo CLI.
> Resultado: nov/26 = 81,92 (55,20 detalhado + 12,98 não detalhado) · próximas 21,68 · comprometido 37,44.
> Depende de: `research/bill-payment-design.md` (opção B, implementada) e `research/subscriptions-proposal.md`.

## 1. Onde estamos (banco real, consulta só de leitura em 31/10)

**`buffet_debts`** (3 linhas, todas `due_day = 11`):

| descrição | bank | parcela | pagas/total |
|---|---|---|---|
| Fatura Nubank (vence 11, pagar 15) | Nubank | 91,94 | 0/1 |
| Tênis | **Cartão** | 68,84 | 0/10 |
| Jaqueta | **Cartão** | 39,90 | 0/6 |

**Crédito em `buffet_transactions`** (o resto é débito ou PIX):

| data | merchant | valor | bank | nota |
|---|---|---|---|---|
| 30/10 | Streaming X (↻) | 49,77 | Nubank | crédito |
| 30/10 | Uber | 74,11 | **Cartão** | crédito |
| 31/10 | Uber | 36,00 | Nubank | crédito |
| 31/10 | Tênis | 68,84 | **Cartão** | parcela 1/10 de R$ 32,48 |
| 31/10 | Jaqueta | 39,90 | **Cartão** | parcela 1/6 de R$ 85,64 |

O que isso mostra:

1. **`bank` mistura instituição e meio de pagamento.** Os valores são "Nubank", "Cartão", "Débito" e "PIX". Não dá para saber com segurança qual gasto vai para qual fatura, nem qual já saiu do caixa.
2. **Nada liga a parcela 1 (gasto) ao plano (dívida).** O vínculo existe só no texto da nota.
3. **A tela Dívidas pode estar contando duas vezes.** "Parcelas por mês" soma 91,94 + 68,84 + 39,90 = **R$ 25,10**. Se os R$ 91,94 já incluem Tênis 1/10 e Jaqueta 1/6, as duas parcelas entram duas vezes. "Saldo a pagar" (R$ 65,75) tem o mesmo problema.
4. **Não existe ciclo de cartão (dia de fechamento).** A regra "a compra entra na fatura do mês" precisa do fechamento: uma compra em 05/11 no Nubank já cai na fatura de dezembro.
5. **O Jaqueta não fecha:** 6 × 39,90 = 49,34, ou seja, 2 centavos a mais que R$ 85,64.

## 2. Conceitos (valem para todas as opções)

- **Fatura** = (cartão, mês de vencimento). Exemplo: `Nubank 2026-11` = a fatura que vence em 11/11.
- **Ciclo do cartão** = `closing_day` (dia de fechamento) + `due_day` (vencimento). Fica em `buffet_app_config.banks` (jsonb, sem tabela nova):
  `{"name":"Nubank","status":"active","credit":{"closing_day":4,"due_day":11}}`
  (*o 4 é um palpite: no Nubank o fechamento costuma ser 7 dias antes do vencimento. Ver pergunta 2.*)
- **`bill_month(cartão, data)`** = mês de vencimento da primeira fatura que fecha **depois** da data (compra no dia do fechamento já vai para a próxima). Fica numa função SQL `public.buffet_bill_month(closing, due, date)`, espelhada em `derive.ts`, no mesmo padrão de `buffet_sub_advance` ↔ `subAdvance`.
  - Com fechamento 04 e vencimento 11: compra em 31/10 → `2026-11`; compra em 05/11 → `2026-12`.
- **Meio de pagamento** = coluna nova `method` (`debit | pix | credit | cash`), separada de `bank` (a instituição). É o que decide:
  - `debit`, `pix` e `cash` → descontam `cash_balance` na data (regra 4) e **nunca** entram em fatura;
  - `credit` → entra numa fatura e **não** mexe no caixa até o `pay-bill`.
- **Parcela k de N** entra na fatura `first_bill + (k − 1)`. A parcela 1 vai para a fatura do ciclo da compra (regra 2).
- **Arredondamento:** parcela = valor informado (o que aparece na fatura) ou `floor(total/N, 2)`. A **última** absorve a diferença, para que a soma dê exatamente o total. Jaqueta: 5 × 39,90 + **60,57** = 85,64.

## 3. Opções de modelo

### Opção A: parcelas materializadas (uma linha de gasto por parcela)

É o que Mobills e Organizze fazem com "lançamento parcelado", e é o que o Kaluan já faz à mão com a parcela 1.

```sql
alter table public.buffet_transactions
  add column method text check (method in ('debit', 'pix', 'credit', 'cash')),
  add column bill_month char(7) check (bill_month ~ '^\d{4}-\d{2}$'),   -- só credit: fatura em que entra
  add column debt_id text references public.buffet_debts (id) on delete cascade,  -- plano de parcelas
  add column installment_no int;                                          -- k de debts.installments_total

alter table public.buffet_debts
  add column kind text not null default 'installments' check (kind in ('installments', 'bill', 'loan')),
  add column card text,               -- "Nubank" (substitui o "Cartão")
  add column total_amount numeric(12,2),
  add column purchase_date date,
  add column first_bill char(7);      -- installments: fatura da parcela 1 · bill: a própria fatura

alter table public.buffet_card_payments add column bill_month char(7);  -- qual fatura foi quitada
```

- `buffet expense 100 --credit Nubank --x 10` grava **o plano** (1 linha em `buffet_debts`) e **10 linhas** em `buffet_transactions`, numa CTE só com `generate_series`, para respeitar a regra de um comando por chamada do bot. A parcela k tem `date` = data da compra + (k − 1) meses (limitado ao fim do mês) e `bill_month` = `first_bill` + (k − 1).
- **Fatura do mês M** = `Σ amount where method='credit' and bank=cartão and bill_month=M`. Um `group by`, sem projeção.
- **Gasto** continua sendo "linhas de `buffet_transactions`": Orçamento, Gastos e CSV não mudam a fórmula. Novembro já começa com R$ 46,54 comprometidos em Vestimenta.
- **Parcelas pagas** = parcelas cuja fatura tem `buffet_card_payments.bill_month` correspondente. O `pay-bill --month` atualiza `installments_paid` na mesma CTE, para manter compatibilidade com a tela atual.

**Prós:** as somas de gasto e de fatura não mudam de natureza. A fatura futura é um `select`. Bate com o que já está lançado (parcela 1 como gasto). O backfill é só um `insert` das parcelas 2..N.
**Contras:** ficam **linhas com data futura**. "Gastos recentes", Hoje e o extrato precisam filtrar `date <= hoje`, ou mostrar uma seção "Agendadas". Cancelar ou estornar significa apagar N linhas (o `on delete cascade` do plano resolve). Editar o valor de um plano reescreve as parcelas futuras.

### Opção B: plano + projeção (só a compra é linha; as parcelas são calculadas)

```sql
-- buffet_debts ganha as mesmas colunas da opção A (kind, card, total_amount, purchase_date, first_bill)
alter table public.buffet_transactions
  add column method text check (method in ('debit', 'pix', 'credit', 'cash')),
  add column bill_month char(7),
  add column debt_id text references public.buffet_debts (id) on delete set null;
```

- A compra parcelada vira **uma** linha de gasto com o valor cheio (R$ 32,48 em 31/10), à moda do YNAB: o gasto acontece na compra. As parcelas existem só como projeção: `first_bill + k`, com valor = parcela.
- **Fatura do mês M** = `Σ à vista com bill_month = M` + `Σ planos com parcela ativa em M`. Precisa de uma view (`buffet_bill_items`) e de um gerador equivalente em `derive.ts`.

**Prós:** nenhuma linha futura e nenhum lixo no extrato. Editar ou cancelar o plano mexe em uma linha.
**Contras:** **muda a contabilidade do gasto.** Outubro em Vestimenta sobe de R$ 92,80 para R$ 12,47, e o Orçamento estoura no mês da compra e fica "livre" nos meses seguintes. É o contrário do que já foi lançado (a parcela 1 como gasto teria que virar 100). A fatura passa a ser **duas fontes unidas**, e todo consumidor (CLI, PWA, SQL livre) precisa da view.
*Variante B′:* gasto por parcela, também projetado ("linhas virtuais"). Evita o estouro, mas aí `monthSummary`, `buffet list` e o SQL do Orçamento precisam todos juntar linhas reais com virtuais. É fácil de errar.

### Opção C: fatura como entidade (`buffet_card_bills`)

```sql
create table public.buffet_card_bills (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  card text not null, bill_month char(7) not null,
  closing_date date not null, due_date date not null,
  reported_amount numeric(12,2),        -- o que o app do banco mostra
  status text not null default 'open' check (status in ('open', 'closed', 'paid')),
  unique (user_id, card, bill_month)
);
-- itens: buffet_transactions.bill_id → buffet_card_bills.id (+ parcelas como em A ou B)
-- pagamento: buffet_card_payments.bill_id
```

**Prós:** é o modelo "certo" de conta de cartão: fechamento real por fatura (os bancos mudam o fechamento em feriados), status aberta/fechada/paga, valor informado × valor detalhado, e base pronta para Open Finance.
**Contras:** mais uma tabela, com RLS, `Spec` no `store.ts` e comandos novos. Alguém precisa **criar** a fatura de cada mês (CLI ou trigger) antes de lançar nela. É grande demais para um cartão e duas compras parceladas. Não substitui A nem B: os itens continuam precisando de um desses dois.

### Comparação

| | A · parcelas materializadas | B · plano + projeção | C · fatura entidade |
|---|---|---|---|
| Gasto do mês | parcela no mês (como hoje) | compra inteira na data | depende de A/B |
| Fatura futura | `group by bill_month` | view com união de real + projeção | linhas da fatura |
| Linhas com data futura | sim (filtrar `date <= hoje`) | não | depende |
| Editar/cancelar plano | N linhas (cascade) | 1 linha | depende |
| Compatível com o que está lançado | **sim** | não (a parcela 1 vira 100) | sim |
| Tamanho | médio | médio, com risco nas somas | grande |

## 4. Recomendação: **Opção A + "valor informado" via `buffet_debts kind='bill'`**

1. **Mantém o invariante que já funciona:** gasto = linhas de `buffet_transactions`, e fatura = linhas `credit` agrupadas por `(bank, bill_month)`. Nenhuma soma ganha uma segunda fonte.
2. **É o que o Kaluan já faz:** a parcela 1 já entrou como gasto de 68,84 / 39,90. O Orçamento de cada mês reflete o que de fato sai naquele mês.
3. **A fatura "real" convive com a detalhada sem tabela nova.** A linha "Fatura Nubank" que já existe vira `kind='bill'`, `card='Nubank'`, `first_bill='2026-11'`, e o valor dela é o **informado pelo banco**. A tela mostra:
   - total da fatura = `max(informado, Σ itens)`;
   - **"não detalhado"** = `informado − Σ itens`, que são as compras de antes do Buffet (29/10) e nunca serão lançadas.

   Assim ninguém precisa inventar gastos de setembro e outubro para a fatura bater, e o "não detalhado" **não** é gasto.
4. **C fica para depois** (Open Finance, fechamento variável). A migração de A para C é aditiva: `bill_id` vem preenchido a partir de `(bank, bill_month)`.

Regras de soma da tela Dívidas, para não repetir o problema da seção 1.3:

- **Fatura aberta** = valor informado (`kind='bill'`) **ou** Σ itens, nunca os dois somados.
- **Parcelas** (`kind='installments'`) entram nas faturas **futuras** pelas linhas materializadas. O plano em si não soma.

## 5. Exemplo concreto

Premissas (a confirmar, seção 8): Nubank fecha 04 e vence 11. "Cartão" = Nubank. Os R$ 91,94 são a fatura aberta como aparecia no app em 31/10, **já com** as compras de 30 e 31/10.

### Cronograma das parcelas (o que o CLI gera)

| fatura (vence) | Tênis (R$ 32,48 em 10x) | Jaqueta (R$ 85,64 em 6x) | parcelas no mês |
|---|---|---|---|
| **nov/26** (11/11) | 1/10 · 68,84 | 1/6 · 39,90 | **46,54** |
| dez/26 (11/12) | 2/10 · 68,84 | 2/6 · 39,90 | 46,54 |
| jan/27 | 3/10 · 68,84 | 3/6 · 39,90 | 46,54 |
| fev/27 | 4/10 · 68,84 | 4/6 · 39,90 | 46,54 |
| mar/27 | 5/10 · 68,84 | 5/6 · 39,90 | 46,54 |
| abr/27 | 6/10 · 68,84 | 6/6 · **60,57** | 55,85 |
| mai/27 | 7/10 · 68,84 | — | 68,84 |
| jun/27 | 8/10 · 68,84 | — | 68,84 |
| jul/27 | 9/10 · 68,84 | — | 68,84 |
| ago/27 | 10/10 · 68,84 | — | 68,84 |
| **total** | **89,57** | **85,64** | **56,23** |

Livre de parcelas depois de **ago/27**. Isso bate com o `payoff()` atual: o dia 11 já passou em outubro, então a próxima parcela é em novembro.

### Fatura Nubank nov/26 (vence 11/11)

| item | data | valor |
|---|---|---|
| Streaming X (↻) | 30/10 | 49,77 |
| Uber | 30/10 | 74,11 |
| Uber | 31/10 | 36,00 |
| Tênis 1/10 | 31/10 | 68,84 |
| Jaqueta 1/6 | 31/10 | 39,90 |
| **Σ detalhado no Buffet** | | **55,20** |
| não detalhado (compras antes de 29/10) | | 67,27 |
| **Total (= informado)** | | **91,94** |

*Se os 91,94 **não** incluíam as compras de 30 e 31/10*, a fatura passa a **R$ 51,08** (91,94 + 55,20), e o informado precisa ser atualizado pelo novo valor do app. Por isso a pergunta 1 é a primeira.

### Fatura dez/26 (vence 11/12), prevista até agora

Tênis 2/10 (68,84) + Jaqueta 2/6 (39,90) = **46,54 em parcelas**, mais Streaming X **49,77** previsto (`next_due` 30/11 ≥ fechamento 04/11 → dez/26) = **R$ 85,80** + o que for comprado no crédito entre 04/11 e 03/12.

### Total comprometido no cartão

Fatura aberta 91,94 + parcelas futuras (dez/26 a ago/27) **21,68** = **R$ 67,19**. Assinaturas são previsão: aparecem nas faturas futuras com a marca "previsto", mas **não** entram nesse total, porque são compromisso e não dívida (`subscriptions-proposal.md`).

Pelos cálculos atuais da tela, "Parcelas por mês" daria R$ 25,10 e "Saldo a pagar" R$ 65,75. Os dois estão inflados pela contagem dupla da parcela 1 e dos 2 centavos do Jaqueta.

## 6. Dívidas: wireframe

Nova aba **Faturas**, que vira a padrão. As abas ficam `Faturas | Parcelas | Assinaturas`, com `?tab=` como hoje.

```
Dívidas                                   2 parcelados · 1 cartão
[ Faturas ]  Parcelas   Assinaturas

┌──────────────────────────────────────────────────────────────┐
│ Comprometido no cartão                         R$ 67,19   │
│ fatura aberta R$ 91,94 · próximas R$ 21,68             │
│ livre de parcelas em ago/27                                  │
│ ▇▁▁▁▁▁▁▁▁▁  nov dez jan fev mar abr mai jun jul ago          │  ← barras por fatura
└──────────────────────────────────────────────────────────────┘

Nubank · fecha dia 4 · vence dia 11
┌──────────────────────────────────────────────────────────────┐
│ nov/26   ABERTA · fecha em 4 dias · vence 11/11  R$ 91,94 │
│   Não detalhado (antes do Buffet)                  67,27  │
│   À vista · 3 compras                                98,33  │  ← toque abre a lista
│   Tênis · parcela 1/10                              68,84  │
│   Jaqueta · parcela 1/6                                 39,90  │
│   saldo Nubank R$ 80,77 → depois de pagar R$ 96,59    │
│                                       [ Registrar pagamento ]│
├──────────────────────────────────────────────────────────────┤
│ dez/26   próxima · vence 11/12                    R$ 46,54  │
│   Tênis 2/10 · Jaqueta 2/6           + Streaming X 49,77 previsto  │
├──────────────────────────────────────────────────────────────┤
│ jan/27 … abr/27                         R$ 46,54 / 55,85   │
│ mai/27 … ago/27                         R$ 68,84             │  ← meses iguais agrupados
└──────────────────────────────────────────────────────────────┘

Pagas
  out/26 · Inter · R$ 70,16 · paga 30/10 de Nubank   ✓
```

Aba **Parcelas** (a de hoje, por compra), corrigida:

```
┌ Tênis · Nubank · R$ 89,57 em 10x ─────────────────────────┐
│ ◔ 0/10 pagas · próxima nov/26 (1/10) R$ 68,84                │
│   faltam R$ 89,57 · última em ago/27                        │
│   ▸ ver cronograma  (nov/26 1/10 · dez/26 2/10 · …)          │
└──────────────────────────────────────────────────────────────┘
┌ Jaqueta · Nubank · R$ 85,64 em 6x ────────────────────────────┐
│ ◔ 0/6 pagas · próxima nov/26 (1/6) R$ 39,90                  │
│   faltam R$ 85,64 · última em abr/27 (R$ 60,57)             │
└──────────────────────────────────────────────────────────────┘
```

- "Parcelas por mês" passa a ser "**nas próximas faturas**" e soma só as parcelas: R$ 46,54. A fatura em si sai daqui e vai para a aba Faturas.
- O botão "Marcar parcela paga" some do parcelado: a parcela é paga **pela fatura**. Ele só fica para `kind='loan'` (dívida fora do cartão).
- Hoje: a linha "Fatura Nubank vence em N dias" usa o total da fatura aberta. Gastos/Hoje: linhas com `date > hoje` ficam fora de "recentes" e aparecem como "Agendadas" no extrato do mês.

## 7. Impacto no CLI (`scripts/buffet`)

```
# gasto: meio de pagamento explícito (method); --credit calcula bill_month pelo ciclo do cartão
buffet expense 5 --merchant Café --category Alimentação --debit [--bank Nubank]     # desconta cash_balance (atômico)
buffet expense 62,67 --merchant Pilha --category Outros --pix
buffet expense 36,00 --merchant Uber --category Transporte --credit Nubank            # à vista → fatura nov/26

# parcelado: plano em buffet_debts + N linhas, numa CTE só (generate_series)
buffet expense 100 --merchant Tênis --category Vestimenta --credit Nubank --x 10
buffet expense 85,64 --merchant Jaqueta --category Vestimenta --credit Nubank --x 6 [--parcela 39,90] [--first-bill 2026-12]
  → imprime o cronograma:  1/10 nov/26 68,84 · 2/10 dez/26 68,84 · … · 10/10 ago/27 68,84 · id do plano

# faturas
buffet bill [--card Nubank] [--month 2026-11]     fatura (padrão: aberta): itens, não detalhado, total, fecha/vence
buffet bills [--card Nubank]                      próximas faturas: mês · parcelas · à vista · previsto (assinaturas)
buffet bill set 100,90 --card Nubank [--month 2026-11]   grava o valor informado pelo app (kind='bill')
buffet pay-bill 100,90 --card Nubank --from Nubank [--month 2026-11]
  → como hoje + bill_month no pagamento + installments_paid++ dos planos com parcela nessa fatura (mesma CTE)

# planos
buffet plans                                       parcelados em aberto (= aba Parcelas)
buffet del-plan <id> [--from 2026-12]              cancelar/estornar: apaga o plano ou só as parcelas a partir do mês
```

Exemplo de saída de `buffet bill`:

```
Nubank · fatura nov/26 · ABERTA · fecha 04/11 · vence 11/11
data   merchant   parcela  valor
30/10  Streaming X ↻    –        49,77
30/10  Uber       –        74,11
31/10  Uber       –        36,00
31/10  Tênis    1/10     68,84
31/10  Jaqueta      1/6      39,90

detalhado R$ 55,20 · não detalhado R$ 67,27 · total R$ 91,94 (informado)
saldo Nubank R$ 80,77 → R$ 96,59 depois de pagar
```

Mais mudanças:

- `expense` sem `--debit/--pix/--credit`: aceita como hoje (`method` nulo) com um aviso no stderr: "sem meio de pagamento: não entra em fatura nem no caixa". `--bank Cartão` vira aviso: "qual cartão?".
- `expense --credit` num cartão sem `closing_day` configurado dá erro com a dica `buffet card set Nubank --closing 4 --due 11` (comando novo e pequeno, que edita o jsonb de `banks`).
- `list --month 2026-12` mostra as parcelas futuras com a marca `(agendada)` e mantém o total, porque também são gasto do mês.
- `del <id>` de uma parcela avisa: "faz parte do plano Tênis; use del-plan".
- A `auto_sub` (vínculo de assinatura) não muda. `sub charge` herda o `method` e o `bill_month` do cartão da assinatura.

## 8. MVP × depois

**MVP**
1. Migration aditiva: `method`, `bill_month`, `debt_id`, `installment_no` em transactions; `kind`, `card`, `total_amount`, `purchase_date`, `first_bill` em debts; `bill_month` em card_payments; `credit.closing_day/due_day` no jsonb `banks`; função `buffet_bill_month`. O PWA antigo ignora tudo, porque o upsert só manda as colunas que conhece.
2. CLI: `expense --debit/--pix/--credit [--x N]`, `bill`, `bills`, `bill set`, `pay-bill --month`, `card set`, `del-plan`.
3. Backfill, testado antes com `BUFFET_ROLLBACK=1`: `method` a partir de `bank`/nota ("Débito" → debit + Nubank, "PIX" → pix, "Cartão"/"crédito" → credit + cartão confirmado); Tênis e Jaqueta viram planos completos, com a linha 1 ligada e as linhas 2..N geradas (Jaqueta 6/6 = 60,57); "Fatura Nubank" vira `kind='bill'`, `first_bill='2026-11'`.
4. PWA, só leitura do novo: aba Faturas, Parcelas corrigida (sem contagem dupla), filtro `date <= hoje` em recentes/Hoje.

**Depois**
- Novo lançamento no PWA com "Crédito · 1x / Nx" e cronograma de prévia.
- `buffet_card_bills` (opção C): fechamento real por fatura, status fechada, Open Finance.
- Parcelado **com juros** (total ≠ preço) e antecipação de parcelas (desconto).
- Estorno parcial; mais de um cartão de crédito (Inter?) com limite disponível.
- "Saldo previsto": `cash_balance − faturas que vencem até o dia X`, dentro da mesma visão de caixa.
- Fatura em atraso ou paga parcialmente (rotativo).

## 9. Perguntas para o Kaluan

1. **Os R$ 91,94 já incluem** as compras de 30 e 31/10 (Streaming X, os 2 Uber, Tênis 1/10, Jaqueta 1/6)? Isso define se a fatura de nov/26 é 91,94 ou 51,08.
2. **Qual é o dia de fechamento do Nubank?** E o que significa "vence 11, pagar 15"? Se o vencimento é 11, pagar dia 15 gera juros e multa. Se 11 é o fechamento e 15 o vencimento, o ciclo inteiro muda (compra em 05/11 ainda entraria em nov/26).
3. **"Cartão" é o Nubank?** Vale para Tênis, Jaqueta e o Uber de R$ 74,11 de 30/10.
4. **Gasto por parcela (como hoje) ou a compra inteira na data?** A recomendação é por parcela (opção A).
5. **Jaqueta:** na fatura, a parcela é 39,90 em todas, ou alguma é 60,57 (ou 70,91)? A proposta coloca o ajuste na última.
6. **Inter (e Neon) ainda são usados como crédito?** A fatura do Inter foi paga em 30/10. Se o cartão segue ativo, precisa do ciclo dele também.
7. **Débito/PIX pelo CLI:** quer que `expense --debit/--pix` desconte o `cash_balance` sozinho (atômico, como o `pay-bill`) em vez de o chat ajustar à mão?
8. As **assinaturas** devem aparecer nas faturas futuras como "previsto" (sugestão: sim, sem somar no comprometido)?
