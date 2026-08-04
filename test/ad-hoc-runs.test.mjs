import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdHocRunError, AdHocRunStore, buildAdHocPreflight } from '../src/ad-hoc-runs.mjs';
import { initializeNativeRepository } from '../src/repositories.mjs';

function component() {
  return {
    slug: 'runtime', title: 'Runtime', order: 1, purpose: 'Own safe local execution.',
    outcomes: ['Unplanned work remains inspectable.'], responsibilities: ['Control agent processes.'],
    limits: ['No implicit delivery progress.'], invariants: ['Accepted plans never change from ad-hoc execution.'],
    interfaces: [], dependencies: [], dataSystems: ['Private run records'], territory: ['src/runtime/**'],
    verification: ['Run ad-hoc tests.'], evidence: [{ kind: 'declared', reference: 'intent:ad-hoc', reason: 'Accepted fixture context.' }],
    uncertainties: [], guidance: 'Investigate narrowly and propose planning changes explicitly.',
  };
}

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'handraise-ad-hoc-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryPath = join(root, 'repository'); mkdirSync(repositoryPath);
  const repository = { id: 'ad-hoc-fixture', name: 'Ad-hoc fixture', path: repositoryPath, adapter: 'handraise' };
  initializeNativeRepository(repository, { components: [component()] });
  const componentPath = join(repositoryPath, '.handraise', 'components', 'runtime.md');
  return { root, repository, componentPath, acceptedBytes: readFileSync(componentPath, 'utf8') };
}

function options(overrides = {}) {
  return {
    actor: { id: 'local', name: 'Server host', implicit: true },
    agent: 'codex', model: 'default', effort: 'high', isolate: true,
    agentIntegration: {
      id: 'codex', title: 'Codex', version: '1.0.0', enabled: true, installed: true,
      efforts: ['low', 'medium', 'high'], auth: { connected: true, provider: 'openai-cli' },
      capabilities: { terminal: true, lifecycleAttention: true, typedPermissions: true, gracefulWrapup: true, configured: true },
    },
    repositoryGit: {
      available: true, path: '/repository', branch: 'main', revision: '1'.repeat(40),
      baseline: '1'.repeat(40), baselineRevision: '1'.repeat(40), dirty: 0, ahead: 0, behind: 0, unbacked: 0, branchMismatch: false,
    },
    workshop: { worktrees: [], orphans: [] }, sessions: [], plannedRuns: [], adHocRuns: [],
    ...overrides,
  };
}

test('[R0-RUN-07][R0-T12] ad-hoc preflight is explicit, exact, side-effect-free and never invents planned provenance', (context) => {
  const current = fixture(context);
  assert.throws(() => buildAdHocPreflight(current.repository, { purpose: 'short' }, options()), (error) => error instanceof AdHocRunError && error.code === 'ADHOC_PURPOSE_REQUIRED');
  const before = readFileSync(current.componentPath, 'utf8');
  const preflight = buildAdHocPreflight(current.repository, {
    purpose: 'Investigate why local session recovery occasionally loses visible context.', componentSlug: 'runtime', isolate: true,
  }, options());
  assert.equal(preflight.kind, 'ad-hoc');
  assert.equal(preflight.work.provenance.planned, false);
  assert.equal(preflight.work.provenance.front, null);
  assert.equal(preflight.work.provenance.release, null);
  assert.equal(preflight.work.provenance.deliveryProgress, false);
  assert.equal(preflight.work.component.slug, 'runtime');
  assert.equal(preflight.work.component.revision.length, 64);
  assert.equal(preflight.execution.isolate, true);
  assert.match(preflight.workspace.branch, /^handraise\/adhoc-/);
  assert.match(preflight.context.prompt, /explicitly unplanned ad-hoc run/i);
  assert.match(preflight.context.prompt, /cannot satisfy a requirement, front or release/i);
  assert.equal(preflight.readiness.ready, true);
  assert.equal(readFileSync(current.componentPath, 'utf8'), before);

  const unscoped = buildAdHocPreflight(current.repository, {
    purpose: 'Inspect a repository-wide symptom without claiming a component owner.',
  }, options());
  assert.equal(unscoped.readiness.ready, true);
  assert.ok(unscoped.readiness.diagnostics.some((item) => item.code === 'ADHOC_COMPONENT_UNSCOPED' && item.severity === 'warning'));
});

