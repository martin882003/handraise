import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createContentManifest } from '../src/intelligence/contracts.mjs';
import { ANALYSIS_DEFAULT_LIMITS } from '../src/intelligence/runtime.mjs';
import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import {
  PlanPublicationStore, buildPublicationManifest, publicationSourceRevision,
} from '../src/plan-publication.mjs';
import {
  normalizeProductBrief, readAcceptedProduct, renderProductBrief,
} from '../src/product-direction.mjs';
import {
  createComponentMarkdown, createFrontMarkdown, parseComponentContract, parseFrontContract,
} from '../src/work-contracts.mjs';
import { createHandraise } from '../src/server.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const actor = { id: 'local:test-client', name: 'Local test client', implicit: true };

function component(slug = 'system-planning', title = 'System Planning') {
  return {
    id: `component:${slug}`, slug, title, state: 'active', order: 1, origin: 'generated', memberEntityIds: ['module:planner'], lockedFields: [],
    contract: {
      purpose: 'Understand repository structure and turn it into reviewable work boundaries.',
      outcomes: ['Humans can review one evidence-backed responsibility model.'],
      responsibilities: ['Map repository responsibilities.', 'Design reviewable component boundaries.'],
      limits: ['Does not launch agents before publication.'], invariants: ['Every generated claim cites evidence or uncertainty.'],
      interfaces: [{ kind: 'provides', target: 'Planning workspace', description: 'Exact private planning artifacts.' }],
      dependencies: [], dataSystems: ['Private analysis snapshots'], territory: ['src/planner.mjs'],
      verification: ['Run planning contract tests.'],
      evidence: [{ kind: 'extracted', reference: 'ev:planner', reason: 'Planner source owns this behavior.' }],
      uncertainties: ['Repository-specific ownership still needs human review.'], guidance: 'Keep analysis read-only until explicit publication.',
    },
  };
}

function front(snapshotId, slug = 'publish-reviewed-plan') {
  return {
    id: `front:${slug}`, slug, title: 'Publish reviewed plan', state: 'queued', order: 1, origin: 'generated', candidateKind: 'implementation',
    leadComponent: 'system-planning', affectedComponents: [], goalIds: ['goal:organize-work'], analysisSnapshot: snapshotId,
    outcome: 'A reviewed system model becomes one durable and internally valid work portfolio.',
    motivation: 'Agents need trustworthy boundaries before parallel execution begins.', scope: 'Publish the reviewed product, components and fronts as one transaction.',
    nonGoals: ['No agent launch in this front.'], dependencies: [], readiness: ['Gate C passes.', 'Gate D passes.'],
    acceptanceCriteria: ['Every accepted artifact matches the reviewed exact diff.'], verification: ['Run publication rollback and conflict tests.'],
    deliverables: ['Durable product and work contracts.'], risks: ['A filesystem failure could interrupt a multi-file write.'], unknowns: [],
    evidence: [{ kind: 'extracted', reference: 'ev:planner', reason: 'Planner source establishes the publication boundary.' }],
    context: 'The publication is the only mutation boundary.', handoff: 'Start agents only after the accepted portfolio is visible.',
    tasks: [{ state: 'open', text: 'Publish the exact reviewed manifest.' }], lockedFields: [], fieldGrounding: {},
  };
}

function product(repositoryId, now = Date.parse('2026-08-03T12:00:00.000Z')) {
  return normalizeProductBrief({
    title: 'Handraise',
    purpose: { id: 'purpose', text: 'Understand the system. Design the work. Run the agents.', sourceIds: ['source:human'], locked: true },
    users: [{ id: 'user:lead', text: 'Technical leads organizing parallel coding-agent work.', sourceIds: ['source:human'] }],
    outcomes: [{ id: 'outcome:organized', text: 'A repository has evidence-backed work boundaries.', sourceIds: ['source:human'] }],
    constraints: [{ id: 'constraint:review', text: 'Nothing accepted changes before explicit review.', sourceIds: ['source:human'], locked: true }],
    invariants: [{ id: 'invariant:atomic', text: 'Publication is conflict-safe and all-or-nothing.', sourceIds: ['source:human'], locked: true }],
    goals: [{
      id: 'goal:organize-work', title: 'Organize the work', outcome: 'Produce a reviewable product, component and front model.',
      priority: 'now', state: 'active', successSignals: ['The complete plan passes portfolio validation.'], sourceIds: ['source:human'],
    }],
  }, { repositoryId, now });
}

