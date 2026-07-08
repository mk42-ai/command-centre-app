import React, { useMemo, useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts';
import {
  META, THREADS, TIER_INFO, TIER_COUNTS, QUIET_THREADS, REPLY_DEBT,
  SENTIMENT_RADAR, OPPORTUNITY_MAP, ACTION_BUCKETS, MACHINE_SUMMARY,
} from './data.js';
import { Toaster } from 'sonner';
import AIWorkbench from './AIWorkbench.jsx';
import Sidebar, { SECTIONS } from './Sidebar.jsx';
import Badge, { toneForScore } from './Badge.jsx';
import { DISMISS_OPTIONS, recordDismissal, undoDismissal, loadDismissals, subscribeDismissals } from './ai.js';
import { toast } from 'sonner';
import SendLog from './SendLog.jsx';
import AuditView from './AuditView.jsx';
import Icon from './Icon.jsx';
import ChatPanel from './ChatPanel.jsx';
import { loadResolved, saveResolved } from './ai.js';
// v19: cache-first backend wiring (OnDemand serverless layer)
import LiveOps, { SyncStatusBar } from './LiveOps.jsx';
import { useDashboard } from './backend.js';

/* ---------- helpers ---------- */
const heatColor = (v) => {
  if (v >= 8) return '#8E1508';
  if (v >= 6) return '#B54708';
  if (v >= 4) return '#7A5200';
  return '#0E6245';
};
const riskColor = (v) => {
  if (v >= 7) return '#8E1508';
  if (v >= 5) return '#B54708';
  if (v >= 3) return '#7A5200';
  return '#0E6245';
};

// v17: reactive dismissal state — every subscriber recomputes scores, ranks
// and badges the instant a thread is dismissed or an undo happens, in any
// view, with no page reload.
function useDismissals() {
  const [dismissals, setDismissals] = useState(() => loadDismissals());
  useEffect(() => subscribeDismissals(() => setDismissals({ ...loadDismissals() })), []);
  return dismissals;
}

function Heat({ v, label = 'Score', invert = false }) {
  return <Badge tone={toneForScore(v, { invert })} icon={invert ? 'gem' : 'flame'} title={`${label} ${v}/10`}>{v}</Badge>;
}

/* ================= A. Priority Pyramid ================= */
function PriorityPyramid() {
  const [sel, setSel] = useState(null);
  const widths = { 1: 34, 2: 50, 3: 66, 4: 82, 5: 98 };
  const filtered = sel ? THREADS.filter((t) => t.tier === sel) : [];

  return (
    <div className="card">
      <h2>A · Priority Pyramid</h2>
      <div className="hint">Click a tier to filter the detail list — reason, owner, action, deadline, impact. Click again to clear.</div>
      <div className="pyramid">
        {[1, 2, 3, 4, 5].map((tier) => (
          <button
            key={tier}
            className={`pyr-row ${sel && sel !== tier ? 'dim' : ''} ${sel === tier ? 'active' : ''}`}
            style={{ width: `${widths[tier]}%`, background: TIER_INFO[tier].color, color: TIER_INFO[tier].text }}
            onClick={() => setSel(sel === tier ? null : tier)}
            title={TIER_INFO[tier].desc}
          >
            {TIER_INFO[tier].label} · {TIER_COUNTS[tier]}
          </button>
        ))}
      </div>
      {sel && (
        <div className="tier-detail">
          <div style={{ fontSize: '0.8rem', color: 'var(--text2)' }}>
            <b style={{ color: TIER_INFO[sel].ink }}>{TIER_INFO[sel].label}</b> — {TIER_INFO[sel].desc} ({filtered.length} thread{filtered.length !== 1 ? 's' : ''})
          </div>
          {filtered.map((t) => (
            <div key={t.id} className="tier-item" style={{ borderLeftColor: TIER_INFO[t.tier].color }}>
              <div className="t">{t.subject}</div>
              <div className="m">
                <b>Why this tier:</b> {t.tierReason}<br />
                <b>Owner:</b> {t.owner} · <b>Deadline / urgency:</b> {t.deadline} (urgency {t.urgency}/10)<br />
                <b>Recommended action:</b> {t.action}<br />
                <b>Impact if ignored:</b> {t.impact}
              </div>
            </div>
          ))}
        </div>
      )}
      {!sel && (
        <div style={{ textAlign: 'center', color: 'var(--text2)', fontSize: '0.8rem', marginTop: 10 }}>
          16 threads triaged · 2 require action <b style={{ color: '#B42318' }}>today</b>
        </div>
      )}
    </div>
  );
}

/* ================= B. Urgency Heatmap ================= */
function UrgencyHeatmap() {
  const [minUrg, setMinUrg] = useState(0);
  const [view, setView] = useState('table');

  const dismissals = useDismissals();
  const rows = useMemo(
    () => THREADS.filter((t) => !dismissals[t.id] && t.urgency >= minUrg).sort((a, b) => b.urgency - a.urgency),
    [minUrg, dismissals]
  );
  const chartData = rows.slice(0, 10).map((t) => ({
    name: t.org.length > 14 ? t.org.slice(0, 13) + '…' : t.org,
    Urgency: t.urgency, 'Biz value': t.bizValue, 'Rel. risk': t.risk,
  }));

  return (
    <div className="card">
      <h2>B · Urgency Heatmap</h2>
      <div className="hint">Threads ranked by urgency, business value and relationship risk — color-coded /10.</div>
      <div className="controls">
        {[0, 5, 7, 8].map((v) => (
          <button key={v} className={`fbtn ${minUrg === v ? 'on' : ''}`} onClick={() => setMinUrg(v)}>
            {v === 0 ? 'All' : `Urgency ≥ ${v}`}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className={`fbtn ${view === 'table' ? 'on' : ''}`} onClick={() => setView('table')}>Table</button>
        <button className={`fbtn ${view === 'chart' ? 'on' : ''}`} onClick={() => setView('chart')}>Chart</button>
      </div>

      {view === 'table' ? (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Rank</th><th>Thread</th><th>Org</th><th>Tier</th><th>Urgency</th><th>Biz value</th><th>Rel. risk</th></tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={t.id}>
                  <td className="audit-rank">#{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{t.subject.length > 48 ? t.subject.slice(0, 47) + '…' : t.subject}</td>
                  <td style={{ color: 'var(--text2)' }}>{t.org}</td>
                  <td><span className="chip" style={{ background: TIER_INFO[t.tier].color, color: TIER_INFO[t.tier].text }}>T{t.tier}</span></td>
                  <td><Heat v={t.urgency} label="Urgency" /></td>
                  <td><Heat v={t.bizValue} label="Business value" invert /></td>
                  <td><Heat v={t.risk} label="Relationship risk" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ width: '100%', height: 380 }}>
          <ResponsiveContainer>
            <BarChart data={chartData} layout="vertical" margin={{ left: 12, right: 18, top: 6 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" />
              <XAxis type="number" domain={[0, 10]} tick={{ fill: 'var(--text2)', fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={106} tick={{ fill: 'var(--text2)', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)' }} itemStyle={{ color: 'var(--text)' }} labelStyle={{ color: 'var(--text)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={(value) => <span style={{ color: '#13241c' }}>{value}</span>} />
              <Bar dataKey="Urgency" fill="#0B3D2E" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Biz value" fill="#1B7355" radius={[0, 4, 4, 0]} />
              <Bar dataKey="Rel. risk" fill="#2E8B6E" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/* ================= C. Quiet Threads ================= */
function QuietThreads() {
  const [open, setOpen] = useState(null);
  const dismissals = useDismissals(); // v17: handled threads drop out of the quiet tracker instantly
  const visible = QUIET_THREADS.filter((q) => !(q.threadId != null && dismissals[q.threadId]));
  return (
    <div className="card">
      <h2>C · Quiet Threads Tracker</h2>
      <div className="hint">Stalled conversations — who spoke last, where it was left, and a ready follow-up message. Threads dismissed as handled are excluded automatically.</div>
      {visible.map((q) => (
        <div key={q.id} className="qcard">
          <div className="head">
            <div className="cp">{q.counterparty}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge tone={q.daysQuiet >= 14 ? 'high' : q.daysQuiet >= 5 ? 'medium' : 'low'} icon="clock" title={`${q.daysQuiet} days since last reply`}>{q.daysQuiet} days quiet</Badge>
              <Badge tone={/high/i.test(q.risk) ? 'high' : /med/i.test(q.risk) ? 'medium' : 'low'} icon="alert" title={`Relationship risk: ${q.risk}`}>{q.risk}</Badge>
            </div>
          </div>
          <div className="meta">
            <b>Topic:</b> {q.topic}<br />
            <b>Last message:</b> {q.lastMessage} · <b>Last responder:</b> {q.lastResponder}<br />
            <b>Where it was left:</b> {q.whereLeft}<br />
            <b>Owes reply:</b> <span className="badge" style={{ background: q.owesReply.startsWith('We') ? '#B4231815' : '#0B3D2E12', color: q.owesReply.startsWith('We') ? '#B42318' : '#135C43' }}>{q.owesReply}</span>
            {q.note && <><br /><b>Note:</b> {q.note}</>}
          </div>
          <button className="exp-btn" style={{ marginTop: 10 }} onClick={() => setOpen(open === q.id ? null : q.id)}>
            {open === q.id ? 'Hide' : 'Show'} suggested follow-up
          </button>
          {open === q.id && <div className="followup">“{q.followUp}”</div>}
        </div>
      ))}
    </div>
  );
}

/* ================= D. Reply Debt ================= */
function ReplyDebt() {
  const sorted = [...REPLY_DEBT].sort((a, b) => b.daysElapsed - a.daysElapsed);
  return (
    <div className="card">
      <h2>D · Reply Debt</h2>
      <div className="hint">What AIREV owes others — prioritized by days elapsed.</div>
      {sorted.map((d) => (
        <div key={d.id} className="qcard" style={{ borderLeft: `4px solid ${d.sevColor}` }}>
          <div className="head">
            <div className="cp">{d.item}</div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <div className="days-big" style={{ color: d.sevColor }}>{d.daysElapsed}</div>
                <div className="days-lbl">days elapsed</div>
              </div>
              <span className="chip" style={{ background: d.sevColor }}>{d.severity}</span>
            </div>
          </div>
          <div className="meta">
            <b>Owed to:</b> {d.counterparty} · <b>Due:</b> {d.dueDate}<br />
            {d.detail}<br />
            <b>Action:</b> {d.action}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ================= E. Sentiment Radar ================= */
function SentimentRadar() {
  const data = SENTIMENT_RADAR.map((s) => ({
    stakeholder: s.stakeholder, Sentiment: s.sentiment, Tone: s.tone, 'Relationship health': s.health,
  }));
  return (
    <div className="card">
      <h2>E · Sentiment Radar</h2>
      <div className="hint">Sentiment, tone and relationship health per stakeholder (0–10) — hidden concerns listed below.</div>
      <div style={{ width: '100%', height: 360 }}>
        <ResponsiveContainer>
          <RadarChart data={data} outerRadius="72%">
            <PolarGrid stroke="var(--grid)" />
            <PolarAngleAxis dataKey="stakeholder" tick={{ fill: 'var(--text2)', fontSize: 11 }} />
            <PolarRadiusAxis domain={[0, 10]} tick={{ fill: 'var(--text2)', fontSize: 10 }} />
            <Radar name="Sentiment" dataKey="Sentiment" stroke="#0B3D2E" fill="#0B3D2E" fillOpacity={0.30} />
            <Radar name="Tone" dataKey="Tone" stroke="#1B7355" fill="#1B7355" fillOpacity={0.18} />
            <Radar name="Relationship health" dataKey="Relationship health" stroke="#2E8B6E" fill="#2E8B6E" fillOpacity={0.12} />
            <Legend wrapperStyle={{ fontSize: 12 }} formatter={(value) => <span style={{ color: '#13241c' }}>{value}</span>} />
            <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)' }} itemStyle={{ color: 'var(--text)' }} labelStyle={{ color: 'var(--text)' }} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <div className="concern-list">
        {SENTIMENT_RADAR.filter((s) => !s.concern.startsWith('None')).map((s) => (
          <div key={s.stakeholder} className="concern">
            <span className="who"><Icon name="alert-triangle" size={13} /> {s.stakeholder}:</span>
            <span>{s.concern}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= F. Opportunity Map ================= */
function OpportunityMap() {
  return (
    <div className="card">
      <h2>F · Strategic Opportunity Map</h2>
      <div className="hint">Every relationship grouped by strategic lane, each with a recommended next step.</div>
      <div className="opp-grid">
        {OPPORTUNITY_MAP.map((o) => (
          <div key={o.category} className="opp" style={{ borderTopColor: o.color }}>
            <div className="cat" style={{ color: o.color }}>{o.category}</div>
            <div className="ent">{o.entities.map((e) => <span key={e}>{e}</span>)}</div>
            <div className="ns">{o.nextSteps}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= G. Recommended Actions ================= */
function RecommendedActions() {
  return (
    <div className="card">
      <h2>G · Recommended Actions</h2>
      <div className="hint">Every action bucketed by how it should be handled.</div>
      <div className="bucket-grid">
        {ACTION_BUCKETS.map((b) => (
          <div key={b.bucket} className="bucket">
            <div className="bh" style={{ background: b.color }}>
              <Icon name={b.icon} size={15} /> {b.bucket} <span className="bh-count">{b.items.length}</span>
            </div>
            <ul>{b.items.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= Detail Table ================= */
const COLS = [
  { k: 'sender', l: 'Sender' },
  { k: 'org', l: 'Organization' },
  { k: 'subject', l: 'Subject' },
  { k: 'lastActivity', l: 'Last activity' },
  { k: 'tier', l: 'Tier' },
  { k: 'sentiment', l: 'Sentiment' },
  { k: 'urgency', l: 'Urgency' },
  { k: 'risk', l: 'Rel. risk' },
  { k: 'owner', l: 'Owner' },
];

function DetailTable() {
  const [sortK, setSortK] = useState('tier');
  const [dir, setDir] = useState(1);
  const [q, setQ] = useState('');
  const [dismissFor, setDismissFor] = useState(null);
  const dismissals = useDismissals(); // reactive: any dismiss/undo re-renders this table
  const refresh = () => {}; // kept for call-site compatibility; subscription handles updates
  const [tierF, setTierF] = useState(0);
  const [open, setOpen] = useState(null);

  const rows = useMemo(() => {
    let r = [...THREADS];
    if (tierF) r = r.filter((t) => t.tier === tierF);
    if (q) {
      const s = q.toLowerCase();
      r = r.filter((t) =>
        [t.sender, t.org, t.subject, t.summary, t.owner, t.action].join(' ').toLowerCase().includes(s)
      );
    }
    r.sort((a, b) => {
      const va = a[sortK], vb = b[sortK];
      if (typeof va === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return r;
  }, [sortK, dir, q, tierF]);

  const clickSort = (k) => {
    if (sortK === k) setDir(-dir);
    else { setSortK(k); setDir(1); }
  };

  return (
    <div className="card">
      <h2>Detailed Action Table</h2>
      <div className="hint">All 16 threads — sortable, searchable, with expandable draft replies where prepared.</div>
      <div className="controls">
        <input className="search" placeholder="Search sender, org, subject, action…" value={q} onChange={(e) => setQ(e.target.value)} />
        {[0, 1, 2, 3, 4, 5].map((t) => (
          <button key={t} className={`fbtn ${tierF === t ? 'on' : ''}`} onClick={() => setTierF(t)}>
            {t === 0 ? 'All tiers' : `Tier ${t}`}
          </button>
        ))}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.k} onClick={() => clickSort(c.k)}>
                  {c.l}{sortK === c.k && <span className="sort-ind"><Icon name={dir === 1 ? 'chevron-up' : 'chevron-down'} size={11} strokeWidth={2.25} /></span>}
                </th>
              ))}
              <th>Summary · Next action</th>
              <th>Draft</th>
              <th>Handled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <React.Fragment key={t.id}>
                <tr className={dismissals[t.id] ? 'row-dismissed' : ''}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{t.sender}<div style={{ color: 'var(--text2)', fontWeight: 400, fontSize: '0.72rem' }}>{t.email}</div></td>
                  <td>{t.org}</td>
                  <td style={{ minWidth: 180 }}>{t.subject}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{t.lastActivity}</td>
                  <td><Badge tone={t.tier <= 2 ? 'brand' : 'outline'} icon={t.tier === 1 ? 'shield' : 'layers'} title={`Priority tier ${t.tier}`}>T{t.tier}</Badge></td>
                  <td style={{ fontSize: '0.75rem', color: 'var(--text2)', minWidth: 110 }}>{t.sentiment}</td>
                  <td><Heat v={t.urgency} label="Urgency" /></td>
                  <td><Heat v={t.risk} label="Relationship risk" /></td>
                  <td style={{ fontSize: '0.76rem', minWidth: 120 }}>{t.owner}</td>
                  <td style={{ fontSize: '0.76rem', color: 'var(--text2)', minWidth: 220 }}>
                    {t.summary}
                    <div className="next-action"><Icon name="chevron-right" size={12} strokeWidth={2.25} /> <b>{t.action}</b></div>
                  </td>
                  <td>
                    {t.draft ? (
                      <button className="exp-btn" onClick={() => setOpen(open === t.id ? null : t.id)}>
                        {open === t.id ? 'Hide' : 'View'}
                      </button>
                    ) : (
                      <span style={{ color: 'var(--text2)', fontSize: '0.72rem' }}>—</span>
                    )}
                  </td>
                  <td style={{ minWidth: 170 }}>
                    {dismissals[t.id] ? (
                      <span className="handled-cell">
                        <Badge tone="low" icon={(DISMISS_OPTIONS.find((o) => o.id === dismissals[t.id].option) || {}).icon || 'check-circle'} title={`Handled by ${dismissals[t.id].by} \u00b7 ${dismissals[t.id].ts}`}>
                          Handled via {dismissals[t.id].optionLabel}
                        </Badge>
                        <button className="wb-undo" title="Undo — restore this thread" onClick={() => { const ev = undoDismissal(t); refresh(); toast.success(`Restored "${t.subject.slice(0, 36)}"`, { description: ev ? `undo logged ${ev.ts}` : '' }); }}>Undo</button>
                      </span>
                    ) : dismissFor === t.id ? (
                      <span className="wb-dismiss-sel">
                        {DISMISS_OPTIONS.map((o) => (
                          <button key={o.id} className="wb-dismiss-opt" title={o.label} onClick={() => { recordDismissal(t, o.id); setDismissFor(null); refresh(); toast.success(`Handled via ${o.label}`); }}>
                            <Badge tone="low" icon={o.icon}>{o.label}</Badge>
                          </button>
                        ))}
                        <button className="wb-init-cancel" onClick={() => setDismissFor(null)} title="Cancel"><Icon name="undo" size={12} /></button>
                      </span>
                    ) : (
                      <button className="wb-dismiss sm" title="Dismiss as handled" onClick={() => setDismissFor(t.id)}>
                        <Icon name="check" size={12} strokeWidth={2} /> Dismiss
                      </button>
                    )}
                  </td>
                </tr>
                {open === t.id && t.draft && (
                  <tr className="draft-row">
                    <td colSpan={12}>
                      <div className="draft-head">Suggested draft reply · {t.sender}</div>
                      <div className="draft-box">{t.draft}</div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ================= JSON summary ================= */
function JsonSummary() {
  const [show, setShow] = useState(false);
  return (
    <div className="card">
      <h2>Machine-Readable Summary</h2>
      <div className="hint">tier_counts · reply_debt_count · quiet_thread_count · top_5_urgent_actions (with deadlines).</div>
      <button className="exp-btn" onClick={() => setShow(!show)}>{show ? 'Hide JSON' : 'Show JSON'}</button>
      {show && (
        <pre style={{
          marginTop: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
          padding: 16, fontSize: '0.75rem', overflowX: 'auto', color: 'var(--text2)', lineHeight: 1.6,
        }}>
          {JSON.stringify(MACHINE_SUMMARY, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ================= App ================= */
export default function App() {
  const [resolved, setResolved] = React.useState(loadResolved);
  const resolve = (id, initials) => {
    setResolved((r) => {
      const next = { ...r, [id]: { by: initials, at: new Date().toISOString() } };
      saveResolved(next);
      return next;
    });
  };
  const unresolve = (id) => {
    setResolved((r) => {
      const next = { ...r };
      delete next[id];
      saveResolved(next);
      return next;
    });
  };

  const [section, setSection] = React.useState(() => {
    try { return localStorage.getItem('mcc.section') || 'overview'; } catch { return 'overview'; }
  });
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return localStorage.getItem('mcc.sidebar') === '1'; } catch { return false; }
  });
  const navigate = (id) => {
    setSection(id);
    try { localStorage.setItem('mcc.section', id); } catch {}
    document.querySelector('.main')?.scrollTo?.({ top: 0 });
  };
  const toggleSidebar = () => {
    setCollapsed((v) => {
      try { localStorage.setItem('mcc.sidebar', v ? '0' : '1'); } catch {}
      return !v;
    });
  };
  const sectionLabel = SECTIONS.find((s) => s.id === section)?.label || '';

  // v19: cache-first dashboard state from the serverless backend.
  // Polls /api/dashboard/meera (60s); shows last-updated + sync-failure state.
  const dash = useDashboard({ pollMs: 60000 });

  return (
    <div className={`app shell ${collapsed ? 'rail' : ''}`}>
      <Sidebar active={section} onNavigate={navigate} collapsed={collapsed} onToggle={toggleSidebar} />

      <div className="main">
        <header className="header">
          <div>
            <h1>
              {META.title} <span className="tagline">— {META.tagline}</span>
            </h1>
            <div className="sub">Prepared for {META.preparedFor} · {META.date} · {META.mailbox} ({META.org}) · <b>{sectionLabel}</b></div>
          </div>
          <SyncStatusBar dash={dash} />
        </header>

        {section === 'overview' && (
          <>
            <div className="kpis">
              <div className="kpi kpi-crit"><div className="v">2</div><div className="l">Tier 1 · act today</div></div>
              <div className="kpi kpi-crit"><div className="v">4</div><div className="l">Reply debts owed</div></div>
              <div className="kpi kpi-warn"><div className="v">3</div><div className="l">At-risk relationships</div></div>
              <div className="kpi"><div className="v">16</div><div className="l">Threads triaged</div></div>
              <div className="kpi"><div className="v">4</div><div className="l">Quiet threads</div></div>
              <div className="kpi"><div className="v">5</div><div className="l">Drafts prepared</div></div>
            </div>
            <div className="grid grid-2">
              <UrgencyHeatmap />
              <SentimentRadar />
            </div>
            <div className="grid grid-2">
              <QuietThreads />
              <ReplyDebt />
            </div>
            <div className="grid">
              <OpportunityMap />
              <DetailTable />
              <JsonSummary />
            </div>
          </>
        )}

        {section === 'liveops' && (
          <div className="grid">
            <LiveOps dash={dash} />
          </div>
        )}

        {section === 'pyramid' && (
          <div className="grid">
            <PriorityPyramid />
          </div>
        )}

        {section === 'buckets' && (
          <div className="grid">
            <RecommendedActions />
          </div>
        )}

        {section === 'workbench' && (
          <div className="grid">
            <AIWorkbench resolved={resolved} onResolve={resolve} onUnresolve={unresolve} />
          </div>
        )}

        {section === 'sendlog' && (
          <div className="grid">
            <SendLog />
          </div>
        )}

        {section === 'audit' && (
          <div className="grid">
            <AuditView />
          </div>
        )}

        {section === 'chat' && (
          <div className="grid">
            <div className="card chat-host">
              <h2>Inbox Copilot</h2>
              <div className="hint">Free-form prompts about MK's inbox, streamed via the OnDemand proxy (Claude Sonnet 5).</div>
              <ChatPanel inline />
            </div>
          </div>
        )}

        <footer className="footer">
          Meera's Command Centre — Managing the CEO's Inbox · OnDemand (AIREV) · Generated {META.date} · Data source: mk@airev.ae Zoho inbox intelligence
        </footer>
      </div>

      {/* floating copilot stays available outside the Chat section */}
      {section !== 'chat' && <ChatPanel />}

      {/* sonner toasts — brand-styled, announced to screen readers */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          role: 'alert',
          ariaLive: 'assertive',
          style: { background: '#ffffff', border: '1px solid #d8e4dd', color: '#13241c', fontFamily: 'Inter, sans-serif' },
        }}
      />
    </div>
  );
}
