# Assinaturas no Buffet — proposta

> Status: **proposta, nada implementado**. Nenhuma mudança de código, schema ou deploy.
> Data: 30/10/2026. Para o Kaluan aprovar ou pedir ajuste.

## 0. Resumo (para decidir rápido)

- **A cobrança no cartão continua sendo gasto.** Diferente da fatura (que é só dinheiro mudando de lugar e por isso saiu de `buffet_transactions`), os R$ 49,77 do Streaming X são consumo de verdade. Eles entram no total do mês **uma vez**, como hoje, na categoria Assinaturas.
- **A assinatura é um compromisso, não um lançamento.** Ela mora numa tabela nova, `buffet_subscriptions`, e diz o que se espera: nome, valor, ciclo, próxima cobrança, cartão e status. Ela **nunca soma** em gasto.
- **A ligação é uma coluna nova em `buffet_transactions`:** `subscription_id`. Um gasto ligado a uma assinatura é "a cobrança deste ciclo". Com isso, "já cobrou este mês?", histórico, preço que subiu e "não apareceu" são todos derivados, sem duplicar nada.
- **No app:** uma tela Assinaturas que se abre a partir de **Dívidas** (que vira "Compromissos: Parcelas | Assinaturas"). Ela também aparece em **Próximos vencimentos** no Hoje e como selo ↻ nos gastos ligados.
- **No chat:** `buffet sub add | list | charge | link | due | pause | cancel`, espelhando `expense` e `pay-bill`. O check-in avisa das cobranças dos próximos dias, de cobrança que não apareceu, de renovação anual e de preço que mudou.
- **Recomendação: opção A** (§4). O MVP cabe em uma migration aditiva e não mexe em nenhum cálculo de gasto.

---

## 1. Ponto de partida (o que existe hoje)

Lido em PRODUCT.md, DESIGN.md, `supabase/migrations/*`, `scripts/buffet`, `web/src/data/*` e `web/src/screens/*`.

| Peça | Estado | Relevância |
|---|---|---|
| `buffet_transactions` | gasto avulso: `date, amount, merchant, category, bank, note, source` | Streaming X já está aqui |
| `buffet_app_config.categories` | inclui **Assinaturas** (grupo *lifestyle* em `derive.ts`) | categoria já existe, tem orçamento próprio |
| `buffet_debts` | parcelas (`installments_paid/total`, `due_day`); hoje guarda até a "Fatura Nubank (vence 11, pagar 15)" como 1/1 | modelo de "vence dia X" que já tem UI (Dívidas, Próximos vencimentos) |
| `buffet_card_payments` | fatura ≠ gasto (opção B do `bill-payment-design.md`) | precedente: tabela própria e só leitura no app |
| `store.ts` | `Spec` por tabela. O `upsert` só manda as colunas do `toRow`, então **colunas que o app não conhece não são apagadas** | `subscription_id` sobrevive a uma edição pelo app antiga |
| Gastos | lista com busca, chips de categoria e **só a ação Excluir** por linha (não há detalhe nem edição) | "Transformar em assinatura" precisa de uma ação nova na linha |
| CLI | `expense`, `del`, `list`, `pay-bill`, `del-bill`. Um comando SQL por chamada, como role `bot` | os novos comandos seguem o mesmo molde (CTE atômica) |

**O lançamento real do Streaming X** (consulta só de leitura, 30/10):

```
id <id> · 2026-10-30 · R$ 49,77 · merchant "Streaming X"
category Assinaturas · bank "Cartão" · note "crédito (via Arnold)"
```

Dois detalhes que a proposta precisa resolver:
1. `bank = "Cartão"` **não diz qual cartão** (Nubank? Inter?). Para a assinatura isso importa, porque é o que liga a cobrança à fatura certa. → **pergunta para o Kaluan (§7).**
2. R$ 49,77 é mensal ou anual? O Streaming X tem planos de preços diferentes. → **pergunta (§7).** O exemplo abaixo assume **mensal**.

---

## 2. Benchmarks (rápido)

> A pesquisa web não foi autorizada nesta sessão. O que está abaixo vem do `research/finance-ui-benchmarks.md` (Copilot, Wallet, Spendee) e do conhecimento prévio dos apps. **Não foi revalidado ao vivo**, e detalhes de tela podem ter mudado.

