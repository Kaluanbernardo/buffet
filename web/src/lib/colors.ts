/**
 * Data hues, chart marks only (legend dots, share bars) — never text, never icons. Fixed per category so a
 * filter never repaints survivors. One set for both themes: every hue clears 3:1 on #151a21 and on #fff.
 * Validated as a set of 11: CIEDE2000 ≥ 14 in normal vision, ≥ 7.2 under protan/deutan simulation, ≥ 10 tritan,
 * and ≥ 10 from the status hues (accent/negative/warning) and the neutral. Icons still carry identity.
 * Outros (a real category, not a bucket) has its own hue, ≥ 30 ΔE76 from every other value here and from NEUTRAL_MARK.
 */
export const CAT_COLORS: Record<string, string> = {
  Alimentação: '#2097ed', Transporte: '#a87848', Moradia: '#1b9b70', Saúde: '#98982c',
  Lazer: '#e363ae', Assinaturas: '#6e57e1', Educação: '#3b7689', Vestimenta: '#9848a8',
  Mercado: '#558217', Doação: '#c31078', Fitness: '#756432', Jogos: '#d8572a', 'Pró-vida': '#2fa3a3', 'Telefonia e internet': '#5b6ee1', Pet: '#b5651d', Impostos: '#7a4fb8',
  Outros: '#a05870',
}
export const NEUTRAL_MARK = '#5b6675'

/** Same name → same colour, always; names outside the table get a hue from a hash of the name (never one shared grey). */
function fallbackColor(category: string) {
  let h = 2166136261
  for (let i = 0; i < category.length; i++) h = Math.imul(h ^ category.charCodeAt(i), 16777619)
  return `hsl(${(h >>> 0) % 360} 55% 50%)`
}
export const catColor = (category: string) => CAT_COLORS[category] ?? fallbackColor(category)
