import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  FRONT_DESIGN_FIELDS,
  FrontPlanningDraftStore,
  evaluateFrontPlanAlternative,
  synthesizeFrontPlanAlternatives,
} from '../src/front-design.mjs';
import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { deriveSystemMap } from '../src/intelligence/system-map.mjs';
import { normalizeProductBrief } from '../src/product-direction.mjs';
import { createFrontMarkdown, parseFrontContract } from '../src/work-contracts.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function snapshotFixture({ freshness = 'current', status = 'complete', createdAt = '2026-08-03T12:00:00.000Z' } = {}) {
  const files = ['src/server.mjs', 'src/auth.mjs', 'src/billing.mjs', 'test/auth.test.mjs', 'test/billing.test.mjs'];
  const evidence = files.map((path, index) => ({
    id: `ev:${index + 1}`, sourceKind: 'source', provenance: 'extracted', path,
    revision: digest(path), summary: `Observed responsibility evidence in ${path}.`,
  }));
  const entities = [
    { id: 'module:server', kind: 'module', name: 'HTTP server', location: { path: 'src/server.mjs' }, evidenceIds: ['ev:1'], attributes: { community: 'runtime' } },
    { id: 'module:auth', kind: 'module', name: 'Authentication', location: { path: 'src/auth.mjs' }, evidenceIds: ['ev:2'], attributes: { community: 'identity' } },
    { id: 'module:billing', kind: 'module', name: 'Billing', location: { path: 'src/billing.mjs' }, evidenceIds: ['ev:3'], attributes: { community: 'commerce' } },
    { id: 'test:auth', kind: 'test', name: 'Authentication tests', location: { path: 'test/auth.test.mjs' }, evidenceIds: ['ev:4'], attributes: { community: 'verification' } },
    { id: 'test:billing', kind: 'test', name: 'Billing tests', location: { path: 'test/billing.test.mjs' }, evidenceIds: ['ev:5'], attributes: { community: 'verification' } },
  ];
  const relations = [
    ['rel:1', 'module:server', 'module:auth', 'calls', 'ev:1'],
    ['rel:2', 'module:server', 'module:billing', 'calls', 'ev:1'],
    ['rel:3', 'test:auth', 'module:auth', 'tests', 'ev:4'],
    ['rel:4', 'test:billing', 'module:billing', 'tests', 'ev:5'],
  ].map(([id, source, target, kind, evidenceId]) => ({ id, source, target, kind, confidence: .95, evidenceIds: [evidenceId] }));
  return createAnalysisSnapshot({
    repository: { id: 'repo:fixture', adapter: 'handraise' }, createdAt,
    analyzer: {
      id: 'fixture-semantic', name: 'Fixture semantic analyzer', version: '1.0.0', contractVersion: 1,
      capabilities: {
        languages: ['JavaScript'], entityKinds: ['module', 'test'], relationKinds: ['calls', 'tests'],
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
    coverage: [{ id: 'coverage:js', subject: 'JavaScript', status: 'covered', summary: 'JavaScript parsed.', evidenceIds: [] }], diagnostics: [],
  });
}

function productFixture() {
  const brief = normalizeProductBrief({
    title: 'Handraise',
    purpose: { id: 'purpose', text: 'Understand the system. Design the work. Run the agents.', sourceIds: ['source:human'], locked: true },
    users: [{ id: 'user:lead', text: 'Technical leads organizing parallel agent work.', sourceIds: ['source:human'] }],
    outcomes: [{ id: 'outcome:remote', text: 'Remote users operate the host safely.', sourceIds: ['source:human'] }],
    constraints: [{ id: 'constraint:no-write', text: 'Planning never mutates accepted repository files.', sourceIds: ['source:human'], locked: true }],
    invariants: [{ id: 'invariant:evidence', text: 'Acceptance requires evidence.', sourceIds: ['source:human'], locked: true }],
    goals: [{
      id: 'goal:remote-control', title: 'Ship safe remote control', outcome: 'A remote client can safely inspect and control agent work.',
      priority: 'now', state: 'active', successSignals: ['A remote browser completes one authenticated control journey.'], sourceIds: ['source:human'],
    }],
  }, { repositoryId: 'repo:fixture', now: Date.parse('2026-08-03T12:00:00.000Z') });
  return { exists: true, revision: digest(JSON.stringify(brief)), brief };
}

function component(slug, title, territory, memberEntityIds, { dependencies = [], uncertainty = 'No material uncertainty is currently evidenced.' } = {}) {
  return {
    id: `component:${slug}`, slug, title, state: 'active', order: slug === 'identity-access' ? 1 : 2, origin: 'generated', memberEntityIds, lockedFields: [], fieldGrounding: {},
    contract: {
      purpose: `Own ${title} responsibilities.`, outcomes: [`${title} behavior is independently reviewable.`], responsibilities: [`Deliver ${title} behavior.`],
      limits: ['Does not own unrelated product behavior.'], invariants: ['Every remote mutation remains authenticated.'],
      interfaces: [{ kind: 'provides', target: `${title} API`, description: `Reviewable ${title} interface.` }], dependencies,
      dataSystems: [`${title} state`], territory, verification: [`Run the observed ${slug} tests.`],
      evidence: memberEntityIds.map((id) => ({ kind: 'inferred', reference: id === 'module:auth' ? 'ev:2' : id === 'module:billing' ? 'ev:3' : 'ev:1', reason: `Observed ${title} source.` })),
      uncertainties: [uncertainty], guidance: `Keep changes inside the reviewed ${title} boundary.`,
    },
  };
}

function componentDraftFixture() {
  const components = [
    component('identity-access', 'Identity Access', ['src/auth.mjs', 'test/auth.test.mjs'], ['module:auth', 'test:auth'], { uncertainty: 'Should local implicit identity and remote pairing share one policy boundary?' }),
    component('remote-control', 'Remote Control', ['src/server.mjs', 'src/billing.mjs', 'test/billing.test.mjs'], ['module:server', 'module:billing', 'test:billing'], {
      dependencies: [{ kind: 'hard', target: 'identity-access', reason: 'Remote control requires authenticated identity.' }],
    }),
  ];
  return {
    id: '11111111-1111-4111-8111-111111111111', repositoryId: 'repo:fixture', revision: digest(JSON.stringify(components)),
    selectedAlternativeId: 'component-alt:responsibility', alternatives: [{ id: 'component-alt:responsibility', strategy: 'responsibility', title: 'Responsibilities', components }],
  };
}

function acceptedFront({ state = 'done' } = {}) {
  return {
    schemaVersion: 2, slug: 'accepted-local-access', title: 'Accepted local access', state, order: 1, component: 'identity-access',
    affectedComponents: ['remote-control'], goalIds: ['goal:remote-control'], analysisSnapshot: null,
    outcome: 'Local host access remains implicit and secure.', motivation: 'Preserve accepted local behavior.', scope: 'Preserve loopback identity policy.',
    nonGoals: ['No remote bypass.'], readiness: ['Accepted implementation exists.'], acceptanceCriteria: ['Loopback host and peer are both required.'],
    verification: ['Run authentication tests.'], deliverables: ['Accepted local identity behavior.'], risks: ['Host spoofing regression.'], dependencies: [],
    evidence: [{ kind: 'declared', reference: 'ev:2', reason: 'Accepted implementation evidence.' }], context: 'Completed evidence must survive replanning.',
    handoff: 'Do not revise completed evidence.', tasks: [{ state: 'done', text: 'Verify local host access.' }],
  };
}

function planningResult({ invalidDependency = false, fabricatedEvidence = false } = {}) {
  return {
    schemaVersion: 1, operation: 'front-design', summary: 'Model proposes an authenticated remote journey.', components: [],
    fronts: [{
      slug: 'model-remote-journey', title: 'Model remote journey', componentSlug: 'remote-control',
      objective: 'A paired remote browser completes one safe control journey.', motivation: 'Validate the product goal through one end-to-end outcome.',
      scope: 'Pair, inspect and issue one bounded command.', nonGoals: ['No public unauthenticated endpoint.'], readiness: ['HTTPS or private-network reachability exists.'],
      acceptanceCriteria: ['The remote journey succeeds with authenticated identity.'], verification: ['Run the observed browser authentication journey.'],
      deliverables: ['Remote journey evidence.'], risks: ['Network identity can be misclassified.'], dependencies: invalidDependency ? ['invented-front'] : [],
      affectedComponents: ['identity-access'], goalIds: ['goal:remote-control'], evidenceIds: [fabricatedEvidence ? 'ev:fabricated' : 'ev:1'],
      uncertainty: 'medium', assumptions: ['The selected endpoint is reachable.'], questions: ['Which exposure mode is accepted?'],
    }], findings: [], assumptions: [], questions: [],
  };
}

function contextFixture({ product = productFixture(), portfolio = { components: [], fronts: [] }, model = true, modelResult = planningResult(), snapshot = snapshotFixture(), goal = null } = {}) {
  const map = deriveSystemMap(snapshot);
  return {
    analysisJobId: 'analysis:fixture', planningJobId: model ? 'planning:fixture' : null, snapshot, map,
    componentDraft: componentDraftFixture(), componentAlternativeId: 'component-alt:responsibility', product,
    ...(goal ? { goal, goalId: null } : { goalId: 'goal:remote-control' }), portfolio,
    planningResult: model ? modelResult : null, modelEvidenceIds: map.evidence.map((item) => item.id),
  };
}

function privateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'handraise-front-design-'));
  const repositoryPath = join(root, 'repository'); mkdirSync(repositoryPath); writeFileSync(join(repositoryPath, 'sentinel.txt'), 'must remain unchanged\n');
  return { root, repositoryPath, draftRoot: join(root, 'private', 'front-design') };
}