| App | Como trata assinaturas | O que roubar |
|---|---|---|
| **YNAB** | *Scheduled transactions*: lançamento futuro com repetição, que aparece em cinza até a data e depois "entra". No cartão, a compra já reserva dinheiro para a fatura. | Assinatura = **lançamento esperado** que vira real ao ser confirmado. Não contar duas vezes. |
| **Rocket Money (Truebill)** | Detecta cobranças recorrentes pelo histórico e mostra uma lista com total mensal, próxima data e alerta de aumento de preço. Oferece cancelamento (EUA). | **Total "por mês"** no topo, **alerta de preço que subiu**, lista ordenada por próxima cobrança. |
| **Monzo** | "Subscriptions/Regular payments": agrupa as cobranças recorrentes do cartão e mostra a próxima prevista e o histórico por comerciante. | Cada assinatura tem **histórico das cobranças reais** (os gastos ligados). |
| **Nubank** | No extrato, a compra recorrente fica marcada. Há área de assinaturas/cartão virtual por serviço. | Selo discreto de **recorrente** no extrato, sem tirar a compra do extrato. |
| **Copilot Money** | Tela *Recurrings* (assinaturas + contas) com próxima data, valor e linha do tempo. Item que não apareceu fica sinalizado. | **"Não apareceu"** como estado. Linha do tempo única "próximos dias" (já sugerida em Hoje). |
| **Organizze / Mobills** | Despesa **fixa/recorrente** no cartão: o app projeta nas faturas futuras. Mobills tem lembretes de contas. | **Lembrete X dias antes**. Ciclo mensal/anual. Escolha do cartão. |
| **C6 / Inter** | Pouco além do extrato. C6 tem cartão virtual por assinatura; Inter tem a área "Assinaturas"/marketplace. | (pouco a copiar) Campo opcional "como cancelar". |

Padrão que se repete: **(1)** a compra continua no extrato, **(2)** a assinatura é uma visão por cima com próxima data e total mensal, **(3)** o valor da lista é um *alerta* (vai cobrar, não cobrou, subiu, renova).

---

## 3. Conceitos

| Coisa | O que é | Soma em gasto? |
|---|---|---|
| **Assinatura** (`buffet_subscriptions`) | contrato: "Streaming X, R$ 49,77/mês no Nubank, próxima em 30/11" | **não**, nunca |
| **Cobrança** (`buffet_transactions` com `subscription_id`) | o gasto real daquele ciclo, com valor e data reais | **sim**, uma vez, como qualquer gasto |
| **Pagamento de fatura** (`buffet_card_payments`) | o dinheiro saindo da conta para o cartão | não (já resolvido) |

O "custo mensal de assinaturas" mostrado na tela é uma **projeção** (anual ÷ 12), com legenda clara, e nunca entra no número herói do Hoje.

---

## 4. Opções

### Opção A — `buffet_subscriptions` + `subscription_id` no gasto ✅ recomendada

```sql
create table public.buffet_subscriptions (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default public.buffet_owner(),
  name text not null,                                   -- "Streaming X"
  amount numeric(12,2) not null check (amount > 0),     -- valor esperado por ciclo
  cycle text not null default 'monthly' check (cycle in ('monthly', 'yearly')),
  next_due date not null,                               -- próxima cobrança esperada
  bank text,                                            -- cartão/conta onde cai ("Nubank")
  category text not null default 'Assinaturas',         -- categoria do gasto gerado
  status text not null default 'active' check (status in ('active', 'paused', 'canceled')),
  remind_days int not null default 2 check (remind_days between 0 and 30),
  match text,                                           -- trecho do merchant p/ sugerir vínculo ("streaming")
  cancel_hint text,                                     -- "app ML › Streaming X › Cancelar" ou URL
  note text,
  started_on date, canceled_on date,
  source text not null default 'bot' check (source in ('app', 'bot')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.buffet_transactions
  add column subscription_id text references public.buffet_subscriptions (id) on delete set null;
create index on public.buffet_transactions (subscription_id) where subscription_id is not null;
-- RLS/grants iguais às outras buffet_*. Bot: select/insert/update (sem delete: cancela por status).
```

**Por que `next_due` guardado em vez de "dia X"?** Uma assinatura anual não cabe em `due_day`, e o dia real oscila (fim de mês, fim de semana). Quem registra a cobrança (app ou CLI) **avança** `next_due` em um ciclo, numa CTE só. O "dia" vira só exibição.

