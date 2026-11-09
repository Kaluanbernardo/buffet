# Captura automática de gastos pelas notificações do Android

O MacroDroid lê cada notificação do app do banco e manda por HTTPS para uma Edge Function do Supabase. A função entende a
notificação e, se for compra ou PIX enviado, cria um **gasto pendente de revisão**. O gasto entra nos totais na hora (com
marcador) e você confirma, ajusta ou descarta depois, no PWA ou no chat.

```
Nubank (notificação) → MacroDroid (HTTP POST + segredo) → Edge Function buffet-ingest-notification
  → buffet_notification_inbox (payload bruto)  → buffet_transactions (review_status = 'pending')
                                                  → revisão: PWA (Hoje › Pendentes) ou CLI (buffet pending | review | confirm | discard)
```

Todos os valores e nomes aqui são fictícios. URL e segredo aparecem como `<PROJECT>` e `<INGEST_SECRET>`.

## O que acontece com cada notificação

| Notificação | Resultado | Caixa (`cash_balance`) | Fatura |
|---|---|---|---|
| Compra no **crédito** aprovada | gasto pendente, `method = credit` | não muda | entra na fatura do ciclo do cartão (Nubank: fecha 11, vence 15) |
| Compra no **débito** aprovada | gasto pendente, `method = debit` | desconta na hora, se o banco for a conta do saldo | — |
| **PIX enviado** / transferência enviada | gasto pendente, `method = pix`, o recebedor vira o estabelecimento | desconta na hora, se for a conta do saldo | — |
| "Compra aprovada" sem dizer crédito/débito | gasto pendente como **crédito**, com a nota "meio deduzido: confira" | não muda | entra na fatura |
| Compra parcelada ("em 3x") | gasto pendente com o **total** e uma nota explicando como virar plano | conforme o meio | o total cai numa fatura só até você revisar |
| **Estorno** / compra cancelada | fica no inbox como estorno, **não cria nem apaga nada** | não muda | não muda |
| PIX recebido, propaganda, limite, fatura/boleto, compra recusada, saldo | só no inbox (`ignored`, com o motivo) | não muda | não muda |
| Qualquer coisa de app que não seja Nubank, Inter ou Neon | só no inbox (`ignored`) | não muda | não muda |

## Decisões

### Caixa do pendente
O dinheiro do débito e do PIX **já saiu** quando a notificação chega, então o pendente já desconta o `cash_balance`, como o
`buffet expense --debit` faz. Só desconta se o banco da notificação for a conta do saldo (`cash_balance_bank`) e se o saldo
estiver informado. O quanto foi descontado fica em `cash_debited`:

- **Descartar** devolve exatamente `cash_debited` e apaga a linha. Se era crédito, a linha sai da fatura junto.
- **Revisar** trocando valor, meio, banco ou data refaz o efeito: devolve o que tinha saído e desconta de novo se continuar
  sendo débito/PIX da conta do saldo. Trocar débito por crédito devolve o dinheiro e põe na fatura.
- Pendente **não pode ser apagado** por `buffet del` nem pelo "Excluir" do app (o banco recusa): só por descartar, que é o que
  acerta o caixa. Depois de confirmado, vale a regra de sempre (apagar não devolve o caixa; o CLI avisa).

O crédito não mexe no caixa. Ele sai do caixa no `buffet pay-bill`, como qualquer compra no cartão.

### Pendentes contam nos totais
Um pendente é uma linha normal de `buffet_transactions`, então entra em todas as somas (mês, categoria, orçamento, fatura,
`buffet list`). Isso evita que um gasto "suma" enquanto você não revisa. Os pendentes aparecem com marcador:

- no PWA, a tag **Pendente** na linha, "Inclui R$ X pendente de revisão" em Hoje e "inclui R$ X pendente" em Gastos;
- no CLI, a nota `(pendente)` no `buffet list`, mais o total pendente no rodapé.

