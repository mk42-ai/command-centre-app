import React, { useMemo, useRef, useState } from 'react';
import { THREADS, TIER_INFO } from './data.js';
import { toast } from 'sonner';
import { motion, useReducedMotion } from 'framer-motion';
import { generateRepliesParallel, refineReply, reviseReplyFreeform, matchDoc, DOCS, MICRO_COMMANDS, sendReply, uploadAttachment, loadSendLog, appendSendLog, DISMISS_OPTIONS, CURRENT_USER, recordDismissal, undoDismissal, loadDismissals } from './ai.js';
import Badge, { toneForScore } from './Badge.jsx';
import Icon from './Icon.jsx';

/*
 * AI Reply Workbench — v3
 *  · 3-4 live AI suggested replies per thread (OnDemand inference via server proxy)
 *  · micro-command box (closed set: warmer/firmer/shorter/formal/add deadline/soften)
 *  · approve to auto-attach detection (Attach? Yes/No)
 *  · dismiss to MK/SK/MA handler attribution, collapsible Resolved strip
 */

function ReplyCard({ idx, text, selected, onSelect, revising, revealText }) {
  // revising: skeleton phase (in-card). revealText: chunked word-streaming phase.
  return (
    <button className={`wb-reply ${selected ? 'sel' : ''}`} onClick={() => onSelect(idx)} title="Select this reply">
      <div className="wb-reply-tag">Option {idx + 1}{selected ? ' · selected' : ''}</div>
      {revising ? (
        <div className="wb-card-skel" aria-label="Revising draft">
          <div className="skel skel-line" />
          <div className="skel skel-line" />
          <div className="skel skel-line short" />
        </div>
      ) : revealText != null ? (
        <div className="wb-reply-text streaming">{revealText}<span className="wb-caret" /></div>
      ) : (
        <div className="wb-reply-text">{text}</div>
      )}
    </button>
  );
}

// parse a PARTIAL JSON array stream ( ["a","b",... ) into per-card texts
// chunked word-by-word reveal (~3 words per tick @ ~45ms); instant under reduced motion
function useWordStream(reduceMotion) {
  const [revealText, setRevealText] = React.useState(null);
  const timerRef = React.useRef(null);
  const run = React.useCallback((fullText, onDone) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (reduceMotion) { setRevealText(null); onDone(fullText); return; }
    const words = String(fullText).split(/(\s+)/); // keep whitespace tokens
    let i = 0;
    setRevealText('');
    timerRef.current = setInterval(() => {
      i = Math.min(words.length, i + 6); // ~3 words + separators
      setRevealText(words.slice(0, i).join(''));
      if (i >= words.length) {
        clearInterval(timerRef.current); timerRef.current = null;
        setRevealText(null); onDone(fullText);
      }
    }, 45);
  }, [reduceMotion]);
  React.useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
  return [revealText, run];
}

