import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  COMPONENT_DESIGN_FIELDS,
  ComponentDesignDraftStore,
  evaluateArchitectureAlternative,
  synthesizeArchitectureAlternatives,
} from '../src/component-design.mjs';
import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { deriveSystemMap } from '../src/intelligence/system-map.mjs';
import { normalizeProductBrief } from '../src/product-direction.mjs';
import { createComponentMarkdown, parseComponentContract } from '../src/work-contracts.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function snapshotFixture({ freshness = 'current', status = 'complete', createdAt = '2026-08-03T12:00:00.000Z' } = {}) {
  const files = [
    'Dockerfile', 'src/server.mjs', 'src/auth/service.mjs', 'src/auth/routes.mjs',
    'src/billing/service.mjs', 'src/billing/store.mjs', 'src/billing/schema.sql', 'test/billing.test.mjs',
  ];
  const evidence = files.map((path, index) => ({
    id: `ev:${index + 1}`, sourceKind: 'source', provenance: 'extracted', path,
    revision: digest(path), summary: `Observed responsibility evidence in ${path}.`,
  }));
  const entities = [
    { id: 'deploy:server', kind: 'service', name: 'Server deployable', location: { path: 'Dockerfile' }, evidenceIds: ['ev:1'], attributes: { community: 'runtime' } },
    { id: 'module:server', kind: 'module', name: 'HTTP server', location: { path: 'src/server.mjs' }, evidenceIds: ['ev:2'], attributes: { community: 'runtime' } },
    { id: 'module:auth', kind: 'module', name: 'Authentication', location: { path: 'src/auth/service.mjs' }, evidenceIds: ['ev:3'], attributes: { community: 'identity' } },
    { id: 'route:auth', kind: 'route', name: 'Authentication API', location: { path: 'src/auth/routes.mjs' }, evidenceIds: ['ev:4'], attributes: { community: 'identity' } },
    { id: 'module:billing', kind: 'module', name: 'Billing', location: { path: 'src/billing/service.mjs' }, evidenceIds: ['ev:5'], attributes: { community: 'billing' } },
    { id: 'store:billing', kind: 'repository', name: 'Billing store', location: { path: 'src/billing/store.mjs' }, evidenceIds: ['ev:6'], attributes: { community: 'billing' } },
    { id: 'db:billing', kind: 'database', name: 'Billing database', location: { path: 'src/billing/schema.sql' }, evidenceIds: ['ev:7'], attributes: { community: 'billing' } },
    { id: 'test:billing', kind: 'test', name: 'Billing tests', location: { path: 'test/billing.test.mjs' }, evidenceIds: ['ev:8'], attributes: { community: 'verification' } },
    { id: 'external:stripe', kind: 'external-service', name: 'Stripe API', evidenceIds: [] },
  ];
  const relations = [
    ['rel:1', 'deploy:server', 'module:server', 'contains'],
    ['rel:2', 'module:server', 'module:auth', 'imports'],
    ['rel:3', 'module:auth', 'route:auth', 'provides'],
    ['rel:4', 'module:server', 'module:billing', 'calls'],
    ['rel:5', 'module:billing', 'store:billing', 'calls'],
    ['rel:6', 'store:billing', 'db:billing', 'writes'],
    ['rel:7', 'module:billing', 'external:stripe', 'depends_on'],
    ['rel:8', 'test:billing', 'module:billing', 'tests'],
  ].map(([id, source, target, kind], index) => ({ id, source, target, kind, confidence: .9, evidenceIds: [`ev:${index + 1}`] }));
  return createAnalysisSnapshot({
    repository: { id: 'repo:fixture', adapter: 'handraise' }, createdAt,
    analyzer: {
      id: 'fixture-semantic', name: 'Fixture semantic analyzer', version: '1.0.0', contractVersion: 1,
      capabilities: {
        languages: ['JavaScript', 'SQL'], entityKinds: [...new Set(entities.map((item) => item.kind))],
        relationKinds: [...new Set(relations.map((item) => item.kind))],
        queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: true, semantic: true, incremental: false,
      },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: { fixture: true }, status,
    freshness: { state: freshness, checkedAt: createdAt, ...(freshness === 'current' ? {} : { reason: 'Repository changed.' }) },
    manifest: {
      files: files.map((path) => ({ path, digest: digest(path), size: path.length * 10, source: 'tracked' })),
      git: { head: digest('head').slice(0, 40), branch: 'main', dirty: false },
      selection: { includeUntracked: false, includeIgnored: false, exclusions: ['node_modules/**'] },
    },
    scope: { included: files, excluded: [], truncated: false, limits: { maxFiles: 10_000 } },
    evidence, entities, relations, findings: [],
    coverage: [
      { id: 'coverage:js', subject: 'JavaScript', status: 'covered', summary: 'JavaScript parsed.', evidenceIds: [] },
      { id: 'coverage:sql', subject: 'SQL', status: 'covered', summary: 'SQL parsed.', evidenceIds: ['ev:7'] },
    ],
    diagnostics: [],
  });
}

