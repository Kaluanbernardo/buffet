import { describe, expect, it } from 'vitest'
import { canonicalPayload, cleanText, dedupKey, detectBank, isSpend, merchantKey, normalizeInput, parseBRL, parseNotification, parseTimestamp,
  prettyMerchant, sha256Hex, storablePayload, type NotificationInput } from '../../supabase/functions/_shared/notification'
import { DEFAULT_CATEGORIES, ruleCategory, suggestCategory, type CategoryContext } from '../../supabase/functions/_shared/category'
import { handleIngest, MIN_SECRET_LENGTH, readBody, SECRET_HEADER, secretMatches, type IngestPayload } from '../../supabase/functions/_shared/ingest'

// Fixtures sintéticas, no formato das notificações públicas do Nubank/Inter: estabelecimentos "Exemplo", cartão final 0000.
const NOW = new Date('2030-06-10T15:00:00Z')
const n = (title: string, text: string, app = 'com.nu.production', timestamp: string | null = null): NotificationInput => ({ app, title, text, timestamp })
const parse = (title: string, text: string, app?: string) => parseNotification(n(title, text, app))

describe('parser: compras', () => {
  it.each([
    ['Compra no crédito aprovada', 'Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO para o cartão com final 0000.', 1234, 'credit', 'PADARIA EXEMPLO', false],
    ['Compra aprovada', 'Compra de R$ 35,90 APROVADA em IFD*RESTAURANTE EXEMPLO para o cartão com final 0000.', 3590, 'credit', 'IFD*RESTAURANTE EXEMPLO', true],
    ['Compra no débito aprovada', 'Compra de R$ 17,00 em ACADEMIA EXEMPLO', 1700, 'debit', 'ACADEMIA EXEMPLO', false],
    ['Compra no débito', 'Compra de R$ 9,90 APROVADA em CAFE EXEMPLO no débito.', 990, 'debit', 'CAFE EXEMPLO', false],
    ['Compra aprovada', 'Compra de R$ 20,00 aprovada em PADARIA CENTRAL EXEMPLO. Limite disponível: R$ 1.980,00', 2000, 'credit', 'PADARIA CENTRAL EXEMPLO', true],
    ['Compra no crédito aprovada', 'Compra de R$ 5,90 APROVADA em APPLE.COM/BILL para o cartão com final 0000.', 590, 'credit', 'APPLE.COM/BILL', false],
    ['Compra aprovada', 'Compra de R$ 40,00 APROVADA em MERCADO EXEMPLO. Aproveite: invista seu troco!', 4000, 'credit', 'MERCADO EXEMPLO', true],
    ['Compra aprovada', 'Compra de R$ 1.234,56 APROVADA em LOJA EXEMPLO para o cartão com final 0000', 123456, 'credit', 'LOJA EXEMPLO', true],
    ['Pagamento aprovado', 'Pagamento de R$ 15,00 aprovado com NuPay em LOJA ONLINE EXEMPLO.', 1500, 'credit', 'LOJA ONLINE EXEMPLO', true],
  ])('%s · %s', (title, text, cents, method, merchant, guessed) => {
    const p = parse(title, text)
    expect(p).toMatchObject({ bank: 'nubank', kind: 'purchase', amountCents: cents, method, merchant, methodGuessed: guessed })
    expect(isSpend(p)).toBe(true)
  })

  it('cartão final e parcelas: o valor é sempre o total da compra', () => {
    expect(parse('Compra aprovada', 'Compra de R$ 300,00 em 3x APROVADA em LOJA EXEMPLO para o cartão com final 0000.'))
      .toMatchObject({ amountCents: 30000, installments: 3, merchant: 'LOJA EXEMPLO', cardLast4: '0000' })
    expect(parse('Compra aprovada', 'Compra parcelada em 4x de R$ 25,00 APROVADA em LOJA EXEMPLO.')).toMatchObject({ amountCents: 10000, installments: 4 })
    expect(parse('Compra aprovada', 'Compra de R$ 50,00 em 1x APROVADA em PADARIA EXEMPLO.')).toMatchObject({ amountCents: 5000, installments: null })
  })

  it('Inter e Neon: outros jeitos de escrever', () => {
    expect(parse('Inter', 'Olá, você acaba de comprar no débito no MERCADO EXEMPLO o valor de R$ 63,80.', 'br.com.intermedium'))
      .toMatchObject({ bank: 'inter', kind: 'purchase', method: 'debit', amountCents: 6380, merchant: 'MERCADO EXEMPLO' })
    expect(parse('Inter', 'Compra no debito de R$ 26,47 no ATACADO EXEMPLO. Toque para ver detalhes.', 'Inter'))
      .toMatchObject({ method: 'debit', amountCents: 2647, merchant: 'ATACADO EXEMPLO' })
    expect(parse('Compra aprovada', 'Compra aprovada no cartão final 0000: R$ 1.250,00 em LOJA EXEMPLO', 'br.com.intermedium'))
      .toMatchObject({ method: 'credit', amountCents: 125000, merchant: 'LOJA EXEMPLO', cardLast4: '0000' })
    expect(parse('Inter', 'Debito de R$ 89,90 - SERVICO EXEMPLO. Clique para gerenciar sua assinatura.', 'Inter'))
      .toMatchObject({ method: 'debit', amountCents: 8990, merchant: 'SERVICO EXEMPLO' })
    expect(parse('Compra no crédito', 'Compra de R$ 30,00 no crédito aprovada em LOJA EXEMPLO', 'br.com.neon'))
      .toMatchObject({ bank: 'neon', method: 'credit', amountCents: 3000, merchant: 'LOJA EXEMPLO' })
  })
})

