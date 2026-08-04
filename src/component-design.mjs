import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { validateAnalysisSnapshot } from './intelligence/contracts.mjs';
import { summarizeSystemMap } from './intelligence/system-map.mjs';
import { validatePlanningResult } from './planning/contracts.mjs';
import { normalizeProductBrief } from './product-direction.mjs';
import {
  COMPONENT_DEPENDENCY_KINDS,
  EVIDENCE_PROVENANCE,
  INTERFACE_KINDS,
  createComponentMarkdown,
  parseComponentContract,
  validatePortfolioContracts,
} from './work-contracts.mjs';

export const COMPONENT_DESIGN_SCHEMA_VERSION = 1;
export const COMPONENT_DESIGN_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const COMPONENT_DESIGN_STATES = Object.freeze(['review', 'skipped']);
export const ARCHITECTURE_STRATEGIES = Object.freeze(['responsibility', 'hybrid', 'existing', 'model', 'manual']);
export const COMPONENT_DESIGN_FIELDS = Object.freeze([
  'purpose', 'outcomes', 'responsibilities', 'limits', 'invariants', 'interfaces', 'dependencies',
  'dataSystems', 'territory', 'verification', 'evidence', 'uncertainties', 'guidance',
]);

const DRAFT_ID = /^[a-f0-9-]{36}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const STATES = new Set(COMPONENT_DESIGN_STATES);
const STRATEGIES = new Set(ARCHITECTURE_STRATEGIES);
const INTERFACE_KIND = new Set(INTERFACE_KINDS);
const DEPENDENCY_KIND = new Set(COMPONENT_DEPENDENCY_KINDS);
const PROVENANCE = new Set(EVIDENCE_PROVENANCE);
const FIELDS = new Set(COMPONENT_DESIGN_FIELDS);
const CORE_LIST_FIELDS = new Set(['outcomes', 'responsibilities', 'limits', 'invariants', 'territory', 'verification', 'evidence']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clean(value, limit = 4_096) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function inline(value, limit = 256) {
  return clean(value, limit).replace(/\s+/g, ' ');
}

function list(value, limit = 100, itemLimit = 2_000) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function uniqueBy(items, selector) {
  const seen = new Set();
  return items.filter((item) => {
    const key = selector(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new ComponentDesignError('INVALID_COMPONENT_DESIGN', `${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function slugify(value, fallback = 'component') {
  const normalized = inline(value, 256).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  const candidate = normalized || fallback;
  return candidate.length > 1 && candidate.endsWith('-') ? candidate.slice(0, -1) : candidate;
}

function stableId(prefix, ...parts) {
  return `${prefix}:${sha256(parts.join('\0')).slice(0, 24)}`;
}

function iso(value, label) {
  const candidate = clean(value, 64);
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== candidate) {
    throw new ComponentDesignError('INVALID_COMPONENT_DESIGN', `${label} must be an ISO-8601 UTC timestamp`);
  }
  return candidate;
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function atomicPrivateJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export class ComponentDesignError extends Error {
  constructor(code, message, { details = null, diagnostics = [], cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ComponentDesignError';
    this.code = code;
    this.details = details;
    this.diagnostics = diagnostics;
  }

  toJSON() {
    return { error: this.message, code: this.code, details: this.details, diagnostics: this.diagnostics };
  }
}

function fail(code, message, details = null) {
  throw new ComponentDesignError(code, message, { details });
}

function productIntentCatalog(product) {
  const brief = product?.brief || product;
  if (!brief) return { brief: null, ids: new Set(), revision: null };
  const normalized = normalizeProductBrief(brief);
  const ids = new Set(['purpose']);
  for (const key of ['users', 'outcomes', 'constraints', 'invariants', 'nonGoals', 'glossary', 'goals', 'repositoryRoles', 'assumptions', 'decisions', 'conflicts']) {
    for (const item of normalized[key] || []) if (item.id) ids.add(item.id);
  }
  return { brief: normalized, ids, revision: product?.revision || sha256(canonical(normalized)) };
}

function portfolioRevision(portfolio) {
  return sha256(canonical({
    components: (portfolio?.components || []).map((component) => ({
      slug: component.slug,
      schemaVersion: component.schemaVersion,
      state: component.state,
      order: component.order,
      contract: component.contract,
    })),
    fronts: (portfolio?.fronts || []).map((front) => ({ slug: front.slug, state: front.state, component: front.component })),
  }));
}

function referenceCatalog(context) {
  const evidenceIds = new Set(context.map.evidence.map((item) => item.id));
  evidenceIds.add(context.map.id);
  evidenceIds.add(context.snapshot.id);
  for (const group of context.map.groups) evidenceIds.add(group.id);
  for (const id of context.modelEvidenceIds || []) evidenceIds.add(id);
  return evidenceIds;
}

function contextIdentity(context) {
  const product = productIntentCatalog(context.product);
  return sha256(`handraise-component-design-context-v1\0${canonical({
    repository: context.snapshot.repository,
    snapshotId: context.snapshot.id,
    mapId: context.map.id,
    productRevision: product.revision,
    portfolioRevision: portfolioRevision(context.portfolio),
    planningJobId: context.planningJobId || null,
    planningResult: context.planningResult ? sha256(canonical(context.planningResult)) : null,
  })}`);
}

export function normalizeComponentDesignContext(value) {
  if (!value || typeof value !== 'object') fail('INVALID_COMPONENT_DESIGN_CONTEXT', 'component design context must be an object');
  const snapshot = validateAnalysisSnapshot(value.snapshot);
  const mapSummary = summarizeSystemMap(value.map);
  if (mapSummary.snapshotId !== snapshot.id) fail('MAP_SNAPSHOT_MISMATCH', 'system map and analysis snapshot identities do not match');
  if (mapSummary.repository.id !== snapshot.repository.id || mapSummary.repository.adapter !== snapshot.repository.adapter) {
    fail('MAP_REPOSITORY_MISMATCH', 'system map and analysis snapshot repository identities do not match');
  }
  const planningResult = value.planningResult
    ? validatePlanningResult(value.planningResult, {
        operation: 'component-design',
        evidenceIds: value.modelEvidenceIds || value.planningResult.components?.flatMap((component) => component.evidenceIds || []) || [],
      })
    : null;
  const context = {
    repository: { id: snapshot.repository.id, adapter: snapshot.repository.adapter },
    analysisJobId: inline(value.analysisJobId, 256),
    planningJobId: inline(value.planningJobId, 256) || null,
    snapshot,
    map: value.map,
    product: value.product || null,
    portfolio: value.portfolio || { components: [], fronts: [] },
    planningResult,
    modelEvidenceIds: list(value.modelEvidenceIds, 5_000, 512),
  };
  if (!context.analysisJobId) fail('INVALID_COMPONENT_DESIGN_CONTEXT', 'analysisJobId is required');
  context.identity = contextIdentity(context);
  return context;
}

function normalizeGrounding(value, { references, intentIds, label }) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const evidenceIds = list(input.evidenceIds, 100, 512);
  const selectedIntentIds = list(input.intentIds, 100, 512);
  for (const id of evidenceIds) if (!references.has(id)) fail('UNKNOWN_COMPONENT_EVIDENCE', `${label} references unknown evidence '${id}'`, { id, label });
  for (const id of selectedIntentIds) if (!intentIds.has(id)) fail('UNKNOWN_COMPONENT_INTENT', `${label} references unknown product intent '${id}'`, { id, label });
  const assumptions = list(input.assumptions, 50, 2_000);
  const questions = list(input.questions, 50, 2_000);
  if (!evidenceIds.length && !selectedIntentIds.length && !assumptions.length && !questions.length) {
    fail('UNGROUNDED_COMPONENT_FIELD', `${label} must cite evidence/intent or expose an assumption/question`);
  }
  return { evidenceIds, intentIds: selectedIntentIds, assumptions, questions };
}

function normalizeInterface(value, label) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = inline(input.kind, 64).toLocaleLowerCase();
  if (!INTERFACE_KIND.has(kind)) fail('INVALID_COMPONENT_INTERFACE', `${label}.kind must be provides or consumes`);
  const target = inline(input.target, 256);
  const description = clean(input.description, 1_000);
  if (!target || !description) fail('INVALID_COMPONENT_INTERFACE', `${label} needs target and description`);
  return { kind, target, description };
}

function normalizeDependency(value, label) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = inline(input.kind, 64).toLocaleLowerCase();
  if (!DEPENDENCY_KIND.has(kind)) fail('INVALID_COMPONENT_DEPENDENCY', `${label}.kind must be hard, soft or external`);
  const target = inline(input.target, 256);
  const reason = clean(input.reason, 1_000);
  if (!target || !reason) fail('INVALID_COMPONENT_DEPENDENCY', `${label} needs target and reason`);
  return { kind, target, reason };
}

function normalizeEvidence(value, label, references) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = inline(input.kind, 64).toLocaleLowerCase();
  if (!PROVENANCE.has(kind)) fail('INVALID_COMPONENT_EVIDENCE', `${label}.kind must be extracted, inferred or declared`);
  const reference = inline(input.reference, 512);
  const reason = clean(input.reason, 1_000);
  if (!reference || !references.has(reference)) fail('UNKNOWN_COMPONENT_EVIDENCE', `${label} references unknown evidence '${reference}'`);
  if (!reason) fail('INVALID_COMPONENT_EVIDENCE', `${label} needs a reason`);
  return { kind, reference, reason };
}

function normalizeCandidate(value, catalogs, label = 'component') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_COMPONENT_CANDIDATE', `${label} must be an object`);
  const id = inline(value.id, 256) || stableId('component-candidate', value.slug || value.title || randomUUID());
  const slug = slugify(value.slug || value.title);
  if (!SLUG.test(slug)) fail('INVALID_COMPONENT_CANDIDATE', `${label}.slug '${slug}' must be lowercase kebab-case`);
  const title = inline(value.title, 160);
  if (!title) fail('INVALID_COMPONENT_CANDIDATE', `${label}.title is required`);
  const contractInput = value.contract && typeof value.contract === 'object' ? value.contract : value;
  const contract = {
    purpose: clean(contractInput.purpose, 8_000),
    outcomes: list(contractInput.outcomes, 50),
    responsibilities: list(contractInput.responsibilities, 100),
    limits: list(contractInput.limits, 100),
    invariants: list(contractInput.invariants, 100),
    interfaces: (Array.isArray(contractInput.interfaces) ? contractInput.interfaces : []).slice(0, 100).map((item, index) => normalizeInterface(item, `${label}.contract.interfaces[${index}]`)),
    dependencies: (Array.isArray(contractInput.dependencies) ? contractInput.dependencies : []).slice(0, 100).map((item, index) => normalizeDependency(item, `${label}.contract.dependencies[${index}]`)),
    dataSystems: list(contractInput.dataSystems, 100),
    territory: list(contractInput.territory, 200, 4_096),
    verification: list(contractInput.verification, 100),
    evidence: (Array.isArray(contractInput.evidence) ? contractInput.evidence : []).slice(0, 200).map((item, index) => normalizeEvidence(item, `${label}.contract.evidence[${index}]`, catalogs.references)),
    uncertainties: list(contractInput.uncertainties, 100),
    guidance: clean(contractInput.guidance, 8_000),
  };
  if (!contract.purpose) fail('INCOMPLETE_COMPONENT_CANDIDATE', `${label}.contract.purpose is required`);
  for (const field of CORE_LIST_FIELDS) if (!contract[field].length) {
    fail('INCOMPLETE_COMPONENT_CANDIDATE', `${label}.contract.${field} needs at least one explicit item`);
  }
  if (!contract.guidance) fail('INCOMPLETE_COMPONENT_CANDIDATE', `${label}.contract.guidance is required`);
  const memberEntityIds = list(value.memberEntityIds, 2_000, 512);
  for (const entityId of memberEntityIds) if (!catalogs.entityIds.has(entityId)) {
    fail('UNKNOWN_COMPONENT_ENTITY', `${label}.memberEntityIds references unknown entity '${entityId}'`);
  }
  const fieldInput = value.fieldGrounding && typeof value.fieldGrounding === 'object' ? value.fieldGrounding : {};
  const fieldGrounding = {};
  for (const field of COMPONENT_DESIGN_FIELDS) {
    fieldGrounding[field] = normalizeGrounding(fieldInput[field], {
      references: catalogs.references,
      intentIds: catalogs.intentIds,
      label: `${label}.fieldGrounding.${field}`,
    });
  }
  const lockedFields = list(value.lockedFields, COMPONENT_DESIGN_FIELDS.length, 64);
  for (const field of lockedFields) if (!FIELDS.has(field)) fail('INVALID_COMPONENT_LOCK', `${label}.lockedFields contains unknown field '${field}'`);
  const result = {
    id,
    slug,
    title,
    state: 'active',
    order: boundedInteger(value.order, 99, 1, 10_000, `${label}.order`),
    origin: ['generated', 'accepted', 'model', 'manual'].includes(value.origin) ? value.origin : 'generated',
    memberEntityIds,
    contract,
    fieldGrounding,
    lockedFields,
  };
  // The renderer/parser is the compatibility boundary for eventual publication.
  const roundTrip = parseComponentContract(createComponentMarkdown(result, { since: '1970-01-01' }));
  if (roundTrip.slug !== result.slug || roundTrip.schemaVersion !== 2) fail('COMPONENT_CONTRACT_ROUNDTRIP', `${label} cannot serialize as a component v2 contract`);
  return result;
}

function cycleDiagnostics(components) {
  const known = new Set(components.map((component) => component.slug));
  const edges = new Map(components.map((component) => [component.slug, component.contract.dependencies
    .filter((dependency) => dependency.kind !== 'external' && known.has(dependency.target))
    .map((dependency) => dependency.target)]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];
  const visit = (slug) => {
    if (visiting.has(slug)) {
      const start = stack.indexOf(slug);
      cycles.push([...stack.slice(start), slug]);
      return;
    }
    if (visited.has(slug)) return;
    visiting.add(slug); stack.push(slug);
    for (const target of edges.get(slug) || []) visit(target);
    stack.pop(); visiting.delete(slug); visited.add(slug);
  };
  for (const slug of known) visit(slug);
  return uniqueBy(cycles, (cycle) => [...new Set(cycle)].sort().join('|'));
}

export function evaluateArchitectureAlternative(componentsValue, mapValue) {
  const components = componentsValue;
  const map = mapValue;
  const assignments = new Map();
  for (const component of components) for (const entityId of component.memberEntityIds) {
    if (!assignments.has(entityId)) assignments.set(entityId, []);
    assignments.get(entityId).push(component.slug);
  }
  const observedIds = new Set(map.entities.map((entity) => entity.id));
  const covered = [...assignments.keys()].filter((id) => observedIds.has(id));
  const overlaps = [...assignments.entries()].filter(([, owners]) => owners.length > 1);
  const orphanEntityIds = map.entities.map((entity) => entity.id).filter((id) => !assignments.has(id));
  let internalRelations = 0;
  let crossingRelations = 0;
  for (const relation of map.relations) {
    const source = new Set(assignments.get(relation.source) || []);
    const target = assignments.get(relation.target) || [];
    if (target.some((slug) => source.has(slug))) internalRelations += 1;
    else crossingRelations += 1;
  }
  const duplicateResponsibilities = [];
  const responsibilityOwners = new Map();
  for (const component of components) for (const responsibility of component.contract.responsibilities) {
    const key = responsibility.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    if (!responsibilityOwners.has(key)) responsibilityOwners.set(key, []);
    responsibilityOwners.get(key).push(component.slug);
  }
  for (const [responsibility, owners] of responsibilityOwners) if (owners.length > 1) duplicateResponsibilities.push({ responsibility, owners });
  const cycles = cycleDiagnostics(components);
  const unstable = components.filter((component) => (
    component.fieldGrounding.purpose.assumptions.length > 0
    || component.fieldGrounding.responsibilities.assumptions.length > 0
    || component.contract.uncertainties.some((item) => /partial|stale|path|unknown|question/i.test(item))
  )).map((component) => component.slug);
  const contractValidation = validatePortfolioContracts(components.map((component) => ({
    schemaVersion: 2, slug: component.slug, title: component.title, state: component.state, order: component.order, contract: component.contract,
  })), []);
  const coverage = observedIds.size ? covered.length / observedIds.size : 1;
  const relationTotal = internalRelations + crossingRelations;
  const cohesion = relationTotal ? internalRelations / relationTotal : null;
  const diagnostics = [
    ...contractValidation.diagnostics.map((item) => ({ ...item, source: 'work-contract' })),
    ...(coverage < .8 ? [{ code: 'LOW_RESPONSIBILITY_COVERAGE', severity: 'warning', path: 'components', message: `${Math.round(coverage * 100)}% of selected map entities have a proposed owner.`, details: { orphanEntityIds: orphanEntityIds.slice(0, 100) } }] : []),
    ...(overlaps.length ? [{ code: 'OVERLAPPING_OWNERSHIP', severity: 'warning', path: 'components', message: `${overlaps.length} observed entities have more than one proposed owner.`, details: { overlaps: overlaps.slice(0, 100) } }] : []),
    ...(duplicateResponsibilities.length ? [{ code: 'DUPLICATE_RESPONSIBILITY', severity: 'warning', path: 'components', message: `${duplicateResponsibilities.length} responsibility statement(s) are duplicated across candidates.`, details: { duplicates: duplicateResponsibilities.slice(0, 100) } }] : []),
    ...(cycles.length ? [{ code: 'COMPONENT_DEPENDENCY_CYCLE', severity: 'error', path: 'components', message: `${cycles.length} proposed component dependency cycle(s) require review.`, details: { cycles } }] : []),
    ...(map.source.freshness.state !== 'current' ? [{ code: 'STALE_DESIGN_SOURCE', severity: 'warning', path: 'source.snapshot', message: `The architecture uses a ${map.source.freshness.state} snapshot.` }] : []),
  ];
  const hardFailures = diagnostics.filter((item) => item.severity === 'error').length;
  return deepFreeze({
    coverage: { ratio: coverage, coveredEntities: covered.length, totalEntities: observedIds.size, orphanEntityIds: orphanEntityIds.slice(0, 500) },
    overlap: { entities: overlaps.length, examples: overlaps.slice(0, 100).map(([entityId, owners]) => ({ entityId, owners })) },
    cohesion: { ratio: cohesion, internalRelations, crossingRelations },
    coupling: { crossingRelations, ratio: relationTotal ? crossingRelations / relationTotal : null },
    duplicateResponsibilities,
    dependencyCycles: cycles,
    unstableBoundaries: unstable,
    diagnostics,
    gateC: {
      pass: hardFailures === 0 && coverage >= .8,
      hardFailures,
      evidenceFailures: diagnostics.filter((item) => /EVIDENCE|UNGROUNDED/.test(item.code)).length,
      minimumCoverage: .8,
      measuredCoverage: coverage,
      statement: 'Automated candidate gate only; human usefulness remains a separate review decision.',
    },
  });
}

function normalizeAlternative(value, catalogs, map, label = 'alternative') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARCHITECTURE_ALTERNATIVE', `${label} must be an object`);
  const strategy = inline(value.strategy, 64).toLocaleLowerCase();
  if (!STRATEGIES.has(strategy)) fail('INVALID_ARCHITECTURE_ALTERNATIVE', `${label}.strategy '${strategy}' is unsupported`);
  const components = (Array.isArray(value.components) ? value.components : []).slice(0, 40)
    .map((component, index) => normalizeCandidate(component, catalogs, `${label}.components[${index}]`));
  if (!components.length) fail('INVALID_ARCHITECTURE_ALTERNATIVE', `${label} needs at least one complete component`);
  const duplicateSlugs = components.map((component) => component.slug)
    .filter((slug, index, slugs) => slugs.indexOf(slug) !== index);
  if (duplicateSlugs.length) fail('DUPLICATE_COMPONENT_SLUG', `${label} contains duplicate component slug '${duplicateSlugs[0]}'`);
  const known = new Set(components.map((component) => component.slug));
  for (const component of components) for (const dependency of component.contract.dependencies) {
    if (dependency.kind !== 'external' && !known.has(dependency.target)) {
      fail('UNKNOWN_COMPONENT_DEPENDENCY', `${label} component '${component.slug}' depends on unknown candidate '${dependency.target}'`);
    }
  }
  const quality = evaluateArchitectureAlternative(components, map);
  return {
    id: inline(value.id, 256) || stableId('architecture-alternative', strategy, ...components.map((component) => component.id)),
    strategy,
    title: inline(value.title, 256) || `${strategy} architecture`,
    summary: clean(value.summary, 4_096),
    rationale: list(value.rationale, 50),
    tradeoffs: {
      strengths: list(value.tradeoffs?.strengths, 50),
      risks: list(value.tradeoffs?.risks, 50),
      bestWhen: list(value.tradeoffs?.bestWhen, 50),
    },
    components: components.map((component, index) => ({ ...component, order: index + 1 })),
    quality,
    generatedBy: value.generatedBy && typeof value.generatedBy === 'object' ? {
      kind: ['deterministic', 'model', 'human'].includes(value.generatedBy.kind) ? value.generatedBy.kind : 'deterministic',
      adapterId: inline(value.generatedBy.adapterId, 256) || null,
      model: inline(value.generatedBy.model, 256) || null,
    } : { kind: 'deterministic', adapterId: null, model: null },
  };
}

function entityIndexes(map) {
  const entityById = new Map(map.entities.map((entity) => [entity.id, entity]));
  const evidenceById = new Map(map.evidence.map((item) => [item.id, item]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const relation of map.relations) {
    if (!outgoing.has(relation.source)) outgoing.set(relation.source, []);
    if (!incoming.has(relation.target)) incoming.set(relation.target, []);
    outgoing.get(relation.source).push(relation);
    incoming.get(relation.target).push(relation);
  }
  return { entityById, evidenceById, outgoing, incoming };
}

function groupPriority(group) {
  const strategy = group.attributes?.strategy;
  const strategyRank = strategy === 'analyzer-community' ? 0 : strategy === 'dependency-affinity' ? 1 : 2;
  const uncertaintyRank = group.uncertainty.level === 'low' ? 0 : group.uncertainty.level === 'medium' ? 1 : 2;
  return [strategyRank, uncertaintyRank, -group.memberEntityIds.length, group.id];
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function pathBucket(entity) {
  const path = entity.location?.path || '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  if (['src', 'lib', 'app', 'apps', 'packages', 'services'].includes(parts[0].toLocaleLowerCase()) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function pseudoGroupsForOrphans(map, assigned, maximum = 12) {
  const buckets = new Map();
  for (const entity of map.entities) {
    if (assigned.has(entity.id)) continue;
    const bucket = pathBucket(entity);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(entity);
  }
  return [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, maximum).map(([bucket, entities]) => ({
    id: stableId('synthetic-map-group', bucket, ...entities.map((entity) => entity.id)),
    lens: 'responsibility',
    name: `Unassigned area ${bucket}`,
    summary: `A provisional boundary for currently unassigned evidence under ${bucket}; path is only a fallback signal.`,
    memberEntityIds: entities.map((entity) => entity.id).slice(0, 250),
    relationIds: [],
    evidenceIds: [...new Set(entities.flatMap((entity) => entity.evidenceIds || []))],
    provenance: 'inferred',
    rationale: [{ kind: 'coverage-fallback', summary: 'This grouping exists to expose orphan evidence, not to declare directory ownership.', evidenceIds: [] }],
    alternatives: [],
    uncertainty: { level: 'high', reasons: ['Only path affinity supports this provisional boundary.'] },
    coverageImpact: { representedEntities: entities.length, snapshotEntities: map.entities.length, uncoveredSubjects: 0, excludedPaths: 0, stale: false },
    attributes: { strategy: 'path-affinity', pathBucket: bucket },
  }));
}

function selectGroups(map, strategy, maximum = 16) {
  const assigned = new Set();
  const selected = [];
  const source = strategy === 'hybrid'
    ? [
        ...map.groups.filter((group) => group.lens === 'deployable'),
        ...map.groups.filter((group) => ['data-store', 'interface', 'external-system'].includes(group.lens)),
        ...map.groups.filter((group) => group.lens === 'responsibility').sort((left, right) => compareTuple(groupPriority(left), groupPriority(right))),
      ]
    : map.groups.filter((group) => group.lens === 'responsibility').sort((left, right) => compareTuple(groupPriority(left), groupPriority(right)));
  for (const group of source) {
    if (selected.length >= maximum) break;
    const members = group.memberEntityIds.filter((id) => !assigned.has(id));
    if (!members.length) continue;
    if (members.length / Math.max(1, group.memberEntityIds.length) < .35) continue;
    const candidate = { ...group, memberEntityIds: members };
    selected.push(candidate);
    for (const id of members) assigned.add(id);
  }
  for (const group of pseudoGroupsForOrphans(map, assigned, Math.max(0, maximum - selected.length))) {
    selected.push(group);
    for (const id of group.memberEntityIds) assigned.add(id);
  }
  return selected;
}

function intentText(brief, key, limit = 3) {
  return (brief?.[key] || []).slice(0, limit).map((item) => item.text || item.outcome || item.title || item.definition).filter(Boolean);
}

function intentIds(brief, key, limit = 20) {
  return (brief?.[key] || []).slice(0, limit).map((item) => item.id).filter(Boolean);
}

function grounding({ evidenceIds = [], intent = [], assumptions = [], questions = [] } = {}) {
  const base = { evidenceIds: list(evidenceIds, 100, 512), intentIds: list(intent, 100, 512), assumptions: list(assumptions, 50), questions: list(questions, 50) };
  if (!base.evidenceIds.length && !base.intentIds.length && !base.assumptions.length && !base.questions.length) {
    base.assumptions.push('This field still requires explicit human confirmation.');
  }
  return base;
}

function componentFromGroup(group, index, context, strategy, usedSlugs) {
  const indexes = entityIndexes(context.map);
  const product = productIntentCatalog(context.product).brief;
  const members = group.memberEntityIds.map((id) => indexes.entityById.get(id)).filter(Boolean);
  let slug = slugify(group.name.replace(/^(?:responsibility around|structural area|community|unassigned area)\s*/i, ''));
  if (['root', 'component'].includes(slug)) slug = `system-area-${index + 1}`;
  const base = slug;
  for (let suffix = 2; usedSlugs.has(slug); suffix += 1) slug = `${base.slice(0, 60)}-${suffix}`;
  usedSlugs.add(slug);
  const title = inline(group.name.replace(/^Responsibility around\s+/i, '').replace(/^Structural area:\s*/i, '').replace(/^Unassigned area\s*/i, ''), 160) || `System area ${index + 1}`;
  const groupEvidence = [...new Set([
    ...group.evidenceIds,
    ...members.flatMap((entity) => entity.evidenceIds || []),
  ])].filter((id) => indexes.evidenceById.has(id)).slice(0, 30);
  const boundary = new Set(group.memberEntityIds);
  const crossing = context.map.relations.filter((relation) => boundary.has(relation.source) !== boundary.has(relation.target)).slice(0, 50);
  const testMembers = members.filter((entity) => /test|spec|fixture/i.test(`${entity.kind} ${entity.location?.path || ''}`));
  const dataMembers = members.filter((entity) => /database|store|schema|migration|queue|topic|cache|external/i.test(`${entity.kind} ${entity.name}`));
  const productOutcomes = intentText(product, 'outcomes', 3);
  const productInvariants = intentText(product, 'invariants', 4);
  const declaredConstraints = intentText(product, 'constraints', 3);
  const purposeIntent = product?.purpose?.text ? ['purpose'] : [];
  const outcomeIntent = intentIds(product, 'outcomes', 3);
  const invariantIntent = [...intentIds(product, 'invariants', 4), ...intentIds(product, 'constraints', 3)];
  const evidenceRecords = groupEvidence.map((id) => {
    const item = indexes.evidenceById.get(id);
    return { kind: item?.provenance || 'inferred', reference: id, reason: item?.summary || `Evidence supporting ${title}.` };
  });
  if (!evidenceRecords.length) evidenceRecords.push({ kind: 'inferred', reference: group.id, reason: 'The derived system-map group is the current bounded source for this hypothesis.' });
  const assumptions = [];
  if (!product) assumptions.push('No accepted product brief was available; repository evidence dominates this boundary.');
  if (group.uncertainty.level !== 'low') assumptions.push(...group.uncertainty.reasons.slice(0, 3));
  const openQuestion = group.uncertainty.level === 'high'
    ? `Should ${title} remain one ownership boundary when product responsibilities are clarified?`
    : null;
  const purpose = product?.purpose?.text
    ? `${title} owns the responsibilities in this evidence cluster in service of: ${product.purpose.text}`
    : `${title} owns the cohesive system responsibility represented by ${group.summary}`;
  const outcomes = productOutcomes.length
    ? productOutcomes.map((outcome) => `Contribute a clear ownership boundary toward: ${outcome}`)
    : [`Changes affecting ${title} can be planned and verified under one explicit owner.`];
  const responsibilities = uniqueBy([
    group.summary,
    ...group.rationale.map((item) => item.summary),
    ...members.slice(0, 8).map((entity) => `Own the behavior represented by ${entity.name} (${entity.kind}).`),
  ].map((item) => clean(item, 1_000)).filter(Boolean), (item) => item.toLocaleLowerCase()).slice(0, 12);
  const limits = [
    'Does not own responsibilities represented only by entities outside this candidate boundary.',
    ...(crossing.length ? ['Cross-boundary relations remain coordination points until interfaces are explicitly accepted.'] : []),
  ];
  const invariants = productInvariants.length || declaredConstraints.length
    ? [...productInvariants, ...declaredConstraints]
    : ['Preserve observed interfaces and repository safety until a reviewed contract changes them.'];
  const memberSet = new Set(group.memberEntityIds);
  const interfaces = uniqueBy(crossing.map((relation) => {
    const outward = memberSet.has(relation.source);
    const peer = indexes.entityById.get(outward ? relation.target : relation.source);
    return {
      kind: outward ? 'provides' : 'consumes',
      target: peer?.name || (outward ? relation.target : relation.source),
      description: `${relation.kind} relation crossing the proposed boundary${relation.confidence !== undefined ? ` (${Math.round(relation.confidence * 100)}% confidence)` : ''}.`,
    };
  }), (item) => `${item.kind}:${item.target}:${item.description}`).slice(0, 20);
  const territory = [...new Set(members.map((entity) => entity.location?.path).filter(Boolean))].sort().slice(0, 60);
  if (!territory.length) territory.push('No located source territory; resolve before publication.');
  const verification = testMembers.length
    ? testMembers.slice(0, 10).map((entity) => `Use ${entity.location?.path || entity.name} as verification evidence for this boundary.`)
    : ['Review this boundary against the current snapshot and define an executable repository check before publication.'];
  const uncertainties = uniqueBy([
    ...group.uncertainty.reasons,
    ...(context.map.source.snapshotStatus === 'partial' ? ['The source analysis reports partial coverage.'] : []),
    ...(openQuestion ? [openQuestion] : []),
  ], (item) => item).slice(0, 20);
  if (!uncertainties.length) uncertainties.push('No material uncertainty was detected by deterministic checks; human review is still required.');
  const dataSystems = dataMembers.map((entity) => `${entity.name} (${entity.kind})`).slice(0, 20);
  const commonEvidence = grounding({ evidenceIds: groupEvidence.length ? groupEvidence : [group.id], assumptions });
  const fieldGrounding = {
    purpose: grounding({ evidenceIds: commonEvidence.evidenceIds, intent: purposeIntent, assumptions }),
    outcomes: grounding({ evidenceIds: commonEvidence.evidenceIds, intent: outcomeIntent, assumptions: productOutcomes.length ? [] : ['No declared product outcome was available; this is an operational ownership outcome.'] }),
    responsibilities: grounding({ evidenceIds: commonEvidence.evidenceIds, assumptions }),
    limits: grounding({ evidenceIds: crossing.flatMap((relation) => relation.evidenceIds || []).slice(0, 50), assumptions: ['Limits are proposed from what lies outside the selected member set.'] }),
    invariants: grounding({ evidenceIds: commonEvidence.evidenceIds, intent: invariantIntent, assumptions: invariantIntent.length ? [] : ['No declared invariant was available; preserve observed interfaces is a provisional invariant.'] }),
    interfaces: grounding({ evidenceIds: crossing.flatMap((relation) => relation.evidenceIds || []).slice(0, 50), assumptions: interfaces.length ? [] : ['No normalized cross-boundary interface was detected.'] }),
    dependencies: grounding({ evidenceIds: crossing.flatMap((relation) => relation.evidenceIds || []).slice(0, 50), assumptions: ['Observed graph edges are coordination signals, not accepted hard dependencies.'] }),
    dataSystems: grounding({ evidenceIds: dataMembers.flatMap((entity) => entity.evidenceIds || []), assumptions: dataSystems.length ? [] : ['No owned data or external system was identified in this candidate.'] }),
    territory: grounding({ evidenceIds: members.flatMap((entity) => entity.evidenceIds || []).slice(0, 100), assumptions: territory[0].startsWith('No located') ? [territory[0]] : [] }),
    verification: grounding({ evidenceIds: testMembers.flatMap((entity) => entity.evidenceIds || []), assumptions: testMembers.length ? [] : [verification[0]] }),
    evidence: commonEvidence,
    uncertainties: grounding({ evidenceIds: commonEvidence.evidenceIds, questions: openQuestion ? [openQuestion] : [], assumptions }),
    guidance: grounding({ evidenceIds: commonEvidence.evidenceIds, assumptions: ['Agent guidance is a proposed delegation constraint derived from this boundary.'] }),
  };
  return {
    id: stableId('component-candidate', strategy, group.id),
    slug,
    title,
    state: 'active',
    order: index + 1,
    origin: 'generated',
    memberEntityIds: group.memberEntityIds,
    contract: {
      purpose,
      outcomes,
      responsibilities,
      limits,
      invariants,
      interfaces,
      dependencies: [],
      dataSystems,
      territory,
      verification,
      evidence: evidenceRecords,
      uncertainties,
      guidance: `Delegate changes that primarily affect ${title} here. Coordinate every crossing interface explicitly and do not expand ownership from path proximity alone.`,
    },
    fieldGrounding,
    lockedFields: [],
  };
}

function connectCandidateDependencies(components, context) {
  const owner = new Map();
  for (const component of components) for (const entityId of component.memberEntityIds) if (!owner.has(entityId)) owner.set(entityId, component.slug);
  const entityById = new Map(context.map.entities.map((entity) => [entity.id, entity]));
  for (const component of components) {
    const dependencies = [];
    const evidenceIds = [];
    const own = new Set(component.memberEntityIds);
    for (const relation of context.map.relations) {
      if (!own.has(relation.source) || own.has(relation.target)) continue;
      const targetSlug = owner.get(relation.target);
      const targetEntity = entityById.get(relation.target);
      if (targetSlug && targetSlug !== component.slug) {
        dependencies.push({ kind: 'soft', target: targetSlug, reason: `Observed ${relation.kind} relation; coordination is proposed, not hard readiness.` });
      } else if (targetEntity) {
        dependencies.push({ kind: 'external', target: targetEntity.name, reason: `Observed ${relation.kind} relation to an entity outside proposed ownership.` });
      }
      evidenceIds.push(...(relation.evidenceIds || []));
    }
    component.contract.dependencies = uniqueBy(dependencies, (dependency) => `${dependency.kind}:${dependency.target}`).slice(0, 30);
    component.fieldGrounding.dependencies = grounding({
      evidenceIds: [...new Set(evidenceIds)].slice(0, 100),
      assumptions: component.contract.dependencies.length
        ? ['Observed relations are represented as soft/external dependencies until a human accepts stronger semantics.']
        : ['No outgoing dependency was observed for the selected member set.'],
    });
  }
  return components;
}

function strategyAlternative(context, strategy) {
  const groups = selectGroups(context.map, strategy);
  const usedSlugs = new Set();
  const components = connectCandidateDependencies(groups.map((group, index) => componentFromGroup(group, index, context, strategy, usedSlugs)), context);
  const distinct = strategy === 'hybrid';
  return {
    id: stableId('architecture-alternative', context.identity, strategy),
    strategy,
    title: distinct ? 'Deployable and responsibility hybrid' : 'Responsibility and dependency architecture',
    summary: distinct
      ? 'Starts from runtime/deployable/data/interface anchors, then fills uncovered responsibility evidence without treating paths as identity.'
      : 'Starts from analyzer communities and dependency-affinity neighborhoods, then exposes remaining structural areas as uncertain coverage fallbacks.',
    rationale: distinct
      ? ['Runtime seams can make agent ownership and verification concrete.', 'Responsibility candidates prevent deployment units from swallowing unrelated product behavior.']
      : ['Dependency affinity and explicit communities provide stronger cohesion evidence than directory shape.', 'Overlapping candidates are resolved into one provisional primary owner while retaining alternatives in the map.'],
    tradeoffs: distinct ? {
      strengths: ['Concrete deploy/release boundaries', 'Visible interfaces and data seams'],
      risks: ['A deployable may contain several unrelated product responsibilities', 'Shared platform responsibilities may be fragmented'],
      bestWhen: ['Deployments and operational ownership dominate change coordination'],
    } : {
      strengths: ['Optimizes for cohesive change and durable responsibility', 'Can cross directory/deployable boundaries when evidence supports it'],
      risks: ['Runtime ownership may need extra coordination', 'Weak graphs require high-uncertainty path fallbacks'],
      bestWhen: ['Business/system responsibility is more stable than deployment topology'],
    },
    components,
    generatedBy: { kind: 'deterministic', adapterId: null, model: null },
  };
}

function membersForTerritory(component, map) {
  const territory = component.contract?.territory || [];
  return map.entities.filter((entity) => entity.location?.path && territory.some((path) => (
    entity.location.path === path || entity.location.path.startsWith(`${String(path).replace(/\/$/, '')}/`)
  ))).map((entity) => entity.id);
}

function acceptedAlternative(context) {
  const current = context.portfolio?.components || [];
  if (!current.length) return null;
  const product = productIntentCatalog(context.product);
  const references = referenceCatalog(context);
  const components = current.slice(0, 40).map((component, index) => {
    const contract = component.contract || {};
    const evidence = (contract.evidence || []).filter((item) => references.has(item.reference));
    const fallbackEvidence = evidence.length ? evidence : [{ kind: 'declared', reference: context.snapshot.id, reason: 'Accepted component retained against this reviewed snapshot.' }];
    const assumptions = ['Missing accepted v2 fields are represented explicitly for review; no accepted file was changed.'];
    const fieldGrounding = Object.fromEntries(COMPONENT_DESIGN_FIELDS.map((field) => [field, grounding({
      evidenceIds: fallbackEvidence.map((item) => item.reference),
      intent: field === 'purpose' && product.brief?.purpose?.text ? ['purpose'] : [],
      assumptions,
    })]));
    return {
      id: stableId('component-candidate', 'accepted', component.slug),
      slug: component.slug,
      title: component.title,
      state: 'active',
      order: index + 1,
      origin: 'accepted',
      memberEntityIds: membersForTerritory(component, context.map),
      contract: {
        purpose: contract.purpose || `Retain the accepted responsibility of ${component.title}.`,
        outcomes: contract.outcomes?.length ? contract.outcomes : [`Keep ${component.title} reviewable while its outcome contract is completed.`],
        responsibilities: contract.responsibilities?.length ? contract.responsibilities : [`Retain currently accepted ownership for ${component.title}.`],
        limits: contract.limits?.length ? contract.limits : ['No additional ownership is inferred from current territory.'],
        invariants: contract.invariants?.length ? contract.invariants : ['Preserve accepted behavior until a reviewed architecture change is published.'],
        interfaces: (contract.interfaces || []).filter((item) => INTERFACE_KIND.has(item.kind) && item.target && item.description),
        dependencies: (contract.dependencies || []).filter((item) => DEPENDENCY_KIND.has(item.kind) && item.target && item.reason),
        dataSystems: contract.dataSystems || [],
        territory: contract.territory?.length ? contract.territory : ['Accepted contract has no located territory.'],
        verification: contract.verification?.length ? contract.verification : ['Define executable verification before publishing an evolved contract.'],
        evidence: fallbackEvidence,
        uncertainties: contract.uncertainties?.length ? contract.uncertainties : ['Accepted contract requires evidence reconciliation against the selected map.'],
        guidance: contract.guidance || `Preserve ${component.title}'s accepted boundary until a reviewed replacement is published.`,
      },
      fieldGrounding,
      lockedFields: [],
    };
  });
  return {
    id: stableId('architecture-alternative', context.identity, 'existing'),
    strategy: 'existing',
    title: 'Current accepted architecture',
    summary: 'A private, normalized view of current accepted components for comparison; missing fields remain explicit review gaps.',
    rationale: ['Existing accepted decisions are a baseline, not disposable context.', 'No accepted Markdown is rewritten by this draft.'],
    tradeoffs: {
      strengths: ['Maximum continuity and stable names', 'Makes proposed changes visible against accepted ownership'],
      risks: ['Legacy or incomplete contracts may preserve weak boundaries', 'Territory may no longer match observed evidence'],
      bestWhen: ['Evolution risk outweighs the benefit of a greenfield decomposition'],
    },
    components,
    generatedBy: { kind: 'human', adapterId: null, model: null },
  };
}

function modelAlternative(context) {
  if (!context.planningResult) return null;
  const result = context.planningResult;
  const entityByPath = new Map();
  for (const entity of context.map.entities) if (entity.location?.path) {
    if (!entityByPath.has(entity.location.path)) entityByPath.set(entity.location.path, []);
    entityByPath.get(entity.location.path).push(entity.id);
  }
  const knownSlugs = new Set(result.components.map((component) => component.slug));
  const product = productIntentCatalog(context.product);
  const components = result.components.map((proposal, index) => {
    const assumptions = proposal.assumptions.length ? proposal.assumptions : ['Model-generated architecture requires explicit human review.'];
    const evidenceIds = proposal.evidenceIds.length ? proposal.evidenceIds : [context.map.id];
    const memberEntityIds = [...new Set(proposal.territory.flatMap((path) => entityByPath.get(path) || context.map.entities
      .filter((entity) => entity.location?.path?.startsWith(`${path.replace(/\/$/, '')}/`)).map((entity) => entity.id)))];
    const baseGrounding = grounding({ evidenceIds, assumptions, questions: proposal.questions });
    const fieldGrounding = Object.fromEntries(COMPONENT_DESIGN_FIELDS.map((field) => [field, {
      ...baseGrounding,
      intentIds: field === 'purpose' && product.brief?.purpose?.text ? ['purpose'] : [],
    }]));
    return {
      id: stableId('component-candidate', 'model', proposal.slug),
      slug: proposal.slug,
      title: proposal.title,
      state: 'active', order: index + 1, origin: 'model', memberEntityIds,
      contract: {
        purpose: proposal.responsibility,
        outcomes: proposal.outcomes.length ? proposal.outcomes : [`Make ${proposal.title}'s outcome explicit before publication.`],
        responsibilities: proposal.responsibilities.length ? proposal.responsibilities : [proposal.responsibility],
        limits: proposal.limits.length ? proposal.limits : ['No ownership outside cited evidence without human review.'],
        invariants: proposal.invariants.length ? proposal.invariants : ['Preserve cited behavior and accepted product constraints.'],
        interfaces: proposal.interfaces.map((item) => ({ kind: 'provides', target: item, description: 'Model-proposed interface; direction and ownership require review.' })),
        dependencies: proposal.dependencies.map((item) => ({
          kind: knownSlugs.has(slugify(item)) ? 'soft' : 'external',
          target: knownSlugs.has(slugify(item)) ? slugify(item) : item,
          reason: 'Model-proposed dependency retained as non-hard until deterministic review.',
        })),
        dataSystems: proposal.dataSystems,
        territory: proposal.territory.length ? proposal.territory : ['Model proposal has no resolved source territory.'],
        verification: proposal.verification.length ? proposal.verification : ['Define executable verification before publication.'],
        evidence: evidenceIds.map((id) => ({ kind: 'inferred', reference: id, reason: 'Validated model proposal cited this allowlisted source.' })),
        uncertainties: [...proposal.assumptions, ...proposal.questions].length ? [...proposal.assumptions, ...proposal.questions] : ['Model synthesis remains a proposal until reviewed.'],
        guidance: `Use only the reviewed evidence and accepted decisions for ${proposal.title}; do not expand this model-proposed boundary implicitly.`,
      },
      fieldGrounding,
      lockedFields: [],
    };
  });
  return {
    id: stableId('architecture-alternative', context.identity, 'model'),
    strategy: 'model',
    title: 'Model-synthesized architecture',
    summary: result.summary,
    rationale: ['Uses the separately consented, schema-validated planning result.', 'Deterministic component and evidence validation runs again inside this workspace.'],
    tradeoffs: {
      strengths: ['Can combine product intent and structural evidence into non-local hypotheses'],
      risks: ['Reasoning remains fallible and may under-map concrete entities', 'Every field still requires evidence and human review'],
      bestWhen: ['The reviewed context includes enough product intent to resolve ambiguous structural seams'],
    },
    components,
    generatedBy: { kind: 'model', adapterId: context.planningJobId || 'planning-runtime', model: null },
  };
}

function architectureSignature(alternative) {
  return canonical(alternative.components.map((component) => ({
    slug: component.slug,
    members: [...component.memberEntityIds].sort(),
  })).sort((left, right) => left.slug.localeCompare(right.slug)));
}

function designQuestions(context, alternatives) {
  const product = productIntentCatalog(context.product).brief;
  const questions = [];
  if (!product?.purpose?.text || !product?.outcomes?.length) questions.push({
    id: 'question:product-priority',
    question: 'Which user or system outcome should dominate component boundaries when structural cohesion conflicts with product responsibility?',
    why: 'Repository structure cannot decide product ownership.',
    affects: ['purpose', 'outcomes', 'responsibilities', 'limits'],
    state: 'open', answer: '',
  });
  if (alternatives.length > 1) questions.push({
    id: 'question:boundary-axis',
    question: 'When deployable topology and responsibility/dependency affinity disagree, which should be the primary ownership axis?',
    why: 'The available alternatives make materially different entity assignments.',
    affects: ['responsibilities', 'interfaces', 'dependencies', 'territory'],
    state: 'open', answer: '',
  });
  const dataCrossings = context.map.relations.filter((relation) => /read|write|store|query|publish|consume/i.test(relation.kind));
  if (dataCrossings.length) questions.push({
    id: 'question:data-lifecycle',
    question: 'Should data lifecycle ownership stay with the calling responsibility, or form a separate platform/data component?',
    why: `${dataCrossings.length} normalized data-flow relation(s) cross potential responsibility boundaries.`,
    affects: ['responsibilities', 'interfaces', 'dependencies', 'dataSystems'],
    state: 'open', answer: '',
  });
  const overlap = Math.max(0, ...alternatives.map((alternative) => alternative.quality.overlap.entities));
  if (overlap) questions.push({
    id: 'question:shared-responsibility',
    question: 'Which proposed owner should be accountable for the overlapping entities, and which consumers should use an interface instead?',
    why: `${overlap} entity assignment(s) overlap in at least one alternative.`,
    affects: ['responsibilities', 'limits', 'interfaces'],
    state: 'open', answer: '',
  });
  return questions.slice(0, 10);
}

function catalogsFor(context) {
  return {
    references: referenceCatalog(context),
    intentIds: productIntentCatalog(context.product).ids,
    entityIds: new Set(context.map.entities.map((entity) => entity.id)),
  };
}

export function synthesizeArchitectureAlternatives(contextValue, { includeModel = true } = {}) {
  const context = normalizeComponentDesignContext(contextValue);
  const catalogs = catalogsFor(context);
  const raw = [strategyAlternative(context, 'responsibility'), strategyAlternative(context, 'hybrid')];
  const accepted = acceptedAlternative(context);
  if (accepted) raw.push(accepted);
  const model = includeModel ? modelAlternative(context) : null;
  if (model) raw.push(model);
  const distinct = uniqueBy(raw, architectureSignature);
  const alternatives = distinct.map((alternative, index) => normalizeAlternative({ ...alternative, id: alternative.id || stableId('architecture-alternative', context.identity, index) }, catalogs, context.map));
  return deepFreeze({ context, catalogs, alternatives });
}

function draftRevision(draft) {
  return sha256(canonical({
    state: draft.state,
    selectedAlternativeId: draft.selectedAlternativeId,
    alternatives: draft.alternatives,
    questions: draft.questions,
    lockedDecisions: draft.lockedDecisions,
  }));
}

function sourceRecord(context) {
  const product = productIntentCatalog(context.product);
  return {
    contextIdentity: context.identity,
    analysisJobId: context.analysisJobId,
    planningJobId: context.planningJobId,
    snapshotId: context.snapshot.id,
    mapId: context.map.id,
    repository: context.snapshot.repository,
    snapshot: { status: context.snapshot.status, freshness: context.snapshot.freshness, analyzer: { id: context.snapshot.analyzer.id, version: context.snapshot.analyzer.version } },
    productRevision: product.revision,
    productIncluded: Boolean(context.product),
    modelIncluded: Boolean(context.planningResult),
    portfolioRevision: portfolioRevision(context.portfolio),
    references: [...referenceCatalog(context)].sort(),
    intentIds: [...product.ids].sort(),
    entityIds: context.map.entities.map((entity) => entity.id).sort(),
  };
}

function publicDraft(draft, context = null, unavailableReason = null) {
  const staleReasons = [];
  if (unavailableReason) staleReasons.push(unavailableReason);
  if (context) {
    if (context.snapshot.id !== draft.source.snapshotId) staleReasons.push('The selected analysis snapshot changed.');
    if (context.map.id !== draft.source.mapId) staleReasons.push('The derived system map changed.');
    if (productIntentCatalog(context.product).revision !== draft.source.productRevision) staleReasons.push('Accepted product direction changed.');
    if (portfolioRevision(context.portfolio) !== draft.source.portfolioRevision) staleReasons.push('The accepted component/front portfolio changed.');
    if (context.identity !== draft.source.contextIdentity) staleReasons.push('The planning context changed.');
    if (context.snapshot.freshness.state !== 'current') staleReasons.push(`The source snapshot is ${context.snapshot.freshness.state}.`);
  } else if (draft.source.snapshot.freshness.state !== 'current') staleReasons.push(`The source snapshot is ${draft.source.snapshot.freshness.state}.`);
  const { references: _references, intentIds: _intentIds, entityIds: _entityIds, ...publicSource } = draft.source;
  return deepFreeze({
    schemaVersion: COMPONENT_DESIGN_SCHEMA_VERSION,
    id: draft.id,
    repositoryId: draft.repositoryId,
    state: draft.state,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    expiresAt: new Date(draft.expiresAtMs).toISOString(),
    source: publicSource,
    stale: staleReasons.length > 0,
    staleReasons: [...new Set(staleReasons)],
    selectedAlternativeId: draft.selectedAlternativeId,
    alternatives: draft.alternatives,
    questions: draft.questions,
    lockedDecisions: draft.lockedDecisions,
    history: draft.history.slice(-100),
    revision: draftRevision(draft),
    mutation: { repository: false, privateDraftOnly: true, publicationAvailableHere: false },
  });
}

function draftCatalogs(draft) {
  return {
    references: new Set(draft.source.references || []),
    intentIds: new Set(draft.source.intentIds || []),
    entityIds: new Set(draft.source.entityIds || []),
  };
}

function selectedAlternative(draft, id = draft.selectedAlternativeId) {
  const alternative = draft.alternatives.find((item) => item.id === id);
  if (!alternative) fail('ALTERNATIVE_NOT_FOUND', `architecture alternative '${id}' was not found`);
  return alternative;
}

function selectedComponent(alternative, id) {
  const component = alternative.components.find((item) => item.id === id);
  if (!component) fail('COMPONENT_CANDIDATE_NOT_FOUND', `component candidate '${id}' was not found`);
  return component;
}

function assertUnlocked(component, fields) {
  const locked = fields.filter((field) => component.lockedFields.includes(field));
  if (locked.length) fail('LOCKED_COMPONENT_FIELD', `unlock ${locked.join(', ')} before changing this component`, { componentId: component.id, fields: locked });
}

function componentPatch(component, updates) {
  const next = clone(component);
  const changed = [];
  if (updates.title !== undefined && inline(updates.title, 160) !== component.title) { next.title = inline(updates.title, 160); changed.push('title'); }
  if (updates.slug !== undefined && slugify(updates.slug) !== component.slug) { next.slug = slugify(updates.slug); changed.push('slug'); }
  if (updates.memberEntityIds !== undefined) { next.memberEntityIds = list(updates.memberEntityIds, 2_000, 512); changed.push('memberEntityIds'); }
  const contract = updates.contract && typeof updates.contract === 'object' ? updates.contract : {};
  for (const field of COMPONENT_DESIGN_FIELDS) if (contract[field] !== undefined) {
    next.contract[field] = clone(contract[field]);
    changed.push(field);
  }
  const fieldGrounding = updates.fieldGrounding && typeof updates.fieldGrounding === 'object' ? updates.fieldGrounding : {};
  for (const field of COMPONENT_DESIGN_FIELDS) if (fieldGrounding[field] !== undefined) {
    next.fieldGrounding[field] = clone(fieldGrounding[field]);
    if (!changed.includes(field)) changed.push(field);
  }
  assertUnlocked(component, changed.filter((field) => FIELDS.has(field)));
  for (const field of changed.filter((item) => FIELDS.has(item))) {
    if (fieldGrounding[field] === undefined && contract[field] !== undefined) {
      next.fieldGrounding[field] = grounding({ assumptions: [`Human-edited ${field}; reconcile evidence before publication.`] });
    }
  }
  return next;
}

function validateAlternativeReferences(alternative) {
  const known = new Set(alternative.components.map((component) => component.slug));
  for (const component of alternative.components) for (const dependency of component.contract.dependencies) {
    if (dependency.kind !== 'external' && !known.has(dependency.target)) {
      fail('UNKNOWN_COMPONENT_DEPENDENCY', `component '${component.slug}' depends on unknown candidate '${dependency.target}'`);
    }
  }
}

function markQualityContextUnavailable(quality) {
  const diagnostic = {
    code: 'QUALITY_CONTEXT_UNAVAILABLE', severity: 'warning', path: 'source.snapshot',
    message: 'Structural quality metrics were not recomputed because the original system-map context is unavailable.',
  };
  return {
    ...quality,
    stale: true,
    diagnostics: [...(quality?.diagnostics || []).filter((item) => item.code !== diagnostic.code), diagnostic],
    gateC: {
      ...(quality?.gateC || {}), pass: false,
      statement: 'Not evaluated: the original system-map context is unavailable.',
    },
  };
}

function alternativeDiff(left, right) {
  const leftBySlug = new Map(left.components.map((component) => [component.slug, component]));
  const rightBySlug = new Map(right.components.map((component) => [component.slug, component]));
  const added = [...rightBySlug.keys()].filter((slug) => !leftBySlug.has(slug)).sort();
  const removed = [...leftBySlug.keys()].filter((slug) => !rightBySlug.has(slug)).sort();
  const changed = [...rightBySlug.keys()].filter((slug) => leftBySlug.has(slug) && canonical(leftBySlug.get(slug)) !== canonical(rightBySlug.get(slug))).sort();
  const leftOwner = new Map(left.components.flatMap((component) => component.memberEntityIds.map((entityId) => [entityId, component.slug])));
  const rightOwner = new Map(right.components.flatMap((component) => component.memberEntityIds.map((entityId) => [entityId, component.slug])));
  const movedEntities = [...new Set([...leftOwner.keys(), ...rightOwner.keys()])]
    .filter((id) => leftOwner.get(id) !== rightOwner.get(id))
    .map((entityId) => ({ entityId, from: leftOwner.get(entityId) || null, to: rightOwner.get(entityId) || null }))
    .slice(0, 1_000);
  return deepFreeze({
    left: { id: left.id, title: left.title, strategy: left.strategy },
    right: { id: right.id, title: right.title, strategy: right.strategy },
    components: { added, removed, changed },
    movedEntities,
    quality: { left: left.quality, right: right.quality },
    materiallyDifferent: Boolean(added.length || removed.length || changed.length || movedEntities.length),
  });
}

export function compareArchitectureAlternatives(draftValue, leftId, rightId) {
  const left = selectedAlternative(draftValue, leftId);
  const right = selectedAlternative(draftValue, rightId);
  return alternativeDiff(left, right);
}

export class ComponentDesignDraftStore {
  constructor({ root, now = () => Date.now(), ttlMs = COMPONENT_DESIGN_DRAFT_TTL_MS } = {}) {
    if (!root) fail('COMPONENT_DESIGN_ROOT_REQUIRED', 'component design draft root is required');
    this.root = ensurePrivateDirectory(root);
    this.now = now;
    this.ttlMs = ttlMs;
    this.cleanup();
  }

  #path(id) {
    if (!DRAFT_ID.test(String(id || ''))) fail('COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'component design draft not found');
    return join(this.root, `${id}.json`);
  }

  #load(id) {
    let draft;
    try { draft = JSON.parse(readFileSync(this.#path(id), 'utf8')); }
    catch (error) {
      if (error instanceof ComponentDesignError) throw error;
      fail('COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'component design draft not found');
    }
    if (draft.expiresAtMs <= this.now()) {
      rmSync(this.#path(id), { force: true });
      fail('COMPONENT_DESIGN_DRAFT_EXPIRED', 'component design draft expired; create a fresh workspace');
    }
    return draft;
  }

  #save(draft) {
    draft.updatedAt = new Date(this.now()).toISOString();
    draft.expiresAtMs = this.now() + this.ttlMs;
    atomicPrivateJson(this.#path(draft.id), draft);
    return draft;
  }

  cleanup() {
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.root, name);
      try {
        const draft = JSON.parse(readFileSync(path, 'utf8'));
        if (!draft?.expiresAtMs || draft.expiresAtMs <= this.now()) rmSync(path, { force: true });
      } catch { rmSync(path, { force: true }); }
    }
  }

  create(repository, contextValue, { includeModel = true } = {}) {
    const context = normalizeComponentDesignContext(contextValue);
    if (context.repository.id !== repository.id || context.repository.adapter !== repository.adapter) {
      fail('COMPONENT_DESIGN_REPOSITORY_MISMATCH', 'component design context belongs to a different repository');
    }
    const synthesis = synthesizeArchitectureAlternatives(context, { includeModel });
    const createdAt = new Date(this.now()).toISOString();
    const id = randomUUID();
    const draft = {
      schemaVersion: COMPONENT_DESIGN_SCHEMA_VERSION,
      id,
      repositoryId: repository.id,
      state: 'review',
      createdAt,
      updatedAt: createdAt,
      expiresAtMs: this.now() + this.ttlMs,
      source: sourceRecord(context),
      selectedAlternativeId: synthesis.alternatives[0].id,
      alternatives: clone(synthesis.alternatives),
      questions: designQuestions(context, synthesis.alternatives),
      lockedDecisions: [],
      history: [{ id: stableId('history', id, createdAt), at: createdAt, operation: 'created', summary: `${synthesis.alternatives.length} architecture alternative(s) generated without repository mutation.` }],
    };
    this.#save(draft);
    return publicDraft(draft, context);
  }

  list(repositoryId) {
    this.cleanup();
    return readdirSync(this.root).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const draft = JSON.parse(readFileSync(join(this.root, name), 'utf8'));
        return draft.repositoryId === repositoryId ? [publicDraft(draft)] : [];
      } catch { return []; }
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(repositoryId, id, { context = null, unavailableReason = null } = {}) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repositoryId) fail('COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'component design draft does not belong to this repository');
    return publicDraft(draft, context ? normalizeComponentDesignContext(context) : null, unavailableReason);
  }

  source(repositoryId, id) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repositoryId) fail('COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'component design draft does not belong to this repository');
    return deepFreeze({
      analysisJobId: draft.source.analysisJobId,
      planningJobId: draft.source.planningJobId,
      snapshotId: draft.source.snapshotId,
      contextIdentity: draft.source.contextIdentity,
      productIncluded: Boolean(draft.source.productIncluded),
      modelIncluded: Boolean(draft.source.modelIncluded),
    });
  }

  compare(repositoryId, id, leftId, rightId) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repositoryId) fail('COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'component design draft does not belong to this repository');
    return compareArchitectureAlternatives(draft, leftId, rightId);
  }

  apply(repositoryId, id, operationValue, { context = null } = {}) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repositoryId) fail('COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'component design draft does not belong to this repository');
    const operation = operationValue && typeof operationValue === 'object' ? operationValue : {};
    const kind = inline(operation.operation, 64);
    const beforeRevision = draftRevision(draft);
    if (operation.expectedRevision && inline(operation.expectedRevision, 128) !== beforeRevision) {
      fail('COMPONENT_DESIGN_REVISION_CONFLICT', 'the component design draft changed; refresh before applying this operation', {
        expectedRevision: inline(operation.expectedRevision, 128), currentRevision: beforeRevision,
      });
    }
    const normalizedContext = context ? normalizeComponentDesignContext(context) : null;
    if (normalizedContext && normalizedContext.snapshot.id !== draft.source.snapshotId) {
      fail('COMPONENT_DESIGN_SOURCE_MISMATCH', 'the supplied system-map context does not match this draft snapshot');
    }
    const catalogs = draftCatalogs(draft);
    const structuralOperation = new Set(['edit-component', 'delete-component', 'add-component', 'split-component', 'merge-components']);
    let summary = '';
    let historyDetails = null;
    if (kind === 'select-alternative') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256));
      draft.selectedAlternativeId = alternative.id;
      summary = `Selected ${alternative.title}.`;
    } else if (kind === 'edit-component') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId);
      const index = alternative.components.findIndex((item) => item.id === operation.componentId);
      const current = selectedComponent(alternative, operation.componentId);
      const next = normalizeCandidate(componentPatch(current, operation.updates || {}), catalogs, 'edited component');
      if (next.slug !== current.slug && alternative.components.some((item) => item.id !== current.id && item.slug === next.slug)) fail('DUPLICATE_COMPONENT_SLUG', `component slug '${next.slug}' already exists in this alternative`);
      alternative.components[index] = next;
      if (next.slug !== current.slug) for (const component of alternative.components) {
        if (component.id === next.id) continue;
        component.contract.dependencies = component.contract.dependencies.map((dependency) => (
          dependency.kind !== 'external' && dependency.target === current.slug
            ? { ...dependency, target: next.slug, reason: `${dependency.reason} Redirected after a reviewed component rename.` }
            : dependency
        ));
      }
      alternative.components = alternative.components.map((component, order) => ({ ...component, order: order + 1 }));
      summary = `Edited ${next.title}.`;
    } else if (kind === 'lock-field' || kind === 'unlock-field') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId);
      const component = selectedComponent(alternative, operation.componentId);
      const field = inline(operation.field, 64);
      if (!FIELDS.has(field)) fail('INVALID_COMPONENT_LOCK', `unknown component field '${field}'`);
      if (kind === 'lock-field') {
        component.lockedFields = [...new Set([...component.lockedFields, field])];
        draft.lockedDecisions = draft.lockedDecisions.filter((item) => !(item.componentId === component.id && item.field === field));
        draft.lockedDecisions.push({ id: stableId('locked-decision', component.id, field), componentId: component.id, componentSlug: component.slug, field, valueDigest: sha256(canonical(component.contract[field])), reason: clean(operation.reason, 1_000) || 'Locked by human review.' });
        summary = `Locked ${component.slug}.${field}.`;
      } else {
        component.lockedFields = component.lockedFields.filter((item) => item !== field);
        draft.lockedDecisions = draft.lockedDecisions.filter((item) => !(item.componentId === component.id && item.field === field));
        summary = `Unlocked ${component.slug}.${field}.`;
      }
    } else if (kind === 'delete-component') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId);
      const component = selectedComponent(alternative, operation.componentId);
      if (component.lockedFields.length) fail('LOCKED_COMPONENT_FIELD', 'unlock every field before deleting this component', { fields: component.lockedFields });
      if (alternative.components.length === 1) fail('INVALID_ARCHITECTURE_ALTERNATIVE', 'an architecture alternative must retain at least one component');
      const inbound = alternative.components.flatMap((item) => item.id === component.id ? [] : item.contract.dependencies
        .filter((dependency) => dependency.kind !== 'external' && dependency.target === component.slug)
        .map((dependency) => ({ component: item.slug, dependency })));
      if (inbound.length) fail('COMPONENT_STILL_REFERENCED', `remove or redirect dependencies to '${component.slug}' before deleting it`, { inbound });
      alternative.components = alternative.components.filter((item) => item.id !== component.id).map((item, index) => ({ ...item, order: index + 1 }));
      draft.lockedDecisions = draft.lockedDecisions.filter((item) => item.componentId !== component.id);
      summary = `Deleted ${component.title} from the private alternative.`;
    } else if (kind === 'add-component') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId);
      const candidate = normalizeCandidate({ ...operation.component, origin: 'manual', order: alternative.components.length + 1 }, catalogs, 'manual component');
      if (alternative.components.some((item) => item.slug === candidate.slug)) fail('DUPLICATE_COMPONENT_SLUG', `component slug '${candidate.slug}' already exists in this alternative`);
      alternative.components.push(candidate);
      summary = `Added manual component ${candidate.title}.`;
    } else if (kind === 'reorder-components') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId);
      const ids = list(operation.componentIds, 100, 256);
      if (ids.length !== alternative.components.length || new Set(ids).size !== ids.length || ids.some((componentId) => !alternative.components.some((component) => component.id === componentId))) {
        fail('INVALID_COMPONENT_ORDER', 'componentIds must contain every candidate exactly once');
      }
      alternative.components = ids.map((componentId, index) => ({ ...selectedComponent(alternative, componentId), order: index + 1 }));
      summary = 'Reordered component candidates.';
    } else if (kind === 'split-component') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId);
      const source = selectedComponent(alternative, operation.componentId);
      if (source.lockedFields.length) fail('LOCKED_COMPONENT_FIELD', 'unlock every field before splitting this component', { fields: source.lockedFields });
      const firstMembers = list(operation.first?.memberEntityIds, 2_000, 512);
      const secondMembers = list(operation.second?.memberEntityIds, 2_000, 512);
      const sourceMembers = new Set(source.memberEntityIds);
      if (!firstMembers.length || !secondMembers.length || [...firstMembers, ...secondMembers].some((entityId) => !sourceMembers.has(entityId))) {
        fail('INVALID_COMPONENT_SPLIT', 'both split candidates need non-empty member sets drawn from the source component');
      }
      const overlap = firstMembers.filter((id) => secondMembers.includes(id));
      if (overlap.length) fail('INVALID_COMPONENT_SPLIT', 'split member sets cannot overlap', { overlap });
      const partition = new Set([...firstMembers, ...secondMembers]);
      const missing = source.memberEntityIds.filter((id) => !partition.has(id));
      if (missing.length || partition.size !== sourceMembers.size) {
        fail('INVALID_COMPONENT_SPLIT', 'split member sets must partition every source entity exactly once', { missing });
      }
      const make = (details, members, suffix) => normalizeCandidate({
        ...clone(source), id: stableId('component-candidate', source.id, suffix), slug: details.slug, title: details.title,
        memberEntityIds: members, lockedFields: [], origin: 'manual',
        contract: { ...clone(source.contract), purpose: clean(details.purpose, 8_000) || `${details.title} owns its selected share of ${source.title}.`, uncertainties: [...source.contract.uncertainties, `Split manually from ${source.title}; cross-boundary responsibilities require review.`] },
        fieldGrounding: Object.fromEntries(COMPONENT_DESIGN_FIELDS.map((field) => [field, grounding({ assumptions: [`This ${field} was inherited or revised during a human-reviewed split of ${source.title}.`] })])),
      }, catalogs, `split ${suffix}`);
      const first = make(operation.first || {}, firstMembers, 'first');
      const second = make(operation.second || {}, secondMembers, 'second');
      if (alternative.components.some((item) => item.id !== source.id && [first.slug, second.slug].includes(item.slug)) || first.slug === second.slug) fail('DUPLICATE_COMPONENT_SLUG', 'split candidates need unique slugs');
      const index = alternative.components.findIndex((item) => item.id === source.id);
      alternative.components.splice(index, 1, first, second);
      for (const component of alternative.components) {
        if (component.id === first.id || component.id === second.id) continue;
        component.contract.dependencies = component.contract.dependencies.flatMap((dependency) => (
          dependency.kind !== 'external' && dependency.target === source.slug
            ? [
                { ...dependency, kind: 'soft', target: first.slug, reason: `${dependency.reason} Redirected by reviewed split; verify the target.` },
                { ...dependency, kind: 'soft', target: second.slug, reason: `${dependency.reason} Redirected by reviewed split; verify the target.` },
              ]
            : [dependency]
        ));
      }
      alternative.components = alternative.components.map((component, order) => ({ ...component, order: order + 1 }));
      summary = `Split ${source.title} into ${first.title} and ${second.title}.`;
    } else if (kind === 'merge-components') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId);
      const ids = list(operation.componentIds, 40, 256);
      if (ids.length < 2) fail('INVALID_COMPONENT_MERGE', 'merge requires at least two component candidates');
      const sources = ids.map((componentId) => selectedComponent(alternative, componentId));
      if (sources.some((component) => component.lockedFields.length)) fail('LOCKED_COMPONENT_FIELD', 'unlock every field before merging components');
      const details = operation.component || {};
      const mergeLists = (field) => uniqueBy(sources.flatMap((component) => component.contract[field] || []), (item) => canonical(item));
      const merged = normalizeCandidate({
        id: stableId('component-candidate', 'merge', ...ids.sort()),
        slug: details.slug,
        title: details.title,
        origin: 'manual', order: Math.min(...sources.map((component) => component.order)),
        memberEntityIds: [...new Set(sources.flatMap((component) => component.memberEntityIds))],
        contract: {
          purpose: clean(details.purpose, 8_000) || `Unify ${sources.map((component) => component.title).join(', ')} under one reviewed responsibility.`,
          outcomes: mergeLists('outcomes'), responsibilities: mergeLists('responsibilities'), limits: mergeLists('limits'), invariants: mergeLists('invariants'),
          interfaces: mergeLists('interfaces'), dependencies: mergeLists('dependencies').filter((dependency) => !sources.some((source) => source.slug === dependency.target)),
          dataSystems: mergeLists('dataSystems'), territory: mergeLists('territory'), verification: mergeLists('verification'), evidence: mergeLists('evidence'),
          uncertainties: [...mergeLists('uncertainties'), `Merged manually from ${sources.map((component) => component.slug).join(', ')}; cohesion requires review.`],
          guidance: clean(details.guidance, 8_000) || `Treat the merged responsibilities as one delegation boundary only after reviewing coupling and limits.`,
        },
        fieldGrounding: Object.fromEntries(COMPONENT_DESIGN_FIELDS.map((field) => [field, grounding({
          evidenceIds: [...new Set(sources.flatMap((component) => component.fieldGrounding[field].evidenceIds))],
          intent: [...new Set(sources.flatMap((component) => component.fieldGrounding[field].intentIds))],
          assumptions: [`This ${field} combines human-selected candidates and requires review for accidental scope growth.`],
        })])),
        lockedFields: [],
      }, catalogs, 'merged component');
      if (alternative.components.some((item) => !ids.includes(item.id) && item.slug === merged.slug)) fail('DUPLICATE_COMPONENT_SLUG', `component slug '${merged.slug}' already exists`);
      const insertion = Math.min(...sources.map((source) => alternative.components.findIndex((item) => item.id === source.id)));
      alternative.components = alternative.components.filter((item) => !ids.includes(item.id));
      alternative.components.splice(insertion, 0, merged);
      for (const component of alternative.components) {
        if (component.id === merged.id) continue;
        component.contract.dependencies = uniqueBy(component.contract.dependencies.map((dependency) => (
          dependency.kind !== 'external' && sources.some((source) => source.slug === dependency.target)
            ? { ...dependency, target: merged.slug, reason: `${dependency.reason} Redirected by reviewed merge.` }
            : dependency
        )), (dependency) => `${dependency.kind}:${dependency.target}:${dependency.reason}`);
      }
      alternative.components = alternative.components.map((component, order) => ({ ...component, order: order + 1 }));
      summary = `Merged ${sources.map((component) => component.title).join(', ')} into ${merged.title}.`;
    } else if (kind === 'answer-question') {
      const question = draft.questions.find((item) => item.id === operation.questionId);
      if (!question) fail('DESIGN_QUESTION_NOT_FOUND', `design question '${operation.questionId}' was not found`);
      question.answer = clean(operation.answer, 4_096);
      question.state = question.answer ? 'answered' : 'open';
      if (question.answer && question.id === 'question:boundary-axis') {
        const preferred = /deploy|runtime|operat|release/i.test(question.answer) ? 'hybrid'
          : /responsib|domain|producto|product/i.test(question.answer) ? 'responsibility' : null;
        const alternative = preferred && draft.alternatives.find((item) => item.strategy === preferred);
        if (alternative) draft.selectedAlternativeId = alternative.id;
      }
      summary = question.answer ? `Answered: ${question.question}` : `Cleared answer: ${question.question}`;
    } else if (kind === 'skip') {
      draft.state = 'skipped';
      summary = 'Skipped component architecture design without repository mutation.';
    } else if (kind === 'resume') {
      draft.state = 'review';
      summary = 'Resumed component architecture review.';
    } else if (kind === 'regenerate') {
      if (!context) fail('COMPONENT_DESIGN_SOURCE_UNAVAILABLE', 'regeneration requires the original snapshot/map context');
      const fresh = synthesizeArchitectureAlternatives(normalizedContext, { includeModel: operation.includeModel !== false });
      const previousSelected = selectedAlternative(draft);
      const previousAlternatives = clone(draft.alternatives);
      const locks = previousSelected.components.flatMap((component) => component.lockedFields.map((field) => ({ slug: component.slug, field, value: clone(component.contract[field]), grounding: clone(component.fieldGrounding[field]) })));
      const answeredQuestions = draft.questions.filter((question) => question.state === 'answered' && question.answer);
      const answers = new Map(answeredQuestions.map((question) => [question.id, question.answer]));
      const alternatives = clone(fresh.alternatives);
      for (const alternative of alternatives) {
        for (const question of answeredQuestions) {
          alternative.rationale = [...alternative.rationale, `Human decision (${question.id}): ${question.answer}`];
        }
        for (const component of alternative.components) {
          for (const question of answeredQuestions) for (const field of question.affects) {
            component.fieldGrounding[field].assumptions = [...new Set([
              ...component.fieldGrounding[field].assumptions,
              `Human answer to ${question.id}: ${question.answer}`,
            ])];
          }
          for (const lock of locks.filter((item) => item.slug === component.slug)) {
            component.contract[lock.field] = lock.value;
            component.fieldGrounding[lock.field] = lock.grounding;
            component.lockedFields = [...new Set([...component.lockedFields, lock.field])];
          }
        }
      }
      draft.alternatives = alternatives;
      draft.selectedAlternativeId = alternatives.find((alternative) => alternative.strategy === previousSelected.strategy)?.id || alternatives[0].id;
      draft.questions = designQuestions(normalizedContext, alternatives).map((question) => answers.has(question.id) ? { ...question, state: 'answered', answer: answers.get(question.id) } : question);
      draft.source = sourceRecord(normalizedContext);
      draft.lockedDecisions = draft.lockedDecisions.filter((decision) => alternatives.some((alternative) => alternative.components.some((component) => component.slug === decision.componentSlug && component.lockedFields.includes(decision.field))));
      const changes = alternatives.map((alternative) => {
        const previous = previousAlternatives.find((item) => item.strategy === alternative.strategy);
        return previous ? { strategy: alternative.strategy, ...alternativeDiff(previous, alternative) } : {
          strategy: alternative.strategy, addedAlternative: true, materiallyDifferent: true,
        };
      });
      const removedStrategies = previousAlternatives.filter((previous) => !alternatives.some((alternative) => alternative.strategy === previous.strategy)).map((item) => item.strategy);
      const materialChanges = changes.filter((change) => change.materiallyDifferent).length + removedStrategies.length;
      historyDetails = { changes, removedStrategies, materialChanges, preservedLocks: locks.length, preservedAnswers: answers.size };
      summary = materialChanges
        ? `Regenerated ${alternatives.length} alternative(s) with ${materialChanges} material strategy change(s), preserving ${locks.length} locked field decision(s) and ${answers.size} answer(s).`
        : `Regenerated ${alternatives.length} stable alternative(s) with no material boundary change.`;
    } else {
      fail('UNSUPPORTED_COMPONENT_DESIGN_OPERATION', `unsupported component design operation '${kind}'`);
    }

    for (const alternative of draft.alternatives) {
      alternative.components = alternative.components.map((component, index) => ({ ...component, order: index + 1 }));
      validateAlternativeReferences(alternative);
      if (normalizedContext?.map) alternative.quality = evaluateArchitectureAlternative(alternative.components, normalizedContext.map);
      else if (structuralOperation.has(kind)) alternative.quality = markQualityContextUnavailable(alternative.quality);
    }
    const afterRevision = draftRevision(draft);
    draft.history.push({
      id: stableId('history', draft.id, beforeRevision, afterRevision, kind),
      at: new Date(this.now()).toISOString(), operation: kind, summary, beforeRevision, afterRevision,
      ...(historyDetails ? { details: historyDetails } : {}),
    });
    this.#save(draft);
    return publicDraft(draft, normalizedContext);
  }

  delete(repositoryId, id) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repositoryId) fail('COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'component design draft does not belong to this repository');
    rmSync(this.#path(id), { force: true });
    return { deleted: id };
  }

  deleteRepository(repositoryId) {
    for (const draft of this.list(repositoryId)) rmSync(this.#path(draft.id), { force: true });
  }
}

export function componentDesignFailure(error) {
  if (error instanceof ComponentDesignError) return error;
  return new ComponentDesignError('COMPONENT_DESIGN_INTERNAL', String(error?.message || error || 'component design failed'), { cause: error });
}
