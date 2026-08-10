// ============================================================
// workbench-state.test.mjs — unit tests for the v43 custom
// micro-command SELECTABILITY fix (src/workbenchState.js) plus the
// server-parser → selectable-options flow (server/lib/reply-shapes.js).
//
// Run:  node --test test/workbench-state.test.mjs   (zero deps)
//
// Covers the reported bug end-to-end at the state level:
//   custom micro-command ('harder') → revision committed → option
//   REMAINS selectable + approvable → attachments toggled (chips,
//   Select all, uploaded file) → send payload correctly formed for
//   the connector send path (/api/send → agent-1784351533).
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitRevision, revisionCommittedState, isOptionSelectable, isApproveEnabled,
  optionsFromServerResponse, toggleAttachId, selectAllIds, resolveSelectedDocs,
  validRecipient, buildSendPayload,
} from '../src/workbenchState.js';
import { parseReplyShapes } from '../server/lib/reply-shapes.js';

const THREAD = {
  id: 'thr-1', sender: 'Willy Liang', email: 'willy@presight.ai', org: 'Presight',
  subject: 'Airev x Presight alignment',
  zoho: { messageId: '1786274208925141800', folderId: 'f-inbox' },
};
const DOCS = [
  { id: 'nda', short: 'NDA', fileName: 'airev_nda_template.docx', label: 'NDA', url: 'https://x/nda.docx' },
  { id: 'byoc', short: 'BYOC Licence', fileName: 'byoc_licence.pdf', label: 'BYOC Licence', url: 'https://x/byoc.pdf' },
  { id: 'pricing', short: 'Pricing', fileName: 'pricing.pdf', label: 'Pricing', url: 'https://x/pricing.pdf' },
];
const OPTS = [
  'Dear Willy,\n\nThanks for the alignment call — confirming next steps this week.\n\nWarm regards,\nMeera AlDhaheri\nChief of Staff, AIREV',
  'Dear Willy,\n\nAppreciate the partnership — status update attached for review.\n\nWarm regards,\nMeera AlDhaheri\nChief of Staff, AIREV',
  'Dear Willy,\n\nCrisp update: legal pack lands Thursday; demo follows Friday.\n\nWarm regards,\nMeera AlDhaheri\nChief of Staff, AIREV',
];
const HARDER =
  'Dear Willy,\n\nWe need the signed pack by Wednesday COB — no further extensions. Confirm today.\n\nWarm regards,\nMeera AlDhaheri\nChief of Staff, AIREV';

// ---------- 1. custom micro-command → revision committed ----------

test("custom 'harder' revision replaces ONLY the selected option", () => {
  const next = commitRevision(OPTS, 1, HARDER);
  assert.equal(next[1], HARDER);
  assert.equal(next[0], OPTS[0]);
  assert.equal(next[2], OPTS[2]);
  assert.notEqual(next, OPTS, 'immutable update');
});

test('unusable (short/empty) revision keeps the prior draft', () => {
  assert.deepEqual(commitRevision(OPTS, 0, 'too short'), OPTS);
  assert.deepEqual(commitRevision(OPTS, 0, ''), OPTS);
});

test('revisionCommittedState always returns ready/not-busy (the stuck-refining fix)', () => {
  assert.deepEqual(revisionCommittedState(), { phase: 'ready', busy: false });
});

// ---------- 2. customised option is SELECTABLE + approvable ----------

test('custom-refined option is selectable and Approve is enabled', () => {
  const revised = commitRevision(OPTS, 1, HARDER);
  const st = revisionCommittedState();
  for (let i = 0; i < revised.length; i++) {
    assert.ok(isOptionSelectable(st.phase, revised, i), `option ${i} selectable`);
  }
  assert.ok(isApproveEnabled(st.phase, revised, 1), 'Approve enabled for the customised option');
});

test('while generating, options are not selectable; after commit they are', () => {
  assert.equal(isOptionSelectable('generating', OPTS, 0), false);
  assert.equal(isApproveEnabled('refining', OPTS, 0), false);
  assert.equal(isOptionSelectable('ready', OPTS, 0), true);
});

