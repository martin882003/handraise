import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
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

import {
  createGraphifyAdapter,
  detectGraphify,
} from '../src/intelligence/adapters/graphify.mjs';
import { AnalysisRuntime } from '../src/intelligence/runtime.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handraise-graphify-adapter-'));
  const repositoryPath = join(root, 'repository');
  const analysisRoot = join(root, 'private', 'analysis');
  mkdirSync(join(repositoryPath, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main', repositoryPath);
  writeFileSync(join(repositoryPath, '.gitignore'), 'graphify-out/\n');
  writeFileSync(join(repositoryPath, 'src', 'main.mjs'), 'export function main() { return helper(); }\nfunction helper() { return 1; }\n');
  writeFileSync(join(repositoryPath, 'README.md'), '# Graphify fixture\n');
  git(repositoryPath, 'add', '.gitignore', 'src/main.mjs', 'README.md');
  git(repositoryPath, '-c', 'user.name=Handraise Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  writeFileSync(join(repositoryPath, 'dirty.mjs'), 'export const dirty = true;\n');
  writeFileSync(join(repositoryPath, 'odd-$(touch graphify-pwned).mjs'), 'export default true;\n');
  return {
    root,
    repositoryPath,
    analysisRoot,
    repository: { id: 'graphify-fixture', name: 'Graphify fixture', path: repositoryPath, adapter: 'handraise' },
  };
}

function treeSentinel(root) {
  const result = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const key = relative(root, path).replaceAll('\\', '/');
      const details = lstatSync(path);
      if (entry.isSymbolicLink()) result[key] = { kind: 'symlink', mode: details.mode & 0o777, size: details.size, mtimeMs: details.mtimeMs };
      else if (entry.isDirectory()) {
        result[key] = { kind: 'directory', mode: details.mode & 0o777, mtimeMs: details.mtimeMs };
        visit(path);
      } else result[key] = { kind: 'file', mode: details.mode & 0o777, size: details.size, mtimeMs: details.mtimeMs, digest: sha256(readFileSync(path)) };
    }
  };
  visit(root);
  return result;
}

function fakeGraphify(root, {
  version = '0.9.32',
  missingFlags = [],
  mode = 'valid',
  graph = null,
  symlinkTarget = null,
} = {}) {
  const executable = join(root, `fake-graphify-${randomUUID()}.mjs`);
  const validGraph = graph || {
    directed: true,
    multigraph: true,
    graph: { built_at_commit: 'fixture' },
    nodes: [
      { id: 'module:src/main.mjs', label: 'src/main.mjs', file_type: 'file', source_file: 'src/main.mjs', source_location: 'L1-L2' },
      { id: 'function:main', label: 'main', file_type: 'function', source_file: 'src/main.mjs', source_location: 'L1:1-L1:44', _origin: 'ast' },
      { id: 'function:helper', label: 'helper', file_type: 'function', source_file: 'src/main.mjs', source_location: 'L2' },
    ],
    links: [
      { source: 'module:src/main.mjs', target: 'function:main', relation: 'contains', confidence: 'EXTRACTED' },
      { source: 'function:main', target: 'function:helper', relation: 'calls', confidence: 'AMBIGUOUS', context: 'call' },
    ],
  };
  const flags = ['--code-only', '--out', '--no-cluster', '--max-workers'].filter((flag) => !missingFlags.includes(flag)).join(' ');
  const source = `#!/usr/bin/env node
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('graphify ${version}\\n'); process.exit(0); }
if (args[0] === 'extract' && args[1] === '--help') { process.stdout.write('usage: graphify extract <path> ${flags}\\n'); process.exit(0); }
if (args[0] !== 'extract') { process.stderr.write('unexpected command'); process.exit(64); }
if (!args.includes('--code-only') || !args.includes('--no-cluster') || !args.includes('--out') || !args.includes('--max-workers')) { process.stderr.write('unsafe invocation'); process.exit(65); }
if (['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_ACCESS_KEY_ID'].some((key) => process.env[key])) { process.stderr.write('provider credential leaked'); process.exit(66); }
const output = args[args.indexOf('--out') + 1];
const target = join(output, 'graphify-out');
mkdirSync(target, { recursive: true });
if (${JSON.stringify(mode)} === 'hang') { setInterval(() => {}, 1000); }
else if (${JSON.stringify(mode)} === 'malformed') writeFileSync(join(target, 'graph.json'), '{not-json');
else if (${JSON.stringify(mode)} === 'huge') writeFileSync(join(target, 'graph.json'), JSON.stringify({ nodes: [{ id: 'n', label: 'x'.repeat(8192) }], links: [] }));
else if (${JSON.stringify(mode)} === 'symlink') symlinkSync(${JSON.stringify(symlinkTarget)}, join(target, 'graph.json'));
else writeFileSync(join(target, 'graph.json'), ${JSON.stringify(JSON.stringify(validGraph))});
`;
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return executable;
}

