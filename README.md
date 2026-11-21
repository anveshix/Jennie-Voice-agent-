# Jenni Voice & Chat Assistant

Jenni is a small browser UI backed by a Node.js server. Typed messages and speech transcripts go to a server-configured, OpenAI-compatible chat provider. Replies are shown in the conversation and read aloud with the browser's speech synthesis. The server does not save chat history.

## No terminal? Use the phone app

If you do not have a laptop with Node.js, you do not need any of the steps above.
A serverless version lives in `docs/` and runs on GitHub Pages:

**<https://anveshix.github.io/Jennie-Voice-agent-/>**

1. Open the link on your phone (Chrome or Safari).
2. **Android:** menu → *Add to Home screen*. **iPhone:** Share → *Add to Home screen*.
3. Paste an API key (Groq and Gemini have free tiers) and press **Save & start**.
4. Press **Test connection** to prove the key works.

There is no server in that path. The phone calls the provider directly, so the key is
stored only in that browser and never reaches a Jenni backend.

### Voice is the main way in

The phone app is built around one big mic button:

1. Tap it once. The mic opens and stays in a loop: **listen → answer → speak → listen**.
2. Talk. Your words appear as text, the reply is read aloud, then the mic reopens on its own.
3. Say **"ruko"**, "band karo", "stop" or "bas" to end the loop — or tap the mic again.
4. Tap **🔇 Chup** to cut a long answer short without leaving voice mode.

Language is switchable from the voice bar (**हिंदी / EN**) and from Setup
(Hindi, English India/US/UK). Setup also has a picker for the device's TTS voices plus a
**Awaaz test karo** button. Android Chrome runs the full hands-free loop; iOS Safari allows
one recording at a time, so there the mic has to be tapped for each turn.

Drafts, optional read-aloud for typed replies, and Google Drive upload with `drive.file`
work on top of that.

### Mobile-shaped shell

The app is laid out like an installed Android/iOS app: a sticky app bar with a status dot
and a Drive shortcut, a five-item bottom navigation (Chat · Voice · Drafts · Drive ·
Setup), bottom sheets with a drag handle, and no double-tap zoom or text selection on
controls. Safe-area insets are respected on notched phones.

### Drive is always one link away

The Drive sheet leads with a single large link that changes meaning as setup progresses:
**"build a client ID first"** → Google Cloud, **"connect Google Drive"** → OAuth prompt,
**"open my Drive files"** → your files. While Drive is not connected the app bar shows a
`+`/`!` badge, and the sheet also carries a credentials link, this guide, and Google's help
page. A **Paste** button fills the client ID from the clipboard, and the authorized origin
has a one-tap copy button.

### Floating bot

A draggable chat-head style bubble sits above every screen, modelled on the pattern
Facebook Messenger and Android bubbles use (pointer events, a drag threshold so taps stay
taps, and a spring to the nearest edge):

- **drag** it anywhere; it snaps to the left or right edge at the height you dropped it and
  remembers both, per device
- **tap** starts the voice loop from whatever screen you are on; tap again to stop
- **long-press** opens the thing that screen needs (drafts, Drive connect, settings)
- **drag onto the ✕ bin** to hide it; the Setup toggle or the restore chip brings it back
- the face reacts: mint rings while listening, violet with sound bars while speaking, amber
  while thinking, and the eyes blink
- a small counter shows how many drafts are saved

It is the same voice controller as the big mic button, so nothing diverges — the bot just
makes it reachable from anywhere.

### Addressable screens

Every screen has a URL: `#voice`, `#drive`, `#drafts`, `#setup`. Shares and bookmarks land
where you expect, the last screen is restored on the next visit, and the hardware back
button closes a sheet before it leaves the app.

Step-by-step Hindi walkthrough: [`Phone-Setup-Hindi.md`](./Phone-Setup-Hindi.md).

The Node app in the repository root is unchanged: `app.html` is the page `npm start`
serves, and the root `index.html` now only redirects Pages visitors to `docs/`.

## Run it locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Edit `.env` and set `AI_API_KEY` to a key from the provider you want to use. Keep the key in `.env` on the server; never paste it into `index.html` or browser code.
4. Set `AI_BASE_URL` and `AI_MODEL` for that provider. The defaults target the OpenAI-compatible API format.
5. Run:

   ```sh
   npm start
   ```

6. Open <http://localhost:3000>, choose a local PIN for the convenience lock, then chat or tap the microphone. Microphone access requires localhost or HTTPS and browser permission.

No package installation is required. Check the server-side integration with `npm test`.

### Local model option

