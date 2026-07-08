// ============================================================
// v29 — environment validation on boot with clear error messages.
// Hard errors (malformed values, inconsistent provider config)
// abort the boot with an explicit explanation; soft gaps (missing
// optional key) log a WARN and flip the app into degraded mode
// instead of dying silently or failing deep in a request handler.
// ============================================================
import { logger } from './logger.js';

export function validateEnv() {
  const errors = [];
  const warnings = [];

  const port = process.env.PORT ?? '5173';
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    errors.push(`PORT="${port}" is not a valid TCP port (expected an integer 1-65535)`);
  }

  if (!process.env.ONDEMAND_API_KEY) {
    warnings.push('ONDEMAND_API_KEY is not set — AI copilot runs in OFFLINE FALLBACK mode: /api/suggest-replies serves deterministic drafts, /api/session and /api/query return 503 with a clear message. Set ONDEMAND_API_KEY to enable live LLM generation.');
  }

  for (const k of ['ONDEMAND_BASE_URL', 'ONDEMAND_MEDIA_BASE_URL', 'ONDEMAND_MEDIA_URL']) {
    const v = process.env[k];
    if (v && !/^https?:\/\//i.test(v)) errors.push(`${k}="${v}" must be an absolute http(s) URL`);
  }

  const mailProvider = process.env.MAIL_PROVIDER || 'seed';
  if (mailProvider === 'zoho' && !(process.env.ZOHO_ACCOUNT_ID && (process.env.ZOHO_API_KEY || process.env.ZOHO_REFRESH_TOKEN))) {
    errors.push('MAIL_PROVIDER=zoho requires ZOHO_ACCOUNT_ID plus ZOHO_API_KEY or ZOHO_REFRESH_TOKEN — set them or switch MAIL_PROVIDER back to "seed"');
  }

  for (const k of ['RETRY_ATTEMPTS', 'RETRY_BASE_MS', 'RETRY_MAX_MS', 'LLM_RATE_PER_MIN', 'ZOHO_RATE_PER_MIN',
    'OD_SESSION_TIMEOUT_MS', 'OD_SYNC_TIMEOUT_MS', 'OD_STREAM_CONNECT_TIMEOUT_MS', 'OD_MEDIA_TIMEOUT_MS']) {
    const v = process.env[k];
    if (v != null && v !== '' && !Number.isFinite(Number(v))) {
      errors.push(`${k}="${v}" must be numeric`);
    }
  }

  for (const w of warnings) logger.warn('env.validate.warning', { message: w });
  for (const e of errors) logger.error('env.validate.error', { message: e });
  logger.info('env.validate.summary', {
    ok: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
    keyConfigured: Boolean(process.env.ONDEMAND_API_KEY),
    mailProvider,
    port: String(port),
  });
  return { ok: errors.length === 0, errors, warnings };
}