async function waitFor(runtime, repositoryId, jobId, states, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let job = runtime.status(repositoryId, jobId);
  while (!states.includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = runtime.status(repositoryId, jobId);
  }
  assert.ok(states.includes(job.state), `job remained ${job.state}: ${JSON.stringify(job)}`);
  return job;
}

test('Graphify detection reports exact package/version/capabilities and rejects missing, incompatible or incomplete CLIs', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-graphify-detect-'));
  const compatible = detectGraphify({ executable: fakeGraphify(root) });
  assert.equal(compatible.available, true);
  assert.equal(compatible.package, 'graphifyy');
  assert.equal(compatible.version, '0.9.32');
  assert.equal(compatible.schema, 'graphify-node-link/extraction-v1');
  assert.equal(compatible.capabilities.semantic, false);
  assert.equal(compatible.capabilities.installsHooks, false);

  const incompatible = detectGraphify({ executable: fakeGraphify(root, { version: '1.0.0' }) });
  assert.equal(incompatible.available, false);
  assert.equal(incompatible.code, 'GRAPHIFY_VERSION_UNSUPPORTED');

  const incomplete = detectGraphify({ executable: fakeGraphify(root, { missingFlags: ['--code-only'] }) });
  assert.equal(incomplete.available, false);
  assert.equal(incomplete.code, 'GRAPHIFY_CAPABILITY_MISMATCH');
  assert.match(incomplete.reason, /--code-only/);

  const missing = detectGraphify({ executable: join(root, 'does-not-exist') });
  assert.equal(missing.available, false);
  assert.equal(missing.code, 'GRAPHIFY_NOT_FOUND');
});

