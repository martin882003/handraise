import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  ANALYSIS_SCHEMA_VERSION,
  IntelligenceError,
  createAnalysisSnapshot,
  createContentManifest,
  intelligenceFailure,
  parseAnalysisSnapshot,
  serializeAnalysisSnapshot,
  validateAnalysisDiff,
  validateAnalysisJob,
  validateAnalysisProgress,
  validateAnalysisSnapshot,
  validateAnalyzerAdapter,
  validateAnalyzerDescriptor,
  validateGraphQuery,
} from '../src/intelligence/contracts.mjs';
import { createSnapshotQuery, queryAnalysisSnapshot } from '../src/intelligence/memory-query.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

const analyzer = (overrides = {}) => ({
  id: 'fixture-structural',
  name: 'Fixture structural analyzer',
  version: '1.2.3',
  contractVersion: ANALYSIS_SCHEMA_VERSION,
  capabilities: {
    languages: ['JavaScript'],
    entityKinds: ['file', 'module', 'function'],
    relationKinds: ['imports', 'calls'],
    queries: ['entity', 'search', 'neighbors', 'path', 'evidence'],
    history: false,
    semantic: false,
    incremental: false,
  },
  privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
  ...overrides,
});

function snapshotInput(overrides = {}) {
  return {
    repository: { id: 'fixture-repository', adapter: 'handraise' },
    createdAt: '2026-08-03T12:00:00.000Z',
    analyzer: analyzer(),
    configuration: { exclusions: ['dist/**'], maxFiles: 2000 },
    status: 'partial',
    freshness: { state: 'current', checkedAt: '2026-08-03T12:00:00.000Z' },
    manifest: {
      files: [
        { path: 'src/c.mjs', digest: digest('c'), size: 3, source: 'untracked' },
        { path: 'src/a.mjs', digest: digest('a'), size: 1, source: 'tracked', executable: false },
        { path: 'src/b.mjs', digest: digest('b'), size: 2, source: 'tracked' },
      ],
      git: { head: digest('head').slice(0, 40), branch: 'main', dirty: true, indexDigest: digest('index') },
      selection: { includeUntracked: true, includeIgnored: false, exclusions: ['.git/**', 'dist/**'] },
    },
    scope: {
      included: ['src/**'],
      excluded: [{ pattern: 'dist/**', reason: 'Generated output is excluded.' }],
      truncated: false,
      limits: { maxFiles: 2000, maxBytes: 1000000 },
    },
    evidence: [
      { id: 'ev:a', sourceKind: 'source', provenance: 'extracted', path: 'src/a.mjs', range: { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } }, excerptHash: digest('a excerpt') },
      { id: 'ev:b', sourceKind: 'source', provenance: 'extracted', path: 'src/b.mjs', range: { start: { line: 1, column: 1 } } },
      { id: 'ev:c', sourceKind: 'source', provenance: 'inferred', path: 'src/c.mjs', summary: 'An untracked entry point candidate.' },
    ],
    entities: [
      { id: 'module:a', kind: 'module', name: 'A', language: 'JavaScript', location: { path: 'src/a.mjs' }, evidenceIds: ['ev:a'] },
      { id: 'module:b', kind: 'module', name: 'B', language: 'JavaScript', location: { path: 'src/b.mjs' }, evidenceIds: ['ev:b'] },
      { id: 'module:c', kind: 'module', name: 'C', language: 'JavaScript', location: { path: 'src/c.mjs' }, evidenceIds: ['ev:c'] },
    ],
    relations: [
      { id: 'rel:a-b', source: 'module:a', target: 'module:b', kind: 'imports', evidenceIds: ['ev:a'], confidence: 1 },
      { id: 'rel:b-c', source: 'module:b', target: 'module:c', kind: 'calls', evidenceIds: ['ev:b'], confidence: 0.7 },
    ],
    findings: [{
      id: 'finding:entry', kind: 'entry-point-candidate', summary: 'C may be an entry point.',
      evidenceIds: ['ev:c'], entityIds: ['module:c'],
      uncertainty: { level: 'medium', reasons: ['The file is untracked and has no manifest declaration.'] },
      alternatives: [{ summary: 'C may instead be a test fixture.', evidenceIds: ['ev:c'] }],
    }],
    coverage: [
      { id: 'coverage:js', subject: 'JavaScript', status: 'covered', summary: 'Static module relations are available.', evidenceIds: ['ev:a'] },
      { id: 'coverage:sql', subject: 'SQL', status: 'unsupported', summary: 'The adapter has no SQL parser.', evidenceIds: [] },
    ],
    diagnostics: [{ code: 'PARTIAL_LANGUAGE', severity: 'warning', message: 'SQL is not covered by this adapter.' }],
    ...overrides,
  };
}

