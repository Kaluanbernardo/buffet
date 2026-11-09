import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, freshDb, OTHER, OWNER, stubDb, type Db } from './pg'
import { isSpend, normalizeInput, parseNotification } from '../../supabase/functions/_shared/notification'
import { buildPayload, handleIngest, SECRET_HEADER } from '../../supabase/functions/_shared/ingest'
import type { CategoryContext } from '../../supabase/functions/_shared/category'

// Postgres real (PGlite) com as migrations do repo. Tudo sintético: estabelecimentos "Exemplo", valores redondos, cartão 0000.
const NOW = new Date('2030-06-10T15:00:00Z')            // 12:00 em Brasília
const at = (hhmm: string, day = '10') => `2030-06-${day}T${hhmm}:00-03:00`
const EMPTY: CategoryContext = { categories: [], learned: [], history: [], subscriptions: [] }

const credit = (o: Record<string, unknown> = {}) => ({ app: 'com.nu.production', titulo: 'Compra no crédito aprovada',
  texto: 'Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO para o cartão com final 0000.', timestamp: at('12:00'), ...o })
const debit = (o: Record<string, unknown> = {}) => ({ app: 'Nubank', title: 'Compra no débito aprovada',
  text: 'Compra de R$ 25,00 em MERCADO EXEMPLO', timestamp: at('12:05'), ...o })
const pixOut = (o: Record<string, unknown> = {}) => ({ pacote: 'com.nu.production', titulo: 'Pix enviado',
  texto: 'Você enviou R$ 50,00 para Pessoa Exemplo via Pix.', ts: Date.parse(at('12:10')), ...o })

let d: Db
const cash = async () => Number((await d.one<{ c: string | null }>('postgres', 'select cash_balance as c from public.buffet_app_config'))?.c)
const tx = (id: string) => d.one<Record<string, unknown>>('postgres',
  `select id, date::text, amount::float8, merchant, category, bank, method, bill_month, note, source, review_status,
          notification_id, cash_debited::float8, possible_duplicate_of, split_share_pct::float8, reimbursed_amount::float8
     from public.buffet_transactions where id = $1`, [id])
const inbox = (id: string) => d.one<Record<string, unknown>>('postgres',
  'select id, status, kind, reason, seen_count, duplicate_of, amount::float8, merchant_key from public.buffet_notification_inbox where id = $1', [id])
const count = async (table: string) => Number((await d.one<{ n: number }>('postgres', `select count(*)::int as n from public.${table}`))?.n)

/** O caminho da Edge Function sem o HTTP: parser → payload → public.buffet_notif_ingest como service_role. */
async function ingest(raw: Record<string, unknown>, ctx: CategoryContext = EMPTY, now = NOW) {
  const input = normalizeInput(raw, now)
  const parsed = parseNotification(input)
  const p = await buildPayload(raw, input, parsed, now, isSpend(parsed) ? ctx : null)
  return (await d.one<{ r: Record<string, unknown> }>('service_role', 'select public.buffet_notif_ingest($1::jsonb) as r', [JSON.stringify(p)]))!.r
}
const rpc = async (role: 'bot' | 'authenticated', fn: string, args: unknown[]) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  return (await d.one<{ r: Record<string, unknown> }>(role, `select public.${fn}(${ph}) as r`, args))!.r
}
const review = (id: string, patch: Record<string, unknown> = {}, confirm = true, role: 'bot' | 'authenticated' = 'bot') =>
  rpc(role, 'buffet_tx_review', [id, JSON.stringify(patch), confirm])
const discard = (id: string, role: 'bot' | 'authenticated' = 'bot') => rpc(role, 'buffet_tx_discard', [id])
/** Como o `buffet expense` grava (role bot, source 'bot'). */
const chat = async (amount: number, date: string, merchant = 'Mercado') =>
  (await d.one<{ id: string }>('bot', `insert into public.buffet_transactions (date, amount, merchant, category, bank, method, source)
     values ($1, $2, $3, 'Mercado', 'Nubank', 'debit', 'bot') returning id`, [date, amount, merchant]))!.id

beforeAll(async () => { d = await freshDb() })
beforeEach(async () => {
  await d.reset()
  await d.as('postgres', `insert into public.buffet_app_config (user_id, cash_balance, cash_balance_bank, banks) values ($1, 1000, 'Nubank',
    '[{"name":"Nubank","status":"active","credit":{"closing_day":11,"due_day":15}},{"name":"Inter","status":"active"}]')`, [OWNER])
})