**Estados derivados (sem coluna):**
- **Cobrada neste ciclo**: existe gasto com `subscription_id` entre `next_due − 1 ciclo` e hoje (na prática, a última cobrança ligada avançou `next_due`).
- **Vence em N dias**: `next_due − hoje ≤ remind_days`.
- **Não apareceu**: `status = active` e `next_due < hoje − 3 dias`, sem cobrança ligada.
- **Preço mudou**: o valor da última cobrança ligada é diferente de `amount`.
- **Gasto no ano**: soma dos gastos ligados no ano (o histórico real).

**Prós**
- **Zero risco de contagem dupla**: assinatura não é linha de dinheiro, e o gasto continua onde já está. `monthSummary`, Orçamento, gráficos e CSV não mudam.
- Migration **aditiva**. O PWA atual ignora a coluna nova, e o `upsert` do `store.ts` não a apaga.
- O histórico, a mudança de preço e o "não apareceu" saem do vínculo, sem tabela extra.
- Transformar o Streaming X num gasto acompanhado é um `insert` + um `update`.

**Contras**
- Uma tabela nova (RLS, grants, `Spec` no `store.ts`, tipo) e uma coluna nova em `buffet_transactions` (incluir no `toRow` e no `load`).
- Avançar `next_due` é uma regra que o app e o CLI precisam aplicar igual. Mitigação: uma função SQL `buffet_sub_advance(id, charged_on)`, que os dois chamam ou copiam.

### Opção B — assinatura + tabela de cobranças própria (`buffet_subscription_charges`)

Igual à A, mas o vínculo é uma tabela N:1 (`subscription_id, transaction_id, cycle_month, status 'charged'|'skipped'`) em vez de coluna no gasto.

**Prós**
- `buffet_transactions` fica intocada.
- Dá para registrar ciclos **pulados** (mês grátis, pausado) explicitamente.

**Contras**
- Mais uma tabela, mais um `Spec`, joins na UI para mostrar o selo ↻ em Gastos.
- O estado "cobrada" pode divergir: apagar o gasto deixa a cobrança órfã, a menos que se use FK com cascade.
- Mais complexo do que um usuário único precisa agora. Os "pulados" são raros.

### Opção C — zero schema: reaproveitar `buffet_debts` + categoria

Cadastrar o Streaming X como "dívida" com `installments_total` alto (ex.: 999) e `due_day`, e acompanhar só pela categoria Assinaturas.

**Prós**
- Nenhuma migration. Aparece hoje mesmo em Dívidas e em Próximos vencimentos.

**Contras**
- Assinatura **não é dívida**. "Parcela 1 de 999", "saldo a pagar" e "livre em 2109" quebram os números do topo de Dívidas.
- Não tem ciclo anual, status pausada/cancelada, nem histórico real.
- Vínculo com o gasto só por texto/categoria: qualquer outro gasto em Assinaturas se confunde.
- Retrabalho certo quando a opção A vier.

### Comparação

| | A · tabela + coluna | B · tabela + cobranças | C · reusar dívidas |
|---|---|---|---|
| Contagem dupla no mês | impossível | impossível | impossível, mas polui Dívidas |
| Tamanho da mudança | médio | médio-grande | mínimo |
| Histórico / preço subiu / não apareceu | sim | sim | não |
| Mensal + anual + status | sim | sim | não |
| Toca em `buffet_transactions` | +1 coluna nula | não | não |
| Pronto para Open Finance (auto-vínculo) | sim (preenche `subscription_id`) | sim | não |

---

## 5. Fluxo concreto: Streaming X (opção A)

**Hoje** o Streaming X é só um gasto: `<id>`, 30/10, R$ 49,77, Assinaturas, bank "Cartão".

**Pelo chat** (Kaluan: "o Streaming X é assinatura mensal no Nubank"):

```bash
buffet sub add 49,77 --name "Streaming X" --cycle mensal --card Nubank --match streaming \
  --from-tx <id>
```

Em **um comando** (CTE): cria a assinatura com `next_due = 30/10 + 1 mês = 30/11`, faz o update do gasto (`subscription_id = <nova>` e, se vier `--card`, corrige `bank = 'Nubank'`) e imprime:

```
Streaming X · R$ 49,77/mês · Nubank · próxima 30/11 · ativa
vinculado: 30/10 R$ 49,77 (<id>)
```

**Pelo app:** Gastos › linha do Streaming X › menu ⋯ › **Acompanhar como assinatura** → sheet com o formulário já preenchido (nome = merchant, valor, cartão, ciclo mensal, próxima = data + 1 ciclo) → Salvar. Toast: "Streaming X agora é assinatura · próxima em 30/11 · Desfazer".