function fixture({ initialized = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'handraise-publication-'));
  const repositoryPath = join(root, 'repository'); mkdirSync(repositoryPath);
  const readme = '# Publication fixture\n'; writeFileSync(join(repositoryPath, 'README.md'), readme);
  const repository = { id: `repo:${randomUUID()}`, name: 'Publication fixture', path: repositoryPath, adapter: initialized ? 'handraise' : 'uninitialized' };
  const acceptedBrief = product(repository.id);
  if (initialized) {
    mkdirSync(join(repositoryPath, '.handraise', 'components'), { recursive: true });
    mkdirSync(join(repositoryPath, '.handraise', 'fronts'), { recursive: true });
    writeFileSync(join(repositoryPath, '.handraise', 'project.json'), `${JSON.stringify({ version: 1, name: repository.name }, null, 2)}\n`);
    writeFileSync(join(repositoryPath, '.handraise', '.gitignore'), 'worktrees/\n.management-lock/\n.publication-transactions/\n');
    const acceptedComponent = component();
    acceptedComponent.contract.purpose = 'Legacy planning purpose that will be revised.';
    const componentMarkdown = createComponentMarkdown(acceptedComponent).replace('---\n', '---\ncustom-owner: human\n');
    writeFileSync(join(repositoryPath, '.handraise', 'components', 'system-planning.md'), `${componentMarkdown}\n## Operator notes\n\nPreserve this component note.\n`);
    writeFileSync(join(repositoryPath, '.handraise', 'components', 'obsolete-boundary.md'), createComponentMarkdown(component('obsolete-boundary', 'Obsolete Boundary')));
    const acceptedFront = front('snapshot:old'); acceptedFront.outcome = 'Legacy publication behavior.';
    writeFileSync(join(repositoryPath, '.handraise', 'fronts', 'publish-reviewed-plan.md'), `${createFrontMarkdown(acceptedFront)}\n## Operator notes\n\nPreserve this front note.\n`);
    const obsoleteFront = front('snapshot:old', 'obsolete-front'); obsoleteFront.state = 'queued';
    writeFileSync(join(repositoryPath, '.handraise', 'fronts', 'obsolete-front.md'), createFrontMarkdown(obsoleteFront));
    writeFileSync(join(repositoryPath, '.handraise', 'product.md'), `${renderProductBrief(acceptedBrief, { repositoryId: repository.id })}\n## Operator notes\n\nPreserve this product note.\n`);
  }
  const manifest = createContentManifest({
    files: [{ path: 'README.md', digest: digest(readme), size: Buffer.byteLength(readme), source: 'untracked', mode: '644', executable: false }],
    git: { head: null, branch: null, dirty: false },
    selection: { includeUntracked: true, includeIgnored: false, exclusions: ['.handraise/**'] },
  });
  const snapshot = {
    id: digest(`snapshot:${randomUUID()}`), status: 'complete', freshness: { state: 'current', checkedAt: '2026-08-03T12:00:00.000Z' }, manifest,
    analyzer: { id: 'fixture-analyzer', version: '1.0.0' }, repository: { id: repository.id, adapter: repository.adapter },
    scope: { included: ['README.md'], excluded: [], truncated: false, limits: ANALYSIS_DEFAULT_LIMITS },
  };
  const selectedComponent = component();
  const componentDraft = {
    id: randomUUID(), repositoryId: repository.id, revision: digest(`component:${randomUUID()}`), state: 'review', stale: false, staleReasons: [],
    selectedAlternativeId: 'architecture:reviewed', source: { snapshotId: snapshot.id },
    alternatives: [{ id: 'architecture:reviewed', title: 'Reviewed responsibilities', strategy: 'responsibility', components: [selectedComponent], quality: { gateC: { pass: true } } }],
  };
  const selectedFront = front(snapshot.id);
  const frontDraft = {
    id: randomUUID(), repositoryId: repository.id, revision: digest(`front:${randomUUID()}`), state: 'review', stale: false, staleReasons: [], selectedAlternativeId: 'fronts:reviewed',
    source: { componentDraftId: componentDraft.id, componentDraftRevision: componentDraft.revision, componentAlternativeId: 'architecture:reviewed' },
    alternatives: [{ id: 'fronts:reviewed', title: 'Reviewed outcomes', strategy: 'outcome-slices', fronts: [selectedFront], quality: { gateD: { pass: true } } }],
  };
  const accepted = readAcceptedProduct(repository);
  const proposedBrief = product(repository.id); proposedBrief.updatedAt = '2026-08-03T13:00:00.000Z';
  proposedBrief.outcomes[0].text = 'A repository has accepted, evidence-backed work boundaries.';
  const productDraft = {
    id: randomUUID(), repositoryId: repository.id, baselineRevision: accepted.revision, currentRevision: accepted.revision,
    createdAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-03T13:00:00.000Z', stale: false, brief: proposedBrief,
  };
  const workspace = {
    snapshot, componentDraft, componentAlternativeId: 'architecture:reviewed', frontDraft, frontAlternativeId: 'fronts:reviewed', productDraft,
  };
  return { root, repository, workspace, stateRoot: join(root, 'private', 'publications') };
}

