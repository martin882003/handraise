#!/usr/bin/env node
// Handraise's command line. Runtime truth stays in tmux and in each repository;
// the small user-level settings file only remembers connected repositories,
// paired devices and agent defaults.

import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createHandraise } from '../src/server.mjs';
import { createPairingAuth } from '../src/auth.mjs';
import { agentInvocation, createConfigStore, detectAdapter } from '../src/config.mjs';
import { sessions, start } from '../src/control.mjs';
import { hookStatus, installHooks as installAgentHooks, uninstallHooks as uninstallAgentHooks } from '../src/hooks.mjs';
import {
  createComponent, createFront, deleteComponent, deleteFront, repositoryPortfolio,
  setComponentState, updateComponent, updateFront,
} from '../src/repositories.mjs';
import { controlService, installService, serviceStatus, uninstallService } from '../src/service.mjs';
import { readAttention, readPermissions, stateDir } from '../src/state.mjs';
import { createWorktree } from '../src/worktrees.mjs';

const [verb = 'serve', ...rest] = process.argv.slice(2);
const cliPath = fileURLToPath(import.meta.url);
const BOOLEAN_FLAGS = new Set(['yes', 'no-start', 'no-worktree']);

function flag(name, fallback = null) {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
}

const hasFlag = (name) => rest.includes(`--${name}`);

/** Everything that is not a `--flag` or the value right after one. */
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(rest[i].slice(2))) i++;
      continue;
    }
    out.push(rest[i]);
  }
  return out;
}

// ── server status ───────────────────────────────────────────────────────────
async function serverCommand() {
  const [action = 'status'] = positional();
  if (action !== 'status') throw new Error('usage: handraise server status [--url http://127.0.0.1:4177]');
  const base = String(flag('url', 'http://127.0.0.1:4177')).replace(/\/$/, '');
  let health;
  let readiness;
  try {
    const [healthResponse, readinessResponse] = await Promise.all([
      fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) }),
      fetch(`${base}/api/readiness`, { signal: AbortSignal.timeout(3_000) }),
    ]);
    health = await healthResponse.json();
    readiness = await readinessResponse.json();
  } catch (error) {
    throw new Error(`server unavailable at ${base}: ${error.message || error}`);
  }
  console.log(`server      ${health?.ok ? 'available' : 'unhealthy'} · ${base}`);
  console.log(`readiness   ${readiness?.ready ? 'ready' : 'not ready'}`);
  for (const [name, check] of Object.entries(readiness?.checks || {})) {
    console.log(`${name.padEnd(11)} ${check.ok ? check.version || 'ok' : check.recovery || 'failed'}`);
  }
  if (!readiness?.ready) process.exitCode = 1;
}

// ── persistent service ──────────────────────────────────────────────────────
function service() {
  const [action = 'status'] = positional();
  const options = { home: homedir(), stateRoot: stateDir(), binPath: cliPath };
  if (action === 'install') {
    const result = installService({
      ...options,
      host: flag('host', '127.0.0.1'), port: Number(flag('port', 4177)), start: !hasFlag('no-start'),
    });
    console.log(`service installed at ${result.path}`);
    console.log(result.started ? 'server started and enabled for this user' : 'service enabled; run handraise service start when ready');
    return;
  }
  if (['start', 'stop', 'restart'].includes(action)) {
    controlService(action);
    console.log(`Handraise service ${action === 'stop' ? 'stopped' : `${action}ed`}`);
    return;
  }
  if (action === 'uninstall') {
    if (!hasFlag('yes')) throw new Error('usage: handraise service uninstall --yes');
    const result = uninstallService({ home: options.home });
    console.log(`service stopped, disabled and removed from ${result.removed}`);
    return;
  }
  if (action !== 'status') throw new Error('usage: handraise service install|start|stop|restart|status|uninstall --yes');
  const status = serviceStatus({ home: options.home });
  if (!status.supported) return console.log('persistent service management is not supported on this platform; use handraise serve');
  console.log(`installed   ${status.installed ? `yes · ${status.path}` : 'no'}`);
  console.log(`enabled     ${status.enabled ? 'yes' : 'no'}`);
  console.log(`active      ${status.active ? 'yes' : 'no'}`);
  if (status.installed && !status.current) console.log('repair      service definition is outdated; run handraise service install');
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
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('server port must be an integer between 1 and 65535');
  if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(String(host))) throw new Error('server host must be an IP address or hostname without spaces');
  const publicUrl = flag('public-url', process.env.HANDRAISE_PUBLIC_URL || null);
  const server = createHandraise({ publicUrl });
  const repositoryPath = flag('repo');
  if (repositoryPath) server.handraise.config.addRepository(repositoryPath);
  server.on('error', (error) => {
    const detail = error?.code === 'EADDRINUSE'
      ? `port ${port} is already in use`
      : error?.code === 'EACCES' || error?.code === 'EPERM'
        ? `cannot bind ${host}:${port} (${error.code})`
        : String(error?.message || error);
    console.error(`handraise server failed to start: ${detail}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`handraise server listening on http://${host}:${port}`);
    const pairing = server.handraise.auth.pairingDetails();
    if (pairing) {
      console.log(`first client pairing code: ${pairing.code} (expires in 5 minutes)`);
    }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log('⚠️  bound to a non-local address: this drives real agents, put auth in front of it.');
    }
  });
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const forcedExit = setTimeout(() => process.exit(1), 5_000);
      try { await server.handraise.shutdown(); }
      catch (error) { console.error(`handraise shutdown warning: ${String(error?.message || error)}`); }
      finally {
        server.close(() => {
          clearTimeout(forcedExit);
          process.exit(0);
        });
        server.closeAllConnections?.();
      }
    });
  }
}