describe('entrada: gasto pendente e caixa', () => {
  it('débito da conta do saldo desconta o caixa uma vez e guarda quanto em cash_debited', async () => {
    const r = await ingest(debit())
    expect(r).toMatchObject({ status: 'created', amount: 25, method: 'debit', bank: 'Nubank', cash_delta: -25 })
    expect(await cash()).toBe(1000 - 25)
    expect(await tx(String(r.transaction_id))).toMatchObject({ date: '2030-06-10', amount: 25, merchant: 'Mercado Exemplo', category: 'Mercado',
      source: 'notificacao', review_status: 'pending', cash_debited: 25, bill_month: null, notification_id: r.inbox_id })
    expect(await inbox(String(r.inbox_id))).toMatchObject({ status: 'created', kind: 'purchase', merchant_key: 'mercado exemplo' })
  })

  it('PIX enviado também desconta; o recebedor vira o estabelecimento', async () => {
    const r = await ingest(pixOut())
    expect(r).toMatchObject({ status: 'created', method: 'pix', amount: 50, merchant: 'Pessoa Exemplo', cash_delta: -50 })
    expect(await cash()).toBe(950)
  })

  it('crédito entra na fatura pelo ciclo (fecha 11, vence 15) e nunca mexe no caixa', async () => {
    const before = await ingest(credit())
    const onClosing = await ingest(credit({ texto: 'Compra de R$ 20,00 APROVADA em LIVRARIA EXEMPLO para o cartão com final 0000.', timestamp: at('09:00', '11') }),
      EMPTY, new Date('2030-06-11T15:00:00Z'))
    expect(before).toMatchObject({ status: 'created', method: 'credit', bill_month: '2030-06', cash_delta: 0 })
    expect(onClosing).toMatchObject({ status: 'created', method: 'credit', bill_month: '2030-07' })
    expect(await cash()).toBe(1000)
    expect((await tx(String(before.transaction_id)))!.cash_debited).toBe(0)
  })

  it('débito de banco que não é o do saldo não mexe no caixa', async () => {
    const r = await ingest(debit({ app: 'br.com.intermedium', title: 'Inter', text: 'Compra no debito de R$ 26,00 no ATACADO EXEMPLO. Toque para ver detalhes.' }))
    expect(r).toMatchObject({ status: 'created', bank: 'Inter', method: 'debit', cash_delta: 0 })
    expect(await cash()).toBe(1000)
  })

  it('sem cash_balance informado nada é descontado, e descartar não devolve nada', async () => {
    await d.as('postgres', 'update public.buffet_app_config set cash_balance = null')
    const r = await ingest(debit())
    expect((await tx(String(r.transaction_id)))!.cash_debited).toBe(0)
    await d.as('postgres', 'update public.buffet_app_config set cash_balance = 300')
    expect(await discard(String(r.transaction_id))).toMatchObject({ cash_delta: 0, cash_balance: 300 })
  })

  it('parcelado na notificação entra com o total e avisa como virar plano', async () => {
    const r = await ingest(credit({ texto: 'Compra de R$ 300,00 em 3x APROVADA em LOJA EXEMPLO para o cartão com final 0000.' }))
    const t = await tx(String(r.transaction_id))
    expect(t).toMatchObject({ amount: 300, method: 'credit', bill_month: '2030-06' })
    expect(String(t!.note)).toContain('--x 3')
  })

  it('cartão sem ciclo: crédito fica fora de fatura e a nota diz por quê', async () => {
    const r = await ingest(credit({ app: 'Inter', titulo: 'Compra aprovada', texto: 'Compra aprovada no cartão final 0000: R$ 40,00 em LOJA EXEMPLO' }))
    const t = await tx(String(r.transaction_id))
    expect(t).toMatchObject({ bank: 'Inter', method: 'credit', bill_month: null })
    expect(String(t!.note)).toMatch(/sem ciclo/)
  })

  it('o que não é gasto fica só no inbox; estorno espera revisão e pode ser dispensado', async () => {
    const results = await Promise.all([
      { app: 'Nubank', titulo: 'Você recebeu um Pix', texto: 'Você recebeu um Pix de R$ 80,00 de Pessoa Exemplo.' },
      { app: 'Nubank', titulo: 'Oferta', texto: 'Ganhe até R$ 100 de cashback nas compras.' },
      { app: 'Nubank', titulo: 'Compra recusada', texto: 'Recusamos uma compra de R$ 99,00 em LOJA EXEMPLO.' },
      { app: 'Nubank', titulo: 'Fatura paga', texto: 'Pagamento da fatura de R$ 500,00 confirmado.' },
      { app: 'com.whatsapp', titulo: 'Grupo', texto: 'Compra de R$ 10,00 aprovada em LOJA EXEMPLO' },
    ].map((raw, i) => ingest({ ...raw, timestamp: at(`13:0${i}`) })))
    expect(results.map((r) => r.status)).toEqual(['ignored', 'ignored', 'ignored', 'ignored', 'ignored'])
    expect(results[4].reason).toBe('app/banco desconhecido')
    const refund = await ingest({ app: 'Nubank', titulo: 'Estorno', texto: 'Estorno de compra de R$ 12,34 em PADARIA EXEMPLO creditado.', timestamp: at('14:00') })
    expect(refund).toMatchObject({ status: 'refund' })
    expect(await count('buffet_transactions')).toBe(0)
    expect(await cash()).toBe(1000)
    expect(await rpc('bot', 'buffet_notif_dismiss', [refund.inbox_id])).toMatchObject({ status: 'dismissed', amount: 12.34 })
    await expect(rpc('bot', 'buffet_notif_dismiss', [refund.inbox_id])).rejects.toThrow(/já dispensado/)
  })
})

