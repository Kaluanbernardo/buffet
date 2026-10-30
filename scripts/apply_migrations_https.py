#!/usr/bin/env python3
"""Aplica supabase/migrations/*.sql novas pela Supabase Management API (HTTPS), em ordem.

Cada migration roda numa transação junto com o registro em public._buffet_migrations (version, name, checksum sha256),
copiado de fitness/app/scripts/apply_migrations_https.py. Tabela própria (public._buffet_migrations) porque
as versions do buffet colidem com as do fitness em public._migrations (mesmo projeto).

Uso: scripts/apply_migrations_https.py [--dry-run]
Token: $SUPABASE_ACCESS_TOKEN ou /home/box/.secrets/supabase_access_token (nunca impresso)."""
import hashlib, json, os, pathlib, sys, urllib.error, urllib.request

REF = os.environ.get("SUPABASE_PROJECT_REF", "qlphmxjehsexuxspspaw")
TOKEN_FILE = "/home/box/.secrets/supabase_access_token"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def token():
    t = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not t and os.path.exists(TOKEN_FILE):
        t = open(TOKEN_FILE).read().strip()
    if not t:
        sys.exit("erro: SUPABASE_ACCESS_TOKEN ausente")
    return t


def run(query):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": query}).encode(), method="POST",
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json",
                 "User-Agent": "buffet-migrations"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("message", "")
        except Exception:
            msg = str(e)
        sys.exit(f"erro {e.code}: {msg}")


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def main(argv):
    dry = "--dry-run" in argv
    run("create table if not exists public._buffet_migrations (version text primary key, name text not null, "
        "checksum text not null, applied_at timestamptz not null default now()); "
        "alter table public._buffet_migrations enable row level security; "
        "revoke all on public._buffet_migrations from public, anon, authenticated;")
    applied = {r["version"]: r["checksum"] for r in run("select version, checksum from public._buffet_migrations")}
    n = 0
    for f in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
        version = f.name.split("_", 1)[0]
        body = f.read_text()
        checksum = hashlib.sha256(f.read_bytes()).hexdigest()
        if version in applied:
            if applied[version] != checksum:
                print(f"aviso: {f.name} mudou depois de aplicada (checksum diferente); não reaplicada", file=sys.stderr)
            continue
        print(("pendente " if dry else "aplicando ") + f.name)
        if dry:
            continue
        run("begin;\nset local client_min_messages = warning;\n" + body +
            f"\n;\ninsert into public._buffet_migrations (version, name, checksum) values "
            f"({lit(version)}, {lit(f.name)}, {lit(checksum)});\ncommit;")
        n += 1
    print(f"migrations novas: {n}")


if __name__ == "__main__":
    main(sys.argv[1:])
