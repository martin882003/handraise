#!/usr/bin/env node
// Handraise's command line. Four verbs and no configuration file: the panel keeps
// no state of its own, so there is nothing to configure that tmux doesn't
// already know.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { createHandraise } from '../src/server.mjs';
import { sessions, start } from '../src/control.mjs';
import { stateDir } from '../src/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(here, '..');

const [verb = 'serve', ...rest] = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
}

/** Everything that is not a `--flag` or the value right after one. */
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) { i++; continue; }
    out.push(rest[i]);
  }
  return out;
}

function requireTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    console.error('handraise needs tmux on your PATH. Install it and try again.');
    process.exit(1);
  }
}

// ── serve ────────────────────────────────────────────────────────────────────
function serve() {
  requireTmux();
  const port = Number(flag('port', process.env.HANDRAISE_PORT || 4177));
  const host = flag('host', '127.0.0.1');
  const server = createHandraise();
  server.listen(port, host, () => {
    console.log(`handraise on http://${host}:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log('⚠️  bound to a non-local address: this drives real agents, put auth in front of it.');
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); process.exit(0); });
  }
}

// ── start ────────────────────────────────────────────────────────────────────
function startSession() {
  requireTmux();
  const [slug] = positional();
  if (!slug) {
    console.error('usage: handraise start <name> [--dir <path>] [--agent claude|codex] [--command "<cli>"]');
    process.exit(1);
  }
  const agent = flag('agent', 'claude');
  const command = flag('command', agent === 'codex' ? 'codex' : 'claude');
  const cwd = resolve(flag('dir', process.cwd()));
  const result = start({ slug, cwd, command, agent });
  console.log(result.existed
    ? `${slug} was already running (${result.tmux})`
    : `${slug} started in ${cwd} (${result.tmux})`);
  console.log('open the panel with: handraise serve');
}

// ── list ─────────────────────────────────────────────────────────────────────
function list() {
  requireTmux();
  const live = sessions();
  if (!live.length) return console.log('no handraise sessions running');
  for (const session of live) {
    console.log(`${session.slug}\t${session.agent}\t${session.cwd ?? ''}`);
  }
}

// ── install-hooks ────────────────────────────────────────────────────────────
// The hooks are what make the panel more than a viewer: one reports which
// session is waiting on you, the other turns a permission prompt into a typed
// question you can answer from the browser.
//
// They are installed at user level because agents run in whatever repo you're
// in. Both are inert outside a handraise session — the attention hook returns when
// tmux does not carry our prefix, and the permission hook returns unless HANDRAISE
// is set in its environment, which only `handraise start` does. A session you open
// in your own terminal keeps its native dialog.
const ATTENTION_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'PermissionDenied', 'Stop', 'Notification', 'SessionEnd'];

function installHooks() {
  const target = join(stateDir(), 'hooks');
  mkdirSync(target, { recursive: true });
  for (const name of ['attention.py', 'permission-request.py']) {
    copyFileSync(join(PACKAGE_ROOT, 'hooks', name), join(target, name));
  }

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    writeFileSync(`${settingsPath}.handraise-backup`, JSON.stringify(settings, null, 2));
  } catch { /* no settings yet: we create one */ }

  settings.hooks ??= {};
  const entry = (script, extra = {}) => ({
    hooks: [{ type: 'command', command: `python3 "${join(target, script)}"`, ...extra }],
  });

  // Idempotent by construction: any block that already points at our directory
  // is replaced rather than appended, so running this twice cannot double-fire.
  const mine = (block) => JSON.stringify(block).includes(target);
  for (const event of ATTENTION_EVENTS) {
    settings.hooks[event] = (settings.hooks[event] ?? []).filter((block) => !mine(block));
    settings.hooks[event].push(entry('attention.py', { async: true, timeout: 10 }));
  }
  settings.hooks.PermissionRequest = (settings.hooks.PermissionRequest ?? []).filter((block) => !mine(block));
  settings.hooks.PermissionRequest.push(entry('permission-request.py'));

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`hooks installed in ${target}`);
  console.log(`wired into ${settingsPath} (previous version saved as settings.json.handraise-backup)`);
  console.log('they stay inert outside handraise sessions, so your own terminals are untouched.');
}

// ── doctor ───────────────────────────────────────────────────────────────────
function doctor() {
  const checks = [];
  try { checks.push(['tmux', execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim()]); }
  catch { checks.push(['tmux', 'MISSING — install it, everything runs on top of it']); }
  checks.push(['node', process.version]);
  try { checks.push(['python3', execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim()]); }
  catch { checks.push(['python3', 'MISSING — needed by the hooks']); }
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    const wired = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks ?? {}).includes('handraise');
    checks.push(['hooks', wired ? 'wired' : 'not wired — run: handraise install-hooks']);
  } catch { checks.push(['hooks', 'not wired — run: handraise install-hooks']); }
  checks.push(['state', stateDir()]);
  for (const [name, value] of checks) console.log(`${name.padEnd(9)} ${value}`);
}

const VERBS = { serve: serve, start: startSession, list, 'install-hooks': installHooks, doctor };

if (!VERBS[verb]) {
  console.error(`unknown command: ${verb}\n`);
  console.error('usage:');
  console.error('  handraise serve [--port 4177] [--host 127.0.0.1]');
  console.error('  handraise start <name> [--dir <path>] [--agent claude|codex] [--command "<cli>"]');
  console.error('  handraise list');
  console.error('  handraise install-hooks');
  console.error('  handraise doctor');
  process.exit(1);
}
VERBS[verb]();
