// ============================================================
// Serverless function layer — the ten backend functions:
//   1. syncInbox            — incremental Zoho inbox sync
//   2. summarizeThread      — thread summarization (LLM, cached)
//   3. classifyEmail        — category classification
//   4. scorePriority        — priority/tier scoring
//   5. analyzeSentiment     — sentiment/tone analysis
//   6. profileSender        — sender relationship profiling
//   7. detectFollowups      — follow-up / stalled-thread detection
//   8. generateDailyBriefing— 07:00 GST executive briefing
//   9. refreshCache         — cache refresh / weekly cleanup
//  10. generateEmbeddings   — embeddings for semantic search
//
// Design contract:
//   • every function is idempotent — dedupe by messageId+checksum
//   • every LLM call is fronted by the hybrid semantic cache
//   • when the LLM is offline/unconfigured, deterministic
//     heuristics keep the pipeline producing sane output
//   • all heavy work runs via the async job queue (jobs.js);
//     API routes only read cache
// ============================================================
import { CONFIG } from '../config.js';
import { kv, semantic, NS, localEmbed, cosine } from '../lib/cache.js';
import { getMailProvider, messageChecksum, headerValue, parseAddress, sha256 } from '../lib/mail.js';
import { analyse, llmConfigured } from '../lib/llm.js';
import { registerJob, enqueue } from '../lib/jobs.js';

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------
// sync state helpers (last-processed timestamps + checksums)
// ------------------------------------------------------------
export function getSyncState() {
  return kv.get(NS.SYNC_STATE, 'inbox') || { lastSyncAt: null, lastHistoryId: null, lastInternalDate: 0, processed: {}, counts: { totalSeen: 0, analyzed: 0, skipped: 0 }, lastError: null, lastResult: null };
}
function putSyncState(s) { kv.set(NS.SYNC_STATE, 'inbox', s, 0); }

// ------------------------------------------------------------
// 1. INBOX SYNC — incremental, idempotent
//    Only fetches messages newer than lastInternalDate (Zoho
//    receivedTime:after search == Gmail historyId semantics),
//    then dedupes by messageId + checksum so a re-delivered or
//    unchanged message is never re-analyzed.
// ------------------------------------------------------------
export async function syncInbox({ force = false, maxResults = 100 } = {}) {
  const provider = await getMailProvider();
  const state = getSyncState();
  const after = force ? null : (state.lastInternalDate || null);

  let messages;
  try {
    messages = await provider.listMessages({ afterEpochMs: after, maxResults });
  } catch (e) {
    state.lastError = { at: nowIso(), message: String(e?.message || e), phase: 'list' };
    putSyncState(state);
    throw e;
  }

  const newOrChanged = [];
  for (const m of messages) {
    const csum = messageChecksum(m);
    const prev = state.processed[m.id];
    state.counts.totalSeen++;
    if (prev && prev.checksum === csum && !force) { state.counts.skipped++; continue; } // idempotent skip
    state.processed[m.id] = { checksum: csum, threadId: m.threadId, at: Date.now() };
    newOrChanged.push({ m, csum, changed: Boolean(prev) });
    // email metadata cache — the dashboard's raw source.
    // v31 (FIX #1): SHORT TTL (CONFIG.mail.fetchTtlS, default 3 min) instead of
    // the old 24h (defaultTtlS*4) so fresh inbox mail is never masked by a
    // day-old cached copy. Also persists the full `body` from the live fetch.
    kv.set(NS.EMAIL_META, m.id, {
      id: m.id, threadId: m.threadId, historyId: m.historyId,
      subject: headerValue(m, 'Subject'), from: parseAddress(headerValue(m, 'From')),
      to: headerValue(m, 'To'), date: headerValue(m, 'Date'),
      internalDate: Number(m.internalDate), snippet: m.snippet,
      body: m.body || m.snippet || '',
      labelIds: m.labelIds, zoho: m.zoho || null, checksum: csum,
      seedMeta: m.seedMeta || null,
      cachedAt: nowIso(),
    }, CONFIG.mail.fetchTtlS || CONFIG.cache.defaultTtlS);
    state.lastInternalDate = Math.max(state.lastInternalDate || 0, Number(m.internalDate) || 0);
  }

  // cap processed-map growth (keep newest 2000 message states)
  const ids = Object.keys(state.processed);
  if (ids.length > 2000) {
    ids.sort((a, b) => state.processed[a].at - state.processed[b].at);
    for (const id of ids.slice(0, ids.length - 2000)) delete state.processed[id];
  }

  state.lastSyncAt = nowIso();
  state.lastHistoryId = String(state.lastInternalDate || '');
  state.counts.analyzed += newOrChanged.length;
  state.lastResult = { newOrChanged: newOrChanged.length, seen: messages.length, provider: provider.name, force };
  state.lastError = null;
  putSyncState(state);

  // fan out per-thread analysis as async jobs (idempotent by thread+checksum)
  const threads = new Map();
  for (const { m, csum } of newOrChanged) threads.set(m.threadId, csum);
  for (const [threadId, csum] of threads) {
    enqueue('analyzeThread', { threadId }, { idempotencyKey: `${threadId}:${csum}` });
  }
  if (newOrChanged.length) enqueue('rebuildDashboard', {}, { idempotencyKey: `dash:${state.lastHistoryId}` });

  return { ok: true, provider: provider.name, seen: messages.length, newOrChanged: newOrChanged.length, threadsQueued: threads.size, lastSyncAt: state.lastSyncAt, incremental: !force && after != null };
}