function operation(store, draft, payload, context = null) {
  return store.apply(draft.repositoryId, draft.id, { ...payload, expectedRevision: draft.revision }, { context });
}

test('synthesis creates stable, complete, materially different and evidence-grounded front portfolios', () => {
  const context = contextFixture({ portfolio: { components: [], fronts: [acceptedFront()] } });
  const first = synthesizeFrontPlanAlternatives(context);
  const second = synthesizeFrontPlanAlternatives(context);
  assert.deepEqual(first.alternatives, second.alternatives);
  assert.deepEqual(first.alternatives.map((item) => item.strategy), ['outcome-slices', 'risk-first', 'existing', 'model']);
  const signatures = new Set(first.alternatives.map((item) => JSON.stringify(item.fronts.map((front) => [front.slug, front.candidateKind, front.dependencies]))));
  assert.equal(signatures.size, first.alternatives.length);
  assert.ok(first.alternatives.find((item) => item.strategy === 'outcome-slices').fronts.some((front) => front.candidateKind === 'decision'));

  for (const alternative of first.alternatives) {
    assert.ok('readySet' in alternative.quality && 'criticalPath' in alternative.quality && 'parallelism' in alternative.quality);
    for (const front of alternative.fronts) {
      assert.ok(front.leadComponent);
      assert.deepEqual(Object.keys(front.fieldGrounding).sort(), [...FRONT_DESIGN_FIELDS].sort());
      for (const grounding of Object.values(front.fieldGrounding)) assert.ok(grounding.evidenceIds.length || grounding.goalIds.length || grounding.componentSlugs.length || grounding.assumptions.length || grounding.questions.length);
      const parsed = parseFrontContract(createFrontMarkdown({ ...front, component: front.leadComponent, risks: [...front.risks, ...front.unknowns.map((item) => `[Unknown] ${item}`)] }));
      assert.equal(parsed.schemaVersion, 2); assert.equal(parsed.slug, front.slug);
    }
  }
  assert.equal(first.alternatives.find((item) => item.strategy === 'existing').fronts[0].state, 'done');
  assert.deepEqual(first.alternatives.find((item) => item.strategy === 'existing').fronts[0].lockedFields, [...FRONT_DESIGN_FIELDS]);
});

