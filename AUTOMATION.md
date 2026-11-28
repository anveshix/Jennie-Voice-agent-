# Jenni Automation (always-on)

Runs inside `npm start` (`server.js`). Works with the phone off. Zero dependencies.

## Setup (5 min)
1. Deploy: `docker compose up -d` (or `deploy/jenni.service`). Set `.env`: `AI_API_KEY`, `JENNI_ACCESS_TOKEN`, `JENNI_DATA_KEY`.
2. Telegram: @BotFather → token → app *Connections* → pair your chat. Only that chat is obeyed.
3. Optional Google (Gmail/Calendar/Sheets): add `GOOGLE_*` to `.env`.
4. Open `/auto` for approvals, schedule, runs.

## Autonomy tiers
| Tier | Actions |
|---|---|
| auto | read, draft, save file, Drive upload, Gmail **draft**, message to yourself |
| approve (one tap) | Gmail send, group posts, calendar write, share, delete |
| never | portal submit, payment, signature, login, OTP |

Standing rules (`autonomy.addRule('gmail_send', {to:'staff@school.in'})`) skip approval for narrow, exact matches. `never` cannot be overridden.

## Recipes / schedule (IST)
| Recipe | When | Does |
|---|---|---|
| `daily_briefing` | 07:00 | tasks, calendar, unread count → Telegram |
| `inbox_triage` | every 30 min, 07–20 | classify mail → tasks / reply **drafts** / ignore |
| `weekly_backup` | Sun 21:00 | state → Drive (student data stays encrypted) |
| `sa1_results` | on demand | CSV → analysis → remedial plan → bilingual circular → QA → save/Drive → Telegram → (email, approval) |

## Telegram
`/brief /tasks /add /done /inbox /approvals /approve /reject /runs /jobs /backup /retry`
Send marks CSV with caption `/sa1 SA1 XI-Commerce`. Voice notes are transcribed (needs `AI_TRANSCRIPTION_MODEL`). Other text → chat.

## Safeguards
- S1/S4/S5 gate (`automation/qa.js`): bilingual check, UDISE 20140300204 footer/validation, PII redaction. Failing QA stops the run.
- Student marks: AES-256-GCM in `storage/automation.json`; raw CSV is dropped from run logs; outputs use roll numbers only.
- Mail bodies are untrusted: only a never-sent draft is produced from them.
- Runs persist; unfinished runs resume after restart; failures notify with `/retry <id>`.

## Still human (by design)
CBSE/UDISE+/APAAR portal entry, signatures, payments, OTP/login. Jenni prepares the data; you submit.
