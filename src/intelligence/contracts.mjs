import { createHash } from 'node:crypto';

export const ANALYSIS_SCHEMA_VERSION = 1;

export const ANALYSIS_PROVENANCE = Object.freeze(['extracted', 'inferred', 'declared']);
export const ANALYSIS_JOB_STATES = Object.freeze([
  'queued', 'running', 'awaiting-input', 'stale', 'cancelled', 'failed', 'complete',
]);
export const SNAPSHOT_STATES = Object.freeze(['complete', 'partial']);
export const FRESHNESS_STATES = Object.freeze(['current', 'stale', 'unknown']);
export const COVERAGE_STATES = Object.freeze(['covered', 'partial', 'excluded', 'unsupported', 'unknown']);
export const GRAPH_QUERY_TYPES = Object.freeze(['entity', 'search', 'neighbors', 'path', 'evidence']);

const FILE_SOURCES = new Set(['tracked', 'untracked', 'ignored-explicit']);
const PROVENANCE = new Set(ANALYSIS_PROVENANCE);
const JOB_STATES = new Set(ANALYSIS_JOB_STATES);
const SNAPSHOT_STATUS = new Set(SNAPSHOT_STATES);
const FRESHNESS = new Set(FRESHNESS_STATES);
const COVERAGE = new Set(COVERAGE_STATES);
const QUERY_TYPES = new Set(GRAPH_QUERY_TYPES);
const DIRECTIONS = new Set(['outgoing', 'incoming', 'both']);
const DIAGNOSTIC_SEVERITIES = new Set(['info', 'warning', 'error']);
const UNCERTAINTY_LEVELS = new Set(['low', 'medium', 'high', 'unknown']);
const SHA256 = /^[a-f0-9]{64}$/;
const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

export const GRAPH_QUERY_LIMITS = Object.freeze({
  defaultLimit: 50,
  maxLimit: 500,
  defaultDepth: 1,
  maxDepth: 5,
  maxPathDepth: 12,
  maxTextLength: 240,
});

export class IntelligenceError extends Error {
  constructor(code, message, { details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'IntelligenceError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.message, code: this.code, details: this.details };
  }
}

function fail(path, message, code = 'INVALID_CONTRACT') {
  throw new IntelligenceError(code, `${path}: ${message}`, { details: { path } });
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

function text(value, path, { min = 1, max = 4_096, optional = false, nullable = false } = {}) {
  if (value === null && nullable) return null;
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  if (typeof value !== 'string') fail(path, 'must be a string');
  const normalized = value.trim();
  if (normalized.length < min) fail(path, `must contain at least ${min} character${min === 1 ? '' : 's'}`);
  if (normalized.length > max) fail(path, `must contain at most ${max} characters`);
  return normalized;
}

function identifier(value, path) {
  const normalized = text(value, path, { max: 256 });
  if (!CONTRACT_ID.test(normalized)) fail(path, 'contains unsupported characters');
  return normalized;
}

function boolean(value, path, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function number(value, path, { min = 0, max = 1, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isFinite(value) || value < min || value > max) fail(path, `must be a number between ${min} and ${max}`);
  return value;
}

function oneOf(value, options, path, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (!options.has(candidate)) fail(path, `must be one of ${[...options].join(', ')}`);
  return candidate;
}

function list(value, path, mapper, { fallback = [], max = 100_000 } = {}) {
  const candidate = value === undefined ? fallback : value;
  if (!Array.isArray(candidate)) fail(path, 'must be an array');
  if (candidate.length > max) fail(path, `must contain at most ${max} items`);
  return candidate.map((item, index) => mapper(item, `${path}[${index}]`));
}

function unique(items, key, path) {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) fail(path, `contains duplicate '${value}'`);
    seen.add(value);
  }
  return items;
}

function isoDate(value, path, fallback) {
  const candidate = value === undefined ? fallback : value;
  const normalized = text(candidate, path, { max: 64 });
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    fail(path, 'must be an ISO-8601 UTC timestamp');
  }
  return normalized;
}

