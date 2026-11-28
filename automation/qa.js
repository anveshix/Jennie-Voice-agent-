'use strict';
/* Quality gate: S1 bilingual, S4 official accuracy (UDISE), S5 zero-trust privacy. */
const UDISE = '20140300204';
const OFFICIAL = new Set(['notice', 'circular', 'letter', 'application', 'notesheet', 'email']);
const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]/;

const PII = [
  ['aadhaar/apaar', /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g],
  ['phone', /(?<!\d)(?:\+?91[ -]?)?[6-9]\d{9}(?!\d)/g],
  ['otp/password', /\b(?:otp|password|passcode|pin)\b\s*(?:is|:|=)?\s*\d{4,8}\b/gi]
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redactPII(text, names = []) {
  let out = String(text == null ? '' : text);
  const found = [];
  for (const [label, re] of PII) {
    out = out.replace(re, () => { found.push(label); return '[redacted]'; });
  }
  for (const n of names) {
    const name = String(n || '').trim();
    if (name.length < 3) continue;
    const re = new RegExp(esc(name), 'gi');
    if (re.test(out)) { found.push('student-name'); out = out.replace(re, '[student]'); }
  }
  return { text: out, found };
}

/** Check a document; returns fixed text plus issues. error-severity issues block delivery. */
function check(text, { kind = 'notice', names = [], bilingual } = {}) {
  const issues = [];
  let out = String(text || '');
  const official = OFFICIAL.has(kind);
  const needBi = bilingual === undefined ? official : bilingual;

  if (!out.trim()) issues.push({ std: 'S1', severity: 'error', msg: 'empty document' });
  if (needBi && !(DEVANAGARI.test(out) && LATIN.test(out))) {
    issues.push({ std: 'S1', severity: 'error', msg: 'must contain both Hindi (Devanagari) and English' });
  }
  const mentioned = [...out.matchAll(/udise[^0-9]{0,20}(\d{11})/gi)].map((m) => m[1]);
  if (mentioned.some((n) => n !== UDISE)) {
    issues.push({ std: 'S4', severity: 'error', msg: `wrong UDISE code (expected ${UDISE})` });
  } else if (official && !mentioned.length) {
    out = `${out.trimEnd()}\n\nUDISE: ${UDISE}`;
    issues.push({ std: 'S4', severity: 'fixed', msg: 'UDISE footer added' });
  }
  const r = redactPII(out, names);
  if (r.found.length) {
    out = r.text;
    issues.push({ std: 'S5', severity: 'fixed', msg: `redacted: ${[...new Set(r.found)].join(', ')}` });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), text: out, issues };
}

module.exports = { UDISE, check, redactPII };
