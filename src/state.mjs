// What the panel knows, and where each fact comes from.
//
// Three sources, and none of them is a database:
//   tmux            which sessions exist, and whether the pane is producing output
//   attention/*     which session is waiting on you (written by the attention hook)
//   permissions/*   which session is blocked on a decision (written by the permission hook)
//
// Everything is derived on read. There is no state of our own to get stale, which
// is the whole reason the panel can be restarted, closed or crashed without
// losing track of anything.

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { sessions as tmuxSessions } from './control.mjs';

export function stateDir() {
  return process.env.HANDRAISE_HOME || join(homedir(), '.handraise');
}

const read = (path, fallback = '') => {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
};

/**
 * Is the process that wrote this seal still the one running?
 *
 * A pid on its own proves nothing — pids are reused — so the seal carries the
 * process start time and the boot id. This is what lets the panel tell a live
 * question from a file somebody left behind.
 */
export function procAlive(seal) {
  const m = /^(\d+)@(\d+)(?:@([0-9a-f-]+))?$/.exec((seal || '').trim());
  if (!m) return false;
  if (m[3]) {
    const boot = read('/proc/sys/kernel/random/boot_id').trim();
    if (boot && !boot.startsWith(m[3])) return false;
  }
  const stat = read(`/proc/${m[1]}/stat`);
  if (!stat) return false;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] === m[2];
}

/**
 * Activity of the pane itself. Comes from tmux `window_activity`, which advances
 * with every byte the agent prints. It answers "is this thing alive", never "is
 * this thing waiting for me" — that second question belongs to the hook.
 */
export function paneActivity(session, now = Date.now() / 1000) {
  const seen = Number(session?.activity);
  if (!Number.isFinite(seen) || seen <= 0) return null;
  return {
    lastSeen: new Date(seen * 1000).toISOString(),
    minutesAgo: Math.max(0, Math.floor((now - seen) / 60)),
  };
}

/**
 * Who is waiting on you, and since when. Written by the attention hook; here it
 * is only read and pruned — a session that died without saying so leaves its
 * file behind, and after 12 hours that file proves nothing.
 */