describe('parser: PIX', () => {
  it.each([
    ['Pix enviado', 'Você enviou R$ 50,00 para Pessoa Exemplo via Pix.', 5000, 'Pessoa Exemplo'],
    ['Transferência enviada', 'Você enviou uma transferência de R$ 100,00 para PESSOA EXEMPLO.', 10000, 'PESSOA EXEMPLO'],
    ['Pix', 'Pix enviado: R$ 1.200,00 para PESSOA EXEMPLO. Toque para ver o comprovante.', 120000, 'PESSOA EXEMPLO'],
    ['Transferência', 'Transferência de R$ 70,00 para Pessoa Exemplo foi realizada com sucesso.', 7000, 'Pessoa Exemplo'],
    ['Pagamento via Pix', 'Você pagou R$ 23,00 para PADARIA EXEMPLO LTDA via Pix.', 2300, 'PADARIA EXEMPLO LTDA'],
  ])('enviado · %s', (title, text, cents, merchant) => {
    expect(parse(title, text)).toMatchObject({ kind: 'pix_out', method: 'pix', amountCents: cents, merchant })
  })

  it.each([
    ['Você recebeu um Pix', 'Você recebeu um Pix de R$ 150,00 de Pessoa Exemplo.'],
    ['Transferência recebida', 'Você recebeu uma transferência de R$ 100,00 de PESSOA EXEMPLO.'],
    ['Nubank', 'Recebemos sua transferência de R$ 20,00.'],
  ])('recebido não é gasto · %s', (title, text) => {
    const p = parse(title, text)
    expect(p.kind).toBe('pix_in')
    expect(isSpend(p)).toBe(false)
  })
})

