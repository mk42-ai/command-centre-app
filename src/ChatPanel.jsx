import React, { useEffect, useRef, useState } from 'react';
import { streamQuery } from './ai.js';
import { liveThreadsOf } from './liveModel.js';
import Icon from './Icon.jsx';

/*
 * Side chat panel — Claude-extension style:
 * slim edge tab when idle, slide-in panel; minimal chrome, rounded,
 * conversation scrolls above a single bottom-anchored input.
 * Free-form prompts run through the same OnDemand session via /api proxy.
 *
 * v41 LIVE-ONLY: the copilot preamble is built from the LIVE dashboard
 * threads passed via the `d` prop — the July fixture brief is gone. When
 * live data has not landed the preamble says so instead of inventing state.
 */

const preambleFor = (d) => {
  const threads = liveThreadsOf(d);
  const brief = threads.length
    ? threads.map((t) => `#${t.id} [T${t.tier}] ${t.org || t.sender} — ${t.subject} · urgency ${t.urgency}/10 · risk ${t.risk}/10 · owner ${t.owner} · ${t.summary}`).join('\n')
    : '(live inbox not yet synced — no triaged state available; say so if asked about specific threads)';
  return `You are the inbox copilot inside "Meera's Command Centre — Managing the CEO's Inbox" (AIREV/OnDemand). Meera AlDhaheri (Chief of Staff) and Sabiya use you to reason about MK's inbox. Be concise and actionable. Current LIVE triaged inbox state:
${brief}

USER QUESTION: `;
};

export default function ChatPanel({ inline = false, d = null }) {
  const [open, setOpen] = useState(inline);
  const [msgs, setMsgs] = useState([]); // {role:'user'|'ai', text}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, open]);

  const send = async (e, override) => {
    e?.preventDefault();
    const q = (override ?? input).trim();
    if (!q || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: q }, { role: 'ai', text: '' }]);
    setBusy(true);
    try {
      await streamQuery(preambleFor(d) + q, (sofar) => {
        setMsgs((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: 'ai', text: sofar };
          return copy;
        });
      });
    } catch (err) {
      setMsgs((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = { role: 'ai', text: `OnDemand call failed after retries (${String(err.message || err)})`, failed: q, error: true };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* slim edge tab (idle state) */}
      {!inline && !open && (
        <button className="cp-tab" onClick={() => setOpen(true)} title="Open inbox copilot">
          <Icon name="message-square" size={14} /> Chat
        </button>
      )}

      {/* slide-in panel */}
      <aside className={`cp-panel ${inline ? 'inline open' : open ? 'open' : ''}`} aria-hidden={!inline && !open}>
        <header className="cp-head">
          <div className="cp-title">
            <span className="cp-tab-dot" /> Inbox copilot
            <span className="cp-sub">OnDemand · streaming</span>
          </div>
          {!inline && <button className="cp-close" onClick={() => setOpen(false)} title="Collapse" aria-label="Collapse chat panel"><Icon name="panel-close" size={15} /></button>}
        </header>

        <div className="cp-scroll" ref={scrollRef}>
          {msgs.length === 0 && (
            <div className="cp-empty">
              Ask anything about MK's inbox —<br />
              “what must go out before noon?”,<br />
              “summarise the Presight situation”,<br />
              “draft a nudge for Lockton”.
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`cp-msg ${m.role}${m.error ? ' err' : ''}`}>
              {m.text || (busy && i === msgs.length - 1 ? <span className="wb-caret" /> : '')}
              {m.failed && !busy && (
                <div><button className="wb-gen sm" style={{ marginTop: 6 }} onClick={() => send(null, m.failed)}>Retry</button></div>
              )}
            </div>
          ))}
        </div>

        <form className="cp-inputrow" onSubmit={send}>
          <input
            className="cp-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? 'Streaming…' : 'Message the copilot…'}
            disabled={busy}
            aria-label="Chat message"
          />
          <button className="cp-send" disabled={busy || !input.trim()} type="submit" aria-label="Send message"><Icon name="send" size={16} /></button>
        </form>
      </aside>
    </>
  );
}
