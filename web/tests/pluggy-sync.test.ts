import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { freshDb, OWNER, type Db } from './pg'
import { cliServer } from './cli'

// scripts/buffet pluggy-sync de verdade: o SQL roda no PGlite, com as migrations e o role bot, e um servidor local faz o papel do
// Pluggy. Tudo sintético.
const dir = mkdtempSync(join(tmpdir(), 'pluggy-'))
writeFileSync(join(dir, 'client'), 'cliente-falso\n')
writeFileSync(join(dir, 'items'), 'item-falso\n')
const env = { PLUGGY_CLIENT_SECRET: 'segredo-falso', PLUGGY_CLIENT_ID_FILE: join(dir, 'client'), PLUGGY_ITEM_IDS_FILE: join(dir, 'items') }

const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const at = `${today}T12:00:00.000Z`
const tx = (id: string, amount: number, description: string, type: string, extra: object = {}) => ({
  id, amount, description, type, date: at, createdAt: at, status: 'POSTED', category: null, operationType: null, creditCardMetadata: null, ...extra })
const state = { bank: [] as unknown[], card: [] as unknown[], balance: 900, snapshot: at, status: 'UPDATED' }

function pluggy(path: string): unknown {
  if (path === '/auth') return { apiKey: 'chave-falsa' }
  if (path.startsWith('/items/')) return { status: state.status, executionStatus: 'SUCCESS', lastUpdatedAt: state.snapshot }
  if (path.startsWith('/accounts')) return { results: [
    { id: 'conta', type: 'BANK', balance: state.balance, currencyCode: 'BRL' }, { id: 'cartao', type: 'CREDIT', balance: 0, currencyCode: 'BRL' }] }
  if (path.startsWith('/bills')) return { results: [], totalPages: 1 }
  if (path.startsWith('/v2/transactions')) return { results: path.includes('accountId=conta') ? state.bank : state.card, next: null }
  return {}
}

let d: Db
let cli: Awaited<ReturnType<typeof cliServer>>['cli']
let close: () => Promise<void>
const count = async (t: string) => Number((await d.one<{ n: string }>('postgres', `select count(*) n from public.${t}`))!.n)
const cash = async () => Number((await d.one<{ c: string }>('postgres', 'select cash_balance c from public.buffet_app_config'))!.c)
const row = (id: string) => d.one<Record<string, unknown>>('postgres', 'select * from public.buffet_transactions where id = $1', [id])

beforeAll(async () => {
  d = await freshDb()
  ;({ cli, close } = await cliServer(d, { pluggy, env }))
})
afterAll(() => close())
beforeEach(async () => {
  await d.reset()
  await d.db.exec('truncate public.buffet_pluggy_seen, public.buffet_incomes')
  await d.as('postgres', `insert into public.buffet_app_config (user_id, cash_balance, cash_balance_bank, banks) values ($1, 1000, 'Nubank',
    '[{"name":"Nubank","status":"active","credit":{"closing_day":11,"due_day":15}}]')`, [OWNER])
  // Um registro antigo de ledger: fora da primeira execução, sem base do import.
  await d.as('postgres', `insert into public.buffet_pluggy_seen (id, user_id, outcome) values ('antigo', $1, 'known')`, [OWNER])
  Object.assign(state, { bank: [], card: [], balance: 900, snapshot: at, status: 'UPDATED' })
})

const sample = () => {
  state.bank = [
    tx('b-pix', -50, 'Transferência enviada pelo Pix|PADARIA EXEMPLO', 'DEBIT', { operationType: 'PIX' }),
    tx('b-sal', 3000, 'Transferência recebida', 'CREDIT'),
    tx('b-fat', -200, 'Pagamento de fatura', 'DEBIT'),
    tx('b-eu', -80, 'Transferência', 'DEBIT', { category: 'Same person transfer' }),
  ]
  state.card = [tx('c-loja', 30, 'LOJA EXEMPLO', 'DEBIT')]
}

