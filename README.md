# Buffet Kaluan

PWA pessoal de finanças (pt-BR, BRL). Publicado em **https://kaluanbernardo.github.io/buffet/**.

## Rodar local
```bash
cd web
cp .env.example .env.local   # preencha VITE_APP_PASSWORD_HASH
npm install
npm run dev                  # http://localhost:5173/buffet/
```
Gerar o hash da senha (não commitar):
```bash
printf '%s' 'minha-senha' | sha256sum | cut -d' ' -f1
```

## Deploy (GitHub Pages)
1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets → Actions: `VITE_APP_PASSWORD_HASH` = hash SHA-256 hex.
3. Push em `main` → workflow `.github/workflows/pages.yml` publica `web/dist`.

## Instalar no Android
Abra a URL no Chrome → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").

## Arquitetura
- `web/src/lib/auth.ts` — `AuthAdapter`. F0: senha (SHA-256 vs `VITE_APP_PASSWORD_HASH`, sessão em `sessionStorage`). F1: Supabase Auth.
- `web/src/data/store.ts` — `DataStore`. F0: `localStorage`. F1: Supabase (mesmo projeto do fitness).
- `supabase/migrations/` — rascunho das tabelas `public.buffet_*` com RLS por `auth.uid()` (**não aplicado**).
- Ícones: `npm run icons` (Python + Pillow) gera `web/public/icons/*.png`.

> A senha atual é um gate temporário só no cliente — não é segurança real. Os dados ficam no aparelho até a F1.
