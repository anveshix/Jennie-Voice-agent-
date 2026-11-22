/**
 * Instant answers for the voice loop.
 *
 * A voice agent that takes 2 seconds to say "haan sir" feels broken even if the
 * model is fine. Greetings, acknowledgements and stop-ish phrases have exactly
 * one sensible answer, so they are answered locally in a few milliseconds — no
 * network, no token cost, no waiting. Anything with real content goes to the
 * model.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_FAST = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Normalise: lowercase, strip punctuation, collapse whitespace. */
  function norm(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Ordered: the first matching rule wins. `re` runs on the normalised text. */
  const RULES = [
    { id: 'greet', re: /^(hi|hello|hey|namaste|namaskar|salaam|good morning|gm|subah|shubh|jai shree krishna|ram ram|sat sri akal|oye|are)$/, reply: 'Haan sir, ready hoon. Aap kaam boliye, main kar dungi.' },
    { id: 'greet-jenni', re: /^(hi|hello|hey|namaste|namaskar)? ?(jenni|jenny|jennie)$/, reply: 'Haan sir, boliye — kya karna hai?' },
    { id: 'how-are-you', re: /^(kaise ho|kaisi ho|kaise hain|how are you|kya haal|kya haal hai|haal chaal|how do you do)$/, reply: 'Bilkul theek hoon sir, aap bataiye — kya karna hai?' },
    { id: 'yes-sir', re: /^(haan|han|ha|yes|yeah|yep|ok|okay|theek|theek hai|thik hai|achha|sahi|bilkul|zaroor|done|hmm|hmmm)$/, reply: 'Ji sir, bataiye.' },
    { id: 'thanks', re: /^(thanks|thank you|thx|shukriya|dhanyavaad|dhanyawad|thanku)$/, reply: 'Koi baat nahi sir. Aur kuch kaam ho to boliye.' },
    { id: 'ready', re: /^(ready|main ready hoon|sun rahi ho|sun rahi ho na|are you there|there)$/, reply: 'Haan sir, sun rahi hoon — boliye.' },
    { id: 'stop', re: /^(ruko|ruk jao|ruk|bas|bas karo|chup|chup ho jao|stop|stop it|band karo|band kar do)$/, reply: '' },
    { id: 'wake', re: /^(hey jenni|hi jenni|jenni suno|jenni)$/, reply: 'Haan sir, boliye.' }
  ];

  /**
   * @returns {{id, reply}|null} null means "this needs the model".
   * A rule with an empty reply is a control word (stop) the caller handles.
   */
  function match(text) {
    const t = norm(text);
    if (!t || t.length > 40) return null;
    const words = t.split(' ').length;
    for (const rule of RULES) {
      if (rule.re.test(t)) return { id: rule.id, reply: rule.reply, words };
    }
    return null;
  }

  /** Convenience for the voice loop: only content-free turns get a free reply. */
  function quickReply(text) {
    const hit = match(text);
    return hit && hit.reply ? hit.reply : null;
  }

  return { norm, match, quickReply, RULES };
});
