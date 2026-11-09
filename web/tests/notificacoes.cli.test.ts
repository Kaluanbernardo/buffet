import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { freshDb, OWNER, type Db } from './pg'
import { cliServer } from './cli'
import { isSpend, normalizeInput, parseNotification } from '../../supabase/functions/_shared/notification'
import { buildPayload } from '../../supabase/functions/_shared/ingest'

// scripts/buffet de verdade, com o SQL executado no PGlite (tests/cli.ts). Datas relativas a hoje, porque o CLI usa o "hoje"
// de Brasília. Tudo sintético.
let d: Db
let cli: Awaited<ReturnType<typeof cliServer>>['cli']
let close: () => Promise<void>
const ctx = { categories: [], learned: [], history: [], subscriptions: [] }
const cash = async () => Number((await d.one<{ c: string }>('postgres', 'select cash_balance as c from public.buffet_app_config'))!.c)
const row = (id: string) => d.one<Record<string, unknown>>('postgres',
  'select merchant, category, review_status, method, bill_month, cash_debited::float8, split_share_pct::float8 from public.buffet_transactions where id = $1', [id])

async function ingest(app: string, title: string, text: string) {
  const now = new Date()
  const raw = { app, titulo: title, texto: text, timestamp: now.toISOString() }
  const input = normalizeInput(raw, now)
  const parsed = parseNotification(input)
  const p = await buildPayload(raw, input, parsed, now, isSpend(parsed) ? ctx : null)
  return (await d.one<{ r: Record<string, string> }>('service_role', 'select public.buffet_notif_ingest($1::jsonb) as r', [JSON.stringify(p)]))!.r
}

beforeAll(async () => {
  d = await freshDb()
  ;({ cli, close } = await cliServer(d))
})
afterAll(() => close())
beforeEach(async () => {
  await d.reset()
  await d.as('postgres', `insert into public.buffet_app_config (user_id, cash_balance, cash_balance_bank, banks) values ($1, 1000, 'Nubank',
    '[{"name":"Nubank","status":"active","credit":{"closing_day":11,"due_day":15}}]')`, [OWNER])
})

describe('buffet pending / review / confirm / discard', () => {
  it('lista pendentes com o efeito no caixa/fatura e os estornos; --inbox mostra o que cada notificação virou', async () => {
    await ingest('Nubank', 'Compra no débito aprovada', 'Compra de R$ 25,00 em MERCADO EXEMPLO')
    await ingest('Nubank', 'Compra no crédito aprovada', 'Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO para o cartão com final 0000.')
    await ingest('Nubank', 'Estorno', 'Estorno de compra de R$ 9,00 em LOJA EXEMPLO creditado.')
    await ingest('Nubank', 'Você recebeu um Pix', 'Você recebeu um Pix de R$ 80,00 de Pessoa Exemplo.')
    const r = await cli('pending')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Mercado Exemplo')
    expect(r.out).toContain('−R$ 25,00')
    expect(r.out).toMatch(/fatura \w{3}\/\d{2}/)
    expect(r.out).toContain('2 pendente(s) · R$ 37,34 (já nos totais) · R$ 25,00 já descontados do caixa')
    expect(r.out).toContain('estornos recebidos')
    expect(r.out).toContain('Loja Exemplo'.toUpperCase())
    const inbox = await cli('pending', '--inbox', '10')
    expect(inbox.out).toMatch(/pix_in/)
    expect(inbox.out).toMatch(/refund/)
    expect(inbox.out.match(/created/g)).toHaveLength(2)
  })

  it('review edita e confirma numa chamada; o caixa acompanha a troca de meio', async () => {
    const t = await ingest('Nubank', 'Compra no débito aprovada', 'Compra de R$ 25,00 em MERCADO EXEMPLO')
    const r = await cli('review', 'mercado ex', '--merchant', 'Mercado do bairro', '--category', 'alimentacao', '--credit', 'nubank')
    expect(r.err).toBe('')
    expect(r.out).toMatch(/Mercado do bairro · R\$ 25,00 · Alimentação · crédito fatura Nubank \w{3}\/\d{2} · confirmado · caixa \+R\$ 25,00 → R\$ 1\.000,00/)
    expect(await row(t.transaction_id)).toMatchObject({ category: 'Alimentação', review_status: 'confirmed', method: 'credit', cash_debited: 0 })
    expect(await cash()).toBe(1000)
  })

  it('review --split --reimburse-all --keep-pending divide, registra o reembolso e continua pendente', async () => {
    const t = await ingest('Nubank', 'Compra no crédito aprovada', 'Compra de R$ 40,00 APROVADA em RESTAURANTE EXEMPLO para o cartão com final 0000.')
    const r = await cli('review', t.transaction_id.slice(0, 8), '--split', '--reimburse-all', '--keep-pending')
    expect(r.out).toContain('pendente · reembolsado · sua parte R$ 20,00 · caixa +R$ 20,00')
    expect(await row(t.transaction_id)).toMatchObject({ split_share_pct: 50, review_status: 'pending' })
  })

  it('confirm --all pula possível duplicata; o expense do chat avisa e o del recusa pendente', async () => {
    const deb = await ingest('Nubank', 'Compra no débito aprovada', 'Compra de R$ 25,00 em MERCADO EXEMPLO')
    const cre = await ingest('Nubank', 'Compra no crédito aprovada', 'Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO para o cartão com final 0000.')
    const e = await cli('expense', '25', '--merchant', 'Mercado', '--category', 'Mercado', '--debit')
    expect(e.code).toBe(0)
    expect(e.err).toContain(`possível duplicata do pendente ${deb.transaction_id.slice(0, 8)}`)
    expect(e.err).toContain(`buffet discard ${deb.transaction_id.slice(0, 8)}`)
    const del = await cli('del', deb.transaction_id)
    expect(del.code).not.toBe(0)
    expect(del.err).toMatch(/pendente de revisão/)
    const all = await cli('confirm', '--all')
    expect(all.out).toContain('1 confirmado(s)')
    expect(all.err).toContain('ficou pendente (possível duplicata)')
    expect((await row(cre.transaction_id))!.review_status).toBe('confirmed')
    expect((await row(deb.transaction_id))!.review_status).toBe('pending')
    const list = await cli('list')
    expect(list.out).toContain('(pendente)')
    expect(list.out).toContain('inclui 1 pendente(s) de revisão')
  })

  it('discard devolve o caixa e dispensa estorno pelo id do inbox', async () => {
    const deb = await ingest('Nubank', 'Compra no débito aprovada', 'Compra de R$ 25,00 em MERCADO EXEMPLO')
    const ref = await ingest('Nubank', 'Estorno', 'Estorno de compra de R$ 9,00 em LOJA EXEMPLO creditado.')
    expect(await cash()).toBe(975)
    const r = await cli('discard', 'mercado')
    expect(r.out).toContain('descartado: Mercado Exemplo · R$ 25,00 · caixa +R$ 25,00 → R$ 1.000,00')
    expect(await cash()).toBe(1000)
    expect(await row(deb.transaction_id)).toBeUndefined()
    expect((await cli('discard', ref.inbox_id.slice(0, 8))).out).toContain('estorno R$ 9,00 LOJA EXEMPLO dispensado')
    expect((await cli('discard', 'mercado')).err).toMatch(/não bate com nenhum gasto pendente/)
  })

  it('confirmado já não aparece como pendente e não pode ser descartado', async () => {
    const t = await ingest('Nubank', 'Compra no crédito aprovada', 'Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO para o cartão com final 0000.')
    await cli('confirm', t.transaction_id)
    expect((await cli('pending')).out).toContain('(nada)')
    expect((await cli('discard', t.transaction_id)).err).toMatch(/só dá para descartar gasto pendente/)
  })
})

