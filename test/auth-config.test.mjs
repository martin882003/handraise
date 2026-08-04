import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { PairingAuth } from '../src/auth.mjs';
import { agentAuthInvocation, agentInvocation, ConfigStore } from '../src/config.mjs';
import {
  askToPause as controlPause, askToWrapUp as controlWrapUp, capture as controlCapture,
  kill as controlKill, resume as controlResume, sendText as controlSendText,
  sessions as controlSessions, start as controlStart,
} from '../src/control.mjs';
import { analyzeNativeRepository, DiscoveryDraftStore } from '../src/discovery.mjs';
import { fleetManagerPrompt, fleetVerdict } from '../src/fleet.mjs';
import { HistoryTracker, historyOutcomes, historySummary, readHistory } from '../src/history.mjs';
import { hookStatus, installHooks, uninstallHooks } from '../src/hooks.mjs';
import { implicitLocalClient, isLoopbackHost, isLoopbackPeer, LOCAL_CLIENT_ID } from '../src/local-client.mjs';
import { PlanningRuntime } from '../src/planning/runtime.mjs';
import { pairingOriginFor, remoteAccessOptions } from '../src/remote-access.mjs';
import {
  createComponent, createFront, deleteComponent, deleteFront, repositoryPortfolio,
  initializeNativeRepository, repositoriesSnapshot, repositoryAvailability, setComponentState, updateFront,
} from '../src/repositories.mjs';
import { createHandraise } from '../src/server.mjs';
import { installService, serviceDefinition, serviceStatus, uninstallService } from '../src/service.mjs';
import { ManagedInternetTunnel, quickTunnelOrigin } from '../src/tunnel.mjs';
import { createWorktree, gitState, removeWorktree, workshopSnapshot } from '../src/worktrees.mjs';

function requestJson(base, pathname, {
  method = 'GET', host = 'remote.test', origin, cookie, headers = {}, payload,
} = {}) {
  const target = new URL(pathname, base);
  const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        host,
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
        ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}),
        ...headers,
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: raw ? JSON.parse(raw) : null,
      }));
    });
    request.on('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

function planningAdapterFixture() {
  const descriptor = {
    id: 'fixture-planner', name: 'Fixture planner', version: '1.0.0', contractVersion: 1,
    provider: { id: 'fixture', name: 'Fixture provider' },
    authentication: { owner: 'first-party-cli', method: 'fixture saved auth', credentialsStoredByHandraise: false },
    capabilities: { operations: ['component-design', 'front-design', 'portfolio-review'], structuredOutput: true, toolFreeInvocation: true, cancellation: true, usage: ['input_tokens'], cost: false, boundedContext: true },
    dataBoundary: { kind: 'cloud', destination: 'Fixture provider boundary', sourceMayLeaveHost: true, requiresConsent: true },
    models: [{ id: 'default', label: 'Fixture default', default: true }],
    degradation: { fallback: 'deterministic-manual', summary: 'Manual component and front editing remains available.' },
  };
  return {
    descriptor,
    detect: () => ({ available: true, version: 'fixture-cli-1.0', authentication: { connected: true } }),
    run: async () => ({
      output: {
        schemaVersion: 1, operation: 'component-design', summary: 'Fixture proposal.',
        components: [{
          slug: 'proposed-runtime', title: 'Proposed Runtime', responsibility: 'Own the proposed runtime.',
          outcomes: [], responsibilities: [], limits: [], invariants: [], interfaces: [], dependencies: [], dataSystems: [], territory: [], verification: [],
          evidenceIds: [], uncertainty: 'high', assumptions: ['Fixture output has no repository claim.'], questions: [],
        }],
        fronts: [], findings: [], assumptions: [], questions: [],
      },
      usage: { input_tokens: 12, output_tokens: 8 }, cost: null,
    }),
    dispose() {},
  };
}

test('pairing creates a persistent, revocable device without storing the raw token', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-auth-'));
  let now = 1_800_000_000_000;
  const auth = new PairingAuth({ root, now: () => now });
  const pairing = auth.pairingDetails();
  const result = auth.pair(pairing.code, 'Martin phone');

  assert.equal(auth.authenticate(`x=1; handraise_session=${result.token}`)?.name, 'Martin phone');
  assert.ok(!readFileSync(join(root, 'auth.json'), 'utf8').includes(result.token));
  assert.equal(statSync(join(root, 'auth.json')).mode & 0o777, 0o600);

  now += 1_000;
  const restarted = new PairingAuth({ root, now: () => now });
  assert.equal(restarted.authenticate(`handraise_session=${result.token}`)?.id, result.device.id);
  assert.throws(() => restarted.revoke(result.device.id), /final active device/);
  assert.deepEqual(restarted.revoke(result.device.id, { allowFinal: true }), { revoked: result.device.id });
  assert.equal(restarted.authenticate(`handraise_session=${result.token}`), null);
  const secondPairing = restarted.startPairing();
  const laptop = restarted.pair(secondPairing.code, 'Laptop');
  assert.throws(() => restarted.revoke(laptop.device.id), /final active device/);
  restarted.reset();
  assert.equal(restarted.hasDevices(), false);
});

test('invalid pairing codes do not create a device', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-auth-'));
  const auth = new PairingAuth({ root });
  assert.throws(() => auth.pair('WRONGCODE', 'attacker'), /invalid pairing code/);
  assert.equal(auth.hasDevices(), false);
});

test('implicit local trust requires the direct loopback peer and an exact loopback Host', () => {
  for (const host of ['localhost', 'LOCALHOST:4188', '127.0.0.1', '127.0.0.1:4188', '::1', '[::1]', '[::1]:4188']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['127.1', '127.0.0.2', 'localhost.', 'localhost:0', 'localhost:65536', 'remote.test', 'localhost,remote.test']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackPeer(peer), true, peer);
  for (const peer of ['127.0.0.2', '192.168.1.8', '100.96.0.3', '::ffff:192.168.1.8']) assert.equal(isLoopbackPeer(peer), false, peer);

  const local = implicitLocalClient({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:4188' } });
  assert.equal(local?.id, LOCAL_CLIENT_ID);
  assert.equal(local?.revocable, false);
  assert.equal(implicitLocalClient({
    socket: { remoteAddress: '192.168.1.8' },
    headers: { host: 'localhost:4188', 'x-forwarded-for': '127.0.0.1' },
  }), null);
  assert.equal(implicitLocalClient({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'remote.test', 'x-forwarded-host': 'localhost:4188' },
  }), null);
});

test('remote access distinguishes reachable private addresses from explicit HTTPS Internet origins', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    ethernet: [
      { address: '192.168.50.20', family: 'IPv4', internal: false },
      { address: '203.0.113.8', family: 'IPv4', internal: false },
    ],
    tailscale0: [{ address: '100.96.4.3', family: 'IPv4', internal: false }],
  };
  const localOnly = remoteAccessOptions({
    listener: { address: '127.0.0.1', port: 4188, family: 'IPv4' }, interfaces,
    publicUrl: 'http://public.example',
  });
  assert.deepEqual(localOnly.privateNetwork.addresses.map((item) => item.address), ['192.168.50.20', '100.96.4.3']);
  assert.equal(localOnly.privateNetwork.ready, false);
  assert.equal(localOnly.privateNetwork.url, 'http://192.168.50.20:4188');
  assert.match(localOnly.privateNetwork.restartCommand, /--host 0\.0\.0\.0 --port 4188/);
  assert.equal(localOnly.internet.configured, true);
  assert.equal(localOnly.internet.ready, false, 'plain HTTP is never an Internet pairing origin');
  assert.throws(() => pairingOriginFor(localOnly, { mode: 'private', address: '192.168.50.20' }), /not reachable.*--host 0\.0\.0\.0/);
  assert.throws(() => pairingOriginFor(localOnly, { mode: 'internet', publicUrl: 'http://public.example' }), /requires the HTTPS public URL/);
  assert.equal(pairingOriginFor(localOnly, { mode: 'internet', publicUrl: 'https://public.example/path' }), 'https://public.example');

  const exposed = remoteAccessOptions({
    listener: { address: '0.0.0.0', port: 4188, family: 'IPv4' }, interfaces,
  });
  assert.equal(exposed.privateNetwork.ready, true);
  assert.equal(pairingOriginFor(exposed, { mode: 'private', address: '100.96.4.3' }), 'http://100.96.4.3:4188');
  assert.throws(() => pairingOriginFor(exposed, { mode: 'private', address: '203.0.113.8' }), /no private LAN|no private.*available/);
});

test('managed Internet tunnels parse only provider origins and have an idempotent supervised lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-tunnel-'));
  const children = [];
  const launches = [];
  const spawnProcess = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      queueMicrotask(() => {
        if (child.exitCode !== null) return;
        child.exitCode = 0;
        child.emit('exit', 0, signal);
      });
      return true;
    };
    children.push(child);
    launches.push({ binary, args, options });
    return child;
  };
  const tunnel = new ManagedInternetTunnel({
    root, spawnProcess,
    inspectConnector: () => ({ installed: true, version: 'cloudflared fixture 1.0' }),
    startupTimeoutMs: 200,
  });

  assert.equal(quickTunnelOrigin('INF https://fixture-name.trycloudflare.com ready'), 'https://fixture-name.trycloudflare.com');
  assert.equal(quickTunnelOrigin('https://fixture-name.trycloudflare.com.evil.test'), null);
  const starting = tunnel.start({ target: 'http://127.0.0.1:4188' });
  const duplicateStart = tunnel.start({ target: 'http://127.0.0.1:4188' });
  assert.equal(tunnel.snapshot().status, 'starting');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].binary, 'cloudflared');
  assert.deepEqual(launches[0].args.slice(-2), ['--url', 'http://127.0.0.1:4188']);
  assert.equal(launches[0].options.stdio[0], 'ignore');
  children[0].stderr.write('INF Your quick Tunnel has been created! Visit it at https://fixture-name.trycloudflare.com\n');
  const ready = await starting;
  assert.equal((await duplicateStart).publicUrl, ready.publicUrl);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.publicUrl, 'https://fixture-name.trycloudflare.com');
  assert.equal((await tunnel.start({ target: 'http://127.0.0.1:4188' })).publicUrl, ready.publicUrl);
  assert.equal(launches.length, 1, 'starting an already-live tunnel is idempotent');
  assert.equal((await tunnel.stop()).status, 'idle');
  assert.deepEqual(children[0].signals, ['SIGTERM']);
});

