/**
 * Memory hub — one coherent view over Jenni's two stores (agent.js facts and
 * brain.js notes/tasks), plus the hygiene a long-lived companion needs:
 * conflict resolution, decay, corrections, recurring tasks, and a strengths-first
 * filter that keeps the owner's shortcomings out of memory and prompts.
 * Pure functions: callers persist.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_MEM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const SINGLE_VALUED = new Set(['name', 'place', 'age', 'language']);   // newer value replaces older

  const tokens = (s) => new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []));
  function overlap(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let n = 0; A.forEach((w) => { if (B.has(w)) n += 1; });
    return n / Math.min(A.size, B.size);
  }
  const factText = (f) => String((f && f.text) || '').replace(/^[a-zA-Z]+:\s*/, '');

  /* ── strengths-first: shortcomings are neither kept nor surfaced ─────── */
  const SHORTCOMING = [
    /\b(i am|i'm|main|mai)\s+(so |very |bahut )?(weak|bad|poor|slow|lazy|careless|forgetful|late|useless|dumb|kamzor|aalsi|sust)\b/i,
    /\b(weak|bad|poor|slow)\s+(in|at)\b/i,
    /\b(always|hamesha|baar baar|often)\s+(late|bhool|forget|miss|fail|galti)/i,
    /\b(bhool jata|bhool jati|bhul jata|bhul jati|bhool jaata|galti karta|galti karti|fail ho|nahi aata|nahi aati|nahi kar paata|nahi kar pati)\b/i,
    /\b(can'?t|cannot|unable to)\s+(manage|handle|cope|do|understand)\b/i,
    /\b(kamzori|weakness|shortcoming|failure|nakaam)\b/i,
    /कमजोर|कमज़ोर|आलसी|भूल जात|गलती करत|नहीं आता|नहीं आती|असफल|कमी है/
  ];
  const isShortcoming = (text) => SHORTCOMING.some((re) => re.test(String(text || '')));

  /* ── recurring tasks ──────────────────────────────────────────────────── */
  const WD = { sunday: 0, sun: 0, ravivar: 0, monday: 1, mon: 1, somvar: 1, tuesday: 2, tue: 2, mangalvar: 2, wednesday: 3, wed: 3, budhvar: 3, thursday: 4, thu: 4, guruvar: 4, friday: 5, fri: 5, shukravar: 5, saturday: 6, sat: 6, shanivar: 6 };
  function parseRepeat(text) {
    const t = String(text || '').toLowerCase();
    let m = t.match(/\b(?:har|every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|ravivar|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar)\b/);
    if (m) return { repeat: 'weekly', weekday: WD[m[1]] };
    if (/\b(har hafte|weekly|every week|hafte me ek baar|साप्ताहिक)\b/.test(t)) return { repeat: 'weekly' };
    if (/\b(roz|daily|every day|har din|rozana)\b|रोज़|रोज/.test(t)) return { repeat: 'daily' };
    if (/\b(har mahine|monthly|every month|masik)\b/.test(t)) return { repeat: 'monthly' };
    return { repeat: '' };
  }
  const cleanRepeatWords = (text) => String(text || '').replace(/\b(har|every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|ravivar|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar)\b/ig, '').replace(/\b(har hafte|weekly|every week|roz|daily|every day|har din|rozana|har mahine|monthly|every month)\b/ig, '').replace(/\s+/g, ' ').trim();

  /** Next due date (YYYY-MM-DD) strictly after `from`, honouring weekday for weekly. */
  function nextDue(task, fromIso) {
    const base = Date.parse((fromIso || task.due || '') + 'T00:00:00Z');
    if (Number.isNaN(base)) return '';
    const d = new Date(base);
    if (task.repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (task.repeat === 'weekly') {
      d.setUTCDate(d.getUTCDate() + 7);
      if (Number.isInteger(task.weekday)) { while (d.getUTCDay() !== task.weekday) d.setUTCDate(d.getUTCDate() + 1); }
    } else if (task.repeat === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else return '';
    return d.toISOString().slice(0, 10);
  }

  /** Complete a task: one-off → removed + win; recurring → rolled forward + win. */
  function completeTask(notes, query, todayIso, nowMs) {
    const q = String(query || '').toLowerCase();
    const idx = notes.findIndex((n) => n.cat === 'task' && (n.id === query || String(n.text).toLowerCase().includes(q)));
    if (idx < 0) return { notes, win: null };
    const t = notes[idx];
    const win = { text: t.text, at: nowMs || Date.now() };
    if (t.repeat) {
      let due = t.due || todayIso, guard = 0;
      do { due = nextDue(t, due); guard += 1; } while (due && due <= todayIso && guard < 400);
      const rolled = Object.assign({}, t, { due });
      return { notes: notes.map((n, i) => (i === idx ? rolled : n)), win, rolled: true };
    }
    return { notes: notes.filter((_, i) => i !== idx), win };
  }

  /* ── facts: decay + conflict resolution ───────────────────────────────── */
  function decayFacts(facts, nowMs) {
    const now = nowMs || Date.now();
    return (facts || []).map((f) => {
      const idleDays = (now - Date.parse(f.at || 0)) / DAY;
      if (!Number.isFinite(idleDays) || idleDays < 90) return f;
      const steps = Math.floor((idleDays - 90) / 60) + 1;
      const conf = Math.max(0.05, (f.confidence || 0.6) - 0.1 * steps);
      return Object.assign({}, f, { confidence: conf, archived: conf < 0.25 });
    });
  }

  /** For single-valued kinds keep only the newest fact (the others are superseded). */
  function resolveConflicts(facts) {
    const newest = {};
    (facts || []).forEach((f) => {
      if (!SINGLE_VALUED.has(f.kind)) return;
      if (!newest[f.kind] || Date.parse(f.at || 0) > Date.parse(newest[f.kind].at || 0)) newest[f.kind] = f;
    });
    return (facts || []).filter((f) => !SINGLE_VALUED.has(f.kind) || newest[f.kind] === f);
  }

  /** One ranked, de-duplicated list for the prompt, whatever store it came from. */
  function unify({ facts, notes, text, now, limit }) {
    const items = [];
    resolveConflicts(decayFacts(facts, now)).forEach((f) => {
      if (f.archived || isShortcoming(f.text)) return;
      items.push({ text: factText(f), kind: f.kind || 'fact', src: 'fact', strength: (f.confidence || 0.5) + Math.min(0.2, (f.hits || 1) * 0.05), at: Date.parse(f.at || 0) || 0 });
    });
    (notes || []).forEach((n) => {
      if (n.cat === 'task' || isShortcoming(n.text)) return;
      items.push({ text: n.text, kind: n.cat || 'note', src: 'note', strength: 0.8, at: n.ts || 0 });
    });
    const scored = items.map((it) => ({ it, s: it.strength * 0.4 + overlap(text, it.text) * 1.2 + Math.min(0.2, it.at / 1e13) }))
      .sort((a, b) => b.s - a.s);
    const out = [];
    scored.forEach(({ it }) => {
      if (out.some((o) => overlap(o.text, it.text) > 0.8)) return;   // near-duplicate across stores
      out.push(it);
    });
    return out.slice(0, limit || 8);
  }

  /** "Not X, it is Y": drop what matches `wrong`, return what to add. */
  function correct({ facts, notes }, wrong, right) {
    const hit = (t) => overlap(wrong, t) >= 0.6 || String(t).toLowerCase().includes(String(wrong).toLowerCase());
    return {
      facts: (facts || []).filter((f) => !hit(factText(f))),
      notes: (notes || []).filter((n) => n.cat === 'task' || !hit(n.text)),
      add: String(right || '').trim()
    };
  }

  return { isShortcoming, parseRepeat, cleanRepeatWords, nextDue, completeTask, decayFacts, resolveConflicts, unify, correct, overlap, SINGLE_VALUED };
});
