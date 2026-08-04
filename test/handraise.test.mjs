// The tests cover the four places where being wrong is expensive: what counts as
// one of our sessions, what may be sent into a pane, what proves a request is
// still live, and what turns into HTML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  askToPause, askToWrapUp, KEYS, PREFIX, resume, sessions, sendKey, sendText, start,
} from '../src/control.mjs';
import { ansiToHtml } from '../src/ansi.mjs';
import { pauseState, procAlive, readPermissions, snapshot } from '../src/state.mjs';

const FIELDS = (name, {
  attached = '0', activity = '1700000000', agent = '', wrapup = '', error = '', cwd = '/tmp',
  repoId = '', component = '', front = '', displaySlug = '', pause = '', started = '', role = '', runId = '',
} = {}) => [
  name, attached, activity, agent, wrapup, error, cwd, repoId, component, front, displaySlug, pause, started, role, runId,
].join('\t');

// ── which sessions are ours ──────────────────────────────────────────────────

test('only sessions carrying our prefix are listed', () => {
  const run = () => [
    FIELDS(`${PREFIX}api`, { cwd: '/code/api' }),
    FIELDS('my-own-shell'),          // somebody else's tmux session
    FIELDS(`${PREFIX}web`, { agent: 'codex', cwd: '/code/web' }),
  ].join('\n');
  const found = sessions(run);
  assert.deepEqual(found.map((s) => s.slug), ['api', 'web']);
  assert.equal(found[1].agent, 'codex');
  assert.equal(found[0].cwd, '/code/api');
});

test('a session with no recorded agent reads back as claude, not as unknown', () => {
  // Sessions started before the agent was recorded still have to be drivable.
  const [session] = sessions(() => FIELDS(`${PREFIX}old`, { agent: '' }));
  assert.equal(session.agent, 'claude');
});

test('no tmux server at all is an empty list, not a crash', () => {
  assert.deepEqual(sessions(() => null), []);
});

// ── what may be sent into a pane ─────────────────────────────────────────────

test('keys outside the allowed set are refused', () => {
  // `send-keys` without a filter is arbitrary execution on the machine, so the
  // list being closed is the security boundary, not a convenience.
  assert.throws(() => sendKey('api', 'C-x; rm -rf /', { run: () => '' }), /not allowed/);
  assert.throws(() => sendKey('api', 'M-x', { run: () => '' }), /not allowed/);
  assert.ok(KEYS.has('Enter') && KEYS.has('C-c'));
});

test('free text is sent literally, and Enter goes as its own call', () => {
  const calls = [];
  sendText('api', '/pause', { run: (args) => { calls.push(args); return ''; } });
  const keys = calls.filter((c) => c[0] === 'send-keys');
  assert.deepEqual(keys[0].slice(-2), ['-l', '/pause'], 'the text must go through -l');
  assert.deepEqual(keys[1].at(-1), 'Enter', 'Enter must be a separate send-keys');
});

test('the same display slug is isolated by repository in tmux', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return null;
    return '';
  };
  const result = start({ slug: 'api', cwd: '/code/one', repoId: 'repo-one', component: 'backend', front: 'api', runId: 'run-123', run });
  const created = calls.find((args) => args[0] === 'new-session');
  assert.ok(created.includes(`${PREFIX}repo-one--api`));
  assert.equal(result.controlSlug, 'repo-one--api');
  assert.ok(calls.some((args) => args.includes('@handraise-slug') && args.at(-1) === 'api'));
  assert.ok(calls.some((args) => args.includes('@handraise-repo') && args.at(-1) === 'repo-one'));
  assert.ok(calls.some((args) => args.includes('@handraise-run') && args.at(-1) === 'run-123'));
});

test('run identity survives tmux discovery for fleet and orchestration reconciliation', () => {
  const [session] = sessions(() => FIELDS(`${PREFIX}repo-one--api`, {
    agent: 'codex', repoId: 'repo-one', component: 'backend', front: 'api', displaySlug: 'api', runId: 'run-123',
  }));
  assert.equal(session.runId, 'run-123');
  const root = mkdtempSync(join(tmpdir(), 'handraise-run-identity-'));
  const fleet = snapshot({ root, list: () => [session] });
  assert.equal(fleet.sessions[0].runId, 'run-123', 'fleet normalization must not discard durable run identity');
});

test('lifecycle orders target the repository-scoped control slug', () => {
  const calls = [];
  const row = FIELDS(`${PREFIX}repo-one--api`, {
    agent: 'codex', repoId: 'repo-one', displaySlug: 'api',
  });
  const run = (args) => {
    calls.push(args);
    return args[0] === 'list-sessions' ? row : '';
  };
  askToWrapUp('repo-one--api', { run, wait: () => {}, now: () => 101 });
  askToPause('repo-one--api', { run, wait: () => {}, now: () => 102 });
  resume('repo-one--api', { run, wait: () => {} });
  const sentTargets = calls.filter((args) => args[0] === 'send-keys').map((args) => args[2]);
  assert.ok(sentTargets.every((target) => target === `${PREFIX}repo-one--api`));
  assert.ok(calls.some((args) => args.includes('@handraise-wrapup') && args.at(-1) === '101'));
  assert.ok(calls.some((args) => args.includes('@handraise-pause') && args.at(-1) === '102'));
  assert.ok(calls.some((args) => args.includes('-u') && args.includes('@handraise-pause')));
});