function productFixture({ purpose = 'Understand the system. Design the work. Run the agents.' } = {}) {
  const brief = normalizeProductBrief({
    title: 'Handraise',
    purpose: { id: 'purpose', text: purpose, sourceIds: ['source:human'], locked: true },
    users: [{ id: 'user:lead', text: 'Technical leads organizing parallel agent work.', sourceIds: ['source:human'] }],
    outcomes: [{ id: 'outcome:boundaries', text: 'Humans review durable responsibility boundaries before work begins.', sourceIds: ['source:human'], locked: true }],
    constraints: [{ id: 'constraint:no-write', text: 'Never mutate planning files before explicit acceptance.', sourceIds: ['source:human'], locked: true }],
    invariants: [{ id: 'invariant:evidence', text: 'Every generated claim remains traceable to evidence or uncertainty.', sourceIds: ['source:human'], locked: true }],
    goals: [{ id: 'goal:architecture', title: 'Design architecture', outcome: 'Produce reviewable components.', priority: 'now', state: 'active', successSignals: ['Gate C'], sourceIds: ['source:human'] }],
  }, { repositoryId: 'repo:fixture', now: Date.parse('2026-08-03T12:00:00.000Z') });
  return { exists: true, revision: digest(JSON.stringify(brief)), brief };
}

function acceptedComponent() {
  return {
    schemaVersion: 2, slug: 'legacy-control', title: 'Legacy Control', state: 'active', order: 1,
    contract: {
      purpose: 'Preserve the currently accepted runtime control boundary.',
      outcomes: ['Existing control remains operable.'], responsibilities: ['Own current HTTP control.'],
      limits: ['Does not own product planning.'], invariants: ['Authenticate every remote mutation.'],
      interfaces: [{ kind: 'provides', target: 'HTTP API', description: 'Authenticated control API.' }],
      dependencies: [], dataSystems: ['Private host state'], territory: ['src/server.mjs'],
      verification: ['Run server API tests.'],
      evidence: [{ kind: 'declared', reference: 'ev:2', reason: 'Accepted owner points to the server module.' }],
      uncertainties: ['Its responsibility may be too broad.'], guidance: 'Preserve accepted behavior until replacement is published.',
    },
  };
}

function planningResult() {
  return {
    schemaVersion: 1, operation: 'component-design', summary: 'Model synthesis proposes identity and commerce boundaries.',
    components: [
      {
        slug: 'identity-access', title: 'Identity Access', responsibility: 'Own authentication and access policy.',
        outcomes: ['Remote access stays safe.'], responsibilities: ['Authenticate clients.'], limits: ['No billing policy.'],
        invariants: ['Never trust forwarded host identity.'], interfaces: ['Authentication API'], dependencies: [],
        dataSystems: ['Paired device state'], territory: ['src/auth/service.mjs', 'src/auth/routes.mjs'], verification: ['Run auth tests.'],
        evidenceIds: ['ev:3', 'ev:4'], uncertainty: 'low', assumptions: [], questions: [],
      },
      {
        slug: 'commerce', title: 'Commerce', responsibility: 'Own billing workflows and persisted billing state.',
        outcomes: ['Billing changes have one owner.'], responsibilities: ['Coordinate billing and Stripe.'], limits: ['No authentication policy.'],
        invariants: ['Billing writes remain testable.'], interfaces: ['Billing service'], dependencies: ['identity-access'],
        dataSystems: ['Billing database', 'Stripe API'], territory: ['src/billing/service.mjs', 'src/billing/store.mjs', 'src/billing/schema.sql'], verification: ['Run billing tests.'],
        evidenceIds: ['ev:5', 'ev:6', 'ev:7'], uncertainty: 'medium', assumptions: ['Identity may be a soft dependency.'], questions: [],
      },
    ],
    fronts: [], findings: [], assumptions: [], questions: [],
  };
}