describe('parser: o que não vira gasto', () => {
  it.each([
    ['Estorno', 'Estorno de compra de R$ 35,90 em LOJA EXEMPLO creditado.', 'refund'],
    ['Compra cancelada', 'A compra de R$ 12,00 em LOJA EXEMPLO foi cancelada e o valor estornado.', 'refund'],
    ['Compra recusada', 'Recusamos uma compra de R$ 99,00 em LOJA EXEMPLO.', 'declined'],
    ['Compra não aprovada', 'Sua compra de R$ 10,00 em LOJA EXEMPLO não foi aprovada.', 'declined'],
    ['Fatura paga', 'Pagamento da fatura de R$ 2.345,67 confirmado.', 'bill'],
    ['Pagamento recebido', 'Recebemos o pagamento de R$ 500,00 da sua fatura.', 'bill'],
    ['Sua fatura fechou', 'A fatura do cartão fechou em R$ 800,00. O pagamento vence em 15/07.', 'bill'],
    ['Boleto pago', 'Você pagou um boleto de R$ 120,00.', 'bill'],
    ['Oferta', 'Ganhe até R$ 100 de cashback nas compras.', 'promo'],
    ['Boa notícia', 'Seu limite subiu para R$ 5.000,00!', 'promo'],
    ['Invista', 'Invista a partir de R$ 1 e resgate quando quiser! Toque para saber mais.', 'promo'],
    ['Saldo', 'Seu saldo é R$ 1.234,56', 'unknown'],
    ['Compra aprovada', 'Compra aprovada em LOJA EXEMPLO.', 'unknown'],
  ])('%s → %s', (title, text, kind) => {
    const p = parse(title, text)
    expect(p.kind).toBe(kind)
    expect(isSpend(p)).toBe(false)
  })

  it('estorno guarda valor e estabelecimento para a revisão', () => {
    expect(parse('Estorno', 'Estorno de compra de R$ 35,90 em LOJA EXEMPLO creditado.')).toMatchObject({ amountCents: 3590, merchant: 'LOJA EXEMPLO' })
  })

  it('app desconhecido nunca é gasto, mesmo com texto de compra', () => {
    const p = parse('Compra aprovada', 'Compra de R$ 10,00 APROVADA em LOJA EXEMPLO', 'com.samsung.android.spay')
    expect(p).toMatchObject({ bank: 'desconhecido', kind: 'purchase' })
    expect(isSpend(p)).toBe(false)
  })
})

describe('parser: entrada tolerante', () => {
  it('valores em pt-BR', () => {
    expect([parseBRL('12,34'), parseBRL('1.234,56'), parseBRL('5'), parseBRL('12,3'), parseBRL('12.34'), parseBRL('1.234'), parseBRL('abc')])
      .toEqual([1234, 123456, 500, 1230, 1234, 123400, null])
  })

  it('NBSP, espaço fino e quebras de linha não atrapalham', () => {
    const p = parse('Compra no débito aprovada', 'Compra de R$ 12,34\nem PADARIA   EXEMPLO')
    expect(p).toMatchObject({ amountCents: 1234, merchant: 'PADARIA EXEMPLO', method: 'debit' })
    expect(cleanText(' a  b\r\nc ')).toBe('a b c')
  })

  it('aliases de campo (pt/en, maiúsculas, aninhado em "notification")', () => {
    const a = normalizeInput({ Pacote: 'com.nu.production', 'Título': 'Compra aprovada', Mensagem: 'Compra de R$ 1,00 APROVADA em X', TS: 1907334000 }, NOW)
    expect(a).toEqual({ app: 'com.nu.production', title: 'Compra aprovada', text: 'Compra de R$ 1,00 APROVADA em X', timestamp: '2030-06-10T15:00:00.000Z' })
    const b = normalizeInput({ notification: { title: 'Pix enviado', text: 'Você enviou R$ 2,00 para Y' }, app_name: 'Nubank' }, NOW)
    expect(b).toMatchObject({ app: 'Nubank', title: 'Pix enviado', text: 'Você enviou R$ 2,00 para Y', timestamp: null })
    expect(normalizeInput({ title: '', titulo: 'B', body: 'C' }, NOW)).toMatchObject({ title: 'B', text: 'C' })
  })

  it('timestamp: epoch s/ms, ISO, dd/mm/aaaa hh:mm em Brasília; fora da janela vira null', () => {
    expect(parseTimestamp(1907334000000, NOW)).toBe('2030-06-10T15:00:00.000Z')
    expect(parseTimestamp('1907334000', NOW)).toBe('2030-06-10T15:00:00.000Z')
    expect(parseTimestamp(1907766000, NOW)).toBeNull()   // 5 dias no futuro
    expect(parseTimestamp('2030-06-10T12:00:00-03:00', NOW)).toBe('2030-06-10T15:00:00.000Z')
    expect(parseTimestamp('2030-06-10 12:00:00', NOW)).toBe('2030-06-10T15:00:00.000Z')
    expect(parseTimestamp('10/06/2030 12:00', NOW)).toBe('2030-06-10T15:00:00.000Z')
    expect(parseTimestamp('01/01/2020 12:00', NOW)).toBeNull()
    expect(parseTimestamp('2031-01-01T00:00:00Z', NOW)).toBeNull()
    expect(parseTimestamp('ontem', NOW)).toBeNull()
  })

  it('banco pelo pacote ou pelo nome do app', () => {
    expect(['com.nu.production', 'Nubank', 'br.com.intermedium', 'Inter', 'br.com.neon', 'Neon', 'com.whatsapp', ''].map(detectBank))
      .toEqual(['nubank', 'nubank', 'inter', 'inter', 'neon', 'neon', 'desconhecido', 'desconhecido'])
  })

  it('merchant: chave estável e nome apresentável', () => {
    expect(merchantKey('IFD*Restaurante Exemplo  Ltda.')).toBe('ifd restaurante exemplo ltda')
    expect(merchantKey('Açaí do Exemplo')).toBe('acai do exemplo')
    expect(prettyMerchant('PADARIA EXEMPLO DE BAIRRO')).toBe('Padaria Exemplo de Bairro')
    expect(prettyMerchant('Pessoa Exemplo')).toBe('Pessoa Exemplo')
  })

  it('payload guardado sem nada com cara de segredo', () => {
    expect(storablePayload({ texto: 'a', secret: 'x', 'X-Buffet-Ingest-Secret': 'y', token: 'z', titulo: 'b' })).toEqual({ texto: 'a', titulo: 'b' })
  })
})

