'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSw(idx, nowMs) {
  const handlers = {}, shown = [];
  const store = { index: idx };
  const RealDate = Date;
  const FakeDate = class extends RealDate { constructor(...a) { super(...(a.length ? a : [nowMs])); } static now() { return nowMs; } };
  const self = {
    addEventListener: (n, f) => { handlers[n] = f; },
    location: { origin: 'https://x' }, registration: { showNotification: async (t, o) => shown.push([t, o]) },
    clients: { matchAll: async () => [], claim: async () => {}, openWindow: async () => {} }
  };
  self.self = self;
  const ctx = vm.createContext({
    self, Intl, Date: FakeDate, caches: {}, URL, Promise,
    importScripts: () => {
      const b = require('./docs/brain.js'); self.JENNI_BRAIN = b;
      self.JENNI_REMIND_STORE = { get: async (k) => store[k], set: async (k, v) => { store[k] = v; } };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'docs/sw.js'), 'utf8'), ctx);
  const fire = (name, ev) => new Promise((resolve) => handlers[name](Object.assign({ waitUntil: (p) => resolve(p) }, ev)));
  return { fire, shown, store };
}

test('periodicsync notifies once per state, respects PIN titles and quiet hours', async () => {
  const idx = { on: true, titles: false, items: [{ due: '2026-11-22', text: '' }], lastKey: '' };
  const day = Date.parse('2026-11-22T05:00:00Z');               // 10:30 IST
  const a = loadSw(JSON.parse(JSON.stringify(idx)), day);
  await a.fire('periodicsync', { tag: 'jenni-remind' });
  assert.equal(a.shown.length, 1);
  assert.ok(!/fees|SA1/.test(a.shown[0][1].body));
  await a.fire('periodicsync', { tag: 'jenni-remind' });          // same state → no repeat
  assert.equal(a.shown.length, 1);
  const early = loadSw(JSON.parse(JSON.stringify(idx)), Date.parse('2026-11-21T22:00:00Z'));   // 03:30 IST
  await early.fire('periodicsync', { tag: 'jenni-remind' });
  assert.equal(early.shown.length, 0);
  const off = loadSw(Object.assign({}, idx, { on: false }), day);
  await off.fire('periodicsync', { tag: 'jenni-remind' });
  assert.equal(off.shown.length, 0);
});