test('repository intelligence snapshots have stable identity, exact dirty scope and immutable round trips', () => {
  const first = createAnalysisSnapshot(snapshotInput());
  const reordered = snapshotInput({ configuration: { maxFiles: 2000, exclusions: ['dist/**'] } });
  reordered.manifest.files.reverse();
  const second = createAnalysisSnapshot(reordered);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.id, second.id, 'file/config key order does not alter snapshot identity');
  assert.equal(first.manifest.git.dirty, true);
  assert.equal(first.manifest.counts.untracked, 1);
  assert.deepEqual(first.manifest.files.map((file) => file.path), ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
  assert.equal(first.status, 'partial');
  assert.equal(first.coverage.find((item) => item.id === 'coverage:sql').status, 'unsupported');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entities), true);
  assert.throws(() => { first.entities.push({}); }, TypeError);

  const serialized = serializeAnalysisSnapshot(first);
  const parsed = parseAnalysisSnapshot(serialized);
  assert.deepEqual(parsed, first);
  assert.equal(parsed.id, first.id);

  const changed = snapshotInput();
  changed.manifest.files[0].digest = digest('changed c');
  assert.notEqual(createAnalysisSnapshot(changed).id, first.id);
});

test('manifest and snapshot validation reject unsafe paths, stale identities, bad references and incompatible schemas', () => {
  assert.throws(() => createContentManifest({ files: [{ path: '../secret', digest: digest('x'), size: 1 }] }), /safe repository-relative path/);
  assert.throws(() => validateAnalyzerDescriptor(analyzer({
    privacy: { localOnly: false, modelAssisted: true, sourceMayLeaveHost: true, requiresConsent: false },
  })), /requiresConsent/);
  assert.throws(() => validateAnalyzerDescriptor(analyzer({ contractVersion: 2 })), (error) => error.code === 'INCOMPATIBLE_SCHEMA');

  const unknownTarget = snapshotInput();
  unknownTarget.relations[0].target = 'module:missing';
  assert.throws(() => createAnalysisSnapshot(unknownTarget), /unknown entity/);

  const unknownEvidence = snapshotInput();
  unknownEvidence.findings[0].evidenceIds = ['ev:missing'];
  assert.throws(() => createAnalysisSnapshot(unknownEvidence), /unknown 'ev:missing'/);

  const stable = createAnalysisSnapshot(snapshotInput());
  const tampered = structuredClone(stable);
  tampered.id = digest('wrong identity');
  assert.throws(() => validateAnalysisSnapshot(tampered), (error) => error.code === 'SNAPSHOT_IDENTITY_MISMATCH');

  const future = structuredClone(stable);
  future.schemaVersion = 2;
  assert.throws(() => validateAnalysisSnapshot(future), (error) => error.code === 'INCOMPATIBLE_SCHEMA');
  assert.throws(() => parseAnalysisSnapshot('{broken'), (error) => error.code === 'INVALID_JSON');
});