function hash(value, path, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  const normalized = text(value, path, { max: 64 });
  if (!SHA256.test(normalized)) fail(path, 'must be a lowercase SHA-256 digest');
  return normalized;
}

function relativePath(value, path) {
  const normalized = text(value, path, { max: 4_096 }).replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes('\0')
    || normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    fail(path, 'must be a safe repository-relative path');
  }
  return normalized;
}

function stringList(value, path, { fallback = [], max = 2_000, itemMax = 256 } = {}) {
  return unique(list(value, path, (item, itemPath) => text(item, itemPath, { max: itemMax }), { fallback, max }), (item) => item, path);
}

function jsonValue(value, path, depth = 0) {
  if (depth > 16) fail(path, 'exceeds the maximum JSON nesting depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [
      text(key, `${path}.<key>`, { max: 256 }), jsonValue(item, `${path}.${key}`, depth + 1),
    ]));
  }
  fail(path, 'must contain only JSON-compatible values');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function references(values, known, path) {
  for (const value of values) if (!known.has(value)) fail(path, `references unknown '${value}'`);
}

function normalizeFile(value, path) {
  const input = record(value, path);
  const result = {
    path: relativePath(input.path, `${path}.path`),
    digest: hash(input.digest, `${path}.digest`),
    size: integer(input.size, `${path}.size`),
    source: oneOf(input.source, FILE_SOURCES, `${path}.source`, 'tracked'),
  };
  if (input.mode !== undefined) result.mode = text(input.mode, `${path}.mode`, { max: 16 });
  if (input.executable !== undefined) result.executable = boolean(input.executable, `${path}.executable`);
  return result;
}

export function createContentManifest(value = {}) {
  const input = record(value, 'manifest');
  const files = unique(list(input.files, 'manifest.files', normalizeFile, { max: 100_000 }), (file) => file.path, 'manifest.files')
    .sort((left, right) => left.path.localeCompare(right.path));
  const gitInput = record(input.git || {}, 'manifest.git');
  const selectionInput = record(input.selection || {}, 'manifest.selection');
  const git = {
    head: text(gitInput.head, 'manifest.git.head', { optional: true, nullable: true, max: 128 }) ?? null,
    branch: text(gitInput.branch, 'manifest.git.branch', { optional: true, nullable: true, max: 512 }) ?? null,
    dirty: boolean(gitInput.dirty, 'manifest.git.dirty'),
  };
  if (gitInput.indexDigest !== undefined) git.indexDigest = hash(gitInput.indexDigest, 'manifest.git.indexDigest');
  const selection = {
    includeUntracked: boolean(selectionInput.includeUntracked, 'manifest.selection.includeUntracked'),
    includeIgnored: boolean(selectionInput.includeIgnored, 'manifest.selection.includeIgnored'),
    exclusions: stringList(selectionInput.exclusions, 'manifest.selection.exclusions', { max: 10_000, itemMax: 4_096 }),
  };
  const body = { files, git, selection };
  const digest = sha256(`handraise-content-manifest-v1\0${canonical(body)}`);
  if (input.digest !== undefined && hash(input.digest, 'manifest.digest') !== digest) {
    fail('manifest.digest', 'does not match the normalized manifest content', 'SNAPSHOT_IDENTITY_MISMATCH');
  }
  return deepFreeze({ ...body, digest, counts: {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    tracked: files.filter((file) => file.source === 'tracked').length,
    untracked: files.filter((file) => file.source === 'untracked').length,
    ignoredExplicit: files.filter((file) => file.source === 'ignored-explicit').length,
  } });
}

