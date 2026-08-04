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
  const target = new URL(pathname, base);
  const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: {
        host, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}),
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

function snapshotFixture(repositoryId = 'api-fixture') {
  const files = ['src/server.mjs', 'src/auth.mjs', 'src/billing.mjs', 'test/billing.test.mjs'];
  const entities = [
    { id: 'module:server', kind: 'module', name: 'Server', location: { path: files[0] }, evidenceIds: ['ev:server'], attributes: { community: 'runtime' } },
    { id: 'module:auth', kind: 'module', name: 'Authentication', location: { path: files[1] }, evidenceIds: ['ev:auth'], attributes: { community: 'identity' } },
    { id: 'module:billing', kind: 'module', name: 'Billing', location: { path: files[2] }, evidenceIds: ['ev:billing'], attributes: { community: 'commerce' } },
    { id: 'test:billing', kind: 'test', name: 'Billing tests', location: { path: files[3] }, evidenceIds: ['ev:test'], attributes: { community: 'verification' } },
  ];
  const evidence = entities.map((entity, index) => ({
    id: entity.evidenceIds[0], sourceKind: 'source', provenance: 'extracted', path: files[index], summary: `Observed ${entity.name}.`,
  }));
  return createAnalysisSnapshot({
    repository: { id: repositoryId, adapter: 'handraise' }, createdAt: '2026-08-03T12:00:00.000Z',
    analyzer: {
      id: 'fixture', name: 'Fixture', version: '1.0.0', contractVersion: 1,
      capabilities: { languages: ['JavaScript'], entityKinds: ['module', 'test'], relationKinds: ['calls', 'tests'], queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: true, incremental: false },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: {}, status: 'complete', freshness: { state: 'current', checkedAt: '2026-08-03T12:00:00.000Z' },
    manifest: {
      files: files.map((path) => ({ path, digest: digest(path), size: path.length, source: 'tracked' })),
      git: { head: digest('head').slice(0, 40), branch: 'main', dirty: false },
      selection: { includeUntracked: false, includeIgnored: false, exclusions: [] },
    },
    scope: { included: files, excluded: [], truncated: false, limits: {} }, evidence, entities,
    relations: [
      { id: 'rel:auth', source: 'module:server', target: 'module:auth', kind: 'calls', evidenceIds: ['ev:server', 'ev:auth'], confidence: .9 },
      { id: 'rel:billing', source: 'module:server', target: 'module:billing', kind: 'calls', evidenceIds: ['ev:server', 'ev:billing'], confidence: .9 },
      { id: 'rel:test', source: 'test:billing', target: 'module:billing', kind: 'tests', evidenceIds: ['ev:test'], confidence: 1 },
    ],
    findings: [], coverage: [{ id: 'coverage:js', subject: 'JavaScript', status: 'covered', summary: 'Parsed.', evidenceIds: [] }], diagnostics: [],
  });
}

function acceptedComponent() {
  return {
    slug: 'runtime-control', title: 'Runtime Control', order: 1,
    purpose: 'Own authenticated server runtime control.', outcomes: ['Runtime control stays operable.'],
    responsibilities: ['Serve authenticated control routes.'], limits: ['No product architecture publication.'],
    invariants: ['Authenticate remote mutations.'], interfaces: [], dependencies: [], dataSystems: ['Private state'],
    territory: ['src/server.mjs'], verification: ['Run API tests.'],
    evidence: [{ kind: 'declared', reference: 'ev:server', reason: 'Current accepted server boundary.' }],
    uncertainties: ['The accepted boundary may be too broad.'], guidance: 'Preserve runtime behavior while reviewing boundaries.',
  };
}

test('authenticated component-design APIs keep every operation private and conflict-safe', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-component-design-api-'));
  const root = join(home, 'state');
  const repositoryRoot = join(home, 'repository');
  const webRoot = join(home, 'web');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, 'src-server-sentinel.txt'), 'repository must remain unchanged\n');
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  initializeNativeRepository({ id: 'api-fixture', name: 'API fixture', path: repositoryRoot }, { components: [acceptedComponent()] });
  const acceptedBefore = readFileSync(join(repositoryRoot, '.handraise', 'components', 'runtime-control.md'), 'utf8');
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home });
  const repository = config.addRepository(repositoryRoot, { id: 'api-fixture', name: 'API fixture' });
  const auth = new PairingAuth({ root });
  const paired = auth.pair(auth.pairingDetails().code, 'API client');
  const snapshot = snapshotFixture(repository.id);
  const analysisRuntime = {
    analyzers: async () => [], list: () => [{ id: 'analysis-job', repositoryId: repository.id, state: 'complete', snapshotId: snapshot.id }],
    status: () => ({ id: 'analysis-job', repositoryId: repository.id, state: 'complete', snapshotId: snapshot.id }),
    snapshot: (repositoryId, id) => {
      if (repositoryId !== repository.id || id !== 'analysis-job') throw new Error('snapshot not found');
      return snapshot;
    },
    shutdown() {},
  };
  const planningRuntime = { catalog: async () => [], list: () => [], shutdown() {} };
  const server = createHandraise({ root, webRoot, auth, config, analysisRuntime, planningRuntime });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    if (error?.code === 'EPERM') {
      server.close(); context.skip('the execution sandbox does not permit a local listening socket'); return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections?.();
  }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const origin = 'http://remote.test';
  const cookie = `handraise_session=${paired.token}`;
  const endpoint = `/api/repositories/${repository.id}/component-design/drafts`;

  const unauthorized = await requestJson(base, endpoint, { method: 'POST', host: 'remote.test', origin, payload: { analysisJobId: 'analysis-job' } });
  assert.equal(unauthorized.status, 401);
  const created = await requestJson(base, endpoint, {
    method: 'POST', host: 'remote.test', origin, cookie,
    payload: { analysisJobId: 'analysis-job', includeProduct: true, includeModel: false },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let draft = created.body.draft;
  assert.equal(draft.mutation.repository, false);
  assert.ok(draft.alternatives.length >= 1);
  assert.equal(readFileSync(join(repositoryRoot, '.handraise', 'components', 'runtime-control.md'), 'utf8'), acceptedBefore);

  const listed = await requestJson(base, endpoint, { host: 'remote.test', cookie });
  assert.equal(listed.body.drafts[0].id, draft.id);
  const opened = await requestJson(base, `${endpoint}/${draft.id}`, { host: 'remote.test', cookie });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.draft.stale, false);

  const selected = draft.alternatives.at(-1);
  assert.notEqual(selected.id, draft.selectedAlternativeId);
  const select = await requestJson(base, `${endpoint}/${draft.id}/operations`, {
    method: 'POST', host: 'remote.test', origin, cookie,
    payload: { operation: 'select-alternative', alternativeId: selected.id, expectedRevision: draft.revision },
  });
  assert.equal(select.status, 200);
  draft = select.body.draft;
  const conflict = await requestJson(base, `${endpoint}/${draft.id}/operations`, {
    method: 'POST', host: 'remote.test', origin, cookie,
    payload: { operation: 'skip', expectedRevision: created.body.draft.revision },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'COMPONENT_DESIGN_REVISION_CONFLICT');

  const compared = await requestJson(base, `${endpoint}/${draft.id}/compare?left=${draft.alternatives[0].id}&right=${draft.alternatives.at(-1).id}`, { host: 'remote.test', cookie });
  assert.equal(compared.status, 200);
  assert.equal(typeof compared.body.comparison.materiallyDifferent, 'boolean');
  const removed = await requestJson(base, `${endpoint}/${draft.id}`, { method: 'DELETE', host: 'remote.test', origin, cookie });
  assert.equal(removed.status, 200);
  assert.equal(readFileSync(join(repositoryRoot, '.handraise', 'components', 'runtime-control.md'), 'utf8'), acceptedBefore);
});
