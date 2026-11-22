/**
 * Companion engine — what Jenni brings up *before* being asked.
 * Local, deterministic, strengths-first: it offers a ready next step
 * ("notice ka draft taiyar karun?"), celebrates what got done, and learns the
 * owner's weekly rhythm. It never scolds about lateness or past gaps.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_PROACTIVE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const istDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms));
  const istHour = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date(ms))) % 24;
  const istWeekday = (ms) => new Date(Date.parse(istDay(ms) + 'T00:00:00Z')).getUTCDay();

  const DOC_HINTS = [
    [/notice|सूचना/i, 'notice'], [/circular|परिपत्र/i, 'circular'], [/note ?sheet|टिप्पणी/i, 'notesheet'],
    [/roster|duty|deployment|ड्यूटी/i, 'roster'], [/routine|time ?table|समय सारणी/i, 'routine'],
    [/letter|patra|पत्र|application|avedan|आवेदन/i, 'letter'], [/mail|email/i, 'email']
  ];
  const docFor = (title) => { const h = DOC_HINTS.find(([re]) => re.test(title)); return h ? h[1] : ''; };

  /** Which kind of work is this message? (for learning the weekly rhythm) */
  function intentOf(text) {
    const t = String(text || '');
    const doc = docFor(t);
    if (doc && /bana|likh|draft|make|create|generate|tayyar/i.test(t)) return 'doc:' + doc;
    if (/result|marks|analysis|remedial|sa1|sa2/i.test(t)) return 'result-analysis';
    if (/lesson plan|worksheet|question paper|quiz|ncert/i.test(t)) return 'teaching-material';
    if (/cbse|compliance|affiliation|udise|apaar/i.test(t)) return 'compliance';
    return '';
  }

  function recordIntent(activity, intent, nowMs) {
    if (!intent) return activity;
    const a = Object.assign({}, activity);
    const day = istDay(nowMs);
    const dates = (a[intent] || []).filter((d) => d !== day).concat(day).slice(-24);
    a[intent] = dates;
    return a;
  }

  const LABEL = { 'result-analysis': 'result analysis', 'teaching-material': 'teaching material', compliance: 'CBSE compliance work' };
  const labelOf = (intent) => (intent.startsWith('doc:') ? intent.slice(4) + ' draft' : LABEL[intent] || intent);

  function rhythm(activity, nowMs) {
    const wd = istWeekday(nowMs), today = istDay(nowMs), out = [];
    Object.entries(activity || {}).forEach(([intent, dates]) => {
      if (dates.includes(today)) return;
      const cutoff = nowMs - 56 * DAY;
      const same = dates.filter((d) => Date.parse(d + 'T00:00:00Z') >= cutoff && new Date(d + 'T00:00:00Z').getUTCDay() === wd);
      if (same.length >= 3) out.push(intent);
    });
    return out;
  }

  /**
   * → up to `max` suggestions: { id, text, action: {type:'chat'|'office', ...} }
   */
  function suggest({ notes = [], wins = [], events = [], activity = {}, dismissed = [], nowMs = Date.now(), max = 3, name = '' } = {}) {
    const today = istDay(nowMs), out = [];
    const tasks = notes.filter((n) => n.cat === 'task');
    const stateOf = (t) => (t.due ? Math.round((Date.parse(t.due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY) : null);

    // 1) a ready next step for work that is due now or soon
    tasks.filter((t) => { const d = stateOf(t); return d !== null && d <= 2; })
      .sort((a, b) => stateOf(a) - stateOf(b)).slice(0, 2).forEach((t) => {
        const doc = docFor(t.text);
        const when = stateOf(t) < 0 ? 'abhi' : stateOf(t) === 0 ? 'aaj' : 'jaldi';
        if (doc) out.push({ id: 'task-doc:' + t.id, text: `"${t.text}" ${when} ka kaam hai — draft taiyar karun?`, action: { type: 'office', doc, subject: t.text } });
        else out.push({ id: 'task:' + t.id, text: `"${t.text}" ${when} ka kaam hai — saath me nipta dein?`, action: { type: 'chat', text: `"${t.text}" ke liye mera plan banao: kya karna hai, kis order me.` } });
      });

    // 2) calendar: the next thing within 90 minutes
    const soon = events.filter((e) => !e.allDay && Date.parse(e.start) > nowMs && Date.parse(e.start) - nowMs <= 90 * 60000)[0];
    if (soon) {
      const mins = Math.round((Date.parse(soon.start) - nowMs) / 60000);
      out.push({ id: 'cal:' + soon.start + soon.title, text: `${mins} min me "${soon.title}" hai — kuch prepare karna hai?`, action: { type: 'chat', text: `"${soon.title}" ke liye mujhe 3 point ka quick prep note do.` } });
    }

    // 3) the owner's weekly rhythm
    rhythm(activity, nowMs).slice(0, 1).forEach((intent) => {
      const doc = intent.startsWith('doc:') ? intent.slice(4) : '';
      out.push({ id: 'rhythm:' + intent + ':' + today, text: `Aaj ke din aap aksar ${labelOf(intent)} karte ho — shuru karein?`, action: doc ? { type: 'office', doc } : { type: 'chat', text: `Aaj ${labelOf(intent)} par kaam shuru karte hain.` } });
    });

    // 4) celebrate what got done (strengths first)
    const doneToday = wins.filter((w) => istDay(w.at) === today);
    if (doneToday.length && istHour(nowMs) >= 16) {
      out.push({ id: 'wins:' + today, text: `Aaj ${doneToday.length} kaam nipte${name ? ', ' + name : ''} — shaandaar. Kal ki taiyari kar dein?`, action: { type: 'chat', text: 'Kal ke liye mera plan banao: sabse zaroori 3 kaam.' } });
    }

    return out.filter((s) => !dismissed.includes(s.id)).slice(0, max);
  }

  return { suggest, intentOf, recordIntent, rhythm, docFor, istDay };
});
