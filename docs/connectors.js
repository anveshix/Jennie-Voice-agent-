/**
 * Jenni connectors — NeverMind agent OS bridge + installable SKILL.md packs.
 *
 *  - NeverMind: REST bridge (/api/command → poll /api/tasks/:id). The user's
 *    own NeverMind server does the work (9 agents, 21 verified skills); Jenni
 *    delegates deliverables to it and reads back the summary + artifact links.
 *  - Skill packs: SKILL.md files (the skills.sh / PpSkills- format) read from
 *    public GitHub repos and kept locally; matched to a message by keywords.
 *
 * Pure + fetch-injectable so it is unit-testable. No secrets are logged.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_CONNECT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BUSY = ['CREATED', 'DECIDED', 'PLANNED', 'DELIBERATING', 'EXECUTING', 'VERIFYING', 'DELIVERING'];
  const DELEGATE_RE = /\b(question paper|worksheet|quiz|lesson plan|active recall|story|storytelling|visual|notice|circular|marking scheme|answer key|blueprint|unit test|revision|flashcards?)\b|प्रश्न\s*पत्र|वर्कशीट|क्विज़?/i;

  const isSafeBase = (url) => {
    try {
      const u = new URL(url);
      const local = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/.test(u.hostname);
      return u.protocol === 'https:' || (u.protocol === 'http:' && local);
    } catch (e) { return false; }
  };
  const cleanBase = (url) => String(url || '').trim().replace(/\/+$/, '');

  function createNeverMind(cfg, fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const base = cleanBase(cfg && cfg.url);
    const headers = (json) => Object.assign(
      json ? { 'Content-Type': 'application/json' } : {},
      cfg && cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {});

    async function call(path, body) {
      if (!f) throw new Error('fetch nahi hai');
      if (!isSafeBase(base)) throw new Error('NeverMind URL https:// hona chahiye (ya local network).');
      const res = await f(base + path, body
        ? { method: 'POST', headers: headers(true), body: JSON.stringify(body) }
        : { headers: headers(false) });
      if (res.status === 401) throw new Error('NeverMind token galat ya missing hai.');
      if (res.status === 403) throw new Error('NeverMind ne is origin ko allow nahi kiya (NEVERMIND_CORS_ORIGINS).');
      if (!res.ok) throw new Error('NeverMind HTTP ' + res.status);
      return res.json();
    }

    return {
      enabled: Boolean(base),
      health: () => call('/api/health'),
      roster: async () => ((await call('/api/bootstrap')).agents || []).map((a) => ({ id: a.id, name: a.name, role: a.role })),
      skills: async () => (await call('/api/skills')).skills || [],
      memories: async () => ((await call('/api/memory')).memories || [])
        .filter((m) => m.status === 'active' && (m.layer === 'semantic' || m.layer === 'procedural'))
        .map((m) => String(m.content || '').slice(0, 200)),
      async delegate(text, { timeoutMs = 90000, intervalMs = 2500, onStatus, sleep } = {}) {
        const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const { task_id: id } = await call('/api/command', { text });
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const { task } = await call('/api/tasks/' + encodeURIComponent(id));
          if (onStatus) onStatus(task.status);
          if (!BUSY.includes(task.status)) {
            return {
              id, status: task.status, summary: String(task.summary || '').slice(0, 2500),
              files: (task.artifacts || []).map((a) => ({ name: a.name, status: a.status, url: base + a.path }))
            };
          }
          await wait(intervalMs);
        }
        return { id, status: 'RUNNING', summary: 'Abhi chal raha hai; NeverMind app me task ' + id + ' dekho.', files: [] };
      }
    };
  }

  // A deliverable noun alone ("notice kya hota hai?") stays normal chat; it needs an action word.
  const ACTION_RE = /\b(bana|banao|bana do|banado|banana|create|generate|make|draft|prepare|build|tayyar|chahiye|likh|likho|de do|do)\b|बना|तैयार|चाहिए|लिख/i;
  function wantsDelegation(text) {
    const s = String(text || '');
    if (/^\s*(nevermind|agents?)\s*[:,-]/i.test(s)) return true;
    return !/\?\s*$/.test(s) && DELEGATE_RE.test(s) && ACTION_RE.test(s);
  }
  const stripPrefix = (text) => String(text).replace(/^\s*(nevermind|agents?)\s*[:,-]\s*/i, '');

  /* ── SKILL.md packs ───────────────────────────────────────────────────── */
  function parseSkillMd(text) {
    const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return null;
    const field = (k) => { const r = m[1].match(new RegExp('^' + k + ':\\s*(.+)$', 'mi')); return r ? r[1].trim().replace(/^["']|["']$/g, '') : ''; };
    const name = field('name');
    if (!name) return null;
    return { name, description: field('description'), body: m[2].trim().slice(0, 4000) };
  }

  const STOP = new Set('the a an and or to of in for with use when this that you your is are be it on as by from if can how do user skill skills'.split(' '));
  const words = (s) => String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];

  function matchPacks(text, packs, max = 2) {
    const q = new Set(words(text).filter((w) => !STOP.has(w)));
    return (packs || []).map((p) => {
      const hay = new Set(words(p.name + ' ' + p.description).filter((w) => !STOP.has(w)));
      let score = 0; hay.forEach((w) => { if (q.has(w)) score += 1; });
      return { p, score };
    }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.p);
  }

  /** Read every SKILL.md of a public repo (root or skills/<name>/). */
  async function fetchPacks(slug, github, fetchImpl) {
    const f = fetchImpl || fetch.bind(globalThis);
    const parsed = github.parseRepo(slug);
    if (!parsed) throw new Error('Repo "owner/repo" jaisa do.');
    const base = `${github.API}/repos/${parsed.owner}/${parsed.repo}/contents`;
    const get = async (path) => {
      const r = await f(base + path, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.status === 403 || r.status === 429) throw new Error('GitHub limit lag gayi, thodi der baad try karo.');
      if (!r.ok) return null;
      return r.json();
    };
    const dirs = await get('/skills');
    const targets = Array.isArray(dirs) ? dirs.filter((d) => d.type === 'dir').slice(0, 12).map((d) => `/skills/${d.name}/SKILL.md`) : [];
    targets.push('/SKILL.md');
    const out = [];
    for (const t of targets) {
      const file = await get(t);
      if (file && file.content) {
        const md = parseSkillMd(github.decodeBase64(file.content));
        if (md) out.push(Object.assign(md, { source: `${parsed.owner}/${parsed.repo}` }));
      }
    }
    if (!out.length) throw new Error('Is repo me SKILL.md nahi mila.');
    return out;
  }

  async function searchSkillsSh(query, fetchImpl) {
    const f = fetchImpl || fetch.bind(globalThis);
    const r = await f('https://skills.sh/api/search?q=' + encodeURIComponent(query) + '&limit=6');
    if (!r.ok) throw new Error('skills.sh HTTP ' + r.status);
    const j = await r.json();
    return (j.skills || []).slice(0, 6).map((s) => ({ name: s.name, source: s.source || s.topSource || '', installs: s.installs }));
  }

  return { createNeverMind, wantsDelegation, stripPrefix, parseSkillMd, matchPacks, fetchPacks, searchSkillsSh, isSafeBase, BUSY };
});
