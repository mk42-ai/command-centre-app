// ============================================================
// v43 — PURE Workbench state helpers (zero React, zero DOM).
//
// WHY THIS FILE EXISTS (custom micro-command selectability bug):
// after a custom micro-command refined a draft, the revised text,
// phase:'ready' and the busy flag were committed ONLY inside the
// cosmetic word-reveal interval's completion callback. If that
// interval died (background-tab timer throttling, re-render
// clearing the timer), the card stayed in phase 'refining' forever:
// the option was DISPLAYED but Approve/attach/micro-command
// controls remained disabled — "cannot be selected or sent".
// The authoritative state transition now lives here as pure
// functions, committed SYNCHRONOUSLY by the component the moment
// the revision arrives; the word reveal is cosmetic only. Being
// pure, node:test exercises the exact production logic.
// ============================================================

/** Commit a revised draft into the options list (immutable). */
export function commitRevision(replies, selIdx, revisedText) {
  const text = String(revisedText || '').trim();
  if (!Array.isArray(replies) || !replies.length) return replies;
  if (text.length < 20) return replies; // unusable revision → keep prior draft
  return replies.map((r, i) => (i === selIdx ? text : r));
}

/** Post-revision UI state: ALWAYS selectable/approvable again. */
export function revisionCommittedState() {
  return { phase: 'ready', busy: false };
}

// ------------------------------------------------------------
// v44 — applied-command indicator (pure, per-option-index map).
//
// Shape: { [optionIdx]: { command: '<exact typed text>', state: 'refining'|'applied' } }
// The SAME helpers drive both the six preset chips and free-form
// custom commands, guaranteeing preset/custom parity by construction.
// 'refining' is set the moment a revision is dispatched; 'applied'
// is committed SYNCHRONOUSLY together with commitRevision (never
// inside the cosmetic word-reveal callback). On failure the entry
// reverts to whatever was previously applied (or disappears).
// ------------------------------------------------------------

/** Mark option `idx` as being revised by `command` (immutable). */
export function beginRevisionIndicator(indicators, idx, command) {
  const cmd = String(command || '').trim();
  if (!cmd) return indicators || {};
  return { ...(indicators || {}), [idx]: { command: cmd, state: 'refining' } };
}

/** Commit option `idx` as revised-by-`command` (immutable). Call
 *  synchronously alongside commitRevision — the badge flips to its
 *  confirmed 'applied' state in the SAME render as the new text. */
export function commitRevisionIndicator(indicators, idx, command) {
  const cmd = String(command || '').trim();
  if (!cmd) return indicators || {};
  return { ...(indicators || {}), [idx]: { command: cmd, state: 'applied' } };
}

/** Revision failed / was abandoned: restore the previously-applied badge
 *  for `idx` (if any) or drop the in-flight entry entirely (immutable). */
export function failRevisionIndicator(indicators, idx, previousApplied = null) {
  const next = { ...(indicators || {}) };
  if (previousApplied && previousApplied.state === 'applied') next[idx] = previousApplied;
  else delete next[idx];
  return next;
}

/** Fresh generation wipes every applied-command badge. */
export function resetRevisionIndicators() {
  return {};
}

/** Badge lookup for a card: {command,state} or null. */
export function indicatorFor(indicators, idx) {
  const e = (indicators || {})[idx];
  if (!e || !e.command) return null;
  return e.state === 'refining' || e.state === 'applied' ? e : null;
}

/** An option is selectable whenever options exist and none is mid-refine. */
export function isOptionSelectable(phase, replies, idx) {
  return Boolean(Array.isArray(replies) && replies[idx] && String(replies[idx]).trim().length >= 20 && phase !== 'generating');
}

/** Approve/Send is enabled for the selected option outside the refining phase. */
export function isApproveEnabled(phase, replies, selIdx) {
  return Boolean(phase === 'ready' && Array.isArray(replies) && String(replies[selIdx] || '').trim().length >= 20);
}

/** Map a /api/suggest-replies response (shared reply-shapes parser output)
 *  into the selectable option list. Returns [] when unusable. */
export function optionsFromServerResponse(json) {
  if (!json || json.ok !== true || !Array.isArray(json.replies)) return [];
  return json.replies.map((s) => String(s == null ? '' : s).trim()).filter((s) => s.length >= 20);
}

/** Toggle one attachment id (immutable Set). */
export function toggleAttachId(prevSet, id) {
  const next = new Set(prevSet);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Select-all / clear-all over the doc catalogue (immutable Set). */
export function selectAllIds(docs, allSelected) {
  return allSelected ? new Set() : new Set((docs || []).map((d) => d.id));
}

/** Resolve selected docs (catalogue + uploads) from the id Set. */
export function resolveSelectedDocs(docs, uploadedDocs, attachIds) {
  return [...(docs || []), ...(uploadedDocs || [])].filter((d) => attachIds.has(d.id));
}

/** RFC-ish recipient guard (mirrors the server's v27 validation). */
export function validRecipient(thread) {
  const e = String(thread?.email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * Build the EXACT /api/send payload the Workbench dispatches after the
 * two-step confirm. Throws on the same conditions the client guard enforces
 * (empty body; no recipient AND no thread messageId).
 */
export function buildSendPayload(thread, approvedBody, selectedDocs = []) {
  const body = String(approvedBody || '').trim();
  if (!body) throw new Error('approved reply body is empty — approve a reply before sending');
  const recipient = validRecipient(thread);
  if (!recipient && !thread?.zoho?.messageId) {
    throw new Error(`no valid recipient for this thread (email: ${JSON.stringify(thread?.email || null)}) — cannot send`);
  }
  return {
    sendApproved: true,
    replyBody: body,
    zohoMessageId: thread?.zoho?.messageId || null,
    zohoFolderId: thread?.zoho?.folderId || null,
    threadSubject: thread?.subject || '(no subject)',
    toAddress: recipient, // validated email or null — never a placeholder
    attachments: (selectedDocs || []).map((d) => ({ id: d.id, name: d.fileName || d.label, url: d.url })),
  };
}
