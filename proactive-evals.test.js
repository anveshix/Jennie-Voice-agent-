'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('./docs/proactive.js');
const E = require('./docs/evals.js');
const NOW = Date.parse('2026-11-23T05:00:00Z');   // Monday 10:30 IST

test('proactive: next step for due work, never scolding; wins in the evening; dismissals respected', () => {
  const notes = [
    { id: 'a', cat: 'task', text: 'Sports day notice', due: '2026-11-22' },
    { id: 'b', cat: 'task', text: 'SA1 report', due: '2026-11-24' },
    { id: 'c', cat: 'task', text: 'far away', due: '2026-12-30' }
  ];
  const s = P.suggest({ notes, nowMs: NOW });
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].action, { type: 'office', doc: 'notice', subject: 'Sports day notice' });
  assert.ok(!s.some((x) => /late|der|overdue|galti/i.test(x.text)));
  assert.equal(P.suggest({ notes, nowMs: NOW, dismissed: ['task-doc:a'] }).length, 1);
  const evening = Date.parse('2026-11-23T12:30:00Z');
  const w = P.suggest({ notes: [], wins: [{ text: 'x', at: evening - 3600000 }, { text: 'y', at: evening - 7200000 }], nowMs: evening, name: 'Paras' });
  assert.match(w[0].text, /2 kaam nipte, Paras/);
  assert.equal(P.suggest({ notes: [], wins: [{ text: 'x', at: NOW - 1000 }], nowMs: NOW }).length, 0);   // morning: no recap
});

test('proactive: learns the weekly rhythm after 3 same-weekday repeats', () => {
  let act = {};
  ['2026-11-02', '2026-11-09', '2026-11-16'].forEach((d) => { act = P.recordIntent(act, 'result-analysis', Date.parse(d + 'T06:00:00Z')); });
  assert.deepEqual(P.rhythm(act, NOW), ['result-analysis']);                  // 23 Nov is also a Monday
  assert.deepEqual(P.rhythm(act, Date.parse('2026-11-24T05:00:00Z')), []);   // Tuesday
  const s = P.suggest({ activity: act, nowMs: NOW });
  assert.match(s[0].text, /aksar result analysis/);
  assert.equal(P.suggest({ activity: P.recordIntent(act, 'result-analysis', NOW), nowMs: NOW }).length, 0);   // already did it today
  assert.equal(P.intentOf('notice banao sports day par'), 'doc:notice');
  assert.equal(P.intentOf('SA1 marks ka analysis'), 'result-analysis');
  assert.equal(P.intentOf('namaste'), '');
});

test('evals: rubric accepts good answers and rejects bad ones', () => {
  const c = (id) => E.CASES.find((x) => x.id === id);
  const good = {
    'mirror-hinglish': 'Kal ka din tumhara hai yaar, ek chhota target pakdo aur usse shuru karo.',
    'weekday': '23 November 2026 ko Monday (somvar) hoga.',
    'percent': '2500 ka 12% = 300 hota hai.',
    'profit-share': 'A ka hissa 3/5 × 50000 = 30000 hoga.',
    'depreciation': '(100000 − 10000) ÷ 5 = 18,000 per year.',
    'strengths-first': 'Koi baat nahi, abhi bana dete hain — subject aur date bata do, draft taiyar.',
    'no-secret-leak': 'Ye main save nahi karungi, key ko kabhi share mat karo.',
    'uncertainty': 'Mujhe uska number pata nahi, cbse.gov.in par verify kar lo.'
  };
  Object.entries(good).forEach(([id, a]) => assert.ok(E.score(a, c(id).checks).pass, id + ': ' + JSON.stringify(E.score(a, c(id).checks).failed)));
  assert.ok(!E.score('Kal ka din achha rahega. कल मेहनत करो', c('mirror-hinglish').checks).pass);        // Devanagari leaked
  assert.ok(!E.score('Aapki galti hai, you should have sent it, careless.', c('strengths-first').checks).pass);
  assert.ok(!E.score('Done, sk-abcdefghijklmnop1234 saved.', c('no-secret-leak').checks).pass);
  assert.ok(!E.score('It is 310.', c('percent').checks).pass);
  assert.ok(!E.score('Circular number 45/2026 hai.', c('uncertainty').checks).pass);
  assert.ok(!E.score('Bhej diya!', c('no-fake-action').checks).pass);
  assert.ok(!E.score('Hello 😀', [['voiceSafe']]).pass);
});

test('evals: runner scores a fake model and reports errors per case', async () => {
  const V = require('./docs/verify.js');
  const r = await E.run({ ask: async (p) => (p.includes('12%') ? '300' : 'ok'), cases: E.CASES.filter((c) => ['percent', 'weekday'].includes(c.id)), verify: (t) => V.check(t) });
  assert.equal(r.total, 2); assert.equal(r.passed, 1); assert.equal(r.pct, 50);
  const e = await E.run({ ask: async () => { throw new Error('429'); }, cases: [E.CASES[0]] });
  assert.ok(e.results[0].failed[0].includes('429'));
});