describe('dedup', () => {
  it('o mesmo payload de novo não duplica gasto nem caixa; só conta seen_count', async () => {
    const a = await ingest(debit())
    const b = await ingest(debit())
    const c = await ingest({ ...debit(), text: '  Compra de R$ 25,00   em MERCADO EXEMPLO ' })   // mesmo texto com espaços/NBSP diferentes
    expect(b).toMatchObject({ status: 'duplicate', inbox_id: a.inbox_id, transaction_id: a.transaction_id, first_status: 'created' })
    expect(c).toMatchObject({ status: 'duplicate', inbox_id: a.inbox_id })
    expect(await count('buffet_transactions')).toBe(1)
    expect(await count('buffet_notification_inbox')).toBe(1)
    expect((await inbox(String(a.inbox_id)))!.seen_count).toBe(3)
    expect(await cash()).toBe(975)
  })

  it('repostada com outro timestamp em até 2 min é a mesma compra; 10 min depois é outra', async () => {
    const a = await ingest(debit({ timestamp: at('12:05') }))
    const b = await ingest(debit({ timestamp: at('12:06') }))
    const c = await ingest(debit({ timestamp: at('12:15') }))
    expect(b).toMatchObject({ status: 'duplicate', duplicate_of: a.inbox_id, transaction_id: a.transaction_id })
    expect(c).toMatchObject({ status: 'created' })
    expect(await count('buffet_transactions')).toBe(2)
    expect(await cash()).toBe(950)
  })

  it('mesmo valor em outro estabelecimento, ou outro valor no mesmo, não é duplicata', async () => {
    await ingest(debit())
    expect(await ingest(debit({ text: 'Compra de R$ 25,00 em FARMACIA EXEMPLO' }))).toMatchObject({ status: 'created' })
    expect(await ingest(debit({ text: 'Compra de R$ 25,01 em MERCADO EXEMPLO' }))).toMatchObject({ status: 'created' })
  })

  it('sem timestamp, o retry no mesmo minuto bate o hash; o café do dia seguinte entra', async () => {
    const raw = { app: 'Nubank', titulo: 'Compra no débito aprovada', texto: 'Compra de R$ 5,00 em CAFE EXEMPLO' }
    const a = await ingest(raw, EMPTY, new Date('2030-06-10T15:00:10Z'))
    expect(await ingest(raw, EMPTY, new Date('2030-06-10T15:00:50Z'))).toMatchObject({ status: 'duplicate', inbox_id: a.inbox_id })
    expect(await ingest(raw, EMPTY, new Date('2030-06-10T15:01:30Z'))).toMatchObject({ status: 'duplicate', duplicate_of: a.inbox_id })
    expect(await ingest(raw, EMPTY, new Date('2030-06-11T15:00:00Z'))).toMatchObject({ status: 'created' })
  })

  it('lançado no chat depois: o pendente fica marcado como possível duplicata', async () => {
    const r = await ingest(debit())
    const manual = await chat(25, '2030-06-11', 'Mercado')
    expect((await tx(String(r.transaction_id)))!.possible_duplicate_of).toBe(manual)
    // Confirmar diz "não é duplicata": a marca sai.
    await review(String(r.transaction_id))
    expect((await tx(String(r.transaction_id)))!.possible_duplicate_of).toBeNull()
  })

  it('lançado no chat antes: o pendente já nasce marcado; apagar o do chat limpa a marca', async () => {
    const manual = await chat(25, '2030-06-09', 'Mercado')
    const r = await ingest(debit())
    expect(r.possible_duplicate_of).toBe(manual)
    await d.as('bot', 'delete from public.buffet_transactions where id = $1', [manual])
    expect((await tx(String(r.transaction_id)))!.possible_duplicate_of).toBeNull()
  })

  it('valor diferente ou mais de 1 dia de distância não marca; um gasto do chat só pareia com um pendente', async () => {
    const a = await ingest(debit())
    const b = await ingest(debit({ text: 'Compra de R$ 25,00 em OUTRO MERCADO EXEMPLO', timestamp: at('18:00') }))
    await chat(25.5, '2030-06-10')
    await chat(25, '2030-06-12')
    expect((await tx(String(a.transaction_id)))!.possible_duplicate_of).toBeNull()
    const m = await chat(25, '2030-06-10')
    const flags = [(await tx(String(a.transaction_id)))!.possible_duplicate_of, (await tx(String(b.transaction_id)))!.possible_duplicate_of]
    expect(flags.filter((x) => x === m)).toHaveLength(1)
  })

  it('parcelado lançado no chat (plano + parcelas) pareia pelo valor da compra', async () => {
    const r = await ingest(credit({ texto: 'Compra de R$ 300,00 em 3x APROVADA em LOJA EXEMPLO para o cartão com final 0000.' }))
    await d.as('bot', `with p as (insert into public.buffet_debts (description, bank, card, kind, installment_amount, installments_total, total_amount,
        purchase_date, first_bill, source) values ('Loja', 'Nubank', 'Nubank', 'installments', 100, 3, 300, '2030-06-10', '2030-06', 'bot') returning *)
      insert into public.buffet_transactions (user_id, date, amount, merchant, category, bank, method, bill_month, debt_id, installment_no, source)
      select p.user_id, (p.purchase_date + (k - 1) * interval '1 month')::date, 100, 'Loja', 'Outros', 'Nubank', 'credit', '2030-06', p.id, k, 'bot'
        from p, generate_series(1, 3) k`)
    const first = await d.one<{ id: string }>('postgres', 'select id from public.buffet_transactions where installment_no = 1')
    expect((await tx(String(r.transaction_id)))!.possible_duplicate_of).toBe(first!.id)
  })
})