test('managed Internet tunnel startup fails closed on early exit and timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-tunnel-failure-'));
  const missing = new ManagedInternetTunnel({
    root, inspectConnector: () => ({ installed: false }), startupTimeoutMs: 10,
  });
  assert.equal(missing.snapshot().installed, false);
  await assert.rejects(missing.start({ target: 'http://127.0.0.1:4188' }), /cloudflared is not installed/);
  const processes = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = (signal) => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, signal));
      return true;
    };
    processes.push(child);
    return child;
  };
  const early = new ManagedInternetTunnel({
    root, spawnProcess, inspectConnector: () => ({ installed: true }), startupTimeoutMs: 100,
  });
  const earlyStart = early.start({ target: 'http://127.0.0.1:4188' });
  processes[0].exitCode = 7;
  processes[0].emit('exit', 7, null);
  await assert.rejects(earlyStart, /exited before the tunnel was ready.*code 7/);
  assert.equal(early.snapshot().status, 'failed');

  const timed = new ManagedInternetTunnel({
    root, spawnProcess, inspectConnector: () => ({ installed: true }), startupTimeoutMs: 10,
  });
  await assert.rejects(timed.start({ target: 'http://127.0.0.1:4188' }), /did not issue a public URL/);
  assert.equal(timed.snapshot().status, 'failed');
  await assert.rejects(timed.start({ target: 'https://public.example' }), /numeric local HTTP address/);
});

test('the HTTP server exposes an implicit local client without persisting or revoking it', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-local-client-'));
  const root = join(home, 'state');
  const repositoryRoot = join(home, 'repository');
  const webRoot = join(home, 'web');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  const auth = new PairingAuth({ root });
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home });
  const server = createHandraise({ root, webRoot, auth, config });
  assert.equal(statSync(root).mode & 0o777, 0o700, 'the server repairs its state trust boundary before serving clients');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    if (error?.code === 'EPERM') {
      server.close();
      context.skip('the execution sandbox does not permit a local listening socket');
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const localStatus = await requestJson(base, '/api/auth/status', { host: `localhost:${address.port}` });
  assert.equal(localStatus.status, 200);
  assert.equal(localStatus.body.authenticated, true);
  assert.equal(localStatus.body.implicitLocal, true);
  assert.equal(localStatus.body.device.id, LOCAL_CLIENT_ID);
  assert.equal(auth.devices().length, 0);
  assert.equal(existsSync(join(root, 'auth.json')), false);

  const repairedHooks = await requestJson(base, '/api/settings/hooks/repair', {
    method: 'POST', host: `localhost:${address.port}`, origin: `http://localhost:${address.port}`, payload: {},
  });
  assert.equal(repairedHooks.status, 200);
  assert.equal(repairedHooks.body.hooks.repairNeeded, false);
  assert.equal(existsSync(join(root, 'hooks', 'attention.py')), true);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), true);
  assert.equal(existsSync(join(home, '.codex', 'hooks.json')), true);

  const localDevices = await requestJson(base, '/api/auth/devices', { host: `127.0.0.1:${address.port}` });
  assert.deepEqual(localDevices.body.devices.map((device) => device.id), [LOCAL_CLIENT_ID]);
  assert.equal(localDevices.body.devices[0].revocable, false);

  const pairing = await requestJson(base, '/api/auth/pairing', {
    method: 'POST', host: `localhost:${address.port}`, origin: `http://localhost:${address.port}`, payload: {},
  });
  assert.equal(pairing.status, 200);
  assert.ok(pairing.body.code);
  assert.equal(auth.devices().length, 0, 'generating a remote pairing code does not persist the local client');
  assert.equal(existsSync(join(root, 'auth.json')), false);

  const unnecessaryLocalPair = await requestJson(base, '/api/auth/pair', {
    method: 'POST', host: `localhost:${address.port}`, origin: `http://localhost:${address.port}`,
    payload: { code: pairing.body.code, name: 'Must not be stored' },
  });
  assert.equal(unnecessaryLocalPair.body.implicitLocal, true);
  assert.equal(unnecessaryLocalPair.body.paired, false);
  assert.equal(auth.devices().length, 0);
  assert.equal(existsSync(join(root, 'auth.json')), false);

  const logout = await requestJson(base, '/api/auth/logout', {
    method: 'POST', host: `localhost:${address.port}`, origin: `http://localhost:${address.port}`, payload: {},
  });
  assert.equal(logout.body.remainsAuthenticated, true);
  assert.equal(logout.body.device.id, LOCAL_CLIENT_ID);
  const afterLogout = await requestJson(base, '/api/auth/status', { host: `localhost:${address.port}` });
  assert.equal(afterLogout.body.authenticated, true);

  const revokeLocal = await requestJson(base, `/api/auth/devices/${LOCAL_CLIENT_ID}`, {
    method: 'DELETE', host: `localhost:${address.port}`, origin: `http://localhost:${address.port}`,
  });
  assert.equal(revokeLocal.status, 400);
  assert.match(revokeLocal.body.error, /cannot be revoked/);

  const spoofedHost = await requestJson(base, '/api/auth/status', {
    host: 'remote.test',
    headers: {
      'x-forwarded-host': `localhost:${address.port}`,
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(spoofedHost.body.authenticated, false);
  const spoofedProtected = await requestJson(base, '/api/settings', {
    host: 'remote.test', headers: { 'x-forwarded-host': `localhost:${address.port}` },
  });
  assert.equal(spoofedProtected.status, 401);

  const ignoredForwarding = await requestJson(base, '/api/auth/status', {
    host: `localhost:${address.port}`,
    headers: { 'x-forwarded-for': '100.96.0.8', 'x-forwarded-host': 'remote.test' },
  });
  assert.equal(ignoredForwarding.body.implicitLocal, true, 'forwarding headers neither widen nor narrow direct trust');

  const paired = await requestJson(base, '/api/auth/pair', {
    method: 'POST', host: 'remote.test', origin: 'http://remote.test',
    payload: { code: pairing.body.code, name: 'Remote browser' },
  });
  assert.equal(paired.status, 200);
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  assert.equal(auth.devices().length, 1);
  assert.equal(auth.devices()[0].name, 'Remote browser');
  assert.notEqual(auth.devices()[0].id, LOCAL_CLIENT_ID);

  const localWithCookie = await requestJson(base, '/api/auth/status', {
    host: `localhost:${address.port}`, cookie,
  });
  assert.equal(localWithCookie.body.device.id, LOCAL_CLIENT_ID, 'loopback identity takes precedence over a stale pairing cookie');

  const remoteSettings = await requestJson(base, '/api/settings', { host: 'remote.test', cookie });
  assert.equal(remoteSettings.status, 200, 'LAN/tailnet/tunnel-style hosts still require and accept pairing');
  const remoteHookRepair = await requestJson(base, '/api/settings/hooks/repair', {
    method: 'POST', host: 'remote.test', origin: 'http://remote.test', cookie, payload: {},
  });
  assert.equal(remoteHookRepair.status, 403, 'a paired remote client cannot rewrite host-level agent configuration');
  const remoteDevices = await requestJson(base, '/api/auth/devices', { host: 'remote.test', cookie });
  assert.equal(remoteDevices.body.implicitLocal, false);
  assert.deepEqual(remoteDevices.body.devices.map((device) => device.name), ['Remote browser']);

  const localWithRemote = await requestJson(base, '/api/auth/devices', { host: `localhost:${address.port}` });
  assert.deepEqual(localWithRemote.body.devices.map((device) => device.name), ['Server host', 'Remote browser']);
  const revokedRemote = await requestJson(base, `/api/auth/devices/${auth.devices()[0].id}`, {
    method: 'DELETE', host: `localhost:${address.port}`, origin: `http://localhost:${address.port}`,
  });
  assert.equal(revokedRemote.status, 200, 'the non-revocable local recovery path may revoke the final paired client');
  assert.equal(auth.devices().length, 0);
});

test('remote pairing modes and first-party agent login stay behind typed authenticated boundaries', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-remote-setup-'));
  const root = join(home, 'state');
  const repositoryRoot = join(home, 'repository');
  const webRoot = join(home, 'web');
  const bin = join(home, 'bin');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Claude Code fixture 1.0'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":false}'; exit 0; fi
exit 0
`);
  writeFileSync(join(bin, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Codex fixture 1.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo 'Not logged in'; exit 0; fi
exit 0
`);
  chmodSync(join(bin, 'claude'), 0o700);
  chmodSync(join(bin, 'codex'), 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const auth = new PairingAuth({ root });
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home, env });
  const launches = [];
  const tunnelTargets = [];
  let tunnelState = {
    provider: 'cloudflare-quick', title: 'Cloudflare Quick Tunnel', installed: true, version: 'fixture',
    status: 'idle', publicUrl: null, target: null, startedAt: null, error: null,
    temporary: true, public: true, supportsSse: false, managed: true,
  };
  const managedInternetTunnel = {
    snapshot: () => ({ ...tunnelState }),
    start: async ({ target }) => {
      tunnelTargets.push(target);
      tunnelState = { ...tunnelState, status: 'ready', publicUrl: 'https://managed-fixture.trycloudflare.com', target };
      return { ...tunnelState };
    },
    stop: async () => {
      tunnelState = { ...tunnelState, status: 'idle', publicUrl: null, target: null };
      return { ...tunnelState };
    },
  };
  const server = createHandraise({
    root, webRoot, auth, config, managedInternetTunnel,
    networkInterfaceSnapshot: {
      ethernet: [{ address: '192.168.50.20', family: 'IPv4', internal: false }],
    },
    launchSession: (details) => {
      launches.push(details);
      return { existed: false, controlSlug: details.slug, tmux: `handraise-${details.slug}` };
    },
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    if (error?.code === 'EPERM') {
      server.close();
      context.skip('the execution sandbox does not permit a local listening socket');
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const host = `localhost:${port}`;
  const origin = `http://${host}`;

  const access = await requestJson(base, '/api/auth/remote-access', { host });
  assert.equal(access.status, 200);
  assert.equal(access.body.privateNetwork.addresses[0].address, '192.168.50.20');
  assert.equal(access.body.privateNetwork.ready, false);
  assert.equal(access.body.internet.managedTunnel.canManage, true);
  const startedTunnel = await requestJson(base, '/api/auth/internet-tunnel', {
    method: 'POST', host, origin, payload: {},
  });
  assert.equal(startedTunnel.status, 200);
  assert.equal(startedTunnel.body.publicUrl, 'https://managed-fixture.trycloudflare.com');
  assert.deepEqual(tunnelTargets, [`http://127.0.0.1:${port}`]);
  const managedPairing = await requestJson(base, '/api/auth/pairing', {
    method: 'POST', host, origin, payload: { mode: 'internet', managed: true },
  });
  assert.equal(managedPairing.status, 200);
  assert.match(managedPairing.body.url, /^https:\/\/managed-fixture\.trycloudflare\.com\/\?pair=/);
  const remotePair = await requestJson(base, '/api/auth/pair', {
    method: 'POST', host: 'remote.test', origin: 'http://remote.test',
    payload: { code: managedPairing.body.code, name: 'Remote tunnel client' },
  });
  const remoteCookie = remotePair.headers['set-cookie'][0].split(';')[0];
  const remoteStart = await requestJson(base, '/api/auth/internet-tunnel', {
    method: 'POST', host: 'remote.test', origin: 'http://remote.test', cookie: remoteCookie, payload: {},
  });
  assert.equal(remoteStart.status, 403, 'a paired remote client cannot create public exposure');
  const unreachable = await requestJson(base, '/api/auth/pairing', {
    method: 'POST', host, origin, payload: { mode: 'private', address: '192.168.50.20' },
  });
  assert.equal(unreachable.status, 400);
  assert.match(unreachable.body.error, /not reachable/);
  const insecure = await requestJson(base, '/api/auth/pairing', {
    method: 'POST', host, origin, payload: { mode: 'internet', publicUrl: 'http://public.example' },
  });
  assert.equal(insecure.status, 400);
  assert.match(insecure.body.error, /HTTPS/);
  const internet = await requestJson(base, '/api/auth/pairing', {
    method: 'POST', host, origin, payload: { mode: 'internet', publicUrl: 'https://public.example/handraise' },
  });
  assert.equal(internet.status, 200);
  assert.equal(internet.body.mode, 'internet');
  assert.match(internet.body.url, /^https:\/\/public\.example\/\?pair=/);
  assert.equal(auth.devices().length, 1);

  for (const id of ['claude', 'codex']) {
    const connected = await requestJson(base, `/api/agents/${id}/connect`, {
      method: 'POST', host, origin, payload: {},
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.role, 'setup');
    assert.equal(connected.body.controlSlug, `setup-${id}-account`);
  }
  assert.deepEqual(launches.map(({ agent, command, role }) => ({ agent, command, role })), [
    { agent: 'claude', command: 'claude auth login', role: 'setup' },
    { agent: 'codex', command: 'codex login', role: 'setup' },
  ]);
  assert.equal(agentAuthInvocation('claude'), 'claude auth login');
  assert.equal(agentAuthInvocation('codex'), 'codex login');
  assert.equal(Object.hasOwn(config.read().agents.claude, 'auth'), false, 'provider authentication is never copied into Handraise settings');
  const stoppedTunnel = await requestJson(base, '/api/auth/internet-tunnel', {
    method: 'DELETE', host, origin,
  });
  assert.equal(stoppedTunnel.body.status, 'idle');
  const unknown = await requestJson(base, '/api/agents/arbitrary/connect', {
    method: 'POST', host, origin, payload: {},
  });
  assert.equal(unknown.status, 404);
});

test('repositories are normalized to their git root and never duplicated', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-config-'));
  const repository = join(home, 'repo');
  const nested = join(repository, 'packages', 'web');
  mkdirSync(nested, { recursive: true });
  const config = new ConfigStore({ root: join(home, 'state'), resolveRepository: () => repository });

  const first = config.addRepository(nested, { name: 'My repo' });
  const second = config.addRepository(repository);
  assert.equal(first.id, second.id);
  assert.equal(config.read().repositories.length, 1);
  assert.equal(first.adapter, 'uninitialized');
  const initialized = config.initializeRepository(first.id);
  assert.equal(initialized.adapter, 'handraise');
  assert.equal(JSON.parse(readFileSync(join(repository, '.handraise', 'project.json'), 'utf8')).name, 'My repo');
});

test('a Director repository becomes a repo-scoped component and front portfolio', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-director-'));
  mkdirSync(join(root, '.claude', 'components'), { recursive: true });
  mkdirSync(join(root, '.claude', 'runtime', 'plans'), { recursive: true });
  writeFileSync(join(root, '.claude', 'components', 'backend.md'), `---\nslug: backend\ntitulo: Backend\nestado: activo\norden: 1\ndesde: 2026-08-02\n---\n\n## Alcance\n\nOwn the API.\n`);
  writeFileSync(join(root, '.claude', 'runtime', 'plans', 'auth.md'), `# auth — Pair devices\n\n**Componente:** backend\n\n## ▶ Handoff\n\nStart with pairing.\n\n- [x] 1.1 Contract\n- [ ] 1.2 UI\n`);
  writeFileSync(join(root, '.claude', 'runtime', 'priorities.md'), 'auth: alto/media\n');

  const portfolio = repositoryPortfolio({ id: 'repo', name: 'Repo', path: root, adapter: 'director' });
  assert.equal(portfolio.components[0].title, 'Backend');
  assert.equal(portfolio.fronts[0].component, 'backend');
  assert.equal(portfolio.fronts[0].percent, 50);
  assert.equal(portfolio.fronts[0].impact, 'alto');
});

