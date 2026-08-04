import { createHash } from 'node:crypto';

export const PLANNING_SCHEMA_VERSION = 1;
export const PLANNING_OPERATIONS = Object.freeze(['component-design', 'front-design', 'portfolio-review']);
export const PLANNING_JOB_STATES = Object.freeze(['queued', 'running', 'cancelled', 'failed', 'complete']);
export const PLANNING_SOURCE_KINDS = Object.freeze(['graph-query', 'evidence', 'product', 'portfolio', 'human']);
export const PLANNING_UNCERTAINTY = Object.freeze(['low', 'medium', 'high', 'unknown']);

export const PLANNING_CONTEXT_LIMITS = Object.freeze({
  maxSources: 48,
  maxSourceBytes: 24 * 1024,
  maxTotalBytes: 192 * 1024,
  maxEvidenceIds: 512,
  maxGraphQueries: 8,
  maxQueryResults: 80,
});

const OPERATIONS = new Set(PLANNING_OPERATIONS);
const SOURCE_KINDS = new Set(PLANNING_SOURCE_KINDS);
const UNCERTAINTY = new Set(PLANNING_UNCERTAINTY);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class PlanningError extends Error {
  constructor(code, message, { details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PlanningError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.message, code: this.code, details: this.details };
  }
}

function fail(path, message, code = 'INVALID_PLANNING_CONTRACT', details = null) {
  throw new PlanningError(code, `${path}: ${message}`, { details: details || { path } });
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function text(value, path, { min = 1, max = 4_096, optional = false, nullable = false, trim = true } = {}) {
  if (value === null && nullable) return null;
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  if (typeof value !== 'string') fail(path, 'must be a string');
  const normalized = trim ? clean(value).trim() : clean(value);
  if (normalized.length < min) fail(path, `must contain at least ${min} character${min === 1 ? '' : 's'}`);
  if (normalized.length > max) fail(path, `must contain at most ${max} characters`);
  return normalized;
}

function identifier(value, path) {
  const normalized = text(value, path, { max: 256 });
  if (!IDENTIFIER.test(normalized)) fail(path, 'contains unsupported characters');
  return normalized;
}

function slug(value, path) {
  const normalized = text(value, path, { max: 96 });
  if (!SLUG.test(normalized)) fail(path, 'must be a lowercase kebab-case slug');
  return normalized;
}

function boolean(value, path, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `must be an integer between ${min} and ${max}`);
  return value;
}

function finiteNumber(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (!Number.isFinite(value) || value < min || value > max) fail(path, `must be a number between ${min} and ${max}`);
  return value;
}

function list(value, path, mapper, { fallback = [], max = 100 } = {}) {
  const candidate = value === undefined ? fallback : value;
  if (!Array.isArray(candidate)) fail(path, 'must be an array');
  if (candidate.length > max) fail(path, `must contain at most ${max} items`);
  return candidate.map((item, index) => mapper(item, `${path}[${index}]`));
}

function unique(values, path) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(path, `contains duplicate '${value}'`);
    seen.add(value);
    result.push(value);
  }
  return result;
}

function stringList(value, path, { fallback = [], max = 50, itemMax = 2_000 } = {}) {
  return unique(list(value, path, (item, itemPath) => text(item, itemPath, { max: itemMax }), { fallback, max }), path);
}

function identifierList(value, path, { fallback = [], max = 512 } = {}) {
  return unique(list(value, path, identifier, { fallback, max }), path);
}

function oneOf(value, values, path, fallback) {
  const candidate = value === undefined ? fallback : value;
  if (!values.has(candidate)) fail(path, `must be one of ${[...values].join(', ')}`);
  return candidate;
}

function isoDate(value, path) {
  const normalized = text(value, path, { max: 64 });
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) fail(path, 'must be an ISO-8601 UTC timestamp');
  return normalized;
}