function completeSelection(overrides = {}) {
  return { mode: 'complete-plan', includeProduct: true, deleteAbsentComponents: true, deleteAbsentFronts: true, ...overrides };
}

function sourceCheck(workspace) { return () => publicationSourceRevision(workspace); }

test('publication preview is private, exact, whole-portfolio validated and non-mutating', () => {
  const current = fixture();
  const componentPath = join(current.repository.path, '.handraise', 'components', 'system-planning.md');
  const before = readFileSync(componentPath, 'utf8');
  const store = new PlanPublicationStore({ root: current.stateRoot });
  const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });

  assert.equal(readFileSync(componentPath, 'utf8'), before);
  assert.equal(preview.state, 'review'); assert.equal(preview.canPublish, true); assert.equal(preview.validation.valid, true);
  assert.ok(preview.operations.some((item) => item.kind === 'product' && item.action === 'update'));
  assert.ok(preview.operations.some((item) => item.kind === 'component' && item.action === 'delete' && item.slug === 'obsolete-boundary'));
  assert.ok(preview.operations.some((item) => item.kind === 'front' && item.action === 'delete' && item.slug === 'obsolete-front'));
  assert.ok(preview.operations.some((item) => item.kind === 'audit' && item.action === 'create'));
  assert.match(preview.operations.find((item) => item.slug === 'system-planning').after, /Operator notes[\s\S]*Preserve this component note/);
  assert.match(preview.operations.find((item) => item.slug === 'system-planning').after, /custom-owner: human/);
  assert.ok(preview.relationships.components.length > 0 || preview.relationships.fronts.length > 0);
  assert.ok(!Object.hasOwn(preview, 'privateSource')); assert.ok(Object.isFrozen(preview));
  assert.equal(statSync(current.stateRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(current.stateRoot, `${preview.id}.json`)).mode & 0o777, 0o600);

  const componentsOnly = store.create(current.repository, current.workspace, { mode: 'components-only' }, { actor });
  assert.ok(!componentsOnly.operations.some((item) => item.kind === 'product' || item.kind === 'front'));
  assert.ok(!componentsOnly.operations.some((item) => item.action === 'delete'), 'absence never means deletion without an explicit flag');
});

test('duplicate destinations and blocked quality gates never produce a publishable preview', () => {
  {
    const current = fixture();
    const duplicated = structuredClone(current.workspace);
    duplicated.componentDraft.alternatives[0].components.push(structuredClone(duplicated.componentDraft.alternatives[0].components[0]));
    const store = new PlanPublicationStore({ root: current.stateRoot });
    assert.throws(
      () => store.create(current.repository, duplicated, { mode: 'components-only' }, { actor }),
      (error) => error.code === 'DUPLICATE_PUBLICATION_DESTINATION',
    );
  }
  {
    const current = fixture();
    current.workspace.componentDraft.alternatives[0].quality.gateC.pass = false;
    const store = new PlanPublicationStore({ root: current.stateRoot });
    const preview = store.create(current.repository, current.workspace, { mode: 'components-only' }, { actor });
    assert.equal(preview.canPublish, false);
    assert.ok(preview.validation.diagnostics.some((item) => item.code === 'COMPONENT_GATE_C_FAILED'));
  }
});

