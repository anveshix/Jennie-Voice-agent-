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
  model: 'llama-3.3-70b-versatile',
  transcribe: 'whisper-large-v3',
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
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Theek hai, **sun rahi** hoon.' } }] }) };
    }
    if (target.includes('upload/drive')) return { ok: true, status: 200, json: async () => ({ id: 'f1', name: 'Draft.md' }) };
    if (target.includes('drive/v3/files')) {
      return { ok: true, status: 200, json: async () => ({ files: [{ id: 'a', name: 'Notes.md', modifiedTime: '2026-11-01T10:00:00Z', webViewLink: 'https://drive.google.com/x' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

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
  ok(navItems.length === 5, 'bottom navigation has five items', navItems.map((t) => t.textContent.trim()).join('/'));
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

  /* a shared link that needs a key lands on setup instead of a dead screen */
  b = await boot({ cfg: null });
  b.$('gateSkip').click();
  await wait(600);
  ok(b.$('app').hidden === false, 'skip goes to the app shell');
  ok(b.$('sheet-setup').hidden === false, 'no key yet sends them to setup');

  /* a returning user comes back to the screen they left */
  b.window.localStorage.setItem('jenni_screen', 'drafts');
  const stored = b.window.localStorage.getItem('jenni_screen');
  b.dom.window.close();
  b = await boot({ seedScreen: stored });
  await wait(320);
  ok(b.$('sheet-drafts').hidden === false, 'returning visit restores the last screen', b.$('sheet-drafts').hidden);
  b.dom.window.close();

  /* ── failures stay readable ────────────────────────────────────────────── */
  b = await boot({ fail: true });
  submit(b.window, 'hello');
  await wait(220);
  const last = [...b.window.document.querySelectorAll('.msg--jenni .bubble')].pop();
  ok(last.textContent.includes('Key galat'), '401 explains itself in plain words');
  b.dom.window.close();

  console.log('\n' + checks + ' checks, ' + (checks - failures) + ' passed' + (failures ? ', ' + failures + ' FAILED' : ''));
  process.exit(failures ? 1 : 0);
})();
