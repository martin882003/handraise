import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { createComponent, createFront, initializeNativeRepository, updateFront } from '../src/repositories.mjs';
import { createHandraise } from '../src/server.mjs';
import { AnalysisRuntime } from '../src/intelligence/runtime.mjs';
import { createGraphifyAdapter } from '../src/intelligence/adapters/graphify.mjs';
import { PlanningRuntime } from '../src/planning/runtime.mjs';

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function browserPlanningAdapter() {
  const descriptor = {
    id: 'browser-planner', name: 'Browser fixture planner', version: '1.0.0', contractVersion: 1,
    provider: { id: 'fixture', name: 'Fixture provider' },
    authentication: { owner: 'first-party-cli', method: 'fixture CLI-owned auth', credentialsStoredByHandraise: false },
    capabilities: { operations: ['component-design', 'front-design', 'portfolio-review'], structuredOutput: true, toolFreeInvocation: true, cancellation: true, usage: ['input_tokens'], cost: false, boundedContext: true },
    dataBoundary: { kind: 'cloud', destination: 'Fixture provider boundary', sourceMayLeaveHost: true, requiresConsent: true },
    models: [{ id: 'default', label: 'Fixture default model', default: true }],
    degradation: { fallback: 'deterministic-manual', summary: 'The existing repository map and manual editors remain available.' },
  };
  return {
    descriptor,
    detect: () => ({ available: true, version: 'fixture-cli-1.0', authentication: { connected: true } }),
    run: async ({ progress }) => {
      progress(.4, 'Fixture provider accepted bounded context.');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        output: {
          schemaVersion: 1, operation: 'component-design', summary: 'Keep runtime control separate from repository planning.',
          components: [{
            slug: 'repository-planning', title: 'Repository Planning', responsibility: 'Turn observed systems and product intent into a reviewable work model.',
            outcomes: ['Evidence-backed components and fronts'], responsibilities: ['Design durable responsibilities'], limits: ['No implicit publication'],
            invariants: ['Every claim is grounded or uncertain'], interfaces: ['Consumes normalized repository intelligence'], dependencies: [],
            dataSystems: ['Private planning context'], territory: ['src/planning/'], verification: ['Run planning contract and browser tests'],
            evidenceIds: ['human:question'], uncertainty: 'medium', assumptions: [], questions: [],
          }],
          fronts: [], findings: [], assumptions: [], questions: ['Should this responsibility remain one component as the product grows?'],
        },
        usage: { input_tokens: 120, output_tokens: 80 }, cost: null,
      };
    },
    dispose() {},
  };
}