// ------------------------------------------------------------
// helpers to assemble thread context from cached email metadata
// ------------------------------------------------------------
function threadEmails(threadId) {
  return kv.all(NS.EMAIL_META).map(({ value }) => value).filter((e) => e && e.threadId === threadId)
    .sort((a, b) => a.internalDate - b.internalDate);
}
function threadDigest(emails) {
  return sha256(emails.map((e) => `${e.id}:${e.checksum}`).join('|'));
}
function threadText(emails) {
  return emails.map((e) => `[${e.date}] ${e.from?.name || e.from?.email}: ${e.subject}\n${e.snippet}`).join('\n---\n').slice(0, 6000);
}

// ------------------------------------------------------------
// 2. THREAD SUMMARIZATION (LLM, semantic-cached, seed-aware)
// ------------------------------------------------------------
export async function summarizeThread(threadId) {
  const emails = threadEmails(threadId);
  if (!emails.length) return null;
  const digest = threadDigest(emails);
  const cached = kv.get(NS.THREAD_SUMMARY, threadId);
  if (cached && cached.digest === digest) return cached; // unchanged thread → no rework

  const seed = emails.find((e) => e.seedMeta)?.seedMeta || null;
  let out;
  if (seed) {
    out = { summary: seed.summary, action: seed.action, owner: seed.owner, deadline: seed.deadline, impact: seed.impact, source: 'seed' };
  } else {
    const r = await analyse('summary', threadText(emails),
      `Summarize this email thread for a chief of staff. Reply as JSON {"summary": "...", "action": "...", "owner": "...", "deadline": "...", "impact": "..."}.\nTHREAD:\n${threadText(emails)}`);
    out = r._offline || r._error
      ? { summary: emails[emails.length - 1].snippet || emails[emails.length - 1].subject, action: 'Review thread', owner: 'Meera', deadline: null, impact: null, source: 'heuristic' }
      : { ...r, source: 'llm' };
  }
  const rec = { threadId, digest, ...out, updatedAt: nowIso() };
  kv.set(NS.THREAD_SUMMARY, threadId, rec, CONFIG.cache.summaryTtlS);
  return rec;
}

