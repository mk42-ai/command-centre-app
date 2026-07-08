import React, { useMemo, useState, useEffect } from 'react';
import { toast } from 'sonner';
import { THREADS, TIER_INFO } from './data.js';
import {
  loadHandledLog, loadResolved, TIER_FACTORS,
  loadDismissals, loadDismissLog, undoDismissal, subscribeDismissals,
  DISMISS_OPTIONS,
} from './ai.js';
import Icon from './Icon.jsx';
import Badge from './Badge.jsx';

/*
 * Algorithm & Audit (v17) — transparency view, fully reactive.
 *  (a) Urgency scoring algorithm: PENDING threads only. Dismissed-as-handled
 *      threads leave this table immediately (no reload) and the remaining
 *      threads re-rank; Undo restores them and their exact prior rank/scores.
 *  (b) Handled: dismissed threads with who / which handling option / ISO ts,
 *      each with an Undo that moves the item back to pending.
 *  (c) Dismissed / Archived tracker: the full immutable event trail
 *      (dismissals AND undos) is kept intact.
 */

// Weights used to explain the urgency composition. The stored urgency score
// is the authoritative triage value; this decomposition shows its drivers.
const WEIGHTS = { deadline: 0.35, tier: 0.25, risk: 0.25, sentiment: 0.15 };

function factorsFor(t) {
  // deadline pressure: derived from tier + urgency (T1/T2 carry same/next-day deadlines)
  const deadline = t.tier <= 2 ? 9 : t.tier === 3 ? 6 : 3;
  const tierScore = { 1: 10, 2: 8, 3: 6, 4: 4, 5: 2 }[t.tier] || 5;
  const risk = t.risk;
  const sentiment = /concern|frustrat|at risk|chas|passive/i.test(t.sentiment) ? 8 : 4;
  const composite =
    deadline * WEIGHTS.deadline + tierScore * WEIGHTS.tier + risk * WEIGHTS.risk + sentiment * WEIGHTS.sentiment;
  return { deadline, tierScore, risk, sentiment, composite: Math.round(composite * 10) / 10 };
}

