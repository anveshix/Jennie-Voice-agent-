#!/usr/bin/env node
/**
 * Browser-level tests for the serverless phone app (docs/).
 *
 * No real browser is needed: jsdom plus fakes for SpeechRecognition, the
 * speech synthesiser and fetch are enough to exercise the behaviour that
 * matters — the voice loop, Drive links, drafts, and the key handling.
 *
 *   cd /tmp && npm install jsdom
 *   node tools/phone-app.test.js
 *
 * Exit code 0 means every check passed.
 */
const path = require('path');
const fs = require('fs');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  try {
    ({ JSDOM } = require('/tmp/node_modules/jsdom'));
  } catch (inner) {
    console.error('jsdom is required: cd /tmp && npm install jsdom');
    process.exit(2);
  }
}

const ROOT = path.join(__dirname, '..', 'docs');
const CFG = {
  apiKey: 'gsk_' + 'a'.repeat(30),
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-120b',
  transcribe: 'whisper-large-v3-turbo',
  provider: 'groq'
};

let failures = 0;
let checks = 0;

function ok(condition, label, extra) {
  checks += 1;
  if (!condition) failures += 1;
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (extra ? ' — ' + extra : ''));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boot(options = {}) {
  const retired = options.retired || null;
  const script = options.script ? options.script.slice() : null;
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: 'https://anveshix.github.io/Jennie-Voice-agent-/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  window.HTMLElement.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.scrollTo = () => {};

  if (options.cfg !== null) {
    window.localStorage.setItem('jenni_cfg_v1', JSON.stringify(options.cfg || CFG));
  }
  if (options.seedScreen) {
    window.localStorage.setItem('jenni_screen', options.seedScreen);
  }
  if (options.seed) {
    Object.entries(options.seed).forEach(([key, value]) => window.localStorage.setItem(key, value));
  }
  if (options.drive) {
    window.localStorage.setItem('jenni_drive_v1', JSON.stringify(options.drive));
  }
  if (options.driveToken) {
    window.localStorage.setItem('jenni_drive_tok_v1', JSON.stringify(options.driveToken));
  }

  /* fake SpeechRecognition */
  const rec = { starts: 0, aborts: 0, last: null };
  class FakeRecognition {
    constructor() { this.lang = ''; rec.last = this; }
    start() { rec.starts += 1; setTimeout(() => this.onstart && this.onstart(), 0); }
    abort() { rec.aborts += 1; if (this.onend) this.onend(); }
    stop() { this.abort(); }
    say(text) {
      const result = [{ transcript: text }];
      result.isFinal = true;
      this.onresult && this.onresult({ resultIndex: 0, results: [result] });
      this.onend && this.onend();
    }
  }
  window.SpeechRecognition = FakeRecognition;

  /* fake speech synthesis */
  const tts = { spoken: [], cancelled: 0 };
  window.speechSynthesis = {
    getVoices: () => [{ name: 'Hindi Voice', lang: 'hi-IN' }, { name: 'English Voice', lang: 'en-IN' }],
    cancel: () => { tts.cancelled += 1; },
    speak: (utterance) => {
      tts.spoken.push({ text: utterance.text, lang: utterance.lang });
      setTimeout(() => utterance.onend && utterance.onend(), 5);
    },
    onvoiceschanged: null
  };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ''; this.rate = 1; };

  /* fake fetch */
  const calls = [];
  window.fetch = async (url, fetchOptions = {}) => {
    calls.push({ url: String(url), options: fetchOptions });
    const target = String(url);
    if (target.includes('chat/completions')) {
      if (options.fail) return { ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) };
      let body = {};
      try { body = JSON.parse(fetchOptions.body || '{}'); } catch (error) { body = {}; }
      // a retired model answers 404, exactly like a real provider
      if (retired && body.model === retired) {
        return { ok: false, status: 404, json: async () => ({ error: { message: 'model_not_found' } }) };
      }
      // a scripted sequence lets a test reproduce timeouts / 500s / cut answers
      if (script && script.length) {
        const step = script.shift();
        if (step === 'timeout') {
          return new Promise((resolve, reject) => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            setTimeout(() => reject(err), 5);
          });
        }
        if (step && typeof step === 'object' && step.sse) {
          const enc = new TextEncoder();
          const chunks = step.sse.map((c) => enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n')).concat([enc.encode('data: [DONE]\n\n')]);
          let i = 0;
          return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel() {} }) } };
        }
        if (step === 'empty') return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) };
        if (step === 'truncated') return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Respected Sir, I am' }, finish_reason: 'length' }] }) };
        if (step === '500') return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
        if (typeof step === 'string') return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: step } }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Theek hai, **sun rahi** hoon.' } }] }) };
    }
    if (target.includes('api.github.com/repos/')) {
      if (target.endsWith('/readme')) {
        return { ok: true, status: 200, json: async () => ({ content: Buffer.from('# Demo repo\n\nA tiny helper library.').toString('base64'), encoding: 'base64' }) };
      }
      if (target.endsWith('/contents/')) {
        return { ok: true, status: 200, json: async () => ([{ type: 'file', name: 'index.js' }, { type: 'dir', name: 'src' }]) };
      }
      return {
        ok: true, status: 200, json: async () => ({
          full_name: 'octocat/demo-repo', description: 'A tiny helper library', stargazers_count: 1234,
          language: 'JavaScript', archived: false, pushed_at: '2026-11-01T10:00:00Z',
          license: { spdx_id: 'MIT' }, open_issues_count: 7, default_branch: 'main'
        })
      };
    }
    if (target.includes('upload/drive')) return { ok: true, status: 200, json: async () => ({ id: 'f1', name: 'Draft.md' }) };
    if (target.includes('drive/v3/files')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'a', name: 'Notes.md', modifiedTime: '2026-11-01T10:00:00Z', webViewLink: 'https://drive.google.com/x' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  /* jsdom ships no WebCrypto; use Node's so the vault code is really exercised */
  const nodeCrypto = require('crypto').webcrypto;
  Object.defineProperty(window, 'crypto', { value: nodeCrypto, configurable: true });
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;

  window.eval(fs.readFileSync(path.join(ROOT, 'security.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'docs.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'github.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'brain.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'remind-store.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'connectors.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'office.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'evals.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'proactive.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'google.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'tools.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'verify.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'budget.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'memory.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
  await wait(180);

  return { dom, window, rec, tts, calls, $: (id) => window.document.getElementById(id) };
}

function submit(window, text) {
  const $ = (id) => window.document.getElementById(id);
  $('input').value = text;
  $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

(async () => {
  /* ── gate and key handling ─────────────────────────────────────────────── */
  let b = await boot({ cfg: null });
  ok(b.$('gate').hidden === false, 'first run shows the setup gate');
  ok(b.$('app').hidden === true, 'app hidden without a key');
  ok(b.$('setupBase').value.includes('groq'), 'Groq preset pre-filled');
  b.$('setupKey').value = 'abc';
  b.$('btnSaveKey').click();
  await wait(60);
  ok(b.$('gateResult').textContent.length > 0, 'short key rejected');
  b.$('setupKey').value = CFG.apiKey;
  b.$('btnSaveKey').click();
  await wait(90);
  ok(b.$('app').hidden === false, 'app opens after saving a key');
  const saved = JSON.parse(b.window.localStorage.getItem('jenni_cfg_v1'));
  ok(saved.apiKey === CFG.apiKey, 'key stored on the device only');
  b.dom.window.close();

  /* ── mobile shell ──────────────────────────────────────────────────────── */
  b = await boot();
  const navItems = [...b.window.document.querySelectorAll('.tab')];
  ok(navItems.length === 6, 'bottom navigation has six items', navItems.map((t) => t.textContent.trim()).join('/'));
  ok(navItems.every((t) => t.querySelector('svg')), 'every nav item has an icon');
  ok(b.$('appbarTitle') !== null && b.$('brandMeta') !== null, 'app bar shows title and provider');
  ok(b.$('btnDriveQuick') !== null, 'app bar has a Drive shortcut');
  ok(b.$('driveBadge').hidden === false, 'Drive badge visible while unconnected');

  /* nav: chat / voice / drafts / drive / setup */
  navItems.find((t) => t.dataset.tab === 'drafts').click();
  await wait(60);
  ok(b.$('sheet-drafts').hidden === false, 'Drafts opens from the nav');
  navItems.find((t) => t.dataset.tab === 'chat').click();
  await wait(60);
  ok(b.$('sheet-drafts').hidden === true, 'Chat closes sheets');

  /* ── drive link behaviour ──────────────────────────────────────────────── */
  navItems.find((t) => t.dataset.tab === 'drive').click();
  await wait(80);
  ok(b.$('sheet-drive').hidden === false, 'Drive sheet opens');
  ok(b.$('driveConnectLink').dataset.action === 'setup', 'without a client id the link goes to setup');
  ok(b.$('driveConnectLink').getAttribute('href').includes('console.cloud.google.com'), 'setup link points at Google Cloud');
  ok(b.$('driveSetupLink').getAttribute('href').includes('console.cloud.google.com'), 'inline setup link present');
  ok(b.$('originHint').textContent === 'https://anveshix.github.io', 'origin shown for the OAuth field', b.$('originHint').textContent);

  b.$('clientId').value = 'not-an-id';
  b.$('btnDriveSave').click();
  await wait(50);
  ok(b.$('driveResult').textContent.includes('.apps.googleusercontent.com'), 'bad client id rejected');

  b.$('clientId').value = '123-abc.apps.googleusercontent.com';
  b.$('btnDriveSave').click();
  await wait(80);
  ok(JSON.parse(b.window.localStorage.getItem('jenni_drive_v1') || '{}').clientId === '123-abc.apps.googleusercontent.com', 'client id saved');
  ok(b.$('driveConnectLink').dataset.action === 'connect', 'with a client id the link becomes a connect action');
  ok(b.$('driveConnectLink').getAttribute('href') === '#connect', 'connect link is an in-page action');
  b.dom.window.close();

  /* connected state shows a real Drive link */
  b = await boot({ drive: { clientId: '123-abc.apps.googleusercontent.com' }, driveToken: { token: 'tok', expires: Date.now() + 3600000 } });
  b.$('btnDriveQuick').click();
  await wait(80);
  ok(b.$('driveConnectLink').dataset.action === 'open', 'connected link opens Drive');
  ok(b.$('driveConnectLink').getAttribute('href').includes('drive.google.com'), 'connected href points at Drive');
  ok(b.$('driveStatusText').textContent === 'Connected', 'status says Connected');
  ok(b.$('driveBadge').hidden === true, 'badge hides when Drive is connected');
  ok(b.$('btnDriveRefresh') !== null && b.$('btnDrivePaste') !== null, 'refresh and paste controls exist');
  b.dom.window.close();

  /* ── chat + drafts (unchanged behaviour) ───────────────────────────────── */
  b = await boot();
  submit(b.window, 'Namaste');
  await wait(260);
  const chatCall = b.calls.find((c) => c.url.includes('chat/completions'));
  ok(Boolean(chatCall), 'chat reaches the provider');
  ok(chatCall.options.headers.Authorization === 'Bearer ' + CFG.apiKey, 'key sent as a Bearer header');
  const bubble = b.window.document.querySelector('.msg--jenni .bubble');
  ok(bubble.innerHTML.includes('<b>sun rahi</b>'), 'markdown rendered safely');
  b.window.document.querySelector('.msg--jenni .msg__tool').click();
  await wait(80);
  ok(JSON.parse(b.window.localStorage.getItem('jenni_drafts_v1') || '[]').length === 1, 'draft saved');
  ok(b.$('draftCount').hidden === false, 'nav shows a draft badge', b.$('draftCount').textContent);
  b.dom.window.close();

  /* ── voice loop (unchanged behaviour) ──────────────────────────────────── */
  b = await boot();
  b.$('btnVoice').click();
  await wait(90);
  ok(b.rec.starts === 1, 'voice mode opens the mic');
  ok(b.$('app').classList.contains('is-voice'), 'app enters voice mode');
  ok(b.window.document.querySelector('.tab[data-tab="voice"]').classList.contains('is-on'), 'Voice tab highlighted during voice mode');
  b.rec.last.say('Namaste Jenni');
  await wait(1400);
  ok(b.tts.spoken.length === 1, 'answer spoken aloud');
  ok(b.tts.spoken[0].text.indexOf('*') === -1, 'markdown stripped before speaking');
  ok(b.rec.starts >= 2, 'mic reopened automatically');
  b.rec.last.say('ruko');
  await wait(700);
  ok(!b.$('app').classList.contains('is-voice'), 'stop word ends voice mode');
  b.dom.window.close();

  /* ── deep links + screen memory (recursive navigation) ─────────────────── */
  b = await boot();
  b.window.location.hash = '#drive';
  b.window.dispatchEvent(new b.window.Event('hashchange'));
  await wait(120);
  ok(b.$('sheet-drive').hidden === false, 'link #drive opens the Drive sheet directly');
  ok(b.window.localStorage.getItem('jenni_screen') === 'drive', 'screen remembered for the next visit');
  b.window.location.hash = '';
  b.window.dispatchEvent(new b.window.Event('hashchange'));
  await wait(120);
  ok(b.$('sheet-drive').hidden === true, 'clearing the hash returns to chat');
  b.dom.window.close();

  /* a link that needs a key lands on setup once the gate is passed */
  b = await boot({ cfg: null });
  b.window.location.hash = '#drive';
  b.window.dispatchEvent(new b.window.Event('hashchange'));
  await wait(200);
  ok(b.$('gate').hidden === false, 'without a key a deep link still shows the gate');

  /* a returning user comes back to the screen they left */
  b.window.localStorage.setItem('jenni_screen', 'drafts');
  const stored = b.window.localStorage.getItem('jenni_screen');
  b.dom.window.close();
  b = await boot({ seedScreen: stored });
  await wait(320);
  ok(b.$('sheet-drafts').hidden === false, 'returning visit restores the last screen', b.$('sheet-drafts').hidden);
  b.dom.window.close();

  /* ── floating bot: drag, tap, snap, hide ───────────────────────────────── */
  b = await boot();
  const botEl = b.$('bot');
  ok(botEl !== null, 'floating bot is on the page');
  ok(botEl.dataset.side === 'right', 'bot starts on the right edge');
  ok(botEl.querySelector('.bot__face') !== null, 'bot has a face');
  ok(b.$('botToggle').checked === true, 'settings toggle reflects the bot being visible');

  /* a real drag: move far enough, then release on the left */
  const pointer = (type, x, y) => {
    const event = new b.window.Event(type, { bubbles: true, cancelable: true });
    event.clientX = x; event.clientY = y; event.pointerId = 1; event.button = 0;
    return event;
  };
  b.window.innerWidth = 400;
  b.window.innerHeight = 800;

  botEl.dispatchEvent(pointer('pointerdown', 340, 500));
  b.window.dispatchEvent(pointer('pointermove', 330, 495));
  ok(botEl.dataset.side === 'right', 'a 10px wobble does not count as a drag yet');
  b.window.dispatchEvent(pointer('pointermove', 60, 300));
  ok(botEl.classList.contains('is-dragging'), 'dragging starts past the threshold');
  ok(botEl.dataset.side === 'left', 'bot follows the pointer to the left half');
  ok(b.$('botBin').hidden === false, 'the hide target appears while dragging');
  b.window.dispatchEvent(pointer('pointerup', 60, 300));
  await wait(60);
  ok(botEl.dataset.side === 'left', 'dropped on the left it snaps to the left edge');
  ok(botEl.classList.contains('is-dragging') === false, 'drag state clears on release');
  ok(b.$('botBin').hidden === true, 'the hide target goes away');
  const savedBot = JSON.parse(b.window.localStorage.getItem('jenni_bot_v1') || '{}');
  ok(savedBot.side === 'left', 'position is remembered', JSON.stringify(savedBot));

  /* the drag must not also have fired a tap */
  ok(!botEl.classList.contains('is-listening'), 'finishing a drag does not start voice mode');

  /* a tap starts the voice loop */
  botEl.dispatchEvent(pointer('pointerdown', 40, 300));
  b.window.dispatchEvent(pointer('pointerup', 41, 301));
  await wait(120);
  ok(b.$('app').classList.contains('is-voice'), 'tapping the bot starts voice mode');
  ok(botEl.classList.contains('is-listening'), 'bot shows the listening state');
  ok(b.rec.starts === 1, 'the mic actually opened');

  /* dragging onto the bin hides it */
  botEl.dispatchEvent(pointer('pointerdown', 40, 300));
  b.window.dispatchEvent(pointer('pointermove', 45, 310));
  const binRect = { left: 180, right: 220, top: 280, bottom: 320 };
  b.$('botBin').getBoundingClientRect = () => binRect;
  b.window.dispatchEvent(pointer('pointermove', 200, 300));
  ok(b.$('botBin').classList.contains('is-hot'), 'bin highlights when the bot is over it');
  b.window.dispatchEvent(pointer('pointerup', 200, 300));
  await wait(80);
  ok(botEl.hidden === true, 'dropping on the bin hides the bot');
  ok(b.$('botRestore').hidden === false, 'a restore chip appears');
  ok(b.window.localStorage.getItem('jenni_bot_v1').includes('"hidden":true'), 'hidden state is remembered');

  /* restore + settings toggle */
  b.$('botShow').click();
  await wait(60);
  ok(botEl.hidden === false, 'restore brings it back');
  b.$('botToggle').checked = false;
  b.$('botToggle').dispatchEvent(new b.window.Event('change'));
  await wait(60);
  ok(botEl.hidden === true, 'the settings toggle can hide it too');
  b.$('botToggle').checked = true;
  b.$('botToggle').dispatchEvent(new b.window.Event('change'));
  await wait(60);
  ok(botEl.hidden === false, 'and bring it back');
  b.dom.window.close();

  /* the bot mirrors voice state from any screen */
  b = await boot();
  b.window.document.querySelector('.tab[data-tab="setup"]').click();
  await wait(80);
  b.$('btnVoiceStart').click();
  await wait(140);
  ok(b.$('bot').classList.contains('is-listening'), 'bot lights up while the mic is open on another screen');
  ok(b.$('sheet-setup').hidden === true, 'starting voice closes the sheet');
  b.dom.window.close();

  /* the bot knows which screen it is on */
  b = await boot();
  ok(b.$('bot').getAttribute('title').includes('Tap karke bolo'), 'bot hint on chat', b.$('bot').getAttribute('title'));
  b.window.document.querySelector('.tab[data-tab="drafts"]').click();
  await wait(80);
  ok(b.$('bot').getAttribute('title').includes('draft'), 'bot hint changes on the drafts screen', b.$('bot').getAttribute('title'));
  b.window.document.querySelector('.tab[data-tab="drive"]').click();
  await wait(80);
  ok(b.$('bot').getAttribute('title').includes('Connect') || b.$('bot').getAttribute('title').includes('bolo'), 'bot hint changes on the drive screen', b.$('bot').getAttribute('title'));
  b.dom.window.close();

  /* ── de-clutter guard: the old walls of text must not come back ────────── */
  const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const banned = [
    'Jenni ke jawab yahan save hote hain',
    'Name hai Jenni. Bolo ya likho',
    'bina haath lagaye baat chalti rahegi',
    'Kaha se jodna hai',
    'Yeh app aapke phone se seedha provider ko request bhejti hai',
    'Step-by-step guide',
    'Rukna ho to mic button'
  ];
  banned.forEach((line) => ok(!page.includes(line), `verbose copy removed — ${line.slice(0, 28)}…`));
  ok((page.match(/class="hint"/g) || []).length <= 3, 'at most three long hints remain',
    String((page.match(/class="hint"/g) || []).length));

  /* ── security: PIN, encrypted key, cooldown, wipe ──────────────────────── */
  b = await boot({ cfg: null, seed: {
    jenni_chat_v1: JSON.stringify([{ role: 'me', text: 'MARKER-PRIVATE-CHAT' }]),
    jenni_notes_v1: JSON.stringify([{ id: 'm1', text: 'MARKER-PRIVATE-MEM', cat: 'fact', ts: 1 }]),
    jenni_memory_v1: JSON.stringify([{ id: 'f1', kind: 'fact', text: 'MARKER-PRIVATE-FACT', hits: 1, confidence: 0.9, at: '2026-11-01' }, { id: 'old', text: 'MARKER-LEGACY-NOTE', cat: 'fact', ts: 1 }]),
    jenni_skills_v1: JSON.stringify([{ name: 'MARKER-PRIVATE-SKILL', triggers: ['zzz'], steps: ['a'] }]),
    jenni_drafts_v1: JSON.stringify([{ id: 'd1', title: 't', text: 'MARKER-PRIVATE-DRAFT', at: '' }])
  } });
  ok(b.$('gatePinWrap') !== null, 'gate offers an optional PIN');
  ok(b.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null, 'a CSP meta tag is injected at boot');
  const csp = b.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  ok(csp.includes("default-src 'self'"), 'CSP restricts sources to self', csp.slice(0, 40));
  ok(csp.includes("object-src 'none'"), 'CSP blocks plugins');

  /* set a PIN + key, then check nothing readable is stored */
  b.$('setupKey').value = CFG.apiKey;
  b.$('setupPin').value = '4821';
  b.$('setupPin2').value = '4821';
  b.$('btnSaveKey').click();
  await wait(700);
  ok(b.$('app').hidden === false, 'PIN + key saves and opens the app');
  ok(b.window.localStorage.getItem('jenni_vault_v1') !== null, 'the key is sealed in a vault');
  ok(b.window.localStorage.getItem('jenni_cfg_v1') === null, 'no plaintext config is left behind');
  const vaultRaw = b.window.localStorage.getItem('jenni_vault_v1');
  ok(!vaultRaw.includes(CFG.apiKey), 'the key is not readable in storage', vaultRaw.slice(0, 40));
  ok(!vaultRaw.includes('gsk'), 'no key prefix leaks into the vault blob');
  const lockRaw = JSON.parse(b.window.localStorage.getItem('jenni_lock_v1'));
  ok(lockRaw.enabled === true, 'lock state is on');
  ok(b.$('secPinState').textContent === 'On', 'security panel shows the PIN as on');
  ok(b.$('secKeyState').textContent === 'Encrypted', 'security panel shows the key encrypted');

  const LSx = b.window.localStorage;
  const allStored = Object.keys(LSx).map((k) => LSx.getItem(k)).join('|');
  ok(!allStored.includes('MARKER-PRIVATE'), 'no chat/memory/draft text is readable in storage after PIN');
  ok(['chat', 'notes', 'drafts', 'memory', 'skills'].every((n) => LSx.getItem('jenni_' + n + '_v1_enc') && LSx.getItem('jenni_' + n + '_v1') === null), 'chat, notes, drafts, agent facts and skills are stored only as encrypted blobs');
  ok(JSON.parse(LSx.getItem('jenni_chat_v1_enc')).data && JSON.parse(LSx.getItem('jenni_chat_v1_enc')).iv, 'blob is AES-GCM (iv + data)');

  /* locking hides the app and drops the key from memory */
  b.$('btnLockNow').click();
  await wait(80);
  ok(b.$('lockScreen').hidden === false, 'Lock now shows the lock screen');
  ok(b.$('app').hidden === true, 'the app is hidden while locked');
  ok(b.$('apiKey').value === '', 'the key field is cleared on lock');
  ok(!b.window.document.body.textContent.includes('MARKER-PRIVATE'), 'locked app holds no chat/memory/draft text in the DOM');

  /* wrong PIN is rejected and counted */
  b.$('lockPin').value = '0000';
  b.$('lockForm').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(600);
  ok(b.$('lockResult').textContent.includes('Galat'), 'a wrong PIN is rejected', b.$('lockResult').textContent);
  ok(b.$('app').hidden === true, 'still locked after a wrong PIN');
  ok(b.$('lockResult').textContent.includes('bache'), 'the remaining attempts are shown');

  /* right PIN unlocks and restores the key */
  b.$('lockPin').value = '4821';
  b.$('lockForm').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(900);
  ok(b.$('lockScreen').hidden === true, 'the right PIN unlocks');
  ok(b.$('app').hidden === false, 'the app comes back');
  ok(b.$('brandMeta').textContent.includes('Groq'), 'the provider is restored from the vault', b.$('brandMeta').textContent);
  ok(b.window.localStorage.getItem('jenni_cfg_v1') === null, 'unlocking does not write the key back in plaintext');
  ok(b.window.document.body.textContent.includes('MARKER-PRIVATE-CHAT'), 'chat history is decrypted after the right PIN');
  ok(b.window.document.body.textContent.includes('MARKER-PRIVATE-MEM'), 'notes are decrypted after the right PIN');
  ok(b.window.document.body.textContent.includes('MARKER-PRIVATE-FACT'), 'agent facts are decrypted after the right PIN');
  ok(JSON.parse(b.window.localStorage.getItem('jenni_notes_v1_enc')).data.length > 10, 'notes blob exists after unlock');

  /* the setup field shows a mask, never the real key */
  b.$('btnOpenSetup').click();
  await wait(250);
  const keyField = b.$('apiKey').value;
  ok(keyField.includes('\u2022'), 'the setup field masks the saved key', keyField);
  ok(!keyField.includes(CFG.apiKey.slice(-8)), 'the mask hides the key body');

  /* saving settings must not downgrade the vault to plaintext */
  b.$('btnSave').click();
  await wait(400);
  ok(b.window.localStorage.getItem('jenni_vault_v1') !== null, 'the vault survives a settings save');
  ok(b.window.localStorage.getItem('jenni_cfg_v1') === null, 'no plaintext config comes back');

  /* a reload starts locked, with no key in memory */
  const vaultAfter = b.window.localStorage.getItem('jenni_vault_v1');
  b.dom.window.close();
  b = await boot({ cfg: null, seed: { ['jenni_vault_v1']: vaultAfter, ['jenni_lock_v1']: JSON.stringify(lockRaw) } });
  await wait(200);
  ok(b.$('lockScreen').hidden === false, 'a reload with a vault starts locked');
  ok(b.$('app').hidden === true, 'the app is not shown before the PIN');
  b.dom.window.close();

  /* panic wipe removes everything jenni-owned */
  b = await boot();
  b.window.localStorage.setItem('jenni_drafts_v1', JSON.stringify([{ id: '1', title: 't', text: 'x', at: '' }]));
  b.window.confirm = () => true;
  try { b.$('btnPanic').click(); } catch (error) { /* jsdom navigation is not implemented */ }
  await wait(200);
  const leftovers = Object.keys(b.window.localStorage).filter((k) => k.startsWith('jenni_'));
  ok(leftovers.length === 0, 'panic wipe leaves no jenni keys', leftovers.join(',') || 'clean');
  b.dom.window.close();

  /* ── Gemini preset + migrating a previously-shipped default ───────────── */
  b = await boot({ cfg: null });
  b.window.document.querySelector('#gateBody [data-provider="gemini"]').click();
  await wait(60);
  ok(b.$('setupModel').value === 'gemini-3.5-flash', 'Gemini preset is gemini-3.5-flash', b.$('setupModel').value);
  ok(b.$('setupBase').value.includes('generativelanguage.googleapis.com'), 'Gemini base URL stays the OpenAI-compatible one');
  b.dom.window.close();

  /* the app used to ship gemini-3.8-flash as the default → it must move by
     itself, without the user doing anything */
  b = await boot({ cfg: Object.assign({}, CFG, { provider: 'gemini', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', transcribe: '' }) });
  const migratedCfg = JSON.parse(b.window.localStorage.getItem('jenni_cfg_v1'));
  ok(migratedCfg.model === 'gemini-3.5-flash', 'an old gemini-3.8-flash default migrates to 3.5', migratedCfg.model);
  ok(migratedCfg.apiKey === CFG.apiKey, 'the key survives the migration');
  b.dom.window.close();

  /* a model the user typed themselves must never be overwritten */
  b = await boot({ cfg: Object.assign({}, CFG, { provider: 'gemini', model: 'gemini-3.6-flash-pro-experimental', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', transcribe: '' }) });
  const keptCfg = JSON.parse(b.window.localStorage.getItem('jenni_cfg_v1'));
  ok(keptCfg.model === 'gemini-3.6-flash-pro-experimental', 'a hand-typed model is left alone', keptCfg.model);
  b.dom.window.close();

  /* ── a retired model id (the 404 people actually hit) ─────────────────── */
  ok(b.$('modelListLink').getAttribute('href').includes('groq.com'), 'setup offers a live Models list link');
  ok(b.$('setupModelListLink') !== null, 'the gate offers the same link');

  /* a model that is NOT one of our old defaults (so migration leaves it) but
     is retired upstream → one retry with the preset model, saved, and said out
     loud, instead of leaving the user stuck on an error */
  b = await boot({
    retired: 'llama-3.1-70b-versatile',
    cfg: Object.assign({}, CFG, { model: 'llama-3.1-70b-versatile' })
  });
  submit(b.window, 'namaste');
  await wait(700);
  const retried = b.calls.filter((c) => c.url.includes('chat/completions'));
  ok(retried.length === 2, 'a 404 triggers exactly one retry', String(retried.length));
  const secondModel = JSON.parse(retried[1].options.body).model;
  ok(secondModel === 'openai/gpt-oss-120b', 'the retry uses the current preset model', secondModel);
  ok(b.window.localStorage.getItem('jenni_cfg_v1').includes('gpt-oss-120b'), 'the working model is saved for next time');
  ok(b.window.document.body.textContent.toLowerCase().includes('purana model band'), 'the user is told what changed');
  const replies = [...b.window.document.querySelectorAll('.msg--jenni')];
  ok(replies.length > 0, 'the retry still produces a reply');
  b.dom.window.close();

  /* a custom provider has no preset to fall back to → the message must name
     the model and the fix, not just "HTTP 404" */
  b = await boot({
    retired: 'my-old-model',
    cfg: Object.assign({}, CFG, { provider: 'custom', model: 'my-old-model', baseUrl: 'https://api.example.com/v1' })
  });
  submit(b.window, 'namaste');
  await wait(700);
  const text = b.window.document.body.textContent;
  ok(text.includes('404'), 'a custom provider 404 is still explained');
  ok(text.includes('my-old-model'), 'the failing model is named', text.slice(-160));
  ok(text.toLowerCase().includes('band ho gaya'), 'the message points at retirement');
  b.dom.window.close();

  /* ── the failure that showed "Jawab nahi aaya" twice ────────────────────
     A timeout, an empty body, or a 500 must heal itself before the user sees
     an error — and if it still fails, they get a one-line message and a retry
     button instead of a wall of apology. */

  /* 1. a timeout on the first try recovers on its own */
  b = await boot({ script: ['timeout', 'Theek hai, aa gaya.'] });
  submit(b.window, 'namaste');
  await wait(1500);
  const timeoutReply = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].map((n) => n.textContent).join(' | ');
  ok(timeoutReply.includes('aa gaya'), 'a timeout is retried instead of failing', timeoutReply);
  ok(!timeoutReply.includes('Jawab nahi aaya'), 'no error bubble after a recovered timeout');
  b.dom.window.close();

  /* 2. an empty body (thinking ate the budget) is retried too */
  b = await boot({ script: ['empty', 'Lo, jawab.'] });
  submit(b.window, 'namaste');
  await wait(1500);
  const emptyReply = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].map((n) => n.textContent).join(' | ');
  ok(emptyReply.includes('Lo, jawab'), 'an empty reply is retried', emptyReply);
  b.dom.window.close();

  /* 3. three failures in a row → one line + a retry button that actually works */
  b = await boot({ script: ['500', '500', '500', 'Theek ho gaya.'] });
  submit(b.window, 'leave application doc file banao');
  await wait(4500);
  const failedBubble = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].map((n) => n.textContent).join(' | ');
  ok(failedBubble.includes('Jawab nahi aaya'), 'after retries the failure is stated once', failedBubble.slice(0, 80));
  ok(!/Maaf karo[\s\S]*Maaf karo/.test(failedBubble), 'the double-apology text is gone');
  const retryBtn = [...b.window.document.querySelectorAll('.msg__tool--retry')][0];
  ok(Boolean(retryBtn), 'a retry button appears on a failed reply');
  retryBtn.click();
  await wait(900);
  const afterRetry = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].map((n) => n.textContent).join(' | ');
  ok(afterRetry.includes('Theek ho gaya'), 'the retry button sends the same question again', afterRetry.slice(0, 60));
  b.dom.window.close();

  /* 4. a cut-off answer is continued, not thrown away */
  b = await boot({ script: ['truncated', ', a student of class 9, request leave.'] });
  submit(b.window, 'application likho');
  await wait(1500);
  const stitched = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].map((n) => n.textContent).join(' ');
  ok(stitched.includes('Respected Sir') && stitched.includes('class 9'), 'a truncated reply is continued and stitched', stitched.slice(0, 90));
  b.dom.window.close();

  /* ── Gemini 3 thinks by default; the request must say otherwise ───────── */
  b = await boot({ cfg: Object.assign({}, CFG, { provider: 'gemini', model: 'gemini-3.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', transcribe: '' }) });
  submit(b.window, 'namaste');
  await wait(600);
  const gemBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  ok(gemBody.reasoning_effort === 'minimal', 'Gemini is asked for the cheapest thinking level', String(gemBody.reasoning_effort));
  ok(Number(gemBody.max_tokens) >= 1200, 'the token budget leaves room for thinking', String(gemBody.max_tokens));
  b.dom.window.close();

  /* a non-Gemini provider must not receive Gemini-only fields */
  b = await boot({});
  submit(b.window, 'namaste');
  await wait(600);
  const groqBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  ok(groqBody.reasoning_effort === undefined, 'Groq request keeps no thinking field');
  b.dom.window.close();

  /* ── document requests produce a real .docx download ──────────────────── */
  b = await boot({ script: ['# Subject: Leave application\n\nRespected Sir / Madam,\n\nI request leave on Monday, 23/11/2026 for personal reasons.\n\nYours obediently,\n[Your Name]'] });
  submit(b.window, 'monday 23/11/2026 ki leave application doc file banao');
  await wait(900);
  const docBtn = [...b.window.document.querySelectorAll('.msg__tool--doc')][0];
  ok(Boolean(docBtn), 'a document request offers a .docx download', docBtn && docBtn.textContent);
  ok(b.window.document.body.textContent.includes('File ready'), 'the user is told the file is ready');

  let downloaded = null;
  b.window.URL.createObjectURL = (blob) => { downloaded = blob; return 'blob:test'; };
  b.window.URL.revokeObjectURL = () => {};
  b.window.HTMLAnchorElement.prototype.click = function () {};
  docBtn.click();
  await wait(100);
  ok(downloaded && downloaded.type.includes('wordprocessingml'), 'clicking builds a Word blob', downloaded && downloaded.type);
  const bytes = new Uint8Array(await downloaded.arrayBuffer());
  ok(bytes[0] === 0x50 && bytes[1] === 0x4b, 'the file is a real zip/OOXML package', bytes.slice(0, 2).join(','));
  const zipText = Buffer.from(bytes).toString('latin1');
  ok(zipText.includes('word/document.xml'), 'the package contains word/document.xml');
  ok(zipText.includes('23/11/2026'), 'the leave date survives into the document');
  b.dom.window.close();

  /* a plain chat message must NOT create a file */
  b = await boot({ script: ['Haan, bolo.'] });
  submit(b.window, 'kaise ho yaar');
  await wait(700);
  ok(b.window.document.querySelectorAll('.msg__tool--doc').length === 0, 'ordinary chat gets no download button');
  b.dom.window.close();

  /* ── the model must never say "main file nahi bana sakti" ──────────────── */
  b = await boot({ script: ['# Subject: Leave application\n\nRespected Sir / Madam,\n\nI request leave on Monday, 23/11/2026 for personal reasons.\n\nYours obediently,\n[Your Name]'] });
  submit(b.window, 'leave application likho');
  await wait(900);
  const promptText = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body).messages[0].content;
  ok(/app tumhare jawab se apne aap/i.test(promptText), 'the prompt says the app builds the file');
  ok(/Main file nahi bana sakti/.test(promptText), 'the prompt bans the "I cannot make a file" reply');
  ok(/clone\/install karne ko mat bolo/i.test(promptText), 'the prompt stops telling a phone user to clone repos');
  b.dom.window.close();

  /* a formal letter gets a download button even without a trigger word */
  b = await boot({ script: ['Respected Sir / Madam,\n\nI am a student of class 9 and I request leave on Monday for personal reasons. I will complete all pending work after returning.\n\nThanking you.\n\nYours obediently,\n[Your Name]'] });
  submit(b.window, 'principal ko chhutti ki baat likh do');
  await wait(900);
  ok(Boolean(b.window.document.querySelector('.msg__tool--doc')), 'a formal letter is detected without a trigger word');
  b.dom.window.close();

  /* the requested format is respected: csv / txt / md / json */
  for (const [word, ext] of [['csv file banao', 'csv'], ['txt file chahiye', 'txt'], ['markdown md file banao', 'md'], ['json file banao', 'json']]) {
    b = await boot({ script: ['name,score\nAarav,91\nMeera,88'] });
    submit(b.window, word);
    await wait(800);
    const btn = b.window.document.querySelector('.msg__tool--doc');
    ok(btn && btn.textContent.includes('.' + ext), `${word} → .${ext} download`, btn && btn.textContent);
    b.dom.window.close();
  }

  /* ── public GitHub repos can be read from the phone ───────────────────── */
  b = await boot({ script: ['Is repo me index.js aur src/ hai, aur README ek tiny helper library batata hai.'] });
  submit(b.window, 'https://github.com/octocat/demo-repo ka code dekho');
  // the repo toast lands ~0.3 s after send; the "PIN lock lagao" nudge replaces
  // it at 1.6 s, so sample the toast before that
  await wait(900);
  const repoToast = b.window.document.getElementById('toastHost').textContent;
  await wait(900);
  const repoCalls = b.calls.filter((c) => c.url.includes('api.github.com'));
  ok(repoCalls.some((c) => c.url.includes('/repos/octocat/demo-repo')), 'the repo is fetched from api.github.com', String(repoCalls.length));
  const repoPrompt = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body).messages.slice(-1)[0].content;
  ok(repoPrompt.includes('octocat/demo-repo'), 'the prompt carries the repo name');
  ok(repoPrompt.includes('1234'), 'stars reach the model');
  ok(repoPrompt.includes('index.js'), 'top-level files reach the model');
  ok(repoPrompt.includes('tiny helper library'), 'the README reaches the model');
  ok(repoToast.includes('padh liya'), 'the user is told the repo was read', repoToast.slice(0, 60));
  b.dom.window.close();

  /* a plain question about GitHub must not hit the API */
  b = await boot({ script: ['GitHub ek code hosting site hai.'] });
  submit(b.window, 'github kya hota hai');
  await wait(700);
  ok(b.calls.filter((c) => c.url.includes('api.github.com')).length === 0, 'a general question does not fetch a repo');
  b.dom.window.close();

  /* ── Jenni's character reaches the model, on every single request ──────── */
  b = await boot({});
  submit(b.window, 'yaar bore ho rahi hoon');
  await wait(700);
  const personaCall = b.calls.filter((c) => c.url.includes('chat/completions')).pop();
  const personaBody = JSON.parse(personaCall.options.body);
  const sys = personaBody.messages[0];
  ok(sys.role === 'system', 'the first message is a system prompt');
  const persona = sys.content;
  ok(/21/.test(persona), 'the prompt gives her age (21)', persona.slice(0, 60));
  ok(/hasmukh|humour|mazak/i.test(persona), 'the prompt asks for a sense of humour');
  ok(/common sense|pata nahi/i.test(persona), 'the prompt asks for common sense and honest unknowns');
  ok(/tum|yaar/i.test(persona), 'the prompt sets a casual tone, not "sir ji"');
  ok(/emoji/i.test(persona) && /bullet/i.test(persona), 'the prompt bans emoji and bullets for voice replies');
  ok(!/helpful conversational ai assistant|helpful assistant\./i.test(persona), 'the old generic assistant line is gone');
  ok(/haan|chal|done/i.test(persona), 'quick acknowledgements like "haan / chal / done" are requested');
  ok(/never ask for or repeat api keys/i.test(persona), 'the key-safety line survives the new persona');

  /* the sampling params support that personality and keep replies short */
  ok(personaBody.temperature >= 0.7, 'temperature is warm enough for personality', String(personaBody.temperature));
  ok(Number(personaBody.max_tokens) > 0 && Number(personaBody.max_tokens) <= 600, 'replies are length-capped', String(personaBody.max_tokens));

  /* a stale error bubble must not be fed back as "assistant" context */
  b.window.localStorage.setItem('jenni_chat_v1', JSON.stringify([
    { role: 'me', text: 'hello', at: new Date().toISOString() },
    { role: 'jenni', text: 'Maaf karo, jawab nahi mila. Key galat hai', at: new Date().toISOString() }
  ]));
  submit(b.window, 'phir se try karo');
  await wait(700);
  const replayBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  const asAssistant = replayBody.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  ok(!asAssistant.some((t) => t.startsWith('Maaf karo')), 'error bubbles are not replayed to the model', asAssistant.join(' | '));
  b.dom.window.close();

  /* voice mode caps the reply tighter than typed chat, so speech starts sooner */
  b = await boot({});
  b.$('btnVoice').click();
  await wait(120);
  b.rec.last.say('kya haal hai');
  await wait(800);
  const voiceBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  ok(Number(voiceBody.max_tokens) <= 300, 'voice replies are capped for speed', String(voiceBody.max_tokens));
  b.$('btnVoice').click();
  await wait(150);
  b.dom.window.close();

  /* ── agent core: memory, skills, self-check ───────────────────────────── */

  /* the pure core, tested without a browser */
  const A = require(path.join(ROOT, 'agent.js'));

  /* 1. a fact said once is remembered, survives a reload, and reaches the prompt */
  b = await boot({ script: ['Yaad rakh liya.', 'Theek hai.'] });
  submit(b.window, 'mera naam Aarav hai');
  await wait(700);
  const storedFacts = JSON.parse(b.window.localStorage.getItem('jenni_memory_v1') || '[]');
  ok(storedFacts.some((f) => /aarav/i.test(f.text)), 'a name is stored as a fact', storedFacts.map((f) => f.text).join(';'));

  /* it shows in the Setup panel … */
  b.$('memoryList').dataset.x = '';
  b.window.document.querySelector('[data-tab="setup"]').click();
  await wait(120);
  const panelText = b.$('memoryList').textContent;
  ok(/aarav/i.test(panelText), 'the Memory panel shows the fact', panelText.slice(0, 80));

  /* … and it comes back after a reload, inside the system prompt */
  const remembered = b.window.localStorage.getItem('jenni_memory_v1');
  b.dom.window.close();
  b = await boot({ seed: { jenni_memory_v1: remembered }, script: ['Haan, Aarav.', 'Theek hai.'] });
  submit(b.window, 'mujhe kya naam se bulana chahiye');
  await wait(700);
  const memoryBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  const systemText = memoryBody.messages[0].content;
  const systemText0 = systemText;
  ok(/Aarav/i.test(systemText), 'the remembered fact is sent in the system prompt', systemText.slice(-120));

  /* "Sab bhool jao" really empties it */
  b.window.confirm = () => true;
  b.$('btnMemoryClear').click();
  await wait(120);
  const afterWipe = JSON.parse(b.window.localStorage.getItem('jenni_memory_v1') || '[]');
  ok(afterWipe.length === 0, '“Sab bhool jao” empties the memory', String(afterWipe.length));
  ok(!/aarav/i.test(b.$('memoryList').textContent), 'the emptied panel clears too');
  b.dom.window.close();

  /* 2. a leave request carries the learned playbook, not just the question */
  b = await boot({ script: ['Ye raha draft.', 'Theek hai.'] });
  submit(b.window, 'leave application likhni hai');
  await wait(700);
  const leaveBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  const leaveSystem = leaveBody.messages[0].content;
  ok(/Leave-application|leave application/i.test(leaveSystem), 'the leave playbook is injected', leaveSystem.slice(-140));
  ok(/date|reason|principal|class/i.test(leaveSystem), 'the playbook carries real steps');
  b.dom.window.close();

  /* 3. a thin answer to a plan question triggers one self-check call, then improves */
  b = await boot({ script: ['haan', 'Pehle syllabus 4 hisson me baanto, phir roz 2 ghante padho aur har Sunday test do.', 'Theek hai.'] });
  submit(b.window, 'study plan kaise banaun');
  await wait(900);
  const planCalls = b.calls.filter((c) => c.url.includes('chat/completions'));
  ok(planCalls.length >= 2, 'a thin plan answer is re-asked once', String(planCalls.length));
  const finalBubble = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].map((n) => n.textContent).join(' | ');
  ok(finalBubble.includes('syllabus'), 'the better second answer is the one shown', finalBubble.slice(0, 80));
  b.dom.window.close();

  /* 4. a greeting stays one call — no wasted second round-trip */
  b = await boot({ script: ['Namaste! Batao kya karna hai.'] });
  submit(b.window, 'namaste');
  await wait(700);
  ok(b.calls.filter((c) => c.url.includes('chat/completions')).length === 1, 'a greeting is answered in one call');
  b.dom.window.close();

  /* 4b. the persona is pointed at 2026-27 → 2030, not stale knowledge */
  ok(/2027-2030/.test(systemText0), 'the prompt asks for 2026-27 to 2030 thinking');

  /* 5. the core's own units */
  ok(A.critiqueAnswer('haan', 'study plan banao').ok === false, 'critique: a bare “haan” is too thin');
  ok(A.critiqueAnswer('Theek hai.', 'namaste').ok === true, 'critique: a short greeting reply is fine');
  ok(A.critiqueAnswer('Main file nahi bana sakti.', 'leave application file banao').ok === false, 'critique: a refusal is caught');
  ok(A.critiqueAnswer('Kal subah 6 baje utho, 2 ghante padho aur raat ko 30 min revision karo.', 'kaise padhun').ok === true, 'critique: a real plan passes');

  /* skills are learned, versioned and matched */
  const store = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; } };
  const skills = A.createSkills(store);
  ok(skills.match('leave application likhni hai').length > 0, 'a leave request matches its playbook');
  ok(skills.match('aaj mausam kaisa hai').length === 0, 'an unrelated question matches nothing');
  const v1 = skills.learn({ name: 'leave application', steps: ['step one', 'step two'] });
  const v2 = skills.learn({ name: 'leave application', steps: ['step one', 'step two', 'step three'] });
  ok(v1 && v1.version === 1, 'a new skill starts at v1', String(v1 && v1.version));
  ok(v2 && v2.version === 2 && v2.steps.length === 3, 're-learning the same skill bumps the version', JSON.stringify(v2 && v2.version));
  ok(skills.all().filter((s) => s.source === 'learned').length === 1, 'a learned skill replaces, never duplicates');

  /* memory recall prefers relevance and drops duplicates */
  const mem = A.createMemory(store);
  mem.observe('mera naam Aarav hai');
  mem.observe('mera naam Aarav hai');
  ok(mem.all().filter((f) => /aarav/i.test(f.text)).length === 1, 'a repeated fact is not duplicated');
  ok(mem.recall('mera naam kya hai')[0].text.includes('Aarav'), 'recall ranks the relevant fact first');

  /* ── chat clear learns first, then wipes the screen ───────────────────── */

  b = await boot({ script: ['Theek hai, likh diya.', 'Chalo phir.'] });
  b.window.confirm = () => true;

  /* an empty chat has nothing to clear */
  b.$('btnNewChat').click();
  await wait(80);
  const emptyToast = b.$('toastHost').textContent;
  ok(/pehle se khali/.test(emptyToast), 'clearing an empty chat says so', emptyToast.slice(0, 60));

  submit(b.window, 'mera naam Aarav hai');

  /* a step-by-step answer becomes a playbook … */
  b = await boot({
    script: [
      'Theek hai. Plan aisa: 1. Syllabus ko 4 hisson me baanto. 2. Roz 2 ghante padho, subah 6 se 8. 3. Har Sunday ek chhota test do. 4. Weak topic par extra 30 min. 5. Har raat 10 min revision karo.',
      'Chalo phir.'
    ]
  });
  submit(b.window, 'study plan banao');
  await wait(600);
  const planLearned = JSON.parse(b.window.localStorage.getItem('jenni_skills_v1') || '[]');
  ok(planLearned.length >= 1, 'a step-by-step answer is saved as a playbook', String(planLearned.length));

  /* 👍 keeps it, and lifts its rating */
  const bubbles = [...b.window.document.querySelectorAll('.msg--jenni')];
  const upBtn = bubbles[bubbles.length - 1].querySelector('.msg__tool--rate');
  ok(Boolean(upBtn), 'every reply has a 👍 button');
  upBtn.click();
  await wait(120);
  const rated = JSON.parse(b.window.localStorage.getItem('jenni_skills_v1') || '[]');
  ok(rated.some((skill) => Number(skill.rating) > 0), '👍 raises the playbook rating', JSON.stringify(rated.map((s) => s.rating)));
  ok(b.window.document.querySelector('.msg__tool--rate.is-on') !== null, 'the pressed rating is visible');
  ok(/pasand aaya|Yaad rakha/i.test(b.$('toastHost').textContent), '👍 confirms it was remembered');

  /* 👎 on the same reply undoes it */
  const downBtn = bubbles[bubbles.length - 1].querySelectorAll('.msg__tool--rate')[1];
  downBtn.click();
  await wait(120);
  const disliked = JSON.parse(b.window.localStorage.getItem('jenni_skills_v1') || '[]');
  ok(disliked.some((skill) => Number(skill.rating) < 0), '👎 pushes the playbook down instead');
  b.dom.window.close();

  /* ── clear chat: screen empties, knowledge stays, journal grows ───────── */

  b = await boot({ script: ['Haan, note kar liya.', 'Theek hai.', 'Aur batao.'] });
  b.window.confirm = () => true;
  submit(b.window, 'mera naam Aarav hai aur Patna me rehta hoon');
  await wait(500);
  submit(b.window, 'study plan banao');
  await wait(600);
  ok(b.window.document.querySelectorAll('.msg').length >= 4, 'the chat has real turns first');

  const factsBefore = JSON.parse(b.window.localStorage.getItem('jenni_memory_v1') || '[]').length;
  b.$('btnNewChat').click();
  await wait(250);

  ok(b.window.document.querySelectorAll('.msg').length === 0, 'clearing empties the conversation');
  ok((b.window.localStorage.getItem('jenni_chat_v1') || '[]') === '[]', 'the saved chat is emptied too');
  const factsAfter = JSON.parse(b.window.localStorage.getItem('jenni_memory_v1') || '[]');
  ok(factsAfter.length >= factsBefore, 'the facts survive the clear', `${factsBefore}→${factsAfter.length}`);
  ok(factsAfter.some((fact) => /aarav/i.test(fact.text)), 'the name is still remembered after the clear');

  const episodes = JSON.parse(b.window.localStorage.getItem('jenni_episodes_v1') || '[]');
  ok(episodes.length === 1, 'one episode row is written for the cleared chat', String(episodes.length));
  ok(episodes[0].turns >= 2, 'the episode counts the turns', String(episodes[0].turns));
  ok(/saaf|yaad/i.test(b.$('toastHost').textContent), 'the toast says what was kept', b.$('toastHost').textContent.slice(0, 70));

  /* the cleared chat still leaves a next-chat hint in the prompt */
  submit(b.window, 'kya yaad hai tujhe');
  await wait(600);
  const afterClearBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  const afterClearSystem = afterClearBody.messages[0].content;
  ok(/Aarav/i.test(afterClearSystem), 'memory still reaches the prompt after the clear');
  b.dom.window.close();

  /* ── the loop closes: a stated taste comes back in the next chat ──────── */

  b = await boot({
    seed: {
      jenni_insights_v1: JSON.stringify([
        { id: 'i1', text: 'Step-by-step jawab pasand aate hain', kind: 'taste', confidence: 0.7, hits: 2, at: new Date().toISOString() }
      ])
    },
    script: ['Theek hai, yaad hai.']
  });
  submit(b.window, 'kuch batao');
  await wait(500);
  const habitBody = JSON.parse(b.calls.filter((c) => c.url.includes('chat/completions')).pop().options.body);
  ok(/pasand aate hain/.test(habitBody.messages[0].content), 'a learned habit is used in the next chat', habitBody.messages[0].content.slice(-120));
  b.dom.window.close();

  /* ── the journal panel is honest and wipeable ─────────────────────────── */

  b = await boot({
    seed: {
      jenni_episodes_v1: JSON.stringify([{ id: 'e1', at: new Date().toISOString(), turns: 3, topics: ['leave'], facts: ['name: Aarav'], skills: ['Leave application'], liked: 1, disliked: 0 }]),
      jenni_insights_v1: JSON.stringify([{ id: 'i1', text: 'Chhote jawab pasand hain', kind: 'taste', confidence: 0.6, hits: 1, at: new Date().toISOString() }])
    }
  });
  b.window.document.querySelector('[data-tab="setup"]').click();
  await wait(150);
  ok(/1 chat se seekha/.test(b.$('journalSummary').textContent), 'the journal panel counts chats', b.$('journalSummary').textContent);
  ok(/Chhote jawab/.test(b.$('insightList').textContent), 'the habit is listed');
  ok(/3 baat/.test(b.$('episodeList').textContent), 'the episode row is listed');

  b.window.confirm = () => true;
  b.$('btnJournalClear').click();
  await wait(150);
  ok((b.window.localStorage.getItem('jenni_episodes_v1') || '') === '', 'clearing the journal removes episodes');
  ok(/Abhi ek bhi chat clear nahi hui/.test(b.$('journalSummary').textContent), 'the panel returns to its empty state');
  b.dom.window.close();

  /* ── journal units: capped, deduped, and it decays like memory ────────── */

  const journalStore = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; } };
  const journal = A.createJournal(journalStore);
  for (let i = 0; i < 35; i += 1) journal.addEpisode({ turns: i + 1, topics: ['t' + i] });
  ok(journal.episodes().length === 30, 'episodes are capped at 30', String(journal.episodes().length));
  ok(journal.episodes()[0].turns === 35, 'the newest episode is first');

  journal.addInsight({ text: 'same habit' });
  journal.addInsight({ text: 'same habit' });
  const habits = journal.insights();
  ok(habits.length === 1 && habits[0].hits === 2, 'a repeated habit is reinforced, not duplicated', JSON.stringify(habits));
  for (let i = 0; i < 12; i += 1) journal.addInsight({ text: 'habit number ' + i });
  ok(journal.insights().length === 8, 'insights are capped at 8', String(journal.insights().length));

  const made = journal.reflect({ liked: 3, disliked: 3, skills: ['Leave application', 'Study plan'] });
  ok(made.length >= 2, 'reflection produces habits from real evidence', String(made.length));
  ok(journal.insights().some((item) => /Step-by-step/.test(item.text)), 'a taste for step-by-step is distilled');
  journal.clear();
  ok(journal.episodes().length === 0 && journal.insights().length === 0, 'journal clear empties both lists');

  /* 👍 on a fact makes it steadier, 👎 makes it fade */
  const memStore = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; } };
  const mem2 = A.createMemory(memStore);
  mem2.observe('mujhe coffee pasand hai');
  const startConfidence = mem2.all()[0].confidence;
  ok(mem2.reinforce('mujhe coffee pasand hai', 0.1) === 1, 'reinforce finds the matching fact');
  ok(mem2.all()[0].confidence > startConfidence, 'a 👍 lifts confidence', mem2.all()[0].confidence.toFixed(2));
  ok(mem2.weaken('mujhe coffee pasand hai', 0.2) === 1, 'weaken finds it too');
  ok(mem2.all()[0].confidence < startConfidence, 'a 👎 lowers it', mem2.all()[0].confidence.toFixed(2));

  /* skills carry their rating into match order */
  const rateStore = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; } };
  const rateSkills = A.createSkills(rateStore);
  const learnedSkill = rateSkills.learn({ name: 'monday plan', steps: ['a', 'b'], triggers: ['monday'] });
  ok(Boolean(rateSkills.rate(learnedSkill.name, 1)), 'a skill can be rated by name');
  ok(Number(rateSkills.custom()[0].rating) === 1, 'the rating is stored', String(rateSkills.custom()[0].rating));
  ok(rateSkills.rate('kuch bhi nahi', 1) === null, 'rating an unknown skill is a no-op');

  /* ── backup carries the learning, and a restore merges ────────────────── */

  b = await boot({
    seed: {
      jenni_memory_v1: JSON.stringify([{ id: 'f1', kind: 'name', text: 'name: Aarav', hits: 2, confidence: 0.9, at: new Date().toISOString() }]),
      jenni_skills_v1: JSON.stringify([{ id: 's1', name: 'monday plan', steps: ['a', 'b'], triggers: ['monday'], version: 2, rating: 1 }]),
      jenni_insights_v1: JSON.stringify([{ id: 'i1', text: 'Chhote jawab', confidence: 0.6, hits: 1, at: new Date().toISOString() }])
    }
  });
  let grabbed = null;
  const realCreate = b.window.URL.createObjectURL;
  b.window.URL.createObjectURL = (blob) => { grabbed = blob; return 'blob:fake'; };
  b.$('btnExport').click();
  await wait(120);
  ok(Boolean(grabbed), 'export produces a file');
  const backupText = await grabbed.text();
  const backup = JSON.parse(backupText);
  ok(Array.isArray(backup.memory) && backup.memory.length === 1, 'the backup carries memory');
  ok(Array.isArray(backup.skills) && backup.skills[0].rating === 1, 'the backup carries learned skills with ratings');
  ok(Array.isArray(backup.insights) && backup.insights.length === 1, 'the backup carries habits');
  ok(!JSON.stringify(backup).includes('test-key-123'), 'the key is never in the backup');
  b.window.URL.createObjectURL = realCreate;
  b.dom.window.close();

  /* restore into a phone that already knows a newer fact — nothing is lost */
  b = await boot({
    seed: {
      jenni_memory_v1: JSON.stringify([{ id: 'f2', kind: 'place', text: 'place: Patna', hits: 1, confidence: 0.8, at: new Date().toISOString() }])
    }
  });
  const importFile = b.$('importFile');
  const file = new b.window.File([backupText], 'jenni-backup.json', { type: 'application/json' });
  Object.defineProperty(importFile, 'files', { value: [file], configurable: true });
  importFile.dispatchEvent(new b.window.Event('change', { bubbles: true }));
  await wait(400);
  const mergedMemory = JSON.parse(b.window.localStorage.getItem('jenni_memory_v1') || '[]');
  ok(mergedMemory.length === 2, 'import merges both sides instead of replacing', JSON.stringify(mergedMemory.map((f) => f.text)));
  ok(mergedMemory.some((fact) => /Aarav/.test(fact.text)) && mergedMemory.some((fact) => /Patna/.test(fact.text)), 'both the old and the restored facts are there');
  ok(JSON.parse(b.window.localStorage.getItem('jenni_skills_v1') || '[]').length === 1, 'the restored skill lands too');
  ok(/wapas aayi/.test(b.$('toastHost').textContent), 'the restore says what came back', b.$('toastHost').textContent.slice(0, 60));
  b.dom.window.close();

  /* ── failures stay readable ────────────────────────────────────────────── */
  b = await boot({ fail: true });
  submit(b.window, 'hello');
  await wait(220);
  const last = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].pop();
  ok(last.textContent.includes('Key galat'), '401 explains itself in plain words');
  b.dom.window.close();

  /* ── restored behaviour: memory tags, streaming, streamed voice ─────────── */
  b = await boot({ script: ['Theek hai, yaad rakh liya.\n[[remember: Principal likes short circulars]]'] });
  submit(b.window, 'hello');
  await wait(300);
  const tagged = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].pop().textContent;
  ok(!tagged.includes('[[') && tagged.includes('yaad rakh liya'), 'memory tags are stripped from the reply', tagged);
  ok(/short circulars/.test(b.window.localStorage.getItem('jenni_notes_v1') || ''), 'a model-written [[remember]] is saved to notes');
  b.dom.window.close();

  b = await boot({ script: [{ sse: ['Haan yaar, ', 'kar deti hoon. ', 'Pehle notice ', 'banate hain.'] }] });
  submit(b.window, 'notice ka plan');
  await wait(400);
  const streamedText = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].pop().textContent;
  ok(streamedText === 'Haan yaar, kar deti hoon. Pehle notice banate hain.', 'a streamed reply is assembled in full', streamedText);
  ok(JSON.parse(b.calls.find((c) => c.url.includes('chat/completions')).options.body).stream === true, 'the request asks for a stream');
  b.dom.window.close();

  b = await boot({ script: [{ sse: ['Haan yaar, ', 'main kar deti hoon ye kaam. ', 'Pehle notice ', 'ka draft banate hain.\n', '[[remember: likes drafts]]'] }] });
  b.$('btnVoice').click();
  await wait(90);
  b.rec.last.say('kal ka din kaisa rahega');
  await wait(900);
  ok(b.tts.spoken.length >= 2, 'a streamed answer is spoken sentence by sentence', String(b.tts.spoken.length));
  ok(b.tts.spoken.every((u) => !u.text.includes('[[') && !u.text.includes('likes drafts')), 'memory tags are never spoken');
  b.rec.last.say('ruko');
  await wait(400);
  b.dom.window.close();

  /* ── Office desk ───────────────────────────────────────────────────────── */
  b = await boot();
  b.window.document.querySelector('.tab[data-tab="office"]').click();
  await wait(150);
  ok(b.$('sheet-office').hidden === false, 'Office tab opens the Office desk');
  ok(b.$('offType').options.length === 8, 'eight document types are offered', String(b.$('offType').options.length));
  b.$('school_name').value = 'Dumka Public School'; b.$('btnSchoolSave').click();
  b.$('offType').value = 'notice'; b.$('offType').dispatchEvent(new b.window.Event('change'));
  b.$('off_subject').value = 'Sports Day'; b.$('off_body').value = 'Reach by 8:30\nWear uniform';
  b.$('btnOffMake').click();
  ok(b.$('offOut').value.includes('DUMKA PUBLIC SCHOOL') && b.$('offOut').value.includes('1. Reach by 8:30'), 'notice is built with letterhead and numbered points');
  b.$('btnOffMake').click();
  ok(/NTC\/2$/.test((b.$('offOut').value.match(/DP\/[^\s]+|DPS\/[^\s]+/) || [''])[0]) || /\/NTC\/2/.test(b.$('offOut').value), 'reference number increments per document');
  b.$('offType').value = 'roster'; b.$('offType').dispatchEvent(new b.window.Event('change'));
  b.$('off_staff').value = 'Anil\nBina\nChandan\nDeepa'; b.$('off_duties').value = 'Assembly | 2\nGate | 1';
  b.$('btnOffMake').click();
  ok(b.$('offOut').value.includes('| Assembly |') && b.$('offOut').value.includes('| Staff | Duties |'), 'duty roster table is generated');
  b.$('btnOffSave').click();
  ok(JSON.parse(b.window.localStorage.getItem('jenni_drafts_v1') || '[]').length === 1, 'office output saves as a draft');
  b.dom.window.close();

  /* ── legacy notes stored under agent.js's key are split out once ───────── */
  b = await boot({ seed: { jenni_memory_v1: JSON.stringify([{ id: 'n1', text: 'old note', cat: 'task', ts: 1 }, { id: 'f9', kind: 'fact', text: 'a fact', hits: 1, confidence: 0.9, at: '2026' }]) } });
  ok(/old note/.test(b.window.localStorage.getItem('jenni_notes_v1') || '') && !/old note/.test(b.window.localStorage.getItem('jenni_memory_v1') || '') && /a fact/.test(b.window.localStorage.getItem('jenni_memory_v1') || ''), 'legacy notes move out of the agent facts key');
  b.dom.window.close();

  /* ── master voice switch + memory ─────────────────────────────────────── */
  b = await boot({});
  const doc = b.window.document;
  doc.getElementById('btnVoiceMaster').click();
  ok(doc.body.classList.contains('voice-off') && b.window.localStorage.getItem('jenni_voice_on') === '0', 'voice master OFF hides mic + persists');
  doc.getElementById('btnVoiceMaster').click();
  ok(!doc.body.classList.contains('voice-off'), 'voice master ON restores mic');
  doc.getElementById('memInput').value = 'Class 12 SA1 Monday';
  doc.getElementById('btnMemAdd').click();
  ok(/SA1/.test(b.window.localStorage.getItem('jenni_notes_v1') || ''), 'memory add persists');
  b.dom.window.close();

  console.log('\n' + checks + ' checks, ' + (checks - failures) + ' passed' + (failures ? ', ' + failures + ' FAILED' : ''));
  process.exit(failures ? 1 : 0);
})();