test('agent invocations preserve model and effort as inert CLI arguments', () => {
  assert.equal(
    agentInvocation('codex', { model: "gpt-5'; touch /tmp/nope; echo '", effort: 'xhigh' }),
    "codex -m 'gpt-5'\\''; touch /tmp/nope; echo '\\''' -c 'model_reasoning_effort=xhigh'",
  );
  assert.equal(agentInvocation('claude', { model: 'opus', effort: 'high' }), "claude --model 'opus' --effort 'high'");
  assert.throws(() => agentInvocation('codex', { effort: 'maximum' }), /invalid effort/);
});

test('Claude and Codex hook installation is idempotent and uninstall preserves unrelated hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-hooks-home-'));
  const root = join(home, 'state');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const custom = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'custom-hook' }] }] } };
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(custom));
  writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify(custom));

  installHooks({ root, home });
  installHooks({ root, home });
  const status = hookStatus({ root, home });
  assert.equal(status.claude.configured, true);
  assert.equal(status.codex.configured, true);
  assert.equal(status.repairNeeded, false);
  assert.equal(status.sourceCurrent, true);
  for (const path of [status.claude.path, status.codex.path]) {
    const text = readFileSync(path, 'utf8');
    assert.equal(text.match(/permission-request\.py/g)?.length, 1);
    assert.ok(text.includes('custom-hook'));
  }
  const claudeHooks = JSON.parse(readFileSync(status.claude.path, 'utf8')).hooks;
  const codexHooks = JSON.parse(readFileSync(status.codex.path, 'utf8')).hooks;
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd', 'PermissionRequest']) {
    assert.ok(claudeHooks[event]?.length, `Claude ${event}`);
    assert.ok(codexHooks[event]?.length, `Codex ${event}`);
  }
  assert.equal(statSync(join(root, 'hooks', 'attention.py')).mode & 0o777, 0o700);
  writeFileSync(join(root, 'hooks', 'attention.py'), '#!/usr/bin/env python3\n# outdated fixture\n');
  assert.equal(hookStatus({ root, home }).repairNeeded, true);
  installHooks({ root, home });
  assert.equal(hookStatus({ root, home }).repairNeeded, false);

  uninstallHooks({ root, home });
  assert.equal(hookStatus({ root, home }).claude.configured, false);
  assert.ok(readFileSync(join(home, '.claude', 'settings.json'), 'utf8').includes('custom-hook'));
  assert.equal(existsSync(join(root, 'hooks', 'attention.py')), false);
});

function hookEnvironment(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const tmux = join(bin, 'tmux');
  writeFileSync(tmux, `#!/bin/sh
if [ "$1" = "display-message" ]; then echo handraise-hook-fixture; exit 0; fi
if [ "$1" = "show-options" ]; then
  case "$3" in
    @handraise-slug) echo hook-fixture ;;
    @handraise-repo) echo repo-hook ;;
    @handraise-component) echo integration ;;
    @handraise-front) echo hook-flow ;;
    @handraise-agent) echo claude ;;
    @handraise-role) echo agent ;;
    @handraise-cwd) echo /fixture ;;
    *) echo '' ;;
  esac
fi
`);
  const notify = join(bin, 'notify-send');
  writeFileSync(notify, '#!/bin/sh\nexit 0\n');
  chmodSync(tmux, 0o700);
  chmodSync(notify, 0o700);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, HANDRAISE_HOME: root, TMUX: 'fixture' };
}