**Em 28/11** (`remind_days = 2`): o check-in do chat diz "Sábado cai o Streaming X, R$ 49,77 no Nubank". No Hoje, em Próximos vencimentos: `↻ Streaming X · Nubank · Em 2 dias · R$ 49,77`.

**Em 30/11**, um de três caminhos:
1. O chat lança `buffet expense 49,77 --merchant "Streaming X" --category Assinaturas --bank Nubank`. O CLI vê o `match` "streaming" numa assinatura ativa e **vincula sozinho**, avisando no stderr ("vinculado à assinatura Streaming X; próxima 30/12"). `--no-sub` evita isso.
2. O chat usa o atalho `buffet sub charge streaming`, que lança o gasto com os dados da assinatura e avança `next_due`.
3. No app, a linha da assinatura vencida mostra **"Cobrou?" → [Lançar R$ 49,77] [Vincular gasto…] [Não cobrou]**.

**Se em 03/12 nada apareceu:** estado "Não apareceu". O check-in pergunta "Streaming X não apareceu em 30/11. Cancelou ou ainda não lançou?"

**No total de novembro:** os R$ 49,77 contam **uma vez**, como gasto em Assinaturas. A tela Assinaturas mostra "R$ 49,77/mês" como **compromisso**, não soma.

---

## 6. UX no app

### 6.1 Onde mora — recomendação

**Dentro de Dívidas, com controle segmentado `Parcelas | Assinaturas`** (rota `/dividas/assinaturas`). O subtítulo de Dívidas já diz "compromissos em aberto": assinatura é a mesma família (coisa que vai cair), com a mesma linguagem de "Em 3 dias" e pills. Não precisa de uma sexta aba na barra de baixo (5 colunas em 390px já estão no limite).

| Alternativa | Por que não (agora) |
|---|---|
| Aba nova | 6 abas no celular apertam demais. Assinaturas é consulta de vez em quando, não diária. |
| Seção em Mais | Mais é "guardado/investido/config". Assinatura vence e cobra, então combina com Dívidas. Fica escondida. |
| Subaba em Gastos | Gastos é o extrato (passado). Assinatura é o que **vai** acontecer, e misturar confunde o total do período. |

**Opcional, para o Kaluan decidir:** renomear a aba "Dívidas" para **"Fixos"** ou "Compromissos". "Compromissos" provavelmente não cabe em 11px numa coluna de ~78px; "Fixos" cabe.

Pontos de contato fora da tela:
- **Hoje › Próximos vencimentos**: junta parcelas e assinaturas ativas numa lista só por data, com ícone ↻ nas assinaturas (é a "linha do tempo" já sugerida no benchmark do Copilot).
- **Gastos**: gasto com `subscription_id` ganha um selo ↻ ao lado do merchant. Tocar no selo abre o detalhe da assinatura.
- **Orçamento › Assinaturas** (depois do MVP): uma linha fina "comprometido R$ X/mês em N assinaturas" sob a barra da categoria.

### 6.2 Telas

**Lista (Assinaturas)**

```
┌───────────────────────────────────────────┐
│ Assinaturas                         [+ Nova] │
│ R$ 49,77/mês · 1 ativa                       │   ← anual ÷ 12, legenda "estimado"
│ R$ 10,29 por ano                            │
├───────────────────────────────────────────┤
│ Atenção                                      │   ← só aparece se houver
│  ⚠ Spotify subiu: 33,95 → 14,69              │
│  ⚠ Netflix não apareceu (dia 12)  [Cobrou?]  │
├───────────────────────────────────────────┤
│ Próximas                                     │
│  ↻ Streaming X          Nubank · mensal   R$ 49,77 │
│                   [Em 2 dias]                │
│  ↻ Anuidade X     Inter · anual    R$ 95,05 │
│                   [Renova 15/jan]            │
├───────────────────────────────────────────┤
│ Pausadas (0) · Canceladas (0)       ▸        │   ← recolhidas
└───────────────────────────────────────────┘
```

- Ordem: atenção > por `next_due`.
- Pills: `Em N dias` (warn se ≤ `remind_days`), `Cobrada 30/10` (ok), `Não apareceu` (negative), `Pausada`.
- No desktop, usa o mesmo `Columns` de Dívidas: resumo fixo à esquerda e lista à direita.
- Empty state: "Nenhuma assinatura acompanhada. Em Gastos, toque ⋯ num gasto recorrente e escolha *Acompanhar como assinatura*."

