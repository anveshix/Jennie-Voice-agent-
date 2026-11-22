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
    nm: 'jenni_nm_v1',         // NeverMind address (localhost only; no secret)
    nmTeam: 'jenni_nm_team_v1',
    packs: 'jenni_packs_v1',   // installed SKILL.md packs
    remind: 'jenni_remind_on', // reminders enabled ('1')
    voiceOn: 'jenni_voice_on', // master voice switch ('0' = off)
    wins: 'jenni_wins_v1',     // completed tasks (strengths log)
    activity: 'jenni_activity_v1', // weekly rhythm of the owner's work
    summary: 'jenni_summary_v1',   // rolling recap of trimmed chat turns
    actions: 'jenni_actions_v1',   // audit trail of what Jenni did
    evals: 'jenni_evals_v1',       // self-test history
    autonomy: 'jenni_autonomy_v1', // ask | smart | auto
    backup: 'jenni_backup_v1',     // last Drive backup info
    voicecfg: 'jenni_voicecfg_v1', // chosen speaking/listening engines + their keys (encrypted with the PIN)
    school: 'jenni_school_v1', // letterhead profile for the Office desk
    notes: 'jenni_notes_v1',   // owner notes + tasks (brain.js)
    dk: 'jenni_dk_v1',         // salt for the data key (not secret)
    lock: 'jenni_lock_v1',     // PIN settings + config
    vault: 'jenni_vault_v1',   // the encrypted API key
    memory: 'jenni_memory_v1', // durable facts about the user
    skills: 'jenni_skills_v1', // procedures learned from real chats
    episodes: 'jenni_episodes_v1', // one row per cleared chat
    insights: 'jenni_insights_v1'  // habits distilled from those chats
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
  const MEM = window.JENNI_MEM;
  const BUDGET = window.JENNI_BUDGET;
  const VERIFY = window.JENNI_VERIFY;
  const TOOLS = window.JENNI_TOOLS;
  const GOOGLE = window.JENNI_GOOGLE;
  const AUDIO = window.JENNI_AUDIO;
  const VOICES = window.JENNI_VOICES;
  const PRO = window.JENNI_PROACTIVE;
  const EVALS = window.JENNI_EVALS;
  const AGENT = window.JENNI_AGENT || {};
  const NET = window.JENNI_NET || null;      // retry/backoff/circuit rules, shared with the server
  const PERSONA_SHARED = window.JENNI_PERSONA || null;   // greeting + manner lines, shared with the server
  const FAST = window.JENNI_FAST || null;               // instant local replies for greetings/acks
  const LIVE = window.JENNI_LIVE || null;               // Gemini native-audio full-duplex transport

  /* Long-term memory and learned skills. Both are plain localStorage data, so
     they show up in the UI, survive reloads and vanish on "Erase everything".
     Declared after AGENT, which they depend on. */
  const SECURE_KEYS = [LS.chat, LS.drafts, LS.notes, LS.school, LS.voicecfg, LS.wins, LS.activity, LS.summary, LS.actions, LS.evals, LS.memory, LS.skills, LS.episodes, LS.insights];
  const vault = new Map();          // decrypted JSON strings while unlocked
  const vaultQueue = {};            // per-key write chain (keeps writes in order)
  const secureStore = {
    getItem(key) {
      if (!security.enabled || !SECURE_KEYS.includes(key)) return localStorage.getItem(key);
      return vault.has(key) ? vault.get(key) : null;
    },
    setItem(key, value) {
      if (!security.enabled || !SECURE_KEYS.includes(key)) return localStorage.setItem(key, value);
      const dataKey = security.dataKey;
      if (!dataKey) return;                                           // locked: never fall back to plaintext
      vault.set(key, String(value));
      vaultQueue[key] = (vaultQueue[key] || Promise.resolve())
        .then(() => SEC.encryptJson(dataKey, key, JSON.parse(String(value))))
        .then((blob) => { localStorage.setItem(key + '_enc', JSON.stringify(blob)); localStorage.removeItem(key); return true; })
        .catch(() => { toast('Data encrypt/save nahi ho paya', true); return false; });
    },
    removeItem(key) {
      localStorage.removeItem(key);
      if (SECURE_KEYS.includes(key)) { localStorage.removeItem(key + '_enc'); vault.delete(key); }
    }
  };
  const secGet = (key, fallback) => { try { const raw = secureStore.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } };
  const secSet = (key, value) => { try { secureStore.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full */ } };
  const memory = AGENT.createMemory ? AGENT.createMemory(secureStore) : null;
  const skills = AGENT.createSkills ? AGENT.createSkills(secureStore) : null;
  const journal = AGENT.createJournal ? AGENT.createJournal(secureStore) : null;
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

  /* one-time: notes my earlier build stored under agent.js's key (plaintext case) */
  (function migrateLegacyNotes() {
    try {
      const raw = localStorage.getItem(LS.memory);
      const legacy = raw && splitLegacyNotes(raw);
      if (!legacy) return;
      const have = JSON.parse(localStorage.getItem(LS.notes) || '[]');
      localStorage.setItem(LS.notes, JSON.stringify(legacy.notes.concat(Array.isArray(have) ? have : [])));
      localStorage.setItem(LS.memory, JSON.stringify(legacy.facts));
    } catch (e) { /* storage unavailable */ }
  }());

  /* ── state ─────────────────────────────────────────────────────────────── */
  const state = {
    cfg: readJson(LS.config, null),
    drafts: readJson(LS.drafts, []),
    chat: readJson(LS.chat, []),
    notes: readJson(LS.notes, []),
    drive: readJson(LS.drive, { clientId: '' }),
    driveToken: readJson(LS.driveToken, null),
    busy: false,
    listening: false,
    recorder: null,
    chunks: [],
    /* 3 bad turns in a row means the provider is genuinely down. While the
       breaker is open only one cheap probe goes out per turn, so a 503 storm is
       not multiplied by every retry this phone would otherwise send. */
    netBreaker: NET ? NET.createBreaker({ threshold: 3, cooldownMs: 25000 }) : null
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

    if (options.onDelta) body.stream = true;
    if (options.tools) { body.tools = options.tools; body.tool_choice = 'auto'; }

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

  /* Server-sent events from an OpenAI-compatible endpoint → text, delivered to
     options.onDelta(chunk) as it arrives so the bubble and the voice start at once. */
  async function readStream(response, options, started) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const readWithIdle = () => new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try { reader.cancel(); } catch (e) { /* ignore */ }
        const err = new Error('Provider ne jawab beech me rok diya.');
        err.code = 'TIMEOUT';
        reject(err);
      }, 25000);
      reader.read().then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
    });
    let buf = '', text = '', finish = '';
    try {
      for (;;) {
        const { done, value } = await readWithIdle();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json;
          try { json = JSON.parse(data); } catch (e) { continue; }
          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          const delta = choice.delta && choice.delta.content;
          if (delta) { text += delta; options.onDelta(delta); }
        }
      }
    } catch (error) {
      // A stream that dies halfway must not throw away the words already heard:
      // hand them to withRetries as a truncation, which can fetch only the tail.
      if (error && error.name === 'AbortError') throw error;
      const partial = text.trim();
      if (partial) {
        const cut = new Error('Provider se stream beech me toot gaya.');
        cut.code = 'TRUNCATED';
        cut.partial = partial;
        throw cut;
      }
      if (error && error.code === 'TIMEOUT') throw error;
      const lost = new Error('Provider se connection toot gaya.');
      lost.code = 'NETWORK';
      throw lost;
    }
    const out = text.trim();
    if (!out) {
      const error = new Error(finish === 'length' ? 'Jawab budget khatam ho gaya. Dobara try karo.' : 'Provider ne khali jawab bheja.');
      error.code = 'EMPTY_REPLY';
      throw error;
    }
    if (finish === 'length') {
      const error = new Error('Jawab beech me kat gaya.');
      error.code = 'TRUNCATED';
      error.partial = out;
      throw error;
    }
    app.lastLatency = Date.now() - started;
    return out;
  }

  async function callProvider(messages, options = {}) {
    const cfg = options.cfg || state.cfg;
    if (!cfg || !cfg.apiKey) throw new Error('Pehle Setup me API key daalo.');
    const model = options.model || cfg.model;

    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
    // Voice can interrupt a turn that is still streaming; keep a handle so a new
    // sentence cancels the old request instead of being dropped.
    state.turnAbort = controller;

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

      if (options.onDelta && response.ok && response.body && response.body.getReader
          && /text\/event-stream/i.test(response.headers.get('content-type') || '')) {
        clearTimeout(timer);                      // streaming has its own idle timeout
        return await readStream(response, options, started);
      }

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const detail = payload && payload.error && (payload.error.message || payload.error.code);
        const asked = NET ? NET.parseRetryAfter(response.headers.get('retry-after'), Date.now()) : null;
        const withMeta = (error) => {
          error.status = response.status;
          if (asked !== null && asked !== undefined) error.retryAfterMs = asked;
          return error;
        };
        if (response.status === 401 || response.status === 403) {
          // a key/base-URL mismatch is a setup problem, not a provider outage
          const auth = withMeta(new Error('Key galat ya expired hai. Provider dashboard se nayi key lo.'));
          auth.code = 'AUTH';
          throw auth;
        }
        if (response.status === 429) {
          const busy = withMeta(new Error('Provider ki limit lag gayi (429). Thodi der baad try karo, ya doosra provider chuno.'));
          busy.code = 'BUSY';              // same "worth one more try" family
          throw busy;
        }
        if (response.status >= 500) {
          const down = withMeta(new Error(`Provider ki taraf se gadbad (HTTP ${response.status}).`));
          down.code = 'HTTP_5XX';
          throw down;
        }
        if (response.status === 404) {
          // A 404 from an OpenAI-compatible endpoint almost always means the
          // model ID was retired or the base URL has an extra path segment.
          const error = withMeta(new Error(`Model "${model}" provider par nahi mila (404). Ye model band ho gaya ho sakta hai — naya model chuno.`));
          error.code = 'MODEL_NOT_FOUND';
          throw error;
        }
        throw withMeta(new Error(detail || `Provider ne error diya (HTTP ${response.status}).`));
      }

      const choice = payload && payload.choices && payload.choices[0];
      if (options.raw && choice && choice.message) { app.lastLatency = Date.now() - started; return choice.message; }
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
        if (controller.__cancelled) {
          const stopped = new Error('Ruk gaya.');
          stopped.code = 'CANCELLED';
          throw stopped;
        }
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
      if (state.turnAbort === controller) state.turnAbort = null;
    }
  }

  /** Stop the turn that is in flight right now (voice interruption / Chup). */
  function interruptTurn() {
    const controller = state.turnAbort;
    if (!controller) return false;
    controller.__cancelled = true;          // checked in callProvider's AbortError branch
    try { controller.abort(); } catch (error) { /* already gone */ }
    return true;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* Errors worth one more attempt on their own — the network blipped, the
     provider was busy, or the answer got cut off mid-way. The rules live in
     net.js so the server proxy classifies a 503 exactly like this app does;
     the local copy keeps an old cached shell working if net.js is missing. */
  const RETRYABLE = NET ? NET.RETRYABLE : new Set(['TIMEOUT', 'NETWORK', 'EMPTY_REPLY', 'TRUNCATED', 'HTTP_5XX', 'BUSY']);
  const retryableLocal = (error) => Boolean(error) && RETRYABLE.has(error.code);

  /* Can a different provider answer for this one right now? Only when the user
     has stored a spare key, the current provider is the one failing, and the
     failure is a provider-side outage — not a bad key or a retired model.
     Spare keys ride inside the saved config, so the PIN vault seals them too. */
  function fallbackTarget(error, options) {
    const code = error && error.code;
    // An expired key on one provider is exactly what a spare provider is for.
    if (!(code === 'HTTP_5XX' || code === 'BUSY' || code === 'TIMEOUT' || code === 'NETWORK' || code === 'AUTH')) return null;
    const cfg = state.cfg || {};
    const extra = cfg.fallbackKeys && typeof cfg.fallbackKeys === 'object' ? cfg.fallbackKeys : {};
    const preferred = options && options.fallbackProvider;
    const order = [preferred, cfg.fallbackProvider].concat(Object.keys(PRESETS));
    const seen = new Set();
    for (const id of order) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (id === cfg.provider || id === 'custom' || !PRESETS[id]) continue;
      const key = extra[id];
      if (!key || String(key).length < 8) continue;
      const preset = PRESETS[id];
      return {
        provider: id,
        label: preset.label,
        apiKey: key,
        baseUrl: preset.baseUrl,
        model: preset.model,
        transcribe: preset.transcribe || ''
      };
    }
    return null;
  }

  /** Save/remove a spare key for another provider (used when the main one is down). */
  function saveSpareKey(provider, key) {
    if (!provider || !PRESETS[provider] || provider === 'custom') return null;
    const cfg = Object.assign({}, state.cfg || {});
    const keys = Object.assign({}, cfg.fallbackKeys || {});
    const value = String(key || '').trim();
    if (/•/.test(value) && keys[provider]) return state.cfg;      // masked field, unchanged
    if (value) keys[provider] = value;
    else delete keys[provider];
    cfg.fallbackKeys = keys;
    if (!Object.keys(keys).length) {
      cfg.fallbackProvider = '';
    } else if (!keys[cfg.fallbackProvider]) {
      cfg.fallbackProvider = Object.keys(keys)[0];
    }
    saveConfig(cfg);
    return cfg;
  }

  /* All providers share the same OpenAI-compatible body shape, so a fallback
     only needs a different config object, not a different code path. */
  function cfgWith(base, override) {
    return Object.assign({}, base, {
      provider: override.provider,
      apiKey: override.apiKey,
      baseUrl: override.baseUrl,
      model: override.model,
      transcribe: override.transcribe
    });
  }

  /**
   * Wraps callProvider with the recovery that the app promises:
   *   timeout / network / 5xx / busy → escalating jittered backoff, honouring
   *     Retry-After; then a second provider if one is configured
   *   404 retired model  → retry once on the preset's current model, save it
   *   truncated answer   → ask for the rest and stitch it together
   *
   * In voice mode the whole thing is on a deadline so a dead provider cannot
   * leave the user staring at a silent mic for a minute.
   */
  async function askProvider(messages, options = {}) {
    const startedAt = Date.now();
    const deadline = options.deadline || startedAt + (voice.mode ? 30000 : 75000);
    const breaker = state.netBreaker;
    // Circuit open → one probe only. If it fails the error carries the wait.
    const opts = breaker && breaker.isOpen() && options.retries === undefined
      ? Object.assign({}, options, { retries: 0 })
      : options;
    const first = await attemptChain(messages, opts, deadline, startedAt);
    if (first.reply !== undefined) return first.reply;
    if (breaker && breaker.isOpen() && first.error && !first.error.retryAfterMs) {
      // Cooldown already running → tell the user how long, do not fake a retry.
      first.error.retryAfterMs = breaker.openFor();
    }
    return recoverFrom(messages, opts, first.error, deadline, startedAt);
  }

  /* One provider, with retries. Returns {reply} or {error} — never throws, so
     the caller can decide whether a second provider is worth trying. */
  const cancelledError = () => Object.assign(new Error('Ruk gaya.'), { code: 'CANCELLED' });
  const isStale = (options) => options.turnToken !== undefined && options.turnToken !== state.turnSeq;

  async function attemptChain(messages, options, deadline, startedAt) {
    const breaker = state.netBreaker;
    let attempt = 0;
    for (;;) {
      if (isStale(options)) return { error: cancelledError() };
      try {
        const cfg = options.useConfig || state.cfg;
        const reply = await callProvider(messages, Object.assign({}, options, { cfg }));
        if (breaker && cfg === state.cfg) breaker.ok();
        return { reply };
      } catch (error) {
        if (error.code === 'TRUNCATED' && error.partial) {
          try {
            const tail = await callProvider(
              messages.concat([
                { role: 'assistant', content: error.partial },
                { role: 'user', content: 'Jahan chhoda tha wahin se aage likho — sirf bacha hua hissa, dohrana nahi.' }
              ]),
              Object.assign({}, options, { maxTokens: 900, cfg: options.useConfig || state.cfg })
            );
            return { reply: (error.partial + '\n' + tail).trim() };
          } catch (tailError) {
            return { reply: error.partial };       // half an answer beats none
          }
        }
        // A key/model problem is about *this* provider — a fallback may still work,
        // but repeating the same request against the same provider never helps.
        if (error.code === 'AUTH' || error.code === 'MODEL_NOT_FOUND') {
          if (breaker && cfg === state.cfg) breaker.fail(error);
          return { error };
        }

        const plan = NET
          ? NET.retryPlan(error, attempt, {
            maxAttempts: options.retries === undefined ? (voice.mode ? 2 : 3) : options.retries,
            baseMs: 600,
            capMs: 6000,
            maxWaitMs: voice.mode ? 6000 : 12000,
            minWaitMs: 250,
            deadline,
            now: Date.now()
          })
          : { retry: retryableLocal(error) && attempt < 2, waitMs: 700 * (attempt + 1) };

        const outage = plan.retry || retryableLocal(error) || error.code === 'AUTH';
        if (outage && breaker && cfg === state.cfg) breaker.fail(error);
        if (!plan.retry) return { error, attempts: attempt + 1 };
        attempt += 1;
        if (options.onReset) options.onReset();     // drop a half-streamed answer before retrying
        // Say what is happening: a silent spinner during a 503 is what "jawab
        // nahi aaya" felt like. one short line, then keep trying.
        setStatus('busy', `${providerName()} busy — dobara koshish (${attempt + 1}/${(options.retries === undefined ? (voice.mode ? 2 : 3) : options.retries) + 1})`);
        if (options.onRetry) options.onRetry(error, attempt, plan.waitMs);
        await sleep(plan.waitMs);
        if (isStale(options)) return { error: cancelledError() };   // cancelled mid-backoff
      }
    }
  }

  /* Model retired → its preset's current model. Outage → another provider the
     user already stored a key for. Anything else → the error itself. */
  async function recoverFrom(messages, options, error, deadline, startedAt) {
    if (error.code === 'MODEL_NOT_FOUND' && !options.noRetry) {
      const cfg = state.cfg || {};
      const preset = PRESETS[cfg.provider];
      if (preset && preset.model && preset.model !== cfg.model) {
        const retry = await attemptChain(messages, Object.assign({}, options, {
          model: preset.model, noRetry: true, useConfig: Object.assign({}, cfg, { model: preset.model })
        }), deadline, startedAt);
        if (retry.reply !== undefined) {
          saveConfig(Object.assign({}, cfg, { model: preset.model }));
          if (voice.mode) stopListening();
          toast(`Purana model band tha — ab "${preset.model}" chal raha hai`, false);
          return retry.reply;
        }
        return throwLate(retry.error);
      }
    }

    const alt = options.noFallback ? null : fallbackTarget(error);
    if (alt && Date.now() < deadline) {
      toast(`${providerName()} par dikkat — ${alt.label} se jawab la rahi hoon`, true);
      const retry = await attemptChain(messages, Object.assign({}, options, {
        useConfig: cfgWith(state.cfg || {}, alt),
        noFallback: true,
        noRetry: false,
        retries: 1
      }), deadline, startedAt);
      if (retry.reply !== undefined) {
        state.netFallbackAt = Date.now();
        return retry.reply;
      }
    }
    return throwLate(error);
  }

  function throwLate(error) {
    if (!error.__late) { error.__late = true; }
    throw error;
  }

  /* One line a frustrated user can act on. A provider outage gets a plain
     "their side, not yours" sentence plus how long to wait, instead of a bare
     "Kuch galat hua" that made people think their key was broken. */
  function outageSentence(error) {
    const waitMs = Number(error && error.retryAfterMs);
    const wait = Number.isFinite(waitMs) && waitMs >= 1000
      ? `${Math.max(1, Math.round(waitMs / 1000))} second`
      : 'thodi der';
    const alt = fallbackTarget(error);
    return (alt ? `Sab provider busy hain. ` : 'Provider ki taraf se dikkat hai. ')
      + `Ye aapki key ki galti nahi — ${wait} baad bhejo, ya doosra provider chuno.`;
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
      // politeness with respect — the owner asked to be addressed as "sir"
      'User ko "sir" bulao — "haan sir", "ji sir", "bilkul sir", par har vaakya me nahi aur kabhi chatukarta/robotic "main aapki seva me haazir hoon" nahi. Izzat wala, garv-raht, warm tone.',
      'Emotional samajh: pehle user ka mood 3-4 shabdon me acknowledge karo, phir kaam. Akela ya thaka lage to halka sa hausla, drama nahi.',
      'Fast raho: pehli line me seedha jawab ya "haan sir, kar deti hoon". Voice me 1 chhota vaakya; type me bhi 2-3 chhote vaakya default — detail, draft ya list sirf tab jab user maange.',
      // language mirroring
      'Jis bhasha me user likhe/bolo usi me jawab do — Hinglish in Hinglish out, Hindi in Hindi out, English in English out. Roman Hinglish hi rakho, Devanagari me tabhi jab user Devanagari me likhe. "Sir" Hinglish/Hindi me "sir" hi rehta hai, English me "sir".',
      // voice-friendly output
      'Tumhara jawab voice me bhi bola jaata hai: emoji, markdown headings, tables, "*" bullet, code block — kuch nahi, jab tak user na maange. Bina maange list mat banao.',
      // accuracy and safety
      'Galat mat bolo. API key, password, OTP, bank details kabhi maango mat, kabhi repeat mat karo. Medical/legal/paisa wale serious sawaal par salah do par "doctor/lawyer se confirm karo" bolna zaroori hai. Emergency (khud ko nuksan, koi khatre me) me pehle safety, phir baat.',
      // honesty about being an AI
      'Jab seedha poochha jaye to maan lo ki tum AI ho (internet par chalne wali), par apni personality mat chhodo — insaan hone ka jhooth mat bolo.',
      'Aaj 2026 ke aakhir me ho aur aage 2027-2030 ki soch ke jawab do: career, padhai, AI, technology, paisa — har cheez me ye socho ki agle 3-5 saal me kya badlega, kaunsi skill aaj se bachayegi, aur kya aaj ka trend 2030 tak purana ho jayega. Purani ya outdated baat ko confidently "aaj ka sach" mat batao — jo cheez 2024 tak sach thi par ab badal chuki hai, wo bolo ki badal chuki hai.',
      // the user calls her "yes sir" style — mirror respect without grovelling
      'DOC FILE RULE: jab user doc/word/pdf/letter/application maange to seedha poora draft likho — placeholders [] me, beech me sawaal nahi. Kabhi mat bolo ki tum file nahi bana sakti ya download nahi kar sakti: phone app tumhare jawab se apne aap .docx/.txt/.md/.csv file bana kar Download button deta hai. "Main file nahi bana sakti, tum copy karo" jaisa jumla bilkul nahi — bas draft do, file app bana degi.',
      'User ke paas git/terminal nahi hai, isliye unhe clone/install karne ko mat bolo. GitHub ka public code padhna ho to tum khud jenniFetchRepo(tool) se padh sakti ho — jawab me links aur seedha code sample do.',
      'Kaam pakadne par turant haan bolo — "haan sir, kar deti hoon", "ji sir, dekh rahi hoon", "done sir" — jab tak koi cheez sach me mumkin na ho. Pehle "haan sir" (short ack), phir kaam, phir ek line ka natija. Jhoothi confirmation mat do: jo tum nahi kar sakti (message bhejna, paisa bhejna, file save karna) usme "ye main nahi kar sakti sir, par aapke liye ye kar sakti hoon…" bolo.'
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

  function loadNotes() { return BRAIN ? state.notes : []; }
  function saveNotes(list) { state.notes = normalizeTasks(list); persist('notes'); paintNotes(); syncReminders(); if (typeof paintSuggestions === 'function') paintSuggestions(); }

  /* ── encrypted storage ────────────────────────────────────────────────────
     With a PIN set, chat, drafts, notes AND the agent's facts, playbooks and
     journal live only as AES-GCM blobs (`<key>_enc`). `secureStore` is a
     localStorage-shaped adapter, so agent.js needs no changes. While locked it
     reads nothing and writes nothing. */
  async function flushVault() {
    await Promise.all(Object.keys(vaultQueue).map((k) => vaultQueue[k]));
  }
  function persist(name) {
    const key = LS[name];
    const value = name === 'chat' ? state.chat.filter((m) => !m.pending) : state[name];
    if (!security.enabled) return Promise.resolve(writeJson(key, value));
    secureStore.setItem(key, JSON.stringify(value));
    return vaultQueue[key] || Promise.resolve(true);
  }
  /* ── reminders ─────────────────────────────────────────────────────────────
     The service worker cannot read encrypted storage, so a minimal index goes to
     IndexedDB: due dates only when a PIN is set, plus titles when it is not. */
  const RSTORE = window.JENNI_REMIND_STORE;
  const remindOn = () => { try { return localStorage.getItem(LS.remind) === '1'; } catch (e) { return false; } };
  async function syncReminders() {
    if (!RSTORE || !BRAIN || !window.indexedDB || security.enabled && !security.dataKey) return;   // locked: keep the last index
    try {
      const prev = (await RSTORE.get('index')) || {};
      const titles = !security.enabled;
      const items = state.notes.filter((m) => m.cat === 'task' && m.due).map((m) => ({ due: m.due, text: titles ? m.text : '' }));
      await RSTORE.set('index', { on: remindOn(), titles, items, lastKey: prev.lastKey || '' });
    } catch (e) { /* IndexedDB blocked (private mode): in-page reminders still work */ }
  }
  async function remindTick() {
    if (!remindOn() || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (security.enabled && !security.dataKey) return;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date())) % 24;
    if (hour < 8) return;
    await syncReminders();
    const reg = navigator.serviceWorker && await navigator.serviceWorker.ready.catch(() => null);
    if (reg && reg.active) reg.active.postMessage('remind-now');
  }
  async function setReminders(on) {
    const info = $('remindInfo');
    if (!on) { localStorage.setItem(LS.remind, '0'); await syncReminders(); info.textContent = 'Reminders band.'; return false; }
    if (!('Notification' in window)) { info.textContent = 'Ye browser notifications support nahi karta.'; return false; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { info.textContent = 'Notification permission nahi mili — browser settings me allow karo.'; return false; }
    localStorage.setItem(LS.remind, '1');
    await syncReminders();
    let bg = false;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg.periodicSync) { await reg.periodicSync.register('jenni-remind', { minInterval: 12 * 60 * 60 * 1000 }); bg = true; }
    } catch (e) { /* not installed as an app, or not supported */ }
    info.textContent = bg
      ? 'ON — app band hone par bhi din me 1-2 baar check hoga (Android me app Home screen par install ho). ' + (security.enabled ? 'PIN ki wajah se notification me task ka naam nahi, sirf count aayega.' : '')
      : 'ON — app khula ya background me ho tab reminder aayega. Band app ke liye Chrome me "Add to Home screen" karo.';
    remindTick();
    return true;
  }

  const persistAll = async () => {
    await Promise.all(['chat', 'drafts', 'notes'].map(persist));
    // agent.js keys: carry over whatever is plaintext (enable) or already decrypted (PIN change)
    SECURE_KEYS.forEach((key) => {
      if (['chat', 'drafts', 'notes'].some((n) => LS[n] === key)) return;
      const value = vault.has(key) ? vault.get(key) : localStorage.getItem(key);
      if (value != null) secureStore.setItem(key, value);
    });
    await flushVault();
  };

  async function initDataKey(pin, fresh) {
    let salt = localStorage.getItem(LS.dk);
    if (!salt || fresh) { salt = SEC.newSalt(); localStorage.setItem(LS.dk, salt); }
    security.dataKey = await SEC.deriveDataKey(pin, salt);
  }

  /* My old build stored notes in `jenni_memory_v1`, which agent.js also owns
     (facts have `kind`, notes have `cat`). Split them apart once. */
  function splitLegacyNotes(raw) {
    let list; try { list = JSON.parse(raw); } catch (e) { return null; }
    if (!Array.isArray(list)) return null;
    const mine = list.filter((x) => x && x.cat && !x.kind);
    return mine.length ? { notes: mine, facts: list.filter((x) => !(x && x.cat && !x.kind)) } : null;
  }

  /* Load everything after unlock; migrate any legacy plaintext copy. */
  async function hydrate() {
    vault.clear();
    for (const key of SECURE_KEYS) {
      const enc = localStorage.getItem(key + '_enc');
      if (enc && security.dataKey) {
        try { vault.set(key, JSON.stringify(await SEC.decryptJson(security.dataKey, key, JSON.parse(enc)))); }
        catch (error) { toast('Ek saved data padha nahi ja saka (' + key.replace('jenni_', '') + ')', true); }
      } else if (security.enabled && security.dataKey && localStorage.getItem(key) != null) {
        vault.set(key, localStorage.getItem(key));
        secureStore.setItem(key, localStorage.getItem(key));          // encrypt + remove plaintext
      }
    }
    const legacy = vault.has(LS.memory) ? splitLegacyNotes(vault.get(LS.memory)) : null;
    if (legacy) {
      vault.set(LS.notes, JSON.stringify(legacy.notes.concat(JSON.parse(vault.get(LS.notes) || '[]'))));
      secureStore.setItem(LS.notes, vault.get(LS.notes));
      secureStore.setItem(LS.memory, JSON.stringify(legacy.facts));
    }
    for (const name of ['chat', 'drafts', 'notes']) {
      try { state[name] = JSON.parse(vault.get(LS[name]) || '[]'); } catch (e) { state[name] = []; }
      if (!Array.isArray(state[name])) state[name] = [];
    }
    await flushVault();
  }

  /* The system prompt is assembled from prioritised sections and fitted to a
     token budget, so a long profile can never crowd out the conversation. */
  const PROMPT_BUDGET = 3300;       // system prompt tokens
  const HISTORY_BUDGET = 1500;      // recent turns
  function unifiedMemoryLines(userText) {
    if (!MEM) return null;
    return MEM.unify({ facts: memory ? memory.all() : [], notes: state.notes, text: userText, now: Date.now(), limit: 8 }).map((i) => i.text);
  }

  function promptSections(userText) {
    const persona = [
      PERSONA.lines.join(' '),
      'Aaj: ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '.',
      'Never ask for or repeat API keys, passwords or personal identifiers.'
    ].join(' ');
    const sections = [{ id: 'persona', priority: 1, text: persona }];
    if (BRAIN) {
      sections.push(...BRAIN.contextSections({
        text: userText, memories: loadNotes(), memoryLines: unifiedMemoryLines(userText),
        packs: CN ? CN.matchPacks(userText, loadPacks()) : [], team: readJson(LS.nmTeam, [])
      }));
    }
    const recap = secGet(LS.summary, '');
    if (recap) sections.push({ id: 'recap', priority: 5, text: 'EARLIER IN THIS CHAT (recap): ' + recap });
    const extra = agentContextFor(userText).trim();
    if (extra) sections.push({ id: 'agent', priority: 6, text: extra });
    return sections;
  }

  function personaPrompt(userText) {
    const sections = promptSections(userText);
    return BUDGET ? BUDGET.fit(sections, PROMPT_BUDGET).text : sections.map((x) => x.text).join('\n');
  }


  /** The facts and the playbook that matter for *this* message. */
  function agentContextFor(userText) {
    const parts = [];
    if (skills) {
      const matched = skills.match(userText);
      if (matched.length) {
        parts.push('Playbook jo pehle kaam aaya (follow karo, par jawab me steps ki list mat banao):\n'
          + matched.map((skill) => skill.name + ': ' + skill.steps.join(' → ')).join('\n'));
      }
    }
    /* The recursive part: what earlier chats taught her still reaches a chat
       that started empty. Only the strongest few, never a wall of notes. */
    if (journal) {
      const habits = journal.insights()
        .filter((insight) => (insight.confidence || 0) >= 0.45)
        .slice(0, 4)
        .map((insight) => '- ' + insight.text);
      if (habits.length) {
        parts.push('Pichhli baaton se seekha (halke se follow karo, user ko list mat do):\n' + habits.join('\n'));
      }
    }
    return parts.length ? '\n\n' + parts.join('\n\n') : '';
  }

  function conversationForApi(userText, options = {}) {
    let history = options.noHistory ? [] : state.chat
      .filter((m) => m.text && !m.pending && !m.failed && !String(m.text).startsWith('Maaf karo'))
      .map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.text }));
    if (BUDGET && history.length) {
      // newest turns that fit; what falls off is condensed into a recap instead of vanishing
      const trimmed = BUDGET.trimHistory(history, HISTORY_BUDGET, 2);
      if (trimmed.dropped.length) {
        const old = secGet(LS.summary, '');
        const fresh = BUDGET.summarize(trimmed.dropped, old);
        if (fresh !== old) secSet(LS.summary, fresh);
      }
      history = trimmed.kept;
    } else history = history.slice(-8);
    return [{ role: 'system', content: personaPrompt(userText) }, ...history, { role: 'user', content: userText }];
  }


  /* ══════════════════════════════════════════════════════ AGENT: tools, hygiene */

  const WD_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayIso = () => (PRO ? PRO.istDay(now()) : new Date().toISOString().slice(0, 10));

  /* "har Monday result report" → a recurring task with a real due date. */
  function normalizeTasks(list) {
    if (!MEM || !BRAIN) return list;
    return list.map((n) => {
      if (n.cat !== 'task' || n.rc) return n;
      const r = MEM.parseRepeat(n.text);
      const out = Object.assign({}, n, { rc: 1 });
      if (r.repeat) {
        out.repeat = r.repeat;
        if (Number.isInteger(r.weekday)) out.weekday = r.weekday;
        const cleaned = MEM.cleanRepeatWords(n.text);
        if (cleaned.length >= 3) out.text = cleaned;
        if (!out.due) out.due = r.repeat === 'weekly' && Number.isInteger(r.weekday) ? BRAIN.parseDueDate(WD_NAMES[r.weekday]) : BRAIN.parseDueDate('aaj');
      }
      return out;
    });
  }

  /* One-step undo for anything destructive Jenni (or the owner) does to memory. */
  const undoStack = [];
  function snapshot() {
    undoStack.push({ notes: JSON.parse(JSON.stringify(state.notes)), facts: memory ? memory.all() : [] });
    if (undoStack.length > 5) undoStack.shift();
  }
  function undoLast() {
    const snap = undoStack.pop();
    if (!snap) return false;
    saveNotes(snap.notes);
    secureStore.setItem(LS.memory, JSON.stringify(snap.facts));
    paintMemory();
    return true;
  }

  function completeNote(query) {
    if (!MEM) return null;
    const r = MEM.completeTask(state.notes, query, todayIso(), now());
    if (!r.win) return null;
    snapshot();
    saveNotes(r.notes);
    secSet(LS.wins, [r.win].concat(secGet(LS.wins, [])).slice(0, 200));
    return r;
  }

  function auditPush(entry) { secSet(LS.actions, [entry].concat(secGet(LS.actions, [])).slice(0, 100)); }

  function askApproval({ name, args, tainted }) {
    const what = {
      gmail_draft: `Gmail DRAFT banana — To: ${args.to}, Subject: ${args.subject}`,
      calendar_create_event: `Calendar me event: "${args.title}" @ ${args.start}`,
      delegate_nevermind: `NeverMind agents ko kaam dena: ${String(args.request).slice(0, 120)}`,
      forget: `Memory se hataana: "${args.text}"`,
      correct_memory: `Memory badalna: "${args.wrong}" → "${args.right}"`
    }[name] || `${name} (${JSON.stringify(args).slice(0, 100)})`;
    return Promise.resolve(window.confirm('Jenni ye karna chahti hai:\n• ' + what + (tainted ? '\n\n(Dhyan: ye mail/web/calendar se padhe content ke baad aaya hai — pehchaan lo ki ye aapki hi marzi hai.)' : '') + '\n\nAllow?'));
  }

  function googleReady() {
    return Boolean(GOOGLE && state.drive && state.drive.extended && state.driveToken && state.driveToken.expires > now());
  }
  function googleClient() {
    return GOOGLE.createGoogle({ getToken: async () => { if (!googleReady()) throw new Error('Google connect nahi hai — Drive tab me Connect dabao.'); return state.driveToken.token; } });
  }

  const taskLine = (t) => `${t.text}${t.due ? ' (due ' + t.due + ')' : ''}${t.repeat ? ' [' + t.repeat + ']' : ''}`;
  const toolHandlers = {
    async list_tasks({ filter }) {
      const tasks = state.notes.filter((n) => n.cat === 'task');
      const keep = { all: () => true, overdue: (t) => BRAIN.taskState(t) === 'overdue', today: (t) => BRAIN.taskState(t) === 'today', week: (t) => ['overdue', 'today', 'soon'].includes(BRAIN.taskState(t)) || (t.due && Date.parse(t.due) - now() < 7 * 86400000) }[filter || 'all'] || (() => true);
      const list = tasks.filter(keep);
      return list.length ? list.map(taskLine).join('\n') : 'No matching tasks.';
    },
    async today_overview() {
      const parts = [];
      const tasks = state.notes.filter((n) => n.cat === 'task' && ['overdue', 'today', 'soon'].includes(BRAIN.taskState(n)));
      parts.push(tasks.length ? 'Tasks:\n' + tasks.map(taskLine).join('\n') : 'Tasks: nothing due soon.');
      if (googleReady()) {
        try { const ev = await googleClient().events(1, now()); parts.push(ev.length ? 'Calendar:\n' + ev.map((e) => `${e.start.slice(11, 16) || 'all-day'} ${e.title}`).join('\n') : 'Calendar: free.'); }
        catch (e) { parts.push('Calendar unavailable: ' + e.message); }
      }
      return parts.join('\n');
    },
    async add_task({ title, due, repeat }) {
      const rep = MEM.parseRepeat(title + ' ' + (repeat || ''));
      let list = BRAIN.addMemory(state.notes, MEM.cleanRepeatWords(title) || title, 'task', now(), BRAIN.parseDueDate(due || title, now()));
      if (list === state.notes) return { error: 'Not saved (duplicate, or it looks like private data).' };
      const added = list[list.length - 1];
      if (repeat && !rep.repeat) added.repeat = repeat; else if (rep.repeat) { added.repeat = rep.repeat; if (Number.isInteger(rep.weekday)) added.weekday = rep.weekday; }
      added.rc = 1;
      if (added.repeat && !added.due) added.due = todayIso();
      saveNotes(list);
      return `Saved: ${taskLine(added)}`;
    },
    async complete_task({ title }) {
      const r = completeNote(title);
      return r ? (r.rolled ? `Done — next one scheduled.` : 'Done — task cleared.') : { error: 'No matching task.' };
    },
    async remember({ fact }) {
      if (MEM.isShortcoming(fact)) return { error: 'Not stored: Jenni keeps what helps, not self-criticism.' };
      const list = BRAIN.addMemory(state.notes, fact, null, now());
      if (list === state.notes) return { error: 'Not saved (duplicate or private data).' };
      saveNotes(list);
      return 'Remembered.';
    },
    async search_memory({ query }) {
      const found = MEM.unify({ facts: memory ? memory.all() : [], notes: state.notes, text: query, now: now(), limit: 6 }).map((i) => '- ' + i.text);
      const tasks = state.notes.filter((n) => n.cat === 'task' && MEM.overlap(query, n.text) > 0.3).map((t) => '- [task] ' + taskLine(t));
      return found.concat(tasks).join('\n') || 'Nothing remembered about that.';
    },
    async forget({ text }) {
      snapshot();
      const before = state.notes.length + (memory ? memory.all().length : 0);
      saveNotes(BRAIN.removeMemory(state.notes, text));
      if (memory) memory.all().filter((f) => MEM.overlap(text, f.text) >= 0.6).forEach((f) => memory.forget(f.id));
      const after = state.notes.length + (memory ? memory.all().length : 0);
      return before === after ? { error: 'Nothing matched.' } : `Removed ${before - after} item(s). (Say "undo" to bring it back.)`;
    },
    async correct_memory({ wrong, right }) {
      snapshot();
      const r = MEM.correct({ facts: memory ? memory.all() : [], notes: state.notes }, wrong, right);
      secureStore.setItem(LS.memory, JSON.stringify(r.facts));
      let notes = r.notes;
      if (r.add && !MEM.isShortcoming(r.add)) notes = BRAIN.addMemory(notes, r.add, null, now());
      saveNotes(notes); paintMemory();
      return 'Corrected. (Say "undo" to revert.)';
    },
    async make_document({ type, fields }) {
      const values = Object.assign({ lang: 'hi' }, fields || {});
      const built = officeMake(type, values);
      const issues = VERIFY.check(built.text, { document: true, udise: BRAIN.OWNER.udise }).issues.map((i) => i.msg);
      saveDraft(built.text, true);
      return { saved_to_drafts: built.title, issues, preview: built.text.slice(0, 500) };
    },
    async calendar_events({ days }) { const ev = await googleClient().events(days || 1, now()); return ev.length ? ev.map((e) => `${e.start} — ${e.title}${e.where ? ' @ ' + e.where : ''}`).join('\n') : 'No events.'; },
    async gmail_search({ query, max }) { const m = await googleClient().searchMail(query, max || 5); return m.length ? m.map((x) => `From: ${x.from} | ${x.subject} | ${x.date}\n${x.snippet}`).join('\n---\n') : 'No messages.'; },
    async gmail_draft(a) { await googleClient().createDraft(a); return 'Draft saved in Gmail (not sent).'; },
    async calendar_create_event(a) { const r = await googleClient().createEvent(a); return 'Event created.' + (r.link ? ' ' + r.link : ''); },
    async delegate_nevermind({ request }) {
      const nm = nmClient(); if (!nm) return { error: 'NeverMind not connected.' };
      const r = await nm.delegate(request);
      return `${r.status}: ${r.summary}\n` + r.files.map((f) => `${f.name}: ${f.url}`).join('\n');
    },
    async read_github_repo({ repo }) { return (await GH.readRepo(repo)).apiBlock; }
  };

  function getToolbox() {
    return TOOLS.createToolbox({
      handlers: toolHandlers, approve: askApproval, audit: auditPush,
      autonomy: () => localStorage.getItem(LS.autonomy) || 'smart',
      available: (n) => (n === 'google' ? googleReady() : n === 'nevermind' ? Boolean(nmClient()) : true),
      now
    });
  }

  const looksLikeToolUnsupported = (e) => /tool|function|tool_choice/i.test(String(e && e.message)) && !/key|quota|limit/i.test(String(e && e.message));

  async function runToolTurn(clean, repoContext, turn) {
    const out = await TOOLS.runLoop({
      chat: (msgs, tools) => askProvider(msgs, Object.assign({ raw: true, maxTokens: 700 }, tools ? { tools } : {})),
      messages: conversationForApi(clean + repoContext),
      toolbox: getToolbox(),
      turn
    });
    return out.text;
  }

  /* Deterministic check of what she wrote; one repair pass when it is wrong. */
  async function verifyReply(reply, clean, repoContext, canRepair) {
    if (!VERIFY || !reply) return { reply, checks: null };
    const docLike = Boolean(DOCS.looksLikeDocumentText(reply) || DOCS.looksLikeDocRequest(clean));
    const ctx = { udise: BRAIN.OWNER.udise, document: docLike };
    let res = VERIFY.check(reply, ctx);
    if (!res.ok && canRepair) {
      try {
        setStatus('busy');
        const fixed = await askProvider(
          conversationForApi(clean + repoContext).concat([{ role: 'assistant', content: reply }, { role: 'user', content: VERIFY.repairPrompt(res.issues) }]),
          { maxTokens: 900, temperature: 0.2 }
        );
        const again = VERIFY.check(fixed, ctx);
        const errs = (r) => r.issues.filter((i) => i.level === 'error').length;
        if (fixed && errs(again) < errs(res)) { reply = fixed; res = again; }
      } catch (e) { /* keep the original; the warning below still shows */ }
    }
    const notes = res.issues.map((i) => (i.level === 'error' ? '⚠ ' : '• ') + i.msg);
    if (!notes.length && !docLike) return { reply, checks: null };
    return { reply, checks: { ok: res.ok, notes: notes.slice(0, 4) } };
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
    if (message.pending && !message.text) {
      bubble.classList.add('is-thinking');
      bubble.innerHTML = '<i></i><i></i><i></i>';
    } else if (message.pending) {
      bubble.classList.add('is-streaming');
      bubble.innerHTML = renderMd(message.text);
    } else if (message.role === 'me') {
      bubble.textContent = message.text;
    } else {
      bubble.innerHTML = renderMd(message.text);
    }
    row.appendChild(bubble);

    if (message.checks && !message.pending) {
      const strip = document.createElement('div');
      strip.className = 'msg__checks' + (message.checks.ok ? ' is-ok' : ' is-warn');
      strip.textContent = message.checks.notes.length ? message.checks.notes.join('  ') : '✓ Date, hisaab aur format check ho gaya';
      row.appendChild(strip);
    }

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

      /* 👍 / 👎 — the fastest signal a phone user can give, and the one the
         agent actually learns from (memory confidence, skill rating). */
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'msg__tool msg__tool--rate';
      up.textContent = '👍';
      up.setAttribute('aria-label', 'Pasand aaya — yaad rakho');
      up.setAttribute('aria-pressed', message.rating === 'up' ? 'true' : 'false');
      if (message.rating === 'up') up.classList.add('is-on');
      up.addEventListener('click', () => rateReply(message, 'up'));

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'msg__tool msg__tool--rate';
      down.textContent = '👎';
      down.setAttribute('aria-label', 'Pasand nahi aaya — agla alag');
      down.setAttribute('aria-pressed', message.rating === 'down' ? 'true' : 'false');
      if (message.rating === 'down') down.classList.add('is-on');
      down.addEventListener('click', () => rateReply(message, 'down'));

      foot.append(save, copy, up, down);

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
      case 'BUSY': return 'Provider ki limit lag gayi. ' + outageSentence(error);
      case 'HTTP_5XX': return outageSentence(error);
      case 'MODEL_NOT_FOUND': return error.message;
      case 'AUTH': return error.message;
      default: return (error && error.message) || 'Kuch galat hua.';
    }
  }

  /* Last turn's real timings, shown in the app bar ("ready · 430 ms"). */
  function latencyLabel() {
    const ms = Math.round(Number(state.lastLatency) || 0);
    if (!ms) return '';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
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
    if (!clean) return;
    if (state.busy) {
      // Talking over her counts as talking *to* her: only an explicit spoken
      // sentence may pre-empt a turn, and only if the new turn then owns the
      // busy flag (see `token` below), never while the recogniser is just
      // echoing her own voice back.
      if (!options.fromVoice || !options.interrupt) return;
      interruptTurn();
      state.busy = false;                 // the old turn's finally() will see a newer token
    }
    if (!state.cfg || !state.cfg.apiKey) {
      openSheet('setup');
      setResult('setupResult', 'Pehle API key daal ke Save dabao.', 'error');
      return;
    }

    if (/^(undo|wapas karo|pichla badlav wapas|undo that)\.?$/i.test(clean)) {
      toast(undoLast() ? 'Pichla badlav wapas kar diya' : 'Wapas karne ko kuch nahi', false);
      return;
    }
    if (BRAIN) {
      const cmd = BRAIN.userCommand(clean);
      if (cmd && MEM && MEM.isShortcoming(cmd.body)) toast('Ye main yaad nahi rakhungi — hum aapki taakat par kaam karte hain', false);
      else if (cmd) { snapshot(); saveNotes(BRAIN.applyOps(loadNotes(), [cmd])); toast('Yaad rakh liya', false); }
    }
    if (PRO) secSet(LS.activity, PRO.recordIntent(secGet(LS.activity, {}), PRO.intentOf(clean), now()));

    // A live session answers typed text on the same socket (no extra round-trip).
    if (live.state === 'live' && liveSendText(clean)) {
      state.chat.push({ role: 'me', text: clean });
      paintChat();
      $('input').value = '';
      autoGrow($('input'));
      return;
    }
    state.busy = true;
    // Turn token: an interrupted turn must not clear the flag that the newer
    // turn just set, or two replies would interleave in the transcript.
    const token = (state.turnSeq = (state.turnSeq || 0) + 1);
    $('input').value = '';
    autoGrow($('input'));
    $('btnSend').disabled = true;
    // A spoken turn gets a hard 30 s budget: past that, the loop should hear the
    // user again rather than sit in a silent "soch rahi hai" forever.
    let voiceGuard = null;
    if (voice.mode && options.fromVoice) {
      voiceGuard = setTimeout(() => { if (state.busy) interruptTurn(); }, VOICE_TURN_MS);
    }

    state.chat.push({ role: 'me', text: clean });
    const pending = { role: 'jenni', text: '', pending: true };
    state.chat.push(pending);
    paintChat();
    setStatus('busy');

    const turnStart = now();
    let reply = '';
    let untrusted = false;                 // external text in this turn → it may not write memory
    const speaker = (voice.mode || options.speakAlways) && voiceEnabled() && window.speechSynthesis ? createSpeaker() : null;
    let streamed = '', lastPaint = 0;
    const onDelta = (chunk) => {
      streamed += chunk;
      pending.text = streamed.replace(/\[\[[\s\S]*$/, '').trim();       // hide a memory tag while it is being written
      const t = Date.now();
      if (t - lastPaint > 80) { lastPaint = t; paintChat(); }
      if (speaker) speaker.push(chunk);
    };
    const onReset = () => { streamed = ''; pending.text = ''; if (speaker) speaker.reset(); };
    voice.activeSpeaker = speaker;
    try {
      if (navigator.onLine === false) throw Object.assign(new Error('Internet nahi hai — connect hote hi dobara bhejna.'), { code: 'OFFLINE' });
      // Voice: keep the reply short so speech starts fast. Typed: allow more.
      const repoContext = await repoContextFor(clean);

      // Learn durable facts before asking — "mera naam Aarav hai" must survive
      // the next reload, not just this conversation.
      if (memory && !(MEM && MEM.isShortcoming(clean))) {
        const learned = memory.observe(clean, 'chat');
        if (learned.length) memory.compact();
      }

      // Greeting / "haan sir" / "ok" in voice mode is answered in ~0 ms — no
      // model round-trip at all. This is the single biggest perceived-speed win.
      const quick = FAST && voice.mode && options.fromVoice ? FAST.quickReply(clean) : null;
      if (quick) {
        reply = quick;
        pending.text = quick;
        pending.pending = false;
        paintChat();
      }

      let delegated = null;
      const nm = !reply && nmClient();
      if (nm && CN && CN.wantsDelegation(clean)) {
        try {
          delegated = await nm.delegate(CN.stripPrefix(clean));
        } catch (error) { toast('NeverMind: ' + error.message, true); }   // fall back to plain chat
      }
      const turn = { tainted: Boolean(repoContext) };
      if (delegated || repoContext) untrusted = true;
      let usedTools = false;
      if (!reply && !delegated && TOOLS && !state.noTools && TOOLS.needsTools(clean)) {
        try {
          reply = await runToolTurn(clean, repoContext, turn);
          usedTools = Boolean(reply);
          if (turn.tainted) untrusted = true;
        } catch (error) {
          if (looksLikeToolUnsupported(error)) state.noTools = true;        // this provider/model has no function calling
          else throw error;
        }
      }
      if (usedTools) {
        /* answered through tools */
      } else if (delegated) {
        reply = ['NeverMind agents (' + delegated.status + '):', delegated.summary]
          .concat(delegated.files.map((f) => `[${f.name}](${f.url})`)).join('\n\n');
      } else if (!reply) {
        reply = await askProvider(
          conversationForApi(clean + repoContext),
          { maxTokens: voice.mode ? 160 : 600, temperature: voice.mode ? 0.55 : 0.8, onDelta, onReset, turnToken: token }
        );
      }

      // One self-check pass: a plan-shaped question deserves more than "haan".
      if (AGENT.critiqueAnswer && !voice.mode && !(speaker && speaker.spoken())) {
        const verdict = AGENT.critiqueAnswer(reply, clean);
        if (!verdict.ok) {
          setStatus('busy');
          const better = await askProvider(
            conversationForApi(clean + repoContext
              + '\n\n[Tumhara pichla draft is wajah se adhura tha: ' + verdict.reason
              + '. Ab poora, seedha aur kaam ka jawab do.]'),
            { maxTokens: 700 }
          );
          if (better && better.length > reply.length * 0.6) reply = better;
        }
      }
      if (BRAIN) {
        const parsed = BRAIN.extractOps(reply);
        reply = parsed.text;
        const ops = MEM ? parsed.ops.filter((o) => !MEM.isShortcoming(o.body)) : parsed.ops;
        if (ops.length && !untrusted) { snapshot(); saveNotes(BRAIN.applyOps(loadNotes(), ops)); toast('Memory update ho gayi', false); }
      }
      if (!delegated) {
        // Voice: no repair round-trip (it doubles latency for a slightly cleaner
        // sentence). Typed chat keeps the full check-and-fix behaviour.
        const v = await verifyReply(reply, clean, repoContext, !voice.mode && !options.fromVoice && !(speaker && speaker.spoken()));
        reply = v.reply;
        if (v.checks) pending.checks = v.checks;
      }
      /* A useful step-by-step answer becomes a reusable playbook, so the next
         similar question starts from experience instead of zero (Hermes-style). */
      if (skills && AGENT.skillFrom && reply) {
        const learned = AGENT.skillFrom(clean, reply);
        if (learned) skills.learn(learned);
      }
      pending.pending = false;
      pending.text = reply;
      state.lastLatency = now() - turnStart;          // whole turn, what the user actually waits
      const took = latencyLabel();
      setStatus('ok', providerName() + ' · ' + state.cfg.model + (took ? ' · ' + took : ''));
    } catch (error) {
      pending.pending = false;
      if (error && error.code === 'CANCELLED') {
        // The user started a new sentence while this turn was still running.
        // Drop the half answer quietly; the new turn owns the conversation.
        pending.cancelled = true;
        state.chat = state.chat.filter((m) => m !== pending);
        reply = '';
      } else {
        pending.failed = true;                 // drives the Retry button
        if (speaker) speaker.reset();
        pending.text = 'Jawab nahi aaya. ' + plainError(error);
        pending.retryText = clean;             // the question to send again
        reply = '';
        setStatus('error');
        if (voice.mode || options.speakAlways) voiceFailedTurn(error);
      }
    } finally {
      clearTimeout(voiceGuard);
      if (state.turnSeq === token) {
        state.busy = false;
        $('btnSend').disabled = false;
      }
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

    if (reply) voice.deadStreak = 0;               // the provider is answering again

    // Voice mode always reads the answer; typed chat only when the user asked.
    if (speaker && speaker.spoken() && reply) await speaker.finish();     // already speaking as it streamed
    else if (options.speakAlways || voice.mode) await speak(reply);
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
    restartTimer: null,
    wake: null,
    lastWake: 0,
    barge: null,
    saying: '',
    activeSpeaker: null,
    /* Two-way-loop bookkeeping: consecutive dead turns (provider down, mic
       refused) and the timer that speaks the "provider down" notice once. */
    deadStreak: 0,
    retryNotice: null,
    lastUserAt: 0,
    lastSaid: ''
  };

  /* How long a turn may take before the loop is allowed to listen again anyway.
     Typed chat keeps its own 75 s deadline; only the voice loop uses this. */
  const VOICE_TURN_MS = 30000;

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


  /* ── voice engines: browser (default), ElevenLabs, or any OpenAI-compatible server ── */
  const loadVoiceCfg = () => (VOICES ? VOICES.normalizeConfig(secGet(LS.voicecfg, {})) : { tts: { engine: 'browser' }, stt: { engine: 'default' } });
  let extPlayer = null;

  function externalTts() {
    if (!VOICES || voice.extFailed) return null;
    const tts = VOICES.createTts(loadVoiceCfg().tts);
    if (!tts) return null;
    extPlayer = extPlayer || VOICES.createPlayer({});
    return { tts, player: extPlayer };
  }
  function externalStt() {
    if (!VOICES || voice.sttFailed) return null;
    const c = loadVoiceCfg();
    return VOICES.createStt(c.stt, c.tts);
  }
  function stopEngines() {
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    if (extPlayer) extPlayer.stop();
  }
  /* Autoplay policies: one silent clip during a tap lets later sentences play. */
  function unlockAudio() {
    if (!AUDIO || !externalTts() || typeof Audio === 'undefined') return;
    try {
      const wav = AUDIO.encodeWav(new Float32Array(160), 16000);
      const a = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
      const p = a.play(); if (p && p.catch) p.catch(() => {});
    } catch (e) { /* not available */ }
  }

  function browserChunk(clean) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) { resolve(false); return; }
      try {
        const u = makeUtterance(clean);
        u.onend = () => resolve(true); u.onerror = () => resolve(false);
        window.speechSynthesis.speak(u);
      } catch (e) { resolve(false); }
    });
  }

  /* One sentence, through whichever engine is chosen. A failing paid/remote
     engine never leaves her silent: it explains once and the phone voice takes over. */
  function speakChunk(clean) {
    const ext = externalTts();
    if (!ext) return browserChunk(clean);
    return new Promise((resolve) => {
      ext.player.enqueue(ext.tts.synth(clean), {
        onEnd: (error) => {
          if (!error) { resolve(true); return; }
          if (!voice.extFailed) toast(error.message + ' — phone ki awaaz par laut rahi hoon', true);
          voice.extFailed = true;
          ext.player.whenIdle().then(() => browserChunk(clean)).then(resolve);
        }
      });
    });
  }

  function makeUtterance(clean) {
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = voice.lang;
    const chosen = voice.ttsVoice || pickVoice(voice.lang);
    if (chosen) utterance.voice = chosen;
    utterance.rate = 1.06;
    utterance.pitch = 1.08;
    utterance.volume = 1;
    return utterance;
  }

  /* Speaks a reply while it is still being written: complete sentences are
     queued on the speech engine as they arrive, so the first words are heard
     after one sentence, not after the whole answer. Memory tags are never read. */
  function createSpeaker() {
    let buf = '', cut = false, pendingCount = 0, spokenCount = 0, closed = false, waiter = null;
    const settle = () => { if (closed && pendingCount === 0 && waiter) { const w = waiter; waiter = null; w(); } };
    function say(raw) {
      const clean = speakableText(raw);
      if (!clean || !voiceEnabled() || (!window.speechSynthesis && !externalTts())) return;
      pendingCount += 1; spokenCount += 1;
      voice.speaking = true; voice.saying = (voice.saying + ' ' + clean).slice(-1200); paintVoiceUi(); onSpeakingChanged(true);
      const end = () => { pendingCount -= 1; if (pendingCount <= 0) { voice.speaking = false; paintVoiceUi(); onSpeakingChanged(false); } settle(); };
      speakChunk(clean).then(end, end);
    }
    function drain(final) {
      for (;;) {
        const m = buf.match(/^[\s\S]*?[.!?।\n](?=\s|$)/);
        let take = m && (m[0].trim().length >= 24 || final || /[\n।]$/.test(m[0])) ? m[0] : '';
        if (!take && buf.length > 160) { const i = buf.lastIndexOf(',', 150); take = buf.slice(0, i > 40 ? i + 1 : 150); }
        if (!take) break;
        buf = buf.slice(take.length);
        say(take);
      }
      if (final && buf.trim()) { say(buf); buf = ''; }
    }
    return {
      push(chunk) {
        if (cut || closed) return;
        buf += chunk;
        const i = buf.indexOf('[[');
        if (i >= 0) { buf = buf.slice(0, i); cut = true; }
        drain(cut);
      },
      mute() { cut = true; buf = ''; },
      reset() { buf = ''; cut = false; stopEngines(); pendingCount = 0; spokenCount = 0; },
      spoken: () => spokenCount > 0,
      finish() {
        closed = true; drain(true);
        if (pendingCount === 0) return Promise.resolve();
        return new Promise((resolve) => { waiter = resolve; setTimeout(resolve, 60000); });
      }
    };
  }

  function speak(text) {
    const clean = speakableText(text);
    if (!clean || !voiceEnabled() || (!window.speechSynthesis && !externalTts())) return Promise.resolve(false);
    stopEngines();
    voice.speaking = true;
    voice.saying = clean;
    paintVoiceUi();
    onSpeakingChanged(true);
    // A touch quicker and brighter than the phone default (see makeUtterance): a
    // 21-year-old chatting, not a narrator.
    return speakChunk(clean).then((ok) => {
      voice.speaking = false; paintVoiceUi(); onSpeakingChanged(false);
      // The answer is over → the mic must reopen even if the caller forgot to
      // schedule it. That is what makes "bolo → jawab → phir bolo" two-way.
      resumeListeningAfterSpeech();
      return ok;
    });
  }

  /* Called whenever Jenni stops talking. Restarts the loop unless something
     newer already took over (another turn, a stop word, voice mode off, or a
     live barge-in listener that is already hearing the user). */
  function resumeListeningAfterSpeech() {
    if (!voice.mode || voice.stopping || state.busy) return;
    if (voice.speaking) return;
    if (voice.barge) return;                 // barge-in listener owns the mic
    scheduleListen(220);
  }

  function stopSpeaking() {
    stopEngines();
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
        if (voice.mode) scheduleListen(500);
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
      // The scheduler waits out speaking/busy by itself, so ask immediately:
      // a 420 ms extra delay on every single turn made the loop feel laggy.
      if (voice.mode && !voice.stopping) resumeListeningAfterSpeech();
    };

    return recognition;
  }

  /* Re-arm until the mic is actually allowed to open. The old version fired
     once and returned if Jenni was still speaking, so the loop could stay shut
     after a slow answer — that is what made the conversation feel one-way. */
  function scheduleListen(delay) {
    clearTimeout(voice.restartTimer);
    const gaveUpAt = Date.now() + 60000;
    const tick = () => {
      if (!voice.mode) return;
      if (voice.stopping) return;
      if (state.busy || voice.speaking) {
        if (Date.now() < gaveUpAt) voice.restartTimer = setTimeout(tick, 350);
        return;
      }
      if (voice.listening) return;          // already open, nothing to do
      listenOnce();
    };
    voice.restartTimer = setTimeout(tick, Math.max(0, delay));
  }

  function listenOnce() {
    if (!voice.mode || voice.speaking || state.busy) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor || externalStt()) { fallbackRecording(); return; }
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


  /* ── "Hey Jenni" (wake word) and talking over her (barge-in) ───────────────
     Both use the browser's own speech recognition, so they work only while the
     page is open and visible — a browser limit, not a choice. Barge-in is off by
     default: without headphones the phone can hear itself. */
  const WAKE_RE = /(?:\b(?:hey|hi|hello|ok|okay|arre|are|oye)\s+)?\b(jenni|jenny|jennie|jeni|jenie|जेनी|जेन्नी|जेनि)\b[\s,.!?]*/i;
  const wakeOn = () => localStorage.getItem('jenni_wake_on') === '1';
  const bargeOn = () => localStorage.getItem('jenni_barge_on') === '1';

  function startWake() {
    if (!wakeOn() || voice.mode || voice.wake || document.hidden || !voiceEnabled() || !state.cfg || !state.cfg.apiKey) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = voice.lang; r.continuous = true; r.interimResults = true;
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const text = ev.results[i][0].transcript;
        const m = text.match(WAKE_RE);
        if (!m || now() - voice.lastWake < 2500) continue;
        const rest = text.slice(m.index + m[0].length).trim();
        if (rest && !ev.results[i].isFinal) return;            // wait until the sentence is complete
        voice.lastWake = now();
        stopWake();
        startVoiceMode();
        if (rest && rest.split(/\s+/).length >= 2) handleVoiceInput(rest);
        return;
      }
    };
    r.onend = () => { if (voice.wake === r) { voice.wake = null; if (wakeOn() && !voice.mode && !document.hidden) setTimeout(startWake, 700); } };
    r.onerror = (e) => {
      if (voice.wake === r) voice.wake = null;
      if (e && /not-allowed|service-not-allowed/.test(e.error)) { localStorage.setItem('jenni_wake_on', '0'); toast('Mic permission chahiye — Hey Jenni band', true); }
    };
    voice.wake = r;
    try { r.start(); } catch (e) { voice.wake = null; }
  }
  function stopWake() {
    const r = voice.wake; voice.wake = null;
    if (r) { r.onend = null; r.onerror = null; try { r.abort(); } catch (e) { /* ignore */ } }
  }

  function startBarge() {
    if (!bargeOn() || !voice.mode || voice.barge || !MEM) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = voice.lang; r.continuous = true; r.interimResults = true;
    r.onresult = (ev) => {
      let text = '', final = false;
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) { text += ev.results[i][0].transcript; final = final || ev.results[i].isFinal; }
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (words.length < 3 || MEM.overlap(text, voice.saying) >= 0.5) return;      // too short, or just her own voice
      if (voice.speaking) { if (voice.activeSpeaker) voice.activeSpeaker.mute(); stopSpeaking(); }
      if (final) { stopBarge(); handleVoiceInput(text); }
    };
    r.onend = () => { if (voice.barge === r) voice.barge = null; };
    r.onerror = () => { if (voice.barge === r) voice.barge = null; };
    voice.barge = r;
    try { r.start(); } catch (e) { voice.barge = null; }
  }
  function stopBarge() {
    const r = voice.barge; voice.barge = null;
    if (r) { r.onend = null; r.onerror = null; try { r.abort(); } catch (e) { /* ignore */ } }
  }
  function onSpeakingChanged(on) { if (on) startBarge(); else stopBarge(); }

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
      let capMs = 6000;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (AUDIO && Ctx && Ctx.prototype && Ctx.prototype.createAnalyser) {
        // stop when the owner stops talking, not after a fixed timer
        try {
          voice.audioCtx = voice.audioCtx || new Ctx();
          const src = voice.audioCtx.createMediaStreamSource(stream);
          const analyser = voice.audioCtx.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
          const buf = new Uint8Array(analyser.fftSize), vad = AUDIO.createVad(), t0 = now();
          const poll = setInterval(() => {
            analyser.getByteTimeDomainData(buf);
            if (recorder.state !== 'recording') { clearInterval(poll); return; }
            if (vad.feed(AUDIO.rmsOf(buf), now() - t0) === 'done') { clearInterval(poll); recorder.stop(); }
          }, 100);
          capMs = 16000;
        } catch (e) { /* analyser unavailable: the fixed timer below still ends the recording */ }
      }
      voice.recordingTimer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, capMs);
    } catch (error) {
      voice.listening = false;
      voice.mode = false;
      paintVoiceUi();
      toast('Mic ki permission chahiye.', true);
    }
  }

  /* Providers with no /audio/transcriptions (Gemini) can still hear: the
     recording goes through the chat endpoint as WAV and comes back as text. */
  async function transcribeViaChat(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!AUDIO || !Ctx) throw new Error('Is browser me awaaz decode nahi ho paati — Chrome par kholo.');
    voice.audioCtx = voice.audioCtx || new Ctx();
    const wav = await AUDIO.blobToWav(blob, voice.audioCtx);
    if (wav.seconds < 0.4) return '';
    const lang = voice.lang.startsWith('hi') ? 'Hindi / Hinglish' : 'English';
    const text = await callProvider([{ role: 'user', content: [
      { type: 'text', text: `Transcribe this audio exactly as spoken (${lang}). Keep the speaker's own language, and Roman letters if they spoke Hinglish. Output only the transcript. If there is no clear speech, output exactly: [silence]` },
      { type: 'input_audio', input_audio: { data: wav.base64, format: wav.format } }
    ] }], { maxTokens: 300, temperature: 0 });
    const out = String(text).trim();
    return /^\[?\s*silence\s*\]?\.?$/i.test(out) ? '' : out.replace(/^["'“]|["'”]$/g, '');
  }

  async function transcribeWithProvider(blob) {
    const cfg = state.cfg;
    const ext = externalStt();
    if (ext) {
      try { return await ext.transcribe(blob, { lang: voice.lang }); }
      catch (error) { voice.sttFailed = true; throw new Error(error.message + ' — ab default sunne wala tareeka chalega.'); }
    }
    if (cfg && (cfg.transcribe === 'chat' || (!cfg.transcribe && isGemini(cfg)))) return transcribeViaChat(blob);
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

  /* ══════════════════════════════════════════════════════════════ LIVE VOICE

     Gemini 2.5 Flash native audio, full duplex: one WebSocket carries the mic up
     and her voice down, so she hears the user while she is still talking and a
     spoken word stops her mid-sentence (server-side VAD + interrupt). That is
     the "phone call" feel; the turn-based loop below is the fallback and keeps
     working exactly as before when Live is off or unavailable.
     ---------------------------------------------------------------------- */

  const liveOn = () => {
    try { return localStorage.getItem('jenni_live_on') === '1'; } catch (error) { return false; }
  };

  /* The Live API needs a Gemini key. If the active provider is Gemini it reuses
     that key; otherwise the key saved under "Live voice" is used, so a Groq-only
     setup can still have a native-audio voice. */
  function liveKey() {
    const cfg = state.cfg || {};
    if (isGemini(cfg) && cfg.apiKey) return cfg.apiKey;
    return String(cfg.liveKey || '').trim();
  }

  function liveInstructions() {
    const manner = PERSONA_SHARED ? PERSONA_SHARED.MANNER.join(' ') : 'Address the user as "sir", be humble and very short.';
    return [
      PERSONA.lines.join(' '),
      manner,
      'Ye ek live phone call hai. Ek-do chhote vaakya bolo, phir ruk jao taaki user bol sake. Lists, markdown, emoji — kuch nahi.',
      'Aaj: ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '.',
      'Never ask for or repeat API keys, passwords or personal identifiers.'
    ].join(' ');
  }

  const live = {
    socket: null,
    ctx: null,
    stream: null,
    node: null,
    player: null,
    state: 'off',          // off | connecting | live | closing
    retries: 0,
    startedAt: 0,
    firstAudioAt: 0,
    said: ''
  };

  function liveAvailable() {
    return Boolean(LIVE && window.WebSocket && (window.AudioContext || window.webkitAudioContext));
  }

  /** Open the duplex session. */
  async function startLive() {
    if (!liveAvailable()) throw new Error('Live voice is browser me nahi chalta.');
    const key = liveKey();
    if (!key) throw new Error('Live voice ke liye Gemini key chahiye (Setup → Live voice).');
    if (live.state === 'live') return;
    if (live.socket && live.state === 'connecting') return;

    live.state = 'connecting';
    live.startedAt = now();
    live.firstAudioAt = 0;
    live.said = '';
    paintVoiceUi();

    const Ctx = window.AudioContext || window.webkitAudioContext;
    live.ctx = live.ctx || new Ctx();
    if (live.ctx.state === 'suspended') { try { await live.ctx.resume(); } catch (error) { /* ignore */ } }

    const ws = new WebSocket(LIVE.url(key, 'v1beta'));
    live.socket = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify(LIVE.setupMessage({
        model: (state.cfg && state.cfg.liveModel) || LIVE.MODELS[0],
        voice: (state.cfg && state.cfg.liveVoice) || LIVE.DEFAULT_VOICE,
        instructions: liveInstructions()
      })));
    };

    ws.onmessage = async (event) => {
      const raw = typeof event.data === 'string' ? event.data : await blobText(event.data);
      const packet = LIVE.readPacket(raw);
      if (!packet) return;
      if (packet.kind === 'ready') {
        live.state = 'live';
        live.retries = 0;
        paintVoiceUi();
        startLiveMic();
        return;
      }
      if (packet.kind === 'audio') {
        if (!live.firstAudioAt) live.firstAudioAt = now();
        live.player = live.player || LIVE.createPlayer(live.ctx, packet.rate);
        live.player.play(LIVE.decodePcm(packet.pcm));
        voice.speaking = true;
        paintVoiceUi();
        return;
      }
      if (packet.kind === 'text') {
        if (packet.role === 'jenni') {
          live.said = (live.said + ' ' + packet.text).slice(-800);
          setTranscript(packet.text, false);
        } else {
          setTranscript(packet.text, false);
          voice.lastUserAt = now();
        }
        return;
      }
      if (packet.kind === 'interrupted') {
        if (live.player) live.player.stop();      // the user spoke over her — go quiet now
        voice.speaking = false;
        paintVoiceUi();
        return;
      }
      if (packet.kind === 'turnComplete') {
        voice.speaking = false;
        paintVoiceUi();
        return;
      }
      if (packet.kind === 'close') closeLive('remote');
    };

    ws.onerror = () => { /* onclose carries the actionable reason */ };
    ws.onclose = (event) => closeLive(event && event.reason ? event.reason : 'socket');
  }

  async function blobText(data) {
    if (data instanceof Blob) return data.text();
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    return String(data || '');
  }

  /** Microphone → 16 kHz PCM16 → socket, in ~100 ms chunks. */
  function startLiveMic() {
    if (!live.ctx || !navigator.mediaDevices || !live.ctx.createMediaStreamSource) return;
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        if (!voice.mode) { stream.getTracks().forEach((t) => t.stop()); return; }
        live.stream = stream;
        const source = live.ctx.createMediaStreamSource(stream);
        // ScriptProcessor is deprecated but universal; AudioWorklet needs a
        // separate module file, which is not worth it for a phone app.
        const node = live.ctx.createScriptProcessor(2048, 1, 1);
        live.node = node;
        source.connect(node);
        node.connect(live.ctx.destination);
        node.onaudioprocess = (event) => {
          if (!live.socket || live.socket.readyState !== 1 || live.state !== 'live') return;
          if (voice.speaking) return;      // half-duplex guard when echo cancellation is weak
          const input = event.inputBuffer.getChannelData(0);
          const pcm = AUDIO ? AUDIO.resample(input, live.ctx.sampleRate, LIVE.INPUT_RATE) : input;
          live.socket.send(JSON.stringify(LIVE.audioMessage(LIVE.encodeMic(pcm))));
        };
        voice.listening = true;
        paintVoiceUi();
      })
      .catch(() => {
        toast('Mic ki permission chahiye — Live voice band, normal voice chalega.', true);
        closeLive('mic');
      });
  }

  function stopLiveMic() {
    if (live.node) { try { live.node.disconnect(); } catch (error) { /* ignore */ } live.node.onaudioprocess = null; live.node = null; }
    if (live.stream) { live.stream.getTracks().forEach((t) => t.stop()); live.stream = null; }
    voice.listening = false;
  }

  /** Close the session; restart once or twice if the provider dropped us. */
  function closeLive(reason) {
    const wasLive = live.state === 'live' || live.state === 'connecting';
    if (!live.socket && live.state === 'off' && !voice.speaking) return;   // nothing to close
    const ws = live.socket;
    live.socket = null;                                    // detach first so close() cannot re-enter
    live.state = 'off';
    stopLiveMic();
    if (live.player) live.player.stop();
    if (ws) {
      ws.onclose = null; ws.onmessage = null; ws.onerror = null;
      try { ws.close(); } catch (error) { /* ignore */ }
    }
    voice.speaking = false;
    paintVoiceUi();
    if (!voice.mode) return;
    const retryable = reason !== 'user' && reason !== 'mic' && !/key|quota|permission/i.test(String(reason));
    if (wasLive && retryable && live.retries < 2) {
      live.retries += 1;
      toast('Live connection toot gaya — dobara jod rahi hoon…', true);
      setTimeout(() => { if (voice.mode) startLive().catch(fallbackToTurnLoop); }, 600 * live.retries);
      return;
    }
    if (reason !== 'user') fallbackToTurnLoop();
  }

  function fallbackToTurnLoop() {
    if (!voice.mode) return;
    live.state = 'off';
    try { localStorage.setItem('jenni_live_on', '0'); } catch (error) { /* ignore */ }
    if (!voice.warnedFallback) {
      voice.warnedFallback = true;
      toast('Live voice nahi chal payi — normal voice mode chalu hai.', true);
    }
    paintVoiceUi();
    listenOnce();
  }

  /** Typed text while a live session is open goes down the same socket. */
  function liveSendText(text) {
    if (!live.socket || live.socket.readyState !== 1 || live.state !== 'live') return false;
    live.socket.send(JSON.stringify(LIVE.textMessage(text)));
    return true;
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
      const liveNow = live.state === 'live';
      label.textContent = !voice.mode ? 'Voice mode band'
        : live.state === 'connecting' ? 'Live jod rahi hoon…'
          : voice.speaking ? (liveNow ? 'Bol rahi hoon — bolo to ruk jaungi' : 'Bol rahi hoon…')
            : voice.listening ? (liveNow ? 'Live · sun rahi hoon' : 'Sun rahi hoon…')
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
    if (!state.cfg || !(state.cfg.apiKey || (liveOn() && liveKey()))) {
      openSheet('setup');
      setResult('setupResult', 'Voice mode ke liye pehle API key save karo.', 'error');
      return;
    }
    stopWake();
    stopSpeaking();
    unlockAudio();
    voice.mode = true;
    voice.lastHandled = '';
    localStorage.setItem('jenni_voice_auto', '1');
    setTranscript('', false);
    paintVoiceUi();
    // Native-audio full duplex first (Gemini Live): she hears and is heard at the
    // same time, and a spoken word cuts her off. Falls back to the turn-based
    // loop when Live is off, unavailable, or has no Gemini key.
    if (liveOn() && liveAvailable() && liveKey()) {
      startLive().catch(() => fallbackToTurnLoop());
      return;
    }
    if (liveOn() && live.state === 'connecting') return;   // already on its way
    // Say why, once per session, instead of silently downgrading.
    if (liveOn() && !liveAvailable() && !voice.warnedLive) {
      voice.warnedLive = true;
      toast('Is browser me Live voice nahi chalti — normal voice mode chalu hai.', true);
    } else if (liveOn() && liveAvailable() && !liveKey() && !voice.warnedLive) {
      voice.warnedLive = true;
      toast('Live voice ke liye Setup me Gemini key daalo.', true);
    }
    // Turn-based: greet first, listen second, so "haan sir" is heard instantly.
    const hello = (PERSONA_SHARED && PERSONA_SHARED.GREETING) || 'Haan sir, ready hoon. Aap kaam boliye, main kar dungi.';
    speak(hello).then(() => { if (voice.mode) listenOnce(); });
  }

  function stopVoiceMode(silent) {
    voice.mode = false;           // first, so nothing schedules a restart
    closeLive('user');
    haltLoop();
    stopSpeaking();
    clearTimeout(voice.recordingTimer);
    if (voice.recorder && voice.recorder.state === 'recording') {
      try { voice.recorder.stop(); } catch (error) { /* ignore */ }
    }
    releaseWakeLock();
    setTranscript('', false);
    paintVoiceUi();
    stopBarge();
    if (!silent) toast('Voice mode band');
    setTimeout(startWake, 900);
  }

  function toggleVoiceMode() {
    if (voice.mode) stopVoiceMode();
    else startVoiceMode();
  }

  /** Setup → Live voice: save key/model/voice, and switch the engine on/off. */
  function saveLiveConfig() {
    const cfg = Object.assign({}, state.cfg || {});
    const key = String(($('liveKey') && $('liveKey').value) || '').trim();
    if (/•/.test(key)) { /* masked, untouched */ } else cfg.liveKey = key;
    cfg.liveModel = (($('liveModel') && $('liveModel').value) || '').trim() || LIVE.MODELS[0];
    cfg.liveVoice = (($('liveVoice') && $('liveVoice').value) || '').trim() || LIVE.DEFAULT_VOICE;
    if (state.cfg && state.cfg.apiKey) saveConfig(Object.assign({}, state.cfg, cfg));
    else state.cfg = cfg;
    const on = Boolean(($('liveToggle') && $('liveToggle').checked));
    try { localStorage.setItem('jenni_live_on', on ? '1' : '0'); } catch (error) { /* ignore */ }
    setResult('liveResult', on
      ? 'Live voice ON — bolo, main sun rahi hoon; tum bologe to main ruk jaungi.'
      : 'Live voice OFF — normal turn-by-turn voice chalegi.', on ? 'ok' : '');
  }

  function paintLiveConfig() {
    if (!$('liveToggle')) return;
    const cfg = state.cfg || {};
    $('liveToggle').checked = liveOn();
    $('liveKey').value = cfg.liveKey || (isGemini(cfg) ? '•••••••• (provider key)' : '');
    $('liveModel').value = cfg.liveModel || LIVE.MODELS[0];
    $('liveVoice').value = cfg.liveVoice || LIVE.DEFAULT_VOICE;
    const ready = liveOn() && liveKey();
    setResult('liveResult', ready
      ? 'Live voice ready — Gemini 2.5 Flash native audio (free tier).'
      : 'Live voice ke liye Gemini key daalo (ya provider Gemini rakho).', ready ? 'ok' : '');
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
    // If the previous answer is still being written, this new sentence is the
    // real intent — stop the old turn instead of ignoring the user.
    if (state.busy || voice.speaking) {
      stopSpeaking();
      interruptTurn();
    }
    await send(text, { speakAlways: true, fromVoice: true, interrupt: true });
  }

  function isStopWord(text) {
    return /^(ruko|ruk jao|band karo|band kar do|chup|chup ho jao|stop|stop it|shut up|bye|goodbye|alvida|ok bye|thats all|bas|bas karo)$/.test(text);
  }

  /* A failed turn in voice mode used to end in a silent bubble: the user kept
     talking into a mic that never reopened. Say it once, then let them speak
     again — after three dead turns in a row the loop backs off to 10 s so a
     provider outage does not spin the mic and the network. */
  function voiceFailedTurn(error) {
    voice.deadStreak = (voice.deadStreak || 0) + 1;
    if (voice.deadStreak === 1) {
      const sentence = plainError(error);
      speak(sentence).then(() => { if (voice.mode) scheduleListen(500); });
    } else if (voice.mode) {
      scheduleListen(Math.min(10000, 1500 * voice.deadStreak));
    }
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

  function saveDraft(text, quiet) {
    const title = String(text).split('\n')[0].replace(/[#*_`>]/g, '').trim().slice(0, 60) || 'Draft';
    state.drafts.unshift({ id: String(now()), title, text, at: new Date().toISOString() });
    state.drafts = state.drafts.slice(0, 200);
    persist('drafts');
    paintDrafts();
    if (!quiet) toast('Draft save ho gaya');
  }


  /* ── companion: suggestions before she is asked ─────────────────────────── */
  const suggestState = { events: [], at: 0 };
  const dismissedToday = () => { const v = readJson('jenni_sugg_v1', {}); return v.day === todayIso() ? v.ids || [] : []; };
  async function refreshEvents() {
    if (!googleReady() || now() - suggestState.at < 30 * 60000) return;
    suggestState.at = now();
    try { suggestState.events = await googleClient().events(1, now()); } catch (e) { suggestState.events = []; }
  }
  function paintSuggestions() {
    const host = $('suggestStrip');
    if (!host || !PRO || !BRAIN) return;
    if (security.enabled && !security.dataKey) { host.hidden = true; return; }
    const list = PRO.suggest({ notes: state.notes, wins: secGet(LS.wins, []), events: suggestState.events, activity: secGet(LS.activity, {}), dismissed: dismissedToday(), nowMs: now(), name: BRAIN.OWNER.name.split(' ')[0] });
    host.textContent = '';
    host.hidden = !list.length;
    list.forEach((sug) => {
      const chip = document.createElement('div'); chip.className = 'suggest__chip';
      const txt = document.createElement('span'); txt.textContent = sug.text;
      const go = document.createElement('button'); go.type = 'button'; go.className = 'suggest__go'; go.textContent = 'Haan';
      const no = document.createElement('button'); no.type = 'button'; no.setAttribute('aria-label', 'Dismiss'); no.textContent = '✕';
      go.addEventListener('click', () => { dismissSuggestion(sug.id); runSuggestion(sug.action); });
      no.addEventListener('click', () => dismissSuggestion(sug.id));
      chip.append(txt, go, no); host.appendChild(chip);
    });
  }
  function dismissSuggestion(id) {
    writeJson('jenni_sugg_v1', { day: todayIso(), ids: dismissedToday().concat(id) });
    paintSuggestions();
  }
  function runSuggestion(action) {
    if (!action) return;
    if (action.type === 'chat') { send(action.text); return; }
    if (action.type === 'office') {
      openSheet('office');
      $('offType').value = action.doc; renderOfficeFields();
      if (action.subject && $('off_subject')) $('off_subject').value = action.subject;
    }
  }

  /* once a day: old, unreinforced facts fade; decayed ones stop reaching prompts */
  function dailyHygiene() {
    if (!MEM || !memory) return;
    const day = todayIso();
    if (localStorage.getItem('jenni_decay_day') === day) return;
    localStorage.setItem('jenni_decay_day', day);
    const facts = memory.all();
    const decayed = MEM.decayFacts(facts, now());
    if (JSON.stringify(decayed) !== JSON.stringify(facts)) secureStore.setItem(LS.memory, JSON.stringify(decayed));
  }

  /* ── agent mode: autonomy, audit trail, self-test ───────────────────────── */
  function paintActionLog() {
    const host = $('actionLog'); if (!host) return;
    host.textContent = '';
    secGet(LS.actions, []).slice(0, 12).forEach((a) => {
      const row = document.createElement('div'); row.className = 'card';
      row.textContent = `${new Date(a.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${a.tool} · ${a.decision}${a.ok ? '' : ' ✗'}`;
      host.appendChild(row);
    });
    if (!host.children.length) host.innerHTML = '<p class="empty">Abhi koi tool-kaam nahi hua.</p>';
  }

  async function runSelfTest() {
    if (!EVALS) return;
    if (!state.cfg || !state.cfg.apiKey) { openSheet('setup'); return; }
    const out = $('evalOut'), res = $('evalResult'); out.textContent = '';
    $('btnEval').disabled = true;
    try {
      const report = await EVALS.run({
        ask: (prompt) => askProvider(conversationForApi(prompt, { noHistory: true }), { maxTokens: 500 }),
        verify: (t) => VERIFY.check(t, { udise: BRAIN.OWNER.udise }),
        onProgress: (n, total) => setResult('evalResult', `Jaanch ho rahi hai… ${n}/${total}`, 'busy')
      });
      const hist = secGet(LS.evals, []);
      const prev = hist[0];
      secSet(LS.evals, [{ at: now(), model: state.cfg.model, pct: report.pct, passed: report.passed, total: report.total }].concat(hist).slice(0, 10));
      const delta = prev ? (report.pct - prev.pct >= 0 ? '+' : '') + (report.pct - prev.pct) + '% pichhli baar se' : 'pehli jaanch';
      setResult('evalResult', `${report.passed}/${report.total} sahi (${report.pct}%) — ${delta}`, report.pct >= 80 ? 'ok' : 'error');
      report.results.filter((r) => !r.pass).forEach((r) => {
        const row = document.createElement('div'); row.className = 'card';
        row.textContent = `✗ ${r.id}: ${r.why} — ${r.failed.join(', ')}`;
        out.appendChild(row);
      });
    } catch (error) { setResult('evalResult', plainError(error), 'error'); }
    $('btnEval').disabled = false;
  }

  function wireAgentSettings() {
    if ($('autonomySel')) {
      $('autonomySel').value = localStorage.getItem(LS.autonomy) || 'smart';
      $('autonomySel').addEventListener('change', (ev) => localStorage.setItem(LS.autonomy, ev.target.value));
    }
    if ($('wakeToggle')) {
      $('wakeToggle').checked = wakeOn();
      $('wakeToggle').addEventListener('change', (ev) => { localStorage.setItem('jenni_wake_on', ev.target.checked ? '1' : '0'); if (ev.target.checked) startWake(); else stopWake(); });
      $('bargeToggle').checked = bargeOn();
      $('bargeToggle').addEventListener('change', (ev) => localStorage.setItem('jenni_barge_on', ev.target.checked ? '1' : '0'));
      document.addEventListener('visibilitychange', () => { if (document.hidden) stopWake(); else startWake(); });
    }
    if ($('btnEval')) $('btnEval').addEventListener('click', runSelfTest);
    setInterval(() => { refreshEvents().then(paintSuggestions); }, 5 * 60000);
  }


  /* ── Setup: choose how Jenni speaks and listens ─────────────────────────── */
  function paintVoiceEngineForm() {
    if (!$('vTtsEngine')) return;
    if (LIVE) paintLiveConfig();
    const c = loadVoiceCfg();
    $('vTtsEngine').value = c.tts.engine; $('vKey').value = c.tts.key; $('vVoice').value = c.tts.voice;
    $('vModel').value = c.tts.model; $('vBase').value = c.tts.base;
    $('vSttEngine').value = c.stt.engine; $('vSttKey').value = c.stt.key; $('vSttBase').value = c.stt.base; $('vSttModel').value = c.stt.model;
  }
  function wireVoiceEngines() {
    if (!$('vTtsEngine') || !VOICES) return;
    paintVoiceEngineForm();
    const say = (m, k) => setResult('vResult', m, k);
    $('btnVoiceCfgSave').addEventListener('click', () => {
      const raw = {
        tts: { engine: $('vTtsEngine').value, key: $('vKey').value, voice: $('vVoice').value, model: $('vModel').value, base: $('vBase').value },
        stt: { engine: $('vSttEngine').value, key: $('vSttKey').value, base: $('vSttBase').value, model: $('vSttModel').value }
      };
      const norm = VOICES.normalizeConfig(raw);
      secSet(LS.voicecfg, norm);
      voice.extFailed = false; voice.sttFailed = false;
      const downgraded = (raw.tts.engine !== norm.tts.engine) || (raw.stt.engine !== norm.stt.engine);
      say(downgraded ? 'Save hua, par kuch adhura tha (key/voice/https URL) — wahan phone ki awaaz rakhi hai.' : 'Save ho gaya. "Awaaz test" dabao.', downgraded ? 'error' : 'ok');
      paintVoiceEngineForm();
    });
    if ($('btnLiveSave')) {
      $('btnLiveSave').addEventListener('click', saveLiveConfig);
      $('liveToggle').addEventListener('change', saveLiveConfig);
    }
    if ($('btnLiveTest')) {
      $('btnLiveTest').addEventListener('click', async () => {
        saveLiveConfig();
        const wasMode = voice.mode;
        voice.mode = true;                      // startLive expects an active mode
        try {
          say('Live voice jod rahi hoon…', 'busy');
          await startLive();
          await new Promise((resolve) => setTimeout(resolve, 1200));
          setResult('liveResult', live.state === 'live'
            ? `Live ready ✓ (${live.firstAudioAt ? Math.max(0, live.firstAudioAt - live.startedAt) + ' ms first audio' : 'connect ho gaya'})`
            : 'Jod nahi payi — key/permission dekho.', live.state === 'live' ? 'ok' : 'error');
        } catch (error) {
          setResult('liveResult', error.message, 'error');
        } finally {
          if (!wasMode) { voice.mode = false; closeLive('user'); paintVoiceUi(); }
        }
      });
    }
    $('btnVoicesLoad').addEventListener('click', async () => {
      try {
        say('Voices la rahi hoon…', 'busy');
        const list = await VOICES.listElevenVoices($('vKey').value);
        const sel = $('vVoiceList'); sel.textContent = '';
        list.forEach((v) => { const o = document.createElement('option'); o.value = v.id; o.textContent = v.name + (v.hint ? ' (' + v.hint + ')' : ''); sel.appendChild(o); });
        sel.hidden = !list.length;
        if (list.length) $('vVoice').value = list[0].id;
        say(list.length + ' voices mili — list se chuno, phir Save.', 'ok');
      } catch (e) { say(e.message, 'error'); }
    });
    $('vVoiceList').addEventListener('change', (ev) => { $('vVoice').value = ev.target.value; });
    $('btnVoiceCfgTest').addEventListener('click', async () => {
      voice.extFailed = false;
      if (!externalTts()) { say('Pehle engine, key aur voice bhar ke Save karo — abhi phone ki awaaz chalegi.', 'error'); speakSample(); return; }
      unlockAudio();
      say('Bol rahi hoon…', 'busy');
      await speak('Namaste, main Jenni hoon. Ye meri nayi awaaz hai.');
      say(voice.extFailed ? 'Ye engine chala nahi — upar ka sandesh dekho.' : 'Theek lagi? Isi se bolegi.', voice.extFailed ? 'error' : 'ok');
    });
  }

  /* ── Office desk ───────────────────────────────────────────────────────── */
  const OFFICE = window.JENNI_OFFICE;
  const SCHOOL_FIELDS = [['name', 'School ka naam'], ['address', 'Pata'], ['affiliation', 'CBSE affiliation no.'], ['udise', 'UDISE'], ['principal', 'Principal / signatory'], ['designation', 'Pad'], ['place', 'Jagah']];
  const officeState = { type: null, built: null };
  const loadSchool = () => { try { return Object.assign({}, OFFICE.SCHOOL_DEFAULT, JSON.parse(secureStore.getItem(LS.school) || '{}')); } catch (e) { return Object.assign({}, OFFICE.SCHOOL_DEFAULT); } };
  const saveSchool = (v) => secureStore.setItem(LS.school, JSON.stringify(v));

  function renderOfficeFields() {
    const type = OFFICE.TYPES.find((t) => t.id === $('offType').value) || OFFICE.TYPES[0];
    officeState.type = type;
    const host = $('offFields'); host.textContent = '';
    type.fields.forEach((f) => {
      const label = document.createElement('label'); label.className = 'label'; label.htmlFor = 'off_' + f.id; label.textContent = f.label + (f.req ? ' *' : '');
      let input;
      if (f.kind === 'area') { input = document.createElement('textarea'); input.rows = f.rows || 4; }
      else if (f.kind === 'select') {
        input = document.createElement('select');
        f.options.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; input.appendChild(o); });
      } else { input = document.createElement('input'); input.type = 'text'; }
      input.className = 'field'; input.id = 'off_' + f.id;
      if (f.value) input.value = f.value;
      host.append(label, input);
    });
  }

  function paintOffice() {
    if (!OFFICE) return;
    const sel = $('offType');
    if (!sel.options.length) {
      OFFICE.TYPES.forEach((t) => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; sel.appendChild(o); });
      renderOfficeFields();
    }
    const school = loadSchool(), host = $('schoolFields');
    host.textContent = '';
    SCHOOL_FIELDS.forEach(([k, label]) => {
      const l = document.createElement('label'); l.className = 'label'; l.textContent = label;
      const i = document.createElement('input'); i.className = 'field'; i.id = 'school_' + k; i.value = school[k] || '';
      host.append(l, i);
    });
  }

  function officeMake(typeId, values) {
    const school = loadSchool();
    const built = OFFICE.build(typeId, values, school, Date.now());
    saveSchool(Object.assign(school, { counter: built.counter }));
    officeState.built = built;
    $('offOut').value = built.text;
    return built;
  }

  function wireOffice() {
    if (!OFFICE || !$('offType')) return;
    $('offType').addEventListener('change', renderOfficeFields);
    $('btnSchoolSave').addEventListener('click', () => {
      const v = loadSchool();
      SCHOOL_FIELDS.forEach(([k]) => { v[k] = $('school_' + k).value.trim(); });
      saveSchool(v); toast('School profile save ho gayi');
    });
    $('btnOffMake').addEventListener('click', () => {
      const type = officeState.type || OFFICE.TYPES[0];
      const values = {};
      for (const f of type.fields) {
        values[f.id] = $('off_' + f.id).value;
        if (f.req && !String(values[f.id]).trim()) { setResult('offResult', `"${f.label}" bharna zaroori hai.`, 'error'); return; }
      }
      const school = loadSchool();
      if (!school.name) setResult('offResult', 'Tip: School profile bhar do to letterhead poora aayega.', 'busy');
      else setResult('offResult', '', '');
      try {
        const built = officeMake(type.id, values);
        const meta = built.meta;
        const issues = meta ? meta.warnings.concat(meta.errors || []) : [];
        if (issues.length) setResult('offResult', issues.slice(0, 3).join(' · '), 'error');
        else if (school.name) setResult('offResult', 'Taiyar. Edit karo, phir Save/Download.', 'ok');
      } catch (error) { setResult('offResult', error.message, 'error'); }
    });
    $('btnOffSave').addEventListener('click', () => { if ($('offOut').value.trim()) saveDraft($('offOut').value); });
    $('btnOffCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('offOut').value); toast('Copy ho gaya'); } catch (e) { toast('Copy nahi hua', true); }
    });
    $('btnOffDocx').addEventListener('click', () => {
      const text = $('offOut').value.trim();
      if (!text) return;
      const title = (officeState.built && officeState.built.title) || 'Office document';
      const built = DOCS.buildFile(title, text, 'docx');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(built.blob); a.download = built.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    document.querySelectorAll('[data-polish]').forEach((btn) => btn.addEventListener('click', async () => {
      const text = $('offOut').value.trim();
      if (!text) return;
      if (!state.cfg || !state.cfg.apiKey) { openSheet('setup'); return; }
      setResult('offResult', 'Jenni sudhar rahi hai…', 'busy');
      try {
        const out = await askProvider([{ role: 'user', content: OFFICE.polishPrompt(text, btn.dataset.polish) }], { maxTokens: 1800, temperature: 0.3 });
        $('offOut').value = out;
        setResult('offResult', 'Ho gaya — padh ke check kar lo.', 'ok');
      } catch (error) { setResult('offResult', plainError(error), 'error'); }
    }));
  }

  function paintNotes() {
    const host = $('notesList');
    if (!host || !BRAIN) return;
    const list = loadNotes();
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
        ? '☐ ' + m.text + (m.repeat ? ' ↻' : '') + (m.due ? ' — ' + m.due + (st === 'overdue' ? ' (pehle ka)' : st === 'today' ? ' (aaj)' : '') : '')
        : '[' + m.cat + '] ' + m.text;
      label.style.flex = '1';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--ghost';
      del.textContent = m.cat === 'task' ? 'Done ✓' : 'Delete';
      del.addEventListener('click', () => { if (m.cat === 'task' && MEM) completeNote(m.id); else { snapshot(); saveNotes(loadNotes().filter((x) => x.id !== m.id)); } });
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
    state.drive = Object.assign({}, state.drive, { clientId: value });
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
            scope: GOOGLE ? GOOGLE.scopeString(Boolean(state.drive.extended)) : DRIVE_SCOPE,
            callback: (response) => {
              if (response && response.access_token) {
                state.driveToken = { token: response.access_token, expires: now() + (Number(response.expires_in || 3600) - 60) * 1000, scoped: Boolean(state.drive.extended) };
                writeJson(LS.driveToken, state.driveToken);
                resolve(state.driveToken.token);
              } else {
                reject(new Error('Google ne permission nahi di.'));
              }
            },
            error_callback: (error) => reject(new Error((error && error.message) || 'Google connect nahi hua.'))
          });
          client.requestAccessToken({ prompt: state.driveToken && state.driveToken.scoped === Boolean(state.drive.extended) ? '' : 'consent' });
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
    paintMemory();
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
    if (state.paintFallback) state.paintFallback();
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

  function collectBackup() {
    /* Everything that took time to build goes in the backup — the key never does. */
    return {
      drafts: state.drafts,
      // Spare provider keys and the live-voice key are secrets too: back them out.
      config: state.cfg ? { ...state.cfg, apiKey: '', fallbackKeys: {}, liveKey: '' } : null,
      drive: state.drive,
      notes: state.notes,
      memory: memory ? memory.all() : [],
      skills: skills ? skills.custom() : [],
      episodes: journal ? journal.episodes() : [],
      insights: journal ? journal.insights() : [],
      school: secGet(LS.school, {}),
      wins: secGet(LS.wins, []),
      activity: secGet(LS.activity, {}),
      packs: loadPacks(),
      at: new Date().toISOString()
    };
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(collectBackup(), null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'jenni-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast('Backup download ho gaya (key shaamil nahi hai)');
  }

  /* Merge, never replace: a restore on a phone that already learned things must
     not throw the newer learning away. Returns how many things came back. */
  function applyBackup(data) {
    let restored = 0;
    if (Array.isArray(data.drafts)) {
      const known = new Set(state.drafts.map((d) => d.id));
      const fresh = data.drafts.filter((d) => d && d.id && !known.has(d.id));
      state.drafts = [...fresh, ...state.drafts];
      restored += fresh.length;
      persist('drafts');
      paintDrafts();
    }
    const merge = (key, incoming, idOf) => {
      if (!Array.isArray(incoming) || !incoming.length) return 0;
      let existing = [];
      try { existing = JSON.parse(secureStore.getItem(key) || '[]'); } catch (error) { existing = []; }
      if (!Array.isArray(existing)) existing = [];
      const seen = new Set(existing.map(idOf));
      const fresh = incoming.filter((item) => item && !seen.has(idOf(item)));
      if (!fresh.length) return 0;
      secureStore.setItem(key, JSON.stringify(fresh.concat(existing)));
      return fresh.length;
    };
    restored += merge(LS.memory, data.memory, (fact) => String(fact.text || '').toLowerCase())
      + merge(LS.skills, data.skills, (skill) => String(skill.name || '').toLowerCase())
      + merge(LS.episodes, data.episodes, (episode) => episode.id)
      + merge(LS.insights, data.insights, (insight) => String(insight.text || '').toLowerCase())
      + merge(LS.wins, data.wins, (w) => w.at + w.text);
    if (Array.isArray(data.notes) && BRAIN) {
      let list = state.notes;
      const before = list.length;
      data.notes.slice(0, 200).forEach((n) => {
        const due = n && /^\d{4}-\d{2}-\d{2}$/.test(n.due || '') ? n.due : '';
        const next = BRAIN.addMemory(list, n && n.text, n && n.cat, n && n.ts, due);   // untrusted: re-validated
        if (next !== list && n.repeat && ['daily', 'weekly', 'monthly'].includes(n.repeat)) { const t = next[next.length - 1]; t.repeat = n.repeat; if (Number.isInteger(n.weekday)) t.weekday = n.weekday; t.rc = 1; }
        list = next;
      });
      restored += list.length - before;
      saveNotes(list);
    }
    if (data.school && typeof data.school === 'object' && !loadSchool().name && data.school.name) saveSchool(Object.assign(loadSchool(), data.school));
    if (data.activity && typeof data.activity === 'object') {
      const mine = secGet(LS.activity, {});
      Object.keys(data.activity).forEach((k) => { if (Array.isArray(data.activity[k])) mine[k] = Array.from(new Set((mine[k] || []).concat(data.activity[k]))).sort().slice(-24); });
      secSet(LS.activity, mine);
    }
    paintMemory();
    return restored;
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const restored = applyBackup(JSON.parse(reader.result));
        toast(restored ? `Import ho gaya — ${restored} cheez wapas aayi` : 'Import ho gaya');
      } catch (error) {
        toast('File padhi nahi ja saki.', true);
      }
    };
    reader.readAsText(file);
  }

  /* ── Drive backup: encrypted, one file, restorable on a new phone ───────── */
  const BACKUP_NAME = 'jenni-backup.json';
  const hashOf = (text) => { let h = 5381; for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return String(h); };
  const driveTokenNow = () => (state.driveToken && state.driveToken.expires > now() ? state.driveToken.token : null);

  function backupPassphrase(ask) {
    if (security.enabled && security.pin) return security.pin;
    if (state.backupPass) return state.backupPass;
    if (!ask) return null;
    const typed = window.prompt('Backup passphrase (ise yaad rakhna — naye phone par restore ke liye chahiye)');
    if (typed && typed.length >= 4) { state.backupPass = typed; return typed; }
    return null;
  }

  async function findBackupFile(token) {
    const q = encodeURIComponent(`name='${BACKUP_NAME}' and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=5`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error && body.error.message) || `Drive HTTP ${res.status}`);
    return ((body && body.files) || []).find((f) => f.name === BACKUP_NAME) || null;
  }

  async function backupToDrive({ silent } = {}) {
    if (!driveReady()) { if (!silent) toast('Pehle Drive connect karo.', true); return false; }
    const pass = backupPassphrase(!silent);
    if (!pass) return false;
    const token = silent ? driveTokenNow() : await driveTokenOrAsk();
    if (!token) return false;
    const data = collectBackup();
    const fingerprint = hashOf(JSON.stringify(Object.assign({}, data, { at: '' })));
    const sealed = await SEC.seal(pass, JSON.stringify(data));
    const existing = await findBackupFile(token);
    const boundary = 'jenni' + now();
    const meta = existing ? {} : { name: BACKUP_NAME };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(sealed)}\r\n--${boundary}--`;
    const url = existing
      ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,modifiedTime`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime';
    const res = await fetch(url, { method: existing ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    if (!res.ok) throw new Error(`Backup fail (HTTP ${res.status}).`);
    writeJson(LS.backup, { at: now(), hash: fingerprint });
    paintBackupStatus();
    if (!silent) toast('Drive par encrypted backup ho gaya');
    return true;
  }

  async function restoreFromDrive() {
    if (!driveReady()) { toast('Pehle Drive connect karo.', true); return; }
    const token = await driveTokenOrAsk();
    const file = await findBackupFile(token);
    if (!file) { toast('Drive me jenni-backup.json nahi mila.', true); return; }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Backup padh nahi paye (HTTP ${res.status}).`);
    const sealed = await res.json();
    let pass = backupPassphrase(false), plain = null;
    for (let attempt = 0; attempt < 2 && plain === null; attempt += 1) {
      if (!pass) { pass = window.prompt('Backup passphrase daalo'); if (!pass) return; }
      try { plain = await SEC.open(pass, sealed); } catch (error) { pass = null; if (attempt === 1) throw new Error('Passphrase galat hai.'); }
    }
    const restored = applyBackup(JSON.parse(plain));
    toast(restored ? `Restore ho gaya — ${restored} cheez wapas aayi` : 'Restore ho gaya (kuch naya nahi tha)');
  }

  function paintBackupStatus() {
    const el = $('backupStatus');
    if (!el) return;
    const info = readJson(LS.backup, null);
    el.textContent = info ? 'Last backup: ' + new Date(info.at).toLocaleString('en-IN') : 'Abhi tak koi backup nahi.';
  }

  /* quietly, at most once a day, when nothing needs a prompt */
  async function maybeAutoBackup() {
    try {
      if (!driveReady() || !driveTokenNow() || !backupPassphrase(false)) return;
      const info = readJson(LS.backup, null);
      if (info && now() - info.at < 20 * 3600 * 1000) return;
      const fingerprint = hashOf(JSON.stringify(Object.assign({}, collectBackup(), { at: '' })));
      if (info && info.hash === fingerprint) return;
      await backupToDrive({ silent: true });
    } catch (error) { /* a failed background backup must never bother the owner */ }
  }

  /* ══════════════════════════════════════════════════════════════ SHEETS */

  const ROUTES = ['chat', 'voice', 'office', 'drafts', 'drive', 'setup'];

  function openSheet(name, options = {}) {
    closeSheets({ keepMemory: true });
    const sheet = $('sheet-' + name);
    if (!sheet) return;
    $('scrim').hidden = false;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    if (name === 'drafts') paintDrafts();
    if (name === 'drive') { paintDrive(); listDriveFiles(); paintBackupStatus(); }
    if (name === 'setup') fillSetupForm();
    if (name === 'office') paintOffice();
    if (name === 'setup') { paintActionLog(); paintNotes(); paintVoiceEngineForm(); }
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
    vault.clear();
    state.chat = []; state.drafts = []; state.notes = [];
    paintChat(); paintDrafts(); paintNotes(); paintMemory();
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
    paintNotes(); paintMemory();
    syncReminders();
    paintSuggestions();
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

  /* ══════════════════════════════════════════════════════ LEARNING FROM CHAT

     Clearing the screen must not throw away what the chat taught her. Before
     the bubbles go, every user turn is mined for facts, every good answer is
     turned into (or improves) a playbook, one episode row is written, and the
     journal reflects on it. That is the loop that makes a new chat smarter
     than the last one instead of resetting to zero.
     ---------------------------------------------------------------------- */

  function chatUserTurns() {
    return state.chat.filter((m) => m.role === 'me' && m.text && !m.pending);
  }

  function precedingQuestion(message) {
    const index = state.chat.indexOf(message);
    for (let i = index - 1; i >= 0; i -= 1) {
      if (state.chat[i].role === 'me' && state.chat[i].text) return state.chat[i].text;
    }
    return '';
  }

  /** Mine the open conversation. Returns a small, honest summary. */
  function digestChat() {
    const userTurns = chatUserTurns();
    if (!userTurns.length || !memory) return null;

    const newFacts = [];
    const learnedSkills = [];
    let liked = 0;
    let disliked = 0;

    state.chat.forEach((message) => {
      if (message.role === 'me' && message.text) {
        memory.observe(message.text, 'chat').forEach((fact) => newFacts.push(fact));
      }
      if (message.role === 'jenni' && message.text && !message.failed) {
        if (message.rating === 'up') liked += 1;
        if (message.rating === 'down') disliked += 1;
        const question = precedingQuestion(message);
        if (AGENT.skillFrom && question) {
          const skill = AGENT.skillFrom(question, message.text);
          if (skill) {
            const saved = skills.learn(skill);
            if (saved) learnedSkills.push(saved.name);
          }
        }
      }
    });

    memory.compact();

    /* Topics: the words the user kept coming back to. */
    const counts = new Map();
    userTurns.forEach((message) => {
      (AGENT.tokens ? AGENT.tokens(message.text) : new Set()).forEach((word) => {
        if (word.length < 4) return;
        counts.set(word, (counts.get(word) || 0) + 1);
      });
    });
    const topics = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([word]) => word);

    let episode = null;
    if (journal) {
      episode = journal.addEpisode({
        turns: userTurns.length,
        topics,
        facts: [...new Set(newFacts)],
        skills: [...new Set(learnedSkills)],
        liked,
        disliked
      });
      journal.reflect({ liked, disliked, skills: learnedSkills });
    }

    return {
      turns: userTurns.length,
      facts: [...new Set(newFacts)],
      skills: [...new Set(learnedSkills)],
      insights: journal ? journal.insights().length : 0,
      episode
    };
  }

  /** Start a fresh chat, keeping everything it taught her. */
  function clearChat() {
    if (!state.chat.length) {
      toast('Chat pehle se khali hai');
      return;
    }
    const sure = window.confirm('Chat saaf kar dun? Jo baat samjhi wo yaad rahegi.');
    if (!sure) return;
    /* Phones that are mid-answer keep the turn; clearing would orphan it. */
    if (state.busy) { toast('Ek jawab aa raha hai — ruk jao', true); return; }

    const digest = digestChat();
    state.chat = [];
    persist('chat');
    secSet(LS.summary, '');
    paintChat();
    paintMemory();

    if (!digest) {
      toast('Naya chat shuru', false);
      return;
    }
    const bits = [];
    if (digest.facts.length) bits.push(`${digest.facts.length} baat yaad`);
    if (digest.skills.length) bits.push(`${digest.skills.length} playbook seekha`);
    toast(bits.length
      ? `Chat saaf — ${bits.join(', ')}`
      : 'Chat saaf — naya kuch seekhne ko nahi mila', false);
  }

  /** 👍 / 👎 on one reply: the same reply is re-used or avoided next time. */
  function rateReply(message, direction) {
    if (!message || message.role !== 'jenni' || !message.text) return;
    const previous = message.rating;
    const value = message.rating === direction ? null : direction;   // tap again to undo
    message.rating = value;
    writeJson(LS.chat, state.chat.filter((m) => !m.pending));

    const question = precedingQuestion(message);
    if (value === 'up') {
      if (memory) memory.reinforce(question + ' ' + message.text, 0.08);
      if (skills && AGENT.skillFrom && question) {
        const skill = AGENT.skillFrom(question, message.text);
        if (skill) {
          skill.rating = 1;
          skill.example = question + ' → ' + message.text.slice(0, 400);
          const saved = skills.learn(skill);
          if (journal && saved) {
            journal.addInsight({
              kind: 'skill',
              text: `${saved.name} jaisa jawab pasand aaya — usi tarah dobara dena`,
              confidence: 0.6
            });
          }
        }
      }
      toast('Yaad rakha — aise hi jawab dobara dungi');
    } else if (value === 'down') {
      if (memory) memory.weaken(message.text, 0.12);
      if (skills) {
        const matched = skills.match(question) || [];
        matched.forEach((skill) => skills.rate(skill.name, -1));
        if (journal) {
          journal.addInsight({
            kind: 'avoid',
            text: `"${String(question).slice(0, 50)}" par aisa jawab pasand nahi aaya — tarika badalna`,
            confidence: 0.55
          });
        }
      }
      toast('Samajh gayi — agli baar alag tarika');
    } else if (previous === 'up') {
      if (skills) {
        const matched = skills.match(question) || [];
        matched.forEach((skill) => skills.rate(skill.name, -1));
      }
    } else if (previous === 'down') {
      if (skills) {
        const matched = skills.match(question) || [];
        matched.forEach((skill) => skills.rate(skill.name, 1));
      }
    }

    paintChat();
  }

  /** What Jenni remembers, and the procedures she has learned. */
  function paintMemory() {
    if (!memory || !skills) return;
    const facts = memory.all();
    const learned = skills.custom();
    const statusText = $('memoryStatusText');
    const badge = $('memoryStatus');
    if (statusText) {
      statusText.textContent = facts.length
        ? `${facts.length} baat yaad hai`
        : 'Kuch yaad nahi';
    }
    if (badge) badge.className = 'status' + (facts.length ? ' is-ok' : '');

    const list = $('memoryList');
    if (list) {
      list.innerHTML = '';
      if (!facts.length) {
        list.innerHTML = '<p class="field-hint">Abhi khali hai. "mera naam … hai" bolo, phir dekho.</p>';
      }
      facts.slice(0, 40).forEach((fact) => {
        const card = document.createElement('div');
        card.className = 'card card--tight';
        const text = document.createElement('span');
        text.className = 'card__meta';
        text.textContent = fact.text;
        const forget = document.createElement('button');
        forget.type = 'button';
        forget.className = 'btn btn--small btn--ghost';
        forget.textContent = 'Bhool jao';
        forget.addEventListener('click', () => {
          memory.forget(fact.id);
          paintMemory();
        });
        card.append(text, forget);
        list.appendChild(card);
      });
    }

    const summary = $('skillsSummary');
    if (summary) {
      summary.textContent = learned.length
        ? `${skills.builtIn().length} built-in sikhai + ${learned.length} tumse seekhi`
        : `${skills.builtIn().length} built-in playbooks tayaar — baat karte karte naye seekhegi`;
    }
    const skillList = $('skillList');
    if (skillList) {
      skillList.innerHTML = '';
      learned.forEach((skill) => {
        const card = document.createElement('div');
        card.className = 'card card--tight';
        const name = document.createElement('strong');
        name.textContent = `${skill.name} · v${skill.version || 1}`;
        if (Number(skill.rating) > 0) name.textContent += ' 👍';
        if (Number(skill.rating) < 0) name.textContent += ' 👎';
        const steps = document.createElement('span');
        steps.className = 'card__meta';
        steps.textContent = skill.steps.join(' → ');
        card.append(name, steps);
        skillList.appendChild(card);
      });
    }
    paintJournal();
  }

  /** What cleared chats left behind: the strongest habits and the last few. */
  function paintJournal() {
    if (!journal) return;
    const insights = journal.insights();
    const episodes = journal.episodes();

    const summary = $('journalSummary');
    if (summary) {
      summary.textContent = episodes.length
        ? `${episodes.length} chat se seekha · ${insights.length} habit yaad`
        : 'Abhi ek bhi chat clear nahi hui — clear karne par pehle seekhegi.';
    }

    const insightList = $('insightList');
    if (insightList) {
      insightList.innerHTML = '';
      if (!insights.length) {
        insightList.innerHTML = '<p class="field-hint">Abhi koi habit nahi bani. Kuch chats clear karo, ya jawab par 👍 dabao.</p>';
      }
      insights.slice(0, 6).forEach((insight) => {
        const card = document.createElement('div');
        card.className = 'card card--tight';
        const text = document.createElement('span');
        text.className = 'card__meta';
        text.textContent = insight.text;
        const strength = document.createElement('span');
        strength.className = 'card__meta';
        strength.textContent = `${Math.round((insight.confidence || 0.5) * 100)}%`;
        card.append(text, strength);
        insightList.appendChild(card);
      });
    }

    const episodeList = $('episodeList');
    if (episodeList) {
      episodeList.innerHTML = '';
      episodes.slice(0, 5).forEach((episode) => {
        const card = document.createElement('div');
        card.className = 'card card--tight';
        const title = document.createElement('strong');
        const when = new Date(episode.at || Date.now());
        title.textContent = `${when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${episode.turns} baat`;
        const meta = document.createElement('span');
        meta.className = 'card__meta';
        const bits = [];
        if ((episode.topics || []).length) bits.push(episode.topics.join(', '));
        if ((episode.facts || []).length) bits.push(`${episode.facts.length} fact`);
        if ((episode.skills || []).length) bits.push(`${episode.skills.length} skill`);
        meta.textContent = bits.join(' · ') || '—';
        card.append(title, meta);
        episodeList.appendChild(card);
      });
    }
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
    await flushVault();
    security.enabled = false;
    SECURE_KEYS.forEach((key) => {                    // back to plaintext (user's choice)
      if (vault.has(key)) localStorage.setItem(key, vault.get(key));
      localStorage.removeItem(key + '_enc');
    });
    vault.clear();
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
    try { if (RSTORE && window.indexedDB) RSTORE.clear(); } catch (e) { /* ignore */ }
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
    const text = BRAIN.briefing(loadNotes());
    try { localStorage.setItem('jenni_brief_day', day); } catch (e) { /* ignore */ }
    if (text) { state.chat.push({ role: 'jenni', text }); persist('chat'); }
  }

  function showApp(options = {}) {
    $('gate').hidden = true;
    $('app').hidden = false;
    const cfg = state.cfg;
    setStatus(cfg && cfg.apiKey ? 'ok' : '', cfg && cfg.apiKey ? providerName() + ' · ' + cfg.model : 'setup needed');
    maybeBrief();
    dailyHygiene();
    refreshEvents().then(paintSuggestions);
    paintSuggestions();
    startWake();
    setTimeout(maybeAutoBackup, 4000);
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
      // "Chup" means quiet for real: stop the stream too, or the rest of the
      // answer keeps arriving and gets read out anyway.
      if (voice.activeSpeaker && voice.activeSpeaker.mute) voice.activeSpeaker.mute();
      if (live.player) live.player.stop();
      stopSpeaking();
      if (state.busy) interruptTurn();
      if (voice.mode) scheduleListen(300);
    });
    $('btnVoiceLang').addEventListener('click', toggleLanguage);
    $('btnVoiceTest').addEventListener('click', speakSample);
    $('btnVoiceStart').addEventListener('click', () => { closeSheets(); startVoiceMode(); });

    $('btnOpenSetup').addEventListener('click', () => openSheet('setup'));
    if ($('btnVoiceMaster')) { $('btnVoiceMaster').addEventListener('click', () => setVoiceEnabled(!voiceEnabled())); paintVoiceMaster(); }
    if (CN && $('btnNmSave')) {
      const cfg0 = readJson(LS.nm, {});
      if (cfg0.token) { delete cfg0.token; writeJson(LS.nm, cfg0); }      // tokens are no longer used or kept
      $('nmUrl').value = cfg0.url || '';
      const say = (m, k) => setResult('nmResult', m, k);
      $('btnNmSave').addEventListener('click', async () => {
        const cfg = { url: $('nmUrl').value.trim().replace(/\/+$/, '') };
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
          let list = loadNotes(); const before = list.length;
          (await nm.memories()).slice(0, 30).forEach((t) => { list = BRAIN.addMemory(list, 'NeverMind: ' + t, 'school'); });
          saveNotes(list); say((list.length - before) + ' nayi memory aayi.', 'ok');
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
    if ($('remindToggle')) {
      $('remindToggle').checked = remindOn() && 'Notification' in window && Notification.permission === 'granted';
      $('remindToggle').addEventListener('change', async (ev) => { ev.target.checked = await setReminders(ev.target.checked); });
      setInterval(remindTick, 60000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') remindTick(); });
    }
    wireOffice();
    wireAgentSettings();
    wireVoiceEngines();
    if ($('btnMemAdd') && BRAIN) {
      $('btnMemAdd').addEventListener('click', () => {
        const box = $('memInput');
        if (!box.value.trim()) return;
        const cmd = BRAIN.userCommand(box.value);
        saveNotes(cmd ? BRAIN.applyOps(loadNotes(), [cmd]) : BRAIN.addMemory(loadNotes(), box.value, null));
        box.value = '';
      });
      $('btnMemClear').addEventListener('click', () => { if (confirm('Saari memory delete karein?')) saveNotes([]); });
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
    /* spare (backup) provider: a second key so a 503 on the main one is not fatal */
    if ($('fbProvider')) {
      const paintFb = () => {
        const cfg = state.cfg || {};
        const keys = cfg.fallbackKeys || {};
        $('fbProvider').innerHTML = '<option value="">— koi nahi —</option>'
          + Object.keys(PRESETS).filter((id) => id !== 'custom')
            .map((id) => `<option value="${id}">${escapeHtml(PRESETS[id].label)}${keys[id] ? ' · saved' : ''}</option>`).join('');
        $('fbProvider').value = cfg.fallbackProvider && keys[cfg.fallbackProvider] ? cfg.fallbackProvider : (Object.keys(keys)[0] || '');
        $('fbKey').value = keys[$('fbProvider').value] ? '••••••••' : '';
        setResult('fbResult', Object.keys(keys).length
          ? 'Spare ready — main provider down ho to apne aap isse try karungi.'
          : 'Abhi koi spare key nahi hai.', Object.keys(keys).length ? 'ok' : '');
      };
      state.paintFallback = paintFb;
      paintFb();
      $('fbProvider').addEventListener('change', () => {
        const keys = (state.cfg && state.cfg.fallbackKeys) || {};
        $('fbKey').value = keys[$('fbProvider').value] ? '••••••••' : '';
      });
      $('btnFbSave').addEventListener('click', () => {
        const id = $('fbProvider').value;
        if (!id) { setResult('fbResult', 'Pehle spare provider chuno.', 'error'); return; }
        const typed = $('fbKey').value.trim();
        if (typed.replace(/•/g, '').length === 0 && !(state.cfg && state.cfg.fallbackKeys && state.cfg.fallbackKeys[id])) {
          setResult('fbResult', 'Spare key daalo.', 'error'); return;
        }
        if (typed.length < 8) { setResult('fbResult', 'Key bahut chhoti lag rahi hai.', 'error'); return; }
        saveSpareKey(id, typed);
        paintFb();
        setResult('fbResult', `${PRESETS[id].label} spare key save ho gayi ✓`, 'ok');
      });
      $('btnFbClear').addEventListener('click', () => {
        const id = $('fbProvider').value;
        if (!id) { setResult('fbResult', 'Pehle spare provider chuno.', 'error'); return; }
        saveSpareKey(id, '');
        paintFb();
        setResult('fbResult', `${PRESETS[id].label} spare key hata di.`, 'ok');
      });
    }

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

    $('btnNewChat').addEventListener('click', clearChat);

    if ($('btnJournalRefresh')) {
      $('btnJournalRefresh').addEventListener('click', () => {
        paintJournal();
        toast('Journal refresh ho gaya', false);
      });
    }
    if ($('btnJournalClear')) {
      $('btnJournalClear').addEventListener('click', () => {
        const sure = window.confirm('Journal (episodes + habits) saaf kar dun? Memory aur skills rahenge.');
        if (!sure) return;
        journal.clear();
        paintJournal();
        toast('Journal saaf ho gaya', false);
      });
    }

    $('btnMemoryRefresh').addEventListener('click', () => {
      paintMemory();
      toast('Memory refresh ho gayi', false);
    });
    $('btnMemoryClear').addEventListener('click', () => {
      const sure = window.confirm('Jenni jo yaad rakhti hai — sab bhool jayegi. Pakka?');
      if (!sure) return;
      memory.clear();
      skills.clear();
      if (journal) journal.clear();
      paintMemory();
      toast('Sab bhool gayi', false);
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
    if ($('googleExtended')) {
      $('googleExtended').checked = Boolean(state.drive && state.drive.extended);
      $('googleExtended').addEventListener('change', (ev) => {
        state.drive = Object.assign({}, state.drive, { extended: ev.target.checked });
        writeJson(LS.drive, state.drive);
        state.driveToken = null; localStorage.removeItem(LS.driveToken);      // new scopes need a fresh consent
        paintDrive();
        setResult('driveResult', ev.target.checked ? 'Calendar + Gmail (read, draft only) ON — ab Connect Google dabao.' : 'Sirf Drive access.', 'ok');
      });
      $('btnBackupNow').addEventListener('click', async () => { try { await backupToDrive(); } catch (e) { toast(e.message, true); } });
      $('btnRestore').addEventListener('click', async () => { try { await restoreFromDrive(); } catch (e) { toast(e.message, true); } });
      paintBackupStatus();
    }
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
    paintMemory();

    /* Three honest states on boot:
         vault + PIN  → locked until the PIN is typed
         plain config → straight in, with a nudge to add a PIN
         nothing      → the setup gate                                        */
    if (security.enabled && localStorage.getItem(LS.vault)) {
      state.cfg = null;                      // never hold the key while locked
      state.chat = []; state.drafts = []; state.notes = [];
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
        navigator.serviceWorker.register('./sw.js').then((reg) => {
          // A new worker (new CACHE name) installs with skipWaiting; reload once
          // so the phone picks up fixed JS instead of running the old shell.
          reg.addEventListener('updatefound', () => {
            const fresh = reg.installing;
            if (!fresh) return;
            fresh.addEventListener('statechange', () => {
              if (fresh.state === 'activated' && navigator.serviceWorker.controller) location.reload();
            });
          });
        }).catch(() => { /* offline cache is optional */ });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
