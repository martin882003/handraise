import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { initializeNativeRepository } from '../src/repositories.mjs';
import { createHandraise } from '../src/server.mjs';

function requestJson(base, pathname, { method = 'GET', host, origin, payload } = {}) {
  const target = new URL(pathname, base); const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}), ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) },
    }, (response) => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    request.on('error', reject); if (encoded) request.write(encoded); request.end();
  });
}

function component() {
  return {
    slug: 'runtime', title: 'Runtime', order: 1, purpose: 'Own safe execution.', outcomes: ['Unplanned work remains auditable.'],
    responsibilities: ['Control local agents.'], limits: ['No implicit planned progress.'], invariants: ['Ad-hoc work never mutates accepted contracts.'],
    interfaces: [], dependencies: [], dataSystems: ['Private ad-hoc records'], territory: ['src/**'], verification: ['Ad-hoc API tests pass.'],
    evidence: [{ kind: 'declared', reference: 'intent:ad-hoc-api', reason: 'Accepted fixture context.' }], uncertainties: [],
    guidance: 'Keep diagnosis bounded and propose follow-up explicitly.',
  };
}

test('[R0-RUN-07][R0-CUX-05][R0-T12] authenticated ad-hoc API keeps unplanned work safe, durable and outside release progress', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-ad-hoc-api-')); context.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'state'); const repositoryPath = join(home, 'repository'); const webRoot = join(home, 'web'); const bin = join(home, 'bin');
  mkdirSync(repositoryPath); mkdirSync(webRoot); mkdirSync(bin);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  initializeNativeRepository({ id: 'adhoc-api', name: 'Ad-hoc API', path: repositoryPath }, { components: [component()] });
  const componentPath = join(repositoryPath, '.handraise', 'components', 'runtime.md'); const acceptedBefore = readFileSync(componentPath, 'utf8');
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Codex fixture 1.0"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi\nexit 0\n');
  chmodSync(join(bin, 'codex'), 0o700);
  const config = new ConfigStore({ root, home, resolveRepository: () => repositoryPath, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const repository = config.addRepository(repositoryPath, { id: 'adhoc-api', name: 'Ad-hoc API' }); config.updateRepository(repository.id, { defaultAgent: 'codex' });
  let workspaceCreates = 0; let launches = 0; let launchDetails = null;
  const git = (path) => ({
    available: true, path, branch: path === repositoryPath ? 'main' : `handraise/${path.split('/').at(-1)}`, revision: '1'.repeat(40),
    baseline: '1'.repeat(40), baselineRevision: '1'.repeat(40), dirty: path === repositoryPath ? 0 : 1,
    ahead: 0, behind: 0, unbacked: path === repositoryPath ? 0 : 1, branchMismatch: false,
  });
  const server = createHandraise({
    root, webRoot, config, auth: new PairingAuth({ root }),
    inspectRunWorkshop: () => ({ worktrees: [], orphans: [] }), inspectRunGitState: (_repository, path) => git(path),
    createRunWorkspace: (_repository, slug) => { workspaceCreates += 1; return { path: join(repositoryPath, '.handraise', 'worktrees', slug), branch: `handraise/${slug}`, created: true, baseline: '1'.repeat(40) }; },
    removeRunWorkspace: () => ({ removed: true }),
    launchSession: (details) => { launches += 1; launchDetails = details; return { existed: false, slug: details.slug, controlSlug: `${details.repoId}--${details.slug}`, tmux: `handraise-${details.slug}` }; },
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); }); server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    server.close(); if (error?.code === 'EPERM') { context.skip('the execution sandbox does not permit a local listening socket'); return; } throw error;
  }
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`; const endpoint = `/api/repositories/${repository.id}/ad-hoc-runs`;
  const payload = { purpose: 'Investigate a bounded runtime recovery defect without claiming planned progress.', componentSlug: 'runtime', isolate: true, agent: 'codex' };

  const unauthorized = await requestJson(base, `${endpoint}/preflight`, { method: 'POST', host: 'remote.test', origin: 'http://remote.test', payload });
  assert.equal(unauthorized.status, 401); assert.equal(workspaceCreates, 0); assert.equal(launches, 0);
  const invalid = await requestJson(base, `${endpoint}/preflight`, { method: 'POST', payload: { ...payload, purpose: 'short' } });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'ADHOC_PURPOSE_REQUIRED');
  const prepared = await requestJson(base, `${endpoint}/preflight`, { method: 'POST', payload });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body)); const preflight = prepared.body.preflight;
  assert.equal(preflight.kind, 'ad-hoc'); assert.equal(preflight.readiness.ready, true); assert.equal(preflight.work.provenance.deliveryProgress, false);
  assert.equal(workspaceCreates, 0); assert.equal(launches, 0); assert.equal(readFileSync(componentPath, 'utf8'), acceptedBefore);
  const rejected = await requestJson(base, `${endpoint}/preflight/${preflight.id}/start`, { method: 'POST', payload: { expectedRevision: preflight.revision, confirmed: false } });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'ADHOC_CONFIRMATION_REQUIRED'); assert.equal(workspaceCreates, 0);
  const startedResponse = await requestJson(base, `${endpoint}/preflight/${preflight.id}/start`, { method: 'POST', payload: { expectedRevision: preflight.revision, confirmed: true } });
  assert.equal(startedResponse.status, 201, JSON.stringify(startedResponse.body)); let run = startedResponse.body.run;
  assert.equal(workspaceCreates, 1); assert.equal(launches, 1); assert.equal(launchDetails.role, 'ad-hoc'); assert.equal(launchDetails.front, null);
  assert.match(launchDetails.command, /explicitly unplanned ad-hoc run/i); assert.equal(run.manifest.provenance.deliveryProgress, false);

  const rejectedRestart = await requestJson(base, `${endpoint}/${run.id}/restart`, { method: 'POST', payload: {
    expectedRevision: run.revision, confirmed: false,
  } });
  assert.equal(rejectedRestart.status, 400); assert.equal(rejectedRestart.body.code, 'ADHOC_RESTART_CONFIRMATION_REQUIRED'); assert.equal(launches, 1);
  const restarted = await requestJson(base, `${endpoint}/${run.id}/restart`, { method: 'POST', payload: {
    expectedRevision: run.revision, confirmed: true,
  } });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  assert.equal(restarted.body.run.id, run.id); assert.equal(restarted.body.run.manifest.revision, run.manifest.revision);
  assert.equal(workspaceCreates, 1, 'restart must reuse the preserved workspace'); assert.equal(launches, 2); run = restarted.body.run;

  const overlapping = await requestJson(base, `${endpoint}/preflight`, { method: 'POST', payload: { ...payload, purpose: 'Investigate another symptom while the same component already has an ad-hoc owner.' } });
  assert.equal(overlapping.status, 201); assert.equal(overlapping.body.preflight.readiness.ready, false);
  assert.ok(overlapping.body.preflight.readiness.diagnostics.some((item) => item.code === 'ADHOC_ACTIVE_OWNERSHIP_CONFLICT'));

  const discovered = await requestJson(base, `${endpoint}/${run.id}/discoveries`, { method: 'POST', payload: {
    expectedRevision: run.revision, kind: 'discovery', summary: 'Reconnect loses one derived cursor.', evidence: 'Observed in fixture.',
  } });
  assert.equal(discovered.status, 201); run = discovered.body.run;
  const checked = await requestJson(base, `${endpoint}/${run.id}/checks`, { method: 'POST', payload: {
    expectedRevision: run.revision, label: 'Reproduction is deterministic', status: 'passed', source: 'configured-check', evidence: 'Fixture passed.',
  } });
  assert.equal(checked.status, 201); assert.equal(checked.body.run.checks.at(-1).source, 'user-observed', 'a browser cannot claim configured-check authority'); run = checked.body.run;
  const handed = await requestJson(base, `${endpoint}/${run.id}/handoff`, { method: 'POST', payload: {
    expectedRevision: run.revision, summary: 'The diagnosis is bounded.', nextSteps: ['Create a reviewed front.'], blockers: [],
  } });
  assert.equal(handed.status, 200); run = handed.body.run;
  const completed = await requestJson(base, `${endpoint}/${run.id}/complete`, { method: 'POST', payload: {
    expectedRevision: run.revision, status: 'completed', summary: 'Diagnosis recorded without accepted-plan mutation.',
  } });
  assert.equal(completed.status, 200, JSON.stringify(completed.body)); run = completed.body.run;
  assert.equal(run.outcome.accepted, false); assert.equal(run.outcome.deliveryProgress, false); assert.equal(run.outcome.git.unbacked, 1);
  const promoted = await requestJson(base, `${endpoint}/${run.id}/promotions`, { method: 'POST', payload: {
    expectedRevision: run.revision, target: { kind: 'new-front', id: null }, summary: 'Plan cursor recovery as reviewed work.',
  } });
  assert.equal(promoted.status, 201); run = promoted.body.run; assert.equal(run.proposals[0].mutatesAcceptedState, false);
  assert.equal(run.proposals[0].retroactivePlanned, false);

  const listed = await requestJson(base, endpoint); assert.equal(listed.status, 200); assert.equal(listed.body.runs[0].id, run.id);
  const repositories = await requestJson(base, '/api/repositories');
  assert.equal(repositories.body.repositories[0].adHocRuns[0].id, run.id);
  assert.deepEqual(repositories.body.repositories[0].releases, []);
  assert.deepEqual(repositories.body.repositories[0].runs, []);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedBefore);
});

test('[R0-T12] real isolated ad-hoc run survives server restart, remains controllable, restarts in place and stops explicitly', async (context) => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); }
  catch { context.skip('tmux is not installed'); return; }

  const home = mkdtempSync(join(tmpdir(), 'handraise-ad-hoc-real-'));
  const root = join(home, 'state'); const repositoryPath = join(home, 'repository'); const webRoot = join(home, 'web'); const bin = join(home, 'bin');
  mkdirSync(repositoryPath); mkdirSync(webRoot); mkdirSync(bin);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  writeFileSync(join(bin, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Codex fixture 1.0"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi
printf '[ad-hoc fixture] ready\\n'
while IFS= read -r line; do printf '[ad-hoc fixture] %s\\n' "$line"; done
`);
  chmodSync(join(bin, 'codex'), 0o700);
  execFileSync('git', ['init', '-b', 'main', repositoryPath], { stdio: 'ignore' });
  writeFileSync(join(repositoryPath, 'README.md'), 'Real ad-hoc lifecycle fixture.\n');
  initializeNativeRepository({ id: 'adhoc-real', name: 'Ad-hoc real', path: repositoryPath }, { components: [component()] });
  execFileSync('git', ['-C', repositoryPath, 'add', '.']);
  execFileSync('git', ['-C', repositoryPath, '-c', 'user.name=Handraise Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  const componentPath = join(repositoryPath, '.handraise', 'components', 'runtime.md'); const acceptedBefore = readFileSync(componentPath, 'utf8');
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const config = new ConfigStore({ root, home, resolveRepository: () => repositoryPath, env: environment });
  const repository = config.addRepository(repositoryPath, { id: 'adhoc-real', name: 'Ad-hoc real' }); config.updateRepository(repository.id, { defaultAgent: 'codex' });

  const previousPath = process.env.PATH; const previousSocket = process.env.HANDRAISE_TMUX_SOCKET;
  const socket = `handraise-adhoc-${process.pid}-${Date.now()}`;
  process.env.PATH = environment.PATH; process.env.HANDRAISE_TMUX_SOCKET = socket;
  let liveServer = null;
  const close = async () => {
    if (!liveServer) return;
    const target = liveServer; liveServer = null;
    await new Promise((resolve) => { target.close(resolve); target.closeAllConnections?.(); });
  };
  context.after(async () => {
    await close();
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already stopped */ }
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousSocket === undefined) delete process.env.HANDRAISE_TMUX_SOCKET; else process.env.HANDRAISE_TMUX_SOCKET = previousSocket;
    rmSync(home, { recursive: true, force: true });
  });
  const startServer = async () => {
    const server = createHandraise({ root, webRoot, config, auth: new PairingAuth({ root }) });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
        server.once('error', (error) => { clearTimeout(timer); reject(error); }); server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
      });
    } catch (error) { server.close(); throw error; }
    liveServer = server; return `http://127.0.0.1:${server.address().port}`;
  };
  const waitFor = async (operation, predicate, label) => {
    let last = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const value = await operation(); last = value; if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last?.body || last)}`);
  };

  let base;
  try { base = await startServer(); }
  catch (error) { if (error?.code === 'EPERM') { context.skip('the execution sandbox does not permit a local listening socket'); return; } throw error; }
  const endpoint = `/api/repositories/${repository.id}/ad-hoc-runs`;
  const prepared = await requestJson(base, `${endpoint}/preflight`, { method: 'POST', payload: {
    purpose: 'Exercise one real isolated ad-hoc lifecycle across control and server recovery.', componentSlug: 'runtime', isolate: true, agent: 'codex',
  } });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body)); assert.equal(prepared.body.preflight.readiness.ready, true, JSON.stringify(prepared.body));
  const started = await requestJson(base, `${endpoint}/preflight/${prepared.body.preflight.id}/start`, { method: 'POST', payload: {
    expectedRevision: prepared.body.preflight.revision, confirmed: true,
  } });
  assert.equal(started.status, 201, JSON.stringify(started.body)); let run = started.body.run;
  const controlSlug = run.session.controlSlug; const originalManifestRevision = run.manifest.revision;
  const stateWithSession = await waitFor(
    () => requestJson(base, '/api/state'),
    (value) => value.body.sessions.some((item) => item.controlSlug === controlSlug && item.role === 'ad-hoc' && item.runId === run.id),
    'real ad-hoc session identity',
  );
  const live = stateWithSession.body.sessions.find((item) => item.controlSlug === controlSlug);
  assert.equal(live.front, null); assert.equal(live.component, 'runtime');
  await waitFor(() => requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/pane?lines=100`), (value) => /ad-hoc fixture.*ready/i.test(value.body?.html || ''), 'fixture pane');
  assert.equal((await requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/text`, { method: 'POST', payload: { text: 'literal before restart', enter: true } })).status, 200);
  await waitFor(() => requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/pane?lines=100`), (value) => /literal before restart/.test(value.body?.html || ''), 'literal terminal control');
  assert.equal((await requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/pause`, { method: 'POST', payload: { order: 'pause the real ad-hoc fixture' } })).status, 200);
  await waitFor(() => requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/pane?lines=100`), (value) => /pause the real ad-hoc fixture/.test(value.body?.html || ''), 'pause control');
  assert.equal((await requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/resume`, { method: 'POST', payload: { order: 'resume the real ad-hoc fixture' } })).status, 200);
  await waitFor(() => requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/pane?lines=100`), (value) => /resume the real ad-hoc fixture/.test(value.body?.html || ''), 'resume control');

  await close();
  base = await startServer();
  const recovered = await waitFor(
    () => requestJson(base, endpoint),
    (value) => value.body.runs[0]?.process.active === true && value.body.runs[0]?.process.session?.controlSlug === controlSlug,
    'server restart reconciliation',
  );
  run = recovered.body.runs[0];
  assert.equal(run.id, started.body.run.id); assert.equal(run.manifest.revision, originalManifestRevision);
  assert.match((await requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}/pane?lines=100`)).body.html, /literal before restart/);

  assert.equal((await requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}`, { method: 'DELETE' })).status, 200);
  await waitFor(() => requestJson(base, '/api/state'), (value) => !value.body.sessions.some((item) => item.controlSlug === controlSlug), 'explicit ad-hoc stop');
  run = (await requestJson(base, endpoint)).body.runs[0]; assert.equal(run.state, 'awaiting-outcome'); assert.equal(run.process.active, false);
  const restarted = await requestJson(base, `${endpoint}/${run.id}/restart`, { method: 'POST', payload: { expectedRevision: run.revision, confirmed: true } });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body)); run = restarted.body.run;
  assert.equal(run.id, started.body.run.id); assert.equal(run.manifest.revision, originalManifestRevision); assert.equal(run.manifest.workspace.created, true);
  await waitFor(() => requestJson(base, '/api/state'), (value) => value.body.sessions.some((item) => item.controlSlug === controlSlug && item.runId === run.id), 'same-run process restart');
  assert.equal((await requestJson(base, `/api/session/${encodeURIComponent(controlSlug)}`, { method: 'DELETE' })).status, 200);
  await waitFor(() => requestJson(base, '/api/state'), (value) => !value.body.sessions.some((item) => item.controlSlug === controlSlug), 'final explicit stop');
  run = (await requestJson(base, endpoint)).body.runs[0];
  const completed = await requestJson(base, `${endpoint}/${run.id}/complete`, { method: 'POST', payload: {
    expectedRevision: run.revision, status: 'completed', summary: 'Real control, recovery, restart and stop stayed outside planned delivery.',
  } });
  assert.equal(completed.status, 200, JSON.stringify(completed.body)); run = completed.body.run;
  const promoted = await requestJson(base, `${endpoint}/${run.id}/promotions`, { method: 'POST', payload: {
    expectedRevision: run.revision, target: { kind: 'new-front', id: null }, summary: 'Review lifecycle hardening as future planned work.',
  } });
  assert.equal(promoted.status, 201); assert.equal(promoted.body.run.outcome.deliveryProgress, false); assert.equal(promoted.body.run.proposals[0].retroactivePlanned, false);
  const repositories = await requestJson(base, '/api/repositories');
  assert.deepEqual(repositories.body.repositories[0].releases, []); assert.deepEqual(repositories.body.repositories[0].runs, []);
  assert.equal(readFileSync(componentPath, 'utf8'), acceptedBefore);
});
