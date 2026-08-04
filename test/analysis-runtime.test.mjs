import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { IntelligenceError, createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { AnalysisRuntime } from '../src/intelligence/runtime.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function repositoryFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'handraise-analysis-runtime-'));
  const repositoryPath = join(fixture, 'repository');
  const analysisRoot = join(fixture, 'private-state', 'analysis');
  const outside = join(fixture, 'outside.txt');
  mkdirSync(repositoryPath, { recursive: true });
  writeFileSync(outside, 'outside repository\n');
  git(fixture, 'init', '-b', 'main', repositoryPath);
  mkdirSync(join(repositoryPath, 'src'), { recursive: true });
  mkdirSync(join(repositoryPath, 'private'), { recursive: true });
  mkdirSync(join(repositoryPath, 'dist'), { recursive: true });
  writeFileSync(join(repositoryPath, '.gitignore'), 'private/\ndist/\n');
  writeFileSync(join(repositoryPath, 'src', 'main.mjs'), 'export const value = 1;\n');
  writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
  symlinkSync(outside, join(repositoryPath, 'escape-link'));
  git(repositoryPath, 'add', '.gitignore', 'src/main.mjs', 'README.md', 'escape-link');
  git(repositoryPath, '-c', 'user.name=Handraise Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  writeFileSync(join(repositoryPath, 'src', 'main.mjs'), 'export const value = 2;\n');
  writeFileSync(join(repositoryPath, 'untracked.mjs'), 'export const untracked = true;\n');
  writeFileSync(join(repositoryPath, 'weird-$(touch-pwned).mjs'), 'export default 1;\n');
  writeFileSync(join(repositoryPath, 'private', 'ignored.txt'), 'explicit ignored fixture\n');
  writeFileSync(join(repositoryPath, 'dist', 'generated.js'), 'generated\n');
  return {
    fixture,
    repositoryPath,
    analysisRoot,
    repository: { id: 'fixture-repository', name: 'Fixture', path: repositoryPath, adapter: 'handraise' },
  };
}

function treeSentinel(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const key = relative(root, path).replaceAll('\\', '/');
      const stat = lstatSync(path);
      if (entry.isSymbolicLink()) result[key] = { kind: 'symlink', mode: stat.mode & 0o777, targetSize: stat.size, mtimeMs: stat.mtimeMs };
      else if (entry.isDirectory()) {
        result[key] = { kind: 'directory', mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs };
        visit(path);
      } else result[key] = { kind: 'file', mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs, digest: digest(readFileSync(path)) };
    }
  };
  visit(root);
  return result;
}

async function waitForJob(runtime, repositoryId, jobId, states = ['complete', 'stale', 'failed', 'cancelled'], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let job = runtime.status(repositoryId, jobId);
  while (!states.includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = runtime.status(repositoryId, jobId);
  }
  assert.ok(states.includes(job.state), `job remained ${job.state}: ${JSON.stringify(job)}`);
  return job;
}

function snapshotFromContext(descriptor, context) {
  return createAnalysisSnapshot({
    repository: context.repository,
    createdAt: context.createdAt,
    analyzer: descriptor,
    configuration: context.options,
    status: context.scope.truncated ? 'partial' : 'complete',
    freshness: { state: 'current', checkedAt: context.createdAt },
    manifest: context.manifest,
    scope: context.scope,
    evidence: [], entities: [], relations: [], findings: [], coverage: [], diagnostics: [],
  });
}

function testAdapter(id, { delayMs = 0, execution = null } = {}) {
  const descriptor = {
    id,
    name: id,
    version: '1.0.0',
    contractVersion: 1,
    capabilities: {
      languages: [], entityKinds: [], relationKinds: [],
      queries: ['entity', 'search', 'neighbors', 'path', 'evidence'],
      history: false, semantic: false, incremental: false,
    },
    privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
  };
  return {
    descriptor,
    detect() { return { available: true }; },
    plan() { return { adapter: id }; },
    async analyze(context) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return snapshotFromContext(descriptor, context);
    },
    query() { return null; },
    dispose() {},
    ...(execution ? { execution } : {}),
  };
}

