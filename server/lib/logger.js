// ============================================================
// v29 — structured JSON logging for all API calls and errors.
// One JSON object per line: { ts, level, event, ...fields }.
// LOG_LEVEL=debug|info|warn|error (default info).
// ============================================================
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;

export function log(level, event, fields = {}) {
  if ((LEVELS[level] ?? 20) < MIN) return;
  let line;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, note: 'unserializable fields' });
  }
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (event, fields) => log('debug', event, fields),
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields),
};

/** Express middleware — one JSON line per /api request with latency. */
export function requestLogger() {
  return (req, res, next) => {
    if (!String(req.path || '').startsWith('/api')) return next();
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      log(res.statusCode >= 500 ? 'error' : 'info', 'http.request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
      });
    });
    next();
  };
}
