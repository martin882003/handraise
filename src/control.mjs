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
export const OPT_ERROR = '@handraise-error';
export const OPT_CWD = '@handraise-cwd';

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
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10000 }).trimEnd();
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
  ];
  const out = run(['list-sessions', '-F', fields.join('\t')], { allowFail: true });
  if (!out) return [];
  return out.split('\n').filter(Boolean).flatMap((line) => {
    const [name, attached, activity, agent, wrapup, error, cwd] = line.split('\t');
    if (!name?.startsWith(PREFIX)) return [];
    return [{
      slug: name.slice(PREFIX.length),
      tmux: name,
      attached: attached === '1',
      activity: Number(activity) || null,
      agent: agent || 'claude',
      wrapupAskedAt: Number(wrapup) || null,
      error: error || null,
      cwd: cwd || null,
    }];
  });
}

export function exists(slug, run = tmux) {
  return sessions(run).some((s) => s.slug === slug);
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
export function start({ slug, cwd, command = 'claude', agent = 'claude', env = {}, run = tmux }) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(slug)) throw new Error(`invalid session name: '${slug}'`);
  const previous = sessions(run).find((s) => s.slug === slug);
  if (previous && !previous.error) return { existed: true, tmux: tmuxName(slug) };
  if (previous?.error) run(['kill-session', '-t', tmuxName(slug)]);

  const exported = Object.entries({ HANDRAISE: '1', ...env })
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join(' ');
  const script = holdError(`export ${exported}; ${command}`);

  run(['new-session', '-d', '-x', '160', '-y', '48', '-s', tmuxName(slug), '-c', cwd, script]);
  // Recorded after creation because before it there is nowhere to record it. If
  // this failed the session is still drivable and reads back as the default.
  run(['set-option', '-t', tmuxName(slug), OPT_AGENT, agent], { allowFail: true });
  run(['set-option', '-t', tmuxName(slug), OPT_CWD, cwd], { allowFail: true });
  return { existed: false, tmux: tmuxName(slug), agent };
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
  clearWrapup(slug, { run });
  run(['send-keys', '-t', tmuxName(slug), '-l', text]);
  if (enter) run(['send-keys', '-t', tmuxName(slug), 'Enter']);
}

export function sendKey(slug, key, { run = tmux } = {}) {
  if (!KEYS.has(key)) throw new Error(`key not allowed: ${key}`);
  clearWrapup(slug, { run });
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
  const session = sessions(run).find((s) => s.slug === slug);
  if (!session) throw new Error('this session was not started here: it can be watched, not driven');
  run(['send-keys', '-t', tmuxName(slug), '-l', order]);
  wait(250);
  run(['send-keys', '-t', tmuxName(slug), 'Enter']);
  run(['set-option', '-t', tmuxName(slug), OPT_WRAPUP, String(now())], { allowFail: true });
  return { agent: session.agent, order };
}

/** Blocking pause between two `send-keys`: the order of the keys is the point. */
function breathe(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function kill(slug, { run = tmux } = {}) {
  run(['kill-session', '-t', tmuxName(slug)], { allowFail: true });
}
