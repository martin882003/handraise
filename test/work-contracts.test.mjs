import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyWorkContractMigration,
  previewWorkContractMigration,
  repositoryPortfolio,
} from '../src/repositories.mjs';

import {
  WorkContractError,
  assertPortfolioContracts,
  createComponentMarkdown,
  createFrontMarkdown,
  migrateComponentMarkdown,
  migrateFrontMarkdown,
  parseComponentContract,
  parseFrontContract,
  updateComponentMarkdown,
  updateFrontMarkdown,
  validatePortfolioContracts,
  workContractRevision,
} from '../src/work-contracts.mjs';

const component = (overrides = {}) => ({
  slug: 'runtime-control', title: 'Runtime Control', state: 'active', order: 1,
  contract: {
    purpose: 'Own reliable agent runtime control.',
    outcomes: ['Agent processes have observable lifecycles.'],
    responsibilities: ['Start, observe and stop agent sessions.'],
    limits: ['Does not decide product priorities.'],
    invariants: ['A session has one repository owner.'],
    interfaces: [{ kind: 'provides', target: 'client-experience', description: 'Typed runtime state.' }],
    dependencies: [{ kind: 'soft', target: 'client-experience', reason: 'Coordinates status presentation.' }],
    dataSystems: ['tmux process state'],
    territory: ['src/control.mjs'],
    verification: ['Run the focused lifecycle tests.'],
    evidence: [{ kind: 'declared', reference: 'docs/runtime.md', reason: 'Accepted runtime design.' }],
    uncertainties: ['Windows process isolation remains unverified.'],
    guidance: 'Preserve typed lifecycle transitions.',
  },
  ...overrides,
});

const front = (overrides = {}) => ({
  slug: 'safe-lifecycle', title: 'Make lifecycle safe', component: 'runtime-control',
  state: 'queued', impact: 'alto', complexity: 'media', affectedComponents: ['client-experience'],
  goalIds: ['goal:reliable-control'],
  outcome: 'Every agent process has a safe observable lifecycle.',
  motivation: 'Untracked processes make the fleet unreliable.',
  scope: 'Lifecycle state and process cleanup.',
  nonGoals: ['Redesign the terminal.'], readiness: ['Runtime contract is accepted.'],
  acceptanceCriteria: ['A crashed child becomes failed.'], verification: ['Run lifecycle tests.'],
  deliverables: ['Typed lifecycle service.'], risks: ['Platform-specific signals.'],
  dependencies: [{ kind: 'hard', target: 'foundation', reason: 'Needs the process contract.' }],
  evidence: [{ kind: 'declared', reference: 'goal:reliable-control', reason: 'Product goal.' }],
  context: 'The existing runtime starts processes but needs explicit terminal states.',
  handoff: 'Begin with the lifecycle state machine and preserve current session IDs.',
  tasks: ['Define lifecycle states', 'Cover cancellation'],
  ...overrides,
});

test('component and front v2 renderers round-trip every designed-work field', () => {
  const componentMarkdown = createComponentMarkdown(component(), { since: '2026-08-03' });
  const parsedComponent = parseComponentContract(componentMarkdown);
  assert.equal(parsedComponent.schemaVersion, 2);
  assert.equal(parsedComponent.contract.purpose, 'Own reliable agent runtime control.');
  assert.deepEqual(parsedComponent.contract.interfaces[0], {
    kind: 'provides', target: 'client-experience', description: 'Typed runtime state.',
    raw: '[provides] client-experience — Typed runtime state.',
  });
  assert.equal(parsedComponent.contract.evidence[0].kind, 'declared');

  const frontMarkdown = createFrontMarkdown(front());
  const parsedFront = parseFrontContract(frontMarkdown);
  assert.equal(parsedFront.schemaVersion, 2);
  assert.equal(parsedFront.component, 'runtime-control');
  assert.deepEqual(parsedFront.affectedComponents, ['client-experience']);
  assert.deepEqual(parsedFront.goalIds, ['goal:reliable-control']);
  assert.equal(parsedFront.dependencies[0].kind, 'hard');
  assert.equal(parsedFront.acceptanceCriteria[0], 'A crashed child becomes failed.');
  assert.equal(parsedFront.tasks.length, 2);
});

