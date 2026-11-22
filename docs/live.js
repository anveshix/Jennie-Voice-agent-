/**
 * Gemini Live — native-audio, full-duplex voice for Jenni.
 *
 * The normal loop is turn-based: record → transcribe → ask a text model → speak
 * → record again. Every hop adds latency and the user cannot talk over her.
 *
 * The Live API is different: one WebSocket carries the microphone up and her
 * voice down as 16-bit PCM, the model listens and speaks at the same time, and a
 * spoken word from the user cancels her mid-sentence (server_vad +
 * START_OF_ACTIVITY_INTERRUPTS). That is what makes it feel like a phone call
 * instead of a walkie-talkie.
 *
 * Models (free tier of the Gemini Developer API, per Google's docs):
 *   gemini-2.5-flash-native-audio-preview-12-2025   ← preferred
 *   gemini-2.5-flash-native-audio-latest            ← also works
 * Audio contract: 16 kHz PCM16 mono up, 24 kHz PCM16 mono down.
 *
 * This module is transport-agnostic: the browser and Node both supply a
 * WebSocket constructor, so every packet shape is unit-testable without a
 * network connection.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_LIVE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  const MODELS = [
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-2.5-flash-native-audio-latest'
  ];

  const INPUT_RATE = 16000;
  const OUTPUT_RATE = 24000;
  const DEFAULT_VOICE = 'Zephyr';

  /** The WebSocket URL. The key rides in `key=` like every other Gemini call. */
  function url(apiKey, version) {
    const v = version || 'v1beta';
    const base = WS_BASE.replace('v1beta', v);
    return base + '?key=' + encodeURIComponent(String(apiKey || ''));
  }

  /**
   * The setup packet: model, audio response, voice, Jenni's instructions, and
   * the interruption behaviour the owner asked for — a spoken word stops her.
   */
  function setupMessage(options) {
    const o = options || {};
    const model = MODELS.includes(o.model) ? o.model : MODELS[0];
    return {
      setup: {
        model: 'models/' + model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice || DEFAULT_VOICE } } },
          thinkingConfig: { thinkingBudget: 0 }      // talk now, think later: latency first
        },
        systemInstruction: { parts: [{ text: String(o.instructions || '') }] },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
            prefixPaddingMs: 80,
            silenceDurationMs: 600
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',   // barge-in, server side
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY'
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: {
          triggerTokens: 25600,
          slidingWindow: { targetTokens: 12800 }
        }
      }
    };
  }

  /** One microphone chunk. base64 PCM16 @16 kHz. */
  function audioMessage(base64Pcm) {
    return { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=' + INPUT_RATE, data: base64Pcm } } };
  }

  /** Used when VAD is disabled and the client decides when the user finished. */
  function activityMessage(kind) {
    return { realtimeInput: { activity: { [kind]: true } } };
  }

  /** Text turn (typed message while the live session is open). */
  function textMessage(text) {
    return { clientContent: { turns: [{ role: 'user', parts: [{ text: String(text || '') }] }], turnComplete: true } };
  }

  /**
   * Parse one server packet into the small vocabulary the UI needs:
   *   { kind: 'audio', pcm, rate }            → play it
   *   { kind: 'text', text, role }            → transcript / caption
   *   { kind: 'interrupted' }                 → user talked over her: drop the buffer
   *   { kind: 'turnComplete' }                → she finished speaking
   *   { kind: 'ready' } | { kind: 'close', reason } | { kind: 'error', message }
   */
  function readPacket(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch (error) { return null; }
    }
    if (!msg || typeof msg !== 'object') return null;

    if (msg.setupComplete) return { kind: 'ready' };
    if (msg.goAway) return { kind: 'close', reason: 'goAway' };

    const content = msg.serverContent;
    if (content) {
      if (content.interrupted) return { kind: 'interrupted' };
      const parts = content.modelTurn && content.modelTurn.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const inline = part && part.inlineData;
          if (inline && inline.data) {
            const rate = Number((/rate=(\d+)/.exec(String(inline.mimeType || '')) || [])[1]) || OUTPUT_RATE;
            return { kind: 'audio', pcm: inline.data, rate };
          }
        }
      }
      const outText = content.outputTranscription && content.outputTranscription.text;
      if (outText) return { kind: 'text', text: outText, role: 'jenni' };
      const inText = content.inputTranscription && content.inputTranscription.text;
      if (inText) return { kind: 'text', text: inText, role: 'me' };
      if (content.turnComplete) return { kind: 'turnComplete' };
    }
    return null;
  }

  /** base64 → Int16Array (PCM16 little-endian). */
  function decodePcm(base64) {
    const bytes = base64ToBytes(base64);
    const count = Math.floor(bytes.length / 2);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i += 1) {
      const lo = bytes[i * 2];
      const hi = bytes[i * 2 + 1];
      const value = (hi << 8) | lo;
      out[i] = value >= 0x8000 ? value - 0x10000 : value;
    }
    return out;
  }

  function base64ToBytes(base64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(base64 || ''), 'base64'));
    const bin = atob(String(base64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** Float32 mono (AudioContext) → base64 PCM16 at 16 kHz. */
  function encodeMic(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const v = Math.max(-1, Math.min(1, float32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return bytesToBase64(new Uint8Array(out.buffer));
  }

  /** Very small rising/falling ramp so a cut-off sentence does not click. */
  function fade(samples, ms, rate) {
    const n = Math.min(samples.length, Math.floor((rate || OUTPUT_RATE) * (ms || 8) / 1000));
    for (let i = 0; i < n; i += 1) {
      const gain = i / n;
      samples[i] *= gain;
      samples[samples.length - 1 - i] *= gain;
    }
    return samples;
  }

  /**
   * Tiny PCM player with a hard `stop()` for barge-in. Uses one AudioContext and
   * schedules buffer sources back to back; `stop()` kills everything queued so a
   * new sentence never plays over the old one.
   */
  function createPlayer(ctx, rate) {
    const context = ctx;
    const sampleRate = rate || OUTPUT_RATE;
    let sources = [];
    let nextAt = 0;
    let stopped = false;

    function stop() {
      stopped = true;
      sources.forEach((src) => { try { src.stop(); } catch (error) { /* already ended */ } });
      sources = [];
      nextAt = 0;
    }

    function play(pcm16) {
      if (!context || !pcm16 || !pcm16.length) return;
      stopped = false;
      const buffer = context.createBuffer(1, pcm16.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm16.length; i += 1) channel[i] = pcm16[i] / 0x8000;
      const src = context.createBufferSource();
      src.buffer = buffer;
      src.connect(context.destination);
      const at = Math.max(nextAt, context.currentTime + 0.02);
      src.start(at);
      nextAt = at + buffer.duration;
      sources.push(src);
      src.onended = () => { sources = sources.filter((s) => s !== src); };
    }

    return { play, stop, get playing() { return sources.length > 0; }, get scheduledUntil() { return nextAt; } };
  }

  return {
    WS_BASE,
    MODELS,
    INPUT_RATE,
    OUTPUT_RATE,
    DEFAULT_VOICE,
    url,
    setupMessage,
    audioMessage,
    activityMessage,
    textMessage,
    readPacket,
    decodePcm,
    encodeMic,
    bytesToBase64,
    base64ToBytes,
    fade,
    createPlayer
  };
});
