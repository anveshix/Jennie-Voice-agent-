/**
 * Shared network-resilience rules for every place Jenni talks to a provider.
 *
 * The browser app (docs/app.js) and the Node proxy (server.js) both load this
 * file, so "provider is busy / overloaded / down" is handled identically in
 * both halves of the stack: same retryable statuses, same Retry-After parsing,
 * same jittered backoff, same circuit-breaker rules.
 *
 * Everything here is pure and clock-injectable, which is what makes the
 * behaviour testable without waiting for real seconds to pass.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNIE_NET = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* A provider may ask us to wait, but never longer than this. Beyond it the
     right answer is "try later", not a hidden 5-minute spinner. */
  const MAX_RETRY_AFTER_MS = 30000;

  /* Codes the caller may retry on its own. 4xx auth/model/validation errors are
     deliberately absent: repeating a wrong key or a retired model never helps. */
  const RETRYABLE = new Set(['TIMEOUT', 'NETWORK', 'EMPTY_REPLY', 'TRUNCATED', 'HTTP_5XX', 'BUSY', 'HTTP_408']);

  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509, 522, 524]);

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

  /** HTTP status → the error code the rest of the app speaks in. */
  function classifyStatus(status) {
    const code = Number(status) || 0;
    if (code === 401 || code === 403) return 'AUTH';
    if (code === 404) return 'MODEL_NOT_FOUND';
    if (code === 408) return 'HTTP_408';
    if (code === 429) return 'BUSY';
    if (code >= 500) return 'HTTP_5XX';
    return 'HTTP_ERROR';
  }

  /**
   * `Retry-After` is either delta-seconds ("7") or an HTTP-date.
   * Returns milliseconds from `nowMs`, clamped to [0, MAX_RETRY_AFTER_MS], or
   * null when the header is missing/unparseable.
   */
  function parseRetryAfter(value, nowMs) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      return clamp(Math.round(Number(raw) * 1000), 0, MAX_RETRY_AFTER_MS);
    }
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    return clamp(at - now, 0, MAX_RETRY_AFTER_MS);
  }

  /**
   * Exponential backoff with "half to full" jitter: 600, 1200, 2400 ms of base
   * delay becomes somewhere in [300–600], [600–1200], [1200–2400] so a hundred
   * phones (or a hundred retries) never hit the provider in lockstep.
   */
  function backoff(attempt, options) {
    const opts = options || {};
    const baseMs = opts.baseMs === undefined ? 600 : Math.max(0, Number(opts.baseMs) || 0);
    const capMs = opts.capMs === undefined ? 12000 : Math.max(0, Number(opts.capMs) || 0);
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const raw = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, Number(attempt) || 0)));
    return Math.round(raw * (0.5 + random() * 0.5));
  }

  /** Would retrying this error ever be useful? */
  function isRetryable(error) {
    if (!error) return false;
    if (error.code === 'CANCELLED') return false;
    if (RETRYABLE.has(error.code)) return true;
    return RETRYABLE_STATUS.has(Number(error.status));
  }

  /**
   * Decide one retry step.
   *
   * @param error   { code, status, retryAfterMs }
   * @param attempt retries already used (0 on the first failure)
   * @param opts    { maxAttempts, baseMs, capMs, maxWaitMs, deadline, now,
   *                  random, minWaitMs }
   * @returns { retry, waitMs }
   *
   * `maxAttempts` counts retries after the first try: 3 means up to 4 requests.
   * `deadline` is an absolute timestamp; a wait that would pass it is refused so
   * a voice turn cannot sit silent for minutes.
   */
  function retryPlan(error, attempt, options) {
    const opts = options || {};
    const tries = Math.max(0, Number(attempt) || 0);
    const maxAttempts = opts.maxAttempts === undefined ? 3 : Math.max(0, Number(opts.maxAttempts) || 0);
    const minWaitMs = opts.minWaitMs === undefined ? 250 : Math.max(0, Number(opts.minWaitMs) || 0);
    const maxWaitMs = opts.maxWaitMs === undefined ? 15000 : Math.max(0, Number(opts.maxWaitMs) || 0);
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();

    if (!isRetryable(error)) return { retry: false, waitMs: 0, reason: 'not-retryable' };
    if (tries >= maxAttempts) return { retry: false, waitMs: 0, reason: 'attempts-exhausted' };

    const asked = Number(error && error.retryAfterMs);
    const waitMs = Number.isFinite(asked) && asked >= 0
      ? clamp(Math.max(asked, minWaitMs), 0, maxWaitMs)
      : clamp(backoff(tries, opts), minWaitMs, maxWaitMs);

    if (Number.isFinite(Number(opts.deadline)) && now + waitMs > Number(opts.deadline)) {
      return { retry: false, waitMs: 0, reason: 'deadline' };
    }
    return { retry: true, waitMs, reason: 'retry' };
  }

  /**
   * A tiny circuit breaker.
   *
   * After `threshold` failed turns in a row the circuit opens for `cooldownMs`.
   * While it is open the caller should make a single cheap probe instead of
   * running the whole retry ladder; a success closes it again, a failure
   * re-opens it. This is what stops a phone from hammering a provider that is
   * already returning 503 for everybody.
   */
  function createBreaker(options) {
    const opts = options || {};
    const threshold = Math.max(1, Number(opts.threshold) || 3);
    const cooldownMs = Math.max(0, Number(opts.cooldownMs) || 25000);
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    let fails = 0;
    let openUntil = 0;
    let lastCode = '';

    function state() {
      const remaining = Math.max(0, openUntil - now());
      return { fails, open: remaining > 0, retryInMs: remaining, lastCode };
    }

    return {
      fail(error) {
        fails += 1;
        lastCode = (error && error.code) || '';
        if (fails >= threshold) {
          // repeat openings stay open a little longer, capped at four cooldowns
          const stretch = Math.min(4, Math.ceil(fails / threshold));
          openUntil = now() + cooldownMs * stretch;
        }
        return state();
      },
      ok() {
        fails = 0;
        openUntil = 0;
        lastCode = '';
        return state();
      },
      openFor() {
        return Math.max(0, openUntil - now());
      },
      isOpen() {
        return this.openFor() > 0;
      },
      reset() {
        fails = 0;
        openUntil = 0;
        lastCode = '';
      },
      state
    };
  }

  return {
    MAX_RETRY_AFTER_MS,
    RETRYABLE,
    RETRYABLE_STATUS,
    classifyStatus,
    parseRetryAfter,
    backoff,
    isRetryable,
    retryPlan,
    createBreaker
  };
});