// ------------------------------------------------------------
// 3. EMAIL CLASSIFICATION (investor/customer/legal/internal/…)
// ------------------------------------------------------------
const CATEGORY_RULES = [
  { cat: 'Investors', re: /invest|shareholder|board resolution|rofr|adgm|equity|term sheet|deal desk/i },
  { cat: 'Legal / Contracts', re: /nda|contract|t&cs|terms|legal|agreement|counsel/i },
  { cat: 'Government', re: /adcci|government|ministry|ad ports|presight|g42|sme upskilling|rfx|tender/i },
  { cat: 'Finance / Payments', re: /invoice|payment|stripe|payout|bank|proforma/i },
  { cat: 'Media / PR', re: /press|congress|conference|media|interview|keynote/i },
  { cat: 'Product / Technical', re: /sdk|api|architecture|integration|bug|deploy|infra|server/i },
  { cat: 'Internal', re: /@airev\.ae$/i },
];
export async function classifyEmail(threadId) {
  const emails = threadEmails(threadId);
  if (!emails.length) return null;
  const seed = emails.find((e) => e.seedMeta)?.seedMeta;
  if (seed?.category) return { threadId, category: seed.category, source: 'seed' };
  const text = `${emails[0].subject} ${emails[0].snippet} ${emails[0].from?.email || ''}`;
  for (const { cat, re } of CATEGORY_RULES) if (re.test(text)) return { threadId, category: cat, source: 'rules' };
  if (llmConfigured()) {
    const r = await analyse('classify', text, `Classify this email into exactly one of: Investors, Government, Enterprise Clients, Strategic Partners, Legal / Contracts, Finance / Payments, Product / Technical, Media / PR, Internal, Other. Reply JSON {"category":"..."}. EMAIL: ${text}`);
    if (r?.category) return { threadId, category: r.category, source: 'llm' };
  }
  return { threadId, category: 'Other', source: 'fallback' };
}

// ------------------------------------------------------------
// 4. PRIORITY SCORING → tier 1–5 (pyramid)
// ------------------------------------------------------------
export async function scorePriority(threadId) {
  const emails = threadEmails(threadId);
  if (!emails.length) return null;
  const seed = emails.find((e) => e.seedMeta)?.seedMeta;
  let urgency, risk, bizValue, tier, tierReason, source;
  if (seed) {
    ({ urgency, risk, bizValue, tier, tierReason } = seed);
    source = 'seed';
  } else {
    const text = threadText(emails);
    const r = llmConfigured()
      ? await analyse('priority', text, `Score this email thread for a CEO inbox. Reply JSON {"urgency":1-10,"risk":1-10,"bizValue":1-10,"tier":1-5,"tierReason":"..."} where tier 1 = act today, 5 = archive. THREAD:\n${text}`)
      : {};
    const ageDays = (Date.now() - emails[emails.length - 1].internalDate) / 86400000;
    urgency = Number(r.urgency) || Math.max(1, Math.min(10, Math.round(8 - ageDays)));
    risk = Number(r.risk) || 4;
    bizValue = Number(r.bizValue) || 5;
    tier = Number(r.tier) || (urgency >= 8 ? 1 : urgency >= 6 ? 2 : urgency >= 4 ? 3 : urgency >= 2 ? 4 : 5);
    tierReason = r.tierReason || `heuristic: urgency ${urgency}, ${Math.round(ageDays)}d old`;
    source = r.tierReason ? 'llm' : 'heuristic';
  }
  const rec = { threadId, urgency, risk, bizValue, tier, tierReason, source, updatedAt: nowIso() };
  kv.set(NS.PYRAMID, threadId, rec, CONFIG.cache.defaultTtlS);
  return rec;
}

// ------------------------------------------------------------
// 5. SENTIMENT / TONE ANALYSIS
// ------------------------------------------------------------
export async function analyzeSentiment(threadId) {
  const emails = threadEmails(threadId);
  if (!emails.length) return null;
  const seed = emails.find((e) => e.seedMeta)?.seedMeta;
  let rec;
  if (seed) {
    rec = { threadId, sentimentLabel: seed.sentiment, relationship: seed.relationship, riskFlag: seed.risk >= 6, source: 'seed' };
  } else {
    const text = threadText(emails);
    const r = llmConfigured()
      ? await analyse('sentiment', text, `Analyze the sentiment and tone of this email thread. Reply JSON {"sentimentLabel":"...","tone":"...","relationship":"Healthy|Stable|At risk|Strained","riskFlag":true/false}. THREAD:\n${text}`)
      : {};
    const negative = /urgent|overdue|disappoint|concern|escalat|final notice|unpaid/i.test(text);
    rec = {
      threadId,
      sentimentLabel: r.sentimentLabel || (negative ? 'Concerned / pressing' : 'Neutral / formal'),
      tone: r.tone || null,
      relationship: r.relationship || (negative ? 'At risk' : 'Stable'),
      riskFlag: typeof r.riskFlag === 'boolean' ? r.riskFlag : negative,
      source: r.sentimentLabel ? 'llm' : 'heuristic',
    };
  }
  rec.updatedAt = nowIso();
  kv.set(NS.SENTIMENT, threadId, rec, CONFIG.cache.defaultTtlS);
  return rec;
}

