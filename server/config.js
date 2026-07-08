// ============================================================
// Central environment configuration for the OnDemand serverless
// backend layer. Every knob is env-driven so the same image runs
// locally, in CI, and on https://serverless.on-demand.io/apps/*.
// No secret ever reaches the client bundle.
// ============================================================

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const CONFIG = {
  // ---- runtime ----
  port: num(process.env.PORT, 5173),
  nodeEnv: process.env.NODE_ENV || 'production',

  // ---- OnDemand LLM (chat/v1) ----
  ondemand: {
    baseUrl: process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io/chat/v1',
    apiKey: process.env.ONDEMAND_API_KEY || '',
    // v21: all model stages default to Claude Sonnet 5
    draftEndpointId: process.env.ONDEMAND_DRAFT_ENDPOINT_ID || 'predefined-claude-sonnet-5',
    sendEndpointId: process.env.ONDEMAND_SEND_ENDPOINT_ID || 'predefined-claude-sonnet-5',
    analysisEndpointId: process.env.ONDEMAND_ANALYSIS_ENDPOINT_ID || 'predefined-claude-sonnet-5',
    agentIds: (process.env.ONDEMAND_AGENT_IDS || 'agent-1741770626').split(',').map((s) => s.trim()).filter(Boolean),
    embeddingsUrl: process.env.ONDEMAND_EMBEDDINGS_URL || '', // optional remote embedding endpoint
  },

  // ---- Zoho Mail API (the user's mail credential is Zoho, NOT Gmail) ----
  zoho: {
    // ZOHO_API_KEY: direct static OAuth token (placeholder until the real
    // credential is issued). When set, it is used as-is for every request
    // and the refresh-token flow below is skipped.
    apiKey: process.env.ZOHO_API_KEY || '',
    clientId: process.env.ZOHO_CLIENT_ID || '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
    accountId: process.env.ZOHO_ACCOUNT_ID || '',
    accountsBase: process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.com',
    mailBase: process.env.ZOHO_MAIL_BASE || 'https://mail.zoho.com/api',
    folderIds: (process.env.ZOHO_FOLDER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    mailbox: process.env.MAILBOX_ADDRESS || 'mk@airev.ae',
  },

  // ---- mail provider selection: zoho | seed | gmail ----
  // 'seed' replays the embedded intelligence snapshot (src/data.js) so the
  // whole pipeline runs deterministically with zero credentials.
  mailProvider: process.env.MAIL_PROVIDER || '',

  // ---- cache ----
  cache: {
    // v25 (BE-09): Vercel/lambda filesystems are read-only except /tmp —
    // default the persistent KV file there when running serverless.
    dir: process.env.CACHE_DIR || (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp/.mcc-data' : '.data'),
    defaultTtlS: num(process.env.CACHE_DEFAULT_TTL_S, 6 * 3600),
    dashboardTtlS: num(process.env.CACHE_DASHBOARD_TTL_S, 20 * 60),
    summaryTtlS: num(process.env.CACHE_SUMMARY_TTL_S, 7 * 24 * 3600),
    profileTtlS: num(process.env.CACHE_PROFILE_TTL_S, 14 * 24 * 3600),
    embeddingTtlS: num(process.env.CACHE_EMBEDDING_TTL_S, 30 * 24 * 3600),
    maxEntries: num(process.env.CACHE_MAX_ENTRIES, 5000),
    flushIntervalMs: num(process.env.CACHE_FLUSH_INTERVAL_MS, 5000),
  },

  // ---- semantic cache ----
  semantic: {
    threshold: Math.min(0.99, Math.max(0.5, num(process.env.SEMANTIC_SIM_THRESHOLD, 0.9))), // 0.85–0.95 recommended
    dim: num(process.env.EMBEDDING_DIM, 256),
    maxVectors: num(process.env.SEMANTIC_MAX_VECTORS, 2000),
  },

  // ---- reliability ----
  retry: {
    attempts: num(process.env.RETRY_ATTEMPTS, 4),
    baseMs: num(process.env.RETRY_BASE_MS, 500),
    maxMs: num(process.env.RETRY_MAX_MS, 15000),
  },
  rateLimit: {
    llmPerMin: num(process.env.LLM_RATE_PER_MIN, 30),
    zohoPerMin: num(process.env.ZOHO_RATE_PER_MIN, 60),
  },

  // ---- cron (all times UTC inside the container) ----
  cron: {
    enabled: bool(process.env.CRON_ENABLED, true),
    inboxSync: process.env.CRON_INBOX_SYNC || '*/10 * * * *',       // every 10 minutes
    priorityRefresh: process.env.CRON_PRIORITY_REFRESH || '0 * * * *', // hourly
    dailyBriefing: process.env.CRON_DAILY_BRIEFING || '0 3 * * *',  // 07:00 GST == 03:00 UTC
    weeklyCleanup: process.env.CRON_WEEKLY_CLEANUP || '0 2 * * 0',  // Sunday 02:00 UTC
  },

  briefing: { timezone: 'Asia/Dubai', localHour: 7 },
};

export default CONFIG;
