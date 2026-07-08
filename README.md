# Meera's Command Centre — Managing the CEO's Inbox

React + Vite dashboard with an Express + OnDemand serverless backend that turns
MK's (mk@airev.ae, AIREV) **Zoho** inbox into an executive command centre:
priority pyramid, reply debt, sentiment risk, relationship memory, AI reply
workbench (Gemini drafting → Fable send via the OnDemand Zoho agent), and a
cache-first live ops layer.

> **v19** adds the OnDemand serverless backend layer: Zoho Mail client behind a
> Gmail-compatible abstraction, persistent hybrid (exact + semantic) caching,
> incremental idempotent sync, async background analysis jobs, cron schedules,
> and reliability primitives (exponential backoff, rate limiting, failed-job
> log, last-good fallback).

---

## Architecture

```
┌────────────────────────────── Browser (React + Vite SPA) ─────────────────────────────┐
│ Overview · Live Ops · Priority Pyramid · Action Buckets · Reply Workbench · Send Log  │
│ Sync status bar: ● last updated Xm ago · [Sync] [Refresh] · degraded/error states     │
└──────────────┬────────────────────────────────────────────────────────────────────────┘
               │ fast JSON (ms) — ALWAYS from cache, never live mail
┌──────────────▼────────────────────────────────────────────────────────────────────────┐
│ Express server (server.js) — OnDemand serverless app container                        │
│                                                                                       │
│  /api/dashboard/meera  /api/followups  /api/daily-briefing  /api/sender-profile ...   │
│         │ read-only                                                                   │
│  ┌──────▼───────────────────────────┐   ┌──────────────────────────────────────────┐  │
│  │ Persistent hybrid cache (.data/) │◄──│ Async job queue (jobs.js)                │  │
│  │ • KV: emailMeta, summaries,      │   │ syncInbox → analyzeThread → rebuild      │  │
│  │   pyramid, profiles, sentiment,  │   │ (retry w/ backoff, dedupe, failed log)   │  │
│  │   dashboard JSON, briefings,     │   └───────▲──────────────▲───────────────────┘  │
│  │   syncState, embeddings          │           │              │                      │
│  │ • Semantic: sha256 exact +       │   ┌───────┴──────┐  ┌────┴─────────────────┐    │
│  │   cosine ≥ 0.90 (configurable)   │   │ Cron (UTC)   │  │ OnDemand LLM (chat/  │    │
│  └──────────────────────────────────┘   │ */10 sync    │  │ v1) — summaries,     │    │
│                                         │ 0 * priority │  │ scores, sentiment,   │    │
│  ┌──────────────────────────────────┐   │ 0 3 briefing │  │ briefing, drafts     │    │
│  │ Mail abstraction (Gmail-shaped)  │   │ 0 2 Sun clean│  └──────────────────────┘    │
│  │ ZohoMailProvider │ SeedProvider  │   └──────────────┘                              │
│  └──────────────────────────────────┘                                                 │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Zoho ⇒ Gmail-compatible mail layer (`server/lib/mail.js`)

The mailbox credential is a **Zoho Mail API** credential (not Gmail). All sync
logic is written Gmail-style, so the Zoho client normalises every message into
the Gmail shape (`id`, `threadId`, `historyId`, `labelIds`, `snippet`,
`internalDate`, `payload.headers[]`) and exposes Gmail-style methods
(`listMessages`, `getThread`, `getMessage`, `getProfile`). Zoho has no
`historyId`, so the layer synthesises one from `receivedTime` and incremental
listing maps to Zoho search `receivedTime:after:<ms>`. Zoho-native ids
(`zoho.messageId`, `zoho.folderId`) ride along for the existing Fable send
pipeline, which is unchanged.

`MAIL_PROVIDER=seed` replays the embedded intelligence snapshot (`src/data.js`)
through the very same pipeline — deterministic, zero credentials, used as the
automatic fallback whenever Zoho env vars are absent so the dashboard never
renders empty.

### Serverless functions (`server/functions/pipeline.js`)

| # | Function | Trigger | Cache namespace |
|---|----------|---------|-----------------|
| 1 | `syncInbox` — incremental Zoho sync | cron `*/10`, `POST /api/inbox/sync`, boot | `emailMeta`, `syncState` |
| 2 | `summarizeThread` — LLM summary | job fan-out per changed thread | `threadSummary` |
| 3 | `classifyEmail` — investor/gov/legal/… | job fan-out | folded into dashboard |
| 4 | `scorePriority` — tier 1–5 + urgency/risk/value | job fan-out | `priorityPyramid` |
| 5 | `analyzeSentiment` — tone + relationship risk | job fan-out | `sentiment` |
| 6 | `profileSender` — relationship memory | job fan-out | `senderProfile` |
| 7 | `detectFollowups` — stalled / who-owes-next | sync + hourly cron | `followups` |
| 8 | `generateDailyBriefing` — 07:00 GST executive brief | cron `0 3 * * *` UTC | `briefing` |
| 9 | `refreshCache` — rebuild + weekly deep clean | cron + `POST /api/refresh` | all |
| 10 | `generateEmbeddingsForThread` — semantic index | job fan-out + weekly refresh | `embeddings`, `semvec` |

### Incremental, idempotent sync

* Only messages with `receivedTime > lastInternalDate` cross the wire.
* Every message gets a **sha256 checksum** (id + thread + headers + snippet);
  unchanged checksums are skipped (`counts.skipped` grows — visible in the UI).
* Thread analysis jobs dedupe on `threadId:checksum` — **no email is analyzed
  twice**; re-deliveries and manual re-syncs are no-ops.
* `lastSyncAt` / `lastHistoryId` / per-message checksums persist in the
  `syncState` cache namespace.

### Hybrid caching

* **KV layer** (`.data/kv-cache.json`, atomic writes, debounced flush): TTLs
  per namespace — dashboard JSON 20 m, facts 6 h, summaries 7 d, profiles 14 d,
  embeddings 30 d — plus LRU-ish eviction above `CACHE_MAX_ENTRIES`.
* **Semantic layer**: exact sha256 match first, then cosine similarity ≥
  `SEMANTIC_SIM_THRESHOLD` (default **0.90**, recommended 0.85–0.95) over
  256-dim vectors. Identical or near-identical LLM prompts are served from
  cache — an unchanged thread never re-bills the LLM.
* Embeddings come from `ONDEMAND_EMBEDDINGS_URL` when configured, else a
  deterministic local hashed projection (stable across restarts).

### Reliability

* Exponential backoff with full jitter (4 attempts, honours `Retry-After`).
* Token-bucket rate limiters: 30 LLM calls/min, 60 Zoho calls/min.
* Failed jobs land in the `failedJobs` namespace with attempt history —
  inspect via `GET /api/jobs`.
* `/api/dashboard/meera` serves stale-while-revalidate from cache and falls
  back to the never-expiring `meera:lastGood` snapshot when a rebuild fails
  (`degraded: true` + banner in the UI).
* The header shows **last updated**, an animated error dot on sync failure,
  and manual **Sync** / **Refresh** buttons.

---

## API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/inbox/sync` | Incremental sync (async job; `?wait=1` sync, `?force=1` full) |
| POST | `/api/thread/analyze` | Queue full analysis of one thread (`{threadId}`) |
| GET | `/api/dashboard/meera` | Dashboard-ready JSON — cache-first, SWR, lastGood fallback |
| GET | `/api/followups` | Stalled threads + who owes the next response |
| GET | `/api/sender-profile?email=` | Relationship memory (omit email for all) |
| GET | `/api/daily-briefing?date=` | Latest (or dated) executive briefing |
| POST | `/api/refresh` | Manual cache refresh (`?deep=1` adds cleanup + re-embed) |
| GET | `/api/search?q=` | Semantic search over thread embeddings |
| GET | `/api/jobs` · `/api/cron` · `/api/cache/stats` | Ops visibility |
| GET | `/api/health` · POST `/api/session` · `/api/query` · `/api/send` | Pre-v19 routes (unchanged) |