// ------------------------------------------------------------
// 6. SENDER RELATIONSHIP PROFILING (relationship memory)
// ------------------------------------------------------------
export async function profileSender(email) {
  const key = String(email).toLowerCase();
  const existing = kv.get(NS.SENDER_PROFILE, key);
  const msgs = kv.all(NS.EMAIL_META).map(({ value }) => value).filter((e) => e?.from?.email === key)
    .sort((a, b) => a.internalDate - b.internalDate);
  if (!msgs.length) return existing || null;
  const last = msgs[msgs.length - 1];
  const seed = msgs.find((e) => e.seedMeta)?.seedMeta;
  const threadIds = [...new Set(msgs.map((m) => m.threadId))];
  const sentiments = threadIds.map((t) => kv.get(NS.SENTIMENT, t)).filter(Boolean);
  const rec = {
    email: key,
    name: last.from?.name || seed?.sender || key,
    org: seed?.org || key.split('@')[1] || null,
    role: seed?.role || null,
    firstSeen: new Date(msgs[0].internalDate).toISOString(),
    lastSeen: new Date(last.internalDate).toISOString(),
    messageCount: msgs.length,
    threadCount: threadIds.length,
    threads: threadIds.slice(0, 20),
    relationship: sentiments[0]?.relationship || seed?.relationship || 'Stable',
    riskFlag: sentiments.some((s) => s.riskFlag),
    recentSubjects: msgs.slice(-5).map((m) => m.subject),
    notes: existing?.notes || (seed ? [seed.tierReason].filter(Boolean) : []),
    interactionLog: [...(existing?.interactionLog || []), { at: nowIso(), event: 'profile-refresh', messageCount: msgs.length }].slice(-25),
    updatedAt: nowIso(),
  };
  kv.set(NS.SENDER_PROFILE, key, rec, CONFIG.cache.profileTtlS);
  return rec;
}

// ------------------------------------------------------------
// 7. FOLLOW-UP DETECTION (stalled threads / who owes next reply)
// ------------------------------------------------------------
export async function detectFollowups() {
  const mailbox = CONFIG.zoho.mailbox.toLowerCase();
  const byThread = new Map();
  for (const { value: e } of kv.all(NS.EMAIL_META)) {
    if (!e) continue;
    if (!byThread.has(e.threadId)) byThread.set(e.threadId, []);
    byThread.get(e.threadId).push(e);
  }
  const followups = [];
  for (const [threadId, emails] of byThread) {
    emails.sort((a, b) => a.internalDate - b.internalDate);
    const last = emails[emails.length - 1];
    const seed = emails.find((e) => e.seedMeta)?.seedMeta;
    const lastFromUs = (last.from?.email || '').toLowerCase() === mailbox || (last.from?.email || '').endsWith('@airev.ae');
    const daysQuiet = Math.floor((Date.now() - last.internalDate) / 86400000);
    const stalled = daysQuiet >= 2;
    if (!stalled) continue;
    const pyramid = kv.get(NS.PYRAMID, threadId);
    followups.push({
      threadId,
      subject: last.subject,
      counterparty: lastFromUs ? (emails.find((e) => (e.from?.email || '').toLowerCase() !== mailbox)?.from || last.from) : last.from,
      lastMessageAt: new Date(last.internalDate).toISOString(),
      daysQuiet,
      owesNext: lastFromUs ? 'them' : 'us',
      tier: pyramid?.tier ?? seed?.tier ?? 3,
      risk: seed ? `${seed.risk}/10` : null,
      suggestedNudge: seed?.action || `Follow up on "${last.subject}" — quiet for ${daysQuiet} days.`,
    });
  }
  followups.sort((a, b) => (a.owesNext === 'us' ? -1 : 1) - (b.owesNext === 'us' ? -1 : 1) || b.daysQuiet - a.daysQuiet);
  const rec = { generatedAt: nowIso(), count: followups.length, followups };
  kv.set(NS.FOLLOWUPS, 'latest', rec, CONFIG.cache.defaultTtlS);
  return rec;
}

