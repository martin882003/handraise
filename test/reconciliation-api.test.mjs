import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { SystemMapRuntime } from '../src/intelligence/system-map.mjs';
import { ReconciliationRuntime } from '../src/reconciliation.mjs';
import { createHandraise } from '../src/server.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function requestJson(base, pathname, { method = 'GET', host = '127.0.0.1', payload } = {}) {
  const target = new URL(pathname, base); const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: { host, ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) },
    }, (response) => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    request.on('error', reject); if (encoded) request.write(encoded); request.end();
  });
}

function analysisSnapshot(repositoryId, { at, changed = false } = {}) {
  const path = changed ? 'src/platform/store.mjs' : 'src/billing/store.mjs';
  const evidenceId = changed ? 'ev:store-v2' : 'ev:store';
  return createAnalysisSnapshot({
    repository: { id: repositoryId, adapter: 'handraise' }, createdAt: at,
    analyzer: {
      id: 'fixture', name: 'Fixture', version: '1.0.0', contractVersion: 1,
      capabilities: { languages: ['JavaScript'], entityKinds: ['database'], relationKinds: [], queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: true, incremental: true },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: {}, status: 'complete', freshness: { state: 'current', checkedAt: at },
    manifest: {
      files: [{ path, digest: digest('same-store-content'), size: 20, source: 'tracked' }],
      git: { head: digest(`head:${at}`).slice(0, 40), branch: 'main', dirty: false },
      selection: { includeUntracked: false, includeIgnored: false, exclusions: [] },
    },
    scope: { included: [path], excluded: [], truncated: false, limits: {} },
    evidence: [{ id: evidenceId, sourceKind: 'source', provenance: 'extracted', path }],
    entities: [{ id: 'store:billing', kind: 'database', name: 'Billing store', location: { path }, evidenceIds: [evidenceId] }],
    relations: [], findings: [], coverage: [], diagnostics: [],
  });
}

test('authenticated reconciliation APIs expose evidence and decisions without mutating accepted repository files', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-reconciliation-api-'));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'state'); const repositoryRoot = join(home, 'repository'); const webRoot = join(home, 'web');
  mkdirSync(repositoryRoot, { recursive: true }); mkdirSync(webRoot, { recursive: true });
  const sentinel = join(repositoryRoot, 'accepted-contract.md');
  writeFileSync(sentinel, '# Accepted contract\n\nMust remain byte-identical.\n');
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home });
  const repository = config.addRepository(repositoryRoot, { name: 'Reconciliation API' });
  const from = analysisSnapshot(repository.id, { at: '2026-08-03T10:00:00.000Z' });
  const to = analysisSnapshot(repository.id, { at: '2026-08-03T11:00:00.000Z', changed: true });
  const snapshots = new Map([['job-from', from], ['job-to', to]]);
  const analysisRuntime = {
    analyzers: async () => [], list: () => [],
    snapshot: (repositoryId, jobId) => {
      if (repositoryId !== repository.id || !snapshots.has(jobId)) throw new Error('snapshot not found');
      return snapshots.get(jobId);
    },
    status: () => ({ state: 'complete', progress: 1 }), cancel: () => ({ state: 'cancelled' }), shutdown() {},
  };
  const systemMaps = new SystemMapRuntime();
  const reconciliations = new ReconciliationRuntime({
    root: join(root, 'reconciliation'), analyses: analysisRuntime, systemMaps,
    context: () => ({
      portfolio: {
        components: [
          { slug: 'billing', contract: { territory: ['src/billing/**'], evidence: [{ reference: 'ev:store' }] } },
          { slug: 'platform', contract: { territory: ['src/platform/**'], evidence: [] } },
        ],
        fronts: [{ slug: 'move-store', component: 'billing', leadComponent: 'billing', affectedComponents: [], state: 'queued', analysisSnapshot: from.id, evidence: [{ reference: 'ev:store' }], dependencies: [] }],
      },
      runs: [],
    }),
  });
  const planningRuntime = { catalog: async () => [], list: () => [], shutdown() {} };
  const server = createHandraise({
    root, webRoot, auth: new PairingAuth({ root }), config, analysisRuntime, systemMapRuntime: systemMaps,
    reconciliationRuntime: reconciliations, planningRuntime,
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    server.close(); if (error?.code === 'EPERM') { context.skip('the execution sandbox does not permit a local listening socket'); return; } throw error;
  }
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `/api/repositories/${repository.id}/reconciliation`;
  const before = readFileSync(sentinel, 'utf8');

  const unauthorized = await requestJson(base, endpoint, { host: 'remote.test' });
  assert.equal(unauthorized.status, 401);
  const empty = await requestJson(base, endpoint);
  assert.equal(empty.status, 200); assert.equal(empty.body.reconciliation.findings.active, 0);
  const compared = await requestJson(base, `${endpoint}/compare`, {
    method: 'POST', payload: { fromJobId: 'job-from', toJobId: 'job-to', cause: 'manual-compare' },
  });
  assert.equal(compared.status, 201, JSON.stringify(compared.body));
  assert.ok(compared.body.cycle.findings.some((item) => item.kind === 'boundary-crossing'));
  assert.equal(compared.body.cycle.authority.accepted, false);
  assert.equal(readFileSync(sentinel, 'utf8'), before);

  const listed = await requestJson(base, `${endpoint}/findings?active=true`);
  assert.equal(listed.status, 200); const finding = listed.body.findings[0];
  const missingRationale = await requestJson(base, `${endpoint}/findings/${finding.id}/decision`, { method: 'POST', payload: { state: 'dismissed' } });
  assert.equal(missingRationale.status, 400); assert.equal(missingRationale.body.code, 'RECONCILIATION_RATIONALE_REQUIRED');
  const decided = await requestJson(base, `${endpoint}/findings/${finding.id}/decision`, {
    method: 'POST', payload: { state: 'accepted-for-planning', rationale: 'Route this through the next reviewed architecture draft.' },
  });
  assert.equal(decided.status, 200); assert.equal(decided.body.authority.contractMutation, false);
  assert.equal(decided.body.finding.disposition, 'accepted-for-planning');
  assert.equal(readFileSync(sentinel, 'utf8'), before);

  const cycle = await requestJson(base, `${endpoint}/cycles/${compared.body.cycle.id}`);
  assert.equal(cycle.status, 200); assert.equal(cycle.body.cycle.findings.some((item) => item.id === finding.id), true);
});
