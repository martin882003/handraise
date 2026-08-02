import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import './styles.css';

type Status = 'blocked' | 'waiting' | 'wrapping' | 'working' | 'paused';

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
  controlSlug: string;
  agent: string;
  cwd: string | null;
  repoId: string | null;
  component: string | null;
  front: string | null;
  status: Status;
  reason: string | null;
  waitingSeconds: number;
  activity: { minutesAgo: number } | null;
  permission: Permission | null;
  controllable: boolean;
}

interface FleetState {
  sessions: AgentSession[];
  needsYou: number;
  at: string;
}

type View = 'repositories' | 'sessions' | 'components' | 'settings';
type FrontState = 'active' | 'queued' | 'blocked' | 'paused' | 'done';

interface RouteState {
  view: View;
  repositoryId: string | null;
  componentSlug: string | null;
  frontSlug: string | null;
  sessionSlug: string | null;
}

interface Front {
  slug: string;
  component: string;
  title: string;
  state: FrontState;
  done: number;
  total: number;
  percent: number;
  next: string | null;
  impact: string | null;
  complexity: string | null;
  kind: 'front' | 'backlog';
}

interface Component {
  slug: string;
  title: string;
  state: 'active' | 'closing';
  progress: number | null;
  activeFront: string | null;
  counts: Record<FrontState, number>;
  sections: Record<string, string>;
  fronts: Front[];
}

interface Repository {
  id: string;
  name: string;
  path: string;
  adapter: 'director' | 'handraise' | 'uninitialized';
  components: Component[];
  fronts: Front[];
  lanes: Array<{
    slug: string;
    component: string | null;
    worktree: string | null;
    statusText: string | null;
    liveness: 'live' | 'dead' | 'unknown';
  }>;
  summary?: { components: number; openFronts: number; activeSessions: number };
  error?: string;
}

interface AgentConfig {
  title: string;
  binary: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  model: string;
  effort: string;
  efforts: string[];
}

interface Settings {
  agents: Record<string, AgentConfig>;
  repositories: Array<Pick<Repository, 'id' | 'name' | 'path' | 'adapter'> & {
    defaultAgent: string | null;
    model: string;
    effort: string;
  }>;
}

interface AuthStatus {
  authenticated: boolean;
  needsSetup: boolean;
  device: { id: string; name: string } | null;
}

const baseRoute = (view: View = 'repositories'): RouteState => ({
  view, repositoryId: null, componentSlug: null, frontSlug: null, sessionSlug: null,
});

function parseRoute(pathname = window.location.pathname): RouteState {
  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] === 'settings') return baseRoute('settings');
  if (parts[0] !== 'repositories' || !parts[1]) return baseRoute();
  const repositoryId = parts[1];
  if (parts[2] === 'sessions') {
    return { ...baseRoute('sessions'), repositoryId, sessionSlug: parts[3] || null };
  }
  const componentSlug = parts[2] === 'components' ? parts[3] || null : null;
  const frontSlug = parts[4] === 'fronts' ? parts[5] || null : null;
  return { ...baseRoute('components'), repositoryId, componentSlug, frontSlug };
}

function routePath(route: RouteState): string {
  if (route.view === 'settings') return '/settings';
  if (!route.repositoryId || route.view === 'repositories') return '/repositories';
  const root = `/repositories/${encodeURIComponent(route.repositoryId)}`;
  if (route.view === 'sessions') {
    return `${root}/sessions${route.sessionSlug ? `/${encodeURIComponent(route.sessionSlug)}` : ''}`;
  }
  const component = route.componentSlug ? `/${encodeURIComponent(route.componentSlug)}` : '';
  const front = route.frontSlug ? `/fronts/${encodeURIComponent(route.frontSlug)}` : '';
  return `${root}/components${component}${front}`;
}

const STATUS_LABEL: Record<Status, string> = {
  blocked: 'Needs you',
  waiting: 'Waiting',
  wrapping: 'Wrapping up',
  working: 'Working',
  paused: 'Paused',
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

function plainCopy(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*[-#>]\s*/gm, '')
    .trim();
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

function SessionCard({ session, onOpen }: { session: AgentSession; onOpen?: () => void }) {
  const openFromKey = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen?.();
    }
  };

  return (
    <article
      class={`session-card ${session.status}`}
      tabIndex={onOpen ? 0 : undefined}
      role={onOpen ? 'button' : undefined}
      aria-label={onOpen ? `Open ${session.slug}, ${STATUS_LABEL[session.status]}` : `${session.slug}, ${STATUS_LABEL[session.status]}`}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) onOpen?.();
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
        <span class="open-label">{session.controllable ? 'Open session →' : 'View session →'}</span>
      </footer>
    </article>
  );
}