describe('dedup (lado do parser)', () => {
  const recv = new Date('2030-06-10T15:00:20Z')
  it('hash ignora espaços/NBSP e caixa do app, mas muda com o timestamp', async () => {
    const a = normalizeInput({ app: 'Nubank', titulo: 'Compra aprovada', texto: 'Compra de R$ 5,00 APROVADA em CAFE', timestamp: '2030-06-10T12:00:00-03:00' }, NOW)
    const b = normalizeInput({ app: 'NUBANK', title: ' Compra  aprovada', text: 'Compra de R$ 5,00 APROVADA em CAFE ', ts: '2030-06-10T12:00:00-03:00' }, NOW)
    const c = { ...a, timestamp: '2030-06-10T15:01:00.000Z' }
    expect(await sha256Hex(canonicalPayload(a, recv))).toBe(await sha256Hex(canonicalPayload(b, recv)))
    expect(await sha256Hex(canonicalPayload(a, recv))).not.toBe(await sha256Hex(canonicalPayload(c, recv)))
  })

  it('sem timestamp, o minuto da chegada entra no hash (o mesmo café amanhã não é "repetido")', () => {
    const a = normalizeInput({ app: 'Nubank', titulo: 'Compra aprovada', texto: 'Compra de R$ 5,00 APROVADA em CAFE' }, NOW)
    expect(canonicalPayload(a, new Date('2030-06-10T15:00:05Z'))).toBe(canonicalPayload(a, new Date('2030-06-10T15:00:55Z')))
    expect(canonicalPayload(a, new Date('2030-06-10T15:00:05Z'))).not.toBe(canonicalPayload(a, new Date('2030-06-11T15:00:05Z')))
  })

  it('dedup_key: banco|tipo|centavos|estabelecimento, igual para a notificação repostada', () => {
    const p1 = parse('Compra aprovada', 'Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO para o cartão com final 0000.')
    const p2 = parse('Compra no crédito aprovada', 'Compra de R$ 12,34 APROVADA em Padaria Exemplo.')
    expect(dedupKey(p1)).toBe('nubank|purchase|1234|padaria exemplo')
    expect(dedupKey(p2)).toBe(dedupKey(p1))
    expect(dedupKey(parse('Compra aprovada', 'Compra de R$ 12,35 APROVADA em PADARIA EXEMPLO'))).not.toBe(dedupKey(p1))
    expect(dedupKey(parse('Saldo', 'Sem valor aqui'))).toBeNull()
  })
})

