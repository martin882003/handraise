// The control layer: what turns a dashboard from a view into a wheel.
//
// The idea that makes it possible: you don't fight the agent's harness for a
// channel into a live session — there isn't one — you run the session INSIDE
// tmux, and tmux already has a command for everything you do by hand:
//
//   read the scrollback  →  capture-pane
//   type into it         →  send-keys -l
//   answer / interrupt   →  send-keys <key>
//   start one            →  new-session -d -c <dir>
//   kill it              →  kill-session
//
// And because the sessions live in tmux rather than in the page, **closing the
// browser kills nothing**: you can `tmux attach` from any terminal and carry on.
//
// Only sessions that were started here can be driven. One you opened by hand in
// your own terminal has no pane we own — it is not listed rather than listed and
// broken.

import { execFileSync } from 'node:child_process';

/** Our own prefix: never touch tmux sessions that aren't ours. */
export const PREFIX = 'handraise-';
export const tmuxName = (slug) => `${PREFIX}${slug}`;

/**
 * What the panel needs to know about a pane and only the pane can answer: which
 * agent runs inside it, and whether it has been asked to wrap up.
 *
 * These live as tmux session options on purpose. A file would outlive the pane,
 * and a fact that outlives the thing it describes is a second source of truth.
 * Here the fact is born and dies with the session.
 */
export const OPT_AGENT = '@handraise-agent';
export const OPT_WRAPUP = '@handraise-wrapup';
export const OPT_PAUSE = '@handraise-pause';
export const OPT_ERROR = '@handraise-error';
export const OPT_CWD = '@handraise-cwd';
export const OPT_REPO = '@handraise-repo';
export const OPT_COMPONENT = '@handraise-component';
export const OPT_FRONT = '@handraise-front';
export const OPT_SLUG = '@handraise-slug';
export const OPT_STARTED = '@handraise-started';
export const OPT_ROLE = '@handraise-role';
export const OPT_RUN = '@handraise-run';

/**
 * Allowed keys, and the list is closed on purpose: `send-keys` without a filter
 * is arbitrary execution on the machine. Free text always goes through `-l`
 * (literal), which tmux does not interpret.
 */
export const KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'BTab', 'Space', 'BSpace', 'DC',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'C-a', 'C-c', 'C-d', 'C-e', 'C-k', 'C-l', 'C-r', 'C-u', 'C-w',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