### Dedup
1. **Mesmo payload:** o hash SHA-256 de app, título, texto e timestamp normalizados (espaços, NBSP, caixa) é único por usuário.
   Um retry do MacroDroid ou um reenvio só incrementa `seen_count`. Se o payload vier sem timestamp, entra o minuto da chegada,
   para que o café de R$ 5,00 de amanhã não seja tomado como repetição do de hoje.
2. **Mesma compra repostada:** mesmo banco, tipo, valor e estabelecimento (`dedup_key`) em até **2 minutos** é a mesma
   notificação, mesmo com outro timestamp (o Android às vezes atualiza a notificação). O inbox guarda a repetida com
   `status = duplicate` e `duplicate_of`.
3. **Lançado também pelo chat/app:** se existe um gasto lançado à mão com o **mesmo valor a até 1 dia**, o pendente fica marcado
   como **possível duplicata** (`possible_duplicate_of`), nos dois sentidos: notificação depois do chat e chat depois da
   notificação (um trigger no banco). Nada é apagado sozinho. O `buffet expense` avisa e sugere `buffet discard <id>`. No app
   aparece "Parece o mesmo que…". O `buffet confirm --all` pula os marcados, e confirmar um deles tira a marca.

Duas compras iguais de verdade (mesmo valor e lugar) em menos de 2 minutos viram uma só. O inbox guarda a segunda como
`duplicate`; se for o caso, lance a outra pelo chat.

### Categoria sugerida
A ordem é esta. A primeira regra que se aplica decide.

1. **Aprendido:** o que você deixou da última vez que confirmou esse mesmo estabelecimento do banco (nome e categoria). Se você
   renomeou "PAG*FEIRA EXEMPLO" para "Feira", a próxima já chega como "Feira".
2. **Assinatura** ativa cujo `match` aparece no estabelecimento.
3. **Histórico:** a categoria mais usada nos seus lançamentos com o mesmo nome, ou com um nome curto contido nele ("Uber" em
   "UBER *TRIP").
4. **Regras por palavra** (`supabase/functions/_shared/category.ts`): uber → Transporte, ifood/padaria → Alimentação, drogaria →
   Saúde, supermercado → Mercado, e assim por diante. A comparação é por palavra inteira.
5. **Outros.**

Só é sugerida categoria que existe na sua lista.

### Estorno
O estorno não cria gasto negativo nem apaga o original, porque o original pode ter sido parcial, dividido, de outro mês ou já
estar na fatura paga. Ele aparece em **Pendentes › Estornos recebidos** e no `buffet pending`. Você ajusta ou apaga o gasto
original e depois dispensa o estorno (no app, ou `buffet discard <id-do-estorno>`).

### Segurança
- O segredo vem no header `X-Buffet-Ingest-Secret` e é comparado em tempo constante (SHA-256 dos dois lados, comparação byte a
  byte sem sair antes). Ele fica só em Supabase secrets (`BUFFET_INGEST_SECRET`). Sem segredo configurado, ou com menos de 24
  caracteres, a função recusa tudo (503).
- Chaves com cara de segredo (`secret`, `token`, `senha`…) são removidas do payload antes de gravar.
- A função grava com a `service_role`, que só existe no servidor. `buffet_notif_ingest` só pode ser executada pela
  `service_role`: nem a chave anon do PWA nem o dono criam gasto por esse caminho. O inbox tem RLS igual às outras tabelas
  (dono e bot leem, ninguém apaga).
- Os logs da função têm só status e ids, nunca o texto da notificação.

## Ir ao ar (uma vez)

1. **Migration** (`supabase/migrations/20261109120000_buffet_notification_capture.sql`):
   ```bash
   scripts/apply_migrations_https.py --dry-run
   scripts/apply_migrations_https.py
   ```