describe('revisão: confirmar, editar, descartar', () => {
  it('confirmar sem editar só muda o status (gasto e inbox)', async () => {
    const r = await ingest(debit())
    const out = await review(String(r.transaction_id))
    expect(out).toMatchObject({ review_status: 'confirmed', cash_delta: 0, amount: 25, merchant: 'Mercado Exemplo' })
    expect(await cash()).toBe(975)
    expect(await inbox(String(r.inbox_id))).toMatchObject({ status: 'confirmed' })
  })

  it('edita estabelecimento, categoria e nota; --keep-pending não confirma', async () => {
    const r = await ingest(credit())
    const out = await review(String(r.transaction_id), { merchant: 'Padaria da esquina', category: 'Alimentação', note: 'café da manhã' }, false)
    expect(out).toMatchObject({ review_status: 'pending', merchant: 'Padaria da esquina', category: 'Alimentação' })
    expect((await tx(String(r.transaction_id)))!.note).toBe('café da manhã')
    await review(String(r.transaction_id), { note: null })
    expect(await tx(String(r.transaction_id))).toMatchObject({ note: null, review_status: 'confirmed' })
  })

  it('débito → crédito devolve o caixa e põe na fatura; crédito → PIX desconta; valor novo ajusta pela diferença', async () => {
    const r = await ingest(debit())
    const id = String(r.transaction_id)
    expect(await review(id, { method: 'credit' }, false)).toMatchObject({ cash_delta: 25, bill_month: '2030-06', cash_debited: 0 })
    expect(await cash()).toBe(1000)
    expect(await review(id, { method: 'pix' }, false)).toMatchObject({ cash_delta: -25, bill_month: null, cash_debited: 25 })
    expect(await cash()).toBe(975)
    expect(await review(id, { amount: 27.5 }, false)).toMatchObject({ cash_delta: -2.5, cash_debited: 27.5, amount: 27.5 })
    expect(await cash()).toBe(972.5)
    expect(await review(id, { bank: 'Inter' }, false)).toMatchObject({ cash_delta: 27.5, cash_debited: 0 })
    expect(await cash()).toBe(1000)
  })

  it('dividir e registrar reembolso na mesma chamada: o caixa só muda pelo reembolso', async () => {
    const r = await ingest(credit())
    const out = await review(String(r.transaction_id), { share: 50, reimburse: null })
    expect(out).toMatchObject({ split_share_pct: 50, partner_amount: 6.17, reimbursed_amount: 6.17, effective_amount: 6.17, cash_delta: 6.17,
      review_status: 'confirmed' })
    expect(await cash()).toBe(1006.17)
  })

  it('descartar devolve exatamente o que foi descontado, tira da fatura e marca o inbox', async () => {
    const deb = await ingest(debit())
    const cre = await ingest(credit())
    expect(await discard(String(deb.transaction_id))).toMatchObject({ cash_delta: 25, cash_balance: 1000 })
    expect(await discard(String(cre.transaction_id))).toMatchObject({ cash_delta: 0, bill_month: '2030-06' })
    expect(await count('buffet_transactions')).toBe(0)
    expect(await inbox(String(deb.inbox_id))).toMatchObject({ status: 'discarded' })
    await expect(discard(String(deb.transaction_id))).rejects.toThrow(/não encontrado/)
    // A mesma notificação chegando de novo continua sendo repetida: descartar não reabre a porta.
    expect(await ingest(debit())).toMatchObject({ status: 'duplicate', first_status: 'discarded' })
    expect(await cash()).toBe(1000)
  })

  it('pendente não sai por DELETE direto (buffet del / app); confirmado sai', async () => {
    const r = await ingest(debit())
    await expect(d.as('bot', 'delete from public.buffet_transactions where id = $1', [r.transaction_id])).rejects.toThrow(/pendente de revisão/)
    await review(String(r.transaction_id))
    await d.as('bot', 'delete from public.buffet_transactions where id = $1', [r.transaction_id])
    expect(await count('buffet_transactions')).toBe(0)
  })

  it('recusa: descartar confirmado, descartar com reembolso, campo desconhecido, revisar gasto do chat', async () => {
    const r = await ingest(credit())
    const id = String(r.transaction_id)
    await review(id, { share: 50, reimburse: 2 }, false)
    await expect(discard(id)).rejects.toThrow(/reembolso/)
    await expect(review(id, { valor: 1 })).rejects.toThrow(/campo desconhecido: valor/)
    await expect(review(id, { method: 'boleto' })).rejects.toThrow(/meio inválido/)
    await expect(review(id, { merchant: '  ' })).rejects.toThrow(/estabelecimento vazio/)
    await review(id)
    await expect(discard(id)).rejects.toThrow(/só dá para descartar gasto pendente/)
    const manual = await chat(10, '2030-06-10')
    await expect(review(manual, {})).rejects.toThrow(/não veio de notificação/)
  })
})

