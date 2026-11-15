'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const JSON_LIMIT_BYTES = 128 * 1024;
const AUDIO_LIMIT_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
const SYSTEM_PROMPT = [
  'You are Jenni, a helpful conversational AI assistant.',
  'Reply in the language and style the user uses, including English, Hindi, or Hinglish.',
  'Be warm and concise by default; provide complete, useful detail when asked.',
  'When asked to write or draft something, create the requested content rather than returning a blank template or saying a draft is ready.',
  'You cannot access this browser’s local drafts, tasks, notes, files, Google Drive, or external accounts unless their contents are included in the conversation.',
  'You cannot send messages, save files, or perform external actions. Never claim you did. You may offer text for the user to review and save locally.'
].join(' ');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseDotEnv(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (match[2].startsWith('"')) {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function loadDotEnv(filePath = path.join(ROOT, '.env'), target = process.env) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const [key, value] of Object.entries(parseDotEnv(contents))) {
    if (target[key] === undefined) target[key] = value;
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '::' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function getConfig(env = process.env) {
  const baseUrl = String(env.AI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const model = String(env.AI_MODEL || 'gpt-4o-mini').trim();
  const transcriptionModel = String(env.AI_TRANSCRIPTION_MODEL === undefined ? 'whisper-1' : env.AI_TRANSCRIPTION_MODEL).trim();
  const apiKey = String(env.AI_API_KEY || '').trim();
  let parsedBaseUrl = null;
  let providerConfigValid = false;

  try {
    parsedBaseUrl = new URL(baseUrl);
    const safeProtocol = parsedBaseUrl.protocol === 'https:' || (parsedBaseUrl.protocol === 'http:' && isLoopbackHost(parsedBaseUrl.hostname));
    providerConfigValid = safeProtocol && !parsedBaseUrl.username && !parsedBaseUrl.password && !parsedBaseUrl.search && !parsedBaseUrl.hash;
  } catch (error) {
    providerConfigValid = false;
  }

  const isLocalProvider = Boolean(parsedBaseUrl && isLoopbackHost(parsedBaseUrl.hostname));
  const configured = providerConfigValid && Boolean(model) && (Boolean(apiKey) || isLocalProvider);
  return {
    baseUrl,
    model,
    transcriptionModel,
    apiKey,
    configured,
    providerConfigValid,
    isLocalProvider
  };
}

function jsonResponse(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function getRequestPath(req) {
  try {
    return new URL(req.url, 'http://localhost').pathname;
  } catch (error) {
    return '';
  }
}

async function readBody(req, maxBytes) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'The request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function providerUrl(config, endpoint) {
  return `${config.baseUrl}/${endpoint}`;
}

function providerHeaders(config, extra = {}) {
  const headers = { ...extra };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

async function fetchProvider(config, endpoint, options) {
  let response;
  try {
    response = await fetch(providerUrl(config, endpoint), {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new HttpError(504, 'AI_TIMEOUT', 'The AI provider took too long to respond. Please try again.');
    }
    throw new HttpError(502, 'AI_UNAVAILABLE', 'Could not reach the configured AI provider. Check the server connection and AI_BASE_URL.');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, 'AI_AUTH_ERROR', 'The AI provider rejected its server-side credentials. Check AI_API_KEY.');
    }
    if (response.status === 429) {
      throw new HttpError(429, 'AI_RATE_LIMITED', 'The AI provider is rate-limiting requests. Wait a moment and try again.');
    }
    if (response.status === 404 && endpoint === 'audio/transcriptions') {
      throw new HttpError(502, 'TRANSCRIPTION_UNAVAILABLE', 'This AI provider does not offer the configured audio transcription endpoint. Use browser speech recognition or type your message.');
    }
    throw new HttpError(502, 'AI_PROVIDER_ERROR', `The AI provider returned an error (HTTP ${response.status}). Check its URL, model, and account configuration.`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new HttpError(502, 'AI_INVALID_RESPONSE', 'The AI provider returned an unreadable response.');
  }
}

function normalizeProviderContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')).join('').trim();
  }
  return '';
}

function parseChatMessages(payload) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > 20) {
    throw new HttpError(400, 'INVALID_MESSAGES', 'Send between 1 and 20 recent chat messages.');
  }
  const messages = payload.messages.map((message) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new HttpError(400, 'INVALID_MESSAGES', 'Each chat message must have a user or assistant role and text content.');
    }
    const content = message.content.trim();
    const maxLength = message.role === 'user' ? 4000 : 10_000;
    if (!content || content.length > maxLength) {
      throw new HttpError(400, 'INVALID_MESSAGES', `Each ${message.role} message must contain 1 to ${maxLength.toLocaleString('en-US')} characters.`);
    }
    return { role: message.role, content };
  });
  if (messages[messages.length - 1].role !== 'user') {
    throw new HttpError(400, 'INVALID_MESSAGES', 'The latest chat message must be from the user.');
  }
  return messages;
}

function audioFilename(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const extensions = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aac': 'aac',
    'audio/flac': 'flac'
  };
  return { mime, filename: `recording.${extensions[mime] || 'webm'}` };
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
}

function createRateLimiter({ limit = 30, windowMs = 10 * 60 * 1000 } = {}) {
  const clients = new Map();
  return function allow(req) {
    const now = Date.now();
    const key = req.socket.remoteAddress || 'unknown';
    let record = clients.get(key);
    if (!record || record.expiresAt <= now) {
      record = { count: 0, expiresAt: now + windowMs };
      clients.set(key, record);
    }
    record.count += 1;
    if (clients.size > 1000) {
      for (const [client, entry] of clients) {
        if (entry.expiresAt <= now) clients.delete(client);
      }
    }
    return record.count <= limit;
  };
}