function normalizeCapabilities(value, path = 'analyzer.capabilities') {
  const input = record(value || {}, path);
  return {
    languages: stringList(input.languages, `${path}.languages`, { max: 1_000 }),
    entityKinds: stringList(input.entityKinds, `${path}.entityKinds`, { max: 1_000 }),
    relationKinds: stringList(input.relationKinds, `${path}.relationKinds`, { max: 1_000 }),
    queries: unique(list(input.queries, `${path}.queries`, (item, itemPath) => oneOf(item, QUERY_TYPES, itemPath), { max: GRAPH_QUERY_TYPES.length }), (item) => item, `${path}.queries`),
    history: boolean(input.history, `${path}.history`),
    semantic: boolean(input.semantic, `${path}.semantic`),
    incremental: boolean(input.incremental, `${path}.incremental`),
  };
}

export function validateAnalyzerDescriptor(value) {
  const input = record(value, 'analyzer');
  const contractVersion = integer(input.contractVersion, 'analyzer.contractVersion', { min: 1, max: 1_000_000, fallback: ANALYSIS_SCHEMA_VERSION });
  if (contractVersion !== ANALYSIS_SCHEMA_VERSION) {
    fail('analyzer.contractVersion', `unsupported version ${contractVersion}`, 'INCOMPATIBLE_SCHEMA');
  }
  const privacyInput = record(input.privacy || {}, 'analyzer.privacy');
  const privacy = {
    localOnly: boolean(privacyInput.localOnly, 'analyzer.privacy.localOnly', true),
    modelAssisted: boolean(privacyInput.modelAssisted, 'analyzer.privacy.modelAssisted'),
    sourceMayLeaveHost: boolean(privacyInput.sourceMayLeaveHost, 'analyzer.privacy.sourceMayLeaveHost'),
    requiresConsent: boolean(privacyInput.requiresConsent, 'analyzer.privacy.requiresConsent'),
  };
  if (privacy.sourceMayLeaveHost && !privacy.requiresConsent) {
    fail('analyzer.privacy.requiresConsent', 'must be true when source may leave the host');
  }
  if (privacy.localOnly && privacy.sourceMayLeaveHost) {
    fail('analyzer.privacy', 'cannot be local-only while source may leave the host');
  }
  const result = {
    id: identifier(input.id, 'analyzer.id'),
    name: text(input.name, 'analyzer.name', { max: 256 }),
    version: text(input.version, 'analyzer.version', { max: 128 }),
    contractVersion,
    capabilities: normalizeCapabilities(input.capabilities),
    privacy,
  };
  if (input.extensions !== undefined) result.extensions = jsonValue(input.extensions, 'analyzer.extensions');
  return deepFreeze(result);
}

function normalizePosition(value, path) {
  const input = record(value, path);
  return {
    line: integer(input.line, `${path}.line`, { min: 1, max: 10_000_000 }),
    column: integer(input.column, `${path}.column`, { min: 1, max: 10_000_000, fallback: 1 }),
  };
}

function normalizeRange(value, path) {
  const input = record(value, path);
  const start = normalizePosition(input.start, `${path}.start`);
  const end = normalizePosition(input.end || input.start, `${path}.end`);
  if (end.line < start.line || (end.line === start.line && end.column < start.column)) fail(path, 'end precedes start');
  return { start, end };
}

function normalizeEvidence(value, path) {
  const input = record(value, path);
  const result = {
    id: identifier(input.id, `${path}.id`),
    sourceKind: text(input.sourceKind, `${path}.sourceKind`, { max: 128 }),
    provenance: oneOf(input.provenance, PROVENANCE, `${path}.provenance`),
  };
  if (input.path !== undefined) result.path = relativePath(input.path, `${path}.path`);
  if (input.range !== undefined) result.range = normalizeRange(input.range, `${path}.range`);
  if (result.range && !result.path) fail(path, 'a source range requires a path');
  if (input.revision !== undefined) result.revision = text(input.revision, `${path}.revision`, { max: 256 });
  if (input.excerptHash !== undefined) result.excerptHash = hash(input.excerptHash, `${path}.excerptHash`);
  if (input.summary !== undefined) result.summary = text(input.summary, `${path}.summary`, { max: 2_000 });
  if (input.extensions !== undefined) result.extensions = jsonValue(input.extensions, `${path}.extensions`);
  return result;
}

