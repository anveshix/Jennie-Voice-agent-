'use strict';
const test = require('node:test');
const assert = require('node:assert');
const O = require('./docs/office.js');
const D = require('./docs/docs.js');
const NOW = Date.parse('2026-11-22T05:00:00Z');
const SCHOOL = { name: 'Dumka Public School', address: 'Dumka', affiliation: '3430001' };

test('every document type builds without throwing, with letterhead + date', () => {
  const samples = {
    notice: { subject: 'S', body: 'a\nb' }, circular: { subject: 'S', body: 'x' }, letter: { to: 'DEO\nDumka', subject: 'S', body: 'x' },
    application: { subject: 'Leave', body: 'x', name: 'N' }, email: { to: 'a@b.c', subject: 'S', body: 'x' }, notesheet: { subject: 'S', proposal: 'p' },
    roster: { staff: 'A\nB', duties: 'Gate | 1' }, routine: { lessons: 'XI|Acc|P|3', periods: '6', daysCount: '5' }
  };
  O.TYPES.forEach((t) => {
    const r = O.build(t.id, samples[t.id], SCHOOL, NOW);
    assert.ok(r.text.length > 40, t.id);
    if (!['email', 'application', 'notesheet'].includes(t.id)) assert.match(r.text, /DUMKA PUBLIC SCHOOL/, t.id);
    assert.equal(r.counter, 1);
  });
  assert.match(O.build('notice', { subject: 'S', body: 'x' }, SCHOOL, NOW).text, /22 नवंबर 2026/);
  assert.equal(O.session(Date.parse('2027-02-01')), '2026-27');
  assert.equal(O.session(Date.parse('2026-04-02')), '2026-27');
});

test('note sheet has all five numbered parts and approval blocks', () => {
  const t = O.build('notesheet', { lang: 'en', subject: 'Buy chairs', proposal: 'Buy 20', finance: 'Rs 20000' }, SCHOOL, NOW).text;
  ['1. Background', '2. Rules / Reference', '3. Proposal', '4. Financial implication', '5. For approval', 'Approved / Not approved'].forEach((x) => assert.ok(t.includes(x), x));
  assert.ok(t.includes('Nil'));   // empty sections are explicit, not blank
});

test('roster: fair, respects unavailability, never double-books a day when staff suffice', () => {
  const r = O.solveRoster({ staff: ['A', 'B', 'C', 'D', 'E'], duties: O.parseDuties('Assembly | 2\nGate | 1'), days: O.selectedDays('Mon-Sat'), unavailable: O.parseUnavailable('A: Mon, Tue') });
  assert.equal(r.grid.Mon.Assembly.concat(r.grid.Mon.Gate).includes('A'), false);
  assert.equal(r.grid.Tue.Assembly.concat(r.grid.Tue.Gate).includes('A'), false);
  Object.values(r.grid).forEach((day) => { const all = [].concat(...Object.values(day)); assert.equal(new Set(all).size, all.length); });
  const loads = Object.values(r.total);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 2);
  assert.equal(r.warnings.filter((w) => /do duty/.test(w)).length, 0);
});

test('roster: too few staff is reported, not hidden', () => {
  const r = O.solveRoster({ staff: ['A'], duties: O.parseDuties('Gate | 2'), days: ['Mon'], unavailable: {} });
  assert.ok(r.warnings.length > 0);
});

test('timetable: no teacher or class clash, every period placed, validator agrees', () => {
  const lessons = O.parseLessons([
    'XI|Accountancy|Paras|6', 'XI|BST|Bina|5', 'XI|Eco|Chandan|5', 'XI|English|Deepa|5', 'XI|Maths|Esha|6',
    'XII|Accountancy|Paras|6', 'XII|BST|Bina|5', 'XII|Eco|Chandan|5', 'XII|English|Deepa|5', 'XII|IP|Esha|6', 'X|Maths|Esha|6', 'X|English|Deepa|5'
  ].join('\n'));
  const r = O.solveTimetable({ periods: 8, days: 6, lessons, breakAfter: 4 });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  const slots = {};
  Object.keys(r.grid).forEach((c) => Object.entries(r.grid[c]).forEach(([slot, l]) => { const k = l.teacher + slot; assert.ok(!slots[k], 'teacher clash ' + k); slots[k] = 1; }));
  lessons.forEach((l) => assert.equal(Object.values(r.grid[l.cls]).filter((x) => x.subject === l.subject).length, l.n));
});

test('timetable: impossible demand is explained', () => {
  const r = O.solveTimetable({ periods: 2, days: 2, lessons: O.parseLessons('X|A|T1|3\nX|B|T1|3'), breakAfter: 0 });
  assert.ok(r.warnings.some((w) => /T1|slot/.test(w)));
});

test('docx tables: markdown tables become real Word tables', () => {
  assert.deepEqual(D.parseLines('| A | B |\n|---|---|\n| 1 | 2 |')[0], { kind: 'table', rows: [['A', 'B'], ['1', '2']] });
  const blob = D.buildDocx('R', '| A | B |\n|---|---|\n| 1 | 2 |');
  assert.ok(blob.size > 200 || blob.length > 200);
});
