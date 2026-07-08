// ============================================================
// Persistent hybrid cache
//   • KVCache      — namespaced key-value store, TTL + LRU-ish
//                    eviction, JSON-file persistence (atomic
//                    write, debounced flush). Fast enough for
//                    dashboard-ready JSON reads (~µs, in-memory
//                    Map fronting the file).
//   • SemanticCache— embedding-based lookup: exact-match first,
//                    then cosine similarity >= threshold
//                    (default 0.90, configurable 0.85–0.95).
// Namespaces used across the app:
//   emailMeta, threadSummary, priorityPyramid, senderProfile,
//   sentiment, syncState, dashboard, embeddings, briefing,
//   followups, jobs, failedJobs
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';

const now = () => Date.now();

export class KVCache {
  constructor({ dir = CONFIG.cache.dir, file = 'kv-cache.json', maxEntries = CONFIG.cache.maxEntries } = {}) {
    this.dir = dir;
    this.file = path.join(dir, file);
    this.maxEntries = maxEntries;
    this.map = new Map(); // key -> {v, exp, at, hits}
    this.dirty = false;
    this._load();
    this._timer = setInterval(() => this.flush(), CONFIG.cache.flushIntervalMs);
    this._timer.unref?.();
  }

  static key(ns, id) { return `${ns}:${id}`; }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [k, e] of Object.entries(raw)) {
          if (!e.exp || e.exp > now()) this.map.set(k, e);
        }
      }
    } catch { /* corrupted cache never blocks boot */ }
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), 'utf8');
      fs.renameSync(tmp, this.file); // atomic on POSIX
      this.dirty = false;
    } catch { /* disk issues degrade to memory-only */ }
  }

  get(ns, id) {
    const k = KVCache.key(ns, id);
    const e = this.map.get(k);
    if (!e) return null;
    if (e.exp && e.exp <= now()) { this.map.delete(k); this.dirty = true; return null; }
    e.hits = (e.hits || 0) + 1;
    return e.v;
  }

  /** get with metadata (age, ttl remaining) — used for stale-while-revalidate. */
  getEntry(ns, id) {
    const k = KVCache.key(ns, id);
    const e = this.map.get(k);
    if (!e) return null;
    if (e.exp && e.exp <= now()) { this.map.delete(k); this.dirty = true; return null; }
    return { value: e.v, storedAt: e.at, ageMs: now() - e.at, expiresAt: e.exp || null };
  }

  set(ns, id, value, ttlS = CONFIG.cache.defaultTtlS) {
    const k = KVCache.key(ns, id);
    this.map.set(k, { v: value, at: now(), exp: ttlS ? now() + ttlS * 1000 : null, hits: 0 });
    this.dirty = true;
    if (this.map.size > this.maxEntries) this._evict();
    return value;
  }

  del(ns, id) { const hit = this.map.delete(KVCache.key(ns, id)); if (hit) this.dirty = true; return hit; }

  keys(ns) {
    const p = `${ns}:`;
    const out = [];
    for (const [k, e] of this.map) {
      if (!k.startsWith(p)) continue;
      if (e.exp && e.exp <= now()) { this.map.delete(k); this.dirty = true; continue; }
      out.push(k.slice(p.length));
    }
    return out;
  }

  all(ns) { return this.keys(ns).map((id) => ({ id, value: this.get(ns, id) })); }

  /** Evict expired first, then least-hit oldest entries down to 90% capacity. */
  _evict() {
    for (const [k, e] of this.map) if (e.exp && e.exp <= now()) this.map.delete(k);
    if (this.map.size <= this.maxEntries) return;
    const scored = [...this.map.entries()].sort((a, b) => (a[1].hits - b[1].hits) || (a[1].at - b[1].at));
    const drop = this.map.size - Math.floor(this.maxEntries * 0.9);
    for (let i = 0; i < drop; i++) this.map.delete(scored[i][0]);
    this.dirty = true;
  }

  /** Purge expired entries + optionally whole namespaces. Returns counts. */
  cleanup({ namespaces = [] } = {}) {
    let expired = 0, purged = 0;
    for (const [k, e] of this.map) {
      if (e.exp && e.exp <= now()) { this.map.delete(k); expired++; continue; }
      if (namespaces.some((ns) => k.startsWith(`${ns}:`))) { this.map.delete(k); purged++; }
    }
    if (expired || purged) this.dirty = true;
    this.flush();
    return { expired, purged, remaining: this.map.size };
  }

  stats() {
    const perNs = {};
    for (const k of this.map.keys()) {
      const ns = k.slice(0, k.indexOf(':'));
      perNs[ns] = (perNs[ns] || 0) + 1;
    }
    return { entries: this.map.size, perNamespace: perNs, file: this.file };
  }
}

