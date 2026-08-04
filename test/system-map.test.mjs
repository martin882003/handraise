import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import {
  SystemMapRuntime,
  compareSystemMaps,
  deriveSystemMap,
  exportSystemMap,
  querySystemMap,
  summarizeSystemMap,
} from '../src/intelligence/system-map.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

const files = [
  'package.json',
  'Dockerfile',
  'src/server.mjs',
  'src/auth/service.mjs',
  'src/auth/routes.mjs',
  'src/billing/service.mjs',
  'src/billing/store.mjs',
  'src/billing/schema.sql',
  'test/billing.test.mjs',
];

function richSnapshot({
  createdAt = '2026-08-03T12:00:00.000Z',
  analyzerVersion = '2.4.0',
  moved = false,
  freshness = 'current',
  dirty = true,
} = {}) {
  const selectedFiles = files.map((path) => (moved && path === 'src/billing/store.mjs' ? 'src/payments/store.mjs' : path));
  const evidence = selectedFiles.map((path, index) => ({
    id: `ev:${index + 1}`,
    sourceKind: 'source',
    provenance: index === 7 ? 'inferred' : 'extracted',
    path,
    revision: digest(path === 'src/payments/store.mjs' ? 'src/billing/store.mjs' : path),
    summary: `Observed ${path}.`,
  }));
  const storePath = moved ? 'src/payments/store.mjs' : 'src/billing/store.mjs';
  const entities = [
    { id: 'module:server', kind: 'module', name: 'Server', location: { path: 'src/server.mjs' }, language: 'JavaScript', evidenceIds: ['ev:3'], attributes: { community: 'runtime' } },
    { id: 'module:auth', kind: 'module', name: 'Authentication', location: { path: 'src/auth/service.mjs' }, language: 'JavaScript', evidenceIds: ['ev:4'], attributes: { community: 'identity' } },
    { id: 'route:auth', kind: 'route', name: 'Authentication API', location: { path: 'src/auth/routes.mjs' }, language: 'JavaScript', evidenceIds: ['ev:5'], attributes: { community: 'identity' } },
    { id: 'module:billing', kind: 'module', name: 'Billing', location: { path: 'src/billing/service.mjs' }, language: 'JavaScript', evidenceIds: ['ev:6'], attributes: { community: 'billing' } },
    { id: 'store:billing', kind: 'repository', name: 'Billing store', location: { path: storePath }, language: 'JavaScript', evidenceIds: ['ev:7'], attributes: { community: 'billing' } },
    { id: 'db:billing', kind: 'database', name: 'Billing database', location: { path: 'src/billing/schema.sql' }, language: 'SQL', evidenceIds: ['ev:8'], attributes: { community: 'billing' } },
    { id: 'test:billing', kind: 'test', name: 'Billing integration test', location: { path: 'test/billing.test.mjs' }, language: 'JavaScript', evidenceIds: ['ev:9'] },
    { id: 'deploy:server', kind: 'service', name: 'Handraise server', location: { path: 'Dockerfile' }, evidenceIds: ['ev:2'], attributes: { community: 'runtime' } },
    { id: 'external:stripe', kind: 'external-service', name: 'Stripe API', evidenceIds: [] },
    { id: 'entry:server', kind: 'entry-point', name: 'server', location: { path: 'src/server.mjs' }, language: 'JavaScript', evidenceIds: ['ev:3'] },
  ];
  const relations = [
    ['rel:1', 'deploy:server', 'module:server', 'contains', 1],
    ['rel:2', 'entry:server', 'module:server', 'calls', 1],
    ['rel:3', 'module:server', 'module:auth', 'imports', .95],
    ['rel:4', 'module:server', 'module:billing', 'imports', .95],
    ['rel:5', 'module:auth', 'route:auth', 'provides', .9],
    ['rel:6', 'module:billing', 'store:billing', 'calls', .95],
    ['rel:7', 'store:billing', 'db:billing', 'writes', .9],
    ['rel:8', 'module:billing', 'external:stripe', 'depends_on', .75],
    ['rel:9', 'test:billing', 'module:billing', 'tests', 1],
    ['rel:10', 'module:billing', 'store:billing', 'co_change', .7],
  ].map(([id, source, target, kind, confidence], index) => ({
    id, source, target, kind, confidence, evidenceIds: index < evidence.length ? [`ev:${index + 1}`] : [],
    attributes: { provenance: confidence === 1 ? 'extracted' : 'inferred' },
  }));
  return createAnalysisSnapshot({
    repository: { id: 'repo:fixture', adapter: 'handraise' },
    createdAt,
    analyzer: {
      id: 'fixture-rich', name: 'Fixture rich analyzer', version: analyzerVersion, contractVersion: 1,
      capabilities: {
        languages: ['JavaScript', 'SQL'],
        entityKinds: [...new Set(entities.map((entity) => entity.kind))],
        relationKinds: [...new Set(relations.map((relation) => relation.kind))],
        queries: ['entity', 'search', 'neighbors', 'path', 'evidence'],
        history: true, semantic: false, incremental: false,
      },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: { fixture: true },
    status: 'partial',
    freshness: { state: freshness, checkedAt: createdAt, ...(freshness === 'current' ? {} : { reason: 'Repository changed.' }) },
    manifest: {
      files: selectedFiles.map((path) => ({
        path,
        digest: digest(path === 'src/payments/store.mjs' ? 'src/billing/store.mjs' : path),
        size: path.length * 10,
        source: 'tracked',
      })),
      git: { head: digest(`head:${createdAt}`).slice(0, 40), branch: 'main', dirty },
      selection: { includeUntracked: false, includeIgnored: false, exclusions: ['node_modules/**'] },
    },
    scope: {
      included: selectedFiles,
      excluded: [{ pattern: 'vendor/**', reason: 'Generated dependencies are excluded.' }],
      truncated: false,
      limits: { maxFiles: 20_000, maxBytes: 1_000_000 },
    },
    evidence,
    entities,
    relations,
    findings: [],
    coverage: [
      { id: 'coverage:js', subject: 'JavaScript', status: 'covered', summary: 'JavaScript was parsed.', evidenceIds: [] },
      { id: 'coverage:sql', subject: 'SQL', status: 'partial', summary: 'SQL stores are located but query semantics are partial.', evidenceIds: ['ev:8'] },
      { id: 'coverage:docs', subject: 'Markdown', status: 'unsupported', summary: 'Documentation was not parsed.', evidenceIds: [] },
    ],
    diagnostics: [],
  });
}

test('semantic map derives explainable multi-lens hypotheses without promoting them to components', () => {
  const snapshot = richSnapshot();
  const original = JSON.stringify(snapshot);
  const first = deriveSystemMap(snapshot);
  const second = deriveSystemMap(snapshot);
  assert.deepEqual(first, second, 'same immutable snapshot and algorithm must produce a stable map');
  assert.equal(first.authority.accepted, false);
  assert.match(first.authority.statement, /not accepted/i);
  assert.equal(first.snapshotId, snapshot.id);
  assert.equal(first.source.git.dirty, true, 'dirty-tree identity remains visible in the derived map source');
  assert.ok(first.groups.some((group) => group.lens === 'responsibility' && group.attributes.strategy === 'analyzer-community'));
  assert.ok(first.groups.some((group) => group.lens === 'deployable'));
  assert.ok(first.groups.some((group) => group.lens === 'entry-point'));
  assert.ok(first.groups.some((group) => group.lens === 'interface'));
  assert.ok(first.groups.some((group) => group.lens === 'data-store'));
  assert.ok(first.groups.some((group) => group.lens === 'test'));
  assert.ok(first.groups.some((group) => group.lens === 'external-system'));
  assert.ok(first.groups.some((group) => group.lens === 'change-coupling'));
  assert.ok(first.lenses.find((lens) => lens.id === 'data-flow').relationKinds.includes('writes'));
  assert.equal(first.coverage.counts.unsupported, 1);
  assert.ok(first.diagnostics.some((item) => item.code === 'MAP_PARTIAL_SNAPSHOT'));
  const evidenceIds = new Set(first.evidence.map((item) => item.id));
  for (const group of first.groups) {
    assert.ok(['extracted', 'inferred', 'declared'].includes(group.provenance));
    assert.ok(group.rationale.length > 0);
    assert.ok(group.evidenceIds.every((id) => evidenceIds.has(id)));
    assert.ok(!/accepted component/i.test(group.summary));
  }
  assert.equal(JSON.stringify(snapshot), original, 'derivation must not mutate the normalized snapshot');
  assert.ok(Object.isFrozen(first));
});

test('weak inventory evidence remains visibly uncertain and capability gaps stay explicit', () => {
  const input = richSnapshot();
  const inventory = createAnalysisSnapshot({
    ...input,
    id: undefined,
    analyzer: {
      ...input.analyzer,
      id: 'inventory-only', version: '1.0.0',
      capabilities: { languages: [], entityKinds: ['file'], relationKinds: [], queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: false, incremental: false },
    },
    configurationDigest: undefined,
    configuration: { inventory: true },
    entities: input.manifest.files.map((file, index) => ({
      id: `file:${index + 1}`, kind: 'file', name: file.path, location: { path: file.path }, evidenceIds: [`ev:${index + 1}`],
    })),
    relations: [],
  });
  const map = deriveSystemMap(inventory);
  assert.ok(map.groups.some((group) => group.lens === 'responsibility' && group.attributes.strategy === 'path-affinity' && group.uncertainty.level === 'high'));
  assert.equal(map.lenses.find((lens) => lens.id === 'change-coupling').status, 'unsupported');
  assert.equal(map.lenses.find((lens) => lens.id === 'dependency').status, 'unsupported');
  assert.ok(map.diagnostics.some((item) => item.code === 'MAP_RELATIONS_UNAVAILABLE'));
});

test('map queries are bounded and preserve evidence routes for search, detail, graph and aggregates', () => {
  const map = deriveSystemMap(richSnapshot());
  const overview = querySystemMap(map, { type: 'overview', limit: 3 });
  assert.equal(overview.groups.length, 3);
  assert.equal(overview.truncated, true);
  assert.ok(overview.aggregates.groupsByLens.length > 1);

  const search = querySystemMap(map, { type: 'search', text: 'billing', limit: 20 });
  assert.ok(search.groups.some((group) => /billing/i.test(group.name)));
  assert.ok(search.entities.some((entity) => entity.id === 'module:billing'));

  const selected = map.groups.find((group) => group.memberEntityIds.includes('module:billing') && group.memberEntityIds.length > 1);
  const detail = querySystemMap(map, { type: 'group', groupId: selected.id, limit: 50 });
  assert.equal(detail.groups[0].id, selected.id);
  assert.ok(detail.entities.some((entity) => entity.id === 'module:billing'));
  assert.ok(detail.evidence.every((item) => selected.evidenceIds.includes(item.id) || detail.entities.some((entity) => entity.evidenceIds.includes(item.id))));

  const entity = querySystemMap(map, { type: 'entity', entityId: 'module:billing', limit: 20 });
  assert.equal(entity.entities[0].id, 'module:billing');
  assert.ok(entity.relations.some((relation) => relation.kind === 'depends_on'));

  const neighbors = querySystemMap(map, { type: 'neighbors', entityId: 'module:billing', depth: 1, direction: 'outgoing', limit: 20 });
  assert.ok(neighbors.entities.some((item) => item.id === 'external:stripe'));
  const reverse = querySystemMap(map, { type: 'reverse-dependencies', entityId: 'module:billing', depth: 2, limit: 20 });
  assert.ok(reverse.entities.some((item) => item.id === 'module:server'));
  const path = querySystemMap(map, { type: 'path', entityId: 'entry:server', targetEntityId: 'external:stripe', direction: 'outgoing', depth: 6, limit: 20 });
  assert.deepEqual(path.entities.map((item) => item.id), ['entry:server', 'module:server', 'module:billing', 'external:stripe']);

  const evidenceId = map.evidence[0].id;
  assert.equal(querySystemMap(map, { type: 'evidence', evidenceIds: [evidenceId], limit: 1 }).evidence[0].id, evidenceId);
  assert.throws(() => querySystemMap(map, { type: 'neighbors', entityId: 'module:billing', depth: 99 }), (error) => error.code === 'INVALID_MAP_LIMIT');
  assert.throws(() => querySystemMap(map, { type: 'search', text: '' }), (error) => error.code === 'INVALID_MAP_QUERY');
});

test('snapshot comparison separates code, analyzer, observed evidence and changed inference', () => {
  const first = deriveSystemMap(richSnapshot());
  const same = compareSystemMaps(first, deriveSystemMap(richSnapshot()));
  assert.equal(same.noChange, true);
  assert.deepEqual(same.causes, []);

  const next = deriveSystemMap(richSnapshot({
    createdAt: '2026-08-03T13:00:00.000Z', analyzerVersion: '2.5.0', moved: true, freshness: 'stale',
  }));
  const diff = compareSystemMaps(first, next);
  assert.equal(diff.noChange, false);
  assert.ok(diff.causes.includes('code'));
  assert.ok(diff.causes.includes('analyzer'));
  assert.ok(diff.causes.includes('evidence'));
  assert.equal(diff.content.moved[0].from, 'src/billing/store.mjs');
  assert.equal(diff.content.moved[0].to, 'src/payments/store.mjs');
  assert.equal(diff.analyzer.from.version, '2.4.0');
  assert.equal(diff.analyzer.to.version, '2.5.0');
  assert.equal(diff.authority.accepted, false);
});

test('derived exports are labeled, bounded and never imply repository authority', () => {
  const map = deriveSystemMap(richSnapshot());
  const markdown = exportSystemMap(map, { format: 'markdown' });
  assert.equal(markdown.mediaType, 'text/markdown');
  assert.match(markdown.content, /derived analysis/i);
  assert.match(markdown.content, /not accepted repository planning truth/i);
  assert.match(markdown.filename, /\.md$/);
  const json = exportSystemMap(map, { format: 'json' });
  assert.equal(JSON.parse(json.content).authority.accepted, false);
  assert.throws(() => exportSystemMap(map, { format: 'xml' }), (error) => error.code === 'UNSUPPORTED_MAP_EXPORT');
  assert.throws(() => exportSystemMap(map, { format: 'json', maxBytes: 1_024 }), (error) => error.code === 'MAP_EXPORT_LIMIT');
});

test('large partial snapshots obey derivation/query budgets and cache immutable results', () => {
  const base = richSnapshot();
  const evidence = Array.from({ length: 900 }, (_, index) => ({
    id: `large-ev:${index}`, sourceKind: 'source', provenance: 'extracted', path: `src/generated-${index}.mjs`, revision: digest(`file:${index}`),
  }));
  const entities = Array.from({ length: 900 }, (_, index) => ({
    id: `large:${index}`, kind: index % 17 === 0 ? 'test' : 'module', name: `Generated ${index}`, location: { path: `src/generated-${index}.mjs` }, language: index % 3 === 0 ? 'JavaScript' : 'TypeScript', evidenceIds: [`large-ev:${index}`],
  }));
  const relations = Array.from({ length: 899 }, (_, index) => ({
    id: `large-rel:${index}`, source: `large:${index}`, target: `large:${index + 1}`, kind: 'imports', evidenceIds: [`large-ev:${index}`], confidence: 1,
  }));
  const snapshot = createAnalysisSnapshot({
    ...base,
    id: undefined,
    configurationDigest: undefined,
    configuration: { large: true },
    manifest: {
      ...base.manifest,
      digest: undefined,
      files: evidence.map((item, index) => ({ path: item.path, digest: digest(`file:${index}`), size: 10, source: 'tracked' })),
    },
    scope: { ...base.scope, included: evidence.map((item) => item.path), truncated: true },
    evidence,
    entities,
    relations,
    coverage: base.coverage.map((item) => ({ ...item, evidenceIds: [] })),
  });
  const runtime = new SystemMapRuntime({ limits: { maxEntities: 120, maxRelations: 100, maxEvidence: 120, maxGroups: 40, maxGroupMembers: 30 }, maxCached: 2 });
  const first = runtime.build(snapshot);
  const second = runtime.build(snapshot);
  assert.equal(first, second, 'cached immutable map should be reused by identity');
  assert.equal(first.counts.entities, 120);
  assert.equal(first.counts.relations, 100);
  assert.ok(first.counts.groups <= 40);
  assert.ok(first.diagnostics.some((item) => item.code === 'MAP_ENTITY_BUDGET'));
  assert.ok(first.diagnostics.some((item) => item.code === 'MAP_RELATION_BUDGET'));
  assert.equal(summarizeSystemMap(first).groups, undefined, 'public description must not return the full graph');
  assert.equal(runtime.query(snapshot, { type: 'overview', limit: 7 }).groups.length, 7);
  runtime.clear();
  assert.notEqual(runtime.build(snapshot), first);
});