test('confirmed publication preserves unknown content, commits once and leaves a durable audit', () => {
  const current = fixture(); const store = new PlanPublicationStore({ root: current.stateRoot });
  const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
  const result = store.commit(current.repository, preview.id, {
    expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace),
  });
  assert.equal(result.committed, true); assert.equal(result.publicationDigest, preview.publicationDigest);
  assert.equal(existsSync(join(current.repository.path, '.handraise', 'components', 'obsolete-boundary.md')), false);
  assert.equal(existsSync(join(current.repository.path, '.handraise', 'fronts', 'obsolete-front.md')), false);
  const componentMarkdown = readFileSync(join(current.repository.path, '.handraise', 'components', 'system-planning.md'), 'utf8');
  const frontMarkdown = readFileSync(join(current.repository.path, '.handraise', 'fronts', 'publish-reviewed-plan.md'), 'utf8');
  const productMarkdown = readFileSync(join(current.repository.path, '.handraise', 'product.md'), 'utf8');
  assert.match(componentMarkdown, /custom-owner: human/); assert.match(componentMarkdown, /Preserve this component note/);
  assert.match(frontMarkdown, /Preserve this front note/); assert.match(productMarkdown, /Preserve this product note/);
  assert.equal(parseComponentContract(componentMarkdown).contract.purpose, component().contract.purpose);
  assert.equal(parseFrontContract(frontMarkdown).outcome, front(current.workspace.snapshot.id).outcome);
  const audit = JSON.parse(readFileSync(join(current.repository.path, result.auditPath), 'utf8'));
  assert.equal(audit.publicationDigest, preview.publicationDigest); assert.equal(audit.actor.authority, 'implicit-local');
  assert.ok(!JSON.stringify(audit).includes('privateSource'));
  assert.equal(existsSync(join(current.repository.path, '.handraise', '.publication-transactions', preview.id)), false);

  const again = store.commit(current.repository, preview.id, {
    expectedRevision: preview.revision, confirmed: true, actor, sourceCheck() { throw new Error('idempotent commit must not need expired sources'); },
  });
  assert.deepEqual(again, result);
});

test('manual edits, source changes, snapshot changes, actor changes and active locks fail closed', () => {
  {
    const current = fixture(); const store = new PlanPublicationStore({ root: current.stateRoot });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    const path = join(current.repository.path, '.handraise', 'components', 'system-planning.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nmanual edit\n`);
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }), (error) => error.code === 'PUBLICATION_BASELINE_CHANGED');
  }
  {
    const current = fixture(); const store = new PlanPublicationStore({ root: current.stateRoot });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    const changedWorkspace = structuredClone(current.workspace); changedWorkspace.componentDraft.revision = digest('changed draft');
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(changedWorkspace) }), (error) => error.code === 'PUBLICATION_SOURCE_CHANGED');
  }
  {
    const current = fixture(); const store = new PlanPublicationStore({ root: current.stateRoot });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    writeFileSync(join(current.repository.path, 'README.md'), '# changed after analysis\n');
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }), (error) => error.code === 'PUBLICATION_SNAPSHOT_CHANGED');
  }
  {
    const current = fixture(); const store = new PlanPublicationStore({ root: current.stateRoot });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    writeFileSync(join(current.repository.path, 'new-source.mjs'), 'export const changedScope = true;\n');
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }), (error) => error.code === 'PUBLICATION_SNAPSHOT_CHANGED');
  }
  {
    const current = fixture(); const store = new PlanPublicationStore({ root: current.stateRoot });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor: { id: 'other', name: 'Other', implicit: true }, sourceCheck: sourceCheck(current.workspace) }), (error) => error.code === 'PUBLICATION_ACTOR_CHANGED');
    mkdirSync(join(current.repository.path, '.handraise', '.management-lock'));
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }), (error) => error.code === 'PUBLICATION_BUSY');
  }
});