export default function AuditView() {
  // reactive dismissal state: any dismiss/undo anywhere in the app triggers
  // an immediate recompute here (scores, ranks, badges) without a reload.
  const [dismissals, setDismissals] = useState(() => loadDismissals());
  useEffect(() => subscribeDismissals(() => setDismissals({ ...loadDismissals() })), []);

  // (a) PENDING ranking — dismissed threads excluded, remainder re-ranked
  const ranked = useMemo(
    () =>
      THREADS.filter((t) => !dismissals[t.id])
        .map((t) => ({ t, f: factorsFor(t) }))
        .sort((a, b) => b.t.urgency - a.t.urgency || b.f.composite - a.f.composite),
    [dismissals]
  );

  // (b) HANDLED — one row per currently-dismissed thread
  const handledRows = useMemo(
    () =>
      Object.values(dismissals).sort((a, b) => String(b.ts).localeCompare(String(a.ts))),
    [dismissals]
  );

  // (c) full event trail: dismiss/undo events + legacy handled log
  const events = useMemo(() => {
    const rows = [];
    for (const e of loadDismissLog()) {
      rows.push({
        ts: e.ts, who: e.by, org: e.org, subject: e.subject,
        action: e.kind === 'undo' ? 'undo (restored to pending)' : `dismissed (${e.optionLabel})`,
        reason: e.kind === 'undo' ? 'moved back to pending list' : `handled via ${e.optionLabel}`,
      });
    }
    for (const e of loadHandledLog()) {
      rows.push({
        ts: e.ts, who: e.signer, org: e.org, subject: e.subject,
        action: `handled (${e.tier})`,
        reason: e.note || `severity ${Number(e.before).toFixed(1)} to ${Number(e.after).toFixed(1)} (delta ${e.delta > 0 ? '+' : ''}${e.delta})`,
      });
    }
    // resolved map entries without a matching event (legacy dismissals)
    const resolved = loadResolved();
    const covered = new Set([
      ...loadHandledLog().map((e) => String(e.threadId)),
      ...loadDismissLog().map((e) => String(e.threadId)),
    ]);
    for (const [id, info] of Object.entries(resolved)) {
      if (!covered.has(String(id))) {
        const t = THREADS.find((x) => String(x.id) === String(id));
        rows.push({ ts: info.at || info.ts || '(this session)', who: info.by, org: t?.org || `Thread ${id}`, subject: t?.subject || '', action: 'dismissed', reason: 'marked handled from workbench' });
      }
    }
    rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return rows;
  }, [dismissals]);

  const restore = (row) => {
    const t = THREADS.find((x) => String(x.id) === String(row.threadId));
    if (!t) return;
    const ev = undoDismissal(t);
    toast.success(`Restored "${t.subject.slice(0, 36)}"`, { description: ev ? `undo logged ${ev.ts}` : '' });
  };

  return (
    <>
      <div className="card">
        <h2><Icon name="layers" size={16} /> Urgency Scoring Algorithm — Pending ({ranked.length})</h2>
        <div className="hint">
          How PENDING threads are prioritized (dismissed-as-handled threads move to the Handled section below and the remainder re-rank instantly). Composite = deadline pressure ({WEIGHTS.deadline}) + tier weight ({WEIGHTS.tier}) + relationship risk ({WEIGHTS.risk}) + sentiment pressure ({WEIGHTS.sentiment}), each factor scored /10. The stored urgency (assigned at triage) is the authoritative rank; the composite shows its drivers. Handled outcomes then shift relationship severity by (urgency/10) x tierFactor (good {TIER_FACTORS.good} / neutral {TIER_FACTORS.neutral} / bad +{TIER_FACTORS.bad}).
        </div>
        <div className="tbl-wrap" style={{ marginTop: 16 }}>
          <table className="audit-table">
            <thead>
              <tr>
                <th>Rank</th><th>Thread</th><th>Tier</th>
                <th>Deadline ({WEIGHTS.deadline})</th><th>Tier wt ({WEIGHTS.tier})</th>
                <th>Risk ({WEIGHTS.risk})</th><th>Sentiment ({WEIGHTS.sentiment})</th>
                <th>Composite</th><th>Urgency /10</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ t, f }, i) => (
                <tr key={t.id}>
                  <td className="audit-rank">#{i + 1}</td>
                  <td className="audit-subj">{t.subject}<div className="audit-org">{t.org}</div></td>
                  <td><span className="chip" style={{ background: TIER_INFO[t.tier].color, color: TIER_INFO[t.tier].text }}>T{t.tier}</span></td>
                  <td>{f.deadline}</td><td>{f.tierScore}</td><td>{f.risk}</td><td>{f.sentiment}</td>
                  <td className="audit-comp">{f.composite.toFixed(1)}</td>
                  <td className="audit-urg"><b>{t.urgency}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2><Icon name="check-circle" size={16} /> Handled ({handledRows.length})</h2>
        <div className="hint">Threads dismissed as handled: who dismissed, which of the three handling options was chosen, and the ISO timestamp. Undo moves the thread back into the pending ranking above and restores its prior scores and rank exactly (base scores are never mutated by a dismissal).</div>
        {handledRows.length === 0 ? (
          <div className="wb-empty">Nothing handled yet. Dismiss a thread as handled (in the Reply Workbench or the detail table) and it will move here, out of the pending ranking.</div>
        ) : (
          <div className="tbl-wrap" style={{ marginTop: 16 }}>
            <table className="audit-table">
              <thead>
                <tr><th>Thread</th><th>Dismissed by</th><th>Handling option</th><th>Timestamp (ISO)</th><th></th></tr>
              </thead>
              <tbody>
                {handledRows.map((row) => (
                  <tr key={row.threadId}>
                    <td className="audit-subj">{row.subject}<div className="audit-org">{row.org}</div></td>
                    <td><span className="wb-init on audit-init">{row.by}</span></td>
                    <td>
                      <Badge tone="low" icon={(DISMISS_OPTIONS.find((o) => o.id === row.option) || {}).icon || 'check-circle'} title={`Handled via ${row.optionLabel}`}>
                        {row.optionLabel}
                      </Badge>
                    </td>
                    <td className="wb-sendlog-ts">{row.ts}</td>
                    <td><button className="wb-undo" title="Undo — restore this thread to pending" onClick={() => restore(row)}>Undo</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2><Icon name="archive" size={16} /> Dismissed / Archived Tracker</h2>
        <div className="hint">The full immutable event trail (persisted in localStorage): every dismissal AND every undo, who acted, when, and the outcome. Undo does not erase history — it appends a new event.</div>
        {events.length === 0 ? (
          <div className="wb-empty">No dismiss or archive events recorded yet. Mark a thread handled in the Reply Workbench (X control) and it will appear here with signer, timestamp and outcome.</div>
        ) : (
          <div className="tbl-wrap" style={{ marginTop: 16 }}>
            <table className="audit-table">
              <thead>
                <tr><th>Timestamp (UTC)</th><th>By</th><th>Thread</th><th>Action</th><th>Reason / outcome</th></tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td className="wb-sendlog-ts">{e.ts}</td>
                    <td><span className="wb-init on audit-init">{e.who}</span></td>
                    <td className="audit-subj">{e.subject}<div className="audit-org">{e.org}</div></td>
                    <td>{e.action}</td>
                    <td className="audit-reason">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
