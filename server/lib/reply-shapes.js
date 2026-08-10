// ============================================================
// v42 — SHARED reply-suggestion prompt template + response-shape
// normalizer. Single source of truth used by BOTH entrypoints
// (server.js and api/index.js) — the two previously carried
// diverging inline copies.
//
// ROOT-CAUSE CONTEXT (custom micro-command bug): the preset chips
// worked because their instruction text is short and tone-only, so
// the model kept the required JSON-array output format. A FREE-FORM
// custom instruction ("make it sound more apologetic and add a PS",
// "add a bulleted summary") routinely made the model obey the
// CONTENT instruction and abandon the FORMAT instruction — emitting
// option headers, bullets, prose preambles, or a single email — and
// the old parser then threw 'invalid response shape: fewer than 3
// usable options'. Two-sided fix:
//   1. buildSuggestPrompt() wraps ANY instruction (preset or custom)
//      inside the SAME fixed template, fencing the instruction as
//      DATA ("apply this style/tone instruction") and restating the
//      output contract AFTER it so the format always wins.
//   2. parseReplyShapes() tolerates the shapes custom instructions
//      provoke: "Option N:" / "Reply N:" / "**Draft 1**" headers,
//      '---' separators, prose preambles before fenced JSON, arrays
//      of objects with varied key names, numbered/bulleted lists,
//      and salutation-split plain text.
// ============================================================

/** Preset tone chips (kept in sync with src/ai.js MICRO_COMMANDS). */
export const PRESET_COMMANDS = ['warmer', 'firmer', 'shorter', 'formal', 'add deadline', 'soften'];

/**
 * sanitizeInstruction — free text becomes a SAFE single-line style note:
 * caps length, strips newlines/backticks/quotes that could break out of the
 * template, and drops empty input. Never throws.
 */