## Cron schedules (container runs UTC)

| Schedule | Job | Notes |
|----------|-----|-------|
| `*/10 * * * *` | inboxSync | incremental only — new/changed threads |
| `0 * * * *` | priorityRefresh | re-detect follow-ups + rebuild dashboard |
| `0 3 * * *` | dailyBriefing | **07:00 GST** (Asia/Dubai) == 03:00 UTC |
| `0 2 * * 0` | weeklyCleanup | expired-entry purge + embedding refresh |

Schedules are also exposed at `GET /api/cron` so an external scheduler can
mirror them (hit `/api/inbox/sync` etc.) if the platform prefers HTTP triggers.

---

## Deploying on OnDemand serverless

**Live deployment (v20):** `https://serverless.on-demand.io/apps/meera-command-centre`
— application `meera-command-centre` (Build Mode **Manual**, branch **main**,
`dockerScriptPath: Dockerfile`), endpoint `meera-command-centre`, container
port **5173**, min/max instances 1 (always-warm so in-process cron and the
async job queue stay alive).

Deployment procedure (repeatable via the OnDemand config APIs
`/config/v1/public/serverless/*` or the console):

1. **Repo config** — register this GitHub repo (`mk42-ai/command-centre-app`)
   as a serverless repository on OnDemand (public repo; add an access token if
   it ever goes private).
