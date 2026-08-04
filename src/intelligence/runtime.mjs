import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ANALYSIS_SCHEMA_VERSION,
  IntelligenceError,
  createAnalysisSnapshot,
  createContentManifest,
  intelligenceFailure,
  serializeAnalysisSnapshot,
  validateAnalysisSnapshot,
  validateAnalyzerAdapter,
} from './contracts.mjs';
import { queryAnalysisSnapshot } from './memory-query.mjs';

export const ANALYSIS_RUNTIME_VERSION = 1;

export const ANALYSIS_DEFAULT_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxBytes: 256 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxPlanDurationMs: 30_000,
  maxAnalysisDurationMs: 5 * 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxMemoryBytes: 2 * 1024 * 1024 * 1024,
  maxCpuSeconds: 300,
  maxProcesses: 64,
});

export const ANALYSIS_DEFAULT_EXCLUSIONS = Object.freeze([
  '.git/**',
  '.handraise/**',
  'node_modules/**',
  'vendor/**',
  '.venv/**',
  'venv/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.cache/**',
  '.next/**',
  '.turbo/**',
  'target/**',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
]);

const PLAN_TTL_MS = 15 * 60_000;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TERMINAL_STATES = new Set(['stale', 'cancelled', 'failed', 'complete']);
const ACTIVE_STATES = new Set(['queued', 'running', 'awaiting-input']);
const SAFE_JOB_ID = /^job:[a-f0-9-]{36}$/;
const SAFE_PLAN_ID = /^[a-f0-9]{64}$/;

const hash = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function cleanText(value, limit = 4_096) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function safeRelativePath(value, label = 'path') {
  const path = String(value || '').replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.includes('\0')
    || path.split('/').some((segment) => !segment || segment === '..' || segment === '.')) {
    throw new IntelligenceError('UNSAFE_PATH', `${label} must be a safe repository-relative path`);
  }
  return path;
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function privateWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function privateJson(path, value) {
  privateWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function removePrivateTree(path) {
  if (!existsSync(path)) return;
  let details;
  try { details = lstatSync(path); } catch { return; }
  if (details.isSymbolicLink()) {
    rmSync(path, { force: true });
    return;
  }
  if (!details.isDirectory()) {
    try { chmodSync(path, 0o600); } catch { /* a vanished file needs no mode repair */ }
    rmSync(path, { force: true });
    return;
  }
  try { chmodSync(path, 0o700); } catch { /* rmSync will report the real failure */ }
  for (const entry of readdirSync(path)) removePrivateTree(join(path, entry));
  rmSync(path, { recursive: true, force: true });
}

function linuxUserTaskCount() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return null;
  const uid = process.getuid();
  let total = 0;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = readFileSync(`/proc/${name}/status`, 'utf8');
        const owner = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
        if (owner !== uid) continue;
        total += Number(status.match(/^Threads:\s+(\d+)/m)?.[1]) || 1;
      } catch { /* process exited during the count */ }
    }
    return total;
  } catch { return null; }
}

function safeRead(path) {
  let file;
  try {
    const noAtime = constants.O_NOATIME || 0;
    const noFollow = constants.O_NOFOLLOW || 0;
    file = openSync(path, constants.O_RDONLY | noAtime | noFollow);
  } catch (error) {
    if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
    file = openSync(path, constants.O_RDONLY);
  }
  try { return readFileSync(file); }
  finally { closeSync(file); }
}