export function readAttention(root = stateDir(), now = Date.now() / 1000) {
  let names = [];
  try { names = readdirSync(join(root, 'attention')).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.flatMap((name) => {
    let entry;
    try { entry = JSON.parse(read(join(root, 'attention', name))); } catch { return []; }
    const age = now - (entry.since ?? 0);
    if (!Number.isFinite(age) || age > 12 * 3600) return [];
    return [{ ...entry, waitingSeconds: entry.state === 'waiting' ? Math.round(age) : 0 }];
  });
}

/**
 * Permission requests with a hook still waiting for an answer. They are typed
 * and ephemeral: the file is born with the dialog and the hook deletes it when
 * it consumes the decision. A request whose process is gone is dropped rather
 * than rendered — a button that decides nothing is worse than no button.
 */
export function readPermissions(root = stateDir(), now = Date.now() / 1000) {
  const directory = join(root, 'permissions');
  let names = [];
  try {
    names = readdirSync(directory).filter((n) => n.endsWith('.json') && !n.endsWith('.response.json'));
  } catch { return []; }
  return names.flatMap((name) => {
    let request;
    try { request = JSON.parse(read(join(directory, name))); } catch { return []; }
    const age = now - (request.requestedAt ?? 0);
    if (request.state !== 'pending' || !Number.isFinite(age) || age > 12 * 3600) return [];
    if (request.proc && !procAlive(request.proc)) return [];
    return [{ ...request, key: request.key || name.replace(/\.json$/, ''), waitingSeconds: Math.max(0, Math.round(age)) }];
  });
}

/** Answers only the request that is still pending; an old button never decides the next one. */
export function resolvePermission(root, key, id, behavior, message = '') {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error('invalid permission key');
  if (!['allow', 'deny'].includes(behavior)) throw new Error(`invalid decision: '${behavior}'`);
  const directory = join(root, 'permissions');
  const requestPath = join(directory, `${key}.json`);
  let request;
  try { request = JSON.parse(read(requestPath)); } catch { throw new Error('this request is no longer pending'); }
  if (request.state !== 'pending' || request.id !== id) throw new Error('the request changed or was already answered');
  if (request.proc && !procAlive(request.proc)) throw new Error('that session is no longer waiting for this permission');
  const responsePath = join(directory, `${key}.response.json`);
  const tmp = `${responsePath}.tmp-${process.pid}`;
  const cleanMessage = String(message || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  writeFileSync(tmp, JSON.stringify({ id, behavior, message: cleanMessage, decidedAt: Date.now() / 1000 }));
  renameSync(tmp, responsePath);
  return { id, behavior, message: cleanMessage };
}

/**
 * How far along a wrap-up is.
 *
 * Asking is instant; complying is not — the agent still has to finish its turn
 * and write down where it got to. While that happens the session is NOT done,
 * and it can't be restarted or killed without losing exactly the thing that
 * makes it resumable. "Wrapping up" is a state, not the moment you clicked.
 *
 * What proves it finished is a real signal, never an optimistic timer: the
 * harness saying it's waiting on you, or the pane going quiet.
 */
export const WRAPUP_NO_ANSWER = 300;
export function wrapupState(session, attention, now = Date.now() / 1000, quietFor = 45) {
  if (!session?.wrapupAskedAt) return null;
  const seconds = Math.max(0, Math.round(now - session.wrapupAskedAt));
  const spoke = attention?.state === 'waiting' && (attention.since ?? 0) >= session.wrapupAskedAt;
  const quiet = session.activity ? now - session.activity >= quietFor : false;
  const proof = spoke ? 'told-us' : quiet ? 'pane-quiet' : null;
  return { seconds, wrapping: !proof, proof, noAnswer: !proof && seconds >= WRAPUP_NO_ANSWER };
}

export function pauseState(session, attention, now = Date.now() / 1000, quietFor = 45) {
  if (!session?.pauseAskedAt) return null;
  const seconds = Math.max(0, Math.round(now - session.pauseAskedAt));
  const spoke = attention?.state === 'waiting' && (attention.since ?? 0) >= session.pauseAskedAt;
  const quiet = session.activity ? now - session.activity >= quietFor : false;
  const proof = spoke ? 'told-us' : quiet ? 'pane-quiet' : null;
  return { seconds, pausing: !proof, paused: Boolean(proof), proof };
}

/**
 * Everything the page needs, in one object.
 *
 * A session is `blocked` when a permission request is waiting on a decision,
 * `waiting` when the agent said it finished or needs you, and `working`
 * otherwise. Blocked outranks waiting on purpose: both mean "your turn", but
 * only one of them has a button that unblocks it.
 */
export function snapshot({ root = stateDir(), now = Date.now() / 1000, list = tmuxSessions } = {}) {
  const attention = readAttention(root, now);
  const permissions = readPermissions(root, now);
  const live = list();

  const sessions = live.map((session) => {
    const mine = attention.find((a) => a.slug === session.controlSlug || a.slug === session.slug) ?? null;
    const permission = permissions.find((p) => p.slug === session.controlSlug || p.slug === session.slug) ?? null;
    const wrapup = wrapupState(session, mine, now);
    const pause = pauseState(session, mine, now);
    const status = session.error ? 'error'
      : permission ? 'blocked'
      : pause?.paused ? 'paused'
      : pause?.pausing ? 'pausing'
      : wrapup?.wrapping ? 'wrapping'
      : mine?.state === 'waiting' ? 'waiting'
      : 'working';
    return {
      slug: session.slug,
      controlSlug: session.controlSlug,
      agent: session.agent,
      cwd: session.cwd,
      repoId: session.repoId,
      component: session.component,
      front: session.front,
      runId: session.runId,
      role: session.role,
      startedAt: session.startedAt,
      attached: session.attached,
      error: session.error,
      status,
      reason: session.error ? `Agent exited with code ${session.error}` : permission ? permission.summary : mine?.reason ?? null,
      waitingSeconds: permission?.waitingSeconds ?? mine?.waitingSeconds ?? 0,
      activity: paneActivity(session, now),
      wrapup,
      pause,
      permission,
      controllable: true,
    };
  });

  const order = { error: 0, blocked: 1, waiting: 2, pausing: 3, paused: 4, wrapping: 5, working: 6 };
  sessions.sort((a, b) => (order[a.status] - order[b.status]) || b.waitingSeconds - a.waitingSeconds);

  return {
    sessions,
    needsYou: sessions.filter((s) => ['error', 'blocked', 'waiting'].includes(s.status)).length,
    at: new Date(now * 1000).toISOString(),
  };
}
