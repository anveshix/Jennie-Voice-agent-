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

## मेरे 11 drafts और PIN?

कुछ नहीं मिटेगा — ये browser की `localStorage` में हैं, server पर नहीं। लेकिन ये **exact address (origin)** से जुड़े हैं: `file://.../index.html` या किसी दूसरे preview URL से `http://localhost:3000` पर जाने पर नया खाली workspace दिख सकता है; पुराना data उसी पुराने address पर सुरक्षित है। जिस address पर 11 drafts दिखते हैं, उसी पर server चलाकर वहीं खोलें। नए address पर PIN दोबारा सेट करना पड़ सकता है — normal है।

## सुरक्षा / सीमाएँ

- Key सिर्फ `.env` में; `.gitignore` पहले से `.env` को ignore करता है। इसे `index.html`, browser, screenshot, चैट या commit में न डालें।
- Key बिलेबल हो सकती है; बिना authentication/HTTPS के server को public internet पर न रखें।
- हर chat request आपका message + हाल की बातें provider को भेजती है; drafts/tasks/notes अपने आप नहीं जाते। Confidential data न डालें।
- Local PIN सिर्फ browser की सुविधा है, account security नहीं।
- इस demo में Google Drive / email / external sending का code ही नहीं है — API key से भी ये नहीं जुड़ेगा।

## सत्यापन (इस session में चेक किया गया)

- `npm start` → `Jenni is listening on http://0.0.0.0:3000` + `AI provider not configured. Add server-side settings to .env.`
- `GET /api/health` → `{"configured":false,"transcriptionConfigured":false,"model":"gpt-4o-mini"}` — यानी server मिल रहा है, सिर्फ key बाकी है।
- `npm test` → **7/7 pass**। कोई code बदलने की ज़रूरत नहीं।

## संदर्भ

- `README.md`, `.env.example` (प्रोजेक्ट फ़ोल्डर)
- https://platform.openai.com/api-keys
- https://openrouter.ai/blog/tutorials/any-coding-agent/
- https://ai.google.dev/gemini-api/docs/openai
- https://freeapihub.com/apis/groq-api

*इस गाइड में कोई असली API key नहीं है; सिर्फ placeholder `sk-APNI-ASLI-KEY-YAHAN` है।*