function normalizeEntity(value, path) {
  const input = record(value, path);
  const result = {
    id: identifier(input.id, `${path}.id`),
    kind: text(input.kind, `${path}.kind`, { max: 128 }),
    name: text(input.name, `${path}.name`, { max: 1_024 }),
    evidenceIds: stringList(input.evidenceIds, `${path}.evidenceIds`, { max: 10_000 }),
  };
  if (input.location !== undefined) {
    const location = record(input.location, `${path}.location`);
    result.location = { path: relativePath(location.path, `${path}.location.path`) };
    if (location.range !== undefined) result.location.range = normalizeRange(location.range, `${path}.location.range`);
  }
  if (input.language !== undefined) result.language = text(input.language, `${path}.language`, { max: 128 });
  if (input.attributes !== undefined) result.attributes = jsonValue(input.attributes, `${path}.attributes`);
  return result;
}

function normalizeRelation(value, path) {
  const input = record(value, path);
  const result = {
    id: identifier(input.id, `${path}.id`),
    source: identifier(input.source, `${path}.source`),
    target: identifier(input.target, `${path}.target`),
    kind: text(input.kind, `${path}.kind`, { max: 128 }),
    evidenceIds: stringList(input.evidenceIds, `${path}.evidenceIds`, { max: 10_000 }),
  };
  if (input.confidence !== undefined) result.confidence = number(input.confidence, `${path}.confidence`, { optional: true });
  if (input.attributes !== undefined) result.attributes = jsonValue(input.attributes, `${path}.attributes`);
  return result;
}

function normalizeUncertainty(value, path) {
  const input = record(value || {}, path);
  return {
    level: oneOf(input.level, UNCERTAINTY_LEVELS, `${path}.level`, 'unknown'),
    reasons: stringList(input.reasons, `${path}.reasons`, { max: 100, itemMax: 2_000 }),
  };
}

function normalizeFinding(value, path) {
  const input = record(value, path);
  return {
    id: identifier(input.id, `${path}.id`),
    kind: text(input.kind, `${path}.kind`, { max: 128 }),
    summary: text(input.summary, `${path}.summary`, { max: 4_096 }),
    evidenceIds: stringList(input.evidenceIds, `${path}.evidenceIds`, { max: 10_000 }),
    entityIds: stringList(input.entityIds, `${path}.entityIds`, { max: 10_000 }),
    uncertainty: normalizeUncertainty(input.uncertainty, `${path}.uncertainty`),
    alternatives: list(input.alternatives, `${path}.alternatives`, (item, itemPath) => {
      const alternative = record(item, itemPath);
      return {
        summary: text(alternative.summary, `${itemPath}.summary`, { max: 4_096 }),
        evidenceIds: stringList(alternative.evidenceIds, `${itemPath}.evidenceIds`, { max: 10_000 }),
      };
    }, { max: 100 }),
  };
}

function normalizeCoverage(value, path) {
  const input = record(value, path);
  return {
    id: identifier(input.id, `${path}.id`),
    subject: text(input.subject, `${path}.subject`, { max: 1_024 }),
    status: oneOf(input.status, COVERAGE, `${path}.status`, 'unknown'),
    summary: text(input.summary, `${path}.summary`, { optional: true, max: 4_096 }) || '',
    evidenceIds: stringList(input.evidenceIds, `${path}.evidenceIds`, { max: 10_000 }),
  };
}

function normalizeDiagnostic(value, path) {
  const input = record(value, path);
  const result = {
    code: identifier(input.code, `${path}.code`),
    severity: oneOf(input.severity, DIAGNOSTIC_SEVERITIES, `${path}.severity`, 'warning'),
    message: text(input.message, `${path}.message`, { max: 4_096 }),
  };
  if (input.path !== undefined) result.path = relativePath(input.path, `${path}.path`);
  if (input.evidenceIds !== undefined) result.evidenceIds = stringList(input.evidenceIds, `${path}.evidenceIds`, { max: 10_000 });
  if (input.details !== undefined) result.details = jsonValue(input.details, `${path}.details`);
  return result;
}

