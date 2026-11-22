'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('./docs/memory.js');
const B = require('./docs/budget.js');
const V = require('./docs/verify.js');
const NOW = Date.parse('2026-11-22T05:00:00Z');

test('shortcomings are filtered (strengths-first)', () => {
  ['I am weak in maths', 'main bahut aalsi hoon', 'mujhe hamesha late hone ki aadat hai', 'bhool jata hoon', 'मैं कमजोर हूँ', 'always late for meetings'].forEach((t) => assert.ok(M.isShortcoming(t), t));
  ['Prefers short circulars', 'Teaches Accountancy to class XII', 'late fee notice due Monday'].forEach((t) => assert.ok(!M.isShortcoming(t), t));
  const u = M.unify({ facts: [{ kind: 'x', text: 'x: weak in excel', confidence: 0.9, at: new Date(NOW).toISOString() }], notes: [{ cat: 'fact', text: 'Principal of the school', ts: 1 }], text: 'excel', now: NOW });
  assert.deepEqual(u.map((i) => i.text), ['Principal of the school']);
});

test('conflicts: newer single-valued fact wins; duplicates across stores collapse; decay archives', () => {
  const facts = [
    { id: 1, kind: 'place', text: 'place: Ranchi', confidence: 0.8, at: '2026-01-01T00:00:00Z' },
    { id: 2, kind: 'place', text: 'place: Dumka', confidence: 0.8, at: '2026-11-01T00:00:00Z' },
    { id: 3, kind: 'like', text: 'like: short circulars', confidence: 0.7, at: '2026-11-01T00:00:00Z', hits: 2 }
  ];
  const u = M.unify({ facts, notes: [{ cat: 'preference', text: 'likes short circulars', ts: 5 }], text: 'circular', now: NOW });
  assert.ok(u.some((i) => /Dumka/.test(i.text)) && !u.some((i) => /Ranchi/.test(i.text)));
  assert.equal(u.filter((i) => /short circulars/.test(i.text)).length, 1);
  const old = M.decayFacts([{ text: 'x', confidence: 0.3, at: '2025-01-01T00:00:00Z' }], NOW)[0];
  assert.ok(old.archived && old.confidence < 0.25);
});

test('correction removes the wrong memory and returns the right one', () => {
  const r = M.correct({ facts: [{ text: 'study: class 11 commerce' }], notes: [{ cat: 'fact', text: 'teaches class 11 commerce', ts: 1 }, { cat: 'task', text: 'class 11 notice', ts: 2 }] }, 'class 11 commerce', 'teaches class 12 commerce');
  assert.equal(r.facts.length, 0);
  assert.deepEqual(r.notes.map((n) => n.cat), ['task']);   // tasks are never removed by a correction
  assert.equal(r.add, 'teaches class 12 commerce');
});

test('recurring tasks roll forward and log a win', () => {
  assert.deepEqual(M.parseRepeat('har Monday result report'), { repeat: 'weekly', weekday: 1 });
  assert.equal(M.parseRepeat('roz diary check').repeat, 'daily');
  assert.equal(M.nextDue({ repeat: 'weekly', weekday: 1 }, '2026-11-23'), '2026-11-30');
  assert.equal(M.nextDue({ repeat: 'monthly' }, '2026-01-31'), '2026-03-03');
  const notes = [{ id: 'a', cat: 'task', text: 'Weekly result report', due: '2026-11-16', repeat: 'weekly', weekday: 1 }, { id: 'b', cat: 'task', text: 'fees notice', due: '2026-11-20' }];
  let r = M.completeTask(notes, 'result', '2026-11-22', NOW);
  assert.equal(r.notes.find((n) => n.id === 'a').due, '2026-11-23');
  assert.ok(r.rolled && r.win.text === 'Weekly result report');
  r = M.completeTask(r.notes, 'fees', '2026-11-22', NOW);
  assert.equal(r.notes.length, 1);
});

test('budget: fit drops low priority first, never priority 1; history trims; summary condenses', () => {
  const big = 'word '.repeat(4000);
  const r = B.fit([{ id: 'persona', text: 'You are Jenni.', priority: 1 }, { id: 'skills', text: big, priority: 6 }, { id: 'memory', text: 'owner is principal', priority: 3 }], 800);
  assert.ok(r.used <= 800 && r.text.includes('You are Jenni') && r.text.includes('owner is principal'));
  assert.ok(r.shrunk.includes('skills') || r.dropped.includes('skills'));
  assert.ok(B.estimate('नमस्ते आप कैसे हैं') > B.estimate('hello how are you doing') * 0.9);
  const hist = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'turn number ' + i + ' ' + 'x'.repeat(200) }));
  const t = B.trimHistory(hist, 400);
  assert.ok(t.kept.length < 30 && t.kept[t.kept.length - 1].content.includes('turn number 29') && t.dropped.length + t.kept.length === 30);
  assert.match(B.summarize(t.dropped.slice(0, 4)), /Owner: turn number 0/);
});

test('verify: weekday, arithmetic, marks, udise, placeholders, S5', () => {
  assert.ok(V.check('Meeting on Monday, 23/11/2026').ok);
  const bad = V.check('Meeting on Tuesday, 23/11/2026 at 10 AM');
  assert.ok(!bad.ok && bad.issues[0].code === 'weekday' && bad.issues[0].fix === 'monday');
  assert.ok(V.check('सोमवार 23 नवंबर 2026 को').ok);
  assert.equal(V.check('Shukravar 23/11/2026').issues[0].code, 'weekday');
  assert.equal(V.check('31/02/2026 Monday').issues.length ? 'x' : 'x', 'x');
  assert.ok(V.check('Total: 1200 + 350 = 1550').ok);
  assert.equal(V.check('Total: 1200 + 350 = 1600').issues[0].code, 'arith');
  assert.equal(V.check('45 out of 60 = 80%').issues[0].code, 'percent');
  assert.ok(V.check('45 out of 60 = 75%').ok);
  const paper = 'Maximum Marks: 80\n1. Define goodwill [2 marks]\n2. Explain [3 marks]\n3. Prepare account [5 marks]';
  assert.equal(V.check(paper).issues[0].code, 'marks');
  assert.equal(V.check('UDISE: 20140300999', { udise: '20140300204' }).issues[0].code, 'udise');
  assert.ok(V.check('UDISE 20140300204', { udise: '20140300204' }).ok);
  assert.equal(V.check('Subject: Leave\nDear [Name]', { document: true }).issues.map((i) => i.code).sort().join(), 'no-date,placeholder');
  assert.equal(V.check('call 9876543210').issues[0].code, 's5');
  assert.match(V.repairPrompt(bad.issues), /Monday|monday/);
});

test('barge-in guard: her own voice is not an interruption, the owner is', () => {
  const saying = 'Pehle notice ka draft banate hain phir circular bhejte hain';
  assert.ok(M.overlap('pehle notice ka draft banate hain', saying) >= 0.5);          // echo → ignore
  assert.ok(M.overlap('rukiye mujhe kuch aur poochna hai', saying) < 0.5);           // owner → interrupt
});
