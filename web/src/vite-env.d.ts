/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_APP_PASSWORD_HASH?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}