describe('buffet pluggy-sync', () => {
  it('importa, grava o ledger e atualiza o caixa', async () => {
    sample()
    const r = await cli('pluggy-sync')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(await row('b-pix')).toMatchObject({ method: 'pix', merchant: 'Padaria Exemplo', source: 'bot', review_status: null, cash_debited: null, bank: 'Nubank' })
    expect((await row('c-loja'))!.bill_month).toMatch(/^\d{4}-\d{2}$/)
    expect(await count('buffet_card_payments')).toBe(1)
    expect(await row('b-eu')).toBeUndefined()
    const inc = await d.one<{ a: string }>('postgres', 'select sum(amount) a from public.buffet_incomes')
    expect(Number(inc!.a)).toBe(3000)
    expect(await cash()).toBe(900)
    expect(await count('buffet_pluggy_seen')).toBe(6)
  })

  it('rodar de novo não muda nada', async () => {
    sample()
    await cli('pluggy-sync')
    const before = [await count('buffet_transactions'), await count('buffet_card_payments'), await count('buffet_pluggy_seen')]
    const r = await cli('pluggy-sync')
    expect(r.out).toContain('já processadas: 5')
    expect([await count('buffet_transactions'), await count('buffet_card_payments'), await count('buffet_pluggy_seen')]).toEqual(before)
    const inc = await d.one<{ a: string }>('postgres', 'select sum(amount) a from public.buffet_incomes')
    expect(Number(inc!.a)).toBe(3000)
  })

  it('--dry-run não grava nada', async () => {
    sample()
    const r = await cli('pluggy-sync', '--dry-run')
    expect(r.code).toBe(0)
    expect(r.out).toContain('dry-run')
    expect(r.out).toContain('gastos novos: 2')
    expect(await count('buffet_transactions')).toBe(0)
    expect(await count('buffet_pluggy_seen')).toBe(1)
    expect(await cash()).toBe(1000)
  })

  it('sem a migration: dry-run funciona, gravação recusa', async () => {
    await d.db.exec('alter table public.buffet_pluggy_seen rename to buffet_pluggy_seen_x')
    try {
      expect((await cli('pluggy-sync', '--dry-run')).code).toBe(0)
      const r = await cli('pluggy-sync')
      expect(r.code).toBe(1)
      expect(r.err).toContain('20261110190000')
    } finally {
      await d.db.exec('alter table public.buffet_pluggy_seen_x rename to buffet_pluggy_seen')
    }
  })

  it('possível duplicata entra como pendente e não volta depois de descartada', async () => {
    await d.as('postgres', `insert into public.buffet_transactions (id, user_id, date, amount, merchant, category, bank, method, source)
      values ('manual', $1, $2, 30, 'Loja', 'Outros', 'Nubank', 'credit', 'bot')`, [OWNER, today])
    state.card = [tx('c-loja', 30, 'LOJA EXEMPLO', 'DEBIT')]
    const r = await cli('pluggy-sync')
    expect(r.out).toContain('possíveis duplicatas: 1')
    expect(await row('c-loja')).toMatchObject({ review_status: 'pending', possible_duplicate_of: 'manual' })
    expect((await cli('pending')).out).toContain('possível duplicata de manual')
    expect((await cli('discard', 'c-loja')).code).toBe(0)
    expect(await row('c-loja')).toBeUndefined()
    await cli('pluggy-sync')
    expect(await row('c-loja')).toBeUndefined()
  })

  it('gasto apagado à mão não volta', async () => {
    state.card = [tx('c-loja', 30, 'LOJA EXEMPLO', 'DEBIT')]
    await cli('pluggy-sync')
    expect((await cli('del', 'c-loja')).code).toBe(0)
    await cli('pluggy-sync')
    expect(await row('c-loja')).toBeUndefined()
  })

  it('estorno de gasto já lançado aparece em Estornos e o gasto fica', async () => {
    state.card = [tx('c-loja', 30, 'LOJA EXEMPLO', 'DEBIT')]
    await cli('pluggy-sync')
    state.card = [...state.card, tx('c-est', -30, 'Estorno', 'CREDIT', { operationType: 'ESTORNO' })]
    const r = await cli('pluggy-sync')
    expect(r.out).toContain('estornos a revisar: 1')
    expect(await row('c-loja')).toBeDefined()
    expect((await cli('pending')).out).toContain('estornos recebidos')
    expect((await cli('discard', 'c-est')).code).toBe(0)
  })

  it('parcelado cria o plano e as parcelas', async () => {
    const md = (k: number) => ({ creditCardMetadata: { totalInstallments: 2, installmentNumber: k, purchaseDate: at, cardNumber: '0000' } })
    state.card = [tx('k1', 30, 'LOJA 1/2', 'DEBIT', md(1)), tx('k2', 30, 'LOJA 2/2', 'DEBIT', md(2))]
    expect((await cli('pluggy-sync')).err).toBe('')
    expect(await count('buffet_debts')).toBe(1)
    const k = await d.as<{ installment_no: number; debt_id: string }>('postgres', 'select installment_no, debt_id from public.buffet_transactions order by installment_no')
    expect(k.map((x) => x.installment_no)).toEqual([1, 2])
    expect(k[0].debt_id).toMatch(/^pluggy-plan-/)
  })

  it('o caixa desconta o que saiu depois da foto e zera o cash_debited anterior', async () => {
    await d.as('postgres', `insert into public.buffet_transactions (id, user_id, date, amount, merchant, category, bank, method, source, review_status, cash_debited, created_at)
      values ('antes', $1, $2, 10, 'A', 'Outros', 'Nubank', 'debit', 'notificacao', 'pending', 10, $3::timestamptz - interval '1 hour'),
             ('depois', $1, $2, 20, 'B', 'Outros', 'Nubank', 'debit', 'notificacao', 'pending', 20, $3::timestamptz + interval '1 hour')`, [OWNER, today, at])
    expect((await cli('pluggy-sync')).code).toBe(0)
    expect(await cash()).toBe(880)
    expect(Number((await row('antes'))!.cash_debited)).toBe(0)
    expect(Number((await row('depois'))!.cash_debited)).toBe(20)
  })

  it('item desatualizado: importa, mas não mexe no caixa', async () => {
    state.status = 'OUTDATED'
    state.card = [tx('c-loja', 30, 'LOJA EXEMPLO', 'DEBIT')]
    const r = await cli('pluggy-sync')
    expect(r.err).toContain('não está atualizado')
    expect(await cash()).toBe(1000)
    expect(await row('c-loja')).toBeDefined()
  })

  it('nunca imprime credenciais', async () => {
    sample()
    const r = await cli('pluggy-sync', '--verbose')
    for (const s of ['segredo-falso', 'cliente-falso', 'chave-falsa', 'item-falso']) expect(r.out + r.err).not.toContain(s)
  })
})
