/**
 * Categoria sugerida para um gasto que chegou por notificação. Pura e sem imports (Deno + vitest).
 * Ordem: o que você já confirmou para esse estabelecimento > assinatura que bate > histórico de lançamentos > regras por
 * palavra > Outros. Só sugere categoria que existe na sua lista (buffet_app_config.categories).
 */
import { merchantKey, prettyMerchant } from './notification.ts'

export interface LearnedRow { merchantKey: string; merchant: string; category: string; date: string }
export interface HistoryRow { merchant: string; category: string; date: string }
export interface SubRow { name: string; match?: string | null; category: string; status: string }
export interface CategoryContext {
  categories: string[]
  /** Notificações já confirmadas: merchant_key do banco → como você deixou (nome e categoria). */
  learned: LearnedRow[]
  /** Lançamentos (chat/app/notificação confirmada), mais recentes primeiro. */
  history: HistoryRow[]
  subscriptions: SubRow[]
}
export type SuggestionSource = 'aprendido' | 'assinatura' | 'historico' | 'regra' | 'padrao'
export interface Suggestion { category: string; merchant: string; source: SuggestionSource }

/** Mesma lista do app (web/src/data/seed.ts), para quando a configuração ainda não existe. */
export const DEFAULT_CATEGORIES = ['Alimentação', 'Transporte', 'Moradia', 'Saúde', 'Lazer', 'Assinaturas', 'Educação', 'Vestimenta',
  'Mercado', 'Doação', 'Fitness', 'Jogos', 'Pró-vida', 'Telefonia e internet', 'Pet', 'Impostos', 'Outros']

/**
 * Palavras (ou sequências de palavras) do estabelecimento → categoria. Comparadas por palavra inteira depois de merchantKey
 * ("IFD*RESTAURANTE" → "ifd restaurante"), então "bar" não pega "barbearia". A primeira regra que bate vence.
 */
export const RULES: { category: string; words: string[] }[] = [
  { category: 'Assinaturas', words: ['netflix', 'spotify', 'youtube premium', 'youtubepremium', 'disney', 'hbo', 'hbomax', 'max com',
    'prime video', 'amazon prime', 'amazonprime', 'apple com bill', 'icloud', 'deezer', 'globoplay', 'paramount', 'crunchyroll',
    'chatgpt', 'openai', 'google one', 'microsoft 365'] },
  // Marketplace não diz o que foi comprado: fica em Outros (e não cai em "mercado" de Mercado). Abaixo de Assinaturas por "amazon prime".
  { category: 'Outros', words: ['mercado livre', 'mercadolivre', 'mercado pago', 'mercadopago', 'amazon', 'shopee', 'aliexpress',
    'magazine luiza', 'magalu', 'americanas', 'temu'] },
  { category: 'Jogos', words: ['steam', 'playstation', 'psn', 'xbox', 'nintendo', 'epic games', 'riot', 'blizzard', 'google play'] },
  { category: 'Transporte', words: ['uber', '99app', '99 pop', '99pop', '99 taxi', 'cabify', 'indrive', 'posto', 'shell', 'ipiranga',
    'petrobras', 'br mania', 'combustivel', 'estacionamento', 'estapar', 'zona azul', 'metro', 'sptrans', 'bilhete unico', 'onibus',
    'pedagio', 'sem parar', 'veloe', 'conectcar', 'latam', 'gol linhas', 'azul linhas', 'buser', 'clickbus'] },
  { category: 'Mercado', words: ['supermercado', 'mercado', 'mercadinho', 'atacadao', 'assai', 'carrefour', 'pao de acucar', 'hortifruti',
    'sacolao', 'atacarejo', 'makro', 'sams club', 'oba hortifruti', 'minuto pa', 'dia brasil'] },
  { category: 'Alimentação', words: ['ifood', 'ifd', 'rappi', 'restaurante', 'lanchonete', 'padaria', 'panificadora', 'cafe', 'cafeteria',
    'pizzaria', 'pizza', 'hamburgueria', 'burger', 'mcdonalds', 'mc donalds', 'bk', 'subway', 'starbucks', 'acai', 'sorveteria', 'bar',
    'boteco', 'churrascaria', 'sushi', 'confeitaria', 'doceria', 'pastelaria', 'food', 'lanches', 'outback', 'habibs', 'spoleto'] },
  { category: 'Saúde', words: ['farmacia', 'drogaria', 'drogasil', 'droga raia', 'raia', 'pague menos', 'panvel', 'hospital', 'clinica',
    'laboratorio', 'odonto', 'dentista', 'unimed', 'consultorio', 'otica'] },
  { category: 'Fitness', words: ['academia', 'smart fit', 'smartfit', 'bluefit', 'gympass', 'wellhub', 'crossfit', 'bodytech', 'selfit'] },
  { category: 'Pet', words: ['petz', 'cobasi', 'petshop', 'pet shop', 'veterinaria', 'veterinario', 'petlove', 'agropet'] },
  { category: 'Telefonia e internet', words: ['vivo', 'claro', 'tim', 'oi fibra', 'net virtua', 'telefonica', 'algar'] },
  { category: 'Vestimenta', words: ['renner', 'riachuelo', 'c a', 'cea', 'zara', 'hering', 'centauro', 'netshoes', 'shein', 'marisa',
    'pernambucanas', 'decathlon'] },
  { category: 'Educação', words: ['udemy', 'alura', 'coursera', 'livraria', 'escola', 'faculdade', 'universidade', 'curso', 'colegio'] },
  { category: 'Lazer', words: ['cinema', 'cinemark', 'ingresso', 'ingressos', 'sympla', 'eventim', 'teatro', 'museu'] },
  { category: 'Moradia', words: ['aluguel', 'condominio', 'enel', 'sabesp', 'copel', 'cemig', 'light', 'comgas', 'energia', 'saneamento',
    'leroy merlin', 'telhanorte'] },
  { category: 'Impostos', words: ['iptu', 'ipva', 'darf', 'detran', 'receita federal', 'prefeitura'] },
]

