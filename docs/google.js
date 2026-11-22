/**
 * Google Calendar + Gmail over REST with the owner's own OAuth token (the same
 * Google sign-in used for Drive). Read access to calendar and mail metadata;
 * mail can only be saved as a DRAFT — Jenni has no send scope.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_GOOGLE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCOPES = {
    drive: 'https://www.googleapis.com/auth/drive.file',
    calendar: 'https://www.googleapis.com/auth/calendar.events',
    gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
    gmailCompose: 'https://www.googleapis.com/auth/gmail.compose'
  };
  const scopeString = (extended) => (extended ? Object.values(SCOPES) : [SCOPES.drive]).join(' ');

  const istOffset = '+05:30';
  const toIso = (s) => (/[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : s + (s.length === 16 ? ':00' : '') + istOffset);

  function createGoogle({ getToken, fetchImpl }) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    async function call(url, init) {
      const token = await getToken();
      const res = await f(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + token }, (init && init.headers) || {}) }));
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401) { const e = new Error('Google token expire ho gaya — Drive tab me phir Connect karo.'); e.code = 'AUTH'; throw e; }
        if (res.status === 403) throw new Error('Google ne permission nahi di (Calendar/Gmail access on karo: Drive tab → Calendar & Gmail).');
        throw new Error((body && body.error && (body.error.message || body.error)) || `Google HTTP ${res.status}`);
      }
      return body;
    }

    return {
      async events(days = 1, nowMs = Date.now()) {
        const min = new Date(nowMs).toISOString();
        const max = new Date(nowMs + Math.min(Math.max(days, 1), 14) * 86400000).toISOString();
        const q = new URLSearchParams({ timeMin: min, timeMax: max, singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
        const data = await call('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + q);
        return (data.items || []).map((e) => ({
          title: e.summary || '(no title)',
          start: (e.start && (e.start.dateTime || e.start.date)) || '',
          end: (e.end && (e.end.dateTime || e.end.date)) || '',
          where: e.location || '',
          allDay: Boolean(e.start && e.start.date)
        }));
      },
      async createEvent({ title, start, end, description }) {
        const s = toIso(start);
        const e = end ? toIso(end) : new Date(Date.parse(s) + 3600000).toISOString();
        const body = { summary: title, description: description || '', start: { dateTime: s, timeZone: 'Asia/Kolkata' }, end: { dateTime: e, timeZone: 'Asia/Kolkata' } };
        const out = await call('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { id: out.id, link: out.htmlLink };
      },
      async searchMail(query, max = 5) {
        const q = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(max, 1), 10)) });
        const list = await call('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + q);
        const ids = (list.messages || []).slice(0, 10);
        const out = [];
        for (const m of ids) {
          const msg = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          const h = Object.fromEntries(((msg.payload && msg.payload.headers) || []).map((x) => [x.name.toLowerCase(), x.value]));
          out.push({ from: h.from || '', subject: h.subject || '', date: h.date || '', snippet: String(msg.snippet || '').slice(0, 200) });
        }
        return out;
      },
      async createDraft({ to, subject, body }) {
        const safe = (s) => String(s).replace(/[\r\n]+/g, ' ');
        const mime = [`To: ${safe(to)}`, `Subject: =?UTF-8?B?${toBase64(safe(subject))}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', toBase64(String(body))].join('\r\n');
        const raw = toBase64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const out = await call('https://gmail.googleapis.com/gmail/v1/users/me/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { raw } }) });
        return { id: out.id };
      }
    };
  }

  function toBase64(s) {
    if (typeof Buffer !== 'undefined') return Buffer.from(String(s), 'utf8').toString('base64');
    const bytes = new TextEncoder().encode(String(s));
    let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  return { SCOPES, scopeString, createGoogle };
});
