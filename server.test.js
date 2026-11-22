'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAppServer,
  getConfig,
  isLoopbackHost,
  parseChatMessages,
  parseDotEnv,
  readStoredSettings,
  writeStoredSettings,
  clearStoredSettings,
  resolveConfig,
  detectProvider,
  SETTINGS_FILE
} = require('./server');
const { validateSettings, PRESETS } = require('./public/providers.js');
const { createConnections, ConnectionError } = require('./connections.js');

/** Keep the developer's real storage/settings.json out of the way. */
async function withCleanSettings(callback) {
  const backup = (() => {
    try { return fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch (error) { return null; }
  })();
  clearStoredSettings();
  try {
    return await callback();
  } finally {
    clearStoredSettings();
    if (backup !== null) {
      fs.writeFileSync(SETTINGS_FILE, backup, { mode: 0o600 });
    }
  }
}

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
  const backup = (() => {
    try { return fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch (error) { return null; }
  })();
  clearStoredSettings();
  const server = createAppServer({ env });
  const port = await listen(server);
  try {
    await callback(port);
  } finally {
    await close(server);
    clearStoredSettings();
    if (backup !== null) fs.writeFileSync(SETTINGS_FILE, backup, { mode: 0o600 });
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
    assert.equal(result.json.configured, false);
    assert.equal(result.json.transcriptionConfigured, false);
    assert.equal(result.json.model, 'test-model');
    assert.equal(result.json.keySet, false);
    assert.equal(result.json.source, 'env');
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
      assert.match(providerRequest.body.messages[0].content, /"sir"/, 'the server prompt keeps the respectful "sir" manner');
      assert.match(providerRequest.body.messages[0].content, /very short/i, 'the server prompt asks for very short replies');
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

test('an upstream 503 is retried, then reported as the provider\'s fault with a retry hint', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1' }
    });
  };
  try {
    await withServer(TEST_ENV, async (port) => {
      const result = await request(port, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
      });
      assert.ok(calls > 1, `the upstream 503 was retried (calls: ${calls})`);
      assert.equal(result.status, 503);
      assert.equal(result.json.error.code, 'AI_PROVIDER_OVERLOADED');
      assert.equal(result.json.error.retryable, true);
      assert.match(result.json.error.message, /overloaded or down/i);
      assert.equal(result.json.error.providerStatus, 503);
      assert.equal(result.headers['retry-after'] !== undefined, true, 'Retry-After is passed on');
      assert.equal(result.text.includes(TEST_ENV.AI_API_KEY), false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('an upstream 503 that clears on retry returns the answer, not an error', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Second try worked.' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    await withServer(TEST_ENV, async (port) => {
      const result = await request(port, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { reply: 'Second try worked.' });
      assert.equal(calls, 2);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('an auth failure is never retried — repeating a bad key wastes quota', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('nope', { status: 401 });
  };
  try {
    await withServer(TEST_ENV, async (port) => {
      const result = await request(port, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
      });
      assert.equal(calls, 1);
      assert.equal(result.status, 502);
      assert.equal(result.json.error.code, 'AI_AUTH_ERROR');
      assert.equal(result.json.error.retryable, false);
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

test('a retired model id (404) is explained as a model problem, not a generic error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'model_not_found' } }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
  try {
    await withServer(TEST_ENV, async (port) => {
      const result = await request(port, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
      });
      assert.equal(result.status, 502);
      assert.equal(result.json.error.code, 'AI_MODEL_NOT_FOUND');
      assert.match(result.json.error.message, /404/);
      assert.match(result.json.error.message, /retired/);
      // the failed model is named so the user knows what to replace
      assert.equal(result.json.error.message.includes(TEST_ENV.AI_MODEL), true);
      assert.equal(result.text.includes(TEST_ENV.AI_API_KEY), false);
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

test('provider presets are well-formed and cover the documented providers', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.label, `${name} needs a label`);
    assert.equal(typeof preset.model, 'string');
    if (name !== 'custom') assert.match(preset.baseUrl, /^https?:\/\//, `${name} base URL`);
  }
  assert.equal(PRESETS.gemini.transcriptionModel, '', 'Gemini has no OpenAI-compatible transcription here');
  assert.equal(PRESETS.ollama.transcriptionModel, '');
});

test('settings validation blocks unsafe or incomplete providers', () => {
  assert.equal(validateSettings({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' }).valid, false);
  assert.equal(validateSettings({ baseUrl: 'http://api.openai.com/v1', model: 'x', apiKey: 'sk-12345678' }).valid, false);
  assert.equal(validateSettings({ baseUrl: 'https://api.openai.com/v1?x=1', model: 'x', apiKey: 'sk-12345678' }).valid, false);
  assert.equal(validateSettings({ baseUrl: 'https://api.openai.com/v1', model: '', apiKey: 'sk-12345678' }).valid, false);
  assert.equal(validateSettings({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'short' }).valid, false);

  const good = validateSettings({ baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4o-mini', apiKey: 'sk-1234567890', transcriptionModel: 'whisper-1' });
  assert.equal(good.valid, true);
  assert.equal(good.value.baseUrl, 'https://api.openai.com/v1');

  // a local provider needs no key
  assert.equal(validateSettings({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', apiKey: '' }).valid, true);
  // keeping an existing key is allowed
  assert.equal(validateSettings({ baseUrl: 'https://api.groq.com/openai/v1', model: 'x', apiKey: '' }, { keepKey: true }).valid, true);
});

test('detectProvider recognises the built-in presets', () => {
  assert.equal(detectProvider('https://api.openai.com/v1'), 'openai');
  assert.equal(detectProvider('https://api.groq.com/openai/v1'), 'groq');
  assert.equal(detectProvider('https://generativelanguage.googleapis.com/v1beta/openai'), 'gemini');
  assert.equal(detectProvider('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(detectProvider('http://localhost:11434/v1'), 'ollama');
  assert.equal(detectProvider('https://my-proxy.example/v1'), 'custom');
});

test('API room saves a provider without leaking the key, and applies it live', async () => {
  await withCleanSettings(async () => {
    await withServer({}, async (port) => {
      const before = await request(port, '/api/health');
      assert.equal(before.json.configured, false);

      const saved = await request(port, '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'https://provider.example/v1',
          model: 'room-model',
          transcriptionModel: 'whisper-1',
          apiKey: 'sk-room-secret-123456',
          provider: 'custom'
        })
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.saved, true);
      assert.equal(saved.json.configured, true);
      assert.equal(saved.json.model, 'room-model');
      assert.equal(saved.text.includes('sk-room-secret'), false, 'key must never come back');

      // takes effect without a restart
      const health = await request(port, '/api/health');
      assert.equal(health.json.configured, true);
      assert.equal(health.json.model, 'room-model');
      assert.equal(health.text.includes('sk-room-secret'), false);

      const status = await request(port, '/api/settings');
      assert.equal(status.json.keySet, true);
      assert.equal(status.json.source, 'room');
      assert.equal(status.text.includes('sk-room-secret'), false);

      assert.equal(readStoredSettings().apiKey, 'sk-room-secret-123456');
    });
  });
});

test('API room rejects invalid settings and keeps the old key when omitted', async () => {
  await withCleanSettings(async () => {
    await withServer({}, async (port) => {
      const bad = await request(port, '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://provider.example/v1', model: 'm', apiKey: 'sk-1234567890' })
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'INVALID_SETTINGS');

      await request(port, '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://provider.example/v1', model: 'first', apiKey: 'sk-first-key-1234' })
      });

      // save again with an empty key -> the stored key survives
      const second = await request(port, '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://provider.example/v2', model: 'second', apiKey: '', keepKey: true })
      });
      assert.equal(second.status, 200);
      assert.equal(second.json.model, 'second');
      assert.equal(readStoredSettings().apiKey, 'sk-first-key-1234');
    });
  });
});

test('API room supports a keyless local provider and can clear settings', async () => {
  await withCleanSettings(async () => {
    await withServer({}, async (port) => {
      const local = await request(port, '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', transcriptionModel: '', apiKey: '' })
      });
      assert.equal(local.status, 200);
      assert.equal(local.json.configured, true);
      assert.equal(local.json.isLocal, true);

      const removed = await request(port, '/api/settings', { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.equal(removed.json.cleared, true);

      const after = await request(port, '/api/health');
      assert.equal(after.json.configured, false);
      assert.equal(readStoredSettings(), null);
    });
  });
});

test('API room test endpoint reports provider failures without leaking secrets', async () => {
  await withCleanSettings(async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(`bad key sk-room-test-secret`, { status: 401 });
    try {
      await withServer({}, async (port) => {
        const missing = await request(port, '/api/settings/test', { method: 'POST' });
        assert.equal(missing.status, 400);
        assert.equal(missing.json.error.code, 'NOT_CONFIGURED');

        await request(port, '/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'sk-room-test-secret' })
        });

        const result = await request(port, '/api/settings/test', { method: 'POST' });
        assert.equal(result.status, 200);
        assert.equal(result.json.ok, false);
        assert.equal(result.json.code, 'AI_AUTH_ERROR');
        assert.equal(result.text.includes('sk-room-test-secret'), false);
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('API room test endpoint reports success for a working provider', async () => {
  await withCleanSettings(async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    try {
      await withServer({}, async (port) => {
        await request(port, '/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: 'https://provider.example/v1', model: 'm', apiKey: 'sk-working-key-1234', transcriptionModel: 'whisper-1' })
        });
        const result = await request(port, '/api/settings/test', { method: 'POST' });
        assert.equal(result.status, 200);
        assert.equal(result.json.ok, true);
        assert.equal(result.json.model, 'm');
        assert.equal(result.json.transcriptionConfigured, true);
        assert.equal(typeof result.json.ms, 'number');
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('stored settings beat .env, and .env still works when the room is empty', async () => {
  await withCleanSettings(async () => {
    const env = { AI_BASE_URL: 'https://env.example/v1', AI_MODEL: 'env-model', AI_API_KEY: 'sk-env-key-1234' };

    const fromEnv = resolveConfig(env);
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.model, 'env-model');
    assert.equal(fromEnv.configured, true);

    writeStoredSettings({
      baseUrl: 'https://room.example/v1',
      model: 'room-model',
      transcriptionModel: 'whisper-1',
      apiKey: 'sk-room-key-1234',
      provider: 'custom',
      savedAt: new Date().toISOString()
    });

    const fromRoom = resolveConfig(env);
    assert.equal(fromRoom.source, 'room');
    assert.equal(fromRoom.model, 'room-model');
    assert.equal(fromRoom.baseUrl, 'https://room.example/v1');

    clearStoredSettings();
    assert.equal(resolveConfig(env).source, 'env');
  });
});

/* ------------------------------------------------------------------ connections */

async function withTempStore(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenni-conn-'));
  try {
    return await callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const result = await handler(url, options);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body
    };
  };
  impl.calls = calls;
  return impl;
}

test('connections start empty and expose no secrets', async () => {
  await withTempStore((dir) => {
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true });
    const status = conn.status();
    assert.equal(status.telegram.configured, false);
    assert.equal(status.drive.mode, 'off');
    assert.equal(/sk-|gsk_|refresh-|GOCSPX-/.test(JSON.stringify(status)), false, 'no secret values are exposed');
    assert.equal(status.telegram.botTokenHint, '');
  });
});

test('telegram validates the token shape before calling the network', async () => {
  await withTempStore(async (dir) => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { ok: true, result: [] } }));
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl });
    await assert.rejects(() => conn.findChats(''), (error) => error instanceof ConnectionError && error.code === 'TELEGRAM_TOKEN_REQUIRED');
    await assert.rejects(() => conn.findChats('hello'), (error) => error.code === 'TELEGRAM_TOKEN_SHAPE');
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('telegram chat discovery reads updates and de-duplicates', async () => {
  await withTempStore(async (dir) => {
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: {
        ok: true,
        result: [
          { message: { chat: { id: 42, first_name: 'Anu', username: 'anu', type: 'private' }, text: 'hi' } },
          { message: { chat: { id: 42, first_name: 'Anu', type: 'private' }, text: 'again' } },
          { message: { chat: { id: -100, title: 'Family', type: 'group' }, text: 'hello' } }
        ]
      }
    }));
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl });
    const chats = await conn.findChats(token);
    assert.equal(chats.length, 2);
    assert.equal(chats[0].id, '42');
    assert.equal(chats[0].username, '@anu');
    assert.equal(chats[1].id, '-100');
    assert.match(fetchImpl.calls[0].url, /getUpdates$/);
  });
});

test('saving telegram verifies with getMe + sendMessage and stores the chat', async () => {
  await withTempStore(async (dir) => {
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('/getMe')) return { status: 200, body: { ok: true, result: { username: 'jenni_bot' } } };
      return { status: 200, body: { ok: true, result: { message_id: 7 } } };
    });
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl });
    const saved = await conn.saveTelegram({ body: {} }, { botToken: token, chatId: '42' });
    assert.equal(saved.configured, true);
    assert.equal(saved.botUsername, 'jenni_bot');
    assert.equal(saved.chatId, '42');
    assert.equal(JSON.stringify(saved).includes(token), false);

    const status = conn.status();
    assert.equal(status.telegram.botTokenHint.endsWith('fghi'), true);
    assert.equal(JSON.stringify(status).includes(token), false);

    const mode = fs.statSync(path.join(dir, 'connections.json')).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  });
});

test('telegram actions require a saved connection and honour the local-only rule', async () => {
  await withTempStore(async (dir) => {
    const local = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl: fakeFetch(() => ({ status: 200, body: { ok: true, result: {} } })) });
    await assert.rejects(() => local.sendTelegram({ text: 'x' }), (error) => error.code === 'TELEGRAM_NOT_CONFIGURED');

    const remote = createConnections({ storageDir: dir, requestIsLocal: () => false, fetchImpl: fakeFetch(() => ({ status: 200, body: { ok: true, result: {} } })) });
    await assert.rejects(
      () => remote.saveTelegram({}, { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '1' }),
      (error) => error.code === 'LOCAL_ONLY' && error.status === 403
    );
    assert.throws(() => remote.disconnectTelegram({}), (error) => error.code === 'LOCAL_ONLY');
  });
});