test('targeted updates preserve unknown frontmatter, sections, comments and human text', () => {
  const legacy = [
    '---', 'slug: preserve-me', 'title: Human title', 'state: queued', 'owner_note: keep exactly', '---', '',
    '# preserve-me — Human title', '', '**Componente:** runtime-control', '',
    '## Observable outcome', '', 'Old outcome.', '', '<!-- rationale: do not erase -->', '',
    '## Custom human section', '', 'Spacing and prose stay here.', '',
    '## Confirmed context', '', 'This context is deliberately long enough for the editor.', '',
    '## ▶ Handoff', '', 'Keep the custom contract while editing.', '',
    '## Checklist', '', '- [ ] 1. Existing task', '',
  ].join('\n');
  const updated = updateFrontMarkdown(legacy, {
    title: 'Changed title', outcome: 'New outcome.', state: 'active',
    tasks: [{ state: 'done', text: 'Existing task' }],
  });
  assert.match(updated, /owner_note: keep exactly/);
  assert.match(updated, /## Custom human section\n\nSpacing and prose stay here\./);
  assert.match(updated, /<!-- rationale: do not erase -->/);
  assert.match(updated, /# preserve-me — Changed title/);
  assert.equal(parseFrontContract(updated).state, 'done', 'a fully checked front remains terminal');

  const componentLegacy = [
    '---', 'slug: runtime-control', 'titulo: Runtime', 'estado: activo', 'custom: yes', '---', '',
    '## Alcance', '', 'Old scope.', '', '<!-- architectural decision -->', '',
    '## Human notes', '', 'Never discard this section.', '',
  ].join('\n');
  const componentUpdated = updateComponentMarkdown(componentLegacy, { title: 'Runtime Control', scope: 'New purpose.' });
  assert.match(componentUpdated, /custom: yes/);
  assert.match(componentUpdated, /## Human notes\n\nNever discard this section\./);
  assert.match(componentUpdated, /<!-- architectural decision -->/);
  assert.equal(parseComponentContract(componentUpdated).contract.purpose.startsWith('New purpose.'), true);
});

test('v1 migration is explicit, additive and an exact no-op once on v2', () => {
  const componentV1 = '---\nslug: runtime\ntitle: Runtime\nstate: active\nunknown: retained\n---\n\n## Scope\n\nOwn runtime.\n\n## Custom\n\nKeep me.\n';
  const migratedComponent = migrateComponentMarkdown(componentV1);
  assert.match(migratedComponent, /schema: 2/);
  assert.match(migratedComponent, /unknown: retained/);
  assert.match(migratedComponent, /## Scope\n\nOwn runtime\./);
  assert.match(migratedComponent, /## Custom\n\nKeep me\./);
  assert.match(migratedComponent, /## Interfaces\n\n_None declared\._/);
  assert.equal(migrateComponentMarkdown(migratedComponent), migratedComponent);

  const frontV1 = '---\nslug: ship\ncomponent: runtime\nstate: queued\n---\n\n# ship — Ship safely\n\n## Checklist\n\n- [ ] Verify it\n';
  const migratedFront = migrateFrontMarkdown(frontV1);
  assert.match(migratedFront, /schema: 2/);
  assert.match(migratedFront, /affected: \[\]/);
  assert.match(migratedFront, /goals: \[\]/);
  assert.match(migratedFront, /## Acceptance criteria/);
  assert.equal(migrateFrontMarkdown(migratedFront), migratedFront);
});

test('portfolio validation reports references, one lead, lifecycle, goals and hard cycles', () => {
  const components = [
    parseComponentContract(createComponentMarkdown(component())),
    parseComponentContract(createComponentMarkdown(component({
      slug: 'client-experience', title: 'Client Experience', order: 2,
      contract: { ...component().contract, interfaces: [], dependencies: [] },
    }))),
  ];
  const foundation = parseFrontContract(createFrontMarkdown(front({
    slug: 'foundation', title: 'Foundation', component: 'runtime-control', affectedComponents: [],
    dependencies: [{ kind: 'hard', target: 'safe-lifecycle', reason: 'Deliberate cycle fixture.' }],
  })));
  const lifecycle = parseFrontContract(createFrontMarkdown(front()));
  const invalid = validatePortfolioContracts(components, [foundation, lifecycle], { goalIds: ['goal:reliable-control'] });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some((item) => item.code === 'HARD_DEPENDENCY_CYCLE'));

  const validFoundation = parseFrontContract(createFrontMarkdown(front({
    slug: 'foundation', title: 'Foundation', component: 'runtime-control', affectedComponents: [],
    dependencies: [],
  })));
  const valid = assertPortfolioContracts(components, [validFoundation, lifecycle], { goalIds: ['goal:reliable-control'] });
  assert.equal(valid.valid, true);

  assert.throws(() => assertPortfolioContracts(components, [parseFrontContract(createFrontMarkdown(front({
    component: 'missing', affectedComponents: ['runtime-control'], goalIds: ['goal:missing'], dependencies: [],
  })))], { goalIds: ['goal:reliable-control'] }), (error) => {
    assert.ok(error instanceof WorkContractError);
    assert.ok(error.diagnostics.some((item) => item.code === 'UNKNOWN_LEAD_COMPONENT'));
    assert.ok(error.diagnostics.some((item) => item.code === 'UNKNOWN_GOAL'));
    return true;
  });
});

test('contract revisions are deterministic and change with exact bytes', () => {
  const markdown = createComponentMarkdown(component());
  assert.equal(workContractRevision(markdown), workContractRevision(markdown));
  assert.notEqual(workContractRevision(markdown), workContractRevision(`${markdown}\n`));
});

function migrationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'handraise-contract-migration-'));
  mkdirSync(join(root, '.handraise', 'components'), { recursive: true });
  mkdirSync(join(root, '.handraise', 'fronts'), { recursive: true });
  const componentPath = join(root, '.handraise', 'components', 'runtime.md');
  const frontPath = join(root, '.handraise', 'fronts', 'ship.md');
  writeFileSync(componentPath, [
    '---', 'slug: runtime', 'title: Runtime', 'state: active', 'custom_owner: human', '---', '',
    '## Scope', '', 'Own runtime.', '', '## Human notes', '', 'Preserve this.', '',
  ].join('\n'));
  writeFileSync(frontPath, [
    '---', 'slug: ship', 'component: runtime', 'state: queued', 'custom_order: deliberate', '---', '',
    '# ship — Ship safely', '', '**Componente:** runtime', '',
    '## Observable outcome', '', 'The runtime ships safely.', '',
    '## Confirmed context', '', 'The legacy plan needs an explicit versioned migration.', '',
    '## ▶ Handoff', '', 'Preserve every human section during migration.', '',
    '## Checklist', '', '- [ ] 1. Review migration', '',
  ].join('\n'));
  return {
    root, componentPath, frontPath,
    repository: { id: 'migration', name: 'Migration', path: root, adapter: 'handraise' },
  };
}

test('[R0-RPL-02][R0-T03] repository migration previews exact bytes, rejects stale baselines and becomes a stable no-op', () => {
  const fixture = migrationFixture();
  const componentBefore = readFileSync(fixture.componentPath, 'utf8');
  const frontBefore = readFileSync(fixture.frontPath, 'utf8');
  const preview = previewWorkContractMigration(fixture.repository);
  assert.equal(preview.canApply, true);
  assert.equal(preview.operations.length, 2);
  assert.equal(preview.operations.every((operation) => !('path' in operation)), true, 'private absolute paths are not published');
  assert.equal(readFileSync(fixture.componentPath, 'utf8'), componentBefore);
  assert.equal(readFileSync(fixture.frontPath, 'utf8'), frontBefore);

  writeFileSync(fixture.frontPath, `${frontBefore}\n<!-- concurrent edit -->\n`);
  assert.throws(() => applyWorkContractMigration(fixture.repository, { previewId: preview.previewId }), (error) => error.code === 'WORK_CONTRACT_BASELINE_CHANGED');
  assert.equal(readFileSync(fixture.componentPath, 'utf8'), componentBefore);
  assert.match(readFileSync(fixture.frontPath, 'utf8'), /concurrent edit/);

  const current = previewWorkContractMigration(fixture.repository);
  const applied = applyWorkContractMigration(fixture.repository, { previewId: current.previewId });
  assert.equal(applied.applied, true);
  assert.equal(applied.migrated, 2);
  assert.match(readFileSync(fixture.componentPath, 'utf8'), /schema: 2/);
  assert.match(readFileSync(fixture.componentPath, 'utf8'), /custom_owner: human/);
  assert.match(readFileSync(fixture.componentPath, 'utf8'), /## Human notes\n\nPreserve this\./);
  assert.match(readFileSync(fixture.frontPath, 'utf8'), /custom_order: deliberate/);
  assert.match(readFileSync(fixture.frontPath, 'utf8'), /concurrent edit/);
  assert.equal(repositoryPortfolio(fixture.repository).workContracts.migrationAvailable, false);

  const after = readFileSync(fixture.frontPath, 'utf8');
  const noOp = previewWorkContractMigration(fixture.repository);
  assert.equal(noOp.noOp, true);
  const noOpApply = applyWorkContractMigration(fixture.repository, { previewId: noOp.previewId });
  assert.equal(noOpApply.applied, false);
  assert.equal(readFileSync(fixture.frontPath, 'utf8'), after);
});

test('[R0-RPL-02][R0-T03] front-scoped migration upgrades only that front and its referenced components', () => {
  const fixture = migrationFixture();
  const docsComponent = join(fixture.root, '.handraise', 'components', 'docs.md');
  const docsFront = join(fixture.root, '.handraise', 'fronts', 'publish-docs.md');
  writeFileSync(docsComponent, [
    '---', 'slug: docs', 'title: Docs', 'state: active', '---', '',
    '## Scope', '', 'Own documentation.', '',
  ].join('\n'));
  writeFileSync(docsFront, [
    '---', 'slug: publish-docs', 'component: docs', 'state: queued', '---', '',
    '# publish-docs — Publish docs', '', '## Observable outcome', '', 'Docs are published.', '',
    '## Confirmed context', '', 'The documentation front remains outside this migration.', '',
    '## ▶ Handoff', '', 'Preserve the unrelated legacy contract.', '',
    '## Checklist', '', '- [ ] Publish docs', '',
  ].join('\n'));
  const docsComponentBefore = readFileSync(docsComponent, 'utf8');
  const docsFrontBefore = readFileSync(docsFront, 'utf8');

  const preview = previewWorkContractMigration(fixture.repository, { frontSlugs: ['ship'] });
  assert.deepEqual(preview.scope, { mode: 'selected', frontSlugs: ['ship'], componentSlugs: ['runtime'] });
  assert.deepEqual(preview.operations.map((operation) => `${operation.kind}:${operation.slug}`), ['component:runtime', 'front:ship']);
  const applied = applyWorkContractMigration(fixture.repository, {
    previewId: preview.previewId, frontSlugs: ['ship'],
  });
  assert.equal(applied.migrated, 2);
  assert.match(readFileSync(fixture.componentPath, 'utf8'), /schema: 2/);
  assert.match(readFileSync(fixture.frontPath, 'utf8'), /schema: 2/);
  assert.equal(readFileSync(docsComponent, 'utf8'), docsComponentBefore);
  assert.equal(readFileSync(docsFront, 'utf8'), docsFrontBefore);
  assert.equal(repositoryPortfolio(fixture.repository).workContracts.migrationAvailable, true, 'unrelated v1 contracts remain explicitly migratable');

  const noOp = previewWorkContractMigration(fixture.repository, { frontSlugs: ['ship'] });
  assert.equal(noOp.noOp, true);
  assert.deepEqual(noOp.scope.componentSlugs, ['runtime']);
  assert.throws(
    () => previewWorkContractMigration(fixture.repository, { frontSlugs: ['missing-front'] }),
    (error) => error.code === 'WORK_CONTRACT_MIGRATION_SCOPE_INVALID',
  );
});

test('[R0-RPL-02][R0-T03] multi-file migration rolls back prior writes when a later target cannot be committed', () => {
  const fixture = migrationFixture();
  const componentBefore = readFileSync(fixture.componentPath, 'utf8');
  const frontBefore = readFileSync(fixture.frontPath, 'utf8');
  const preview = previewWorkContractMigration(fixture.repository);
  const frontDirectory = join(fixture.root, '.handraise', 'fronts');
  chmodSync(frontDirectory, 0o555);
  try {
    assert.throws(() => applyWorkContractMigration(fixture.repository, { previewId: preview.previewId }));
  } finally {
    chmodSync(frontDirectory, 0o755);
  }
  assert.equal(readFileSync(fixture.componentPath, 'utf8'), componentBefore, 'the earlier component write was rolled back');
  assert.equal(readFileSync(fixture.frontPath, 'utf8'), frontBefore);
  assert.equal(previewWorkContractMigration(fixture.repository).previewId, preview.previewId);
});

test('Director migration is honestly unavailable and does not create native metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-contract-director-'));
  mkdirSync(join(root, '.claude', 'components'), { recursive: true });
  mkdirSync(join(root, '.claude', 'runtime', 'plans'), { recursive: true });
  const repository = { id: 'director', name: 'Director', path: root, adapter: 'director' };
  assert.throws(() => previewWorkContractMigration(repository), (error) => error.code === 'WORK_CONTRACT_MIGRATION_UNSUPPORTED');
  assert.throws(() => applyWorkContractMigration(repository, { previewId: 'reviewed' }), (error) => error.code === 'WORK_CONTRACT_MIGRATION_UNSUPPORTED');
  assert.equal(existsSync(join(root, '.handraise')), false);
  assert.equal(repositoryPortfolio(repository).mutations.workContracts.migrate, false);
});