test('I/O failure rolls every accepted file back and crash recovery uses the durable journal', () => {
  {
    const current = fixture();
    const baselines = new Map([
      ['component', readFileSync(join(current.repository.path, '.handraise', 'components', 'system-planning.md'), 'utf8')],
      ['front', readFileSync(join(current.repository.path, '.handraise', 'fronts', 'publish-reviewed-plan.md'), 'utf8')],
      ['product', readFileSync(join(current.repository.path, '.handraise', 'product.md'), 'utf8')],
    ]);
    const store = new PlanPublicationStore({ root: current.stateRoot, fault(stage, context) { if (stage === 'after-operation' && context.index === 0) throw Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' }); } });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }), /injected disk failure/);
    assert.equal(readFileSync(join(current.repository.path, '.handraise', 'components', 'system-planning.md'), 'utf8'), baselines.get('component'));
    assert.equal(readFileSync(join(current.repository.path, '.handraise', 'fronts', 'publish-reviewed-plan.md'), 'utf8'), baselines.get('front'));
    assert.equal(readFileSync(join(current.repository.path, '.handraise', 'product.md'), 'utf8'), baselines.get('product'));
    assert.equal(existsSync(join(current.repository.path, '.handraise', 'publications', `${preview.id}.json`)), false);
  }
  for (const scenario of [
    { stage: 'after-stage', code: 'EACCES', label: 'staging fsync/permission failure' },
    { stage: 'before-target-rename', code: 'EXDEV', label: 'destination rename failure', index: 0 },
    { stage: 'after-target-rename', code: 'EIO', label: 'post-rename fsync failure', index: 0 },
    { stage: 'before-commit', code: 'ENOSPC', label: 'journal commit failure' },
  ]) {
    const current = fixture();
    const store = new PlanPublicationStore({
      root: current.stateRoot,
      fault(stage, context) {
        if (stage === scenario.stage && (scenario.index === undefined || context.index === scenario.index)) {
          throw Object.assign(new Error(`injected ${scenario.label}`), { code: scenario.code });
        }
      },
    });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    assert.throws(
      () => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }),
      new RegExp(`injected ${scenario.label}`),
    );
    for (const item of preview.operations) {
      const path = join(current.repository.path, ...item.relativePath.split('/'));
      if (item.before === null) assert.equal(existsSync(path), false, `${scenario.label}: ${item.relativePath} must not remain created`);
      else assert.equal(readFileSync(path, 'utf8'), item.before, `${scenario.label}: ${item.relativePath} must be restored byte-for-byte`);
    }
    assert.equal(existsSync(join(current.repository.path, '.handraise', '.publication-transactions', preview.id)), false);
  }
  {
    const current = fixture();
    const before = readFileSync(join(current.repository.path, '.handraise', 'product.md'), 'utf8');
    const store = new PlanPublicationStore({ root: current.stateRoot, fault(stage, context) {
      if (stage === 'after-operation' && context.index === 0) throw Object.assign(new Error('simulated process crash'), { code: 'SIMULATED_CRASH', simulateCrash: true });
    } });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }), (error) => error.code === 'SIMULATED_CRASH');
    assert.equal(existsSync(join(current.repository.path, '.handraise', '.publication-transactions', preview.id)), true);
    const recovery = store.recover(current.repository);
    assert.deepEqual(recovery.recovered, [{ previewId: preview.id, outcome: 'rolled-back' }]);
    assert.equal(readFileSync(join(current.repository.path, '.handraise', 'product.md'), 'utf8'), before);
  }
});

test('uninitialized repository is published by one directory rename and crash completion is idempotent', () => {
  {
    const current = fixture({ initialized: false });
    const store = new PlanPublicationStore({ root: current.stateRoot, fault(stage) {
      if (stage === 'before-initialize-rename') throw Object.assign(new Error('injected initialization rename failure'), { code: 'EXDEV' });
    } });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    assert.throws(
      () => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }),
      /injected initialization rename failure/,
    );
    assert.equal(existsSync(join(current.repository.path, '.handraise')), false);
    assert.equal(existsSync(join(current.repository.path, `.handraise.publish-${preview.id}`)), false);
    assert.equal(existsSync(join(current.repository.path, '.handraise-publication.lock')), false);
  }
  {
    const current = fixture({ initialized: false }); const store = new PlanPublicationStore({ root: current.stateRoot });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    assert.ok(preview.operations.some((item) => item.kind === 'project'));
    assert.equal(existsSync(join(current.repository.path, '.handraise')), false);
    const result = store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) });
    assert.equal(result.committed, true);
    assert.equal(existsSync(join(current.repository.path, '.handraise', 'components', 'system-planning.md')), true);
    assert.equal(existsSync(join(current.repository.path, '.handraise', 'fronts', 'publish-reviewed-plan.md')), true);
    assert.equal(existsSync(join(current.repository.path, '.handraise', 'product.md')), true);
  }
  {
    const current = fixture({ initialized: false });
    const store = new PlanPublicationStore({ root: current.stateRoot, fault(stage) {
      if (stage === 'after-initialize-rename') throw Object.assign(new Error('simulated process crash'), { code: 'SIMULATED_CRASH', simulateCrash: true });
    } });
    const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
    assert.throws(() => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }), (error) => error.code === 'SIMULATED_CRASH');
    assert.equal(existsSync(join(current.repository.path, '.handraise', 'publications', `${preview.id}.json`)), true);
    const result = store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck() { throw new Error('already complete'); } });
    assert.equal(result.committed, true);
  }
});