test('telegram send clips long drafts and reports the character count', async () => {
  await withTempStore(async (dir) => {
    const long = 'x'.repeat(5000);
    let sentText = '';
    const fetchImpl = fakeFetch((url, options) => {
      if (url.endsWith('/getMe')) return { status: 200, body: { ok: true, result: { username: 'b' } } };
      if (url.endsWith('/sendMessage')) {
        sentText = JSON.parse(options.body).text;
        return { status: 200, body: { ok: true, result: { message_id: 1 } } };
      }
      return { status: 200, body: { ok: true, result: {} } };
    });
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl });
    await conn.saveTelegram({}, { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '9' });
    const result = await conn.sendTelegram({ text: long });
    assert.equal(result.ok, true);
    assert.match(sentText, /shortened/);
    assert.ok(sentText.length < 5000);
  });
});

test('drive client id is validated and secrets only kept in server mode', async () => {
  await withTempStore(async (dir) => {
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl: fakeFetch(() => ({ status: 200, body: {} })) });
    assert.throws(() => conn.saveDrive({}, { clientId: 'nope' }), (error) => error.code === 'DRIVE_CLIENT_SHAPE');

    const browser = conn.saveDrive({}, { clientId: '123-abc.apps.googleusercontent.com', mode: 'browser' });
    assert.equal(browser.mode, 'browser');
    assert.equal(browser.browserReady, true);
    assert.equal(browser.hasClientSecret, false);

    assert.throws(() => conn.saveDrive({}, { mode: 'server' }), (error) => error.code === 'DRIVE_SECRET_REQUIRED');

    const server = conn.saveDrive({}, { mode: 'server', clientSecret: 'GOCSPX-secret' });
    assert.equal(server.hasClientSecret, true);
    assert.equal(server.serverReady, false, 'no refresh token yet');
  });
});