// ------------------------------------------------------------
// full thread analysis job = 2+3+4+5 (+ sender profile)
// ------------------------------------------------------------
export async function analyzeThread(threadId) {
  const [summary, cls, pri, sen] = [
    await summarizeThread(threadId),
    await classifyEmail(threadId),
    await scorePriority(threadId),
    await analyzeSentiment(threadId),
  ];
  const emails = threadEmails(threadId);
  for (const e of new Set(emails.map((x) => x.from?.email).filter(Boolean))) await profileSender(e);
  await generateEmbeddingsForThread(threadId);
  return { threadId, summary: Boolean(summary), classified: cls?.category, tier: pri?.tier, sentiment: sen?.sentimentLabel };
}

// ------------------------------------------------------------
// 8. DAILY EXECUTIVE BRIEFING (07:00 GST / 03:00 UTC)
// ------------------------------------------------------------
export async function generateDailyBriefing({ trigger = 'cron' } = {}) {
  const dash = await rebuildDashboard(); // briefing reads the fresh dashboard model
  const top = dash.topUrgent.slice(0, 5);
  const fu = (kv.get(NS.FOLLOWUPS, 'latest') || await detectFollowups());
  const oweUs = fu.followups.filter((f) => f.owesNext === 'us').slice(0, 4);
  const risky = dash.sentimentRisk.slice(0, 4);

  let narrative = null;
  if (llmConfigured()) {
    const ctx = JSON.stringify({ topUrgent: top, replyDebt: oweUs, sentimentRisk: risky, tierCounts: dash.tierCounts }).slice(0, 5000);
    const r = await analyse('briefing', `${new Date().toISOString().slice(0, 10)}:${sha256(ctx).slice(0, 16)}`,
      `You are Meera, chief of staff. Write a crisp 6-10 sentence executive morning briefing for MK's inbox based on this JSON. Reply JSON {"briefing":"..."}. DATA: ${ctx}`, { temperature: 0.4 });
    narrative = r?.briefing || null;
  }
  if (!narrative) {
    narrative = [
      `Good morning. ${dash.tierCounts['1'] || 0} Tier-1 item(s) need action today; ${fu.count} thread(s) are stalled.`,
      top.length ? `Top of the stack: ${top.map((t) => `"${t.subject}" (${t.owner || 'unassigned'})`).join('; ')}.` : null,
      oweUs.length ? `We owe replies on: ${oweUs.map((f) => f.subject).join('; ')}.` : null,
      risky.length ? `Relationship risk watch: ${risky.map((r) => r.stakeholder || r.subject).join(', ')}.` : null,
      `Dashboard refreshed ${dash.generatedAt}.`,
    ].filter(Boolean).join(' ');
  }

  const briefing = {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: nowIso(),
    timezone: CONFIG.briefing.timezone,
    localTime: '07:00 GST (03:00 UTC)',
    trigger,
    narrative,
    tierCounts: dash.tierCounts,
    topUrgent: top,
    replyDebt: oweUs,
    sentimentRisk: risky,
    followupCount: fu.count,
    source: llmConfigured() ? 'llm+cache' : 'heuristic+cache',
  };
  kv.set(NS.BRIEFING, briefing.date, briefing, 3 * 24 * 3600);
  kv.set(NS.BRIEFING, 'latest', briefing, 3 * 24 * 3600);
  return briefing;
}

