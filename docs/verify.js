/**
 * Verification — deterministic checks on what Jenni writes, so S4 "official
 * accuracy" is enforced by code rather than hoped for in a prompt:
 * weekday/date agreement, arithmetic, marks totals, UDISE, leftover
 * placeholders and personal identifiers. Returns issues; callers decide
 * whether to repair, warn or pass.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JENNI_VERIFY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WD_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const WD_HI = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
  const WD_RO = ['ravivar', 'somvar', 'mangalvar', 'budhvar', 'guruvar', 'shukravar', 'shanivar'];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTHS_HI = ['जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];

  function weekdayIndex(word) {
    const w = word.toLowerCase();
    let i = WD_EN.findIndex((d) => w === d || w === d.slice(0, 3));
    if (i < 0) i = WD_HI.indexOf(word);
    if (i < 0) i = WD_RO.indexOf(w);
    return i;
  }

  function checkDates(text, issues) {
    const day = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat|ravivar|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|रविवार|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार)';
    const patterns = [
      new RegExp(day + '[^\\d\\n]{0,12}(\\d{1,2})[\\/.-](\\d{1,2})[\\/.-](\\d{4})', 'giu'),
      new RegExp(day + '[^\\d\\n]{0,12}(\\d{1,2})(?:st|nd|rd|th)?\\s+([A-Za-z\\u0900-\\u097F]{3,10})\\.?,?\\s+(\\d{4})', 'giu'),
      new RegExp('(\\d{1,2})[\\/.-](\\d{1,2})[\\/.-](\\d{4})\\s*[\\(,]\\s*' + day, 'giu')
    ];
    patterns.forEach((re, pi) => {
      let m;
      while ((m = re.exec(text))) {
        let wd, d, mo, y;
        if (pi === 0) { [, wd, d, mo, y] = m; }
        else if (pi === 1) {
          [, wd, d, , y] = m;
          const name = m[3].toLowerCase();
          mo = MONTHS.findIndex((x) => name.startsWith(x)) + 1;
          if (!mo) mo = MONTHS_HI.findIndex((x) => m[3].startsWith(x.slice(0, 3))) + 1;
          if (!mo) continue;
        } else { [, d, mo, y, wd] = m; }
        const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
        if (date.getUTCMonth() !== Number(mo) - 1 || Number(mo) > 12) { issues.push({ level: 'error', code: 'bad-date', msg: `Date "${m[0].trim()}" valid nahi hai.` }); continue; }
        const idx = weekdayIndex(wd);
        if (idx >= 0 && idx !== date.getUTCDay()) {
          issues.push({ level: 'error', code: 'weekday', msg: `${m[0].trim()}: ${d}/${mo}/${y} ko asal me ${WD_EN[date.getUTCDay()]} padta hai.`, fix: WD_EN[date.getUTCDay()] });
        }
      }
    });
  }

  const num = (s) => Number(String(s).replace(/,/g, ''));
  function checkArithmetic(text, issues) {
    const re = /(\d[\d,]*(?:\.\d+)?)\s*([+\-−×x*÷/])\s*(\d[\d,]*(?:\.\d+)?)\s*=\s*(\d[\d,]*(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(text))) {
      const a = num(m[1]), b = num(m[3]), c = num(m[4]);
      const op = m[2];
      const want = op === '+' ? a + b : (op === '-' || op === '−') ? a - b : (op === '×' || op === 'x' || op === '*') ? a * b : b === 0 ? NaN : a / b;
      if (Number.isFinite(want) && Math.abs(want - c) > 0.01 * Math.max(1, Math.abs(want)) * 0.1) {
        issues.push({ level: 'error', code: 'arith', msg: `Hisaab galat: ${m[0].trim()} (sahi: ${Math.round(want * 100) / 100}).`, fix: String(Math.round(want * 100) / 100) });
      }
    }
    const pct = /(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*(\d+(?:\.\d+)?)\s*(?:=|is|→|->)?\s*(\d+(?:\.\d+)?)\s*%/gi;
    while ((m = pct.exec(text))) {
      const want = (Number(m[1]) / Number(m[2])) * 100;
      if (Number(m[2]) && Math.abs(want - Number(m[3])) > 0.6) issues.push({ level: 'error', code: 'percent', msg: `Percentage galat: ${m[1]}/${m[2]} = ${want.toFixed(1)}%, likha ${m[3]}%.`, fix: want.toFixed(1) });
    }
  }

  /** Question paper: "Maximum Marks: 80" vs the sum of per-question marks. */
  function checkMarks(text, issues) {
    const total = text.match(/(?:max(?:imum)?\s*marks|total\s*marks|कुल\s*अंक|पूर्णांक)\s*[:=\-]?\s*(\d{1,3})/i);
    if (!total) return;
    const marks = [...text.matchAll(/[\[(]\s*(\d{1,2})\s*(?:marks?|m|अंक)\s*[\])]/gi)].map((x) => Number(x[1]));
    if (marks.length < 3) return;
    const sum = marks.reduce((a, b) => a + b, 0);
    if (sum !== Number(total[1])) issues.push({ level: 'error', code: 'marks', msg: `Marks ka jod ${sum} hai par total ${total[1]} likha hai.`, fix: String(sum) });
  }

  function check(text, ctx = {}) {
    const t = String(text || '');
    const issues = [];
    if (!t.trim()) return { ok: true, issues };
    checkDates(t, issues);
    checkArithmetic(t, issues);
    checkMarks(t, issues);

    if (ctx.udise) {
      const re = /udise[^\d]{0,20}(\d{11})/gi; let m;
      while ((m = re.exec(t))) if (m[1] !== ctx.udise) issues.push({ level: 'error', code: 'udise', msg: `UDISE ${m[1]} school ke record (${ctx.udise}) se match nahi karta.`, fix: ctx.udise });
    }
    if (ctx.document) {
      const left = t.match(/\[[A-Za-zऀ-ॿ][^\]\n]{1,40}\]/g);
      if (left) issues.push({ level: 'warn', code: 'placeholder', msg: `Bharna baaki: ${[...new Set(left)].slice(0, 4).join(', ')}` });
      if (/(subject|विषय)\s*[:：]/i.test(t) && !/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{1,2}\s+[A-Za-zऀ-ॿ]{3,10}\s+\d{4}\b|date|दिनांक/i.test(t)) {
        issues.push({ level: 'warn', code: 'no-date', msg: 'Patra me tareekh nahi dikhi.' });
      }
    }
    if (ctx.s5 !== false) {
      if (/\b[6-9]\d{9}\b/.test(t) || /\b\d{4}\s\d{4}\s\d{4}\b/.test(t)) issues.push({ level: 'warn', code: 's5', msg: 'S5: isme phone/Aadhaar jaisa number hai — bhejne se pehle dekh lo.' });
    }
    return { ok: !issues.some((i) => i.level === 'error'), issues };
  }

  function repairPrompt(issues) {
    return 'Tumhare draft me ye galtiyan mili hain. Sirf inhe theek karke poora draft wapas do, baaki kuch mat badlo:\n'
      + issues.filter((i) => i.level === 'error').map((i) => '- ' + i.msg).join('\n');
  }

  return { check, repairPrompt, checkDates, checkArithmetic, checkMarks };
});