function contextFixture({ product = productFixture(), portfolio = { components: [acceptedComponent()], fronts: [] }, model = true, snapshot = snapshotFixture() } = {}) {
  const map = deriveSystemMap(snapshot);
  return {
    analysisJobId: 'analysis:fixture', planningJobId: model ? 'planning:fixture' : null,
    snapshot, map, product, portfolio,
    planningResult: model ? planningResult() : null,
    modelEvidenceIds: map.evidence.map((item) => item.id),
  };
}

function privateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'handraise-component-design-'));
  const repositoryPath = join(root, 'repository');
  mkdirSync(repositoryPath);
  writeFileSync(join(repositoryPath, 'sentinel.txt'), 'must remain unchanged\n');
  return { root, repositoryPath, draftRoot: join(root, 'private', 'component-design') };
}

function operation(store, draft, payload, context = null) {
  return store.apply(draft.repositoryId, draft.id, { ...payload, expectedRevision: draft.revision }, { context });
}

test('synthesis is stable, product-aware, materially alternative and complete at the v2 boundary', () => {
  const context = contextFixture();
  const first = synthesizeArchitectureAlternatives(context);
  const second = synthesizeArchitectureAlternatives(context);
  assert.deepEqual(first.alternatives, second.alternatives);
  assert.ok(first.alternatives.some((item) => item.strategy === 'responsibility'));
  assert.ok(first.alternatives.some((item) => item.strategy === 'hybrid'));
  assert.ok(first.alternatives.some((item) => item.strategy === 'existing'));
  assert.ok(first.alternatives.some((item) => item.strategy === 'model'));
  const signatures = new Set(first.alternatives.map((alternative) => JSON.stringify(alternative.components.map((component) => component.memberEntityIds.slice().sort()))));
  assert.equal(signatures.size, first.alternatives.length, 'non-distinct alternatives must be collapsed');
  assert.ok(first.alternatives.flatMap((item) => item.components).some((component) => component.contract.purpose.includes(context.product.brief.purpose.text)));

  const references = new Set([context.map.id, context.snapshot.id, ...context.map.evidence.map((item) => item.id), ...context.map.groups.map((item) => item.id)]);
  const intentIds = new Set(['purpose', ...['users', 'outcomes', 'constraints', 'invariants', 'goals'].flatMap((key) => context.product.brief[key].map((item) => item.id))]);
  for (const alternative of first.alternatives) {
    assert.ok('coverage' in alternative.quality && 'overlap' in alternative.quality && 'cohesion' in alternative.quality);
    assert.ok('coupling' in alternative.quality && 'dependencyCycles' in alternative.quality && 'unstableBoundaries' in alternative.quality);
    for (const component of alternative.components) {
      const parsed = parseComponentContract(createComponentMarkdown(component, { since: '2026-08-03' }));
      assert.equal(parsed.schemaVersion, 2);
      assert.equal(parsed.slug, component.slug);
      assert.deepEqual(Object.keys(component.fieldGrounding).sort(), [...COMPONENT_DESIGN_FIELDS].sort());
      for (const grounding of Object.values(component.fieldGrounding)) {
        assert.ok(grounding.evidenceIds.length || grounding.intentIds.length || grounding.assumptions.length || grounding.questions.length);
        assert.ok(grounding.evidenceIds.every((id) => references.has(id)));
        assert.ok(grounding.intentIds.every((id) => intentIds.has(id)));
      }
    }
  }
  assert.ok(first.alternatives.some((item) => item.quality.gateC.pass), 'the benchmark fixture should produce at least one Gate C candidate');
});

