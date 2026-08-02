import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import './styles.css';

type Status = 'blocked' | 'waiting' | 'wrapping' | 'working';

interface Permission {
  id: string;
  key: string;
  waitingSeconds: number;
  tool?: {
    name?: string;
    input?: Record<string, unknown>;
  };
}

interface AgentSession {
  slug: string;
  agent: string;
  cwd: string | null;
  status: Status;
  reason: string | null;
  waitingSeconds: number;
  activity: { minutesAgo: number } | null;
  permission: Permission | null;
}

interface FleetState {
  sessions: AgentSession[];
  needsYou: number;
  at: string;
}

const STATUS_LABEL: Record<Status, string> = {
  blocked: 'Needs you',
  waiting: 'Waiting',
  wrapping: 'Wrapping up',
  working: 'Working',
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

function age(seconds: number): string {
  if (!seconds) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function permissionSummary(permission: Permission): string {
  const input = permission.tool?.input ?? {};
  const value = input.command ?? input.file_path ?? input.url;
  return typeof value === 'string' ? value : JSON.stringify(input, null, 1);
}

function PermissionRequest({ permission }: { permission: Permission }) {
  const [deciding, setDeciding] = useState<'allow' | 'deny' | null>(null);

  const decide = async (behavior: 'allow' | 'deny') => {
    setDeciding(behavior);
    try {
      await api(`/api/permission/${encodeURIComponent(permission.key)}`, {
        method: 'POST',
        body: JSON.stringify({ id: permission.id, behavior }),
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setDeciding(null);
    }
  };

  return (
    <section class="permission" aria-label="Permission request">
      <div class="permission-title">
        {permission.tool?.name || 'Tool'} · waiting {age(permission.waitingSeconds)}
      </div>
      <code>{permissionSummary(permission)}</code>
      <div class="button-row">
        <button class="primary" disabled={deciding !== null} onClick={() => void decide('allow')}>
          {deciding === 'allow' ? 'Allowing…' : 'Allow once'}
        </button>
        <button class="danger" disabled={deciding !== null} onClick={() => void decide('deny')}>
          {deciding === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </div>
    </section>
  );
}

function SessionCard({ session, onOpen }: { session: AgentSession; onOpen: () => void }) {
  const openFromKey = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <article
      class={`session-card ${session.status}`}
      tabIndex={0}
      role="button"
      aria-label={`Open ${session.slug}, ${STATUS_LABEL[session.status]}`}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) onOpen();
      }}
      onKeyDown={openFromKey}
    >
      <div class="card-heading">
        <span class="session-name"><i class="state-dot" aria-hidden="true" />{session.slug}</span>
        <span class="status-label">
          {STATUS_LABEL[session.status]}{session.waitingSeconds ? ` · ${age(session.waitingSeconds)}` : ''}
        </span>
      </div>
      <div class="session-meta">
        {[session.cwd, session.activity ? `active ${session.activity.minutesAgo}m ago` : null]
          .filter(Boolean).join(' · ')}
      </div>
      {session.status !== 'blocked' && session.reason && <div class="session-meta">{session.reason}</div>}
      {session.permission && <PermissionRequest permission={session.permission} />}
      <footer class="card-footer">
        <span>{session.agent || 'agent'}</span>
        <span class="open-label">Open session →</span>
      </footer>
    </article>
  );
}

interface SessionDrawerProps {
  session: AgentSession | null;
  onClose: () => void;
}

function SessionDrawer({ session, onClose }: SessionDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const terminalRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const [pane, setPane] = useState('');
  const [paneError, setPaneError] = useState('');
  const [message, setMessage] = useState('');

  const refreshPane = useCallback(async () => {
    if (!session) return;
    try {
      const result = await api<{ html: string }>(`/api/session/${encodeURIComponent(session.slug)}/pane?lines=400`);
      const terminal = terminalRef.current;
      const atBottom = terminal
        ? terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 40
        : true;
      setPaneError('');
      setPane(result.html);
      requestAnimationFrame(() => {
        const current = terminalRef.current;
        if (current && (pinned.current || atBottom)) current.scrollTop = current.scrollHeight;
      });
    } catch (error) {
      setPane('');
      setPaneError(String(error instanceof Error ? error.message : error));
    }
  }, [session]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (session && dialog && !dialog.open) {
      dialog.showModal();
      void refreshPane();
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!session && dialog?.open) dialog.close();
  }, [session, refreshPane]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => void refreshPane(), 1200);
    return () => window.clearInterval(timer);
  }, [session, refreshPane]);

  const sendKey = async (key: string) => {
    if (!session) return;
    try {
      await api(`/api/session/${encodeURIComponent(session.slug)}/key`, {
        method: 'POST', body: JSON.stringify({ key }),
      });
      window.setTimeout(() => void refreshPane(), 220);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const sendMessage = async () => {
    if (!session || !message) return;
    const text = message;
    setMessage('');
    try {
      await api(`/api/session/${encodeURIComponent(session.slug)}/text`, {
        method: 'POST', body: JSON.stringify({ text }),
      });
      window.setTimeout(() => void refreshPane(), 220);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setMessage(text);
    }
  };

  const wrapUp = async () => {
    if (!session || !window.confirm(`Ask ${session.slug} to wrap up? It will finish its turn and save a handoff.`)) return;
    try {
      await api(`/api/session/${encodeURIComponent(session.slug)}/wrapup`, {
        method: 'POST', body: '{}',
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onClose} onCancel={onClose}>
      <div class="drawer">
        <header class="drawer-header">
          <div class="drawer-identity">
            <strong>{session?.slug}</strong>
            <small>{[session?.agent, session?.cwd].filter(Boolean).join(' · ')}</small>
          </div>
          <div class="button-row">
            <button onClick={() => void wrapUp()}>Wrap up</button>
            <button onClick={onClose}>Close</button>
          </div>
        </header>
        <pre
          ref={terminalRef}
          class="terminal"
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 40;
          }}
        >
          {paneError || <span dangerouslySetInnerHTML={{ __html: pane }} />}
        </pre>
        <footer class="composer">
          <input
            ref={inputRef}
            value={message}
            onInput={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void sendMessage();
            }}
            placeholder="Type to the agent"
            aria-label="Message to agent"
            autoComplete="off"
            spellcheck={false}
          />
          <button onClick={() => void sendMessage()}>Send</button>
          <button onClick={() => void sendKey('Escape')}>Esc</button>
          <button onClick={() => void sendKey('Up')}>↑</button>
          <button onClick={() => void sendKey('Down')}>↓</button>
          <button onClick={() => void sendKey('C-c')}>Ctrl-C</button>
        </footer>
      </div>
    </dialog>
  );
}