describe('review_patch (opções → p_patch)', () => {
  const py = (code: string) => spawnSync('python3', ['-I', '-B', '-c', `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("buffet_cli", sys.argv[1])
spec = importlib.util.spec_from_loader("buffet_cli", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
${code}`, resolve(__dirname, '../../scripts/buffet')], { encoding: 'utf8' })
  const patch = (o: Record<string, unknown>) => {
    const r = py(`
try:
    print(json.dumps(m.review_patch(json.loads(sys.argv[2])), ensure_ascii=False, sort_keys=True))
except SystemExit as e:
    print("exit: " + str(e))`.replace('sys.argv[2]', JSON.stringify(JSON.stringify(o))))
    return r.stdout.trim()
  }

  it('só as chaves pedidas, com a grafia/formato do CLI', () => {
    expect(patch({})).toBe('{}')
    expect(patch({ category: 'saude', merchant: 'Farmácia', amount: '12,30', credit: 'nubank' }))
      .toBe('{"amount": 12.3, "bank": "Nubank", "category": "Saúde", "merchant": "Farmácia", "method": "credit"}')
    expect(patch({ pix: true, bank: 'inter' })).toBe('{"bank": "Inter", "method": "pix"}')
    expect(patch({ split: true })).toBe('{"share": 50.0}')
    expect(patch({ share: '0' })).toBe('{"share": 0.0}')
    expect(patch({ unsplit: true })).toBe('{"share": null}')
    expect(patch({ split: true, 'reimburse-all': true, 'no-cash': true })).toBe('{"reimburse": null, "reimburse_cash": false, "share": 50.0}')
    expect(patch({ note: '' })).toBe('{"note": null}')
  })

  it('recusa combinações sem sentido', () => {
    expect(patch({ debit: true, credit: 'Nubank' })).toMatch(/^exit: erro: use só um/)
    expect(patch({ credit: 'Nubank', bank: 'Inter' })).toMatch(/^exit: erro: no crédito/)
    expect(patch({ unsplit: true, share: '50' })).toMatch(/^exit: erro: use --split/)
    expect(patch({ reimburse: '5', 'reimburse-all': true })).toMatch(/^exit: erro: use --reimburse/)
    expect(patch({ 'no-cash': true })).toMatch(/^exit: erro: --no-cash/)
  })

  it('a ajuda lista os comandos novos', () => {
    const help = py('m.main(["help"])').stdout
    for (const c of ['buffet pending', 'buffet review', 'buffet confirm', 'buffet discard']) expect(help).toContain(c)
  })
})