function normalizeScope(value) {
  const input = record(value || {}, 'snapshot.scope');
  const limitsInput = record(input.limits || {}, 'snapshot.scope.limits');
  return {
    included: stringList(input.included, 'snapshot.scope.included', { max: 10_000, itemMax: 4_096 }),
    excluded: list(input.excluded, 'snapshot.scope.excluded', (item, path) => {
      const exclusion = record(item, path);
      return {
        pattern: text(exclusion.pattern, `${path}.pattern`, { max: 4_096 }),
        reason: text(exclusion.reason, `${path}.reason`, { max: 2_000 }),
      };
    }, { max: 10_000 }),
    truncated: boolean(input.truncated, 'snapshot.scope.truncated'),
    limits: Object.fromEntries(Object.entries(limitsInput).map(([key, value]) => [
      text(key, 'snapshot.scope.limits.<key>', { max: 128 }),
      integer(value, `snapshot.scope.limits.${key}`),
    ])),
  };
}

function configurationDigest(value) {
  if (value === undefined) return sha256('handraise-analysis-configuration-v1\0{}');
  if (typeof value === 'string' && SHA256.test(value)) return value;
  return sha256(`handraise-analysis-configuration-v1\0${canonical(jsonValue(value, 'snapshot.configuration'))}`);
}

export function analysisSnapshotIdentity({ repository, manifest, analyzer, configurationDigest: digest }) {
  const repositoryInput = record(repository, 'snapshot.repository');
  const normalized = {
    contractVersion: ANALYSIS_SCHEMA_VERSION,
    repository: {
      id: identifier(repositoryInput.id, 'snapshot.repository.id'),
      adapter: identifier(repositoryInput.adapter, 'snapshot.repository.adapter'),
    },
    manifestDigest: hash(manifest?.digest, 'snapshot.manifest.digest'),
    analyzer: {
      id: identifier(analyzer?.id, 'snapshot.analyzer.id'),
      version: text(analyzer?.version, 'snapshot.analyzer.version', { max: 128 }),
    },
    configurationDigest: hash(digest, 'snapshot.configurationDigest'),
  };
  return sha256(`handraise-analysis-snapshot-v1\0${canonical(normalized)}`);
}