function createAppServer({ env = process.env } = {}) {
  const config = getConfig(env);
  const allowAiRequest = createRateLimiter();
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
    '/sw.js': ['sw.js', 'text/javascript; charset=utf-8']
  };

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    const pathname = getRequestPath(req);

    try {
      if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        return jsonResponse(res, 200, {
          configured: config.configured,
          transcriptionConfigured: config.configured && Boolean(config.transcriptionModel),
          model: config.model
        });
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        if (!allowAiRequest(req)) {
          return jsonResponse(res, 429, { error: { code: 'APP_RATE_LIMITED', message: 'Too many requests from this connection. Please wait a few minutes and try again.' } });
        }
        if (!config.configured) {
          return jsonResponse(res, 503, { error: { code: 'AI_NOT_CONFIGURED', message: 'AI is not configured yet. Copy .env.example to .env, add an AI_API_KEY and model, then restart the server. For a local provider, set AI_BASE_URL to its local OpenAI-compatible endpoint.' } });
        }
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
          return jsonResponse(res, 415, { error: { code: 'UNSUPPORTED_CONTENT_TYPE', message: 'Chat requests must use application/json.' } });
        }
        const body = await readBody(req, JSON_LIMIT_BYTES);
        let payload;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch (error) {
          throw new HttpError(400, 'INVALID_JSON', 'The chat request was not valid JSON.');
        }
        const messages = parseChatMessages(payload);
        const result = await fetchProvider(config, 'chat/completions', {
          method: 'POST',
          headers: providerHeaders(config, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.slice(-18)],
            temperature: 0.7,
            max_tokens: 1200
          })
        });
        const reply = normalizeProviderContent(result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content);
        if (!reply) throw new HttpError(502, 'AI_EMPTY_RESPONSE', 'The AI provider returned an empty reply. Please try again.');
        return jsonResponse(res, 200, { reply });
      }

      if (pathname === '/api/transcribe' && req.method === 'POST') {
        if (!allowAiRequest(req)) {
          return jsonResponse(res, 429, { error: { code: 'APP_RATE_LIMITED', message: 'Too many requests from this connection. Please wait a few minutes and try again.' } });
        }
        if (!config.configured) {
          return jsonResponse(res, 503, { error: { code: 'AI_NOT_CONFIGURED', message: 'AI speech transcription needs a configured server-side AI provider. Set AI_API_KEY and AI_TRANSCRIPTION_MODEL in .env, then restart the server.' } });
        }
        if (!config.transcriptionModel) {
          return jsonResponse(res, 503, { error: { code: 'TRANSCRIPTION_NOT_CONFIGURED', message: 'Set AI_TRANSCRIPTION_MODEL in .env to enable server-side speech transcription.' } });
        }
        const { mime, filename } = audioFilename(req.headers['content-type']);
        if (!mime.startsWith('audio/')) {
          return jsonResponse(res, 415, { error: { code: 'UNSUPPORTED_AUDIO_TYPE', message: 'Send an audio recording in a supported audio format.' } });
        }
        const audio = await readBody(req, AUDIO_LIMIT_BYTES);
        if (!audio.length) throw new HttpError(400, 'EMPTY_AUDIO', 'The audio recording was empty. Please try again.');

        const form = new FormData();
        form.append('file', new Blob([audio], { type: mime }), filename);
        form.append('model', config.transcriptionModel);
        const result = await fetchProvider(config, 'audio/transcriptions', {
          method: 'POST',
          headers: providerHeaders(config),
          body: form
        });
        const transcript = typeof result.text === 'string' ? result.text.trim() : '';
        if (!transcript) throw new HttpError(502, 'EMPTY_TRANSCRIPTION', 'No speech was recognized. Please try again or type your message.');
        return jsonResponse(res, 200, { text: transcript });
      }

      if (pathname.startsWith('/api/')) {
        return jsonResponse(res, 404, { error: { code: 'NOT_FOUND', message: 'API route not found.' } });
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && files[pathname]) {
        const [relativePath, contentType] = files[pathname];
        const filePath = path.join(ROOT, relativePath);
        const content = await fs.promises.readFile(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length,
          'Cache-Control': pathname === '/sw.js' ? 'no-cache' : 'no-cache'
        });
        return req.method === 'HEAD' ? res.end() : res.end(content);
      }

      if (pathname === '/favicon.ico' && req.method === 'GET') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Not found');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof HttpError ? error.message : 'The server could not complete this request.';
      if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
      return jsonResponse(res, status, { error: { code, message } });
    }
  });

  return server;
}

if (require.main === module) {
  loadDotEnv();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT must be a valid TCP port number.');
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.listen(port, '0.0.0.0', () => {
      const address = server.address();
      console.log(`Jenni is listening on http://0.0.0.0:${address.port}`);
      const config = getConfig();
      console.log(config.configured ? `AI provider configured for model ${config.model}.` : 'AI provider not configured. Add server-side settings to .env.');
    });
  }
}

module.exports = {
  AUDIO_LIMIT_BYTES,
  JSON_LIMIT_BYTES,
  SYSTEM_PROMPT,
  createAppServer,
  getConfig,
  isLoopbackHost,
  loadDotEnv,
  normalizeProviderContent,
  parseChatMessages,
  parseDotEnv
};
