import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { ANALYSIS_DEFAULT_LIMITS } from '../src/intelligence/runtime.mjs';
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

function acceptedComponent() {
  return {
    slug: 'repository-planning', title: 'Repository Planning', order: 1,
    purpose: 'Own the legacy planning boundary.', outcomes: ['Planning remains available.'], responsibilities: ['Inspect repositories.'],
    limits: ['No runtime control.'], invariants: ['Review before mutation.'], interfaces: [], dependencies: [], dataSystems: ['Private drafts'],
    territory: ['README.md'], verification: ['Run publication API tests.'],
    evidence: [{ kind: 'declared', reference: 'ev:readme', reason: 'Accepted declaration.' }], uncertainties: ['The boundary needs review.'], guidance: 'Preserve review semantics.',
  };
}

function componentDraft(repositoryId, snapshotId) {
  const candidate = {
    id: 'component:repository-planning', slug: 'repository-planning', title: 'Repository Planning', state: 'active', order: 1,
    origin: 'generated', memberEntityIds: ['module:readme'], lockedFields: [], fieldGrounding: {},
    contract: {
      purpose: 'Understand the system and design evidence-backed work boundaries.', outcomes: ['A human reviews one coherent work model.'],
      responsibilities: ['Inspect repository evidence.', 'Design components and fronts.'], limits: ['Does not launch agents before publication.'],
      invariants: ['No accepted mutation before explicit confirmation.'], interfaces: [], dependencies: [], dataSystems: ['Private drafts'], territory: ['README.md'],
      verification: ['Run publication API tests.'], evidence: [{ kind: 'extracted', reference: 'ev:readme', reason: 'README describes repository planning.' }],
      uncertainties: ['Human review remains authoritative.'], guidance: 'Keep every proposal private until publication.',
    },
  };
  return {
    id: '11111111-1111-4111-8111-111111111111', repositoryId, revision: digest(`draft:${snapshotId}`), state: 'review', stale: false, staleReasons: [],
    selectedAlternativeId: 'architecture:reviewed', source: { snapshotId },
    alternatives: [{ id: 'architecture:reviewed', title: 'Reviewed architecture', strategy: 'responsibility', components: [candidate], quality: { gateC: { pass: true } } }],
  };
}