test('generated slugs from long manual learning goals remain valid v2 round trips', () => {
  const context = contextFixture({
    product: null, model: false,
    goal: {
      id: 'goal:manual-learning-long-title',
      title: 'Review blocker reconnect verification and retry policy ownership after a failed execution outcome',
      outcome: 'A human reviews the exact failure and chooses one bounded owner before another run starts.',
      successSignals: ['The reviewed front portfolio serializes as valid v2 contracts.'],
    },
  });
  const result = synthesizeFrontPlanAlternatives(context, { includeModel: false });
  for (const alternative of result.alternatives) for (const front of alternative.fronts) {
    assert.ok(front.slug.length <= 64, `${front.slug} exceeds the work-contract slug limit`);
    const parsed = parseFrontContract(createFrontMarkdown({ ...front, component: front.leadComponent, risks: [...front.risks, ...front.unknowns.map((item) => `[Unknown] ${item}`)] }));
    assert.equal(parsed.slug, front.slug);
    assert.equal(parsed.schemaVersion, 2);
  }
});

test('private drafts are permission-bounded and never mutate repository, worktree or agent state', () => {
  const fixture = privateFixture(); const before = readFileSync(join(fixture.repositoryPath, 'sentinel.txt'), 'utf8');
  const store = new FrontPlanningDraftStore({ root: fixture.draftRoot });
  const draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, contextFixture(), { includeModel: false });
  assert.equal(statSync(fixture.draftRoot).mode & 0o777, 0o700);
  const [file] = readdirSync(fixture.draftRoot); assert.equal(statSync(join(fixture.draftRoot, file)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(fixture.repositoryPath, 'sentinel.txt'), 'utf8'), before);
  assert.deepEqual(draft.mutation, { repository: false, worktrees: false, agents: false, privateDraftOnly: true, publicationAvailableHere: false });
  assert.ok(!Object.hasOwn(draft.source, 'references')); assert.ok(!Object.hasOwn(draft.source, 'componentSnapshot')); assert.ok(Object.isFrozen(draft));
});

