'use strict';
/* Durable workflow engine: persisted runs, resume after restart, retries, approval gates. */
function createEngine({ store, autonomy, onEvent = () => {}, retryDelayMs = 1500, now = () => Date.now() }) {
  const defs = new Map();
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const active = new Set();
  const iso = () => new Date(now()).toISOString();

  const register = (def) => { defs.set(def.id, def); return def; };
  const save = (run) => { run.updatedAt = iso(); store.put('runs', run.id, run); return run; };

  async function start(defId, input = {}) {
    const def = defs.get(defId);
    if (!def) throw new Error(`unknown workflow: ${defId}`);
    const run = save({ id: store.uid('run'), def: defId, title: def.title, status: 'running', cursor: 0, input, out: {}, log: [], createdAt: iso() });
    store.audit('run_start', { run: run.id, def: defId });
    await advance(run.id);
    return store.get('runs', run.id);
  }

  async function advance(runId) {
    if (active.has(runId)) return store.get('runs', runId);
    active.add(runId);
    try {
      const run = store.get('runs', runId);
      const def = run && defs.get(run.def);
      if (!run || !def || !['running', 'failed_retry'].includes(run.status)) return run;
      run.status = 'running';
      while (run.cursor < def.steps.length) {
        const step = def.steps[run.cursor];
        const ctx = { input: run.input, out: run.out, run };
        if (step.when && !step.when(ctx)) { run.cursor += 1; save(run); continue; }
        const payload = step.payload ? step.payload(ctx) : {};
        const decision = autonomy.decide(step.action || 'read', payload);
        if (decision.tier === 'never') {
          run.status = 'blocked'; run.error = `${step.id}: human-only action`;
          save(run); store.audit('run_blocked', { run: run.id, step: step.id }); onEvent({ type: 'run_blocked', run });
          return run;
        }
        if (decision.tier === 'approve' && !(run.approved || {})[step.id]) {
          const id = store.uid('appr');
          const approval = { id, runId: run.id, step: step.id, action: step.action, status: 'pending',
            preview: step.preview ? String(step.preview(ctx)).slice(0, 1500) : step.id, createdAt: iso() };
          store.put('approvals', id, approval);
          run.status = 'waiting_approval'; run.approvalId = id;
          save(run); store.audit('approval_requested', { run: run.id, step: step.id, approval: id });
          onEvent({ type: 'approval_needed', run, approval });
          return run;
        }
        let lastErr = null, done = false;
        for (let attempt = 0; attempt <= (step.retries == null ? 2 : step.retries) && !done; attempt += 1) {
          try {
            const out = await step.run(ctx);
            run.out[step.id] = out === undefined ? null : out;
            run.log.push({ step: step.id, ok: true, at: iso() });
            done = true;
          } catch (e) {
            lastErr = e;
            if (e && e.fatal) break;
            await sleep(retryDelayMs * (attempt + 1));
          }
        }
        if (!done) {
          run.status = 'failed'; run.error = `${step.id}: ${(lastErr && lastErr.message) || 'failed'}`;
          run.log.push({ step: step.id, ok: false, error: run.error, at: iso() });
          save(run); store.audit('run_failed', { run: run.id, step: step.id, error: run.error });
          onEvent({ type: 'run_failed', run });
          return run;
        }
        run.cursor += 1; save(run);
      }
      run.status = 'done'; save(run);
      store.audit('run_done', { run: run.id, def: run.def });
      onEvent({ type: 'run_done', run, result: def.summary ? def.summary(run) : '' });
      return run;
    } finally { active.delete(runId); }
  }

  async function decideApproval(id, approve, by = 'owner') {
    const a = store.get('approvals', id);
    if (!a || a.status !== 'pending') throw new Error('approval not pending');
    a.status = approve ? 'approved' : 'rejected'; a.by = by; a.decidedAt = iso();
    store.put('approvals', id, a);
    store.audit('approval_decided', { approval: id, status: a.status, by });
    const run = store.get('runs', a.runId);
    if (!run) return a;
    if (approve) { run.approved = { ...(run.approved || {}), [a.step]: true }; run.status = 'running'; save(run); await advance(run.id); }
    else { run.status = 'cancelled'; save(run); onEvent({ type: 'run_cancelled', run }); }
    return a;
  }

  /** Call on boot: continue every run that was mid-flight when the process stopped. */
  async function resumeAll() {
    for (const r of store.list('runs')) if (r.status === 'running') await advance(r.id);
  }
  const retry = async (runId) => {
    const r = store.get('runs', runId);
    if (!r || r.status !== 'failed') throw new Error('only failed runs can be retried');
    r.status = 'running'; r.error = ''; save(r); return advance(runId);
  };

  return { register, start, advance, decideApproval, resumeAll, retry, defs, pending: () => store.list('approvals').filter((a) => a.status === 'pending') };
}

module.exports = { createEngine };
