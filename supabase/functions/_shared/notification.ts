/**
 * Parser das notificações de banco que o MacroDroid envia (docs/captura-notificacoes.md).
 * Puro e sem imports: roda na Edge Function (Deno) e nos testes do web (vitest). Formatos deduzidos de notificações públicas
 * do Nubank/Inter; todo exemplo nos testes é sintético. Na dúvida o parser não inventa: devolve kind 'unknown' e a notificação
 * fica só no inbox.
 */

export const PARSER_VERSION = 1

export type BankKey = 'nubank' | 'inter' | 'neon' | 'desconhecido'
/** purchase e pix_out viram gasto pendente; o resto fica só no inbox. */
export type NotificationKind = 'purchase' | 'pix_out' | 'pix_in' | 'refund' | 'declined' | 'bill' | 'promo' | 'unknown'
export type SpendMethod = 'credit' | 'debit' | 'pix'

/** O que chegou, já com os aliases resolvidos e o texto limpo. */
export interface NotificationInput {
  app: string
  title: string
  text: string
  /** ISO da notificação; null = o payload não trouxe (ou trouxe algo inválido). */
  timestamp: string | null
}

export interface ParsedNotification {
  bank: BankKey
  kind: NotificationKind
  method: SpendMethod | null
  /** true quando o texto não diz crédito nem débito e o parser assumiu crédito (o padrão do "Compra aprovada"). */
  methodGuessed: boolean
  amountCents: number | null
  merchant: string | null
  merchantKey: string | null
  cardLast4: string | null
  /** Parcelas (> 1) quando a notificação fala em "em 3x"; amountCents é sempre o total da compra. */
  installments: number | null
  /** Por que não vira gasto, ou o que foi deduzido. */
  reason: string | null
}

// ---------------------------------------------------------------- entrada

/** Nomes aceitos para cada campo (sem diferenciar maiúsculas, acentos, "_" ou "-"). O primeiro não vazio vence. */
export const FIELD_ALIASES = {
  app: ['app', 'pacote', 'package', 'packagename', 'apppackage', 'notapppackage', 'appname', 'aplicativo', 'notappname', 'source'],
  title: ['titulo', 'title', 'nottitle', 'notificationtitle', 'assunto', 'subject'],
  text: ['texto', 'text', 'body', 'mensagem', 'message', 'msg', 'notification', 'nottext', 'notificationtext', 'conteudo', 'content',
    'bigtext', 'notbigtext'],
  timestamp: ['timestamp', 'ts', 'time', 'hora', 'datahora', 'data', 'date', 'datetime', 'postedat', 'posttime', 'when', 'quando'],
} as const

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const keyOf = (k: string) => fold(k).replace(/[^a-z0-9]/g, '')

/** NBSP e espaço fino viram espaço comum; quebras e espaços repetidos viram um só. */
export const cleanText = (v: unknown) =>
  (v == null ? '' : String(v)).replace(/[   \t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

/** Campos que nunca vão para o inbox (alguém pode ter posto o segredo no corpo por engano). */
const SECRET_KEY = /secret|segredo|token|senha|password|authorization|apikey|api_key/i

/** O payload como será guardado: sem chaves com cara de segredo e sem valores enormes. */
export function storablePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (SECRET_KEY.test(k)) continue
    out[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) : v
  }
  return out
}

/**
 * Hora da notificação: epoch em segundos ou milissegundos (número ou texto), ISO, ou "dd/mm/aaaa hh:mm[:ss]" no horário
 * de Brasília (sem horário de verão desde 2019). Fora de [now − 30 dias, now + 1 dia] não é confiável: null.
 */
export function parseTimestamp(v: unknown, now: Date): string | null {
  if (v == null || v === '') return null
  let ms: number | null = null
  const s = String(v).trim()
  if (typeof v === 'number' || /^\d{9,13}(\.\d+)?$/.test(s)) {
    const n = Number(s)
    ms = n > 1e12 ? n : n * 1000
  } else {
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
    if (br) {
      const [, d, m, y, hh = '12', mm = '00', ss = '00'] = br
      const pad = (x: string) => x.padStart(2, '0')
      ms = Date.parse(`${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${mm}:${ss}-03:00`)
    } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      // Sem fuso, vale Brasília.
      ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) || s.length <= 10 ? s : `${s.replace(' ', 'T')}-03:00`)
    }
  }
  if (ms == null || !Number.isFinite(ms)) return null
  if (ms < now.getTime() - 30 * 86400000 || ms > now.getTime() + 86400000) return null
  return new Date(ms).toISOString()
}