test('quality reports hard cycles, invalid references, duplicate outcomes, broad work and ownership collisions', () => {
  const context = contextFixture({ model: false });
  const fronts = clone(synthesizeFrontPlanAlternatives(context, { includeModel: false }).alternatives.find((item) => item.strategy === 'outcome-slices').fronts);
  const implementations = fronts.filter((front) => front.candidateKind === 'implementation');
  assert.ok(implementations.length >= 2);
  implementations[0].dependencies.push({ kind: 'hard', target: implementations[1].slug, reason: 'Fixture cycle edge.' });
  implementations[1].dependencies.push({ kind: 'hard', target: implementations[0].slug, reason: 'Fixture cycle edge.' });
  implementations[1].outcome = implementations[0].outcome;
  implementations[0].affectedComponents = [implementations[1].leadComponent];
  implementations[0].tasks = Array.from({ length: 13 }, (_, index) => ({ state: 'open', text: `Broad task ${index}` }));
  implementations[0].dependencies.push({ kind: 'informational', target: 'missing-front', reason: 'Adversarial invalid reference.' });
  const quality = evaluateFrontPlanAlternative(fronts, context);
  assert.ok(quality.dependencyCycles.length); assert.ok(quality.duplicateOutcomes.length); assert.ok(quality.broadFronts.includes(implementations[0].slug));
  assert.ok(quality.parallelism.collisions.length); assert.equal(quality.gateD.pass, false);
  assert.ok(quality.diagnostics.some((item) => item.code === 'UNKNOWN_FRONT_DEPENDENCY'));
});

