# Task: Buffet F0 — personal finance PWA for Kaluan

Build in /workspace/buffet (this git repo, remote already set to https://github.com/Kaluanbernardo/buffet.git).

## Goal
Mirror the fitness app pattern (Kaluanbernardo/treinos) but for personal finance.
Single-user PWA, pt-BR, BRL, installable on Android, deployable to GitHub Pages at /buffet/.

## Stack
- `web/`: Vite + React + TypeScript + Tailwind + vite-plugin-pwa
- Hash routing (HashRouter) so GitHub Pages deep links work
- `base: '/buffet/'` in vite.config
- Dark theme, Inter/system fonts, big cards radius 16–20, tabular-nums for money
- No Firebase. No backend yet: data in localStorage. Auth = client password gate (temporary until Supabase).

## Auth (temporary)
- Login screen: password only (no signup). Email field optional label "Kaluan" fixed.
- Compare SHA-256 hex of password to `import.meta.env.VITE_APP_PASSWORD_HASH`
- Session: sessionStorage key `buffet_authed=1` (logout clears it)
- If env hash missing, show friendly "Quase lá — falta configurar a senha" screen
- Never hardcode the real password or hash in source

## Screens (bottom nav)
1. **Hoje** — month spend total, budget progress bars by category, upcoming dues count
2. **Gastos** — list + quick-add (amount, merchant, category, date); seed example Mangará R$ 29,47 Alimentação
3. **Orçamento** — edit monthly limits per category
4. **Dívidas** — card installments list (placeholder rows ok)
5. **Mais** — Reserva progress, Investimentos list, Config (banks Nubank/Neon/Inter active, XP planned; Open Finance stub button)

Categories default: Alimentação, Transporte, Moradia, Saúde, Lazer, Assinaturas, Educação, Outros.

## PWA
- manifest name "Buffet Kaluan", short_name "Buffet", theme/background #0E1116
- Generate simple PNG icons 192/512 + maskable (script ok)
- theme-color meta

## Deploy
- `.github/workflows/pages.yml` like treinos but working-directory `web`, secret `VITE_APP_PASSWORD_HASH`
- README.md: how to open, Android install steps, Pages URL https://kaluanbernardo.github.io/buffet/
- .gitignore for node_modules, dist, .env.local
- .env.example with VITE_APP_PASSWORD_HASH=
- Commit on main (initial commit). Do NOT push secrets. Do NOT force-push.

## Success
- `cd web && npm install && VITE_APP_PASSWORD_HASH=deadbeef npm run build` succeeds
- dist exists with index.html, assets, icons
- git status clean after commit on main