const tokens = (s: string) => merchantKey(s).split(' ').filter(Boolean)
/** As palavras de `needle` aparecem em sequência dentro de `hay`. */
function hasRun(hay: string[], needle: string[]) {
  if (!needle.length || needle.length > hay.length) return false
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return true
  return false
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

/** A regra por palavra, ou null. */
export function ruleCategory(merchant: string, categories: string[] = DEFAULT_CATEGORIES): string | null {
  const t = tokens(merchant)
  for (const r of RULES) if (categories.includes(r.category) && r.words.some((w) => hasRun(t, w.split(' ')))) return r.category
  return null
}

/** Categoria mais usada entre as linhas (empate: a mais recente). */
function mostUsed(rows: HistoryRow[]) {
  const by = new Map<string, { n: number; last: string; merchants: Map<string, number> }>()
  for (const r of rows) {
    const e = by.get(r.category) ?? { n: 0, last: '', merchants: new Map() }
    e.n++
    if (r.date > e.last) e.last = r.date
    e.merchants.set(r.merchant, (e.merchants.get(r.merchant) ?? 0) + 1)
    by.set(r.category, e)
  }
  const [cat, e] = [...by].sort((a, b) => b[1].n - a[1].n || b[1].last.localeCompare(a[1].last))[0] ?? []
  if (!cat || !e) return null
  const merchant = [...e.merchants].sort((a, b) => b[1] - a[1])[0][0]
  return { category: cat, merchant }
}

export function suggestCategory(merchant: string | null, ctx: CategoryContext): Suggestion {
  const categories = ctx.categories.length ? ctx.categories : DEFAULT_CATEGORIES
  const known = (c: string) => categories.includes(c)
  const pretty = merchant ? prettyMerchant(merchant) : 'Sem descrição'
  const fallback: Suggestion = { category: known('Outros') ? 'Outros' : categories[categories.length - 1], merchant: pretty, source: 'padrao' }
  if (!merchant) return fallback
  const key = merchantKey(merchant)

  // 1. Você já confirmou esse estabelecimento antes: o nome e a categoria que você deixou.
  const learned = ctx.learned.filter((r) => r.merchantKey === key && known(r.category)).sort((a, b) => b.date.localeCompare(a.date))[0]
  if (learned) return { category: learned.category, merchant: learned.merchant, source: 'aprendido' }

  // 2. Assinatura ativa cujo match (ou nome) aparece no estabelecimento.
  const sub = ctx.subscriptions.find((s) => s.status === 'active' && known(s.category) && fold(s.match || s.name).length > 0
    && fold(merchant).includes(fold(s.match || s.name)))
  if (sub) return { category: sub.category, merchant: sub.name, source: 'assinatura' }

  // 3. Histórico: mesmo estabelecimento, ou um nome curto que você usa no chat contido nele ("Uber" em "UBER *TRIP").
  const t = tokens(merchant)
  const same = ctx.history.filter((r) => known(r.category) && merchantKey(r.merchant) === key)
  const hist = mostUsed(same)
  if (hist) return { category: hist.category, merchant: hist.merchant, source: 'historico' }
  const inside = ctx.history.filter((r) => {
    const k = tokens(r.merchant)
    return known(r.category) && k.join(' ').length >= 4 && hasRun(t, k)
  })
  const histIn = mostUsed(inside)
  if (histIn) return { category: histIn.category, merchant: pretty, source: 'historico' }

  // 4. Regras por palavra.
  const rule = ruleCategory(merchant, categories)
  if (rule) return { category: rule, merchant: pretty, source: 'regra' }
  return fallback
}