An OpenAI-compatible local server can be used without an API key. For example, set `AI_BASE_URL` to the local server's `/v1` endpoint and `AI_MODEL` to a model it serves. The app allows unencrypted HTTP only for loopback hostnames such as `localhost` and `127.0.0.1`; remote provider URLs must use HTTPS.

### Speech

Jenni uses the browser's SpeechRecognition API when available. Browser speech recognition may be processed by a browser or operating-system speech service; its privacy behavior depends on that implementation. If SpeechRecognition is unavailable, Jenni can record audio in the browser and send it to the configured `AI_TRANSCRIPTION_MODEL` endpoint, provided that your chosen provider supports the OpenAI-compatible transcription endpoint. That recording is sent to the configured provider for transcription and is not stored by Jenni's server. Set `AI_TRANSCRIPTION_MODEL=` to disable this fallback.

## API Room (add a key from the browser)

Once the server is running you can add a provider key from the app itself — no file editing:

1. Open <http://localhost:3000>, unlock, then click the status pill (or **AI setup & privacy**).
2. Pick a preset (OpenAI, Groq, Google Gemini, OpenRouter, Ollama, or Custom).
3. Paste the key, check the model name, press **Save settings**.
4. Press **Test connection** — you get the model, latency, and whether voice transcription is on.

### Where the key goes

- Written by the server to `storage/settings.json` with mode `600`, inside a `storage/` folder that
  is **git-ignored**. It is never written to the browser, `localStorage`, or `index.html`.
- Saving is only accepted from the same machine (`127.0.0.1`). A phone on your Wi-Fi can **use** the
  saved key but cannot replace it, and can never read it back — `/api/settings` returns only a
  "key is set" flag.
- A key saved in the API Room takes priority over `.env` and applies immediately, without a restart.
  **Remove saved key** deletes the file and falls back to `.env`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Safe status: configured, model, voice, source (`env` or `room`) |
| `GET` | `/api/settings` | Same status plus `savedAt` and `canEdit` (local only) |
| `POST` | `/api/settings` | Save provider settings — loopback requests only |
| `DELETE` | `/api/settings` | Delete the saved key — loopback requests only |
| `POST` | `/api/settings/test` | One small real request to the provider; reports ok/error and ms |
| `GET` | `/api/providers` | Provider presets used by the form |

### Using it from your phone

1. Run `npm start` on the computer, then open `http://<computer-ip>:3000` on the phone (same Wi-Fi).
   The computer's firewall must allow port 3000.
