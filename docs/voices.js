/**
 * Pluggable voices. Jenni speaks and listens through the browser by default
 * (free, private, no setup). Optionally:
 *
 *   ElevenLabs          natural multilingual TTS (Hindi/Hinglish) + Scribe STT
 *   OpenAI-compatible   any server that speaks /v1/audio/speech and
 *                       /v1/audio/transcriptions — OpenAI, Groq, or open-source
 *                       you host yourself (Kokoro-FastAPI, openedai-speech,
 *                       Speaches/faster-whisper, LocalAI …)
 *
 * Keys are stored in Jenni's encrypted store and are sent only to the chosen
 * endpoint. Whatever Jenni says is sent to that endpoint to be voiced.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_VOICES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ELEVEN = 'https://api.elevenlabs.io';
  const TTS_ENGINES = ['browser', 'eleven', 'compat'];
  const STT_ENGINES = ['default', 'eleven', 'compat'];

  const safeBase = (url) => {
    try {
      const u = new URL(url);
      const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
      return (u.protocol === 'https:' || (u.protocol === 'http:' && local)) && !u.username && !u.password && !u.search && !u.hash;
    } catch (e) { return false; }
  };
  const clean = (s) => String(s || '').trim();
  const trimSlash = (s) => clean(s).replace(/\/+$/, '');

  function normalizeConfig(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const t = r.tts || {}, s = r.stt || {};
    const tts = { engine: TTS_ENGINES.includes(t.engine) ? t.engine : 'browser', key: clean(t.key), voice: clean(t.voice), model: clean(t.model), base: trimSlash(t.base) };
    const stt = { engine: STT_ENGINES.includes(s.engine) ? s.engine : 'default', key: clean(s.key), model: clean(s.model), base: trimSlash(s.base) };
    if (tts.engine === 'compat' && !safeBase(tts.base)) tts.engine = 'browser';
    if (stt.engine === 'compat' && !safeBase(stt.base)) stt.engine = 'default';
    if ((tts.engine === 'eleven' && (!tts.key || !tts.voice)) || (tts.engine === 'compat' && !tts.voice && !tts.model)) tts.engine = 'browser';
    if (stt.engine === 'eleven' && !(stt.key || tts.key)) stt.engine = 'default';
    return { tts, stt };
  }

  async function failure(res, who) {
    const body = await res.json().catch(() => null);
    const detail = body && (body.detail && (body.detail.message || body.detail) || body.error && (body.error.message || body.error));
    const text = typeof detail === 'string' ? detail : '';
    const e = new Error(
      res.status === 401 ? `${who}: key galat hai.`
        : res.status === 402 || (res.status === 429 && /quota|credit|character/i.test(text)) ? `${who}: credits/quota khatam.`
          : res.status === 429 ? `${who}: bahut zyada requests — thodi der baad.`
            : res.status === 404 || res.status === 422 ? `${who}: voice/model nahi mila (${text || res.status}).`
              : `${who}: HTTP ${res.status}${text ? ' — ' + text.slice(0, 120) : ''}`
    );
    e.status = res.status;
    return e;
  }

  /** → { engine, synth(text, {signal}) → Promise<Blob> } */
  function createTts(cfg, fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (cfg.engine === 'eleven') {
      return {
        engine: 'eleven',
        async synth(text, opts = {}) {
          const res = await f(`${ELEVEN}/v1/text-to-speech/${encodeURIComponent(cfg.voice)}?output_format=mp3_44100_64`, {
            method: 'POST', signal: opts.signal,
            headers: { 'xi-api-key': cfg.key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: cfg.model || 'eleven_flash_v2_5' })
          });
          if (!res.ok) throw await failure(res, 'ElevenLabs');
          return res.blob();
        }
      };
    }
    if (cfg.engine === 'compat') {
      return {
        engine: 'compat',
        async synth(text, opts = {}) {
          const res = await f(`${cfg.base}/audio/speech`, {
            method: 'POST', signal: opts.signal,
            headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
            body: JSON.stringify({ model: cfg.model || 'tts-1', input: text, voice: cfg.voice || 'alloy', response_format: 'mp3' })
          });
          if (!res.ok) throw await failure(res, 'Voice server');
          return res.blob();
        }
      };
    }
    return null;
  }

  async function listElevenVoices(key, fetchImpl) {
    const f = fetchImpl || fetch.bind(globalThis);
    const res = await f(`${ELEVEN}/v1/voices`, { headers: { 'xi-api-key': clean(key) } });
    if (!res.ok) throw await failure(res, 'ElevenLabs');
    const data = await res.json();
    return (data.voices || []).map((v) => ({ id: v.voice_id, name: v.name, hint: [v.labels && v.labels.accent, v.labels && v.labels.gender].filter(Boolean).join(', ') }));
  }

  /** → { engine, transcribe(blob, {lang}) → Promise<string> } */
  function createStt(cfg, ttsCfg, fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const lang = (l) => String(l || 'hi').split('-')[0];
    if (cfg.engine === 'eleven') {
      return {
        engine: 'eleven',
        async transcribe(blob, opts = {}) {
          const form = new FormData();
          form.append('file', blob, 'voice.webm');
          form.append('model_id', cfg.model || 'scribe_v1');
          form.append('language_code', lang(opts.lang));
          const res = await f(`${ELEVEN}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': cfg.key || (ttsCfg && ttsCfg.key) }, body: form });
          if (!res.ok) throw await failure(res, 'ElevenLabs Scribe');
          return String((await res.json()).text || '').trim();
        }
      };
    }
    if (cfg.engine === 'compat') {
      return {
        engine: 'compat',
        async transcribe(blob, opts = {}) {
          const form = new FormData();
          form.append('file', blob, 'voice.webm');
          form.append('model', cfg.model || 'whisper-1');
          form.append('language', lang(opts.lang));
          const res = await f(`${cfg.base}/audio/transcriptions`, { method: 'POST', headers: cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}, body: form });
          if (!res.ok) throw await failure(res, 'Voice server');
          return String((await res.json()).text || '').trim();
        }
      };
    }
    return null;
  }

  /**
   * Gapless-ish playback queue: every sentence's audio is requested at once
   * (prefetch) and played strictly in order. stop() drops everything.
   */
  function createPlayer({ AudioCtor, urlApi }) {
    const A = AudioCtor || (typeof Audio !== 'undefined' ? Audio : null);
    const U = urlApi || (typeof URL !== 'undefined' ? URL : null);
    let queue = [], playing = false, gen = 0, current = null, idleWaiters = [];
    const settle = () => { if (!playing && !queue.length) { idleWaiters.forEach((w) => w()); idleWaiters = []; } };

    async function pump() {
      if (playing) return;
      const item = queue.shift();
      if (!item) { settle(); return; }
      playing = true;
      const myGen = gen;
      try {
        const blob = await item.blobPromise;
        if (myGen !== gen) throw Object.assign(new Error('stopped'), { stopped: true });
        const url = U.createObjectURL(blob);
        const audio = new A(url);
        current = audio;
        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = () => reject(new Error('audio error'));
          if (item.onStart) item.onStart();
          const p = audio.play();
          if (p && p.catch) p.catch(reject);
        });
        if (U.revokeObjectURL) U.revokeObjectURL(url);
        if (item.onEnd) item.onEnd(null);
      } catch (error) {
        if (item.onEnd) item.onEnd(error.stopped ? null : error);
      }
      current = null; playing = false;
      pump();
    }

    return {
      enqueue(blobPromise, hooks = {}) {
        blobPromise.catch(() => {});                       // failures surface through onEnd, not as unhandled rejections
        queue.push(Object.assign({ blobPromise }, hooks));
        pump();
      },
      stop() {
        gen += 1;
        const dropped = queue; queue = [];
        dropped.forEach((i) => { if (i.onEnd) i.onEnd(null); });
        if (current) { try { current.pause(); } catch (e) { /* ignore */ } if (current.onended) current.onended(); }
        settle();
      },
      whenIdle() { return playing || queue.length ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve(); },
      busy: () => playing || queue.length > 0
    };
  }

  return { normalizeConfig, createTts, createStt, createPlayer, listElevenVoices, safeBase };
});
