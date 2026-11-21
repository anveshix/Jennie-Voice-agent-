# Jenni AI Server — "Cannot reach AI server" का पूरा हल (एक-एक स्टेप)

> तारीख: 16 नवंबर 2026 · प्रोजेक्ट: `Jennie-Voice-agent-`
> पूरा रंगीन PDF: `Jenni-Setup-Guide-Hindi.pdf`

## सीधा जवाब

**हाँ, API key डालनी होगी — लेकिन दो काम अलग-अलग हैं:**

1. **Server चालू करना:** `npm start` + `http://localhost:3000` → इससे लाल error **"Cannot reach Jenni's AI server"** खत्म होगा।
2. **चैट का जवाब आना:** `.env` फ़ाइल में `AI_API_KEY` → इससे Jenni जवाब देने लगेगी।

Key **सिर्फ server की `.env` में** जाती है। Browser, `index.html`, PIN box या चैट में कभी नहीं।

## पहले 3 चीज़ें अलग समझें

| चीज़ | कहाँ रहती है | क्या करता है |
| --- | --- | --- |
| Browser पेज (`index.html`) | आपके browser में | PIN, 11 drafts, 0 tasks, माइक — इन्हें ठीक करने की ज़रूरत नहीं |
| Node server (`server.js`) | `npm start` से चलता है | `/api/health`, `/api/chat` देता है; बंद रहने पर लाल error |
| AI provider | OpenAI / Groq / OpenRouter / Ollama | असली जवाब यहीं बनता है; इसके लिए key या local model चाहिए |

**तीन रंग:** लाल = server OFF · पीला = server ON पर `.env`/key खाली · हरा `AI ready` = सब ठीक।

## API key कहाँ से लाएँ?

**रास्ता A — Cloud (सबसे आसान):** `platform.openai.com` → login → API keys → *Create new secret key* → `sk-...` वाली key तुरंत copy करें (दोबारा नहीं दिखती) → credit/billing चेक करें।

**रास्ता B — Local model (free, कोई key नहीं):** Ollama / LM Studio को उसी कंप्यूटर पर चलाएँ। `AI_BASE_URL` localhost/127.0.0.1 हो तो `server.js` बिना key के चलता है। दूर के provider के लिए हमेशा `https`।

## एक-एक स्टेप