test('drive server mode exchanges the code and stores a refresh token', async () => {
  await withTempStore(async (dir) => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { status: 200, body: { refresh_token: 'refresh-123', access_token: 'access-1', scope: 'https://www.googleapis.com/auth/drive.file' } };
      }
      if (url.includes('/about')) {
        return { status: 200, body: { user: { emailAddress: 'me@example.com' } } };
      }
      return { status: 200, body: {} };
    });
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl });
    conn.saveDrive({}, { clientId: '123-abc.apps.googleusercontent.com', mode: 'server', clientSecret: 'GOCSPX-secret' });

    await assert.rejects(
      () => conn.exchangeDriveCode({}, { code: 'c', redirectUri: 'nope' }),
      (error) => error.code === 'DRIVE_REDIRECT_REQUIRED'
    );

    const drive = await conn.exchangeDriveCode({}, { code: 'one-time-code', redirectUri: 'https://tunnel.example/oauth2callback' });
    assert.equal(drive.serverReady, true);
    assert.equal(drive.hasRefreshToken, true);
    assert.equal(drive.account, 'me@example.com');
    assert.equal(JSON.stringify(drive).includes('refresh-123'), false, 'refresh token never leaves the server');

    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'connections.json'), 'utf8'));
    assert.equal(raw.drive.refreshToken, 'refresh-123');
  });
});