test('attention hook records lifecycle transitions and a durable session end', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-attention-hook-'));
  const env = hookEnvironment(root);
  const script = join(process.cwd(), 'hooks', 'attention.py');
  const run = (event) => spawnSync('python3', [script], {
    env, input: JSON.stringify({ hook_event_name: event, session_id: 'lifecycle-session', cwd: '/fixture' }),
    encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(run('UserPromptSubmit').status, 0);
  assert.equal(JSON.parse(readFileSync(join(root, 'attention', 'lifecycle-session.json'), 'utf8')).state, 'working');
  assert.equal(run('Stop').status, 0);
  assert.equal(JSON.parse(readFileSync(join(root, 'attention', 'lifecycle-session.json'), 'utf8')).state, 'waiting');
  assert.equal(run('SessionEnd').status, 0);
  assert.equal(existsSync(join(root, 'attention', 'lifecycle-session.json')), false);
  const events = readdirSync(join(root, 'history')).map((name) => JSON.parse(readFileSync(join(root, 'history', name), 'utf8')));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ended');
  assert.equal(events[0].repoId, 'repo-hook');
});

test('permission hook times out safely and returns an exact typed denial', async () => {
  const script = join(process.cwd(), 'hooks', 'permission-request.py');
  const timeoutRoot = mkdtempSync(join(tmpdir(), 'handraise-permission-timeout-'));
  const timeout = spawnSync('python3', [script], {
    env: { ...hookEnvironment(timeoutRoot), HANDRAISE: '1', HANDRAISE_PERMISSION_WAIT_SECONDS: '0.05', HANDRAISE_PERMISSION_POLL_SECONDS: '0.01' },
    input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'timeout-session', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(timeout.status, 0);
  assert.equal(timeout.stdout, '');
  assert.equal(JSON.parse(readFileSync(join(timeoutRoot, 'permissions', 'timeout-session.json'), 'utf8')).state, 'expired');

  const decisionRoot = mkdtempSync(join(tmpdir(), 'handraise-permission-decision-'));
  const child = spawn('python3', [script], {
    env: { ...hookEnvironment(decisionRoot), HANDRAISE: '1', HANDRAISE_PERMISSION_WAIT_SECONDS: '3', HANDRAISE_PERMISSION_POLL_SECONDS: '0.01' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify({
    hook_event_name: 'PermissionRequest', session_id: 'decision-session',
    tool_name: 'Bash', tool_input: { command: 'npm publish' }, permission_suggestions: [{ type: 'allow_once' }],
  }));
  const requestPath = join(decisionRoot, 'permissions', 'decision-session.json');
  let request = null;
  for (let attempt = 0; attempt < 200 && !request; attempt++) {
    try { request = JSON.parse(readFileSync(requestPath, 'utf8')); }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(request, 'the typed request becomes visible while the hook waits');
  writeFileSync(join(decisionRoot, 'permissions', 'decision-session.response.json'), JSON.stringify({
    id: request.id, behavior: 'deny', message: 'Publish from the release job.',
  }));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0, stderr);
  const decision = JSON.parse(stdout);
  assert.deepEqual(decision.hookSpecificOutput.decision, { behavior: 'deny', message: 'Publish from the release job.' });
  assert.equal(existsSync(requestPath), false);
});

test('the Linux user service workflow is explicit, versioned and reversible', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-service-home-'));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('is-enabled')) return 'enabled\n';
    if (args.includes('is-active')) return 'active\n';
    return '';
  };
  const definition = serviceDefinition({
    nodePath: '/usr/bin/node', binPath: '/opt/handraise/bin/handraise.mjs',
    stateRoot: join(home, '.handraise'), home, path: '/usr/bin:/bin', port: 4188,
  });
  assert.match(definition, /ExecStart="\/usr\/bin\/node" "\/opt\/handraise\/bin\/handraise\.mjs" serve --host "127\.0\.0\.1" --port 4188/);
  assert.match(definition, /UMask=0077/);
  const installed = installService({
    home, platform: 'linux', run, nodePath: '/usr/bin/node',
    binPath: '/opt/handraise/bin/handraise.mjs', stateRoot: join(home, '.handraise'),
  });
  assert.equal(existsSync(installed.path), true);
  assert.ok(calls.some((call) => call.includes('daemon-reload')));
  assert.ok(calls.some((call) => call.includes('enable') && call.includes('--now')));
  assert.deepEqual(serviceStatus({ home, platform: 'linux', run }), {
    supported: true, installed: true, enabled: true, active: true,
    path: installed.path, version: 1, current: true,
  });
  uninstallService({ home, platform: 'linux', run });
  assert.equal(existsSync(installed.path), false);
  assert.throws(() => installService({ home, platform: 'darwin', run, binPath: '/bin/handraise', stateRoot: '/tmp/state' }), /supported on Linux/);
  assert.throws(() => serviceDefinition({ binPath: '/bin/handraise', stateRoot: '/tmp/state', host: '127.0.0.1 --port 1' }), /host/);
  assert.throws(() => serviceDefinition({ binPath: '/bin/handraise', stateRoot: '/tmp/state', port: 70_000 }), /port/);
});

test('native components and fronts have an explicit, editable lifecycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-native-project-'));
  mkdirSync(join(root, '.handraise', 'components'), { recursive: true });
  mkdirSync(join(root, '.handraise', 'fronts'), { recursive: true });
  const repository = { id: 'native', name: 'Native', path: root, adapter: 'handraise' };
  const component = createComponent(repository, {
    title: 'Operations', scope: 'Owns operational work.', limits: 'No product work.',
    delegation: 'Hand off product changes.', territory: 'ops/', order: 7,
  });
  assert.equal(component.order, 7);
  const front = createFront(repository, component.slug, {
    title: 'Reliable startup', outcome: 'The service starts reliably.',
    context: 'Startup currently has no explicit lifecycle coverage.',
    handoff: 'Begin at the server entry point and preserve localhost defaults.',
    tasks: ['Add the lifecycle contract', 'Verify startup failures'], impact: 'alto', complexity: 'media',
  });
  assert.equal(front.tasks.length, 2);
  assert.equal(front.outcome, 'The service starts reliably.');
  assert.throws(() => deleteFront(repository, component.slug, front.slug, {
    sessions: [{ repoId: 'native', front: front.slug, slug: front.slug }],
  }), /live sessions: reliable-startup/);
  const completed = updateFront(repository, component.slug, front.slug, {
    state: 'done', tasks: front.tasks.map((task) => ({ ...task, state: 'done' })),
  });
  assert.equal(completed.state, 'done');
  assert.equal(setComponentState(repository, component.slug, 'closing').state, 'closing');
  deleteFront(repository, component.slug, front.slug);
  assert.equal(deleteComponent(repository, component.slug).removed, true);
});

test('repository availability and external portfolio changes stay explicit and live', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-repository-live-'));
  const missing = join(home, 'moved-repository');
  const missingState = repositoryAvailability(missing);
  assert.equal(missingState.kind, 'missing');
  assert.match(missingState.recovery, /reconnect/i);

  const notDirectory = join(home, 'not-a-directory');
  writeFileSync(notDirectory, 'fixture\n');
  assert.equal(repositoryAvailability(notDirectory).kind, 'invalid');
  const unavailable = repositoriesSnapshot({ repositories: [{
    id: 'missing', name: 'Moved', path: missing, adapter: 'uninitialized',
  }] });
  assert.equal(unavailable[0].availability.available, false);
  assert.equal(unavailable[0].mutations.components, false);
  assert.match(unavailable[0].error, /missing|moved/i);

  const root = join(home, 'live');
  mkdirSync(join(root, '.handraise', 'components'), { recursive: true });
  mkdirSync(join(root, '.handraise', 'fronts'), { recursive: true });
  writeFileSync(join(root, '.handraise', 'components', 'runtime.md'), '---\nslug: runtime\ntitle: Runtime\nstate: active\norder: 1\n---\n\n## Scope\n\nOwn runtime behavior.\n');
  const repository = { id: 'live', name: 'Live', path: root, adapter: 'handraise' };
  assert.equal(repositoryPortfolio(repository).components[0].title, 'Runtime');
  writeFileSync(join(root, '.handraise', 'components', 'runtime.md'), '---\nslug: runtime\ntitle: Runtime Updated Externally\nstate: active\norder: 1\n---\n\n## Scope\n\nOwn runtime behavior.\n');
  assert.equal(repositoryPortfolio(repository).components[0].title, 'Runtime Updated Externally');
});

test('native project mutations serialize and fail without partial writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-native-lock-'));
  mkdirSync(join(root, '.handraise', 'components'), { recursive: true });
  mkdirSync(join(root, '.handraise', 'fronts'), { recursive: true });
  const repository = { id: 'native-lock', name: 'Native lock', path: root, adapter: 'handraise' };
  const component = createComponent(repository, { title: 'Runtime', scope: 'Own runtime behavior.' });
  const componentPath = join(root, '.handraise', 'components', `${component.slug}.md`);
  const before = readFileSync(componentPath, 'utf8');
  mkdirSync(join(root, '.handraise', '.management-lock'));
  assert.throws(() => createFront(repository, component.slug, {
    title: 'Locked front', outcome: 'The locked operation is safely refused.',
    context: 'A concurrent writer currently owns the native management lock.',
    handoff: 'Wait for the current writer and retry the same typed operation.',
    tasks: ['Retry after the writer releases the lock'],
  }), /another Handraise project update/);
  assert.equal(readFileSync(componentPath, 'utf8'), before);
  assert.deepEqual(readdirSync(join(root, '.handraise', 'fronts')), []);
  rmSync(join(root, '.handraise', '.management-lock'), { recursive: true });
  assert.throws(() => createFront(repository, 'missing-component', {
    title: 'Invalid owner', outcome: 'This must not be created.',
    context: 'The component reference is deliberately invalid for this test.',
    handoff: 'Reject the plan before any file is written.', tasks: ['Reject it'],
  }), /component 'missing-component' not found/);
  assert.deepEqual(readdirSync(join(root, '.handraise', 'fronts')), []);
});

