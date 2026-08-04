import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { normalizeProductBrief, renderProductBrief } from '../src/product-direction.mjs';
import { updateFront } from '../src/repositories.mjs';
import { RunOrchestrationStore, buildRunPreflight } from '../src/run-orchestration.mjs';
import { createComponentMarkdown, createFrontMarkdown } from '../src/work-contracts.mjs';

const actor = { id: 'local:test', name: 'Local reviewer', implicit: true };

function component(slug, territory) {
  return createComponentMarkdown({
    slug, title: slug === 'runtime' ? 'Runtime Control' : 'Repository Planning', state: 'active', order: slug === 'runtime' ? 1 : 2,
    contract: {
      purpose: `Own ${slug} responsibilities for accepted agent work.`,
      outcomes: [`${slug} outcomes remain verifiable.`], responsibilities: [`Maintain ${slug} boundaries.`],
      limits: ['No implicit product-plan mutation.'], invariants: ['Human acceptance remains authoritative.'],
      interfaces: [{ kind: 'provides', target: `${slug} contract`, description: 'Accepted execution context.' }],
      dependencies: [], dataSystems: ['Private run records'], territory: [territory],
      verification: ['Run the orchestration contract tests.'],
      evidence: [{ kind: 'declared', reference: `intent:${slug}`, reason: 'Accepted human boundary.' }],
      uncertainties: [`${slug} may reveal bounded discoveries.`], guidance: 'Stay inside the accepted front and report scope changes.',
    },
  });
}

