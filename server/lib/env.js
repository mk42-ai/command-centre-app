// ============================================================
// v25 — zero-dependency .env loader.
// Loads KEY=VALUE pairs from a .env file into process.env at
// import time (idempotent: existing env vars always win). This
// closed the "keyConfigured:false" gap: the sandbox/production
// container now picks up ONDEMAND_API_KEY from a gitignored
// .env file without requiring the dotenv package.
// SECURITY: values are never logged; the file itself is listed
// in .gitignore and must be chmod 600 in deployments.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// walk up from server/lib/ to the project root
const candidates = [
  path.resolve(here, '../../.env'),
  path.resolve(process.cwd(), '.env'),
];

for (const file of candidates) {
  try {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] == null) process.env[key] = val;
    }
    break; // first hit wins
  } catch { /* unreadable .env → env vars only */ }
}

// ============================================================
// v30 (ROOT-CAUSE FIX for the intermittent OnDemand connection) —
// platform env-var NAME reconciliation + base-URL normalization.
//
// THE BUG: the On Demand platform injects credentials as ON_DEMAND_*
// (with an underscore between ON and DEMAND: ON_DEMAND_API_KEY,
// ON_DEMAND_BASE_URL). This codebase reads ONDEMAND_* (no underscore)
// in 30+ places. So the process ran with ONDEMAND_API_KEY UNSET →
// odConfigured() === false → /api/session, /api/query and /api/send
// returned 503, and the copilot only worked on the rare redeploys that
// happened to carry an ephemeral ONDEMAND_* var. That is exactly the
// "connection keeps going on and off across redeploys" symptom.
//
// THE SECOND BUG: ON_DEMAND_BASE_URL is a BARE host
// (https://gateway.on-demand.io). The chat client appends '/sessions',
// so the effective URL became https://gateway.on-demand.io/sessions →
// HTTP 404 (verified live). The chat/v1 client needs the base to end at
// the chat/v1 root.
//
// FIX: alias every ON_DEMAND_* / OD_* variant onto the canonical
// ONDEMAND_* name the app expects (never overwriting an explicitly-set
// canonical value), then normalize the chat base URL to end in /chat/v1.
// This makes the app work UNCHANGED in every environment: the sandbox
// (.env above), CI, and the live on-demand serverless platform.
// ============================================================
const ALIASES = {
  ONDEMAND_API_KEY: ['ON_DEMAND_API_KEY', 'OD_API_KEY', 'ONDEMAND_APIKEY', 'ONDEMAND_KEY'],
  ONDEMAND_BASE_URL: ['ON_DEMAND_BASE_URL', 'OD_BASE_URL', 'ONDEMAND_CHAT_BASE_URL'],
  ONDEMAND_MEDIA_BASE_URL: ['ON_DEMAND_MEDIA_BASE_URL', 'OD_MEDIA_BASE_URL'],
  ONDEMAND_MEDIA_URL: ['ON_DEMAND_MEDIA_URL', 'OD_MEDIA_URL'],
  ONDEMAND_AGENT_IDS: ['ON_DEMAND_AGENT_IDS', 'OD_AGENT_IDS'],
  ONDEMAND_FILE_AGENT_IDS: ['ON_DEMAND_FILE_AGENT_IDS', 'OD_FILE_AGENT_IDS'],
  ONDEMAND_DRAFT_ENDPOINT_ID: ['ON_DEMAND_DRAFT_ENDPOINT_ID'],
  ONDEMAND_SEND_ENDPOINT_ID: ['ON_DEMAND_SEND_ENDPOINT_ID'],
  ONDEMAND_ANALYSIS_ENDPOINT_ID: ['ON_DEMAND_ANALYSIS_ENDPOINT_ID'],
};
export const envReconciliation = { aliased: [], baseUrlNormalized: false };
for (const [canonical, alts] of Object.entries(ALIASES)) {
  if (process.env[canonical] != null && process.env[canonical] !== '') continue;
  for (const alt of alts) {
    if (process.env[alt] != null && process.env[alt] !== '') {
      process.env[canonical] = process.env[alt];
      envReconciliation.aliased.push(`${alt}→${canonical}`);
      break;
    }
  }
}

/**
 * normalizeChatBase — the chat/v1 client appends '/sessions' and
 * '/sessions/{id}/query' to this base, so it MUST end at the chat/v1 root.
 * Accepts a bare host, a trailing '/chat', or an already-correct base and
 * always returns '<host>/chat/v1' (no trailing slash). Media URLs are NOT
 * touched here — only ONDEMAND_BASE_URL is normalized.
 */
export function normalizeChatBase(u) {
  if (!u) return u;
  let s = String(u).trim().replace(/\/+$/, '');
  if (/\/chat\/v\d+$/i.test(s)) return s;      // already a chat/vN root
  s = s.replace(/\/chat$/i, '');                // '<host>/chat' → '<host>'
  return `${s}/chat/v1`;
}
if (process.env.ONDEMAND_BASE_URL) {
  const before = process.env.ONDEMAND_BASE_URL;
  const after = normalizeChatBase(before);
  if (after !== before) { process.env.ONDEMAND_BASE_URL = after; envReconciliation.baseUrlNormalized = true; }
}

export const envLoaded = true;