export function tmux(args, { allowFail = false } = {}) {
  const socket = String(process.env.HANDRAISE_TMUX_SOCKET || '').trim();
  if (socket && !/^[A-Za-z0-9._-]{1,80}$/.test(socket)) {
    throw new Error('HANDRAISE_TMUX_SOCKET must be a short tmux socket name');
  }
  const commandArgs = socket ? ['-L', socket, ...args] : args;
  try {
    return execFileSync('tmux', commandArgs, {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`tmux ${args[0]} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

/**
 * The sessions this panel can drive.
 *
 * ⚠️ Activity comes from `window_activity`, NOT `session_activity`: measured
 * against tmux 3.7, the session one freezes at creation time while the window
 * one advances with every byte the pane prints. With the wrong one, an agent
 * that is working looks idle and a wrap-up request looks instantly honoured.
 */
export function sessions(run = tmux) {
  const fields = [
    '#{session_name}', '#{session_attached}', '#{window_activity}',
    `#{${OPT_AGENT}}`, `#{${OPT_WRAPUP}}`, `#{${OPT_ERROR}}`, `#{${OPT_CWD}}`,
    `#{${OPT_REPO}}`, `#{${OPT_COMPONENT}}`, `#{${OPT_FRONT}}`,
    `#{${OPT_SLUG}}`, `#{${OPT_PAUSE}}`, `#{${OPT_STARTED}}`, `#{${OPT_ROLE}}`, `#{${OPT_RUN}}`,
  ];
  const out = run(['list-sessions', '-F', fields.join('\t')], { allowFail: true });
  if (!out) return [];
  return out.split('\n').filter(Boolean).flatMap((line) => {
    const [name, attached, activity, agent, wrapup, error, cwd, repoId, component, front, displaySlug, pause, started, role, runId] = line.split('\t');
    if (!name?.startsWith(PREFIX)) return [];
    const controlSlug = name.slice(PREFIX.length);
    return [{
      slug: displaySlug || controlSlug,
      controlSlug,
      tmux: name,
      attached: attached === '1',
      activity: Number(activity) || null,
      agent: agent || 'claude',
      wrapupAskedAt: Number(wrapup) || null,
      pauseAskedAt: Number(pause) || null,
      startedAt: Number(started) || null,
      role: role || 'agent',
      runId: runId || null,
      error: error || null,
      cwd: cwd || null,
      repoId: repoId || null,
      component: component || null,
      front: front || null,
    }];
  });
}

export function exists(slug, run = tmux) {
  return sessions(run).some((s) => s.controlSlug === slug);
}

/**
 * If the agent's CLI exits with an error, the pane keeps the message instead of
 * vanishing. It sleeps there — it does not drop you into an interactive shell
 * behind the input box — and the next start replaces it cleanly.
 */
export function holdError(command) {
  return `( ${command} ); code=$?; if [ "$code" -ne 0 ]; then `
    + `tmux set-option ${OPT_ERROR} "$code" 2>/dev/null || true; `
    + `printf '\\n[handraise] the agent exited with code %s; fix the cause and start it again\\n' "$code"; `
    + 'exec sleep infinity; fi';
}

/**
 * Start an agent in its own tmux session.
 *
 * The pane is born with real working dimensions. A detached tmux session with no
 * explicit size falls back to 80×24, and the agent will wrap its own output even
 * when the browser has the whole screen available.
 */
export function start({
  slug, cwd, command = 'claude', agent = 'claude', env = {},
  repoId = null, component = null, front = null, runId = null, role = 'agent', run = tmux,
}) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(slug)) throw new Error(`invalid session name: '${slug}'`);
  const controlSlug = repoId ? `${repoId}--${slug}` : slug;
  if (!/^[A-Za-z0-9._-]{1,140}$/.test(controlSlug)) throw new Error('repository and session names are too long together');
  const previous = sessions(run).find((s) => s.controlSlug === controlSlug);
  if (previous && !previous.error) return { existed: true, tmux: tmuxName(controlSlug), controlSlug };
  if (previous?.error) run(['kill-session', '-t', tmuxName(controlSlug)]);

  const exported = Object.entries({ HANDRAISE: '1', ...env })
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join(' ');
  const script = holdError(`export ${exported}; ${command}`);

  run(['new-session', '-d', '-x', '160', '-y', '48', '-s', tmuxName(controlSlug), '-c', cwd, script]);
  // Recorded after creation because before it there is nowhere to record it. If
  // this failed the session is still drivable and reads back as the default.
  run(['set-option', '-t', tmuxName(controlSlug), OPT_AGENT, agent], { allowFail: true });
  run(['set-option', '-t', tmuxName(controlSlug), OPT_CWD, cwd], { allowFail: true });
  run(['set-option', '-t', tmuxName(controlSlug), OPT_SLUG, slug], { allowFail: true });
  run(['set-option', '-t', tmuxName(controlSlug), OPT_STARTED, String(Math.floor(Date.now() / 1000))], { allowFail: true });
  run(['set-option', '-t', tmuxName(controlSlug), OPT_ROLE, role], { allowFail: true });
  if (repoId) run(['set-option', '-t', tmuxName(controlSlug), OPT_REPO, repoId], { allowFail: true });
  if (component) run(['set-option', '-t', tmuxName(controlSlug), OPT_COMPONENT, component], { allowFail: true });
  if (front) run(['set-option', '-t', tmuxName(controlSlug), OPT_FRONT, front], { allowFail: true });
  if (runId) run(['set-option', '-t', tmuxName(controlSlug), OPT_RUN, runId], { allowFail: true });
  return { existed: false, tmux: tmuxName(controlSlug), controlSlug, agent };
}

/** What the pane shows, including the scrollback you asked for. */
export function capture(slug, { lines = 200, run = tmux } = {}) {
  // `-e` keeps the ANSI attributes. The server turns them into safe HTML;
  // without this tmux flattens the output and the agent loses all visual
  // hierarchy — which is most of how you read an agent at a glance.
  const out = run(['capture-pane', '-p', '-e', '-t', tmuxName(slug), '-S', `-${lines}`], { allowFail: true });
  return out === null ? null : out;
}

