'use strict';
const path = require('node:path');
const { createStore } = require('./store.js');
const { createAutonomy } = require('./autonomy.js');
const { createEngine } = require('./workflows.js');
const { createScheduler } = require('./scheduler.js');
const { createRecipes } = require('./recipes.js');
const { createGoogle } = require('./google.js');
const { createTasks } = require('./tasks.js');
const { createBot } = require('./telegram-bot.js');
const qa = require('./qa.js');

const HELP = [
  'Jenni commands',
  '/brief – daily briefing now', '/tasks – open tasks', '/add <task> – add (kal/aaj/25/11 understood)', '/done <text> – complete',
  '/inbox – triage mail now', '/approvals – pending approvals', '/approve <id> · /reject <id>',
  '/runs – recent runs', '/jobs – schedule', '/backup – backup to Drive',
  'Send a marks CSV with caption /sa1 <exam> <class> → analysis + circular',
  'Anything else → chat with Jenni'
].join('\n');

function createAutomation({ storageDir, connections, llm, transcribe, env = process.env, fetchImpl, now = () => Date.now(), systemPrompt = '', retryDelayMs, startBot = true }) {
  const store = createStore({ dir: storageDir, env, now });
  const autonomy = createAutonomy(store);
  const tasks = createTasks(store, now);
  const google = createGoogle({ env, fetchImpl, now });
  let bot = null;
  const notify = async (text) => { if (bot) { try { await bot.say(text); return; } catch (e) { /* fall through */ } } try { await connections.sendTelegram({ text }); } catch (e) { /* no channel */ } };

  const engine = createEngine({ store, autonomy, now, retryDelayMs, onEvent: (e) => {
    if (e.type === 'approval_needed') (bot ? bot.notifyApproval(e.approval) : Promise.resolve()).catch(() => notify(`Approval needed: ${e.approval.preview}`));
    else if (e.type === 'run_failed') notify(`⚠️ ${e.run.title} failed: ${e.run.error}\nRetry: /retry ${e.run.id}`);
    else if (e.type === 'run_blocked') notify(`⛔ ${e.run.title} needs you (human-only step): ${e.run.error}`);
  } });
  const recipes = createRecipes({ store, tasks, llm, connections, google, notify, now, outDir: path.join(storageDir, 'outbox') });
  recipes.forEach((r) => engine.register(r));
  const run = (id, input) => engine.start(id, input);
  const scheduler = createScheduler({ store, run, now, onError: (job, e) => store.audit('job_error', { job: job.id, error: e.message }) });

  const chat = async (text) => {
    if (!llm) return 'AI is not configured on the server yet.';
    const mem = store.list('tasks').filter((t) => !t.done).slice(0, 8).map((t) => `- ${t.title} ${t.due || ''}`).join('\n');
    return qa.redactPII(await llm([{ role: 'system', content: `${systemPrompt}\nOpen tasks:\n${mem || 'none'}` }, { role: 'user', content: text }])).text;
  };

  async function command(text) {
    const [cmd, ...rest] = text.split(/\s+/); const arg = rest.join(' ').trim();
    switch (cmd.toLowerCase().replace(/@\w+$/, '')) {
      case '/start': case '/help': return HELP;
      case '/brief': { const r = await run('daily_briefing'); return r.status === 'done' ? 'Sent.' : `Briefing ${r.status}`; }
      case '/inbox': { const r = await run('inbox_triage'); return r.out.scan && r.out.scan.skipped ? `Skipped: ${r.out.scan.skipped}` : `Done: ${r.status}`; }
      case '/backup': { const r = await run('weekly_backup'); return `Backup ${r.status}${r.error ? `: ${r.error}` : ''}`; }
      case '/tasks': { const l = tasks.list('open'); return l.length ? l.map((t) => `• ${t.title}${t.due ? ` (${t.due})` : ''}`).join('\n') : 'No open tasks 🎉'; }
      case '/add': { if (!arg) return 'Usage: /add <task>'; const t = tasks.add(arg); return `Added: ${t.title}${t.due ? ` (due ${t.due})` : ''}`; }
      case '/done': { const t = tasks.complete(arg); return t ? `Done: ${t.title}` : 'No matching task.'; }
      case '/approvals': { const p = engine.pending(); return p.length ? p.map((a) => `${a.id}\n${a.action}: ${a.preview.slice(0, 200)}`).join('\n\n') : 'Nothing pending.'; }
      case '/approve': case '/reject': { await engine.decideApproval(arg, cmd.toLowerCase().startsWith('/approve'), 'telegram'); return 'Recorded.'; }
      case '/retry': { const r = await engine.retry(arg); return `Run ${r.status}`; }
      case '/runs': return store.list('runs').slice(-8).map((r) => `${r.status.padEnd(16)} ${r.title}`).join('\n') || 'No runs yet.';
      case '/jobs': return scheduler.jobs().map((j) => `${j.enabled ? '●' : '○'} ${j.id}  ${j.cron}`).join('\n');
      default: return null;
    }
  }

  const handlers = {
    async text(t) { if (t.startsWith('/')) { const r = await command(t); if (r !== null) return r; } return chat(t); },
    async file({ name, text, caption }) {
      if (/^\/sa1\b/i.test(caption) || /sa1|marks|result/i.test(name)) {
        const [, exam = 'SA1', ...cls] = caption.replace(/^\/sa1\s*/i, 'SA1 ').trim().split(/\s+/);
        const r = await run('sa1_results', { csv: text, exam, classLabel: cls.join(' ') });
        return r.status === 'done' ? 'Analysis + circular ready.' : `Run ${r.status}${r.error ? `: ${r.error}` : ''}`;
      }
      return 'Send a marks CSV with caption /sa1 <exam> <class>.';
    },
    decide: (id, ok) => engine.decideApproval(id, ok, 'telegram'),
    transcribe
  };

  function start() {
    engine.resumeAll().catch((e) => store.audit('resume_error', { error: e.message }));
    scheduler.start();
    if (startBot) { bot = createBot({ connections, handlers, fetchImpl, onError: (e) => store.audit('bot_error', { error: e.message }) }); bot.start(); }
  }
  function stop() { scheduler.stop(); if (bot) bot.stop(); }

  return {
    store, engine, scheduler, tasks, google, autonomy, handlers, command, run, start, stop, notify,
    status: () => ({ jobs: scheduler.jobs(), pending: engine.pending(), runs: store.list('runs').slice(-20).reverse(), tasks: tasks.list('open'), google: google.configured(), ai: Boolean(llm), recipes: [...engine.defs.keys()], audit: store.auditLog(20) })
  };
}

module.exports = { createAutomation, HELP };
