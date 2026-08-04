import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { normalizeProductBrief, renderProductBrief } from '../src/product-direction.mjs';
import { createHandraise } from '../src/server.mjs';
import { createComponentMarkdown, createFrontMarkdown } from '../src/work-contracts.mjs';

function requestJson(base, pathname, { method = 'GET', host = '127.0.0.1', payload } = {}) {
  const target = new URL(pathname, base); const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers: { host, ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) } }, (response) => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { raw += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    request.on('error', reject); if (encoded) request.write(encoded); request.end();
  });
}

function componentMarkdown() {
  return createComponentMarkdown({
    slug: 'runtime', title: 'Runtime', state: 'active', order: 1,
    contract: {
      purpose: 'Own accepted plan execution.', outcomes: ['Runs are explicit and verifiable.'], responsibilities: ['Compile accepted fronts into runs.'],
      limits: ['No implicit completion.'], invariants: ['Agent claims are not evidence.'], interfaces: [], dependencies: [],
      dataSystems: ['Private run store'], territory: ['src/runtime/'], verification: ['Run API tests.'],
      evidence: [{ kind: 'declared', reference: 'intent:run', reason: 'Accepted intent.' }], uncertainties: ['Runtime can reveal discoveries.'], guidance: 'Report scope changes.',
    },
  });
}

function frontMarkdown() {
  return createFrontMarkdown({
    slug: 'ship-runtime', title: 'Ship runtime', state: 'queued', component: 'runtime', affectedComponents: [], goalIds: ['goal:ship'], analysisSnapshot: null,
    outcome: 'The accepted runtime change is implemented and reviewed.', motivation: 'Execution needs an auditable boundary.', scope: 'Implement the accepted runtime outcome.',
    nonGoals: ['No hidden plan mutation.'], readiness: ['The selected agent is connected.'], acceptanceCriteria: ['The outcome is reviewed.'], verification: ['API tests pass.'],
    deliverables: ['A verified runtime change.'], risks: ['The process can exit before acceptance.'], dependencies: [], evidence: [{ kind: 'declared', reference: 'intent:run', reason: 'Accepted intent.' }],
    context: 'This fixture exercises the authenticated plan-to-run API boundary.', handoff: 'Start from the exact accepted context.', tasks: [{ state: 'open', text: 'Implement and verify the runtime.' }], impact: 'alto', complexity: 'media',
  });
}