2. **Segredo:** gere um valor longo e guarde no gerenciador de senhas. Ele vai para o Supabase e para o MacroDroid, nunca para o
   repositório.
   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
   supabase secrets set BUFFET_INGEST_SECRET=<INGEST_SECRET> --project-ref <PROJECT>
   ```
3. **Deploy da função.** O MacroDroid não manda JWT do Supabase: quem autentica é o header. A pasta `_shared` vai junto
   automaticamente.
   ```bash
   supabase functions deploy buffet-ingest-notification --no-verify-jwt --project-ref <PROJECT>
   ```
4. **Teste sem o celular:**
   ```bash
   curl -sS -X POST "https://<PROJECT>.supabase.co/functions/v1/buffet-ingest-notification" \
     -H "Content-Type: application/json" -H "X-Buffet-Ingest-Secret: <INGEST_SECRET>" \
     -d '{"app":"com.nu.production","titulo":"Compra no crédito aprovada","texto":"Compra de R$ 1,23 APROVADA em TESTE EXEMPLO para o cartão com final 0000."}'
   # → {"ok":true,"status":"created",...,"message":"Buffet: R$ 1,23 Teste Exemplo pendente de revisão"}
   scripts/buffet pending            # aparece lá
   scripts/buffet discard teste      # e sai, sem deixar rastro no caixa/fatura
   ```
   Com o segredo errado a resposta é `401`. Repetir o mesmo `curl` responde `"status":"duplicate"`.
5. **PWA:** publicar o app (push em `main`, GitHub Pages) para a caixa "Pendentes" aparecer.

## MacroDroid, passo a passo

### Permissões e bateria (o que mais faz a captura falhar)
1. Instale o **MacroDroid** pela Play Store.
2. **Acesso a notificações:** Configurações do Android › Apps › Acesso especial › **Acesso a notificações** › MacroDroid ›
   permitir. O próprio MacroDroid pede isso ao criar o gatilho.
3. **Bateria sem restrição:** Configurações › Apps › MacroDroid › Bateria › **Sem restrições** (ou "Não otimizar"). Em Xiaomi,
   Samsung, Motorola e similares, ative também **Início automático** e tire o MacroDroid de "apps em suspensão" ou "apps
   adormecidos".
4. No MacroDroid, deixe ligada a **notificação fixa** (Configurações › Notificação do MacroDroid). Ela mantém o serviço vivo.
5. Não feche o MacroDroid pela lista de recentes. Se o celular tiver "limpeza automática", ponha o MacroDroid na lista de exceções.

### Macro "Buffet · Nubank"
**Gatilho: Notificação › Notificação recebida**
- Aplicativo: **Nubank** (pacote `com.nu.production`).
- Texto: **Contém** `R$`. No débito a palavra "aprovada" fica só no **título**, então não filtre por "aprovada". O `R$`
  aparece no texto de toda compra e PIX. Também dá para usar "Qualquer conteúdo": a função ignora o que não é gasto.

**Ação: HTTP Request** (fica entre as ações de web/conectividade; o nome em português varia entre versões)
- Método: **POST**
- URL: `https://<PROJECT>.supabase.co/functions/v1/buffet-ingest-notification`
- Cabeçalho: `X-Buffet-Ingest-Secret` = `<INGEST_SECRET>`
- Tipo de conteúdo: **application/json**
- Corpo, montado com o botão de **texto mágico** (`…`): escolha *título da notificação*, *texto da notificação* e *pacote/nome
  do app*. Os nomes dos campos mudam entre versões do MacroDroid; insira sempre pelo botão. Um exemplo de como fica:
  ```json
  {"app": "{not_app_package}", "titulo": "{not_title}", "texto": "{notification}"}
  ```
- Opcional, `"timestamp"` com a hora da notificação (epoch em s ou ms, ISO, ou `dd/mm/aaaa hh:mm`). Sem ele vale a hora em que
  chegou ao servidor, o que basta porque o MacroDroid envia na hora.
- Se o texto mágico quebrar o JSON (aspas dentro do texto), a função ainda tenta ler os campos. Outra saída é mandar como
  **form** (`application/x-www-form-urlencoded`) com os campos `app`, `titulo` e `texto`.