### 1. Node.js चेक करें
```sh
node -v
npm -v
```
`command not found` आए तो [nodejs.org](https://nodejs.org) से LTS install करें, फिर Terminal दोबारा खोलें।

### 2. प्रोजेक्ट फ़ोल्डर में Terminal खोलें
- Windows: File Explorer में फ़ोल्डर खोलें → address bar में `cmd` लिखकर Enter (PowerShell भी चलेगा)।
- Mac/Linux: `cd /path/to/Jennie-Voice-agent-`

### 3. सही फ़ोल्डर confirm करें
```sh
dir        # Windows cmd
ls         # Mac / Linux
```
`server.js`, `package.json`, `index.html`, `.env.example` दिखने चाहिए। **`npm install` की ज़रूरत नहीं है** — कोई dependency नहीं है।

### 4. `.env` बनाएँ
```sh
copy .env.example .env            # Windows cmd
Copy-Item .env.example .env       # PowerShell
cp .env.example .env              # Mac / Linux
```
फ़ाइल का नाम सिर्फ `.env` है, `.env.txt` नहीं।

### 5. `.env` खोलें
```sh
notepad .env      # Windows
nano .env         # Mac / Linux → Ctrl+O, Enter, Ctrl+X
```

### 6. ये 5 लाइनें लिखें
```dotenv
AI_API_KEY=sk-APNI-ASLI-KEY-YAHAN
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_TRANSCRIPTION_MODEL=whisper-1
PORT=3000
```
`=` के बाद कोई quote, space या comma नहीं। Local Ollama के लिए:
```dotenv
AI_API_KEY=
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=llama3.2
AI_TRANSCRIPTION_MODEL=
PORT=3000
```

### 7. Server चलाएँ
```sh
npm start
```
ये दिखना चाहिए:
```
Jenni is listening on http://0.0.0.0:3000
AI provider configured for model gpt-4o-mini.
```
**Terminal बंद मत करें** — बंद किया तो server भी बंद हो जाएगा।

### 8. सही URL खोलें
```
http://localhost:3000
```
`index.html` को double-click न करें (`file://...`), न कोई दूसरा preview URL इस्तेमाल करें।

### 9. Confirm करें
```
http://localhost:3000/api/health
→ {"configured":true,"transcriptionConfigured":true,"model":"gpt-4o-mini"}
```
App में `AI ready · gpt-4o-mini` दिखे → "नमस्ते Jenni" लिखकर भेजें।

### 10. `.env` बदलें तो restart करें
```sh
Ctrl+C
npm start
F5        # browser refresh
```

## दूसरे providers (सिर्फ 3 मान बदलें)

| Provider | `AI_BASE_URL` | `AI_MODEL` / transcription |
| --- | --- | --- |
| OpenAI (default) | `https://api.openai.com/v1` | `gpt-4o-mini` / `whisper-1` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` / `whisper-large-v3` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` / खाली |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | AI Studio का current model ID / खाली |

Model नाम बदलते रहते हैं — अपने provider की current docs से मिला लें। जहाँ audio transcription न हो, वहाँ `AI_TRANSCRIPTION_MODEL=` खाली रखें; browser speech recognition पहले से काम कर रहा है।

## Error → इलाज

| संदेश | कारण | ठीक करें |
| --- | --- | --- |
| `Cannot reach Jenni's AI server...` | server बंद / गलत URL | `npm start`, `localhost:3000` |
| `AI is not configured...` | `.env` खाली या restart नहीं | स्टेप 4–6, `Ctrl+C` → `npm start` |
| `AI provider rejected its server-side credentials` | key गलत/expired | नई key, `AI_BASE_URL` से मिलाएँ |
| `Could not reach the configured AI provider` | internet / firewall / गलत URL | URL जाँचें, `https` |
| `HTTP 404` | पुराना `AI_MODEL` | provider की Models list |
| `429 rate-limiting` | limit / credit | रुकें, quota जाँचें |
| `does not offer transcription` | audio endpoint नहीं | `AI_TRANSCRIPTION_MODEL=` खाली |
| `Port 3000 already in use` | port busy | `PORT=3001` → `localhost:3001` |
| `npm: command not found` | Node नहीं | स्टेप 1 |

## Telegram या Google Drive जोड़ना (तीन options, एक-एक स्टेप)

तीनों options अलग-अलग हैं — जो ज़रूरत हो वही on करो, बाकी बंद रहने दो। कुछ भी अपने आप connect नहीं होता; credentials आप खुद डालते हैं। App में बाईं तरफ़ **Send & save elsewhere** खोलो।

### Option 1 — Telegram (सबसे आसान, कोई OAuth नहीं, कोई verification नहीं)

1. Telegram में **@BotFather** खोलो → `/newbot` → नाम दो।
2. जो token मिलेगा (`123456789:ABC…`) वो copy करो।
3. अपने नए bot को **कोई भी message** भेजो — "hi" काफ़ी है। (Bot खुद chat शुरू नहीं कर सकता।)
4. App के option 1 में token paste करो → **Find my chat** → chat चुनो → **Save & test**।

Save करते ही असली confirmation message जाता है — token या chat गलत हुआ तो वहीं error दिखेगा, चुपचाप fail नहीं होगा। Draft भेजने के लिए editor में draft खोलो → **Send draft to Telegram**। 3900 अक्षर तक एक message; उससे लंबा हो तो कट जाता है और message में लिखा आता है कितने अक्षर छूटे।

### Option 2 — Google Drive, browser mode (सिर्फ client ID, कोई verification नहीं)

Scope `drive.file` है, यानी app सिर्फ अपनी बनाई files देख सकती है। पूरा Drive search करने के लिए Google की verification + security assessment चाहिए — इसलिए वो जान-बूझकर नहीं माँगा गया।

1. Google Cloud → नया project → **Google Drive API** enable करो।
2. OAuth consent screen → External → अपना email test user में डालो।
3. Credentials → **OAuth client ID** → Web application।
4. Authorized JavaScript origin: `http://localhost:3000` (या आपका HTTPS tunnel URL)।
5. Client ID (`.apps.googleusercontent.com` पर खत्म होता है) paste करो → **Save client ID** → **Connect Google**।

Google का token browser में बनता है और लगभग 1 घंटे चलता है; upload सीधे browser से Google को जाता है। Server वो token नहीं देखता, और client secret की ज़रूरत ही नहीं।

### Option 3 — Google Drive, server mode (background upload)

1. वही OAuth client, साथ में **client secret** भी copy करो (`GOCSPX-…`)।
2. Redirect URI register करो, जैसे `https://your-tunnel.example/oauth2callback`।
3. Option 3 में secret + redirect URI डालो → **Show Google link** → link खोलो → allow करो।
4. Browser के URL से `?code=` की value copy करो → paste → **Finish connection**।

Server उस एक-बार वाले code को refresh token में बदल देता है, इसलिए browser बंद होने के बाद भी upload चलता रहता है। ये token `storage/connections.json` में mode `600` के साथ रहता है (git-ignored) और किसी browser को वापस नहीं दिया जाता — इसे API key जितना कीमती समझो। **Disconnect** दबाने पर मिट जाता है।

### तीनों में फ़र्क़

| | Telegram | Drive browser | Drive server |
|---|---|---|---|
| क्या paste करना है | bot token | सिर्फ client ID | client ID + secret |
| Google verification | नहीं | नहीं | नहीं |
| Browser बंद हो तो | — | नहीं चलेगा (1 घंटे का token) | चलेगा |
| Server पर secret | bot token | कुछ नहीं | client secret + refresh token |
| Phone पर HTTPS | ज़रूरी नहीं | ज़रूरी | ज़रूरी |

### बदलाव कहाँ से होगा — और कहाँ से नहीं

- Credentials **सिर्फ उसी computer से** save होते हैं (loopback)। Wi-Fi पर मौजूद phone इन्हें बदल नहीं सकता, और token कभी पढ़ भी नहीं सकता।
- **भेजना/upload करना** phone से भी चलता है, क्योंकि गंतव्य पहले से तय है और token server पर ही रहता है। स्पैम से बचने के लिए 20 कॉल/मिनट की सीमा है।

## मेरे 11 drafts और PIN?

कुछ नहीं मिटेगा — ये browser की `localStorage` में हैं, server पर नहीं। लेकिन ये **exact address (origin)** से जुड़े हैं: `file://.../index.html` या किसी दूसरे preview URL से `http://localhost:3000` पर जाने पर नया खाली workspace दिख सकता है; पुराना data उसी पुराने address पर सुरक्षित है। जिस address पर 11 drafts दिखते हैं, उसी पर server चलाकर वहीं खोलें। नए address पर PIN दोबारा सेट करना पड़ सकता है — normal है।

## सुरक्षा / सीमाएँ

- Key सिर्फ `.env` में; `.gitignore` पहले से `.env` को ignore करता है। इसे `index.html`, browser, screenshot, चैट या commit में न डालें।
- Key बिलेबल हो सकती है; बिना authentication/HTTPS के server को public internet पर न रखें।
- हर chat request आपका message + हाल की बातें provider को भेजती है; drafts/tasks/notes अपने आप नहीं जाते। Confidential data न डालें।
- Local PIN सिर्फ browser की सुविधा है, account security नहीं।
- Google Drive / external sending का code अब है, पर **opt-in**: जब तक आप खुद Telegram या Drive connect नहीं करते, कुछ भी बाहर नहीं जाता। AI की API key इनसे जुड़ी नहीं है — दोनों अलग चीज़ें हैं। बिना HTTPS के public internet पर इस server को न रखें।

## सत्यापन (इस session में चेक किया गया)

- `npm start` → `Jenni is listening on http://0.0.0.0:3000` + `AI provider not configured. Add server-side settings to .env.`
- `GET /api/health` → `{"configured":false,"transcriptionConfigured":false,"model":"gpt-4o-mini"}` — यानी server मिल रहा है, सिर्फ key बाकी है।
- `npm test` → **27/27 pass** (17 मूल + 10 connections वाले)।
- `GET /api/connections` → सिर्फ flags और mode लौटाता है, कोई token नहीं।
- `POST /api/connections/telegram/send` बिना setup → `400 TELEGRAM_NOT_CONFIGURED`; गलत client ID → `400 DRIVE_CLIENT_SHAPE`।

## संदर्भ

- `README.md`, `.env.example` (प्रोजेक्ट फ़ोल्डर)
- https://platform.openai.com/api-keys
- https://openrouter.ai/blog/tutorials/any-coding-agent/
- https://ai.google.dev/gemini-api/docs/openai
- https://freeapihub.com/apis/groq-api

*इस गाइड में कोई असली API key नहीं है; सिर्फ placeholder `sk-APNI-ASLI-KEY-YAHAN` है।*