// ---------------- embeddings (local deterministic fallback) ----------------
// When ONDEMAND_EMBEDDINGS_URL is unset we use a deterministic hashed
// bag-of-words projection (256-dim, L2-normalised). It is stable across
// processes → safe as a cache key, and good enough for near-duplicate
// email/query detection. A remote model can be swapped in via env with
// zero code changes.
export function localEmbed(text, dim = CONFIG.semantic.dim) {
  const v = new Float64Array(dim);
  const tokens = String(text).toLowerCase().replace(/[^a-z0-9@.\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const h = crypto.createHash('sha1').update(t).digest();
    const idx = h.readUInt32BE(0) % dim;
    const sign = (h[4] & 1) === 1 ? 1 : -1;
    v[idx] += sign;
    // bigram-ish context: second slot keyed by token+len for mild ordering signal
    const idx2 = h.readUInt32BE(8) % dim;
    v[idx2] += sign * 0.5;
  }
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(v, (x) => +(x / norm).toFixed(6));
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

export class SemanticCache {
  /**
   * Hybrid lookup:
   *   1. exact key (sha256 of normalised text) — O(1)
   *   2. cosine-similarity scan over stored vectors >= threshold
   * Entries carry TTLs like the KV layer. Backed by the same KVCache
   * (namespace `semvec`) so persistence/eviction is unified.
   */
  constructor(kv, { threshold = CONFIG.semantic.threshold, maxVectors = CONFIG.semantic.maxVectors } = {}) {
    this.kv = kv;
    this.threshold = threshold;
    this.maxVectors = maxVectors;
    this.ns = 'semvec';
  }

  static normalise(text) { return String(text).trim().toLowerCase().replace(/\s+/g, ' '); }
  static exactKey(text) { return crypto.createHash('sha256').update(SemanticCache.normalise(text)).digest('hex'); }

  async embed(text) {
    // remote embedding endpoint optional; local fallback is deterministic
    if (CONFIG.ondemand.embeddingsUrl && CONFIG.ondemand.apiKey) {
      try {
        const r = await fetch(CONFIG.ondemand.embeddingsUrl, {
          method: 'POST',
          headers: { apikey: CONFIG.ondemand.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: text }),
        });
        if (r.ok) {
          const j = await r.json();
          const vec = j?.data?.[0]?.embedding || j?.embedding;
          if (Array.isArray(vec)) return vec;
        }
      } catch { /* fall through to local */ }
    }
    return localEmbed(text);
  }

  async lookup(text) {
    const ek = SemanticCache.exactKey(text);
    const exact = this.kv.get(this.ns, ek);
    if (exact) return { hit: true, kind: 'exact', similarity: 1, value: exact.value, key: ek };
    const qv = await this.embed(text);
    let best = null;
    for (const { id, value: e } of this.kv.all(this.ns)) {
      if (!e?.vector) continue;
      const sim = cosine(qv, e.vector);
      if (sim >= this.threshold && (!best || sim > best.similarity)) best = { hit: true, kind: 'semantic', similarity: +sim.toFixed(4), value: e.value, key: id };
    }
    return best || { hit: false, kind: 'miss', similarity: 0, value: null, key: ek, vector: qv };
  }

  async store(text, value, ttlS = CONFIG.cache.embeddingTtlS, precomputedVector = null) {
    const ek = SemanticCache.exactKey(text);
    const vector = precomputedVector || (await this.embed(text));
    if (this.kv.keys(this.ns).length >= this.maxVectors) {
      // drop ~10% oldest vectors
      const all = this.kv.all(this.ns).sort((a, b) => (a.value?.at || 0) - (b.value?.at || 0));
      for (const { id } of all.slice(0, Math.ceil(this.maxVectors * 0.1))) this.kv.del(this.ns, id);
    }
    this.kv.set(this.ns, ek, { value, vector, at: now(), text: String(text).slice(0, 300) }, ttlS);
    return ek;
  }
}

// ---------------- singletons ----------------
export const kv = new KVCache({});
export const semantic = new SemanticCache(kv);

export const NS = {
  EMAIL_META: 'emailMeta',
  THREAD_SUMMARY: 'threadSummary',
  PYRAMID: 'priorityPyramid',
  SENDER_PROFILE: 'senderProfile',
  SENTIMENT: 'sentiment',
  SYNC_STATE: 'syncState',
  DASHBOARD: 'dashboard',
  EMBEDDINGS: 'embeddings',
  BRIEFING: 'briefing',
  FOLLOWUPS: 'followups',
  JOBS: 'jobs',
  FAILED_JOBS: 'failedJobs',
};