/** Resolve os aliases (inclusive dentro de um objeto "notification"/"data" aninhado) e limpa o texto. */
export function normalizeInput(raw: Record<string, unknown>, now = new Date()): NotificationInput {
  const flat: Record<string, unknown> = {}
  // Campos de objetos aninhados primeiro; os do topo sobrescrevem.
  for (const v of Object.values(raw)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (!(keyOf(k2) in flat)) flat[keyOf(k2)] = v2
    }
  }
  for (const [k, v] of Object.entries(raw)) if (!(v && typeof v === 'object')) flat[keyOf(k)] = v
  const pick = (names: readonly string[]) => {
    for (const n of names) {
      const v = flat[n]
      if (v != null && cleanText(v) !== '') return v
    }
    return null
  }
  return {
    app: cleanText(pick(FIELD_ALIASES.app)),
    title: cleanText(pick(FIELD_ALIASES.title)),
    text: cleanText(pick(FIELD_ALIASES.text)),
    timestamp: parseTimestamp(pick(FIELD_ALIASES.timestamp), now),
  }
}

// ---------------------------------------------------------------- valores e nomes

/** "R$ 1.234,56" → 123456; "R$ 12,3" → 1230; "R$ 5" → 500; "R$ 12.34" (ponto decimal) → 1234. */
export function parseBRL(s: string): number | null {
  const m = s.match(/^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/) ?? null
  if (m) return Number(m[1].replace(/\./g, '')) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0)
  const dot = s.match(/^(\d+)\.(\d{2})$/)
  return dot ? Number(dot[1]) * 100 + Number(dot[2]) : null
}

const MONEY = /R\$\s?(\d[\d.]*(?:,\d{1,2})?)/i

/** Valor capturado sem o ponto final da frase ("R$ 63,80." → "63,80"). */
const amountOf = (s: string) => parseBRL(s.replace(/\.+$/, ''))

function firstAmount(text: string): number | null {
  const m = text.match(MONEY)
  return m ? amountOf(m[1]) : null
}

/** Chave estável do estabelecimento: sem acento, minúsculas, só letras/números separados por um espaço. */
export const merchantKey = (s: string) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim()

const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o'])
/** "PADARIA EXEMPLO DE BAIRRO" → "Padaria Exemplo de Bairro". Texto que já tem minúsculas fica como veio. */
export function prettyMerchant(s: string) {
  const t = cleanText(s)
  if (/\p{Ll}/u.test(t)) return t
  return t.toLowerCase().split(' ').map((w, i) => (i > 0 && CONNECTORS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
}

/** Corta o que vem depois do estabelecimento ("para o cartão com final 1234", "Limite disponível…", "Toque para…"). */
function trimMerchant(s: string) {
  const cut = s.split(/\s+(?:no (?:cr[eé]dito|d[eé]bito)\b|para o cart[aã]o|no cart[aã]o|com o cart[aã]o|com (?:seu )?cart[aã]o|com nubank|via pix|foi (?:aprovad|realizad|enviad|creditad|estornad)|(?:foi )?(?:creditad|estornad|cancelad)[oa]s?\b|com sucesso|no valor de|o valor de)|[,;]\s*(?:cart[aã]o|final|limite|saldo)|\s+-\s+(?:cart[aã]o|final)|\.\s+(?=\p{Lu}|\d)|\s+(?:Limite|Saldo|Toque|Clique|Aproveite|Acesse|Veja|Valor)\b/iu)[0]
  return cleanText(cut.replace(/[.!:;,\s]+$/, '')) || null
}

function pickMerchant(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re)
    if (m?.[1]) {
      const v = trimMerchant(m[1])
      if (v && !/^R\$/.test(v)) return v
    }
  }
  return null
}