function front(slug, state, overrides = {}) {
  return createFrontMarkdown({
    slug, title: slug === 'prepare-runtime' ? 'Prepare runtime' : 'Execute accepted plan', state, component: 'runtime',
    affectedComponents: ['repository-planning'], goalIds: ['goal:run'], analysisSnapshot: null,
    outcome: slug === 'prepare-runtime' ? 'The runtime dependency is ready.' : 'An accepted front runs from an immutable manifest.',
    motivation: 'Execution must preserve the exact reviewed plan.', scope: 'Compile accepted contracts into one bounded run.',
    nonGoals: ['No implicit completion.'], readiness: ['Hard dependencies are done.', 'Agent capability is available.'],
    acceptanceCriteria: ['The accepted outcome is explicitly reviewed.'], verification: ['Run orchestration tests pass.'],
    deliverables: ['Immutable run manifest and evidence record.'], risks: ['Agent claims can be wrong.'],
    dependencies: slug === 'execute-plan' ? [{ kind: 'hard', target: 'prepare-runtime', reason: 'Runtime preparation must finish first.' }] : [],
    evidence: [{ kind: 'declared', reference: 'intent:run', reason: 'Accepted product intent.' }],
    context: 'The repository contains accepted v2 product, component and front contracts.',
    handoff: 'Begin from the immutable run context and preserve explicit unknowns.',
    tasks: [{ state: 'open', text: 'Implement the bounded change.' }, { state: 'open', text: 'Collect verification evidence.' }],
    impact: 'alto', complexity: 'alta',
    ...overrides,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handraise-run-orchestration-'));
  const repositoryPath = join(root, 'repository'); const metadata = join(repositoryPath, '.handraise');
  mkdirSync(join(metadata, 'components'), { recursive: true }); mkdirSync(join(metadata, 'fronts'), { recursive: true });
  writeFileSync(join(metadata, 'project.json'), '{"version":1,"name":"Run fixture"}\n');
  writeFileSync(join(metadata, '.gitignore'), 'worktrees/\n.management-lock/\n');
  writeFileSync(join(metadata, 'components', 'runtime.md'), component('runtime', 'src/runtime/'));
  writeFileSync(join(metadata, 'components', 'repository-planning.md'), component('repository-planning', 'src/planning/'));
  writeFileSync(join(metadata, 'fronts', 'prepare-runtime.md'), front('prepare-runtime', 'done', { tasks: [{ state: 'done', text: 'Prepare the runtime dependency.' }] }));
  writeFileSync(join(metadata, 'fronts', 'execute-plan.md'), front('execute-plan', 'queued'));
  const brief = normalizeProductBrief({
    title: 'Run fixture', purpose: { id: 'purpose', text: 'Run accepted agent work safely.', sourceIds: ['source:human'], locked: true },
    users: [{ id: 'user:lead', text: 'Technical leads.', sourceIds: ['source:human'] }],
    outcomes: [{ id: 'outcome:run', text: 'Verified work reaches acceptance.', sourceIds: ['source:human'] }],
    constraints: [{ id: 'constraint:explicit', text: 'Start and completion are explicit.', sourceIds: ['source:human'], locked: true }],
    invariants: [{ id: 'invariant:claims', text: 'Agent claims are not facts.', sourceIds: ['source:human'], locked: true }],
    goals: [{ id: 'goal:run', title: 'Run accepted work', outcome: 'One accepted front completes with evidence.', priority: 'now', state: 'active', successSignals: ['The run is accepted.'], sourceIds: ['source:human'] }],
  }, { repositoryId: 'run-fixture', now: Date.parse('2026-08-03T12:00:00Z') });
  writeFileSync(join(metadata, 'product.md'), renderProductBrief(brief, { repositoryId: 'run-fixture', now: Date.parse('2026-08-03T12:00:00Z') }));
  return { root, repository: { id: 'run-fixture', name: 'Run fixture', path: repositoryPath, adapter: 'handraise' }, stateRoot: join(root, 'private-runs') };
}

function options(overrides = {}) {
  return {
    actor, agent: 'codex', model: 'fixture-model', effort: 'high', isolate: true,
    agentIntegration: { id: 'codex', title: 'Codex', version: 'fixture-1', enabled: true, installed: true, auth: { connected: true, provider: 'openai' }, capabilities: { terminal: true, configured: true, typedPermissions: true, lifecycleAttention: true, gracefulWrapup: true } },
    sessions: [], runs: [], workshop: { worktrees: [] }, repositoryGit: { available: true, branch: 'main', baseline: 'abc123', dirty: 0, ahead: 0, unbacked: 0, branchMismatch: false },
    ...overrides,
  };
}

function acceptedBytes(repository) {
  return ['product.md', 'components/runtime.md', 'components/repository-planning.md', 'fronts/prepare-runtime.md', 'fronts/execute-plan.md']
    .map((path) => [path, readFileSync(join(repository.path, '.handraise', ...path.split('/')), 'utf8')]);
}

test('preflight compiles exact accepted contracts without allocating execution and reports readiness honestly', () => {
  const current = fixture(); const before = acceptedBytes(current.repository);
  const preview = buildRunPreflight(current.repository, 'execute-plan', options());
  assert.equal(preview.readiness.ready, true);
  assert.equal(preview.dependencies[0].state, 'done');
  assert.equal(preview.front.revision.length, 64);
  assert.equal(preview.front.outcome, 'An accepted front runs from an immutable manifest.');
  assert.deepEqual(preview.front.acceptanceCriteria, ['The accepted outcome is explicitly reviewed.']);
  assert.deepEqual(preview.front.checklist.map((item) => item.state), ['open', 'open']);
  assert.equal(preview.components.length, 2);
  assert.equal(preview.components[0].purpose.length > 0, true);
  assert.equal(preview.execution.capabilities.typedPermissions, true);
  assert.equal(preview.source.repositoryRevision, 'abc123');
  assert.equal(preview.productContext.constraints[0], 'Start and completion are explicit.');
  assert.match(preview.context.prompt, /Observable outcome: An accepted front runs from an immutable manifest/);
  assert.match(preview.context.prompt, /Accepted product constraints and invariants/);
  assert.match(preview.context.prompt, /Front evidence:/);
  assert.match(preview.context.prompt, /An agent claim is not verification/);
  assert.match(preview.context.prompt, /Accepted source digest/);
  assert.equal(preview.workspace.branch, 'handraise/execute-plan');
  assert.deepEqual(acceptedBytes(current.repository), before);

  const store = new RunOrchestrationStore({ root: current.stateRoot });
  const persisted = store.prepare(current.repository, 'execute-plan', options());
  assert.equal(statSync(current.stateRoot).mode & 0o777, 0o700);
  assert.equal(persisted.revision.length, 64);
  assert.deepEqual(acceptedBytes(current.repository), before);
});

test('dependency, agent, ownership, stale-analysis and workspace risks block before any side effect', () => {
  {
    const current = fixture();
    writeFileSync(join(current.repository.path, '.handraise', 'fronts', 'prepare-runtime.md'), front('prepare-runtime', 'queued'));
    const preview = buildRunPreflight(current.repository, 'execute-plan', options({ agentIntegration: { enabled: true, installed: true, auth: { connected: false }, capabilities: { terminal: true, configured: true } } }));
    assert.equal(preview.readiness.ready, false);
    assert.ok(preview.readiness.diagnostics.some((item) => item.code === 'RUN_HARD_DEPENDENCY_NOT_DONE'));
    assert.ok(preview.readiness.diagnostics.some((item) => item.code === 'RUN_AGENT_AUTH_REQUIRED'));
    assert.ok(preview.readiness.diagnostics.every((item) => item.recovery));
  }
  {
    const current = fixture();
    const preview = buildRunPreflight(current.repository, 'execute-plan', options({
      sessions: [{ repoId: current.repository.id, slug: 'other', front: 'prepare-runtime', component: 'runtime' }],
      workshop: { worktrees: [{ path: join(current.repository.path, '.handraise', 'worktrees', 'execute-plan'), git: { dirty: 1, ahead: 1, unbacked: 1 } }] },
    }));
    assert.equal(preview.readiness.ready, false);
    assert.ok(preview.readiness.diagnostics.some((item) => item.code === 'RUN_ACTIVE_OWNERSHIP_CONFLICT'));
    assert.ok(preview.readiness.diagnostics.some((item) => item.code === 'RUN_EXISTING_WORKTREE_RISK'));
  }
  {
    const current = fixture();
    const preview = buildRunPreflight(current.repository, 'execute-plan', options({
      sessions: [{ repoId: current.repository.id, slug: 'interrupt-investigation', role: 'ad-hoc', front: null, component: 'runtime' }],
      adHocRuns: [{ id: 'adhoc-active', state: 'running', manifest: { work: { component: { slug: 'runtime' } } } }],
    }));
    assert.equal(preview.readiness.ready, false);
    const conflicts = preview.readiness.diagnostics.filter((item) => item.code === 'RUN_ACTIVE_OWNERSHIP_CONFLICT');
    assert.ok(conflicts.some((item) => /Ad-hoc session 'interrupt-investigation'/.test(item.message)));
    assert.ok(conflicts.some((item) => /Ad-hoc run 'adhoc-active'/.test(item.message)));
  }
  {
    const current = fixture();
    const preview = buildRunPreflight(current.repository, 'execute-plan', options({
      runStoreError: 'manifest integrity failed',
      workshop: { worktrees: [], error: 'git worktree list failed' },
      repositoryGit: { available: false, reason: 'no usable baseline' },
    }));
    assert.equal(preview.readiness.ready, false);
    for (const code of ['RUN_HISTORY_UNAVAILABLE', 'RUN_WORKTREE_STATE_UNAVAILABLE', 'RUN_GIT_STATE_UNAVAILABLE']) {
      assert.ok(preview.readiness.diagnostics.some((item) => item.code === code));
    }
  }
});

test('explicit start is idempotent, revision-bound and creates workspace/session only after final preflight', () => {
  const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot }); const liveSessions = [];
  const reviewedOptions = options({ sessions: liveSessions, sessionsAfter: () => liveSessions });
  const preview = store.prepare(current.repository, 'execute-plan', reviewedOptions);
  let workspaces = 0; let launches = 0; let launchedManifest = null;
  const callbacks = {
    createWorkspace({ workspace }) { workspaces += 1; return { ...workspace, created: true, baseline: 'abc123' }; },
    removeWorkspace() {},
    launch({ manifest, workspace, execution }) {
      launches += 1; launchedManifest = manifest;
      liveSessions.push({ runId: manifest.id, repoId: current.repository.id, front: manifest.front.slug, component: manifest.front.leadComponent, slug: manifest.front.slug, controlSlug: `${current.repository.id}--${manifest.front.slug}`, agent: execution.agent, cwd: workspace.path, status: 'working' });
      return { slug: manifest.front.slug, controlSlug: `${current.repository.id}--${manifest.front.slug}`, tmux: `handraise-${current.repository.id}--${manifest.front.slug}`, existed: false };
    },
  };
  assert.throws(() => store.start(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: false, actor, currentOptions: reviewedOptions, ...callbacks }), (error) => error.code === 'RUN_CONFIRMATION_REQUIRED');
  assert.equal(workspaces, 0); assert.equal(launches, 0);
  const started = store.start(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, currentOptions: reviewedOptions, ...callbacks });
  assert.equal(started.state, 'running'); assert.equal(started.process.active, true); assert.equal(workspaces, 1); assert.equal(launches, 1);
  assert.equal(launchedManifest.revision.length, 64); assert.equal(launchedManifest.front.revision, preview.front.revision);
  assert.equal(launchedManifest.context.digest, preview.context.digest);
  const again = store.start(current.repository, preview.id, { expectedRevision: preview.revision, confirmed: true, actor, currentOptions: reviewedOptions, ...callbacks });
  assert.equal(again.id, started.id); assert.equal(workspaces, 1); assert.equal(launches, 1);

  const second = store.prepare(current.repository, 'execute-plan', options({ sessions: [] }));
  writeFileSync(join(current.repository.path, '.handraise', 'components', 'runtime.md'), `${readFileSync(join(current.repository.path, '.handraise', 'components', 'runtime.md'), 'utf8')}\nHuman edit.\n`);
  assert.throws(() => store.start(current.repository, second.id, { expectedRevision: second.revision, confirmed: true, actor, currentOptions: options({ sessions: [] }), ...callbacks }), (error) => error.code === 'RUN_PREFLIGHT_STALE');
});

