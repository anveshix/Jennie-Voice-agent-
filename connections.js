/* ============================================================================
   External connections: Telegram, Google Drive (browser mode), Google Drive
   (server mode / background sync).

   Three deliberately separate levels of trust:

   1. Telegram      — a bot token. No OAuth, no Google review. Sends a draft or
                      note to your own chat. The cheapest real "send" feature.
   2. Drive (browser) — only a public OAuth client id. The browser gets a token
                      for `drive.file` and creates files. The app can only touch
                      files it created; no Picker, no API key, no verification.
   3. Drive (server)  — client id + secret + a refresh token. The server can
                      upload in the background, so the phone does not need a
                      Google session. Needs HTTPS reachability for the redirect.

   Secrets live in storage/connections.json (mode 600, git-ignored) and are
   never returned to a browser. Only the *actions* (send / upload / list) are
   exposed to LAN clients, rate limited, because that is the whole point of
   using the app from a phone.
   ========================================================================= */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TELEGRAM_API = 'https://api.telegram.org';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 20_000;
const MESSAGE_LIMIT = 3900;
const UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

class ConnectionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function emptyStore() {
  return {
    telegram: { botToken: '', chatId: '', savedAt: '' },
    drive: {
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      mode: 'off',
      folderId: '',
      account: '',
      savedAt: ''
    }
  };
}