// ------------------------------------------------------------
// 9. CACHE REFRESH / CLEANUP
// ------------------------------------------------------------
export async function refreshCache({ deep = false } = {}) {
  const t0 = Date.now();
  const dash = await rebuildDashboard();
  await detectFollowups();
  let cleanup = null;
  if (deep) {
    cleanup = kv.cleanup({ namespaces: [] }); // expired-entry purge across all namespaces
    // re-embed all thread summaries (weekly embedding refresh)
    let reembedded = 0;
    for (const { id } of kv.all(NS.THREAD_SUMMARY)) {
      if (id === 'latest') continue;
      await generateEmbeddingsForThread(id);
      reembedded++;
    }
    cleanup.reembedded = reembedded;
  }
  return { ok: true, tookMs: Date.now() - t0, dashboardAt: dash.generatedAt, cleanup };
}

// ------------------------------------------------------------
// 10. EMBEDDINGS GENERATION (semantic search index)
// ------------------------------------------------------------
export async function generateEmbeddingsForThread(threadId) {
  const emails = threadEmails(threadId);
  if (!emails.length) return null;
  const summary = kv.get(NS.THREAD_SUMMARY, threadId);
  const text = `${emails[0].subject}\n${summary?.summary || ''}\n${emails.map((e) => e.snippet).join(' ')}`.slice(0, 4000);
  const vector = await semantic.embed(text);
  const rec = { threadId, vector, text: text.slice(0, 200), dim: vector.length, updatedAt: nowIso() };
  kv.set(NS.EMBEDDINGS, threadId, rec, CONFIG.cache.embeddingTtlS);
  return { threadId, dim: vector.length };
}

export async function semanticSearch(query, { topK = 5 } = {}) {
  const qv = await semantic.embed(query);
  const scored = kv.all(NS.EMBEDDINGS)
    .map(({ id, value }) => value && ({ threadId: id, similarity: +cosine(qv, value.vector).toFixed(4), preview: value.text }))
    .filter(Boolean)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
  return { query, results: scored };
}

