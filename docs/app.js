/* ============================================================================
   Jenni — phone app, no server.
   Everything runs in the browser: the AI request goes straight from this
   device to the provider you picked. There is no Jenni backend, so the key
   never leaves the phone.
   ========================================================================= */
(function () {
  'use strict';

  /* ── storage keys ──────────────────────────────────────────────────────── */
  const LS = {
    config: 'jenni_cfg_v1',
    drafts: 'jenni_drafts_v1',
    chat: 'jenni_chat_v1',
    drive: 'jenni_drive_v1',   // client id only
    driveToken: 'jenni_drive_tok_v1' // access token + expiry (session-ish)
  };

  const PRESETS = {
    groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', transcribe: 'whisper-large-v3', keyUrl: 'https://console.groq.com/keys' },
    gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', transcribe: '', keyUrl: 'https://aistudio.google.com/app/apikey' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', transcribe: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', transcribe: '', keyUrl: 'https://openrouter.ai/keys' },
    custom: { label: 'Custom', baseUrl: '', model: '', transcribe: '', keyUrl: '' }
  };

  const $ = (id) => document.getElementById(id);
  const now = () => Date.now();

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Tiny markdown: bold, inline code, links, line breaks. Everything is
     escaped first, so a model reply can never inject markup. */
  function renderMd(text) {
    let out = escapeHtml(text || '');
    out = out.replace(/```([\s\S]*?)```/g, (m, code) => `\n<code>${code.trim()}</code>\n`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      toast('Phone ki storage bhar gayi. Purane drafts delete karo.', true);
      return false;
    }
  }

  /* ── toast ─────────────────────────────────────────────────────────────── */
  let toastTimer = null;
  function toast(message, isError) {
    const host = $('toastHost');
    if (!host) return;
    host.textContent = '';
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' is-error' : '');
    el.textContent = message;
    host.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3400);
  }

  /* ── state ─────────────────────────────────────────────────────────────── */
  const state = {
    cfg: readJson(LS.config, null),
    drafts: readJson(LS.drafts, []),
    chat: readJson(LS.chat, []),
    drive: readJson(LS.drive, { clientId: '' }),
    driveToken: readJson(LS.driveToken, null),
    busy: false,
    listening: false,
    recorder: null,
    chunks: []
  };

  /* ══════════════════════════════════════════════════════════════ CONFIG */

  function normalizeBaseUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      if (url.username || url.password || url.search || url.hash) return null;
      if (url.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(url.hostname)) return null;
      return raw;
    } catch (error) {
      return null;
    }
  }

  function validateConfig(input) {
    const errors = [];
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!baseUrl) errors.push('Base URL https:// se shuru hona chahiye.');
    const model = String(input.model || '').trim();
    if (!model) errors.push('Model ka naam chahiye.');
    const apiKey = String(input.apiKey || '').trim();
    if (!apiKey) errors.push('API key chahiye.');
    else if (apiKey.length < 8) errors.push('API key bahut chhoti lag rahi hai.');
    else if (/\s/.test(apiKey)) errors.push('API key me space nahi hota.');
    return { ok: errors.length === 0, errors, value: { baseUrl, model, apiKey, transcribe: String(input.transcribe || '').trim(), provider: input.provider || 'custom' } };
  }

  function saveConfig(cfg) {
    state.cfg = cfg;
    return writeJson(LS.config, cfg);
  }

  function providerName() {
    const key = state.cfg && state.cfg.provider;
    return (PRESETS[key] && PRESETS[key].label) || 'Custom';
  }

  /* ══════════════════════════════════════════════════════════════ THE AI */

  async function callProvider(messages, options = {}) {
    const cfg = state.cfg;
    if (!cfg || !cfg.apiKey) throw new Error('Pehle Setup me API key daalo.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);

    try {
      const response = await fetch(cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.6
        }),
        signal: controller.signal
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const detail = payload && payload.error && (payload.error.message || payload.error.code);
        if (response.status === 401 || response.status === 403) {
          throw new Error('Key galat ya expired hai. Provider dashboard se nayi key lo.');
        }
        if (response.status === 429) {
          throw new Error('Provider ki limit lag gayi (429). Thodi der baad try karo, ya doosra provider chuno.');
        }
        throw new Error(detail || `Provider ne error diya (HTTP ${response.status}).`);
      }

      const choice = payload && payload.choices && payload.choices[0];
      const content = choice && choice.message && choice.message.content;
      if (!content) throw new Error('Provider ne khali jawab bheja.');
      return String(content).trim();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Jawab aane me bahut der lagi — dobara try karo.');
      if (error instanceof TypeError) {
        throw new Error('Provider tak nahi pahunch paye. Internet check karo, ya Base URL galat hai.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const SYSTEM_PROMPT = [
    'You are Jenni, a friendly assistant on the user\'s phone.',
    'Reply in the language the user writes in — Hinglish in, Hinglish out, Hindi in Hindi out, English in English out.',
    'Keep answers short and useful on a small screen: no long intros, no repeating the question.',
    'Never ask for or repeat API keys, passwords or personal identifiers.'
  ].join(' ');

  function conversationForApi(userText) {
    const history = state.chat.slice(-10).map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.text }));
    return [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: userText }];
  }

  /* ══════════════════════════════════════════════════════════════ CHAT UI */

  function paintChat() {
    const wrap = $('messages');
    wrap.innerHTML = '';
    const empty = $('chatEmpty');
    if (empty) empty.hidden = state.chat.length > 0;

    state.chat.forEach((message) => {
      wrap.appendChild(messageNode(message));
    });
    scrollChat();
  }

  function messageNode(message) {
    const row = document.createElement('div');
    row.className = 'msg msg--' + (message.role === 'me' ? 'me' : 'jenni');

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (message.pending) {
      bubble.classList.add('is-thinking');
      bubble.innerHTML = '<i></i><i></i><i></i>';
    } else if (message.role === 'me') {
      bubble.textContent = message.text;
    } else {
      bubble.innerHTML = renderMd(message.text);
    }
    row.appendChild(bubble);

    if (message.role === 'jenni' && !message.pending && message.text) {
      const foot = document.createElement('div');
      foot.className = 'msg__foot';

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'msg__tool';
      save.textContent = 'Save draft';
      save.addEventListener('click', () => {
        saveDraft(message.text);
        save.textContent = 'Saved ✓';
        save.disabled = true;
      });

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'msg__tool';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(message.text);
          copy.textContent = 'Copied ✓';
        } catch (error) {
          copy.textContent = 'Copy nahi hua';
        }
        setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
      });

      foot.append(save, copy);
      row.appendChild(foot);
    }

    return row;
  }

  function scrollChat(smooth) {
    const box = $('chatScroll');
    if (!box) return;
    requestAnimationFrame(() => {
      box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  function setStatus(kind, text) {
    const dot = $('brandDot');
    const meta = $('brandMeta');
    const foot = $('composerFoot');
    if (dot) {
      dot.className = 'brand__dot' + (kind === 'ok' ? ' is-ok' : kind === 'busy' ? ' is-busy' : kind === 'error' ? ' is-error' : '');
    }
    if (meta) meta.textContent = text || 'ready';
    if (foot) {
      foot.className = 'composer__foot' + (kind === 'busy' ? ' is-busy' : kind === 'error' ? ' is-error' : '');
      foot.textContent = kind === 'busy' ? 'Jenni soch rahi hai…' : kind === 'error' ? 'Kuch galat hua — neeche dekho' : 'Ready';
    }
  }

  async function send(text) {
    const clean = String(text || '').trim();
    if (!clean || state.busy) return;
    if (!state.cfg || !state.cfg.apiKey) {
      openSheet('setup');
      setResult('setupResult', 'Pehle API key daal ke Save dabao.', 'error');
      return;
    }

    state.busy = true;
    $('input').value = '';
    autoGrow($('input'));
    $('btnSend').disabled = true;

    state.chat.push({ role: 'me', text: clean });
    const pending = { role: 'jenni', text: '', pending: true };
    state.chat.push(pending);
    paintChat();
    setStatus('busy');

    try {
      const reply = await callProvider(conversationForApi(clean));
      pending.pending = false;
      pending.text = reply;
      setStatus('ok', providerName() + ' · ' + state.cfg.model);
    } catch (error) {
      pending.pending = false;
      pending.text = 'Maaf karo, jawab nahi mila.\n\n' + error.message;
      setStatus('error');
      speak('Maaf karo, jawab nahi mila. ' + error.message);
    } finally {
      state.busy = false;
      $('btnSend').disabled = false;
      writeJson(LS.chat, state.chat.filter((m) => !m.pending));
      paintChat();
      maybeSpeakLast();
    }
  }

  /* Voice output — only when the user turned it on. */
  function maybeSpeakLast() {
    const last = state.chat[state.chat.length - 1];
    if (!last || last.role !== 'jenni' || !last.text) return;
    if (localStorage.getItem('jenni_speak') !== '1') return;
    speak(last.text);
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    try {
      const clean = String(text).replace(/[*_`#>]/g, '').slice(0, 600);
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = /[\u0900-\u097F]/.test(clean) ? 'hi-IN' : 'en-IN';
      utterance.rate = 1;
      window.speechSynthesis.speak(utterance);
    } catch (error) { /* speech is optional */ }
  }

  /* ══════════════════════════════════════════════════════════════ VOICE IN */

  function speechRecognition() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  async function startListening() {
    const Recognition = speechRecognition();
    if (Recognition) {
      const recognition = new Recognition();
      recognition.lang = /[\u0900-\u097F]/.test($('input').value) ? 'hi-IN' : 'en-IN';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        state.listening = true;
        $('btnMic').classList.add('is-live');
        setStatus('busy', 'Sun rahi hoon…');
      };
      recognition.onerror = (event) => {
        state.listening = false;
        $('btnMic').classList.remove('is-live');
        setStatus('ok', providerName() + ' · ' + state.cfg.model);
        if (event.error === 'not-allowed') toast('Microphone ki permission chahiye.', true);
        else if (event.error !== 'aborted') toast('Awaaz samajh nahi aayi. Dobara try karo.', true);
      };
      recognition.onresult = (event) => {
        const said = event.results[0][0].transcript;
        $('input').value = said;
        autoGrow($('input'));
        send(said);
      };
      recognition.onend = () => {
        state.listening = false;
        $('btnMic').classList.remove('is-live');
      };
      try { recognition.start(); } catch (error) { toast('Mic abhi shuru nahi ho paya.', true); }
      return;
    }
    toast('Is browser me speech-to-text nahi hai. Chrome par kholo.');
  }

  /* ══════════════════════════════════════════════════════════════ DRAFTS */

  function saveDraft(text) {
    const title = String(text).split('\n')[0].replace(/[#*_`>]/g, '').trim().slice(0, 60) || 'Draft';
    state.drafts.unshift({ id: String(now()), title, text, at: new Date().toISOString() });
    state.drafts = state.drafts.slice(0, 200);
    writeJson(LS.drafts, state.drafts);
    paintDrafts();
    toast('Draft save ho gaya');
  }

  function paintDrafts() {
    const list = $('draftList');
    if (!list) return;
    if (!state.drafts.length) {
      list.innerHTML = '<p class="empty">Abhi koi draft nahi. Chat me kisi jawab par <strong>Save draft</strong> dabao.</p>';
      return;
    }
    list.innerHTML = state.drafts.map((d) => `
      <article class="card">
        <span class="card__title">${escapeHtml(d.title)}</span>
        <span class="card__meta">${new Date(d.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <p class="card__body">${escapeHtml(d.text)}</p>
        <div class="card__actions">
          <button class="btn btn--small" type="button" data-copy="${d.id}">Copy</button>
          <button class="btn btn--small" type="button" data-send="${d.id}">Chat me bhejo</button>
          <button class="btn btn--small" type="button" data-drive="${d.id}">Drive</button>
          <button class="btn btn--small btn--ghost" type="button" data-del="${d.id}">Delete</button>
        </div>
      </article>`).join('');

    list.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyDraft(b.dataset.copy)));
    list.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', () => {
      closeSheets();
      $('input').value = draftById(b.dataset.send).text;
      autoGrow($('input'));
      $('input').focus();
    }));
    list.querySelectorAll('[data-drive]').forEach((b) => b.addEventListener('click', () => uploadDraft(b.dataset.send)));
    list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      state.drafts = state.drafts.filter((d) => d.id !== b.dataset.del);
      writeJson(LS.drafts, state.drafts);
      paintDrafts();
    }));
  }

  function draftById(id) {
    return state.drafts.find((d) => d.id === id) || { title: 'Draft', text: '' };
  }

  async function copyDraft(id) {
    try {
      await navigator.clipboard.writeText(draftById(id).text);
      toast('Copy ho gaya');
    } catch (error) {
      toast('Copy nahi hua — text select karke copy karo.', true);
    }
  }

  /* ══════════════════════════════════════════════════════════════ DRIVE */

  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  let gisPromise = null;

  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Google login load nahi hua. Internet check karo.'));
      document.head.appendChild(script);
    });
    return gisPromise;
  }

  function driveReady() {
    return Boolean(state.drive && state.drive.clientId);
  }

  function saveClientId() {
    const value = $('clientId').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(value)) {
      setResult('driveResult', 'Client ID .apps.googleusercontent.com par khatam hota hai.', 'error');
      return;
    }
    state.drive = { clientId: value };
    writeJson(LS.drive, state.drive);
    paintDrive();
    setResult('driveResult', 'Client ID save ho gaya. Ab Connect Google dabao.', 'ok');
  }

  function requestDriveToken() {
    return new Promise((resolve, reject) => {
      if (!driveReady()) { reject(new Error('Pehle client ID save karo.')); return; }
      loadGis().then(() => {
        try {
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: state.drive.clientId,
            scope: DRIVE_SCOPE,
            callback: (response) => {
              if (response && response.access_token) {
                state.driveToken = { token: response.access_token, expires: now() + (Number(response.expires_in || 3600) - 60) * 1000 };
                writeJson(LS.driveToken, state.driveToken);
                resolve(state.driveToken.token);
              } else {
                reject(new Error('Google ne permission nahi di.'));
              }
            },
            error_callback: (error) => reject(new Error((error && error.message) || 'Google connect nahi hua.'))
          });
          client.requestAccessToken({ prompt: state.driveToken ? '' : 'consent' });
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    });
  }

  async function driveTokenOrAsk() {
    if (state.driveToken && state.driveToken.expires > now()) return state.driveToken.token;
    return requestDriveToken();
  }

  async function connectDrive() {
    setResult('driveResult', 'Google se permission maang rahe hain…', 'busy');
    try {
      await requestDriveToken();
      paintDrive();
      setResult('driveResult', 'Drive connect ho gaya. Ab drafts upload kar sakte ho.', 'ok');
      await listDriveFiles();
    } catch (error) {
      setResult('driveResult', error.message, 'error');
    }
  }

  function disconnectDrive() {
    state.driveToken = null;
    localStorage.removeItem(LS.driveToken);
    paintDrive();
    setResult('driveResult', 'Drive disconnect ho gaya.', 'ok');
  }

  async function uploadDraft(id) {
    const draft = draftById(id);
    if (!driveReady()) {
      toast('Pehle Drive tab me client ID daalo.', true);
      openSheet('drive');
      return;
    }
    try {
      const token = await driveTokenOrAsk();
      toast('Drive par upload ho raha hai…');
      const boundary = 'jenni' + now();
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: draft.title.replace(/[/\\]/g, '-') + '.md' }) +
        `\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${draft.text}\r\n--${boundary}--`;

      const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) {
          state.driveToken = null;
          localStorage.removeItem(LS.driveToken);
        }
        throw new Error((payload && payload.error && payload.error.message) || `Upload fail (HTTP ${response.status}).`);
      }
      toast('Drive par save ho gaya: ' + payload.name);
      await listDriveFiles();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function listDriveFiles() {
    const box = $('driveFiles');
    if (!box) return;
    if (!driveReady() || !state.driveToken || state.driveToken.expires <= now()) {
      box.innerHTML = '<p class="empty">Connect karne par yahan files dikhengi.</p>';
      return;
    }
    try {
      const response = await fetch(
        'https://www.googleapis.com/drive/v3/files?pageSize=20&orderBy=modifiedTime desc&q=trashed%3Dfalse&fields=files(id,name,modifiedTime,webViewLink)',
        { headers: { Authorization: `Bearer ${state.driveToken.token}` } }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || 'Files nahi mile.');
      const files = (payload && payload.files) || [];
      box.innerHTML = files.length
        ? files.map((f) => `
            <article class="card">
              <a class="card__title" href="${escapeHtml(f.webViewLink || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(f.name || 'Untitled')}</a>
              <span class="card__meta">${escapeHtml((f.modifiedTime || '').slice(0, 10))}</span>
            </article>`).join('')
        : '<p class="empty">Abhi koi file nahi.</p>';
    } catch (error) {
      box.innerHTML = '<p class="empty">' + escapeHtml(error.message) + '</p>';
    }
  }

  function paintDrive() {
    const ok = driveReady();
    const badge = $('driveStatus');
    const text = $('driveStatusText');
    if (badge) badge.className = 'status' + (ok ? ' is-ok' : '');
    if (text) text.textContent = ok
      ? (state.driveToken && state.driveToken.expires > now() ? 'Connected' : 'Client ID saved — connect karo')
      : 'Not set up';
    if ($('clientId')) $('clientId').value = (state.drive && state.drive.clientId) || '';
    const originHint = $('originHint');
    if (originHint) originHint.textContent = location.origin;
  }

  /* ══════════════════════════════════════════════════════════════ SETUP UI */

  function fillSetupForm() {
    const cfg = state.cfg || {};
    if ($('apiKey')) $('apiKey').value = cfg.apiKey || '';
    if ($('baseUrl')) $('baseUrl').value = cfg.baseUrl || PRESETS.groq.baseUrl;
    if ($('model')) $('model').value = cfg.model || PRESETS.groq.model;
    if ($('transcribe')) $('transcribe').value = cfg.transcribe || PRESETS.groq.transcribe;
    paintProvGrid(cfg.provider || 'groq');
    paintSetupStatus();
  }

  function paintProvGrid(active) {
    const grid = $('provGrid');
    if (!grid) return;
    grid.innerHTML = Object.entries(PRESETS).map(([key, preset]) => `
      <button class="prov${key === active ? ' is-on' : ''}" type="button" data-preset="${key}">
        <strong>${escapeHtml(preset.label)}</strong>
        <span>${escapeHtml(preset.keyUrl ? 'key chahiye' : 'khud bharo')}</span>
      </button>`).join('');
    grid.querySelectorAll('[data-preset]').forEach((button) => {
      button.addEventListener('click', () => applyPreset(button.dataset.preset));
    });
  }

  function applyPreset(key) {
    const preset = PRESETS[key];
    if (!preset) return;
    state.pendingProvider = key;
    if ($('baseUrl')) $('baseUrl').value = preset.baseUrl;
    if ($('model')) $('model').value = preset.model;
    if ($('transcribe')) $('transcribe').value = preset.transcribe;
    paintProvGrid(key);
    if (preset.keyUrl) setResult('setupResult', 'Key yahan se le sakte ho: ' + preset.keyUrl, 'ok');
  }

  function paintSetupStatus() {
    const badge = $('setupStatus');
    const text = $('setupStatusText');
    const has = Boolean(state.cfg && state.cfg.apiKey);
    if (badge) badge.className = 'status' + (has ? ' is-ok' : '');
    if (text) text.textContent = has ? `${providerName()} · ${state.cfg.model}` : 'No key saved';
  }

  function saveSettingsFromForm() {
    const provider = state.pendingProvider || (state.cfg && state.cfg.provider) || 'groq';
    const result = validateConfig({
      apiKey: $('apiKey').value,
      baseUrl: $('baseUrl').value,
      model: $('model').value,
      transcribe: $('transcribe').value,
      provider
    });
    if (!result.ok) {
      setResult('setupResult', result.errors[0], 'error');
      return null;
    }
    saveConfig(result.value);
    paintSetupStatus();
    setStatus('ok', providerName() + ' · ' + result.value.model);
    setResult('setupResult', 'Save ho gaya. Ab "Test connection" dabao.', 'ok');
    return result.value;
  }

  async function testConnection() {
    const cfg = saveSettingsFromForm();
    if (!cfg) return;
    setResult('setupResult', 'Provider se baat kar rahe hain…', 'busy');
    const started = now();
    try {
      const reply = await callProvider([{ role: 'user', content: 'Reply with the single word: ok' }], { timeoutMs: 25000 });
      const ms = now() - started;
      setResult('setupResult', `Chal raha hai ✓ (${ms} ms) — model ne kaha: "${reply.slice(0, 40)}"`, 'ok');
      setStatus('ok', providerName() + ' · ' + cfg.model);
    } catch (error) {
      setResult('setupResult', error.message, 'error');
      setStatus('error');
    }
  }

  function setResult(id, message, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.className = 'room-result' + (kind === 'ok' ? ' is-ok' : kind === 'error' ? ' is-error' : kind === 'busy' ? ' is-busy' : '');
  }

  /* ══════════════════════════════════════════════════════════════ EXPORT */

  function exportData() {
    const data = { drafts: state.drafts, config: state.cfg ? { ...state.cfg, apiKey: '' } : null, drive: state.drive, at: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'jenni-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast('Backup download ho gaya (key shaamil nahi hai)');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (Array.isArray(data.drafts)) {
          const known = new Set(state.drafts.map((d) => d.id));
          state.drafts = [...data.drafts.filter((d) => d && d.id && !known.has(d.id)), ...state.drafts];
          writeJson(LS.drafts, state.drafts);
          paintDrafts();
        }
        toast('Import ho gaya');
      } catch (error) {
        toast('File padhi nahi ja saki.', true);
      }
    };
    reader.readAsText(file);
  }

  /* ══════════════════════════════════════════════════════════════ SHEETS */

  function openSheet(name) {
    closeSheets();
    const sheet = $('sheet-' + name);
    if (!sheet) return;
    $('scrim').hidden = false;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    if (name === 'drafts') paintDrafts();
    if (name === 'drive') { paintDrive(); listDriveFiles(); }
    if (name === 'setup') fillSetupForm();
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === name));
  }

  function closeSheets() {
    $('scrim').hidden = true;
    document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
    document.body.style.overflow = '';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === 'chat'));
  }

  /* ══════════════════════════════════════════════════════════════ WIRING */

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }

  function showApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
    const cfg = state.cfg;
    setStatus(cfg && cfg.apiKey ? 'ok' : '', cfg && cfg.apiKey ? providerName() + ' · ' + cfg.model : 'setup needed');
    paintChat();
    paintDrive();
    paintDrafts();
    if (!cfg || !cfg.apiKey) setTimeout(() => openSheet('setup'), 350);
  }

  function wireGate() {
    document.querySelectorAll('#gateBody [data-provider]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.provider;
        const preset = PRESETS[key];
        document.querySelectorAll('#gateBody [data-provider]').forEach((b) => b.classList.toggle('is-on', b === button));
        state.pendingProvider = key;
        $('setupBase').value = preset.baseUrl;
        $('setupModel').value = preset.model;
        $('setupTranscribe').value = preset.transcribe;
        $('gateKeyLink').href = preset.keyUrl || '#';
        $('gateKeyLink').textContent = preset.keyUrl ? preset.label + ' par key banayein' : 'Provider docs';
      });
    });

    $('btnSetupReveal').addEventListener('click', () => {
      const input = $('setupKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('btnSetupReveal').classList.toggle('is-on', show);
    });

    $('btnSaveKey').addEventListener('click', () => {
      const provider = state.pendingProvider || 'groq';
      const result = validateConfig({
        apiKey: $('setupKey').value,
        baseUrl: $('setupBase').value,
        model: $('setupModel').value,
        transcribe: $('setupTranscribe').value,
        provider
      });
      if (!result.ok) {
        setResult('gateResult', result.errors[0], 'error');
        return;
      }
      saveConfig(result.value);
      setResult('gateResult', '', '');
      showApp();
      setStatus('ok', providerName() + ' · ' + result.value.model);
      toast('Key save ho gayi — sirf is phone me');
    });

    $('gateSkip').addEventListener('click', (event) => {
      event.preventDefault();
      showApp();
      openSheet('setup');
    });
  }

  function wireApp() {
    $('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      send($('input').value);
    });

    $('input').addEventListener('input', () => autoGrow($('input')));
    $('input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && window.innerWidth > 719) {
        event.preventDefault();
        send($('input').value);
      }
    });

    $('btnMic').addEventListener('click', () => {
      if (state.listening) { window.speechSynthesis && window.speechSynthesis.cancel(); return; }
      startListening();
    });

    $('btnOpenSetup').addEventListener('click', () => openSheet('setup'));

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        if (name === 'chat') closeSheets();
        else openSheet(name);
      });
    });

    $('scrim').addEventListener('click', closeSheets);
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

    $('suggestions').querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => send(button.textContent));
    });

    /* setup */
    $('btnRevealKey').addEventListener('click', () => {
      const input = $('apiKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('btnRevealKey').classList.toggle('is-on', show);
    });
    $('btnSave').addEventListener('click', () => { saveSettingsFromForm(); });
    $('btnTest').addEventListener('click', testConnection);
    $('btnForget').addEventListener('click', () => {
      state.cfg = null;
      localStorage.removeItem(LS.config);
      if ($('apiKey')) $('apiKey').value = '';
      paintSetupStatus();
      setStatus('', 'setup needed');
      setResult('setupResult', 'Key delete ho gayi.', 'ok');
    });
    $('btnExport').addEventListener('click', exportData);
    $('btnImport').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importData(file);
      event.target.value = '';
    });

    /* voice output */
    const speakBox = $('speakToggle');
    if (speakBox) {
      speakBox.checked = localStorage.getItem('jenni_speak') === '1';
      speakBox.addEventListener('change', () => {
        localStorage.setItem('jenni_speak', speakBox.checked ? '1' : '0');
        if (!speakBox.checked && window.speechSynthesis) window.speechSynthesis.cancel();
        toast(speakBox.checked ? 'Jawab bol kar sunaya jayega' : 'Voice output band');
      });
    }

    /* drive */
    $('btnDriveSave').addEventListener('click', saveClientId);
    $('btnDriveConnect').addEventListener('click', connectDrive);
    $('btnDriveOff').addEventListener('click', disconnectDrive);
  }

  /* ── boot ──────────────────────────────────────────────────────────────── */
  function boot() {
    wireGate();
    wireApp();
    if (state.cfg && state.cfg.apiKey) showApp();
    else {
      state.pendingProvider = 'groq';
      document.querySelector('#gateBody [data-provider="groq"]').classList.add('is-on');
      $('setupBase').value = PRESETS.groq.baseUrl;
      $('setupModel').value = PRESETS.groq.model;
      $('setupTranscribe').value = PRESETS.groq.transcribe;
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache is optional */ });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
