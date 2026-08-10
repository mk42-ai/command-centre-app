// ============================================================
// v41 — LIVE dashboard model mappers (the ONLY data source for UI
// sections). Every helper takes the live /api/dashboard/meera
// payload (`d = dash.dashboard`) and maps it into the shape a view
// renders. There is NO fixture fallback anywhere: when live data
// has not landed, helpers return empty collections and the views
// show an explicit "awaiting live sync…" state.
// ============================================================

/** Map live dashboard.threads → the UI thread shape shared by views. */
export function liveThreadsOf(d) {
  const list = d?.threads || [];
  return list.map((t) => ({
    id: t.threadId,
    zoho: t.zoho || { messageId: String(t.threadId) },
    sender: t.sender || t.email || 'unknown',
    email: t.email || '',
    org: t.org || '',
    role: '',
    subject: t.subject || '(no subject)',
    lastActivity: t.lastActivity ? String(t.lastActivity).slice(0, 10) : '—',
    summary: t.summary || '',
    tier: t.tier ?? 3,
    tierReason: t.tierReason || 'Tier assigned by the live triage pipeline.',
    sentiment: t.sentiment || 'Neutral',
    urgency: t.urgency ?? 5,
    risk: t.risk ?? 4,
    bizValue: t.bizValue ?? 5,
    relationship: t.relationship || 'Unknown',
    owner: t.owner || 'Meera',
    action: t.action || null,
    deadline: t.deadline || '—',
    bucket: t.bucket || null,
    category: t.category || null,
    draft: t.suggestedReply || null,
    impact: t.tier <= 2 ? 'Deadline slip or relationship damage on a live executive thread.' : 'Loss of momentum on an active conversation.',
  }));
}

export function tierCountsOf(d) {
  const tc = d?.tierCounts || {};
  return { 1: tc['1'] || 0, 2: tc['2'] || 0, 3: tc['3'] || 0, 4: tc['4'] || 0, 5: tc['5'] || 0 };
}

/** Quiet/stalled threads from the live follow-up detector. */
export function quietThreadsOf(d) {
  return (d?.stalledThreads || []).map((f, i) => ({
    id: f.threadId || `q-${i}`,
    threadId: f.threadId,
    counterparty: f.counterparty?.name || f.counterparty?.email || 'Unknown counterparty',
    topic: f.subject || '(no subject)',
    daysQuiet: f.daysQuiet ?? 0,
    risk: f.risk || (f.tier <= 2 ? 'High risk' : 'Medium risk'),
    lastMessage: f.lastMessageAt ? String(f.lastMessageAt).slice(0, 10) : '—',
    lastResponder: f.owesNext === 'us' ? 'Them (we owe the reply)' : 'Us (awaiting them)',
    whereLeft: f.suggestedNudge || '—',
    owesReply: f.owesNext === 'us' ? 'We owe them' : 'They owe us',
    note: null,
    followUp: f.suggestedNudge || `Follow up on "${f.subject}" — quiet for ${f.daysQuiet} days.`,
  }));
}

/** Reply debt = live follow-ups where WE owe the next reply. */
export function replyDebtOf(d) {
  const sevFor = (days) => (days >= 7 ? ['Critical', '#8E1508'] : days >= 3 ? ['High', '#B54708'] : ['Medium', '#7A5200']);
  return (d?.whoOwesNext?.us || []).map((f, i) => {
    const [severity, sevColor] = sevFor(f.daysQuiet ?? 0);
    return {
      id: f.threadId || `rd-${i}`,
      item: f.subject || '(no subject)',
      counterparty: f.counterparty?.name || f.counterparty || '—',
      daysElapsed: f.daysQuiet ?? 0,
      dueDate: 'overdue — reply owed',
      severity, sevColor,
      detail: `Quiet for ${f.daysQuiet ?? 0} day(s); the counterparty spoke last.`,
      action: `Send the follow-up on "${(f.subject || '').slice(0, 60)}".`,
    };
  });
}

