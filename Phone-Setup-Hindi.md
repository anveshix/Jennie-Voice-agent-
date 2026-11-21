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

अब app बिल्कुल mobile app जैसा दिखता है — ऊपर Jenni का app bar (हरा dot = ready), नीचे पाँच tab (Chat · Voice · Drafts · Drive · Setup), और sheets नीचे से खुलती हैं।

- **Android (Chrome):** ऊपर right ⋮ → **Add to Home screen** → **Install**
- **iPhone (Safari):** नीचे Share ⬆️ → **Add to Home Screen**

अब Jenni का icon आ जाएगा। Browser में खोलने की ज़रूरत नहीं — icon दबाओ, app खुल जाएगा।

### स्टेप 4 — key डालो

1. App खुलते ही key माँगेगा।
2. **Groq** पहले से चुना होगा।
3. Key paste करो → **Save & start**।
4. Home स्क्रीन पर नहीं, app के अंदर **Setup** tab खोलो → **Test connection** दबाओ।

अगर **"Chal raha hai ✓ (500 ms)"** जैसा message आए — सब तैयार है।

### स्टेप 5 — बोल कर बात करो

- नीचे **बड़ा हरा mic** दबाओ → बोलो → जवाब सुनो → mic खुद खुल जाएगा → फिर बोलो।
- रोकना हो तो **"ruko"** बोलो, या बड़ा mic दबा दो।
- भाषा बदलनी है? Voice bar में **"हिंदी / EN"**।
- Likh kar bhi bhej sakte ho — नीचे text box में लिखो → ➤।
- किसी जवाब को save करना है? उसके नीचे **Save draft** दबाओ।

---

## 🎙 Voice — बिना हाथ लगाये बात करो

ऐप का मुख्य हिस्सा यही है। नीचे **बड़ा हरा mic** दबाओ, फिर फ़ोन जेब में रख दो और बोलते रहो।

### कैसे चलता है

1. **बड़ा mic दबाओ** — "Sun rahi hoon…" दिखेगा।
2. **बोलो** — आपकी बात नीचे text में दिखती है।
3. जवाब आता है और Jenni **बोलकर सुनाती है**।
4. सुनाना खत्म → mic **अपने आप** फिर खुल जाता है। आप फिर बोलो।
5. यह चक्र चलता रहता है — हाथ लगाने की ज़रूरत नहीं।

### रोकना है?

- **कहो: "ruko"** / "बंद करो" / "stop" / "bas" — तुरंत band।
- या **बड़ा mic** दबा दो।
- बोलते हुए रोकना है (बीच में टोकना है)? **🔇 Chup** दबाओ — बोलना बंद, mic फिर सुनने लगेगा।

### भाषा

Voice bar में **"हिंदी / EN"** chip दबाकर भाषा बदलो। यह दोनों चीज़ें बदलता है — आपकी आवाज़ किस भाषा में सुनी जाए, और जवाब किस भाषा में बोला जाए।
Setup में चार options हैं: हिंदी, English (India), English (US), English (UK)।

**जवाब किस आवाज़ में आए** — WhatsApp/Instagram जैसे और apps की आवाज़ भी phone में होती है। **Setup → Awaaz** में list से चुनो, **🔊 Awaaz test karo** से सुनकर देखो।

### क्या काम करता है, क्या नहीं

| | Android Chrome | iPhone Safari |
|---|---|---|
| एक message बोलना | ✅ | ✅ |
| Hands-free loop (mic खुद खुले) | ✅ | ⚠️ हर बार mic दबाना पड़ सकता है |
| बोलकर जवाब | ✅ | ✅ |

iPhone में Apple की सीमा है — Safari back-to-back mic नहीं खोलने देता। वहाँ एक-एक करके बात करनी पड़ेगी, बाकी सब चलेगा।
Desktop Chrome/Edge में भी पूरा loop चलता है — testing के लिए अच्छा है।

### आवाज़ न पकड़े तो

| दिक्कत | इलाज |
|---|---|
| mic शुरू ही नहीं होता | browser में microphone की permission दो (address bar के 🔒 icon से) |
| "Awaaz samajh nahi aayi" | शोर कम करो, फ़ोन के पास बोलो |
| बोलती है पर सुनाई नहीं देता | phone का media volume, silent mode बंद करो |
| पहला शब्द कट जाता है | mic खुलने के बाद 1 सेकंड रुककर बोलो |
| कुछ नहीं समझ आ रहा | Chrome में खोलो — Safari से बेहतर चलता है |

---

---

## Drive connect — एक link, दो tap

Drive tab खोलो। सबसे ऊपर एक **बड़ा हरा link** है — यही सारा काम करता है:

| Link क्या कहता है | मतलब | दबाने पर |
|---|---|---|
| **"पहले client ID बनाओ — link खोलो"** | अभी setup बाकी है | Google Cloud खुलेगा |
| **"Google Drive connect करो"** | client ID है, permission बाकी | Google का पॉपअप → Allow |
| **"मेरी Drive files खोलो"** | जुड़ गया | Drive में `.md` files |

बाकी जगह link हमेशा हाथ में रहता है:

- **App bar** में Drive icon (top-right) — जुड़ा नहीं तो उस पर **!** या **+** का निशान
- Drive tab में **Open Google Cloud credentials** link
- **Step-by-step guide** link (यही गाइड)
- **Google की मदद** link

### पहली बार करना है (2 मिनट)

1. Drive tab → **Open Google Cloud credentials** (या बड़ा link) दबाओ।
2. नया project → **Google Drive API** enable।
3. OAuth consent screen → External → अपना email test user।
4. Credentials → **OAuth client ID** → **Web application**।
5. Authorized JavaScript origin में **copy** बटन दबाओ और paste करो — बस यही: `https://anveshix.github.io`
6. Client ID copy करो → app में **Paste** दबाओ (clipboard से खुद भर जाएगा) → **Save client ID**।
7. अब बड़ा link **"Google Drive connect करो"** हो जाएगा → दबाओ → Allow।

बस। अब किसी भी draft पर **Drive** दबाओ — file Drive में चली जाएगी।

### Link से सीधे screen खोलो

अब हर screen का अपना link है — WhatsApp पर भेज सकते हो, bookmark बना सकते हो:

| Link | खुलेगा |
|---|---|
| `…github.io/Jennie-Voice-agent-/` | Chat |
| `…/#voice` | सीधे voice mode |
| `…/#drive` | Drive connect screen |
| `…/#drafts` | आपके drafts |
| `…/#setup` | Key वाली settings |

और अगली बार app खोलोगे तो **वही screen** खुलेगी जहाँ छोड़ी थी। Phone का **back button** भी सही चलता है — पहले sheet बंद, फिर app से बाहर।

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
