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
  b = await boot({ cfg: null });
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

  /* locking hides the app and drops the key from memory */
  b.$('btnLockNow').click();
  await wait(80);
  ok(b.$('lockScreen').hidden === false, 'Lock now shows the lock screen');
  ok(b.$('app').hidden === true, 'the app is hidden while locked');
  ok(b.$('apiKey').value === '', 'the key field is cleared on lock');

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
