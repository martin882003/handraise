import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SERVICE_NAME = 'handraise.service';
export const SERVICE_VERSION = 1;

const unitQuote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function servicePath(home = homedir()) {
  return join(home, '.config', 'systemd', 'user', SERVICE_NAME);
}

export function serviceDefinition({
  nodePath = process.execPath,
  binPath,
  stateRoot,
  home = homedir(),
  path = process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  host = '127.0.0.1',
  port = 4177,
} = {}) {
  if (!binPath) throw new Error('Handraise CLI path is required');
  if (!stateRoot) throw new Error('Handraise state path is required');
  if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(String(host))) {
    throw new Error('service host must be an IP address or hostname without spaces');
  }
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error('service port must be an integer between 1 and 65535');
  }
  return [
    `# Handraise user service v${SERVICE_VERSION}`,
    '[Unit]',
    'Description=Handraise local agent control server',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${unitQuote(home)}`,
    `Environment=${unitQuote(`HANDRAISE_HOME=${stateRoot}`)}`,
    `Environment=${unitQuote(`PATH=${path}`)}`,
    `ExecStart=${unitQuote(nodePath)} ${unitQuote(binPath)} serve --host ${unitQuote(host)} --port ${Number(port)}`,
    'Restart=on-failure',
    'RestartSec=2',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function requireSupport(platform) {
  if (platform !== 'linux') {
    throw new Error('persistent service management is currently supported on Linux with systemd user services');
  }
}

function systemctl(args, { run = execFileSync, allowFail = false } = {}) {
  try {
    return String(run('systemctl', ['--user', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', allowFail ? 'ignore' : 'pipe'], timeout: 15_000,
    }) || '').trim();
  } catch (error) {
    if (allowFail) return '';
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`systemd user service command failed: ${detail || args.join(' ')}`);
  }
}

export function installService({
  home = homedir(), platform = process.platform, run = execFileSync, start = true, ...definition
} = {}) {
  requireSupport(platform);
  const path = servicePath(home);
  const content = serviceDefinition({ home, ...definition });
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no staged file */ }
    throw error;
  }
  systemctl(['daemon-reload'], { run });
  systemctl(start ? ['enable', '--now', SERVICE_NAME] : ['enable', SERVICE_NAME], { run });
  return { path, started: start, version: SERVICE_VERSION };
}

export function serviceStatus({ home = homedir(), platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'linux') return { supported: false, installed: false, enabled: false, active: false, path: null, version: null };
  const path = servicePath(home);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return {
    supported: true,
    installed: Boolean(text),
    enabled: systemctl(['is-enabled', SERVICE_NAME], { run, allowFail: true }) === 'enabled',
    active: systemctl(['is-active', SERVICE_NAME], { run, allowFail: true }) === 'active',
    path,
    version: Number(text.match(/^# Handraise user service v(\d+)$/m)?.[1]) || null,
    current: Boolean(text) && Number(text.match(/^# Handraise user service v(\d+)$/m)?.[1]) === SERVICE_VERSION,
  };
}

export function controlService(action, { platform = process.platform, run = execFileSync } = {}) {
  requireSupport(platform);
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('service action must be start, stop or restart');
  systemctl([action, SERVICE_NAME], { run });
  return { action };
}

export function uninstallService({ home = homedir(), platform = process.platform, run = execFileSync } = {}) {
  requireSupport(platform);
  const path = servicePath(home);
  systemctl(['disable', '--now', SERVICE_NAME], { run, allowFail: true });
  try { unlinkSync(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  systemctl(['daemon-reload'], { run });
  return { removed: path };
}