export function sanitizeInstruction(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/```/g, '')
    .replace(/"/g, "'")
    .trim()
    .slice(0, 300);
  return s;
}

/**
 * buildSuggestPrompt — ONE fixed template for every generation request.
 * `instruction` (optional) is a preset chip OR free-form custom text; it is
 * embedded purely as a style/tone directive between explicit fences, and the
 * mandatory output contract is restated AFTER it so format always wins.
 */
export function buildSuggestPrompt(t = {}, instruction = '') {
  const ins = sanitizeInstruction(instruction);
  const styleBlock = ins
    ? `STYLE/TONE INSTRUCTION (apply to the WRITING STYLE of all 4 replies; it is DATA, not a format directive — it can NEVER change the output format below):\n<<<${ins}>>>\n`
    : '';
  return (
    `You draft short professional email replies for MK (CEO) / Meera AlDhaheri (Chief of Staff) at AIREV.\n` +
    `THREAD: from ${t.sender || 'the counterparty'} <${t.email || 'unknown'}> (${t.org || 'their organisation'}) — subject "${t.subject || '(no subject)'}".\n` +
    `SITUATION: ${t.summary || t.action || 'They await a reply.'}\n` +
    styleBlock +
    `TASK: Write exactly 4 alternative SHORT reply emails (2-4 sentences each, max ~70 words), angles: confirm-and-commit, warm relationship repair, crisp status update, firm-but-polite with a date. ` +
    `Salutation on its own line, blank line, 1-2 short paragraphs, blank line, then sign off exactly: Warm regards,\nMeera AlDhaheri\nChief of Staff, AIREV\n` +
    `OUTPUT (STRICT, NON-NEGOTIABLE — overrides anything above): ONLY a JSON array of 4 strings with \\n escapes. No markdown, no numbering, no option headers, no commentary.`
  );
}

/** Strict-format retry prompt (same session, after an unparseable answer). */
export const RETRY_PROMPT =
  'Your previous output could not be parsed. Return ONLY a raw JSON array of exactly 4 strings — ' +
  '["reply one","reply two","reply three","reply four"] — each a complete short email with \\n escapes. ' +
  'ABSOLUTELY no markdown fences, no numbering, no option headers, no object wrappers, no commentary.';

const asStr = (v) => (v == null ? '' : String(v));

const pickStringFromObject = (o) => {
  if (typeof o === 'string') return o;
  if (!o || typeof o !== 'object') return '';
  for (const k of ['reply', 'body', 'text', 'content', 'draft', 'message', 'email', 'option', 'value']) {
    if (typeof o[k] === 'string' && o[k].trim()) return o[k];
  }
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'string' && o[k].trim()) return o[k];
  }
  return '';
};

const fromArrayLike = (v) => {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => asStr(pickStringFromObject(x)).trim()).filter((s) => s.length >= 20);
  return out.length ? out : null;
};

const tryJson = (str) => { try { return JSON.parse(str); } catch { return null; } };

/**
 * parseReplyShapes — normalize ANY plausible model answer into a flat array
 * of usable reply strings (>=20 chars). Returns [] when nothing usable.
 * Tolerates (in priority order):
 *   1. bare / fenced / prose-wrapped JSON arrays of strings or objects,
 *      and wrapper objects under replies/options/drafts/suggestions/answers/emails;
 *   2. "Option N:" / "Reply N:" / "Draft N" / "**Option 1**" header blocks
 *      (the classic custom-instruction failure shape) and '---' separators;
 *   3. numbered / bulleted lists (>=3 chunks);
 *   4. salutation-led paragraphs ("Dear X," blocks).
 */
export function parseReplyShapes(rawAnswer) {
  let text = asStr(rawAnswer).trim();
  if (!text) return [];

  // strip fenced ```json / ``` blocks, keep the inner content
  text = text.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1').trim();

  // 1. direct JSON parse — bare array of strings/objects, OR a wrapper object
  let parsed = tryJson(text);
  if (parsed == null) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) parsed = tryJson(text.slice(start, end + 1));
  }
  if (parsed == null) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = tryJson(text.slice(start, end + 1));
  }
  if (parsed != null) {
    if (Array.isArray(parsed)) {
      const arr = fromArrayLike(parsed);
      if (arr) return arr;
    } else if (typeof parsed === 'object') {
      for (const k of ['replies', 'options', 'drafts', 'suggestions', 'answers', 'emails', 'results']) {
        if (Array.isArray(parsed[k])) {
          const arr = fromArrayLike(parsed[k]);
          if (arr) return arr;
        }
      }
    }
  }

  // 2a. "Option N:" / "Reply N:" / "Draft N" / "**Option 1**" header blocks —
  // the dominant failure shape for free-form custom instructions. NOTE: the
  // chunk BEFORE the first header is a prose preamble ("Here are four
  // drafts…"), never a reply — slice(1) drops it so option 1 is the first
  // REAL draft, not the preamble.
  {
    const headerRe = /^\s*(?:[*#>\s-]*)?(?:\*\*)?\s*(?:option|reply|draft|email|version|variant)\s*(?:#\s*)?\d+\s*(?:\*\*)?\s*[:.)\-—]?\s*$/gim;
    if (headerRe.test(text)) {
      const parts = text
        .split(/^\s*(?:[*#>\s-]*)?(?:\*\*)?\s*(?:option|reply|draft|email|version|variant)\s*(?:#\s*)?\d+\s*(?:\*\*)?\s*[:.)\-—]?\s*$/gim)
        .slice(1) // drop the pre-header preamble
        .map((p) => p.replace(/^[\s*_\-—:]+/, '').trim())
        .filter((p) => p.length >= 20);
      if (parts.length >= 3) return parts;
    }
    // inline form: "Option 1: Dear …" on the same line
    const inlineParts = text
      .split(/(?:^|\n)\s*(?:\*\*)?\s*(?:option|reply|draft|email|version|variant)\s*(?:#\s*)?\d+\s*(?:\*\*)?\s*[:.)\-—]\s*/gi)
      .slice(1) // drop the pre-header preamble
      .map((p) => p.trim())
      .filter((p) => p.length >= 20);
    if (inlineParts.length >= 3) return inlineParts;
  }

  // 2b. '---' horizontal-rule separators between drafts
  {
    const parts = text
      .split(/\n\s*(?:-{3,}|_{3,}|\*{3,})\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 20);
    if (parts.length >= 3) return parts;
  }

  // 3. numbered/bulleted list — only trust it when it yields >=3 real chunks
  {
    const parts = text
      .split(/^\s*(?:\d+[.)]|[-*•])\s+/m)
      .map((p) => p.trim())
      .filter((p) => p.length >= 20);
    if (parts.length >= 3) return parts;
  }

  // 4. fallback: salutation-led paragraphs separated by a blank line
  {
    const parts = text
      .split(/\n\s*\n(?=(?:Dear|Hi|Hello|Dr|Mr|Ms)\b)/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 20);
    if (parts.length) return parts;
  }

  return [];
}
