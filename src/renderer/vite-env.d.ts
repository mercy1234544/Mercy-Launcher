/// <reference types="vite/client" />

// Real, optional deployment configuration — see .env.example at the repo
// root. Never hardcoded; undefined until the owner supplies real values.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