test('publication API requires authentication and exact confirmation, then commits the reviewed manifest', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-publication-api-')); const root = join(home, 'state');
  const repositoryRoot = join(home, 'repository'); const webRoot = join(home, 'web'); mkdirSync(repositoryRoot); mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  const readme = '# Repository planning fixture\n'; writeFileSync(join(repositoryRoot, 'README.md'), readme);
  initializeNativeRepository({ id: 'publication-api', name: 'Publication API', path: repositoryRoot }, { components: [acceptedComponent()] });
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home });
  const repository = config.addRepository(repositoryRoot, { id: 'publication-api', name: 'Publication API' });
  const snapshot = createAnalysisSnapshot({
    repository: { id: repository.id, adapter: 'handraise' }, createdAt: '2026-08-03T12:00:00.000Z',
    analyzer: {
      id: 'fixture', name: 'Fixture analyzer', version: '1.0.0', contractVersion: 1,
      capabilities: { languages: ['Markdown'], entityKinds: ['module'], relationKinds: [], queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: true, incremental: false },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: {}, status: 'complete', freshness: { state: 'current', checkedAt: '2026-08-03T12:00:00.000Z' },
    manifest: {
      files: [{ path: 'README.md', digest: digest(readme), size: Buffer.byteLength(readme), source: 'untracked', mode: '644', executable: false }],
      git: { head: null, branch: null, dirty: false }, selection: { includeUntracked: true, includeIgnored: false, exclusions: ['.handraise/**'] },
    },
    scope: { included: ['README.md'], excluded: [], truncated: false, limits: ANALYSIS_DEFAULT_LIMITS },
    evidence: [{ id: 'ev:readme', sourceKind: 'source', provenance: 'extracted', path: 'README.md', revision: digest(readme), summary: 'README describes repository planning.' }],
    entities: [{ id: 'module:readme', kind: 'module', name: 'Repository guide', location: { path: 'README.md' }, evidenceIds: ['ev:readme'], attributes: { community: 'planning' } }],
    relations: [], findings: [], coverage: [{ id: 'coverage:markdown', subject: 'Markdown', status: 'covered', summary: 'Repository guide parsed.', evidenceIds: ['ev:readme'] }], diagnostics: [],
  });
  const draft = componentDraft(repository.id, snapshot.id);
  const componentDesignStore = {
    source(repositoryId, id) {
      if (repositoryId !== repository.id || id !== draft.id) throw new Error('draft not found');
      return { analysisJobId: 'analysis-job', planningJobId: null, snapshotId: snapshot.id, productIncluded: false, modelIncluded: false };
    },
    get() { return structuredClone(draft); }, list() { return [structuredClone(draft)]; }, deleteRepository() {}, cleanup() {},
  };
  const analysisRuntime = {
    analyzers: async () => [], list: () => [], status: () => ({ id: 'analysis-job', state: 'complete' }),
    snapshot: (repositoryId, id) => { if (repositoryId !== repository.id || id !== 'analysis-job') throw new Error('snapshot not found'); return snapshot; }, shutdown() {},
  };
  const planningRuntime = { catalog: async () => [], list: () => [], shutdown() {} };
  const auth = new PairingAuth({ root }); const paired = auth.pair(auth.pairingDetails().code, 'Publication reviewer');
  const server = createHandraise({ root, webRoot, auth, config, componentDesignStore, analysisRuntime, planningRuntime });
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
  const endpoint = `/api/repositories/${repository.id}/publications`;
  const acceptedPath = join(repositoryRoot, '.handraise', 'components', 'repository-planning.md'); const acceptedBefore = readFileSync(acceptedPath, 'utf8');

  const unauthorized = await requestJson(base, endpoint, { method: 'POST', host: 'remote.test', origin, payload: {} }); assert.equal(unauthorized.status, 401);
  const created = await requestJson(base, endpoint, {
    method: 'POST', host: 'remote.test', origin, cookie,
    payload: { sources: { componentDraftId: draft.id, componentAlternativeId: draft.selectedAlternativeId }, selection: { mode: 'components-only' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const publication = created.body.publication;
  assert.equal(publication.canPublish, true); assert.equal(readFileSync(acceptedPath, 'utf8'), acceptedBefore);
  const listed = await requestJson(base, endpoint, { host: 'remote.test', cookie }); assert.equal(listed.body.publications[0].id, publication.id);
  const unconfirmed = await requestJson(base, `${endpoint}/${publication.id}/commit`, {
    method: 'POST', host: 'remote.test', origin, cookie, payload: { expectedRevision: publication.revision, confirmed: false },
  });
  assert.equal(unconfirmed.status, 400); assert.equal(unconfirmed.body.code, 'PUBLICATION_CONFIRMATION_REQUIRED'); assert.equal(readFileSync(acceptedPath, 'utf8'), acceptedBefore);
  const committed = await requestJson(base, `${endpoint}/${publication.id}/commit`, {
    method: 'POST', host: 'remote.test', origin, cookie, payload: { expectedRevision: publication.revision, confirmed: true },
  });
  assert.equal(committed.status, 201, JSON.stringify(committed.body)); assert.equal(committed.body.result.committed, true);
  assert.equal(committed.body.reconciliationTrigger?.cause, 'publication');
  assert.equal(committed.body.reconciliationTrigger?.state, 'pending');
  assert.equal(committed.body.reconciliationTrigger?.mutatesRepository, false);
  assert.match(readFileSync(acceptedPath, 'utf8'), /Understand the system and design evidence-backed work boundaries/);
  assert.equal(committed.body.publication.state, 'committed');
  const again = await requestJson(base, `${endpoint}/${publication.id}/commit`, {
    method: 'POST', host: 'remote.test', origin, cookie, payload: { expectedRevision: publication.revision, confirmed: true },
  });
  assert.equal(again.status, 201); assert.deepEqual(again.body.result, committed.body.result);
});