function App() {
  const [state, setState] = useState<FleetState>({ sessions: [], needsYou: 0, at: '' });
  const [connected, setConnected] = useState(false);
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  useEffect(() => {
    const stream = new EventSource('/api/stream');
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (event) => setState(JSON.parse(event.data) as FleetState);
    return () => stream.close();
  }, []);

  const openSession = useMemo(
    () => state.sessions.find((session) => session.slug === openSlug) ?? null,
    [openSlug, state.sessions],
  );
  const summary = state.sessions.length
    ? `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'}`
    : 'No sessions';
  const wrapping = state.sessions.filter((session) => session.status === 'wrapping').length;
  const liveSummary = state.needsYou
    ? <>{summary} · <b>{state.needsYou} need{state.needsYou === 1 ? 's' : ''} you</b></>
    : wrapping
      ? `${summary} · ${wrapping} wrapping up`
      : `${summary} · all clear`;

  return (
    <>
      <header class="topbar">
        <div class="brand-lockup">
          <img src="/handraise-mark.svg" width="38" height="38" alt="" />
          <span>
            <strong>Handraise</strong>
            <small>Local agent control</small>
          </span>
        </div>
        <div class="fleet-summary" aria-live="polite">
          <i class={connected ? 'online' : ''} aria-hidden="true" />
          <span>{connected ? (state.at ? liveSummary : 'Connecting…') : (state.at ? `Offline · ${summary} last seen` : 'Connecting…')}</span>
        </div>
      </header>

      <main class="workspace">
        <section class="page-heading" aria-labelledby="sessions-title">
          <div>
            <p>Current workspace</p>
            <h1 id="sessions-title">Sessions</h1>
          </div>
          <div class="legend" aria-label="Session status legend">
            {(Object.keys(STATUS_LABEL) as Status[]).map((status) => (
              <span class={status} key={status}><i aria-hidden="true" />{STATUS_LABEL[status]}</span>
            ))}
          </div>
        </section>

        <section class="session-grid" aria-label="Agent sessions" aria-live="polite">
          {state.sessions.length ? state.sessions.map((session) => (
            <SessionCard key={session.slug} session={session} onOpen={() => setOpenSlug(session.slug)} />
          )) : state.at ? (
            <p class="empty-state">
              No sessions yet. Start one with <code>handraise start &lt;name&gt;</code>.
            </p>
          ) : (
            <p class="empty-state">Connecting to the local Handraise service…</p>
          )}
        </section>
      </main>

      <SessionDrawer session={openSession} onClose={() => setOpenSlug(null)} />
    </>
  );
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}