test('drive upload builds a multipart body and returns the link', async () => {
  await withTempStore(async (dir) => {
    let uploadBody = null;
    const fetchImpl = fakeFetch((url, options) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { status: 200, body: { access_token: 'access-2' } };
      }
      if (url.includes('upload/drive/v3/files')) {
        uploadBody = options.body;
        return { status: 200, body: { id: 'file-1', name: 'Test.md', webViewLink: 'https://drive.google.com/file/d/file-1/view' } };
      }
      return { status: 200, body: {} };
    });
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl });
    conn.saveDrive({}, { clientId: '123-abc.apps.googleusercontent.com', mode: 'server', clientSecret: 'GOCSPX-secret' });
    fetchImpl.calls.length = 0;

    const raw = { telegram: { botToken: '', chatId: '', savedAt: '' }, drive: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret', refreshToken: 'refresh-123', mode: 'server', folderId: '', account: '', savedAt: '' } };
    fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify(raw));

    const result = await conn.uploadToDrive({ name: 'Test.md', content: '# Hello' });
    assert.equal(result.ok, true);
    assert.equal(result.id, 'file-1');
    assert.match(result.link, /drive\.google\.com/);
    assert.ok(Buffer.isBuffer(uploadBody));
    assert.match(uploadBody.toString('utf8'), /# Hello/);
    assert.match(uploadBody.toString('utf8'), /multipart|Content-Type: application\/json/);
  });
});