test('private drafts are permission-bounded, omit validation catalogs and never mutate the repository', () => {
  const fixture = privateFixture();
  const before = readFileSync(join(fixture.repositoryPath, 'sentinel.txt'), 'utf8');
  const store = new ComponentDesignDraftStore({ root: fixture.draftRoot });
  const draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, contextFixture());
  assert.equal(statSync(fixture.draftRoot).mode & 0o777, 0o700);
  const files = readdirSync(fixture.draftRoot);
  assert.equal(files.length, 1);
  assert.equal(statSync(join(fixture.draftRoot, files[0])).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(fixture.repositoryPath, 'sentinel.txt'), 'utf8'), before);
  assert.equal(draft.mutation.repository, false);
  assert.equal(draft.mutation.publicationAvailableHere, false);
  assert.ok(!Object.hasOwn(draft.source, 'references'));
  assert.ok(!Object.hasOwn(draft.source, 'intentIds'));
  assert.ok(!Object.hasOwn(draft.source, 'entityIds'));
  assert.ok(Object.isFrozen(draft));
});

test('the review workspace supports lock/edit/reorder/split/merge/add/delete/compare/skip with revision conflicts', () => {
  const fixture = privateFixture();
  const context = contextFixture({ portfolio: { components: [], fronts: [] }, model: false });
  const store = new ComponentDesignDraftStore({ root: fixture.draftRoot });
  let draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: false });
  let selected = draft.alternatives.find((item) => item.strategy === 'responsibility');
  draft = operation(store, draft, { operation: 'select-alternative', alternativeId: selected.id }, context);
  selected = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  let component = selected.components.find((item) => item.memberEntityIds.length >= 2);
  assert.ok(component, 'fixture needs a splittable component');

  draft = operation(store, draft, { operation: 'lock-field', componentId: component.id, field: 'purpose', reason: 'Reviewed boundary.' }, context);
  assert.throws(() => operation(store, draft, {
    operation: 'edit-component', componentId: component.id,
    updates: { contract: { purpose: 'A forbidden locked edit.' } },
  }, context), (error) => error.code === 'LOCKED_COMPONENT_FIELD');
  draft = operation(store, draft, { operation: 'unlock-field', componentId: component.id, field: 'purpose' }, context);
  draft = operation(store, draft, {
    operation: 'edit-component', componentId: component.id,
    updates: { contract: { purpose: 'A human-reviewed responsibility boundary.' } },
  }, context);
  selected = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  component = selected.components.find((item) => item.id === component.id);
  assert.equal(component.contract.purpose, 'A human-reviewed responsibility boundary.');
  assert.match(component.fieldGrounding.purpose.assumptions[0], /Human-edited/);

  const reversed = selected.components.map((item) => item.id).reverse();
  draft = operation(store, draft, { operation: 'reorder-components', componentIds: reversed }, context);
  assert.deepEqual(draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).components.map((item) => item.id), reversed);

  selected = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  component = selected.components.find((item) => item.memberEntityIds.length >= 2);
  const pivot = Math.ceil(component.memberEntityIds.length / 2);
  const firstMembers = component.memberEntityIds.slice(0, pivot);
  const secondMembers = component.memberEntityIds.slice(pivot);
  assert.throws(() => operation(store, draft, {
    operation: 'split-component', componentId: component.id,
    first: { slug: 'split-first', title: 'Split First', memberEntityIds: firstMembers },
    second: { slug: 'split-second', title: 'Split Second', memberEntityIds: secondMembers.slice(1) },
  }, context), (error) => error.code === 'INVALID_COMPONENT_SPLIT');
  draft = operation(store, draft, {
    operation: 'split-component', componentId: component.id,
    first: { slug: 'split-first', title: 'Split First', memberEntityIds: firstMembers },
    second: { slug: 'split-second', title: 'Split Second', memberEntityIds: secondMembers },
  }, context);
  selected = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  const split = selected.components.filter((item) => ['split-first', 'split-second'].includes(item.slug));
  assert.equal(split.length, 2);
  draft = operation(store, draft, {
    operation: 'merge-components', componentIds: split.map((item) => item.id),
    component: { slug: 'merged-boundary', title: 'Merged Boundary', purpose: 'Own the reviewed merged responsibility.' },
  }, context);
  assert.ok(draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).components.some((item) => item.slug === 'merged-boundary'));

  selected = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  const template = clone(selected.components[0]);
  template.id = 'manual:candidate'; template.slug = 'manual-boundary'; template.title = 'Manual Boundary'; template.memberEntityIds = [];
  draft = operation(store, draft, { operation: 'add-component', component: template }, context);
  selected = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  const manual = selected.components.find((item) => item.slug === 'manual-boundary');
  assert.equal(manual.origin, 'manual');
  const comparison = store.compare(draft.repositoryId, draft.id, draft.alternatives[0].id, draft.alternatives[1].id);
  assert.equal(comparison.materiallyDifferent, true);
  draft = operation(store, draft, { operation: 'delete-component', componentId: manual.id }, context);
  draft = operation(store, draft, { operation: 'skip' }, context);
  assert.equal(draft.state, 'skipped');
  draft = operation(store, draft, { operation: 'resume' }, context);
  assert.equal(draft.state, 'review');
  assert.throws(() => store.apply(draft.repositoryId, draft.id, {
    operation: 'skip', expectedRevision: '0'.repeat(64),
  }, { context }), (error) => error.code === 'COMPONENT_DESIGN_REVISION_CONFLICT');
});

