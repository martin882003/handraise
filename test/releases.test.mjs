import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ReleaseError,
  ReleaseStore,
  assessRelease,
  normalizeRelease,
  parseRelease,
  releaseRevision,
  renderRelease,
} from '../src/releases.mjs';

const digest = (character) => character.repeat(64);

function fronts(overrides = {}) {
  return [{
    slug: 'dogfood-core', title: 'Dogfood core', component: 'runtime-worktree-control',
    state: 'queued', schemaVersion: 2, revision: digest('a'), dependencies: [],
    ...overrides,
  }];
}

function release(overrides = {}) {
  return {
    slug: 'release-0', title: 'Release 0 — Dogfood core', version: '0.1.0',
    state: 'draft', targetBranch: 'main',
    outcome: 'Handraise can use Handraise to complete one bounded accepted front.',
    requirementIds: ['R0-RPL-02', 'R0-RUN-01'],
    fronts: [{ slug: 'dogfood-core', revision: digest('a') }],
    acceptanceCriteria: ['The complete journey is reproducible from the candidate artifact.'],
    verification: ['npm test', 'R0-T10'],
    compatibility: ['Node >=20', 'Git and tmux available'],
    limitations: ['Repository-local release only.'],
    ...overrides,
  };
}

function requirementEvidence(status = 'defined') {
  return Object.fromEntries(['R0-RPL-02', 'R0-RUN-01'].map((id, index) => [id, {
    accepted: true,
    tests: [{ id: `R0-T0${index + 3}`, status, sourceRevision: digest('c') }],
  }]));
}

test('release Markdown round-trips exact membership and preserves unknown human content', () => {
  const existing = [
    '---', 'schema: 1', 'slug: release-0', 'title: "Old release"', 'state: draft',
    'version: "0.0.1"', 'target_branch: main', 'created: 2026-08-01T00:00:00.000Z',
    'updated: 2026-08-01T00:00:00.000Z', 'owner_note: preserve-me', '---', '',
    '# Release — Old release', '', 'Human introduction.', '',
    '## Observable outcome', '', 'Old outcome.', '',
    '## Custom governance', '', 'This section is maintained by a human.', '',
  ].join('\n');
  const normalized = normalizeRelease(release(), { repositoryId: 'repo', now: Date.parse('2026-08-04T12:00:00.000Z') });
  const markdown = renderRelease(normalized, { existingMarkdown: existing });

  assert.match(markdown, /owner_note: preserve-me/);
  assert.match(markdown, /## Custom governance\n\nThis section is maintained by a human\./);
  assert.match(markdown, /- `dogfood-core` @ `a{64}`/);
  const parsed = parseRelease(markdown, { repositoryId: 'repo' });
  assert.equal(parsed.slug, 'release-0');
  assert.equal(parsed.targetBranch, 'main');
  assert.deepEqual(parsed.requirementIds, ['R0-RPL-02', 'R0-RUN-01']);
  assert.deepEqual(parsed.fronts, [{ slug: 'dogfood-core', revision: digest('a') }]);
  assert.equal(parsed.limitations[0], 'Repository-local release only.');
  assert.equal(releaseRevision(markdown), releaseRevision(markdown));
  assert.notEqual(releaseRevision(markdown), releaseRevision(`${markdown}\n`));
});

test('release validation rejects ambiguity before repository mutation', () => {
  assert.throws(() => normalizeRelease(release({ requirementIds: ['R0-X-01', 'R0-X-01'] })), /duplicate requirement/i);
  assert.throws(() => normalizeRelease(release({ fronts: [release().fronts[0], release().fronts[0]] })), /duplicate front/i);
  assert.throws(() => normalizeRelease(release({ fronts: [{ slug: 'dogfood-core', revision: 'moving' }] })), /revision/i);
  assert.throws(() => normalizeRelease(release({ state: 'done' })), /release state/i);
  assert.throws(() => normalizeRelease(release({ outcome: '' })), /outcome/i);
  assert.throws(() => parseRelease(renderRelease(normalizeRelease(release())).replace('schema: 1', 'schema: 2')), /unsupported release schema/i);
});

test('release store is optimistic, serialized and enforces one open release per front', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-release-store-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.handraise', 'fronts'), { recursive: true });
  const repository = { id: 'repo', name: 'Release fixture', path: root, adapter: 'handraise' };
  const store = new ReleaseStore({ now: () => Date.parse('2026-08-04T12:00:00.000Z') });

  const created = store.create(repository, release(), { fronts: fronts() });
  const path = join(root, '.handraise', 'releases', 'release-0.md');
  assert.equal(existsSync(path), true);
  assert.equal(store.list(repository).length, 1);
  assert.equal(created.revision, releaseRevision(readFileSync(path, 'utf8')));
  assert.throws(() => store.create(repository, release({ slug: 'release-next', title: 'Release next' }), { fronts: fronts() }), /already belongs to open release 'release-0'/i);

  const beforeConflict = readFileSync(path, 'utf8');
  assert.throws(() => store.update(repository, 'release-0', { title: 'Changed' }, {
    expectedRevision: digest('f'), fronts: fronts(),
  }), (error) => error instanceof ReleaseError && error.code === 'RELEASE_BASELINE_CHANGED');
  assert.equal(readFileSync(path, 'utf8'), beforeConflict);

  const updated = store.update(repository, 'release-0', { title: 'Release 0 candidate' }, {
    expectedRevision: created.revision, fronts: fronts(),
  });
  assert.equal(updated.title, 'Release 0 candidate');
  assert.notEqual(updated.revision, created.revision);

  mkdirSync(join(root, '.handraise', '.management-lock'));
  assert.throws(() => store.update(repository, 'release-0', { title: 'Blocked update' }, {
    expectedRevision: updated.revision, fronts: fronts(),
  }), /another Handraise project update/i);
  assert.equal(store.get(repository, 'release-0').title, 'Release 0 candidate');
});