// ── repo ────────────────────────────────────────────────────────────────────
function repository() {
  const [action = 'list', value] = positional();
  const config = createConfigStore({ root: stateDir() });
  if (action === 'add') {
    const added = config.addRepository(resolve(value || process.cwd()), { name: flag('name') });
    console.log(`${added.name}\t${added.path}\t${added.adapter}`);
    return;
  }
  if (action === 'remove') {
    if (!value) throw new Error('usage: handraise repo remove <repo-id>');
    config.removeRepository(value);
    console.log(`${value} removed from Handraise (the repository itself was not changed)`);
    return;
  }
  if (action !== 'list') throw new Error('usage: handraise repo add [path] | list | remove <repo-id>');
  const repositories = config.snapshot().repositories;
  if (!repositories.length) return console.log('no repositories connected');
  for (const item of repositories) console.log(`${item.id}\t${item.name}\t${item.path}\t${item.adapter}`);
}

// ── auth ────────────────────────────────────────────────────────────────────
function authentication() {
  const [action = ''] = positional();
  if (action !== 'reset' || !hasFlag('yes')) {
    throw new Error('usage: handraise auth reset --yes');
  }
  createPairingAuth({ root: stateDir() }).reset();
  console.log('paired devices cleared; restart handraise serve to print a new pairing code');
}

