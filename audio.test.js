'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('./docs/audio.js');

test('WAV: valid RIFF header, 16 kHz mono PCM16, samples clipped and preserved', () => {
  const wav = A.encodeWav(Float32Array.from([0, 0.5, -0.5, 2, -2]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 16)), 'WAVEfmt ');
  assert.equal(v.getUint16(20, true), 1);            // PCM
  assert.equal(v.getUint16(22, true), 1);            // mono
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 10);           // 5 samples * 2 bytes
  assert.equal(wav.length, 54);
  assert.equal(v.getInt16(46, true), 16383);         // 0.5
  assert.equal(v.getInt16(50, true), 32767);         // clipped +
  assert.equal(v.getInt16(52, true), -32768);        // clipped -
});

test('resample 48k→16k keeps duration; stereo mixes down', () => {
  const sec = new Float32Array(48000).map((_, i) => Math.sin(i / 20));
  assert.equal(A.resample(sec, 48000, 16000).length, 16000);
  assert.equal(A.resample(sec, 16000, 16000), sec);
  const mono = A.mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
  assert.deepEqual(Array.from(mono), [0.5, 0.5]);
});

test('blobToWav decodes through an AudioContext and returns base64 wav', async () => {
  const data = new Float32Array(48000).fill(0.1);
  const ctx = { decodeAudioData: async () => ({ numberOfChannels: 1, sampleRate: 48000, getChannelData: () => data }) };
  const r = await A.blobToWav({ arrayBuffer: async () => new ArrayBuffer(8) }, ctx);
  assert.equal(r.format, 'wav'); assert.ok(Math.abs(r.seconds - 1) < 0.01);
  assert.equal(Buffer.from(r.base64, 'base64').slice(0, 4).toString(), 'RIFF');
});

test('VAD: ends shortly after speech stops; gives up on silence; caps long recordings', () => {
  let v = A.createVad({ silenceMs: 900 });
  assert.equal(v.feed(0.001, 0), 'waiting');
  assert.equal(v.feed(0.1, 500), 'speaking');
  assert.equal(v.feed(0.001, 1200), 'speaking');
  assert.equal(v.feed(0.001, 1500), 'done');
  v = A.createVad({ noSpeechMs: 3000 });
  assert.equal(v.feed(0.001, 0), 'waiting'); assert.equal(v.feed(0.001, 3100), 'done'); assert.ok(!v.heard());
  v = A.createVad({ maxMs: 2000 });
  v.feed(0.5, 0); assert.equal(v.feed(0.5, 2100), 'done');
});