function ThreadWorkbench({ thread, seq, onResolve, resolvedInfo, onUnresolve }) {
  const [replies, setReplies] = useState(null);      // array of strings
  const [phase, setPhase] = useState('idle');        // idle | generating | ready | refining | error
  const [selIdx, setSelIdx] = useState(0);
  const [optStreams, setOptStreams] = useState(null); // per-option live stream text [4] while generating
  const [revealText, runWordStream] = useWordStream(useReducedMotion());
  const [cmd, setCmd] = useState('');
  const [cmdErr, setCmdErr] = useState('');
  const [err, setErr] = useState('');
  const [approving, setApproving] = useState(false); // show attach prompt
  const [approvedMsg, setApprovedMsg] = useState('');
  const [approvedBody, setApprovedBody] = useState(null); // final approved reply text
  const [sendState, setSendState] = useState(null);       // null | 'sending' | {ok,ts,...}
  const [sendLog, setSendLog] = useState(() => (loadSendLog()[thread.id] || []));
  const [dismissOpen, setDismissOpen] = useState(false); // compact 3-option selector
  const busyRef = useRef(false);

  const doc = useMemo(() => matchDoc(thread), [thread]);
  // v18: multi-select document attachments — Set of DOCS ids. The keyword-matched
  // doc is pre-selected as a suggestion; the user can toggle any of the 6 or Select all.
  const [attachIds, setAttachIds] = useState(() => new Set(doc ? [doc.id] : []));
  const toggleAttach = (id) =>
    setAttachIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const allSelected = attachIds.size === DOCS.length;
  const selectAllAttach = () => setAttachIds(allSelected ? new Set() : new Set(DOCS.map((d) => d.id)));
  // v25: user-uploaded attachments (via /api/upload → OnDemand media/v1).
  // Each entry: { id, short, fileName, url, uploaded:true } — same shape the
  // send payload consumes, so uploads merge seamlessly with the DOCS chips.
  const [uploadedDocs, setUploadedDocs] = useState([]);
  const [uploadState, setUploadState] = useState(null); // null | 'uploading' | {error}
  const fileInputRef = useRef(null);
  const onPickFile = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    if (file.size > 18 * 1024 * 1024) { setUploadState({ error: 'file too large (18MB max)' }); return; }
    setUploadState('uploading');
    try {
      const up = await uploadAttachment(file);
      const entry = { id: `up-${Date.now()}`, short: file.name.length > 22 ? file.name.slice(0, 20) + '…' : file.name, fileName: file.name, label: `Uploaded — ${file.name}`, url: up.url, mediaId: up.id, uploaded: true };
      setUploadedDocs((prev) => [...prev, entry]);
      setAttachIds((prev) => new Set(prev).add(entry.id));
      setUploadState(null);
      toast.success(`Uploaded ${file.name}`, { description: 'Attached via OnDemand media store' });
    } catch (e) {
      setUploadState({ error: String(e?.message || e) });
      toast.error('Upload failed', { description: String(e?.message || e).slice(0, 120) });
    }
  };
  const removeUploaded = (id) => {
    setUploadedDocs((prev) => prev.filter((d) => d.id !== id));
    setAttachIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
  };
  const selectedDocs = useMemo(
    () => [...DOCS, ...uploadedDocs].filter((d) => attachIds.has(d.id)),
    [attachIds, uploadedDocs]
  );

  const generate = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase('generating'); setErr(''); setOptStreams(['', '', '', '']); setApprovedMsg('');
    try {
      // v17: 4 options drafted IN PARALLEL, each streaming into its own card
      const arr = await generateRepliesParallel(
        thread,
        (i, sofar) =>
          setOptStreams((prev) => {
            const next = prev ? [...prev] : ['', '', '', ''];
            next[i] = sofar;
            return next;
          }),
        selectedDocs // every selected document is referenced in the drafting prompt
      );
      setReplies(arr); setSelIdx(0); setPhase('ready');
      // v29: degraded-mode notice — fallback drafts still render, with a banner
      if (arr.__degraded) setErr(`Live AI unavailable (${String(arr.__degraded).slice(0, 80)}) — showing standby drafts; retry for live generation.`);
    } catch (e) {
      setErr(`Generation failed (${String(e.message || e)}). Try again.`);
      setPhase(replies ? 'ready' : 'error');
    } finally {
      setOptStreams(null); busyRef.current = false;
    }
  };

  // chips use the closed tone set; the input accepts FREE-FORM micro-prompts.
  // Both revise IN-CARD: skeleton while Gemini works, then chunked word reveal.
  const applyRevision = async (instruction, freeform) => {
    const c = String(instruction || '').trim();
    if (!c || busyRef.current || !replies) return;
    busyRef.current = true;
    setCmdErr(''); setErr(''); setPhase('refining');
    try {
      const revised = freeform
        ? await reviseReplyFreeform(thread, replies[selIdx], c)
        : await refineReply(thread, replies[selIdx], c.toLowerCase());
      setCmd('');
      runWordStream(revised, (finalText) => {
        setReplies((rs) => rs.map((r, i) => (i === selIdx ? finalText : r)));
        setPhase('ready');
        busyRef.current = false;
      });
    } catch (e) {
      toast.error('Revision failed', { description: String(e.message || e).slice(0, 120) });
      setErr(`Revision failed (${String(e.message || e)}).`);
      setPhase('ready');
      busyRef.current = false;
    }
  };
  const applyCmd = (chip) => applyRevision(chip, false);
  const applyMicroPrompt = () => {
    const c = cmd.trim();
    if (!c) return;
    // known tone chip typed verbatim \u2192 closed-set path; anything else \u2192 free-form Gemini
    applyRevision(c, !MICRO_COMMANDS.includes(c.toLowerCase()));
  };

  // v18: Approve finalizes immediately with whatever attachments are selected.
  // Send via Fable becomes ENABLED the moment approval completes (no zoho gate,
  // no intermediate prompt state that previously left the button disabled).
  const approve = async () => {
    // v25 (B-05): the '[Attachments: …]' footer is clipboard-cosmetic ONLY —
    // the DISPATCHED body stays clean (the send prompt lists attachments
    // separately, so the old behaviour duplicated them in the email).
    const body = replies[selIdx];
    const clip = selectedDocs.length
      ? `${body}\n\n[Attachments: ${selectedDocs.map((d) => d.fileName || d.short).join('; ')}]`
      : body;
    try { await navigator.clipboard.writeText(clip); } catch {}
    setApproving(false);
    setApprovedBody(body);
    setSendState(null);
    setApprovedMsg(
      selectedDocs.length
        ? `Approved — reply + ${selectedDocs.length} attachment${selectedDocs.length > 1 ? 's' : ''} (${selectedDocs.map((d) => d.short).join(', ')}) copied to clipboard.`
        : 'Approved — reply copied to clipboard.'
    );
  };

  if (resolvedInfo) {
    const dis = loadDismissals()[thread.id];
    const opt = dis ? DISMISS_OPTIONS.find((o) => o.id === dis.option) : null;
    return (
      <div className="wb-thread wb-done">
        <div className="wb-head">
          <div>
            <Badge tone={thread.tier <= 2 ? 'brand' : 'outline'} icon={thread.tier === 1 ? 'shield' : 'layers'} title={`Position ${seq} \u00b7 priority tier ${thread.tier}`}>T{seq}</Badge>
            <span className="wb-subj muted">{thread.subject}</span>
          </div>
          <div className="wb-resolved-note">
            <Badge tone="low" icon={opt ? opt.icon : 'check-circle'} title={dis ? `Handled by ${dis.by} \u00b7 ${dis.ts}` : 'Handled'}>
              Handled via {opt ? opt.label : (resolvedInfo.by || 'workbench')}
            </Badge>
            <button
              className="wb-undo"
              title="Undo — restore this thread"
              onClick={() => {
                const ev = undoDismissal(thread);
                onUnresolve();
                toast.success(`Restored "${thread.subject.slice(0, 40)}"`, { description: ev ? `undo logged ${ev.ts}` : 'restored' });
              }}
            >Undo</button>
          </div>
        </div>
      </div>
    );
  }

  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className="wb-thread"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      <div className="wb-head">
        <div style={{ minWidth: 0 }}>
          <Badge tone={thread.tier <= 2 ? 'brand' : 'outline'} icon={thread.tier === 1 ? 'shield' : 'layers'} title={`Position ${seq} \u00b7 priority tier ${thread.tier}`}>T{seq}</Badge>
          <span className="wb-subj">{thread.subject}</span>
          <div className="wb-meta">
            {thread.sender} · {thread.org} · <Badge tone={toneForScore(thread.urgency)} icon="flame" title={`Urgency ${thread.urgency}/10`}>{thread.urgency}/10</Badge> · {thread.sentiment}
          </div>
        </div>
        <div className="wb-headctl">
          {!dismissOpen ? (
            <button className="wb-dismiss" title="Dismiss as handled" aria-label="Dismiss as handled" onClick={() => setDismissOpen(true)}>
              <Icon name="check" size={14} strokeWidth={2} /> Dismiss as handled
            </button>
          ) : (
            <span className="wb-dismiss-sel" role="menu" aria-label="How was this handled?">
              <span className="wb-dismiss-lbl">Handled how?</span>
              {DISMISS_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  className="wb-dismiss-opt"
                  role="menuitem"
                  onClick={() => {
                    const entry = recordDismissal(thread, o.id);
                    setDismissOpen(false);
                    toast.success(`Handled via ${o.label}`, { description: `${entry.by} \u00b7 ${entry.ts}` });
                    onResolve('MA');
                  }}
                >
                  <Badge tone="low" icon={o.icon}>{o.label}</Badge>
                </button>
              ))}
              <button className="wb-init-cancel" onClick={() => setDismissOpen(false)} title="Cancel" aria-label="Cancel"><Icon name="undo" size={13} /></button>
            </span>
          )}
        </div>
      </div>

      {phase === 'idle' && (
        <button className="wb-gen" onClick={generate}><Icon name="sparkles" size={15} /> Suggest replies (live AI)</button>
      )}
      {phase === 'error' && (
        <div className="wb-err">{err} <button className="wb-gen sm" onClick={generate}>Retry</button></div>
      )}
      {phase === 'generating' && (
        <div className="wb-streaming">
          <div className="wb-streamlabel"><span className="wb-spinner" /> Drafting 4 options via OnDemand…</div>
          <div className="wb-replies">
            {(optStreams || ['', '', '', '']).map((txt, i) => (
              <div key={i} className="wb-reply">
                <div className="wb-reply-tag">Option {i + 1}</div>
                {txt ? (
                  <div className="wb-reply-text streaming">{txt}<span className="wb-caret" /></div>
                ) : (
                  <div className="wb-card-skel" aria-label="Drafting">
                    <div className="skel skel-line" />
                    <div className="skel skel-line" />
                    <div className="skel skel-line short" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {replies && phase !== 'generating' && (
        <>
          <div className="wb-replies">
            {replies.map((r, i) => (
              <ReplyCard
                key={i}
                idx={i}
                text={r}
                selected={i === selIdx}
                onSelect={setSelIdx}
                revising={phase === 'refining' && i === selIdx && revealText == null}
                revealText={i === selIdx ? revealText : null}
              />
            ))}
          </div>

          {/* micro-command box — closed command set only */}
          <div className="wb-cmdrow">
            <div className="wb-chips">
              {MICRO_COMMANDS.map((c) => (
                <button key={c} className="wb-chip" disabled={phase === 'refining'} onClick={() => applyCmd(c)}>{c}</button>
              ))}
            </div>
            <form
              className="wb-cmdform"
              onSubmit={(e) => { e.preventDefault(); applyMicroPrompt(); }}
            >
              <input
                className="wb-cmdinput"
                value={cmd}
                disabled={phase === 'refining'}
                onChange={(e) => { setCmd(e.target.value); setCmdErr(''); }}
                placeholder="micro-command or custom instruction…"
                aria-label="Micro tone command (warmer, firmer, shorter, formal, add deadline, soften)"
              />
            </form>
            {err && phase === 'ready' && <span className="wb-inline-err">{err}</span>}
          </div>
          {cmdErr && <div className="wb-cmderr">{cmdErr}</div>}

          {/* v18: document attachments — multi-select chips + Select all */}
          <div className="wb-attach-row" role="group" aria-label="Attach documents">
            <span className="wb-attach-lbl"><Icon name="paperclip" size={13} /> Attach:</span>
            {DOCS.map((d) => (
              <button
                key={d.id}
                className={`wb-attach-chip ${attachIds.has(d.id) ? 'on' : ''}`}
                role="checkbox"
                aria-checked={attachIds.has(d.id)}
                title={`${d.label}${attachIds.has(d.id) ? ' (selected)' : ''}`}
                onClick={() => toggleAttach(d.id)}
              >
                {attachIds.has(d.id) && <Icon name="check" size={11} strokeWidth={2.5} />} {d.short}
              </button>
            ))}
            <button className={`wb-attach-chip all ${allSelected ? 'on' : ''}`} onClick={selectAllAttach} title={allSelected ? 'Clear all attachments' : 'Attach all 6 documents'}>
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
            {/* v25: user uploads — chips for files pushed through /api/upload */}
            {uploadedDocs.map((d) => (
              <button
                key={d.id}
                className={`wb-attach-chip up ${attachIds.has(d.id) ? 'on' : ''}`}
                role="checkbox"
                aria-checked={attachIds.has(d.id)}
                title={`${d.label}${attachIds.has(d.id) ? ' (selected)' : ''} — double-click to remove`}
                onClick={() => toggleAttach(d.id)}
                onDoubleClick={() => removeUploaded(d.id)}
              >
                {attachIds.has(d.id) && <Icon name="check" size={11} strokeWidth={2.5} />} {d.short}
              </button>
            ))}
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onPickFile} data-testid="upload-input" />
            <button
              className="wb-attach-chip upload"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadState === 'uploading'}
              title="Upload a new file as an attachment (stored via OnDemand media)"
              data-testid="upload-btn"
            >
              {uploadState === 'uploading' ? <span className="wb-spinner sm" /> : <Icon name="paperclip" size={11} />} {uploadState === 'uploading' ? 'Uploading…' : 'Upload file'}
            </button>
            {uploadState?.error && <span className="wb-inline-err">{uploadState.error}</span>}
            {attachIds.size > 0 && <span className="wb-attach-count">{attachIds.size} selected</span>}
          </div>

          {/* approve + send flow */}
          <div className="wb-actions">
            {!approving && (
              <>
                <button className="wb-approve" disabled={phase === 'refining'} onClick={approve}>Approve reply</button>
                <button className="wb-gen sm" disabled={phase === 'refining'} onClick={generate}><Icon name="refresh" size={13} /> Regenerate all</button>
                {approvedMsg && <span className="wb-approved-msg"><Icon name="check" size={13} strokeWidth={2.25} /> {approvedMsg}</span>}
              </>
            )}
            {approvedBody && !approving && (
              <span className="wb-sendwrap">
                {/* v24 APPROVAL GATE: two-step confirm. First click ARMS the
                    confirmation ('confirm' state, nothing sent); only the
                    explicit 'Confirm send' click dispatches. Generation can
                    never reach this path — sendReply carries the
                    x-send-approved attestation required by the server. */}
                {!sendState && (
                  <button
                    className="wb-send"
                    data-testid="send-arm"
                    title="Step 1 of 2 — arms a confirmation; nothing is sent yet"
                    onClick={() => setSendState('confirm')}
                  >
                    <Icon name="send" size={13} /> Send reply
                  </button>
                )}
                {sendState === 'confirm' && (
                  <span className="wb-confirmwrap">
                    <span className="wb-confirm-note">Send this reply to {thread.email}?</span>
                    <button className="wb-gen sm" data-testid="send-cancel" onClick={() => setSendState(null)}>Cancel</button>
                  <button
                    className="wb-send"
                    data-testid="send-confirm"
                    title={thread.zoho ? 'Step 2 of 2 — dispatch as a real threaded Zoho reply (via Claude Sonnet 5)' : 'Step 2 of 2 — dispatch as a fresh Zoho email to the counterparty (via Claude Sonnet 5)'}
                    onClick={async () => {
                      setSendState('sending');
                      const startedAt = new Date().toISOString();
                      let res;
                      try {
                        res = await sendReply(thread, approvedBody, selectedDocs);
                      } catch (e) {
                        res = { ok: false, status: 'failed', agentReport: String(e.message || e), ts: new Date().toISOString() };
                      }
                      setSendState(res);
                      const entry = {
                        ts: res.ts || new Date().toISOString(),
                        startedAt,
                        status: res.status === 'blocked-approval-required' ? 'blocked (dry-run)' : (res.ok ? 'sent' : 'failed'),
                        sentMessageId: res.sentMessageId || null,
                        targetMessageId: thread.zoho?.messageId || null,
                        endpoint: res.ok ? (res.endpointUsed || null) : null,
                        attachments: selectedDocs.map((d) => d.short),
                        detail: String(res.agentReport || res.error || '').slice(0, 200),
                      };
                      // v25 (B-07): persist OUTSIDE the state updater (StrictMode double-invoke wrote duplicates)
                      appendSendLog(thread.id, entry);
                      setSendLog((prev) => [entry, ...prev].slice(0, 10));
                      if (res.ok) {
                        toast.success(`Reply sent into "${thread.subject.slice(0, 44)}"`, {
                          description: `${res.sentMessageId ? 'msg ' + res.sentMessageId + ' · ' : ''}${entry.ts}`,
                        });
                      } else {
                        toast.error('Send failed — no reply was posted', {
                          description: String(res.agentReport || '').slice(0, 120),
                        });
                      }
                    }}
                  >
                    <Icon name="send" size={13} /> Confirm send
                  </button>
                  </span>
                )}
                {sendState === 'sending' && (
                  <span className="wb-sending"><span className="wb-spinner" /> Dispatching via claude-sonnet-5…</span>
                )}
                {sendState && sendState !== 'sending' && sendState !== 'confirm' && sendState.ok && (
                  <span className="wb-sent">
                    <Icon name="check" size={13} strokeWidth={2.25} /> Sent {sendState.sentMessageId ? `· msg ${sendState.sentMessageId}` : ''} · {sendState.ts} · thread: {thread.subject.slice(0, 40)}{thread.zoho?.messageId ? ` (${thread.zoho.messageId})` : ''}
                  </span>
                )}
                {sendState && sendState !== 'sending' && sendState !== 'confirm' && !sendState.ok && (
                  <span className="wb-sendfail">
                    <Icon name="alert-triangle" size={13} /> Send failed: {String(sendState.agentReport || '').slice(0, 160)}
                    <button className="wb-gen sm" onClick={() => setSendState(null)}>Retry send</button>
                  </span>
                )}
              </span>
            )}
          </div>

          {/* timestamped send log — proof of every dispatch for this thread */}
          {sendLog.length > 0 && (
            <div className="wb-sendlog">
              <div className="wb-sendlog-h"><Icon name="history" size={12} /> Send log</div>
              {sendLog.map((l, i) => (
                <div key={i} className={`wb-sendlog-row ${l.status}`}>
                  <span className={`wb-sendlog-dot ${l.status}`} aria-hidden="true" />
                  <span className="wb-sendlog-ts">{l.ts}</span>
                  <span className="wb-sendlog-status">{l.status === 'sent' ? 'Sent' : 'Failed'}</span>
                  {l.sentMessageId && <span className="wb-sendlog-mid">msg {l.sentMessageId}</span>}
                  {l.targetMessageId && <span className="wb-sendlog-mid">thread {l.targetMessageId}</span>}
                  {l.status === 'failed' && l.detail && <span className="wb-sendlog-detail">{l.detail.slice(0, 90)}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}

export default function AIWorkbench({ resolved, onResolve, onUnresolve }) {
  const [tierF, setTierF] = useState(0);
  const [showResolved, setShowResolved] = useState(false);

  const active = useMemo(
    () => THREADS.filter((t) => !resolved[t.id] && (tierF === 0 || t.tier === tierF)).sort((a, b) => a.tier - b.tier || b.urgency - a.urgency),
    [resolved, tierF]
  );
  const done = useMemo(() => THREADS.filter((t) => resolved[t.id]), [resolved]);

  return (
    <div className="card">
      <h2>AI Reply Workbench <span className="wb-live-dot" title="Live inference via OnDemand" /></h2>
      <div className="hint">
        Live suggested replies per thread (OnDemand · claude-sonnet-5 via server-side proxy) · micro-commands: warmer / firmer / shorter / formal / add deadline / soften · approve triggers document auto-attach · dismiss stamps MK / SK / MA ownership.
      </div>
      <div className="controls">
        {[0, 1, 2, 3, 4, 5].map((t) => (
          <button key={t} className={`fbtn ${tierF === t ? 'on' : ''}`} onClick={() => setTierF(t)}>
            {t === 0 ? 'All tiers' : `Tier ${t}`}
          </button>
        ))}
      </div>

      <div className="wb-list">
        {active.map((t, seqIdx) => (
          <ThreadWorkbench
            key={t.id}
            thread={t}
            seq={seqIdx + 1}
            resolvedInfo={null}
            onResolve={(initials) => onResolve(t.id, initials)}
            onUnresolve={() => onUnresolve(t.id)}
          />
        ))}
        {!active.length && <div className="wb-empty">Nothing open in this tier — check the Resolved strip below.</div>}
      </div>

      {/* collapsible Resolved strip */}
      <div className="resolved-strip">
        <button className="resolved-toggle" onClick={() => setShowResolved(!showResolved)}>
          <Icon name={showResolved ? 'chevron-down' : 'chevron-right'} size={14} /> Resolved ({done.length})
        </button>
        {showResolved && (
          <div className="resolved-items">
            {done.length === 0 && <span className="wb-empty">Nothing resolved yet.</span>}
            {done.map((t) => (
              <div key={t.id} className="resolved-item">
                <span className="handled-badge"><Icon name="check" size={12} strokeWidth={2.25} /> dismissed by {resolved[t.id].by}</span>
                <span className="resolved-subj">{t.subject}</span>
                <span className="resolved-org">{t.org}</span>
                <button className="wb-undo" onClick={() => onUnresolve(t.id)}>reopen</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
