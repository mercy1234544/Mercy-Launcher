// Minimal, dependency-free .env loader for the MAIN process only.
//
// Why this exists: Vite already injects VITE_-prefixed variables into
// import.meta.env for the RENDERER bundle (see src/renderer/vite-env.d.ts),
// but main.ts is compiled by plain tsc and run by plain Node/Electron — Vite
// never touches it, so a renderer-style `VITE_*` variable has no way to
// reach main-process code. Before this file existed, nothing loaded a
// `.env` file into `process.env` for the main process at all: setting
// MERCY_RELAY_WS_URL in `.env` had zero effect on the app (confirmed by the
// Linux backend audit — see docs/linux-backend-client-contract.md §19/§20.4).
//
// This loader is intentionally tiny (no `dotenv` dependency) — it only
// parses simple `KEY=VALUE` lines, skips blanks/comments, and never
// overwrites a variable the real OS environment already set (so a real
// deployment's own env vars always win over a checked-in-adjacent .env
// file). It is safe to call even when no .env file exists.
import fs from 'fs';
import path from 'path';

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Loads `<appRoot>/.env` (repo root in dev; the packaged app's own
 *  directory in production) into `process.env`, without overwriting any
 *  variable already set in the real environment. Never throws — a missing
 *  or unreadable .env file is a normal, safe state (matches every other
 *  "not configured yet" path in this codebase). */
export function loadMainProcessEnv(appRoot: string): void {
  const envPath = path.join(appRoot, '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