describe('segurança (grants e RLS)', () => {
  it('só a service_role cria pela entrada; anon não lê o inbox; outro usuário não vê nada', async () => {
    const input = normalizeInput(debit(), NOW)
    const p = JSON.stringify(await buildPayload(debit(), input, parseNotification(input), NOW, EMPTY))
    for (const role of ['anon', 'authenticated', 'bot'] as const) {
      await expect(d.as(role, 'select public.buffet_notif_ingest($1::jsonb)', [p])).rejects.toThrow(/permission denied/)
    }
    const r = await ingest(debit())
    await expect(d.as('anon', 'select * from public.buffet_notification_inbox')).rejects.toThrow(/permission denied/)
    expect(await d.as('authenticated', 'select id from public.buffet_notification_inbox', [], OTHER)).toHaveLength(0)
    await expect(d.as('authenticated', 'select public.buffet_tx_discard($1)', [r.transaction_id], OTHER)).rejects.toThrow(/não encontrado/)
    await expect(d.as('authenticated', `insert into public.buffet_notification_inbox (payload, payload_hash, posted_at, kind) values ('{}', 'x', now(), 'unknown')`))
      .rejects.toThrow(/permission denied/)
    // O dono (app) revisa e descarta pelas mesmas funções do CLI.
    expect(await d.as('authenticated', 'select id from public.buffet_notification_inbox')).toHaveLength(1)
    expect(await discard(String(r.transaction_id), 'authenticated')).toMatchObject({ cash_delta: 25 })
  })
})

