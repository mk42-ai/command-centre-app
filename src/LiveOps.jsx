import React from 'react';
import Icon from './Icon.jsx';
import { useBriefing, useFollowups, fmtAgo } from './backend.js';

/*
 * Live Ops (v19) — the cache-first view of the OnDemand serverless
 * backend. Everything rendered here comes from /api/dashboard/meera,
 * /api/daily-briefing and /api/followups, which read the persistent
 * server-side cache (never live mail fetches). The embedded
 * intelligence views (Overview, Pyramid, …) remain untouched; this
 * section shows the same model as continuously refreshed by the
 * sync + analysis pipeline.
 */

export function SyncStatusBar({ dash }) {
  const { lastUpdated, source, degraded, error, loading, sync, refresh } = dash;
  return (
    <div className="syncbar" role="status">
      <span className={`sync-dot ${error ? 'err' : degraded ? 'warn' : 'ok'}`} aria-hidden="true" />
      <span className="sync-txt">
        {error
          ? <>sync issue — showing last cached state <b title={error}>({String(error).slice(0, 60)})</b></>
          : <>last updated <b title={lastUpdated || ''}>{fmtAgo(lastUpdated)}</b>{source ? ` · ${source}` : ''}{degraded ? ' · degraded (lastGood fallback)' : ''}</>}
      </span>
      <button className="sync-btn" onClick={sync} disabled={loading} title="Incremental inbox sync (only new/changed threads)">
        <Icon name="refresh" size={13} /> Sync
      </button>
      <button className="sync-btn" onClick={refresh} disabled={loading} title="Rebuild dashboard model from cache">
        Refresh
      </button>
    </div>
  );
}

function KpiRow({ d }) {
  const tc = d?.tierCounts || {};
  return (
    <div className="kpis">
      <div className="kpi kpi-crit"><div className="v">{tc['1'] || 0}</div><div className="l">Tier 1 · act today</div></div>
      <div className="kpi kpi-warn"><div className="v">{(d?.whoOwesNext?.us || []).length}</div><div className="l">Replies we owe</div></div>
      <div className="kpi kpi-warn"><div className="v">{(d?.sentimentRisk || []).length}</div><div className="l">Sentiment risk</div></div>
      <div className="kpi"><div className="v">{d?.threads?.length || 0}</div><div className="l">Threads cached</div></div>
      <div className="kpi"><div className="v">{(d?.stalledThreads || []).length}</div><div className="l">Stalled threads</div></div>
      <div className="kpi"><div className="v">{(d?.suggestedReplies || []).length}</div><div className="l">Suggested replies</div></div>
    </div>
  );
}

function Pyramid({ d }) {
  const widths = { 1: 34, 2: 50, 3: 66, 4: 82, 5: 98 };
  const rows = d?.priorityPyramid || [];
  return (
    <div className="card">
      <h2>Priority Pyramid — live cache</h2>
      <div className="hint">Recomputed hourly by the priorityRefresh cron and on every incremental sync.</div>
      <div className="pyramid">
        {rows.map(({ tier, count }) => (
          <div key={tier} className="pyr-row" style={{ width: `${widths[tier]}%`, background: ['#0B3D2E', '#135C43', '#1B7355', '#A9D2C1', '#DFEEE7'][tier - 1], color: tier <= 3 ? '#fff' : '#0B3D2E' }}>
            Tier {tier} · {count}
          </div>
        ))}
      </div>
    </div>
  );
}

function TopUrgent({ d }) {
  const list = d?.topUrgent || [];
  return (
    <div className="card">
      <h2>Top Urgent — from cache</h2>
      {!list.length && <div className="hint">No tier 1–2 threads in cache yet — run a sync.</div>}
      {list.map((t) => (
        <div key={t.threadId} className="tier-item" style={{ borderLeftColor: t.tier === 1 ? '#8E1508' : '#B54708' }}>
          <div className="t">{t.subject}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text2)' }}>
            {t.sender} · {t.org || '—'} · tier {t.tier} · urgency {t.urgency}/10 {t.deadline ? `· due ${t.deadline}` : ''}
          </div>
          {t.action && <div style={{ fontSize: '0.78rem', marginTop: 2 }}>{t.action}</div>}
        </div>
      ))}
    </div>
  );
}