const AMOUNT_SRC = String.raw`R\$\s?\d[\d.]*(?:,\d{1,2})?`
const PURCHASE_MERCHANT = [
  // "Compra de R$ 12,34 APROVADA em PADARIA EXEMPLO para o cartão com final 1234"
  new RegExp(String.raw`aprovad[ao]\s+(?:no\s+(?:cr[eé]dito|d[eé]bito)\s+|com\s+(?:o\s+)?nupay\s+)?(?:em|no|na)\s+(?!cart[aã]o)(.+)$`, 'i'),
  // "Compra de R$ 12,34 em PADARIA EXEMPLO" (débito: "aprovada" fica no título)
  new RegExp(String.raw`${AMOUNT_SRC}\s+(?:em\s+\d{1,2}x\s+)?(?:aprovad[ao]\s+)?(?:em|no|na)\s+(?!\d{1,2}x\b)(.+)$`, 'i'),
  // Inter: "você acaba de comprar no débito no MERCADO EXEMPLO o valor de R$ 63,80"
  /comprar\s+no\s+(?:cr[eé]dito|d[eé]bito)\s+(?:no|na|em)\s+(.+?)\s+o valor de/i,
  // "Débito de R$ 89,90 - SERVIÇO EXEMPLO"
  new RegExp(String.raw`${AMOUNT_SRC}\s*-\s*(.+)$`, 'i'),
]
const PIX_OUT_MERCHANT = [/\bpara\s+(.+)$/i]
const REFUND_MERCHANT = [new RegExp(String.raw`${AMOUNT_SRC}\s+(?:em|no|na|de)\s+(.+)$`, 'i'), /\b(?:em|no|na)\s+(.+)$/i]
const PIX_IN_MERCHANT = [new RegExp(String.raw`${AMOUNT_SRC}\s+(?:de|do|da)\s+(.+)$`, 'i'), /\b(?:de|do|da)\s+(.+)$/i]

// ---------------------------------------------------------------- banco e tipo

/** Banco pelo pacote/nome do app (o MacroDroid manda um dos dois). Outros apps não criam gasto. */
export function detectBank(app: string): BankKey {
  const a = fold(app)
  if (/com\.nu\.production|\bnubank\b|^nu$/.test(a)) return 'nubank'
  if (/br\.com\.intermedium|\bbanco inter\b|^inter\b/.test(a)) return 'inter'
  if (/br\.com\.neon|^neon\b|\bbanco neon\b/.test(a)) return 'neon'
  return 'desconhecido'
}

const RE = {
  declined: /recusad|negad|nao (?:foi )?aprovad|nao autorizad|bloquead|nao conseguimos aprovar/,
  refund: /estorn|compra cancelada|cancelamos (?:a|sua) compra|devolvid|devolucao|reembolso de compra/,
  // Fatura não é gasto (as compras já entraram uma a uma); pagamento de fatura vai pelo buffet pay-bill.
  bill: /fatura|boleto/,
  pixIn: /voce recebeu|recebemos (?:sua|uma) transferencia|transferencia recebida|pix recebido|recebeu um pix|deposito recebido|caiu na (?:sua )?conta/,
  pixOut: /(?:pix|transferencia) (?:enviad|realizad|feit|confirmad)|(?:pix|transferencia) de r\$ ?[\d.,]+ para |voce (?:enviou|transferiu|fez um pix|fez uma transferencia|pagou)|pix enviado|enviamos (?:o|seu) pix|pagamento (?:via|com|por) pix/,
  purchase: /compra|aprovad|pagamento aprovado|nupay|debito de r\$|comprar no/,
  promo: /ganhe|cashback|oferta|aproveite|invista|investir|rende|simul|emprestimo|limite (?:subiu|aumentou|disponivel|extra)|seguro|indique|convite|saiba mais|novidade|confira|desconto|beneficio|sorteio|premio/,
  credit: /credito/,
  debit: /debito/,
}

