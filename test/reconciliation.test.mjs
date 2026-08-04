import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { SystemMapRuntime } from '../src/intelligence/system-map.mjs';
import { ReconciliationRuntime, reconcileArchitecture } from '../src/reconciliation.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function snapshot({
  createdAt, version = '1.0.0', status = 'complete', files, evidence, entities, relations = [], repositoryId = 'repo:reconciliation',
} = {}) {
  return createAnalysisSnapshot({
    repository: { id: repositoryId, adapter: 'handraise' },
    createdAt,
    analyzer: {
      id: 'fixture-analyzer', name: 'Fixture analyzer', version, contractVersion: 1,
      capabilities: {
        languages: ['JavaScript'], entityKinds: [...new Set(entities.map((item) => item.kind))],
        relationKinds: [...new Set(relations.map((item) => item.kind))],
        queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: true, incremental: true,
      },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: { fixture: true },
    status,
    freshness: { state: 'current', checkedAt: createdAt },
    manifest: {
      files: files.map((item) => ({ path: item.path, digest: item.digest || digest(item.content || item.path), size: item.size || 20, source: 'tracked' })),
      git: { head: digest(`head:${createdAt}`).slice(0, 40), branch: 'main', dirty: false },
      selection: { includeUntracked: false, includeIgnored: false, exclusions: [] },
    },
    scope: { included: files.map((item) => item.path), excluded: [], truncated: false, limits: { maxFiles: 20_000, maxBytes: 10_000_000 } },
    evidence,
    entities,
    relations,
    findings: [], coverage: [], diagnostics: [],
  });
}

function fixtureSnapshots({ version = '1.0.0', partial = false } = {}) {
  const from = snapshot({
    createdAt: '2026-08-03T10:00:00.000Z',
    status: partial ? 'partial' : 'complete',
    files: [
      { path: 'src/billing/service.mjs', content: 'service' },
      { path: 'src/billing/store.mjs', content: 'store' },
      { path: 'src/api/routes.mjs', content: 'routes' },
    ],
    evidence: [
      { id: 'ev:service', sourceKind: 'source', provenance: 'extracted', path: 'src/billing/service.mjs' },
      { id: 'ev:store', sourceKind: 'source', provenance: 'extracted', path: 'src/billing/store.mjs' },
      { id: 'ev:routes', sourceKind: 'source', provenance: 'extracted', path: 'src/api/routes.mjs' },
    ],
    entities: [
      { id: 'module:billing', kind: 'module', name: 'Billing', location: { path: 'src/billing/service.mjs' }, evidenceIds: ['ev:service'], attributes: { community: 'billing' } },
      { id: 'store:billing', kind: 'database', name: 'Billing store', location: { path: 'src/billing/store.mjs' }, evidenceIds: ['ev:store'], attributes: { community: 'billing' } },
      { id: 'route:billing', kind: 'route', name: 'Billing route', location: { path: 'src/api/routes.mjs' }, evidenceIds: ['ev:routes'], attributes: { community: 'api' } },
    ],
    relations: [{ id: 'rel:store', source: 'module:billing', target: 'store:billing', kind: 'writes', evidenceIds: ['ev:store'], confidence: 0.95 }],
  });
  const to = snapshot({
    createdAt: '2026-08-03T11:00:00.000Z', version,
    files: [
      { path: 'src/billing/service.mjs', content: 'service-v2' },
      { path: 'src/platform/store.mjs', content: 'store' },
      { path: 'src/api/routes.mjs', content: 'routes-v2' },
      { path: 'src/workers/invoice.mjs', content: 'worker' },
    ],
    evidence: [
      { id: 'ev:service-v2', sourceKind: 'source', provenance: 'extracted', path: 'src/billing/service.mjs' },
      { id: 'ev:store-v2', sourceKind: 'source', provenance: 'extracted', path: 'src/platform/store.mjs' },
      { id: 'ev:routes-v2', sourceKind: 'source', provenance: 'extracted', path: 'src/api/routes.mjs' },
      { id: 'ev:worker', sourceKind: 'source', provenance: 'extracted', path: 'src/workers/invoice.mjs' },
    ],
    entities: [
      { id: 'module:billing', kind: 'module', name: 'Billing', location: { path: 'src/billing/service.mjs' }, evidenceIds: ['ev:service-v2'], attributes: { community: 'billing' } },
      { id: 'store:billing', kind: 'database', name: 'Billing store', location: { path: 'src/platform/store.mjs' }, evidenceIds: ['ev:store-v2'], attributes: { community: 'platform' } },
      { id: 'route:billing', kind: 'route', name: 'Billing route', location: { path: 'src/api/routes.mjs' }, evidenceIds: ['ev:routes-v2'], attributes: { community: 'api' } },
      { id: 'service:invoice', kind: 'service', name: 'Invoice worker', location: { path: 'src/workers/invoice.mjs' }, evidenceIds: ['ev:worker'], attributes: { community: 'workers' } },
    ],
    relations: [
      { id: 'rel:store-v2', source: 'module:billing', target: 'store:billing', kind: 'writes', evidenceIds: ['ev:store-v2'], confidence: 0.95 },
      { id: 'rel:worker', source: 'service:invoice', target: 'module:billing', kind: 'imports', evidenceIds: ['ev:worker'], confidence: 0.9 },
    ],
  });
  return { from, to };
}

function acceptedContext(from, { overlap = false } = {}) {
  const components = [
    {
      slug: 'billing', title: 'Billing',
      contract: { territory: ['src/billing/**'], evidence: [{ kind: 'extracted', reference: 'ev:store' }] },
    },
    {
      slug: 'platform', title: 'Platform',
      contract: { territory: ['src/platform/**'], evidence: [] },
    },
    ...(overlap ? [{ slug: 'shared', title: 'Shared', contract: { territory: ['src/**'], evidence: [] } }] : []),
  ];
  const fronts = [{
    slug: 'billing-change', component: 'billing', leadComponent: 'billing', affectedComponents: [], state: 'active',
    analysisSnapshot: from.id, evidence: [{ kind: 'extracted', reference: 'ev:store' }], dependencies: [],
  }];
  const runs = [{
    id: 'run:active', state: 'running', discoveries: [],
    manifest: { front: { slug: 'billing-change' }, components: [{ slug: 'billing' }], source: { analysisSnapshot: from.id, repositoryRevision: from.manifest.git.head, digest: 'run-source' } },
  }, {
    id: 'run:completed', state: 'completed', discoveries: [], checks: [],
    manifest: {
      front: { slug: 'billing-completed', acceptanceCriteria: ['The move is accepted.'], verification: ['Storage tests pass.'] },
      components: [{ slug: 'billing', territory: ['src/billing/**'] }], source: { analysisSnapshot: from.id, repositoryRevision: from.manifest.git.head, digest: 'completed-source' },
    },
    outcome: { accepted: true, acceptedAt: '2026-08-03T10:30:00.000Z', evidence: { tasks: ['task:1'], checks: [] } },
  }];
  const product = {
    purpose: { id: 'purpose', text: 'Keep billing work safe.', sourceIds: ['ev:store'] },
    outcomes: [], constraints: [], invariants: [], nonGoals: [], goals: [], users: [], assumptions: [], decisions: [], conflicts: [],
  };
  return { portfolio: { components, fronts, product }, runs };
}

test('reconciliation separates snapshot causes and traces boundary, evidence, architecture and active-run drift', () => {
  const { from, to } = fixtureSnapshots();
  const maps = new SystemMapRuntime();
  const comparison = maps.compare(from, to);
  const context = acceptedContext(from);
  const cycle = reconcileArchitecture({
    repository: { id: 'repo:reconciliation', name: 'Fixture' }, fromMap: maps.build(from), toMap: maps.build(to), comparison,
    portfolio: context.portfolio, runs: context.runs, now: Date.parse('2026-08-03T12:00:00.000Z'),
  });
  const kinds = new Set(cycle.findings.map((item) => item.kind));
  assert.deepEqual(new Set(comparison.causes), new Set(['code', 'evidence', 'inference']));
  assert.ok(kinds.has('boundary-crossing'));
  assert.ok(kinds.has('stale-evidence'));
  assert.ok(kinds.has('stale-analysis-snapshot'));
  assert.ok(kinds.has('new-deployable'));
  assert.ok(kinds.has('new-dependency'));
  assert.ok(kinds.has('stale-run-context'));
  assert.ok(kinds.has('completed-run-evidence-gap'));
  assert.ok(kinds.has('completed-run-outcome'));
  assert.ok(kinds.has('orphan-responsibility'));
  const staleEvidence = cycle.findings.find((item) => item.kind === 'stale-evidence');
  assert.ok(staleEvidence.affected.components.includes('billing'));
  assert.ok(staleEvidence.affected.fronts.includes('billing-change'));
  assert.ok(staleEvidence.affected.runs.includes('run:active'));
  assert.ok(staleEvidence.affected.productClaims.includes('purpose:purpose'));
  assert.equal(cycle.staleness.fronts.some((item) => item.id === 'billing-change'), true);
  assert.equal(cycle.authority.accepted, false);
  assert.match(cycle.authority.statement, /never modify/i);

  const overlap = reconcileArchitecture({
    repository: { id: 'repo:reconciliation', name: 'Fixture' }, fromMap: maps.build(from), toMap: maps.build(to), comparison,
    ...acceptedContext(from, { overlap: true }),
  });
  assert.ok(overlap.findings.some((item) => item.kind === 'overlapping-responsibility'));
});

test('no-op and repeated findings are stable while analyzer-only and partial evidence remain distinct', () => {
  const { from, to } = fixtureSnapshots();
  const maps = new SystemMapRuntime();
  const unchangedComparison = maps.compare(from, from);
  const noOp = reconcileArchitecture({ repository: { id: 'repo:reconciliation' }, fromMap: maps.build(from), toMap: maps.build(from), comparison: unchangedComparison });
  assert.equal(noOp.summary.noChange, true);
  assert.equal(noOp.findings.length, 0);

  const first = reconcileArchitecture({
    repository: { id: 'repo:reconciliation' }, fromMap: maps.build(from), toMap: maps.build(to), comparison: maps.compare(from, to),
    ...acceptedContext(from), now: Date.parse('2026-08-03T12:00:00.000Z'),
  });
  const repeated = reconcileArchitecture({
    repository: { id: 'repo:reconciliation' }, fromMap: maps.build(from), toMap: maps.build(to), comparison: maps.compare(from, to),
    ...acceptedContext(from), previousFindings: first.findings, now: Date.parse('2026-08-03T13:00:00.000Z'),
  });
  assert.deepEqual(repeated.findings.map((item) => item.id), first.findings.map((item) => item.id));
  assert.ok(repeated.findings.every((item) => item.firstSeen === first.findings.find((prior) => prior.id === item.id).firstSeen));
  assert.ok(repeated.findings.every((item) => item.occurrences === 2));

  const analyzerOnly = snapshot({
    createdAt: '2026-08-03T10:00:00.000Z', version: '2.0.0',
    files: from.manifest.files, evidence: from.evidence, entities: from.entities, relations: from.relations,
  });
  const analyzerCycle = reconcileArchitecture({
    repository: { id: 'repo:reconciliation' }, fromMap: maps.build(from), toMap: maps.build(analyzerOnly), comparison: maps.compare(from, analyzerOnly),
  });
  assert.ok(analyzerCycle.findings.some((item) => item.kind === 'analyzer-change'));
  assert.equal(analyzerCycle.comparison.content.manifestChanged, false);

  const partialPair = fixtureSnapshots({ partial: true });
  const partialMaps = new SystemMapRuntime();
  const partialCycle = reconcileArchitecture({
    repository: { id: 'repo:reconciliation' }, fromMap: partialMaps.build(partialPair.from), toMap: partialMaps.build(partialPair.to), comparison: partialMaps.compare(partialPair.from, partialPair.to),
    ...acceptedContext(partialPair.from),
  });
  assert.ok(partialCycle.findings.some((item) => item.kind === 'partial-analysis'));
  assert.equal(partialCycle.findings.find((item) => item.kind === 'stale-evidence').confidence.level, 'low');
});

test('runtime persists stable findings, decisions, deduplicated triggers and monitored refresh outcomes privately', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-reconciliation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { from, to } = fixtureSnapshots();
  const snapshots = new Map([['job:from', from], ['job:to', to], ['job:cancel', to]]);
  const statuses = new Map([
    ['job:to', { id: 'job:to', state: 'complete', progress: 1, stage: 'complete', message: 'Complete' }],
    ['job:cancel', { id: 'job:cancel', state: 'running', progress: 0.4, stage: 'analysis', message: 'Running' }],
  ]);
  const analyses = {
    snapshot(repositoryId, jobId) { assert.equal(repositoryId, 'repo:reconciliation'); return snapshots.get(jobId); },
    status(repositoryId, jobId) { assert.equal(repositoryId, 'repo:reconciliation'); return statuses.get(jobId); },
    cancel(repositoryId, jobId) { assert.equal(repositoryId, 'repo:reconciliation'); statuses.set(jobId, { ...statuses.get(jobId), state: 'cancelled' }); return statuses.get(jobId); },
  };
  const context = acceptedContext(from);
  const repository = { id: 'repo:reconciliation', name: 'Fixture', adapter: 'handraise' };
  const runtime = new ReconciliationRuntime({ root, analyses, systemMaps: new SystemMapRuntime(), context: () => context });
  t.after(() => runtime.shutdown());

  const trigger = runtime.trigger(repository, { cause: 'publication', sourceId: 'publication:1' });
  assert.equal(runtime.trigger(repository, { cause: 'publication', sourceId: 'publication:1' }).id, trigger.id);
  const cycle = runtime.compare(repository, { fromJobId: 'job:from', toJobId: 'job:to', cause: 'publication', sourceId: 'publication:1' });
  assert.equal(runtime.triggers(repository)[0].state, 'addressed');
  const finding = cycle.findings.find((item) => item.kind === 'boundary-crossing');
  const decision = runtime.decide(repository, finding.id, { state: 'deferred', rationale: 'Wait for the storage migration design.' }, { actor: { id: 'local', name: 'Host', implicit: true } });
  assert.equal(decision.finding.disposition, 'deferred');
  assert.equal(decision.authority.contractMutation, false);

  const repeated = runtime.compare(repository, { fromJobId: 'job:from', toJobId: 'job:to' });
  assert.equal(repeated.findings.find((item) => item.id === finding.id).disposition, 'deferred');
  assert.equal(runtime.findings(repository, { active: true }).filter((item) => item.id === finding.id).length, 1);

  const monitored = runtime.trackAnalysis(repository, statuses.get('job:to'), { fromJobId: 'job:from', cause: 'manual-refresh' });
  const finished = runtime.observeJob(repository, monitored.id);
  assert.equal(finished.state, 'complete');
  assert.ok(finished.cycleId);
  const cancellable = runtime.trackAnalysis(repository, statuses.get('job:cancel'), { fromJobId: 'job:from' });
  assert.equal(runtime.cancel(repository, cancellable.id).state, 'cancelled');
  assert.equal(statuses.get('job:cancel').state, 'cancelled');

  const stateFile = join(root, `${digest(repository.id).slice(0, 24)}.json`);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.repositoryId, repository.id);
  assert.ok(persisted.decisions.some((item) => item.findingId === finding.id));
});

