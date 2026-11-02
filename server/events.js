// Every pipeline step reports through here: the event is saved (for replay) and pushed live to any open page.
import { q } from './db.js';

const listeners = new Map(); // runId -> Set<res>

export function subscribe(runId, res) {
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId).add(res);
  return () => listeners.get(runId)?.delete(res);
}

export function broadcast(runId, payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners.get(runId) ?? []) res.write(line);
}

export function createRecorder(runId) {
  const t0 = performance.now();
  const started = new Map();
  let seq = 0;
  // Saves run in order on one chain so replay order always matches what happened.
  let chain = Promise.resolve();

  function emit(step, status, detail = '', data = null) {
    const at = Math.round(performance.now() - t0);
    let duration = null;
    if (status === 'start') started.set(step, at);
    else if (started.has(step)) duration = at - started.get(step);
    const ev = { runId, seq: seq++, at, step, status, detail, duration, data };
    broadcast(runId, { type: 'event', event: ev });
    chain = chain.then(() => q(
      'insert into events (run_id, seq, at_ms, step, status, detail, duration_ms, data) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [runId, ev.seq, at, step, status, detail, duration, data ? JSON.stringify(data) : null],
    )).catch(err => console.error('event save failed', err));
    return ev;
  }

  return {
    start: (step, detail, data) => emit(step, 'start', detail, data),
    progress: (step, detail, data) => emit(step, 'progress', detail, data),
    done: (step, detail, data) => emit(step, 'done', detail, data),
    warn: (step, detail, data) => emit(step, 'warn', detail, data),
    fail: (step, detail, data) => emit(step, 'fail', detail, data),
    retry: (step, detail, data) => emit(step, 'retry', detail, data),
    flush: () => chain,
  };
}
