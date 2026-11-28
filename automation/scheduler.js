'use strict';
/* Minimal 5-field cron evaluated in IST. Persisted jobs; fires each matching minute once. */
const IST_MS = 330 * 60000;

function field(expr, min, max) {
  const out = new Set();
  for (const part of String(expr).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${part}`);
    let lo = min, hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      lo = Number(a); hi = b === undefined ? (stepRaw ? max : lo) : Number(b);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`bad cron field: ${part}`);
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

function parseCron(expr) {
  const p = String(expr).trim().split(/\s+/);
  if (p.length !== 5) throw new Error('cron needs 5 fields');
  return { m: field(p[0], 0, 59), h: field(p[1], 0, 23), dom: field(p[2], 1, 31), mon: field(p[3], 1, 12), dow: field(p[4], 0, 6), domStar: p[2] === '*', dowStar: p[4] === '*' };
}

function matches(expr, ms) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(ms + IST_MS);
  const dayOk = c.domStar && c.dowStar ? true : c.domStar ? c.dow.has(d.getUTCDay()) : c.dowStar ? c.dom.has(d.getUTCDate())
    : c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay());
  return c.m.has(d.getUTCMinutes()) && c.h.has(d.getUTCHours()) && c.mon.has(d.getUTCMonth() + 1) && dayOk;
}

const DEFAULT_JOBS = [
  { id: 'daily_briefing', cron: '0 7 * * *', recipe: 'daily_briefing', enabled: true },
  { id: 'inbox_triage', cron: '*/30 7-20 * * *', recipe: 'inbox_triage', enabled: true },
  { id: 'weekly_backup', cron: '0 21 * * 0', recipe: 'weekly_backup', enabled: true }
];

function createScheduler({ store, run, now = () => Date.now(), tickMs = 20000, onError = () => {} }) {
  let timer = null;
  for (const j of DEFAULT_JOBS) if (!store.get('jobs', j.id)) store.put('jobs', j.id, { ...j, input: {}, lastKey: '' });

  async function tick() {
    const t = now();
    const key = Math.floor(t / 60000);
    const fired = [];
    for (const job of store.list('jobs')) {
      if (!job.enabled || job.lastKey === key) continue;
      let hit = false;
      try { hit = matches(job.cron, t); } catch (e) { onError(job, e); continue; }
      if (!hit) continue;
      job.lastKey = key; store.put('jobs', job.id, job); fired.push(job.id);
      Promise.resolve(run(job.recipe, job.input || {})).catch((e) => onError(job, e));
    }
    return fired;
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => tick().catch(() => {}), tickMs); timer.unref && timer.unref(); } },
    stop() { clearInterval(timer); timer = null; },
    jobs: () => store.list('jobs'),
    setEnabled(id, on) { const j = store.get('jobs', id); if (!j) throw new Error('no such job'); j.enabled = Boolean(on); return store.put('jobs', id, j); },
    upsert(job) { parseCron(job.cron); return store.put('jobs', job.id, { enabled: true, input: {}, lastKey: '', ...job }); }
  };
}

module.exports = { createScheduler, parseCron, matches, DEFAULT_JOBS };