function browserSlowAnalysisAdapter() {
  const descriptor = {
    id: 'browser-slow-local',
    name: 'Browser slow local analyzer',
    version: '1.0.0',
    contractVersion: 1,
    capabilities: {
      languages: [],
      entityKinds: ['file'],
      relationKinds: [],
      queries: ['entity', 'search', 'neighbors', 'path', 'evidence'],
      history: false,
      semantic: false,
      incremental: false,
    },
    privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
  };
  return {
    descriptor,
    detect: () => ({ available: true, version: 'fixture-1.0', isolation: 'private-snapshot' }),
    plan: () => ({ mode: 'fixture-held-analysis', deterministic: true, isolation: 'private-snapshot' }),
    analyze: ({ signal, progress }) => {
      progress(.1, 'Fixture analysis is waiting so resume can be verified.');
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('Analysis cancelled', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
    query: () => { throw new Error('The held fixture analysis has no completed snapshot.'); },
    dispose() {},
  };
}

function launchChrome(binary, profile, extra = []) {
  const child = spawn(binary, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-proxy-server',
    `--user-data-dir=${profile}`,
    ...extra,
    '--remote-debugging-pipe',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const input = child.stdio[3];
  const output = child.stdio[4];
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    for (let boundary = buffer.indexOf('\0'); boundary >= 0; boundary = buffer.indexOf('\0')) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      const waiting = pending.get(message.id);
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result || {});
    }
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.once('error', (error) => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    pending.clear();
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome protocol timed out at ${method}: ${stderr.slice(-1_000)}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });

  let sessionId;
  const ensurePage = async () => {
    if (sessionId) return sessionId;
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    sessionId = attached.sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    return sessionId;
  };
  const waitFor = async (expected) => {
    const session = await ensurePage();
    const deadline = Date.now() + 15_000;
    let html = '';
    while (Date.now() < deadline) {
      const evaluated = await send('Runtime.evaluate', {
        expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
        returnByValue: true,
      }, session);
      html = evaluated.result?.value || '';
      expected.lastIndex = 0;
      if (expected.test(html)) return html;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`browser never rendered ${expected}: ${html.slice(0, 1_000)}`);
  };

  return {
    async evaluate(expression, { awaitPromise = true } = {}) {
      const session = await ensurePage();
      const evaluated = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, session);
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || 'browser evaluation failed');
      return evaluated.result?.value;
    },
    async blockUrls(urls) {
      const session = await ensurePage();
      await send('Network.enable', {}, session);
      await send('Network.setBlockedURLs', { urls }, session);
    },
    async setViewport(width, height, { mobile = false } = {}) {
      const session = await ensurePage();
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile,
      }, session);
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 }, session);
    },
    waitFor,
    async navigate(url, expected) {
      const session = await ensurePage();
      await send('Page.navigate', { url }, session);
      return waitFor(expected);
    },
    async close() {
      try { await send('Browser.close'); } catch { child.kill('SIGTERM'); }
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

test('[R0-RPL-02][R0-RPL-05][R0-RUN-07][R0-CUX-05][R0-T03][R0-T11][R0-T12] browser smoke covers scoped compatibility, release authority, planned and ad-hoc runs, implicit loopback access and remote-client pairing', async (context) => {
  const chrome = CHROME_CANDIDATES.find(existsSync);
  const webRoot = join(process.cwd(), 'dist', 'ui');
  if (!chrome || !existsSync(join(webRoot, 'index.html'))) {
    context.skip('headless Chrome or the built UI is unavailable');
    return;
  }

  const fixture = mkdtempSync(join(tmpdir(), 'handraise-browser-smoke-'));
  const stateRoot = join(fixture, 'state');
  const repositoryRoot = join(fixture, 'repository');
  const browserProfile = join(fixture, 'chrome');
  const bin = join(fixture, 'bin');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repositoryRoot, 'README.md'), 'Browser smoke fixture.\n');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Claude Code fixture 1.0'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":false}'; exit 0; fi
exit 0
`);
  writeFileSync(join(bin, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Codex fixture 1.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo 'Logged in'; exit 0; fi
exit 0
`);
  chmodSync(join(bin, 'claude'), 0o700);
  chmodSync(join(bin, 'codex'), 0o700);
  const config = new ConfigStore({
    root: stateRoot, resolveRepository: () => repositoryRoot, home: fixture,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const registered = config.addRepository(repositoryRoot, { name: 'Browser fixture' });
  config.updateRepository(registered.id, { defaultAgent: 'codex' });
  initializeNativeRepository(registered);
  const repository = { ...registered, adapter: 'handraise' };
  const component = createComponent(repository, {
    slug: 'runtime', title: 'Runtime', scope: 'Own browser-smoke runtime behavior.', order: 1,
  });
  const front = createFront(repository, component.slug, {
    slug: 'safe-cleanup', title: 'Safe cleanup', outcome: 'Destructive controls require confirmation.',
    context: 'The browser fixture verifies both cancellation and confirmed deletion.',
    handoff: 'Keep the repository file until the user explicitly confirms the operation.',
    tasks: ['Verify cancellation', 'Verify confirmed deletion'], impact: 'alto', complexity: 'media',
  });
  updateFront(repository, component.slug, front.slug, {
    state: 'done', tasks: front.tasks.map((task) => ({ ...task, state: 'done' })),
  });
  const runFront = createFront(repository, component.slug, {
    slug: 'reviewed-run', title: 'Reviewed run',
    outcome: 'A reviewed accepted plan crosses into one auditable agent run.',
    motivation: 'The browser must prove that planning and execution remain separate boundaries.',
    scope: 'Review exact native v2 context and explicitly start one isolated run.',
    nonGoals: ['No implicit worktree or agent allocation.'], readiness: ['Codex is connected on the server host.'],
    acceptanceCriteria: ['The run start is explicitly reviewed.'], verification: ['Browser plan-to-run smoke passes.'],
    deliverables: ['One immutable run manifest.'], risks: ['The fixture session is intentionally synthetic.'],
    dependencies: [], evidence: [{ kind: 'declared', reference: 'browser:plan-to-run', reason: 'Required browser acceptance path.' }],
    affectedComponents: [], goalIds: [], analysisSnapshot: null,
    context: 'This accepted browser fixture verifies the exact plan-driven execution boundary.',
    handoff: 'Review the preflight and preserve the accepted front bytes until explicit start.',
    tasks: ['Start only after exact readiness review'], impact: 'alto', complexity: 'media',
  });
  const componentPath = join(repositoryRoot, '.handraise', 'components', 'runtime.md');
  writeFileSync(componentPath, readFileSync(componentPath, 'utf8').replace('schema: 2\n', ''));
  const legacyComponent = readFileSync(componentPath, 'utf8');
  const frontPath = join(repositoryRoot, '.handraise', 'fronts', 'safe-cleanup.md');
  const runFrontPath = join(repositoryRoot, '.handraise', 'fronts', 'reviewed-run.md');
  writeFileSync(runFrontPath, readFileSync(runFrontPath, 'utf8').replace('schema: 2\n', ''));
  const legacyRunFront = readFileSync(runFrontPath, 'utf8');
  const unrelatedFrontBytes = readFileSync(frontPath, 'utf8');
  const productPath = join(repositoryRoot, '.handraise', 'product.md');
  const auth = new PairingAuth({ root: stateRoot });
  let setupLaunch = null;
  let runLaunch = null;
  let adHocLaunch = null;
  let adHocLaunches = 0;
  let runWorkspaceCreates = 0;
  let adHocWorkspaceCreates = 0;
  let managedTunnelStarts = 0;
  let managedTunnelState = {
    provider: 'cloudflare-quick', title: 'Cloudflare Quick Tunnel', installed: true, version: 'fixture 1.0',
    status: 'idle', publicUrl: null, target: null, startedAt: null, error: null,
    temporary: true, public: true, supportsSse: false, managed: true,
  };
  const managedInternetTunnel = {
    snapshot: () => ({ ...managedTunnelState }),
    start: async ({ target }) => {
      managedTunnelStarts += 1;
      managedTunnelState = {
        ...managedTunnelState, status: 'ready', publicUrl: 'https://browser-fixture.trycloudflare.com', target,
      };
      return { ...managedTunnelState };
    },
    stop: async () => {
      managedTunnelState = { ...managedTunnelState, status: 'idle', publicUrl: null, target: null };
      return { ...managedTunnelState };
    },
  };
  const graphifyExecutable = join(fixture, 'missing-graphify');
  const analysisRuntime = new AnalysisRuntime({
    root: join(stateRoot, 'analysis'),
    adapters: [createGraphifyAdapter({ executable: graphifyExecutable }), browserSlowAnalysisAdapter()],
  });
  const planningRuntime = new PlanningRuntime({
    root: join(stateRoot, 'planning'), adapters: [browserPlanningAdapter()],
  });
  const server = createHandraise({
    root: stateRoot, webRoot, auth, config, managedInternetTunnel, analysisRuntime, planningRuntime,
    networkInterfaceSnapshot: {
      ethernet: [{ address: '192.168.50.20', family: 'IPv4', internal: false }],
    },
    createRunWorkspace: (_target, slug) => {
      if (slug.startsWith('adhoc-')) adHocWorkspaceCreates += 1;
      else runWorkspaceCreates += 1;
      return { path: join(repositoryRoot, '.handraise', 'worktrees', slug), branch: `handraise/${slug}`, created: true, baseline: 'browser-baseline' };
    },
    removeRunWorkspace: () => ({ removed: true }),
    inspectRunWorkshop: () => ({ worktrees: [], orphans: [] }),
    inspectRunGitState: (_target, path, slug = '') => ({ available: true, path, branch: slug ? `handraise/${slug}` : 'main', expectedBranch: slug ? `handraise/${slug}` : null, branchMismatch: false, baseline: 'browser-baseline', dirty: 0, ahead: 0, behind: 0, backupRef: 'origin/main', unbacked: 0 }),
    launchSession: (details) => {
      if (details.role === 'setup') setupLaunch = details;
      if (details.role === 'ad-hoc') { adHocLaunch = details; adHocLaunches += 1; }
      else if (details.runId) runLaunch = details;
      const controlSlug = details.repoId ? `${details.repoId}--${details.slug}` : details.slug;
      return { existed: false, controlSlug, tmux: `handraise-${controlSlug}` };
    },
  });
  let statePolls = 0;
  server.on('request', (request) => { if (request.url === '/api/state') statePolls += 1; });
  let browser;
  let serverClosed = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    server.close();
    rmSync(fixture, { recursive: true, force: true });
    if (error?.code === 'EPERM') {
      context.skip('the execution sandbox does not permit a local listening socket');
      return;
    }
    throw error;
  }
  const closeServer = async () => {
    if (serverClosed) return;
    serverClosed = true;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  };
  context.after(async () => {
    await browser?.close();
    await closeServer();
    for (const job of analysisRuntime.list(registered.id)) {
      try { await analysisRuntime.delete(registered.id, job.id); } catch { /* best-effort private fixture cleanup */ }
    }
    for (const job of planningRuntime.list(registered.id)) {
      try { await planningRuntime.delete(registered.id, job.id); } catch { /* best-effort private fixture cleanup */ }
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  const { port } = server.address();
  browser = launchChrome(chrome, browserProfile, ['--host-resolver-rules=MAP handraise.test 127.0.0.1']);
  await browser.blockUrls(['*/api/stream']);
  const localDom = await browser.navigate(`http://127.0.0.1:${port}/settings`, /Server host stays signed in/);
  assert.match(localDom, /Direct server-host access is implicit/);
  assert.match(localDom, /Server host stays signed in/);
  const qualitySettingsDom = await browser.waitFor(/Planning quality benchmark · v1\.0\.0/);
  assert.match(qualitySettingsDom, /human gate blocked/);
  assert.match(qualitySettingsDom, /Semantic and release limitations/);
  assert.doesNotMatch(localDom, /Pair this client/);
  assert.match(localDom, /<html[^>]+data-theme=/);
  assert.equal(auth.devices().length, 0, 'implicit loopback access must not create a paired-device record');
  for (let attempt = 0; attempt < 40 && statePolls < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(statePolls >= 2, 'the client keeps polling authenticated state when SSE is unavailable');

  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Pair another client')).click(); true`);
  const remoteChoiceDom = await browser.waitFor(/Where will the other browser or installed PWA connect from/);
  assert.match(remoteChoiceDom, /Private network/);
  assert.match(remoteChoiceDom, /Internet/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Private network')).click(); true`);
  const privateModeDom = await browser.waitFor(/192\.168\.50\.20/);
  assert.match(privateModeDom, /not listening yet/);
  assert.match(privateModeDom, /handraise serve --host 0\.0\.0\.0 --port/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Internet')).click(); true`);
  assert.match(await browser.waitFor(/Create temporary tunnel/), /Cloudflare Quick Tunnel/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Create temporary tunnel').click(); true`);
  const tunnelDom = await browser.waitFor(/https:\/\/browser-fixture\.trycloudflare\.com/);
  assert.match(tunnelDom, /Temporary Internet tunnel is live/);
  assert.equal(managedTunnelStarts, 1);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Generate one-time QR')).click(); true`);
  const internetPairingDom = await browser.waitFor(/Internet · one time/);
  assert.match(internetPairingDom, /https:\/\/browser-fixture\.trycloudflare\.com\/\?pair=/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Done').click(); true`);

  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Pair another client')).click(); true`);
  await browser.waitFor(/Where will the other browser or installed PWA connect from/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Internet')).click(); true`);
  await browser.waitFor(/Temporary Internet tunnel is live/);
  await browser.evaluate(`window.confirm = () => true; [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Stop temporary tunnel').click(); true`);
  await browser.waitFor(/Create temporary tunnel/);
  await browser.evaluate(`document.querySelector('button[aria-label="Close remote pairing"]').click(); true`);

  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Connect Claude Code').click(); true`);
  for (let attempt = 0; attempt < 50 && !setupLaunch; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(setupLaunch?.command, 'claude auth login');
  assert.equal(setupLaunch?.role, 'setup');
  assert.match(await browser.waitFor(/Setup terminal open/), /Credentials stay with the CLI|Setup terminal open/);

  const pairing = auth.startPairing();
  const pairedDom = await browser.navigate(
    `http://handraise.test:${port}/?pair=${encodeURIComponent(pairing.token)}`,
    /Fleet command center/,
  );
  assert.doesNotMatch(pairedDom, /Pair this client/);
  assert.equal(auth.devices().length, 1, 'the remote browser must persist one revocable client');

  const remoteSettingsDom = await browser.navigate(`http://handraise.test:${port}/settings`, /Log out this client/);
  assert.match(remoteSettingsDom, /Log out this client/);
  assert.doesNotMatch(remoteSettingsDom, /Server host stays signed in/);

  const repositoryHomeDom = await browser.navigate(
    `http://handraise.test:${port}/repositories/${registered.id}`,
    /Move from understanding to a shipped outcome/,
  );
  const journeyDom = await browser.waitFor(/Product not accepted/);
  assert.match(journeyDom, /Recommended next/);
  assert.match(journeyDom, /Understand/);
  assert.match(journeyDom, /Design/);
  assert.match(journeyDom, /Run/);
  assert.match(journeyDom, /Upgrade existing work for safe runs/);
  assert.match(journeyDom, /Choose a front to upgrade/);
  assert.match(repositoryHomeDom, /Current delivery/);
  assert.match(repositoryHomeDom, /Browse and connect/);
  assert.equal(new URL(await browser.evaluate(`window.location.href`)).pathname, `/repositories/${registered.id}`);
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.guided-stage')].map((link) => new URL(link.href).pathname)`), [
    `/repositories/${registered.id}/map`,
    `/repositories/${registered.id}/components`,
    `/repositories/${registered.id}/releases`,
  ], 'the vertical guide exposes canonical Understand, Design and Run links');
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.guided-stage')].every((link) => link.tagName === 'A')`), true, 'guided stages are real hyperlinks');
  assert.equal(await browser.evaluate(`document.querySelectorAll('.repository-browse details').length`), 2, 'secondary inventories stay grouped behind progressive disclosure');
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.repository-journey nav'))`), false, 'the repository summary does not repeat primary navigation');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.body).fontSize) >= 16`), true, 'body copy keeps a readable 16px baseline');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.primary-nav > a span')).fontSize) >= 14`), true, 'primary navigation is readable without zoom');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.journey-next strong')).fontSize) >= 16`), true, 'the recommended action keeps content-scale type');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.journey-truth')).fontSize) >= 13`), true, 'repository status text stays above the metadata floor');
  await browser.evaluate(`document.querySelector('.journey-boundary summary').click(); true`);
  const authorityDom = await browser.waitFor(/Agent claims never satisfy acceptance/);
  assert.match(authorityDom, /read-only and bounded/);
  assert.match(authorityDom, /Manual and skip paths stay available/);
  await browser.setViewport(320, 720, { mobile: true });
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'the guided workflow must not overflow from the 320px mobile baseline');
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.primary-nav')).position`), 'fixed', 'mobile phase navigation stays thumb-reachable');
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.primary-nav > a small')).display`), 'none');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.primary-nav > a')).minHeight) >= 44`), true, 'coarse-pointer primary navigation keeps a 44px touch target');
  assert.equal(await browser.evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    const rgb = (value) => {
      const color = value.trim();
      const hex = color.replace('#', '');
      if (/^[0-9a-f]{3}$/i.test(hex)) return [...hex].map((part) => parseInt(part + part, 16) / 255);
      if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map((part) => Number(part) / 255);
      return channels?.length === 3 ? channels : [NaN, NaN, NaN];
    };
    const luminance = (color) => rgb(color).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const foreground = luminance(root.getPropertyValue('--muted'));
    const background = luminance(root.getPropertyValue('--surface'));
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) >= 4.5;
  })()`), true, 'secondary text tokens meet AA contrast against surfaces');
  await browser.setViewport(1280, 900);
  await browser.evaluate(`document.querySelector('.guided-stage:nth-child(2)').click(); true`);
  const productEntryDom = await browser.waitFor(/Accepted work model/);
  assert.equal(new URL(await browser.evaluate(`window.location.href`)).pathname, `/repositories/${registered.id}/components`);
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.repository-journey'))`), false, 'specialist workspaces do not repeat the repository guide');
  assert.match(productEntryDom, /Accepted work model/);
  assert.match(productEntryDom, /Goals → components → fronts → runs/);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.work-model-graph > article').length > 0`), true);
  await browser.evaluate(`document.querySelector('.work-model-mode button:last-child').click(); true`);
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.work-model-list[role="table"]'))`), true, 'accepted work model exposes an accessible list alternative');
  await browser.evaluate(`document.querySelector('.work-model-mode button:first-child').click(); true`);
  assert.equal(await browser.evaluate(`document.querySelector('.primary-nav > a[aria-current="page"]')?.textContent.includes('Design')`), true);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.primary-nav > a').length`), 3, 'the primary navigation contains only Understand, Design and Run');
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.primary-nav > a')].every((link) => link.href.startsWith('http'))`), true, 'primary phases preserve normal hyperlink behavior');
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.primary-nav .fleet-nav'))`), false, 'Fleet is not duplicated as a repository navigation item');
  assert.equal(await browser.evaluate(`(() => { const link = document.querySelector('.primary-nav > a[aria-current="page"]'); link.focus(); return document.activeElement === link; })()`), true, 'the active primary phase is keyboard focusable');
  assert.match(productEntryDom, /Product brief/);
  assert.match(productEntryDom, /Analyze repository/);
  assert.match(productEntryDom, /Design with model/);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.design-command-bar > button').length`), 2, 'Design initially exposes only its two primary planning actions');
  assert.equal(await browser.evaluate(`document.querySelector('.design-more-actions').open`), false, 'technical and infrequent Design actions are collapsed by default');
  await browser.evaluate(`document.querySelector('.design-more-actions > summary').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Design with model').click(); true`);
  const remotePlanningDom = await browser.waitFor(/Preview exact model context/);
  assert.match(remotePlanningDom, /Browser fixture planner/);
  await browser.evaluate(`[...document.querySelectorAll('.planning-dialog button')].find((button) => button.textContent.trim() === 'Preview exact model context').click(); true`);
  assert.match(await browser.waitFor(/only the implicit server-host client can select source context/), /implicit server-host client/);
  await browser.evaluate(`document.querySelector('.planning-dialog > footer button:last-child').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Analyze repository').click(); true`);
  const analyzerCatalogDom = await browser.waitFor(/Preview exact scope/);
  assert.match(analyzerCatalogDom, /Graphify local code graph/);
  await browser.evaluate(`(() => { const select = document.querySelector('.analysis-dialog select'); select.value = 'graphify-code-local'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const unavailableGraphifyDom = await browser.waitFor(/GRAPHIFY_NOT_FOUND/);
  assert.match(unavailableGraphifyDom, /will not install it automatically/);
  assert.equal(await browser.evaluate(`document.querySelector('.analysis-preview-action').disabled`), true);
  await browser.evaluate(`(() => { const select = document.querySelector('.analysis-dialog select'); select.value = 'handraise-inventory'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Preview exact scope').click(); true`);
  const analysisPlanDom = await browser.waitFor(/Start reviewed analysis/);
  assert.match(analysisPlanDom, /No repository mutation/);
  assert.equal(readFileSync(componentPath, 'utf8'), legacyComponent, 'analysis planning must leave accepted contracts unchanged');
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Start reviewed analysis').click(); true`);
  const analysisCompleteDom = await browser.waitFor(/Analysis completed over the reviewed repository snapshot/);
  assert.match(analysisCompleteDom, /current/);
  assert.match(analysisCompleteDom, /private result is complete; it is still not accepted product or repository truth/i);
  assert.equal(readFileSync(componentPath, 'utf8'), legacyComponent, 'analysis execution must leave accepted contracts unchanged');
  assert.equal(existsSync(join(repositoryRoot, 'graphify-out')), false);
  await browser.evaluate(`document.querySelector('.analysis-dialog > footer button:last-child').click(); true`);

  await browser.navigate(
    `http://handraise.test:${port}/repositories/${registered.id}/map`,
    /Intent first\. Evidence second\. Work design last/,
  );
  const mapDom = await browser.waitFor(/Derived, not accepted truth/);
  assert.match(mapDom, /Product intent/);
  assert.match(mapDom, /Repository evidence/);
  assert.match(mapDom, /Accepted work model/);
  assert.match(mapDom, /No product brief is accepted yet/);
  assert.equal(await browser.evaluate(`document.querySelector('.understand-heading h1').textContent`), 'Intent first. Evidence second. Work design last.', 'Understand exposes one semantic page heading');
  assert.equal(await browser.evaluate(`document.querySelector('.understand-path').tagName`), 'OL', 'the three-step Understand path is an ordered list');
  assert.equal(new URL(await browser.evaluate(`document.querySelector('.understand-path li:last-child > a').href`)).pathname, `/repositories/${registered.id}/components`, 'manual Design remains a canonical path when analysis is skipped');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.understand-path .button-link')).minHeight) >= 44`), true, 'link actions meet the touch target baseline');
  assert.equal(await browser.evaluate(`document.querySelector('.system-map-inspection').open`), false, 'snapshot IDs, export, diagnostics and comparison are progressively disclosed');
  assert.equal(await browser.evaluate(`document.querySelector('.understand-secondary.reconciliation').open`), false, 'drift review is collapsed without high-priority findings');
  assert.equal(await browser.evaluate(`document.querySelector('.understand-secondary.learning').open`), false, 'learning proposals do not overwhelm the initial Understand view');
  assert.match(mapDom, /Derived, not accepted truth/);
  assert.match(await browser.waitFor(/Architecture reconciliation/), /Findings are review overlays, never silent contract edits/);
  assert.match(await browser.waitFor(/Accepted contracts/), /Unchanged/);
  assert.match(mapDom, /Responsibilities/);
  assert.match(mapDom, /Change coupling/);
  assert.match(mapDom, /unsupported/);
  assert.equal(readFileSync(componentPath, 'utf8'), legacyComponent, 'opening the derived map from a paired remote client must not mutate accepted contracts');
  assert.ok(await browser.evaluate(`document.querySelectorAll('.system-map-node').length > 0`));
  assert.equal(await browser.evaluate(`document.querySelector('.system-map-node').getAttribute('role')`), null, 'map result buttons retain their native button semantics');
  assert.equal(await browser.evaluate(`document.querySelector('.system-map-node').parentElement.tagName`), 'LI', 'map result buttons sit inside semantic list items');
  assert.equal(await browser.evaluate(`document.querySelector('.system-map-lenses button').getAttribute('aria-pressed')`), 'true', 'the All lens communicates its selected state');
  await browser.evaluate(`(() => { const node = [...document.querySelectorAll('.system-map-node')].find((item) => item.textContent.includes('Responsibilities')); node.focus(); node.click(); return true; })()`);
  const mapDetailDom = await browser.waitFor(/Why this grouping exists/);
  assert.match(mapDetailDom, /README\.md/);
  assert.match(mapDetailDom, /directory is not assumed to be a component|not an accepted component boundary/);
  assert.match(mapDetailDom, /Extracted|Inferred|Declared/);
  assert.match(mapDetailDom, /uncertainty/i);
  assert.ok(await browser.evaluate(`document.activeElement.classList.contains('system-map-node')`), 'a map hypothesis is a keyboard-focusable button');
  await browser.evaluate(`document.querySelector('.system-map-detail .evidence-reference-action')?.click(); true`);
  const exactEvidenceDom = await browser.waitFor(/Opened evidence references/);
  assert.match(exactEvidenceDom, /Source in the selected snapshot/);
  assert.match(exactEvidenceDom, /Technical reference/);
  await browser.evaluate(`[...document.querySelectorAll('.system-map-mode button')].find((button) => button.textContent.trim() === 'List').click(); true`);
  assert.ok(await browser.evaluate(`Boolean(document.querySelector('.system-map-list'))`));
  await browser.evaluate(`(() => { const input = document.querySelector('.system-map-toolbar input'); input.value = 'README'; input.dispatchEvent(new Event('input', { bubbles: true })); input.form.requestSubmit(); return true; })()`);
  const mapSearchDom = await browser.waitFor(/README\.md/);
  assert.match(mapSearchDom, /Derived, not accepted truth/);
  assert.equal(readFileSync(componentPath, 'utf8'), legacyComponent, 'map search and detail queries remain read-only');

  await browser.evaluate(`document.querySelector('.system-map-inspection > summary').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('.system-map-inspection button')].find((button) => button.textContent.trim() === 'New analysis').click(); true`);
  await browser.waitFor(/Browser slow local analyzer/);
  await browser.evaluate(`(() => { const select = document.querySelector('.analysis-dialog select'); select.value = 'browser-slow-local'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Preview exact scope').click(); true`);
  await browser.waitFor(/fixture-held-analysis/);
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Start reviewed analysis').click(); true`);
  await browser.waitFor(/Fixture analysis is waiting so resume can be verified/);
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.analysis-job.running'))`), true, 'the fixture analysis remains active before leaving the dialog');

  await browser.navigate(
    `http://handraise.test:${port}/repositories/${registered.id}/map`,
    /Fixture analysis is waiting so resume can be verified/,
  );
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.analysis-dialog'))`), false, 'a full route reload drops transient dialog state');
  assert.equal(await browser.evaluate(`document.querySelector('.understand-path li:nth-child(2) button').textContent.trim()`), 'Open progress', 'Understand recognizes the existing active analysis');
  await browser.evaluate(`document.querySelector('.understand-path li:nth-child(2) button').click(); true`);
  for (let attempt = 0; attempt < 40 && !await browser.evaluate(`Boolean(document.querySelector('.analysis-dialog .analysis-job.running'))`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.analysis-dialog .analysis-job.running'))`), true, 'the resumed dialog points to the same running job');
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.analysis-dialog .analysis-configuration'))`), false, 'opening progress resumes the active job instead of presenting a duplicate analysis form');
  assert.match(await browser.evaluate(`document.querySelector('.analysis-dialog .unified-job-progress').textContent`), /browser-slow-local/);
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Cancel analysis').click(); true`);
  await browser.waitFor(/Analysis was cancelled by the user/);
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.analysis-dialog .analysis-job.cancelled'))`), true, 'the resumed active job remains cancellable');
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Plan another').click(); true`);
  await browser.waitFor(/Preview exact scope/);
  writeFileSync(join(repositoryRoot, 'README.md'), 'Browser smoke fixture, revised for snapshot identity.\n');
  await browser.evaluate(`(() => { const select = document.querySelector('.analysis-dialog select'); select.value = 'handraise-inventory'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Preview exact scope').click(); true`);
  await browser.waitFor(/Start reviewed analysis/);
  await browser.evaluate(`[...document.querySelectorAll('.analysis-dialog button')].find((button) => button.textContent.trim() === 'Start reviewed analysis').click(); true`);
  await browser.waitFor(/Analysis completed over the reviewed repository snapshot/);
  await browser.evaluate(`document.querySelector('.analysis-dialog > footer button:last-child').click(); true`);

  await browser.waitFor(/Derived system map/);
  await browser.evaluate(`document.querySelector('.system-map-inspection > summary').click(); true`);
  for (let attempt = 0; attempt < 40 && await browser.evaluate(`document.querySelectorAll('.system-map-heading-actions select option').length < 2`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  const snapshotChoices = await browser.evaluate(`[...document.querySelectorAll('.system-map-heading-actions select option')].map((option) => ({ value: option.value, text: option.textContent }))`);
  assert.equal(snapshotChoices.length, 2, 'two completed snapshots are selectable after the refreshed analysis');
  assert.equal(await browser.evaluate(`document.querySelectorAll('.system-map-compare select option').length`), 2, 'the latest snapshot can compare only against its one earlier snapshot');
  assert.notEqual(await browser.evaluate(`document.querySelector('.system-map-compare select option:last-child').value`), snapshotChoices[0].value, 'the selected snapshot is never offered as its own comparison source');
  await browser.evaluate(`(() => { const select = document.querySelector('.system-map-heading-actions select'); select.value = ${JSON.stringify(snapshotChoices[1].value)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const earlierSnapshotPrefix = snapshotChoices[1].text.split(' · ').at(-1);
  for (let attempt = 0; attempt < 40 && !await browser.evaluate(`document.querySelector('.system-map-technical-identity code')?.textContent.includes(${JSON.stringify(earlierSnapshotPrefix)})`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await browser.evaluate(`document.querySelector('.system-map-technical-identity code').textContent.includes(${JSON.stringify(earlierSnapshotPrefix)})`), true, 'the rendered map identity follows the selected snapshot');
  assert.equal(await browser.evaluate(`document.querySelectorAll('.system-map-compare select option').length`), 1, 'an earliest snapshot offers no same-age or newer comparison source');
  assert.equal(await browser.evaluate(`document.querySelector('.system-map-compare button').disabled`), true, 'self or reverse-time comparison cannot be submitted');

  await browser.setViewport(320, 720, { mobile: true });
  await browser.navigate(`http://handraise.test:${port}/repositories/${registered.id}/map`, /Intent first\. Evidence second\. Work design last/);
  await browser.waitFor(/Derived system map/);
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.system-map-list'))`), true, 'Understand starts list-first on the 320px baseline');
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.system-map-canvas'))`), false, 'the graph-like card canvas is an explicit mobile alternative');
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'Understand must not overflow the 320px mobile baseline');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.system-map-mode button')).minHeight) >= 44`), true, 'map/list controls remain touch-safe');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.system-map-lenses button')).minHeight) >= 44`), true, 'evidence lenses remain touch-safe');
  await browser.evaluate(`document.querySelector('.system-map-list > li > button').click(); true`);
  await browser.waitFor(/Why this grouping exists/);
  for (let attempt = 0; attempt < 20 && !await browser.evaluate(`document.activeElement.classList.contains('system-map-detail')`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await browser.evaluate(`document.activeElement.classList.contains('system-map-detail')`), true, 'mobile selection moves focus to the evidence detail');
  await browser.evaluate(`document.querySelector('.system-map-back').click(); true`);
  for (let attempt = 0; attempt < 20 && !await browser.evaluate(`Boolean(document.activeElement.dataset.mapId)`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await browser.evaluate(`Boolean(document.activeElement.dataset.mapId)`), true, 'returning from mobile detail restores focus to the selected result');
  await browser.setViewport(1280, 900);

  await browser.navigate(`http://handraise.test:${port}/repositories/${registered.id}/components`, /Review v2 migration/);
  assert.match(productEntryDom, /Review v2 migration/);
  const legacyRunEntryDom = await browser.navigate(
    `http://handraise.test:${port}/repositories/${registered.id}/components/runtime/fronts/${runFront.slug}`,
    /Review this front's v2 upgrade/,
  );
  assert.match(legacyRunEntryDom, /Start legacy session/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === "Review this front's v2 upgrade").click(); true`);
  const migrationDom = await browser.waitFor(/Selected front reviewed-run/);
  assert.match(migrationDom, /Review work contracts for Browser fixture/);
  assert.match(migrationDom, /\.handraise\/components\/runtime\.md/);
  assert.match(migrationDom, /\.handraise\/fronts\/reviewed-run\.md/);
  assert.doesNotMatch(migrationDom, /\.handraise\/fronts\/safe-cleanup\.md/);
  assert.equal(readFileSync(componentPath, 'utf8'), legacyComponent, 'reviewing migration must remain read-only');
  assert.equal(readFileSync(runFrontPath, 'utf8'), legacyRunFront, 'scoped migration preview must preserve the selected front');
  assert.equal(readFileSync(frontPath, 'utf8'), unrelatedFrontBytes, 'scoped migration preview must preserve unrelated fronts');
  await browser.evaluate(`window.confirm = () => true; [...document.querySelectorAll('.contract-migration-dialog button')].find((button) => button.textContent.trim() === 'Apply reviewed migration').click(); true`);
  for (let attempt = 0; attempt < 50 && !/^schema: 2$/m.test(readFileSync(componentPath, 'utf8')); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(readFileSync(componentPath, 'utf8'), /^schema: 2$/m);
  assert.match(readFileSync(runFrontPath, 'utf8'), /^schema: 2$/m);
  assert.equal(readFileSync(frontPath, 'utf8'), unrelatedFrontBytes, 'scoped migration acceptance must preserve unrelated fronts byte-for-byte');
  for (let attempt = 0; attempt < 50 && await browser.evaluate(`Boolean(document.querySelector('.contract-migration-dialog'))`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await browser.evaluate(`Boolean(document.querySelector('.contract-migration-dialog'))`), false);

  const runFrontBefore = readFileSync(runFrontPath, 'utf8');
  const runEntryDom = await browser.navigate(
    `http://handraise.test:${port}/repositories/${registered.id}/components/runtime/fronts/${runFront.slug}`,
    /Review run preflight/,
  );
  assert.match(runEntryDom, /No run has crossed the execution boundary/);
  assert.match(runEntryDom, /Follow the outcome down to its live process/);
  assert.match(runEntryDom, /Not assigned yet/);
  assert.match(runEntryDom, /Durable responsibility boundary/);
  assert.equal(await browser.evaluate(`document.querySelector('.front-plan-details').open`), false, 'front context and handoff are progressively disclosed');
  assert.equal(new URL(await browser.evaluate(`document.querySelector('.work-context-flow a').href`)).pathname, `/repositories/${registered.id}/releases`, 'an unassigned front links to the release workspace');
  await browser.setViewport(320, 720, { mobile: true });
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'front, run and execution relationships must not overflow the 320px baseline');
  assert.equal(await browser.evaluate(`parseFloat(getComputedStyle(document.querySelector('.work-context-flow a')).minHeight) >= 44`), true, 'vertical work-context links remain touch-safe');
  await browser.setViewport(1280, 900);
  assert.equal(runWorkspaceCreates, 0);
  assert.equal(runLaunch, null);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Review run preflight').click(); true`);
  const runSetupDom = await browser.waitFor(/Read-only readiness review/);
  assert.match(runSetupDom, /Nothing is allocated until you confirm this revision/);
  assert.equal(runWorkspaceCreates, 0, 'opening the run boundary must not allocate a worktree');
  assert.equal(readFileSync(runFrontPath, 'utf8'), runFrontBefore, 'opening the run boundary must not mutate the accepted front');
  await browser.evaluate(`[...document.querySelectorAll('.run-preflight-dialog button')].find((button) => button.textContent.trim() === 'Review readiness').click(); true`);
  const runReviewDom = await browser.waitFor(/Ready for explicit start/);
  assert.match(runReviewDom, /Accepted source/);
  assert.match(runReviewDom, /Reviewed workspace/);
  assert.match(runReviewDom, /Agent capability snapshot/);
  assert.match(runReviewDom, /complete execution context/);
  assert.match(runReviewDom, /handraise hooks repair|Final revalidation still runs under the start boundary/);
  assert.equal(runWorkspaceCreates, 0, 'readiness remains a read-only review');
  assert.equal(readFileSync(runFrontPath, 'utf8'), runFrontBefore, 'readiness review preserves exact accepted bytes');
  assert.equal(await browser.evaluate(`document.querySelector('.run-review-actions .primary').disabled`), true);
  await browser.evaluate(`document.querySelector('.run-confirm input').click(); true`);
  assert.equal(await browser.evaluate(`document.querySelector('.run-review-actions .primary').disabled`), false);
  await browser.evaluate(`document.querySelector('.run-review-actions .primary').click(); true`);
  const activeRunDom = await browser.waitFor(/Execution and evidence/);
  assert.match(activeRunDom, /Agent process/);
  assert.match(activeRunDom, /Immutable manifest/);
  assert.match(activeRunDom, /Agent claims remain separate and non-authoritative/);
  assert.equal(await browser.evaluate(`document.querySelector('.run-technical-details').open`), false, 'manifest and raw workspace identity are collapsed by default');
  assert.equal(await browser.evaluate(`document.querySelector('.run-evidence-details').open`), true, 'evidence opens when the synthetic process has already reached awaiting-acceptance');
  assert.equal(runWorkspaceCreates, 1);
  assert.equal(runLaunch?.front, runFront.slug);
  assert.ok(runLaunch?.runId);
  assert.match(runLaunch?.command || '', /Accepted source digest/);
  assert.equal(readFileSync(runFrontPath, 'utf8'), runFrontBefore, 'explicit start snapshots but does not rewrite the accepted front');

  await browser.evaluate(`window.prompt = () => 'Browser reviewer observed the exact result.'; document.querySelector('.run-evidence-columns > section:first-child .run-evidence-row button').click(); true`);
  await browser.waitFor(/1\/1/);
  await browser.evaluate(`window.prompt = () => 'Browser acceptance criterion observed.'; document.querySelector('.run-evidence-columns > section:nth-child(2) .run-evidence-row button').click(); true`);
  await browser.waitFor(/Passed with reviewed evidence/);
  await browser.evaluate(`window.prompt = () => 'Browser plan-to-run smoke passed.'; document.querySelector('.run-evidence-columns > section:nth-child(2) .run-evidence-row.open button').click(); true`);
  await browser.waitFor(/Verification passed/);
  assert.equal(await browser.evaluate(`document.querySelector('.run-panel-actions .primary').disabled`), false);
  await browser.evaluate(`window.confirm = () => true; document.querySelector('.run-panel-actions .primary').click(); true`);
  const acceptedRunDom = await browser.waitFor(/Outcome accepted/);
  assert.match(acceptedRunDom, /process activity and evidence remain separately auditable/);
  assert.match(readFileSync(runFrontPath, 'utf8'), /state: done/);
  assert.match(readFileSync(runFrontPath, 'utf8'), /- \[x\]/);

  const processStartsBeforeRelease = { runWorkspaceCreates, runId: runLaunch?.runId };
  const releaseEmptyDom = await browser.navigate(
    `http://handraise.test:${port}/repositories/${registered.id}/releases`,
    /No release contract yet/,
  );
  assert.match(releaseEmptyDom, /One release contract owns progress above fronts and runs/);
  assert.match(releaseEmptyDom, /Planned delivery authority/);
  assert.match(releaseEmptyDom, /Processes and live control/);
  assert.equal(await browser.evaluate(`document.querySelector('.delivery-workspace-tabs > a.active')?.textContent.includes('Releases')`), true);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Create the first release').click(); true`);
  await browser.waitFor(/Assemble a release/);
  await browser.evaluate(`(() => {
    const set = (selector, value) => { const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
    set('.release-editor-fields label:nth-child(1) input', 'Release 0 — Browser dogfood');
    set('.release-editor-fields label:nth-child(2) input', 'release-0-browser-dogfood');
    set('.release-editor-fields label.wide textarea', 'The browser fixture ships one exact, verified delivery increment.');
    set('.release-gate-fields label:nth-child(1) textarea', 'R0-RPL-05');
    set('.release-gate-fields label:nth-child(2) textarea', 'The release remains the single planned-delivery authority.');
    set('.release-gate-fields label:nth-child(3) textarea', 'R0-T11');
    set('.release-gate-fields label:nth-child(4) textarea', 'Node >=20');
    set('.release-gate-fields label:nth-child(5) textarea', 'Browser fixture only.');
    return true;
  })()`);
  await browser.evaluate(`[...document.querySelectorAll('.release-available-fronts button')].find((button) => button.textContent.includes('Reviewed run')).click(); true`);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.release-selected-fronts > article').length`), 1);
  await browser.evaluate(`document.querySelector('.release-editor > footer .primary').click(); true`);
  const releaseDom = await browser.waitFor(/Release 0 — Browser dogfood/);
  assert.match(releaseDom, /R0-RPL-05/);
  assert.match(releaseDom, /R0-T11/);
  assert.match(releaseDom, /Contract revision/);
  assert.equal(new URL(await browser.evaluate(`document.querySelector('.release-front-list > a').href`)).pathname, `/repositories/${registered.id}/components/runtime/fronts/reviewed-run`, 'release membership links to the exact front context');
  assert.equal(await browser.evaluate(`document.querySelector('.release-contract-details').open`), false, 'technical release contract detail is collapsed by default');
  assert.equal(new URL(await browser.evaluate(`document.querySelector('.release-card > header h2 a').href`)).pathname, `/repositories/${registered.id}/releases/release-0-browser-dogfood`, 'release titles expose canonical deep links');
  await browser.evaluate(`document.querySelector('.release-card > header h2 a').click(); true`);
  await browser.waitFor(/Release detail/);
  assert.equal(new URL(await browser.evaluate(`window.location.href`)).pathname, `/repositories/${registered.id}/releases/release-0-browser-dogfood`);
  await browser.evaluate(`document.querySelector('.release-contract-details > summary').click(); true`);
  assert.equal(await browser.evaluate(`document.querySelector('.release-contract-details').open`), true, 'technical release detail remains available on demand');
  assert.equal(runWorkspaceCreates, processStartsBeforeRelease.runWorkspaceCreates, 'assembling a release must not allocate a run workspace');
  assert.equal(runLaunch?.runId, processStartsBeforeRelease.runId, 'assembling a release must not launch another agent');
  const releasePath = join(repositoryRoot, '.handraise', 'releases', 'release-0-browser-dogfood.md');
  assert.equal(existsSync(releasePath), true);
  assert.match(readFileSync(releasePath, 'utf8'), /- `reviewed-run` @ `[a-f0-9]{64}`/);
  assert.match(readFileSync(releasePath, 'utf8'), /- `R0-RPL-05`/);
  await browser.evaluate(`window.confirm = () => true; [...document.querySelectorAll('.release-card button')].find((button) => button.textContent.trim() === 'Mark structurally ready').click(); true`);
  await browser.waitFor(/ready<\/span>/i);
  assert.match(readFileSync(releasePath, 'utf8'), /^state: ready$/m);
  await browser.evaluate(`[...document.querySelectorAll('.release-card button')].find((button) => button.textContent.trim() === 'Activate release').click(); true`);
  await browser.waitFor(/Candidate promotion waits for current passing test and artifact evidence/);
  assert.match(readFileSync(releasePath, 'utf8'), /^state: active$/m);

  const releaseBeforeAdHoc = readFileSync(releasePath, 'utf8');
  const acceptedFrontBeforeAdHoc = readFileSync(runFrontPath, 'utf8');
  const frontNamesBeforeAdHoc = readdirSync(join(repositoryRoot, '.handraise', 'fronts')).sort();
  const plannedRunIdBeforeAdHoc = runLaunch?.runId;
  await browser.evaluate(`document.querySelector('.delivery-workspace-tabs > a:nth-child(2)').click(); true`);
  const adHocEmptyDom = await browser.waitFor(/No unplanned work recorded/);
  assert.match(adHocEmptyDom, /Explicitly unplanned work/);
  assert.match(adHocEmptyDom, /zero progress/i);
  assert.equal(new URL(await browser.evaluate(`window.location.href`)).pathname, `/repositories/${registered.id}/ad-hoc`);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Review the first ad-hoc run').click(); true`);
  await browser.waitFor(/Review ad-hoc work/);
  await browser.evaluate(`(() => {
    const purpose = document.querySelector('.ad-hoc-purpose textarea');
    purpose.value = 'Investigate the browser fixture interruption without changing accepted delivery planning.';
    purpose.dispatchEvent(new Event('input', { bubbles: true }));
    const component = document.querySelector('.ad-hoc-preflight-controls label:first-child select');
    component.value = 'runtime';
    component.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(adHocWorkspaceCreates, 0, 'editing ad-hoc intent must remain read-only');
  assert.equal(adHocLaunch, null, 'editing ad-hoc intent must not launch an agent');
  await browser.evaluate(`[...document.querySelectorAll('.ad-hoc-start-dialog button')].find((button) => button.textContent.trim() === 'Review ad-hoc readiness').click(); true`);
  const adHocReviewDom = await browser.waitFor(/Ready for explicit unplanned start/);
  assert.match(adHocReviewDom, /Zero accepted delivery progress/);
  assert.match(adHocReviewDom, /No requirement, front or release provenance exists/);
  assert.match(adHocReviewDom, /Inspect exact ad-hoc agent context/);
  assert.equal(adHocWorkspaceCreates, 0, 'ad-hoc preflight must not allocate a worktree');
  assert.equal(adHocLaunch, null, 'ad-hoc preflight must not allocate an agent process');
  assert.equal(readFileSync(releasePath, 'utf8'), releaseBeforeAdHoc);
  assert.equal(readFileSync(runFrontPath, 'utf8'), acceptedFrontBeforeAdHoc);
  await browser.evaluate(`document.querySelector('.ad-hoc-start-dialog .run-confirm input').click(); true`);
  assert.equal(await browser.evaluate(`document.querySelector('.ad-hoc-start-dialog .run-review-actions .primary').disabled`), false);
  await browser.evaluate(`document.querySelector('.ad-hoc-start-dialog .run-review-actions .primary').click(); true`);
  const adHocRunDom = await browser.waitFor(/0 requirement · 0 front · 0 release progress/);
  for (let attempt = 0; attempt < 50 && !adHocLaunch; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(adHocWorkspaceCreates, 1);
  assert.equal(adHocLaunches, 1);
  assert.equal(adHocLaunch?.role, 'ad-hoc');
  assert.equal(adHocLaunch?.front, null);
  assert.ok(adHocLaunch?.runId);
  assert.equal(runLaunch?.runId, plannedRunIdBeforeAdHoc, 'ad-hoc launch must not replace planned-run identity');
  assert.equal(runWorkspaceCreates, processStartsBeforeRelease.runWorkspaceCreates, 'ad-hoc allocation is accounted separately from planned runs');
  assert.match(adHocRunDom, /awaiting outcome/i);
  assert.equal(readFileSync(releasePath, 'utf8'), releaseBeforeAdHoc, 'ad-hoc start must not advance the active release');
  assert.equal(readFileSync(runFrontPath, 'utf8'), acceptedFrontBeforeAdHoc, 'ad-hoc start must not mutate the accepted front');

  const adHocRunIdBeforeRestart = adHocLaunch.runId;
  await browser.evaluate(`window.confirm = () => true; [...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Restart agent').click(); true`);
  for (let attempt = 0; attempt < 50 && adHocLaunches < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(adHocLaunches, 2, 'the client can restart the same durable ad-hoc run');
  assert.equal(adHocLaunch.runId, adHocRunIdBeforeRestart);
  assert.equal(adHocWorkspaceCreates, 1, 'restart must reuse the original isolated workspace');
  assert.equal(readFileSync(releasePath, 'utf8'), releaseBeforeAdHoc);
  for (let attempt = 0; attempt < 50 && await browser.evaluate(`Boolean([...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Add discovery')?.disabled)`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await browser.evaluate(`Boolean([...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Add discovery')?.disabled)`), false, 'restart refresh must finish before evidence actions are available');

  await browser.evaluate(`window.prompt = (message) => message.includes('discover') ? 'The fixture exposes a bounded interruption.' : 'test/browser-smoke.test.mjs'; [...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Add discovery').click(); true`);
  await browser.waitFor(/The fixture exposes a bounded interruption/);
  await browser.evaluate(`window.prompt = (message) => message.startsWith('Check') ? 'Ad-hoc boundary remained separate' : message.startsWith('Result') ? 'passed' : 'Release and front bytes stayed identical'; [...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Record check').click(); true`);
  await browser.waitFor(/Ad-hoc boundary remained separate/);
  await browser.evaluate(`window.prompt = (message) => message.startsWith('Durable') ? 'Interruption investigated; preserve the isolated evidence.' : message.startsWith('Next') ? 'Record outcome' : ''; [...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Save handoff').click(); true`);
  await browser.waitFor(/Interruption investigated; preserve the isolated evidence/);
  await browser.evaluate(`window.prompt = () => 'The interruption was reproduced and bounded without accepted-plan mutation.'; [...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Record outcome').click(); true`);
  const adHocOutcomeDom = await browser.waitFor(/Recorded outcome/);
  assert.match(adHocOutcomeDom, /accepted: no · delivery progress: no/);
  await browser.evaluate(`window.prompt = (message) => message.startsWith('Promotion target') ? 'new-front' : 'Review a planned front for hardening this interruption path.'; [...document.querySelectorAll('.ad-hoc-card button')].find((button) => button.textContent.trim() === 'Propose planned follow-up').click(); true`);
  const adHocProposalDom = await browser.waitFor(/Planning proposals · review only/);
  assert.match(adHocProposalDom, /Review a planned front for hardening this interruption path/);
  assert.match(adHocProposalDom, /0 progress/);
  assert.equal(readFileSync(releasePath, 'utf8'), releaseBeforeAdHoc, 'ad-hoc outcome and promotion proposal must not advance release state');
  assert.equal(readFileSync(runFrontPath, 'utf8'), acceptedFrontBeforeAdHoc, 'ad-hoc outcome and promotion proposal must not rewrite front history');
  assert.deepEqual(readdirSync(join(repositoryRoot, '.handraise', 'fronts')).sort(), frontNamesBeforeAdHoc, 'promotion remains a proposal and cannot create a front');
  assert.equal(existsSync(join(stateRoot, 'ad-hoc-runs')), true, 'ad-hoc evidence is durable in private state');

  await browser.evaluate(`document.querySelector('.delivery-workspace-tabs > a:nth-child(3)').click(); true`);
  await browser.waitFor(/Agent sessions/);
  assert.equal(new URL(await browser.evaluate(`window.location.href`)).pathname, `/repositories/${registered.id}/sessions`);
  assert.match(await browser.waitFor(/Start ad-hoc work/), /Legacy direct session/);
  await browser.evaluate(`document.querySelector('.delivery-workspace-tabs > a:nth-child(2)').click(); true`);
  await browser.waitFor(/The interruption was reproduced and bounded/);
  assert.equal(new URL(await browser.evaluate(`window.location.href`)).pathname, `/repositories/${registered.id}/ad-hoc`);
  await browser.setViewport(390, 844, { mobile: true });
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'ad-hoc evidence must not overflow a mobile PWA viewport');
  await browser.setViewport(1280, 900);
  await browser.evaluate(`document.querySelector('.delivery-workspace-tabs > a:first-child').click(); true`);
  await browser.waitFor(/Release 0 — Browser dogfood/);
  assert.equal(new URL(await browser.evaluate(`window.location.href`)).pathname, `/repositories/${registered.id}/releases`);
  await browser.setViewport(390, 844, { mobile: true });
  assert.equal(await browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'release authority must not overflow a mobile PWA viewport');
  await browser.setViewport(1280, 900);

  await browser.navigate(`http://handraise.test:${port}/repositories/${registered.id}/map`, /Architecture reconciliation/);
  const reconciliationTriggerDom = await browser.waitFor(/refresh recommendation/);
  assert.match(reconciliationTriggerDom, /Run .* was accepted|Refresh repository analysis explicitly/);
  assert.match(reconciliationTriggerDom, /Accepted contracts/);
  await browser.evaluate(`(() => { const section = document.querySelector('.understand-secondary.reconciliation'); if (!section.open) section.querySelector(':scope > summary').click(); return true; })()`);
  await browser.evaluate(`(() => { const section = document.querySelector('.understand-secondary.learning'); if (!section.open) section.querySelector(':scope > summary').click(); return true; })()`);
  const learningDom = await browser.waitFor(/Outcome learning proposals/);
  assert.match(learningDom, /Local ranking is not product truth/);
  assert.match(await browser.waitFor(/Accepted run 'reviewed-run' produced reusable verification evidence/), /zero auto mutation/);
  await browser.evaluate(`[...document.querySelectorAll('.learning-proposal.open button')].find((button) => button.textContent.trim() === 'Useful').click(); true`);
  assert.match(await browser.waitFor(/Private feedback was recorded/), /does not establish product truth/);
  await browser.evaluate(`document.querySelector('.learning-feedback-ledger summary').click(); true`);
  const remoteLearningLedger = await browser.waitFor(/never exported/);
  assert.match(remoteLearningLedger, /Open Handraise directly on the server host over loopback/);
  const acceptedBeforeLearningRoute = readFileSync(componentPath, 'utf8');
  await browser.evaluate(`[...document.querySelectorAll('.learning-proposal.open button')].find((button) => button.textContent.trim() === 'Create review draft').click(); true`);
  const routedLearningDraftDom = await browser.waitFor(/Private draft · nothing published/);
  assert.match(routedLearningDraftDom, /Current accepted architecture/);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedBeforeLearningRoute, 'routing a learning proposal through the browser must not mutate the accepted component');
  await browser.evaluate(`document.querySelector('button[aria-label="Close component architecture"]').click(); true`);

  await browser.navigate(`http://handraise.test:${port}/repositories/${registered.id}/components`, /Product brief/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Product brief').click(); true`);
  await browser.waitFor(/Protect this purpose/);
  await browser.evaluate(`(() => {
    const set = (selector, value) => { const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
    set('.product-purpose textarea', 'Help teams understand repositories and design verifiable work before agents run.');
    set('.product-list-grid label:nth-child(1) textarea', 'Technical leads coordinating coding agents.');
    set('.product-list-grid label:nth-child(2) textarea', 'An accepted product and repository work model exists.');
    return true;
  })()`);
  await browser.evaluate(`[...document.querySelectorAll('.product-brief-footer button')].find((button) => button.textContent.trim() === 'Save draft').click(); true`);
  for (let attempt = 0; attempt < 50 && await browser.evaluate(`Boolean(document.querySelector('.product-brief-dialog'))`); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(existsSync(productPath), false, 'saving a private product draft must not mutate the repository');
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Product brief').click(); true`);
  await browser.waitFor(/Protect this purpose/);
  assert.equal(await browser.evaluate(`document.querySelector('.product-purpose textarea').value`), 'Help teams understand repositories and design verifiable work before agents run.');
  await browser.evaluate(`[...document.querySelectorAll('.product-brief-footer button')].find((button) => button.textContent.trim() === 'Review Markdown').click(); true`);
  const previewDom = await browser.waitFor(/Exact Markdown publication preview/);
  assert.match(previewDom, /Proposed product\.md/);
  assert.equal(existsSync(productPath), false, 'reviewing the exact Markdown must remain read-only');
  await browser.evaluate(`window.confirm = () => true; [...document.querySelectorAll('.product-brief-footer button')].find((button) => button.textContent.trim() === 'Accept product brief').click(); true`);
  for (let attempt = 0; attempt < 50 && !existsSync(productPath); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(productPath), true, 'explicit product acceptance publishes product.md');
  assert.match(readFileSync(productPath, 'utf8'), /Help teams understand repositories and design verifiable work before agents run\./);

  const acceptedComponentBytes = readFileSync(componentPath, 'utf8');
  const acceptedFrontBytes = readFileSync(frontPath, 'utf8');
  await browser.navigate(
    `http://127.0.0.1:${port}/repositories/${registered.id}/map`,
    /Outcome learning proposals/,
  );
  const localLearningDom = await browser.waitFor(/Optional anonymized benchmark contribution/);
  assert.match(localLearningDom, /Optional anonymized benchmark contribution/);
  await browser.evaluate(`document.querySelector('.learning-feedback-ledger summary').click(); true`);
  await browser.waitFor(/never exported/);
  await browser.evaluate(`document.querySelector('.learning-feedback-list input[type="checkbox"]').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('.learning-export > button')].find((button) => button.textContent.includes('Preview 1 selected record')).click(); true`);
  const learningExportDom = await browser.waitFor(/Sanitized exact payload/);
  assert.match(learningExportDom, /actorIdentity/); assert.match(learningExportDom, /freeTextRationale/);
  assert.match(learningExportDom, /No automatic upload exists/);
  await browser.evaluate(`document.querySelector('.learning-export-preview > label input').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('.learning-export-preview button')].find((button) => button.textContent.includes('Confirm exact payload')).click(); true`);
  assert.match(await browser.waitFor(/downloaded locally/), /no external network request/i);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'feedback export must not mutate accepted contracts');
  const localPlanningEntry = await browser.navigate(
    `http://127.0.0.1:${port}/repositories/${registered.id}/components`,
    /Design with model/,
  );
  assert.match(localPlanningEntry, /Design with model/);
  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Design with model').click(); true`);
  const planningConfigurationDom = await browser.waitFor(/Preview exact model context/);
  assert.match(planningConfigurationDom, /Fixture provider/);
  assert.match(planningConfigurationDom, /CLI-owned auth/);
  assert.match(planningConfigurationDom, /handraise-inventory · complete/);
  await browser.evaluate(`[...document.querySelectorAll('.planning-dialog button')].find((button) => button.textContent.trim() === 'Preview exact model context').click(); true`);
  const planningPreflightDom = await browser.waitFor(/Exact data boundary/);
  assert.match(planningPreflightDom, /Bounded repository graph overview/);
  assert.match(planningPreflightDom, /Evidence referenced by selected graph material/);
  assert.match(planningPreflightDom, /Accepted product direction/);
  assert.match(planningPreflightDom, /Current accepted components and fronts/);
  assert.match(planningPreflightDom, /No repository write or agent run is authorized/);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'planning preflight must not mutate accepted work contracts');
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.planning-dialog button')].find((button) => button.textContent.trim() === 'Run reviewed planning').disabled`), true);
  await browser.evaluate(`document.querySelector('.planning-consent input').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('.planning-dialog button')].find((button) => button.textContent.trim() === 'Run reviewed planning').click(); true`);
  const planningResultDom = await browser.waitFor(/Validated private proposal/);
  assert.match(planningResultDom, /Keep runtime control separate from repository planning/);
  assert.match(planningResultDom, /Nothing was published/);
  assert.match(planningResultDom, /human:question/);
  assert.match(planningResultDom, /Not reported by adapter/);
  assert.match(planningResultDom, /private result is complete; it is still not accepted product or repository truth/i);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'validated model output remains a private proposal');
  await browser.evaluate(`document.querySelector('.planning-dialog > footer button:last-child').click(); true`);

  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Design architecture').click(); true`);
  const architectureStartDom = await browser.waitFor(/Fixture provider/);
  assert.match(architectureStartDom, /Analysis snapshot · required/);
  assert.match(architectureStartDom, /Fixture provider/);
  assert.match(architectureStartDom, /Deterministic\/manual only/);
  assert.match(architectureStartDom, /no component or front Markdown is written here/i);
  await browser.evaluate(`[...document.querySelectorAll('.architecture-dialog button')].find((button) => button.textContent.trim() === 'Generate private alternatives').click(); true`);
  const architectureDom = await browser.waitFor(/Private draft · nothing published/);
  assert.match(architectureDom, /Responsibility and dependency architecture/);
  assert.match(architectureDom, /Current accepted architecture/);
  assert.match(architectureDom, /Model-synthesized architecture/);
  assert.match(architectureDom, /Gate C/);
  assert.match(architectureDom, /Boundary questions/);
  assert.match(architectureDom, /Compare alternatives/);
  assert.match(architectureDom, /Add manual/);
  assert.match(architectureDom, /Merge selected/);
  assert.match(architectureDom, /Split/);
  assert.match(architectureDom, /Why this field/);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'architecture synthesis must not mutate accepted work contracts');
  assert.ok(await browser.evaluate(`document.querySelectorAll('.architecture-alternatives > button').length >= 3`));

  await browser.evaluate(`[...document.querySelectorAll('.architecture-dialog button')].find((button) => button.textContent.trim() === 'Compare alternatives').click(); true`);
  const architectureComparisonDom = await browser.waitFor(/Materially different|Equivalent assignment/);
  assert.match(architectureComparisonDom, /entities moved/);
  await browser.evaluate(`window.prompt = (_message, initial) => initial || 'Runtime ownership should dominate this repository.'; [...document.querySelectorAll('.architecture-questions button')].find((button) => button.textContent.trim() === 'Answer').click(); true`);
  assert.match(await browser.waitFor(/Runtime ownership should dominate this repository/), /answered/);
  await browser.evaluate(`document.querySelector('.architecture-contract-field header button').click(); true`);
  assert.match(await browser.waitFor(/Locked/), /Locked/);
  await browser.evaluate(`[...document.querySelectorAll('.architecture-workspace-actions button')].find((button) => button.textContent.trim() === 'Regenerate safely').click(); true`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const regeneratedArchitectureDom = await browser.waitFor(/Regenerate safely/);
  assert.match(regeneratedArchitectureDom, /Runtime ownership should dominate this repository/);
  assert.match(regeneratedArchitectureDom, /Locked/);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'architecture regeneration with answers and locks stays private');

  await browser.evaluate(`[...document.querySelectorAll('.architecture-component-list button')].find((button) => button.textContent.trim() === 'Add manual').click(); true`);
  const manualEditorDom = await browser.waitFor(/Complete component v2/);
  for (const field of ['Purpose', 'Outcomes', 'Responsibilities', 'Limits', 'Invariants', 'Interfaces', 'Dependencies', 'Data and external systems', 'Territory', 'Verification', 'Evidence', 'Uncertainty and open questions', 'Agent guidance']) {
    assert.match(manualEditorDom, new RegExp(field));
  }
  await browser.evaluate(`[...document.querySelectorAll('.architecture-editor button')].find((button) => button.textContent.trim() === 'Cancel').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('.architecture-workspace-actions button')].find((button) => button.textContent.trim() === 'Skip for now').click(); true`);
  await browser.waitFor(/Resume review/);
  await browser.evaluate(`[...document.querySelectorAll('.architecture-workspace-actions button')].find((button) => button.textContent.trim() === 'Resume review').click(); true`);
  await browser.waitFor(/Skip for now/);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'architecture review operations stay private until later publication');
  await browser.evaluate(`[...document.querySelectorAll('.architecture-workspace-actions button')].find((button) => button.textContent.trim() === 'Plan fronts from this architecture').click(); true`);
  const frontPlanStartDom = await browser.waitFor(/Planning goal/);
  assert.match(frontPlanStartDom, /Private component architecture · required/);
  assert.match(frontPlanStartDom, /Manual partial goal/);
  assert.match(frontPlanStartDom, /no Markdown, worktree or agent is created/i);
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-goal-source button')].find((button) => button.textContent.trim() === 'Manual partial goal').click(); true`);
  await browser.waitFor(/Goal title/);
  await browser.evaluate(`(() => {
    const set = (selector, value) => { const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
    set('.front-plan-goal-source input', 'Ship safe repository planning');
    const areas = document.querySelectorAll('.front-plan-goal-source textarea');
    areas[0].value = 'A technical lead reviews an evidence-backed portfolio before agents run.';
    areas[0].dispatchEvent(new Event('input', { bubbles: true }));
    areas[1].value = 'The reviewed plan exposes readiness, critical path and ownership collisions.';
    areas[1].dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await browser.waitFor(/Generate private front alternatives/);
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-dialog button')].find((button) => button.textContent.trim() === 'Generate private front alternatives').click(); true`);
  const frontPlanDom = await browser.waitFor(/Private plan · no execution allocation/);
  assert.match(frontPlanDom, /Parallel outcome slices/);
  assert.match(frontPlanDom, /Risk-first vertical proof/);
  assert.match(frontPlanDom, /Dependency and parallelism view/);
  assert.match(frontPlanDom, /Ready set/);
  assert.match(frontPlanDom, /Critical path/);
  assert.match(frontPlanDom, /Gate D|Review/);
  assert.match(frontPlanDom, /Compare portfolios/);
  assert.match(frontPlanDom, /Add manual/);
  assert.match(frontPlanDom, /Evidence, intent and uncertainty/);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'front synthesis must not mutate accepted components');
  assert.equal(readFileSync(frontPath, 'utf8'), acceptedFrontBytes, 'front synthesis must not mutate accepted fronts');
  assert.ok(await browser.evaluate(`document.querySelectorAll('.front-plan-alternatives > button').length >= 2`));
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-dialog button')].find((button) => button.textContent.trim() === 'Compare portfolios').click(); true`);
  assert.match(await browser.waitFor(/Materially different plan|Equivalent plan/), /added|changed/);
  await browser.evaluate(`window.prompt = (_message, initial) => initial || 'Prioritize one risk-first end-to-end proof.'; [...document.querySelectorAll('.front-plan-dialog .architecture-questions button')].find((button) => button.textContent.trim() === 'Answer').click(); true`);
  await browser.waitFor(/Prioritize one risk-first end-to-end proof/);
  await browser.evaluate(`document.querySelector('.front-plan-contract-field header button').click(); true`);
  await browser.waitFor(/Locked/);
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-actions button')].find((button) => button.textContent.trim() === 'Regenerate safely').click(); true`);
  const regeneratedFrontPlanDom = await browser.waitFor(/Regeneration result/);
  assert.match(regeneratedFrontPlanDom, /Prioritize one risk-first end-to-end proof/);
  assert.match(regeneratedFrontPlanDom, /Locked/);
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-list button')].find((button) => button.textContent.trim() === 'Add manual').click(); true`);
  const frontEditorDom = await browser.waitFor(/Complete front v2 contract/);
  for (const field of ['Observable outcome', 'Motivation', 'Scope', 'Confirmed context', 'Handoff', 'Affected components', 'Goal IDs', 'Non-goals', 'Readiness', 'Acceptance criteria', 'Feasible verification', 'Deliverables', 'Risks', 'Unknowns', 'Dependencies', 'Evidence', 'Ordered checklist']) assert.match(frontEditorDom, new RegExp(field));
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-editor button')].find((button) => button.textContent.trim() === 'Cancel').click(); true`);
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-actions button')].find((button) => button.textContent.trim() === 'Skip for now').click(); true`);
  await browser.waitFor(/Resume review/);
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-actions button')].find((button) => button.textContent.trim() === 'Resume review').click(); true`);
  await browser.waitFor(/Skip for now/);
  assert.equal(readFileSync(frontPath, 'utf8'), acceptedFrontBytes, 'front review, answers, locks and regeneration stay private');
  await browser.evaluate(`[...document.querySelectorAll('.front-plan-actions button')].find((button) => button.textContent.trim() === 'Review complete publication').click(); true`);
  const publicationSetupDom = await browser.waitFor(/Human acceptance boundary/);
  assert.match(publicationSetupDom, /Select exactly what can cross the boundary/);
  assert.match(publicationSetupDom, /Explicit deletion options · off by default/);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'opening publication review remains read-only');
  await browser.evaluate(`[...document.querySelectorAll('.publication-mode button')].find((button) => button.textContent.includes('Components only')).click(); true`);
  await browser.waitFor(/Product and fronts stay unchanged/);
  for (let attempt = 0; attempt < 50 && await browser.evaluate(`document.querySelector('.publication-prepare button')?.disabled !== false`); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  await browser.evaluate(`document.querySelector('.publication-prepare button').click(); true`);
  const publicationReviewDom = await browser.waitFor(/Every destination in this transaction/);
  assert.match(publicationReviewDom, /Exact textual diff/);
  assert.match(publicationReviewDom, /Ownership, dependencies and goals/);
  assert.match(publicationReviewDom, /\.handraise\/publications\//);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedComponentBytes, 'rendering the whole publication diff remains read-only');
  assert.equal(readFileSync(frontPath, 'utf8'), acceptedFrontBytes, 'components-only preview preserves accepted fronts');
  const acceptedProductBytes = readFileSync(productPath, 'utf8');
  await browser.evaluate(`document.querySelector('.publication-confirm input').click(); true`);
  for (let attempt = 0; attempt < 50 && await browser.evaluate(`document.querySelector('.publication-confirm button').disabled`); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await browser.evaluate(`document.querySelector('.publication-confirm button').disabled`), false);
  await browser.evaluate(`document.querySelector('.publication-confirm button').click(); true`);
  const committedPublicationDom = await browser.waitFor(/Accepted publication is durable/);
  assert.match(committedPublicationDom, /Publication committed once/);
  assert.match(committedPublicationDom, /No worktree or agent was created/);
  assert.equal(readFileSync(frontPath, 'utf8'), acceptedFrontBytes, 'components-only commit preserves accepted fronts byte-for-byte');
  assert.equal(readFileSync(productPath, 'utf8'), acceptedProductBytes, 'components-only commit preserves accepted product byte-for-byte');
  const publicationAudits = readdirSync(join(repositoryRoot, '.handraise', 'publications')).filter((name) => name.endsWith('.json'));
  assert.equal(publicationAudits.length, 1);
  const publicationAudit = JSON.parse(readFileSync(join(repositoryRoot, '.handraise', 'publications', publicationAudits[0]), 'utf8'));
  assert.equal(publicationAudit.selection.mode, 'components-only');
  assert.equal(publicationAudit.actor.authority, 'implicit-local');
  await browser.evaluate(`document.querySelector('.publication-review-actions button:last-child').click(); true`);

  await browser.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Design with model').click(); true`);
  await browser.waitFor(/Recent private planning jobs/);
  await browser.evaluate(`document.querySelector('.planning-history button').click(); true`);
  await browser.waitFor(/Validated private proposal/);
  await browser.evaluate(`window.confirm = () => true; [...document.querySelectorAll('.planning-dialog button')].find((button) => button.textContent.trim() === 'Delete private data').click(); true`);
  await browser.waitFor(/Preview exact model context/);
  await browser.evaluate(`document.querySelector('.planning-dialog > footer button:last-child').click(); true`);

  const componentDom = await browser.navigate(
    `http://handraise.test:${port}/repositories/${registered.id}/components/runtime`,
    /Delete Safe cleanup/,
  );
  assert.match(componentDom, /Delete Safe cleanup/);
  await browser.evaluate(`window.confirm = () => false; [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Delete Safe cleanup').click(); true`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(existsSync(frontPath), true, 'cancelled destructive UI actions must not reach the repository');
  await browser.evaluate(`window.confirm = () => true; [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Delete Safe cleanup').click(); true`);
  for (let attempt = 0; attempt < 50 && existsSync(frontPath); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(existsSync(frontPath), false, 'confirmed destructive UI actions may cross the mutation boundary');

  await browser.navigate(`http://127.0.0.1:${port}/settings`, /Server host stays signed in/);
  await browser.evaluate('navigator.serviceWorker.ready.then(() => true)');
  await browser.navigate(`http://127.0.0.1:${port}/settings`, /Server host stays signed in/);
  await closeServer();
  const offlineDom = await browser.navigate(`http://127.0.0.1:${port}/settings`, /Handraise is offline/);
  assert.match(offlineDom, /The cached interface is read-only/);
  assert.doesNotMatch(offlineDom, /Pair this client/);
});