test('claims, verified tasks, checks, handoff and completion remain distinct auditable transitions', () => {
  const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot }); const sessions = [];
  const reviewed = options({ sessions, sessionsAfter: () => sessions }); const preview = store.prepare(current.repository, 'execute-plan', reviewed);
  const started = store.start(current.repository, preview.id, {
    expectedRevision: preview.revision, confirmed: true, actor, currentOptions: reviewed,
    createWorkspace: ({ workspace }) => ({ ...workspace, created: true, baseline: 'abc123' }), removeWorkspace() {},
    launch({ manifest, workspace }) { sessions.push({ runId: manifest.id, repoId: current.repository.id, front: 'execute-plan', component: 'runtime', slug: 'execute-plan', controlSlug: 'run-fixture--execute-plan', agent: 'codex', cwd: workspace.path, status: 'working' }); return { slug: 'execute-plan', controlSlug: 'run-fixture--execute-plan', tmux: 'handraise-run', existed: false }; },
  });
  const updater = ({ componentSlug, frontSlug, expectedRevision, ...changes }) => updateFront(current.repository, componentSlug, frontSlug, { ...changes, expectedRevision });
  const claimed = store.recordTask(current.repository, started.id, 0, { source: 'agent-claim', state: 'done', evidence: 'Agent says done.' }, { actor, updateFront: updater });
  assert.equal(claimed.taskEvidence[0].applied, false);
  assert.match(readFileSync(join(current.repository.path, '.handraise', 'fronts', 'execute-plan.md'), 'utf8'), /- \[ \] 1\. Implement the bounded change/);
  store.recordTask(current.repository, started.id, 0, { source: 'user', state: 'done', evidence: 'Reviewed implementation.' }, { actor, updateFront: updater });
  store.recordTask(current.repository, started.id, 1, { source: 'configured-check', state: 'done', evidence: 'Test runner passed.' }, { actor, updateFront: updater });
  store.recordCheck(current.repository, started.id, { kind: 'criterion', index: 0, label: 'The accepted outcome is explicitly reviewed.', status: 'passed', source: 'user-observed', evidence: 'Reviewer accepted the outcome.' }, { actor });
  store.recordCheck(current.repository, started.id, { kind: 'verification', index: 0, label: 'Run orchestration tests pass.', status: 'passed', source: 'configured-check', evidence: 'node --test passed.' }, { actor });
  const paused = store.handoff(current.repository, started.id, { summary: 'Implementation is ready for review.', nextSteps: ['Integrate the clean branch.'], blockers: [] }, { actor });
  assert.equal(paused.state, 'paused'); assert.equal(paused.handoffs[0].revision.length, 64);
  assert.throws(() => store.complete(current.repository, started.id, { actor, sessions, git: { available: true, dirty: 0, ahead: 0, unbacked: 0, branchMismatch: false }, updateFront: updater }), (error) => error.code === 'RUN_PROCESS_ACTIVE');
  sessions.length = 0;
  assert.throws(() => store.complete(current.repository, started.id, { actor, sessions, git: { available: true, dirty: 1, ahead: 0, unbacked: 0, branchMismatch: false }, updateFront: updater }), (error) => error.code === 'RUN_GIT_RISK');
  const completed = store.complete(current.repository, started.id, { actor, sessions, git: { available: true, dirty: 0, ahead: 0, unbacked: 0, branchMismatch: false }, updateFront: updater });
  assert.equal(completed.state, 'completed'); assert.equal(completed.outcome.accepted, true);
  assert.match(readFileSync(join(current.repository.path, '.handraise', 'fronts', 'execute-plan.md'), 'utf8'), /state: done/);
  assert.ok(completed.events.some((event) => event.type === 'outcome-accepted'));
});

