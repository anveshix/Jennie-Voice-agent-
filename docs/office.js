/**
 * Jenni Office Desk — the routine paperwork of a school admin / teacher / office
 * staff, produced deterministically (instant, offline, same format every time):
 * notice, circular, official letter, application, e-mail, note-sheet, duty
 * roster (deployment routine) and class routine (timetable).
 *
 * The roster and timetable are real constraint solvers with a validator, not
 * model text, so a double-booked teacher cannot slip through. The model is only
 * used afterwards, on request, to polish wording or translate.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_OFFICE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HI_MONTHS = ['जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
  const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAYS_HI = ['सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'];

  const SCHOOL_DEFAULT = { name: '', address: '', affiliation: '', udise: '20140300204', principal: 'Paras Pranav', designation: 'Principal', place: 'Dumka', counter: 0 };

  const LABELS = {
    hi: { subject: 'विषय', date: 'दिनांक', ref: 'संदर्भ सं.', to: 'सेवा में', sir: 'महोदय/महोदया,', yours: 'भवदीय,', notice: 'सूचना', circular: 'परिपत्र', copy: 'प्रतिलिपि', encl: 'संलग्नक', udise: 'यू-डायस', aff: 'संबद्धता सं.', issuedBy: 'जारीकर्ता', applicant: 'आवेदक', obed: 'आपका आज्ञाकारी,' },
    en: { subject: 'Subject', date: 'Date', ref: 'Ref. No.', to: 'To', sir: 'Sir/Madam,', yours: 'Yours faithfully,', notice: 'NOTICE', circular: 'CIRCULAR', copy: 'Copy to', encl: 'Enclosures', udise: 'UDISE', aff: 'Affiliation No.', issuedBy: 'Issued by', applicant: 'Applicant', obed: 'Yours obediently,' }
  };
  const L = (lang) => LABELS[lang === 'en' ? 'en' : 'hi'];
  const bi = (lang, hi, en) => (lang === 'bi' ? `${hi} / ${en}` : lang === 'en' ? en : hi);

  /* ── helpers ──────────────────────────────────────────────────────────── */
  function istParts(now) {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(now || Date.now())).split('-').map(Number);
    return { y, m, d };
  }
  function dateStr(now, lang) {
    const { y, m, d } = istParts(now);
    return lang === 'en' ? `${d} ${EN_MONTHS[m - 1]} ${y}` : `${d} ${HI_MONTHS[m - 1]} ${y}`;
  }
  function session(now) {
    const { y, m } = istParts(now);
    const start = m >= 4 ? y : y - 1;
    return `${start}-${String(start + 1).slice(2)}`;
  }
  function abbr(name) {
    const letters = String(name || '').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !/^(of|the|and|school|vidyalaya)$/i.test(w)).map((w) => w[0].toUpperCase()).join('');
    return letters.slice(0, 5) || 'SCH';
  }
  const refNo = (school, kind, n, now) => `${abbr(school.name)}/${session(now)}/${kind}/${n}`;
  const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const para = (s) => lines(s).join('\n\n');
  const num = (s) => lines(s).map((x, i) => `${i + 1}. ${x.replace(/^\d+[.)]\s*/, '')}`).join('\n');

  function letterhead(school, lang) {
    const t = L(lang);
    const meta = [school.address, school.udise ? `${t.udise}: ${school.udise}` : '', school.affiliation ? `${t.aff}: ${school.affiliation}` : ''].filter(Boolean).join(' | ');
    return [`# ${(school.name || '[School name]').toUpperCase()}`, meta || '[Address | UDISE | Affiliation]', ''];
  }
  function refLine(school, kind, ctx, lang) {
    const t = L(lang);
    return `${t.ref}: ${refNo(school, kind, ctx.n, ctx.now)}        ${t.date}: ${ctx.date || dateStr(ctx.now, lang)}`;
  }
  const signBlock = (school, lang) => ['', '', `(${school.principal || '[Name]'})`, school.designation || 'Principal', (school.name || '[School name]') + (school.place ? ', ' + school.place : '')].join('\n');

  /* ── document builders: (values, school, ctx) → { title, text } ───────── */
  const BUILD = {
    notice(v, school, ctx) {
      const lang = v.lang || 'hi', t = L(lang);
      const text = [
        ...letterhead(school, lang), refLine(school, 'NTC', ctx, lang), '',
        `## ${bi(lang, 'सूचना', 'NOTICE')}`, '',
        `**${t.subject}:** ${v.subject || '[Subject]'}`, '',
        v.audience ? `${bi(lang, 'संबंधित', 'For')}: ${v.audience}` : '',
        v.when ? `${bi(lang, 'तिथि/समय', 'Date/Time')}: ${v.when}` : '',
        v.venue ? `${bi(lang, 'स्थान', 'Venue')}: ${v.venue}` : '', '',
        v.body ? num(v.body) : '[Details]', '',
        v.cc ? `${t.copy}: ${v.cc}` : '', signBlock(school, lang)
      ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
      return { title: `Notice - ${v.subject || ''}`.trim(), text };
    },
    circular(v, school, ctx) {
      const lang = v.lang || 'hi', t = L(lang);
      const text = [
        ...letterhead(school, lang), refLine(school, 'CIR', ctx, lang), '',
        `## ${bi(lang, 'परिपत्र', 'CIRCULAR')}`, '',
        `**${t.subject}:** ${v.subject || '[Subject]'}`, '',
        v.refTo ? `${bi(lang, 'संदर्भ', 'Reference')}: ${v.refTo}` : '', '',
        para(v.body) || '[Body]', '',
        bi(lang, 'सभी संबंधित से अनुरोध है कि उपरोक्त का अनुपालन सुनिश्चित करें।', 'All concerned are requested to ensure compliance.'), '',
        v.cc ? `${t.copy}: ${v.cc}` : '', signBlock(school, lang)
      ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
      return { title: `Circular - ${v.subject || ''}`.trim(), text };
    },
    letter(v, school, ctx) {
      const lang = v.lang || 'hi', t = L(lang);
      const text = [
        ...letterhead(school, lang), refLine(school, 'LTR', ctx, lang), '',
        `${t.to},`, lines(v.to).join('\n') || '[Designation, Office, Place]', '',
        `**${t.subject}:** ${v.subject || '[Subject]'}`, '',
        v.refTo ? `${bi(lang, 'संदर्भ', 'Reference')}: ${v.refTo}\n` : '',
        t.sir, '', para(v.body) || '[Body]', '', t.yours, signBlock(school, lang), '',
        v.encl ? `${t.encl}: ${v.encl}` : '', v.cc ? `${t.copy}: ${v.cc}` : ''
      ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
      return { title: `Letter - ${v.subject || ''}`.trim(), text };
    },
    application(v, school, ctx) {
      const lang = v.lang || 'hi', t = L(lang);
      const text = [
        `${t.to},`, lines(v.to).join('\n') || `${school.designation || 'Principal'}, ${school.name || '[School]'}`, '',
        `**${t.subject}:** ${v.subject || '[Subject]'}`, '', t.sir, '', para(v.body) || '[Body]', '',
        bi(lang, 'कृपया उपरोक्त पर सहानुभूतिपूर्वक विचार कर स्वीकृति प्रदान करने की कृपा करें।', 'I request you to kindly consider and grant the same.'), '',
        t.obed, v.name || '[Name]', v.role || '', `${t.date}: ${ctx.date || dateStr(ctx.now, lang)}`
      ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
      return { title: `Application - ${v.subject || ''}`.trim(), text };
    },
    email(v, school) {
      const tone = v.tone || 'formal';
      const open = { formal: 'Respected Sir/Madam,', polite: 'Dear Sir/Madam,', firm: 'Dear Sir/Madam,' }[tone] || 'Dear Sir/Madam,';
      const close = { formal: 'Thanking you,\nYours sincerely,', polite: 'With regards,', firm: 'Kindly treat this as urgent.\nRegards,' }[tone] || 'Regards,';
      const text = [
        `To: ${v.to || '[recipient]'}`, v.cc ? `Cc: ${v.cc}` : '', `Subject: ${v.subject || '[Subject]'}`, '',
        open, '', para(v.body) || '[Body]', '', close, school.principal || '[Name]', school.designation || '', school.name || ''
      ].filter((x, i, a) => !(x === '' && a[i - 1] === '' )).join('\n');
      return { title: `Mail - ${v.subject || ''}`.trim(), text };
    },
    notesheet(v, school, ctx) {
      const lang = v.lang || 'bi';
      const nil = bi(lang, 'लागू नहीं', 'Nil');
      const sec = (n, hi, en, body) => `**${n}. ${bi(lang, hi, en)}**\n${body && body.trim() ? para(body) : nil}`;
      const text = [
        `# ${bi(lang, 'टिप्पणी पत्रक', 'NOTE SHEET')}`,
        `${bi(lang, 'फाइल सं.', 'File No.')}: ${refNo(school, 'NS', ctx.n, ctx.now)}        ${L(lang === 'en' ? 'en' : 'hi').date}: ${ctx.date || dateStr(ctx.now, lang === 'en' ? 'en' : 'hi')}`, '',
        `**${bi(lang, 'विषय', 'Subject')}:** ${v.subject || '[Subject]'}`, '',
        sec(1, 'पृष्ठभूमि', 'Background', v.background), '',
        sec(2, 'नियम / संदर्भ', 'Rules / Reference', v.rules), '',
        sec(3, 'प्रस्ताव', 'Proposal', v.proposal), '',
        sec(4, 'वित्तीय प्रभाव', 'Financial implication', v.finance), '',
        `**5. ${bi(lang, 'अनुमोदन हेतु', 'For approval')}**`,
        bi(lang, 'उपरोक्त प्रस्ताव कृपया अनुमोदन हेतु प्रस्तुत है।', 'The above proposal is submitted for kind approval.'), '',
        `${bi(lang, 'प्रस्तुतकर्ता', 'Put up by')}: ${v.by || '[Name, Designation]'}        ${bi(lang, 'दिनांक', 'Date')}: ${ctx.date || dateStr(ctx.now, 'en')}`, '',
        `${bi(lang, 'अनुशंसित', 'Recommended')}: ____________________`, '',
        `${bi(lang, 'अनुमोदित / अनुमोदित नहीं', 'Approved / Not approved')}: ____________________`,
        `(${school.principal || '[Name]'}), ${school.designation || 'Principal'}`
      ].join('\n');
      return { title: `Note sheet - ${v.subject || ''}`.trim(), text };
    },
    roster(v, school, ctx) {
      const lang = v.lang || 'hi';
      const r = solveRoster({ staff: lines(v.staff), duties: parseDuties(v.duties), days: selectedDays(v.days), unavailable: parseUnavailable(v.unavailable) });
      const text = [
        ...letterhead(school, lang), refLine(school, 'DTY', ctx, lang), '',
        `## ${bi(lang, 'ड्यूटी रोस्टर / डिप्लॉयमेंट रूटीन', 'DUTY ROSTER / DEPLOYMENT ROUTINE')}`,
        v.week ? `${bi(lang, 'अवधि', 'Period')}: ${v.week}` : '', '', r.table, '',
        `**${bi(lang, 'कुल ड्यूटी (निष्पक्षता जाँच)', 'Duty load (fairness check)')}**`, r.loadTable,
        r.warnings.length ? `\n**${bi(lang, 'चेतावनी', 'Warnings')}**\n` + r.warnings.map((w) => `- ${w}`).join('\n') : '', '',
        bi(lang, 'सभी संबंधित कर्मचारी अपनी ड्यूटी समय पर करना सुनिश्चित करें। ड्यूटी बदलने हेतु पूर्व अनुमति आवश्यक है।', 'All staff must report on time for their duty. Prior permission is required for any swap.'),
        signBlock(school, lang)
      ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
      return { title: 'Duty roster', text, meta: r };
    },
    routine(v, school, ctx) {
      const lang = v.lang || 'hi';
      const r = solveTimetable({ periods: Number(v.periods) || 8, days: Number(v.daysCount) || 6, lessons: parseLessons(v.lessons), breakAfter: Number(v.breakAfter) || 4 });
      const text = [
        ...letterhead(school, lang), refLine(school, 'RTN', ctx, lang), '',
        `## ${bi(lang, 'कक्षा रूटीन / समय सारणी', 'CLASS ROUTINE / TIME TABLE')}`,
        `${bi(lang, 'सत्र', 'Session')}: ${session(ctx.now)}`, '', r.text,
        r.warnings.length ? '\n**' + bi(lang, 'चेतावनी', 'Warnings') + '**\n' + r.warnings.map((w) => `- ${w}`).join('\n') : '',
        signBlock(school, lang)
      ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
      return { title: 'Class routine', text, meta: r };
    }
  };

  /* ── duty roster solver ───────────────────────────────────────────────── */
  function selectedDays(spec) {
    const s = String(spec || 'Mon-Sat');
    const m = s.match(/^(Mon|Tue|Wed|Thu|Fri|Sat)\s*-\s*(Mon|Tue|Wed|Thu|Fri|Sat)$/i);
    if (m) {
      const a = DAYS.findIndex((d) => d.toLowerCase() === m[1].toLowerCase()), b = DAYS.findIndex((d) => d.toLowerCase() === m[2].toLowerCase());
      return DAYS.slice(a, b + 1);
    }
    const picked = DAYS.filter((d) => new RegExp('\\b' + d + '\\b', 'i').test(s));
    return picked.length ? picked : DAYS.slice();
  }
  function parseDuties(text) {
    return lines(text).map((l) => { const [name, c] = l.split('|').map((x) => x.trim()); return { name, count: Math.max(1, Number(c) || 1) }; });
  }
  function parseUnavailable(text) {   // "Name: Mon, Tue"
    const out = {};
    lines(text).forEach((l) => {
      const [name, days] = l.split(':');
      if (name && days) out[name.trim().toLowerCase()] = DAYS.filter((d) => new RegExp('\\b' + d + '\\b', 'i').test(days));
    });
    return out;
  }

  function solveRoster({ staff, duties, days, unavailable }) {
    const total = {}, lastOn = {}, grid = {}, warnings = [];
    staff.forEach((s) => { total[s] = 0; lastOn[s] = {}; });
    if (!staff.length || !duties.length) warnings.push('Staff ya duties list khali hai.');
    days.forEach((day, di) => {
      grid[day] = {};
      const usedToday = new Set();
      duties.forEach((duty) => {
        grid[day][duty.name] = [];
        for (let k = 0; k < duty.count; k += 1) {
          const free = staff.filter((s) => !(unavailable[s.toLowerCase()] || []).includes(day));
          let pool = free.filter((s) => !usedToday.has(s) && !grid[day][duty.name].includes(s));
          if (!pool.length) { pool = free.filter((s) => !grid[day][duty.name].includes(s)); if (pool.length) warnings.push(`${day}: ${duty.name} ke liye ek vyakti ko do duty di gayi (staff kam).`); }
          if (!pool.length) { grid[day][duty.name].push('—'); warnings.push(`${day}: ${duty.name} ke liye koi staff uplabdh nahi.`); continue; }
          // fairness first, then rotation (longest since this duty), then name order
          pool.sort((a, b) => total[a] - total[b] || (lastOn[a][duty.name] ?? -99) - (lastOn[b][duty.name] ?? -99) || a.localeCompare(b));
          const pick = pool[0];
          grid[day][duty.name].push(pick); usedToday.add(pick); total[pick] += 1; lastOn[pick][duty.name] = di;
        }
      });
    });
    const head = `| Duty | ${days.join(' | ')} |`;
    const sep = `|${'---|'.repeat(days.length + 1)}`;
    const rows = duties.map((d) => `| ${d.name} | ${days.map((day) => grid[day][d.name].join(', ')).join(' | ')} |`);
    const loadRows = staff.map((s) => `| ${s} | ${total[s]} |`);
    const vals = staff.map((s) => total[s]);
    if (vals.length && Math.max(...vals) - Math.min(...vals) > 1) warnings.push('Duty ka bantwara barabar nahi (limit/unavailability ki wajah se).');
    return { grid, total, warnings, table: [head, sep, ...rows].join('\n'), loadTable: ['| Staff | Duties |', '|---|---|', ...loadRows].join('\n') };
  }

  /* ── timetable solver ─────────────────────────────────────────────────── */
  function parseLessons(text) {      // "Class | Subject | Teacher | periods/week"
    return lines(text).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length >= 4 && Number(p[3]) > 0)
      .map(([cls, subject, teacher, n]) => ({ cls, subject, teacher, n: Math.min(Number(n), 12) }));
  }

  function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  function attempt(lessons, P, D, seed) {
    const rand = rng(seed);
    const cls = {}, tch = {};              // `${who}|${d}|${p}` → entry
    const subjDay = {}, tchDay = {}, grid = {}, unplaced = [];
    const key = (a, d, p) => `${a}|${d}|${p}`;
    // scarce teachers first, then bigger weekly loads
    const teacherLoad = {};
    lessons.forEach((l) => { teacherLoad[l.teacher] = (teacherLoad[l.teacher] || 0) + l.n; });
    const queue = [];
    lessons.forEach((l) => { for (let i = 0; i < l.n; i += 1) queue.push(l); });
    queue.sort((a, b) => teacherLoad[b.teacher] - teacherLoad[a.teacher] || b.n - a.n || rand() - 0.5);
    queue.forEach((l) => {
      let best = null;
      for (let d = 0; d < D; d += 1) for (let p = 0; p < P; p += 1) {
        if (cls[key(l.cls, d, p)] || tch[key(l.teacher, d, p)]) continue;
        const sd = subjDay[`${l.cls}|${l.subject}|${d}`] || 0;
        const td = tchDay[`${l.teacher}|${d}`] || 0;
        const cap = l.n > D ? 2 : 1;
        const penalty = (sd >= cap ? 100 : 0) + sd * 10 + td * 2 + p * 0.4 + rand();
        if (!best || penalty < best.penalty) best = { d, p, penalty };
      }
      if (!best) { unplaced.push(l); return; }
      cls[key(l.cls, best.d, best.p)] = l; tch[key(l.teacher, best.d, best.p)] = l;
      subjDay[`${l.cls}|${l.subject}|${best.d}`] = (subjDay[`${l.cls}|${l.subject}|${best.d}`] || 0) + 1;
      tchDay[`${l.teacher}|${best.d}`] = (tchDay[`${l.teacher}|${best.d}`] || 0) + 1;
      (grid[l.cls] = grid[l.cls] || {})[`${best.d}|${best.p}`] = l;
    });
    return { grid, unplaced, tch };
  }

  function validateTimetable(grid, lessons) {
    const errors = [], seen = {};
    Object.keys(grid).forEach((c) => Object.keys(grid[c]).forEach((slot) => {
      const l = grid[c][slot], k = `${l.teacher}@${slot}`;
      if (seen[k]) errors.push(`Teacher ${l.teacher} double-booked at slot ${slot} (${seen[k]} & ${c})`);
      seen[k] = c;
    }));
    lessons.forEach((l) => {
      const got = Object.keys(grid[l.cls] || {}).filter((s) => grid[l.cls][s].subject === l.subject && grid[l.cls][s].teacher === l.teacher).length;
      if (got !== l.n) errors.push(`${l.cls} ${l.subject}: ${got}/${l.n} periods`);
    });
    return errors;
  }

  function solveTimetable({ periods, days, lessons, breakAfter }) {
    const P = Math.min(Math.max(periods, 1), 10), D = Math.min(Math.max(days, 1), 6);
    const warnings = [];
    if (!lessons.length) return { grid: {}, text: '[Lessons list khali hai — "Class | Subject | Teacher | periods/week"]', warnings: ['Lessons list khali hai.'], errors: [] };
    // quick capacity checks that explain a failure before the solver is blamed
    const perClass = {}, perTeacher = {};
    lessons.forEach((l) => { perClass[l.cls] = (perClass[l.cls] || 0) + l.n; perTeacher[l.teacher] = (perTeacher[l.teacher] || 0) + l.n; });
    Object.keys(perClass).forEach((c) => { if (perClass[c] > P * D) warnings.push(`${c}: ${perClass[c]} periods maange, sirf ${P * D} slot hain.`); });
    Object.keys(perTeacher).forEach((t) => { if (perTeacher[t] > P * D) warnings.push(`${t}: ${perTeacher[t]} periods/week — ${P * D} se zyada.`); });
    let best = null;
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = attempt(lessons, P, D, seed);
      if (!best || r.unplaced.length < best.unplaced.length) best = r;
      if (!r.unplaced.length) break;
    }
    best.unplaced.forEach((l) => warnings.push(`Place nahi hua: ${l.cls} ${l.subject} (${l.teacher})`));
    const errors = validateTimetable(best.grid, lessons.filter((l) => !best.unplaced.includes(l)));
    const dayNames = DAYS.slice(0, D);
    const tables = Object.keys(best.grid).sort().map((c) => {
      const head = `| ${c} | ${dayNames.join(' | ')} |`;
      const rows = [];
      for (let p = 0; p < P; p += 1) {
        rows.push(`| P${p + 1} | ${dayNames.map((_, d) => { const l = best.grid[c][`${d}|${p}`]; return l ? `${l.subject} (${l.teacher})` : '—'; }).join(' | ')} |`);
        if (breakAfter && p + 1 === breakAfter && p + 1 < P) rows.push(`| Break | ${dayNames.map(() => '·').join(' | ')} |`);
      }
      return `**Class ${c}**\n${head}\n|${'---|'.repeat(D + 1)}\n${rows.join('\n')}`;
    });
    const load = Object.keys(perTeacher).sort().map((t) => `| ${t} | ${perTeacher[t]} |`);
    const text = tables.join('\n\n') + '\n\n**Teacher load (periods/week)**\n| Teacher | Periods |\n|---|---|\n' + load.join('\n');
    return { grid: best.grid, text, warnings, errors };
  }

  /* ── form definitions for the UI ──────────────────────────────────────── */
  const LANG = { id: 'lang', label: 'Bhasha', kind: 'select', options: [['hi', 'हिंदी'], ['en', 'English'], ['bi', 'Hindi + English']], value: 'hi' };
  const TYPES = [
    { id: 'notice', label: 'Notice / सूचना', fields: [LANG, { id: 'subject', label: 'Vishay', req: 1 }, { id: 'audience', label: 'Kiske liye (students/staff/parents)' }, { id: 'when', label: 'Tithi / samay' }, { id: 'venue', label: 'Sthaan' }, { id: 'body', label: 'Mukhya baatein (har line ek point)', kind: 'area', req: 1 }, { id: 'cc', label: 'Copy to' }] },
    { id: 'circular', label: 'Circular / परिपत्र', fields: [LANG, { id: 'subject', label: 'Vishay', req: 1 }, { id: 'refTo', label: 'Sandarbh (letter/circular no.)' }, { id: 'body', label: 'Nirdesh', kind: 'area', req: 1 }, { id: 'cc', label: 'Copy to' }] },
    { id: 'letter', label: 'Official letter / पत्र', fields: [LANG, { id: 'to', label: 'Kise (designation, office, place)', kind: 'area', rows: 3, req: 1 }, { id: 'subject', label: 'Vishay', req: 1 }, { id: 'refTo', label: 'Sandarbh' }, { id: 'body', label: 'Patra ki baatein', kind: 'area', req: 1 }, { id: 'encl', label: 'Sanlagnak' }, { id: 'cc', label: 'Copy to' }] },
    { id: 'application', label: 'Application / आवेदन', fields: [LANG, { id: 'to', label: 'Kise', kind: 'area', rows: 2 }, { id: 'subject', label: 'Vishay', req: 1 }, { id: 'body', label: 'Kaaran / vivaran', kind: 'area', req: 1 }, { id: 'name', label: 'Aapka naam', req: 1 }, { id: 'role', label: 'Pad / class' }] },
    { id: 'email', label: 'E-mail', fields: [{ id: 'to', label: 'To', req: 1 }, { id: 'cc', label: 'Cc' }, { id: 'subject', label: 'Subject', req: 1 }, { id: 'tone', label: 'Tone', kind: 'select', options: [['formal', 'Formal'], ['polite', 'Polite'], ['firm', 'Firm / urgent']], value: 'formal' }, { id: 'body', label: 'Kya kehna hai', kind: 'area', req: 1 }] },
    { id: 'notesheet', label: 'Note sheet / टिप्पणी', fields: [LANG, { id: 'subject', label: 'Vishay', req: 1 }, { id: 'background', label: 'Prishthbhumi', kind: 'area' }, { id: 'rules', label: 'Niyam / sandarbh', kind: 'area' }, { id: 'proposal', label: 'Prastaav', kind: 'area', req: 1 }, { id: 'finance', label: 'Vittiya prabhav', kind: 'area', rows: 2 }, { id: 'by', label: 'Prastutkarta (naam, pad)' }] },
    { id: 'roster', label: 'Duty roster / deployment', fields: [LANG, { id: 'staff', label: 'Staff (har line ek naam)', kind: 'area', req: 1 }, { id: 'duties', label: 'Duties (Duty | kitne log) — jaise: Morning Assembly | 2', kind: 'area', req: 1 }, { id: 'days', label: 'Din', value: 'Mon-Sat' }, { id: 'unavailable', label: 'Uplabdh nahi (Naam: Mon, Tue)', kind: 'area', rows: 2 }, { id: 'week', label: 'Avadhi (jaise 24-29 Nov 2026)' }] },
    { id: 'routine', label: 'Class routine / time table', fields: [LANG, { id: 'lessons', label: 'Class | Subject | Teacher | periods/week (har line ek)', kind: 'area', rows: 8, req: 1 }, { id: 'periods', label: 'Periods/din', value: '8' }, { id: 'daysCount', label: 'Din/hafta', value: '6' }, { id: 'breakAfter', label: 'Break kitne period ke baad', value: '4' }] }
  ];

  function build(typeId, values, school, now) {
    const fn = BUILD[typeId];
    if (!fn) throw new Error('Unknown document type');
    const sc = Object.assign({}, SCHOOL_DEFAULT, school || {});
    const n = (sc.counter || 0) + 1;
    const out = fn(values || {}, sc, { n, now: now || Date.now() });
    return Object.assign(out, { counter: n });
  }

  function polishPrompt(text, mode) {
    const task = {
      improve: 'Improve the wording to be polished, courteous and official, without changing any facts, names, dates, numbers or the structure.',
      hindi: 'Translate to formal Hindi (Devanagari) suitable for an Indian school office. Keep every name, number and date exactly.',
      english: 'Translate to formal Indian-English suitable for an official school letter. Keep every name, number and date exactly.',
      bilingual: 'Make it bilingual: each heading and paragraph in Hindi (Devanagari) followed by English. Keep every name, number and date exactly.'
    }[mode] || '';
    return `${task}\nKeep the same layout (headings, tables, numbering, signature block). Do not add facts. Do not invent placeholders; keep [brackets] as they are. Return only the final document, no commentary.\n\n---\n${text}`;
  }

  return { TYPES, SCHOOL_DEFAULT, build, polishPrompt, solveRoster, solveTimetable, validateTimetable, parseLessons, parseDuties, parseUnavailable, selectedDays, dateStr, session, abbr };
});