/** Radar per organisation, computed from LIVE thread scores. */
export function sentimentRadarOf(d) {
  const threads = d?.threads || [];
  const byOrg = new Map();
  for (const t of threads) {
    const org = t.org || t.sender || 'Other';
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org).push(t);
  }
  const rows = [...byOrg.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([org, list]) => {
      const max = (k) => Math.max(...list.map((t) => t[k] ?? 0));
      const neg = list.some((t) => /concern|frustrat|at risk|negative|urgent/i.test(`${t.sentiment} ${t.relationship}`));
      return {
        stakeholder: org.length > 14 ? `${org.slice(0, 13)}…` : org,
        sentiment: neg ? 4 : 7,
        tone: Math.max(1, 10 - max('risk')),
        health: max('bizValue'),
      };
    });
  const concerns = (d?.sentimentRisk || []).map((s) => ({
    stakeholder: s.stakeholder || '—',
    concern: `${s.subject ? `"${s.subject}" — ` : ''}${s.relationship || s.sentiment || 'relationship flagged at risk'}`,
  }));
  return { rows, concerns };
}

/** Strategic lanes from the live category grouping. */
const LANE_COLORS = ['#0B3D2E', '#1B7355', '#2E8B6E', '#7A5200', '#B54708', '#8E1508', '#135C43', '#4E7A6A', '#7FB8A4', '#5A6E64'];
export function opportunityMapOf(d) {
  const threads = liveThreadsOf(d);
  return (d?.categories || []).map((c, i) => {
    const members = threads.filter((t) => t.category === c.category);
    const ents = [...new Set(members.map((t) => t.org || t.sender))].slice(0, 6);
    const next = members.find((t) => t.action)?.action;
    return {
      category: c.category,
      color: LANE_COLORS[i % LANE_COLORS.length],
      entities: ents.length ? ents : ['—'],
      nextSteps: next || `${c.count} active thread(s) — keep momentum.`,
    };
  });
}

/** Action buckets grouped from live thread bucket/tier fields. */
export function actionBucketsOf(d) {
  const threads = liveThreadsOf(d);
  const buckets = [
    { bucket: 'Do now', icon: 'zap', color: '#8E1508', match: (t) => t.tier === 1 },
    { bucket: 'Reply today', icon: 'send', color: '#B54708', match: (t) => t.tier === 2 },
    { bucket: 'Schedule / follow up', icon: 'clock', color: '#1B7355', match: (t) => t.tier === 3 },
    { bucket: 'Monitor', icon: 'eye', color: '#2E8B6E', match: (t) => t.tier >= 4 },
  ];
  return buckets
    .map((b) => ({
      ...b,
      items: threads.filter((t) => (t.bucket ? t.bucket === b.bucket : b.match(t)))
        .map((t) => t.action || `${t.subject} (${t.org || t.sender})`)
        .slice(0, 8),
    }))
    .filter((b) => b.items.length > 0);
}

/** Machine-readable summary assembled from the LIVE payload. */
export function machineSummaryOf(d) {
  const threads = liveThreadsOf(d);
  return {
    generated_at: d?.generatedAt || null,
    source: 'live /api/dashboard/meera',
    tier_counts: tierCountsOf(d),
    reply_debt_count: (d?.whoOwesNext?.us || []).length,
    quiet_thread_count: (d?.stalledThreads || []).length,
    top_5_urgent_actions: threads
      .slice()
      .sort((a, b) => a.tier - b.tier || b.urgency - a.urgency)
      .slice(0, 5)
      .map((t) => ({ subject: t.subject, org: t.org, tier: t.tier, urgency: t.urgency, action: t.action, deadline: t.deadline })),
    recent_email_head: d?.recentEmails?.[0]?.messageId || null,
  };
}

/** True while the dashboard has no live threads yet. */
export function awaitingLive(d) {
  return !d || !Array.isArray(d.threads) || d.threads.length === 0;
}

/** Standard empty-state hint shown by every section pre-sync. */
export const AWAITING_MSG = 'awaiting live sync… — no data is shown until the live inbox loads (live-only, no cached snapshots).';
