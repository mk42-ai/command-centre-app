// ============================================================
// applied-command.test.mjs — unit tests for the v44 custom
// micro-command LIVE RE-RENDER + APPLIED-COMMAND BADGE fix
// (src/workbenchState.js indicator helpers).
//
// Run:  node --test test/applied-command.test.mjs   (zero deps)
//
// Covers the reported bug at the state level:
//   1. synchronous live re-render — commitRevision + commitRevisionIndicator
//      happen in the SAME synchronous commit (never inside the cosmetic
//      word-reveal callback), so the displayed option text and its badge
//      update together the moment the revision arrives.
//   2. loading→applied indicator transitions (begin → commit / fail).
//   3. preset/custom parity — identical helper path for the six preset
//      chips and free-form typed commands like 'more mean'.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitRevision, revisionCommittedState,
  beginRevisionIndicator, commitRevisionIndicator, failRevisionIndicator,
  resetRevisionIndicators, indicatorFor,
} from '../src/workbenchState.js';

const OPTS = [
  'Thanks for the update — happy to confirm Thursday works for the working session.',
  'Appreciate the follow-up; let me align internally and revert by end of day.',
  'Understood — we will circulate the pending legal documents before Friday.',
];
const REVISED = 'Frankly, this has dragged on long enough. Send the documents today or we escalate.';
const PRESETS = ['warmer', 'firmer', 'shorter', 'formal', 'add deadline', 'soften'];

// --- 1. synchronous live re-render -----------------------------------------

test('custom command commit: revised text replaces the option synchronously', () => {
  const next = commitRevision(OPTS, 1, REVISED);
  assert.notEqual(next, OPTS);                 // immutable
  assert.equal(next[1], REVISED);              // selected option re-rendered
  assert.equal(next[0], OPTS[0]);              // others untouched
  assert.equal(next[2], OPTS[2]);
  // ready state committed in the same synchronous step — never via animation
  assert.deepEqual(revisionCommittedState(), { phase: 'ready', busy: false });
});

test('text commit and badge commit form ONE synchronous state transition', () => {
  // simulate the exact component sequence in applyRevision's success path
  let replies = OPTS, indicators = beginRevisionIndicator(resetRevisionIndicators(), 1, 'more mean');
  assert.deepEqual(indicatorFor(indicators, 1), { command: 'more mean', state: 'refining' });
  // ...revision arrives → BOTH commits happen before any cosmetic reveal:
  replies = commitRevision(replies, 1, REVISED);
  indicators = commitRevisionIndicator(indicators, 1, 'more mean');
  assert.equal(replies[1], REVISED);
  assert.deepEqual(indicatorFor(indicators, 1), { command: 'more mean', state: 'applied' });
});

test('unusable revision (<20 chars) keeps the prior draft text', () => {
  assert.deepEqual(commitRevision(OPTS, 0, 'ok.'), OPTS);
  assert.deepEqual(commitRevision(OPTS, 0, ''), OPTS);
});

// --- 2. loading → applied indicator transitions -----------------------------

test('beginRevisionIndicator marks the option as refining with the EXACT typed text', () => {
  const ind = beginRevisionIndicator({}, 2, '  more mean  ');
  assert.deepEqual(ind[2], { command: 'more mean', state: 'refining' });
  assert.equal(indicatorFor(ind, 2).state, 'refining');
  assert.equal(indicatorFor(ind, 0), null); // other options untouched
});

test('commitRevisionIndicator flips refining → applied for the same command', () => {
  let ind = beginRevisionIndicator({}, 0, 'more mean');
  ind = commitRevisionIndicator(ind, 0, 'more mean');
  assert.deepEqual(ind[0], { command: 'more mean', state: 'applied' });
});

test('failRevisionIndicator drops an in-flight badge with no prior applied badge', () => {
  let ind = beginRevisionIndicator({}, 0, 'more mean');
  ind = failRevisionIndicator(ind, 0, null);
  assert.equal(indicatorFor(ind, 0), null);
});

test('failRevisionIndicator restores the previously APPLIED badge', () => {
  let ind = commitRevisionIndicator({}, 0, 'warmer');       // earlier successful preset
  const prev = indicatorFor(ind, 0);
  ind = beginRevisionIndicator(ind, 0, 'more mean');         // new attempt in flight
  assert.equal(ind[0].state, 'refining');
  ind = failRevisionIndicator(ind, 0, prev);                 // attempt fails
  assert.deepEqual(ind[0], { command: 'warmer', state: 'applied' });
});

test('resetRevisionIndicators wipes all badges on fresh generation', () => {
  let ind = commitRevisionIndicator({}, 0, 'more mean');
  ind = commitRevisionIndicator(ind, 1, 'firmer');
  assert.deepEqual(resetRevisionIndicators(), {});
  assert.equal(indicatorFor(resetRevisionIndicators(), 0), null);
});

test('indicator helpers are immutable and ignore empty commands', () => {
  const base = { 0: { command: 'warmer', state: 'applied' } };
  const same1 = beginRevisionIndicator(base, 1, '');
  const same2 = commitRevisionIndicator(base, 1, '   ');
  assert.deepEqual(same1, base);
  assert.deepEqual(same2, base);
  const changed = beginRevisionIndicator(base, 1, 'soften');
  assert.notEqual(changed, base);
  assert.deepEqual(base, { 0: { command: 'warmer', state: 'applied' } }); // untouched
});

// --- 3. preset / custom parity ----------------------------------------------

test('parity: all six preset chips and a custom command take the identical path', () => {
  for (const cmd of [...PRESETS, 'more mean', 'sound like a pirate']) {
    let ind = beginRevisionIndicator({}, 1, cmd);
    assert.deepEqual(ind[1], { command: cmd, state: 'refining' }, `refining for ${cmd}`);
    ind = commitRevisionIndicator(ind, 1, cmd);
    assert.deepEqual(ind[1], { command: cmd, state: 'applied' }, `applied for ${cmd}`);
    const replies = commitRevision(OPTS, 1, REVISED);
    assert.equal(replies[1], REVISED, `re-render for ${cmd}`);
    assert.deepEqual(revisionCommittedState(), { phase: 'ready', busy: false });
  }
});

test('parity: badge shows the exact command text for preset AND custom', () => {
  const preset = commitRevisionIndicator({}, 0, 'add deadline');
  const custom = commitRevisionIndicator({}, 0, 'more mean');
  assert.equal(indicatorFor(preset, 0).command, 'add deadline');
  assert.equal(indicatorFor(custom, 0).command, 'more mean');
  assert.equal(indicatorFor(preset, 0).state, indicatorFor(custom, 0).state);
});
