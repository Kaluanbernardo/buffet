import type { Transaction } from '../data/types'
import { spendOf } from '../data/derive'
import { monthKey } from './format'

/** Excel pt-BR friendly: ";" separator, decimal comma, UTF-8 BOM so accents survive. */
const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function monthCsv(transactions: Transaction[], mk: string) {
  const rows = transactions.filter((t) => monthKey(t.date) === mk).sort((a, b) => a.date.localeCompare(b.date))
  const lines = [
    ['data', 'valor', 'estabelecimento', 'categoria', 'conta', 'nota', 'sua_parte'].join(';'),
    ...rows.map((t) => [t.date, t.amount.toFixed(2).replace('.', ','), t.merchant, t.category, t.bank ?? '', t.note ?? '', spendOf(t).toFixed(2).replace('.', ',')].map(cell).join(';')),
  ]
  return { csv: '﻿' + lines.join('\r\n') + '\r\n', count: rows.length }
}

export function download(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
