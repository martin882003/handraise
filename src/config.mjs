import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { hookStatus } from './hooks.mjs';
import { initializeNativeRepository, repositoryAvailability } from './repositories.mjs';

const AGENTS = {
  claude: {
    title: 'Claude Code', binary: 'claude', efforts: ['low', 'medium', 'high', 'xhigh'],
    authStatus: ['auth', 'status', '--json'], loginCommand: 'claude auth login', logoutCommand: 'claude auth logout',
    capabilities: { terminal: true, lifecycleAttention: true, typedPermissions: true, gracefulWrapup: true },
  },
  codex: {
    title: 'Codex', binary: 'codex', efforts: ['low', 'medium', 'high', 'xhigh'],
    authStatus: ['login', 'status'], loginCommand: 'codex login', logoutCommand: 'codex logout',
    capabilities: { terminal: true, lifecycleAttention: true, typedPermissions: true, gracefulWrapup: true },
  },
};

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function agentInvocation(id, configured = {}) {
  if (!AGENTS[id]) throw new Error(`unknown agent: ${id}`);
  const model = String(configured.model || '').trim();
  const effort = String(configured.effort || '').trim();
  const prompt = String(configured.prompt || '').trim();
  if (effort && !AGENTS[id].efforts.includes(effort)) throw new Error(`invalid effort for ${id}`);
  if (id === 'codex') {
    return ['codex', model ? `-m ${shellQuote(model)}` : '', effort ? `-c ${shellQuote(`model_reasoning_effort=${effort}`)}` : '', prompt ? shellQuote(prompt) : '']
      .filter(Boolean).join(' ');
  }
  return ['claude', model ? `--model ${shellQuote(model)}` : '', effort ? `--effort ${shellQuote(effort)}` : '', prompt ? shellQuote(prompt) : '']
    .filter(Boolean).join(' ');
}

export function agentAuthInvocation(id, action = 'login') {
  const definition = AGENTS[id];
  if (!definition) throw new Error(`unknown agent: ${id}`);
  if (!['login', 'logout'].includes(action)) throw new Error('agent authentication action must be login or logout');
  return action === 'login' ? definition.loginCommand : definition.logoutCommand;
}

const defaults = () => ({
  version: 1,
  agents: {
    claude: { enabled: true, model: '', effort: 'high' },
    codex: { enabled: true, model: '', effort: 'high' },
  },
  repositories: [],
});

const slug = (value) => String(value || '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'repo';

function repositoryId(path) {
  return `${slug(basename(path))}-${createHash('sha256').update(path).digest('hex').slice(0, 7)}`;
}

function gitRoot(path) {
  const absolute = realpathSync(resolve(path));
  if (!statSync(absolute).isDirectory()) throw new Error('repository path is not a directory');
  try {
    return execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
  } catch {
    throw new Error(`'${absolute}' is not a Git repository`);
  }
}

function authSnapshot(id, definition, env = process.env) {
  const base = {
    connected: false,
    provider: null,
    email: null,
    plan: null,
    loginCommand: definition.loginCommand,
    logoutCommand: definition.logoutCommand,
  };
  try {
    const result = spawnSync(definition.binary, definition.authStatus, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, env,
    });
    if (result.error || result.status !== 0) throw result.error || new Error('auth status failed');
    const stdout = String(result.stdout || '').trim();
    const output = `${stdout}\n${String(result.stderr || '').trim()}`.trim();
    if (id === 'claude') {
      const status = JSON.parse(stdout);
      return {
        ...base,
        connected: Boolean(status.loggedIn),
        provider: status.apiProvider || null,
        email: status.email || null,
        plan: status.subscriptionType || null,
      };
    }
    const connected = /logged in/i.test(output) && !/not logged in/i.test(output);
    return { ...base, connected, provider: connected ? 'ChatGPT' : null };
  } catch {
    return base;
  }
}

export function detectAdapter(path) {
  const exists = (target) => { try { return statSync(join(path, target)).isDirectory(); } catch { return false; } };
  if (exists('.claude/components') && exists('.claude/runtime/plans')) return 'director';
  if (exists('.handraise/components') && exists('.handraise/fronts')) return 'handraise';
  return 'uninitialized';
}

function normalize(data) {
  const base = defaults();
  const agents = Object.fromEntries(Object.keys(AGENTS).map((id) => [id, {
    ...base.agents[id],
    ...(data?.agents?.[id] || {}),
    enabled: data?.agents?.[id]?.enabled !== false,
  }]));
  const repositories = Array.isArray(data?.repositories)
    ? data.repositories.filter((repo) => repo?.id && repo?.path).map((repo) => ({
      id: String(repo.id), name: String(repo.name || basename(repo.path)), path: String(repo.path),
      addedAt: repo.addedAt || new Date().toISOString(),
      defaultAgent: AGENTS[repo.defaultAgent] ? repo.defaultAgent : null,
      model: String(repo.model || ''), effort: String(repo.effort || ''),
    }))
    : [];
  return { version: 1, agents, repositories };
}

