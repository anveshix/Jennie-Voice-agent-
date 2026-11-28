'use strict';
/* Pure marks analysis: CSV in, class-level aggregates + at-risk list out. */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const META = /^(roll|rollno|roll no|roll_no|name|student|class|section|sec|admission|adm|sr|s\.?no)/i;

function parseMarks(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('CSV needs a header and at least one student row');
  const head = rows[0].map((h) => h.trim());
  const rollIdx = head.findIndex((h) => /^roll/i.test(h));
  const nameIdx = head.findIndex((h) => /^(name|student)/i.test(h));
  const subjects = head.map((h, i) => ({ h, i })).filter((x) => x.h && !META.test(x.h));
  if (!subjects.length) throw new Error('no subject columns found');
  const students = rows.slice(1).map((r, n) => {
    const marks = {};
    subjects.forEach(({ h, i }) => {
      const v = String(r[i] == null ? '' : r[i]).trim();
      if (v === '' || /^(ab|absent|-)$/i.test(v)) return;
      const num = Number(v);
      if (Number.isFinite(num)) marks[h] = num;
    });
    return { roll: rollIdx >= 0 ? String(r[rollIdx]).trim() : String(n + 1), name: nameIdx >= 0 ? String(r[nameIdx]).trim() : '', marks };
  }).filter((s) => Object.keys(s.marks).length);
  return { subjects: subjects.map((x) => x.h), students };
}

const round1 = (n) => Math.round(n * 10) / 10;

function analyze({ subjects, students }, { max = 100, passPercent = 33 } = {}) {
  const passMark = (max * passPercent) / 100;
  const per = {};
  subjects.forEach((s) => {
    const v = students.map((x) => x.marks[s]).filter((n) => n !== undefined);
    if (!v.length) return;
    per[s] = { n: v.length, avg: round1(v.reduce((a, b) => a + b, 0) / v.length), high: Math.max(...v), low: Math.min(...v), passPct: round1((v.filter((n) => n >= passMark).length / v.length) * 100) };
  });
  const atRisk = students.map((s) => ({ roll: s.roll, failing: Object.entries(s.marks).filter(([, m]) => m < passMark).map(([k]) => k) }))
    .filter((s) => s.failing.length);
  const totals = students.map((s) => {
    const v = Object.values(s.marks);
    return (v.reduce((a, b) => a + b, 0) / (v.length * max)) * 100;
  });
  const bands = { '90+': 0, '75-89': 0, '60-74': 0, '33-59': 0, '<33': 0 };
  totals.forEach((p) => { bands[p >= 90 ? '90+' : p >= 75 ? '75-89' : p >= 60 ? '60-74' : p >= passPercent ? '33-59' : '<33'] += 1; });
  const weakest = Object.entries(per).sort((a, b) => a[1].passPct - b[1].passPct || a[1].avg - b[1].avg).map(([k]) => k);
  return {
    count: students.length, max, passPercent, subjects: per, weakest, bands, atRisk,
    overallAvgPct: totals.length ? round1(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
    allPassPct: students.length ? round1(((students.length - atRisk.length) / students.length) * 100) : 0
  };
}

module.exports = { parseCsv, parseMarks, analyze };