**Detalhe (sheet)**
- Cabeçalho: nome, valor/ciclo, cartão e status.
- "Próxima cobrança: 30/11 (em 31 dias)".
- **Histórico**: gastos ligados (data, valor), com o total do ano e o valor que mudou destacado.
- Ações: **Editar**, **Pausar/Retomar**, **Cancelar** (pede a data, guarda `canceled_on` e mantém o histórico), "Como cancelar" (`cancel_hint`), **Excluir** (só o app; desvincula os gastos, que continuam existindo).

**Adicionar / editar (sheet, mesmo molde do Novo gasto)**
- Valor primeiro (teclado decimal).
- Nome. Ciclo `Mensal | Anual` (segmentado). Próxima cobrança (data, com o padrão de hoje + 1 ciclo). Cartão (chips dos bancos ativos). Categoria (padrão Assinaturas). Lembrar `0 · 1 · 2 · 3 · 7` dias antes.
- Avançado (recolhido): trecho para reconhecer no merchant, como cancelar, nota.

**Cobrou? (ação na linha vencida)**
- **Lançar R$ 49,77**: cria o gasto (`merchant = name`, `category`, `bank`, `date = next_due`, `subscription_id`) e avança `next_due`. Toast com Desfazer.
- **Vincular gasto…**: lista gastos **sem vínculo** de ±5 dias, com valor ±15% ou merchant com o `match`. Tocar vincula e avança.
- **Não cobrou**: avança `next_due` sem gasto (mês grátis ou pulado). Opção de pausar.

### 6.3 Como o gasto e a assinatura se ligam visualmente (sem duplicar)

- O **gasto** é a única linha com dinheiro. Ele aparece em Gastos, em Hoje e no total, igual a hoje, com o selo ↻ "Streaming X".
- A **assinatura** mostra o **valor esperado** em tipografia `text-muted` e o rótulo "por mês". Quando já cobrou no ciclo, a pill vira "Cobrada 30/10" e o valor real aparece no histórico. O total da tela de Assinaturas é sempre "compromisso por mês", **nunca** "gasto".
- Em Próximos vencimentos (Hoje), só entram assinaturas **ainda não cobradas** no ciclo, então uma cobrança feita não aparece duas vezes na mesma tela.

---

## 7. Papel do bot (Buffet no chat)

### 7.1 CLI `buffet sub …`

Mesmo estilo do `expense`/`pay-bill`: um comando SQL por chamada (CTE quando há mais de uma escrita), `source='bot'`, datas `hoje/ontem/dd/mm`, valores `49,77`. `<sub>` aceita id ou nome/trecho (único, sem diferenciar acentos/maiúsculas).

```
ASSINATURAS (buffet_subscriptions — compromisso; o gasto real continua em buffet_transactions)
  buffet sub add <valor> --name X [--cycle mensal|anual] [--next d | --day N] [--card b]
                 [--category Assinaturas] [--remind 2] [--match t] [--cancel-hint t] [--from-tx <id>]
        cria; --from-tx vincula um gasto existente e calcula next_due = data dele + 1 ciclo
  buffet sub list [--all]                 ativas (ou todas) com próxima, estado e total/mês
  buffet sub charge <sub> [--date d] [--amount v] [--bank b]
        lança o gasto da cobrança (vinculado) e avança next_due — um comando
  buffet sub link <tx-id> <sub>           vincula um gasto existente e avança next_due
  buffet sub unlink <tx-id>               desfaz o vínculo (não mexe no next_due)
  buffet sub skip <sub>                   "não cobrou": avança next_due sem gasto
  buffet sub edit <sub> [--amount v] [--next d] [--card b] [--cycle c] [--remind n] [--name X]
  buffet sub pause|resume|cancel <sub> [--date d]
  buffet sub due [--days 7]               o que cobra nos próximos N dias + não apareceu + preço mudou
```

Mudanças no que já existe:
- `buffet expense` ganha `--sub <sub>` e, **sem a flag**, vincula sozinho quando o merchant bate com o `match` de **uma única** assinatura ativa com `next_due` a até ±7 dias. Ele avisa no stderr e aceita `--no-sub` para não vincular. Se bater em mais de uma, só avisa e não vincula.
- `buffet list` mostra `↻ Streaming X` na coluna nota/assinatura dos gastos ligados.
- O bot **não apaga** assinaturas (só cancela), igual ao princípio de grants mínimos de hoje.

