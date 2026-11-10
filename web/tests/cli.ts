/**
 * Roda scripts/buffet de verdade contra o PGlite: um servidor local faz o papel da Management API (POST {query} → linhas do
 * último comando que devolve linhas; erro → 400 "ERROR:  <sqlstate>: <mensagem>") e um wrapper Python desvia o urlopen do CLI
 * para ele. Assim o SQL que o CLI monta (role bot, CTEs, funções) é executado de fato. Nenhum token real: o CLI recebe um falso.
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import type { Db } from './pg'

const CLI = resolve(__dirname, '../../scripts/buffet')
const WRAPPER = `
import importlib.machinery, importlib.util, sys, urllib.request
real = urllib.request.urlopen
def fake(req, timeout=None):
    if req.full_url.startswith("https://api.pluggy.ai/"):
        return real(urllib.request.Request(sys.argv[2] + "__pluggy" + req.full_url[len("https://api.pluggy.ai"):], data=req.data, method=req.get_method(), headers={"Content-Type": "application/json"}), timeout=60)
    assert req.full_url.startswith("https://api.supabase.com/v1/projects/"), req.full_url
    return real(urllib.request.Request(sys.argv[2], data=req.data, method="POST", headers={"Content-Type": "application/json"}), timeout=60)
urllib.request.urlopen = fake
loader = importlib.machinery.SourceFileLoader("buffet_cli", sys.argv[1])
spec = importlib.util.spec_from_loader("buffet_cli", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.entry(sys.argv[3:])
`

/** pluggy: responde as chamadas de api.pluggy.ai (caminho → JSON). env: variáveis extras para o CLI. */
export async function cliServer(d: Db, opts: { pluggy?: (path: string) => unknown; env?: Record<string, string> } = {}) {
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      if (req.url?.startsWith('/__pluggy')) {
        res.setHeader('content-type', 'application/json')
        res.statusCode = 200
        res.end(JSON.stringify(opts.pluggy?.(req.url.slice('/__pluggy'.length)) ?? {}))
        return
      }
      const { query } = JSON.parse(body) as { query: string }
      res.setHeader('content-type', 'application/json')
      try {
        const results = await d.db.exec(query)
        const last = [...results].reverse().find((r) => r.fields.length > 0)
        res.statusCode = 201
        res.end(JSON.stringify(last?.rows ?? []))
      } catch (e) {
        await d.db.exec('rollback').catch(() => {})
        const err = e as { code?: string; message?: string }
        res.statusCode = 400
        res.end(JSON.stringify({ message: `Failed to run sql query: ERROR:  ${err.code ?? 'XX000'}: ${err.message ?? String(e)}` }))
      }
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  /** `buffet <args>`: stdout, stderr e código de saída. */
  const cli = (...args: string[]) => new Promise<{ out: string; err: string; code: number | null }>((ok) => {
    const p = spawn('python3', ['-I', '-B', '-c', WRAPPER, CLI, url, ...args], { env: { PATH: process.env.PATH ?? '', SUPABASE_ACCESS_TOKEN: 'token-falso-de-teste', ...opts.env } })
    let out = '', err = ''
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { err += c })
    p.on('close', (code) => ok({ out, err, code }))
  })
  return { cli, close: () => new Promise<void>((ok) => server.close(() => ok())) }
}
