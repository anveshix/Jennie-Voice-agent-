'use strict';
const test = require('node:test');
const assert = require('node:assert');
const b = require('./docs/brain.js');

test('ops: extract, apply, dedupe, secret filter', () => {
  const r = b.extractOps('ok\n[[task: SA1 report | due Monday]]\n[[remember: likes Hindi]]');
  assert.equal(r.text, 'ok');
  let m = b.applyOps([], r.ops, 1);
  m = b.applyOps(m, r.ops, 2);
  assert.equal(m.length, 2);
  assert.equal(b.addMemory([], 'password 1234').length, 0);
  m = b.applyOps(m, [{ op: 'done', body: 'SA1' }]);
  assert.equal(m.length, 1);
});

test('skills + context + commands', () => {
  assert.ok(b.selectSkills('leave application likho').some((s) => s.id === 'official-letter'));
  assert.equal(b.selectSkills('hello').length, 0);
  assert.match(b.buildContext({ text: 'hi', memories: [] }), /Paras Pranav/);
  assert.equal(b.userCommand('yaad rakho: kal meeting').op, 'remember');
});
