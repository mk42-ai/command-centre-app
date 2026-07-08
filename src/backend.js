// ============================================================
// v19 frontend client for the OnDemand serverless backend layer.
// The dashboard loads primarily from the persistent server cache
// (/api/dashboard/meera) — never from live mail fetches. This
// module adds:
//   • useDashboard()  — cache-first dashboard state + lastUpdated
//                       + degraded/error flags + manual refresh
//   • useBriefing()   — latest daily executive briefing
//   • useFollowups()  — stalled threads / who-owes-next
//   • triggerSync()   — manual incremental inbox sync
// All fetches are resilient: on failure the last in-browser copy
// is kept and an error flag is raised (UI shows sync-failure
// state instead of blanking).
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';

// Deployed-backend base URL resolution (v20):
//   1. VITE_API_BASE (build-time env) — explicit live deployment URL, e.g.
//      https://serverless.on-demand.io/apps/meera-command-centre
//   2. runtime path-prefix detection — when the SPA is served by the OnDemand
//      serverless proxy under /apps/<app-name>/, same-origin API calls must
//      keep that prefix.
//   3. '' — plain same-origin (local dev / root-mounted prod).
const BUILD_TIME_BASE = (import.meta.env?.VITE_API_BASE || '').replace(/\/$/, '');
function runtimePrefix() {
  if (typeof window === 'undefined') return '';
  const m = window.location.pathname.match(/^(\/apps\/[^/]+)/);
  return m ? m[1] : '';
}
export const API_BASE = BUILD_TIME_BASE || runtimePrefix();

async function getJson(url, opts = {}) {
  const r = await fetch(`${API_BASE}${url}`, { headers: { Accept: 'application/json' }, ...opts });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(j?.error || `HTTP ${r.status} from ${url}`);
  return j;
}

export async function triggerSync({ force = false, wait = true } = {}) {
  // v25 (C6): default to synchronous completion — the fire-and-forget 202 +
  // fixed 1.5s sleep raced the async job and reloaded pre-sync data.
  const qs = [force ? 'force=1' : '', wait ? 'wait=1' : ''].filter(Boolean).join('&');
  return getJson(`/api/inbox/sync${qs ? `?${qs}` : ''}`, { method: 'POST' });
}

export async function triggerRefresh() {
  return getJson('/api/refresh?wait=1', { method: 'POST' });
}

export function useDashboard({ pollMs = 60000 } = {}) {
  const [state, setState] = useState({ loading: true, dashboard: null, lastUpdated: null, source: null, degraded: false, error: null });
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const j = await getJson('/api/dashboard/meera');
      if (!alive.current) return;
      setState({ loading: false, dashboard: j.dashboard, lastUpdated: j.lastUpdated, source: j.source, degraded: Boolean(j.degraded), error: j.degraded ? (j.error || 'degraded') : null });
    } catch (e) {
      if (!alive.current) return;
      // keep last good in-browser copy; surface the sync-failure state
      setState((s) => ({ ...s, loading: false, error: String(e?.message || e) }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, pollMs]);

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try { await triggerRefresh(); } catch { /* refresh best-effort */ }
    await load();
  }, [load]);

  const sync = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    // v25 (C6): wait=1 → the reload below always sees post-sync data
    try { await triggerSync({ wait: true }); } catch { /* surface via load() */ }
    await load();
  }, [load]);

  return { ...state, reload: load, refresh, sync };
}

export function useBriefing() {
  const [state, setState] = useState({ loading: true, briefing: null, error: null });
  useEffect(() => {
    let on = true;
    getJson('/api/daily-briefing')
      .then((j) => on && setState({ loading: false, briefing: j.briefing, error: null }))
      .catch((e) => on && setState({ loading: false, briefing: null, error: String(e?.message || e) }));
    return () => { on = false; };
  }, []);
  return state;
}

export function useFollowups() {
  const [state, setState] = useState({ loading: true, followups: [], count: 0, error: null });
  useEffect(() => {
    let on = true;
    getJson('/api/followups')
      .then((j) => on && setState({ loading: false, followups: j.followups || [], count: j.count || 0, error: null }))
      .catch((e) => on && setState({ loading: false, followups: [], count: 0, error: String(e?.message || e) }));
    return () => { on = false; };
  }, []);
  return state;
}

export function fmtAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}
