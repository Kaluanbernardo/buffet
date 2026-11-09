/**
 * Handler HTTP da Edge Function buffet-ingest-notification, sem nada de Deno: index.ts injeta o segredo e o acesso ao banco,
 * e os testes (vitest) injetam dublês. Fluxo: método → segredo (tempo constante) → corpo → parser → categoria → banco.
 * Nunca loga o conteúdo da notificação (é dado financeiro): só status e ids.
 */
import { canonicalPayload, dedupKey, isSpend, normalizeInput, parseNotification, PARSER_VERSION, sha256Hex, storablePayload,
  type NotificationInput, type ParsedNotification } from './notification.ts'
import { suggestCategory, type CategoryContext } from './category.ts'

export const SECRET_HEADER = 'x-buffet-ingest-secret'
export const MAX_BODY_BYTES = 32 * 1024
/** Segredo curto demais é recusado na configuração (a função responde 503 até ter um decente). */
export const MIN_SECRET_LENGTH = 24

/** O que vai para public.buffet_notif_ingest (ver a migration). */
export interface IngestPayload {
  payload: Record<string, unknown>; payload_hash: string
  app: string; title: string; body: string; posted_at: string | null
  bank: ParsedNotification['bank']; kind: ParsedNotification['kind']; method: ParsedNotification['method']
  amount_cents: number | null; merchant: string | null; merchant_key: string | null; card_last4: string | null
  installments: number | null; dedup_key: string | null; parser_version: number; reason: string | null
  display_merchant: string | null; category: string | null; note: string | null
}

export interface IngestDeps {
  /** Valor de BUFFET_INGEST_SECRET (Supabase secrets). Ausente/curto = a função não aceita nada. */
  secret: string | undefined
  /** Histórico para a categoria; só é chamado para gasto em potencial. */
  loadContext: (merchantKey: string | null) => Promise<CategoryContext>
  ingest: (p: IngestPayload) => Promise<Record<string, unknown>>
  now?: () => Date
  log?: (msg: string) => void
}

/**
 * Compara em tempo constante: os dois lados viram SHA-256 (mesmo tamanho, nada vaza pelo comprimento) e a comparação
 * percorre todos os bytes sem sair antes.
 */
export async function secretMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))])
  const x = new Uint8Array(a), y = new Uint8Array(b)
  let diff = given.length === 0 ? 1 : 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * Corpo aceito: JSON (objeto), form-urlencoded, ou um "JSON" quebrado por aspas dentro do texto (o MacroDroid insere o texto
 * da notificação cru): nesse caso extrai os campos conhecidos um a um. null = nada aproveitável.
 */
export function readBody(raw: string, contentType: string): Record<string, unknown> | null {
  const t = raw.trim()
  if (!t) return null
  if (/application\/x-www-form-urlencoded/i.test(contentType) || (!t.startsWith('{') && /^[\w%.-]+=/.test(t))) {
    return Object.fromEntries(new URLSearchParams(t))
  }
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    // "texto": "Compra em "LOJA" aprovada" → pega de cada chave até a próxima chave conhecida ou o fim do objeto.
    const out: Record<string, unknown> = {}
    const re = /"([\wÀ-ſ-]+)"\s*:\s*(?:"([\s\S]*?)"(?=\s*,\s*"[\wÀ-ſ-]+"\s*:|\s*}\s*$)|(-?\d+(?:\.\d+)?))/g
    for (const m of t.matchAll(re)) out[m[1]] = m[2] ?? Number(m[3])
    return Object.keys(out).length ? out : null
  }
}

/** Monta o que vai para o banco. Exportado para os testes. */
export async function buildPayload(raw: Record<string, unknown>, input: NotificationInput, parsed: ParsedNotification, now: Date,
  ctx: CategoryContext | null): Promise<IngestPayload> {
  const s = ctx && isSpend(parsed) ? suggestCategory(parsed.merchant, ctx) : null
  return {
    payload: storablePayload(raw), payload_hash: await sha256Hex(canonicalPayload(input, now)),
    app: input.app, title: input.title, body: input.text, posted_at: input.timestamp ?? now.toISOString(),
    bank: parsed.bank, kind: parsed.kind, method: parsed.method, amount_cents: parsed.amountCents, merchant: parsed.merchant,
    merchant_key: parsed.merchantKey, card_last4: parsed.cardLast4, installments: parsed.installments, dedup_key: dedupKey(parsed),
    parser_version: PARSER_VERSION, reason: parsed.reason,
    display_merchant: s?.merchant ?? null, category: s?.category ?? null,
    note: s && parsed.methodGuessed ? 'meio deduzido: confira crédito/débito' : null,
  }
}

/** Frase curta para o MacroDroid mostrar num toast, se quiser. Sem saldo. */
function message(r: Record<string, unknown>) {
  const v = typeof r.amount === 'number' || typeof r.amount === 'string' ? `R$ ${Number(r.amount).toFixed(2).replace('.', ',')}` : ''
  if (r.status === 'created') return `Buffet: ${v} ${r.merchant ?? ''} pendente de revisão`.replace(/\s+/g, ' ').trim()
  if (r.status === 'duplicate') return 'Buffet: notificação repetida, nada novo'
  if (r.status === 'refund') return 'Buffet: estorno anotado para revisão'
  return 'Buffet: notificação ignorada'
}

export async function handleIngest(req: Request, deps: IngestDeps): Promise<Response> {
  const log = deps.log ?? (() => {})
  if (req.method !== 'POST') return json(405, { ok: false, error: 'use POST' })
  if (!deps.secret || deps.secret.length < MIN_SECRET_LENGTH) {
    log('BUFFET_INGEST_SECRET ausente ou curto: recusando')
    return json(503, { ok: false, error: 'ingest não configurado' })
  }
  if (!(await secretMatches(req.headers.get(SECRET_HEADER) ?? '', deps.secret))) return json(401, { ok: false, error: 'segredo inválido' })

  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: 'corpo grande demais' })
  const raw = await req.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'corpo grande demais' })
  const body = readBody(raw, req.headers.get('content-type') ?? '')
  if (!body) return json(400, { ok: false, error: 'corpo precisa ser JSON (ou form) com titulo/texto' })

  const now = (deps.now ?? (() => new Date()))()
  const input = normalizeInput(body, now)
  if (!input.title && !input.text) return json(400, { ok: false, error: 'sem titulo nem texto (aceita titulo/title, texto/text/body)' })
  const parsed = parseNotification(input)
  try {
    const ctx = isSpend(parsed) ? await deps.loadContext(parsed.merchantKey) : null
    const result = await deps.ingest(await buildPayload(body, input, parsed, now, ctx))
    log(`ingest ${String(result.status)} inbox=${String(result.inbox_id ?? '-')} tx=${String(result.transaction_id ?? '-')}`)
    return json(200, { ok: true, ...result, message: message(result) })
  } catch (e) {
    log(`ingest falhou: ${e instanceof Error ? e.message : String(e)}`)
    // Retry é seguro: o mesmo payload cai no dedup por hash.
    return json(500, { ok: false, error: 'erro ao gravar; pode reenviar' })
  }
}