### 7.2 Check-in e alertas

O que o chat deve lembrar, por prioridade:

| Quando | Mensagem (exemplo) |
|---|---|
| `next_due − hoje = remind_days` | "Sábado cai o Streaming X, R$ 49,77 no Nubank." |
| anual, 10 dias antes | "A anuidade X renova em 15/01 (R$ 16,04). Ainda vale a pena?" |
| `next_due` passou 3 dias sem vínculo | "Streaming X não apareceu em 30/11. Cancelou ou ainda não lançou?" → oferece `sub charge` ou `sub skip` |
| cobrança vinculada com valor ≠ `amount` | "Streaming X veio R$ 61,47 (era R$ 49,77). Atualizo o valor?" → `sub edit --amount` |
| alerta de fatura (já existe para a Fatura Nubank, vence 11) | "Na fatura do Nubank, R$ X são assinaturas (Streaming X, …)." Soma dos gastos ligados com `bank = Nubank` no período da fatura. |
| 1º dia do mês / check-in semanal | "Você tem N assinaturas ativas, R$ X/mês (Y% do orçamento de Assinaturas)." |
| gasto novo em Assinaturas sem vínculo | "Esse ‘Spotify’ é assinatura? Quer que eu acompanhe?" → `sub add --from-tx` |

A fonte é sempre `buffet sub due --days 7`. O chat não precisa calcular nada à mão.

---

## 8. MVP vs. depois

### Entra agora (MVP, opção A)
1. Migration aditiva: `buffet_subscriptions` + `buffet_transactions.subscription_id` + RLS/grants + função `buffet_sub_advance`.
2. CLI: `sub add` (com `--from-tx`), `list`, `charge`, `link`, `unlink`, `skip`, `edit`, `pause`/`resume`/`cancel`, `due`. Mais o `expense --sub` com o vínculo automático por `match`.
3. Migração do Streaming X (depois de confirmar o cartão e o ciclo, §9): `sub add … --from-tx <id>`.
4. App: tipo + `Spec` no `store.ts` (`subscription_id` também no `toRow`/`load` de transações). Tela Assinaturas em Dívidas (lista, detalhe, formulário, "Cobrou?"). Selo ↻ em Gastos e ação ⋯ › "Acompanhar como assinatura". Assinaturas em Próximos vencimentos no Hoje.
5. Check-in do chat com as 4 primeiras linhas da tabela 7.2.

Não muda: `monthSummary`, Orçamento, gráficos, CSV e `buffet_card_payments`.

### Depois
- **Sugestão automática sem Open Finance**: varrer o histórico por merchant + valor parecido em meses seguidos ("Spotify apareceu 3 meses seguidos. É assinatura?"). Dá para fazer no próprio app/CLI.
- **Orçamento**: linha "comprometido" na categoria Assinaturas; alerta quando as assinaturas sozinhas passam do limite.
- **Assinaturas em dólar** (IOF + câmbio): flag `amount_varies` e tolerância maior no "preço mudou".
- **Período de teste**: `trial_ends_on` e alerta "o teste do X acaba amanhã".
- **Ciclos extras**: trimestral/semestral (amplia o `check` de `cycle`).
- **Projeção na fatura**: "fatura Nubank de dezembro já tem R$ X comprometidos em assinaturas".
- **Push** (Web Push no PWA) para os lembretes; no MVP o lembrete é do chat e do Hoje.
- **Open Finance**: importar o extrato do cartão e vincular sozinho pelo `match`/valor, preenchendo `subscription_id`; o modelo da opção A já serve.
- Logo do serviço, link de cancelamento direto, divisão com outra pessoa (assinatura família).

---

## 9. Perguntas para o Kaluan

1. **Opção A** está ok? (tabela de assinaturas + vínculo no gasto, sem tirar o gasto do total)
2. **Streaming X**: é **mensal** ou **anual**? Em **qual cartão** cai? (o lançamento está como `bank = "Cartão"`)
3. **Onde mora**: dentro de Dívidas como `Parcelas | Assinaturas` está bom? Quer renomear a aba para **"Fixos"**?
4. **Vínculo automático** no `buffet expense` (quando o merchant bate com uma assinatura) ou prefere que o chat sempre pergunte?
5. **Lembrete padrão**: 2 dias antes está bom? E para as anuais, 10 dias?
6. Tem outras assinaturas para cadastrar já no MVP (streaming, música, nuvem, academia…)?
