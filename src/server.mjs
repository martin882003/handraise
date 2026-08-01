// The HTTP surface. Small on purpose: the panel has no database and no model of
// its own, so every route either derives state from tmux and the hook files, or
// pushes a key into a pane.
//
// It binds to 127.0.0.1 by default. This drives real agents on your machine —
// exposing it to a network is a decision you have to make explicitly, and one
// you should only make behind something that authenticates.

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { capture, exists, kill, askToWrapUp, sendKey, sendText, start } from './control.mjs';
import { ansiToHtml } from './ansi.mjs';
import { resolvePermission, snapshot, stateDir } from './state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, '..', 'public', 'index.html');

// Session names come from the URL, so the pattern is the security boundary for
// everything downstream: tmux target names are built from it.
const SLUG = /^[A-Za-z0-9._-]{1,64}$/;

const json = (response, code, payload) => {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
};

function body(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) request.destroy(); });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

export function createHandraise({ root = stateDir() } = {}) {
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
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return response.end(readFileSync(PAGE));
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
        if (!SLUG.test(slug)) return json(response, 400, { error: 'invalid session name' });
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
        const { slug, cwd, command, agent } = await body(request);
        if (!SLUG.test(String(slug ?? ''))) return json(response, 400, { error: 'invalid session name' });
        const result = start({
          slug: String(slug),
          cwd: String(cwd || process.cwd()),
          command: command ? String(command) : undefined,
          agent: agent ? String(agent) : undefined,
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

  return server;
}