test('final revalidation catches dependency and capability loss before allocation', () => {
  {
    const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
    const preview = store.prepare(current.repository, 'execute-plan', options());
    let workspaces = 0; let launches = 0;
    assert.throws(() => store.start(current.repository, preview.id, {
      expectedRevision: preview.revision, confirmed: true, actor,
      currentOptions: () => options({
        agentIntegration: { id: 'codex', title: 'Codex', enabled: true, installed: true, auth: { connected: false }, capabilities: { terminal: true, configured: true } },
      }),
      createWorkspace: () => { workspaces += 1; return {}; },
      removeWorkspace() {}, launch: () => { launches += 1; },
    }), (error) => error.code === 'RUN_PREFLIGHT_STALE' && error.details.diagnostics.some((item) => item.code === 'RUN_AGENT_AUTH_REQUIRED'));
    assert.equal(workspaces, 0); assert.equal(launches, 0);
  }
  {
    const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
    const preview = store.prepare(current.repository, 'execute-plan', options());
    writeFileSync(join(current.repository.path, '.handraise', 'fronts', 'prepare-runtime.md'), front('prepare-runtime', 'queued'));
    let workspaces = 0;
    assert.throws(() => store.start(current.repository, preview.id, {
      expectedRevision: preview.revision, confirmed: true, actor, currentOptions: () => options(),
      createWorkspace: () => { workspaces += 1; return {}; }, removeWorkspace() {}, launch() {},
    }), (error) => error.code === 'RUN_PREFLIGHT_STALE' && error.details.diagnostics.some((item) => item.code === 'RUN_HARD_DEPENDENCY_NOT_DONE'));
    assert.equal(workspaces, 0);
  }
  {
    const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
    const preview = store.prepare(current.repository, 'execute-plan', options());
    let removed = 0; let launches = 0;
    assert.throws(() => store.start(current.repository, preview.id, {
      expectedRevision: preview.revision, confirmed: true, actor, currentOptions: () => options(),
      createWorkspace: ({ workspace }) => {
        const path = join(current.repository.path, '.handraise', 'components', 'runtime.md');
        writeFileSync(path, `${readFileSync(path, 'utf8')}\nExternal edit during worktree creation.\n`);
        return { ...workspace, created: true, baseline: 'abc123' };
      },
      removeWorkspace: () => { removed += 1; }, launch: () => { launches += 1; },
    }), (error) => error.code === 'RUN_PREFLIGHT_STALE');
    assert.equal(removed, 1); assert.equal(launches, 0);
  }
});