function createConnections({ storageDir, requestIsLocal = () => false, fetchImpl } = {}) {
  const storeFile = path.join(storageDir, 'connections.json');
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  function ensureDir() {
    try {
      fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  function read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyStore();
      return emptyStore();
    }
    const base = emptyStore();
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      telegram: { ...base.telegram, ...(parsed.telegram || {}) },
      drive: { ...base.drive, ...(parsed.drive || {}) }
    };
  }

  function write(store) {
    ensureDir();
    const temp = `${storeFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(temp, storeFile);
    try { fs.chmodSync(storeFile, 0o600); } catch (error) { /* best effort */ }
  }

  function clearAll() {
    try {
      fs.unlinkSync(storeFile);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  function requireLocal(req) {
    if (!requestIsLocal(req)) {
      throw new ConnectionError(403, 'LOCAL_ONLY', 'Connection settings can only be changed from this computer, not from another device.');
    }
  }

  /** Never includes tokens, secrets or the bot token. */
  function status() {
    const store = read();
    const tg = store.telegram;
    const drive = store.drive;
    return {
      telegram: {
        configured: Boolean(tg.botToken && tg.chatId),
        tokenSet: Boolean(tg.botToken),
        chatSet: Boolean(tg.chatId),
        chatId: tg.chatId || '',
        botTokenHint: tg.botToken ? `…${tg.botToken.slice(-4)}` : '',
        savedAt: tg.savedAt || ''
      },
      drive: {
        mode: drive.clientId ? (drive.mode || 'browser') : 'off',
        clientId: drive.clientId || '',
        hasClientSecret: Boolean(drive.clientSecret),
        hasRefreshToken: Boolean(drive.refreshToken),
        browserReady: Boolean(drive.clientId),
        serverReady: Boolean(drive.clientId && drive.clientSecret && drive.refreshToken),
        folderId: drive.folderId || '',
        account: drive.account || '',
        savedAt: drive.savedAt || ''
      }
    };
  }

  /* ------------------------------------------------------------- Telegram */

  async function callTelegram(token, method, body) {
    let response;
    try {
      response = await doFetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new ConnectionError(504, 'TELEGRAM_TIMEOUT', 'Telegram did not answer in time. Try again.');
      }
      throw new ConnectionError(502, 'TELEGRAM_UNREACHABLE', 'Could not reach Telegram. Check this computer’s internet connection.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      const description = (payload && payload.description) || `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 404) {
        throw new ConnectionError(400, 'TELEGRAM_BAD_TOKEN', 'Telegram rejected that bot token. Copy it again from @BotFather.');
      }
      throw new ConnectionError(502, 'TELEGRAM_ERROR', `Telegram said: ${description}`);
    }
    return payload.result;
  }

  function validateToken(token) {
    const value = String(token || '').trim();
    if (!value) throw new ConnectionError(400, 'TELEGRAM_TOKEN_REQUIRED', 'Paste the bot token from @BotFather first.');
    if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(value)) {
      throw new ConnectionError(400, 'TELEGRAM_TOKEN_SHAPE', 'That does not look like a bot token (expected 123456789:ABC…).');
    }
    return value;
  }

  /** Ask Telegram who has messaged the bot, so the chat id can be picked. */
  async function findChats(token) {
    const value = validateToken(token);
    const updates = await callTelegram(value, 'getUpdates', { limit: 20 });
    const seen = new Map();
    for (const update of Array.isArray(updates) ? updates : []) {
      const message = update.message || update.edited_message || update.channel_post;
      if (!message || !message.chat) continue;
      const chat = message.chat;
      if (!seen.has(chat.id)) {
        seen.set(chat.id, {
          id: String(chat.id),
          label: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || chat.username || 'Chat',
          username: chat.username ? `@${chat.username}` : '',
          type: chat.type,
          lastText: String(message.text || '').slice(0, 60)
        });
      }
    }
    return [...seen.values()];
  }

  async function saveTelegram(req, input) {
    requireLocal(req);
    const token = input && input.botToken ? validateToken(input.botToken) : '';
    const store = read();
    const nextToken = token || store.telegram.botToken;
    if (!nextToken) throw new ConnectionError(400, 'TELEGRAM_TOKEN_REQUIRED', 'A bot token is required.');

    const chatId = String((input && input.chatId) || store.telegram.chatId || '').trim();
    if (!chatId) throw new ConnectionError(400, 'TELEGRAM_CHAT_REQUIRED', 'Send any message to your bot, then press “Find my chat”.');

    // verify both before saving so a typo never leaves a half-broken config
    const me = await callTelegram(nextToken, 'getMe', {});
    await callTelegram(nextToken, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Jenni is connected to this chat.\nBot: @${me.username || 'unknown'}`
    });

    store.telegram = { botToken: nextToken, chatId, savedAt: new Date().toISOString() };
    write(store);
    return { ...status().telegram, botUsername: me.username || '' };
  }

  async function testTelegram(req) {
    requireLocal(req);
    const store = read();
    if (!store.telegram.botToken || !store.telegram.chatId) {
      throw new ConnectionError(400, 'TELEGRAM_NOT_CONFIGURED', 'Connect Telegram first.');
    }
    await callTelegram(store.telegram.botToken, 'sendMessage', {
      chat_id: store.telegram.chatId,
      text: '🔔 Test message from Jenni. If you can read this, sending works.'
    });
    return { ok: true };
  }

  /**
   * Send text to the configured chat. Allowed from the LAN on purpose — that is
   * what makes "send this draft to my phone" useful. The token never leaves the
   * server and the destination is fixed, so the worst a LAN client can do is
   * send a message to the owner's own chat.
   */
  async function sendTelegram(input) {
    const store = read();
    if (!store.telegram.botToken || !store.telegram.chatId) {
      throw new ConnectionError(400, 'TELEGRAM_NOT_CONFIGURED', 'Connect Telegram in the Connections panel first.');
    }
    const text = String((input && input.text) || '').trim();
    if (!text) throw new ConnectionError(400, 'TEXT_REQUIRED', 'There is nothing to send.');
    const clipped = text.length > MESSAGE_LIMIT
      ? `${text.slice(0, MESSAGE_LIMIT)}\n\n…(shortened, ${text.length - MESSAGE_LIMIT} characters left out)`
      : text;
    const result = await callTelegram(store.telegram.botToken, 'sendMessage', {
      chat_id: store.telegram.chatId,
      text: clipped,
      disable_web_page_preview: true
    });
    return { ok: true, messageId: result && result.message_id, sentChars: clipped.length };
  }

  function disconnectTelegram(req) {
    requireLocal(req);
    const store = read();
    const had = Boolean(store.telegram.botToken);
    store.telegram = { botToken: '', chatId: '', savedAt: '' };
    write(store);
    return { cleared: had };
  }

  /* ---------------------------------------------------------------- Drive */

  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

  function validateClientId(value) {
    const id = String(value || '').trim();
    if (!id) throw new ConnectionError(400, 'DRIVE_CLIENT_REQUIRED', 'Paste the OAuth client ID from Google Cloud.');
    if (!/\.apps\.googleusercontent\.com$/.test(id)) {
      throw new ConnectionError(400, 'DRIVE_CLIENT_SHAPE', 'A Web OAuth client ID ends with .apps.googleusercontent.com.');
    }
    return id;
  }

  function saveDrive(req, input) {
    requireLocal(req);
    const store = read();
    const clientId = input && input.clientId ? validateClientId(input.clientId) : store.drive.clientId;
    if (!clientId) throw new ConnectionError(400, 'DRIVE_CLIENT_REQUIRED', 'A client ID is required.');

    // A secret only makes sense in server mode; sending one implies server mode.
    const wantsSecret = Boolean(input && input.clientSecret && String(input.clientSecret).trim());
    const requestedMode = input && ['browser', 'server'].includes(input.mode) ? input.mode : '';
    const mode = requestedMode || (wantsSecret ? 'server' : (store.drive.mode === 'server' ? 'server' : 'browser'));
    const clientSecret = wantsSecret ? String(input.clientSecret).trim() : String(store.drive.clientSecret || '');
    if (mode === 'server' && !clientSecret) {
      throw new ConnectionError(400, 'DRIVE_SECRET_REQUIRED', 'Server mode needs the OAuth client secret as well.');
    }

    store.drive = {
      ...store.drive,
      clientId,
      clientSecret: mode === 'server' ? clientSecret : '',
      mode,
      savedAt: new Date().toISOString()
    };
    if (mode === 'browser') {
      store.drive.refreshToken = '';
      store.drive.account = '';
    }
    write(store);
    return status().drive;
  }

  /** Server mode: turn the one-time authorization code into a refresh token. */
  async function exchangeDriveCode(req, input) {
    requireLocal(req);
    const store = read();
    if (!store.drive.clientId || !store.drive.clientSecret) {
      throw new ConnectionError(400, 'DRIVE_SERVER_NOT_READY', 'Save the client ID, client secret and choose server mode first.');
    }
    const code = String((input && input.code) || '').trim();
    if (!code) throw new ConnectionError(400, 'DRIVE_CODE_REQUIRED', 'Paste the ?code= value from the redirect URL.');
    const redirectUri = String((input && input.redirectUri) || '').trim();
    if (!/^https?:\/\/[^\s]+$/.test(redirectUri)) {
      throw new ConnectionError(400, 'DRIVE_REDIRECT_REQUIRED', 'The redirect URI must match the one registered in Google Cloud (for example https://your-tunnel.example/oauth2callback).');
    }

    const body = new URLSearchParams({
      code,
      client_id: store.drive.clientId,
      client_secret: store.drive.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    let response;
    try {
      response = await doFetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new ConnectionError(502, 'DRIVE_OAUTH_UNREACHABLE', 'Could not reach Google to finish the connection.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.refresh_token) {
      const reason = (payload && (payload.error_description || payload.error)) || `HTTP ${response.status}`;
      throw new ConnectionError(400, 'DRIVE_CODE_REJECTED', `Google refused the authorization code: ${reason}. Codes expire in minutes and each can be used once.`);
    }

    store.drive = { ...store.drive, refreshToken: payload.refresh_token, savedAt: new Date().toISOString() };
    if (payload.scope && !String(payload.scope).includes('drive.file')) {
      // keep it, but say so — the user may have granted something broader
      store.drive.grantedScope = String(payload.scope);
    }
    write(store);

    try {
      const account = await driveFetch(store, '/about?fields=user(emailAddress,displayName)', { retryOnce: true });
      store.drive.account = (account && account.user && (account.user.emailAddress || account.user.displayName)) || '';
      write(store);
    } catch (error) { /* account label is a nicety, not a requirement */ }

    return status().drive;
  }

  async function driveAccessToken(store) {
    if (!store.drive.refreshToken) {
      throw new ConnectionError(400, 'DRIVE_NOT_AUTHORIZED', 'Connect Google Drive first.');
    }
    const body = new URLSearchParams({
      client_id: store.drive.clientId,
      client_secret: store.drive.clientSecret,
      refresh_token: store.drive.refreshToken,
      grant_type: 'refresh_token'
    });
    let response;
    try {
      response = await doFetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new ConnectionError(502, 'DRIVE_OAUTH_UNREACHABLE', 'Could not reach Google to refresh the Drive token.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.access_token) {
      const reason = (payload && (payload.error_description || payload.error)) || `HTTP ${response.status}`;
      throw new ConnectionError(401, 'DRIVE_REFRESH_FAILED', `Google refused the saved Drive authorization (${reason}). Reconnect Drive.`);
    }
    return payload.access_token;
  }

  async function driveFetch(store, pathname, options = {}) {
    const token = options.token || await driveAccessToken(store);
    let response;
    try {
      response = await doFetch(`${DRIVE_API}${pathname}`, {
        method: options.method || 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
        body: options.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new ConnectionError(502, 'DRIVE_UNREACHABLE', 'Could not reach Google Drive.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (payload && payload.error && payload.error.message) || `HTTP ${response.status}`;
      throw new ConnectionError(response.status === 401 ? 401 : 502, 'DRIVE_ERROR', `Google Drive said: ${message}`);
    }
    return payload;
  }

  /** Server-mode upload of a text/markdown draft. */
  async function uploadToDrive(input) {
    const store = read();
    if (!store.drive.refreshToken) {
      throw new ConnectionError(400, 'DRIVE_NOT_AUTHORIZED', 'Server-side Drive is not authorized yet. Finish the OAuth step in Connections.');
    }
    const name = String((input && input.name) || '').trim() || 'Jenni draft.md';
    const content = String((input && input.content) || '');
    if (!content.trim()) throw new ConnectionError(400, 'TEXT_REQUIRED', 'This draft is empty.');
    if (Buffer.byteLength(content) > UPLOAD_LIMIT_BYTES) {
      throw new ConnectionError(413, 'DRAFT_TOO_LARGE', 'Drafts over 2 MB are not uploaded.');
    }

    const boundary = `jenni${Date.now().toString(36)}`;
    const metadata = { name, mimeType: 'text/markdown' };
    if (store.drive.folderId) metadata.parents = [store.drive.folderId];

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n`),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const token = await driveAccessToken(store);
    let response;
    try {
      response = await doFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new ConnectionError(502, 'DRIVE_UNREACHABLE', 'Could not reach Google Drive to upload.');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (payload && payload.error && payload.error.message) || `HTTP ${response.status}`;
      throw new ConnectionError(502, 'DRIVE_UPLOAD_FAILED', `Google Drive said: ${message}`);
    }
    return { ok: true, id: payload.id, name: payload.name, link: payload.webViewLink || '' };
  }

  async function listDrive() {
    const store = read();
    if (!store.drive.refreshToken) {
      throw new ConnectionError(400, 'DRIVE_NOT_AUTHORIZED', 'Server-side Drive is not authorized yet.');
    }
    const result = await driveFetch(store, '/files?pageSize=20&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,webViewLink)&q=trashed%3Dfalse');
    return { files: (result && result.files) || [] };
  }

  function disconnectDrive(req) {
    requireLocal(req);
    const store = read();
    const had = Boolean(store.drive.refreshToken || store.drive.clientId);
    store.drive = {
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      mode: 'off',
      folderId: '',
      account: '',
      savedAt: ''
    };
    write(store);
    return { cleared: had };
  }

  return {
    status,
    read,
    clearAll,
    // telegram
    findChats,
    saveTelegram,
    testTelegram,
    sendTelegram,
    disconnectTelegram,
    // drive
    saveDrive,
    exchangeDriveCode,
    uploadToDrive,
    listDrive,
    disconnectDrive,
    DRIVE_SCOPE,
    storeFile
  };
}

module.exports = { createConnections, ConnectionError, MESSAGE_LIMIT, UPLOAD_LIMIT_BYTES, DRIVE_SCOPE_URI: 'https://www.googleapis.com/auth/drive.file' };
