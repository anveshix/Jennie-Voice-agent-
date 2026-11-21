/* ============================================================================
   Provider presets — shared by the browser (API Room form) and the server.
   Pure data + pure functions so Node and the browser can both load it.
   Model ids drift; each preset is only a starting point for the form.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_PROVIDERS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRESETS = {
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      transcriptionModel: 'whisper-1',
      keyUrl: 'https://platform.openai.com/api-keys',
      note: 'Chat + voice transcription. Billing is per token; set a spend limit.'
    },
    groq: {
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      transcriptionModel: 'whisper-large-v3-turbo',
      keyUrl: 'https://console.groq.com/keys',
      note: 'Very fast, generous free tier. Chat + Whisper transcription.'
    },
    gemini: {
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.5-flash',
      transcriptionModel: '',
      keyUrl: 'https://aistudio.google.com/app/apikey',
      note: 'Free tier available. Open-key mode: transcriptions are off, browser speech still works.'
    },
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-oss-120b:free',
      transcriptionModel: '',
      keyUrl: 'https://openrouter.ai/keys',
      note: 'One key, many models. Check the model slug on openrouter.ai/models.'
    },
    ollama: {
      label: 'Ollama (this computer)',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      transcriptionModel: '',
      keyUrl: 'https://ollama.com/download',
      note: 'No API key and no bill. Slow on small laptops; needs Ollama running.'
    },
    custom: {
      label: 'Custom / other',
      baseUrl: '',
      model: '',
      transcriptionModel: '',
      keyUrl: '',
      note: 'Any OpenAI-compatible endpoint. Remote URLs must be HTTPS.'
    }
  };

  /** Strip trailing slashes and re-parse; returns null when not a usable URL. */
  function normalizeBaseUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      if (url.username || url.password || url.search || url.hash) return null;
      return raw;
    } catch (error) {
      return null;
    }
  }

  /** Mirrors the server rule: HTTPS anywhere, HTTP only for loopback. */
  function isLoopback(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || host === '::' || /^127(?:\.\d{1,3}){3}$/.test(host);
  }

  function validateSettings(input, options = {}) {
    const errors = [];
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const model = String(input.model || '').trim();
    const transcriptionModel = String(input.transcriptionModel || '').trim();
    const apiKey = String(input.apiKey || '').trim();
    const keepKey = Boolean(options.keepKey);

    if (!baseUrl) errors.push('Base URL must be a plain http(s) address without a query string.');
    let local = false;
    if (baseUrl) {
      const url = new URL(baseUrl);
      local = isLoopback(url.hostname);
      if (url.protocol === 'http:' && !local) {
        errors.push('Remote providers must use HTTPS. Plain HTTP is only allowed for localhost / 127.0.0.1.');
      }
    }
    if (!model) errors.push('Model name is required.');
    if (model.length > 120) errors.push('Model name looks too long.');
    if (transcriptionModel.length > 120) errors.push('Transcription model name looks too long.');
    if (apiKey && apiKey.length < 8) errors.push('That API key looks too short.');
    if (apiKey && /\s/.test(apiKey)) errors.push('API keys do not contain spaces.');
    if (!apiKey && !keepKey && !local) errors.push('An API key is required for a hosted provider.');

    return {
      valid: errors.length === 0,
      errors,
      value: {
        baseUrl: baseUrl || '',
        model,
        transcriptionModel,
        apiKey: apiKey || (keepKey ? undefined : ''),
        isLocal: local
      }
    };
  }

  /** Safe summary for the UI: never includes the key itself. */
  function describe(config) {
    if (!config) return { configured: false };
    return {
      configured: Boolean(config.configured),
      model: config.model || '',
      transcriptionModel: config.transcriptionModel || '',
      transcriptionConfigured: Boolean(config.configured && config.transcriptionModel),
      baseUrl: config.baseUrl || '',
      provider: config.provider || 'custom',
      isLocal: Boolean(config.isLocalProvider),
      keySet: Boolean(config.apiKey),
      source: config.source || 'env'
    };
  }

  return { PRESETS, normalizeBaseUrl, isLoopback, validateSettings, describe };
});