test('drive failures surface Google’s message without the token', async () => {
  await withTempStore(async (dir) => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { status: 200, body: { access_token: 'access-secret-xyz' } };
      return { status: 403, body: { error: { message: 'Insufficient permissions' } } };
    });
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true, fetchImpl });
    fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify({
      telegram: { botToken: '', chatId: '', savedAt: '' },
      drive: { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 's', refreshToken: 'r', mode: 'server', folderId: '', account: '', savedAt: '' }
    }));
    let captured = null;
    try {
      await conn.listDrive();
    } catch (error) {
      captured = error;
    }
    assert.ok(captured);
    assert.equal(captured.message.includes('Insufficient permissions'), true);
    assert.equal(captured.message.includes('access-secret-xyz'), false);
  });
});

test('disconnect clears only the requested service', async () => {
  await withTempStore((dir) => {
    const conn = createConnections({ storageDir: dir, requestIsLocal: () => true });
    conn.saveDrive({}, { clientId: '123-abc.apps.googleusercontent.com', mode: 'browser' });
    const result = conn.disconnectDrive({});
    assert.equal(result.cleared, true);
    assert.equal(conn.status().drive.mode, 'off');
  });
});

test('JENNI_ACCESS_TOKEN gates proxied /api/chat requests', async () => {
  const server = createAppServer({ env: { JENNI_ACCESS_TOKEN: 'sekret', AI_API_KEY: 'k' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const call = (headers) => new Promise((resolve, reject) => {
    const req = require('node:http').request({ port, path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  try {
    assert.equal(await call({ 'x-forwarded-for': '1.2.3.4' }), 401);
    assert.equal(await call({ 'x-forwarded-for': '1.2.3.4', 'x-jenni-token': 'wrong' }), 401);
    assert.notEqual(await call({ 'x-forwarded-for': '1.2.3.4', 'x-jenni-token': 'sekret' }), 401);
  } finally { server.close(); }
});