**Opcional:** guarde a resposta numa variável e mostre um **toast** com o campo `message`
("Buffet: R$ 12,34 Padaria Exemplo pendente de revisão").

### Campos aceitos (aliases)
O nome do campo não diferencia maiúsculas, acentos, `_` ou `-`. Também vale um objeto `notification: {…}` aninhado.

| Campo | Aceita |
|---|---|
| app | `app`, `pacote`, `package`, `packageName`, `app_package`, `app_name`, `aplicativo`, `not_app_package`, `not_app_name` |
| título | `titulo`, `título`, `title`, `not_title`, `notification_title`, `assunto` |
| texto | `texto`, `text`, `body`, `mensagem`, `message`, `msg`, `notification`, `not_text`, `conteudo`, `big_text` |
| hora | `timestamp`, `ts`, `time`, `hora`, `data`, `date`, `datetime`, `posted_at`, `postTime`, `quando` |

Respostas: `200` com `status` (`created`, `duplicate`, `ignored`, `refund`), `400` corpo sem título/texto, `401` segredo
errado, `405` sem ser POST, `413` corpo acima de 32 KB, `503` segredo não configurado, `500` erro ao gravar. Reenviar depois de
um `500` é seguro, porque o hash evita duplicar.

### Inter e Neon
O parser já reconhece os pacotes `br.com.intermedium` (Inter) e `br.com.neon` (Neon) e os formatos mais comuns deles. Para
ligar, duplique a macro trocando o app. Antes, confira em `buffet pending --inbox` como as primeiras notificações chegaram.
Se o formato não for reconhecido, a notificação fica como `unknown` e nada é criado.

## Revisar

**PWA:** em Hoje, o cartão **Pendentes de revisão** mostra a quantidade, o total, as possíveis duplicatas e os estornos.
Cada pendente tem **Confirmar**, **Revisar** e **Descartar**. Revisar permite mudar o estabelecimento, a categoria, como pagou,
a nota, se é dividido (sua parte em %) e quanto já recebeu. Em Gastos, o "…" de uma linha pendente abre as mesmas ações.

**CLI:**
```bash
scripts/buffet pending                       # pendentes, efeito no caixa/fatura, avisos e estornos
scripts/buffet pending --inbox 30            # as últimas 30 notificações e o que cada uma virou (diagnóstico)
scripts/buffet confirm padaria               # confirma sem mudar nada
scripts/buffet confirm --all                 # todos, menos os marcados como possível duplicata
scripts/buffet review padaria --category Alimentação --merchant "Padaria do bairro" --note "café"
scripts/buffet review 3f2a91 --debit         # o parser errou o meio: refaz caixa e fatura
scripts/buffet review jantar --split --reimburse-all   # dividido 50% e a outra parte já voltou
scripts/buffet review mercado --keep-pending --category Mercado   # edita sem confirmar
scripts/buffet discard 3f2a91                # descarta: devolve o caixa, tira da fatura
scripts/buffet discard <id-do-estorno>       # tira o estorno da lista
```

## Limitações conhecidas
- Os formatos foram deduzidos de notificações públicas e podem mudar com uma atualização do app do banco. Notificação não
  reconhecida fica no inbox como `unknown` (`buffet pending --inbox`) e nada é criado. Ajuste o parser e os testes juntos.
- Parcelado chega como um gasto só, com o total. Para virar plano: `buffet discard <id>` e
  `buffet expense <total> --credit Nubank --x N`.
- Não há vínculo automático com assinatura: a categoria vem dela, mas o "↻" se faz na revisão (`buffet sub link` ou
  "Acompanhar como assinatura" depois de confirmar).
- Boleto e pagamento de fatura são ignorados. Pagamento de fatura continua pelo `buffet pay-bill`.
- Sem conexão no momento da notificação, depende de o MacroDroid tentar de novo. A notificação pode se perder; confira a fatura
  de vez em quando.
