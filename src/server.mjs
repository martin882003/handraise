// The HTTP surface. Small on purpose: the panel has no database and no model of
// its own, so every route either derives state from tmux and the hook files, or
// pushes a key into a pane.
//
// It binds to 127.0.0.1 by default. This drives real agents on your machine —
// exposing it to a network is a decision you have to make explicitly, and one
// you should only make behind something that authenticates.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

import { capture, exists, kill, askToWrapUp, sendKey, sendText, start } from './control.mjs';
import { ansiToHtml } from './ansi.mjs';
import { createPairingAuth } from './auth.mjs';
import { agentInvocation, createConfigStore, detectAdapter } from './config.mjs';
import { renameComponent, repositoriesSnapshot } from './repositories.mjs';
import { resolvePermission, snapshot, stateDir } from './state.mjs';

import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function pickDirectory() {
  const commands = process.platform === 'darwin'
    ? [['osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a Git repository")']]]
    : process.platform === 'win32'
      ? [['powershell.exe', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq "OK"){[Console]::Write($d.SelectedPath)}']]]
      : [['zenity', ['--file-selection', '--directory', '--title=Choose a Git repository']], ['kdialog', ['--getexistingdirectory', '.', 'Choose a Git repository']]];

  for (const [command, args] of commands) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 30_000, maxBuffer: 32_000 });
      const path = String(stdout || '').trim();
      if (path) return path;
    } catch (error) {
      // ENOENT means this picker is not installed. Any other exit is a user
      // cancellation (or a picker failure), so do not open a second dialog.
      if (error?.code !== 'ENOENT') return null;
    }
  }
  return null;
}

function browseDirectory(pathname = '') {
  const requested = String(pathname || '').trim() || homedir();
  const path = realpathSync(resolve(requested));
  if (!statSync(path).isDirectory()) throw new Error('path is not a directory');
  const parent = path === dirname(path) ? null : dirname(path);
  const directories = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  return { path, parent, directories };
}

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, '..', 'dist', 'ui');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function serveWeb(pathname, response, webRoot, { head = false } = {}) {
  let relative;
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'; }
  catch { return false; }
  if (relative.split('/').includes('..')) return false;

  const root = resolve(webRoot);
  let file = resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${sep}`)) return false;
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    if (extname(relative)) return false;
    file = join(root, 'index.html');
    try { if (!statSync(file).isFile()) return false; } catch { return false; }
  }

  const extension = extname(file);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': CONTENT_TYPES[extension] || 'application/octet-stream',
    'cache-control': relative.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  response.end(head ? undefined : readFileSync(file));
  return true;
}

// Session names come from the URL, so the pattern is the security boundary for
// everything downstream: tmux target names are built from it.
const SLUG = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_SLUG = /^[A-Za-z0-9._-]{1,140}$/;

const json = (response, code, payload, headers = {}) => {
  response.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
};

function requestOrigin(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  return `${forwardedProto || 'http'}://${forwardedHost || request.headers.host || '127.0.0.1'}`;
}

function publicOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function secureRequest(request) {
  return requestOrigin(request).startsWith('https://');
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === new URL(requestOrigin(request)).host; }
  catch { return false; }
}

function body(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) request.destroy(); });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