test('two reviewed starts cannot race into duplicate durable ownership', () => {
  const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
  const first = store.prepare(current.repository, 'execute-plan', options());
  const second = store.prepare(current.repository, 'execute-plan', options());
  let workspaces = 0; let launches = 0;
  const callbacks = {
    createWorkspace: ({ workspace }) => { workspaces += 1; return { ...workspace, created: true, baseline: 'abc123' }; },
    removeWorkspace() {}, launch: ({ manifest }) => { launches += 1; return { slug: manifest.front.slug, controlSlug: `session-${manifest.id}`, tmux: `tmux-${manifest.id}`, existed: false }; },
  };
  const liveOptions = () => options({ runs: store.list(current.repository) });
  const started = store.start(current.repository, first.id, { expectedRevision: first.revision, confirmed: true, actor, currentOptions: liveOptions, ...callbacks });
  assert.equal(started.state, 'awaiting-acceptance');
  assert.throws(() => store.start(current.repository, second.id, { expectedRevision: second.revision, confirmed: true, actor, currentOptions: liveOptions, ...callbacks }), (error) => error.code === 'RUN_PREFLIGHT_STALE' && error.details.diagnostics.some((item) => item.code === 'RUN_EXISTING_ACTIVE_RUN'));
  assert.equal(workspaces, 1); assert.equal(launches, 1);
  const blocked = store.prepare(current.repository, 'execute-plan', liveOptions());
  assert.equal(blocked.readiness.ready, false);
  assert.match(blocked.readiness.diagnostics.find((item) => item.code === 'RUN_EXISTING_ACTIVE_RUN').recovery, /Resume or complete/);
});

