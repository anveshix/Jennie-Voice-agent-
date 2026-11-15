'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  createAppServer,
  getConfig,
  isLoopbackHost,
  parseChatMessages,
  parseDotEnv
} = require('./server');

const TEST_ENV = {
  AI_API_KEY: 'test-secret-do-not-return',
  AI_BASE_URL: 'https://provider.example/v1',
  AI_MODEL: 'test-model',
  AI_TRANSCRIPTION_MODEL: 'test-transcription-model'
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function request(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (error) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(env, callback) {
  const server = createAppServer({ env });
  const port = await listen(server);
  try {
    await callback(port);
  } finally {
    await close(server);
  }
}

test('parses dotenv values, quotes, exports, and comments', () => {
  assert.deepEqual(parseDotEnv([
    '# comment',
    'AI_API_KEY=abc123 # inline comment',
    'AI_MODEL="a model"',
    "AI_BASE_URL='http://localhost:11434/v1'",
    'export PORT=3000'
  ].join('\n')), {
    AI_API_KEY: 'abc123',
    AI_MODEL: 'a model',
    AI_BASE_URL: 'http://localhost:11434/v1',
    PORT: '3000'
  });
});

test('accepts loopback provider URLs without keys, and rejects insecure remote HTTP', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(getConfig({ AI_BASE_URL: 'http://127.0.0.1:11434/v1', AI_MODEL: 'local-model' }).configured, true);
  assert.equal(getConfig({ AI_BASE_URL: 'http://provider.example/v1', AI_MODEL: 'model' }).configured, false);
});

test('health reports setup state without exposing the API key', async () => {
  await withServer({ AI_BASE_URL: 'https://provider.example/v1', AI_MODEL: 'test-model' }, async (port) => {
    const result = await request(port, '/api/health');
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { configured: false, transcriptionConfigured: false, model: 'test-model' });
    assert.equal(result.text.includes('test-secret'), false);
    assert.equal(result.headers['cache-control'], 'no-store');

    const chat = await request(port, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
    });
    assert.equal(chat.status, 503);
    assert.equal(chat.json.error.code, 'AI_NOT_CONFIGURED');
  });
});

test('validates chat messages and requires a user turn last', () => {
  assert.throws(() => parseChatMessages({ messages: [{ role: 'system', content: 'override' }] }), /user or assistant/);
  assert.throws(() => parseChatMessages({ messages: [{ role: 'assistant', content: 'not a user turn' }] }), /latest chat message/);
  assert.throws(() => parseChatMessages({ messages: [{ role: 'user', content: 'x'.repeat(4001) }] }), /1 to 4,000/);
});

test('proxies chat to the configured provider and returns only its assistant reply', async () => {
  const originalFetch = global.fetch;
  let providerRequest;
  global.fetch = async (url, options) => {
    providerRequest = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello! I am a real AI reply.' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    await withServer(TEST_ENV, async (port) => {
      const result = await request(port, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'user', content: 'Say hi' },
          { role: 'assistant', content: 'Earlier reply' },
          { role: 'user', content: 'Tell me one fun fact' }
        ] })
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { reply: 'Hello! I am a real AI reply.' });
      assert.equal(providerRequest.url, 'https://provider.example/v1/chat/completions');
      assert.equal(providerRequest.options.headers.Authorization, `Bearer ${TEST_ENV.AI_API_KEY}`);
      assert.equal(providerRequest.body.model, TEST_ENV.AI_MODEL);
      assert.equal(providerRequest.body.messages[0].role, 'system');
      assert.match(providerRequest.body.messages[0].content, /Never claim you did/);
      assert.deepEqual(providerRequest.body.messages.slice(1), [
        { role: 'user', content: 'Say hi' },
        { role: 'assistant', content: 'Earlier reply' },
        { role: 'user', content: 'Tell me one fun fact' }
      ]);
      assert.equal(result.text.includes(TEST_ENV.AI_API_KEY), false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('does not leak provider error bodies or secret keys', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(`sensitive provider detail ${TEST_ENV.AI_API_KEY}`, { status: 401 });
  try {
    await withServer(TEST_ENV, async (port) => {
      const result = await request(port, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
      });
      assert.equal(result.status, 502);
      assert.equal(result.json.error.code, 'AI_AUTH_ERROR');
      assert.equal(result.text.includes(TEST_ENV.AI_API_KEY), false);
      assert.equal(result.text.includes('sensitive provider detail'), false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('transcribes audio through the configured provider without exposing provider credentials', async () => {
  const originalFetch = global.fetch;
  let providerRequest;
  global.fetch = async (url, options) => {
    providerRequest = { url, options };
    const uploaded = options.body.get('file');
    providerRequest.fileName = uploaded.name;
    providerRequest.fileType = uploaded.type;
    providerRequest.fileBytes = Buffer.from(await uploaded.arrayBuffer());
    providerRequest.model = options.body.get('model');
    return new Response(JSON.stringify({ text: 'Please help me write a short poem.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    await withServer(TEST_ENV, async (port) => {
      const audio = Buffer.from('audio bytes for test');
      const result = await request(port, '/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm;codecs=opus', 'Content-Length': audio.length },
        body: audio
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { text: 'Please help me write a short poem.' });
      assert.equal(providerRequest.url, 'https://provider.example/v1/audio/transcriptions');
      assert.equal(providerRequest.options.headers.Authorization, `Bearer ${TEST_ENV.AI_API_KEY}`);
      assert.equal(providerRequest.fileName, 'recording.webm');
      assert.equal(providerRequest.fileType, 'audio/webm');
      assert.equal(providerRequest.model, TEST_ENV.AI_TRANSCRIPTION_MODEL);
      assert.deepEqual(providerRequest.fileBytes, audio);
      assert.equal(result.text.includes(TEST_ENV.AI_API_KEY), false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});