describe('categoria sugerida', () => {
  const ctx = (o: Partial<CategoryContext> = {}): CategoryContext => ({ categories: DEFAULT_CATEGORIES, learned: [], history: [], subscriptions: [], ...o })

  it('regras por palavra inteira (bar ≠ barbearia), só categorias que existem', () => {
    expect(ruleCategory('UBER *TRIP EXEMPLO')).toBe('Transporte')
    expect(ruleCategory('IFD*RESTAURANTE EXEMPLO')).toBe('Alimentação')
    expect(ruleCategory('DROGARIA EXEMPLO')).toBe('Saúde')
    expect(ruleCategory('SUPERMERCADO EXEMPLO')).toBe('Mercado')
    expect(ruleCategory('BAR DO EXEMPLO')).toBe('Alimentação')
    expect(ruleCategory('BARBEARIA EXEMPLO')).toBeNull()
    expect(ruleCategory('MERCADO LIVRE EXEMPLO')).toBe('Outros')
    expect(ruleCategory('AMAZON PRIME EXEMPLO')).toBe('Assinaturas')
    expect(ruleCategory('POSTO EXEMPLO', ['Alimentação', 'Outros'])).toBeNull()
  })

  it('ordem: aprendido > assinatura > histórico > regra > Outros', () => {
    const learned = [{ merchantKey: 'padaria exemplo', merchant: 'Padaria do bairro', category: 'Lazer', date: '2030-05-01' }]
    expect(suggestCategory('PADARIA EXEMPLO', ctx({ learned }))).toEqual({ category: 'Lazer', merchant: 'Padaria do bairro', source: 'aprendido' })
    const subscriptions = [{ name: 'Streaming exemplo', match: 'streamex', category: 'Assinaturas', status: 'active' }]
    expect(suggestCategory('STREAMEX*EXEMPLO', ctx({ subscriptions }))).toEqual({ category: 'Assinaturas', merchant: 'Streaming exemplo', source: 'assinatura' })
    expect(suggestCategory('STREAMEX*EXEMPLO', ctx({ subscriptions: [{ ...subscriptions[0], status: 'canceled' }] })).source).toBe('padrao')
    const history = [
      { merchant: 'Padaria Exemplo', category: 'Mercado', date: '2030-05-02' },
      { merchant: 'padaria exemplo', category: 'Mercado', date: '2030-05-03' },
      { merchant: 'Padaria Exemplo', category: 'Alimentação', date: '2030-05-20' },
    ]
    expect(suggestCategory('PADARIA EXEMPLO', ctx({ history }))).toMatchObject({ category: 'Mercado', source: 'historico' })
    expect(suggestCategory('PADARIA EXEMPLO', ctx())).toEqual({ category: 'Alimentação', merchant: 'Padaria Exemplo', source: 'regra' })
    expect(suggestCategory('LOJA SEM PISTA EXEMPLO', ctx())).toEqual({ category: 'Outros', merchant: 'Loja Sem Pista Exemplo', source: 'padrao' })
    expect(suggestCategory(null, ctx()).source).toBe('padrao')
  })

  it('nome curto do chat contido no do banco ("Uber" em "UBER *TRIP") vale como histórico; curto demais não', () => {
    const history = [{ merchant: 'Uber', category: 'Lazer', date: '2030-05-01' }, { merchant: 'Bar', category: 'Moradia', date: '2030-05-01' }]
    expect(suggestCategory('UBER *TRIP EXEMPLO', ctx({ history }))).toEqual({ category: 'Lazer', merchant: 'Uber *trip Exemplo', source: 'historico' })
    expect(suggestCategory('BAR DO EXEMPLO', ctx({ history }))).toMatchObject({ category: 'Alimentação', source: 'regra' })
  })

  it('aprendido com categoria que não existe mais é ignorado; lista vazia usa a padrão', () => {
    const learned = [{ merchantKey: 'padaria exemplo', merchant: 'X', category: 'Removida', date: '2030-05-01' }]
    expect(suggestCategory('PADARIA EXEMPLO', ctx({ learned })).source).toBe('regra')
    expect(suggestCategory('PADARIA EXEMPLO', { categories: [], learned: [], history: [], subscriptions: [] }).category).toBe('Alimentação')
  })
})