interface SessionDrawerProps {
  session: AgentSession | null;
  onClose: () => void;
  onOpenFront?: () => void;
}

function SessionDrawer({ session, onClose, onOpenFront }: SessionDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const terminalRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const [pane, setPane] = useState('');
  const [paneError, setPaneError] = useState('');
  const [message, setMessage] = useState('');

  const refreshPane = useCallback(async () => {
    if (!session?.controllable) return;
    try {
      const result = await api<{ html: string }>(`/api/session/${encodeURIComponent(session.controlSlug)}/pane?lines=400`);
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
      if (session.controllable) {
        void refreshPane();
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
    if (!session && dialog?.open) dialog.close();
  }, [session, refreshPane]);

  useEffect(() => {
    if (!session?.controllable) return;
    const timer = window.setInterval(() => void refreshPane(), 1200);
    return () => window.clearInterval(timer);
  }, [session, refreshPane]);

  const sendKey = async (key: string) => {
    if (!session) return;
    try {
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}/key`, {
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
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}/text`, {
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
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}/wrapup`, {
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
            {onOpenFront && <button onClick={onOpenFront}>View front</button>}
            {session?.controllable && <button onClick={() => void wrapUp()}>Wrap up</button>}
            <button onClick={onClose}>Close</button>
          </div>
        </header>
        {session?.controllable ? <pre
            ref={terminalRef}
            class="terminal"
            onScroll={(event) => {
              const node = event.currentTarget;
              pinned.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 40;
            }}
          >
            {paneError || <span dangerouslySetInnerHTML={{ __html: pane }} />}
          </pre> : <section class="external-session-detail">
            <p class="section-kicker">External session</p>
            <h2>{STATUS_LABEL[session?.status || 'paused']}</h2>
            <p>{session?.reason || 'This lane was registered outside Handraise.'}</p>
            <dl>
              <div><dt>Component</dt><dd>{session?.component || 'Unassigned'}</dd></div>
              <div><dt>Front</dt><dd>{session?.front || session?.slug}</dd></div>
              <div><dt>Worktree</dt><dd>{session?.cwd || 'Unknown'}</dd></div>
            </dl>
            <small>This session is visible but read-only because it was not started in a Handraise-controlled tmux pane.</small>
          </section>}
        {session?.controllable && <footer class="composer">
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
        </footer>}
      </div>
    </dialog>
  );
}

function PairScreen({ onPaired }: { onPaired: (status: AuthStatus) => void }) {
  const token = new URLSearchParams(window.location.search).get('pair');
  const [credential, setCredential] = useState(token || '');
  const [name, setName] = useState(/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'Browser');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);

  const pair = useCallback(async (value: string) => {
    if (!value) return;
    setPairing(true);
    setError('');
    try {
      const result = await api<AuthStatus>('/api/auth/pair', {
        method: 'POST', body: JSON.stringify(token ? { token: value, name } : { code: value, name }),
      });
      window.history.replaceState({}, '', '/');
      onPaired(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPairing(false);
    }
  }, [name, onPaired, token]);

  useEffect(() => { if (token) void pair(token); }, [pair, token]);

  return (
    <main class="pair-screen">
      <section class="pair-card">
        <img src="/handraise-mark.png" width="62" height="62" alt="" />
        <div>
          <p class="section-kicker">Device pairing</p>
          <h1>Connect to Handraise</h1>
          <p>Enter the one-time code shown in the terminal running <code>handraise serve</code>.</p>
        </div>
        <label>
          <span>Device name</span>
          <input value={name} onInput={(event) => setName(event.currentTarget.value)} autoComplete="off" />
        </label>
        <label>
          <span>Pairing code</span>
          <input
            class="pair-code-input"
            value={token ? 'Pairing from QR…' : credential}
            disabled={Boolean(token)}
            onInput={(event) => setCredential(event.currentTarget.value.toUpperCase())}
            onKeyDown={(event) => { if (event.key === 'Enter') void pair(credential); }}
            autoComplete="one-time-code"
            spellcheck={false}
          />
        </label>
        {error && <p class="form-error" role="alert">{error}</p>}
        <button class="primary pair-submit" disabled={pairing || !credential} onClick={() => void pair(credential)}>
          {pairing ? 'Connecting…' : 'Pair device'}
        </button>
        <small>Codes expire after five minutes. Paired devices can be revoked from Settings.</small>
      </section>
    </main>
  );
}

function PageHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: preact.ComponentChildren }) {
  return (
    <section class="page-heading">
      <div><p>{eyebrow}</p><h1>{title}</h1></div>
      {children}
    </section>
  );
}

function RepositoryOverview({ repositories, onSelect }: { repositories: Repository[]; onSelect: (id: string) => void }) {
  if (!repositories.length) {
    return <p class="empty-state">No repositories connected. Add the first one from Settings.</p>;
  }
  return (
    <section class="repository-grid">
      {repositories.map((repository) => (
        <button class="repository-card" key={repository.id} onClick={() => onSelect(repository.id)}>
          <span><strong>{repository.name}</strong><small>{repository.path}</small></span>
          <span class={`adapter-badge ${repository.adapter}`}>{repository.adapter}</span>
          <dl class="repository-signals">
            <div class="structure"><dt>Components</dt><dd>{repository.summary?.components || 0}</dd></div>
            <div class="fronts"><dt>Open fronts</dt><dd>{repository.summary?.openFronts || 0}</dd></div>
            <div class="operation"><dt>Sessions</dt><dd>{repository.summary?.activeSessions || 0}</dd></div>
          </dl>
          <span class="drill-label">Enter repository →</span>
        </button>
      ))}
    </section>
  );
}

function InitializeRepository({ repository, onInitialize }: { repository: Repository; onInitialize: () => Promise<void> }) {
  return (
    <div class="empty-state action-empty">
      <span>This repository is connected but has no Handraise project metadata yet.</span>
      <button class="primary" onClick={() => void onInitialize()}>Initialize repository</button>
    </div>
  );
}

function ComponentsView({
  repository, onInitialize, onOpen,
}: { repository: Repository; onInitialize: () => Promise<void>; onOpen: (slug: string) => void }) {
  if (repository.adapter === 'uninitialized') {
    return <InitializeRepository repository={repository} onInitialize={onInitialize} />;
  }
  if (!repository.components.length) return <p class="empty-state">No components registered in this repository.</p>;
  return (
    <section class="component-grid">
      {repository.components.map((component) => (
        <button class="component-card" key={component.slug} onClick={() => onOpen(component.slug)}>
          <header>
            <span><strong>{component.title}</strong><small>{component.slug}</small></span>
            <span class={`adapter-badge ${component.state}`}>{component.state}</span>
          </header>
          <div class="component-progress-heading"><span>Progress</span><b>{component.progress === null ? '—' : `${component.progress}%`}</b></div>
          <div class="component-progress">
            <span style={{ width: `${component.progress || 0}%` }} />
          </div>
          <p>{component.activeFront ? <>Working on <b>{component.activeFront}</b></> : 'No active front'}</p>
          <dl>
            <div class="active"><dt>Active</dt><dd>{component.counts.active}</dd></div>
            <div class="queued"><dt>Queued</dt><dd>{component.counts.queued}</dd></div>
            <div class="blocked"><dt>Blocked</dt><dd>{component.counts.blocked}</dd></div>
            <div class="done"><dt>Done</dt><dd>{component.counts.done}</dd></div>
          </dl>
          <span class="drill-label">Open component →</span>
        </button>
      ))}
    </section>
  );
}

const FRONT_LABEL: Record<FrontState, string> = {
  active: 'Active', queued: 'Queued', blocked: 'Blocked', paused: 'Paused', done: 'Done',
};

function FrontRows({ fronts, onOpen }: { fronts: Front[]; onOpen: (slug: string) => void }) {
  if (!fronts.length) return <p class="empty-state">No fronts registered in this component.</p>;
  return (
    <section class="front-list">
      {(['active', 'blocked', 'paused', 'queued', 'done'] as FrontState[]).map((state) => {
        const group = fronts.filter((front) => front.state === state);
        if (!group.length) return null;
        return (
          <section class="front-group" key={state}>
            <header><span>{FRONT_LABEL[state]}</span><b>{group.length}</b></header>
            {group.map((front) => (
              <button class={`front-row ${front.state}`} key={front.slug} onClick={() => onOpen(front.slug)}>
                <i aria-hidden="true" />
                <span class="front-main"><strong>{front.title}</strong><small>{front.slug} · {front.component}</small></span>
                <span class="front-priority">{front.impact && front.complexity ? `${front.impact} / ${front.complexity}` : 'unranked'}</span>
                <span class="front-progress">{front.done}/{front.total} · {front.percent}%</span>
              </button>
            ))}
          </section>
        );
      })}
    </section>
  );
}

function ComponentDetail({
  component, onBack, onOpenFront,
}: { component: Component; onBack: () => void; onOpenFront: (slug: string) => void }) {
  const description = Object.entries(component.sections).find(([title]) => /alcance|scope|purpose/i.test(title))?.[1]
    || Object.values(component.sections).find(Boolean)
    || 'This component has no written scope yet.';
  const fronts = component.fronts.filter((front) => front.kind === 'front');
  return (
    <>
      <nav class="breadcrumbs" aria-label="Breadcrumb"><button onClick={onBack}>Components</button><span>/</span><b>{component.title}</b></nav>
      <section class="entity-hero component-detail-hero">
        <div><p class="section-kicker">Component · {component.slug}</p><h1>{component.title}</h1><p class="entity-copy">{plainCopy(description)}</p></div>
        <dl>
          <div class="progress"><dt>Progress</dt><dd>{component.progress === null ? '—' : `${component.progress}%`}</dd></div>
          <div class="active"><dt>Active</dt><dd>{component.counts.active}</dd></div>
          <div class="open"><dt>Open</dt><dd>{component.counts.queued + component.counts.blocked + component.counts.paused}</dd></div>
        </dl>
        <div class="component-detail-progress"><span style={{ width: `${component.progress || 0}%` }} /></div>
      </section>
      <section class="detail-section">
        <header><div><p class="section-kicker">Work</p><h2>Fronts</h2></div><span>{fronts.length} total</span></header>
        <FrontRows fronts={fronts} onOpen={onOpenFront} />
      </section>
    </>
  );
}

function FrontDetail({
  front, component, session, onBack, onOpenSession,
}: {
  front: Front;
  component: Component;
  session: AgentSession | null;
  onBack: () => void;
  onOpenSession: (session: AgentSession) => void;
}) {
  return (
    <>
      <nav class="breadcrumbs" aria-label="Breadcrumb"><button onClick={onBack}>{component.title}</button><span>/</span><b>{front.title}</b></nav>
      <section class="entity-hero front-detail-hero">
        <div><p class="section-kicker">Front · {front.slug}</p><h1>{front.title}</h1><p class="entity-copy">{front.next ? `Next: ${front.next}` : 'No next action is registered.'}</p></div>
        <span class={`front-state-badge ${front.state}`}>{FRONT_LABEL[front.state]}</span>
        <dl>
          <div class="progress"><dt>Progress</dt><dd>{front.percent}%</dd></div>
          <div class="checklist"><dt>Checklist</dt><dd>{front.done}/{front.total}</dd></div>
          <div class="priority"><dt>Priority</dt><dd>{front.impact && front.complexity ? `${front.impact} / ${front.complexity}` : 'Unranked'}</dd></div>
        </dl>
        <div class={`front-detail-progress ${front.state}`}><span style={{ width: `${front.percent}%` }} /></div>
      </section>
      <section class="detail-section linked-session">
        <header><div><p class="section-kicker">Operation</p><h2>Session</h2></div></header>
        {session ? <div class="linked-session-row"><span><strong>{session.slug}</strong><small>{session.controllable ? 'Handraise-controlled' : 'External · read-only'}</small></span><button class="primary" onClick={() => onOpenSession(session)}>Open session</button></div>
          : <p class="empty-state">No session is linked to this front.</p>}
      </section>
    </>
  );
}

interface DeviceInfo { id: string; name: string; createdAt: string; lastSeenAt: string; expiresAt: string }
interface PairingInfo { code: string; expiresAt: string; qr: string; url: string }

function RepositorySettings({
  repository, agents, onRefresh,
}: {
  repository: Settings['repositories'][number];
  agents: Record<string, AgentConfig>;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    defaultAgent: repository.defaultAgent || '', model: repository.model, effort: repository.effort,
  });
  const save = async () => {
    await api(`/api/repositories/${repository.id}`, { method: 'PATCH', body: JSON.stringify(draft) });
    await onRefresh();
  };

  return (
    <article class="repository-setting">
      <div class="repository-setting-heading">
        <span><strong>{repository.name}</strong><small>{repository.path}</small></span>
        <span class={`adapter-badge ${repository.adapter}`}>{repository.adapter}</span>
      </div>
      <div class="repository-defaults">
        <label><span>Default agent</span><select value={draft.defaultAgent} onChange={(event) => setDraft({ ...draft, defaultAgent: event.currentTarget.value })}><option value="">Global default</option>{Object.entries(agents).filter(([, agent]) => agent.enabled).map(([id, agent]) => <option value={id}>{agent.title}</option>)}</select></label>
        <label><span>Model override</span><input value={draft.model} placeholder="Agent default" onInput={(event) => setDraft({ ...draft, model: event.currentTarget.value })} /></label>
        <label><span>Effort override</span><select value={draft.effort} onChange={(event) => setDraft({ ...draft, effort: event.currentTarget.value })}><option value="">Agent default</option>{['low', 'medium', 'high', 'xhigh'].map((effort) => <option value={effort}>{effort}</option>)}</select></label>
        <button onClick={() => void save()}>Save defaults</button>
        <button class="danger" onClick={async () => {
          if (!window.confirm(`Disconnect ${repository.name}? The repository will not be changed.`)) return;
          await api(`/api/repositories/${repository.id}`, { method: 'DELETE' });
          await onRefresh();
        }}>Disconnect</button>
      </div>
    </article>
  );
}

function SettingsView({
  settings, onRefresh,
}: { settings: Settings | null; onRefresh: () => Promise<void> }) {
  const [repoPath, setRepoPath] = useState('');
  const [repoName, setRepoName] = useState('');
  const [draftAgents, setDraftAgents] = useState<Record<string, AgentConfig>>({});
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [error, setError] = useState('');

  const loadDevices = useCallback(async () => {
    const result = await api<{ devices: DeviceInfo[]; currentDeviceId: string }>('/api/auth/devices');
    setDevices(result.devices);
    setCurrentDeviceId(result.currentDeviceId);
  }, []);

  useEffect(() => { if (settings) setDraftAgents(settings.agents); }, [settings]);
  useEffect(() => { void loadDevices(); }, [loadDevices]);

  const addRepository = async () => {
    setError('');
    try {
      await api('/api/repositories', {
        method: 'POST', body: JSON.stringify({ path: repoPath, name: repoName }),
      });
      setRepoPath('');
      setRepoName('');
      await onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const saveAgents = async () => {
    await api('/api/settings/agents', { method: 'PATCH', body: JSON.stringify(draftAgents) });
    await onRefresh();
  };

  const startPairing = async () => setPairing(await api<PairingInfo>('/api/auth/pairing', { method: 'POST', body: '{}' }));

  return (
    <div class="settings-stack">
      <section class="settings-section">
        <header><div><h2>Repositories</h2><p>Each repository owns its components, fronts and sessions.</p></div></header>
        <div class="repo-form">
          <label><span>Repository path</span><input value={repoPath} onInput={(event) => setRepoPath(event.currentTarget.value)} placeholder="/home/you/code/project" /></label>
          <label><span>Display name</span><input value={repoName} onInput={(event) => setRepoName(event.currentTarget.value)} placeholder="Optional" /></label>
          <button class="primary" disabled={!repoPath} onClick={() => void addRepository()}>Connect repository</button>
        </div>
        {error && <p class="form-error">{error}</p>}
        <div class="settings-list">
          {settings?.repositories.map((repository) => <RepositorySettings key={repository.id} repository={repository} agents={settings.agents} onRefresh={onRefresh} />)}
        </div>
      </section>

      <section class="settings-section">
        <header><div><h2>Agent integrations</h2><p>Handraise uses the authenticated CLI already installed on this machine.</p></div><button onClick={() => void saveAgents()}>Save agents</button></header>
        <div class="agent-settings">
          {Object.entries(draftAgents).map(([id, agent]) => (
            <article key={id}>
              <header><span><strong>{agent.title}</strong><small>{agent.installed ? agent.version : `${agent.binary} not found`}</small></span><input type="checkbox" checked={agent.enabled} onChange={(event) => setDraftAgents({ ...draftAgents, [id]: { ...agent, enabled: event.currentTarget.checked } })} /></header>
              <label><span>Default model</span><input value={agent.model} placeholder="CLI default" onInput={(event) => setDraftAgents({ ...draftAgents, [id]: { ...agent, model: event.currentTarget.value } })} /></label>
              <label><span>Reasoning effort</span><select value={agent.effort} onChange={(event) => setDraftAgents({ ...draftAgents, [id]: { ...agent, effort: event.currentTarget.value } })}><option value="">CLI default</option>{agent.efforts.map((effort) => <option value={effort}>{effort}</option>)}</select></label>
            </article>
          ))}
        </div>
      </section>

      <section class="settings-section">
        <header><div><h2>Paired devices</h2><p>Generate a one-time QR or code for another browser.</p></div><button class="primary" onClick={() => void startPairing()}>Pair another device</button></header>
        {pairing && <div class="pairing-panel"><img src={pairing.qr} width="180" height="180" alt="Pairing QR code" /><div><span>One-time code</span><strong>{pairing.code}</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</small><small>{new URL(pairing.url).hostname === '127.0.0.1' || new URL(pairing.url).hostname === 'localhost' ? 'For phone pairing, open Settings through the Tailscale HTTPS URL first.' : new URL(pairing.url).host}</small></div></div>}
        <div class="settings-list">
          {devices.map((device) => (
            <article key={device.id}>
              <span><strong>{device.name}{device.id === currentDeviceId ? ' · this device' : ''}</strong><small>Last seen {new Date(device.lastSeenAt).toLocaleString()}</small></span>
              <button class="danger" disabled={devices.length === 1} title={devices.length === 1 ? 'Pair another device before revoking this one' : undefined} onClick={async () => {
                await api(`/api/auth/devices/${device.id}`, { method: 'DELETE' });
                if (device.id === currentDeviceId) window.location.reload();
                else await loadDevices();
              }}>Revoke</button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function Workbench() {
  const [state, setState] = useState<FleetState>({ sessions: [], needsYou: 0, at: '' });
  const [connected, setConnected] = useState(false);
  const [route, setRoute] = useState<RouteState>(() => parseRoute());
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigate = useCallback((next: RouteState, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', routePath(next));
    setRoute(next);
    setMobileMenuOpen(false);
  }, []);

  const refreshRepositories = useCallback(async () => {
    const repositoryData = await api<{ repositories: Repository[] }>('/api/repositories');
    setRepositories(repositoryData.repositories);
    setRoute((current) => {
      if (!current.repositoryId || repositoryData.repositories.some((repository) => repository.id === current.repositoryId)) return current;
      const fallback = baseRoute();
      window.history.replaceState({}, '', routePath(fallback));
      return fallback;
    });
  }, []);

  const refreshManagement = useCallback(async () => {
    const [, settingsData] = await Promise.all([refreshRepositories(), api<Settings>('/api/settings')]);
    setSettings(settingsData);
  }, [refreshRepositories]);

  useEffect(() => {
    const stream = new EventSource('/api/stream');
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (event) => setState(JSON.parse(event.data) as FleetState);
    return () => stream.close();
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => { void refreshManagement(); }, []);
  useEffect(() => {
    if (!['repositories', 'components'].includes(route.view)) return;
    void refreshRepositories();
    const timer = window.setInterval(() => void refreshRepositories(), 5_000);
    return () => window.clearInterval(timer);
  }, [route.view, refreshRepositories]);

  const selectedRepo = route.repositoryId;
  const controlledSessions = selectedRepo
    ? state.sessions.filter((session) => session.repoId === selectedRepo)
    : [];
  const controlledKeys = new Set(state.sessions.map((session) => `${session.repoId}:${session.front || session.slug}`));
  const externalSessions: AgentSession[] = repositories
    .filter((repository) => repository.id === selectedRepo)
    .flatMap((repository) => (repository.lanes || [])
      .filter((lane) => !controlledKeys.has(`${repository.id}:${lane.slug}`))
      .map((lane) => ({
        slug: lane.slug,
        controlSlug: `external:${repository.id}:${lane.slug}`,
        agent: 'external',
        cwd: lane.worktree,
        repoId: repository.id,
        component: lane.component,
        front: lane.slug,
        status: lane.liveness === 'dead' ? 'paused' : 'working',
        reason: lane.statusText,
        waitingSeconds: 0,
        activity: null,
        permission: null,
        controllable: false,
      })));
  const visibleSessions = [...controlledSessions, ...externalSessions];
  const selectedRepository = repositories.find((repository) => repository.id === selectedRepo) || null;
  const selectedComponent = selectedRepository?.components.find((component) => component.slug === route.componentSlug) || null;
  const selectedFront = selectedComponent?.fronts.find((front) => front.slug === route.frontSlug) || null;
  const frontSession = selectedFront
    ? visibleSessions.find((session) => session.front === selectedFront.slug || session.slug === selectedFront.slug) || null
    : null;
  const openSession = route.sessionSlug
    ? visibleSessions.find((session) => session.controlSlug === route.sessionSlug) || null
    : null;
  const openSessionComponent = openSession?.component
    ? selectedRepository?.components.find((component) => component.slug === openSession.component) || null
    : null;
  const openSessionFront = openSessionComponent && openSession?.front
    ? openSessionComponent.fronts.find((front) => front.slug === openSession.front) || null
    : null;
  const initializeRepository = async () => {
    if (!selectedRepository) return;
    await api(`/api/repositories/${selectedRepository.id}/initialize`, { method: 'POST', body: '{}' });
    await refreshManagement();
  };
  const needsYou = visibleSessions.filter((session) => ['blocked', 'waiting'].includes(session.status)).length;
  const summary = visibleSessions.length
    ? `${visibleSessions.length} session${visibleSessions.length === 1 ? '' : 's'}`
    : 'No sessions';
  const wrapping = visibleSessions.filter((session) => session.status === 'wrapping').length;
  const liveSummary = needsYou
    ? <>{summary} · <b>{needsYou} need{needsYou === 1 ? 's' : ''} you</b></>
    : wrapping
      ? `${summary} · ${wrapping} wrapping up`
      : `${summary} · all clear`;
  const headerStatus = selectedRepository
    ? (connected ? (state.at ? liveSummary : 'Connecting…') : (state.at ? `Offline · ${summary} last seen` : 'Connecting…'))
    : `${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}`;
  const repositoryRoute = (repositoryId: string, view: 'components' | 'sessions' = 'components'): RouteState => ({
    ...baseRoute(view), repositoryId,
  });
  const openSessionRoute = (session: AgentSession) => {
    if (!selectedRepo) return;
    navigate({ ...repositoryRoute(selectedRepo, 'sessions'), sessionSlug: session.controlSlug });
  };

  return (
    <>
      <header class="topbar">
        <button class="brand-lockup" onClick={() => navigate(baseRoute())} aria-label="Choose a repository">
          <img src="/handraise-mark.png" width="38" height="38" alt="" />
          <span>
            <strong>Handraise</strong>
            <small>Local agent control</small>
          </span>
        </button>
        <nav class="primary-nav" aria-label="Primary navigation">
          <button class={route.view === 'repositories' ? 'active' : ''} onClick={() => navigate(baseRoute())}>Repositories</button>
          {selectedRepo && <button class={route.view === 'components' ? 'active' : ''} onClick={() => navigate(repositoryRoute(selectedRepo))}>Components</button>}
          {selectedRepo && <button class={route.view === 'sessions' ? 'active' : ''} onClick={() => navigate(repositoryRoute(selectedRepo, 'sessions'))}>Sessions</button>}
        </nav>
        <select class="repo-select" aria-label="Repository" value={selectedRepo || ''} onChange={(event) => {
          const repositoryId = event.currentTarget.value;
          navigate(repositoryId ? repositoryRoute(repositoryId) : baseRoute());
        }}>
          <option value="">Choose repository</option>
          {repositories.map((repository) => <option value={repository.id}>{repository.name}</option>)}
        </select>
        <div class="fleet-summary" aria-live="polite">
          <i class={connected ? 'online' : ''} aria-hidden="true" />
          <span>{headerStatus}</span>
        </div>
        <button class={`settings-shortcut ${route.view === 'settings' ? 'active' : ''}`} onClick={() => navigate(baseRoute('settings'))}>Settings</button>
        <button
          class="mobile-menu-toggle"
          aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-utility-menu"
          onClick={() => setMobileMenuOpen((open) => !open)}
        ><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></button>
        <section id="mobile-utility-menu" class={`mobile-menu-panel ${mobileMenuOpen ? 'open' : ''}`}>
          <button class={route.view === 'settings' ? 'active' : ''} onClick={() => navigate(baseRoute('settings'))}>
            <span>Settings</span><small>Repositories, agents and paired devices</small>
          </button>
          <div class="mobile-menu-status" aria-live="polite"><i class={connected ? 'online' : ''} aria-hidden="true" /><span>{headerStatus}</span></div>
        </section>
      </header>

      <main class="workspace">
        {route.view === 'repositories' && <>
          <PageHeading eyebrow="Local workspaces" title="Repositories" />
          <RepositoryOverview repositories={repositories} onSelect={(repositoryId) => navigate(repositoryRoute(repositoryId))} />
        </>}

        {route.view === 'sessions' && selectedRepository && <>
          <PageHeading eyebrow={selectedRepository.name} title="Sessions">
            <div class="legend" aria-label="Session status legend">{(Object.keys(STATUS_LABEL) as Status[]).map((status) => <span class={status} key={status}><i aria-hidden="true" />{STATUS_LABEL[status]}</span>)}</div>
          </PageHeading>
          <section class="session-grid" aria-label="Agent sessions" aria-live="polite">
            {visibleSessions.length ? visibleSessions.map((session) => <SessionCard key={session.controlSlug} session={session} onOpen={() => openSessionRoute(session)} />) : state.at ? <p class="empty-state">No sessions in this repository.</p> : <p class="empty-state">Connecting to the local Handraise service…</p>}
          </section>
        </>}

        {route.view === 'components' && selectedRepository && <>
          {selectedFront && selectedComponent ? <FrontDetail
              front={selectedFront}
              component={selectedComponent}
              session={frontSession}
              onBack={() => navigate({ ...repositoryRoute(selectedRepository.id), componentSlug: selectedComponent.slug })}
              onOpenSession={openSessionRoute}
            /> : selectedComponent ? <ComponentDetail
              component={selectedComponent}
              onBack={() => navigate(repositoryRoute(selectedRepository.id))}
              onOpenFront={(frontSlug) => navigate({ ...repositoryRoute(selectedRepository.id), componentSlug: selectedComponent.slug, frontSlug })}
            /> : <>
              <PageHeading eyebrow={selectedRepository.name} title="Components" />
              <ComponentsView
                repository={selectedRepository}
                onInitialize={initializeRepository}
                onOpen={(componentSlug) => navigate({ ...repositoryRoute(selectedRepository.id), componentSlug })}
              />
            </>}
        </>}

        {route.view === 'settings' && <>
          <PageHeading eyebrow="Handraise" title="Settings" />
          <SettingsView settings={settings} onRefresh={refreshManagement} />
        </>}
      </main>

      <SessionDrawer
        session={openSession}
        onClose={() => selectedRepo && navigate(repositoryRoute(selectedRepo, 'sessions'), { replace: true })}
        onOpenFront={selectedRepo && openSessionComponent && openSessionFront
          ? () => navigate({ ...repositoryRoute(selectedRepo), componentSlug: openSessionComponent.slug, frontSlug: openSessionFront.slug })
          : undefined}
      />
    </>
  );
}

function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  useEffect(() => {
    api<AuthStatus>('/api/auth/status').then(setAuth).catch(() => setAuth({ authenticated: false, needsSetup: false, device: null }));
  }, []);
  if (!auth) return <main class="pair-screen"><p>Loading Handraise…</p></main>;
  return auth.authenticated ? <Workbench /> : <PairScreen onPaired={setAuth} />;
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}