export class ConfigStore {
  constructor({ root, resolveRepository = gitRoot, home = homedir(), env = process.env }) {
    this.root = root;
    this.home = home;
    this.path = join(root, 'settings.json');
    this.resolveRepository = resolveRepository;
    this.env = env;
  }

  read() {
    try { return normalize(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch { return defaults(); }
  }

  write(settings) {
    const clean = normalize(settings);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    return clean;
  }

  addRepository(path, options = {}) {
    const root = this.resolveRepository(path);
    const settings = this.read();
    const existing = settings.repositories.find((repo) => repo.path === root);
    if (existing) return { ...existing, adapter: detectAdapter(existing.path) };
    const repository = {
      id: repositoryId(root),
      name: String(options.name || basename(root)).trim().slice(0, 80),
      path: root,
      addedAt: new Date().toISOString(),
      defaultAgent: AGENTS[options.defaultAgent] ? options.defaultAgent : null,
      model: '',
      effort: '',
    };
    settings.repositories.push(repository);
    this.write(settings);
    return { ...repository, adapter: detectAdapter(root) };
  }

  updateRepository(id, changes) {
    const settings = this.read();
    const repository = settings.repositories.find((repo) => repo.id === id);
    if (!repository) throw new Error('repository not found');
    if (changes.name !== undefined) repository.name = String(changes.name).trim().slice(0, 80) || repository.name;
    if (changes.defaultAgent !== undefined) {
      if (changes.defaultAgent && !AGENTS[changes.defaultAgent]) throw new Error('unknown agent');
      repository.defaultAgent = changes.defaultAgent || null;
    }
    if (changes.model !== undefined) repository.model = String(changes.model).trim().slice(0, 120);
    if (changes.effort !== undefined) {
      const effort = String(changes.effort).trim();
      if (effort && !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('invalid effort');
      repository.effort = effort;
    }
    this.write(settings);
    return { ...repository, adapter: detectAdapter(repository.path) };
  }

  removeRepository(id) {
    const settings = this.read();
    const before = settings.repositories.length;
    settings.repositories = settings.repositories.filter((repo) => repo.id !== id);
    if (before === settings.repositories.length) throw new Error('repository not found');
    this.write(settings);
    return { removed: id };
  }

  initializeRepository(id) {
    const repository = this.read().repositories.find((repo) => repo.id === id);
    if (!repository) throw new Error('repository not found');
    const adapter = detectAdapter(repository.path);
    if (adapter !== 'uninitialized') return { ...repository, adapter };
    return initializeNativeRepository(repository);
  }

  updateAgents(changes) {
    const settings = this.read();
    for (const [id, values] of Object.entries(changes || {})) {
      if (!AGENTS[id] || !values || typeof values !== 'object') continue;
      if (values.enabled !== undefined) settings.agents[id].enabled = Boolean(values.enabled);
      if (values.model !== undefined) settings.agents[id].model = String(values.model).trim().slice(0, 120);
      if (values.effort !== undefined) {
        const effort = String(values.effort).trim();
        if (effort && !AGENTS[id].efforts.includes(effort)) throw new Error(`invalid effort for ${id}`);
        settings.agents[id].effort = effort;
      }
    }
    return this.write(settings);
  }

  snapshot() {
    const settings = this.read();
    const hooks = hookStatus({ root: this.root, home: this.home });
    let notifySend = false;
    try {
      execFileSync('notify-send', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000, env: this.env });
      notifySend = true;
    } catch { /* optional desktop integration */ }
    const graphicalSession = Boolean(this.env.DISPLAY || this.env.WAYLAND_DISPLAY);
    return {
      ...settings,
      hooks,
      platform: {
        desktopNotifications: {
          available: process.platform === 'linux' && notifySend && graphicalSession,
          provider: process.platform === 'linux' && notifySend ? 'notify-send' : null,
          optional: true,
          reason: process.platform !== 'linux' ? 'Desktop notifications are currently supported only on Linux.'
            : !notifySend ? 'Install notify-send to enable optional desktop notifications.'
              : !graphicalSession ? 'No graphical session is visible to the Handraise server.' : null,
        },
      },
      repositories: settings.repositories.map((repo) => ({
        ...repo, adapter: detectAdapter(repo.path), availability: repositoryAvailability(repo.path),
      })),
      agents: Object.fromEntries(Object.entries(settings.agents).map(([id, configured]) => {
        const definition = AGENTS[id];
        const { authStatus: _authStatus, loginCommand: _loginCommand, logoutCommand: _logoutCommand, ...publicDefinition } = definition;
        let version = null;
        try {
          version = execFileSync(definition.binary, ['--version'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000, env: this.env,
          }).trim().split('\n')[0];
        } catch { /* not installed */ }
        return [id, {
          ...publicDefinition, ...configured, installed: Boolean(version), version,
          auth: authSnapshot(id, definition, this.env),
          capabilities: {
            ...definition.capabilities,
            configured: hooks[id].configured,
            setup: id === 'codex' && hooks[id].configured ? hooks.codex.trustReview : null,
          },
        }];
      })),
    };
  }
}

export function createConfigStore(options) {
  return new ConfigStore(options);
}