2. **Application** — create a serverless application pointing at the repo,
   `branchName: main`, `dockerScriptPath: Dockerfile`, Build Mode **Manual**
   (`appBuildMode: manual_build`); trigger a build after each push and wait
   for status `Succeeded`.
3. **Endpoint** — create an endpoint for the application with
   `targetPortNumber: 5173`, `minInstanceCount: 1`, `maxInstanceCount: 1`,
   and the environment variables below (incl. `BASE_PATH=/apps/<app-name>`
   so the server strips the platform path prefix). Persist `CACHE_DIR` on a
   volume if the platform offers one; otherwise the cache rebuilds from
   mail + LLM on cold start (by design).
4. **Frontend base URL** — the SPA auto-detects the `/apps/<app-name>` prefix
   at runtime (v20), so no build-time flag is needed when server.js serves
   both. Only when hosting the SPA on a *different* origin set
   `VITE_API_BASE=https://serverless.on-demand.io/apps/meera-command-centre`
   at build time.
5. **Verify** — `GET /api/health`, `GET /api/cron` (4 schedules with stable
   `cron-*` IDs), `GET /api/cache/stats`, then `POST /api/inbox/sync?wait=1`
   once to prime the cache; `GET /api/dashboard/meera` must answer from cache
   with a `lastUpdated` timestamp.

### Required environment variables

| Variable | Purpose |
|----------|---------|
| `ONDEMAND_API_KEY` | OnDemand chat/v1 key — LLM analysis, copilot, Fable send |
| `ONDEMAND_AGENT_IDS` | Agent list incl. the Zoho Mail send agent |
| `ONDEMAND_DRAFT_ENDPOINT_ID` / `ONDEMAND_SEND_ENDPOINT_ID` / `ONDEMAND_ANALYSIS_ENDPOINT_ID` | Model endpoints (defaults provided) |
| `ZOHO_API_KEY` | **Placeholder / direct-token mode** — static Zoho OAuth token used as-is (skips refresh flow); replace the placeholder with the real credential when issued |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` / `ZOHO_ACCOUNT_ID` | Zoho Mail API OAuth (Self Client, scopes `ZohoMail.messages.READ, ZohoMail.folders.READ, ZohoMail.accounts.READ`) — alternative to `ZOHO_API_KEY` |
| `MAILBOX_ADDRESS` | Monitored mailbox (default `mk@airev.ae`) |
| `MAIL_PROVIDER` | `zoho` · `seed` (auto-falls back to seed when Zoho unset) |
| `BASE_PATH` | OnDemand path prefix (`/apps/<app-name>`) — stripped by the server when the platform proxy forwards it |
| `GITHUB_TOKEN` | (optional, ops) token for repo automation from the container — never bundled client-side |
| `SEMANTIC_SIM_THRESHOLD` | Semantic-cache cosine threshold (0.85–0.95) |
| `CACHE_*`, `RETRY_*`, `*_RATE_PER_MIN`, `CRON_*` | Tuning knobs — see `.env.example` |
| `VITE_API_BASE` | (build-time) remote backend base URL for the SPA — only needed for cross-origin hosting; same-origin prefix is auto-detected |

Full commented list: [`.env.example`](./.env.example).

---

## Local development

```bash
npm install
cp .env.example .env          # fill in keys (or leave empty → seed provider)
npm run dev                   # Vite on :5173, /api proxied to :8787
PORT=8787 node server.js      # backend with cron + jobs
# production-style single process:
npm run build && PORT=5173 node server.js
```

Zero-credential demo: leave `.env` empty — the seed provider replays the
embedded snapshot through the full sync → analyze → cache → dashboard
pipeline, and the LLM steps fall back to deterministic heuristics.
