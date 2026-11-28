'use strict';
/* Server-side Gmail / Calendar / Sheets via one OAuth refresh token (env GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN).
   Scopes needed: gmail.readonly gmail.compose gmail.send calendar sheets. Email bodies are untrusted data. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function createGoogle({ env = process.env, fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let cache = { token: '', exp: 0 };
  const configured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);

  async function token() {
    if (!configured()) throw new Error('Google is not configured (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN)');
    if (cache.token && cache.exp > now() + 30000) return cache.token;
    const r = await doFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google token refresh failed (${r.status})`);
    cache = { token: j.access_token, exp: now() + (j.expires_in || 3600) * 1000 };
    return cache.token;
  }
  async function api(url, opts = {}) {
    const r = await doFetch(url, { ...opts, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google API ${r.status}: ${(j.error && j.error.message) || 'error'}`);
    return j;
  }
  const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
  const hdr = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const mime = ({ to, subject, body }) => [`To: ${hdr(to)}`, `Subject: =?UTF-8?B?${Buffer.from(hdr(subject)).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', String(body || '')].join('\r\n');
  const G = 'https://gmail.googleapis.com/gmail/v1/users/me';

  return {
    configured,
    async gmailList(q, max = 10) {
      const l = await api(`${G}/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
      const out = [];
      for (const m of l.messages || []) {
        const d = await api(`${G}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const h = Object.fromEntries((d.payload.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
        out.push({ id: m.id, threadId: m.threadId, from: h.from || '', subject: h.subject || '', date: h.date || '', snippet: d.snippet || '' });
      }
      return out;
    },
    gmailDraft: (m) => api(`${G}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw: b64url(mime(m)) } }) }),
    gmailSend: (m) => api(`${G}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: b64url(mime(m)) }) }),
    async calendarEvents(days = 1) {
      const from = new Date(now()), to = new Date(now() + days * 86400000);
      const j = await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`);
      return (j.items || []).map((e) => ({ title: e.summary || '(no title)', start: (e.start && (e.start.dateTime || e.start.date)) || '' }));
    },
    async sheetsRead(id, range) { return (await api(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`)).values || []; },
    sheetsAppend: (id, range, values) => api(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, { method: 'POST', body: JSON.stringify({ values }) })
  };
}

module.exports = { createGoogle };