const discoveredComponent = (overrides = {}) => ({
  slug: 'runtime-control', title: 'Runtime Control', order: 1,
  scope: 'Own reliable runtime behavior.',
  limits: 'Does not own the browser client.',
  delegation: 'Preserve lifecycle evidence and coordinate shared contracts.',
  territory: '`src/runtime/` and its focused tests.',
  ...overrides,
});

test('assisted discovery is bounded and does not create repository metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-discovery-readonly-'));
  mkdirSync(join(root, 'src', 'runtime'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  writeFileSync(join(root, 'README.md'), '# Runtime service\nControls long-running agent sessions.\n');
  writeFileSync(join(root, 'src', 'runtime', 'sessions.mjs'), 'export function startSession() {}\n');
  writeFileSync(join(root, 'docs', 'architecture.md'), 'Session lifecycle and worktree isolation.\n');
  writeFileSync(join(root, 'test', 'runtime.test.mjs'), 'test runtime lifecycle\n');
  const repository = { id: 'repo', name: 'Repo', path: root, adapter: 'uninitialized' };

  const result = analyzeNativeRepository(repository);
  assert.equal(existsSync(join(root, '.handraise')), false);
  assert.ok(result.analysis.files >= 5);
  assert.ok(result.analysis.documentation >= 2);
  assert.ok(result.analysis.manifests >= 1);
  assert.ok(result.analysis.tests >= 1);
  assert.ok(result.proposals.length > 0);
  for (const proposal of result.proposals) {
    for (const field of ['slug', 'title', 'scope', 'limits', 'delegation', 'territory', 'order', 'evidence', 'uncertainty']) {
      assert.ok(Object.hasOwn(proposal, field), `${field} belongs to every proposal`);
    }
  }
});

test('discovery rejects stale and duplicate proposals without leaving partial metadata', () => {
  const staleRoot = mkdtempSync(join(tmpdir(), 'handraise-discovery-stale-'));
  writeFileSync(join(staleRoot, 'README.md'), 'first repository state\n');
  const staleRepository = { id: 'stale', name: 'Stale', path: staleRoot, adapter: 'uninitialized' };
  const store = new DiscoveryDraftStore();
  const draft = store.create(staleRepository);
  writeFileSync(join(staleRoot, 'README.md'), 'second repository state with a material change\n');
  assert.throws(() => store.accept(staleRepository, draft.id, [discoveredComponent()]), /changed after discovery/);
  assert.equal(existsSync(join(staleRoot, '.handraise')), false);

  const duplicateRoot = mkdtempSync(join(tmpdir(), 'handraise-discovery-duplicate-'));
  writeFileSync(join(duplicateRoot, 'README.md'), 'stable repository state\n');
  const duplicateRepository = { id: 'duplicate', name: 'Duplicate', path: duplicateRoot, adapter: 'uninitialized' };
  const duplicateStore = new DiscoveryDraftStore();
  const duplicateDraft = duplicateStore.create(duplicateRepository);
  assert.throws(() => duplicateStore.accept(duplicateRepository, duplicateDraft.id, [
    discoveredComponent(), discoveredComponent({ title: 'Other Runtime', order: 2 }),
  ]), /duplicate component slug/);
  assert.equal(existsSync(join(duplicateRoot, '.handraise')), false);
  assert.ok(!readdirSync(duplicateRoot).some((name) => name.startsWith('.handraise.tmp-') || name === '.handraise-initialize.lock'));

  const expiredRoot = mkdtempSync(join(tmpdir(), 'handraise-discovery-expired-'));
  writeFileSync(join(expiredRoot, 'README.md'), 'stable repository state\n');
  const expiredRepository = { id: 'expired', name: 'Expired', path: expiredRoot, adapter: 'uninitialized' };
  let now = 1_000;
  const expiringStore = new DiscoveryDraftStore({ now: () => now, ttlMs: 100 });
  const expiredDraft = expiringStore.create(expiredRepository);
  now += 101;
  assert.throws(() => expiringStore.accept(expiredRepository, expiredDraft.id, [discoveredComponent()]), /expired/);
  assert.equal(existsSync(join(expiredRoot, '.handraise')), false);
});