describe('Edge Function de ponta a ponta (handler + banco)', () => {
  const SECRET = 'segredo-de-teste-sintetico-0123456789'
  const deps = (ctx: CategoryContext = EMPTY) => ({
    secret: SECRET, now: () => NOW, loadContext: async () => ctx,
    ingest: async (p: unknown) => (await d.one<{ r: Record<string, unknown> }>('service_role', 'select public.buffet_notif_ingest($1::jsonb) as r', [JSON.stringify(p)]))!.r,
  })
  const post = (body: unknown, secret = SECRET, headers: Record<string, string> = {}) => new Request('https://example.invalid/functions/v1/buffet-ingest-notification', {
    method: 'POST', headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

  it('segredo errado: 401 e nada gravado; certo: gasto pendente com a categoria aprendida', async () => {
    expect((await handleIngest(post(credit(), 'errado'), deps())).status).toBe(401)
    expect(await count('buffet_notification_inbox')).toBe(0)
    const learned: CategoryContext = { ...EMPTY, learned: [{ merchantKey: 'padaria exemplo', merchant: 'Padaria do bairro', category: 'Alimentação', date: '2030-05-01' }] }
    const res = await handleIngest(post({ ...credit(), secret: 'nao-deveria-ser-gravado' }), deps(learned))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, status: 'created', merchant: 'Padaria do bairro', category: 'Alimentação', message: expect.stringContaining('pendente') })
    const stored = await d.one<{ payload: Record<string, unknown> }>('postgres', 'select payload from public.buffet_notification_inbox')
    expect(stored!.payload).not.toHaveProperty('secret')
    expect(stored!.payload).toHaveProperty('texto')
  })

  it('JSON quebrado por aspas no texto ainda entra; form-urlencoded também', async () => {
    const broken = `{"app":"Nubank","titulo":"Compra no débito aprovada","texto":"Compra de R$ 8,00 em LOJA "EXEMPLO"","timestamp":"${at('16:00')}"}`
    expect(await (await handleIngest(post(broken), deps())).json()).toMatchObject({ status: 'created', amount: 8 })
    const form = new URLSearchParams({ app: 'Nubank', titulo: 'Pix enviado', texto: 'Você enviou R$ 9,00 para Pessoa Exemplo via Pix.', timestamp: at('16:30') }).toString()
    expect(await (await handleIngest(post(form, SECRET, { 'content-type': 'application/x-www-form-urlencoded' }), deps())).json())
      .toMatchObject({ status: 'created', method: 'pix', amount: 9 })
  })
})

describe('migration', () => {
  it('troca o check de source mesmo quando ele tem outro nome no banco, e reaplicar não quebra', async () => {
    const db = await stubDb()
    const NEW = '20261109120000_buffet_notification_capture.sql'
    await applyMigrations(db, (f) => f < NEW)
    await db.exec('alter table public.buffet_transactions rename constraint buffet_transactions_source_check to legado_source_chk')
    await applyMigrations(db, (f) => f >= NEW)
    await applyMigrations(db, (f) => f >= NEW)
    const checks = await db.query<{ conname: string }>(`select conname from pg_constraint where conrelid = 'public.buffet_transactions'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) ~ '\\msource\\M'`)
    expect(checks.rows.map((r) => r.conname)).toEqual(['buffet_transactions_source_check'])
    await db.exec(`insert into public.buffet_transactions (date, amount, merchant, category, source) values ('2030-06-10', 1, 'x', 'Outros', 'notificacao')`)
    await expect(db.exec(`insert into public.buffet_transactions (date, amount, merchant, category, source) values ('2030-06-10', 1, 'x', 'Outros', 'outro')`))
      .rejects.toThrow(/source_check/)
  })
})
