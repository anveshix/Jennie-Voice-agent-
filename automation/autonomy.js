'use strict';
/* Autonomy tiers. auto = just do it · approve = one-tap human OK · never = human only. */
const TIER = {
  read: 'auto', draft: 'auto', file: 'auto', remind: 'auto', notify_self: 'auto', drive_upload: 'auto', gmail_draft: 'auto',
  gmail_send: 'approve', telegram_group: 'approve', calendar_write: 'approve', post_public: 'approve', share_file: 'approve', delete: 'approve',
  portal_submit: 'never', payment: 'never', signature: 'never', login: 'never', otp: 'never'
};

function createAutonomy(store) {
  const rules = () => store.list('rules');
  function matches(rule, action, payload) {
    if (rule.action !== action) return false;
    return Object.entries(rule.where || {}).every(([k, v]) => String((payload || {})[k] || '').toLowerCase() === String(v).toLowerCase());
  }
  function decide(action, payload) {
    const base = TIER[action] || 'approve'; // unknown actions are never silent
    if (base === 'never') return { tier: 'never', reason: 'human-only action' };
    if (base === 'approve' && rules().some((r) => matches(r, action, payload))) return { tier: 'auto', reason: 'standing rule' };
    return { tier: base, reason: base === 'auto' ? 'safe action' : 'needs approval' };
  }
  function addRule(action, where = {}) {
    if (TIER[action] === 'never') throw new Error(`${action} can never be automated`);
    if (!Object.keys(where).length) throw new Error('a standing rule needs a narrow condition (e.g. {to:"staff@school.in"})');
    const id = store.uid('rule');
    store.put('rules', id, { id, action, where });
    store.audit('rule_added', { id, action, where });
    return id;
  }
  return { decide, addRule, removeRule: (id) => store.del('rules', id), rules, TIER };
}

module.exports = { createAutonomy, TIER };
