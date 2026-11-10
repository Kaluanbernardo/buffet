# Sincronização diária com o Meu Pluggy

`scripts/buffet pluggy-sync` lê as contas e o cartão no Pluggy, grava só o que é novo e atualiza o caixa pelo saldo da conta.
Todos os valores e nomes aqui são fictícios.

```bash
scripts/buffet pluggy-sync --dry-run             # lê Pluggy e banco, mostra as contagens, não grava nada
scripts/buffet pluggy-sync                       # grava
scripts/buffet pluggy-sync --days 60 --verbose   # janela maior e lista dos gastos novos
```

A janela padrão é de 45 dias. Compras parceladas com data futura vêm junto.

## Credenciais

| O quê | Onde |
|---|---|
| Client id | `/home/box/.pluggy-client-id` |
| Client secret | variável de ambiente `PLUGGY_CLIENT_SECRET` |
| Itens | `/home/box/.pluggy-item-ids`, um id por linha |

O conector do Meu Pluggy não diz qual é o banco. Sem indicação, o item vale como a conta do saldo (`cash_balance_bank`). Com mais
de um banco, ponha o nome depois do id: `<ITEM_ID> Inter`. Nenhum desses valores é impresso, nem em mensagem de erro.

## O que cada transação vira

| Transação | Resultado |
|---|---|
| Débito ou PIX na conta | gasto (`method = debit` ou `pix`, sem mexer no caixa) |
| Compra no cartão | gasto `credit` na fatura do Pluggy (`billId`) ou, sem ela, na do ciclo do cartão |
| Compra parcelada | uma linha por parcela, ligadas a um plano `pluggy-plan-<hash>` em `buffet_debts` |
| Transferência entre contas próprias | ignorada |
| Pagamento de fatura, boleto de outro cartão | `buffet_card_payments`, com as mesmas atualizações do `buffet pay-bill` |
| Pagamento recebido no cartão | ignorado, já contou pela conta |
| Investimento, resgate, quitação de empréstimo, boleto `NU PAGAMENTOS` | ignorado |
| Outra entrada na conta | soma em `buffet_incomes` do mês |
| Compra e estorno novos, casados | nenhum dos dois entra |
| Estorno de gasto já lançado | fica em **Estornos recebidos** para você decidir, o gasto continua |
| Estorno sem compra | ignorado |

Estorno casa com compra de mesmo valor, de 1 dia antes até 30 dias depois. Cada compra casa com um estorno só.

## Categoria e nome

A primeira regra que se aplica decide: o que você já usou para aquela descrição do banco, Pet e Impostos por palavra, a
categoria do Pluggy, as regras por palavra, Outros. Só sai categoria da sua lista. Do histórico vale o nome mais frequente, para um
renome pontual não virar o nome de todas as próximas compras.

## Possível duplicata

Antes de criar um gasto, o sync procura um lançamento que não veio do Pluggy (notificação, chat ou app) com **mesmo valor, data a
até 3 dias e mesmo banco**. Lançamento sem banco também casa. Uma notificação com o total de uma compra parcelada casa com a
primeira parcela.

Achou: o novo entra com `review_status = 'pending'` e `possible_duplicate_of`, e aparece em `buffet pending` e na caixa Pendentes.
Como todo pendente, ele conta nos totais até você decidir. `buffet confirm` mantém os dois e `buffet discard` apaga o novo. Depois de
descartado, ele não volta. Pagamento de fatura igual a um já lançado é ignorado, porque pagamento não tem estado pendente.

## Caixa

`cash_balance` recebe o saldo das contas `BANK` do banco do saldo. Dois ajustes evitam erro de horário:

- O que saiu **depois** da última leitura do Pluggy (débito ou PIX por notificação, chat ou app) é descontado, porque o saldo ainda não sabe.
- O que veio **antes** já está no saldo, então o `cash_debited` desses pendentes zera. Assim, descartar um deles não devolve dinheiro que o saldo já contou.

Se o item não estiver `UPDATED` no Pluggy, o sync importa, avisa e não mexe no caixa. Editar o valor de um pendente depois que
o `cash_debited` zerou desconta o caixa outra vez; a sincronização seguinte corrige.

## Dividido e reembolso

As regras continuam as de sempre: `amount` fica cheio, e parcela de plano não se divide. O sync nunca divide nem registra reembolso
sozinho, só avisa em duas contagens: gasto cuja descrição já foi dividida antes e entrada igual a um valor a receber. Para registrar
um reembolso que já está no saldo, use `buffet reimburse <gasto> --no-cash`.

## Idempotência

`buffet_pluggy_seen` guarda uma linha por transação do Pluggy, inclusive a que não vira gasto, e cada efeito é gravado no mesmo comando SQL
que o registro. Repetir não conta duas vezes, e o que você apagou ou descartou não volta.

**Primeira execução:** com o ledger vazio, o que o Pluggy criou até o fim do import inicial é só registrado, como `baseline`.

## Ligar (uma vez)

1. Conferir e aplicar a migration `20261110190000_buffet_pluggy_sync.sql`:
   ```bash
   scripts/apply_migrations_https.py --dry-run
   scripts/apply_migrations_https.py
   ```
2. Rodar `scripts/buffet pluggy-sync --dry-run` e depois `scripts/buffet pluggy-sync`.
3. Agendar uma vez por dia, depois da atualização automática do Meu Pluggy, com o segredo vindo de um arquivo fora do repositório:
   ```cron
   0 18 * * * . <ARQUIVO_COM_O_SEGREDO>; <REPO>/scripts/buffet pluggy-sync >> <LOG> 2>&1
   ```

## Testes

```bash
python3 -B -m unittest discover -s scripts/tests      # regras, com dados fictícios
cd web && npx vitest run tests/pluggy-sync.test.ts    # CLI e SQL de verdade no PGlite, Pluggy falso
```

## Limitações

- O Pluggy só atualiza uma vez por dia. Gasto de hoje pode aparecer amanhã.
- Não é certo que uma compra pendente mantenha o id ao ser publicada. Se o id mudar, a nova entra como possível duplicata da antiga.
- Mudança de valor ou data numa transação já importada não é aplicada: só o que é novo entra.
- Não há vínculo automático com assinatura.
- Lançamento manual com `--no-cash` feito depois da última leitura ainda desconta no ajuste do caixa, até a próxima sincronização.
