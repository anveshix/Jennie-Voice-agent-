'use strict';
const test = require('node:test');
const assert = require('node:assert');
const c = require('./docs/connectors.js');

const res = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });

test('NeverMind delegate polls to completion and builds file urls', async () => {
  const seen = [];
  let polls = 0;
  const nm = c.createNeverMind({ url: 'https://nm.example/', token: 'tk' }, async (url, opts = {}) => {
    seen.push([url, opts.headers && opts.headers.Authorization]);
    if (url.endsWith('/api/command')) return res({ task_id: 'T1' });
    polls += 1;
    return res({ task: polls < 2 ? { status: 'EXECUTING' } : { status: 'COMPLETED', summary: 'ok', artifacts: [{ name: 'w.md', status: 'TRUSTED', path: '/api/artifacts/T1/w.md' }] } });
  });
  const r = await nm.delegate('worksheet', { sleep: async () => {} });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.files[0].url, 'https://nm.example/api/artifacts/T1/w.md');
  assert.ok(seen.every(([, a]) => a === 'Bearer tk'));
});

test('unsafe http base is refused; errors are readable', async () => {
  await assert.rejects(c.createNeverMind({ url: 'http://evil.example' }, async () => res({})).health(), /https/);
  await assert.rejects(c.createNeverMind({ url: 'https://x.example' }, async () => res({}, 401)).health(), /token/);
});

test('routing + packs', () => {
  assert.ok(c.wantsDelegation('Class 11 quiz banao'));
  assert.ok(c.wantsDelegation('nevermind: hi'));
  assert.equal(c.stripPrefix('agents: quiz'), 'quiz');
  assert.equal(c.parseSkillMd('no frontmatter'), null);
  const packs = [{ name: 'find-skills', description: 'discover and install agent skills', body: 'b' }];
  assert.equal(c.matchPacks('how to discover agent skills', packs).length, 1);
  assert.equal(c.matchPacks('weather today', packs).length, 0);
});

test('audit: questions and bare nouns are not delegated', () => {
  assert.equal(c.wantsDelegation('notice kya hota hai?'), false);
  assert.equal(c.wantsDelegation('quiz'), false);
  assert.ok(c.wantsDelegation('Class 12 ka quiz bana do'));
});