test('adapter, job, progress and diff contracts expose bounded typed lifecycle behavior', () => {
  const descriptor = analyzer();
  const adapter = validateAnalyzerAdapter({
    descriptor,
    detect() { return { available: true }; },
    plan() { return { files: 3 }; },
    analyze() { return createAnalysisSnapshot(snapshotInput()); },
    query() { return null; },
    dispose() {},
  });
  assert.equal(adapter.descriptor.id, descriptor.id);
  assert.throws(() => validateAnalyzerAdapter({ descriptor, detect() {}, plan() {}, analyze() {}, dispose() {} }), /adapter.query/);
  assert.throws(() => validateAnalyzerAdapter({
    descriptor: analyzer({ capabilities: { ...descriptor.capabilities, incremental: true } }),
    detect() {}, plan() {}, analyze() {}, query() {}, dispose() {},
  }), /adapter.diff/);

  const job = validateAnalysisJob({
    id: 'job:1', repositoryId: 'fixture-repository', analyzerId: descriptor.id, state: 'running',
    createdAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-03T12:00:01.000Z', progress: 0.25,
    stage: 'parse', message: 'Parsing selected files.',
  });
  assert.equal(job.state, 'running');
  assert.throws(() => validateAnalysisJob({ ...job, state: 'invented' }), /must be one of/);
  assert.throws(() => validateAnalysisJob({ ...job, updatedAt: '2026-08-03T11:59:59.000Z' }), /precedes createdAt/);

  assert.deepEqual(validateAnalysisProgress({
    jobId: job.id, state: 'running', stage: 'parse', at: job.updatedAt, completed: 2, total: 4,
  }).completed, 2);
  assert.throws(() => validateAnalysisProgress({
    jobId: job.id, state: 'running', stage: 'parse', at: job.updatedAt, completed: 5, total: 4,
  }), /cannot exceed total/);

  const snapshot = createAnalysisSnapshot(snapshotInput());
  const diff = validateAnalysisDiff({
    schemaVersion: 1, fromSnapshotId: snapshot.id, toSnapshotId: digest('next'), cause: 'content',
    entities: { added: ['module:d'], removed: [], changed: ['module:a'] },
    relations: {}, evidence: {}, diagnostics: [],
  });
  assert.equal(diff.cause, 'content');

  const abort = new Error('stop');
  abort.name = 'AbortError';
  assert.equal(intelligenceFailure(abort).code, 'CANCELLED');
  assert.equal(intelligenceFailure(new IntelligenceError('TIMEOUT', 'too slow')).code, 'TIMEOUT');
});

test('provider-neutral snapshot queries navigate entities, evidence, neighborhoods and bounded paths', () => {
  const snapshot = createAnalysisSnapshot(snapshotInput());
  const graph = createSnapshotQuery(snapshot);

  const search = graph.query({ type: 'search', text: 'src/b', limit: 10 });
  assert.deepEqual(search.entities.map((entity) => entity.id), ['module:b']);
  assert.deepEqual(search.evidence.map((item) => item.id), ['ev:b']);

  const neighbors = graph.query({ type: 'neighbors', entityId: 'module:a', direction: 'outgoing', depth: 2, limit: 10 });
  assert.deepEqual(neighbors.entities.map((entity) => entity.id), ['module:a', 'module:b', 'module:c']);
  assert.deepEqual(neighbors.relations.map((relation) => relation.id), ['rel:a-b', 'rel:b-c']);

  const path = queryAnalysisSnapshot(snapshot, {
    type: 'path', snapshotId: snapshot.id, entityId: 'module:a', targetEntityId: 'module:c', direction: 'outgoing', depth: 4, limit: 10,
  });
  assert.deepEqual(path.entities.map((entity) => entity.id), ['module:a', 'module:b', 'module:c']);
  assert.deepEqual(path.relations.map((relation) => relation.id), ['rel:a-b', 'rel:b-c']);

  const evidence = graph.query({ type: 'evidence', evidenceIds: ['ev:a', 'ev:missing'], limit: 10 });
  assert.deepEqual(evidence.evidence.map((item) => item.id), ['ev:a']);
  assert.equal(evidence.diagnostics[0].code, 'EVIDENCE_NOT_FOUND');

  const missing = graph.query({ type: 'entity', entityId: 'module:missing', limit: 10 });
  assert.equal(missing.diagnostics[0].code, 'ENTITY_NOT_FOUND');
  assert.throws(() => validateGraphQuery({ type: 'search', snapshotId: snapshot.id, text: 'x', limit: 501 }), /at most|between/);
  assert.throws(() => queryAnalysisSnapshot(snapshot, { type: 'entity', snapshotId: digest('other'), entityId: 'module:a', limit: 1 }), /does not match/);
});
