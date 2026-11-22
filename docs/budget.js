/**
 * Context budget — keeps every request inside what a free-tier model can take,
 * and decides *what* to drop (lowest priority first) instead of letting the
 * provider silently truncate or fail. Old turns are condensed, not lost.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_BUDGET = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Rough token estimate that respects Devanagari (many tokens per character). */
  function estimate(text) {
    const s = String(text || '');
    let deva = 0, latin = 0, other = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0x900 && c <= 0x97f) deva += 1;
      else if (c < 0x250) latin += 1;
      else other += 1;
    }
    return Math.ceil(latin / 3.8 + deva / 1.4 + other / 1.6);
  }

  const clip = (text, tokens) => {
    if (estimate(text) <= tokens) return text;
    tokens = Math.max(1, tokens - 2);   // room for the ellipsis
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (estimate(text.slice(0, mid)) <= tokens) lo = mid; else hi = mid - 1; }
    return text.slice(0, lo).replace(/\s+\S*$/, '') + '…';
  };

  /**
   * sections: [{ id, text, priority }]  (1 = never drop … 9 = first to go)
   * Shrinks/drops from the least important until the total fits.
   */
  function fit(sections, maxTokens) {
    const list = sections.filter((s) => s && s.text).map((s) => Object.assign({ tokens: estimate(s.text) }, s));
    const total = () => list.reduce((n, s) => n + s.tokens, 0);
    const dropped = [], shrunk = [];
    const order = list.slice().sort((a, b) => b.priority - a.priority);
    for (const s of order) {
      if (total() <= maxTokens) break;
      if (s.priority <= 1) continue;
      const allowed = maxTokens - (total() - s.tokens);
      if (allowed >= 60 && s.priority >= 4) { s.text = clip(s.text, allowed); s.tokens = estimate(s.text); shrunk.push(s.id); }
      else { s.text = ''; s.tokens = 0; dropped.push(s.id); }
    }
    return { text: list.filter((s) => s.text).map((s) => s.text).join('\n'), used: total(), dropped, shrunk };
  }

  /** Newest turns that fit; anything older is returned for summarising. */
  function trimHistory(history, maxTokens, minTurns) {
    const kept = []; let used = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const t = estimate(history[i].content) + 4;
      if (used + t > maxTokens && kept.length >= (minTurns || 2)) break;
      kept.unshift(history[i]); used += t;
    }
    return { kept, dropped: history.slice(0, history.length - kept.length), used };
  }

  /** Extractive recap of dropped turns (no model call). */
  function summarize(dropped, previous) {
    const bits = [];
    dropped.forEach((m) => {
      const first = String(m.content || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?।])\s/)[0] || '';
      if (m.role === 'user' && first) bits.push('Owner: ' + first.slice(0, 90));
      else if (m.role === 'assistant' && first) bits.push('Jenni: ' + first.slice(0, 70));
    });
    const merged = [previous || '', ...bits].filter(Boolean).join(' | ');
    return merged.length > 700 ? merged.slice(-700).replace(/^[^|]*\|\s*/, '') : merged;
  }

  return { estimate, clip, fit, trimHistory, summarize };
});
