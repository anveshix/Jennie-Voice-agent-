const test = require('node:test');
const assert = require('node:assert/strict');

const LIVE = require('./docs/live.js');
const FAST = require('./docs/fast.js');
const PERSONA = require('./docs/persona.js');

/* ── Gemini Live packets ─────────────────────────────────────────────────── */

test('live: setup asks for native audio, low latency, and server-side barge-in', () => {
  const msg = LIVE.setupMessage({ instructions: 'Tum Jenni ho.', voice: 'Puck', model: LIVE.MODELS[1] });
  const setup = msg.setup;
  assert.equal(setup.model, 'models/' + LIVE.MODELS[1]);
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.equal(setup.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(setup.systemInstruction.parts[0].text, 'Tum Jenni ho.');
  assert.equal(setup.realtimeInputConfig.activityHandling, 'START_OF_ACTIVITY_INTERRUPTS');
  assert.equal(setup.realtimeInputConfig.automaticActivityDetection.disabled, false);
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
  assert.ok(setup.contextWindowCompression.slidingWindow.targetTokens > 0);
});

test('live: an unknown model falls back to a supported native-audio model', () => {
  const msg = LIVE.setupMessage({ model: 'gemini-not-real' });
  assert.equal(msg.setup.model, 'models/' + LIVE.MODELS[0]);
  assert.match(msg.setup.model, /native-audio/);
});

test('live: websocket url carries the key and the chosen API version', () => {
  const url = LIVE.url('AIza test/+key');
  assert.match(url, /^wss:\/\/generativelanguage\.googleapis\.com\/ws\//);
  assert.match(url, /BidiGenerateContent\?key=/);
  assert.ok(!url.includes(' '), 'the key is URL-encoded');
  assert.match(LIVE.url('k', 'v1alpha'), /generativelanguage\.v1alpha\.GenerativeService/);
  assert.match(LIVE.url('k'), /generativelanguage\.v1beta\.GenerativeService/);
});

test('live: mic chunks are 16 kHz PCM16 and typed turns are clientContent', () => {
  const mic = LIVE.audioMessage('AAAA');
  assert.equal(mic.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(mic.realtimeInput.audio.data, 'AAAA');
  assert.deepEqual(LIVE.textMessage('namaste'), {
    clientContent: { turns: [{ role: 'user', parts: [{ text: 'namaste' }] }], turnComplete: true }
  });
  assert.deepEqual(LIVE.activityMessage('audioStreamEnd'), { realtimeInput: { activity: { audioStreamEnd: true } } });
});

test('live: server packets map onto audio / text / interrupted / turnComplete', () => {
  assert.deepEqual(LIVE.readPacket('{"setupComplete":{}}'), { kind: 'ready' });

  const audio = LIVE.readPacket(JSON.stringify({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } }
  }));
  assert.deepEqual(audio, { kind: 'audio', pcm: 'AAAA', rate: 24000 });

  const spoken = LIVE.readPacket({
    serverContent: { outputTranscription: { text: 'Haan sir.' } }
  });
  assert.deepEqual(spoken, { kind: 'text', text: 'Haan sir.', role: 'jenni' });

  const heard = LIVE.readPacket({ serverContent: { inputTranscription: { text: 'kaam bolo' } } });
  assert.deepEqual(heard, { kind: 'text', text: 'kaam bolo', role: 'me' });

  assert.deepEqual(LIVE.readPacket({ serverContent: { interrupted: true } }), { kind: 'interrupted' });
  assert.deepEqual(LIVE.readPacket({ serverContent: { turnComplete: true } }), { kind: 'turnComplete' });
  assert.deepEqual(LIVE.readPacket({ goAway: { timeLeft: '1s' } }), { kind: 'close', reason: 'goAway' });
  assert.equal(LIVE.readPacket('not json'), null);
  assert.equal(LIVE.readPacket({}), null);
});

test('live: PCM helpers round-trip and clamp correctly', () => {
  const floats = new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]);
  const encoded = LIVE.encodeMic(floats);
  const decoded = LIVE.decodePcm(encoded);
  assert.equal(decoded.length, floats.length);
  assert.equal(decoded[0], 0);
  assert.equal(decoded[1], 32767);
  assert.equal(decoded[2], -32768);
  assert.equal(decoded[5], 32767, 'above-range input is clamped, not wrapped');
  assert.equal(decoded[6], -32768);
  // 16-bit PCM, 2 bytes per sample
  assert.equal(LIVE.base64ToBytes(encoded).length, floats.length * 2);
});