function digest(value, path) {
  const normalized = text(value, path, { max: 64 });
  if (!SHA256.test(normalized)) fail(path, 'must be a lowercase SHA-256 digest');
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function planningDigest(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
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

function normalizeModel(value, path) {
  const input = record(value, path);
  return {
    id: identifier(input.id, `${path}.id`),
    label: text(input.label, `${path}.label`, { max: 256 }),
    default: boolean(input.default, `${path}.default`),
  };
}

export function validatePlanningAdapterDescriptor(value) {
  const input = record(value, 'adapter');
  const contractVersion = integer(input.contractVersion, 'adapter.contractVersion', { min: 1, max: 1_000, fallback: PLANNING_SCHEMA_VERSION });
  if (contractVersion !== PLANNING_SCHEMA_VERSION) fail('adapter.contractVersion', `unsupported version ${contractVersion}`, 'INCOMPATIBLE_SCHEMA');
  const providerInput = record(input.provider, 'adapter.provider');
  const authInput = record(input.authentication, 'adapter.authentication');
  const capabilitiesInput = record(input.capabilities, 'adapter.capabilities');
  const boundaryInput = record(input.dataBoundary, 'adapter.dataBoundary');
  const degradationInput = record(input.degradation || {}, 'adapter.degradation');
  const operations = unique(list(capabilitiesInput.operations, 'adapter.capabilities.operations', (item, path) => oneOf(item, OPERATIONS, path), { max: PLANNING_OPERATIONS.length }), 'adapter.capabilities.operations');
  const models = list(input.models, 'adapter.models', normalizeModel, { max: 50 });
  if (!models.length) fail('adapter.models', 'must declare at least one model selector');
  if (models.filter((model) => model.default).length !== 1) fail('adapter.models', 'must declare exactly one default model');
  const result = {
    id: identifier(input.id, 'adapter.id'),
    name: text(input.name, 'adapter.name', { max: 256 }),
    version: text(input.version, 'adapter.version', { max: 128 }),
    contractVersion,
    provider: {
      id: identifier(providerInput.id, 'adapter.provider.id'),
      name: text(providerInput.name, 'adapter.provider.name', { max: 256 }),
    },
    authentication: {
      owner: oneOf(authInput.owner, new Set(['first-party-cli', 'explicit-provider']), 'adapter.authentication.owner'),
      method: text(authInput.method, 'adapter.authentication.method', { max: 256 }),
      credentialsStoredByHandraise: boolean(authInput.credentialsStoredByHandraise, 'adapter.authentication.credentialsStoredByHandraise'),
    },
    capabilities: {
      operations,
      structuredOutput: boolean(capabilitiesInput.structuredOutput, 'adapter.capabilities.structuredOutput'),
      toolFreeInvocation: boolean(capabilitiesInput.toolFreeInvocation, 'adapter.capabilities.toolFreeInvocation'),
      cancellation: boolean(capabilitiesInput.cancellation, 'adapter.capabilities.cancellation'),
      usage: stringList(capabilitiesInput.usage, 'adapter.capabilities.usage', { max: 20, itemMax: 128 }),
      cost: boolean(capabilitiesInput.cost, 'adapter.capabilities.cost'),
      boundedContext: boolean(capabilitiesInput.boundedContext, 'adapter.capabilities.boundedContext'),
    },
    dataBoundary: {
      kind: oneOf(boundaryInput.kind, new Set(['local', 'cloud']), 'adapter.dataBoundary.kind'),
      destination: text(boundaryInput.destination, 'adapter.dataBoundary.destination', { max: 512 }),
      sourceMayLeaveHost: boolean(boundaryInput.sourceMayLeaveHost, 'adapter.dataBoundary.sourceMayLeaveHost'),
      requiresConsent: boolean(boundaryInput.requiresConsent, 'adapter.dataBoundary.requiresConsent'),
    },
    models,
    degradation: {
      fallback: oneOf(degradationInput.fallback, new Set(['deterministic-manual']), 'adapter.degradation.fallback', 'deterministic-manual'),
      summary: text(degradationInput.summary, 'adapter.degradation.summary', { max: 1_000 }),
    },
  };
  if (result.authentication.credentialsStoredByHandraise) fail('adapter.authentication.credentialsStoredByHandraise', 'must be false');
  if (result.dataBoundary.sourceMayLeaveHost && !result.dataBoundary.requiresConsent) fail('adapter.dataBoundary.requiresConsent', 'must be true when source may leave the host');
  if (result.dataBoundary.kind === 'local' && result.dataBoundary.sourceMayLeaveHost) fail('adapter.dataBoundary', 'local adapters cannot send source off-host');
  if (!result.capabilities.structuredOutput || !result.capabilities.boundedContext) fail('adapter.capabilities', 'planning adapters must support structured output and bounded context');
  return deepFreeze(result);
}

export function validatePlanningAdapter(value) {
  const input = record(value, 'adapterImplementation');
  const descriptor = validatePlanningAdapterDescriptor(input.descriptor);
  if (typeof input.detect !== 'function') fail('adapterImplementation.detect', 'must be a function');
  if (typeof input.run !== 'function') fail('adapterImplementation.run', 'must be a function');
  return { descriptor, detect: input.detect.bind(input), run: input.run.bind(input), dispose: typeof input.dispose === 'function' ? input.dispose.bind(input) : async () => {} };
}

function normalizeSource(value, path) {
  const input = record(value, path);
  const content = text(input.content, `${path}.content`, { max: PLANNING_CONTEXT_LIMITS.maxSourceBytes, trim: false });
  const bytes = Buffer.byteLength(content);
  if (bytes > PLANNING_CONTEXT_LIMITS.maxSourceBytes) fail(`${path}.content`, `must contain at most ${PLANNING_CONTEXT_LIMITS.maxSourceBytes} UTF-8 bytes`);
  const computedDigest = planningDigest(content);
  if (input.digest !== undefined && digest(input.digest, `${path}.digest`) !== computedDigest) fail(`${path}.digest`, 'does not match the source content', 'CONTEXT_DIGEST_MISMATCH');
  return {
    id: identifier(input.id, `${path}.id`),
    kind: oneOf(input.kind, SOURCE_KINDS, `${path}.kind`),
    title: text(input.title, `${path}.title`, { max: 512 }),
    content,
    bytes,
    digest: computedDigest,
    provenance: oneOf(input.provenance, new Set(['extracted', 'inferred', 'declared', 'human', 'mixed']), `${path}.provenance`, 'mixed'),
    evidenceIds: identifierList(input.evidenceIds, `${path}.evidenceIds`, { max: PLANNING_CONTEXT_LIMITS.maxEvidenceIds }),
  };
}

export function createPlanningContext(value) {
  const input = record(value, 'context');
  const repositoryInput = record(input.repository, 'context.repository');
  const sources = list(input.sources, 'context.sources', normalizeSource, { max: PLANNING_CONTEXT_LIMITS.maxSources });
  const sourceIds = sources.map((source) => source.id);
  unique(sourceIds, 'context.sources');
  const bytes = sources.reduce((sum, source) => sum + source.bytes, 0);
  if (bytes > PLANNING_CONTEXT_LIMITS.maxTotalBytes) fail('context.sources', `exceed the ${PLANNING_CONTEXT_LIMITS.maxTotalBytes}-byte context budget`, 'CONTEXT_LIMIT_EXCEEDED');
  const evidenceIds = [...new Set(sources.flatMap((source) => source.evidenceIds))].sort();
  if (evidenceIds.length > PLANNING_CONTEXT_LIMITS.maxEvidenceIds) fail('context.sources.evidenceIds', `must contain at most ${PLANNING_CONTEXT_LIMITS.maxEvidenceIds} identifiers`, 'CONTEXT_LIMIT_EXCEEDED');
  const snapshotInput = input.snapshot === null || input.snapshot === undefined ? null : record(input.snapshot, 'context.snapshot');
  const productInput = input.product === null || input.product === undefined ? null : record(input.product, 'context.product');
  const body = {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    repository: {
      id: identifier(repositoryInput.id, 'context.repository.id'),
      adapter: identifier(repositoryInput.adapter, 'context.repository.adapter'),
    },
    operation: oneOf(input.operation, OPERATIONS, 'context.operation'),
    snapshot: snapshotInput ? {
      id: digest(snapshotInput.id, 'context.snapshot.id'),
      status: text(snapshotInput.status, 'context.snapshot.status', { max: 64 }),
      freshness: text(snapshotInput.freshness, 'context.snapshot.freshness', { max: 64 }),
    } : null,
    product: productInput ? {
      revision: digest(productInput.revision, 'context.product.revision'),
      title: text(productInput.title, 'context.product.title', { max: 512 }),
    } : null,
    sources,
    diagnostics: list(input.diagnostics, 'context.diagnostics', (item, path) => {
      const diagnostic = record(item, path);
      return { code: identifier(diagnostic.code, `${path}.code`), message: text(diagnostic.message, `${path}.message`, { max: 2_000 }) };
    }, { max: 50 }),
    evidenceIds,
    counts: { sources: sources.length, bytes, evidenceIds: evidenceIds.length },
  };
  const computedDigest = planningDigest(`handraise-planning-context-v1\0${canonical(body)}`);
  if (input.digest !== undefined && digest(input.digest, 'context.digest') !== computedDigest) fail('context.digest', 'does not match normalized context', 'CONTEXT_DIGEST_MISMATCH');
  return deepFreeze({ ...body, digest: computedDigest });
}

function outputTextList(value, path, max = 30) {
  return stringList(value, path, { max, itemMax: 2_000 });
}

function grounding(input, path, knownEvidence) {
  const evidenceIds = identifierList(input.evidenceIds, `${path}.evidenceIds`, { max: 100 });
  for (const id of evidenceIds) if (!knownEvidence.has(id)) fail(`${path}.evidenceIds`, `references unknown evidence '${id}'`, 'FABRICATED_EVIDENCE', { path: `${path}.evidenceIds`, evidenceId: id });
  const uncertainty = oneOf(input.uncertainty, UNCERTAINTY, `${path}.uncertainty`, 'unknown');
  const assumptions = outputTextList(input.assumptions, `${path}.assumptions`, 30);
  const questions = outputTextList(input.questions, `${path}.questions`, 30);
  if (!evidenceIds.length && !assumptions.length && !questions.length) {
    fail(path, 'must cite evidence or explicitly state an assumption/question', 'UNGROUNDED_CLAIM', { path });
  }
  return { evidenceIds, uncertainty, assumptions, questions };
}

function normalizeComponentProposal(value, path, knownEvidence) {
  const input = record(value, path);
  return {
    slug: slug(input.slug, `${path}.slug`),
    title: text(input.title, `${path}.title`, { max: 256 }),
    responsibility: text(input.responsibility, `${path}.responsibility`, { max: 4_096 }),
    outcomes: outputTextList(input.outcomes, `${path}.outcomes`),
    responsibilities: outputTextList(input.responsibilities, `${path}.responsibilities`),
    limits: outputTextList(input.limits, `${path}.limits`),
    invariants: outputTextList(input.invariants, `${path}.invariants`),
    interfaces: outputTextList(input.interfaces, `${path}.interfaces`),
    dependencies: outputTextList(input.dependencies, `${path}.dependencies`),
    dataSystems: outputTextList(input.dataSystems, `${path}.dataSystems`),
    territory: outputTextList(input.territory, `${path}.territory`),
    verification: outputTextList(input.verification, `${path}.verification`),
    ...grounding(input, path, knownEvidence),
  };
}

function normalizeFrontProposal(value, path, knownEvidence) {
  const input = record(value, path);
  return {
    slug: slug(input.slug, `${path}.slug`),
    title: text(input.title, `${path}.title`, { max: 256 }),
    componentSlug: slug(input.componentSlug, `${path}.componentSlug`),
    objective: text(input.objective, `${path}.objective`, { max: 4_096 }),
    motivation: text(input.motivation, `${path}.motivation`, { max: 4_096 }),
    scope: text(input.scope, `${path}.scope`, { max: 8_000 }),
    nonGoals: outputTextList(input.nonGoals, `${path}.nonGoals`),
    readiness: outputTextList(input.readiness, `${path}.readiness`),
    acceptanceCriteria: outputTextList(input.acceptanceCriteria, `${path}.acceptanceCriteria`, 50),
    verification: outputTextList(input.verification, `${path}.verification`, 50),
    deliverables: outputTextList(input.deliverables, `${path}.deliverables`, 50),
    risks: outputTextList(input.risks, `${path}.risks`, 50),
    dependencies: outputTextList(input.dependencies, `${path}.dependencies`, 50),
    affectedComponents: outputTextList(input.affectedComponents, `${path}.affectedComponents`, 50),
    goalIds: identifierList(input.goalIds, `${path}.goalIds`, { max: 50 }),
    ...grounding(input, path, knownEvidence),
  };
}

function normalizeFinding(value, path, knownEvidence) {
  const input = record(value, path);
  return {
    id: identifier(input.id, `${path}.id`),
    title: text(input.title, `${path}.title`, { max: 256 }),
    kind: oneOf(input.kind, new Set(['gap', 'overlap', 'dependency', 'risk', 'opportunity', 'question']), `${path}.kind`),
    description: text(input.description, `${path}.description`, { max: 4_096 }),
    recommendation: text(input.recommendation, `${path}.recommendation`, { max: 4_096 }),
    ...grounding(input, path, knownEvidence),
  };
}

export function validatePlanningResult(value, { operation, evidenceIds = [] } = {}) {
  const input = record(value, 'result');
  const schemaVersion = integer(input.schemaVersion, 'result.schemaVersion', { min: 1, max: 1_000 });
  if (schemaVersion !== PLANNING_SCHEMA_VERSION) fail('result.schemaVersion', `unsupported version ${schemaVersion}`, 'INCOMPATIBLE_SCHEMA');
  const normalizedOperation = oneOf(input.operation, OPERATIONS, 'result.operation');
  if (operation && normalizedOperation !== operation) fail('result.operation', `must match requested operation '${operation}'`, 'OPERATION_MISMATCH');
  const knownEvidence = new Set(identifierList(evidenceIds, 'knownEvidenceIds', { max: PLANNING_CONTEXT_LIMITS.maxEvidenceIds }));
  const components = list(input.components, 'result.components', (item, path) => normalizeComponentProposal(item, path, knownEvidence), { max: 40 });
  const fronts = list(input.fronts, 'result.fronts', (item, path) => normalizeFrontProposal(item, path, knownEvidence), { max: 80 });
  const findings = list(input.findings, 'result.findings', (item, path) => normalizeFinding(item, path, knownEvidence), { max: 80 });
  unique(components.map((item) => item.slug), 'result.components');
  unique(fronts.map((item) => item.slug), 'result.fronts');
  unique(findings.map((item) => item.id), 'result.findings');
  if (normalizedOperation === 'component-design' && !components.length) fail('result.components', 'must contain at least one component proposal for component-design');
  if (normalizedOperation === 'front-design' && !fronts.length) fail('result.fronts', 'must contain at least one front proposal for front-design');
  if (normalizedOperation === 'portfolio-review' && !findings.length) fail('result.findings', 'must contain at least one finding for portfolio-review');
  return deepFreeze({
    schemaVersion,
    operation: normalizedOperation,
    summary: text(input.summary, 'result.summary', { max: 8_000 }),
    components,
    fronts,
    findings,
    assumptions: outputTextList(input.assumptions, 'result.assumptions', 80),
    questions: outputTextList(input.questions, 'result.questions', 80),
  });
}

const stringArraySchema = (maxItems = 50) => ({ type: 'array', maxItems, items: { type: 'string', minLength: 1, maxLength: 2_000 } });
const groundedProperties = (evidenceIds) => ({
  evidenceIds: { type: 'array', maxItems: 100, items: evidenceIds.length ? { type: 'string', enum: evidenceIds } : { type: 'string', enum: [] } },
  uncertainty: { type: 'string', enum: PLANNING_UNCERTAINTY },
  assumptions: stringArraySchema(30),
  questions: stringArraySchema(30),
});

export function planningResultJsonSchema({ operation, evidenceIds = [] } = {}) {
  const normalizedOperation = oneOf(operation, OPERATIONS, 'schema.operation');
  const knownEvidence = unique(identifierList(evidenceIds, 'schema.evidenceIds', { max: PLANNING_CONTEXT_LIMITS.maxEvidenceIds }), 'schema.evidenceIds').sort();
  const componentProperties = {
    slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 96 }, title: { type: 'string', minLength: 1, maxLength: 256 },
    responsibility: { type: 'string', minLength: 1, maxLength: 4_096 }, outcomes: stringArraySchema(), responsibilities: stringArraySchema(), limits: stringArraySchema(), invariants: stringArraySchema(), interfaces: stringArraySchema(), dependencies: stringArraySchema(), dataSystems: stringArraySchema(), territory: stringArraySchema(), verification: stringArraySchema(50),
    ...groundedProperties(knownEvidence),
  };
  const frontProperties = {
    slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 96 }, title: { type: 'string', minLength: 1, maxLength: 256 }, componentSlug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 96 },
    objective: { type: 'string', minLength: 1, maxLength: 4_096 }, motivation: { type: 'string', minLength: 1, maxLength: 4_096 }, scope: { type: 'string', minLength: 1, maxLength: 8_000 }, nonGoals: stringArraySchema(), readiness: stringArraySchema(), acceptanceCriteria: stringArraySchema(50), verification: stringArraySchema(50), deliverables: stringArraySchema(50), risks: stringArraySchema(50), dependencies: stringArraySchema(50), affectedComponents: stringArraySchema(50), goalIds: stringArraySchema(50),
    ...groundedProperties(knownEvidence),
  };
  const findingProperties = {
    id: { type: 'string', minLength: 1, maxLength: 256 }, title: { type: 'string', minLength: 1, maxLength: 256 }, kind: { type: 'string', enum: ['gap', 'overlap', 'dependency', 'risk', 'opportunity', 'question'] }, description: { type: 'string', minLength: 1, maxLength: 4_096 }, recommendation: { type: 'string', minLength: 1, maxLength: 4_096 },
    ...groundedProperties(knownEvidence),
  };
  return deepFreeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', additionalProperties: false,
    properties: {
      schemaVersion: { type: 'integer', const: PLANNING_SCHEMA_VERSION },
      operation: { type: 'string', const: normalizedOperation },
      summary: { type: 'string', minLength: 1, maxLength: 8_000 },
      components: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, properties: componentProperties, required: Object.keys(componentProperties) } },
      fronts: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false, properties: frontProperties, required: Object.keys(frontProperties) } },
      findings: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false, properties: findingProperties, required: Object.keys(findingProperties) } },
      assumptions: stringArraySchema(80),
      questions: stringArraySchema(80),
    },
    required: ['schemaVersion', 'operation', 'summary', 'components', 'fronts', 'findings', 'assumptions', 'questions'],
  });
}

export function planningFailure(error, fallbackCode = 'PLANNING_FAILED') {
  if (error instanceof PlanningError) return { code: error.code, message: error.message, details: error.details };
  if (error?.name === 'AbortError') return { code: 'CANCELLED', message: 'Planning was cancelled.', details: null };
  return { code: fallbackCode, message: clean(error?.message || error || 'Planning failed.').slice(0, 4_096), details: null };
}
