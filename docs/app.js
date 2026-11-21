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
    driveToken: 'jenni_drive_tok_v1', // access token + expiry (session-ish)
    nm: 'jenni_nm_v1',         // NeverMind url + token
    nmTeam: 'jenni_nm_team_v1',
    packs: 'jenni_packs_v1',   // installed SKILL.md packs
    voiceOn: 'jenni_voice_on', // master voice switch ('0' = off)
    memory: 'jenni_memory_v1', // long-term memory (local only, wiped by panic)
    lock: 'jenni_lock_v1',     // PIN settings + config
    dk: 'jenni_dk_v1',         // salt for the data key (not secret)
    vault: 'jenni_vault_v1'    // the encrypted API key
  };

  const PRESETS = {
    groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', transcribe: 'whisper-large-v3-turbo', keyUrl: 'https://console.groq.com/keys', modelsUrl: 'https://console.groq.com/docs/models' },
    gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash', transcribe: '', keyUrl: 'https://aistudio.google.com/app/apikey', modelsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', transcribe: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys', modelsUrl: 'https://platform.openai.com/docs/models' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b:free', transcribe: '', keyUrl: 'https://openrouter.ai/keys', modelsUrl: 'https://openrouter.ai/models' },
    custom: { label: 'Custom', baseUrl: '', model: '', transcribe: '', keyUrl: '', modelsUrl: '' }
  };

  /* Model IDs this app used to ship as preset defaults. A saved config that
     still points at one of these was never chosen by hand, so it is safe to
     move it to the current default — a model the user typed is left alone. */
  const RETIRED_DEFAULTS = {
    groq: ['llama-3.3-70b-versatile', 'llama3-70b-8192', 'llama-3.1-8b-instant'],
    gemini: ['gemini-2.0-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'],
    openai: ['gpt-4o-mini', 'gpt-5-mini'],
    openrouter: ['openai/gpt-4o-mini', 'openai/gpt-4o-mini:free']
  };

  const SEC = window.JENNI_SECURITY || {};
  const DOCS = window.JENNI_DOCS || {};
  const GH = window.JENNI_GITHUB || {};
  const BRAIN = window.JENNI_BRAIN;
  const CN = window.JENNI_CONNECT;
  const $ = (id) => document.getElementById(id);
  const now = () => Date.now();

  /* Every key this app writes, so a panic wipe can be complete. */
  const ALL_KEYS = Object.values(LS).concat([
    'jenni_brief_day', 'jenni_speak', 'jenni_voice_lang', 'jenni_voice_auto', 'jenni_screen',
    'jenni_speak', 'jenni_screen', SEC.LOCK_KEY || 'jenni_lock_v1', SEC.VAULT_KEY || 'jenni_vault_v1'
  ]);

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
    memory: readJson(LS.memory, []),
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

  /**
   * Persist the config. If a PIN vault is active, the new key is re-sealed and
   * the plaintext copy is removed — a settings save must never downgrade the
   * storage to plaintext.
   */
  function saveConfig(cfg) {
    state.cfg = cfg;
    if (security.enabled && security.pin && SEC.seal) {
      SEC.seal(security.pin, JSON.stringify(cfg))
        .then((sealed) => {
          try {
            localStorage.setItem(LS.vault, JSON.stringify(sealed));
            localStorage.removeItem(LS.config);
          } catch (error) { /* private mode */ }
        })
        .catch(() => writeJson(LS.config, cfg));
      return true;
    }
    return writeJson(LS.config, cfg);
  }

  /**
   * If the saved config still uses a model id that this app shipped as a
   * preset default (and has since replaced), move it to the current default.
   * Returns the new model name when it changed, otherwise null.
   */
  function migratePresetModel() {
    const cfg = state.cfg;
    if (!cfg || !cfg.model || !cfg.provider) return null;
    const retired = RETIRED_DEFAULTS[cfg.provider];
    const preset = PRESETS[cfg.provider];
    if (!retired || !preset || !preset.model) return null;
    if (!retired.includes(cfg.model)) return null;
    if (preset.model === cfg.model) return null;
    const next = Object.assign({}, cfg, { model: preset.model });
    saveConfig(next);
    if (typeof paintSetupStatus === 'function') paintSetupStatus();
    return preset.model;
  }

  function providerName() {
    const key = state.cfg && state.cfg.provider;
    return (PRESETS[key] && PRESETS[key].label) || 'Custom';
  }

  /* ══════════════════════════════════════════════════════════════ THE AI */

  /**
   * Gemini 3 models 'think' before they answer: the default level is medium,
   * which costs 5-15 seconds before the first visible token and silently eats
   * the max_tokens budget (that is why replies came back empty or late).
   * OpenAI-compatible Gemini maps reasoning_effort -> thinking_level, so ask
   * for the cheapest level by model, and always give the thinking room.
   */
  const THINKING_FLOOR = {
    // 3.8 Flash cannot go below 'low'; the 3.6/3.5/Lite line accepts 'minimal'
    'gemini-3.8-flash': 'low',
    'gemini-3.8-flash-lite': 'low'
  };

  function isGemini(cfg) {
    return Boolean(cfg && /generativelanguage\.googleapis\.com/i.test(String(cfg.baseUrl || '')));
  }

  function buildRequestBody(cfg, model, messages, options) {
    const body = {
      model,
      messages,
      temperature: options.temperature || 0.8,
      max_tokens: options.maxTokens || 500
    };

    if (isGemini(cfg)) {
      const effort = THINKING_FLOOR[model] || 'minimal';
      body.reasoning_effort = effort;
      // thinking tokens are billed against max_tokens — a reply can be cut to
      // nothing if they use the whole budget. Reserve room on top of the answer.
      body.max_tokens = Number(body.max_tokens) + 1200;
      if (effort === 'minimal') delete body.temperature;   // 3.6 ignores sampling anyway
    }
    return body;
  }

  async function callProvider(messages, options = {}) {
    const cfg = state.cfg;
    if (!cfg || !cfg.apiKey) throw new Error('Pehle Setup me API key daalo.');
    const model = options.model || cfg.model;

    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);

    try {
      const response = await fetch(cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(buildRequestBody(cfg, model, messages, options)),
        signal: controller.signal
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const detail = payload && payload.error && (payload.error.message || payload.error.code);
        if (response.status === 401 || response.status === 403) {
          throw new Error('Key galat ya expired hai. Provider dashboard se nayi key lo.');
        }
        if (response.status === 429) {
          const busy = new Error('Provider ki limit lag gayi (429). Thodi der baad try karo, ya doosra provider chuno.');
          busy.code = 'BUSY';              // same "worth one more try" family
          throw busy;
        }
        if (response.status >= 500) {
          const down = new Error(`Provider ki taraf se gadbad (HTTP ${response.status}).`);
          down.code = 'HTTP_5XX';
          throw down;
        }
        if (response.status === 404) {
          // A 404 from an OpenAI-compatible endpoint almost always means the
          // model ID was retired or the base URL has an extra path segment.
          const error = new Error(`Model "${model}" provider par nahi mila (404). Ye model band ho gaya ho sakta hai — naya model chuno.`);
          error.code = 'MODEL_NOT_FOUND';
          throw error;
        }
        throw new Error(detail || `Provider ne error diya (HTTP ${response.status}).`);
      }

      const choice = payload && payload.choices && payload.choices[0];
      const content = choice && choice.message && choice.message.content;
      const finish = choice && choice.finish_reason;

      if (!content) {
        // An empty body with finish_reason=length means the budget was spent on
        // thinking before any visible token — call it a truncation, not a reply.
        const error = new Error(finish === 'length'
          ? 'Jawab budget khatam ho gaya. Dobara try karo.'
          : 'Provider ne khali jawab bheja.');
        error.code = 'EMPTY_REPLY';
        error.finish = finish;
        throw error;
      }
      const text = String(content).trim();
      if (finish === 'length') {
        const error = new Error('Jawab beech me kat gaya.');
        error.code = 'TRUNCATED';
        error.partial = text;
        throw error;
      }
      app.lastLatency = Date.now() - started;
      return text;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeout = new Error('Provider ne 60 second me jawab nahi diya. Ek baar phir bhejo.');
        timeout.code = 'TIMEOUT';
        throw timeout;
      }
      if (error instanceof TypeError) {
        const offline = new Error('Internet ya provider tak nahi pahunch paye. Connection check karo.');
        offline.code = 'NETWORK';
        throw offline;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Errors worth one more attempt on their own — the network blipped, the
     provider was busy, or the answer got cut off mid-way. */
  const RETRYABLE = new Set(['TIMEOUT', 'NETWORK', 'EMPTY_REPLY', 'TRUNCATED', 'HTTP_5XX', 'BUSY']);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Wraps callProvider with the recovery that the app promises:
   *   404 retired model  → retry once on the preset's current model, save it
   *   timeout / network / 5xx / empty → retry up to twice with a short backoff
   *   truncated answer   → ask for the rest and stitch it together
   */
  async function askProvider(messages, options = {}) {
    try {
      return await withRetries(messages, options);
    } catch (error) {
      if (error.code !== 'MODEL_NOT_FOUND' || options.noRetry) throw error;
      const cfg = state.cfg || {};
      const preset = PRESETS[cfg.provider];
      if (!preset || !preset.model || preset.model === cfg.model) throw error;

      const reply = await withRetries(messages, Object.assign({}, options, { model: preset.model, noRetry: true }));
      saveConfig(Object.assign({}, cfg, { model: preset.model }));
      if (voice.mode) stopListening();
      toast(`Purana model band tha — ab "${preset.model}" chal raha hai`, false);
      return reply;
    }
  }

  async function withRetries(messages, options) {
    let attempt = 0;
    for (;;) {
      try {
        return await callProvider(messages, options);
      } catch (error) {
        if (error.code === 'TRUNCATED' && error.partial) {
          // keep what we have and ask for the tail, so a long application still
          // arrives complete instead of failing outright
          const tail = await callProvider(
            messages.concat([
              { role: 'assistant', content: error.partial },
              { role: 'user', content: 'Jahan chhoda tha wahin se aage likho — sirf bacha hua hissa, dohrana nahi.' }
            ]),
            Object.assign({}, options, { maxTokens: 900 })
          );
          return (error.partial + '\n' + tail).trim();
        }
        const canRetry = RETRYABLE.has(error.code) && attempt < 2 && !options.noRetry;
        if (!canRetry) throw error;
        attempt += 1;
        setStatus('busy');
        await sleep(700 * attempt);
      }
    }
  }

  /* Jenni ka character. Ye sach me prompt hai, isliye concrete rakha hai:
     age + tone + rhythm + humour ke rules — "friendly assistant" jaise
     dhundhle shabdon se koi model personal nahi banta. */
  const PERSONA = {
    name: 'Jenni',
    age: '21',
    vibe: 'smarter-than-average college senior who has seen enough to be calm, kind and quick',
    lines: [
      // who she is
      'Tum Jenni ho — 21 saal ki smart, hasmukh ladki jo user ki phone par rehti hai. User ka dost ho, assistant nahi; "aap" nahi, casual "tum/yaar" wala tone (Hindi/Hinglish me).',
      // sanity + common sense
      'Neend, padhai, paisa, rishte, deadlines — real zindagi ki baat samajhti ho. Common sense lagao: jo obviously galat ya risky ho, seedha bolo, drama nahi; jo pata nahi, "pata nahi" bolo, bana kar mat likho.',
      // mood + humour
      'Hasmukh par chipku nahi: halka humour tab jab user bhi khula ho ya baat casual ho. User ka mazak pakdo aur usi tone me jawab do — wo roast kare to pyaar se wapas roast, wo serious ho to turant serious. Ek hi mazak ko repeat karke irritate mat karo.',
      // politeness without servility
      'Polite ho, par "bilkul sir", "bahut bahut dhanyavaad", "main aapki seva me haazir hoon" jaise robotic line kabhi nahi. Chhoti si "haan yaar", "arre wah", "achha sun" jaisi natural baat theek hai.',
      // speed: the voice loop depends on it
      'Fast raho: pehli line me seedha jawab, phir chahiye to ek-do line ka context. 2-4 chhote vaakya default; user ne detail maangi ho tabhi lamba likho. List sirf tab jab steps ho.',
      // language mirroring
      'Jis bhasha me user likhe/bolo usi me jawab do — Hinglish in Hinglish out, Hindi in Hindi out, English in English out. Roman Hinglish hi rakho, Devanagari me tabhi jab user Devanagari me likhe.',
      // voice-friendly output
      'Tumhara jawab voice me bhi bola jaata hai: emoji, markdown headings, tables, "*" bullet, code block — kuch nahi, jab tak user na maange. Bina maange list mat banao.',
      // accuracy and safety
      'Galat mat bolo. API key, password, OTP, bank details kabhi maango mat, kabhi repeat mat karo. Medical/legal/paisa wale serious sawaal par salah do par "doctor/lawyer se confirm karo" bolna zaroori hai. Emergency (khud ko nuksan, koi khatre me) me pehle safety, phir baat.',
      // honesty about being an AI
      'Jab seedha poochha jaye to maan lo ki tum AI ho (internet par chalne wali), par apni personality mat chhodo — insaan hone ka jhooth mat bolo.',
      // the user calls her "yes sir" style — mirror respect without grovelling
      'DOC FILE RULE: jab user doc/word/pdf/letter/application maange to seedha poora draft likho — placeholders [] me, beech me sawaal nahi. Kabhi mat bolo ki tum file nahi bana sakti ya download nahi kar sakti: phone app tumhare jawab se apne aap .docx/.txt/.md/.csv file bana kar Download button deta hai. "Main file nahi bana sakti, tum copy karo" jaisa jumla bilkul nahi — bas draft do, file app bana degi.',
      'User ke paas git/terminal nahi hai, isliye unhe clone/install karne ko mat bolo. GitHub ka public code padhna ho to tum khud jenniFetchRepo(tool) se padh sakti ho — jawab me links aur seedha code sample do.',
      'Kaam pakadne par turant haan bolo — "haan yaar, kar deti hoon", "chal, dekh rahi hoon", "ok done" — jab tak koi cheez sach me mumkin na ho. Pehle "haan" (short ack), phir kaam, phir ek line ka natija. Jhoothi confirmation mat do: jo tum nahi kar sakti (message bhejna, paisa bhejna, file save karna) usme "ye main nahi kar sakti, par tumhare liye ye kar sakti hoon…" bolo.'
    ]
  };

  function loadPacks() { return readJson(LS.packs, []); }
  function nmClient() {
    const cfg = readJson(LS.nm, null);
    return CN && cfg && cfg.url ? CN.createNeverMind(cfg) : null;
  }

  /* ── master voice switch ───────────────────────────────────────────────── */
  function voiceEnabled() { try { return localStorage.getItem(LS.voiceOn) !== '0'; } catch (e) { return true; } }
  function paintVoiceMaster() {
    const on = voiceEnabled();
    document.body.classList.toggle('voice-off', !on);
    const b = $('btnVoiceMaster');
    if (b) {
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Voice on — tap to turn off' : 'Voice off — tap to turn on');
      b.title = on ? 'Voice ON' : 'Voice OFF';
      b.querySelector('.vm-slash').style.display = on ? 'none' : '';
    }
  }
  function setVoiceEnabled(on) {
    try { localStorage.setItem(LS.voiceOn, on ? '1' : '0'); } catch (e) { /* private mode */ }
    if (!on) { stopVoiceMode(true); stopSpeaking(); }
    paintVoiceMaster();
    toast(on ? 'Voice ON' : 'Voice OFF', false);
  }

  function loadMemory() { return BRAIN ? state.memory : []; }
  function saveMemory(list) { state.memory = list; persist('memory'); paintMemory(); }

  /* ── encrypted storage for chat, drafts and memory ─────────────────────────
     With a PIN set, these live only as AES-GCM blobs (`<key>_enc`). While the
     app is locked nothing is written and nothing is held in memory. */
  const writeChain = {};
  function persist(name) {
    const key = LS[name];
    const value = name === 'chat' ? state.chat.filter((m) => !m.pending) : state[name];
    if (!security.enabled) return Promise.resolve(writeJson(key, value));
    const dataKey = security.dataKey;
    if (!dataKey) return Promise.resolve(false);              // locked: never fall back to plaintext
    writeChain[name] = (writeChain[name] || Promise.resolve())
      .then(() => SEC.encryptJson(dataKey, key, value))
      .then((blob) => { localStorage.setItem(key + '_enc', JSON.stringify(blob)); localStorage.removeItem(key); return true; })
      .catch(() => { toast('Data encrypt/save nahi ho paya', true); return false; });
    return writeChain[name];
  }
  const persistAll = () => Promise.all(['chat', 'drafts', 'memory'].map(persist));

  async function initDataKey(pin, fresh) {
    let salt = localStorage.getItem(LS.dk);
    if (!salt || fresh) { salt = SEC.newSalt(); localStorage.setItem(LS.dk, salt); }
    security.dataKey = await SEC.deriveDataKey(pin, salt);
  }

  /* Load the three stores after unlock; migrate any legacy plaintext copy. */
  async function hydrate() {
    for (const name of ['chat', 'drafts', 'memory']) {
      const key = LS[name];
      const raw = localStorage.getItem(key + '_enc');
      if (raw && security.dataKey) {
        try { state[name] = await SEC.decryptJson(security.dataKey, key, JSON.parse(raw)); }
        catch (error) { state[name] = []; toast('Ek saved data padha nahi ja saka (' + name + ')', true); }
      } else {
        state[name] = readJson(key, []);
        if (security.enabled && security.dataKey && localStorage.getItem(key)) await persist(name);   // encrypt + remove plaintext
      }
    }
  }

  function personaPrompt(userText) {
    return [
      PERSONA.lines.join(' '),
      'Aaj: ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '.',
      'Never ask for or repeat API keys, passwords or personal identifiers.',
      BRAIN ? BRAIN.buildContext({ text: userText, memories: loadMemory(), packs: CN ? CN.matchPacks(userText, loadPacks()) : [], team: readJson(LS.nmTeam, []) }) : ''
    ].join(' ');
  }

  const SYSTEM_PROMPT = personaPrompt();

  function conversationForApi(userText) {
    // Recent turns only: older messages make the first token slower and rarely help.
    const history = state.chat.slice(-8)
      .filter((m) => m.text && !m.pending && !String(m.text).startsWith('Maaf karo'))
      .map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.text }));
    return [{ role: 'system', content: personaPrompt(userText) }, ...history, { role: 'user', content: userText }];
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

      if (message.doc && DOCS.buildDocx) {
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'msg__tool msg__tool--doc';
        const ext = message.doc.format || 'docx';
        download.textContent = `⬇ Download .${ext}`;
        download.addEventListener('click', () => {
          try {
            const built = DOCS.buildFile
              ? DOCS.buildFile(message.doc.title, message.doc.text, '.' + ext)
              : { blob: DOCS.buildDocx(message.doc.title, message.doc.text), name: DOCS.docFileName(message.doc.title) };
            const blob = built.blob;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = built.name;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            download.textContent = 'Saved ✓';
          } catch (error) {
            toast('File nahi ban payi: ' + error.message, true);
          }
        });
        foot.appendChild(download);
      }

      row.appendChild(foot);
    }

    if (message.role === 'jenni' && message.failed && message.retryText) {
      const foot = document.createElement('div');
      foot.className = 'msg__foot';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'msg__tool msg__tool--retry';
      retry.textContent = 'Phir try karo';
      retry.addEventListener('click', () => {
        // drop the failed bubble so the thread does not fill with errors
        state.chat = state.chat.filter((m) => m !== message);
        paintChat();
        send(message.retryText);
      });
      foot.appendChild(retry);
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

  /** "leave application doc banao" → "Leave application 23-11-2026" */
  function docTitleFor(request, reply) {
    const heading = (String(reply).match(/^#{1,6}\s+(.+)$/m) || [])[1];
    const subject = (String(reply).match(/^\s*(?:subject|विषय)\s*[:\-]\s*(.+)$/im) || [])[1];
    const date = (String(reply).match(/\b(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\b/) || [])[1];
    const kind = (String(request).match(/\b(leave application|application|letter|email|essay|report|resume|cv|notice|note)\b/i) || [])[1];
    const base = kind || heading || subject || 'Jenni document';
    const clean = base.replace(/\s+/g, ' ').trim();
    return date ? `${clean.charAt(0).toUpperCase() + clean.slice(1)} ${date}` : clean;
  }

  /* One line a frustrated user can act on. The status strip keeps the detail. */
  function plainError(error) {
    switch (error && error.code) {
      case 'TIMEOUT': return 'Provider ne 60 second me jawab nahi diya.';
      case 'NETWORK': return 'Internet ya provider tak nahi pahunch paye.';
      case 'EMPTY_REPLY': return 'Provider ne khali jawab bheja.';
      case 'TRUNCATED': return 'Jawab beech me kat gaya.';
      case 'MODEL_NOT_FOUND': return error.message;
      default: return (error && error.message) || 'Kuch galat hua.';
    }
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

  /**
   * "anveshix/Jenni-Voice-agent- ka code dekho" → read the public repo and hand
   * the model a compact digest. A phone cannot clone or install; this is the
   * part that is actually possible in a browser, done honestly.
   */
  async function repoContextFor(text) {
    if (!GH.readRepo || !GH.looksLikeRepoRequest || !GH.looksLikeRepoRequest(text)) return '';
    const parsed = GH.parseRepo(text);
    if (!parsed) return '';
    setStatus('busy');
    try {
      const info = await GH.readRepo(`${parsed.owner}/${parsed.repo}`);
      toast(`GitHub: ${info.fullName} padh liya (${info.stars} stars)`, false);
      return `\n\n[GitHub se padha gaya repo — isi ke hisaab se jawab do, aur user ko clone/install karne ko mat bolo]\n${info.apiBlock}`;
    } catch (error) {
      return `\n\n[GitHub repo padha nahi ja saka: ${error.message}]`;
    }
  }

  async function send(text, options = {}) {
    const clean = String(text || '').trim();
    if (!clean || state.busy) return;
    if (!state.cfg || !state.cfg.apiKey) {
      openSheet('setup');
      setResult('setupResult', 'Pehle API key daal ke Save dabao.', 'error');
      return;
    }

    if (BRAIN) {
      const cmd = BRAIN.userCommand(clean);
      if (cmd) { saveMemory(BRAIN.applyOps(loadMemory(), [cmd])); toast('Yaad rakh liya', false); }
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

    let reply = '';
    try {
      // Voice: keep the reply short so speech starts fast. Typed: allow more.
      let delegated = null;
      let untrusted = false;   // external text in this turn → it may not write memory
      if (navigator.onLine === false) throw Object.assign(new Error('Internet nahi hai — connect hote hi dobara bhejna.'), { code: 'OFFLINE' });
      const nm = nmClient();
      if (nm && CN.wantsDelegation(clean)) {
        try {
          delegated = await nm.delegate(CN.stripPrefix(clean));
        } catch (error) { toast('NeverMind: ' + error.message, true); }   // fall back to plain chat
      }
      if (delegated) {
        untrusted = true;
        reply = ['NeverMind agents (' + delegated.status + '):', delegated.summary]
          .concat(delegated.files.map((f) => `[${f.name}](${f.url})`)).join('\n\n');
      } else {
        const repoContext = await repoContextFor(clean);
        untrusted = Boolean(repoContext);
        reply = await askProvider(
          conversationForApi(clean + repoContext),
          { maxTokens: voice.mode ? 260 : 600 }
        );
      }
      if (BRAIN) {
        const parsed = BRAIN.extractOps(reply);
        reply = parsed.text;
        if (parsed.ops.length && !untrusted) { saveMemory(BRAIN.applyOps(loadMemory(), parsed.ops)); toast('Memory update ho gayi', false); }
      }
      pending.pending = false;
      pending.text = reply;
      setStatus('ok', providerName() + ' · ' + state.cfg.model);
    } catch (error) {
      pending.pending = false;
      pending.failed = true;                 // drives the Retry button
      pending.text = 'Jawab nahi aaya. ' + plainError(error);
      pending.retryText = clean;             // the question to send again
      reply = '';
      setStatus('error');
    } finally {
      state.busy = false;
      $('btnSend').disabled = false;
      persist('chat');
      paintChat();
    }

    // A reply that IS a document gets a real file — whether or not the user
    // used a trigger word. Asking for it by name picks the format instead.
    if (reply && DOCS.buildFile) {
      const asked = DOCS.looksLikeDocRequest(clean);
      const isDoc = DOCS.looksLikeDocumentText(reply);
      if (asked || isDoc) {
        const last = state.chat[state.chat.length - 1];
        if (last && last.role === 'jenni') {
          const title = docTitleFor(clean, reply);
          const built = DOCS.buildFile(title, reply, asked ? clean : '');
          last.doc = { title, text: reply, format: built.format, name: built.name };
          persist('chat');
          paintChat();
          toast(`File ready (.${built.format}) — neeche Download dabao`, false);
        }
      }
    }

    // Voice mode always reads the answer; typed chat only when the user asked.
    if (options.speakAlways || voice.mode) await speak(reply);
    else maybeSpeakLast();

    if (voice.mode && !voice.stopping) scheduleListen(400);
  }

  function maybeSpeakLast() {
    const last = state.chat[state.chat.length - 1];
    if (!last || last.role !== 'jenni' || !last.text) return;
    if (localStorage.getItem('jenni_speak') !== '1') return;
    speak(last.text);
  }

  /* ══════════════════════════════════════════════════════════════ VOICE

     Hands-free loop: listen → think → speak → listen again, until the user
     stops it or the phone sleeps. Everything here is defensive because speech
     APIs differ a lot between Chrome (Android, desktop) and Safari (iOS).
     ---------------------------------------------------------------------- */

  const voice = {
    mode: false,
    listening: false,
    speaking: false,
    recognition: null,
    recorder: null,
    chunks: [],
    recordingTimer: null,
    lang: localStorage.getItem('jenni_voice_lang') || 'hi-IN',
    ttsVoice: null,
    wakeLock: null,
    lastHandled: '',
    lastHandledAt: 0,
    cooldownUntil: 0,
    stopping: false,
    restartTimer: null
  };

  const BCP = { 'hi-IN': 'hi-IN', 'en-IN': 'en-IN', 'en-US': 'en-US', 'en-GB': 'en-GB' };

  function speechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function hasRecorder() {
    return Boolean(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /* ── speech output ─────────────────────────────────────────────────────── */

  function pickVoice(lang) {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    const exact = voices.find((v) => v.lang === lang);
    if (exact) return exact;
    const prefix = lang.split('-')[0];
    return voices.find((v) => (v.lang || '').toLowerCase().startsWith(prefix)) || null;
  }

  /* Strip things a voice should not read aloud (markdown, code, urls, emoji). */
  function speakableText(raw) {
    let text = String(raw || '');
    text = text.replace(/```[\s\S]*?```/g, ' ');
    text = text.replace(/`([^`]*)`/g, '$1');
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    text = text.replace(/https?:\/\/\S+/g, ' ');
    text = text.replace(/[*_#>|]/g, '');
    text = text.replace(/^\s*[-•]\s*/gm, '');
    text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, 900);
  }

  function speak(text) {
    return new Promise((resolve) => {
      const clean = speakableText(text);
      if (!clean || !window.speechSynthesis || !voiceEnabled()) { resolve(false); return; }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(clean);
        const lang = voice.lang;
        utterance.lang = lang;
        const chosen = voice.ttsVoice || pickVoice(lang);
        if (chosen) utterance.voice = chosen;
        // A touch quicker and brighter than the phone default: this is a
        // 21-year-old chatting, not a narrator. Still easy to follow.
        utterance.rate = 1.06;
        utterance.pitch = 1.08;
        utterance.volume = 1;
        voice.speaking = true;
        paintVoiceUi();
        utterance.onend = () => { voice.speaking = false; paintVoiceUi(); resolve(true); };
        utterance.onerror = () => { voice.speaking = false; paintVoiceUi(); resolve(false); };
        window.speechSynthesis.speak(utterance);
      } catch (error) {
        voice.speaking = false;
        paintVoiceUi();
        resolve(false);
      }
    });
  }

  function stopSpeaking() {
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (error) { /* ignore */ }
    }
    voice.speaking = false;
    paintVoiceUi();
  }

  /* ── speech input (Chrome, Android, Edge) ──────────────────────────────── */

  function buildRecognition() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return null;
    const recognition = new Ctor();
    recognition.lang = voice.lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      voice.listening = true;
      paintVoiceUi();
    };

    recognition.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) setTranscript(interim, false);
      if (finalText) {
        setTranscript(finalText, true);
        handleVoiceInput(finalText);
      }
    };

    recognition.onerror = (event) => {
      voice.listening = false;
      paintVoiceUi();
      const code = event && event.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        voice.mode = false;
        paintVoiceUi();
        toast('Mic ki permission chahiye — browser settings me allow karo.', true);
        return;
      }
      if (code === 'no-speech' || code === 'aborted') {
        if (voice.mode) scheduleListen(700);
        return;
      }
      if (code === 'network') {
        toast('Speech service tak nahi pahunch paye — internet check karo.', true);
        if (voice.mode) scheduleListen(1400);
        return;
      }
      if (voice.mode) scheduleListen(900);
    };

    recognition.onend = () => {
      voice.listening = false;
      paintVoiceUi();
      // never restart while the loop is being torn down or the answer is playing
      if (voice.mode && !voice.speaking && !voice.stopping && !state.busy) scheduleListen(420);
    };

    return recognition;
  }

  function scheduleListen(delay) {
    clearTimeout(voice.restartTimer);
    voice.restartTimer = setTimeout(() => {
      if (voice.mode && !state.busy && !voice.speaking) listenOnce();
    }, delay);
  }

  function listenOnce() {
    if (!voice.mode || voice.speaking || state.busy) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) { fallbackRecording(); return; }
    try {
      if (!voice.recognition) voice.recognition = buildRecognition();
      voice.recognition.lang = voice.lang;
      voice.recognition.start();
    } catch (error) {
      /* "already started" is harmless; anything else retries shortly */
      scheduleListen(600);
    }
  }

  function stopListening() {
    if (voice.recognition) {
      try { voice.recognition.abort(); } catch (error) { /* ignore */ }
    }
    voice.listening = false;
    paintVoiceUi();
  }

  /* Tear the loop down without letting the abort's own onend restart it. */
  function haltLoop() {
    voice.stopping = true;
    clearTimeout(voice.restartTimer);
    voice.restartTimer = null;
    stopListening();
    setTimeout(() => { voice.stopping = false; }, 120);
  }

  /* ── fallback: record audio when the browser has no speech recognition ─── */

  async function fallbackRecording() {
    if (!voice.mode) return;
    if (!hasRecorder()) {
      toast('Is browser me voice input nahi chalta. Chrome par kholo.', true);
      voice.mode = false;
      paintVoiceUi();
      return;
    }
    setTranscript('Bolo… (record ho raha hai)', false);
    voice.listening = true;
    paintVoiceUi();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      voice.chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) voice.chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        voice.listening = false;
        paintVoiceUi();
        const blob = new Blob(voice.chunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 1200) { if (voice.mode) scheduleListen(500); return; }
        try {
          const said = await transcribeWithProvider(blob);
          if (said) handleVoiceInput(said);
          else if (voice.mode) scheduleListen(600);
        } catch (error) {
          toast(error.message, true);
          if (voice.mode) scheduleListen(1200);
        }
      };
      voice.recorder = recorder;
      recorder.start();
      clearTimeout(voice.recordingTimer);
      voice.recordingTimer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 6000);
    } catch (error) {
      voice.listening = false;
      voice.mode = false;
      paintVoiceUi();
      toast('Mic ki permission chahiye.', true);
    }
  }

  async function transcribeWithProvider(blob) {
    const cfg = state.cfg;
    if (!cfg || !cfg.transcribe) {
      throw new Error('Voice samajhne ke liye "Voice-to-text model" Setup me bharna hoga (jaise whisper-1).');
    }
    const form = new FormData();
    form.append('file', blob, 'voice.webm');
    form.append('model', cfg.transcribe);
    form.append('language', voice.lang.split('-')[0]);
    const response = await fetch(cfg.baseUrl + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404) {
        // the transcription model was retired → fall back to browser speech
        // rather than nagging on every single turn
        stopListening();
        throw new Error(`"${cfg.transcribe}" model band lagta hai (404). Setup me naya voice-to-text model daalo, ya usse khali chhodo.`);
      }
      throw new Error((payload && payload.error && payload.error.message) || 'Awaaz transcribe nahi hui.');
    }
    return (payload && (payload.text || '')).trim();
  }

  /* ── the loop ──────────────────────────────────────────────────────────── */

  function setTranscript(text, isFinal) {
    const bar = $('voiceTranscript');
    if (!bar) return;
    bar.textContent = text;
    bar.classList.toggle('is-final', Boolean(isFinal));
    bar.hidden = !text;
  }

  function paintVoiceUi() {
    const app = $('app');
    if (app) {
      app.classList.toggle('is-voice', voice.mode);
      app.classList.toggle('is-listening', voice.listening);
      app.classList.toggle('is-speaking', voice.speaking);
    }
    const button = $('btnVoice');
    if (button) {
      button.classList.toggle('is-live', voice.mode);
      button.setAttribute('aria-pressed', voice.mode ? 'true' : 'false');
    }
    const label = $('voiceState');
    if (label) {
      label.textContent = !voice.mode ? 'Voice mode band'
        : voice.speaking ? 'Bol rahi hoon…'
          : voice.listening ? 'Sun rahi hoon…'
            : 'Voice mode on';
    }
    const foot = $('composerFoot');
    if (foot && voice.mode) {
      foot.className = 'composer__foot is-busy';
      foot.textContent = voice.speaking ? 'Bol rahi hoon — rukna ho to 🔇 dabao' : 'Sun rahi hoon… bolo';
    }
    paintTabs();
    paintBot();
    if (voice.mode) keepAwake();
  }

  async function keepAwake() {
    if (!('wakeLock' in navigator) || voice.wakeLock) return;
    try {
      voice.wakeLock = await navigator.wakeLock.request('screen');
      voice.wakeLock.addEventListener('release', () => { voice.wakeLock = null; });
    } catch (error) {
      voice.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (voice.wakeLock) {
      try { voice.wakeLock.release(); } catch (error) { /* ignore */ }
      voice.wakeLock = null;
    }
  }

  function startVoiceMode() {
    if (!voiceEnabled()) { toast('Voice OFF hai — upar speaker button se ON karo', true); return; }
    if (!state.cfg || !state.cfg.apiKey) {
      openSheet('setup');
      setResult('setupResult', 'Voice mode ke liye pehle API key save karo.', 'error');
      return;
    }
    stopSpeaking();
    voice.mode = true;
    voice.lastHandled = '';
    localStorage.setItem('jenni_voice_auto', '1');
    setTranscript('', false);
    paintVoiceUi();
    listenOnce();
  }

  function stopVoiceMode(silent) {
    voice.mode = false;           // first, so nothing schedules a restart
    haltLoop();
    stopSpeaking();
    clearTimeout(voice.recordingTimer);
    if (voice.recorder && voice.recorder.state === 'recording') {
      try { voice.recorder.stop(); } catch (error) { /* ignore */ }
    }
    releaseWakeLock();
    setTranscript('', false);
    paintVoiceUi();
    if (!silent) toast('Voice mode band');
  }

  function toggleVoiceMode() {
    if (voice.mode) stopVoiceMode();
    else startVoiceMode();
  }

  /* A spoken message is handled exactly like a typed one, but the reply is
     always read aloud and then the mic opens again. Repeat guesses from the
     recogniser are ignored so a stray echo cannot send the same thing twice. */
  async function handleVoiceInput(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    if (!norm) return;

    // Stop words are checked first and always win — the mic often hears the
    // phone's own speaker, and an echo must never lock the user out.
    if (isStopWord(norm)) {
      stopVoiceMode();
      return;
    }

    if (now() < voice.cooldownUntil) return;
    if (norm === voice.lastHandled && now() - (voice.lastHandledAt || 0) < 8000) return;
    voice.lastHandled = norm;
    voice.lastHandledAt = now();

    voice.cooldownUntil = now() + 400;
    setTranscript(text, true);
    await send(text, { speakAlways: true, fromVoice: true });
  }

  function isStopWord(text) {
    return /^(ruko|ruk jao|band karo|band kar do|chup|chup ho jao|stop|stop it|shut up|bye|goodbye|alvida|ok bye|thats all|bas|bas karo)$/.test(text);
  }

  /* ── tester ────────────────────────────────────────────────────────────── */
  function fillVoiceList() {
    const pick = $('voicePick');
    if (!pick || !window.speechSynthesis) return;
    const all = window.speechSynthesis.getVoices() || [];
    const prefix = voice.lang.split('-')[0];
    const matching = all.filter((v) => (v.lang || '').toLowerCase().startsWith(prefix));
    const list = matching.length ? matching : all;
    const current = voice.ttsVoice && voice.ttsVoice.name;
    pick.innerHTML = '<option value="">Phone ki default awaaz</option>' + list.map((v) => `
      <option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} — ${escapeHtml(v.lang || '')}</option>`).join('');
    const chosen = list.find((v) => v.name === current) || list.find((v) => v.lang === voice.lang);
    pick.value = chosen ? chosen.name : '';
    pick.onchange = () => {
      voice.ttsVoice = list.find((v) => v.name === pick.value) || null;
      if (voice.ttsVoice) speakSample();
    };
  }

  function speakSample() {
    speak('Namaste, main Jenni hoon. Aap bol kar poochho, main bol kar jawab dungi.');
  }

  function toggleLanguage() {
    voice.lang = voice.lang === 'hi-IN' ? 'en-IN' : 'hi-IN';
    localStorage.setItem('jenni_voice_lang', voice.lang);
    if (voice.recognition) voice.recognition.lang = voice.lang;
    voice.ttsVoice = pickVoice(voice.lang);
    toast(voice.lang === 'hi-IN' ? 'Bhasha: Hindi' : 'Language: English');
    if (voice.mode) { stopListening(); scheduleListen(300); }
  }

  /* ══════════════════════════════════════════════════════════════ DRAFTS */

  function saveDraft(text) {
    const title = String(text).split('\n')[0].replace(/[#*_`>]/g, '').trim().slice(0, 60) || 'Draft';
    state.drafts.unshift({ id: String(now()), title, text, at: new Date().toISOString() });
    state.drafts = state.drafts.slice(0, 200);
    persist('drafts');
    paintDrafts();
    toast('Draft save ho gaya');
  }

  function paintMemory() {
    const host = $('memoryList');
    if (!host || !BRAIN) return;
    const list = loadMemory();
    host.textContent = '';
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'room-result';
      empty.textContent = 'Abhi kuch yaad nahi. "yaad rakho: ..." bolo ya neeche likho.';
      host.appendChild(empty);
    }
    list.slice().reverse().forEach((m) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      const st = BRAIN.taskState(m);
      label.textContent = m.cat === 'task'
        ? (st === 'overdue' ? '⚠ ' : '☐ ') + m.text + (m.due ? ' — ' + m.due + (st === 'overdue' ? ' (overdue)' : st === 'today' ? ' (aaj)' : '') : '')
        : '[' + m.cat + '] ' + m.text;
      label.style.flex = '1';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--ghost';
      del.textContent = m.cat === 'task' ? 'Done ✓' : 'Delete';
      del.addEventListener('click', () => saveMemory(loadMemory().filter((x) => x.id !== m.id)));
      row.append(label, del);
      host.appendChild(row);
    });
  }

  function paintDrafts() {
    paintBot();
    const badge = $('draftCount');
    if (badge) {
      badge.hidden = state.drafts.length === 0;
      badge.textContent = String(Math.min(state.drafts.length, 99));
    }
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
      persist('drafts');
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
    const hasId = driveReady();
    const connected = Boolean(state.driveToken && state.driveToken.expires > now());

    const badge = $('driveStatus');
    const text = $('driveStatusText');
    if (badge) badge.className = 'status' + (hasId ? ' is-ok' : '');
    if (text) {
      text.textContent = connected ? 'Connected' : hasId ? 'Client ID saved — connect karo' : 'Not connected';
    }

    /* the one link that matters: always present, always clickable */
    const link = $('driveConnectLink');
    const label = $('driveConnectLabel');
    const lead = $('driveLead');
    if (link) {
      if (!hasId) {
        link.setAttribute('href', 'https://console.cloud.google.com/apis/credentials');
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        link.dataset.action = 'setup';
      } else if (connected) {
        link.setAttribute('href', 'https://drive.google.com/drive/search?q=.md');
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        link.dataset.action = 'open';
      } else {
        link.setAttribute('href', '#connect');
        link.removeAttribute('target');
        link.dataset.action = 'connect';
      }
    }
    if (label) {
      label.textContent = !hasId
        ? 'Pehle client ID banao — link kholo'
        : connected ? 'Meri Drive files kholo' : 'Google Drive connect karo';
    }
    if (lead) {
      lead.textContent = !hasId
        ? 'Do minat ka setup: link kholo, client ID banao, niche paste karo.'
        : connected ? 'Ho gaya. Ab koi bhi draft Drive par bhej sakte ho.'
          : 'Bas ek tap — Google se permission maango.';
    }

    /* the app-bar shortcut shows a dot until Drive is connected */
    const appBadge = $('driveBadge');
    if (appBadge) {
      appBadge.hidden = connected;
      appBadge.textContent = hasId ? '!' : '+';
    }
    const quick = $('btnDriveQuick');
    if (quick) quick.classList.toggle('is-on', connected);

    if ($('clientId')) $('clientId').value = (state.drive && state.drive.clientId) || '';
    const originHint = $('originHint');
    if (originHint) originHint.textContent = location.origin;
  }

  /* The connect link behaves differently depending on how far setup has got,
     but it is always one tap away from the Drive sheet. */
  function onDriveLinkClick(event) {
    const link = $('driveConnectLink');
    if (!link) return;
    const action = link.dataset.action;
    if (action === 'connect') {
      event.preventDefault();
      connectDrive();
      return;
    }
    if (action === 'open') return;      // real Drive URL, let the browser handle it
    // setup: fall through to the Google Cloud URL, and nudge the field below
    setTimeout(() => {
      const input = $('clientId');
      if (input) input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }

  async function pasteClientId() {
    try {
      const clip = await navigator.clipboard.readText();
      const value = String(clip || '').trim();
      if (!value) { toast('Clipboard khali hai', true); return; }
      if (!/\.apps\.googleusercontent\.com$/.test(value)) {
        toast('Clipboard me client ID jaisi cheez nahi mili', true);
        return;
      }
      $('clientId').value = value;
      saveClientId();
    } catch (error) {
      toast('Paste ki permission nahi mili — haath se paste karo', true);
    }
  }

  async function copyOrigin() {
    const origin = location.origin;
    try {
      await navigator.clipboard.writeText(origin);
      toast('Origin copy ho gaya: ' + origin);
    } catch (error) {
      toast('Copy nahi hua — ' + origin, true);
    }
  }

  /* ══════════════════════════════════════════════════════════════ SETUP UI */

  /* Show only the tail of a key: enough to recognise it, not enough to use it. */
  function maskKey(key) {
    const value = String(key || '');
    if (value.length <= 8) return value ? '••••' : '';
    return value.slice(0, 3) + '••••' + value.slice(-4);
  }

  function fillSetupForm() {
    const cfg = state.cfg || {};
    // the real key stays in memory; the field shows a masked stand-in and is
    // only written when the user actually edits it (see saveSettingsFromForm)
    if ($('apiKey')) $('apiKey').value = cfg.apiKey ? maskKey(cfg.apiKey) : '';
    if ($('baseUrl')) $('baseUrl').value = cfg.baseUrl || PRESETS.groq.baseUrl;
    if ($('model')) $('model').value = cfg.model || PRESETS.groq.model;
    if ($('transcribe')) $('transcribe').value = cfg.transcribe || PRESETS.groq.transcribe;
    paintProvGrid(cfg.provider || 'groq');
    paintSetupStatus();
  }

  function paintModelLinks(provider) {
    const preset = PRESETS[provider] || PRESETS.groq;
    const url = preset.modelsUrl || 'https://console.groq.com/docs/models';
    ['modelListLink', 'setupModelListLink'].forEach((id) => {
      const link = $(id);
      if (link) link.href = url;
    });
  }

  function paintProvGrid(active) {
    paintModelLinks(active);
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
    const typed = $('apiKey').value;
    // untouched field still holds the mask → keep the key that is already saved
    const apiKey = /•/.test(typed) && state.cfg && state.cfg.apiKey ? state.cfg.apiKey : typed;
    const result = validateConfig({
      apiKey,
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
    setResult('setupResult', security.enabled ? 'Save ✓ (key encrypted)' : 'Save ✓ — PIN lagao', 'ok');
    return result.value;
  }

  async function testConnection() {
    const cfg = saveSettingsFromForm();
    if (!cfg) return;
    setResult('setupResult', 'Provider se baat kar rahe hain…', 'busy');
    const started = now();
    try {
      const reply = await askProvider([{ role: 'user', content: 'Reply with the single word: ok' }], { timeoutMs: 25000 });
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
          persist('drafts');
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

  const ROUTES = ['chat', 'voice', 'drafts', 'drive', 'setup'];

  function openSheet(name, options = {}) {
    closeSheets({ keepMemory: true });
    const sheet = $('sheet-' + name);
    if (!sheet) return;
    $('scrim').hidden = false;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    if (name === 'drafts') paintDrafts();
    if (name === 'drive') { paintDrive(); listDriveFiles(); }
    if (name === 'setup') fillSetupForm();
    rememberScreen(name);
    if (!options.silent) setHash(name);
    paintTabs();
  }

  function closeSheets(options = {}) {
    $('scrim').hidden = true;
    document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
    document.body.style.overflow = '';
    // when another sheet opens next, "chat" is not where the user is going
    if (options.keepMemory !== true) rememberScreen('chat');
    paintTabs();
  }

  /* Screens are addressable (#drive, #setup…) so a link can land anywhere and
     the phone's back button does what people expect. */
  function setHash(name) {
    const target = name === 'chat' ? '' : '#' + name;
    if ((location.hash || '') === target) return;
    try {
      history.pushState({ screen: name }, '', target || location.pathname + location.search);
    } catch (error) {
      location.hash = target;   // file:// and odd embeds
    }
  }

  function rememberScreen(name) {
    try { localStorage.setItem('jenni_screen', name); } catch (error) { /* private mode */ }
  }

  function routeFromLocation() {
    const raw = (location.hash || '').replace(/^#/, '').split('?')[0];
    return ROUTES.includes(raw) ? raw : '';
  }

  /* Only ever used to *land* on a screen. openSheet() already clears the
     others, so nothing here calls closeSheets() — that would overwrite the
     remembered screen before we read it. */
  function applyRoute(options = {}) {
    const name = routeFromLocation();
    if (name === 'voice') { startVoiceMode(); return; }
    if (!name) { closeSheets(); return; }
    if (!state.cfg || !state.cfg.apiKey) { openSheet('setup', options); return; }
    openSheet(name, options);
  }

  /* Highlight the section that is actually on screen. */
  function paintTabs() {
    let active = 'chat';
    if (voice.mode) active = 'voice';
    else {
      const open = [...document.querySelectorAll('.sheet')].find((s) => !s.hidden);
      if (open) active = open.id.replace('sheet-', '');
    }
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.tab === active));
  }



  /* ══════════════════════════════════════════════════════════════ SECURITY

     The API key is never stored in the clear. It lives in an AES-GCM vault
     whose key is derived from the PIN (PBKDF2, 210k rounds). Settings and
     drafts stay readable — they are not secrets — but locking wipes the
     decrypted key from memory and the UI.
     ---------------------------------------------------------------------- */

  const security = {
    enabled: false,
    idleMs: 120000,
    lockOnHide: true,
    lock: null,
    timer: null,
    unlockedThisSession: false,
    dataKey: null
  };

  function readLockSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(LS.lock) || '{}');
      return {
        enabled: Boolean(stored.enabled),
        idleMs: Number.isFinite(stored.idleMs) ? stored.idleMs : 120000,
        lockOnHide: stored.lockOnHide !== false
      };
    } catch (error) {
      return { enabled: false, idleMs: 120000, lockOnHide: true };
    }
  }

  function writeLockSettings() {
    try {
      localStorage.setItem(LS.lock, JSON.stringify({
        enabled: security.enabled,
        idleMs: security.idleMs,
        lockOnHide: security.lockOnHide
      }));
    } catch (error) { /* private mode */ }
  }

  function vaultExists() {
    return Boolean(localStorage.getItem(LS.vault));
  }

  async function sealKey(apiKey) {
    if (!security.pin) throw new Error('PIN set nahi hai.');
    const sealed = await SEC.seal(security.pin, apiKey);
    localStorage.setItem(LS.vault, JSON.stringify(sealed));
    localStorage.removeItem(LS.config);   // the plaintext copy must go
  }

  async function openVault(pin) {
    const sealed = JSON.parse(localStorage.getItem(LS.vault) || 'null');
    if (!sealed) throw new Error('Koi saved key nahi.');
    const plain = await SEC.open(pin, sealed);
    let cfg = null;
    try { cfg = JSON.parse(plain); } catch (error) { throw new Error('Vault kharab hai.'); }
    return cfg;
  }

  /* Wipe the secret from memory and repaint everything that could show it. */
  function forgetSecret() {
    if (state.cfg) state.cfg = null;
    if ($('apiKey')) $('apiKey').value = '';
    stopVoiceMode(true);
    stopSpeaking();
  }

  function paintSecurity() {
    const hasKey = Boolean(state.cfg && state.cfg.apiKey);
    const keyState = $('secKeyState');
    if (keyState) keyState.textContent = hasKey ? (vaultExists() ? 'Encrypted' : 'Plain') : '—';
    const pinState = $('secPinState');
    if (pinState) pinState.textContent = security.enabled ? 'On' : 'Off';
    const autoState = $('secAutoState');
    if (autoState) autoState.textContent = security.idleMs ? Math.round(security.idleMs / 60000) + ' min' : 'Off';

    const auto = $('autoLockSelect');
    if (auto) auto.value = String(security.idleMs);
    const hide = $('lockOnHideToggle');
    if (hide) hide.checked = security.lockOnHide;
  }

  /* ── locking ───────────────────────────────────────────────────────────── */

  function lockNow(options = {}) {
    if (!security.enabled) return false;
    forgetSecret();
    security.dataKey = null;
    state.chat = []; state.drafts = []; state.memory = [];
    paintChat(); paintDrafts(); paintMemory();
    $('app').hidden = true;
    $('gate').hidden = true;
    $('lockScreen').hidden = false;
    if ($('lockPin')) { $('lockPin').value = ''; setTimeout(() => $('lockPin').focus(), 60); }
    setResult('lockResult', options.reason || '', options.reasonKind || '');
    security.unlockedThisSession = false;
    security.lock = security.lock || SEC.createLock({ idleMs: security.idleMs });
    return true;
  }

  async function unlockWith(pin, cfg) {
    security.pin = pin;
    state.cfg = cfg;                       // memory only: the key is never written back in plaintext
    await initDataKey(pin);
    await hydrate();
    paintMemory();
    $('lockScreen').hidden = true;
    $('gate').hidden = true;
    $('app').hidden = false;
    security.unlockedThisSession = true;
    if (security.lock) security.lock.recordSuccess();
    showApp();
    setStatus('ok', providerName() + ' · ' + cfg.model);
    startAutoLock();
    paintSecurity();
    // a config unlocked from the vault may still hold an old preset default
    const migrated = migratePresetModel();
    if (migrated) toast(`Model update: ${migrated}`, false);
  }

  function startAutoLock() {
    clearInterval(security.timer);
    if (!security.enabled || !security.idleMs) return;
    security.lock = security.lock || SEC.createLock({ idleMs: security.idleMs });
    security.lock.settings.idleMs = security.idleMs;
    security.timer = setInterval(() => {
      if ($('lockScreen').hidden === false) return;      // already locked
      if (security.lock.isIdleExpired()) lockNow({ reason: 'Idle thi — PIN daalo.', reasonKind: 'busy' });
    }, 5000);
  }

  function noteActivity() {
    if (security.lock) security.lock.touching();
  }

  async function submitUnlock() {
    const pin = $('lockPin').value;
    if (!pin) return;
    const cooldown = security.lock ? security.lock.remainingCooldown() : 0;
    if (cooldown > 0) {
      setResult('lockResult', `Thoda ruko — ${Math.ceil(cooldown / 1000)}s baad try karo.`, 'error');
      return;
    }
    setResult('lockResult', 'Khol rahe hain…', 'busy');
    try {
      const cfg = await openVault(pin);
      await unlockWith(pin, cfg);
    } catch (error) {
      const outcome = security.lock ? security.lock.recordFailure() : { failed: 0, cooldownMs: 0 };
      const left = Math.max(0, (security.lock ? security.lock.settings.attempts : 5) - outcome.failed);
      const message = outcome.cooldownMs
        ? `Galat PIN. ${Math.round(outcome.cooldownMs / 1000)}s ke liye locked.`
        : `Galat PIN${left ? ` — ${left} try bache` : ''}.`;
      setResult('lockResult', message, 'error');
      $('lockPin').value = '';
    }
  }

  /* ── choosing / changing the PIN ───────────────────────────────────────── */

  async function setPinAndKey(pin, cfg) {
    if (!SEC.hasWebCrypto) throw new Error('Is browser me crypto nahi — HTTPS par kholo.');
    if (!cfg || !cfg.apiKey) throw new Error('Pehle key daalo.');
    security.pin = pin;
    security.enabled = true;
    writeLockSettings();
    const sealed = await SEC.seal(pin, JSON.stringify(cfg));
    localStorage.setItem(LS.vault, JSON.stringify(sealed));
    localStorage.removeItem(LS.config);
    state.cfg = cfg;
    await initDataKey(pin, true);          // new salt + key, then re-encrypt everything
    await persistAll();
    return cfg;
  }

  /* Remove the PIN requirement, keeping the key in the clear (user's choice). */
  async function disableLockWith(pin) {
    const cfg = await openVault(pin);
    await initDataKey(pin);
    await hydrate();                       // make sure the decrypted data is in memory first
    security.enabled = false;
    await persistAll();                    // back to plaintext (user's choice)
    ['chat', 'drafts', 'memory'].forEach((n) => localStorage.removeItem(LS[n] + '_enc'));
    localStorage.removeItem(LS.dk);
    security.dataKey = null;
    localStorage.setItem(LS.config, JSON.stringify(cfg));
    localStorage.removeItem(LS.vault);
    localStorage.removeItem(LS.lock);
    security.pin = null;
    security.enabled = false;
    state.cfg = cfg;
  }

  /* ── panic ─────────────────────────────────────────────────────────────── */

  function panicWipe() {
    const keys = new Set(ALL_KEYS);
    try {
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('jenni_')) keys.add(key);
      });
    } catch (error) { /* ignore */ }
    keys.forEach((key) => { try { localStorage.removeItem(key); } catch (error) { /* ignore */ } });
    try { sessionStorage.clear(); } catch (error) { /* ignore */ }
    state.cfg = null;
    state.chat = [];
    state.drafts = [];
    security.pin = null;
    security.enabled = false;
    clearInterval(security.timer);
    location.replace(location.pathname);   // reload with nothing left
  }

  /* ══════════════════════════════════════════════════════════════ FLOATING BOT

     A chat-head style bubble: pointer-events drag, a 6px threshold so a tap
     is still a tap, spring-to-edge on release, position remembered per device,
     and a bin that appears while dragging. It mirrors the voice loop, so the
     app's voice state is visible from any screen.
     ---------------------------------------------------------------------- */

  const bot = {
    node: null,
    side: 'right',
    y: 62,          // vh
    dragging: false,
    moved: false,
    held: false,
    startX: 0,
    startY: 0,
    offsetY: 0,
    hidden: false
  };

  const BOT_KEY = 'jenni_bot_v1';

  function readBotPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(BOT_KEY) || '{}');
      if (saved.side === 'left' || saved.side === 'right') bot.side = saved.side;
      if (Number.isFinite(saved.y)) bot.y = saved.y;
      bot.hidden = Boolean(saved.hidden);
    } catch (error) { /* defaults are fine */ }
  }

  function writeBotPrefs() {
    try {
      localStorage.setItem(BOT_KEY, JSON.stringify({ side: bot.side, y: bot.y, hidden: bot.hidden }));
    } catch (error) { /* private mode */ }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function paintBot() {
    const node = $('bot');
    if (!node) return;
    node.dataset.side = bot.side;
    const minY = 8;
    const maxY = 88;
    node.style.setProperty('--bot-y', clamp(bot.y, minY, maxY).toFixed(2) + 'vh');
    node.hidden = bot.hidden;
    const restore = $('botRestore');
    if (restore) restore.hidden = !bot.hidden;

    const toggle = $('botToggle');
    if (toggle) toggle.checked = !bot.hidden;

    // the bot is a mirror of the voice loop, wherever you are
    node.classList.toggle('is-listening', voice.listening);
    node.classList.toggle('is-speaking', voice.speaking);
    node.classList.toggle('is-busy', state.busy && !voice.speaking);
    node.classList.toggle('is-error', Boolean(node.dataset.error));

    const title = $('bot');
    if (title) title.setAttribute('title', botHint());
    const body = $('botButton');
    if (body) body.setAttribute('aria-label', 'Jennie bot — ' + botHint());

    const badge = $('botBadge');
    if (badge) {
      const show = state.drafts.length > 0 && !voice.mode;
      badge.hidden = !show;
      badge.textContent = String(Math.min(state.drafts.length, 9));
    }
  }

  function setBotHidden(hidden, silent) {
    bot.hidden = hidden;
    writeBotPrefs();
    paintBot();
    if (hidden && voice.mode) stopVoiceMode(true);
    if (!silent) toast(hidden ? 'Bot chhup gaya — Setup se wapas lao' : 'Bot wapas aa gaya');
  }

  /* ── drag ──────────────────────────────────────────────────────────────── */

  function onBotPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const node = $('bot');
    if (!node) return;

    bot.dragging = true;
    bot.moved = false;
    bot.startX = event.clientX;
    bot.startY = event.clientY;
    const rect = node.getBoundingClientRect();
    bot.offsetY = event.clientY - rect.top;
    bot.node.setPointerCapture && bot.node.setPointerCapture(event.pointerId);
    node.classList.add('is-grabbing');

    clearTimeout(bot.holdTimer);
    bot.holdTimer = setTimeout(() => {
      if (!bot.moved && bot.dragging) {
        bot.dragging = false;
        bot.held = true;
        node.classList.remove('is-grabbing');
        botLongPress();
      }
    }, 520);
  }

  function onBotPointerMove(event) {
    if (!bot.dragging) return;
    const node = $('bot');
    if (!node) return;

    const dx = event.clientX - bot.startX;
    const dy = event.clientY - bot.startY;

    // a press only becomes a drag after a few pixels, so taps stay taps
    if (!bot.moved && Math.hypot(dx, dy) < 6) return;
    if (!bot.moved) {
      clearTimeout(bot.holdTimer);
      bot.moved = true;
      node.classList.add('is-dragging');
      const bin = $('botBin');
      if (bin) bin.hidden = false;
    }

    event.preventDefault();

    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = clamp(event.clientX, 24, width - 24);
    const y = clamp(event.clientY, 40, height - 40);
    bot.side = x < width / 2 ? 'left' : 'right';
    bot.y = (y / height) * 100;

    node.dataset.side = bot.side;
    node.style.setProperty('--bot-y', bot.y.toFixed(2) + 'vh');

    const bin = $('botBin');
    if (bin) bin.classList.toggle('is-hot', overBotBin(event.clientX, event.clientY));
  }

  function onBotPointerUp(event) {
    clearTimeout(bot.holdTimer);
    if (!bot.dragging) return;
    bot.dragging = false;
    const node = $('bot');
    if (node) {
      node.classList.remove('is-dragging', 'is-grabbing');
      if (node.releasePointerCapture && event.pointerId !== undefined) {
        try { node.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
      }
    }
    // ask before hiding the bin — a hidden element has no box to measure
    const droppedOnBin = bot.moved && overBotBin(event.clientX, event.clientY);
    const bin = $('botBin');
    if (bin) {
      bin.hidden = true;
      bin.classList.remove('is-hot');
    }

    if (bot.moved) {
      bot.moved = false;
      if (droppedOnBin) { setBotHidden(true); return; }
      bot.y = clamp(bot.y, 8, 88);
      writeBotPrefs();
      paintBot();
      return;
    }
    // a real tap: talk
    if (!bot.held) toggleVoiceMode();
    bot.held = false;
  }

  function overBotBin(x, y) {
    const bin = $('botBin');
    if (!bin || bin.hidden) return false;
    const rect = bin.getBoundingClientRect();
    return x >= rect.left - 8 && x <= rect.right + 8 && y >= rect.top - 8 && y <= rect.bottom + 8;
  }


  /* The bot is the same everywhere, but it is useful in different ways on
     different screens: it can save the open draft, upload it, or just talk. */
  function currentScreen() {
    if (voice.mode) return 'voice';
    const open = [...document.querySelectorAll('.sheet')].find((sh) => !sh.hidden);
    return open ? open.id.replace('sheet-', '') : 'chat';
  }

  function botHint() {
    const screen = currentScreen();
    if (screen === 'voice') return 'Bol rahi hoon… rukna ho to tap karo';
    if (screen === 'drafts') return state.drafts.length ? `${state.drafts.length} draft — tap karke bolo` : 'Koi draft nahi — tap karke bolo';
    if (screen === 'drive') return driveReady() ? 'Tap karke bolo, ya Connect Google dabao' : 'Tap karke bolo';
    if (screen === 'setup') return 'Key set hai — tap karke bolo';
    if (state.drafts.length) return `${state.drafts.length} draft — tap karke bolo`;
    return 'Tap karke bolo';
  }

  /* A long press on the bot offers the actions that fit the current screen. */
  function botLongPress() {
    const screen = currentScreen();
    if (screen === 'drafts' && state.drafts.length) {
      openSheet('drafts');
      toast('Draft par Drive / Copy dabao');
      return;
    }
    if (screen === 'drive') {
      paintDrive();
      toast(driveReady() ? 'Connect Google dabao' : 'Neeche client ID paste karo');
      return;
    }
    openSheet('setup');
  }

  function wireBot() {
    readBotPrefs();
    bot.node = $('bot');
    const node = bot.node;
    if (!node) return;

    paintBot();

    node.addEventListener('pointerdown', onBotPointerDown);
    window.addEventListener('pointermove', onBotPointerMove, { passive: false });
    window.addEventListener('pointerup', onBotPointerUp);
    window.addEventListener('pointercancel', () => {
      bot.dragging = false;
      node.classList.remove('is-dragging', 'is-grabbing');
      const bin = $('botBin');
      if (bin) bin.hidden = true;
    });

    $('botBin').addEventListener('click', () => setBotHidden(true));
    $('botShow').addEventListener('click', () => setBotHidden(false));

    const toggle = $('botToggle');
    if (toggle) {
      toggle.checked = !bot.hidden;
      toggle.addEventListener('change', () => setBotHidden(!toggle.checked, true));
    }

    // keep the bubble usable after rotation / resize
    window.addEventListener('resize', () => {
      bot.y = clamp(bot.y, 8, 88);
      node.style.setProperty('--bot-y', bot.y.toFixed(2) + 'vh');
    });
  }

  /* ══════════════════════════════════════════════════════════════ WIRING */

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }

  /* Once a day, the first time the app opens unlocked: tasks due or overdue.
     Local only — no model call, so it costs nothing and works offline. */
  function maybeBrief() {
    if (!BRAIN) return;
    const day = new Date().toISOString().slice(0, 10);
    try { if (localStorage.getItem('jenni_brief_day') === day) return; } catch (e) { return; }
    const text = BRAIN.briefing(loadMemory());
    try { localStorage.setItem('jenni_brief_day', day); } catch (e) { /* ignore */ }
    if (text) { state.chat.push({ role: 'jenni', text }); persist('chat'); }
  }

  function showApp(options = {}) {
    $('gate').hidden = true;
    $('app').hidden = false;
    const cfg = state.cfg;
    setStatus(cfg && cfg.apiKey ? 'ok' : '', cfg && cfg.apiKey ? providerName() + ' · ' + cfg.model : 'setup needed');
    maybeBrief();
    paintChat();
    paintDrive();
    paintDrafts();
    paintTabs();
    if ((!cfg || !cfg.apiKey) && options.openSetup !== false) {
      setTimeout(() => openSheet('setup'), 350);
    }
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
        paintModelLinks(key);
        $('gateKeyLink').href = preset.keyUrl || '#';
        $('gateKeyLink').textContent = preset.keyUrl ? preset.label + ' par key banayein' : 'Provider docs';
      });
    });

    $('btnSetupReveal').addEventListener('click', () => {
      const input = $('setupKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('btnSetupReveal').classList.toggle('is-on', show);
      // never leave a key on screen: re-hide on its own
      clearTimeout(window.__revealTimer);
      if (show) {
        window.__revealTimer = setTimeout(() => {
          input.type = 'password';
          $('btnSetupReveal').classList.remove('is-on');
        }, 12000);
      }
    });

    $('btnSaveKey').addEventListener('click', async () => {
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

      // a PIN is optional, but it is the only thing that encrypts the key
      const pin = ($('setupPin') && $('setupPin').value) || '';
      const pin2 = ($('setupPin2') && $('setupPin2').value) || '';
      if (pin || pin2) {
        if (pin !== pin2) { setResult('gateResult', 'Dono PIN same nahi hain.', 'error'); return; }
        const strength = SEC.pinStrength(pin);
        if (!strength.ok) { setResult('gateResult', 'PIN kam se kam 4 digits ka ho.', 'error'); return; }
        try {
          setResult('gateResult', 'Encrypt kar rahe hain…', 'busy');
          await setPinAndKey(pin, result.value);
        } catch (error) {
          setResult('gateResult', error.message, 'error');
          return;
        }
      } else {
        saveConfig(result.value);
      }

      setResult('gateResult', '', '');
      $('gate').hidden = true;
      $('lockScreen').hidden = true;
      showApp();
      setStatus('ok', providerName() + ' · ' + result.value.model);
      startAutoLock();
      paintSecurity();
      toast(security.enabled ? 'Key encrypt ho gayi — PIN yaad rakho' : 'Key save ho gayi (PIN ke bina)');
    });

    /* the PIN block only makes sense if WebCrypto is available */
    if (!SEC.hasWebCrypto) {
      const wrap = $('gatePinWrap');
      if (wrap) wrap.hidden = true;
    }
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

    /* one-shot mic: listen for a single message */
    $('btnMic').addEventListener('click', () => {
      if (state.listening) { stopListening(); return; }
      if (!voiceEnabled()) { toast('Voice OFF hai — upar speaker button se ON karo', true); return; }
      const wasMode = voice.mode;
      voice.mode = true;
      listenOnce();
      voice.mode = wasMode;
    });

    /* hands-free loop */
    $('btnVoice').addEventListener('click', toggleVoiceMode);
    $('btnStopSpeak').addEventListener('click', () => {
      stopSpeaking();
      if (voice.mode) scheduleListen(300);
    });
    $('btnVoiceLang').addEventListener('click', toggleLanguage);
    $('btnVoiceTest').addEventListener('click', speakSample);
    $('btnVoiceStart').addEventListener('click', () => { closeSheets(); startVoiceMode(); });

    $('btnOpenSetup').addEventListener('click', () => openSheet('setup'));
    if ($('btnVoiceMaster')) { $('btnVoiceMaster').addEventListener('click', () => setVoiceEnabled(!voiceEnabled())); paintVoiceMaster(); }
    if (CN && $('btnNmSave')) {
      const cfg0 = readJson(LS.nm, {});
      $('nmUrl').value = cfg0.url || '';
      $('nmToken').value = cfg0.token || '';
      const say = (m, k) => setResult('nmResult', m, k);
      $('btnNmSave').addEventListener('click', async () => {
        const cfg = { url: $('nmUrl').value.trim().replace(/\/+$/, ''), token: $('nmToken').value.trim() };
        if (!cfg.url) { localStorage.removeItem(LS.nm); localStorage.removeItem(LS.nmTeam); say('NeverMind disconnect.', 'ok'); return; }
        try {
          const nm = CN.createNeverMind(cfg);
          await nm.health();
          const team = await nm.roster();
          writeJson(LS.nm, cfg); writeJson(LS.nmTeam, team);
          say('Connected — ' + team.length + ' agents mile. Ab worksheet/quiz/lesson plan wale kaam wahi karega.', 'ok');
        } catch (error) { say(error.message, 'error'); }
      });
      $('btnNmSync').addEventListener('click', async () => {
        const nm = nmClient();
        if (!nm) { say('Pehle NeverMind connect karo.', 'error'); return; }
        try {
          let list = loadMemory(); const before = list.length;
          (await nm.memories()).slice(0, 30).forEach((t) => { list = BRAIN.addMemory(list, 'NeverMind: ' + t, 'school'); });
          saveMemory(list); say((list.length - before) + ' nayi memory aayi.', 'ok');
        } catch (error) { say(error.message, 'error'); }
      });
      const paintPacks = () => {
        const host = $('packList'); host.textContent = '';
        loadPacks().forEach((p) => {
          const row = document.createElement('div'); row.className = 'row';
          const label = document.createElement('span'); label.style.flex = '1'; label.textContent = p.name + ' — ' + (p.description || '').slice(0, 70);
          const del = document.createElement('button'); del.type = 'button'; del.className = 'btn btn--ghost'; del.textContent = 'Remove';
          del.addEventListener('click', () => { writeJson(LS.packs, loadPacks().filter((x) => x.name !== p.name)); paintPacks(); });
          row.append(label, del); host.appendChild(row);
        });
      };
      $('btnPackAdd').addEventListener('click', async () => {
        try {
          say('Skills padh rahi hoon…', 'ok');
          const found = await CN.fetchPacks($('packRepo').value, GH);
          const have = loadPacks().filter((p) => !found.some((f) => f.name === p.name));
          writeJson(LS.packs, have.concat(found).slice(-30)); paintPacks();
          say(found.length + ' skill install hui: ' + found.map((f) => f.name).join(', '), 'ok');
        } catch (error) { say(error.message, 'error'); }
      });
      $('btnPackFind').addEventListener('click', async () => {
        try {
          const r = await CN.searchSkillsSh($('packQuery').value);
          say(r.length ? r.map((x) => x.name + ' ← ' + x.source).join(' | ') + '  (source repo upar daal ke install karo)' : 'Kuch nahi mila.', r.length ? 'ok' : 'error');
        } catch (error) { say('skills.sh search nahi ho paya: ' + error.message, 'error'); }
      });
      paintPacks();
    }
    if ($('btnMemAdd') && BRAIN) {
      $('btnMemAdd').addEventListener('click', () => {
        const box = $('memInput');
        if (!box.value.trim()) return;
        const cmd = BRAIN.userCommand(box.value);
        saveMemory(cmd ? BRAIN.applyOps(loadMemory(), [cmd]) : BRAIN.addMemory(loadMemory(), box.value, null));
        box.value = '';
      });
      $('btnMemExport').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ app: 'jenni', v: 1, memory: loadMemory(), packs: loadPacks() }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'jenni-memory-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      });
      $('btnMemImport').addEventListener('click', () => $('memFile').click());
      $('memFile').addEventListener('change', async (ev) => {
        try {
          const data = JSON.parse(await ev.target.files[0].text());
          let list = loadMemory(); const before = list.length;
          (Array.isArray(data.memory) ? data.memory : []).slice(0, 200).forEach((m) => {
            list = BRAIN.addMemory(list, m && m.text, m && m.cat, m && m.ts, m && m.due && /^\d{4}-\d{2}-\d{2}$/.test(m.due) ? m.due : '');   // re-validated: imports are untrusted
          });
          saveMemory(list); toast((list.length - before) + ' memory import hui', false);
        } catch (error) { toast('File padhi nahi ja saki', true); }
        ev.target.value = '';
      });
      $('btnMemClear').addEventListener('click', () => { if (confirm('Saari memory delete karein?')) saveMemory([]); });
      paintMemory();
    }

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        if (name === 'chat') {
          closeSheets();
          stopVoiceMode(true);
        } else if (name === 'voice') {
          closeSheets();
          if (voice.mode) stopVoiceMode();
          else startVoiceMode();
        } else {
          openSheet(name);
        }
      });
    });

    $('scrim').addEventListener('click', closeSheets);

    /* the phone's back button closes a sheet before it leaves the app */
    window.addEventListener('popstate', () => applyRoute({ silent: true }));
    window.addEventListener('hashchange', () => applyRoute({ silent: true }));
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
      // never leave a key on screen: re-hide on its own
      clearTimeout(window.__revealTimer);
      if (show) {
        window.__revealTimer = setTimeout(() => {
          input.type = 'password';
          $('btnRevealKey').classList.remove('is-on');
        }, 12000);
      }
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

    /* ── lock screen ─────────────────────────────────────────────────── */
    $('lockForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitUnlock();
    });
    $('btnForgotPin').addEventListener('click', () => {
      const sure = window.confirm('PIN ke bina key wapas nahi milegi. Sab data delete karke shuru se shuru karein?');
      if (sure) panicWipe();
    });

    /* ── security panel ──────────────────────────────────────────────── */
    $('autoLockSelect').addEventListener('change', () => {
      security.idleMs = Number($('autoLockSelect').value) || 0;
      writeLockSettings();
      if (security.lock) security.lock.settings.idleMs = security.idleMs;
      startAutoLock();
      paintSecurity();
      toast(security.idleMs ? `Auto-lock: ${Math.round(security.idleMs / 60000)} min` : 'Auto-lock band');
    });

    $('lockOnHideToggle').addEventListener('change', () => {
      security.lockOnHide = $('lockOnHideToggle').checked;
      writeLockSettings();
    });

    $('btnLockNow').addEventListener('click', () => {
      if (!security.enabled) { toast('Pehle PIN set karo', true); return; }
      lockNow({ reason: 'Locked.', reasonKind: 'busy' });
    });

    $('btnChangePin').addEventListener('click', async () => {
      if (!security.enabled) {
        const pin = window.prompt('Naya PIN (4+ digits)');
        if (pin === null) return;
        const check = SEC.pinStrength(pin);
        if (!check.ok) { toast('PIN kam se kam 4 digits ka ho', true); return; }
        if (!state.cfg || !state.cfg.apiKey) { toast('Pehle key save karo', true); return; }
        try {
          await setPinAndKey(pin, state.cfg);
          security.enabled = true;
          writeLockSettings();
          startAutoLock();
          paintSecurity();
          toast('PIN lag gaya — key ab encrypted hai');
        } catch (error) { toast(error.message, true); }
        return;
      }
      const current = window.prompt('Abhi ka PIN');
      if (current === null) return;
      try {
        const cfg = await openVault(current);
        const next = window.prompt('Naya PIN (4+ digits)');
        if (next === null) return;
        const check = SEC.pinStrength(next);
        if (!check.ok) { toast('PIN kam se kam 4 digits ka ho', true); return; }
        security.pin = current;
        await setPinAndKey(next, cfg);
        paintSecurity();
        toast('PIN badal gaya');
      } catch (error) {
        toast('PIN galat', true);
      }
    });

    $('btnPanic').addEventListener('click', () => {
      const sure = window.confirm('Sab kuch mit jayega — key, PIN, drafts, chat. Pakka?');
      if (sure) panicWipe();
    });

    /* count real activity so auto-lock is fair */
    ['pointerdown', 'keydown', 'touchstart'].forEach((event) => {
      window.addEventListener(event, noteActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && security.lockOnHide && security.enabled && security.unlockedThisSession) {
        lockNow({ reason: 'App background me gaya — PIN daalo.', reasonKind: 'busy' });
      }
    });

    /* voice language + voice choice */
    const langSelect = $('voiceLangSelect');
    if (langSelect) {
      langSelect.value = voice.lang;
      langSelect.addEventListener('change', () => {
        voice.lang = BCP[langSelect.value] || 'hi-IN';
        localStorage.setItem('jenni_voice_lang', voice.lang);
        voice.ttsVoice = null;
        fillVoiceList();
        if (voice.mode) { stopListening(); scheduleListen(300); }
      });
    }
    if (voice.recognition) voice.recognition.lang = voice.lang;
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => fillVoiceList();
      setTimeout(fillVoiceList, 300);
    }

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
    $('btnDriveRefresh').addEventListener('click', listDriveFiles);
    $('btnDrivePaste').addEventListener('click', pasteClientId);
    $('btnCopyOrigin').addEventListener('click', copyOrigin);
    $('driveConnectLink').addEventListener('click', onDriveLinkClick);

    /* app-bar shortcut: open the Drive sheet from anywhere */
    $('btnDriveQuick').addEventListener('click', () => openSheet('drive'));

    /* the docs link lives in the app bar menu now */
  }

  /* ── boot ──────────────────────────────────────────────────────────────── */
  function boot() {
    /* Security first: a strict CSP, then the lock state decides what is shown. */
    if (SEC.applyCsp) SEC.applyCsp(document);
    const lockPrefs = readLockSettings();
    security.enabled = lockPrefs.enabled;
    security.idleMs = lockPrefs.idleMs;
    security.lockOnHide = lockPrefs.lockOnHide;
    security.lock = SEC.createLock ? SEC.createLock({ idleMs: security.idleMs }) : null;

    // move a previously-shipped default model to today's default
    const migrated = migratePresetModel();
    if (migrated) setTimeout(() => toast(`Model update: ${migrated}`, false), 900);

    // restore the user's voice language and chosen voice
    voice.ttsVoice = pickVoice(voice.lang);
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => {
        if (!voice.ttsVoice) voice.ttsVoice = pickVoice(voice.lang);
        fillVoiceList();
      };
    }
    wireGate();
    wireApp();
    wireBot();
    paintSecurity();

    /* Three honest states on boot:
         vault + PIN  → locked until the PIN is typed
         plain config → straight in, with a nudge to add a PIN
         nothing      → the setup gate                                        */
    if (security.enabled && localStorage.getItem(LS.vault)) {
      state.cfg = null;                      // never hold the key while locked
      state.chat = []; state.drafts = []; state.memory = [];
      $('gate').hidden = true;
      $('app').hidden = true;
      $('lockScreen').hidden = false;
      if ($('lockPin')) setTimeout(() => $('lockPin').focus(), 120);
      return;
    }
    if (state.cfg && state.cfg.apiKey) {
      // read the destination before showApp() paints the default screen
      const target = routeFromLocation() || localStorage.getItem('jenni_screen') || '';
      showApp();
      // then land on it — a shared link wins, otherwise resume where they were.
      // openSheet() is called directly: applyRoute() re-reads the hash, which is
      // empty on a resumed visit, so it would always fall back to chat.
      if (target && target !== 'chat') setTimeout(() => openSheet(target, { silent: true }), 80);
      else rememberScreen('chat');
      startAutoLock();
      if (!security.enabled) setTimeout(() => toast('PIN lock lagao — Setup → Security'), 1600);
    } else {
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