function git(repositoryPath, args, { optional = false, buffer = false, maxBuffer = 128 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], {
      encoding: buffer ? null : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (error) {
    if (optional) return buffer ? Buffer.alloc(0) : '';
    const detail = cleanText(error?.stderr || error?.message || error, 2_000);
    throw new IntelligenceError('GIT_SCOPE_FAILED', detail || `git ${args[0]} failed`, { cause: error });
  }
}

function nulList(value) {
  return Buffer.isBuffer(value)
    ? value.toString('utf8').split('\0').filter(Boolean)
    : String(value || '').split('\0').filter(Boolean);
}

function globRegex(pattern) {
  const normalized = String(pattern || '').replaceAll('\\', '/');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globRegex(pattern).test(path)
    || (pattern.endsWith('/**') && path === pattern.slice(0, -3)));
}

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new IntelligenceError('INVALID_ANALYSIS_SCOPE', `${name} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

function normalizeScopeOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntelligenceError('INVALID_ANALYSIS_SCOPE', 'analysis scope must be an object');
  }
  const customExclusions = Array.isArray(value.exclusions)
    ? value.exclusions.map((item) => cleanText(item, 512)).filter(Boolean)
    : [];
  if (customExclusions.length > 100) throw new IntelligenceError('INVALID_ANALYSIS_SCOPE', 'analysis accepts at most 100 custom exclusions');
  for (const pattern of customExclusions) {
    if (pattern.startsWith('/') || pattern.includes('\0') || pattern.split('/').includes('..')) {
      throw new IntelligenceError('INVALID_ANALYSIS_SCOPE', `unsafe exclusion pattern: ${pattern}`);
    }
  }
  const ignoredPaths = Array.isArray(value.ignoredPaths)
    ? [...new Set(value.ignoredPaths.map((item) => safeRelativePath(item, 'ignored path')))]
    : [];
  if (ignoredPaths.length > 50) throw new IntelligenceError('INVALID_ANALYSIS_SCOPE', 'analysis accepts at most 50 explicit ignored files');
  return Object.freeze({
    includeDirty: value.includeDirty !== false,
    includeUntracked: value.includeUntracked !== false,
    ignoredPaths,
    exclusions: [...ANALYSIS_DEFAULT_EXCLUSIONS, ...customExclusions],
    limits: Object.freeze({
      maxFiles: boundedInteger(value.limits?.maxFiles, ANALYSIS_DEFAULT_LIMITS.maxFiles, 1, 100_000, 'maxFiles'),
      maxBytes: boundedInteger(value.limits?.maxBytes, ANALYSIS_DEFAULT_LIMITS.maxBytes, 1, 1024 * 1024 * 1024, 'maxBytes'),
      maxFileBytes: boundedInteger(value.limits?.maxFileBytes, ANALYSIS_DEFAULT_LIMITS.maxFileBytes, 1, 256 * 1024 * 1024, 'maxFileBytes'),
      maxPlanDurationMs: boundedInteger(value.limits?.maxPlanDurationMs, ANALYSIS_DEFAULT_LIMITS.maxPlanDurationMs, 100, 120_000, 'maxPlanDurationMs'),
      maxAnalysisDurationMs: boundedInteger(value.limits?.maxAnalysisDurationMs, ANALYSIS_DEFAULT_LIMITS.maxAnalysisDurationMs, 100, 60 * 60_000, 'maxAnalysisDurationMs'),
      maxOutputBytes: boundedInteger(value.limits?.maxOutputBytes, ANALYSIS_DEFAULT_LIMITS.maxOutputBytes, 1_024, 512 * 1024 * 1024, 'maxOutputBytes'),
      maxMemoryBytes: boundedInteger(value.limits?.maxMemoryBytes, ANALYSIS_DEFAULT_LIMITS.maxMemoryBytes, 64 * 1024 * 1024, 16 * 1024 * 1024 * 1024, 'maxMemoryBytes'),
      maxCpuSeconds: boundedInteger(value.limits?.maxCpuSeconds, ANALYSIS_DEFAULT_LIMITS.maxCpuSeconds, 1, 3_600, 'maxCpuSeconds'),
      maxProcesses: boundedInteger(value.limits?.maxProcesses, ANALYSIS_DEFAULT_LIMITS.maxProcesses, 1, 512, 'maxProcesses'),
    }),
  });
}

function pathWithin(root, target) {
  const from = resolve(root);
  const to = resolve(target);
  return to === from || to.startsWith(`${from}${sep}`);
}

function assertSeparatedStorage(repositoryPath, storageRoot) {
  const repository = realpathSync(repositoryPath);
  const storage = realpathSync(storageRoot);
  if (pathWithin(repository, storage) || pathWithin(storage, repository)) {
    throw new IntelligenceError('UNSAFE_STORAGE_ROOT', 'analysis storage and the target repository must be separate directory trees');
  }
}

function classifyLanguage(path) {
  const extension = extname(path).toLowerCase();
  return ({
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
    '.ts': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript', '.tsx': 'TypeScript',
    '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
    '.kt': 'Kotlin', '.kts': 'Kotlin', '.swift': 'Swift', '.php': 'PHP', '.cs': 'C#',
    '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
    '.sql': 'SQL', '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
    '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.md': 'Markdown', '.mdx': 'Markdown',
  })[extension] || 'Unknown';
}

function repositoryGitState(repositoryPath) {
  const inside = git(repositoryPath, ['rev-parse', '--is-inside-work-tree'], { optional: true }).trim() === 'true';
  if (!inside) return { available: false, head: null, branch: null, dirty: false, indexDigest: undefined, changed: new Set() };
  const status = nulList(git(repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { buffer: true }));
  const changed = new Set();
  for (let index = 0; index < status.length; index += 1) {
    const item = status[index];
    if (item.length < 4) continue;
    const code = item.slice(0, 2);
    const path = item.slice(3);
    if (path) changed.add(path.replaceAll('\\', '/'));
    if (/[RC]/.test(code) && status[index + 1]) index += 1;
  }
  const indexPathRaw = git(repositoryPath, ['rev-parse', '--git-path', 'index'], { optional: true }).trim();
  const indexPath = indexPathRaw ? (isAbsolute(indexPathRaw) ? indexPathRaw : join(repositoryPath, indexPathRaw)) : null;
  const indexDigest = indexPath && existsSync(indexPath) ? hash(safeRead(indexPath)) : undefined;
  return {
    available: true,
    head: git(repositoryPath, ['rev-parse', 'HEAD'], { optional: true }).trim() || null,
    branch: git(repositoryPath, ['branch', '--show-current'], { optional: true }).trim() || null,
    dirty: status.length > 0,
    indexDigest,
    changed,
  };
}

function walkNonGit(root, exclusions, deadline, output = [], prefix = '') {
  if (Date.now() > deadline) throw new IntelligenceError('ANALYSIS_PLAN_TIMEOUT', 'repository scope planning exceeded its time budget');
  const directory = prefix ? join(root, ...prefix.split('/')) : root;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (matchesAny(path, exclusions) || matchesAny(`${path}/placeholder`, exclusions)) continue;
    if (entry.isSymbolicLink()) output.push({ path, symlink: true });
    else if (entry.isDirectory()) walkNonGit(root, exclusions, deadline, output, path);
    else if (entry.isFile()) output.push({ path, source: 'untracked' });
  }
  return output;
}

function candidatePaths(repositoryPath, options, gitState, deadline) {
  if (!gitState.available) return walkNonGit(repositoryPath, options.exclusions, deadline);
  const tracked = nulList(git(repositoryPath, ['ls-files', '-z'], { buffer: true }))
    .map((path) => ({ path: path.replaceAll('\\', '/'), source: 'tracked' }));
  const untracked = options.includeUntracked
    ? nulList(git(repositoryPath, ['ls-files', '--others', '--exclude-standard', '-z'], { buffer: true }))
      .map((path) => ({ path: path.replaceAll('\\', '/'), source: 'untracked' }))
    : [];
  const ignoredListing = options.ignoredPaths.length
    ? new Set(nulList(git(repositoryPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...options.ignoredPaths], { optional: true, buffer: true })))
    : new Set();
  const ignored = options.ignoredPaths.map((path) => {
    if (!ignoredListing.has(path)) throw new IntelligenceError('IGNORED_PATH_NOT_CONFIRMED', `ignored path '${path}' is unavailable or not ignored by Git`);
    return { path, source: 'ignored-explicit' };
  });
  return [...tracked, ...untracked, ...ignored];
}

function inspectRepository(repository, options, { now = Date.now } = {}) {
  const started = now();
  const deadline = started + options.limits.maxPlanDurationMs;
  const root = realpathSync(repository.path);
  const gitState = repositoryGitState(root);
  const candidates = candidatePaths(root, options, gitState, deadline)
    .sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set();
  const files = [];
  const entries = [];
  const excluded = [];
  let bytes = 0;
  let truncated = false;

  for (const candidate of candidates) {
    if (now() > deadline) throw new IntelligenceError('ANALYSIS_PLAN_TIMEOUT', 'repository scope planning exceeded its time budget');
    let path;
    try { path = safeRelativePath(candidate.path); }
    catch (error) {
      excluded.push({ pattern: String(candidate.path), reason: 'Unsafe repository-relative path.' });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (matchesAny(path, options.exclusions)) {
      excluded.push({ pattern: path, reason: 'Matched a default or selected exclusion.' });
      continue;
    }
    if (candidate.source === 'tracked' && !options.includeDirty && gitState.changed.has(path)) {
      excluded.push({ pattern: path, reason: 'Working-tree changes were excluded by scope.' });
      continue;
    }
    const absolute = join(root, ...path.split('/'));
    let details;
    try { details = lstatSync(absolute); }
    catch {
      excluded.push({ pattern: path, reason: 'The file disappeared while scope was planned.' });
      continue;
    }
    if (details.isSymbolicLink() || candidate.symlink) {
      excluded.push({ pattern: path, reason: 'Symbolic links are never followed into an analysis snapshot.' });
      continue;
    }
    if (!details.isFile()) {
      excluded.push({ pattern: path, reason: 'Only regular files can enter an analysis snapshot.' });
      continue;
    }
    let resolved;
    try { resolved = realpathSync(absolute); }
    catch {
      excluded.push({ pattern: path, reason: 'The path could not be resolved safely.' });
      continue;
    }
    if (!pathWithin(root, resolved)) {
      excluded.push({ pattern: path, reason: 'Resolved path escapes the repository.' });
      continue;
    }
    if (details.size > options.limits.maxFileBytes) {
      excluded.push({ pattern: path, reason: `File exceeds the ${options.limits.maxFileBytes}-byte per-file budget.` });
      continue;
    }
    if (files.length >= options.limits.maxFiles || bytes + details.size > options.limits.maxBytes) {
      excluded.push({ pattern: path, reason: 'The selected file/byte budget was reached.' });
      truncated = true;
      continue;
    }
    const content = safeRead(absolute);
    const after = lstatSync(absolute);
    const digest = hash(content);
    if (after.size !== details.size || after.mtimeMs !== details.mtimeMs || content.length !== details.size) {
      throw new IntelligenceError('REPOSITORY_CHANGED', `repository file '${path}' changed while scope was planned`, {
        details: { path, retryable: true },
      });
    }
    const executable = Boolean(details.mode & 0o111);
    files.push({ path, digest, size: content.length, source: candidate.source || 'tracked', mode: (details.mode & 0o777).toString(8), executable });
    entries.push({ path, absolute, digest, size: content.length, source: candidate.source || 'tracked', mode: details.mode & 0o777, executable, mtimeMs: details.mtimeMs });
    bytes += content.length;
  }

  const manifest = createContentManifest({
    files,
    git: {
      head: gitState.head,
      branch: gitState.branch,
      dirty: gitState.dirty,
      ...(gitState.indexDigest ? { indexDigest: gitState.indexDigest } : {}),
    },
    selection: {
      includeUntracked: options.includeUntracked,
      includeIgnored: options.ignoredPaths.length > 0,
      exclusions: options.exclusions,
    },
  });
  return {
    root,
    manifest,
    entries,
    scope: {
      included: files.map((file) => file.path),
      excluded,
      truncated,
      limits: options.limits,
    },
    plannedInMs: now() - started,
  };
}

/**
 * Recreate the exact repository content manifest represented by an analysis
 * snapshot. Publication uses this under its repository lock so additions and
 * removals inside the reviewed scope are detected, not only byte changes to
 * files that happened to exist in the original capture.
 */
export function recaptureAnalysisManifest(repository, snapshot, { now = Date.now } = {}) {
  if (!snapshot?.manifest?.selection || !snapshot?.scope?.limits) {
    throw new IntelligenceError('INVALID_ANALYSIS_SNAPSHOT', 'snapshot scope and selection are required to recapture its repository manifest');
  }
  const runtimeExclusions = ['.handraise/**', '.handraise-publication.lock/**', '.handraise.publish-*/**'];
  const options = Object.freeze({
    // The manifest schema predates includeDirty. Including current dirty files
    // is the conservative choice: a newly dirty path invalidates acceptance.
    includeDirty: true,
    includeUntracked: snapshot.manifest.selection.includeUntracked,
    ignoredPaths: snapshot.manifest.files.filter((file) => file.source === 'ignored-explicit').map((file) => file.path),
    exclusions: [...new Set([...snapshot.manifest.selection.exclusions, ...runtimeExclusions])],
    limits: Object.freeze({ ...ANALYSIS_DEFAULT_LIMITS, ...snapshot.scope.limits }),
  });
  const recaptured = inspectRepository(repository, options, { now }).manifest;
  // Keep the reviewed selection identity verbatim. In particular, an explicit
  // ignored path can have been reviewed yet excluded by a byte limit, so it is
  // not always reconstructible from included file records alone.
  return createContentManifest({
    files: recaptured.files,
    git: recaptured.git,
    selection: snapshot.manifest.selection,
  });
}

function publicPlan(plan) {
  return {
    id: plan.id,
    repositoryId: plan.repository.id,
    repositoryAdapter: plan.repository.adapter,
    analyzer: plan.analyzer,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    manifest: plan.manifest,
    scope: plan.scope,
    options: plan.options,
    adapterPlan: plan.adapterPlan,
    plannedInMs: plan.plannedInMs,
  };
}

function sanitizePlanForStorage(plan) {
  return {
    ...plan,
    entries: plan.entries.map(({ absolute, ...entry }) => entry),
  };
}

function publicJob(job, events = []) {
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    analyzerId: job.analyzerId,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    snapshotId: job.snapshotId || null,
    snapshotFreshness: job.snapshotFreshness || null,
    error: job.error || null,
    resources: job.resources || null,
    events,
  };
}

function makeInventoryAdapter() {
  const descriptor = {
    id: 'handraise-inventory',
    name: 'Handraise structural inventory',
    version: '1.0.0',
    contractVersion: ANALYSIS_SCHEMA_VERSION,
    capabilities: {
      languages: [],
      entityKinds: ['file'],
      relationKinds: [],
      queries: ['entity', 'search', 'neighbors', 'path', 'evidence'],
      history: false,
      semantic: false,
      incremental: false,
    },
    privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
  };
  let lastSnapshot = null;
  return {
    descriptor,
    detect() { return { available: true, isolation: 'private-snapshot' }; },
    plan({ manifest }) { return { files: manifest.counts.files, bytes: manifest.counts.bytes, mode: 'structural-inventory' }; },
    analyze({ repository, manifest, scope, options, createdAt }) {
      const evidence = manifest.files.map((file, index) => ({
        id: `evidence:file:${index + 1}`,
        sourceKind: 'source',
        provenance: 'extracted',
        path: file.path,
        revision: file.digest,
        summary: `File captured in the immutable private snapshot (${file.size} bytes).`,
      }));
      const entities = manifest.files.map((file, index) => ({
        id: `file:${index + 1}`,
        kind: 'file',
        name: file.path,
        language: classifyLanguage(file.path),
        location: { path: file.path },
        evidenceIds: [`evidence:file:${index + 1}`],
        attributes: { size: file.size, source: file.source, digest: file.digest, executable: Boolean(file.executable) },
      }));
      const languages = [...new Set(entities.map((entity) => entity.language))].sort();
      const coverage = languages.map((language, index) => ({
        id: `coverage:language:${index + 1}`,
        subject: language,
        status: language === 'Unknown' ? 'partial' : 'covered',
        summary: language === 'Unknown'
          ? 'Files are inventoried, but no language-specific parser has been selected.'
          : 'Files are inventoried structurally; semantic relations require a richer adapter.',
        evidenceIds: [],
      }));
      lastSnapshot = createAnalysisSnapshot({
        repository: { id: repository.id, adapter: repository.adapter },
        createdAt,
        analyzer: descriptor,
        configuration: options,
        status: scope.truncated ? 'partial' : 'complete',
        freshness: { state: 'current', checkedAt: createdAt },
        manifest,
        scope,
        evidence,
        entities,
        relations: [],
        findings: [],
        coverage,
        diagnostics: scope.truncated ? [{ code: 'SCOPE_TRUNCATED', severity: 'warning', message: 'The selected analysis budget truncated repository coverage.' }] : [],
        extensions: { runtimeVersion: ANALYSIS_RUNTIME_VERSION },
      });
      return lastSnapshot;
    },
    query(query) {
      if (!lastSnapshot) throw new IntelligenceError('SNAPSHOT_NOT_LOADED', 'no inventory snapshot is loaded');
      return queryAnalysisSnapshot(lastSnapshot, query);
    },
    dispose() { lastSnapshot = null; },
  };
}

function registerAdapterRecord(adapter) {
  const validated = validateAnalyzerAdapter(adapter);
  return Object.freeze({
    ...validated,
    execution: adapter.execution || null,
  });
}

export class AnalysisRuntime {
  constructor({ root, adapters = [], now = () => Date.now(), planTtlMs = PLAN_TTL_MS, retentionMs = JOB_RETENTION_MS } = {}) {
    if (!root) throw new IntelligenceError('ANALYSIS_ROOT_REQUIRED', 'analysis runtime root is required');
    this.root = ensurePrivateDirectory(root);
    this.plansRoot = ensurePrivateDirectory(join(this.root, 'plans'));
    this.jobsRoot = ensurePrivateDirectory(join(this.root, 'jobs'));
    this.now = now;
    this.planTtlMs = planTtlMs;
    this.retentionMs = retentionMs;
    this.adapters = new Map();
    this.jobs = new Map();
    this.controllers = new Map();
    this.registerAdapter(makeInventoryAdapter());
    for (const adapter of adapters) this.registerAdapter(adapter);
    this.#recover();
    this.cleanup();
  }

  registerAdapter(adapter) {
    const record = registerAdapterRecord(adapter);
    if (this.adapters.has(record.descriptor.id)) throw new IntelligenceError('DUPLICATE_ANALYZER', `analyzer '${record.descriptor.id}' is already registered`);
    this.adapters.set(record.descriptor.id, record);
    return record.descriptor;
  }

  async analyzers() {
    return Promise.all([...this.adapters.values()].map(async (adapter) => {
      try {
        const detected = await adapter.detect({ catalog: true });
        const availability = detected && typeof detected === 'object'
          ? {
              available: detected.available !== false,
              ...(detected.code ? { code: cleanText(detected.code, 128) } : {}),
              ...(detected.reason ? { reason: cleanText(detected.reason, 2_000) } : {}),
              ...(detected.binary ? { binary: cleanText(detected.binary, 4_096) } : {}),
              ...(detected.package ? { package: cleanText(detected.package, 256) } : {}),
              ...(detected.version ? { version: cleanText(detected.version, 128) } : {}),
              ...(detected.supportedVersions ? { supportedVersions: cleanText(detected.supportedVersions, 256) } : {}),
              ...(detected.command ? { command: cleanText(detected.command, 2_000) } : {}),
              ...(detected.schema ? { schema: cleanText(detected.schema, 256) } : {}),
              ...(detected.isolation ? { isolation: cleanText(detected.isolation, 256) } : {}),
            }
          : { available: true };
        return { ...adapter.descriptor, availability };
      } catch (error) {
        return {
          ...adapter.descriptor,
          availability: {
            available: false,
            code: cleanText(error?.code || 'ANALYZER_DETECTION_FAILED', 128),
            reason: cleanText(error?.message || error || 'Analyzer detection failed.', 2_000),
          },
        };
      }
    }));
  }

  #planPath(id) {
    if (!SAFE_PLAN_ID.test(id)) throw new IntelligenceError('PLAN_NOT_FOUND', 'analysis plan not found');
    return join(this.plansRoot, `${id}.json`);
  }

  #jobDirectory(id) {
    if (!SAFE_JOB_ID.test(id)) throw new IntelligenceError('JOB_NOT_FOUND', 'analysis job not found');
    return join(this.jobsRoot, id.slice(4));
  }

  #jobPath(id) {
    return join(this.#jobDirectory(id), 'job.json');
  }

  #eventsPath(id) {
    return join(this.#jobDirectory(id), 'events.ndjson');
  }

  #persistJob(job) {
    if (!this.jobs.has(job.id)) return;
    privateJson(this.#jobPath(job.id), job);
  }

  #events(id, limit = 100) {
    try {
      return readFileSync(this.#eventsPath(id), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
    } catch { return []; }
  }

  #emit(job, stage, progress, message, extra = {}) {
    if (!this.jobs.has(job.id)) return;
    job.updatedAt = nowIso(this.now);
    job.stage = stage;
    job.progress = Math.max(0, Math.min(1, Number(progress) || 0));
    job.message = cleanText(message, 4_096);
    Object.assign(job, extra);
    const event = { jobId: job.id, state: job.state, stage, at: job.updatedAt, progress: job.progress, message: job.message };
    appendFileSync(this.#eventsPath(job.id), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.#eventsPath(job.id), 0o600);
    this.#persistJob(job);
  }

  #transition(job, state, stage, progress, message, extra = {}) {
    if (!this.jobs.has(job.id)) return;
    if (TERMINAL_STATES.has(job.state) && job.state !== state) return;
    job.state = state;
    this.#emit(job, stage, progress, message, extra);
  }

  #recover() {
    for (const directory of readdirSync(this.jobsRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const path = join(this.jobsRoot, directory.name, 'job.json');
      try {
        const job = JSON.parse(readFileSync(path, 'utf8'));
        if (!SAFE_JOB_ID.test(job.id)) continue;
        this.jobs.set(job.id, job);
        if (ACTIVE_STATES.has(job.state)) {
          for (const name of ['source', 'output', 'home', 'tmp']) {
            removePrivateTree(join(this.#jobDirectory(job.id), name));
          }
          job.state = 'stale';
          job.error = { code: 'SERVER_RESTARTED', message: 'The server restarted before analysis reached a terminal result.', retryable: true };
          this.#emit(job, 'recovery', job.progress || 0, 'Analysis became stale after server restart. Incomplete private source/output data was removed; start from a fresh plan.');
        }
      } catch { removePrivateTree(join(this.jobsRoot, directory.name)); }
    }
  }

  #readPlan(id) {
    let plan;
    try { plan = JSON.parse(readFileSync(this.#planPath(id), 'utf8')); }
    catch { throw new IntelligenceError('PLAN_NOT_FOUND', 'analysis plan not found or expired'); }
    if (new Date(plan.expiresAt).getTime() <= this.now()) {
      rmSync(this.#planPath(id), { force: true });
      throw new IntelligenceError('PLAN_EXPIRED', 'analysis plan expired; review a fresh repository scope');
    }
    plan.entries = plan.entries.map((entry) => ({
      ...entry,
      absolute: join(plan.repository.path, ...safeRelativePath(entry.path).split('/')),
    }));
    return plan;
  }

  async plan(repository, { analyzerId = 'handraise-inventory', scope = {}, hostAuthority = false, consent = false } = {}) {
    this.cleanup();
    if (!repository?.id || !repository?.path || !repository?.adapter) throw new IntelligenceError('INVALID_REPOSITORY', 'repository id, path and adapter are required');
    assertSeparatedStorage(repository.path, this.root);
    const options = normalizeScopeOptions(scope);
    if (options.ignoredPaths.length && !hostAuthority) {
      throw new IntelligenceError('LOCAL_AUTHORITY_REQUIRED', 'only the implicit server-host client can include ignored files in analysis');
    }
    const adapter = this.adapters.get(String(analyzerId));
    if (!adapter) throw new IntelligenceError('ANALYZER_NOT_FOUND', `analyzer '${analyzerId}' is not registered`);
    const privacy = adapter.descriptor.privacy;
    if ((!privacy.localOnly || privacy.modelAssisted || privacy.sourceMayLeaveHost) && !hostAuthority) {
      throw new IntelligenceError('LOCAL_AUTHORITY_REQUIRED', 'only the implicit server-host client can select a model-assisted or non-local analyzer');
    }
    if (privacy.requiresConsent && !consent) throw new IntelligenceError('ANALYZER_CONSENT_REQUIRED', 'this analyzer requires explicit source/data-boundary consent');
    const detection = await adapter.detect({ repository: { id: repository.id, adapter: repository.adapter } });
    if (detection && typeof detection === 'object' && detection.available === false) {
      throw new IntelligenceError('ANALYZER_UNAVAILABLE', cleanText(detection.reason || `${adapter.descriptor.name} is unavailable`));
    }
    const inspected = inspectRepository(repository, options, { now: this.now });
    const adapterPlan = await adapter.plan({
      repository: { id: repository.id, adapter: repository.adapter },
      manifest: inspected.manifest,
      scope: inspected.scope,
      options,
    });
    if (Buffer.byteLength(JSON.stringify(adapterPlan ?? null)) > 256 * 1024) {
      throw new IntelligenceError('ANALYZER_PLAN_TOO_LARGE', 'analyzer planning output exceeds 256 KiB');
    }
    const id = hash(`handraise-analysis-plan-v1\0${canonical({
      repository: { id: repository.id, adapter: repository.adapter },
      analyzer: { id: adapter.descriptor.id, version: adapter.descriptor.version },
      manifest: inspected.manifest.digest,
      options,
    })}`);
    const createdAt = nowIso(this.now);
    const plan = {
      id,
      repository: { id: repository.id, adapter: repository.adapter, path: realpathSync(repository.path) },
      analyzer: adapter.descriptor,
      createdAt,
      expiresAt: new Date(this.now() + this.planTtlMs).toISOString(),
      manifest: inspected.manifest,
      scope: inspected.scope,
      options,
      entries: inspected.entries,
      adapterPlan: adapterPlan ?? null,
      plannedInMs: inspected.plannedInMs,
    };
    privateJson(this.#planPath(id), sanitizePlanForStorage(plan));
    return publicPlan(plan);
  }

  start(repository, { planId, hostAuthority = false, consent = false } = {}) {
    const plan = this.#readPlan(String(planId || ''));
    if (plan.repository.id !== repository?.id || realpathSync(repository.path) !== plan.repository.path) {
      throw new IntelligenceError('PLAN_REPOSITORY_MISMATCH', 'analysis plan belongs to a different repository');
    }
    const adapter = this.adapters.get(plan.analyzer.id);
    if (!adapter || adapter.descriptor.version !== plan.analyzer.version) {
      throw new IntelligenceError('ANALYZER_CHANGED', 'the selected analyzer changed after preview; create a fresh plan');
    }
    const privacy = adapter.descriptor.privacy;
    if ((!privacy.localOnly || privacy.modelAssisted || privacy.sourceMayLeaveHost || plan.options.ignoredPaths.length) && !hostAuthority) {
      throw new IntelligenceError('LOCAL_AUTHORITY_REQUIRED', 'this reviewed analysis can only be started by the implicit server-host client');
    }
    if (privacy.requiresConsent && !consent) throw new IntelligenceError('ANALYZER_CONSENT_REQUIRED', 'this analyzer requires explicit source/data-boundary consent');

    const id = `job:${randomUUID()}`;
    const directory = ensurePrivateDirectory(this.#jobDirectory(id));
    ensurePrivateDirectory(join(directory, 'source'));
    ensurePrivateDirectory(join(directory, 'output'));
    ensurePrivateDirectory(join(directory, 'home'));
    ensurePrivateDirectory(join(directory, 'tmp'));
    const createdAt = nowIso(this.now);
    const job = {
      runtimeVersion: ANALYSIS_RUNTIME_VERSION,
      id,
      repositoryId: repository.id,
      repositoryAdapter: repository.adapter,
      repositoryPath: realpathSync(repository.path),
      analyzerId: adapter.descriptor.id,
      analyzerVersion: adapter.descriptor.version,
      planId: plan.id,
      state: 'queued',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(this.now() + this.retentionMs).toISOString(),
      progress: 0,
      stage: 'queued',
      message: 'Analysis is queued.',
      resources: { files: plan.manifest.counts.files, bytes: plan.manifest.counts.bytes, outputBytes: 0, durationMs: 0, isolation: 'private-snapshot' },
    };
    this.jobs.set(id, job);
    this.#persistJob(job);
    this.#emit(job, 'queued', 0, 'Analysis is queued.');
    queueMicrotask(() => void this.#run(job, plan, adapter));
    return publicJob(job, this.#events(id));
  }

  status(repositoryId, id) {
    const job = this.jobs.get(String(id || ''));
    if (!job || job.repositoryId !== repositoryId) throw new IntelligenceError('JOB_NOT_FOUND', 'analysis job not found');
    return publicJob(job, this.#events(job.id));
  }

  list(repositoryId) {
    this.cleanup();
    return [...this.jobs.values()]
      .filter((job) => job.repositoryId === repositoryId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => publicJob(job, this.#events(job.id, 20)));
  }

  snapshot(repositoryId, id) {
    const job = this.jobs.get(String(id || ''));
    if (!job || job.repositoryId !== repositoryId || !job.snapshotId) throw new IntelligenceError('SNAPSHOT_NOT_FOUND', 'analysis snapshot not found');
    try { return JSON.parse(readFileSync(join(this.#jobDirectory(job.id), 'snapshot.json'), 'utf8')); }
    catch { throw new IntelligenceError('SNAPSHOT_NOT_FOUND', 'analysis snapshot is unavailable'); }
  }

  cancel(repositoryId, id) {
    const job = this.jobs.get(String(id || ''));
    if (!job || job.repositoryId !== repositoryId) throw new IntelligenceError('JOB_NOT_FOUND', 'analysis job not found');
    if (TERMINAL_STATES.has(job.state)) return publicJob(job, this.#events(job.id));
    const controller = this.controllers.get(job.id);
    controller?.abort.abort();
    controller?.terminate?.();
    this.#transition(job, 'cancelled', 'cancelled', job.progress, 'Analysis was cancelled by the user.', {
      error: { code: 'CANCELLED', message: 'Analysis was cancelled by the user.', retryable: true },
    });
    return publicJob(job, this.#events(job.id));
  }

  async delete(repositoryId, id) {
    const job = this.jobs.get(String(id || ''));
    if (!job || job.repositoryId !== repositoryId) throw new IntelligenceError('JOB_NOT_FOUND', 'analysis job not found');
    if (!TERMINAL_STATES.has(job.state)) this.cancel(repositoryId, id);
    const deadline = Date.now() + 2_000;
    while (this.controllers.has(job.id) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    this.controllers.get(job.id)?.terminate?.(true);
    this.controllers.delete(job.id);
    this.jobs.delete(job.id);
    removePrivateTree(this.#jobDirectory(job.id));
    return { deleted: job.id };
  }

  cleanup() {
    const time = this.now();
    for (const name of readdirSync(this.plansRoot)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.plansRoot, name);
      try {
        const plan = JSON.parse(readFileSync(path, 'utf8'));
        if (new Date(plan.expiresAt).getTime() <= time) rmSync(path, { force: true });
      } catch { rmSync(path, { force: true }); }
    }
    for (const [id, job] of this.jobs) {
      if (TERMINAL_STATES.has(job.state) && new Date(job.expiresAt).getTime() <= time) {
        this.jobs.delete(id);
        removePrivateTree(this.#jobDirectory(id));
      }
    }
  }

  shutdown() {
    for (const job of this.jobs.values()) if (!TERMINAL_STATES.has(job.state)) this.cancel(job.repositoryId, job.id);
  }

  async #capture(job, plan, abortSignal) {
    const fresh = inspectRepository({ id: plan.repository.id, adapter: plan.repository.adapter, path: plan.repository.path }, plan.options, { now: this.now });
    if (fresh.manifest.digest !== plan.manifest.digest) {
      throw new IntelligenceError('REPOSITORY_CHANGED', 'repository content changed after the analysis scope was reviewed', {
        details: { plannedManifest: plan.manifest.digest, currentManifest: fresh.manifest.digest, retryable: true },
      });
    }
    const source = join(this.#jobDirectory(job.id), 'source');
    for (const [index, entry] of plan.entries.entries()) {
      if (abortSignal.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
      const before = lstatSync(entry.absolute);
      const resolved = realpathSync(entry.absolute);
      if (!before.isFile() || before.isSymbolicLink() || !pathWithin(plan.repository.path, resolved)) {
        throw new IntelligenceError('REPOSITORY_CHANGED', `repository path '${entry.path}' no longer resolves to the reviewed regular file`, {
          details: { path: entry.path, retryable: true },
        });
      }
      const content = safeRead(entry.absolute);
      const after = lstatSync(entry.absolute);
      if (!after.isFile() || after.isSymbolicLink() || hash(content) !== entry.digest || content.length !== entry.size
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.mtimeMs !== entry.mtimeMs) {
        throw new IntelligenceError('REPOSITORY_CHANGED', `repository file '${entry.path}' changed during snapshot capture`, {
          details: { path: entry.path, retryable: true },
        });
      }
      const target = join(source, ...entry.path.split('/'));
      const parent = target.slice(0, target.lastIndexOf(sep));
      ensurePrivateDirectory(parent);
      writeFileSync(target, content, { mode: entry.executable ? 0o700 : 0o600, flag: 'wx' });
      chmodSync(target, entry.executable ? 0o500 : 0o400);
      if (index % 25 === 0 || index + 1 === plan.entries.length) {
        this.#emit(job, 'capture', .05 + .35 * ((index + 1) / Math.max(1, plan.entries.length)), `Captured ${index + 1} of ${plan.entries.length} files.`);
      }
    }
    const afterCapture = inspectRepository({ id: plan.repository.id, adapter: plan.repository.adapter, path: plan.repository.path }, plan.options, { now: this.now });
    if (afterCapture.manifest.digest !== plan.manifest.digest) {
      throw new IntelligenceError('REPOSITORY_CHANGED', 'repository content changed while the private snapshot was captured', {
        details: { plannedManifest: plan.manifest.digest, currentManifest: afterCapture.manifest.digest, retryable: true },
      });
    }
    this.#makeTreeReadOnly(source);
    privateJson(join(this.#jobDirectory(job.id), 'manifest.json'), plan.manifest);
    return source;
  }

  #makeTreeReadOnly(root) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) this.#makeTreeReadOnly(path);
      else chmodSync(path, statSync(path).mode & 0o111 ? 0o500 : 0o400);
    }
    chmodSync(root, 0o500);
  }

  async #run(job, plan, adapter) {
    const started = this.now();
    const abort = new AbortController();
    const control = { abort, terminate: null };
    this.controllers.set(job.id, control);
    try {
      if (job.state === 'cancelled') return;
      this.#transition(job, 'running', 'capture', .02, 'Creating an immutable private repository snapshot.');
      const sourcePath = await this.#capture(job, plan, abort.signal);
      if (job.state === 'cancelled') return;
      this.#emit(job, 'analyze', .42, `Running ${adapter.descriptor.name} against the private snapshot.`);
      const context = {
        repository: { id: plan.repository.id, adapter: plan.repository.adapter },
        manifest: plan.manifest,
        scope: plan.scope,
        options: plan.options,
        adapterPlan: plan.adapterPlan,
        sourcePath,
        outputPath: join(this.#jobDirectory(job.id), 'output'),
        signal: abort.signal,
        createdAt: nowIso(this.now),
        progress: (progress, message) => this.#emit(job, 'analyze', .42 + .48 * Math.max(0, Math.min(1, progress)), message),
      };
      const snapshot = adapter.execution
        ? await this.#runCommand(job, adapter, context, control)
        : await this.#runInProcess(adapter, context, control);
      if (job.state === 'cancelled') return;
      let normalized = validateAnalysisSnapshot(snapshot);
      if (normalized.repository.id !== plan.repository.id || normalized.repository.adapter !== plan.repository.adapter) {
        throw new IntelligenceError('ANALYZER_CONTRACT_VIOLATION', 'analyzer returned a snapshot for a different repository');
      }
      if (normalized.manifest.digest !== plan.manifest.digest) {
        throw new IntelligenceError('ANALYZER_CONTRACT_VIOLATION', 'analyzer returned evidence for a different content manifest');
      }
      const afterAnalysis = inspectRepository({ id: plan.repository.id, adapter: plan.repository.adapter, path: plan.repository.path }, plan.options, { now: this.now });
      const changed = afterAnalysis.manifest.digest !== plan.manifest.digest;
      if (changed) {
        normalized = createAnalysisSnapshot({
          ...normalized,
          id: undefined,
          freshness: {
            state: 'stale',
            checkedAt: nowIso(this.now),
            reason: 'Repository content changed after the private snapshot was captured.',
          },
        });
      }
      privateWrite(join(this.#jobDirectory(job.id), 'snapshot.json'), serializeAnalysisSnapshot(normalized));
      const extra = {
        snapshotId: normalized.id,
        snapshotFreshness: normalized.freshness.state,
        resources: { ...job.resources, durationMs: this.now() - started },
      };
      if (changed) {
        this.#transition(job, 'stale', 'stale', 1, 'Analysis completed over a coherent snapshot, but the repository changed; review a fresh analysis.', {
          ...extra,
          error: { code: 'REPOSITORY_CHANGED', message: 'The result is coherent but stale.', retryable: true },
        });
      } else {
        this.#transition(job, 'complete', 'complete', 1, 'Analysis completed over the reviewed repository snapshot.', extra);
      }
    } catch (error) {
      if (!this.jobs.has(job.id) || job.state === 'cancelled') return;
      const failure = intelligenceFailure(error, 'ANALYSIS_FAILED');
      if (failure.code === 'REPOSITORY_CHANGED') {
        this.#transition(job, 'stale', 'stale', job.progress, failure.message, {
          error: { code: failure.code, message: failure.message, details: failure.details, retryable: true },
        });
      } else if (failure.code === 'AWAITING_INPUT') {
        this.#transition(job, 'awaiting-input', 'awaiting-input', job.progress, failure.message, {
          error: { code: failure.code, message: failure.message, details: failure.details, retryable: true },
        });
      } else {
        this.#transition(job, 'failed', 'failed', job.progress, failure.message, {
          error: { code: failure.code, message: failure.message, details: failure.details, retryable: ['TIMEOUT', 'OUTPUT_LIMIT', 'ANALYZER_EXIT'].includes(failure.code) },
        });
      }
    } finally {
      try { await adapter.dispose({ jobId: job.id }); } catch { /* cleanup diagnostics must not replace the terminal cause */ }
      this.controllers.delete(job.id);
      if (this.jobs.has(job.id)) {
        job.resources = { ...job.resources, durationMs: this.now() - started };
        this.#persistJob(job);
      }
    }
  }

  async #runInProcess(adapter, context, control) {
    let timer;
    let abortListener;
    try {
      return await Promise.race([
        Promise.resolve(adapter.analyze(context)),
        new Promise((_, rejectPromise) => {
          abortListener = () => rejectPromise(new DOMException('Analysis cancelled', 'AbortError'));
          if (context.signal.aborted) abortListener();
          else context.signal.addEventListener('abort', abortListener, { once: true });
        }),
        new Promise((_, rejectPromise) => {
          timer = setTimeout(() => {
            control.abort.abort();
            rejectPromise(new IntelligenceError('TIMEOUT', 'analysis exceeded its wall-time budget'));
          }, context.options.limits.maxAnalysisDurationMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abortListener) context.signal.removeEventListener('abort', abortListener);
    }
  }

  async #runCommand(job, adapter, context, control) {
    const specification = await adapter.execution.command({
      sourcePath: context.sourcePath,
      outputPath: context.outputPath,
      manifest: context.manifest,
      options: context.options,
      adapterPlan: context.adapterPlan,
    });
    if (!specification || typeof specification.file !== 'string' || !Array.isArray(specification.args)
      || specification.args.some((argument) => typeof argument !== 'string')) {
      throw new IntelligenceError('INVALID_ANALYZER_COMMAND', 'analyzer command must contain one executable and a string argv array');
    }
    const directory = this.#jobDirectory(job.id);
    const isolatedHome = join(directory, 'home');
    const temporary = join(directory, 'tmp');
    const environment = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      XDG_CACHE_HOME: join(isolatedHome, '.cache'),
      XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
      TMPDIR: temporary,
      HANDRAISE_SOURCE_ROOT: context.sourcePath,
      HANDRAISE_OUTPUT_ROOT: context.outputPath,
      ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT || '', WINDIR: process.env.WINDIR || '' } : {}),
    };
    for (const [key, value] of Object.entries(specification.env || {})) {
      if (!/^HANDRAISE_[A-Z0-9_]+$/.test(key)) throw new IntelligenceError('INVALID_ANALYZER_ENV', `analyzer environment key '${key}' is outside the allowlist`);
      environment[key] = cleanText(value, 8_192);
    }
    ensurePrivateDirectory(environment.XDG_CONFIG_HOME);
    ensurePrivateDirectory(environment.XDG_CACHE_HOME);
    ensurePrivateDirectory(environment.XDG_DATA_HOME);

    let file = specification.file;
    let args = [...specification.args];
    const prlimit = process.platform === 'linux' && existsSync('/usr/bin/prlimit') ? '/usr/bin/prlimit' : null;
    if (prlimit) {
      const currentTasks = linuxUserTaskCount();
      const processLimit = currentTasks === null ? context.options.limits.maxProcesses : currentTasks + context.options.limits.maxProcesses;
      args = [
        `--as=${context.options.limits.maxMemoryBytes}`,
        `--cpu=${context.options.limits.maxCpuSeconds}`,
        `--nproc=${processLimit}`,
        '--', file, ...args,
      ];
      file = prlimit;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const started = this.now();
    const result = await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let terminationTimer;
      let timeout;
      let forcedError = null;
      const child = spawn(file, args, {
        cwd: context.sourcePath,
        env: environment,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(terminationTimer);
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        if (error) rejectPromise(error); else resolvePromise(value);
      };
      const terminate = (force = false) => {
        if (!child.pid) return;
        const signal = force ? 'SIGKILL' : 'SIGTERM';
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* process already exited */ }
        if (!force) {
          terminationTimer = setTimeout(() => {
            try {
              if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
              else child.kill('SIGKILL');
            } catch { /* process already exited */ }
          }, 750);
          terminationTimer.unref?.();
        }
      };
      control.terminate = terminate;
      const collect = (kind, chunk) => {
        if (settled) return;
        const total = stdout.length + stderr.length + chunk.length;
        if (total > context.options.limits.maxOutputBytes) {
          forcedError ||= new IntelligenceError('OUTPUT_LIMIT', 'analyzer exceeded its stdout/stderr output budget');
          terminate();
          return;
        }
        if (kind === 'stdout') stdout = Buffer.concat([stdout, chunk]);
        else stderr = Buffer.concat([stderr, chunk]);
        job.resources = { ...job.resources, outputBytes: stdout.length + stderr.length };
      };
      child.stdout.on('data', (chunk) => collect('stdout', chunk));
      child.stderr.on('data', (chunk) => collect('stderr', chunk));
      child.once('error', (error) => finish(new IntelligenceError('ANALYZER_START_FAILED', cleanText(error.message), { cause: error })));
      child.once('close', (code, signal) => {
        if (forcedError) finish(forcedError);
        else if (code !== 0) {
          finish(new IntelligenceError('ANALYZER_EXIT', `analyzer exited with ${signal || `code ${code}`}: ${cleanText(stderr.toString('utf8').slice(-2_000))}`));
        } else finish(null, { stdout, stderr });
      });
      timeout = setTimeout(() => {
        forcedError ||= new IntelligenceError('TIMEOUT', 'analyzer exceeded its wall-time budget');
        terminate();
      }, context.options.limits.maxAnalysisDurationMs);
      timeout.unref?.();
      if (context.signal.aborted) terminate();
      context.signal.addEventListener('abort', () => terminate(), { once: true });
    });
    job.resources = { ...job.resources, outputBytes: stdout.length + stderr.length, analyzerDurationMs: this.now() - started, resourceLimits: prlimit ? 'linux-prlimit' : 'portable-walltime-output' };
    if (typeof adapter.execution.parseResult !== 'function') {
      throw new IntelligenceError('INVALID_ANALYZER_COMMAND', 'command analyzer must define parseResult');
    }
    return adapter.execution.parseResult({ ...result, outputPath: context.outputPath, context });
  }
}

export function createAnalysisRuntime(options) {
  return new AnalysisRuntime(options);
}
