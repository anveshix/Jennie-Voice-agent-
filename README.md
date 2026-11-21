# Jenni Voice & Chat Assistant

Jenni is a small browser UI backed by a Node.js server. Typed messages and speech transcripts go to a server-configured, OpenAI-compatible chat provider. Replies are shown in the conversation and read aloud with the browser's speech synthesis. The server does not save chat history.

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

## Privacy and limits

- Each chat request sends the user's message and recent turns from the current tab to the configured AI provider. The conversation stays in tab memory only; it is not written to the app's server or browser storage.
- Local notes, tasks, and drafts remain in this browser and are **not** automatically attached to AI requests.
- The local PIN is only a browser convenience and is not account authentication or a security boundary.
- No Google Drive account, email, messaging destination, or remote send action is configured. Saving an AI response creates a local browser draft only.
- The API Room key lives in `storage/settings.json` on this machine (mode `600`, git-ignored). It is never
  returned to any browser, but anyone with shell access to the computer can read it — treat it like an SSH key.
- Do not put confidential or sensitive information into chat unless the configured AI provider is approved to process it.
- This demo has no user login. Do not expose a server with a billable AI key to the public internet without putting it behind appropriate authentication, HTTPS, and operational protections. The API key is server-side, but an unauthenticated public endpoint could still be abused.

If the AI service is not configured or a provider request fails, Jenni displays the error instead of pretending a reply or external action succeeded.