export function validateAnalysisSnapshot(value, { freeze = true } = {}) {
  const input = record(value, 'snapshot');
  const schemaVersion = integer(input.schemaVersion, 'snapshot.schemaVersion', { min: 1, max: 1_000_000 });
  if (schemaVersion !== ANALYSIS_SCHEMA_VERSION) fail('snapshot.schemaVersion', `unsupported version ${schemaVersion}`, 'INCOMPATIBLE_SCHEMA');
  const repositoryInput = record(input.repository, 'snapshot.repository');
  const repository = {
    id: identifier(repositoryInput.id, 'snapshot.repository.id'),
    adapter: identifier(repositoryInput.adapter, 'snapshot.repository.adapter'),
  };
  const analyzer = validateAnalyzerDescriptor(input.analyzer);
  const manifest = createContentManifest(input.manifest);
  const configDigest = configurationDigest(input.configurationDigest || input.configuration);
  const evidence = unique(list(input.evidence, 'snapshot.evidence', normalizeEvidence), (item) => item.id, 'snapshot.evidence');
  const entities = unique(list(input.entities, 'snapshot.entities', normalizeEntity), (item) => item.id, 'snapshot.entities');
  const relations = unique(list(input.relations, 'snapshot.relations', normalizeRelation), (item) => item.id, 'snapshot.relations');
  const findings = unique(list(input.findings, 'snapshot.findings', normalizeFinding), (item) => item.id, 'snapshot.findings');
  const coverage = unique(list(input.coverage, 'snapshot.coverage', normalizeCoverage), (item) => item.id, 'snapshot.coverage');
  const diagnostics = list(input.diagnostics, 'snapshot.diagnostics', normalizeDiagnostic, { max: 100_000 });
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const entityIds = new Set(entities.map((item) => item.id));
  for (const entity of entities) references(entity.evidenceIds, evidenceIds, `entity '${entity.id}' evidenceIds`);
  for (const relation of relations) {
    if (!entityIds.has(relation.source)) fail(`relation '${relation.id}'.source`, `references unknown entity '${relation.source}'`);
    if (!entityIds.has(relation.target)) fail(`relation '${relation.id}'.target`, `references unknown entity '${relation.target}'`);
    references(relation.evidenceIds, evidenceIds, `relation '${relation.id}' evidenceIds`);
  }
  for (const finding of findings) {
    references(finding.evidenceIds, evidenceIds, `finding '${finding.id}' evidenceIds`);
    references(finding.entityIds, entityIds, `finding '${finding.id}' entityIds`);
    for (const alternative of finding.alternatives) references(alternative.evidenceIds, evidenceIds, `finding '${finding.id}' alternative evidenceIds`);
  }
  for (const item of coverage) references(item.evidenceIds, evidenceIds, `coverage '${item.id}' evidenceIds`);
  for (const diagnostic of diagnostics) if (diagnostic.evidenceIds) references(diagnostic.evidenceIds, evidenceIds, `diagnostic '${diagnostic.code}' evidenceIds`);
  const freshnessInput = record(input.freshness || {}, 'snapshot.freshness');
  const freshness = {
    state: oneOf(freshnessInput.state, FRESHNESS, 'snapshot.freshness.state', 'unknown'),
    checkedAt: isoDate(freshnessInput.checkedAt, 'snapshot.freshness.checkedAt', input.createdAt || new Date(0).toISOString()),
  };
  if (freshnessInput.reason !== undefined) freshness.reason = text(freshnessInput.reason, 'snapshot.freshness.reason', { max: 4_096 });
  const normalized = {
    schemaVersion,
    id: '',
    repository,
    createdAt: isoDate(input.createdAt, 'snapshot.createdAt'),
    analyzer,
    configurationDigest: configDigest,
    status: oneOf(input.status, SNAPSHOT_STATUS, 'snapshot.status', 'complete'),
    freshness,
    manifest,
    scope: normalizeScope(input.scope),
    coverage,
    entities,
    relations,
    evidence,
    findings,
    diagnostics,
  };
  normalized.id = analysisSnapshotIdentity(normalized);
  if (input.id !== undefined && hash(input.id, 'snapshot.id') !== normalized.id) {
    fail('snapshot.id', 'does not match repository content, analyzer and configuration', 'SNAPSHOT_IDENTITY_MISMATCH');
  }
  if (input.extensions !== undefined) normalized.extensions = jsonValue(input.extensions, 'snapshot.extensions');
  return freeze ? deepFreeze(normalized) : normalized;
}

export function createAnalysisSnapshot(value) {
  return validateAnalysisSnapshot({ ...value, schemaVersion: ANALYSIS_SCHEMA_VERSION });
}

export function serializeAnalysisSnapshot(value) {
  return `${JSON.stringify(validateAnalysisSnapshot(value), null, 2)}\n`;
}

export function parseAnalysisSnapshot(serialized) {
  let parsed;
  try { parsed = JSON.parse(text(serialized, 'serialized snapshot', { max: 512 * 1024 * 1024 })); }
  catch (error) {
    if (error instanceof IntelligenceError) throw error;
    throw new IntelligenceError('INVALID_JSON', 'serialized snapshot is not valid JSON', { cause: error });
  }
  return validateAnalysisSnapshot(parsed);
}