test('ad-hoc readiness applies agent, ownership and Git safety without requiring a fake front', (context) => {
  const current = fixture(context);
  const details = { purpose: 'Diagnose a bounded runtime ownership conflict before proposing planned work.', componentSlug: 'runtime' };
  const disconnected = buildAdHocPreflight(current.repository, details, options({
    agentIntegration: { ...options().agentIntegration, auth: { connected: false } },
  }));
  assert.ok(disconnected.readiness.diagnostics.some((item) => item.code === 'ADHOC_AGENT_AUTH_REQUIRED' && item.severity === 'error'));
  const dirtyPrimary = buildAdHocPreflight(current.repository, { ...details, isolate: false }, options({
    isolate: false, repositoryGit: { ...options().repositoryGit, dirty: 2 },
  }));
  assert.ok(dirtyPrimary.readiness.diagnostics.some((item) => item.code === 'ADHOC_PRIMARY_WORKTREE_UNSAFE'));
  const conflict = buildAdHocPreflight(current.repository, details, options({
    sessions: [{ repoId: current.repository.id, component: 'runtime', front: 'planned-runtime', role: 'agent', slug: 'planned-runtime' }],
  }));
  assert.ok(conflict.readiness.diagnostics.some((item) => item.code === 'ADHOC_ACTIVE_OWNERSHIP_CONFLICT'));
  assert.equal(conflict.work.provenance.front, null);
});

test('ad-hoc start is confirmation-bound, idempotent, revalidated and rolls back only its new workspace', (context) => {
  const current = fixture(context);
  const store = new AdHocRunStore({ root: join(current.root, 'state'), now: () => Date.parse('2026-08-04T15:00:00.000Z') });
  const details = { purpose: 'Investigate an isolated runtime recovery defect with exact component guidance.', componentSlug: 'runtime' };
  const reviewedOptions = options();
  const preflight = store.prepare(current.repository, details, reviewedOptions);
  let workspaces = 0; let launches = 0; let rollbacks = 0;
  const boundaries = {
    currentOptions: () => reviewedOptions,
    createWorkspace: ({ preflight: reviewed }) => {
      workspaces += 1;
      return { path: reviewed.workspace.path, branch: reviewed.workspace.branch, created: true, baseline: '1'.repeat(40), revision: '1'.repeat(40) };
    },
    removeWorkspace: () => { rollbacks += 1; },
    launch: ({ manifest }) => { launches += 1; return { existed: false, slug: manifest.work.slug, controlSlug: `${current.repository.id}--${manifest.work.slug}`, tmux: `handraise-${manifest.work.slug}` }; },
  };
  assert.throws(() => store.start(current.repository, preflight.id, {
    expectedRevision: preflight.revision, confirmed: false, actor: reviewedOptions.actor, ...boundaries,
  }), (error) => error.code === 'ADHOC_CONFIRMATION_REQUIRED');
  assert.equal(workspaces, 0); assert.equal(launches, 0);
  const started = store.start(current.repository, preflight.id, {
    expectedRevision: preflight.revision, confirmed: true, actor: reviewedOptions.actor, ...boundaries,
  });
  assert.equal(started.kind, 'ad-hoc'); assert.equal(started.state, 'running');
  assert.equal(started.manifest.provenance.deliveryProgress, false);
  assert.equal(workspaces, 1); assert.equal(launches, 1);
  const again = store.start(current.repository, preflight.id, {
    expectedRevision: preflight.revision, confirmed: true, actor: reviewedOptions.actor, ...boundaries,
  });
  assert.equal(again.id, started.id); assert.equal(workspaces, 1); assert.equal(launches, 1);

  const stale = store.prepare(current.repository, {
    purpose: 'Review a second bounded runtime symptom after exact source context changes.', componentSlug: 'runtime',
  }, reviewedOptions);
  writeFileSync(current.componentPath, `${readFileSync(current.componentPath, 'utf8')}\nHuman change.\n`);
  assert.throws(() => store.start(current.repository, stale.id, {
    expectedRevision: stale.revision, confirmed: true, actor: reviewedOptions.actor, ...boundaries,
  }), (error) => error.code === 'ADHOC_PREFLIGHT_STALE');
  assert.equal(workspaces, 1, 'stale exact context must fail before workspace allocation');

  writeFileSync(current.componentPath, current.acceptedBytes);
  const failing = store.prepare(current.repository, {
    purpose: 'Exercise rollback when the selected ad-hoc agent cannot launch safely.', componentSlug: 'runtime',
  }, reviewedOptions);
  assert.throws(() => store.start(current.repository, failing.id, {
    expectedRevision: failing.revision, confirmed: true, actor: reviewedOptions.actor,
    ...boundaries, launch: () => { launches += 1; throw new Error('injected ad-hoc launch failure'); },
  }), /injected ad-hoc launch failure/);
  assert.equal(rollbacks, 1);
  assert.equal(store.list(current.repository).some((run) => run.state === 'failed'), true);
});

