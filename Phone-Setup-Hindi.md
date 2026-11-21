# Jenni — phone setup (बिना Node.js, बिना terminal)

**आपको कुछ install नहीं करना है।** एक link खोलना है, API key paste करनी है, और app आपके phone की home screen पर आ जाएगा।

---

## सबसे छोटा रास्ता (5 मिनट)

### स्टेप 1 — key बनाओ

Groq सबसे अच्छा है: free, तेज़, card नहीं चाहिए।

1. Phone में खोलो: **console.groq.com/keys**
2. Sign in करो (Google/GitHub से चलेगा)।
3. **Create API Key** → नाम दो (जैसे `jenni-phone`) → **Submit**।
4. Jo key दिखे (`gsk_…`) उसे **copy** करो। दोबारा नहीं दिखेगी, इसलिए अभी paste कर लो।

> दूसरे options भी हैं — नीचे "कौन सा provider" देखो।

### स्टेप 2 — app खोलो

Phone के browser (Chrome या Safari) में यह link खोलो:

```
https://anveshix.github.io/Jennie-Voice-agent-/
```

सीधा `docs` वाला link भी वही app खोलता है:
`https://anveshix.github.io/Jennie-Voice-agent-/docs/`

### स्टेप 3 — home screen पर लगाओ

- **Android (Chrome):** ऊपर right ⋮ → **Add to Home screen** → **Install**
- **iPhone (Safari):** नीचे Share ⬆️ → **Add to Home Screen**

अब Jenni का icon आ जाएगा। Browser में खोलने की ज़रूरत नहीं — icon दबाओ, app खुल जाएगा।

### स्टेप 4 — key डालो

1. App खुलते ही key माँगेगा।
2. **Groq** पहले से चुना होगा।
3. Key paste करो → **Save & start**।
4. Home स्क्रीन पर नहीं, app के अंदर **Setup** tab खोलो → **Test connection** दबाओ।

अगर **"Chal raha hai ✓ (500 ms)"** जैसा message आए — सब तैयार है।

### स्टेप 5 — बात करो

- नीचे message लिखो → ➤ दबाओ।
- या **mic** दबाकर बोलो (Hindi/English दोनों चलेंगे)।
- बोलकर जवाब सुनना है? **Setup → "Jawab bol kar sunao"** वाला switch on करो।
- किसी जवाब को save करना है? उसके नीचे **Save draft** दबाओ। **Drafts** tab में मिलेगा।

---

## कौन सा provider चुनूँ?

| Provider | Key कहाँ से | खर्च | Voice |
|---|---|---|---|
| **Groq** ⭐ | console.groq.com/keys | free tier | हाँ (Whisper) |
| **Gemini** | aistudio.google.com/app/apikey | free tier | browser speech |
| **OpenAI** | platform.openai.com/api-keys | paid | हाँ (Whisper) |
| **OpenRouter** | openrouter.ai/keys | paid/credit | browser speech |

**सुझाव:** Groq से शुरू करो — free है, जवाब तेज़ आते हैं, और गलती से bill नहीं आएगा।

Model बदलना है? **Setup → Model** में लिखो। मिसाल: `llama-3.3-70b-versatile`, `gemini-2.0-flash`, `gpt-4o-mini`।
Custom provider? **Setup → Base URL** में अपना OpenAI-compatible endpoint डालो (https होना चाहिए)।

---

## Google Drive में draft save करना (optional)

1. Google Cloud → नया project → **Google Drive API** enable करो।
2. OAuth consent screen → **External** → अपना email **test user** में डालो।
3. Credentials → **OAuth client ID** → **Web application**।
4. **Authorized JavaScript origin** में यह डालो:
   ```
   https://anveshix.github.io
   ```
   (पूरा path नहीं, सिर्फ origin — `https://anveshix.github.io`)
5. Client ID copy करो → app के **Drive** tab में paste → **Save client ID** → **Connect Google**।
6. "unverified app" दिखे तो **Advanced → Continue** दबाओ (यह अपना ही app है)।
7. अब किसी draft पर **Drive** दबाओ — Google Drive में `.md` file बन जाएगी।

Scope `drive.file` है — app सिर्फ अपनी बनाई files देखती है, पूरा Drive नहीं।

---

## सुरक्षा — 4 बातें जो याद रखो

1. **Key सिर्फ आपके phone में** — browser की storage में। किसी Jenni server पर नहीं जाती; request सीधे provider को जाती है।
2. **Phone खो गया?** Provider के dashboard से key **revoke** कर दो। उसके बाद पुरानी key बेकार।
3. **Spend limit लगाओ** — OpenAI/OpenRouter में billing limit सेट करो। Groq/Gemini free tier में bill नहीं आता।
4. **Shared/public phone पर key न डालो।** किसी को phone दे रहे हो तो पहले **Setup → Delete key** दबा दो।

Backup लेना है? **Setup → Export data** — drafts का JSON मिलेगा। **Key इसमें नहीं जाती** (जान-बूझकर)।

---

## कुछ काम न करे तो

| दिक्कत | इलाज |
|---|---|
| "Key galat ya expired hai" | नई key बनाओ, पूरी copy हुई है जाँचो |
| "Provider tak nahi pahunch paye" | internet / WiFi जाँचो, या Base URL गलत है |
| "429 limit" | provider की limit — 1-2 मिनट रुको या दूसरा provider चुनो |
| Mic नहीं चल रहा | Chrome में खोलो, microphone की permission दो |
| Home screen पर icon नहीं | Chrome ⋮ → Add to Home screen (Safari में Share menu) |
| Drive "Connected" नहीं होता | देखो origin में सिर्फ `https://anveshix.github.io` डाला है, path नहीं |
| App पुराना दिख रहा है | app बंद करके फिर खोलो, या browser में reload करो |

---

## यह कैसे बना है (समझने के लिए)

- **कोई server नहीं चलता।** GitHub Pages सिर्फ HTML/CSS/JS की files देता है।
- **आपका phone ही "server" है** — AI की request phone से सीधे provider को जाती है।
- इसलिए laptop, terminal, `npm`, clone — कुछ भी ज़रूरत नहीं।
- Files यहाँ हैं: `docs/index.html`, `docs/app.js`, `docs/app.css`.

---

*इस गाइड में कोई असली API key नहीं है।*