test('focused answers and locked decisions survive stable regeneration', () => {
  const fixture = privateFixture();
  const context = contextFixture({ portfolio: { components: [], fronts: [] }, model: false });
  const store = new ComponentDesignDraftStore({ root: fixture.draftRoot });
  let draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: false });
  const boundaryQuestion = draft.questions.find((item) => item.id === 'question:boundary-axis');
  assert.ok(boundaryQuestion);
  draft = operation(store, draft, {
    operation: 'answer-question', questionId: boundaryQuestion.id,
    answer: 'Runtime and deployable ownership should dominate this repository.',
  }, context);
  assert.equal(draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).strategy, 'hybrid');
  let component = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).components[0];
  draft = operation(store, draft, { operation: 'lock-field', componentId: component.id, field: 'guidance', reason: 'Human-approved delegation.' }, context);
  component = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).components.find((item) => item.id === component.id);
  const lockedGuidance = component.contract.guidance;
  const namesBefore = draft.alternatives.map((item) => [item.strategy, item.components.map((candidate) => candidate.slug)]);
  draft = operation(store, draft, { operation: 'regenerate', includeModel: false }, context);
  const namesAfter = draft.alternatives.map((item) => [item.strategy, item.components.map((candidate) => candidate.slug)]);
  assert.deepEqual(namesAfter, namesBefore);
  assert.equal(draft.questions.find((item) => item.id === boundaryQuestion.id).answer, 'Runtime and deployable ownership should dominate this repository.');
  const regenerated = draft.alternatives.find((item) => item.strategy === 'hybrid').components.find((item) => item.slug === component.slug);
  assert.equal(regenerated.contract.guidance, lockedGuidance);
  assert.ok(regenerated.lockedFields.includes('guidance'));
  const regeneration = draft.history.at(-1);
  assert.equal(regeneration.operation, 'regenerate');
  assert.ok(regeneration.details.materialChanges > 0);
  assert.equal(regeneration.details.preservedLocks, 1);
  assert.equal(regeneration.details.preservedAnswers, 1);
});

test('a no-op regeneration preserves names and reports no material boundary change', () => {
  const fixture = privateFixture();
  const context = contextFixture({ portfolio: { components: [], fronts: [] }, model: false });
  const store = new ComponentDesignDraftStore({ root: fixture.draftRoot });
  let draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: false });
  const before = draft.alternatives.map((alternative) => ({
    strategy: alternative.strategy,
    components: alternative.components.map((component) => ({ slug: component.slug, order: component.order, members: component.memberEntityIds })),
  }));
  draft = operation(store, draft, { operation: 'regenerate', includeModel: false }, context);
  const after = draft.alternatives.map((alternative) => ({
    strategy: alternative.strategy,
    components: alternative.components.map((component) => ({ slug: component.slug, order: component.order, members: component.memberEntityIds })),
  }));
  assert.deepEqual(after, before);
  assert.equal(draft.history.at(-1).details.materialChanges, 0);
  assert.match(draft.history.at(-1).summary, /no material boundary change/);
});

