/**
 * Jenni — local security layer (browser only, no dependencies).
 *
 * What this protects and how:
 *   1. The API key at rest  → encrypted with PBKDF2(SHA-256, 210k) + AES-GCM
 *                              using the PIN as the passphrase. The plaintext
 *                              key is never written to storage.
 *   2. The app in the hand   → auto-lock after idle (default 2 min), lock on
 *                              tab hide, and a hard lock after repeated wrong
 *                              PINs.
 *   3. The key in memory     → "lock now" wipes it and the decrypted copy.
 *   4. Data on a lost phone  → panic wipe removes every key and all app data.
 *   5. Network exposure      → a strict CSP is injected at boot, and the
 *                              provider URLs are validated before any request.
 *
 * Deliberately limited: a browser cannot stop someone with the unlocked phone
 * and the PIN. This raises the cost, it is not a guarantee — the README says
 * so in plain words.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_SECURITY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KDF = { name: 'PBKDF2', hash: 'SHA-256', iterations: 210000 };
  const LOCK_KEY = 'jenni_lock_v1';
  const VAULT_KEY = 'jenni_vault_v1';

  /* ── helpers ───────────────────────────────────────────────────────────── */

  function toBase64(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function hasWebCrypto() {
    return Boolean(
      typeof crypto !== 'undefined' &&
      crypto.subtle &&
      typeof crypto.subtle.importKey === 'function' &&
      typeof TextEncoder !== 'undefined'
    );
  }

  async function deriveKey(pin, salt, iterations) {
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iterations || KDF.iterations, hash: KDF.hash },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* ── the vault: the API key, encrypted under the PIN ───────────────────── */

  /**
   * Returns { salt, iv, data, iterations } — safe to store. The key itself is
   * only inside `data`, encrypted.
   */
  async function seal(pin, plaintext) {
    if (!hasWebCrypto()) throw new Error('Is browser me crypto nahi hai — HTTPS par kholo.');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(pin, salt);
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plaintext))
    );
    return { v: 1, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data), iterations: KDF.iterations };
  }

  async function open(pin, sealed) {
    if (!hasWebCrypto()) throw new Error('Is browser me crypto nahi hai — HTTPS par kholo.');
    const key = await deriveKey(pin, fromBase64(sealed.salt), sealed.iterations);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data)
      );
    } catch (error) {
      throw new Error('Galat PIN');
    }
    return new TextDecoder().decode(plain);
  }

  /* ── PIN strength, judged locally and only to give advice ──────────────── */

  function pinStrength(pin) {
    const value = String(pin || '');
    if (value.length < 4) return { score: 0, label: 'Bahut chhota', ok: false };
    let score = 0;
    if (value.length >= 6) score += 1;
    if (value.length >= 8) score += 1;
    if (/[a-zA-Z]/.test(value) && /\d/.test(value)) score += 1;
    if (/[^a-zA-Z0-9]/.test(value)) score += 1;
    if (/^(?:\d)\1+$/.test(value) || /^(?:0123|1234|12345|123456|1111|0000|9999)/.test(value)) score = 0;
    const labels = ['Bahut kamzor', 'Kamzor', 'Theek', 'Achha', 'Mazboot'];
    return { score, label: labels[score] || 'Theek', ok: value.length >= 4 };
  }

  /* ── lock state: attempts, cooldown, auto-lock ─────────────────────────── */

  function createLock(options) {
    const settings = Object.assign({ attempts: 5, cooldownMs: 60000, idleMs: 120000 }, options || {});
    let state = { failed: 0, lockedUntil: 0, lastActive: Date.now() };

    function remainingCooldown() {
      return Math.max(0, state.lockedUntil - Date.now());
    }

    function recordFailure() {
      state.failed += 1;
      let cooldown = 0;
      if (state.failed >= settings.attempts) {
        const over = state.failed - settings.attempts;
        cooldown = Math.min(settings.cooldownMs * Math.pow(2, over), 15 * 60 * 1000);
        state.lockedUntil = Date.now() + cooldown;
      }
      return { failed: state.failed, cooldownMs: cooldown };
    }

    function recordSuccess() {
      state = { failed: 0, lockedUntil: 0, lastActive: Date.now() };
    }

    function touching() {
      state.lastActive = Date.now();
    }

    function idleFor() {
      return Date.now() - state.lastActive;
    }

    function isIdleExpired() {
      return idleFor() > settings.idleMs;
    }

    return { settings, remainingCooldown, recordFailure, recordSuccess, touching, idleFor, isIdleExpired };
  }

  /* ── URL validation, so a pasted base URL cannot exfiltrate to plain HTTP ─ */

  function isSafeUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return { ok: false, reason: 'URL khali hai' };
    let url;
    try {
      url = new URL(raw);
    } catch (error) {
      return { ok: false, reason: 'URL padhi nahi ja saki' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, reason: 'Sirf http(s) chalega' };
    }
    if (url.username || url.password) return { ok: false, reason: 'URL me username/password nahi' };
    if (url.search || url.hash) return { ok: false, reason: 'URL me query ya # nahi' };
    const local = /^(localhost|127\.|\[::1\])/.test(url.hostname);
    if (url.protocol === 'http:' && !local) {
      return { ok: false, reason: 'HTTP sirf localhost ke liye — baaki HTTPS' };
    }
    if (url.hostname.endsWith('.localhost')) return { ok: false, reason: 'Yeh host allowed nahi' };
    return { ok: true, url: raw };
  }

  /* ── strict CSP, injected before the app does anything ─────────────────── */

  const CSP = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com",
    "connect-src 'self' https:",   // includes api.github.com and every provider
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "frame-src https://accounts.google.com",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ].join('; ');

  function applyCsp(doc) {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    if (!target || target.querySelector('meta[http-equiv="Content-Security-Policy"]')) return;
    const meta = target.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', CSP);
    target.head.prepend(meta);
  }

  return { KDF, LOCK_KEY, VAULT_KEY, seal, open, pinStrength, createLock, isSafeUrl, hasWebCrypto, applyCsp, CSP, toBase64, fromBase64 };
});