// ── start ────────────────────────────────────────────────────────────────────
function startSession() {
  requireTmux();
  const [slug] = positional();
  if (!slug) {
    console.error('usage: handraise start <name> [--dir <path>] [--repo <id>] [--component <slug>] [--front <slug>] [--agent claude|codex] [--model <id>] [--effort <level>]');
    process.exit(1);
  }
  let cwd = resolve(flag('dir', process.cwd()));
  const config = createConfigStore({ root: stateDir() });
  let settings = config.read();
  let repository = flag('repo')
    ? settings.repositories.find((item) => item.id === flag('repo'))
    : settings.repositories.find((item) => cwd === item.path || cwd.startsWith(`${item.path}${sep}`));
  if (!repository) {
    try { repository = config.addRepository(cwd); settings = config.read(); } catch { /* session stays unassigned outside Git */ }
  }
  const agent = flag('agent', repository?.defaultAgent || (settings.agents.claude.enabled ? 'claude' : 'codex'));
  if (!settings.agents[agent]?.enabled) throw new Error(`${agent} is disabled in Settings`);
  const component = flag('component');
  const front = flag('front');
  let initialPrompt = '';
  if (repository && (component || front)) {
    const target = { ...repository, adapter: detectAdapter(repository.path) };
    const portfolio = repositoryPortfolio(target, sessions());
    const frontRecord = front ? portfolio.fronts.find((item) => item.slug === front) : null;
    if (front && !frontRecord) throw new Error(`front '${front}' not found`);
    if (component && !portfolio.components.some((item) => item.slug === component)) throw new Error(`component '${component}' not found`);
    const owner = sessions().find((session) => session.repoId === repository.id && session.front === front);
    if (owner) throw new Error(`front '${front}' is already owned by session '${owner.slug}'`);
    if (front && !hasFlag('no-worktree')) cwd = createWorktree(target, front).path;
    if (frontRecord) initialPrompt = `You own front '${front}' for component '${frontRecord.component}'. Read its plan and Handoff before editing, keep its checklist current, and report dependencies outside this front.`;
  }
  const command = flag('command', agentInvocation(agent, {
    model: flag('model', repository?.model || settings.agents[agent].model),
    effort: flag('effort', repository?.effort || settings.agents[agent].effort),
    prompt: initialPrompt,
  }));
  const result = start({
    slug, cwd, command, agent,
    repoId: repository?.id || null,
    component,
    front,
  });
  console.log(result.existed
    ? `${slug} was already running (${result.tmux})`
    : `${slug} started in ${cwd} (${result.tmux})${repository ? ` · ${repository.name}` : ''}`);
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

// ── project mutation boundary ───────────────────────────────────────────────
function project() {
  const [entity] = positional();
  const repositoryId = flag('repo');
  const from = flag('from');
  if (!['component', 'front'].includes(entity) || !repositoryId || !from) {
    throw new Error('usage: handraise project component|front --repo <id> --from <operation.json>');
  }
  const config = createConfigStore({ root: stateDir() });
  const stored = config.read().repositories.find((item) => item.id === repositoryId);
  if (!stored) throw new Error('repository not found');
  const repository = { ...stored, adapter: detectAdapter(stored.path) };
  const payload = JSON.parse(readFileSync(resolve(from), 'utf8'));
  let result;
  if (entity === 'component') {
    const action = String(payload.action || '');
    if (action === 'create') result = createComponent(repository, payload);
    else if (action === 'update') result = updateComponent(repository, String(payload.slug || ''), payload);
    else if (action === 'retire') result = setComponentState(repository, String(payload.slug || ''), 'closing');
    else if (action === 'reopen') result = setComponentState(repository, String(payload.slug || ''), 'active');
    else if (action === 'remove') result = deleteComponent(repository, String(payload.slug || ''), { sessions: sessions() });
    else throw new Error('component action must be create, update, retire, reopen or remove');
  } else {
    const action = String(payload.action || '');
    const component = String(payload.component || '');
    const slug = String(payload.slug || '');
    if (action === 'create') result = createFront(repository, component, payload);
    else if (action === 'update') result = updateFront(repository, component, slug, payload);
    else if (action === 'remove') result = deleteFront(repository, component, slug, { sessions: sessions() });
    else throw new Error('front action must be create, update or remove');
  }
  console.log(JSON.stringify(result, null, 2));
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
function installHooks() {
  const status = installAgentHooks({ root: stateDir() });
  console.log(`hooks installed in ${stateDir()}/hooks`);
  console.log(`Claude Code wired through ${status.claude.path}`);
  console.log(`Codex wired through ${status.codex.path}`);
  console.log('Codex requires one trust review: launch it and use /hooks to trust the Handraise entries.');
  console.log('The hooks stay inert outside Handraise sessions, so your own terminals are untouched.');
}

function hooks() {
  const [action = 'status'] = positional();
  if (['install', 'repair'].includes(action)) return installHooks();
  if (action === 'uninstall') {
    if (!hasFlag('yes')) throw new Error('usage: handraise hooks uninstall --yes');
    uninstallAgentHooks({ root: stateDir() });
    console.log('Handraise hook entries and copied scripts were removed; unrelated agent hooks were preserved.');
    return;
  }
  if (action !== 'status') throw new Error('usage: handraise hooks install | repair | status | uninstall --yes');
  const status = hookStatus({ root: stateDir() });
  console.log(`scripts   ${Object.values(status.scripts).every(Boolean) ? `installed · v${status.version || '?'}${status.sourceCurrent ? '' : ' · outdated'}` : 'missing'}`);
  console.log(`claude    ${status.claude.configured ? 'wired' : 'not wired'}`);
  console.log(`codex     ${status.codex.configured ? 'wired · review with /hooks after changes' : 'not wired'}`);
  if (status.repairNeeded) console.log('repair    run: handraise hooks repair');
}

// ── doctor ───────────────────────────────────────────────────────────────────
function doctor() {
  const checks = [];
  try { checks.push(['tmux', execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim()]); }
  catch { checks.push(['tmux', 'MISSING — install it, everything runs on top of it']); }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(['node', `${process.version}${nodeMajor >= 20 ? '' : ' — UNSUPPORTED, requires Node 20+'}`]);
  try { checks.push(['python3', execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim()]); }
  catch { checks.push(['python3', 'MISSING — needed by the hooks']); }
  const config = createConfigStore({ root: stateDir() });
  const settings = config.snapshot();
  for (const [id, agent] of Object.entries(settings.agents)) {
    checks.push([id, agent.installed
      ? `${agent.version}${agent.auth.connected ? ' · authenticated' : ' · authentication not detected'}`
      : `MISSING — install ${agent.title}`]);
  }
  const hooksState = hookStatus({ root: stateDir() });
  checks.push(['claude hooks', hooksState.claude.configured && !hooksState.repairNeeded ? 'wired' : 'repair needed — run: handraise hooks repair']);
  checks.push(['codex hooks', hooksState.codex.configured && !hooksState.repairNeeded ? 'wired · verify trust with /hooks' : 'repair needed — run: handraise hooks repair']);
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const mode = statSync(stateDir()).mode & 0o777;
  checks.push(['state', `${stateDir()} · mode ${mode.toString(8)}${mode & 0o077 ? ' — should not be accessible to other users' : ''}`]);
  const countJson = (name) => { try { return readdirSync(resolve(stateDir(), name)).filter((file) => file.endsWith('.json') && !file.endsWith('.response.json')).length; } catch { return 0; } };
  const staleAttention = Math.max(0, countJson('attention') - readAttention(stateDir()).length);
  const stalePermissions = Math.max(0, countJson('permissions') - readPermissions(stateDir()).length);
  checks.push(['runtime state', staleAttention || stalePermissions
    ? `${staleAttention} stale attention · ${stalePermissions} stale permission files; safe to remove after stopping affected hooks`
    : 'no stale attention or permission records']);
  const unavailable = settings.repositories.filter((repository) => { try { return !statSync(repository.path).isDirectory(); } catch { return true; } });
  checks.push(['repositories', unavailable.length ? `${unavailable.length} unavailable — reconnect or remove their registrations` : `${settings.repositories.length} reachable`]);
  const managedService = serviceStatus({ home: homedir() });
  checks.push(['service', !managedService.supported ? 'unsupported on this platform'
    : managedService.active ? 'active'
      : managedService.installed ? 'installed but inactive — run: handraise service start'
        : 'not installed (optional)']);
  for (const [name, value] of checks) console.log(`${name.padEnd(14)} ${value}`);
}

const VERBS = { serve: serve, server: serverCommand, service, start: startSession, list, repo: repository, project, auth: authentication, hooks, 'install-hooks': installHooks, doctor };

if (!VERBS[verb]) {
  console.error(`unknown command: ${verb}\n`);
  console.error('usage:');
  console.error('  handraise serve [--port 4177] [--host 127.0.0.1] [--repo <path>]');
  console.error('  handraise server status [--url http://127.0.0.1:4177]');
  console.error('  handraise service install|start|stop|restart|status|uninstall --yes');
  console.error('  handraise start <name> [--dir <path>] [--repo <id>] [--component <slug>] [--front <slug>] [--no-worktree] [--agent claude|codex] [--model <id>] [--effort <level>]');
  console.error('  handraise list');
  console.error('  handraise repo add [path] | list | remove <repo-id>');
  console.error('  handraise project component|front --repo <id> --from <operation.json>');
  console.error('  handraise auth reset --yes');
  console.error('  handraise hooks install | repair | status | uninstall --yes');
  console.error('  handraise doctor');
  process.exit(1);
}
try { await VERBS[verb](); }
catch (error) { console.error(`handraise: ${error.message || error}`); process.exitCode = 1; }