// ------------------------------------------------------------
// DASHBOARD MODEL — the cache-first JSON the frontend reads.
// Assembled purely from cached facts; no live mail call, no LLM.
// ------------------------------------------------------------
export async function rebuildDashboard() {
  const emails = kv.all(NS.EMAIL_META).map(({ value }) => value).filter(Boolean);
  const byThread = new Map();
  for (const e of emails) {
    if (!byThread.has(e.threadId)) byThread.set(e.threadId, []);
    byThread.get(e.threadId).push(e);
  }
  const threads = [];
  for (const [threadId, list] of byThread) {
    list.sort((a, b) => a.internalDate - b.internalDate);
    const last = list[list.length - 1];
    const seed = list.find((e) => e.seedMeta)?.seedMeta;
    const pyramid = kv.get(NS.PYRAMID, threadId);
    const summary = kv.get(NS.THREAD_SUMMARY, threadId);
    const sentiment = kv.get(NS.SENTIMENT, threadId);
    threads.push({
      threadId,
      subject: last.subject,
      sender: last.from?.name || last.from?.email,
      email: last.from?.email,
      org: seed?.org || (last.from?.email || '').split('@')[1] || null,
      lastActivity: new Date(last.internalDate).toISOString(),
      tier: pyramid?.tier ?? seed?.tier ?? 3,
      tierReason: pyramid?.tierReason ?? seed?.tierReason ?? null,
      urgency: pyramid?.urgency ?? seed?.urgency ?? 5,
      risk: pyramid?.risk ?? seed?.risk ?? 4,
      bizValue: pyramid?.bizValue ?? seed?.bizValue ?? 5,
      category: seed?.category || null,
      bucket: seed?.bucket || null,
      owner: seed?.owner || null,
      action: summary?.action ?? seed?.action ?? null,
      deadline: summary?.deadline ?? seed?.deadline ?? null,
      summary: summary?.summary ?? seed?.summary ?? last.snippet,
      sentiment: sentiment?.sentimentLabel ?? seed?.sentiment ?? null,
      relationship: sentiment?.relationship ?? seed?.relationship ?? null,
      riskFlag: sentiment?.riskFlag ?? false,
      suggestedReply: seed?.draft || null,
      zoho: last.zoho || null,
      messageCount: list.length,
    });
  }
  threads.sort((a, b) => a.tier - b.tier || b.urgency - a.urgency);

  const tierCounts = {};
  for (const t of threads) tierCounts[t.tier] = (tierCounts[t.tier] || 0) + 1;

  const fu = kv.get(NS.FOLLOWUPS, 'latest') || { followups: [], count: 0 };
  const dashboard = {
    generatedAt: nowIso(),
    mailbox: CONFIG.zoho.mailbox,
    provider: (await getMailProvider()).name,
    syncState: (() => { const s = getSyncState(); return { lastSyncAt: s.lastSyncAt, lastHistoryId: s.lastHistoryId, lastError: s.lastError, counts: s.counts }; })(),
    tierCounts,
    priorityPyramid: [1, 2, 3, 4, 5].map((tier) => ({ tier, count: tierCounts[tier] || 0, threads: threads.filter((t) => t.tier === tier).map((t) => t.threadId) })),
    topUrgent: threads.filter((t) => t.tier <= 2).slice(0, 8),
    stalledThreads: fu.followups.slice(0, 10),
    whoOwesNext: {
      us: fu.followups.filter((f) => f.owesNext === 'us').map((f) => ({ threadId: f.threadId, subject: f.subject, daysQuiet: f.daysQuiet })),
      them: fu.followups.filter((f) => f.owesNext === 'them').map((f) => ({ threadId: f.threadId, subject: f.subject, daysQuiet: f.daysQuiet })),
    },
    categories: ['Investors', 'Government', 'Enterprise Clients', 'Strategic Partners', 'Legal / Contracts', 'Finance / Payments', 'Product / Technical', 'Media / PR', 'Internal', 'Other']
      .map((cat) => ({ category: cat, threads: threads.filter((t) => t.category === cat).map((t) => t.threadId), count: threads.filter((t) => t.category === cat).length }))
      .filter((c) => c.count > 0),
    sentimentRisk: threads.filter((t) => t.riskFlag || /at risk|strained/i.test(t.relationship || '')).map((t) => ({ threadId: t.threadId, stakeholder: t.org || t.sender, subject: t.subject, relationship: t.relationship, sentiment: t.sentiment })),
    suggestedReplies: threads.filter((t) => t.suggestedReply).map((t) => ({ threadId: t.threadId, subject: t.subject, draft: t.suggestedReply })),
    relationshipMemory: kv.all(NS.SENDER_PROFILE).map(({ value }) => value).filter(Boolean)
      .sort((a, b) => b.messageCount - a.messageCount).slice(0, 12)
      .map((p) => ({ email: p.email, name: p.name, org: p.org, role: p.role, messageCount: p.messageCount, relationship: p.relationship, riskFlag: p.riskFlag, lastSeen: p.lastSeen, recentSubjects: p.recentSubjects?.slice(-3) })),
    threads,
  };
  kv.set(NS.DASHBOARD, 'meera', dashboard, CONFIG.cache.dashboardTtlS);
  kv.set(NS.DASHBOARD, 'meera:lastGood', dashboard, 0); // never expires — sync-failure fallback
  return dashboard;
}

// ------------------------------------------------------------
// job registrations (async background execution)
// ------------------------------------------------------------
registerJob('syncInbox', (p) => syncInbox(p));
registerJob('analyzeThread', ({ threadId }) => analyzeThread(threadId));
registerJob('rebuildDashboard', () => rebuildDashboard());
registerJob('detectFollowups', () => detectFollowups());
registerJob('dailyBriefing', (p) => generateDailyBriefing(p));
registerJob('refreshCache', (p) => refreshCache(p));
registerJob('profileSender', ({ email }) => profileSender(email));
registerJob('embeddings', ({ threadId }) => generateEmbeddingsForThread(threadId));