test('readiness and lifecycle separate defined tests, passing evidence and exact candidate identity', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-release-lifecycle-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.handraise'), { recursive: true });
  const repository = { id: 'repo', name: 'Lifecycle fixture', path: root, adapter: 'handraise' };
  const store = new ReleaseStore({ now: () => Date.parse('2026-08-04T12:00:00.000Z') });
  let current = store.create(repository, release(), { fronts: fronts() });

  const structurallyReady = assessRelease(current, {
    fronts: fronts(), requirementEvidence: requirementEvidence('defined'), phase: 'ready',
  });
  assert.equal(structurallyReady.ready, true);
  current = store.transition(repository, current.slug, 'ready', {
    expectedRevision: current.revision, fronts: fronts(), requirementEvidence: requirementEvidence('defined'),
  });
  current = store.transition(repository, current.slug, 'active', {
    expectedRevision: current.revision, fronts: fronts(), requirementEvidence: requirementEvidence('defined'),
  });

  const notCandidate = assessRelease(current, {
    fronts: fronts(), requirementEvidence: requirementEvidence('passed'), phase: 'candidate',
    priorGates: [{ id: 'release--1', status: 'passed', sourceRevision: digest('c') }],
  });
  assert.equal(notCandidate.ready, false);
  assert.ok(notCandidate.blockers.some((item) => item.code === 'FRONT_NOT_DONE'));

  const doneFronts = fronts({ state: 'done' });
  const skipped = assessRelease(current, {
    fronts: doneFronts, requirementEvidence: requirementEvidence('skipped'), phase: 'candidate',
    priorGates: [{ id: 'release--1', status: 'passed', sourceRevision: digest('c') }],
  });
  assert.ok(skipped.blockers.some((item) => item.code === 'REQUIRED_TEST_NOT_PASSED'));

  const candidateEvidence = {
    sourceRevision: '1'.repeat(40), contractRevision: current.revision,
    artifactDigest: digest('d'), artifact: 'handraise-0.1.0.tgz',
    toolVersions: { node: '24.13.1', handraise: '0.1.0' },
    measurementProfile: 'linux-4cpu-8gib-ssd', measuredAt: '2026-08-04T12:30:00.000Z',
  };
  const candidateReady = assessRelease(current, {
    fronts: doneFronts, requirementEvidence: requirementEvidence('passed'), phase: 'candidate',
    priorGates: [{ id: 'release--1', status: 'passed', sourceRevision: '1'.repeat(40) }], candidateEvidence,
  });
  assert.equal(candidateReady.ready, true);
  current = store.transition(repository, current.slug, 'candidate', {
    expectedRevision: current.revision, fronts: doneFronts,
    requirementEvidence: requirementEvidence('passed'),
    priorGates: [{ id: 'release--1', status: 'passed', sourceRevision: '1'.repeat(40) }],
    candidateEvidence,
  });
  assert.equal(current.candidate.artifactDigest, digest('d'));
  current = store.transition(repository, current.slug, 'released', {
    expectedRevision: current.revision, fronts: doneFronts,
    requirementEvidence: requirementEvidence('passed'),
    priorGates: [{ id: 'release--1', status: 'passed', sourceRevision: '1'.repeat(40) }],
  });
  assert.equal(current.state, 'released');
  assert.throws(() => store.transition(repository, current.slug, 'active', {
    expectedRevision: current.revision, fronts: doneFronts,
  }), /illegal release transition/i);
});

test('Director release mutation is explicitly unavailable', () => {
  const repository = { id: 'director', name: 'Director', path: '/tmp/director', adapter: 'director' };
  const store = new ReleaseStore();
  assert.deepEqual(store.list(repository), []);
  assert.throws(() => store.create(repository, release(), { fronts: fronts() }), /Director releases are read-only/i);
});
