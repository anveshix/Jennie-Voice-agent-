/**
 * Audio helpers for providers that understand speech through the chat endpoint
 * (Gemini's OpenAI-compatible API accepts WAV/MP3, not the WebM/MP4 a phone
 * records). Converts a recording to 16 kHz mono PCM WAV in the browser, and
 * provides a small voice-activity detector so a recording ends when the owner
 * stops talking instead of after a fixed timer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_AUDIO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TARGET_RATE = 16000;

  function mixToMono(channels) {
    if (channels.length === 1) return channels[0];
    const len = channels[0].length, out = new Float32Array(len);
    for (let c = 0; c < channels.length; c += 1) for (let i = 0; i < len; i += 1) out[i] += channels[c][i] / channels.length;
    return out;
  }

  /** Linear-interpolation resample (speech at 16 kHz does not need better). */
  function resample(samples, from, to) {
    if (from === to) return samples;
    const ratio = from / to, len = Math.max(1, Math.floor(samples.length / ratio)), out = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, samples.length - 1), frac = pos - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
  }

  /** Float32 mono → 16-bit PCM WAV bytes. */
  function encodeWav(samples, rate) {
    const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return bytes;
  }

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** A recorded Blob → { base64, format:'wav', seconds }. `ctx` is an AudioContext. */
  async function blobToWav(blob, ctx) {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    const mono = resample(mixToMono(channels), decoded.sampleRate, TARGET_RATE);
    return { base64: toBase64(encodeWav(mono, TARGET_RATE)), format: 'wav', seconds: mono.length / TARGET_RATE };
  }

  /**
   * Voice-activity detector. feed(rms, ms) → 'waiting' | 'speaking' | 'done'.
   * Ends after `silenceMs` of quiet once speech has been heard, or gives up
   * after `maxMs` / `noSpeechMs`.
   */
  function createVad({ threshold = 0.02, silenceMs = 900, noSpeechMs = 6000, maxMs = 15000 } = {}) {
    let heard = false, lastLoud = 0, start = null;
    return {
      feed(rms, ms) {
        if (start === null) start = ms;
        if (rms >= threshold) { heard = true; lastLoud = ms; }
        if (ms - start >= maxMs) return 'done';
        if (!heard) return ms - start >= noSpeechMs ? 'done' : 'waiting';
        return ms - lastLoud >= silenceMs ? 'done' : 'speaking';
      },
      heard: () => heard
    };
  }

  const rmsOf = (buf) => { let s = 0; for (let i = 0; i < buf.length; i += 1) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.sqrt(s / buf.length); };

  return { resample, mixToMono, encodeWav, toBase64, blobToWav, createVad, rmsOf, TARGET_RATE };
});