/** Lê uma notificação. Ordem: recusa > estorno > fatura > PIX recebido > PIX enviado > compra; sem valor nem padrão, promo/unknown. */
export function parseNotification(input: NotificationInput): ParsedNotification {
  const bank = detectBank(input.app)
  const text = input.text
  const all = cleanText(`${input.title}. ${input.text}`)
  const f = fold(all)
  const amount = firstAmount(text) ?? firstAmount(input.title)
  const base: ParsedNotification = { bank, kind: 'unknown', method: null, methodGuessed: false, amountCents: amount, merchant: null,
    merchantKey: null, cardLast4: all.match(/final\s+(\d{4})\b/i)?.[1] ?? null, installments: null, reason: null }
  const withMerchant = (p: ParsedNotification, m: string | null): ParsedNotification =>
    ({ ...p, merchant: m, merchantKey: m ? merchantKey(m) || null : null })

  if (RE.declined.test(f)) return withMerchant({ ...base, kind: 'declined', reason: 'compra recusada' }, pickMerchant(text, PURCHASE_MERCHANT))
  if (RE.refund.test(f)) return withMerchant({ ...base, kind: 'refund', reason: 'estorno: revisar à mão' }, pickMerchant(text, REFUND_MERCHANT))
  if (RE.bill.test(f)) return { ...base, kind: 'bill', reason: 'fatura/boleto não é gasto (use buffet pay-bill)' }
  if (RE.pixIn.test(f)) return withMerchant({ ...base, kind: 'pix_in', reason: 'dinheiro recebido não é gasto' }, pickMerchant(text, PIX_IN_MERCHANT))
  if (amount != null && RE.pixOut.test(f)) {
    return withMerchant({ ...base, kind: 'pix_out', method: 'pix' }, pickMerchant(text, PIX_OUT_MERCHANT))
  }
  if (amount != null && RE.purchase.test(f) && !onlyPromo(f)) {
    const credit = RE.credit.test(f), debit = RE.debit.test(f)
    const method: SpendMethod = debit && !credit ? 'debit' : 'credit'
    const parcel = all.match(/parcelad[ao]\s+em\s+(\d{1,2})\s?x\s+de\s+R\$\s?(\d[\d.]*(?:,\d{1,2})?)/i)
    const inX = all.match(/\bem\s+(\d{1,2})\s?x\b/i)
    const n = parcel ? Number(parcel[1]) : inX ? Number(inX[1]) : 1
    const cents = parcel ? (amountOf(parcel[2]) ?? 0) * n : amount
    const guessed = !credit && !debit
    return withMerchant({ ...base, kind: 'purchase', method, methodGuessed: guessed, amountCents: cents, installments: n > 1 ? n : null,
      reason: guessed ? 'meio deduzido (o texto não diz crédito nem débito)' : null }, pickMerchant(text, PURCHASE_MERCHANT))
  }
  if (RE.promo.test(f)) return { ...base, kind: 'promo', reason: 'propaganda/aviso' }
  return { ...base, kind: 'unknown', reason: amount == null ? 'sem valor no texto' : 'formato não reconhecido' }
}

/** Propaganda que fala em "compra" ("Ganhe cashback nas compras"): tem cara de promo e nenhum sinal de transação aprovada. */
const onlyPromo = (f: string) => RE.promo.test(f) && !/aprovad|compra de r\$|compra no|pagamento aprovado/.test(f)

// ---------------------------------------------------------------- dedup

/** Gasto em potencial: purchase/pix_out com valor e banco conhecido. */
export const isSpend = (p: ParsedNotification) =>
  (p.kind === 'purchase' || p.kind === 'pix_out') && p.amountCents != null && p.amountCents > 0 && p.bank !== 'desconhecido'

/**
 * O que identifica "a mesma notificação" para o hash: app, título, texto e timestamp, normalizados (espaços, NBSP, caixa do
 * app). Sem timestamp no payload entra o minuto da chegada: um retry no mesmo minuto bate o hash, e um retry mais tarde cai
 * na janela de 2 minutos do dedup_key. Sem isso, o café de R$ 5,00 de todo dia seria "repetido".
 */
export function canonicalPayload(input: NotificationInput, receivedAt: Date): string {
  const when = input.timestamp ?? `recv:${receivedAt.toISOString().slice(0, 16)}`
  return [fold(input.app), input.title, input.text, when].join('␟')
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Mesma compra = mesmo banco, tipo, valor e estabelecimento. O banco (buffet_notif_ingest) junta as que caem em até 2 minutos. */
export const dedupKey = (p: ParsedNotification) =>
  p.amountCents == null ? null : [p.bank, p.kind, p.amountCents, p.merchantKey ?? ''].join('|')

/** Janela do dedup_key, em segundos; igual à de public.buffet_notif_ingest. */
export const DEDUP_WINDOW_S = 120