2. Chat works over plain HTTP on your LAN. **Microphone and PWA install need a secure context** —
   `localhost` counts as secure, a LAN IP does not. Either use `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
   for testing, or put the server behind HTTPS (see below).
3. Install it: Android Chrome → ⋮ → *Install app*; iPhone Safari → Share → *Add to Home Screen*.
   The service worker caches the shell so the UI opens even with a flaky connection.
4. Keys can only be saved from the computer itself — open the room there once, then use the phone.

### Interface

The UI is hand-written CSS plus one small script; it needs no build step and no CDN:

- `index.html` — page structure (lock screen, conversation, workspace rail, drawers)
- `public/app.css` — design tokens, glass panels, orb motion, responsive layout
- `public/app.js` — local workspace, speech, and calls to `/api/*`
- `server.js` — also serves those two files, so the app works offline behind the local server

Motion (orb pulses, aurora drift, staged reveals) is pure CSS and turns off automatically
when the OS requests reduced motion. Icons are inline SVG, so nothing depends on an emoji font.

## Send & save elsewhere (three independent options)

Open **Send & save elsewhere** in the workspace rail. Each of the three options turns on
independently — use whichever one you need and leave the others off. Nothing is connected
until you save credentials yourself.

### 1. Telegram (easiest — no OAuth, no verification)

1. In Telegram open **@BotFather** → `/newbot` → pick a name.
2. Copy the token (`123456789:ABC…`).
3. Send your new bot any message ("hi" is enough) — a bot cannot start a chat itself.
4. Paste the token in option 1 → **Find my chat** → choose the chat → **Save & test**.
   Saving sends one real confirmation message, so a wrong token or chat fails loudly.

Sending a draft: open a draft in the editor, then **Send draft to Telegram**. Messages are
split at 3900 characters; anything longer is cut and the message says how many characters
were left out.

### 2. Google Drive — browser mode (client ID only, no verification)

Scope is `drive.file`, which is non-sensitive: the app can only see the files **it created**
or files you explicitly opened with it. Full Drive search needs Google verification plus a
security assessment, so it is deliberately not requested.

1. Google Cloud → new project → enable **Google Drive API**.
2. OAuth consent screen → External → add your own email as a test user.
3. Credentials → **OAuth client ID** → Web application.
4. Authorized JavaScript origin: `http://localhost:3000` (or your HTTPS tunnel URL).
5. Paste the client ID (ends with `.apps.googleusercontent.com`) → **Save client ID** → **Connect Google**.

The token is issued by Google Identity Services in the browser and lasts about an hour; the
upload goes straight from the browser to Google. The server never sees the token, and the app
asks for no client secret.

### 3. Google Drive — server mode (background upload)

1. Use the same OAuth client, and copy the **client secret** too (`GOCSPX-…`).
2. Register a redirect URI, for example `https://your-tunnel.example/oauth2callback`.
3. Paste secret + redirect URI in option 3 → **Show Google link** → open it → allow.
4. Copy the `?code=` value from the redirect URL → paste it → **Finish connection**.

The server swaps that one-time code for a refresh token, so uploads keep working while the
browser is closed. The refresh token is stored in `storage/connections.json` (mode `600`,
git-ignored) and is never returned to any browser — treat it like an API key.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/connections` | Status only: flags, hints, mode. Never tokens. |
| `DELETE` | `/api/connections` | Forget everything — loopback only |
| `POST` | `/api/connections/telegram/chats` | List chats that messaged the bot — loopback only |
| `POST` `DELETE` | `/api/connections/telegram` | Save (with a real test send) / forget — loopback only |
| `POST` | `/api/connections/telegram/test` | Send a test message — loopback only |
| `POST` | `/api/connections/telegram/send` | Send the open draft (LAN allowed, 20/min) |
| `POST` | `/api/connections/drive` | Save client ID / secret / mode — loopback only |
| `POST` | `/api/connections/drive/code` | Exchange `?code=` for a refresh token — loopback only |
| `POST` | `/api/connections/drive/upload` | Upload markdown (LAN allowed, 20/min) |
| `GET` | `/api/connections/drive/files` | Recent app files (LAN allowed, 20/min) |
| `DELETE` | `/api/connections/drive` | Forget Drive — loopback only |

Changing credentials is loopback-only, exactly like the API Room. Sending and uploading are
allowed from a phone on the same Wi-Fi because the destination is already fixed and the token
never leaves the server.

## Jenni's character

Jenni is written as a specific person, not a generic assistant: a **21-year-old smart, funny,
level-headed friend** living on your phone.

- **Common sense first** — say "pata nahi" when unknown, flag risky or obviously wrong requests instead of
  producing confident nonsense.
- **Humor that reads the room** — playful when you are; instantly serious when you are not.
- **Polite, never servile** — natural lines ("haan yaar", "chal, dekh rahi hoon"), never "yes sir, how may I
  assist you".
- **Quick acknowledgement** — "haan, kar deti hoon" first, then the work, then one line of result. Never
  claims an action it cannot take.
- **Fast by design** — answer first, 2–4 short sentences by default, capped tokens; voice mode caps tighter
  so speech begins sooner; TTS runs slightly quick and bright (rate 1.06, pitch 1.08).
- **Voice-safe output** — no emoji, headings, tables or bullets unless asked, because replies get read aloud.
- **Honest** — admits being an AI when asked, keeps the personality either way.

The persona is a prompt (`docs/app.js` → `PERSONA`, `server.js` → `SYSTEM_PROMPT`), not a fine-tuned model,
so it travels with whichever provider you plug in.

## Documents and failure handling

- **Documents are always offered.** Any reply that reads like a letter/application (formal header + closing or
  signature block) gets the download button even if the user never said "doc" — `docs/docs.js` also writes
  `.txt`, `.md`, `.csv`, `.json` and `.html` when those are asked for.
- **The model is told not to refuse.** The prompt states that the app builds the file from the reply, so it
  writes the draft instead of saying "I cannot create or download files".
- **Public GitHub repos can be read** (`docs/github.js`): `owner/repo` or a github.com URL plus a request to
  look at the code fetches metadata, top-level tree and README through api.github.com and folds a trimmed
  digest into the prompt. A browser cannot clone or install — it reads, links and quotes instead, and the
  prompt forbids telling a phone user to run git.
- **Document requests make real files.** "leave application doc file banao", "word me do", "PDF chahiye",
  "letter likho" → the model writes the full draft and the app attaches **⬇ Download .docx** to that reply.
  The file is a genuine OOXML package built in the browser (`docs/docs.js`, an 80-line stored-zip writer +
  WordprocessingML): it opens in Word, Google Docs and every phone office app. Nothing is uploaded.
- **Gemini 3 thinks before answering.** Its default `thinking_level` is medium (time-to-first-token ≈ 11 s)
  and thinking tokens are billed against `max_tokens`, which is why replies used to time out or come back
  empty. Requests to `generativelanguage.googleapis.com` now send `reasoning_effort: minimal` (or `low` for
  3.8 Flash) and add 1200 tokens of headroom. Other providers get no Gemini-only fields.
- **Self-healing sends.** Timeout, network drop, HTTP 5xx, 429 and empty bodies retry automatically (2 tries,
  backoff). A `finish_reason: length` answer is continued and stitched rather than discarded.
- **Honest, short failures.** After retries the bubble says one line ("Jawab nahi aaya. Provider ne 60 second
  me jawab nahi diya.") and offers **Phir try karo**, which resends the same question — no more stacked
  "Maaf karo…" paragraphs, and failed bubbles are never replayed to the model.

## Privacy and limits

- Each chat request sends the user's message and recent turns from the current tab to the configured AI provider. The conversation stays in tab memory only; it is not written to the app's server or browser storage.
- Local notes, tasks, and drafts remain in this browser and are **not** automatically attached to AI requests.
- The local PIN is only a browser convenience and is not account authentication or a security boundary.
  In the phone app it **does** encrypt the API key at rest (PBKDF2-SHA256, 210k rounds, then AES-GCM-256):
  with a PIN set, `jenni_vault_v1` holds only ciphertext and `jenni_cfg_v1` is removed. Locking wipes the
  key from memory; auto-lock (1-15 min) and lock-on-tab-hide re-arm it; five wrong PINs trigger a growing
  cooldown (1 to 15 min); **Erase everything** clears every `jenni_*` key. A CSP is injected at boot
  (`default-src 'self'`, `connect-src https:`, `object-src 'none'`, `base-uri 'none'`). What this cannot
  do: stop someone holding the unlocked phone who also knows the PIN. See `docs/security.js`.
- No connection is configured out of the box. Saving an AI response creates a local browser draft only; nothing leaves the machine until you connect Telegram or Drive yourself and press send/upload.
- The API Room key lives in `storage/settings.json` on this machine (mode `600`, git-ignored). The Telegram
  bot token, Drive client secret, and Drive refresh token live in `storage/connections.json`, also mode `600`
  and git-ignored. None of them are ever returned to a browser, but anyone with shell access can read them —
  treat them like SSH keys. **Disconnect** deletes them.

### What each option can and cannot do

| | Telegram | Drive browser | Drive server |
|---|---|---|---|
| Credentials you paste | bot token | client ID | client ID + secret |
| Google verification | not needed | not needed | not needed |
| Scope | your bot chat only | `drive.file` | `drive.file` |
| Works when browser is closed | — | no (1-hour token) | yes |
| Storage of a secret on the server | bot token | none | client secret + refresh token |
| Needs HTTPS / tunnel | no | yes, on a phone | yes |
- Do not put confidential or sensitive information into chat unless the configured AI provider is approved to process it.
- This demo has no user login. Do not expose a server with a billable AI key to the public internet without putting it behind appropriate authentication, HTTPS, and operational protections. The API key is server-side, but an unauthenticated public endpoint could still be abused.

If the AI service is not configured or a provider request fails, Jenni displays the error instead of pretending a reply or external action succeeded.

## Memory, skills and autonomy (`docs/brain.js`)

Jenni knows the owner profile (from `AGENTS.md`), the current IST date/time, and a long-term **memory** kept only in this browser (`jenni_memory_v1`, wiped by panic). Say "yaad rakho: …", "bhool jao …", or just talk: Jenni saves durable facts and tasks herself via hidden `[[remember/task/done/forget: …]]` tags that are stripped from the reply. Passwords/OTP-like text is never saved. Manage it in **Setup → Memory**.

Skills (official letters, lesson plans, result diagnostics, planner, commerce tutor, CBSE compliance, code, sensitive advice) load only when the message matches. Add one by appending to `SKILLS` in `docs/brain.js`. The Node server uses the same module (profile, time, skills; memory stays on the phone).

## NeverMind agents, skill packs, voice switch

- **NeverMind bridge** (Setup → NeverMind): paste your deployed NeverMind URL (+ token). Requests for worksheets, quizzes, question papers, lesson plans, notices etc. (or `nevermind: …`) are delegated to its 9 agents / 21 verified skills; Jenni returns the summary and file links, and falls back to normal chat on error. "Memory sync" pulls NeverMind's active semantic/procedural memory into Jenni. On the NeverMind server set `NEVERMIND_CORS_ORIGINS` (default `https://anveshix.github.io`) and `NEVERMIND_API_TOKEN`.
- **Skill packs**: install any public repo's `SKILL.md` files (PpSkills-/skills.sh format, e.g. `anveshix/PpSkills-`); they load when a message matches their description. "Find skills" searches skills.sh.
- **Voice switch**: the speaker button in the app bar turns all voice (mic, hands-free loop, read-aloud) on/off; saved per device.
