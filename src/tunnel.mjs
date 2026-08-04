import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

const PROVIDER = 'cloudflare-quick';
const TITLE = 'Cloudflare Quick Tunnel';
const QUICK_ORIGIN = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?![a-z0-9.-])/i;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cleanTarget(value) {
  let target;
  try { target = new URL(String(value || '')); }
  catch { throw new Error('managed tunnel target is invalid'); }
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (target.protocol !== 'http:' || target.username || target.password || (!isIP(hostname) && hostname !== 'localhost')) {
    throw new Error('managed tunnels may target only this server through a numeric local HTTP address');
  }
  if (target.pathname !== '/' || target.search || target.hash || !target.port) {
    throw new Error('managed tunnel target must be the server HTTP origin');
  }
  return target.origin;
}

function inspectCloudflared(binary, env) {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000, env,
  });
  if (result.error || result.status !== 0) return { installed: false, version: null };
  return { installed: true, version: String(result.stdout || '').trim().split('\n')[0] || null };
}

export function quickTunnelOrigin(output) {
  const match = String(output || '').match(QUICK_ORIGIN);
  if (!match) return null;
  try { return new URL(match[0]).origin; }
  catch { return null; }
}

export class ManagedInternetTunnel {
  constructor({
    root,
    binary = 'cloudflared',
    env = process.env,
    spawnProcess = spawn,
    inspectConnector = () => inspectCloudflared(binary, env),
    startupTimeoutMs = 30_000,
    stopTimeoutMs = 3_000,
    now = () => Date.now(),
  } = {}) {
    if (!root) throw new Error('managed tunnel state root is required');
    this.root = root;
    this.binary = binary;
    this.env = env;
    this.spawnProcess = spawnProcess;
    this.inspectConnector = inspectConnector;
    this.startupTimeoutMs = startupTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.now = now;
    this.configPath = join(root, 'cloudflared-quick.yml');
    this.connector = { installed: false, version: null };
    this.state = { status: 'idle', publicUrl: null, target: null, startedAt: null, error: null };
    this.child = null;
    this.exitPromise = null;
    this.startPromise = null;
    this.intentionalChild = null;
    this.logTail = '';
    this.refreshAvailability();
  }

  refreshAvailability() {
    try { this.connector = { installed: false, version: null, ...this.inspectConnector() }; }
    catch { this.connector = { installed: false, version: null }; }
    return this.connector;
  }

  snapshot() {
    return {
      provider: PROVIDER,
      title: TITLE,
      installed: Boolean(this.connector.installed),
      version: this.connector.version || null,
      status: this.state.status,
      publicUrl: this.state.publicUrl,
      target: this.state.target,
      startedAt: this.state.startedAt,
      error: this.state.error,
      temporary: true,
      public: true,
      supportsSse: false,
      managed: true,
    };
  }

  async start({ target } = {}) {
    const origin = cleanTarget(target);
    if (this.child && this.state.status === 'ready') return this.snapshot();
    if (this.startPromise) return this.startPromise;
    if (this.state.status === 'stopping') throw new Error('the managed tunnel is still stopping');
    if (this.child) await this.stop();
    const connector = this.refreshAvailability();
    if (!connector.installed) throw new Error('cloudflared is not installed on the server host');

    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(this.configPath, '# Empty configuration reserved for the Handraise quick tunnel.\n', { mode: 0o600 });
    this.logTail = '';
    this.state = {
      status: 'starting', publicUrl: null, target: origin,
      startedAt: new Date(this.now()).toISOString(), error: null,
    };

    let child;
    try {
      child = this.spawnProcess(this.binary, [
        'tunnel', '--config', this.configPath, '--no-autoupdate',
        '--metrics', '127.0.0.1:0', '--url', origin,
      ], {
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.state = { ...this.state, status: 'failed', error: String(error?.message || error) };
      throw error;
    }
    this.child = child;
    this.intentionalChild = null;

    let resolveExit;
    this.exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error('Cloudflare did not issue a public URL within 30 seconds'));
      }, this.startupTimeoutMs);

      const finish = (publicUrl) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = { ...this.state, status: 'ready', publicUrl, error: null };
        this.startPromise = null;
        resolve(this.snapshot());
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message = String(error?.message || error || 'managed tunnel failed');
        this.state = { ...this.state, status: 'failed', publicUrl: null, error: message };
        this.startPromise = null;
        try { if (this.child === child && child.exitCode === null) child.kill('SIGTERM'); } catch { /* process already exited */ }
        reject(new Error(message));
      };
      const consume = (chunk) => {
        this.logTail = `${this.logTail}${String(chunk || '')}`.slice(-16_000);
        const publicUrl = quickTunnelOrigin(this.logTail);
        if (publicUrl) finish(publicUrl);
      };

      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
      child.once('error', fail);
      child.once('exit', (code, signal) => {
        const intentional = this.intentionalChild === child;
        if (this.child === child) this.child = null;
        resolveExit({ code, signal });
        if (this.state.status === 'starting') {
          fail(new Error(intentional
            ? 'managed tunnel startup was cancelled'
            : `cloudflared exited before the tunnel was ready${code === null ? '' : ` (code ${code})`}`));
          return;
        }
        if (intentional || this.state.status === 'stopping') {
          this.state = { status: 'idle', publicUrl: null, target: null, startedAt: null, error: null };
          return;
        }
        if (this.state.status === 'ready') {
          this.state = {
            ...this.state, status: 'failed', publicUrl: null,
            error: `cloudflared stopped unexpectedly${code === null ? '' : ` (code ${code})`}`,
          };
        }
      });
    });
    return this.startPromise;
  }

  async stop() {
    const child = this.child;
    if (!child) {
      this.state = { status: 'idle', publicUrl: null, target: null, startedAt: null, error: null };
      return this.snapshot();
    }
    this.intentionalChild = child;
    this.state = { ...this.state, status: 'stopping', error: null };
    try { child.kill('SIGTERM'); } catch { /* process already exited */ }
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      delay(this.stopTimeoutMs).then(() => false),
    ]);
    if (!exited && this.child === child) {
      try { child.kill('SIGKILL'); } catch { /* process already exited */ }
      await Promise.race([this.exitPromise, delay(1_000)]);
    }
    if (this.child === child) this.child = null;
    this.state = { status: 'idle', publicUrl: null, target: null, startedAt: null, error: null };
    return this.snapshot();
  }
}

export function createManagedInternetTunnel(options) {
  return new ManagedInternetTunnel(options);
}