// ── what proves a request is still live ──────────────────────────────────────

test('our own process seal is alive and an invented one is not', () => {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  assert.equal(procAlive(`${process.pid}@${start}`), true);
  assert.equal(procAlive(`${process.pid}@${start}@${boot.slice(0, 8)}`), true, 'Director-compatible short boot seals stay valid');
  assert.equal(procAlive(`${process.pid}@${Number(start) + 1}`), false, 'a reused pid must not pass');
  assert.equal(procAlive('999999@1'), false);
  assert.equal(procAlive(''), false);
  assert.equal(procAlive('garbage'), false);
});

test('a permission request whose process is gone is dropped, not shown', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-'));
  mkdirSync(join(root, 'permissions'), { recursive: true });
  const base = { key: 'k', session: 'k', slug: 'api', state: 'pending', requestedAt: Date.now() / 1000,
    tool: { name: 'Bash', input: { command: 'rm -rf /' } }, summary: 'Bash: rm -rf /' };
  writeFileSync(join(root, 'permissions', 'dead.json'), JSON.stringify({ ...base, proc: '999999@1@deadbeef' }));
  assert.deepEqual(readPermissions(root), [], 'a button that decides nothing is worse than no button');
});

// ── what the page is told ────────────────────────────────────────────────────

test('a pending permission outranks a plain wait', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-'));
  const now = Date.now() / 1000;
  mkdirSync(join(root, 'attention'), { recursive: true });
  mkdirSync(join(root, 'permissions'), { recursive: true });
  for (const slug of ['api', 'web']) {
    writeFileSync(join(root, 'attention', `${slug}.json`), JSON.stringify({
      session: slug, slug, state: 'waiting', reason: 'finished its turn', since: now - 30,
    }));
  }
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  writeFileSync(join(root, 'permissions', 'api.json'), JSON.stringify({
    id: 'x', key: 'api', session: 'api', slug: 'api', state: 'pending', requestedAt: now - 5,
    proc: `${process.pid}@${start}`, tool: { name: 'Bash', input: { command: 'npm run migrate' } },
    summary: 'Bash: npm run migrate',
  }));

  const list = () => sessions(() => [FIELDS(`${PREFIX}web`), FIELDS(`${PREFIX}api`)].join('\n'));
  const state = snapshot({ root, now, list });

  assert.equal(state.needsYou, 2);
  assert.equal(state.sessions[0].slug, 'api', 'the blocked one sorts first');
  assert.equal(state.sessions[0].status, 'blocked');
  assert.equal(state.sessions[0].reason, 'Bash: npm run migrate');
  assert.equal(state.sessions[1].status, 'waiting');
});

test('a session nobody is waiting on is working', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-'));
  const list = () => sessions(() => FIELDS(`${PREFIX}quiet`));
  const [session] = snapshot({ root, list }).sessions;
  assert.equal(session.status, 'working');
  assert.equal(session.permission, null);
});

test('a cooperative pause only becomes paused after a real proof', () => {
  const now = 1_000;
  const session = { pauseAskedAt: 950, activity: 980 };
  assert.equal(pauseState(session, null, now).pausing, true);
  assert.equal(pauseState(session, { state: 'waiting', since: 960 }, now).paused, true);
  assert.equal(pauseState({ ...session, activity: 900 }, null, now).proof, 'pane-quiet');
});

test('an agent exit is surfaced ahead of stale attention', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-'));
  const now = Date.now() / 1000;
  mkdirSync(join(root, 'attention'), { recursive: true });
  writeFileSync(join(root, 'attention', 'broken.json'), JSON.stringify({
    session: 'broken', slug: 'broken', state: 'waiting', reason: 'old wait', since: now - 20,
  }));
  const list = () => sessions(() => FIELDS(`${PREFIX}broken`, { error: '127' }));
  const [session] = snapshot({ root, now, list }).sessions;
  assert.equal(session.status, 'error');
  assert.equal(session.reason, 'Agent exited with code 127');
});

// ── what turns into HTML ─────────────────────────────────────────────────────

test('pane text is escaped before it becomes markup', () => {
  const html = ansiToHtml('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), 'a pane must never be able to inject markup');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('colour sequences become styles and other control bytes are dropped', () => {
  assert.match(ansiToHtml('\x1b[31mred\x1b[0m'), /<span style="color:#ff6b72">red<\/span>/);
  assert.equal(ansiToHtml('\x1b[2Kclean'), 'clean', 'a non-SGR CSI is consumed, not printed');
  assert.equal(ansiToHtml('plain'), 'plain');
});
