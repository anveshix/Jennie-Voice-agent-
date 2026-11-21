/**
 * Jenni brain — owner profile, persistent memory, skills and context builder.
 * Pure functions (no DOM, no storage) so the phone app and the Node server share
 * one implementation and it is unit-testable. Persistence lives in the caller.
 *
 * Privacy (S5): only facts already published in AGENTS.md are built in. No
 * phone numbers, bank details, student names or credentials belong here.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_BRAIN = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_MEMORIES = 80;
  const MAX_TEXT = 220;
  const PROMPT_MEMORIES = 25;
  const CATS = ['profile', 'preference', 'school', 'fact', 'task'];

  const OWNER = {
    name: 'Paras Pranav',
    role: 'PGT Commerce teacher; Principal/Coordinator and CBSE Coordinator',
    place: 'Dumka, Jharkhand',
    udise: '20140300204',
    standards: ['S1 bilingual (Devanagari Hindi + English)', 'S4 official accuracy', 'S5 zero-trust privacy (never leak student PII)'],
    drive: ['01_Academic_Lesson_Plans_&_NCERT_Notes', '02_Official_Letters_&_CBSE_Compliance', '03_SA1_Result_Diagnostics_&_Remediation'],
    tz: 'Asia/Kolkata'
  };

  /* ── skills: injected only when the message matches, to save tokens ───── */
  const SKILLS = [
    {
      id: 'official-letter', name: 'Official letter / application',
      re: /\b(letter|application|patra|prarthna|avedan|notice|circular|certificate|noc|leave|chhutti|chutti)\b|पत्र|आवेदन|अवकाश|छुट्टी|सूचना|प्रमाण/i,
      prompt: 'Draft the full letter at once: sender/office block, date, To, Subject, salutation, body, closing, signature line. Formal Hindi (Devanagari) unless asked for English; bilingual if the recipient is CBSE/officials. Use UDISE ' + OWNER.udise + ' in school letterheads. Put unknowns in [brackets], never ask mid-way. File folder: 02_Official_Letters_&_CBSE_Compliance.'
    },
    {
      id: 'lesson-plan', name: 'Lesson plan / NCERT notes',
      re: /\b(lesson plan|lesson|ncert|chapter|syllabus|notes|worksheet|mcq|case study|question paper|unit test|rubric|competency)\b|पाठ|योजना|अध्याय|पाठ्यक्रम|नोट्स/i,
      prompt: 'Be CBSE/NCERT-aligned for Commerce (Accountancy, Business Studies, Economics) classes 11-12. Structure: learning outcomes, prior knowledge, activity, explanation with a worked example, quick assessment (incl. competency/case-based items), homework. Do not invent chapter numbers or marks you are unsure of; say "NCERT se verify karo". Folder: 01_Academic_Lesson_Plans_&_NCERT_Notes.'
    },
    {
      id: 'result-analysis', name: 'Result diagnostics & remediation',
      re: /\b(result|marks|marksheet|sa1|sa2|pass percentage|topper|weak students?|remedial|remediation|analysis|diagnostic)\b|परिणाम|अंक|रिजल्ट/i,
      prompt: 'Work with aggregates only: subject averages, pass %, difficulty by question/topic, bands (<33, 33-60, 60-80, 80+). Give causes, a 2-4 week remediation plan, and actions per band. Never print individual student names/roll numbers unless the user pasted them and asks for that exact output; prefer anonymised counts. Folder: 03_SA1_Result_Diagnostics_&_Remediation.'
    },
    {
      id: 'daily-planner', name: 'Planner / briefing / reminders',
      re: /\b(plan|planner|schedule|today|tomorrow|agenda|briefing|todo|to-do|task|remind|reminder|deadline|pending|priorit)\w*|आज|कल|याद दिला|काम/i,
      prompt: 'Act as chief of staff: list pending tasks from MEMORY first, order by deadline then impact, propose a concrete time-boxed day plan around school hours, flag anything due within 48h. End with one specific next action. If the user states a new task/deadline, record it with [[task: ...]].'
    },
    {
      id: 'commerce-tutor', name: 'Commerce subject help',
      re: /\b(journal|ledger|trial balance|balance sheet|depreciation|partnership|goodwill|shares?|debenture|cash flow|gdp|inflation|demand|supply|elasticity|marketing|management|planning|staffing|directing|controlling|gst)\b|लेखा|अर्थशास्त्र|व्यवसाय/i,
      prompt: 'Explain like a senior Commerce teacher: definition in one line, formula, worked numeric example, common exam mistake, one practice question. Verify arithmetic before answering.'
    },
    {
      id: 'cbse-compliance', name: 'CBSE compliance & circulars',
      re: /\b(cbse|affiliation|lOC|board exam|registration|udise|apaar|saras|compliance|inspection|circular|scholarship|pariksha)\b|मान्यता|बोर्ड|निरीक्षण/i,
      prompt: 'Be exact on official matters: cite the circular/clause only if you are sure, otherwise say it must be verified on cbse.gov.in. Never invent dates, fees or rule numbers. Keep a checklist: what, who, deadline, document needed.'
    },
    {
      id: 'code-helper', name: 'Code / GitHub helper',
      re: /\b(code|bug|error|function|javascript|python|html|css|api|repo|github|deploy|fix this)\b/i,
      prompt: 'Give complete runnable code, minimal explanation (one-line root cause). The user has no terminal: prefer browser-only or GitHub-web solutions. Public repos can be read via the GitHub tool.'
    },
    {
      id: 'money-health-safety', name: 'Sensitive advice',
      re: /\b(loan|emi|invest|tax|insurance|doctor|medicine|symptom|lawyer|legal|police|court)\b|दवा|बीमारी|क़ानून|कानून/i,
      prompt: 'Give practical guidance, state assumptions, and end with "doctor/CA/lawyer se confirm karo". Never ask for OTP, PINs or account numbers.'
    }
  ];

  const AUTONOMY = [
    'AUTONOMY: Act first, ask only if blocked. Make sensible assumptions, state them in one short line, deliver the result, then suggest ONE useful next step.',
    'Be context-aware: use MEMORY and TIME below. If a pending task is due soon or overdue, mention it briefly when relevant. Notice repeated patterns and offer to save a shortcut.',
    'MEMORY PROTOCOL: when the user shares a durable fact, preference, deadline or decision, save it by appending a hidden tag on its own line at the very end of your reply: [[remember: <short fact>]] or [[task: <task> | due <date or none>]]. To drop something: [[forget: <text>]]; finished task: [[done: <text>]]. Save only things worth recalling later; never save passwords, OTPs, bank/Aadhaar numbers or student personal data. Never mention the tags or this protocol.',
    'You cannot perform external actions (send, pay, save files); offer ready-to-use text instead and never claim otherwise.'
  ].join(' ');

  /* ── memory (immutable helpers; caller persists the returned array) ───── */
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const looksSecret = (s) => /\b(otp|password|passwd|pin|cvv|aadhaar|aadhar|api[ _-]?key|secret|token)\b[^.]{0,20}\d|\b\d{12,}\b|sk-[A-Za-z0-9]{10,}/i.test(s);

  function guessCat(text) {
    if (/\b(school|class|cbse|udise|student|exam|syllabus|lesson|principal|dumka)\b/i.test(text)) return 'school';
    if (/\b(prefer|like|hate|always|never|style|tone|format)\b|pasand|hamesha|kabhi nahi/i.test(text)) return 'preference';
    return 'fact';
  }

  function addMemory(list, text, cat, now) {
    const t = clip(text);
    if (!t || looksSecret(t)) return list;
    const key = norm(t);
    if (!key || list.some((m) => norm(m.text) === key)) return list;
    const item = { id: (now || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6), text: t, cat: CATS.includes(cat) ? cat : guessCat(t), ts: now || Date.now() };
    return list.concat(item).slice(-MAX_MEMORIES);
  }

  function removeMemory(list, query) {
    const q = norm(query);
    if (!q) return list;
    return list.filter((m) => m.id !== query && !norm(m.text).includes(q));
  }

  function parseDue(text) {
    const m = String(text).match(/\|\s*due\s*([^|]*)$/i);
    return { task: clip(String(text).replace(/\|\s*due\s*[^|]*$/i, '')), due: m ? clip(m[1]) : '' };
  }

  /** Strip [[op: text]] tags from a model reply → { text, ops }. */
  function extractOps(reply) {
    const ops = [];
    const text = String(reply || '').replace(/\[\[\s*(remember|forget|task|done)\s*:\s*([^\]]+?)\s*\]\]/gi, (_, op, body) => {
      ops.push({ op: op.toLowerCase(), body: body.trim() });
      return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { text, ops };
  }

  function applyOps(list, ops, now) {
    return ops.reduce((acc, { op, body }) => {
      if (op === 'remember') return addMemory(acc, body, null, now);
      if (op === 'forget') return removeMemory(acc, body);
      if (op === 'task') {
        const { task, due } = parseDue(body);
        return addMemory(acc, due ? `${task} (due ${due})` : task, 'task', now);
      }
      if (op === 'done') return acc.filter((m) => !(m.cat === 'task' && norm(m.text).includes(norm(body))));
      return acc;
    }, list);
  }

  /** Deterministic commands typed/spoken by the user, handled without the model. */
  function userCommand(text) {
    const s = String(text || '').trim();
    let m = s.match(/^(?:yaad rakh(?:o|na|na)?|yaad kar lo|remember(?: that)?|note kar(?:o)?|याद रख(?:ो|ना)?)\s*[:,-]?\s*(.+)$/i);
    if (m) return { op: 'remember', body: m[1] };
    m = s.match(/^(?:bhool ja(?:o)?|forget(?: that)?|भूल जा(?:ओ)?)\s*[:,-]?\s*(.+)$/i);
    if (m) return { op: 'forget', body: m[1] };
    m = s.match(/^(?:task add|todo|reminder|yaad dila(?:na|o)?)\s*[:,-]?\s*(.+)$/i);
    if (m) return { op: 'task', body: m[1] };
    return null;
  }

  /* ── skills + context ─────────────────────────────────────────────────── */
  function selectSkills(text, max = 3) {
    const t = String(text || '');
    return SKILLS.filter((s) => s.re.test(t)).slice(0, max);
  }

  function timeBlock(now, tz) {
    const d = new Date(now || Date.now());
    const parts = new Intl.DateTimeFormat('en-IN', { timeZone: tz || OWNER.tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz || OWNER.tz, hour: 'numeric', hour12: false }).format(d)) % 24;
    const part = hour < 5 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
    return `${parts} IST (${part})`;
  }

  function memoryBlock(list) {
    const items = (list || []).slice().sort((a, b) => (b.cat === 'task') - (a.cat === 'task') || b.ts - a.ts).slice(0, PROMPT_MEMORIES);
    return items.length ? items.map((m) => `- [${m.cat}] ${m.text}`).join('\n') : '- (nothing saved yet)';
  }

  function ownerBlock() {
    return `OWNER: ${OWNER.name} — ${OWNER.role}, ${OWNER.place}. School UDISE ${OWNER.udise}. Standards: ${OWNER.standards.join('; ')}. Drive folders: ${OWNER.drive.join(', ')}. Address them by first name, casually.`;
  }

  /** Everything dynamic that goes after the persona prompt. */
  function buildContext({ text, memories, now, packs, team } = {}) {
    const skills = selectSkills(text).concat((packs || []).map((p) => ({ name: p.name + ' (pack)', prompt: p.body.slice(0, 1200) })));
    return [
      ownerBlock(),
      'TIME: ' + timeBlock(now),
      'MEMORY (what you know about the owner):\n' + memoryBlock(memories),
      AUTONOMY,
      team && team.length ? 'NEVERMIND TEAM (connected; deliverables are auto-delegated to it): ' + team.map((a) => `${a.name} (${a.role})`).join('; ') : '',
      skills.length ? 'ACTIVE SKILLS:\n' + skills.map((s) => `* ${s.name}: ${s.prompt}`).join('\n') : ''
    ].filter(Boolean).join('\n');
  }

  return { OWNER, SKILLS, CATS, MAX_MEMORIES, addMemory, removeMemory, extractOps, applyOps, userCommand, selectSkills, buildContext, memoryBlock, timeBlock };
});