test('agent crash, reconnect and cross-agent handoff remain explicit process transitions', () => {
  const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot }); const sessions = [];
  const reviewed = options({ sessions, sessionsAfter: () => sessions }); const preflight = store.prepare(current.repository, 'execute-plan', reviewed);
  const started = store.start(current.repository, preflight.id, {
    expectedRevision: preflight.revision, confirmed: true, actor, currentOptions: reviewed,
    createWorkspace: ({ workspace }) => ({ ...workspace, created: true, baseline: 'abc123' }), removeWorkspace() {},
    launch({ manifest, workspace }) {
      sessions.push({ runId: manifest.id, repoId: current.repository.id, front: manifest.front.slug, component: 'runtime', slug: manifest.front.slug, controlSlug: 'run-session', agent: 'codex', cwd: workspace.path, status: 'working' });
      return { slug: manifest.front.slug, controlSlug: 'run-session', tmux: 'handraise-run-session', existed: false };
    },
  });
  assert.equal(started.process.active, true);
  sessions.length = 0;
  assert.equal(store.get(current.repository, started.id, { sessions }).state, 'awaiting-acceptance');
  sessions.push({ runId: started.id, repoId: current.repository.id, front: 'execute-plan', component: 'runtime', slug: 'execute-plan', controlSlug: 'reconnected-session', agent: 'codex', cwd: started.manifest.workspace.path, status: 'waiting', reason: 'Reviewer input required', permission: { id: 'permission' } });
  const reconnected = store.get(current.repository, started.id, { sessions });
  assert.equal(reconnected.state, 'running'); assert.equal(reconnected.process.active, true); assert.equal(reconnected.process.attention.status, 'waiting');
  sessions.length = 0;
  const paused = store.handoff(current.repository, started.id, { summary: 'The first agent stopped at a reviewed boundary.', nextSteps: ['Continue from the preserved worktree.'], blockers: [] }, { actor });
  const handoff = paused.handoffs.at(-1);
  const resumeOptions = options({
    agent: 'claude', agentIntegration: { id: 'claude', title: 'Claude Code', version: 'fixture-2', enabled: true, installed: true, auth: { connected: true, provider: 'anthropic' }, capabilities: { terminal: true, configured: true, typedPermissions: true, lifecycleAttention: true, gracefulWrapup: true } },
    runs: store.list(current.repository), resume: { runId: started.id, handoffRevision: handoff.revision, handoff },
    workshop: { worktrees: [{ path: started.manifest.workspace.path, owner: { front: 'execute-plan' }, git: { dirty: 1, ahead: 1, unbacked: 1 } }] },
  });
  const resumePreflight = store.prepare(current.repository, 'execute-plan', resumeOptions);
  assert.equal(resumePreflight.readiness.ready, true);
  assert.match(resumePreflight.context.prompt, /first agent stopped at a reviewed boundary/i);
  assert.match(resumePreflight.context.prompt, /hidden prior conversation/i);
  const resumed = store.start(current.repository, resumePreflight.id, {
    expectedRevision: resumePreflight.revision, confirmed: true, actor, currentOptions: () => resumeOptions,
    createWorkspace: ({ workspace }) => ({ ...workspace, created: false, baseline: 'abc123' }), removeWorkspace() {},
    launch: ({ manifest }) => ({ slug: manifest.front.slug, controlSlug: 'resumed-session', tmux: 'handraise-resumed', existed: false }),
  });
  assert.equal(resumed.manifest.execution.agent, 'claude');
  assert.equal(resumed.manifest.resume.runId, started.id);
  assert.equal(resumed.manifest.resume.handoffRevision, handoff.revision);
});