test('[R0-T12] ad-hoc restart preserves run identity and revalidates actor, agent, ownership, component and workspace', (context) => {
  const current = fixture(context);
  const store = new AdHocRunStore({ root: join(current.root, 'state'), now: () => Date.parse('2026-08-04T15:30:00.000Z') });
  const sessions = [];
  const selected = options({ sessions, sessionsAfter: () => sessions });
  const preflight = store.prepare(current.repository, {
    purpose: 'Restart one bounded diagnosis without replacing its durable ad-hoc identity.', componentSlug: 'runtime',
  }, selected);
  let initialLaunches = 0; let restarts = 0; let inspections = 0;
  const started = store.start(current.repository, preflight.id, {
    expectedRevision: preflight.revision, confirmed: true, actor: selected.actor, currentOptions: selected,
    createWorkspace: ({ preflight: reviewed }) => ({ path: reviewed.workspace.path, branch: reviewed.workspace.branch, created: true, baseline: '1'.repeat(40), revision: '1'.repeat(40) }),
    removeWorkspace() {},
    launch: ({ manifest }) => {
      initialLaunches += 1;
      const session = { runId: manifest.id, repoId: current.repository.id, component: 'runtime', front: null, role: 'ad-hoc', slug: manifest.work.slug, controlSlug: `${current.repository.id}--${manifest.work.slug}`, agent: 'codex', cwd: manifest.workspace.path, error: null };
      sessions.push(session); return { existed: false, slug: session.slug, controlSlug: session.controlSlug, tmux: `handraise-${session.controlSlug}` };
    },
  });
  const currentOptions = () => options({ sessions, sessionsAfter: () => sessions, adHocRuns: store.list(current.repository, { sessions }) });
  const boundaries = {
    actor: selected.actor, currentOptions,
    inspectWorkspace: ({ workspace }) => {
      inspections += 1;
      return { available: true, path: workspace.path, branch: workspace.branch, branchMismatch: false, dirty: 1, ahead: 0, unbacked: 0 };
    },
    launch: ({ manifest }) => {
      restarts += 1;
      const session = { runId: manifest.id, repoId: current.repository.id, component: 'runtime', front: null, role: 'ad-hoc', slug: manifest.work.slug, controlSlug: `${current.repository.id}--${manifest.work.slug}`, agent: 'codex', cwd: manifest.workspace.path, error: null };
      sessions.push(session); return { existed: false, slug: session.slug, controlSlug: session.controlSlug, tmux: `handraise-${session.controlSlug}` };
    },
  };
  const alreadyLive = store.restart(current.repository, started.id, { expectedRevision: started.revision, confirmed: true, ...boundaries });
  assert.equal(alreadyLive.id, started.id); assert.equal(restarts, 0); assert.equal(inspections, 0);
  sessions.length = 0;
  assert.throws(() => store.restart(current.repository, started.id, { expectedRevision: started.revision, confirmed: false, ...boundaries }), (error) => error.code === 'ADHOC_RESTART_CONFIRMATION_REQUIRED');
  const restarted = store.restart(current.repository, started.id, { expectedRevision: started.revision, confirmed: true, ...boundaries });
  assert.equal(restarted.id, started.id); assert.equal(restarted.manifest.revision, started.manifest.revision);
  assert.equal(restarted.state, 'running'); assert.equal(restarts, 1); assert.equal(inspections, 1); assert.equal(initialLaunches, 1);
  assert.equal(restarted.events.at(-1).type, 'restarted');

  sessions.length = 0;
  writeFileSync(current.componentPath, `${current.acceptedBytes}\nAccepted component changed.\n`);
  assert.throws(() => store.restart(current.repository, restarted.id, { expectedRevision: restarted.revision, confirmed: true, ...boundaries }), (error) => error.code === 'ADHOC_RESTART_STALE');
  assert.equal(restarts, 1, 'stale component context must fail before process launch');
  writeFileSync(current.componentPath, current.acceptedBytes);
  const conflicting = () => options({
    sessions, sessionsAfter: () => sessions,
    plannedRuns: [{ id: 'planned-owner', state: 'running', manifest: { components: [{ slug: 'runtime' }] } }],
    adHocRuns: store.list(current.repository, { sessions }),
  });
  assert.throws(() => store.restart(current.repository, restarted.id, {
    expectedRevision: restarted.revision, confirmed: true, ...boundaries, currentOptions: conflicting,
  }), (error) => error.code === 'ADHOC_RESTART_OWNERSHIP_CONFLICT');
  assert.equal(restarts, 1);
});

