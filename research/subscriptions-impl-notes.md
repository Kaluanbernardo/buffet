# Assinaturas — notas de implementação (UI)

Estado em 2026-10-31: UI pronta no PWA. A migration **não foi aplicada** e **nada foi publicado**.

## 1. Aplicar a migration

O arquivo é `supabase/migrations/20261031120000_buffet_subscriptions.sql` (cria `buffet_subscriptions`,
`buffet_transactions.subscription_id`, `buffet_sub_advance`/`buffet_sub_roll`, RLS e a policy do bot).

```sh
scripts/buffet admin-sql "$(cat supabase/migrations/20261031120000_buffet_subscriptions.sql)"
```

Antes disso o app continua funcionando: o store detecta a tabela ausente (`subscriptionsReady = false`), a aba
Assinaturas mostra "migration pendente" e nada de assinatura é sincronizado. Depois de aplicar, basta recarregar o app.

## 2. Cadastrar o Meli+

```sh
buffet sub add 74,90 --name "Meli+" --cycle mensal --card Nubank --match meli --from-tx 5a5c6066-2e07-4a67-97f5-4a37e783cff1
```

Isso cria a assinatura a partir do gasto (data dele = início do ciclo; próxima = +1 mês) e vincula o gasto (↻ em Gastos).
Conferir com `buffet sub list`.

## 3. O que a UI faz

- **Dívidas › Assinaturas** (`#/dividas?tab=assinaturas`): controle segmentado `Parcelas | Assinaturas`.
  Total por mês (anual ÷ 12) e por ano, pills de estado (`subState`/`subDueLabel`: em N dias, cobra amanhã, venceu, não
  apareceu, pausada, cancelada), lista de ativas e de pausadas/canceladas.
- **Detalhe** (sheet): valor, próxima cobrança, aviso de preço diferente da última cobrança, histórico de cobranças e
  total no ano, Editar, Pausar/Retomar (retomar rola a próxima para depois de hoje), Cancelar (mostra "como cancelar").
- **Cobrou?** (aparece na linha a partir de `remind_days` antes): lançar a cobrança como gasto com `subscription_id`
  (opcionalmente atualizando o valor), vincular um gasto já lançado (`linkCandidates`: ±7 dias, ±15% ou merchant
  casando com `match`), ou "não cobrou" (pula o ciclo). Tudo com Desfazer.
- **Gastos**: ↻ ao lado do merchant quando o gasto tem `subscription_id`. O botão ⋯ abre ações: "Acompanhar como
  assinatura" (abre o form preenchido com merchant/valor/cartão/data e vincula esse gasto), "Ver assinatura",
  "Desvincular", "Excluir gasto" (antes era a lixeira direta).
- **Hoje › Próximos vencimentos**: parcelas + assinaturas ativas ainda não cobradas no ciclo (próxima em até 31 dias ou
  vencida), com ícone ↻, ordenadas por data, até 4 itens.

Assinatura é compromisso, nunca gasto: só a transação vinculada entra nos totais.

## 4. Pendências conhecidas

- Não há "excluir assinatura" na UI (cancelar cobre o caso; excluir fica no chat).
- O avanço de `next_due` no app usa `subAdvance` (espelho de `buffet_sub_advance`); se a função SQL mudar, atualizar os dois.
