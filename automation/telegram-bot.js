'use strict';
/* Two-way Telegram control. Only the paired chat id is obeyed; everyone else is ignored silently. */
const API = 'https://api.telegram.org';
const FILE_LIMIT = 1024 * 1024;

function createBot({ connections, handlers, fetchImpl, pollSeconds = 25, onError = () => {} }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let running = false, offset = 0, abort = null;
  const creds = () => { const t = connections.read().telegram; return t && t.botToken && t.chatId ? t : null; };

  async function call(method, body, signal) {
    const c = creds(); if (!c) throw new Error('telegram not configured');
    const r = await doFetch(`${API}/bot${c.botToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) throw new Error(`telegram ${method} failed: ${(j && j.description) || r.status}`);
    return j.result;
  }
  const say = (text, extra = {}) => call('sendMessage', { chat_id: creds().chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true, ...extra });
  const notifyApproval = (a) => say(`🔐 Approval needed\n${a.action}: ${a.preview}`, { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ap:${a.id}` }, { text: '❌ Reject', callback_data: `rj:${a.id}` }]] } });

  async function download(fileId) {
    const f = await call('getFile', { file_id: fileId });
    if (f.file_size && f.file_size > FILE_LIMIT * 20) throw new Error('file too large');
    const r = await doFetch(`${API}/file/bot${creds().botToken}/${f.file_path}`);
    if (!r.ok) throw new Error('download failed');
    return Buffer.from(await r.arrayBuffer());
  }

  async function handleUpdate(u) {
    const c = creds(); if (!c) return;
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.message && q.message.chat.id) !== String(c.chatId)) return;
      const [kind, id] = String(q.data || '').split(':');
      await call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      if (kind === 'ap' || kind === 'rj') {
        try { await handlers.decide(id, kind === 'ap'); await say(kind === 'ap' ? '✅ Approved' : '❌ Rejected'); } catch (e) { await say(`⚠️ ${e.message}`); }
      }
      return;
    }
    const m = u.message;
    if (!m || String(m.chat.id) !== String(c.chatId)) return;
    try {
      let text = (m.text || m.caption || '').trim();
      if (m.voice || m.audio) {
        if (!handlers.transcribe) return void (await say('Voice notes need AI_TRANSCRIPTION_MODEL.'));
        text = await handlers.transcribe(await download((m.voice || m.audio).file_id), 'audio/ogg');
        await say(`🎙 ${text}`);
      }
      if (m.document) {
        const buf = await download(m.document.file_id);
        if (buf.length > FILE_LIMIT) return void (await say('File too large (max 1 MB).'));
        const reply = await handlers.file({ name: m.document.file_name || '', text: buf.toString('utf8'), caption: text });
        return void (await say(reply));
      }
      if (!text) return;
      await say(await handlers.text(text));
    } catch (e) { await say(`⚠️ ${e.message}`).catch(() => {}); }
  }

  async function loop() {
    let backoff = 1000;
    while (running) {
      try {
        if (!creds()) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        abort = new AbortController();
        const updates = await call('getUpdates', { offset, timeout: pollSeconds, allowed_updates: ['message', 'callback_query'] }, abort.signal);
        backoff = 1000;
        for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u); }
      } catch (e) {
        if (!running) break;
        onError(e);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }
  return {
    say, notifyApproval, handleUpdate, call,
    start() { if (!running) { running = true; loop(); } },
    stop() { running = false; if (abort) abort.abort(); }
  };
}

module.exports = { createBot };
