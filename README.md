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
- Do not put confidential or sensitive information into chat unless the configured AI provider is approved to process it.
- This demo has no user login. Do not expose a server with a billable AI key to the public internet without putting it behind appropriate authentication, HTTPS, and operational protections. The API key is server-side, but an unauthenticated public endpoint could still be abused.

If the AI service is not configured or a provider request fails, Jenni displays the error instead of pretending a reply or external action succeeded.