test('scope planning is Git-aware, bounded, explicit about dirty/ignored content and never follows symlinks', async () => {
  const fixture = repositoryFixture();
  const runtime = new AnalysisRuntime({ root: fixture.analysisRoot });
  const before = treeSentinel(fixture.repositoryPath);
  const statusBefore = git(fixture.repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all');

  await assert.rejects(() => runtime.plan(fixture.repository, {
    scope: { ignoredPaths: ['private/ignored.txt'] },
  }), (error) => error.code === 'LOCAL_AUTHORITY_REQUIRED');

  const plan = await runtime.plan(fixture.repository, {
    hostAuthority: true,
    scope: { ignoredPaths: ['private/ignored.txt'] },
  });
  assert.equal(plan.manifest.git.dirty, true);
  assert.ok(plan.manifest.files.some((file) => file.path === 'src/main.mjs' && file.source === 'tracked'));
  assert.ok(plan.manifest.files.some((file) => file.path === 'untracked.mjs' && file.source === 'untracked'));
  assert.ok(plan.manifest.files.some((file) => file.path === 'private/ignored.txt' && file.source === 'ignored-explicit'));
  assert.ok(plan.scope.excluded.some((item) => item.pattern === 'escape-link' && /Symbolic/.test(item.reason)));
  assert.ok(!plan.manifest.files.some((file) => file.path === 'dist/generated.js'));
  assert.equal(existsSync(join(fixture.repositoryPath, 'pwned')), false);
  assert.deepEqual(treeSentinel(fixture.repositoryPath), before);
  assert.equal(git(fixture.repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all'), statusBefore);
  assert.equal(statSync(fixture.analysisRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(fixture.analysisRoot, 'plans', `${plan.id}.json`)).mode & 0o777, 0o600);

  const cleanOnly = await runtime.plan(fixture.repository, { scope: { includeDirty: false, includeUntracked: false } });
  assert.ok(!cleanOnly.manifest.files.some((file) => file.path === 'src/main.mjs'));
  assert.ok(!cleanOnly.manifest.files.some((file) => file.path === 'untracked.mjs'));

  const bounded = await runtime.plan(fixture.repository, { scope: { limits: { maxFiles: 1, maxBytes: 1_000_000 } } });
  assert.equal(bounded.manifest.counts.files, 1);
  assert.equal(bounded.scope.truncated, true);
  runtime.shutdown();
});

test('a built-in job captures a private immutable snapshot, streams durable progress and deletes immediately', async () => {
  const fixture = repositoryFixture();
  const runtime = new AnalysisRuntime({ root: fixture.analysisRoot });
  const before = treeSentinel(fixture.repositoryPath);
  const plan = await runtime.plan(fixture.repository);
  const started = runtime.start(fixture.repository, { planId: plan.id });
  assert.equal(started.state, 'queued');
  const complete = await waitForJob(runtime, fixture.repository.id, started.id, ['complete']);
  assert.equal(complete.progress, 1);
  assert.equal(complete.snapshotFreshness, 'current');
  assert.ok(complete.events.some((event) => event.stage === 'capture'));
  assert.ok(complete.events.some((event) => event.stage === 'analyze'));
  const snapshot = runtime.snapshot(fixture.repository.id, started.id);
  assert.equal(snapshot.id, complete.snapshotId);
  assert.equal(snapshot.manifest.digest, plan.manifest.digest);
  assert.ok(snapshot.entities.some((entity) => entity.name === 'src/main.mjs'));
  const privateSource = join(fixture.analysisRoot, 'jobs', started.id.slice(4), 'source');
  const privateOutput = join(fixture.analysisRoot, 'jobs', started.id.slice(4), 'output');
  assert.equal(statSync(privateSource).mode & 0o777, 0o500);
  assert.equal(statSync(join(privateSource, 'src', 'main.mjs')).mode & 0o777, 0o400);
  assert.deepEqual(treeSentinel(fixture.repositoryPath), before);
  assert.equal(existsSync(join(fixture.repositoryPath, 'graphify-out')), false);

  const listed = runtime.list(fixture.repository.id);
  assert.equal(listed[0].id, started.id);
  const repositoryMode = statSync(join(fixture.repositoryPath, 'README.md')).mode & 0o777;
  symlinkSync(join(fixture.repositoryPath, 'README.md'), join(privateOutput, 'hostile-output-link'));
  await runtime.delete(fixture.repository.id, started.id);
  assert.equal(existsSync(join(fixture.analysisRoot, 'jobs', started.id.slice(4))), false);
  assert.equal(statSync(join(fixture.repositoryPath, 'README.md')).mode & 0o777, repositoryMode, 'private cleanup must never chmod a symlink target');
  assert.throws(() => runtime.status(fixture.repository.id, started.id), (error) => error.code === 'JOB_NOT_FOUND');
});

test('changed baselines and mid-analysis changes become stale without mixed current evidence', async () => {
  const first = repositoryFixture();
  const runtime = new AnalysisRuntime({ root: first.analysisRoot });
  const plan = await runtime.plan(first.repository);
  writeFileSync(join(first.repositoryPath, 'README.md'), '# Changed after preview\n');
  const started = runtime.start(first.repository, { planId: plan.id });
  const stale = await waitForJob(runtime, first.repository.id, started.id, ['stale']);
  assert.equal(stale.error.code, 'REPOSITORY_CHANGED');
  assert.equal(stale.snapshotId, null);

  const second = repositoryFixture();
  const slow = testAdapter('slow-fixture', { delayMs: 180 });
  const secondRuntime = new AnalysisRuntime({ root: second.analysisRoot, adapters: [slow] });
  const secondPlan = await secondRuntime.plan(second.repository, { analyzerId: 'slow-fixture' });
  const secondStarted = secondRuntime.start(second.repository, { planId: secondPlan.id });
  for (let attempt = 0; attempt < 100 && secondRuntime.status(second.repository.id, secondStarted.id).stage !== 'analyze'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(join(second.repositoryPath, 'README.md'), '# Changed during analysis\n');
  const secondStale = await waitForJob(secondRuntime, second.repository.id, secondStarted.id, ['stale']);
  assert.ok(secondStale.snapshotId, 'a coherent private snapshot may be retained but must be marked stale');
  assert.equal(secondRuntime.snapshot(second.repository.id, secondStarted.id).freshness.state, 'stale');

  const awaitingFixture = repositoryFixture();
  const awaitingAdapter = testAdapter('awaiting-fixture');
  awaitingAdapter.analyze = async () => { throw new IntelligenceError('AWAITING_INPUT', 'A product boundary decision is required.'); };
  const awaitingRuntime = new AnalysisRuntime({ root: awaitingFixture.analysisRoot, adapters: [awaitingAdapter] });
  const awaitingPlan = await awaitingRuntime.plan(awaitingFixture.repository, { analyzerId: 'awaiting-fixture' });
  const awaitingStarted = awaitingRuntime.start(awaitingFixture.repository, { planId: awaitingPlan.id });
  const awaiting = await waitForJob(awaitingRuntime, awaitingFixture.repository.id, awaitingStarted.id, ['awaiting-input']);
  assert.equal(awaiting.error.code, 'AWAITING_INPUT');
  assert.equal(awaiting.message, 'A product boundary decision is required.');
  awaitingRuntime.cancel(awaitingFixture.repository.id, awaitingStarted.id);
});

test('command adapters use structured argv, isolated environment, resource limits, cancellation and bounded output', async () => {
  const fixture = repositoryFixture();
  const repositoryBefore = treeSentinel(fixture.repositoryPath);
  const commandAdapter = (id, source, parse = true) => {
    let adapter;
    adapter = testAdapter(id, {
      execution: {
        command() { return { file: process.execPath, args: ['-e', source], env: { HANDRAISE_FIXTURE: 'safe' } }; },
        parseResult({ context }) {
          if (!parse) throw new Error('parse should not run');
          return snapshotFromContext(adapter.descriptor, context);
        },
      },
    });
    return adapter;
  };
  const successAdapter = commandAdapter('command-success', "process.stdout.write(process.env.HANDRAISE_FIXTURE + ':' + process.cwd())");
  const timeoutAdapter = commandAdapter('command-timeout', 'setInterval(() => {}, 1000)', false);
  const outputAdapter = commandAdapter('command-output', "process.stdout.write('x'.repeat(20000))", false);
  const cancelAdapter = commandAdapter('command-cancel', 'setInterval(() => {}, 1000)', false);
  const runtime = new AnalysisRuntime({ root: fixture.analysisRoot, adapters: [successAdapter, timeoutAdapter, outputAdapter, cancelAdapter] });

  const successPlan = await runtime.plan(fixture.repository, {
    analyzerId: 'command-success', scope: { limits: { maxProcesses: 512 } },
  });
  const successJob = runtime.start(fixture.repository, { planId: successPlan.id });
  const complete = await waitForJob(runtime, fixture.repository.id, successJob.id, ['complete']);
  assert.equal(complete.resources.resourceLimits, process.platform === 'linux' && existsSync('/usr/bin/prlimit') ? 'linux-prlimit' : 'portable-walltime-output');

  const timeoutPlan = await runtime.plan(fixture.repository, {
    analyzerId: 'command-timeout', scope: { limits: { maxAnalysisDurationMs: 120, maxProcesses: 512 } },
  });
  const timeoutJob = runtime.start(fixture.repository, { planId: timeoutPlan.id });
  const timedOut = await waitForJob(runtime, fixture.repository.id, timeoutJob.id, ['failed']);
  assert.equal(timedOut.error.code, 'TIMEOUT');

  const outputPlan = await runtime.plan(fixture.repository, {
    analyzerId: 'command-output', scope: { limits: { maxOutputBytes: 1_024, maxProcesses: 512 } },
  });
  const outputJob = runtime.start(fixture.repository, { planId: outputPlan.id });
  const overflow = await waitForJob(runtime, fixture.repository.id, outputJob.id, ['failed']);
  assert.equal(overflow.error.code, 'OUTPUT_LIMIT');

  const cancelPlan = await runtime.plan(fixture.repository, {
    analyzerId: 'command-cancel', scope: { limits: { maxAnalysisDurationMs: 10_000, maxProcesses: 512 } },
  });
  const cancelJob = runtime.start(fixture.repository, { planId: cancelPlan.id });
  for (let attempt = 0; attempt < 100 && runtime.status(fixture.repository.id, cancelJob.id).stage !== 'analyze'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const cancelled = runtime.cancel(fixture.repository.id, cancelJob.id);
  assert.equal(cancelled.state, 'cancelled');
  await runtime.delete(fixture.repository.id, cancelJob.id);
  assert.equal(existsSync(join(fixture.analysisRoot, 'jobs', cancelJob.id.slice(4))), false);
  assert.deepEqual(treeSentinel(fixture.repositoryPath), repositoryBefore, 'success, timeout, output failure and cancellation must all leave the repository byte/metadata-identical');
  assert.equal(existsSync(join(fixture.repositoryPath, 'graphify-out')), false);
});

test('startup recovery, expiry and unsafe storage roots have explicit outcomes', async () => {
  const fixture = repositoryFixture();
  const jobsRoot = join(fixture.analysisRoot, 'jobs');
  mkdirSync(jobsRoot, { recursive: true });
  mkdirSync(join(fixture.analysisRoot, 'plans'), { recursive: true });
  const id = `job:${randomUUID()}`;
  const directory = join(jobsRoot, id.slice(4));
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(join(directory, 'job.json'), `${JSON.stringify({
    id, repositoryId: fixture.repository.id, analyzerId: 'handraise-inventory', state: 'running',
    createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    progress: .5, stage: 'analyze', message: 'Interrupted.', resources: {},
  })}\n`);
  mkdirSync(join(jobsRoot, 'malformed'), { recursive: true });
  writeFileSync(join(jobsRoot, 'malformed', 'job.json'), '{broken');
  const runtime = new AnalysisRuntime({ root: fixture.analysisRoot });
  const recovered = runtime.status(fixture.repository.id, id);
  assert.equal(recovered.state, 'stale');
  assert.equal(recovered.error.code, 'SERVER_RESTARTED');
  assert.equal(existsSync(join(jobsRoot, 'malformed')), false);

  let clock = Date.now();
  const expiringFixture = repositoryFixture();
  const expiring = new AnalysisRuntime({ root: expiringFixture.analysisRoot, now: () => clock, planTtlMs: 50, retentionMs: 50 });
  const plan = await expiring.plan(expiringFixture.repository);
  clock += 51;
  assert.throws(() => expiring.start(expiringFixture.repository, { planId: plan.id }), (error) => error.code === 'PLAN_EXPIRED');

  let retentionClock = Date.now();
  const retentionFixture = repositoryFixture();
  const retaining = new AnalysisRuntime({ root: retentionFixture.analysisRoot, now: () => retentionClock, retentionMs: 50 });
  const retainedPlan = await retaining.plan(retentionFixture.repository);
  const retainedJob = retaining.start(retentionFixture.repository, { planId: retainedPlan.id });
  await waitForJob(retaining, retentionFixture.repository.id, retainedJob.id, ['complete']);
  retentionClock += 51;
  retaining.cleanup();
  assert.throws(() => retaining.status(retentionFixture.repository.id, retainedJob.id), (error) => error.code === 'JOB_NOT_FOUND');
  assert.equal(existsSync(join(retentionFixture.analysisRoot, 'jobs', retainedJob.id.slice(4))), false);

  const overlapping = new AnalysisRuntime({ root: join(fixture.repositoryPath, '.runtime-private') });
  await assert.rejects(() => overlapping.plan(fixture.repository), (error) => error.code === 'UNSAFE_STORAGE_ROOT');
  runtime.shutdown();
  expiring.shutdown();
  retaining.shutdown();
  overlapping.shutdown();
});