export function createHandraise({
  root = stateDir(), webRoot = WEB_ROOT,
  publicUrl = process.env.HANDRAISE_PUBLIC_URL || null,
  auth = createPairingAuth({ root }), config = createConfigStore({ root }),
} = {}) {
  const pairingOrigin = publicOrigin(publicUrl);
  mkdirSync(join(root, 'attention'), { recursive: true });
  mkdirSync(join(root, 'permissions'), { recursive: true });

  const clients = new Set();
  let timer = null;

  const push = () => {
    const payload = `data: ${JSON.stringify(snapshot({ root }))}\n\n`;
    for (const client of clients) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
  };

  // Two triggers, and both are needed. The watchers make a permission request
  // appear the instant the hook writes it — waiting up to two seconds to be told
  // you are blocking an agent is exactly the delay this tool exists to remove.
  // The interval covers what no file announces: a pane going quiet, an agent
  // finishing, a session being killed from another terminal.
  const watchers = ['attention', 'permissions'].map((name) => {
    try { return watch(join(root, name), () => push()); } catch { return null; }
  }).filter(Boolean);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (request.method === 'GET' && url.pathname === '/api/auth/status') {
        const device = auth.authenticate(request.headers.cookie);
        return json(response, 200, {
          authenticated: Boolean(device),
          needsSetup: !auth.hasDevices(),
          device,
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/pair') {
        if (!sameOrigin(request)) return json(response, 403, { error: 'cross-origin pairing is not allowed' });
        const payload = await body(request);
        const result = auth.pair(payload.token || payload.code, payload.name);
        return json(response, 200, { authenticated: true, device: result.device }, {
          'set-cookie': auth.cookie(result.token, { secure: secureRequest(request) }),
        });
      }

      const device = auth.authenticate(request.headers.cookie);
      if (url.pathname.startsWith('/api/') && !device) {
        return json(response, 401, { error: 'pair this device with Handraise first' });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
        return json(response, 403, { error: 'cross-origin request blocked' });
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        return json(response, 200, { ok: true }, {
          'set-cookie': auth.clearCookie({ secure: secureRequest(request) }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/devices') {
        return json(response, 200, { devices: auth.devices(), currentDeviceId: device.id });
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/pairing') {
        const pairing = auth.startPairing();
        const pairUrl = new URL('/', pairingOrigin || requestOrigin(request));
        pairUrl.searchParams.set('pair', pairing.token);
        const qr = await QRCode.toDataURL(pairUrl.toString(), {
          width: 320, margin: 1,
          color: { dark: '#171714', light: '#f1eee5' },
        });
        return json(response, 200, {
          code: pairing.code,
          expiresAt: pairing.expiresAt,
          qr,
          url: pairUrl.toString(),
        });
      }

      if (request.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'devices' && parts[3]) {
        const result = auth.revoke(parts[3]);
        const headers = parts[3] === device.id
          ? { 'set-cookie': auth.clearCookie({ secure: secureRequest(request) }) }
          : {};
        return json(response, 200, result, headers);
      }

      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return json(response, 200, config.snapshot());
      }

      if (request.method === 'PATCH' && url.pathname === '/api/settings/agents') {
        return json(response, 200, config.updateAgents(await body(request)));
      }

      if (request.method === 'GET' && url.pathname === '/api/repositories') {
        const repositories = config.read().repositories.map((repository) => ({
          ...repository, adapter: detectAdapter(repository.path),
        }));
        return json(response, 200, {
          repositories: repositoriesSnapshot({ repositories }, snapshot({ root }).sessions),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/repositories') {
        const payload = await body(request);
        return json(response, 201, { repository: config.addRepository(payload.path, payload) });
      }

      if (request.method === 'POST' && url.pathname === '/api/repositories/pick-directory') {
        return json(response, 200, { path: await pickDirectory() });
      }

      if (request.method === 'POST' && url.pathname === '/api/repositories/browse-directory') {
        const payload = await body(request);
        return json(response, 200, browseDirectory(payload.path));
      }

      if (request.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'components' && parts[4]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const payload = await body(request);
        const component = renameComponent({ ...repository, adapter: detectAdapter(repository.path) }, parts[4], payload.title);
        return json(response, 200, { component });
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'initialize') {
        return json(response, 200, { repository: config.initializeRepository(parts[2]) });
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && !parts[3]) {
        if (request.method === 'PATCH') {
          return json(response, 200, { repository: config.updateRepository(parts[2], await body(request)) });
        }
        if (request.method === 'DELETE') {
          return json(response, 200, config.removeRepository(parts[2]));
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        return json(response, 200, snapshot({ root }));
      }

      if (request.method === 'GET' && url.pathname === '/api/stream') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(`data: ${JSON.stringify(snapshot({ root }))}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return undefined;
      }

      // /api/session/<slug>/<action>
      if (parts[0] === 'api' && parts[1] === 'session' && parts[2]) {
        const slug = parts[2];
        if (!CONTROL_SLUG.test(slug)) return json(response, 400, { error: 'invalid session name' });
        const action = parts[3] ?? '';

        if (request.method === 'GET' && action === 'pane') {
          const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get('lines')) || 200));
          const text = capture(slug, { lines });
          if (text === null) return json(response, 404, { error: 'no pane for that session' });
          return json(response, 200, { html: ansiToHtml(text) });
        }

        if (request.method === 'POST' && !exists(slug)) {
          return json(response, 404, { error: 'that session was not started here' });
        }

        if (request.method === 'POST' && action === 'text') {
          const { text, enter = true } = await body(request);
          sendText(slug, String(text ?? ''), { enter: enter !== false });
          push();
          return json(response, 200, { ok: true });
        }

        if (request.method === 'POST' && action === 'key') {
          const { key } = await body(request);
          sendKey(slug, String(key ?? ''));
          push();
          return json(response, 200, { ok: true });
        }

        if (request.method === 'POST' && action === 'wrapup') {
          const { order } = await body(request);
          const result = askToWrapUp(slug, order ? { order: String(order) } : {});
          push();
          return json(response, 200, result);
        }

        if (request.method === 'DELETE' && !action) {
          kill(slug);
          push();
          return json(response, 200, { ok: true });
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/session') {
        const { slug, cwd, command, agent, repoId, component, front, model, effort } = await body(request);
        if (!SLUG.test(String(slug ?? ''))) return json(response, 400, { error: 'invalid session name' });
        const repository = repoId
          ? config.read().repositories.find((item) => item.id === repoId)
          : null;
        if (repoId && !repository) return json(response, 400, { error: 'repository not found' });
        const settings = config.read();
        const chosenAgent = String(agent || repository?.defaultAgent || (settings.agents.claude.enabled ? 'claude' : 'codex'));
        const agentSettings = settings.agents[chosenAgent];
        if (!agentSettings?.enabled) return json(response, 400, { error: `${chosenAgent} is disabled in Settings` });
        const invocation = agentInvocation(chosenAgent, {
          model: model || repository?.model || agentSettings.model,
          effort: effort || repository?.effort || agentSettings.effort,
        });
        const result = start({
          slug: String(slug),
          cwd: String(cwd || repository?.path || process.cwd()),
          command: command ? String(command) : invocation,
          agent: chosenAgent,
          repoId: repository?.id || null,
          component: component ? String(component) : null,
          front: front ? String(front) : null,
        });
        push();
        return json(response, 200, result);
      }

      // /api/permission/<key>
      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'permission' && parts[2]) {
        const { id, behavior } = await body(request);
        const result = resolvePermission(root, parts[2], String(id ?? ''), String(behavior ?? ''));
        push();
        return json(response, 200, result);
      }

      if (['GET', 'HEAD'].includes(request.method) && !url.pathname.startsWith('/api/')
        && serveWeb(url.pathname, response, webRoot, { head: request.method === 'HEAD' })) {
        return undefined;
      }

      return json(response, 404, { error: 'not found' });
    } catch (error) {
      return json(response, 400, { error: String(error?.message || error) });
    }
  });

  server.on('listening', () => { timer = setInterval(push, 2000); timer.unref?.(); });
  server.on('close', () => {
    clearInterval(timer);
    for (const watcher of watchers) watcher.close();
    for (const client of clients) client.end();
    clients.clear();
  });

  server.handraise = { auth, config };

  return server;
}
