'use strict';
/* Server-side tasks (so briefings and the Telegram bot work with the app closed). */
const IST_MS = 330 * 60000;
const ymd = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

function parseDue(text, ms) {
  const t = String(text || '').toLowerCase();
  const day = 86400000;
  if (/\b(aaj|today)\b/.test(t)) return ymd(ms);
  if (/\b(kal|tomorrow)\b/.test(t)) return ymd(ms + day);
  if (/\b(parso)\b/.test(t)) return ymd(ms + 2 * day);
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : ymd(ms).slice(0, 4);
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const i = days.findIndex((d) => t.includes(d));
  if (i >= 0) { const cur = new Date(ms + IST_MS).getUTCDay(); return ymd(ms + (((i - cur + 7) % 7) || 7) * day); }
  return '';
}

function createTasks(store, now = () => Date.now()) {
  const add = (title, due = '', repeat = '') => {
    const t = String(title || '').trim();
    if (!t) throw new Error('task title required');
    const id = store.uid('task');
    return store.put('tasks', id, { id, title: t, due: due || parseDue(t, now()), repeat, done: false, createdAt: new Date(now()).toISOString() });
  };
  const list = (filter = 'open') => {
    const today = ymd(now());
    return store.list('tasks').filter((t) => !t.done).filter((t) => {
      if (filter === 'overdue') return t.due && t.due < today;
      if (filter === 'today') return t.due === today;
      if (filter === 'week') return t.due && t.due <= ymd(now() + 7 * 86400000);
      return true;
    }).sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
  };
  const complete = (part) => {
    const t = store.list('tasks').find((x) => !x.done && x.title.toLowerCase().includes(String(part).toLowerCase()));
    if (!t) return null;
    if (t.repeat) {
      const step = t.repeat === 'weekly' ? 7 : t.repeat === 'monthly' ? 30 : 1;
      t.due = ymd(Date.parse(`${t.due || ymd(now())}T00:00:00Z`) + step * 86400000);
    } else t.done = true;
    return store.put('tasks', t.id, t);
  };
  return { add, list, complete, parseDue: (s) => parseDue(s, now()), today: () => ymd(now()) };
}

module.exports = { createTasks, parseDue, ymd };