// ---------- 3. server-parser output flows into selectable options ----------

test('parseReplyShapes output (custom-instruction messy shape) → selectable list', () => {
  const messy = `Option 1:\n${OPTS[0]}\nOption 2:\n${OPTS[1]}\nOption 3:\n${HARDER}`;
  const parsed = parseReplyShapes(messy);
  assert.ok(parsed.length >= 3);
  const json = { ok: true, replies: parsed, source: 'ondemand-live' };
  const options = optionsFromServerResponse(json);
  assert.ok(options.length >= 3);
  assert.ok(isOptionSelectable('ready', options, options.length - 1), 'last (customised) option selectable');
});

test('optionsFromServerResponse rejects malformed payloads safely', () => {
  assert.deepEqual(optionsFromServerResponse(null), []);
  assert.deepEqual(optionsFromServerResponse({ ok: false, replies: OPTS }), []);
  assert.deepEqual(optionsFromServerResponse({ ok: true, replies: 'nope' }), []);
});

// ---------- 4. attachment chips / Select all / uploads ----------

test('toggleAttachId adds and removes ids immutably', () => {
  let ids = new Set(['nda']);
  ids = toggleAttachId(ids, 'byoc');
  assert.deepEqual([...ids].sort(), ['byoc', 'nda']);
  ids = toggleAttachId(ids, 'nda');
  assert.deepEqual([...ids], ['byoc']);
});

test('selectAllIds selects the whole catalogue then clears', () => {
  const all = selectAllIds(DOCS, false);
  assert.equal(all.size, DOCS.length);
  const none = selectAllIds(DOCS, true);
  assert.equal(none.size, 0);
});

test('resolveSelectedDocs merges catalogue + uploaded docs by id', () => {
  const uploaded = [{ id: 'up-1', short: 'brief.pdf', fileName: 'brief.pdf', label: 'Uploaded — brief.pdf', url: 'https://media/x', uploaded: true }];
  const ids = new Set(['byoc', 'up-1']);
  const sel = resolveSelectedDocs(DOCS, uploaded, ids);
  assert.deepEqual(sel.map((d) => d.id).sort(), ['byoc', 'up-1']);
});

// ---------- 5. send payload formed for the connector send path ----------

test('buildSendPayload: customised body + attachments → exact /api/send shape', () => {
  const revised = commitRevision(OPTS, 1, HARDER);
  const approvedBody = revised[1]; // the customised option, approved
  const sel = resolveSelectedDocs(DOCS, [], new Set(['byoc', 'pricing']));
  const p = buildSendPayload(THREAD, approvedBody, sel);
  assert.equal(p.sendApproved, true);
  assert.equal(p.replyBody, HARDER);
  assert.equal(p.zohoMessageId, THREAD.zoho.messageId);
  assert.equal(p.toAddress, 'willy@presight.ai');
  assert.deepEqual(p.attachments, [
    { id: 'byoc', name: 'byoc_licence.pdf', url: 'https://x/byoc.pdf' },
    { id: 'pricing', name: 'pricing.pdf', url: 'https://x/pricing.pdf' },
  ]);
});

test('buildSendPayload guards: empty body and missing recipient both throw', () => {
  assert.throws(() => buildSendPayload(THREAD, '', []), /approved reply body is empty/);
  assert.throws(
    () => buildSendPayload({ email: 'various', subject: 'x' }, HARDER, []),
    /no valid recipient/,
  );
});

test('threaded send allowed on messageId alone (no valid email)', () => {
  const t = { email: 'various', subject: 'x', zoho: { messageId: '17999' } };
  const p = buildSendPayload(t, HARDER, []);
  assert.equal(p.toAddress, null);
  assert.equal(p.zohoMessageId, '17999');
});

test('validRecipient mirrors server-side v27 validation', () => {
  assert.equal(validRecipient({ email: 'a@b.co' }), 'a@b.co');
  assert.equal(validRecipient({ email: 'various' }), null);
  assert.equal(validRecipient({}), null);
});