test('accepted discovery publishes complete contracts atomically and cleans failed staging', () => {
  const failedRoot = mkdtempSync(join(tmpdir(), 'handraise-initialize-failure-'));
  assert.throws(() => initializeNativeRepository({ id: 'failed', name: 1n, path: failedRoot }, {
    components: [discoveredComponent()],
  }), /BigInt/);
  assert.equal(existsSync(join(failedRoot, '.handraise')), false);
  assert.ok(!readdirSync(failedRoot).some((name) => name.startsWith('.handraise.tmp-') || name === '.handraise-initialize.lock'));

  const root = mkdtempSync(join(tmpdir(), 'handraise-discovery-accept-'));
  writeFileSync(join(root, 'README.md'), 'stable repository state\n');
  const repository = { id: 'accepted', name: 'Accepted', path: root, adapter: 'uninitialized' };
  const store = new DiscoveryDraftStore();
  const draft = store.create(repository);
  const result = store.accept(repository, draft.id, [
    discoveredComponent(),
    discoveredComponent({
      slug: 'client-experience', title: 'Client Experience', order: 2,
      scope: 'Own the browser experience.', limits: 'Does not own runtime control.',
      delegation: 'Coordinate API contracts before client changes.', territory: '`ui/` and browser tests.',
    }),
  ]);
  assert.equal(result.created, 2);
  assert.equal(result.repository.adapter, 'handraise');
  assert.deepEqual(readdirSync(join(root, '.handraise', 'components')).sort(), ['client-experience.md', 'runtime-control.md']);
  const contract = readFileSync(join(root, '.handraise', 'components', 'runtime-control.md'), 'utf8');
  assert.match(contract, /## Scope\n\nOwn reliable runtime behavior\./);
  assert.match(contract, /## Limits\n\nDoes not own the browser client\./);
  assert.match(contract, /## Agent guidance/);
  assert.match(contract, /## Territory/);
  assert.throws(() => initializeNativeRepository(repository), /metadata already exists/);
  assert.equal(readFileSync(join(root, '.handraise', 'components', 'runtime-control.md'), 'utf8'), contract);
});

test('discovery preview and acceptance are authenticated API operations', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-discovery-api-'));
  const root = join(home, 'state');
  const repositoryRoot = join(home, 'repository');
  const webRoot = join(home, 'web');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, 'README.md'), 'A runtime service with a browser client.\n');
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home });
  const repository = config.addRepository(repositoryRoot, { name: 'API fixture' });
  const auth = new PairingAuth({ root });
  const paired = auth.pair(auth.pairingDetails().code, 'Test client');
  const planningRuntime = new PlanningRuntime({ root: join(root, 'planning'), adapters: [planningAdapterFixture()] });
  let launched = null;
  const server = createHandraise({
    root, webRoot, auth, config, planningRuntime,
    launchSession: (details) => {
      launched = details;
      return { existed: false, controlSlug: `${details.repoId}--${details.slug}`, tmux: `handraise-${details.repoId}--${details.slug}` };
    },
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    if (error?.code === 'EPERM') {
      server.close();
      context.skip('the execution sandbox does not permit a local listening socket');
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const remoteHost = 'remote.test';
  const remoteOrigin = `http://${remoteHost}`;
  const remoteFetch = async (pathname, options = {}) => {
    const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const result = await requestJson(base, pathname, {
      method: options.method || 'GET',
      host: remoteHost,
      origin: headers.origin,
      cookie: headers.cookie,
      payload: options.body === undefined ? undefined : JSON.parse(options.body || '{}'),
    });
    return { status: result.status, headers: result.headers, json: async () => result.body };
  };

  const health = await fetch(`${base}/api/health`);
  const readiness = await fetch(`${base}/api/readiness`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).ready, true);
  const analyzerCatalogResponse = await fetch(`${base}/api/analysis/analyzers`);
  assert.equal(analyzerCatalogResponse.status, 200);
  const analyzerCatalog = (await analyzerCatalogResponse.json()).analyzers;
  assert.ok(analyzerCatalog.some((analyzer) => analyzer.id === 'handraise-inventory' && analyzer.availability.available));
  const graphifyAnalyzer = analyzerCatalog.find((analyzer) => analyzer.id === 'graphify-code-local');
  assert.ok(graphifyAnalyzer, 'the optional Graphify capability must be discoverable even when unavailable');
  assert.equal(typeof graphifyAnalyzer.availability.available, 'boolean');
  assert.equal(graphifyAnalyzer.extensions.mode, 'code-only');
  const planningCatalogResponse = await fetch(`${base}/api/planning/adapters`);
  assert.equal(planningCatalogResponse.status, 200);
  const planningCatalog = (await planningCatalogResponse.json()).adapters;
  assert.ok(planningCatalog.some((adapter) => adapter.id === 'fixture-planner' && adapter.availability.available));
  const statusProcess = spawn(process.execPath, [join(process.cwd(), 'bin', 'handraise.mjs'), 'server', 'status', '--url', base], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let statusOutput = '';
  let statusError = '';
  statusProcess.stdout.on('data', (chunk) => { statusOutput += chunk; });
  statusProcess.stderr.on('data', (chunk) => { statusError += chunk; });
  const statusCode = await new Promise((resolve) => statusProcess.once('close', resolve));
  assert.equal(statusCode, 0, statusError);
  assert.match(statusOutput, /server\s+available/);
  assert.match(statusOutput, /readiness\s+ready/);

  const unauthorized = await remoteFetch(`/api/repositories/${repository.id}/discovery`, {
    method: 'POST', headers: { host: remoteHost, origin: remoteOrigin },
  });
  assert.equal(unauthorized.status, 401);
  await unauthorized.json();
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);

  const remoteAnalysisPlan = await remoteFetch(`/api/repositories/${repository.id}/analysis/plan`, {
    method: 'POST',
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ analyzerId: 'handraise-inventory', scope: { includeUntracked: true } }),
  });
  assert.equal(remoteAnalysisPlan.status, 201);
  const plannedAnalysis = (await remoteAnalysisPlan.json()).plan;
  assert.equal(plannedAnalysis.repositoryId, repository.id);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false, 'analysis planning must not initialize the repository');

  const remoteIgnoredPlan = await remoteFetch(`/api/repositories/${repository.id}/analysis/plan`, {
    method: 'POST',
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: { ignoredPaths: ['private/secret.txt'] } }),
  });
  assert.equal(remoteIgnoredPlan.status, 403);
  assert.equal((await remoteIgnoredPlan.json()).code, 'LOCAL_AUTHORITY_REQUIRED');

  const remotePlanningPreflight = await remoteFetch(`/api/repositories/${repository.id}/planning/preflight`, {
    method: 'POST',
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ adapterId: 'fixture-planner', operation: 'component-design', question: 'Design the work.' }),
  });
  assert.equal(remotePlanningPreflight.status, 403, 'a paired remote client cannot authorize source egress from the server host');
  assert.equal((await remotePlanningPreflight.json()).code, 'LOCAL_AUTHORITY_REQUIRED');

  const analysisStart = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs`, {
    method: 'POST',
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plannedAnalysis.id }),
  });
  assert.equal(analysisStart.status, 202);
  const analysisJobId = (await analysisStart.json()).job.id;
  let analysisStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}`, {
      headers: { host: remoteHost, cookie: `handraise_session=${paired.token}` },
    });
    analysisStatus = (await response.json()).job;
    if (['complete', 'stale', 'failed'].includes(analysisStatus.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(analysisStatus.state, 'complete');
  const analysisSnapshot = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}/snapshot`, {
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}` },
  });
  assert.equal(analysisSnapshot.status, 200);
  assert.equal((await analysisSnapshot.json()).snapshot.id, analysisStatus.snapshotId);

  const systemMapResponse = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}/map?limit=10`, {
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}` },
  });
  assert.equal(systemMapResponse.status, 200);
  const systemMap = await systemMapResponse.json();
  assert.equal(systemMap.map.snapshotId, analysisStatus.snapshotId);
  assert.equal(systemMap.map.authority.accepted, false);
  assert.ok(systemMap.result.groups.length > 0);
  assert.ok(systemMap.map.lenses.some((lens) => lens.id === 'change-coupling' && lens.status === 'unsupported'));
  const unauthorizedMap = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}/map`, {
    headers: { host: remoteHost },
  });
  assert.equal(unauthorizedMap.status, 401, 'map queries require the same authenticated client boundary as the source snapshot');
  await unauthorizedMap.json();
  const mapSearchResponse = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}/map/query`, {
    method: 'POST',
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'search', text: 'README', limit: 20 }),
  });
  assert.equal(mapSearchResponse.status, 200);
  assert.ok((await mapSearchResponse.json()).result.entities.some((entity) => entity.name === 'README.md'));
  const mapExportResponse = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}/map/export?format=markdown`, {
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}` },
  });
  assert.equal(mapExportResponse.status, 200);
  const mapExport = (await mapExportResponse.json()).export;
  assert.equal(mapExport.authority.accepted, false);
  assert.match(mapExport.content, /derived analysis/i);
  const mapComparisonResponse = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}/map/compare?fromJobId=${encodeURIComponent(analysisJobId)}`, {
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}` },
  });
  assert.equal(mapComparisonResponse.status, 200);
  assert.equal((await mapComparisonResponse.json()).comparison.noChange, true);
  const invalidMapQuery = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}/map/query`, {
    method: 'POST',
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'overview', limit: 50_000 }),
  });
  assert.equal(invalidMapQuery.status, 400);
  assert.equal((await invalidMapQuery.json()).code, 'INVALID_MAP_LIMIT');
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false, 'map derivation, queries, comparison and export must not initialize or mutate the repository');

  const localPlanningPreflightResponse = await fetch(`${base}/api/repositories/${repository.id}/planning/preflight`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adapterId: 'fixture-planner', operation: 'component-design', analysisJobId, question: 'Design the work from this exact snapshot.' }),
  });
  assert.equal(localPlanningPreflightResponse.status, 201);
  const localPlanningPreflight = (await localPlanningPreflightResponse.json()).preflight;
  assert.equal(localPlanningPreflight.context.snapshot.id, analysisStatus.snapshotId);
  assert.equal(localPlanningPreflight.mutation.repository, false);
  assert.equal(localPlanningPreflight.consent.required, true);
  assert.ok(localPlanningPreflight.sources.some((source) => source.kind === 'graph-query'));
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false, 'planning preflight must not initialize or mutate the repository');

  const missingPlanningConsent = await fetch(`${base}/api/repositories/${repository.id}/planning/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preflightId: localPlanningPreflight.id, consent: false }),
  });
  assert.equal(missingPlanningConsent.status, 403);
  assert.equal((await missingPlanningConsent.json()).code, 'PLANNING_CONSENT_REQUIRED');
  const planningStart = await fetch(`${base}/api/repositories/${repository.id}/planning/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preflightId: localPlanningPreflight.id, consent: true }),
  });
  assert.equal(planningStart.status, 202);
  const planningJobId = (await planningStart.json()).job.id;
  let planningStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/repositories/${repository.id}/planning/jobs/${encodeURIComponent(planningJobId)}`);
    planningStatus = (await response.json()).job;
    if (['complete', 'failed', 'cancelled'].includes(planningStatus.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(planningStatus.state, 'complete');
  assert.equal(planningStatus.cost, null);
  assert.equal(planningStatus.usage.input_tokens, 12);
  const planningResultResponse = await fetch(`${base}/api/repositories/${repository.id}/planning/jobs/${encodeURIComponent(planningJobId)}/result`);
  assert.equal(planningResultResponse.status, 200);
  assert.equal((await planningResultResponse.json()).result.components[0].slug, 'proposed-runtime');
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false, 'validated model proposals remain private');
  const planningDeleted = await fetch(`${base}/api/repositories/${repository.id}/planning/jobs/${encodeURIComponent(planningJobId)}`, { method: 'DELETE' });
  assert.equal(planningDeleted.status, 200);
  assert.equal((await planningDeleted.json()).deleted, planningJobId);

  const analysisDeleted = await remoteFetch(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(analysisJobId)}`, {
    method: 'DELETE', headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin },
  });
  assert.equal(analysisDeleted.status, 200);
  assert.equal((await analysisDeleted.json()).deleted, analysisJobId);

  const preview = await remoteFetch(`/api/repositories/${repository.id}/discovery`, {
    method: 'POST', headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin },
  });
  assert.equal(preview.status, 201);
  const { draft } = await preview.json();
  assert.ok(draft.id);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);

  const accepted = await remoteFetch(`/api/repositories/${repository.id}/discovery/${draft.id}/accept`, {
    method: 'POST',
    headers: { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ components: [discoveredComponent()] }),
  });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).created, 1);
  assert.equal(existsSync(join(repositoryRoot, '.handraise', 'components', 'runtime-control.md')), true);

  const authenticatedHeaders = { host: remoteHost, cookie: `handraise_session=${paired.token}`, origin: remoteOrigin, 'content-type': 'application/json' };
  const migrationPreviewResponse = await remoteFetch(`/api/repositories/${repository.id}/contracts/migration`, {
    headers: authenticatedHeaders,
  });
  assert.equal(migrationPreviewResponse.status, 200);
  const migrationPreview = (await migrationPreviewResponse.json()).preview;
  assert.equal(migrationPreview.noOp, true, 'new native contracts already use schema v2');
  const migrationApplied = await remoteFetch(`/api/repositories/${repository.id}/contracts/migration`, {
    method: 'POST', headers: authenticatedHeaders, body: JSON.stringify({ previewId: migrationPreview.previewId }),
  });
  assert.equal(migrationApplied.status, 200);
  assert.equal((await migrationApplied.json()).applied, false);

  const createdComponent = await remoteFetch(`/api/repositories/${repository.id}/components`, {
    method: 'POST', headers: authenticatedHeaders, body: JSON.stringify(discoveredComponent({
      slug: 'temporary', title: 'Temporary', order: 2,
    })),
  });
  assert.equal(createdComponent.status, 201);
  assert.equal((await createdComponent.json()).component.slug, 'temporary');
  const removedComponent = await remoteFetch(`/api/repositories/${repository.id}/components/temporary`, {
    method: 'DELETE', headers: authenticatedHeaders,
  });
  assert.equal(removedComponent.status, 200);
  await removedComponent.json();

  const createdFront = await remoteFetch(`/api/repositories/${repository.id}/components/runtime-control/fronts`, {
    method: 'POST', headers: authenticatedHeaders, body: JSON.stringify({
      slug: 'api-flow', title: 'API flow', outcome: 'The API flow is fully exercised.',
      context: 'The authenticated integration fixture has a complete native component.',
      handoff: 'Exercise the safe routes without launching a real provider process.',
      tasks: ['Create the front', 'Start its session', 'Complete and remove it'], impact: 'alto', complexity: 'media',
    }),
  });
  assert.equal(createdFront.status, 201);
  assert.equal((await createdFront.json()).front.slug, 'api-flow');
  const updatedFront = await remoteFetch(`/api/repositories/${repository.id}/components/runtime-control/fronts/api-flow`, {
    method: 'PATCH', headers: authenticatedHeaders, body: JSON.stringify({ state: 'paused' }),
  });
  assert.equal(updatedFront.status, 200);
  assert.equal((await updatedFront.json()).front.state, 'paused');

  const started = await remoteFetch('/api/session', {
    method: 'POST', headers: authenticatedHeaders, body: JSON.stringify({
      slug: 'api-flow', repoId: repository.id, component: 'runtime-control', front: 'api-flow', agent: 'claude', isolate: false,
    }),
  });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).controlSlug, `${repository.id}--api-flow`);
  assert.equal(launched.repoId, repository.id);
  assert.equal(launched.component, 'runtime-control');
  assert.equal(launched.front, 'api-flow');
  assert.match(launched.command, /^claude\b/);
  const unsafeCommand = await remoteFetch('/api/session', {
    method: 'POST', headers: authenticatedHeaders, body: JSON.stringify({ slug: 'unsafe', command: 'echo unsafe' }),
  });
  assert.equal(unsafeCommand.status, 400);
  assert.match((await unsafeCommand.json()).error, /CLI-only escape hatch/);

  const processStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const processStart = processStat.slice(processStat.lastIndexOf(')') + 2).split(' ')[19];
  const permissionKey = 'api-route-permission';
  writeFileSync(join(root, 'permissions', `${permissionKey}.json`), JSON.stringify({
    id: 'permission-id', key: permissionKey, state: 'pending', requestedAt: Date.now() / 1000,
    proc: `${process.pid}@${processStart}`, tool: { name: 'Bash', input: { command: 'npm test' } },
  }));
  const denied = await remoteFetch(`/api/permission/${permissionKey}`, {
    method: 'POST', headers: authenticatedHeaders,
    body: JSON.stringify({ id: 'permission-id', behavior: 'deny', message: 'Use the focused test instead.' }),
  });
  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).message, 'Use the focused test instead.');
  assert.equal(JSON.parse(readFileSync(join(root, 'permissions', `${permissionKey}.response.json`), 'utf8')).behavior, 'deny');

  const completedFront = await remoteFetch(`/api/repositories/${repository.id}/components/runtime-control/fronts/api-flow`, {
    method: 'PATCH', headers: authenticatedHeaders, body: JSON.stringify({ state: 'done' }),
  });
  assert.equal(completedFront.status, 200);
  await completedFront.json();
  const removedFront = await remoteFetch(`/api/repositories/${repository.id}/components/runtime-control/fronts/api-flow`, {
    method: 'DELETE', headers: authenticatedHeaders,
  });
  assert.equal(removedFront.status, 200);
  await removedFront.json();
});

test('fleet verdict precedence preserves repository and lane ownership', () => {
  const now = Date.parse('2026-08-03T15:00:00Z');
  const repositories = [{
    id: 'repo-a', name: 'Repo A', lanes: [{ slug: 'external', liveness: 'live' }],
    workshop: { worktrees: [{ path: '/repo-a/wt', branch: 'feat/risk', git: { dirty: 1 } }], orphans: [] },
  }, {
    id: 'repo-b', name: 'Repo B', lanes: [], workshop: { worktrees: [], orphans: [] },
  }];
  const active = { slug: 'build', controlSlug: 'repo-b--build', repoId: 'repo-b', front: 'build', status: 'working' };
  const outcomes = [{ type: 'completed', at: '2026-08-03T14:00:00Z' }];

  assert.equal(fleetVerdict({ repositories: [], sessions: [], outcomes: [], now }).kind, 'idle');
  assert.equal(fleetVerdict({ repositories: [], sessions: [], outcomes, now }).kind, 'recent');
  const unsafe = fleetVerdict({ repositories, sessions: [active], outcomes, now });
  assert.equal(unsafe.kind, 'unsafe');
  assert.equal(unsafe.counts.running, 2, 'one controlled session plus one external lane');
  assert.equal(unsafe.risks[0].repoId, 'repo-a');
  assert.equal(fleetVerdict({ repositories, sessions: [active, { ...active, slug: 'wait', status: 'waiting' }], outcomes, now }).kind, 'waiting');
  assert.equal(fleetVerdict({ repositories, sessions: [active, { ...active, slug: 'wait', status: 'waiting' }, { ...active, slug: 'block', status: 'blocked' }], outcomes, now }).kind, 'blocked');
  const failed = fleetVerdict({ repositories, sessions: [
    active, { ...active, slug: 'wait', status: 'waiting' }, { ...active, slug: 'block', status: 'blocked' },
    { ...active, slug: 'fail', repoId: 'repo-a', status: 'error' },
  ], outcomes, now });
  assert.equal(failed.kind, 'failed');
  assert.deepEqual(failed.attention.map((session) => session.status), ['error', 'blocked', 'waiting']);
});

test('history deduplicates terminal outcomes and intentional stops', () => {
  const at = '2026-08-03T12:00:00.000Z';
  const events = [
    { id: 'ended', type: 'ended', at, controlSlug: 'repo--one', startedAt: 100, durationSeconds: 9 },
    { id: 'complete', type: 'completed', at, controlSlug: 'repo--one', startedAt: 100, durationSeconds: 10 },
    { id: 'late-complete', type: 'completed', at, controlSlug: 'repo--two', startedAt: 200, durationSeconds: 20 },
    { id: 'failed', type: 'failed', at, controlSlug: 'repo--two', startedAt: 200, durationSeconds: 21 },
    { id: 'stopped', type: 'stopped', at, controlSlug: 'repo--three', startedAt: 300, durationSeconds: 30 },
  ];
  const outcomes = historyOutcomes(events);
  assert.deepEqual(outcomes.map((event) => event.type).sort(), ['completed', 'failed', 'stopped']);
  assert.deepEqual(historySummary(events, Date.parse('2026-08-03T13:00:00Z')), {
    completed7d: 1, failed7d: 1, stopped7d: 1, medianDurationSeconds: 21,
  });

  const root = mkdtempSync(join(tmpdir(), 'handraise-history-'));
  const tracker = new HistoryTracker({ root });
  const first = { slug: 'one', controlSlug: 'repo--one', repoId: 'repo', startedAt: Math.floor(Date.now() / 1000), status: 'working' };
  tracker.observe([]);
  tracker.observe([first]);
  tracker.observe([first]);
  tracker.observe([{ ...first, error: '17', status: 'error' }]);
  tracker.observe([{ ...first, error: '17', status: 'error' }]);
  tracker.observe([]);
  const second = { ...first, slug: 'two', controlSlug: 'repo--two', startedAt: first.startedAt + 1 };
  tracker.started(second);
  tracker.stopped(second);
  tracker.observe([]);
  const recorded = readHistory(root);
  assert.equal(recorded.filter((event) => event.type === 'started').length, 2);
  assert.equal(recorded.filter((event) => event.type === 'failed').length, 1);
  assert.equal(recorded.filter((event) => event.type === 'completed').length, 1);
  assert.equal(recorded.filter((event) => event.type === 'stopped').length, 1);
  assert.deepEqual(historyOutcomes(recorded).map((event) => event.type).sort(), ['failed', 'stopped']);
});

test('fleet Director prompt scopes every proposal and keeps confirmation as the mutation boundary', () => {
  const prompt = fleetManagerPrompt({
    nodePath: '/usr/bin/node', binPath: '/opt/handraise/bin/handraise.mjs',
    repositories: [
      { id: 'repo-a', name: 'Repo A', path: '/work/a', adapter: 'handraise', components: [{ slug: 'api' }], fronts: [] },
      { id: 'repo-b', name: 'Repo B', path: '/work/b', adapter: 'director', components: [{ slug: 'web' }], fronts: [{ slug: 'ship', component: 'web', state: 'queued' }] },
    ],
    sessions: [{ slug: 'build', repoId: 'repo-a', component: 'api', front: 'build', status: 'working' }],
  });
  assert.match(prompt, /Repo A \[repo-a\][\s\S]*Repo B \[repo-b\]/);
  assert.match(prompt, /Require an explicit user confirmation/);
  assert.match(prompt, /do not write repository metadata, launch agents, stop sessions or create operation files/);
  assert.match(prompt, /project component --repo <repository-id>/);
  assert.match(prompt, /Never edit component\/front Markdown directly/);
  assert.match(prompt, /repo=repo-a · component=api · front=build/);
});

test('Director mutations fail closed when its validated helpers are absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-director-readonly-'));
  mkdirSync(join(root, '.claude', 'components'), { recursive: true });
  mkdirSync(join(root, '.claude', 'runtime', 'plans'), { recursive: true });
  const repository = { id: 'director', name: 'Director', path: root, adapter: 'director' };
  assert.throws(() => createComponent(repository, {
    title: 'Unsafe', scope: 'Would bypass Director.', limits: 'None.', delegation: 'None.', territory: 'none/',
  }), /read-only.*components\.mjs/);
  writeFileSync(join(root, '.claude', 'components', 'backend.md'), '---\nslug: backend\ntitulo: Backend\nestado: activo\n---\n\n## Alcance\n\nOwn backend work.\n');
  assert.throws(() => createFront(repository, 'backend', {
    title: 'Unsafe front', outcome: 'Would bypass Director.',
    context: 'There is enough context to reach the adapter boundary.', handoff: 'Do not write directly.', tasks: ['One'],
  }), /read-only.*fronts\.mjs/);
  assert.deepEqual(readdirSync(join(root, '.claude', 'components')), ['backend.md']);
  assert.deepEqual(readdirSync(join(root, '.claude', 'runtime', 'plans')), []);
});

test('Director mutations are delegated to its validated helpers with typed proposals', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-director-helpers-'));
  mkdirSync(join(root, '.claude', 'components'), { recursive: true });
  mkdirSync(join(root, '.claude', 'runtime', 'plans'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'director'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'director', 'components.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = process.argv[process.argv.indexOf('--root') + 1];
    const proposal = process.argv[process.argv.indexOf('--from') + 1];
    const payload = JSON.parse(readFileSync(proposal, 'utf8'));
    if (process.argv[2] !== 'apply' || payload.action !== 'create') throw new Error('invalid typed component operation');
    writeFileSync(join(root, '.director-component-call.json'), JSON.stringify(payload));
    const component = {
      slug: payload.slug, titulo: payload.title, estado: 'activo', orden: payload.order,
      desde: payload.since, secciones: payload.sections,
    };
    writeFileSync(join(root, '.claude', 'components', payload.slug + '.md'), [
      '---', 'slug: ' + payload.slug, 'titulo: ' + payload.title, 'estado: activo',
      'orden: ' + payload.order, '---', '', '## Alcance', '', payload.sections.Alcance,
      '', '<!-- managed-by-director-helper -->', '',
    ].join('\\n'));
    process.stdout.write(JSON.stringify({ component }));
  `);
  writeFileSync(join(root, 'scripts', 'director', 'fronts.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = process.argv[process.argv.indexOf('--root') + 1];
    const proposal = process.argv[process.argv.indexOf('--from') + 1];
    const payload = JSON.parse(readFileSync(proposal, 'utf8'));
    if (process.argv[2] !== 'create') throw new Error('invalid typed front operation');
    writeFileSync(join(root, '.director-front-call.json'), JSON.stringify(payload));
    const markdown = [
      '---', 'slug: ' + payload.slug, 'component: ' + payload.component, 'state: queued',
      'impact: ' + payload.impact, 'complexity: ' + payload.complexity, '---', '',
      '# ' + payload.slug + ' — ' + payload.title, '', '**Componente:** ' + payload.component,
      '', '## Confirmed context', '', payload.handoff, '', '## Checklist', '',
      ...payload.tasks.map((task, index) => '- [ ] ' + (index + 1) + '. ' + task),
      '', '<!-- managed-by-director-helper -->', '',
    ].join('\\n');
    writeFileSync(join(root, '.claude', 'runtime', 'plans', payload.slug + '.md'), markdown);
    process.stdout.write(JSON.stringify({ created: payload.slug }));
  `);
  const repository = { id: 'director', name: 'Director', path: root, adapter: 'director' };

  const component = createComponent(repository, {
    slug: 'runtime', title: 'Runtime', scope: 'Own runtime behavior.',
    limits: 'Do not own product planning.', delegation: 'Use the Director lock.',
    territory: 'src/runtime/', order: 3,
  });
  assert.equal(component.slug, 'runtime');
  const componentCall = JSON.parse(readFileSync(join(root, '.director-component-call.json'), 'utf8'));
  assert.equal(componentCall.action, 'create');
  assert.equal(componentCall.sections.Alcance, 'Own runtime behavior.');
  assert.match(readFileSync(join(root, '.claude', 'components', 'runtime.md'), 'utf8'), /managed-by-director-helper/);

  const front = createFront(repository, 'runtime', {
    slug: 'safe-control', title: 'Safe control', outcome: 'Runtime control remains safe.',
    context: 'The Director helper owns validation, locking and final serialization.',
    handoff: 'Preserve the adapter boundary and its repository-native invariants.',
    tasks: ['Validate the typed proposal', 'Publish through the helper'], impact: 'alto', complexity: 'media',
  });
  assert.equal(front.slug, 'safe-control');
  const frontCall = JSON.parse(readFileSync(join(root, '.director-front-call.json'), 'utf8'));
  assert.equal(frontCall.component, 'runtime');
  assert.deepEqual(frontCall.tasks, ['Validate the typed proposal', 'Publish through the helper']);
  assert.match(readFileSync(join(root, '.claude', 'runtime', 'plans', 'safe-control.md'), 'utf8'), /managed-by-director-helper/);
});

test('the service worker keeps API requests network-only and has an explicit offline shell', () => {
  const serviceWorker = readFileSync(join(process.cwd(), 'ui', 'public', 'sw.js'), 'utf8');
  assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(serviceWorker, /Handraise server unavailable/);
  assert.match(serviceWorker, /Server-backed actions are unavailable/);
  assert.match(serviceWorker, /keys\.filter\(\(key\) => key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(serviceWorker, /cache-control': 'no-store/);
});

test('native worktrees get an isolated branch, Git risk signals and safe removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-worktree-'));
  execFileSync('git', ['init', '-b', 'main', root]);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  mkdirSync(join(root, '.handraise'), { recursive: true });
  writeFileSync(join(root, '.handraise', '.gitignore'), 'worktrees/\n.management-lock/\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Handraise Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  const repository = { id: 'repo', name: 'Repo', path: root, adapter: 'handraise' };

  const created = createWorktree(repository, 'safe-lane');
  assert.equal(created.branch, 'handraise/safe-lane');
  assert.equal(gitState(repository, created.path, 'safe-lane').dirty, 0);
  const workshop = workshopSnapshot(repository, [{
    repoId: 'repo', cwd: created.path, slug: 'safe-lane', controlSlug: 'repo--safe-lane', front: 'safe-lane',
  }]);
  assert.equal(workshop.worktrees.find((item) => item.path === created.path).owner.slug, 'safe-lane');
  assert.equal(removeWorktree(repository, 'safe-lane').removed, 'safe-lane');

  const risky = createWorktree(repository, 'risky-lane');
  writeFileSync(join(risky.path, 'uncommitted.txt'), 'do not lose\n');
  assert.equal(gitState(repository, risky.path, 'risky-lane').dirty, 1);
  assert.throws(() => removeWorktree(repository, 'risky-lane'), /uncommitted/);
});

test('real tmux lifecycle supports control, pause, resume, wrap-up, failure retention and stop', async (context) => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); }
  catch {
    context.skip('tmux is not installed');
    return;
  }
  const previousSocket = process.env.HANDRAISE_TMUX_SOCKET;
  const socket = `handraise-smoke-${process.pid}-${Date.now()}`;
  process.env.HANDRAISE_TMUX_SOCKET = socket;
  context.after(() => {
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already stopped */ }
    if (previousSocket === undefined) delete process.env.HANDRAISE_TMUX_SOCKET;
    else process.env.HANDRAISE_TMUX_SOCKET = previousSocket;
  });
  const root = mkdtempSync(join(tmpdir(), 'handraise-real-tmux-'));
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const loop = `printf '[fixture] ready\\n'; while IFS= read -r line; do printf '[fixture] %s\\n' "$line"; done`;
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const started = controlStart({
    slug: 'lifecycle', repoId: 'repo', component: 'runtime', front: 'smoke',
    cwd: root, command: `sh -c ${quote(loop)}`, agent: 'fixture',
  });
  assert.equal(started.controlSlug, 'repo--lifecycle');
  await waitFor(() => controlCapture(started.controlSlug, { lines: 80 })?.includes('[fixture] ready'), 'fixture startup');
  let session = controlSessions().find((item) => item.controlSlug === started.controlSlug);
  assert.equal(session.repoId, 'repo');
  assert.equal(session.component, 'runtime');
  assert.equal(session.front, 'smoke');

  controlSendText(started.controlSlug, 'literal $HOME and `not-a-command`');
  await waitFor(() => controlCapture(started.controlSlug, { lines: 80 })?.includes('literal $HOME and `not-a-command`'), 'literal terminal input');
  controlPause(started.controlSlug, { order: 'pause safely', now: () => 123, wait: () => {} });
  await waitFor(() => controlCapture(started.controlSlug, { lines: 80 })?.includes('pause safely'), 'pause request');
  assert.equal(controlSessions().find((item) => item.controlSlug === started.controlSlug).pauseAskedAt, 123);
  controlResume(started.controlSlug, { order: 'resume now', wait: () => {} });
  await waitFor(() => controlCapture(started.controlSlug, { lines: 80 })?.includes('resume now'), 'resume request');
  assert.equal(controlSessions().find((item) => item.controlSlug === started.controlSlug).pauseAskedAt, null);
  controlWrapUp(started.controlSlug, { order: 'wrap up safely', now: () => 124, wait: () => {} });
  await waitFor(() => controlCapture(started.controlSlug, { lines: 80 })?.includes('wrap up safely'), 'wrap-up request');
  assert.equal(controlSessions().find((item) => item.controlSlug === started.controlSlug).wrapupAskedAt, 124);
  controlSendText(started.controlSlug, 'continue after review');
  assert.equal(controlSessions().find((item) => item.controlSlug === started.controlSlug).wrapupAskedAt, null);
  controlKill(started.controlSlug);
  await waitFor(() => !controlSessions().some((item) => item.controlSlug === started.controlSlug), 'confirmed hard stop');

  const failed = controlStart({
    slug: 'failure', repoId: 'repo', cwd: root,
    command: `sh -c ${quote("printf '[fixture] failing\\n'; exit 17")}`, agent: 'fixture',
  });
  session = await waitFor(() => {
    const current = controlSessions().find((item) => item.controlSlug === failed.controlSlug);
    return current?.error === '17' ? current : null;
  }, 'retained launch failure');
  assert.equal(session.error, '17');
  assert.match(controlCapture(failed.controlSlug, { lines: 80 }), /agent exited with code 17/);
  const retried = controlStart({
    slug: 'failure', repoId: 'repo', cwd: root,
    command: `sh -c ${quote(loop)}`, agent: 'fixture',
  });
  assert.equal(retried.existed, false);
  await waitFor(() => controlCapture(retried.controlSlug, { lines: 80 })?.includes('[fixture] ready'), 'failure retry');
  assert.equal(controlSessions().find((item) => item.controlSlug === retried.controlSlug).error, null);
  controlKill(retried.controlSlug);
});
