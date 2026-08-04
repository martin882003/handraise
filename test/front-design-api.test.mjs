import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { initializeNativeRepository } from '../src/repositories.mjs';
import { createHandraise } from '../src/server.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function requestJson(base, pathname, { method = 'GET', host = 'remote.test', origin, cookie, payload } = {}) {
  const target = new URL(pathname, base); const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: { host, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) },
    }, (response) => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    request.on('error', reject); if (encoded) request.write(encoded); request.end();
  });
}

function snapshotFixture(repositoryId) {
  const files = ['src/server.mjs', 'src/auth.mjs', 'test/auth.test.mjs'];
  const entities = [
    { id: 'module:server', kind: 'module', name: 'Server', location: { path: files[0] }, evidenceIds: ['ev:server'], attributes: { community: 'runtime' } },
    { id: 'module:auth', kind: 'module', name: 'Authentication', location: { path: files[1] }, evidenceIds: ['ev:auth'], attributes: { community: 'identity' } },
    { id: 'test:auth', kind: 'test', name: 'Authentication tests', location: { path: files[2] }, evidenceIds: ['ev:test'], attributes: { community: 'verification' } },
  ];
  const evidence = entities.map((entity, index) => ({ id: entity.evidenceIds[0], sourceKind: 'source', provenance: 'extracted', path: files[index], summary: `Observed ${entity.name}.` }));
  return createAnalysisSnapshot({
    repository: { id: repositoryId, adapter: 'handraise' }, createdAt: '2026-08-03T12:00:00.000Z',
    analyzer: {
      id: 'fixture', name: 'Fixture', version: '1.0.0', contractVersion: 1,
      capabilities: { languages: ['JavaScript'], entityKinds: ['module', 'test'], relationKinds: ['calls', 'tests'], queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: true, incremental: false },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: {}, status: 'complete', freshness: { state: 'current', checkedAt: '2026-08-03T12:00:00.000Z' },
    manifest: { files: files.map((path) => ({ path, digest: digest(path), size: path.length, source: 'tracked' })), git: { head: digest('head').slice(0, 40), branch: 'main', dirty: false }, selection: { includeUntracked: false, includeIgnored: false, exclusions: [] } },
    scope: { included: files, excluded: [], truncated: false, limits: {} }, evidence, entities,
    relations: [
      { id: 'rel:auth', source: 'module:server', target: 'module:auth', kind: 'calls', evidenceIds: ['ev:server', 'ev:auth'], confidence: .9 },
      { id: 'rel:test', source: 'test:auth', target: 'module:auth', kind: 'tests', evidenceIds: ['ev:test'], confidence: 1 },
    ], findings: [], coverage: [{ id: 'coverage:js', subject: 'JavaScript', status: 'covered', summary: 'Parsed.', evidenceIds: [] }], diagnostics: [],
  });
}

function acceptedComponent() {
  return {
    slug: 'runtime-control', title: 'Runtime Control', order: 1, purpose: 'Own authenticated runtime control.', outcomes: ['Runtime control remains operable.'],
    responsibilities: ['Serve authenticated control routes.'], limits: ['No product publication.'], invariants: ['Authenticate remote mutations.'], interfaces: [], dependencies: [],
    dataSystems: ['Private state'], territory: ['src/server.mjs', 'src/auth.mjs'], verification: ['Run API tests.'], evidence: [{ kind: 'declared', reference: 'ev:server', reason: 'Accepted runtime owner.' }],
    uncertainties: ['Remote identity slicing needs review.'], guidance: 'Preserve runtime behavior.',
  };
}

test('front-design APIs plan from a private component architecture without publishing execution artifacts', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-front-design-api-')); const root = join(home, 'state'); const repositoryRoot = join(home, 'repository'); const webRoot = join(home, 'web');
  mkdirSync(repositoryRoot, { recursive: true }); mkdirSync(webRoot, { recursive: true }); writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  initializeNativeRepository({ id: 'front-api-fixture', name: 'Front API fixture', path: repositoryRoot }, { components: [acceptedComponent()] });
  const acceptedPath = join(repositoryRoot, '.handraise', 'components', 'runtime-control.md'); const acceptedBefore = readFileSync(acceptedPath, 'utf8');
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home }); const repository = config.addRepository(repositoryRoot, { id: 'front-api-fixture', name: 'Front API fixture' });
  const auth = new PairingAuth({ root }); const paired = auth.pair(auth.pairingDetails().code, 'API client'); const snapshot = snapshotFixture(repository.id);
  const analysisRuntime = {
    analyzers: async () => [], list: () => [{ id: 'analysis-job', repositoryId: repository.id, state: 'complete', snapshotId: snapshot.id }], status: () => ({ id: 'analysis-job', repositoryId: repository.id, state: 'complete', snapshotId: snapshot.id }),
    snapshot: (repositoryId, id) => { if (repositoryId !== repository.id || id !== 'analysis-job') throw new Error('snapshot not found'); return snapshot; }, shutdown() {},
  };
  const planningRuntime = { catalog: async () => [], list: () => [], shutdown() {} };
  const server = createHandraise({ root, webRoot, auth, config, analysisRuntime, planningRuntime });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); }); server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    if (error?.code === 'EPERM') { server.close(); context.skip('the execution sandbox does not permit a local listening socket'); return; }
    throw error;
  }
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`; const origin = 'http://remote.test'; const cookie = `handraise_session=${paired.token}`;
  const componentEndpoint = `/api/repositories/${repository.id}/component-design/drafts`;
  const componentResponse = await requestJson(base, componentEndpoint, { method: 'POST', host: 'remote.test', origin, cookie, payload: { analysisJobId: 'analysis-job', includeProduct: false, includeModel: false } });
  assert.equal(componentResponse.status, 201, JSON.stringify(componentResponse.body)); const componentDraft = componentResponse.body.draft;
  const frontEndpoint = `/api/repositories/${repository.id}/front-design/drafts`;
  const unauthorized = await requestJson(base, frontEndpoint, { method: 'POST', host: 'remote.test', origin, payload: {} }); assert.equal(unauthorized.status, 401);
  const created = await requestJson(base, frontEndpoint, {
    method: 'POST', host: 'remote.test', origin, cookie,
    payload: {
      componentDraftId: componentDraft.id, componentAlternativeId: componentDraft.selectedAlternativeId, includeProduct: false, includeModel: false,
      goal: { id: 'goal:manual-remote', title: 'Safe remote control', outcome: 'A remote browser safely controls one agent journey.', successSignals: ['A reviewer completes the journey.'] },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body)); let draft = created.body.draft;
  assert.equal(draft.mutation.repository, false); assert.ok(draft.alternatives.length >= 2); assert.equal(readFileSync(acceptedPath, 'utf8'), acceptedBefore);
  const listed = await requestJson(base, frontEndpoint, { host: 'remote.test', cookie }); assert.equal(listed.body.drafts[0].id, draft.id);
  const opened = await requestJson(base, `${frontEndpoint}/${draft.id}`, { host: 'remote.test', cookie }); assert.equal(opened.status, 200); assert.equal(opened.body.draft.stale, false);
  const selected = draft.alternatives.at(-1);
  const selectedResponse = await requestJson(base, `${frontEndpoint}/${draft.id}/operations`, { method: 'POST', host: 'remote.test', origin, cookie, payload: { operation: 'select-alternative', alternativeId: selected.id, expectedRevision: draft.revision } });
  assert.equal(selectedResponse.status, 200, JSON.stringify(selectedResponse.body)); draft = selectedResponse.body.draft;
  const conflict = await requestJson(base, `${frontEndpoint}/${draft.id}/operations`, { method: 'POST', host: 'remote.test', origin, cookie, payload: { operation: 'skip', expectedRevision: created.body.draft.revision } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'FRONT_DESIGN_REVISION_CONFLICT');
  const compared = await requestJson(base, `${frontEndpoint}/${draft.id}/compare?left=${draft.alternatives[0].id}&right=${draft.alternatives[1].id}`, { host: 'remote.test', cookie });
  assert.equal(compared.status, 200); assert.equal(compared.body.comparison.materiallyDifferent, true);
  const removed = await requestJson(base, `${frontEndpoint}/${draft.id}`, { method: 'DELETE', host: 'remote.test', origin, cookie }); assert.equal(removed.status, 200);
  assert.equal(readFileSync(acceptedPath, 'utf8'), acceptedBefore);
});
