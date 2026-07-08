import React, { useMemo } from 'react';
import { THREADS } from './data.js';
import { loadSendLog, loadHandledLog } from './ai.js';
import Icon from './Icon.jsx';

/*
 * Send Log section (v10) — aggregated, timestamped view of every dispatch
 * recorded per thread in localStorage (written by the Send via Fable flow).
 */

export default function SendLog() {
  const entries = useMemo(() => {
    const log = loadSendLog();
    const rows = [];
    for (const [threadId, arr] of Object.entries(log)) {
      const t = THREADS.find((x) => String(x.id) === String(threadId));
      for (const e of arr || []) {
        rows.push({ ...e, threadId, subject: t?.subject || `Thread ${threadId}`, org: t?.org || '' });
      }
    }
    // merge handled events (severity changes with tier/signer/note)
    for (const ev of loadHandledLog()) {
      rows.push({
        ts: ev.ts, status: 'handled', subject: ev.subject, org: ev.org,
        sentMessageId: null, targetMessageId: null,
        detail: `severity ${Number(ev.before).toFixed(1)} to ${Number(ev.after).toFixed(1)} (delta ${ev.delta > 0 ? '+' : ''}${ev.delta}) - ${ev.tier} - signed ${ev.signer}${ev.note ? ' - ' + ev.note : ''}`,
      });
    }
    rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return rows;
  }, []);

  return (
    <div className="card">
      <h2><Icon name="history" size={16} /> Send Log</h2>
      <div className="hint">
        Every dispatch executed via the Fable send pipeline (/api/send), newest first. Entries persist in this browser (localStorage).
      </div>

      {entries.length === 0 ? (
        <div className="wb-empty">
          No sends recorded yet in this browser. Approve a reply in the Reply Workbench and press
          {' '}<b>Send via Fable</b> — each dispatch lands here with its timestamp and outcome.
        </div>
      ) : (
        <div className="sendlog-table-wrap">
          <table className="sendlog-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Timestamp (UTC)</th>
                <th>Thread</th>
                <th>Sent msg id</th>
                <th>Target thread id</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className={e.status}>
                  <td>
                    <span className={`wb-sendlog-dot ${e.status}`} aria-hidden="true" />
                    <span className="wb-sendlog-status">{e.status === 'sent' ? 'Sent' : e.status === 'handled' ? 'Handled' : 'Failed'}</span>
                  </td>
                  <td className="wb-sendlog-ts">{e.ts}</td>
                  <td>
                    <div className="sendlog-subj">{e.subject}</div>
                    <div className="sendlog-org">{e.org}</div>
                  </td>
                  <td>{e.sentMessageId ? <span className="wb-sendlog-mid">{e.sentMessageId}</span> : '—'}</td>
                  <td>{e.targetMessageId ? <span className="wb-sendlog-mid">{e.targetMessageId}</span> : '—'}</td>
                  <td className="sendlog-detail">{e.status === 'sent' ? `via ${e.endpoint || 'predefined-claude-sonnet-5'}` : (e.detail || '').slice(0, 140)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
