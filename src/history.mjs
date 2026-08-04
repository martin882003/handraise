import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function directory(root) {
  return join(root, 'history');
}

export function recordHistory(root, event) {
  const at = event.at || new Date().toISOString();
  const payload = { id: event.id || randomUUID(), at, ...event };
  const dir = directory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = String(new Date(at).getTime()).padStart(13, '0');
  const path = join(dir, `${stamp}-${payload.id}.json`);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return payload;
}

export function readHistory(root, { limit = 500, repoId = null } = {}) {
  let names = [];
  try { names = readdirSync(directory(root)).filter((name) => name.endsWith('.json')).sort().reverse(); }
  catch { return []; }
  const events = [];
  for (const name of names) {
    try {
      const event = JSON.parse(readFileSync(join(directory(root), name), 'utf8'));
      if (!repoId || event.repoId === repoId) events.push(event);
    } catch { /* a corrupt history record is isolated from the rest */ }
    if (events.length >= limit) break;
  }
  return events;
}

function historyIdentity(event) {
  const incarnation = event.startedAt || event.sessionId || event.at || event.id;
  return `${event.controlSlug || event.slug || 'unknown'}:${incarnation}`;
}

export function historyOutcomes(events) {
  const terminalPriority = { failed: 4, stopped: 3, completed: 2, ended: 1 };
  const terminal = new Map();
  for (const event of events) {
    if (!terminalPriority[event.type]) continue;
    const key = historyIdentity(event);
    const previous = terminal.get(key);
    if (!previous || terminalPriority[event.type] > terminalPriority[previous.type]) terminal.set(key, event);
  }
  return [...terminal.values()]
    .map((event) => event.type === 'ended' ? { ...event, type: 'completed', sourceType: 'ended' } : event)
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
}

export function historySummary(events, now = Date.now()) {
  const recent = historyOutcomes(events).filter((event) => {
    const age = now - new Date(event.at).getTime();
    return Number.isFinite(age) && age >= 0 && age <= 7 * 24 * 3600 * 1000;
  });
  const durations = recent.map((event) => Number(event.durationSeconds)).filter((value) => Number.isFinite(value) && value >= 0);
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  return {
    completed7d: recent.filter((event) => event.type === 'completed').length,
    failed7d: recent.filter((event) => event.type === 'failed').length,
    stopped7d: recent.filter((event) => event.type === 'stopped').length,
    medianDurationSeconds: durations.length
      ? durations.length % 2 ? durations[middle] : Math.round((durations[middle - 1] + durations[middle]) / 2)
      : null,
  };
}

function sessionIdentity(session) {
  return `${session.controlSlug}:${session.startedAt || 'unknown'}`;
}

export class HistoryTracker {
  constructor({ root }) {
    this.root = root;
    this.previous = new Map();
    this.initialized = false;
    this.failed = new Set();
    this.recordedStarts = new Set();
  }

  sessionEvent(session, type, extra = {}) {
    const now = Date.now() / 1000;
    return recordHistory(this.root, {
      type,
      slug: session.slug,
      controlSlug: session.controlSlug,
      repoId: session.repoId,
      component: session.component,
      front: session.front,
      runId: session.runId || null,
      agent: session.agent,
      role: session.role || 'agent',
      cwd: session.cwd,
      startedAt: session.startedAt,
      durationSeconds: session.startedAt ? Math.max(0, Math.round(now - session.startedAt)) : null,
      ...extra,
    });
  }

  started(session) {
    const identity = sessionIdentity(session);
    this.previous.set(identity, session);
    if (this.recordedStarts.has(identity)) return null;
    this.recordedStarts.add(identity);
    return this.sessionEvent(session, 'started');
  }

  stopped(session) {
    this.previous.delete(sessionIdentity(session));
    return this.sessionEvent(session, 'stopped');
  }

  observe(sessions) {
    const current = new Map(sessions.map((session) => [sessionIdentity(session), session]));
    if (!this.initialized) {
      this.previous = current;
      this.initialized = true;
      return;
    }
    for (const [identity, previous] of this.previous) {
      if (!current.has(identity)) this.sessionEvent(previous, 'completed');
    }
    for (const [identity, session] of current) {
      if (!this.previous.has(identity) && !this.recordedStarts.has(identity)) {
        this.recordedStarts.add(identity);
        this.sessionEvent(session, 'started', { detected: true });
      }
    }
    for (const session of sessions) {
      const failureKey = sessionIdentity(session);
      if (session.error && !this.failed.has(failureKey)) {
        this.failed.add(failureKey);
        this.sessionEvent(session, 'failed', { exitCode: session.error });
      }
    }
    this.previous = current;
  }
}