test('large reconciliation diffs stay bounded and report truncation instead of silently dropping scope', () => {
  const count = 240;
  const from = snapshot({
    createdAt: '2026-08-03T10:00:00.000Z',
    files: Array.from({ length: count }, (_, index) => ({ path: `src/old-${index}.mjs`, content: `old-${index}` })),
    evidence: [], entities: [],
  });
  const to = snapshot({
    createdAt: '2026-08-03T11:00:00.000Z',
    files: Array.from({ length: count }, (_, index) => ({ path: `src/new-${index}.mjs`, content: `new-${index}` })),
    evidence: [], entities: [],
  });
  const maps = new SystemMapRuntime();
  const started = performance.now();
  const cycle = reconcileArchitecture({
    repository: { id: 'repo:reconciliation' }, fromMap: maps.build(from), toMap: maps.build(to), comparison: maps.compare(from, to),
    portfolio: { components: [{ slug: 'core', contract: { territory: ['lib/**'], evidence: [] } }], fronts: [] },
    limits: { maxChangedItems: 20, maxFindingsPerCycle: 10 },
  });
  assert.ok(performance.now() - started < 1_000);
  assert.ok(cycle.findings.length <= 10);
  assert.equal(cycle.summary.bounded, true);
  assert.ok(cycle.diagnostics.some((item) => item.code === 'RECONCILIATION_BUDGET_REACHED'));
  assert.equal(cycle.comparison.content.truncated, true);
});