test('failed launch records failure and rolls back only the newly created workspace', () => {
  const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
  const preview = store.prepare(current.repository, 'execute-plan', options());
  let removed = 0;
  assert.throws(() => store.start(current.repository, preview.id, {
    expectedRevision: preview.revision, confirmed: true, actor, currentOptions: options(),
    createWorkspace: ({ workspace }) => ({ ...workspace, created: true, baseline: 'abc123' }),
    removeWorkspace: () => { removed += 1; },
    launch: () => { throw Object.assign(new Error('fixture agent launch failed'), { code: 'FIXTURE_LAUNCH_FAILED' }); },
  }), /fixture agent launch failed/);
  assert.equal(removed, 1);
  const [failed] = store.list(current.repository);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure.code, 'FIXTURE_LAUNCH_FAILED');
  assert.match(failed.failure.message, /fixture agent launch failed/);
});

test('a moved worktree baseline is rolled back before the agent launch', () => {
  const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
  const preview = store.prepare(current.repository, 'execute-plan', options());
  let removed = 0; let launches = 0;
  assert.throws(() => store.start(current.repository, preview.id, {
    expectedRevision: preview.revision, confirmed: true, actor, currentOptions: options(),
    createWorkspace: ({ workspace }) => ({ ...workspace, created: true, baseline: 'moved-after-review', revision: 'moved-after-review' }),
    removeWorkspace: () => { removed += 1; }, launch: () => { launches += 1; },
  }), (error) => error.code === 'RUN_WORKSPACE_REVISION_CHANGED');
  assert.equal(removed, 1); assert.equal(launches, 0); assert.equal(store.list(current.repository).length, 0);
});

test('persisted preflight and immutable manifest corruption is detected before use', () => {
  {
    const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
    const preflight = store.prepare(current.repository, 'execute-plan', options());
    const directory = join(current.stateRoot, 'preflights', readdirSync(join(current.stateRoot, 'preflights'))[0]);
    const path = join(directory, `${preflight.id}.json`); const value = JSON.parse(readFileSync(path, 'utf8'));
    value.workspace.path = '/tmp/tampered-workspace'; writeFileSync(path, JSON.stringify(value));
    assert.throws(() => store.getPreflight(current.repository, preflight.id), (error) => error.code === 'RUN_PREFLIGHT_CORRUPT');
  }
  {
    const current = fixture(); const store = new RunOrchestrationStore({ root: current.stateRoot });
    const preflight = store.prepare(current.repository, 'execute-plan', options());
    const run = store.start(current.repository, preflight.id, {
      expectedRevision: preflight.revision, confirmed: true, actor, currentOptions: options(),
      createWorkspace: ({ workspace }) => ({ ...workspace, created: true, baseline: 'abc123' }), removeWorkspace() {},
      launch: ({ manifest }) => ({ slug: manifest.front.slug, controlSlug: 'manifest-session', tmux: 'handraise-manifest', existed: false }),
    });
    const directory = join(current.stateRoot, 'runs', readdirSync(join(current.stateRoot, 'runs'))[0]);
    const path = join(directory, `${run.id}.json`); const value = JSON.parse(readFileSync(path, 'utf8'));
    value.manifest.front.title = 'Tampered manifest'; writeFileSync(path, JSON.stringify(value));
    assert.throws(() => store.get(current.repository, run.id), (error) => error.code === 'RUN_MANIFEST_CORRUPT');
  }
});
