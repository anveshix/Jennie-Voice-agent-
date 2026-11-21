/**
 * Jenni's agent core — the parts worth borrowing from 2026's personal agents,
 * rebuilt for a phone browser with no server, no install and no eval().
 *
 * Ideas ported, and what they became here:
 *   mem0 / Graphiti   → fact memory with importance, confidence and forgetting
 *   Hermes Agent      → skill files that are learned from use and versioned
 *   deep-agents       → plan → act → reflect loop with a scratchpad
 *   OpenClaw / MCP    → a tool registry with permissions, not shell access
 *
 * Everything is plain data in localStorage, so it survives reloads, is visible
 * to the user, and can be wiped by "Erase everything".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_AGENT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MEMORY_KEY = 'jenni_memory_v1';
  const SKILLS_KEY = 'jenni_skills_v1';
  const MAX_FACTS = 120;
  const MAX_SKILLS = 40;

  /* ── text helpers ─────────────────────────────────────────────────────── */

  const STOP = new Set(('a an the and or but if then than that this these those is are was were be been being am '
    + 'do does did doing have has had having i me my mine you your yours he him his she her hers it its we us our '
    + 'they them their to of in on at for with about into over after before from by as so just really very '
    + 'kya hai hain ho mujhe mera meri main tum tumhara aap kar karna karo ka ki ke ko se me bhi nahi haan '
    + 'please pls bhai yaar na ab aur ek').split(' '));

  function normalise(text) {
    return String(text || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(text) {
    return new Set(normalise(text).split(' ').filter((t) => t.length > 2 && !STOP.has(t)));
  }

  /** Jaccard overlap of meaningful words — cheap, explainable, no embeddings. */
  function similarity(a, b) {
    const left = tokens(a);
    const right = tokens(b);
    if (!left.size || !right.size) return 0;
    let shared = 0;
    left.forEach((word) => { if (right.has(word)) shared += 1; });
    return shared / (left.size + right.size - shared);
  }

  /* ── memory: what Jenni keeps about the user ──────────────────────────── */

  const FACT_PATTERNS = [
    { kind: 'name', re: /\b(?:mera naam|my name is|main)\s+([A-Z][\p{L}]{2,20})\s+(?:hoon|hu|hun|hai)\b/u, weight: 0.95 },
    { kind: 'name', re: /\b(?:mera naam|my name is)\s+([A-Z][\p{L}]{2,20})\b/u, weight: 0.95 },
    { kind: 'place', re: /\b(?:main|i live in|i am from|rehta hoon|rehti hoon|se hoon)\s+([\p{L}]{3,20})\s+(?:me|mein|se)\b/u, weight: 0.8 },
    { kind: 'age', re: /\b(?:meri umar|main|i am|i'm)\s+(\d{1,2})\s+(?:saal|years?)\b/u, weight: 0.85 },
    { kind: 'study', re: /\b(class|college|school|university|course|semester|exam)\s*[:：-]?\s*([\p{L}\p{N}][\p{L}\p{N}\s]{1,30})/u, weight: 0.7 },
    { kind: 'goal', re: /\b(i want to|mera goal|mera sapna|i am preparing for|target)\s+([^.!?\n]{4,60})/iu, weight: 0.75 },
    { kind: 'like', re: /\b(mujhe|i)\s+([^.!?\n]{2,30})\s+(?:pasand|like)\b/iu, weight: 0.6 },
    { kind: 'like', re: /\b(?:mera favourite|my favourite|my favorite)\s+([^.!?\n]{2,30})/iu, weight: 0.7 },
    { kind: 'dislike', re: /\b(mujhe|i)\s+([^.!?\n]{2,30})\s+(?:pasand nahi|don't like|do not like)\b/iu, weight: 0.55 },
    { kind: 'language', re: /\b(?:i speak|main)\s+(hindi|english|hinglish|bhojpuri|urdu|marathi|tamil|bengali)\b/iu, weight: 0.8 },
    { kind: 'routine', re: /\b(?:roz|every day|daily|har din)\s+([^.!?\n]{3,40})/iu, weight: 0.55 }
  ];

  function createMemory(store) {
    const read = () => {
      try {
        const raw = store.getItem(MEMORY_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (error) {
        return [];
      }
    };

    const write = (list) => {
      try { store.setItem(MEMORY_KEY, JSON.stringify(list.slice(0, MAX_FACTS))); } catch (error) { /* full */ }
    };

    return {
      all: read,

      /** Pull durable facts out of something the user said. */
      observe(text, source) {
        const value = String(text || '');
        if (!value || value.length > 600) return [];
        const facts = read();
        const found = [];

        FACT_PATTERNS.forEach(({ kind, re, weight }) => {
          const match = value.match(re);
          if (!match) return;
          const detail = (match[2] || match[1] || '').trim();
          if (!detail || detail.length < 2) return;
          const statement = `${kind}: ${detail}`;
          found.push({ kind, text: statement, weight, source: source || 'chat' });
        });

        const fresh = [];
        found.forEach((candidate) => {
          // same kind with a similar value → reinforce instead of duplicating
          const existing = facts.find((fact) => fact.kind === candidate.kind && similarity(fact.text, candidate.text) > 0.55);
          if (existing) {
            existing.hits = (existing.hits || 1) + 1;
            existing.confidence = Math.min(0.99, (existing.confidence || 0.6) + 0.1);
            existing.at = new Date().toISOString();
          } else {
            facts.unshift({
              id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
              kind: candidate.kind,
              text: candidate.text,
              hits: 1,
              confidence: candidate.weight,
              source: candidate.source,
              at: new Date().toISOString()
            });
            fresh.push(candidate.text);
          }
        });

        if (found.length) write(facts);
        return fresh;
      },

      /** Facts worth putting in a prompt right now, most useful first. */
      recall(query, limit) {
        const facts = read();
        const ranked = facts.map((fact) => {
          const ageDays = (Date.now() - Date.parse(fact.at || 0)) / 86400000;
          const freshness = Math.max(0, 1 - ageDays / 180);          // fades over ~6 months
          const relevance = query ? similarity(query, fact.text) : 0.15;
          const score = (fact.confidence || 0.5) * 0.5 + freshness * 0.2
            + relevance * 0.6 + Math.min(0.2, (fact.hits || 1) * 0.05);
          return { fact, score };
        }).sort((a, b) => b.score - a.score);
        return ranked.slice(0, limit || 8).map((entry) => entry.fact);
      },

      forget(id) {
        const facts = read().filter((fact) => fact.id !== id);
        write(facts);
        return facts;
      },

      clear() {
        try { store.removeItem(MEMORY_KEY); } catch (error) { /* ignore */ }
      },

      /** Drop the weakest third once memory is full — mem0-style decay. */
      compact() {
        let facts = read();
        if (facts.length <= MAX_FACTS) return facts;
        facts = facts
          .map((fact) => ({ fact, score: (fact.confidence || 0.5) + Math.min(0.2, (fact.hits || 1) * 0.05) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.floor(MAX_FACTS * 0.7))
          .map((entry) => entry.fact);
        write(facts);
        return facts;
      }
    };
  }

  /* ── skills: reusable procedures learned from real conversations ──────── */

  const SKILL_LIBRARY = [
    {
      id: 'leave-application',
      name: 'Leave application',
      triggers: ['leave', 'chhutti', 'chutti', 'application', 'principal', 'absent', 'holiday'],
      steps: [
        'Date aur karan pakdo (na ho to aaj + "personal reasons")',
        'To / Date / Subject header banao',
        '2 paragraph: request + catch-up promise',
        'Signature block me [Your Full Name], class, roll no.',
        'Download button (.docx) — app khud banayegi'
      ],
      example: 'monday 23/11/2026 ki leave application doc file banao'
    },
    {
      id: 'study-plan',
      name: 'Study plan',
      triggers: ['padhai', 'study', 'exam', 'syllabus', 'revision', 'timetable', 'plan'],
      steps: [
        'Kitna time / kitne din bache hain — poochho ya maan lo',
        'Subjects ko 3 bucket me todo: strong / medium / weak',
        'Har din 2 subject + 1 revision block',
        'Chhota measurable target per block',
        'Ek line: aaj ka pehla kaam kya hai'
      ],
      example: 'exams 20 din baad hain, study plan banao'
    },
    {
      id: 'email-write',
      name: 'Email / message draft',
      triggers: ['email', 'mail', 'message likho', 'draft', 'application bhejo'],
      steps: [
        'Kisko + kya chahiye — 1 line me',
        'Subject line chhoti aur specific',
        'Greeting + 2 short paragraphs + clear ask',
        'Sign-off; tone user ke tone se match kare'
      ],
      example: 'teacher ko assignment extension ke liye email likho'
    },
    {
      id: 'code-help',
      name: 'Coding help',
      triggers: ['code', 'error', 'bug', 'function', 'javascript', 'python', 'repo', 'github'],
      steps: [
        'Kaun si language / kahan error — confirm karo',
        'Sabse chhota reproducible tukda dikho',
        'Fix + kyun chala (1 line)',
        'Test kaise karein — ek command ya step',
        'Bina maange poora project mat likho'
      ],
      example: 'javascript me ye error kyun aa raha hai'
    },
    {
      id: 'mood-support',
      name: 'Mood support',
      triggers: ['udaas', 'sad', 'tension', 'stress', 'pareshan', 'mood', 'akela', 'lonely', 'bore'],
      steps: [
        'Pehle ek line ka validation — salah nahi',
        'Kya hua, chhota sawaal (1 hi)',
        'Ek chhota concrete step jo aaj ho sake',
        'Mazak sirf tab jab user khud halka ho',
        'Serious signal ho to safety pehle, helpline mention'
      ],
      example: 'mood kharab hai kuch samajh nahi aa raha'
    },
    {
      id: 'summarise',
      name: 'Summarise / notes',
      triggers: ['summarise', 'summary', 'notes', 'short me', 'tldr', 'chapter'],
      steps: [
        'Original ka structure bacho, words nahi',
        '3-5 bullet, har bullet ek idea',
        'Ek line me "iska matlab"',
        'Agar document maanga ho to file bana do'
      ],
      example: 'is chapter ka summary banao'
    },
    {
      id: 'daily-plan',
      name: 'Day plan',
      triggers: ['aaj ka plan', 'din plan', 'schedule', 'kya karun', 'to-do', 'todo'],
      steps: [
        'Kitne ghante free hain — maan lo 4',
        '3 kaam: 1 zaroori, 1 useful, 1 easy win',
        'Har kaam ka time block',
        'Neeche ek line: "pehle ye karo"'
      ],
      example: 'aaj ka plan banao, 4 ghante free hain'
    }
  ];

  function createSkills(store) {
    const readCustom = () => {
      try {
        const raw = store.getItem(SKILLS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (error) {
        return [];
      }
    };

    const writeCustom = (list) => {
      try { store.setItem(SKILLS_KEY, JSON.stringify(list.slice(0, MAX_SKILLS))); } catch (error) { /* full */ }
    };

    function match(text) {
      const normal = ' ' + normalise(text) + ' ';
      const scored = SKILL_LIBRARY.concat(readCustom()).map((skill) => {
        const hits = (skill.triggers || []).filter((trigger) => normal.includes(' ' + normalise(trigger) + ' ')
          || normal.includes(normalise(trigger)));
        return { skill, score: hits.length };
      }).filter((entry) => entry.score > 0);
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 2).map((entry) => entry.skill);
    }

    /** If the model produced a new reusable procedure, keep it — versioned. */
    function learn(definition) {
      if (!definition || !definition.name || !Array.isArray(definition.steps) || !definition.steps.length) return null;
      const custom = readCustom();
      const normalisedName = normalise(definition.name);
      const existing = custom.find((skill) => normalise(skill.name) === normalisedName);
      if (existing) {
        existing.version = (existing.version || 1) + 1;
        existing.steps = definition.steps.slice(0, 10).map((step) => String(step).slice(0, 200));
        existing.updatedAt = new Date().toISOString();
        writeCustom(custom);
        return existing;
      }
      const skill = {
        id: 's' + Date.now().toString(36),
        name: String(definition.name).slice(0, 60),
        triggers: (definition.triggers || [definition.name]).slice(0, 8).map((trigger) => String(trigger).slice(0, 40)),
        steps: definition.steps.slice(0, 10).map((step) => String(step).slice(0, 200)),
        learned: true,
        source: 'learned',
        version: 1,
        createdAt: new Date().toISOString()
      };
      writeCustom([skill].concat(custom));
      return skill;
    }

    return {
      all: () => SKILL_LIBRARY.concat(readCustom()),
      builtIn: () => SKILL_LIBRARY.slice(),
      custom: readCustom,
      match,
      learn,
      remove(id) {
        writeCustom(readCustom().filter((skill) => skill.id !== id));
      },
      clear() {
        try { store.removeItem(SKILLS_KEY); } catch (error) { /* ignore */ }
      }
    };
  }

  /* ── tools: a registry, not a shell ───────────────────────────────────── */

  function createTools(handlers) {
    const registry = new Map();
    Object.entries(handlers || {}).forEach(([name, definition]) => {
      registry.set(name, Object.assign({ name, permission: 'safe' }, definition));
    });

    return {
      list: () => Array.from(registry.values()).map((tool) => ({
        name: tool.name, description: tool.description, permission: tool.permission
      })),
      has: (name) => registry.has(name),
      /** Every call is validated and can be refused by permission. */
      async call(name, args) {
        const tool = registry.get(name);
        if (!tool) throw new Error(`Tool "${name}" nahi hai.`);
        if (tool.permission === 'blocked') throw new Error(`Tool "${name}" allowed nahi hai.`);
        const payload = tool.validate ? tool.validate(args || {}) : (args || {});
        return tool.run(payload);
      }
    };
  }

  /**
   * Turn a finished question+answer pair into something reusable.
   * Only answers that actually read like a procedure are kept — a chat that
   * merely says "theek hai" teaches nothing.
   */
  function skillFrom(question, answer) {
    const q = String(question || '').trim();
    const text = String(answer || '').trim();
    if (q.length < 8 || text.length < 120) return null;
    const numbered = text.split(/\n+/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((line) => line.length > 12 && line.length < 220);
    if (numbered.length < 2) return null;
    return {
      name: q.slice(0, 60),
      triggers: q.split(/\s+/).filter((w) => w.length > 3).slice(0, 6),
      steps: numbered.slice(0, 5)
    };
  }

  /* ── the loop: plan → act → reflect, with a bounded step budget ───────── */

  async function run(options) {
    const {
      question,
      memory,
      skills,
      tools,
      maxSteps = 2,
      callModel,          // async (messages) => text
      onStep = () => {}
    } = options;

    const steps = [];
    const usedSkills = skills ? skills.match(question) : [];
    const recalled = memory ? memory.recall(question, 8) : [];

    const context = {
      question,
      recalled,
      skills: usedSkills
    };
    steps.push({ phase: 'recall', detail: `${recalled.length} fact, ${usedSkills.length} skill` });

    if (tools) {
      const available = tools.list();
      if (available.length) context.tools = available;
    }

    let answer = await callModel(context);
    steps.push({ phase: 'answer', detail: 'first pass' });

    // reflect: only if the answer looks thin, and only within the budget
    for (let i = 0; i < maxSteps; i += 1) {
      const critique = critiqueAnswer(answer, question);
      steps.push({ phase: 'reflect', detail: critique.reason });
      if (critique.ok) break;
      onStep({ phase: 'improve', detail: critique.reason });
      answer = await callModel(Object.assign({}, context, { draft: answer, fix: critique.reason }));
      steps.push({ phase: 'improve', detail: 'second pass' });
    }

    return { answer, steps, facts: recalled, skills: usedSkills };
  }

  /** Cheap self-check: is this reply worth sending, or obviously too thin? */
  const SMALL_TALK = /^(hi|hey|hello|namaste|namaskar|salaam|good (morning|evening|afternoon)|kaise ho|kya haal|thanks|thank you|shukriya|dhanyavad|ok|okay|theek hai|haan|ji|bye)\b/i;

  function critiqueAnswer(answer, question) {
    const text = String(answer || '').trim();
    const q = String(question || '').trim();
    if (!text) return { ok: false, reason: 'jawab khali hai' };
    /* Chhoti baat, chhota jawab. A greeting or a thank-you answered in one
       line is correct — spending a second API call to "improve" it is waste. */
    if (SMALL_TALK.test(q) && q.length < 40) return { ok: true, reason: 'chhoti baat' };
    if (text.length < 12) return { ok: false, reason: 'jawab bahut chhota hai' };
    const refuses = /(cannot|can ?not|not able to|nahi bana sakti|nahi bana sakta|nahi kar sakti|nahi kar sakta|nahi de sakti|nahi de sakta|man kar rahi|mana kar rahi)/i.test(text);
    if (refuses && /file|download|doc|application|letter|cv|resume|pdf|word/i.test(q)) {
      return { ok: false, reason: 'file ke liye mana kar diya' };
    }
    if (/^#{1,6}\s/m.test(question) && !/[\n]/.test(text)) return { ok: false, reason: 'structure missing' };
    const asksSteps = /\b(kya karun|kaise|how do|plan|steps|tarika)\b/i.test(question);
    if (asksSteps && text.length < 80 && !/\d/.test(text)) {
      return { ok: false, reason: 'plan jaise sawaal ka jawab adhura' };
    }
    return { ok: true, reason: 'theek hai' };
  }

  return {
    MEMORY_KEY, SKILLS_KEY, SKILL_LIBRARY,
    createMemory, createSkills, createTools, run, critiqueAnswer, skillFrom,
    similarity, tokens, normalise
  };
});