test('authenticated run APIs keep preflight read-only, bind explicit start and separate evidence from completion', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-run-api-')); const root = join(home, 'state'); const repositoryPath = join(home, 'repository'); const webRoot = join(home, 'web'); const bin = join(home, 'bin');
  mkdirSync(join(repositoryPath, '.handraise', 'components'), { recursive: true }); mkdirSync(join(repositoryPath, '.handraise', 'fronts'), { recursive: true }); mkdirSync(webRoot); mkdirSync(bin);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  writeFileSync(join(repositoryPath, '.handraise', 'project.json'), '{"version":1,"name":"Run API"}\n');
  writeFileSync(join(repositoryPath, '.handraise', '.gitignore'), 'worktrees/\n.management-lock/\n');
  writeFileSync(join(repositoryPath, '.handraise', 'components', 'runtime.md'), componentMarkdown());
  writeFileSync(join(repositoryPath, '.handraise', 'fronts', 'ship-runtime.md'), frontMarkdown());
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Codex fixture 1.0"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi\nexit 0\n'); chmodSync(join(bin, 'codex'), 0o700);
  const config = new ConfigStore({ root, resolveRepository: () => repositoryPath, home, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const repository = config.addRepository(repositoryPath, { name: 'Run API' });
  config.updateRepository(repository.id, { defaultAgent: 'codex' });
  const brief = normalizeProductBrief({
    title: 'Run API', purpose: { id: 'purpose', text: 'Run accepted work safely.', sourceIds: ['source:human'], locked: true },
    users: [{ id: 'user', text: 'Technical leads.', sourceIds: ['source:human'] }], outcomes: [{ id: 'outcome', text: 'Runs are reviewed.', sourceIds: ['source:human'] }],
    constraints: [{ id: 'constraint', text: 'Start is explicit.', sourceIds: ['source:human'], locked: true }], invariants: [{ id: 'invariant', text: 'Completion needs evidence.', sourceIds: ['source:human'], locked: true }],
    goals: [{ id: 'goal:ship', title: 'Ship safely', outcome: 'The runtime outcome is accepted.', priority: 'now', state: 'active', successSignals: ['Evidence passes.'], sourceIds: ['source:human'] }],
  }, { repositoryId: repository.id, now: Date.parse('2026-08-03T12:00:00Z') });
  writeFileSync(join(repositoryPath, '.handraise', 'product.md'), renderProductBrief(brief, { repositoryId: repository.id, now: Date.parse('2026-08-03T12:00:00Z') }));
  const acceptedBefore = readFileSync(join(repositoryPath, '.handraise', 'fronts', 'ship-runtime.md'), 'utf8');
  let workspaceCreates = 0; let launches = 0; let prompt = '';
  const server = createHandraise({
    root, webRoot, auth: new PairingAuth({ root }), config,
    createRunWorkspace: (_target, slug) => { workspaceCreates += 1; return { path: join(repositoryPath, '.handraise', 'worktrees', slug), branch: `handraise/${slug}`, created: true, baseline: 'main' }; },
    removeRunWorkspace: () => ({ removed: true }),
    inspectRunWorkshop: () => ({ worktrees: [], orphans: [] }),
    inspectRunGitState: (_target, path, slug = '') => ({ available: true, path, branch: slug ? `handraise/${slug}` : 'main', expectedBranch: slug ? `handraise/${slug}` : null, branchMismatch: false, baseline: 'main', dirty: 0, ahead: 0, behind: 0, backupRef: 'origin/main', unbacked: 0 }),
    launchSession: (details) => { launches += 1; prompt = details.command; return { existed: false, slug: details.slug, controlSlug: `${details.repoId}--${details.slug}`, tmux: `handraise-${details.slug}` }; },
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
  const base = `http://127.0.0.1:${server.address().port}`; const endpoint = `/api/repositories/${repository.id}/runs`;
  const unauthorized = await requestJson(base, `${endpoint}/preflight`, { method: 'POST', host: 'remote.test', payload: { frontSlug: 'ship-runtime', agent: 'codex' } });
  assert.equal(unauthorized.status, 401);
  const prepared = await requestJson(base, `${endpoint}/preflight`, { method: 'POST', payload: { frontSlug: 'ship-runtime', agent: 'codex', isolate: true } });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body)); const preflight = prepared.body.preflight;
  assert.equal(preflight.readiness.ready, true); assert.equal(workspaceCreates, 0); assert.equal(launches, 0); assert.equal(readFileSync(join(repositoryPath, '.handraise', 'fronts', 'ship-runtime.md'), 'utf8'), acceptedBefore);
  const rejected = await requestJson(base, `${endpoint}/preflight/${preflight.id}/start`, { method: 'POST', payload: { expectedRevision: preflight.revision, confirmed: false } });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'RUN_CONFIRMATION_REQUIRED'); assert.equal(workspaceCreates, 0);
  const startedResponse = await requestJson(base, `${endpoint}/preflight/${preflight.id}/start`, { method: 'POST', payload: { expectedRevision: preflight.revision, confirmed: true } });
  assert.equal(startedResponse.status, 201, JSON.stringify(startedResponse.body)); const run = startedResponse.body.run;
  assert.equal(workspaceCreates, 1); assert.equal(launches, 1); assert.match(prompt, /exact accepted context|Accepted source digest/i); assert.equal(run.manifest.front.revision, preflight.front.revision);
  const agentClaim = await requestJson(base, `${endpoint}/${run.id}/tasks/0`, { method: 'POST', payload: { source: 'agent-claim', state: 'done', evidence: 'Agent says done.' } });
  assert.equal(agentClaim.status, 200); assert.equal(agentClaim.body.run.taskEvidence.at(-1).applied, false); assert.equal(readFileSync(join(repositoryPath, '.handraise', 'fronts', 'ship-runtime.md'), 'utf8'), acceptedBefore);
  const verified = await requestJson(base, `${endpoint}/${run.id}/tasks/0`, { method: 'POST', payload: { source: 'configured-check', state: 'done', evidence: 'Human reviewed the change.' } }); assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.run.taskEvidence.at(-1).source, 'user', 'a browser client cannot self-assert configured-check authority');
  await requestJson(base, `${endpoint}/${run.id}/checks`, { method: 'POST', payload: { kind: 'criterion', index: 0, label: 'The outcome is reviewed.', status: 'passed', source: 'user-observed', evidence: 'Accepted in review.' } });
  const verification = await requestJson(base, `${endpoint}/${run.id}/checks`, { method: 'POST', payload: { kind: 'verification', index: 0, label: 'API tests pass.', status: 'passed', source: 'configured-check', evidence: 'Fixture check passed.' } });
  assert.equal(verification.body.run.checks.at(-1).source, 'user-observed', 'configured-check evidence is reserved for a trusted internal runner');
  const completed = await requestJson(base, `${endpoint}/${run.id}/complete`, { method: 'POST', payload: {} });
  assert.equal(completed.status, 200, JSON.stringify(completed.body)); assert.equal(completed.body.run.state, 'completed'); assert.equal(completed.body.run.outcome.accepted, true);
  assert.equal(completed.body.reconciliationTrigger?.cause, 'completed-run');
  assert.equal(completed.body.reconciliationTrigger?.state, 'pending');
  assert.equal(completed.body.reconciliationTrigger?.mutatesRepository, false);
  assert.match(readFileSync(join(repositoryPath, '.handraise', 'fronts', 'ship-runtime.md'), 'utf8'), /state: done/);
  const listed = await requestJson(base, endpoint); assert.equal(listed.status, 200); assert.equal(listed.body.runs[0].id, run.id);
});