function OwesNext({ fu }) {
  return (
    <div className="card">
      <h2>Who Owes the Next Response</h2>
      <div className="hint">Follow-up detection over thread timestamps — refreshed by sync + hourly cron.</div>
      {['us', 'them'].map((side) => {
        const items = (fu.followups || []).filter((f) => f.owesNext === side);
        return (
          <div key={side} style={{ marginTop: 8 }}>
            <b style={{ fontSize: '0.8rem', color: side === 'us' ? '#8E1508' : '#0B3D2E' }}>
              {side === 'us' ? 'We owe them' : 'They owe us'} ({items.length})
            </b>
            {items.map((f) => (
              <div key={f.threadId} className="tier-item" style={{ borderLeftColor: side === 'us' ? '#8E1508' : '#1B7355' }}>
                <div className="t">{f.subject}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text2)' }}>
                  {(f.counterparty?.name || f.counterparty?.email || '—')} · quiet {f.daysQuiet}d · tier {f.tier}
                </div>
                {f.suggestedNudge && <div style={{ fontSize: '0.78rem', marginTop: 2 }}>{f.suggestedNudge}</div>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Briefing() {
  const { loading, briefing, error } = useBriefing();
  return (
    <div className="card">
      <h2>Daily Executive Briefing</h2>
      <div className="hint">Generated every day at 07:00 GST (03:00 UTC) by the dailyBriefing cron; cached 3 days.</div>
      {loading && <div className="hint">Loading briefing…</div>}
      {error && <div className="hint" style={{ color: '#8E1508' }}>Briefing unavailable: {error}</div>}
      {briefing && (
        <>
          <div style={{ fontSize: '0.85rem', lineHeight: 1.55, marginTop: 6 }}>{briefing.narrative}</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text2)', marginTop: 8 }}>
            {briefing.date} · {briefing.localTime} · source: {briefing.source} · trigger: {briefing.trigger}
          </div>
        </>
      )}
    </div>
  );
}

function Relationships({ d }) {
  const mem = d?.relationshipMemory || [];
  return (
    <div className="card">
      <h2>Relationship Memory — frequent contacts</h2>
      <div className="hint">Sender profiles built by the profiling function, cached 14 days.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 8, marginTop: 8 }}>
        {mem.map((p) => (
          <div key={p.email} className="tier-item" style={{ borderLeftColor: p.riskFlag ? '#8E1508' : '#1B7355' }}>
            <div className="t">{p.name || p.email}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text2)' }}>
              {p.org || '—'}{p.role ? ` · ${p.role}` : ''} · {p.messageCount} msg · {p.relationship}
            </div>
            {p.recentSubjects?.length > 0 && (
              <div style={{ fontSize: '0.72rem', marginTop: 2 }}>{p.recentSubjects[p.recentSubjects.length - 1]}</div>
            )}
          </div>
        ))}
        {!mem.length && <div className="hint">No profiles cached yet — run a sync.</div>}
      </div>
    </div>
  );
}

function CategoryFilters({ d }) {
  const [sel, setSel] = React.useState(null);
  const cats = d?.categories || [];
  const threads = d?.threads || [];
  const shown = sel ? threads.filter((t) => t.category === sel) : [];
  return (
    <div className="card">
      <h2>Category Filters</h2>
      <div className="hint">Investor / customer / legal / internal segmentation from the classification function.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
        {cats.map((c) => (
          <button key={c.category} className={`sync-btn ${sel === c.category ? 'active' : ''}`} onClick={() => setSel(sel === c.category ? null : c.category)}>
            {c.category} · {c.count}
          </button>
        ))}
      </div>
      {sel && shown.map((t) => (
        <div key={t.threadId} className="tier-item" style={{ borderLeftColor: '#135C43' }}>
          <div className="t">{t.subject}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text2)' }}>{t.sender} · tier {t.tier} · {t.sentiment || '—'}</div>
        </div>
      ))}
    </div>
  );
}

export default function LiveOps({ dash }) {
  const fu = useFollowups();
  const d = dash.dashboard;

  if (dash.loading && !d) return <div className="card"><h2>Live Ops</h2><div className="hint">Loading cached dashboard…</div></div>;
  if (!d) {
    return (
      <div className="card">
        <h2>Live Ops — backend unreachable</h2>
        <div className="hint" style={{ color: '#8E1508' }}>
          {dash.error || 'The backend API did not answer.'} The static intelligence views (Overview, Pyramid, Workbench) remain fully functional.
        </div>
      </div>
    );
  }

  return (
    <>
      {dash.degraded && (
        <div className="card" style={{ borderLeft: '4px solid #B54708' }}>
          <b>Degraded mode</b> — last sync failed; showing the last good cached dashboard from {d.generatedAt}.
        </div>
      )}
      <KpiRow d={d} />
      <div className="grid grid-2">
        <Pyramid d={d} />
        <TopUrgent d={d} />
      </div>
      <div className="grid grid-2">
        <OwesNext fu={fu} />
        <Briefing />
      </div>
      <div className="grid">
        <CategoryFilters d={d} />
        <Relationships d={d} />
      </div>
      <div className="card">
        <h2>Pipeline State</h2>
        <div style={{ fontSize: '0.78rem', color: 'var(--text2)' }}>
          provider: <b>{d.provider}</b> · mailbox: {d.mailbox} · last sync: {d.syncState?.lastSyncAt ? fmtAgo(d.syncState.lastSyncAt) : 'never'} ·
          seen {d.syncState?.counts?.totalSeen ?? 0} · analyzed {d.syncState?.counts?.analyzed ?? 0} · skipped (idempotent) {d.syncState?.counts?.skipped ?? 0}
          {d.syncState?.lastError && <span style={{ color: '#8E1508' }}> · last error: {d.syncState.lastError.message}</span>}
        </div>
      </div>
    </>
  );
}