test('Graphify runs only over private input/output and normalizes graph provenance, evidence and honest coverage', async () => {
  const current = fixture();
  const executable = fakeGraphify(current.root);
  const runtime = new AnalysisRuntime({ root: current.analysisRoot, adapters: [createGraphifyAdapter({ executable })] });
  const before = treeSentinel(current.repositoryPath);
  const statusBefore = git(current.repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all');

  const analyzers = await runtime.analyzers();
  const graphify = analyzers.find((item) => item.id === 'graphify-code-local');
  assert.equal(graphify.availability.available, true);
  assert.equal(graphify.availability.version, '0.9.32');

  const plan = await runtime.plan(current.repository, { analyzerId: 'graphify-code-local' });
  assert.equal(plan.adapterPlan.mode, 'code-only');
  assert.equal(plan.adapterPlan.semantic, false);
  assert.equal(plan.adapterPlan.sourceMayLeaveHost, false);
  assert.ok(plan.adapterPlan.supportedFiles >= 3);
  assert.ok(plan.adapterPlan.unsupportedFiles >= 1, 'README and git metadata are disclosed as unsupported by code-only mode');
  assert.ok(plan.adapterPlan.invocation.every((argument) => !argument.includes(current.repositoryPath)), 'the public plan must not disclose a host path to the analyzer');

  const started = runtime.start(current.repository, { planId: plan.id });
  const complete = await waitFor(runtime, current.repository.id, started.id, ['complete', 'stale', 'failed']);
  assert.equal(complete.state, 'complete');
  const snapshot = runtime.snapshot(current.repository.id, started.id);
  assert.equal(snapshot.status, 'partial', 'unsupported selected files must prevent a false complete-coverage claim');
  assert.equal(snapshot.extensions.graphify.mode, 'code-only');
  assert.equal(snapshot.extensions.graphify.semantic, false);
  assert.equal(snapshot.extensions.graphify.upstreamVersion, '0.9.32');
  assert.ok(snapshot.entities.some((entity) => entity.name === 'main' && entity.location.path === 'src/main.mjs'));
  assert.ok(snapshot.evidence.every((item) => item.path === 'src/main.mjs'));
  assert.ok(snapshot.relations.some((relation) => relation.kind === 'contains' && relation.attributes.provenance === 'extracted' && relation.confidence === 1));
  assert.ok(snapshot.relations.some((relation) => relation.kind === 'calls' && relation.attributes.graphifyConfidence === 'AMBIGUOUS' && relation.confidence === .35));
  assert.ok(snapshot.coverage.some((item) => item.status === 'unsupported'));
  assert.deepEqual(treeSentinel(current.repositoryPath), before);
  assert.equal(git(current.repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all'), statusBefore);
  assert.equal(existsSync(join(current.repositoryPath, 'graphify-out')), false);
  assert.equal(existsSync(join(current.repositoryPath, 'graphify-pwned')), false);
  runtime.shutdown();
});

test('Graphify malformed, oversized and symlink outputs fail closed without touching the repository', async () => {
  for (const mode of ['malformed', 'huge', 'symlink']) {
    const current = fixture();
    const target = join(current.repositoryPath, 'README.md');
    const executable = fakeGraphify(current.root, { mode, symlinkTarget: target });
    const runtime = new AnalysisRuntime({ root: current.analysisRoot, adapters: [createGraphifyAdapter({ executable })] });
    const before = treeSentinel(current.repositoryPath);
    const plan = await runtime.plan(current.repository, {
      analyzerId: 'graphify-code-local',
      scope: { limits: { maxOutputBytes: mode === 'huge' ? 1_024 : 64 * 1024, maxProcesses: 512 } },
    });
    const started = runtime.start(current.repository, { planId: plan.id });
    const failed = await waitFor(runtime, current.repository.id, started.id, ['failed']);
    assert.equal(failed.error.code, mode === 'malformed' ? 'GRAPHIFY_SCHEMA_INVALID' : mode === 'huge' ? 'OUTPUT_LIMIT' : 'GRAPHIFY_OUTPUT_UNSAFE');
    assert.deepEqual(treeSentinel(current.repositoryPath), before, `${mode} output must not mutate target bytes, modes or mtimes`);
    assert.equal(existsSync(join(current.repositoryPath, 'graphify-out')), false);
    await runtime.delete(current.repository.id, started.id);
  }
});

test('Graphify cancellation terminates the process group and restart recovery removes incomplete private trees safely', async () => {
  const current = fixture();
  const executable = fakeGraphify(current.root, { mode: 'hang' });
  const adapter = createGraphifyAdapter({ executable });
  const runtime = new AnalysisRuntime({ root: current.analysisRoot, adapters: [adapter] });
  const before = treeSentinel(current.repositoryPath);
  const plan = await runtime.plan(current.repository, {
    analyzerId: 'graphify-code-local', scope: { limits: { maxAnalysisDurationMs: 20_000, maxProcesses: 512 } },
  });
  const started = runtime.start(current.repository, { planId: plan.id });
  for (let attempt = 0; attempt < 200 && runtime.status(current.repository.id, started.id).stage !== 'analyze'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(runtime.cancel(current.repository.id, started.id).state, 'cancelled');
  await runtime.delete(current.repository.id, started.id);
  assert.deepEqual(treeSentinel(current.repositoryPath), before);

  const recoveryId = `job:${randomUUID()}`;
  const recoveryDirectory = join(current.analysisRoot, 'jobs', recoveryId.slice(4));
  mkdirSync(join(recoveryDirectory, 'output'), { recursive: true });
  mkdirSync(join(recoveryDirectory, 'source'), { recursive: true });
  mkdirSync(join(recoveryDirectory, 'home'), { recursive: true });
  mkdirSync(join(recoveryDirectory, 'tmp'), { recursive: true });
  symlinkSync(join(current.repositoryPath, 'README.md'), join(recoveryDirectory, 'output', 'host-target'));
  writeFileSync(join(recoveryDirectory, 'source', 'partial.txt'), 'partial');
  const now = new Date().toISOString();
  writeFileSync(join(recoveryDirectory, 'job.json'), `${JSON.stringify({
    id: recoveryId,
    repositoryId: current.repository.id,
    analyzerId: 'graphify-code-local',
    state: 'running',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    progress: .5,
    stage: 'analyze',
    message: 'Interrupted Graphify run.',
    resources: {},
  })}\n`);
  const readmeMode = statSync(join(current.repositoryPath, 'README.md')).mode & 0o777;
  const recoveredRuntime = new AnalysisRuntime({ root: current.analysisRoot, adapters: [createGraphifyAdapter({ executable })] });
  const recovered = recoveredRuntime.status(current.repository.id, recoveryId);
  assert.equal(recovered.state, 'stale');
  assert.equal(recovered.error.code, 'SERVER_RESTARTED');
  for (const name of ['source', 'output', 'home', 'tmp']) assert.equal(existsSync(join(recoveryDirectory, name)), false);
  assert.equal(statSync(join(current.repositoryPath, 'README.md')).mode & 0o777, readmeMode, 'startup cleanup must not follow output symlinks');
  assert.deepEqual(treeSentinel(current.repositoryPath), before);
  recoveredRuntime.shutdown();
});