export function validateAnalyzerAdapter(value) {
  const input = record(value, 'adapter');
  const descriptor = validateAnalyzerDescriptor(input.descriptor);
  const required = ['detect', 'plan', 'analyze', 'query', 'dispose'];
  for (const method of required) if (typeof input[method] !== 'function') fail(`adapter.${method}`, 'must be a function');
  if (input.diff !== undefined && typeof input.diff !== 'function') fail('adapter.diff', 'must be a function when provided');
  if (descriptor.capabilities.incremental && typeof input.diff !== 'function') {
    fail('adapter.diff', 'is required when incremental capability is true');
  }
  return Object.freeze({
    descriptor,
    detect: input.detect.bind(input),
    plan: input.plan.bind(input),
    analyze: input.analyze.bind(input),
    query: input.query.bind(input),
    diff: input.diff?.bind(input),
    dispose: input.dispose.bind(input),
  });
}

export function validateAnalysisJob(value) {
  const input = record(value, 'job');
  const result = {
    id: identifier(input.id, 'job.id'),
    repositoryId: identifier(input.repositoryId, 'job.repositoryId'),
    analyzerId: identifier(input.analyzerId, 'job.analyzerId'),
    state: oneOf(input.state, JOB_STATES, 'job.state'),
    createdAt: isoDate(input.createdAt, 'job.createdAt'),
    updatedAt: isoDate(input.updatedAt, 'job.updatedAt'),
    progress: number(input.progress ?? 0, 'job.progress'),
  };
  if (new Date(result.updatedAt) < new Date(result.createdAt)) fail('job.updatedAt', 'precedes createdAt');
  if (input.snapshotId !== undefined) result.snapshotId = hash(input.snapshotId, 'job.snapshotId');
  if (input.stage !== undefined) result.stage = text(input.stage, 'job.stage', { max: 256 });
  if (input.message !== undefined) result.message = text(input.message, 'job.message', { max: 4_096 });
  if (input.error !== undefined) result.error = jsonValue(input.error, 'job.error');
  return deepFreeze(result);
}

export function validateAnalysisProgress(value) {
  const input = record(value, 'progress');
  const result = {
    jobId: identifier(input.jobId, 'progress.jobId'),
    state: oneOf(input.state, JOB_STATES, 'progress.state'),
    stage: text(input.stage, 'progress.stage', { max: 256 }),
    at: isoDate(input.at, 'progress.at'),
    completed: integer(input.completed, 'progress.completed', { fallback: 0 }),
  };
  if (input.total !== undefined) {
    result.total = integer(input.total, 'progress.total', { min: 1 });
    if (result.completed > result.total) fail('progress.completed', 'cannot exceed total');
  }
  if (input.message !== undefined) result.message = text(input.message, 'progress.message', { max: 4_096 });
  if (input.diagnostic !== undefined) result.diagnostic = normalizeDiagnostic(input.diagnostic, 'progress.diagnostic');
  return deepFreeze(result);
}

export function validateGraphQuery(value) {
  const input = record(value, 'query');
  const type = oneOf(input.type, QUERY_TYPES, 'query.type');
  const result = {
    type,
    snapshotId: hash(input.snapshotId, 'query.snapshotId'),
    limit: integer(input.limit, 'query.limit', { min: 1, max: GRAPH_QUERY_LIMITS.maxLimit, fallback: GRAPH_QUERY_LIMITS.defaultLimit }),
  };
  if (input.relationKinds !== undefined) result.relationKinds = stringList(input.relationKinds, 'query.relationKinds', { max: 1_000 });
  if (type === 'entity' || type === 'neighbors' || type === 'path') result.entityId = identifier(input.entityId, 'query.entityId');
  if (type === 'neighbors') {
    result.direction = oneOf(input.direction, DIRECTIONS, 'query.direction', 'both');
    result.depth = integer(input.depth, 'query.depth', { min: 1, max: GRAPH_QUERY_LIMITS.maxDepth, fallback: GRAPH_QUERY_LIMITS.defaultDepth });
  }
  if (type === 'path') {
    result.targetEntityId = identifier(input.targetEntityId, 'query.targetEntityId');
    result.direction = oneOf(input.direction, DIRECTIONS, 'query.direction', 'outgoing');
    result.depth = integer(input.depth, 'query.depth', { min: 1, max: GRAPH_QUERY_LIMITS.maxPathDepth, fallback: GRAPH_QUERY_LIMITS.maxDepth });
  }
  if (type === 'search') result.text = text(input.text, 'query.text', { max: GRAPH_QUERY_LIMITS.maxTextLength });
  if (type === 'evidence') result.evidenceIds = stringList(input.evidenceIds, 'query.evidenceIds', { max: GRAPH_QUERY_LIMITS.maxLimit });
  return deepFreeze(result);
}

