import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'PermissionDenied', 'Stop', 'Notification', 'SessionEnd'];
const CODEX_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];
const SCRIPTS = ['attention.py', 'permission-request.py'];
export const HOOK_VERSION = 2;

function readJson(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function commandFor(target, script) {
  return `python3 "${join(target, script)}"`;
}

function owns(block, target) {
  return JSON.stringify(block).includes(target);
}

function removeOwnedHooks(document, target) {
  const hooks = document.hooks && typeof document.hooks === 'object' ? document.hooks : {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((block) => !owns(block, target));
    if (!hooks[event].length) delete hooks[event];
  }
  document.hooks = hooks;
  return document;
}

function handler(target, script, values = {}) {
  return { type: 'command', command: commandFor(target, script), ...values };
}

function installClaude(path, target) {
  const settings = removeOwnedHooks(readJson(path), target);
  const backup = `${path}.handraise-backup`;
  if (existsSync(path) && !existsSync(backup)) atomicJson(backup, readJson(path));
  for (const event of CLAUDE_EVENTS) {
    settings.hooks[event] ??= [];
    settings.hooks[event].push({ hooks: [handler(target, 'attention.py', { async: true, timeout: 10 })] });
  }
  settings.hooks.PermissionRequest ??= [];
  settings.hooks.PermissionRequest.push({ hooks: [handler(target, 'permission-request.py')] });
  atomicJson(path, settings);
}

function installCodex(path, target) {
  const settings = removeOwnedHooks(readJson(path, {
    description: 'User-level Codex hooks. Handraise-owned entries are safe outside Handraise sessions.',
    hooks: {},
  }), target);
  for (const event of CODEX_EVENTS) {
    settings.hooks[event] ??= [];
    const timeout = event === 'SessionEnd' ? 3 : 10;
    settings.hooks[event].push({ hooks: [handler(target, 'attention.py', { timeout })] });
  }
  settings.hooks.PermissionRequest ??= [];
  settings.hooks.PermissionRequest.push({ hooks: [handler(target, 'permission-request.py')] });
  atomicJson(path, settings);
}

export function hookPaths({ root, home = homedir() }) {
  const target = join(root, 'hooks');
  return {
    target,
    claude: join(home, '.claude', 'settings.json'),
    codex: join(home, '.codex', 'hooks.json'),
  };
}

function digest(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
}

export function hookStatus({ root, home = homedir(), sourceRoot = packageRoot }) {
  const paths = hookPaths({ root, home });
  const wired = (path, script) => JSON.stringify(readJson(path).hooks || {}).includes(join(paths.target, script));
  const scripts = Object.fromEntries(SCRIPTS.map((name) => [name, existsSync(join(paths.target, name))]));
  const installation = readJson(join(paths.target, 'installation.json'));
  const sourceCurrent = SCRIPTS.every((name) => {
    const installed = digest(join(paths.target, name));
    const expected = digest(join(sourceRoot, 'hooks', name));
    return Boolean(installed && expected && installed === expected);
  });
  const result = {
    scripts,
    version: Number(installation.version) || null,
    expectedVersion: HOOK_VERSION,
    sourceCurrent,
    claude: {
      configured: wired(paths.claude, 'attention.py') && wired(paths.claude, 'permission-request.py'),
      path: paths.claude,
    },
    codex: {
      configured: wired(paths.codex, 'attention.py') && wired(paths.codex, 'permission-request.py'),
      path: paths.codex,
      trustReview: 'Open /hooks once in Codex after an install or repair and trust the Handraise hooks.',
    },
  };
  result.repairNeeded = result.version !== HOOK_VERSION || !sourceCurrent
    || !Object.values(scripts).every(Boolean) || !result.claude.configured || !result.codex.configured;
  return result;
}

export function installHooks({ root, home = homedir(), sourceRoot = packageRoot } = {}) {
  if (!root) throw new Error('hook state root is required');
  const paths = hookPaths({ root, home });
  mkdirSync(paths.target, { recursive: true, mode: 0o700 });
  for (const name of SCRIPTS) {
    copyFileSync(join(sourceRoot, 'hooks', name), join(paths.target, name));
    chmodSync(join(paths.target, name), 0o700);
  }
  installClaude(paths.claude, paths.target);
  installCodex(paths.codex, paths.target);
  atomicJson(join(paths.target, 'installation.json'), {
    version: HOOK_VERSION,
    installedAt: new Date().toISOString(),
    integrations: ['claude', 'codex'],
  });
  return hookStatus({ root, home, sourceRoot });
}

export function uninstallHooks({ root, home = homedir() } = {}) {
  if (!root) throw new Error('hook state root is required');
  const paths = hookPaths({ root, home });
  for (const path of [paths.claude, paths.codex]) {
    if (!existsSync(path)) continue;
    atomicJson(path, removeOwnedHooks(readJson(path), paths.target));
  }
  for (const name of [...SCRIPTS, 'installation.json']) {
    try { unlinkSync(join(paths.target, name)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  try { rmdirSync(paths.target); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
  return hookStatus({ root, home });
}