test('a live publication process owns the repository lock and its sealed stale lock is recovered', async () => {
  const current = fixture(); const store = new PlanPublicationStore({ root: current.stateRoot });
  const preview = store.create(current.repository, current.workspace, completeSelection(), { actor });
  const lock = join(current.repository.path, '.handraise', '.management-lock');
  const child = spawn(process.execPath, ['-e', `
    const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const lock = process.argv[1];
    mkdirSync(lock, { mode: 0o700 });
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().slice(0, 8);
    const owner = { schemaVersion: 1, kind: 'plan-publication', token: 'child-owner', previewId: 'child', seal: process.pid + '@' + started + '@' + boot, pid: process.pid, acquiredAt: new Date().toISOString() };
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1_000);
  `, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => reject(new Error(`lock owner child did not become ready: ${stderr}`)), 5_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { if (code !== null) { clearTimeout(timer); reject(new Error(`lock owner child exited ${code}: ${stderr}`)); } });
    child.stdout.once('data', (chunk) => { clearTimeout(timer); assert.match(String(chunk), /ready/); resolve(); });
  });
  try {
    await ready;
    assert.throws(
      () => store.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }),
      (error) => error.code === 'PUBLICATION_BUSY',
    );
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const result = store.commit(current.repository, preview.id, {
    expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace),
  });
  assert.equal(result.committed, true, 'the dead process seal allows safe stale-lock reclamation');
});

test('server startup recovers a durable interrupted publication journal before serving', async () => {
  const current = fixture();
  const appRoot = join(current.root, 'server-state');
  const previewRoot = join(appRoot, 'plan-publication-previews');
  const config = new ConfigStore({ root: appRoot, resolveRepository: () => current.repository.path, home: current.root });
  const registered = config.addRepository(current.repository.path, { name: current.repository.name });
  current.repository = { ...registered, adapter: 'handraise' };
  current.workspace.snapshot.repository.id = registered.id;
  current.workspace.componentDraft.repositoryId = registered.id;
  current.workspace.frontDraft.repositoryId = registered.id;
  current.workspace.productDraft.repositoryId = registered.id;
  const before = readFileSync(join(current.repository.path, '.handraise', 'product.md'), 'utf8');
  const crashing = new PlanPublicationStore({ root: previewRoot, fault(stage, context) {
    if (stage === 'after-operation' && context.index === 0) throw Object.assign(new Error('simulated process crash'), { code: 'SIMULATED_CRASH', simulateCrash: true });
  } });
  const preview = crashing.create(current.repository, current.workspace, completeSelection(), { actor });
  assert.throws(
    () => crashing.commit(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, sourceCheck: sourceCheck(current.workspace) }),
    (error) => error.code === 'SIMULATED_CRASH',
  );
  assert.equal(existsSync(join(current.repository.path, '.handraise', '.publication-transactions', preview.id)), true);

  const recovering = new PlanPublicationStore({ root: previewRoot });
  const webRoot = join(current.root, 'web'); mkdirSync(webRoot); writeFileSync(join(webRoot, 'index.html'), '<!doctype html>');
  const server = createHandraise({ root: appRoot, webRoot, config, auth: new PairingAuth({ root: appRoot }), publicationStore: recovering });
  try {
    assert.equal(existsSync(join(current.repository.path, '.handraise', '.publication-transactions', preview.id)), false);
    assert.equal(readFileSync(join(current.repository.path, '.handraise', 'product.md'), 'utf8'), before);
    const recovered = recovering.get(current.repository, preview.id);
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.failure.code, 'PUBLICATION_RECOVERED_ROLLBACK');
  } finally {
    server.emit('close');
    await server.handraise.shutdown();
  }
});

test('Director repositories fail honestly without calling a partial writer', () => {
  const current = fixture({ initialized: false });
  mkdirSync(join(current.repository.path, '.claude', 'components'), { recursive: true });
  mkdirSync(join(current.repository.path, '.claude', 'runtime', 'plans'), { recursive: true });
  current.repository.adapter = 'director';
  assert.throws(() => buildPublicationManifest(current.repository, current.workspace, { mode: 'components-only' }, { actor }), (error) => error.code === 'DIRECTOR_PUBLICATION_UNSUPPORTED');
  assert.equal(readdirSync(join(current.repository.path, '.claude', 'components')).length, 0);
});