test('review operations cover edit, lock, split, merge, add, delete, reorder, compare and skip with optimistic revisions', () => {
  const fixture = privateFixture(); const context = contextFixture({ model: false });
  const store = new FrontPlanningDraftStore({ root: fixture.draftRoot });
  let draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: false });
  let alternative = draft.alternatives.find((item) => item.strategy === 'outcome-slices');
  draft = operation(store, draft, { operation: 'select-alternative', alternativeId: alternative.id }, context);
  alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  let front = alternative.fronts.find((item) => item.candidateKind === 'implementation');

  draft = operation(store, draft, { operation: 'lock-field', frontId: front.id, field: 'outcome', reason: 'Human approved this feedback boundary.' }, context);
  assert.throws(() => operation(store, draft, { operation: 'edit-front', frontId: front.id, updates: { outcome: 'Forbidden locked change.' } }, context), (error) => error.code === 'LOCKED_FRONT_FIELD');
  draft = operation(store, draft, { operation: 'unlock-field', frontId: front.id, field: 'outcome' }, context);
  draft = operation(store, draft, { operation: 'edit-front', frontId: front.id, updates: { outcome: 'A reviewer can complete the explicitly revised outcome.' } }, context);
  alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId); front = alternative.fronts.find((item) => item.id === front.id);
  assert.match(front.fieldGrounding.outcome.assumptions.join(' '), /Human-edited outcome/);

  const reversed = alternative.fronts.map((item) => item.id).reverse();
  draft = operation(store, draft, { operation: 'reorder-fronts', frontIds: reversed }, context);
  assert.deepEqual(draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).fronts.map((item) => item.id), reversed);

  alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId); front = alternative.fronts.find((item) => item.id === front.id);
  assert.throws(() => operation(store, draft, {
    operation: 'split-front', frontId: front.id,
    first: { slug: 'split-observe', title: 'Split observe', taskIndexes: [0, 1] }, second: { slug: 'split-deliver', title: 'Split deliver', taskIndexes: [3] },
  }, context), (error) => error.code === 'INVALID_FRONT_SPLIT');
  draft = operation(store, draft, {
    operation: 'split-front', frontId: front.id,
    first: { slug: 'split-observe', title: 'Split observe', outcome: 'Observed behavior is reviewable.', taskIndexes: [0, 1] },
    second: { slug: 'split-deliver', title: 'Split deliver', outcome: 'Delivered behavior is reviewable.', taskIndexes: [2, 3] },
  }, context);
  alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  const split = alternative.fronts.filter((item) => ['split-observe', 'split-deliver'].includes(item.slug)); assert.equal(split.length, 2);
  assert.equal(split.flatMap((item) => item.tasks).length, 4);
  draft = operation(store, draft, {
    operation: 'merge-fronts', frontIds: split.map((item) => item.id),
    front: { slug: 'merged-reviewed-outcome', title: 'Merged reviewed outcome', outcome: 'One reviewed outcome restores the accepted feedback boundary.' },
  }, context);
  alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
  assert.ok(alternative.fronts.some((item) => item.slug === 'merged-reviewed-outcome'));

  const template = clone(alternative.fronts.find((item) => item.slug === 'merged-reviewed-outcome'));
  delete template.id; template.slug = 'manual-research'; template.title = 'Manual research'; template.candidateKind = 'research';
  template.outcome = 'A bounded answer removes one explicit product unknown.'; template.dependencies = [];
  template.fieldGrounding = Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, { evidenceIds: [], goalIds: ['goal:remote-control'], componentSlugs: [], assumptions: [`Human-authored ${field}.`], questions: [] }]));
  draft = operation(store, draft, { operation: 'add-front', front: template }, context);
  alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId); const manual = alternative.fronts.find((item) => item.slug === 'manual-research');
  assert.equal(manual.origin, 'manual');
  const comparison = store.compare(draft.repositoryId, draft.id, draft.alternatives[0].id, draft.alternatives[1].id); assert.equal(comparison.materiallyDifferent, true);
  draft = operation(store, draft, { operation: 'delete-front', frontId: manual.id }, context);
  draft = operation(store, draft, { operation: 'skip' }, context); assert.equal(draft.state, 'skipped');
  draft = operation(store, draft, { operation: 'resume' }, context); assert.equal(draft.state, 'review');
  assert.throws(() => store.apply(draft.repositoryId, draft.id, { operation: 'skip', expectedRevision: '0'.repeat(64) }, { context }), (error) => error.code === 'FRONT_DESIGN_REVISION_CONFLICT');
});

