'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('./docs/voices.js');

const blobRes = (ok = true, status = 200, body = {}) => ({ ok, status, blob: async () => new Blob(['mp3']), json: async () => body });

test('config: invalid or incomplete setups fall back to the browser voice', () => {
  assert.equal(V.normalizeConfig({}).tts.engine, 'browser');
  assert.equal(V.normalizeConfig({ tts: { engine: 'eleven', key: 'k' } }).tts.engine, 'browser');                   // no voice id
  assert.equal(V.normalizeConfig({ tts: { engine: 'eleven', key: ' k ', voice: 'v1' } }).tts.key, 'k');
  assert.equal(V.normalizeConfig({ tts: { engine: 'compat', base: 'http://evil.example/v1', voice: 'a' } }).tts.engine, 'browser');
  assert.equal(V.normalizeConfig({ tts: { engine: 'compat', base: 'https://voice.example/v1/', voice: 'af_bella' } }).tts.base, 'https://voice.example/v1');
  assert.equal(V.normalizeConfig({ tts: { engine: 'compat', base: 'http://localhost:8880/v1', voice: 'a' } }).tts.engine, 'compat');
  assert.equal(V.normalizeConfig({ stt: { engine: 'eleven' } }).stt.engine, 'default');                               // no key anywhere
  assert.equal(V.normalizeConfig({ tts: { engine: 'eleven', key: 'k', voice: 'v' }, stt: { engine: 'eleven' } }).stt.engine, 'eleven');   // reuses the TTS key
});

test('ElevenLabs TTS: correct endpoint, key header, multilingual model; errors are explained', async () => {
  let seen;
  const tts = V.createTts({ engine: 'eleven', key: 'KEY', voice: 'VOICE/ID', model: '' }, async (url, init) => { seen = { url, init }; return blobRes(); });
  await tts.synth('नमस्ते');
  assert.match(seen.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/VOICE%2FID\?output_format=mp3_44100_64$/);
  assert.equal(seen.init.headers['xi-api-key'], 'KEY');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.text, 'नमस्ते'); assert.equal(body.model_id, 'eleven_flash_v2_5');
  for (const [status, re] of [[401, /key galat/], [402, /credits/], [422, /voice/]]) {
    await assert.rejects(V.createTts({ engine: 'eleven', key: 'k', voice: 'v' }, async () => blobRes(false, status)).synth('x'), re);
  }
});

test('OpenAI-compatible TTS/STT (open-source servers): paths, auth only when a key is set', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push([url, init]); return url.endsWith('/audio/speech') ? blobRes() : { ok: true, status: 200, json: async () => ({ text: ' kal ka plan ' }) }; };
  const cfg = { engine: 'compat', base: 'https://tts.example/v1', key: '', voice: 'af_bella', model: 'kokoro' };
  await V.createTts(cfg, f).synth('hello');
  assert.equal(calls[0][0], 'https://tts.example/v1/audio/speech');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0][1].body), { model: 'kokoro', input: 'hello', voice: 'af_bella', response_format: 'mp3' });
  const text = await V.createStt({ engine: 'compat', base: 'https://tts.example/v1', key: 'k', model: '' }, null, f).transcribe(new Blob(['a']), { lang: 'hi-IN' });
  assert.equal(text, 'kal ka plan');
  assert.equal(calls[1][0], 'https://tts.example/v1/audio/transcriptions');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer k');
  assert.equal(calls[1][1].body.get('language'), 'hi'); assert.equal(calls[1][1].body.get('model'), 'whisper-1');
});

test('ElevenLabs Scribe STT and voice list', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return url.endsWith('/voices') ? { ok: true, status: 200, json: async () => ({ voices: [{ voice_id: 'a1', name: 'Anika', labels: { accent: 'indian', gender: 'female' } }] }) } : { ok: true, status: 200, json: async () => ({ text: 'namaste' }) }; };
  const out = await V.createStt({ engine: 'eleven', key: '', model: '' }, { key: 'TTSKEY' }, f).transcribe(new Blob(['a']), { lang: 'en-IN' });
  assert.equal(out, 'namaste');
  assert.equal(seen.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(seen.init.headers['xi-api-key'], 'TTSKEY');
  assert.equal(seen.init.body.get('model_id'), 'scribe_v1'); assert.equal(seen.init.body.get('language_code'), 'en');
  assert.deepEqual(await V.listElevenVoices('k', f), [{ id: 'a1', name: 'Anika', hint: 'indian, female' }]);
});

test('player: plays in order while later clips prefetch; stop drops the rest; a failure is reported once', async () => {
  const log = [];
  class FakeAudio { constructor(url) { this.url = url; } play() { log.push('play:' + this.url); setTimeout(() => this.onended && this.onended(), 5); return Promise.resolve(); } pause() {} }
  const urlApi = { createObjectURL: (b) => 'blob:' + b.tag, revokeObjectURL() {} };
  const mk = (tag, delay) => new Promise((r) => setTimeout(() => r({ tag }), delay));
  const p = V.createPlayer({ AudioCtor: FakeAudio, urlApi });
  const ends = [];
  p.enqueue(mk('one', 30), { onEnd: (e) => ends.push(['one', e]) });
  p.enqueue(mk('two', 1), { onEnd: (e) => ends.push(['two', e]) });          // ready first, still plays second
  p.enqueue(Promise.reject(new Error('quota')), { onEnd: (e) => ends.push(['bad', e && e.message]) });
  await p.whenIdle();
  assert.deepEqual(log, ['play:blob:one', 'play:blob:two']);
  assert.deepEqual(ends, [['one', null], ['two', null], ['bad', 'quota']]);
  p.enqueue(mk('a', 20), { onEnd: (e) => ends.push(['a', e]) });
  p.enqueue(mk('b', 20), { onEnd: (e) => ends.push(['b', e]) });
  p.stop();
  await p.whenIdle();
  assert.ok(!log.includes('play:blob:b'));
});
