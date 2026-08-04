import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { initializeNativeRepository } from '../src/repositories.mjs';
import { createHandraise } from '../src/server.mjs';
import { createFrontMarkdown, updateFrontMarkdown, workContractRevision } from '../src/work-contracts.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function requestJson(base, pathname, { method = 'GET', host, origin, cookie, payload } = {}) {
  const target = new URL(pathname, base);
  const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        ...(host ? { host } : {}),
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
        ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}),
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    request.on('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

function component() {
  return {
    slug: 'runtime', title: 'Runtime', order: 1,
    purpose: 'Own safe execution.', outcomes: ['Reviewed work ships.'], responsibilities: ['Run accepted fronts.'],
    limits: ['No implicit releases.'], invariants: ['Exact revisions are immutable.'], interfaces: [], dependencies: [],
    dataSystems: ['Repository-local Markdown'], territory: ['src/**'], verification: ['Run release API tests.'],
    evidence: [{ kind: 'declared', reference: 'intent:release-api', reason: 'Accepted fixture intent.' }],
    uncertainties: [], guidance: 'Require explicit release transitions.',
  };
}

function frontMarkdown(state = 'queued') {
  return createFrontMarkdown({
    slug: 'ship-core', title: 'Ship core', state, component: 'runtime', affectedComponents: [], goalIds: ['goal:ship'], analysisSnapshot: null,
    outcome: 'The core release journey is operable.', motivation: 'Dogfood needs one trustworthy delivery boundary.',
    scope: 'Create and verify one release.', nonGoals: ['No automatic deployment.'], readiness: ['The release contract is reviewed.'],
    acceptanceCriteria: ['The exact candidate can be released.'], verification: ['Release API test passes.'],
    deliverables: ['One release contract.'], risks: ['Evidence can become stale.'], dependencies: [],
    evidence: [{ kind: 'declared', reference: 'intent:release', reason: 'Accepted release intent.' }],
    context: 'This accepted front exercises the release lifecycle against exact revisions.',
    handoff: 'Use the reviewed release contract and never infer candidate evidence.',
    tasks: [{ state: state === 'done' ? 'done' : 'open', text: 'Verify the complete release lifecycle.' }],
    impact: 'alto', complexity: 'media',
  });
}

function releasePayload(frontRevision, overrides = {}) {
  return {
    slug: 'release-0', title: 'Release 0 — Dogfood core', version: '0.1.0', state: 'draft', targetBranch: 'main',
    outcome: 'Handraise can ship one bounded, verified candidate.',
    requirementIds: ['R0-RLS-01'], fronts: [{ slug: 'ship-core', revision: frontRevision }],
    acceptanceCriteria: ['The candidate journey passes from the packaged artifact.'],
    verification: ['R0-T11'], compatibility: ['Node >=20'], limitations: ['No automatic deployment.'],
    ...overrides,
  };
}

function requirementEvidence(status) {
  return {
    'R0-RLS-01': {
      accepted: true,
      tests: [{ id: 'R0-T11', status, sourceRevision: digest('release-api-source') }],
    },
  };
}

test('[R0-RPL-05][R0-T11] authenticated release API persists exact contracts and enforces reviewed gates', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-release-api-'));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'state');
  const repositoryPath = join(home, 'repository');
  const webRoot = join(home, 'web');
  mkdirSync(repositoryPath); mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  initializeNativeRepository({ id: 'release-api', name: 'Release API', path: repositoryPath }, { components: [component()] });
  const frontPath = join(repositoryPath, '.handraise', 'fronts', 'ship-core.md');
  const initialFront = frontMarkdown();
  writeFileSync(frontPath, initialFront);

  const config = new ConfigStore({ root, home, resolveRepository: () => repositoryPath });
  const repository = config.addRepository(repositoryPath, { id: 'release-api', name: 'Release API' });
  const server = createHandraise({ root, webRoot, config, auth: new PairingAuth({ root }) });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    server.close();
    if (error?.code === 'EPERM') { context.skip('the execution sandbox does not permit a local listening socket'); return; }
    throw error;
  }
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `/api/repositories/${repository.id}/releases`;
  const releaseDirectory = join(repositoryPath, '.handraise', 'releases');
  const currentFrontRevision = workContractRevision(initialFront);

  const unauthorized = await requestJson(base, endpoint, {
    method: 'POST', host: 'remote.test', origin: 'http://remote.test', payload: releasePayload(currentFrontRevision),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(existsSync(releaseDirectory), false, 'unauthorized requests must not create release metadata');

  const stale = await requestJson(base, endpoint, { method: 'POST', payload: releasePayload('f'.repeat(64)) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'FRONT_REVISION_STALE');
  assert.equal(existsSync(releaseDirectory), false, 'stale release review must not leave repository metadata behind');
  assert.deepEqual(existsSync(join(releaseDirectory, 'release-0.md')), false);

  const createdResponse = await requestJson(base, endpoint, { method: 'POST', payload: releasePayload(currentFrontRevision) });
  assert.equal(createdResponse.status, 201, JSON.stringify(createdResponse.body));
  let current = createdResponse.body.release;
  assert.equal(current.fronts[0].revision, currentFrontRevision);
  assert.equal(readFileSync(join(releaseDirectory, 'release-0.md'), 'utf8').includes('## Selected requirements'), true);

  const listed = await requestJson(base, endpoint);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.releases[0].slug, 'release-0');
  const portfolio = await requestJson(base, '/api/repositories');
  assert.equal(portfolio.body.repositories[0].releases[0].revision, current.revision);

  const staleUpdate = await requestJson(base, `${endpoint}/release-0`, {
    method: 'PATCH', payload: { expectedRevision: 'e'.repeat(64), title: 'Stale title' },
  });
  assert.equal(staleUpdate.status, 409);
  assert.equal(staleUpdate.body.code, 'RELEASE_BASELINE_CHANGED');

  const updated = await requestJson(base, `${endpoint}/release-0`, {
    method: 'PATCH', payload: { expectedRevision: current.revision, title: 'Release 0 candidate' },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  current = updated.body.release;

  const ready = await requestJson(base, `${endpoint}/release-0/transition`, {
    method: 'POST', payload: { expectedRevision: current.revision, targetState: 'ready', requirementEvidence: requirementEvidence('defined') },
  });
  assert.equal(ready.status, 200, JSON.stringify(ready.body)); current = ready.body.release;
  const active = await requestJson(base, `${endpoint}/release-0/transition`, {
    method: 'POST', payload: { expectedRevision: current.revision, targetState: 'active' },
  });
  assert.equal(active.status, 200, JSON.stringify(active.body)); current = active.body.release;

  const premature = await requestJson(base, `${endpoint}/release-0/transition`, {
    method: 'POST', payload: {
      expectedRevision: current.revision, targetState: 'candidate', confirmed: true,
      requirementEvidence: requirementEvidence('passed'),
      candidateEvidence: {
        sourceRevision: '1'.repeat(40), contractRevision: current.revision, artifactDigest: digest('artifact'),
        artifact: 'handraise-0.1.0.tgz', toolVersions: { node: process.version, handraise: '0.1.0' },
        measurementProfile: 'release-api-fixture', measuredAt: '2026-08-04T12:30:00.000Z',
      },
    },
  });
  assert.equal(premature.status, 409);
  assert.equal(premature.body.code, 'RELEASE_NOT_READY');
  assert.ok(premature.body.details.blockers.some((item) => item.code === 'FRONT_NOT_DONE'));

  const completedFront = updateFrontMarkdown(initialFront, { state: 'done', tasks: [{ state: 'done', text: 'Verify the complete release lifecycle.' }] });
  writeFileSync(frontPath, completedFront);
  const completedFrontRevision = workContractRevision(completedFront);
  const rebound = await requestJson(base, `${endpoint}/release-0`, {
    method: 'PATCH', payload: { expectedRevision: current.revision, fronts: [{ slug: 'ship-core', revision: completedFrontRevision }] },
  });
  assert.equal(rebound.status, 200, JSON.stringify(rebound.body)); current = rebound.body.release;

  const candidateEvidence = {
    sourceRevision: '1'.repeat(40), contractRevision: current.revision, artifactDigest: digest('artifact'),
    artifact: 'handraise-0.1.0.tgz', toolVersions: { node: process.version, handraise: '0.1.0' },
    measurementProfile: 'release-api-fixture', measuredAt: '2026-08-04T12:30:00.000Z',
  };
  const unconfirmed = await requestJson(base, `${endpoint}/release-0/transition`, {
    method: 'POST', payload: {
      expectedRevision: current.revision, targetState: 'candidate', confirmed: false,
      requirementEvidence: requirementEvidence('passed'), candidateEvidence,
    },
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.body.code, 'RELEASE_CONFIRMATION_REQUIRED');

  const candidate = await requestJson(base, `${endpoint}/release-0/transition`, {
    method: 'POST', payload: {
      expectedRevision: current.revision, targetState: 'candidate', confirmed: true,
      requirementEvidence: requirementEvidence('passed'), candidateEvidence,
    },
  });
  assert.equal(candidate.status, 200, JSON.stringify(candidate.body)); current = candidate.body.release;
  assert.equal(current.state, 'candidate');
  assert.equal(current.candidate.contractRevision, candidateEvidence.contractRevision);

  const released = await requestJson(base, `${endpoint}/release-0/transition`, {
    method: 'POST', payload: {
      expectedRevision: current.revision, targetState: 'released', confirmed: true,
      requirementEvidence: requirementEvidence('passed'),
    },
  });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.release.state, 'released');

  const next = await requestJson(base, endpoint, {
    method: 'POST', payload: releasePayload(completedFrontRevision, { slug: 'release-1', title: 'Release 1' }),
  });
  assert.equal(next.status, 201, JSON.stringify(next.body));
});