test('answers and locked decisions survive regeneration while a no-op remains stable', () => {
  const fixture = privateFixture(); const context = contextFixture({ model: false });
  const store = new FrontPlanningDraftStore({ root: fixture.draftRoot });
  let draft = store.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: false });
  const question = draft.questions.find((item) => item.id === 'front-question:slicing-axis'); assert.ok(question);
  draft = operation(store, draft, { operation: 'answer-question', questionId: question.id, answer: 'Prioritize one risk-first end-to-end proof.' }, context);
  assert.equal(draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).strategy, 'risk-first');
  let front = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).fronts.find((item) => item.candidateKind === 'implementation');
  assert.ok(front.fieldGrounding.scope.assumptions.some((item) => item.includes(question.id)));
  draft = operation(store, draft, { operation: 'lock-field', frontId: front.id, field: 'handoff', reason: 'Accepted delegation boundary.' }, context);
  front = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId).fronts.find((item) => item.id === front.id); const handoff = front.handoff;
  draft = operation(store, draft, { operation: 'regenerate', includeModel: false }, context);
  assert.equal(draft.questions.find((item) => item.id === question.id).answer, 'Prioritize one risk-first end-to-end proof.');
  const regenerated = draft.alternatives.find((item) => item.strategy === 'risk-first').fronts.find((item) => item.slug === front.slug);
  assert.equal(regenerated.handoff, handoff); assert.ok(regenerated.lockedFields.includes('handoff'));
  assert.equal(draft.history.at(-1).details.preservedLocks, 1); assert.equal(draft.history.at(-1).details.preservedAnswers, 1);

  const stableStore = new FrontPlanningDraftStore({ root: join(fixture.root, 'stable') });
  let stable = stableStore.create({ id: 'repo:fixture', adapter: 'handraise' }, context, { includeModel: false });
  const before = stable.alternatives.map((alternative) => ({ strategy: alternative.strategy, fronts: alternative.fronts.map((item) => ({ slug: item.slug, order: item.order, dependencies: item.dependencies })) }));
  stable = operation(stableStore, stable, { operation: 'regenerate', includeModel: false }, context);
  const after = stable.alternatives.map((alternative) => ({ strategy: alternative.strategy, fronts: alternative.fronts.map((item) => ({ slug: item.slug, order: item.order, dependencies: item.dependencies })) }));
  assert.deepEqual(after, before); assert.equal(stable.history.at(-1).details.materialChanges, 0); assert.match(stable.history.at(-1).summary, /no material change/);
});

test('manual, stale, partial, model-rejection, expiry and immutable-completion paths fail honestly', () => {
  const fixture = privateFixture();
  const manualContext = contextFixture({
    product: null, model: false, snapshot: snapshotFixture({ freshness: 'stale', status: 'partial' }),
    goal: { id: 'goal:manual-safe-control', title: 'Clarify safe control', outcome: 'A reviewed plan explains safe remote control.', successSignals: ['A reviewer accepts the plan.'] },
  });
  const store = new FrontPlanningDraftStore({ root: fixture.draftRoot });
  const manual = store.create({ id: 'repo:fixture', adapter: 'handraise' }, manualContext, { includeModel: true });
  assert.equal(manual.stale, true); assert.ok(manual.questions.some((item) => item.id === 'front-question:goal-success')); assert.ok(!manual.alternatives.some((item) => item.strategy === 'model'));
  const unavailable = store.get(manual.repositoryId, manual.id, { unavailableReason: 'The source component draft was deleted.' });
  assert.equal(unavailable.stale, true); assert.match(unavailable.staleReasons.join(' '), /deleted/);

  const rejected = store.create({ id: 'repo:fixture', adapter: 'handraise' }, contextFixture({ modelResult: planningResult({ invalidDependency: true }) }));
  assert.ok(!rejected.alternatives.some((item) => item.strategy === 'model')); assert.ok(rejected.diagnostics.some((item) => item.code === 'UNKNOWN_FRONT_DEPENDENCY'));
  assert.throws(() => synthesizeFrontPlanAlternatives(contextFixture({ modelResult: planningResult({ fabricatedEvidence: true }) })), (error) => ['FABRICATED_EVIDENCE', 'INVALID_PLANNING_CONTRACT'].includes(error.code));

  const completedContext = contextFixture({ model: false, portfolio: { components: [], fronts: [acceptedFront()] } });
  let completed = store.create({ id: 'repo:fixture', adapter: 'handraise' }, completedContext, { includeModel: false });
  const existing = completed.alternatives.find((item) => item.strategy === 'existing');
  completed = operation(store, completed, { operation: 'select-alternative', alternativeId: existing.id }, completedContext);
  assert.throws(() => operation(store, completed, { operation: 'edit-front', frontId: existing.fronts[0].id, updates: { outcome: 'Rewrite completed evidence.' } }, completedContext), (error) => error.code === 'COMPLETED_FRONT_IMMUTABLE');

  let now = Date.parse('2026-08-03T12:00:00.000Z'); const expiringStore = new FrontPlanningDraftStore({ root: join(fixture.root, 'expiring'), now: () => now, ttlMs: 10 });
  const expiring = expiringStore.create({ id: 'repo:fixture', adapter: 'handraise' }, contextFixture({ model: false }), { includeModel: false }); now += 11;
  assert.throws(() => expiringStore.get(expiring.repositoryId, expiring.id), (error) => error.code === 'FRONT_DESIGN_DRAFT_EXPIRED');
});
