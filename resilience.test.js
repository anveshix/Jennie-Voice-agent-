const test = require('node:test');
const assert = require('node:assert');

const NET = require('./docs/net.js');

/* A fixed clock and a fixed "random" make every wait below exact. */
const at = (ms) => () => ms;

test('classifyStatus maps provider statuses to the codes the app speaks', () => {
  assert.equal(NET.classifyStatus(401), 'AUTH');
  assert.equal(NET.classifyStatus(403), 'AUTH');
  assert.equal(NET.classifyStatus(404), 'MODEL_NOT_FOUND');
  assert.equal(NET.classifyStatus(408), 'HTTP_408');
  assert.equal(NET.classifyStatus(429), 'BUSY');
  assert.equal(NET.classifyStatus(503), 'HTTP_5XX');
  assert.equal(NET.classifyStatus(500), 'HTTP_5XX');
  assert.equal(NET.classifyStatus(400), 'HTTP_ERROR');
  assert.equal(NET.classifyStatus(undefined), 'HTTP_ERROR');
});

test('Retry-After accepts seconds, HTTP-dates, clamps and rejects junk', () => {
  assert.equal(NET.parseRetryAfter('7'), 7000);
  assert.equal(NET.parseRetryAfter('0.5'), 500);
  assert.equal(NET.parseRetryAfter('9999'), NET.MAX_RETRY_AFTER_MS);
  assert.equal(NET.parseRetryAfter('  3  '), 3000);
  assert.equal(NET.parseRetryAfter(new Date(50_000).toUTCString(), 45_000), 5000);
  assert.equal(NET.parseRetryAfter(new Date(10_000).toUTCString(), 45_000), 0);
  assert.equal(NET.parseRetryAfter('soon-ish'), null);
  assert.equal(NET.parseRetryAfter(''), null);
  assert.equal(NET.parseRetryAfter(null), null);
});

test('backoff grows exponentially, stays inside the cap, and is jittered', () => {
  assert.equal(NET.backoff(0, { baseMs: 1000, capMs: 10000, random: () => 0 }), 500);
  assert.equal(NET.backoff(0, { baseMs: 1000, capMs: 10000, random: () => 1 }), 1000);
  assert.equal(NET.backoff(1, { baseMs: 1000, capMs: 10000, random: () => 1 }), 2000);
  assert.equal(NET.backoff(2, { baseMs: 1000, capMs: 10000, random: () => 1 }), 4000);
  assert.equal(NET.backoff(9, { baseMs: 1000, capMs: 10000, random: () => 1 }), 10000);
  // never above the cap, never below half of it, whatever the random source says
  for (let i = 0; i < 50; i += 1) {
    const wait = NET.backoff(4, { baseMs: 1000, capMs: 6000 });
    assert.ok(wait >= 3000 && wait <= 6000, String(wait));
  }
  // jitter actually varies, so retries do not march in lockstep
  const spread = new Set(Array.from({ length: 30 }, () => NET.backoff(3, { baseMs: 1000, capMs: 8000 })));
  assert.ok(spread.size > 5, 'jitter should spread the waits out');
});

test('a 503 is retried, a bad key or retired model is not', () => {
  const down = { code: 'HTTP_5XX', status: 503 };
  assert.equal(NET.retryPlan(down, 0, { baseMs: 100, random: () => 1 }).retry, true);
  assert.equal(NET.retryPlan(down, 3, { maxAttempts: 3 }).retry, false);
  assert.equal(NET.retryPlan({ code: 'BUSY', status: 429 }, 0, {}).retry, true);
  assert.equal(NET.retryPlan({ code: 'TIMEOUT' }, 1, {}).retry, true);
  assert.equal(NET.retryPlan({ code: 'AUTH', status: 401 }, 0, {}).retry, false);
  assert.equal(NET.retryPlan({ code: 'MODEL_NOT_FOUND', status: 404 }, 0, {}).retry, false);
  assert.equal(NET.retryPlan({ code: 'CANCELLED' }, 0, {}).retry, false);
  assert.equal(NET.retryPlan(null, 0, {}).retry, false);
});

test('Retry-After wins over backoff, with a floor so a "0" does not spin', () => {
  const plan = NET.retryPlan({ code: 'BUSY', status: 429, retryAfterMs: 4000 }, 0, { baseMs: 100 });
  assert.deepEqual({ retry: plan.retry, waitMs: plan.waitMs }, { retry: true, waitMs: 4000 });
  const zero = NET.retryPlan({ code: 'HTTP_5XX', status: 503, retryAfterMs: 0 }, 0, { minWaitMs: 250 });
  assert.equal(zero.waitMs, 250);
  const huge = NET.retryPlan({ code: 'HTTP_5XX', status: 503, retryAfterMs: 90000 }, 0, { maxWaitMs: 8000 });
  assert.equal(huge.waitMs, 8000);
});

test('a deadline stops a retry that would keep a voice turn silent too long', () => {
  const plan = NET.retryPlan({ code: 'HTTP_5XX', status: 503, retryAfterMs: 9000 }, 0, { now: 1000, deadline: 5000 });
  assert.equal(plan.retry, false);
  assert.equal(plan.reason, 'deadline');
  const soon = NET.retryPlan({ code: 'HTTP_5XX', status: 503 }, 0, { now: 1000, deadline: 9000, random: () => 0, baseMs: 1000 });
  assert.equal(soon.retry, true);
  assert.ok(soon.waitMs <= 8000);
});

test('the breaker opens after repeated failures, cools down, and closes on success', () => {
  let clock = 0;
  const breaker = NET.createBreaker({ threshold: 3, cooldownMs: 1000, now: () => clock });
  assert.equal(breaker.isOpen(), false);
  breaker.fail({ code: 'HTTP_5XX' });
  breaker.fail({ code: 'HTTP_5XX' });
  assert.equal(breaker.isOpen(), false, 'still below the threshold');
  breaker.fail({ code: 'HTTP_5XX' });
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.openFor(), 1000);
  clock += 400;
  assert.equal(breaker.openFor(), 600);
  clock += 601;
  assert.equal(breaker.isOpen(), false, 'cooldown expired → allow one probe');
  breaker.fail({ code: 'HTTP_5XX' });
  assert.equal(breaker.openFor(), 2000, 'a failed probe opens for longer');
  breaker.ok();
  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.state().fails, 0);
});
