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

  async function send(text, options = {}) {
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

    let reply = '';
    try {
      reply = await callProvider(conversationForApi(clean));
      pending.pending = false;
      pending.text = reply;
      setStatus('ok', providerName() + ' · ' + state.cfg.model);
    } catch (error) {
      pending.pending = false;
      pending.text = 'Maaf karo, jawab nahi mila.\n\n' + error.message;
      reply = 'Maaf karo, jawab nahi mila. ' + error.message;
      setStatus('error');
    } finally {
      state.busy = false;
      $('btnSend').disabled = false;
      writeJson(LS.chat, state.chat.filter((m) => !m.pending));
      paintChat();
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
      if (!clean || !window.speechSynthesis) { resolve(false); return; }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(clean);
        const lang = voice.lang;
        utterance.lang = lang;
        const chosen = voice.ttsVoice || pickVoice(lang);
        if (chosen) utterance.voice = chosen;
        utterance.rate = 1;
        utterance.pitch = 1;
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

    /* one-shot mic: listen for a single message */
    $('btnMic').addEventListener('click', () => {
      if (state.listening) { stopListening(); return; }
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
