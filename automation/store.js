'use strict';
/* Durable JSON store (atomic writes, mode 600) + AES-256-GCM "secure" section for student data. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadKey(dir, env) {
  const given = String((env && env.JENNI_DATA_KEY) || '');
  if (given) return crypto.createHash('sha256').update(given).digest();
  const file = path.join(dir, 'data.key');
  try { return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); } catch (e) { /* create */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

function createStore({ dir, env = process.env, now = () => Date.now() } = {}) {
  const file = path.join(dir, 'automation.json');
  const key = loadKey(dir, env);
  let state = { v: 1, jobs: {}, runs: {}, approvals: {}, rules: {}, tasks: {}, audit: [], seen: {}, secure: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { /* first run */ }

  function flush() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const col = (name) => (state[name] = state[name] || {});
  const get = (name, id) => col(name)[id];
  const list = (name) => Object.values(col(name));
  const put = (name, id, value) => { col(name)[id] = value; flush(); return value; };
  const del = (name, id) => { const had = id in col(name); delete col(name)[id]; if (had) flush(); return had; };
  const uid = (p) => `${p}_${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

  function audit(type, data) {
    state.audit.push({ t: new Date(now()).toISOString(), type, ...data });
    if (state.audit.length > 2000) state.audit.splice(0, state.audit.length - 2000);
    flush();
  }

  function seal(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  }
  function open(blob) {
    const [iv, tag, enc] = String(blob).split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  }
  const setSecure = (name, obj) => { state.secure[name] = seal(obj); flush(); };
  const getSecure = (name) => (state.secure[name] ? open(state.secure[name]) : null);

  return {
    file, get, list, put, del, uid, audit, flush, setSecure, getSecure,
    auditLog: (n = 50) => state.audit.slice(-n),
    seen: (ns, id) => Boolean((state.seen[ns] || {})[id]),
    markSeen: (ns, id) => { (state.seen[ns] = state.seen[ns] || {})[id] = now(); flush(); },
    /** Full snapshot; student data stays encrypted. */
    snapshot: () => JSON.stringify({ ...state, audit: state.audit.slice(-200) })
  };
}

module.exports = { createStore };