describe('handler: segredo, método, corpo', () => {
  const SECRET = 'x'.repeat(MIN_SECRET_LENGTH)
  const calls: IngestPayload[] = []
  const deps = (secret: string | undefined = SECRET) => ({
    secret: secret, now: () => NOW,
    loadContext: async () => ({ categories: [], learned: [], history: [], subscriptions: [] }),
    ingest: async (p: IngestPayload) => { calls.push(p); return { status: 'created', inbox_id: 'i1', transaction_id: 't1', amount: 12.34, merchant: 'Padaria Exemplo' } },
  })
  const req = (init: RequestInit & { secret?: string | null } = {}) => {
    const { secret = SECRET, ...rest } = init
    return new Request('https://example.invalid/fn', { method: 'POST', ...rest,
      headers: { 'content-type': 'application/json', ...(secret == null ? {} : { [SECRET_HEADER]: secret }), ...(rest.headers as Record<string, string> ?? {}) } })
  }
  const body = JSON.stringify({ app: 'com.nu.production', titulo: 'Compra no crédito aprovada', texto: 'Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO.' })

  it('comparação do segredo em tempo constante (por digest) e sem aceitar vazio', async () => {
    expect(await secretMatches(SECRET, SECRET)).toBe(true)
    expect(await secretMatches(SECRET + 'x', SECRET)).toBe(false)
    expect(await secretMatches('', '')).toBe(false)
  })

  it('sem segredo configurado (ou curto) a função não aceita nada: 503', async () => {
    expect((await handleIngest(req({ body }), { ...deps(), secret: undefined })).status).toBe(503)
    expect((await handleIngest(req({ body, secret: 'curto' }), deps('curto'))).status).toBe(503)
  })

  it('401 sem header ou com segredo errado; 405 fora de POST; 400 corpo inútil; 413 corpo enorme', async () => {
    expect((await handleIngest(req({ body, secret: null }), deps())).status).toBe(401)
    expect((await handleIngest(req({ body, secret: SECRET.slice(1) + 'y' }), deps())).status).toBe(401)
    expect((await handleIngest(new Request('https://example.invalid/fn', { method: 'GET' }), deps())).status).toBe(405)
    expect((await handleIngest(req({ body: '[1,2]' }), deps())).status).toBe(400)
    expect((await handleIngest(req({ body: '{"outra":"coisa"}' }), deps())).status).toBe(400)
    expect((await handleIngest(req({ body: JSON.stringify({ texto: 'x'.repeat(40000) }) }), deps())).status).toBe(413)
  })

  it('200 com o que o banco respondeu + mensagem curta; payload com centavos, dedup_key e categoria', async () => {
    calls.length = 0
    const res = await handleIngest(req({ body }), deps())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'created', message: 'Buffet: R$ 12,34 Padaria Exemplo pendente de revisão' })
    expect(calls[0]).toMatchObject({ kind: 'purchase', method: 'credit', amount_cents: 1234, bank: 'nubank', dedup_key: 'nubank|purchase|1234|padaria exemplo',
      category: 'Alimentação', display_merchant: 'Padaria Exemplo', posted_at: NOW.toISOString(), payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('erro no banco: 500 sem vazar detalhe (o retry é seguro pelo hash)', async () => {
    const res = await handleIngest(req({ body }), { ...deps(), ingest: async () => { throw new Error('conexão caiu') } })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/conexão/)
  })

  it('readBody: JSON, form e JSON quebrado por aspas no texto', () => {
    expect(readBody('{"a":"b"}', 'application/json')).toEqual({ a: 'b' })
    expect(readBody('titulo=Pix+enviado&texto=Voc%C3%AA', 'application/x-www-form-urlencoded')).toEqual({ titulo: 'Pix enviado', texto: 'Você' })
    expect(readBody('{"titulo":"Compra","texto":"Compra em "LOJA" ok","ts":1907766000}', 'application/json'))
      .toEqual({ titulo: 'Compra', texto: 'Compra em "LOJA" ok', ts: 1907766000 })
    expect(readBody('', 'application/json')).toBeNull()
    expect(readBody('lixo', 'text/plain')).toBeNull()
  })
})