/** Free text: literal, so tmux never interprets it. Enter goes separately. */
export function sendText(slug, text, { enter = true, run = tmux } = {}) {
  if (typeof text !== 'string' || !text.length) throw new Error('empty text');
  clearLifecycleRequests(slug, { run });
  run(['send-keys', '-t', tmuxName(slug), '-l', text]);
  if (enter) run(['send-keys', '-t', tmuxName(slug), 'Enter']);
}

export function sendKey(slug, key, { run = tmux } = {}) {
  if (!KEYS.has(key)) throw new Error(`key not allowed: ${key}`);
  clearLifecycleRequests(slug, { run });
  run(['send-keys', '-t', tmuxName(slug), key]);
}

/**
 * Talking to a session that was wrapping up cancels the wrap-up: you asked it
 * for something else. Without this, a session you picked back up by hand stays
 * marked "wrapping up" forever and never offers its controls again.
 */
export function clearWrapup(slug, { run = tmux } = {}) {
  run(['set-option', '-t', tmuxName(slug), '-u', OPT_WRAPUP], { allowFail: true });
}

export function clearPause(slug, { run = tmux } = {}) {
  run(['set-option', '-t', tmuxName(slug), '-u', OPT_PAUSE], { allowFail: true });
}

export function clearLifecycleRequests(slug, { run = tmux } = {}) {
  clearWrapup(slug, { run });
  clearPause(slug, { run });
}

/**
 * Graceful wrap-up: the session is TOLD to finish, and then we wait. Killing the
 * process is not the same thing — the agent still has work to commit and state
 * to write down, and that is exactly what makes a session resumable.
 *
 * The Enter goes in a separate call, after a breath: in Claude Code a message
 * starting with `/` opens the command menu while you type, and an Enter glued to
 * the text picks from that list instead of sending the line.
 */
export function askToWrapUp(slug, {
  order = 'Please wrap up: finish what you are doing, commit your work, and summarise where you left off.',
  run = tmux,
  now = () => Math.floor(Date.now() / 1000),
  wait = breathe,
} = {}) {
  const session = sessions(run).find((s) => s.controlSlug === slug || s.slug === slug);
  if (!session) throw new Error('this session was not started here: it can be watched, not driven');
  const target = session.controlSlug;
  clearPause(target, { run });
  run(['send-keys', '-t', tmuxName(target), '-l', order]);
  wait(250);
  run(['send-keys', '-t', tmuxName(target), 'Enter']);
  run(['set-option', '-t', tmuxName(target), OPT_WRAPUP, String(now())], { allowFail: true });
  return { agent: session.agent, order };
}

/**
 * Cooperative pause. The process is deliberately left alive: the agent gets a
 * chance to finish the smallest safe unit and write a handoff, while tmux keeps
 * the exact conversation available for a later resume.
 */
export function askToPause(slug, {
  order = 'Please pause here safely: finish the smallest coherent unit, save or commit any work that must not be lost, write a short handoff, and do not start anything new.',
  run = tmux,
  now = () => Math.floor(Date.now() / 1000),
  wait = breathe,
} = {}) {
  const session = sessions(run).find((s) => s.controlSlug === slug || s.slug === slug);
  if (!session) throw new Error('this session was not started here: it can be watched, not driven');
  const target = session.controlSlug;
  clearWrapup(target, { run });
  run(['send-keys', '-t', tmuxName(target), '-l', order]);
  wait(250);
  run(['send-keys', '-t', tmuxName(target), 'Enter']);
  run(['set-option', '-t', tmuxName(target), OPT_PAUSE, String(now())], { allowFail: true });
  return { agent: session.agent, order };
}

export function resume(slug, {
  order = 'Please resume from the saved handoff and continue with the current task.',
  run = tmux,
  wait = breathe,
} = {}) {
  const session = sessions(run).find((s) => s.controlSlug === slug || s.slug === slug);
  if (!session) throw new Error('this session was not started here: it can be watched, not driven');
  if (session.error) throw new Error('the agent exited; start the session again instead');
  const target = session.controlSlug;
  clearLifecycleRequests(target, { run });
  run(['send-keys', '-t', tmuxName(target), '-l', order]);
  wait(250);
  run(['send-keys', '-t', tmuxName(target), 'Enter']);
  return { agent: session.agent, order };
}

/** Blocking pause between two `send-keys`: the order of the keys is the point. */
function breathe(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function kill(slug, { run = tmux } = {}) {
  run(['kill-session', '-t', tmuxName(slug)], { allowFail: true });
}
