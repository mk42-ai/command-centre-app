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

export const envLoaded = true;