test('live: a cut sentence is faded, not clicked', () => {
  const samples = LIVE.fade(new Float32Array(480).fill(1), 5, 24000);
  assert.ok(samples[0] < 0.05, 'starts near silence');
  assert.ok(samples[samples.length - 1] < 0.05, 'ends near silence');
  assert.equal(samples[240], 1, 'the middle is untouched');
});

test('live: the player stops everything on barge-in', () => {
  const started = [];
  const stopped = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    createBuffer: (channels, length, rate) => ({ duration: length / rate, getChannelData: () => new Float32Array(length), length, rate }),
    createBufferSource: () => {
      const src = { connect() {}, start() { started.push(src); }, stop() { stopped.push(src); } };
      return src;
    }
  };
  const player = LIVE.createPlayer(ctx, 24000);
  player.play(new Int16Array(24000));
  player.play(new Int16Array(12000));
  assert.equal(started.length, 2, 'chunks queue back to back');
  assert.ok(ctx.currentTime + 0.02 <= 1.01);
  player.stop();
  assert.equal(stopped.length, 2, 'every queued source is cancelled');
  assert.equal(player.playing, false);
});

/* ── instant local replies ───────────────────────────────────────────────── */

test('fast: greetings and acks answer instantly in "haan sir" style', () => {
  assert.match(FAST.quickReply('hello'), /haan sir/i);
  assert.match(FAST.quickReply('Namaste!'), /sir/i);
  assert.match(FAST.quickReply('hey jenni'), /sir/i);
  assert.match(FAST.quickReply('thank you'), /sir/i);
  assert.equal(FAST.quickReply('kaise ho'), 'Bilkul theek hoon sir, aap bataiye — kya karna hai?');
  assert.equal(FAST.match('haan').id, 'yes-sir');
  assert.equal(FAST.match('theek hai').id, 'yes-sir');
  assert.equal(FAST.match('ruko').id, 'stop', 'stop words are recognised as control, not chat');
  assert.equal(FAST.quickReply('ruko'), null, 'stop words are not answered by the fast path');
});

test('fast: real requests always reach the model', () => {
  for (const text of [
    'leave application banao',
    'aaj ka mausam kaisa hai',
    'SA1 marks ka analysis karo',
    'akeli hoon aur bore ho rahi hoon',
    'haan par kal school jana hai kya',
    'ye lamba sawaal hai jo model ko jana chahiye kyunki isme kaam hai'
  ]) {
    assert.equal(FAST.quickReply(text), null, text);
  }
  assert.equal(FAST.quickReply(''), null);
});

/* ── shared persona ──────────────────────────────────────────────────────── */

test('persona: the greeting is short, respectful and work-ready', () => {
  assert.match(PERSONA.GREETING, /sir/i);
  assert.ok(PERSONA.GREETING.length < 90, 'a greeting must be sayable in one breath');
  assert.ok(PERSONA.GREETING.split(' ').length <= 14);
});

test('persona: manner lines demand "sir", humility, emotion and short replies', () => {
  const all = PERSONA.MANNER.join(' ');
  assert.match(all, /sir/i);
  assert.match(all, /humble|polite/i);
  assert.match(all, /emotion/i);
  assert.match(all, /short/i);
  assert.ok(!/yaar|tum/.test(all), 'the old casual "tum/yaar" tone is gone from the manner lines');
});

test('persona: spoken replies are trimmed at a sentence, never mid-word', () => {
  const long = 'Haan sir. '.repeat(40) + 'Kar diya.';
  const short = PERSONA.shortForSpeech(long, 60);
  assert.ok(short.length <= 62, short.length + ' chars');
  assert.ok(short.endsWith('.') || short.endsWith('…'), 'ends cleanly: ' + short.slice(-3));
  assert.equal(PERSONA.shortForSpeech('ji sir', 100), 'ji sir');
  assert.ok(PERSONA.shortForSpeech('a'.repeat(300), 50).length <= 52);
});