test('quality critique detects overlap, orphan evidence, cycles and unstable boundaries', () => {
  const context = contextFixture({ portfolio: { components: [], fronts: [] }, model: false });
  const generated = clone(synthesizeArchitectureAlternatives(context, { includeModel: false }).alternatives.find((item) => item.strategy === 'responsibility').components);
  assert.ok(generated.length >= 2);
  generated[0].memberEntityIds.push(generated[1].memberEntityIds[0]);
  generated[0].contract.dependencies = [{ kind: 'hard', target: generated[1].slug, reason: 'Fixture cycle.' }];
  generated[1].contract.dependencies = [{ kind: 'hard', target: generated[0].slug, reason: 'Fixture cycle.' }];
  generated[0].fieldGrounding.purpose.assumptions.push('Unknown boundary.');
  const quality = evaluateArchitectureAlternative(generated, context.map);
  assert.ok(quality.overlap.entities > 0);
  assert.ok(quality.dependencyCycles.length > 0);
  assert.ok(quality.unstableBoundaries.includes(generated[0].slug));
  assert.equal(quality.gateC.pass, false);
  assert.ok(quality.diagnostics.some((item) => item.code === 'COMPONENT_DEPENDENCY_CYCLE'));
});

test('partial/manual/model-failure paths stay honest and invalid evidence fails closed', () => {
  const context = contextFixture({ product: null, portfolio: { components: [], fronts: [] }, model: false, snapshot: snapshotFixture({ freshness: 'stale', status: 'partial' }) });
  const fixture = privateFixture();
  const store = new ComponentDesignDraftStore({ root: fixture.draftRoot });
  const draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: true });
  assert.ok(!draft.alternatives.some((item) => item.strategy === 'model'));
  assert.ok(draft.questions.some((item) => item.id === 'question:product-priority'));
  assert.equal(draft.stale, true);
  assert.ok(draft.alternatives.flatMap((item) => item.components).every((component) => (
    component.fieldGrounding.purpose.assumptions.length || component.fieldGrounding.purpose.evidenceIds.length
  )));
  const unavailable = store.get(draft.repositoryId, draft.id, { unavailableReason: 'The source analysis was deleted.' });
  assert.equal(unavailable.stale, true);
  assert.match(unavailable.staleReasons.join(' '), /deleted/);

  const bad = contextFixture();
  bad.planningResult.components[0].evidenceIds = ['ev:fabricated'];
  assert.throws(() => synthesizeArchitectureAlternatives(bad), (error) => error.code === 'FABRICATED_EVIDENCE');
});

test('structural edits without source context mark metrics stale instead of fabricating an empty map', () => {
  const fixture = privateFixture();
  const context = contextFixture({ portfolio: { components: [], fronts: [] }, model: false });
  const store = new ComponentDesignDraftStore({ root: fixture.draftRoot });
  let draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: false });
  const component = draft.alternatives[0].components[0];
  draft = operation(store, draft, {
    operation: 'edit-component', componentId: component.id,
    updates: { contract: { guidance: 'Human guidance while the analysis source is unavailable.' } },
  });
  const quality = draft.alternatives[0].quality;
  assert.equal(quality.stale, true);
  assert.equal(quality.gateC.pass, false);
  assert.ok(quality.diagnostics.some((item) => item.code === 'QUALITY_CONTEXT_UNAVAILABLE'));
});

test('expired drafts are removed and cannot be resumed', () => {
  const fixture = privateFixture();
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const store = new ComponentDesignDraftStore({ root: fixture.draftRoot, now: () => now, ttlMs: 1_000 });
  const draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, contextFixture());
  now += 1_001;
  assert.throws(() => store.get(draft.repositoryId, draft.id), (error) => error.code === 'COMPONENT_DESIGN_DRAFT_EXPIRED');
  assert.equal(readdirSync(fixture.draftRoot).length, 0);
});