test('ad-hoc outcome, evidence and promotion remain durable and create zero accepted delivery progress', (context) => {
  const current = fixture(context);
  const storeRoot = join(current.root, 'state');
  const store = new AdHocRunStore({ root: storeRoot, now: () => Date.parse('2026-08-04T16:00:00.000Z') });
  const reviewedOptions = options();
  const preflight = store.prepare(current.repository, {
    purpose: 'Explore a runtime defect and preserve evidence for a later reviewed front.', componentSlug: 'runtime',
  }, reviewedOptions);
  let run = store.start(current.repository, preflight.id, {
    expectedRevision: preflight.revision, confirmed: true, actor: reviewedOptions.actor,
    currentOptions: () => reviewedOptions,
    createWorkspace: ({ preflight: reviewed }) => ({ path: reviewed.workspace.path, branch: reviewed.workspace.branch, created: true, baseline: '1'.repeat(40), revision: '1'.repeat(40) }),
    removeWorkspace: () => {},
    launch: ({ manifest }) => ({ existed: false, slug: manifest.work.slug, controlSlug: `${current.repository.id}--${manifest.work.slug}` }),
  });
  run = store.addDiscovery(current.repository, run.id, {
    kind: 'discovery', summary: 'Recovery loses one derived terminal cursor after reconnect.', evidence: 'Observed in isolated fixture.',
  }, { actor: reviewedOptions.actor, expectedRevision: run.revision });
  run = store.recordCheck(current.repository, run.id, {
    label: 'Reproduction is deterministic', status: 'passed', source: 'user-observed', evidence: 'Repeated three times.',
  }, { actor: reviewedOptions.actor, expectedRevision: run.revision });
  run = store.handoff(current.repository, run.id, {
    summary: 'The symptom is bounded and ready for planning review.', nextSteps: ['Propose a front.'], blockers: [],
  }, { actor: reviewedOptions.actor, expectedRevision: run.revision });
  run = store.complete(current.repository, run.id, {
    status: 'completed', summary: 'Diagnosis completed; no accepted plan was changed.', actor: reviewedOptions.actor,
    expectedRevision: run.revision, sessions: [],
    git: { ...reviewedOptions.repositoryGit, path: run.manifest.workspace.path, dirty: 1, unbacked: 1 },
  });
  assert.equal(run.state, 'completed');
  assert.equal(run.outcome.accepted, false);
  assert.equal(run.outcome.deliveryProgress, false);
  assert.equal(run.outcome.git.dirty, 1, 'unintegrated work remains visible instead of being cleaned implicitly');
  let promoted = store.proposePromotion(current.repository, run.id, {
    target: { kind: 'new-front', id: null }, summary: 'Plan and verify terminal cursor recovery.',
  }, { actor: reviewedOptions.actor, expectedRevision: run.revision });
  assert.equal(promoted.proposals[0].state, 'review');
  assert.equal(promoted.proposals[0].mutatesAcceptedState, false);
  assert.equal(promoted.proposals[0].retroactivePlanned, false);
  promoted = store.proposePromotion(current.repository, run.id, {
    target: { kind: 'existing-front', id: 'runtime-recovery' }, summary: 'Review the discovery against an existing front.',
  }, { actor: reviewedOptions.actor, expectedRevision: promoted.revision });
  promoted = store.proposePromotion(current.repository, run.id, {
    target: { kind: 'release-review', id: 'release-0' }, summary: 'Classify the discovery during release review.',
  }, { actor: reviewedOptions.actor, expectedRevision: promoted.revision });
  assert.deepEqual(promoted.proposals.map((item) => item.target), [
    { kind: 'new-front', id: null }, { kind: 'existing-front', id: 'runtime-recovery' }, { kind: 'release-review', id: 'release-0' },
  ]);
  assert.ok(promoted.proposals.every((item) => item.state === 'review' && item.mutatesAcceptedState === false && item.deliveryProgress === false));
  assert.equal(readFileSync(current.componentPath, 'utf8'), current.acceptedBytes);

  const restarted = new AdHocRunStore({ root: storeRoot, now: () => Date.parse('2026-08-04T16:05:00.000Z') });
  const durable = restarted.get(current.repository, run.id);
  assert.equal(durable.discoveries.length, 1);
  assert.equal(durable.checks.length, 1);
  assert.equal(durable.handoffs.length, 1);
  assert.equal(durable.proposals.length, 3);
  assert.equal(durable.manifest.provenance.front, null);
  assert.equal(durable.manifest.provenance.release, null);
});