export function validateGraphQueryResult(value) {
  const input = record(value, 'queryResult');
  const schemaVersion = integer(input.schemaVersion, 'queryResult.schemaVersion', { min: 1, max: 1_000_000 });
  if (schemaVersion !== ANALYSIS_SCHEMA_VERSION) fail('queryResult.schemaVersion', `unsupported version ${schemaVersion}`, 'INCOMPATIBLE_SCHEMA');
  const result = {
    schemaVersion,
    snapshotId: hash(input.snapshotId, 'queryResult.snapshotId'),
    query: validateGraphQuery(input.query),
    entities: unique(list(input.entities, 'queryResult.entities', normalizeEntity, { max: GRAPH_QUERY_LIMITS.maxLimit }), (item) => item.id, 'queryResult.entities'),
    relations: unique(list(input.relations, 'queryResult.relations', normalizeRelation, { max: GRAPH_QUERY_LIMITS.maxLimit * 4 }), (item) => item.id, 'queryResult.relations'),
    evidence: unique(list(input.evidence, 'queryResult.evidence', normalizeEvidence, { max: GRAPH_QUERY_LIMITS.maxLimit * 8 }), (item) => item.id, 'queryResult.evidence'),
    diagnostics: list(input.diagnostics, 'queryResult.diagnostics', normalizeDiagnostic, { max: 1_000 }),
    truncated: boolean(input.truncated, 'queryResult.truncated'),
  };
  if (result.query.snapshotId !== result.snapshotId) fail('queryResult.query.snapshotId', 'does not match queryResult.snapshotId');
  return deepFreeze(result);
}

export function validateAnalysisDiff(value) {
  const input = record(value, 'diff');
  const schemaVersion = integer(input.schemaVersion, 'diff.schemaVersion', { min: 1, max: 1_000_000 });
  if (schemaVersion !== ANALYSIS_SCHEMA_VERSION) fail('diff.schemaVersion', `unsupported version ${schemaVersion}`, 'INCOMPATIBLE_SCHEMA');
  const bucket = (name) => {
    const item = record(input[name] || {}, `diff.${name}`);
    return {
      added: stringList(item.added, `diff.${name}.added`, { max: 100_000 }),
      removed: stringList(item.removed, `diff.${name}.removed`, { max: 100_000 }),
      changed: stringList(item.changed, `diff.${name}.changed`, { max: 100_000 }),
    };
  };
  return deepFreeze({
    schemaVersion,
    fromSnapshotId: hash(input.fromSnapshotId, 'diff.fromSnapshotId'),
    toSnapshotId: hash(input.toSnapshotId, 'diff.toSnapshotId'),
    cause: oneOf(input.cause, new Set(['content', 'analyzer', 'configuration', 'mixed']), 'diff.cause', 'mixed'),
    entities: bucket('entities'),
    relations: bucket('relations'),
    evidence: bucket('evidence'),
    diagnostics: list(input.diagnostics, 'diff.diagnostics', normalizeDiagnostic, { max: 10_000 }),
  });
}

export function intelligenceFailure(error, fallbackCode = 'INTERNAL') {
  if (error instanceof IntelligenceError) return error;
  if (error?.name === 'AbortError') return new IntelligenceError('CANCELLED', 'analysis was cancelled', { cause: error });
  return new IntelligenceError(fallbackCode, String(error?.message || error || 'analysis failed'), { cause: error });
}
