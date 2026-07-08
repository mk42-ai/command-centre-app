// ============================================================
// v29 — process supervisor: the Express server never silently dies.
// Spawns server.js as a child, restarts it on ANY non-zero exit or
// crash with capped exponential backoff (1s → 30s), resets the
// backoff after a healthy 60s run, and emits a structured JSON log
// line for every lifecycle event. Signals (SIGTERM/SIGINT) forward
// to the child for graceful shutdown, then exit the supervisor.
// Usage: npm run start:supervised   (or: node supervisor.js)
// ============================================================
import { spawn } from 'node:child_process';

let restarts = 0;
let child = null;
let shuttingDown = false;

const jlog = (level, event, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));

function start() {
  if (shuttingDown) return;
  const t0 = Date.now();
  child = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: process.env });
  jlog('info', 'supervisor.start', { pid: child.pid, restarts });
  child.on('exit', (code, signal) => {
    const upMs = Date.now() - t0;
    if (shuttingDown || (code === 0 && !signal)) {
      jlog('info', 'supervisor.exit.clean', { code, signal, upMs });
      process.exit(code ?? 0);
    }
    if (upMs > 60000) restarts = 0; // healthy run — reset the backoff ladder
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(restarts, 5));
    restarts += 1;
    jlog('error', 'supervisor.restart', { code, signal, upMs, delayMs, restarts });
    setTimeout(start, delayMs);
  });
  child.on('error', (e) => {
    jlog('error', 'supervisor.spawn.error', { error: String(e?.message || e) });
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shuttingDown = true;
    jlog('info', 'supervisor.signal', { signal: sig });
    if (child) child.kill(sig);
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

start();
