import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { validateAnalysisSnapshot } from './intelligence/contracts.mjs';
import { summarizeSystemMap } from './intelligence/system-map.mjs';
import { validatePlanningResult } from './planning/contracts.mjs';
import { normalizeProductBrief } from './product-direction.mjs';
import {
  EVIDENCE_PROVENANCE, FRONT_DEPENDENCY_KINDS, FRONT_STATES,
  createFrontMarkdown, parseFrontContract,
} from './work-contracts.mjs';

export const FRONT_DESIGN_SCHEMA_VERSION = 1;
export const FRONT_DESIGN_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const FRONT_DESIGN_STATES = Object.freeze(['review', 'skipped']);
export const FRONT_PLAN_STRATEGIES = Object.freeze(['outcome-slices', 'risk-first', 'existing', 'model', 'manual']);
export const FRONT_CANDIDATE_KINDS = Object.freeze(['implementation', 'research', 'decision', 'validation', 'migration']);
export const FRONT_DESIGN_FIELDS = Object.freeze([
  'outcome', 'leadComponent', 'affectedComponents', 'motivation', 'scope', 'nonGoals', 'dependencies',
  'readiness', 'acceptanceCriteria', 'verification', 'deliverables', 'risks', 'unknowns', 'evidence',
  'tasks', 'context', 'handoff',
]);

const DRAFT_ID = /^[a-f0-9-]{36}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const STATES = new Set(FRONT_DESIGN_STATES);
const STRATEGIES = new Set(FRONT_PLAN_STRATEGIES);
const CANDIDATE_KINDS = new Set(FRONT_CANDIDATE_KINDS);
const FRONT_STATE = new Set(FRONT_STATES);
const DEPENDENCY_KIND = new Set(FRONT_DEPENDENCY_KINDS);
const PROVENANCE = new Set(EVIDENCE_PROVENANCE);
const FIELDS = new Set(FRONT_DESIGN_FIELDS);
const REQUIRED_LIST_FIELDS = ['nonGoals', 'readiness', 'acceptanceCriteria', 'verification', 'deliverables', 'risks', 'unknowns', 'evidence', 'tasks'];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clean(value, limit = 8_000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function inline(value, limit = 256) { return clean(value, limit).replace(/\s+/g, ' '); }

function list(value, limit = 100, itemLimit = 2_000) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function stableId(prefix, ...parts) { return `${prefix}:${sha256(parts.join('\0')).slice(0, 24)}`; }

function slugify(value, fallback = 'front') {
  const result = inline(value, 256).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  const candidate = result || fallback;
  return candidate.length > 1 && candidate.endsWith('-') ? candidate.slice(0, -1) : candidate;
}

function uniqueBy(items, selector) {
  const seen = new Set();
  return items.filter((item) => {
    const key = selector(item);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
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

export class FrontDesignError extends Error {
  constructor(code, message, { details = null, diagnostics = [], cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FrontDesignError'; this.code = code; this.details = details; this.diagnostics = diagnostics;
  }

  toJSON() { return { error: this.message, code: this.code, details: this.details, diagnostics: this.diagnostics }; }
}

function fail(code, message, details = null) { throw new FrontDesignError(code, message, { details }); }

function productCatalog(product) {
  const source = product?.brief || product;
  if (!source) return { brief: null, revision: null, goals: new Map(), goalIds: new Set() };
  const brief = normalizeProductBrief(source);
  const goals = new Map((brief.goals || []).map((goal) => [goal.id, goal]));
  return { brief, revision: product?.revision || sha256(canonical(brief)), goals, goalIds: new Set(goals.keys()) };
}

function normalizedManualGoal(value) {
  const input = value && typeof value === 'object' ? value : {};
  const title = inline(input.title || input.outcome, 240);
  const outcome = clean(input.outcome || input.title, 4_096);
  if (!title || !outcome) fail('FRONT_DESIGN_GOAL_REQUIRED', 'choose an accepted product goal or provide a manual goal title and outcome');
  const id = inline(input.id, 128) || `goal:manual-${slugify(title)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(id)) fail('INVALID_FRONT_DESIGN_GOAL', 'manual goal id contains unsupported characters');
  return {
    id,
    title, outcome, priority: 'unspecified', state: 'proposed', successSignals: list(input.successSignals, 30),
    constraintIds: [], repositoryIds: [], sourceIds: ['source:human'], locked: false, order: 1,
    manual: true,
  };
}

function componentPortfolioRevision(components) {
  return sha256(canonical(components.map((component) => ({
    id: component.id, slug: component.slug, order: component.order, contract: component.contract,
    memberEntityIds: component.memberEntityIds, lockedFields: component.lockedFields,
  }))));
}

function acceptedPortfolioRevision(portfolio) {
  return sha256(canonical({
    components: (portfolio?.components || []).map((item) => ({ slug: item.slug, state: item.state, contract: item.contract })),
    fronts: (portfolio?.fronts || []).map((item) => ({ slug: item.slug, state: item.state, component: item.component, updated: item })),
  }));
}

function contextIdentity(context) {
  return sha256(`handraise-front-design-context-v1\0${canonical({
    repository: context.snapshot.repository, snapshotId: context.snapshot.id, mapId: context.map.id,
    componentDraftId: context.componentDraft.id, componentDraftRevision: context.componentDraft.revision,
    componentAlternativeId: context.componentAlternative.id,
    componentDraftStale: Boolean(context.componentDraft.stale),
    componentRevision: componentPortfolioRevision(context.componentAlternative.components),
    goal: context.goal, productRevision: context.productCatalog.revision,
    portfolioRevision: acceptedPortfolioRevision(context.portfolio), planningJobId: context.planningJobId,
    planningResult: context.planningResult ? sha256(canonical(context.planningResult)) : null,
  })}`);
}

function referenceCatalog(context) {
  const references = new Set([context.snapshot.id, context.map.id]);
  for (const item of context.map.evidence) references.add(item.id);
  for (const group of context.map.groups) references.add(group.id);
  for (const component of context.componentAlternative.components) for (const evidence of component.contract.evidence || []) {
    if (evidence.reference) references.add(evidence.reference);
  }
  for (const id of context.modelEvidenceIds || []) references.add(id);
  return references;
}

export function normalizeFrontDesignContext(value) {
  if (!value || typeof value !== 'object') fail('INVALID_FRONT_DESIGN_CONTEXT', 'front design context must be an object');
  const snapshot = validateAnalysisSnapshot(value.snapshot);
  const map = value.map;
  const mapSummary = summarizeSystemMap(map);
  if (mapSummary.snapshotId !== snapshot.id) fail('FRONT_MAP_SNAPSHOT_MISMATCH', 'system map and analysis snapshot identities do not match');
  const componentDraft = value.componentDraft;
  if (!componentDraft || componentDraft.repositoryId !== snapshot.repository.id || !componentDraft.revision) {
    fail('FRONT_COMPONENT_DRAFT_MISMATCH', 'a current component-design draft from this repository is required');
  }
  const componentAlternativeId = inline(value.componentAlternativeId || componentDraft.selectedAlternativeId, 256);
  const componentAlternative = componentDraft.alternatives?.find((alternative) => alternative.id === componentAlternativeId);
  if (!componentAlternative || !componentAlternative.components?.length) fail('FRONT_COMPONENT_ALTERNATIVE_NOT_FOUND', 'the selected component architecture is unavailable');
  const product = productCatalog(value.product);
  const goal = value.goalId ? product.goals.get(inline(value.goalId, 128)) : normalizedManualGoal(value.goal);
  if (!goal) fail('FRONT_DESIGN_GOAL_NOT_FOUND', `accepted product goal '${value.goalId}' was not found`);
  const modelEvidenceIds = list(value.modelEvidenceIds, 5_000, 512);
  const planningResult = value.planningResult ? validatePlanningResult(value.planningResult, {
    operation: 'front-design', evidenceIds: modelEvidenceIds.length ? modelEvidenceIds : value.planningResult.fronts?.flatMap((item) => item.evidenceIds || []) || [],
  }) : null;
  const context = {
    repository: snapshot.repository,
    analysisJobId: inline(value.analysisJobId, 256), planningJobId: inline(value.planningJobId, 256) || null,
    snapshot, map, componentDraft, componentAlternative,
    product: value.product || null, productCatalog: product, goal,
    portfolio: value.portfolio || { components: [], fronts: [] }, planningResult, modelEvidenceIds,
  };
  if (!context.analysisJobId) fail('INVALID_FRONT_DESIGN_CONTEXT', 'analysisJobId is required');
  context.identity = contextIdentity(context);
  return context;
}

function catalogsFor(context) {
  const goalIds = new Set([...context.productCatalog.goalIds, context.goal.id]);
  return {
    references: referenceCatalog(context), goalIds,
    componentSlugs: new Set(context.componentAlternative.components.map((component) => component.slug)),
  };
}

function grounding(value, catalogs, label) {
  const input = value && typeof value === 'object' ? value : {};
  const result = {
    evidenceIds: list(input.evidenceIds, 100, 512), goalIds: list(input.goalIds, 50, 128),
    componentSlugs: list(input.componentSlugs, 50, 128), assumptions: list(input.assumptions, 50), questions: list(input.questions, 50),
  };
  for (const id of result.evidenceIds) if (!catalogs.references.has(id)) fail('UNKNOWN_FRONT_EVIDENCE', `${label} references unknown evidence '${id}'`);
  for (const id of result.goalIds) if (!catalogs.goalIds.has(id)) fail('UNKNOWN_FRONT_GOAL', `${label} references unknown goal '${id}'`);
  for (const slug of result.componentSlugs) if (!catalogs.componentSlugs.has(slug)) fail('UNKNOWN_FRONT_COMPONENT', `${label} references unknown component '${slug}'`);
  if (!result.evidenceIds.length && !result.goalIds.length && !result.componentSlugs.length && !result.assumptions.length && !result.questions.length) {
    fail('UNGROUNDED_FRONT_FIELD', `${label} must cite evidence, goal/component intent or expose an assumption/question`);
  }
  return result;
}

function defaultGrounding({ evidenceIds = [], goalIds = [], componentSlugs = [], assumptions = [], questions = [] } = {}) {
  const result = { evidenceIds: list(evidenceIds), goalIds: list(goalIds), componentSlugs: list(componentSlugs), assumptions: list(assumptions), questions: list(questions) };
  if (!result.evidenceIds.length && !result.goalIds.length && !result.componentSlugs.length && !result.assumptions.length && !result.questions.length) {
    result.assumptions.push('This field requires explicit human confirmation.');
  }
  return result;
}

function dependency(value, label) {
  const input = value && typeof value === 'object' ? value : {};
  const kind = inline(input.kind, 64);
  const rawTarget = inline(input.target, 128);
  const target = rawTarget ? slugify(rawTarget) : '';
  const reason = clean(input.reason, 2_000);
  if (!DEPENDENCY_KIND.has(kind) || !target || !reason) fail('INVALID_FRONT_DEPENDENCY', `${label} needs hard/coordination/informational kind, target and reason`);
  return { kind, target, reason };
}

function evidence(value, references, label) {
  const input = value && typeof value === 'object' ? value : {};
  const kind = inline(input.kind, 64);
  const reference = inline(input.reference, 512);
  const reason = clean(input.reason, 2_000);
  if (!PROVENANCE.has(kind) || !references.has(reference) || !reason) fail('INVALID_FRONT_EVIDENCE', `${label} needs a valid provenance, allowlisted reference and reason`);
  return { kind, reference, reason };
}

function task(value, label) {
  const input = typeof value === 'string' ? { text: value } : value || {};
  const state = ['open', 'done', 'skipped'].includes(input.state) ? input.state : 'open';
  const text = clean(input.text, 2_000);
  if (!text) fail('INVALID_FRONT_TASK', `${label} needs text`);
  return { state, text };
}

function normalizeCandidate(value, catalogs, { label = 'front', allowInvalidReferences = false } = {}) {
  if (!value || typeof value !== 'object') fail('INVALID_FRONT_CANDIDATE', `${label} must be an object`);
  const slug = slugify(value.slug || value.title);
  const title = inline(value.title, 200);
  const rawLeadComponent = inline(value.leadComponent || value.component, 128);
  const leadComponent = rawLeadComponent ? slugify(rawLeadComponent) : '';
  const affectedComponents = list(value.affectedComponents, 50, 128).map((item) => slugify(item)).filter((item) => item !== leadComponent);
  const goalIds = list(value.goalIds, 50, 128);
  if (!SLUG.test(slug) || !title || !leadComponent) fail('INVALID_FRONT_CANDIDATE', `${label} needs a kebab-case slug, title and one lead component`);
  if (!allowInvalidReferences && !catalogs.componentSlugs.has(leadComponent)) fail('UNKNOWN_FRONT_COMPONENT', `${label} lead component '${leadComponent}' is not in the selected architecture`);
  if (!allowInvalidReferences) for (const component of affectedComponents) if (!catalogs.componentSlugs.has(component)) fail('UNKNOWN_FRONT_COMPONENT', `${label} affected component '${component}' is not in the selected architecture`);
  if (!goalIds.length) fail('INCOMPLETE_FRONT_CANDIDATE', `${label}.goalIds needs at least one goal`);
  if (!allowInvalidReferences) for (const goalId of goalIds) if (!catalogs.goalIds.has(goalId)) fail('UNKNOWN_FRONT_GOAL', `${label} references unknown goal '${goalId}'`);
  const result = {
    id: inline(value.id, 256) || stableId('front-candidate', slug), slug, title,
    state: FRONT_STATE.has(value.state) ? value.state : 'queued',
    order: Number.isSafeInteger(Number(value.order)) && Number(value.order) > 0 ? Number(value.order) : 99,
    origin: ['generated', 'accepted', 'model', 'manual'].includes(value.origin) ? value.origin : 'generated',
    candidateKind: CANDIDATE_KINDS.has(value.candidateKind) ? value.candidateKind : 'implementation',
    leadComponent, affectedComponents: [...new Set(affectedComponents)], goalIds,
    analysisSnapshot: inline(value.analysisSnapshot, 128) || null,
    outcome: clean(value.outcome, 8_000), motivation: clean(value.motivation, 8_000), scope: clean(value.scope, 12_000),
    nonGoals: list(value.nonGoals, 50), readiness: list(value.readiness, 80), acceptanceCriteria: list(value.acceptanceCriteria, 80),
    verification: list(value.verification, 80), deliverables: list(value.deliverables, 80), risks: list(value.risks, 80), unknowns: list(value.unknowns, 80),
    dependencies: (Array.isArray(value.dependencies) ? value.dependencies : []).slice(0, 100).map((item, index) => dependency(item, `${label}.dependencies[${index}]`)),
    evidence: (Array.isArray(value.evidence) ? value.evidence : []).slice(0, 200).map((item, index) => evidence(item, catalogs.references, `${label}.evidence[${index}]`)),
    context: clean(value.context, 12_000), handoff: clean(value.handoff, 12_000),
    tasks: (Array.isArray(value.tasks) ? value.tasks : []).slice(0, 120).map((item, index) => task(item, `${label}.tasks[${index}]`)),
    fieldGrounding: {}, lockedFields: list(value.lockedFields, FRONT_DESIGN_FIELDS.length, 64),
  };
  for (const field of result.lockedFields) if (!FIELDS.has(field)) fail('INVALID_FRONT_LOCK', `${label} contains unknown lock '${field}'`);
  for (const field of ['outcome', 'motivation', 'scope', 'context', 'handoff']) if (!result[field]) fail('INCOMPLETE_FRONT_CANDIDATE', `${label}.${field} is required`);
  for (const field of REQUIRED_LIST_FIELDS) if (!result[field].length) fail('INCOMPLETE_FRONT_CANDIDATE', `${label}.${field} needs at least one explicit item`);
  const fieldInput = value.fieldGrounding && typeof value.fieldGrounding === 'object' ? value.fieldGrounding : {};
  for (const field of FRONT_DESIGN_FIELDS) result.fieldGrounding[field] = grounding(fieldInput[field], catalogs, `${label}.fieldGrounding.${field}`);
  const roundTrip = parseFrontContract(createFrontMarkdown({
    slug: result.slug, title: result.title, state: result.state, component: result.leadComponent,
    affectedComponents: result.affectedComponents, goalIds: result.goalIds, analysisSnapshot: result.analysisSnapshot,
    outcome: result.outcome, motivation: result.motivation, scope: result.scope, nonGoals: result.nonGoals,
    readiness: result.readiness, acceptanceCriteria: result.acceptanceCriteria, verification: result.verification,
    deliverables: result.deliverables, risks: [...result.risks, ...result.unknowns.map((item) => `[Unknown] ${item}`)],
    dependencies: result.dependencies, evidence: result.evidence, context: result.context, handoff: result.handoff, tasks: result.tasks,
  }));
  if (roundTrip.slug !== result.slug || roundTrip.schemaVersion !== 2) fail('FRONT_CONTRACT_ROUNDTRIP', `${label} cannot serialize as a front v2 contract`);
  return result;
}

function hardGraph(fronts) {
  const known = new Set(fronts.map((front) => front.slug));
  return new Map(fronts.map((front) => [front.slug, front.dependencies.filter((item) => item.kind === 'hard' && known.has(item.target)).map((item) => item.target)]));
}

function dependencyCycles(fronts) {
  const edges = hardGraph(fronts); const visiting = new Set(); const visited = new Set(); const stack = []; const cycles = [];
  const visit = (slug) => {
    if (visiting.has(slug)) { const start = stack.indexOf(slug); cycles.push([...stack.slice(start), slug]); return; }
    if (visited.has(slug)) return;
    visiting.add(slug); stack.push(slug);
    for (const target of edges.get(slug) || []) visit(target);
    stack.pop(); visiting.delete(slug); visited.add(slug);
  };
  for (const slug of edges.keys()) visit(slug);
  return uniqueBy(cycles, (cycle) => [...new Set(cycle)].sort().join('|'));
}

function criticalPath(fronts) {
  const edges = hardGraph(fronts); const memo = new Map();
  const path = (slug, trail = new Set()) => {
    if (memo.has(slug)) return memo.get(slug);
    if (trail.has(slug)) return [slug];
    const nextTrail = new Set([...trail, slug]);
    const options = (edges.get(slug) || []).map((target) => path(target, nextTrail));
    const longest = options.sort((left, right) => right.length - left.length)[0] || [];
    const result = [...longest, slug]; memo.set(slug, result); return result;
  };
  return [...edges.keys()].map((slug) => path(slug)).sort((left, right) => right.length - left.length)[0] || [];
}

function territoryOverlap(left, right, componentBySlug) {
  const paths = (front) => [front.leadComponent, ...front.affectedComponents].flatMap((slug) => componentBySlug.get(slug)?.contract?.territory || []);
  const leftPaths = paths(left); const rightPaths = paths(right);
  return leftPaths.filter((leftPath) => rightPaths.some((rightPath) => leftPath === rightPath || leftPath.startsWith(`${rightPath.replace(/\/$/, '')}/`) || rightPath.startsWith(`${leftPath.replace(/\/$/, '')}/`))).slice(0, 20);
}

function reaches(edges, source, target, seen = new Set()) {
  if (source === target) return true;
  if (seen.has(source)) return false;
  seen.add(source);
  return (edges.get(source) || []).some((next) => reaches(edges, next, target, seen));
}

export function evaluateFrontPlanAlternative(fronts, contextValue) {
  const context = contextValue?.componentAlternative ? contextValue : normalizeFrontDesignContext(contextValue);
  const componentBySlug = new Map(context.componentAlternative.components.map((component) => [component.slug, component]));
  const knownFronts = new Set(fronts.map((front) => front.slug));
  const diagnostics = [];
  for (const [index, front] of fronts.entries()) {
    if (!componentBySlug.has(front.leadComponent)) diagnostics.push({ code: 'UNKNOWN_LEAD_COMPONENT', severity: 'error', path: `fronts[${index}].leadComponent`, message: `${front.slug} references unknown lead component '${front.leadComponent}'.` });
    for (const affected of front.affectedComponents) if (!componentBySlug.has(affected)) diagnostics.push({ code: 'UNKNOWN_AFFECTED_COMPONENT', severity: 'error', path: `fronts[${index}].affectedComponents`, message: `${front.slug} references unknown affected component '${affected}'.` });
    for (const dependency of front.dependencies) if (!knownFronts.has(dependency.target)) diagnostics.push({ code: 'UNKNOWN_FRONT_DEPENDENCY', severity: 'error', path: `fronts[${index}].dependencies`, message: `${front.slug} references unknown dependency '${dependency.target}'.` });
    if (!front.goalIds.includes(context.goal.id)) diagnostics.push({ code: 'UNCOVERED_SELECTED_GOAL', severity: 'error', path: `fronts[${index}].goalIds`, message: `${front.slug} does not link the selected goal '${context.goal.id}'.` });
  }
  const outcomeOwners = new Map();
  for (const front of fronts) {
    const key = front.outcome.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!outcomeOwners.has(key)) outcomeOwners.set(key, []);
    outcomeOwners.get(key).push(front.slug);
  }
  const duplicateOutcomes = [...outcomeOwners.entries()].filter(([, owners]) => owners.length > 1).map(([outcome, owners]) => ({ outcome, owners }));
  if (duplicateOutcomes.length) diagnostics.push({ code: 'DUPLICATE_FRONT_OUTCOME', severity: 'warning', path: 'fronts', message: `${duplicateOutcomes.length} outcome statement(s) are duplicated.` });
  const cycles = dependencyCycles(fronts);
  if (cycles.length) diagnostics.push({ code: 'HARD_FRONT_DEPENDENCY_CYCLE', severity: 'error', path: 'fronts', message: `${cycles.length} hard dependency cycle(s) block execution.`, details: { cycles } });
  const broadFronts = fronts.filter((front) => front.affectedComponents.length > 4 || front.tasks.length > 12 || front.verification.every((item) => /define|decide|review.*before/i.test(item))).map((front) => front.slug);
  if (broadFronts.length) diagnostics.push({ code: 'FRONT_TOO_BROAD_TO_VERIFY', severity: 'warning', path: 'fronts', message: `${broadFronts.length} front(s) need a narrower or executable verification boundary.`, details: { fronts: broadFronts } });
  const edges = hardGraph(fronts);
  const active = fronts.filter((front) => front.state !== 'done');
  const readySet = active.filter((front) => !(edges.get(front.slug) || []).some((target) => fronts.find((item) => item.slug === target)?.state !== 'done')).map((front) => front.slug);
  const collisions = [];
  const safeConcurrency = [];
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
    const left = active[leftIndex]; const right = active[rightIndex];
    const leftOwners = new Set([left.leadComponent, ...left.affectedComponents]);
    const sharedComponents = [right.leadComponent, ...right.affectedComponents].filter((slug) => leftOwners.has(slug));
    const sharedTerritory = territoryOverlap(left, right, componentBySlug);
    const dependencyRelated = reaches(edges, left.slug, right.slug) || reaches(edges, right.slug, left.slug);
    if (sharedComponents.length || sharedTerritory.length) collisions.push({ left: left.slug, right: right.slug, sharedComponents, sharedTerritory });
    else if (!dependencyRelated) safeConcurrency.push({ left: left.slug, right: right.slug });
  }
  const coveredGoalIds = [...new Set(fronts.flatMap((front) => front.goalIds))];
  const hardFailures = diagnostics.filter((item) => item.severity === 'error').length;
  return deepFreeze({
    goalCoverage: { selectedGoalId: context.goal.id, covered: fronts.some((front) => front.goalIds.includes(context.goal.id)), coveredGoalIds, uncoveredGoalIds: fronts.some((front) => front.goalIds.includes(context.goal.id)) ? [] : [context.goal.id] },
    duplicateOutcomes, dependencyCycles: cycles, readySet, criticalPath: criticalPath(fronts),
    parallelism: { safePairs: safeConcurrency, collisions, maximumReady: readySet.length },
    broadFronts, diagnostics,
    feedback: { firstOutcomeDepth: criticalPath(fronts).length ? 1 : 0, criticalPathLength: criticalPath(fronts).length, independentOutcomeSlices: readySet.length },
    risk: { explicitRisks: fronts.reduce((sum, front) => sum + front.risks.length, 0), explicitUnknowns: fronts.reduce((sum, front) => sum + front.unknowns.length, 0) },
    gateD: { pass: hardFailures === 0 && !broadFronts.length && fronts.length > 0, hardFailures, statement: 'Automated executable-plan gate only; human usefulness remains a separate review decision.' },
  });
}

function componentEvidence(component, context) {
  const allowed = referenceCatalog(context);
  const ids = [...new Set([
    ...(component.contract.evidence || []).map((item) => item.reference),
    ...Object.values(component.fieldGrounding || {}).flatMap((item) => item.evidenceIds || []),
  ])].filter((id) => allowed.has(id));
  return ids.length ? ids.slice(0, 30) : [context.snapshot.id];
}

function componentRelevance(component, goal) {
  const words = new Set(`${goal.title} ${goal.outcome}`.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3));
  const text = `${component.title} ${component.contract.purpose} ${component.contract.outcomes.join(' ')} ${component.contract.responsibilities.join(' ')}`.toLocaleLowerCase();
  return [...words].filter((word) => text.includes(word)).length * 10 + Math.max(0, 10 - component.order);
}

function testEvidence(component, context) {
  const members = new Set(component.memberEntityIds);
  const tests = context.map.entities.filter((entity) => /test|spec/i.test(`${entity.kind} ${entity.location?.path || ''}`) && (
    members.has(entity.id) || context.map.relations.some((relation) => (members.has(relation.source) && relation.target === entity.id) || (members.has(relation.target) && relation.source === entity.id))
  ));
  return {
    checks: tests.map((entity) => `Use observed verification evidence at ${entity.location?.path || entity.name}.`).slice(0, 10),
    evidenceIds: [...new Set(tests.flatMap((entity) => entity.evidenceIds || []))].slice(0, 30),
  };
}

function candidateGrounding(component, context, evidenceIds, verificationEvidence, unknownQuestion = null) {
  const common = { evidenceIds, goalIds: [context.goal.id], componentSlugs: [component.slug] };
  return Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, defaultGrounding({
    ...common,
    evidenceIds: field === 'verification' && verificationEvidence.length ? verificationEvidence : common.evidenceIds,
    assumptions: field === 'verification' && !verificationEvidence.length ? ['No executable check was observed; verification must be resolved before readiness.'] : [],
    questions: field === 'unknowns' && unknownQuestion ? [unknownQuestion] : [],
  })]));
}

function implementationCandidate(component, index, context, { prefix = '', hardDependency = null, plannedComponentSlugs = new Set() } = {}) {
  const evidenceIds = componentEvidence(component, context);
  const tests = testEvidence(component, context);
  const unknownQuestion = component.contract.uncertainties?.find((item) => !/^No material uncertainty/i.test(item)) || null;
  const title = `${prefix}${component.title} outcome slice`.trim();
  const slug = slugify(`${prefix}${component.slug}-outcome`);
  const verification = tests.checks.length ? tests.checks : (component.contract.verification?.length ? component.contract.verification : ['Define one executable acceptance check before this front becomes ready.']);
  return {
    id: stableId('front-candidate', 'outcome', context.identity, component.slug, prefix), slug, title, state: 'queued', order: index + 1,
    origin: 'generated', candidateKind: 'implementation', leadComponent: component.slug, affectedComponents: [], goalIds: [context.goal.id], analysisSnapshot: context.snapshot.id,
    outcome: `${context.goal.outcome} — ${component.title} delivers its independently reviewable responsibility.`,
    motivation: `${component.title} is a selected ownership boundary needed to advance ${context.goal.title}.`,
    scope: `Deliver the smallest reviewable behavior inside ${component.title}: ${component.contract.responsibilities.slice(0, 3).join(' ')}`,
    nonGoals: [...component.contract.limits.slice(0, 3), 'Do not allocate a worktree or start an agent during planning.'],
    dependencies: [
      ...(hardDependency ? [{ kind: 'hard', target: hardDependency, reason: 'Resolve the explicit unknown before implementation commits to this boundary.' }] : []),
      ...component.contract.dependencies
        .filter((item) => item.kind !== 'external' && item.target !== component.slug && plannedComponentSlugs.has(item.target))
        .slice(0, 4)
        .map((item) => ({ kind: 'coordination', target: slugify(`${prefix}${item.target}-outcome`), reason: `Coordinate the component relationship: ${item.reason}` })),
    ],
    readiness: [hardDependency ? `The decision in ${hardDependency} is complete.` : 'The selected component boundary and product goal are still current.', 'Acceptance and verification evidence are reviewable before execution.'],
    acceptanceCriteria: [`A reviewer can observe how ${component.title} advances: ${context.goal.outcome}`, `Changes remain inside ${component.title}'s accepted limits or record explicit coordination.`],
    verification,
    deliverables: [`A reviewable ${component.title} outcome increment.`, 'Recorded acceptance evidence tied to this front.'],
    risks: [`The selected architecture boundary may change while implementing ${context.goal.title}.`],
    unknowns: [unknownQuestion || 'No material implementation unknown is currently evidenced; discoveries must be recorded rather than hidden.'],
    evidence: evidenceIds.map((id) => ({ kind: 'inferred', reference: id, reason: `Supports the selected ${component.title} responsibility and goal slice.` })),
    context: `Selected goal: ${context.goal.title}. Selected component: ${component.title}. This is proposed work, not an execution allocation.`,
    handoff: `Produce the observable outcome and its acceptance evidence. Stop and create a decision/research front if a new boundary unknown invalidates the reviewed scope.`,
    tasks: [
      { state: 'open', text: 'Confirm current goal, component limits and dependencies.' },
      { state: 'open', text: 'Implement the smallest independently reviewable outcome slice.' },
      { state: 'open', text: 'Run or establish the reviewed verification evidence.' },
      { state: 'open', text: 'Record acceptance evidence and any architecture discovery.' },
    ],
    fieldGrounding: candidateGrounding(component, context, evidenceIds, tests.evidenceIds, unknownQuestion), lockedFields: [],
  };
}

function decisionCandidate(components, context, strategy) {
  const lead = components[0];
  const evidenceIds = [...new Set(components.flatMap((component) => componentEvidence(component, context)))].slice(0, 40);
  const uncertainty = components.flatMap((component) => component.contract.uncertainties || []).find((item) => !/^No material uncertainty/i.test(item))
    || `Which component boundary should own the riskiest cross-cutting part of ${context.goal.title}?`;
  const slug = slugify(`${strategy}-decision-${context.goal.title}`);
  const groundingMap = Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, defaultGrounding({ evidenceIds, goalIds: [context.goal.id], componentSlugs: components.map((item) => item.slug), questions: [uncertainty] })]));
  return {
    id: stableId('front-candidate', strategy, 'decision', context.identity), slug, title: `Resolve ${context.goal.title} boundary risk`, state: 'queued', order: 1,
    origin: 'generated', candidateKind: 'decision', leadComponent: lead.slug, affectedComponents: components.slice(1).map((item) => item.slug), goalIds: [context.goal.id], analysisSnapshot: context.snapshot.id,
    outcome: `A recorded, evidence-backed decision removes the highest-impact unknown blocking ${context.goal.outcome}`,
    motivation: 'An explicit decision front prevents an architecture assumption from hiding inside implementation tasks.',
    scope: `Resolve this question using existing evidence and the selected component model: ${uncertainty}`,
    nonGoals: ['Do not implement the downstream product behavior.', 'Do not publish component/front contracts from this private workspace.'], dependencies: [],
    readiness: ['The question, affected components and decision owner are explicit.'],
    acceptanceCriteria: ['One decision and rationale are recorded.', 'Affected component ownership and downstream readiness are unambiguous.'],
    verification: ['Review the decision against cited map/component evidence and accepted product constraints.'],
    deliverables: ['A decision with evidence, rejected alternatives and downstream implications.'],
    risks: ['Insufficient evidence may require a separate bounded research front.'], unknowns: [uncertainty],
    evidence: evidenceIds.map((id) => ({ kind: 'inferred', reference: id, reason: 'Evidence selected for the boundary decision.' })),
    context: `This decision gates implementation for ${context.goal.title}; it is not an implementation checklist item.`,
    handoff: 'Resolve or explicitly escalate the question. Update downstream readiness rather than guessing.',
    tasks: [{ state: 'open', text: 'State the decision question and viable alternatives.' }, { state: 'open', text: 'Review cited product and system evidence.' }, { state: 'open', text: 'Record the decision, rationale and rejected alternatives.' }],
    fieldGrounding: groundingMap, lockedFields: [],
  };
}

function validationCandidate(implementations, components, context, strategy) {
  const lead = components[0];
  const evidenceIds = [...new Set(components.flatMap((component) => componentEvidence(component, context)))].slice(0, 40);
  const checks = uniqueBy(components.flatMap((component) => testEvidence(component, context).checks.length ? testEvidence(component, context).checks : component.contract.verification || []), (item) => item).slice(0, 20);
  const slug = slugify(`${strategy}-validate-${context.goal.title}`);
  return {
    id: stableId('front-candidate', strategy, 'validation', context.identity), slug, title: `Validate ${context.goal.title} outcome`, state: 'queued', order: 99,
    origin: 'generated', candidateKind: 'validation', leadComponent: lead.slug, affectedComponents: components.slice(1).map((item) => item.slug), goalIds: [context.goal.id], analysisSnapshot: context.snapshot.id,
    outcome: `Acceptance evidence demonstrates the complete outcome: ${context.goal.outcome}`,
    motivation: 'Independent slices need one explicit product-level proof; agent completion messages are not acceptance.',
    scope: 'Collect and review end-to-end evidence across the selected implementation slices.',
    nonGoals: ['Do not hide implementation work inside validation.', 'Do not accept evidence that only states an agent finished.'],
    dependencies: implementations.map((front) => ({ kind: 'hard', target: front.slug, reason: `Product-level validation requires the ${front.title} outcome.` })),
    readiness: ['Every required implementation outcome has accepted evidence.'],
    acceptanceCriteria: [...(context.goal.successSignals || []).slice(0, 5), `A reviewer can demonstrate: ${context.goal.outcome}`].filter(Boolean),
    verification: checks.length ? checks : ['Define a feasible product-level check before this validation front becomes ready.'],
    deliverables: ['A product-level acceptance record linked to every required front.'],
    risks: ['Component-level checks may pass while the product outcome still fails.'],
    unknowns: ['Whether current component checks cover the complete user/system journey must be confirmed.'],
    evidence: evidenceIds.map((id) => ({ kind: 'inferred', reference: id, reason: 'Connects component evidence to the product-level validation plan.' })),
    context: `Final feedback boundary for ${context.goal.title}; depends only on reviewed outcome slices.`,
    handoff: 'Validate the observable outcome, attach evidence and reopen the owning front when proof fails.',
    tasks: [{ state: 'open', text: 'Confirm prerequisite front evidence.' }, { state: 'open', text: 'Execute or observe the reviewed product-level verification.' }, { state: 'open', text: 'Record pass/fail evidence against each acceptance criterion.' }],
    fieldGrounding: Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, defaultGrounding({ evidenceIds, goalIds: [context.goal.id], componentSlugs: components.map((item) => item.slug), assumptions: checks.length ? [] : ['No product-level executable check was observed.'] })])), lockedFields: [],
  };
}

function selectedComponents(context, maximum = 5) {
  return [...context.componentAlternative.components].sort((left, right) => componentRelevance(right, context.goal) - componentRelevance(left, context.goal) || left.order - right.order).slice(0, maximum);
}

function outcomeAlternative(context) {
  const components = selectedComponents(context);
  const plannedComponentSlugs = new Set(components.map((component) => component.slug));
  const uncertain = components.some((component) => (component.contract.uncertainties || []).some((item) => !/^No material uncertainty/i.test(item)));
  const decision = uncertain ? decisionCandidate(components, context, 'outcome-slices') : null;
  const implementations = components.map((component, index) => implementationCandidate(component, index + (decision ? 1 : 0), context, { hardDependency: decision?.slug || null, plannedComponentSlugs }));
  const validation = validationCandidate(implementations, components, context, 'outcome-slices');
  const fronts = [...(decision ? [decision] : []), ...implementations, validation].map((front, index) => ({ ...front, order: index + 1 }));
  return {
    id: stableId('front-plan-alternative', context.identity, 'outcome-slices'), strategy: 'outcome-slices', title: 'Parallel outcome slices',
    summary: 'Slices work by component-owned observable outcomes, routes the highest-impact boundary unknown explicitly, then joins evidence at one product validation front.',
    rationale: ['Each implementation slice can produce feedback independently.', 'Hard edges are reserved for real readiness; component relationships remain coordination edges.'],
    tradeoffs: { strengths: ['Fast independent feedback', 'Clear lead ownership'], risks: ['Cross-component integration appears late'], bestWhen: ['Component boundaries are stable enough for parallel delivery'] },
    fronts, generatedBy: { kind: 'deterministic', adapterId: null, model: null },
  };
}

function riskFirstAlternative(context) {
  const components = selectedComponents(context);
  const decision = decisionCandidate(components, context, 'risk-first');
  const lead = components[0];
  const vertical = implementationCandidate(lead, 1, context, { prefix: 'vertical-', hardDependency: decision.slug });
  vertical.title = `Vertical proof for ${context.goal.title}`;
  vertical.slug = slugify(`vertical-${context.goal.title}`);
  vertical.affectedComponents = components.slice(1).map((item) => item.slug);
  vertical.outcome = `One thin cross-component journey proves the riskiest path toward ${context.goal.outcome}`;
  vertical.scope = `Deliver one end-to-end proof across ${components.map((item) => item.title).join(', ')} without broadening beyond the selected goal.`;
  vertical.fieldGrounding.affectedComponents = defaultGrounding({ goalIds: [context.goal.id], componentSlugs: components.map((item) => item.slug), assumptions: ['Affected ownership is limited to the thin vertical proof.'] });
  const validation = validationCandidate([vertical], components, context, 'risk-first');
  const fronts = [decision, vertical, validation].map((front, index) => ({ ...front, order: index + 1 }));
  return {
    id: stableId('front-plan-alternative', context.identity, 'risk-first'), strategy: 'risk-first', title: 'Risk-first vertical proof',
    summary: 'Resolves the largest unknown, proves one thin end-to-end path, then validates before expanding into parallel component slices.',
    rationale: ['Early uncertainty reduction can prevent parallel work on the wrong boundary.', 'One vertical proof shortens time to integrated learning.'],
    tradeoffs: { strengths: ['Earlier integration and risk feedback'], risks: ['Less initial parallelism', 'One front coordinates several components'], bestWhen: ['Architecture or product uncertainty dominates throughput'] },
    fronts, generatedBy: { kind: 'deterministic', adapterId: null, model: null },
  };
}

function acceptedAlternative(context) {
  const current = context.portfolio?.fronts || [];
  if (!current.length) return null;
  const references = referenceCatalog(context);
  const fronts = current.slice(0, 80).map((front, index) => {
    const lead = front.leadComponent || front.component || 'unresolved-component';
    const acceptedEvidence = (front.evidence || []).filter((item) => references.has(item.reference));
    const evidenceItems = acceptedEvidence.length ? acceptedEvidence : [{ kind: 'declared', reference: context.snapshot.id, reason: 'Accepted front retained as an evolution baseline against this snapshot.' }];
    const assumptions = ['Missing accepted v2 fields and invalid selected-architecture references remain explicit baseline diagnostics.'];
    return {
      id: stableId('front-candidate', 'accepted', front.slug), slug: front.slug, title: front.title, state: front.state || 'queued', order: index + 1,
      origin: 'accepted', candidateKind: 'implementation', leadComponent: lead, affectedComponents: front.affectedComponents || [],
      goalIds: front.goalIds?.length ? front.goalIds : [context.goal.id], analysisSnapshot: front.analysisSnapshot || context.snapshot.id,
      outcome: front.outcome || `Retain the accepted outcome of ${front.title}.`, motivation: front.motivation || `Review whether ${front.title} still advances ${context.goal.title}.`,
      scope: front.scope || front.context || `Retain the currently accepted scope of ${front.title}.`,
      nonGoals: front.nonGoals?.length ? front.nonGoals : ['No additional scope is inferred from accepted checklist text.'],
      dependencies: (front.dependencies || []).filter((item) => DEPENDENCY_KIND.has(item.kind) && item.target && item.reason),
      readiness: front.readiness?.length ? front.readiness : ['Reconcile accepted readiness before replanning.'],
      acceptanceCriteria: front.acceptanceCriteria?.length ? front.acceptanceCriteria : ['Reconcile accepted completion evidence before replanning.'],
      verification: front.verification?.length ? front.verification : ['Define an executable check before this accepted front is considered ready.'],
      deliverables: front.deliverables?.length ? front.deliverables : [`The accepted ${front.title} deliverable.`],
      risks: front.risks?.length ? front.risks : ['Accepted risk/unknown detail is incomplete.'],
      unknowns: (front.risks || []).filter((item) => /^\[Unknown\]/i.test(item)).map((item) => item.replace(/^\[Unknown\]\s*/i, '')).concat('Accepted front needs reconciliation against the selected architecture.'),
      evidence: evidenceItems, context: front.context || 'Accepted front baseline.', handoff: front.handoff || 'Preserve completed evidence and revisit only queued work.',
      tasks: front.tasks?.length ? front.tasks : [{ state: 'open', text: 'Reconcile the accepted front with the selected component architecture.' }],
      fieldGrounding: Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, defaultGrounding({ evidenceIds: evidenceItems.map((item) => item.reference), goalIds: [context.goal.id], componentSlugs: catalogsFor(context).componentSlugs.has(lead) ? [lead] : [], assumptions })])),
      lockedFields: front.state === 'done' ? [...FRONT_DESIGN_FIELDS] : [],
    };
  });
  return {
    id: stableId('front-plan-alternative', context.identity, 'existing'), strategy: 'existing', title: 'Current accepted front portfolio',
    summary: 'A normalized private baseline for replanning; completed fronts are fully locked and invalid references remain diagnostics.',
    rationale: ['Completed evidence must survive replanning.', 'Accepted queued work is context, not automatically correct for the new goal/architecture.'],
    tradeoffs: { strengths: ['Continuity and preserved completed evidence'], risks: ['Legacy fronts may be task-shaped or reference superseded components'], bestWhen: ['Replanning an active initialized repository'] },
    fronts, generatedBy: { kind: 'human', adapterId: null, model: null },
  };
}

function modelAlternative(context) {
  if (!context.planningResult) return null;
  const proposals = context.planningResult.fronts;
  const knownFronts = new Set(proposals.map((item) => item.slug));
  const fronts = proposals.map((proposal, index) => {
    const evidenceIds = proposal.evidenceIds.length ? proposal.evidenceIds : [context.snapshot.id];
    const assumptions = proposal.assumptions.length ? proposal.assumptions : ['Model proposal requires deterministic and human review.'];
    const common = { evidenceIds, goalIds: proposal.goalIds.length ? proposal.goalIds : [context.goal.id], componentSlugs: [proposal.componentSlug, ...proposal.affectedComponents].filter((slug) => catalogsFor(context).componentSlugs.has(slug)), assumptions, questions: proposal.questions };
    return {
      id: stableId('front-candidate', 'model', proposal.slug), slug: proposal.slug, title: proposal.title, state: 'queued', order: index + 1,
      origin: 'model', candidateKind: proposal.questions.length ? 'research' : 'implementation', leadComponent: proposal.componentSlug,
      affectedComponents: proposal.affectedComponents, goalIds: proposal.goalIds.length ? proposal.goalIds : [context.goal.id], analysisSnapshot: context.snapshot.id,
      outcome: proposal.objective, motivation: proposal.motivation, scope: proposal.scope,
      nonGoals: proposal.nonGoals.length ? proposal.nonGoals : ['No implicit scope outside the cited model proposal.'],
      dependencies: proposal.dependencies.map((target) => ({ kind: knownFronts.has(slugify(target)) ? 'hard' : 'informational', target: slugify(target), reason: 'Model-proposed dependency; kind remains reviewable.' })),
      readiness: proposal.readiness.length ? proposal.readiness : ['Review model-proposed readiness before execution.'],
      acceptanceCriteria: proposal.acceptanceCriteria.length ? proposal.acceptanceCriteria : ['Define observable acceptance before execution.'],
      verification: proposal.verification.length ? proposal.verification : ['Define feasible verification before execution.'],
      deliverables: proposal.deliverables.length ? proposal.deliverables : ['A reviewed outcome deliverable.'],
      risks: proposal.risks.length ? proposal.risks : ['Model synthesis may have missed a repository constraint.'],
      unknowns: proposal.questions.length ? proposal.questions : ['No model question was reported; human review remains required.'],
      evidence: evidenceIds.map((id) => ({ kind: 'inferred', reference: id, reason: 'Validated model result cited this allowlisted source.' })),
      context: `Imported from the separately consented planning result for ${context.goal.title}.`,
      handoff: 'Use only reviewed scope, evidence and component ownership; do not allocate execution until publication.',
      tasks: [{ state: 'open', text: 'Reconfirm model claims against cited evidence.' }, ...proposal.deliverables.slice(0, 8).map((item) => ({ state: 'open', text: `Produce: ${item}` })), { state: 'open', text: 'Collect acceptance and verification evidence.' }],
      fieldGrounding: Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, defaultGrounding(common)])), lockedFields: [],
    };
  });
  return {
    id: stableId('front-plan-alternative', context.identity, 'model'), strategy: 'model', title: 'Model-synthesized front portfolio', summary: context.planningResult.summary,
    rationale: ['Imports one separately consented and schema-validated front-design result.', 'Deterministic reference, DAG and quality validation runs again here.'],
    tradeoffs: { strengths: ['Can hypothesize non-local outcome slices'], risks: ['May invent weak sequencing or under-specify checks'], bestWhen: ['Bounded product/system context is rich enough to resolve slicing ambiguity'] },
    fronts, generatedBy: { kind: 'model', adapterId: context.planningJobId || 'planning-runtime', model: null },
  };
}

function alternativeSignature(alternative) {
  return canonical(alternative.fronts.map((front) => ({ slug: front.slug, lead: front.leadComponent, affected: [...front.affectedComponents].sort(), outcome: front.outcome, hard: front.dependencies.filter((item) => item.kind === 'hard').map((item) => item.target).sort() })));
}

function normalizeAlternative(value, catalogs, context) {
  const strategy = inline(value.strategy, 64);
  if (!STRATEGIES.has(strategy)) fail('INVALID_FRONT_PLAN_ALTERNATIVE', `unsupported front-plan strategy '${strategy}'`);
  const allowInvalidReferences = strategy === 'existing';
  const fronts = (value.fronts || []).slice(0, 80).map((front, index) => normalizeCandidate(front, catalogs, { label: `${strategy}.fronts[${index}]`, allowInvalidReferences }));
  if (!fronts.length) fail('INVALID_FRONT_PLAN_ALTERNATIVE', `${strategy} needs at least one complete front`);
  const duplicates = fronts.map((front) => front.slug).filter((slug, index, all) => all.indexOf(slug) !== index);
  if (duplicates.length) fail('DUPLICATE_FRONT_SLUG', `${strategy} contains duplicate front slug '${duplicates[0]}'`);
  if (!allowInvalidReferences) for (const front of fronts) for (const edge of front.dependencies) if (!fronts.some((item) => item.slug === edge.target)) {
    fail('UNKNOWN_FRONT_DEPENDENCY', `${front.slug} references unknown front '${edge.target}'`);
  }
  const normalized = {
    id: inline(value.id, 256) || stableId('front-plan-alternative', strategy, ...fronts.map((item) => item.id)), strategy,
    title: inline(value.title, 256) || `${strategy} plan`, summary: clean(value.summary, 8_000), rationale: list(value.rationale, 50),
    tradeoffs: { strengths: list(value.tradeoffs?.strengths, 50), risks: list(value.tradeoffs?.risks, 50), bestWhen: list(value.tradeoffs?.bestWhen, 50) },
    fronts: fronts.map((front, index) => ({ ...front, order: index + 1 })),
    generatedBy: value.generatedBy || { kind: 'deterministic', adapterId: null, model: null },
  };
  normalized.quality = evaluateFrontPlanAlternative(normalized.fronts, context);
  return normalized;
}

function designQuestions(context, alternatives) {
  const questions = [];
  if (context.goal.manual) questions.push({ id: 'front-question:goal-success', question: 'What observable signal proves this manually entered goal succeeded?', why: 'No accepted product success signal is available.', affects: ['outcome', 'acceptanceCriteria', 'verification'], state: 'open', answer: '' });
  const collisions = Math.max(...alternatives.map((item) => item.quality.parallelism.collisions.length), 0);
  if (collisions) questions.push({ id: 'front-question:parallel-priority', question: 'Should ownership collisions be serialized, or can one front expose an interface that makes the work safely parallel?', why: `${collisions} candidate pair(s) share component or territory ownership.`, affects: ['dependencies', 'scope', 'affectedComponents'], state: 'open', answer: '' });
  if (alternatives.some((item) => item.quality.broadFronts.length)) questions.push({ id: 'front-question:verification', question: 'Which available check or observable signal is strong enough to accept the broad outcome?', why: 'The repository evidence does not yet support a narrow executable verification boundary.', affects: ['acceptanceCriteria', 'verification', 'readiness'], state: 'open', answer: '' });
  questions.push({ id: 'front-question:slicing-axis', question: 'Optimize first for parallel component throughput or for one early end-to-end risk proof?', why: 'The two deterministic alternatives trade feedback speed against initial parallelism.', affects: ['dependencies', 'scope', 'tasks'], state: 'open', answer: '' });
  return questions.slice(0, 10);
}

function applyQuestionAnswers(alternatives, questions) {
  for (const question of questions) {
    const prefix = `Human planning answer [${question.id}]:`;
    for (const alternative of alternatives) for (const front of alternative.fronts) for (const field of question.affects) {
      const fieldGrounding = front.fieldGrounding[field];
      if (!fieldGrounding) continue;
      fieldGrounding.assumptions = fieldGrounding.assumptions.filter((item) => !item.startsWith(prefix));
      if (question.state === 'answered' && question.answer) fieldGrounding.assumptions.push(`${prefix} ${question.answer}`);
    }
  }
}

export function synthesizeFrontPlanAlternatives(contextValue, { includeModel = true } = {}) {
  const context = normalizeFrontDesignContext(contextValue);
  const catalogs = catalogsFor(context);
  const raw = [outcomeAlternative(context), riskFirstAlternative(context)];
  const accepted = acceptedAlternative(context); if (accepted) raw.push(accepted);
  const modelDiagnostics = [];
  if (includeModel && context.planningResult) {
    try { raw.push(modelAlternative(context)); }
    catch (error) { modelDiagnostics.push({ code: error.code || 'MODEL_FRONT_ALTERNATIVE_REJECTED', severity: 'warning', message: String(error.message || error) }); }
  }
  const distinct = uniqueBy(raw, alternativeSignature);
  const alternatives = [];
  for (const alternative of distinct) {
    try { alternatives.push(normalizeAlternative(alternative, catalogs, context)); }
    catch (error) {
      if (alternative.strategy !== 'model') throw error;
      modelDiagnostics.push({ code: error.code || 'MODEL_FRONT_ALTERNATIVE_REJECTED', severity: 'warning', message: String(error.message || error) });
    }
  }
  return deepFreeze({ context, catalogs, alternatives, diagnostics: modelDiagnostics });
}

function sourceRecord(context) {
  return {
    contextIdentity: context.identity, analysisJobId: context.analysisJobId, planningJobId: context.planningJobId,
    snapshotId: context.snapshot.id, mapId: context.map.id, componentDraftId: context.componentDraft.id,
    componentDraftRevision: context.componentDraft.revision, componentAlternativeId: context.componentAlternative.id,
    componentRevision: componentPortfolioRevision(context.componentAlternative.components), goal: context.goal,
    componentDraftStale: Boolean(context.componentDraft.stale), componentDraftStaleReasons: list(context.componentDraft.staleReasons, 20),
    productRevision: context.productCatalog.revision, portfolioRevision: acceptedPortfolioRevision(context.portfolio),
    repository: context.repository, references: [...referenceCatalog(context)], goalIds: [...catalogsFor(context).goalIds],
    componentSlugs: [...catalogsFor(context).componentSlugs],
    componentSnapshot: context.componentAlternative.components.map((component) => ({ slug: component.slug, contract: { territory: component.contract.territory } })),
    productIncluded: Boolean(context.product), modelIncluded: Boolean(context.planningResult),
  };
}

function draftRevision(draft) {
  return sha256(canonical({ state: draft.state, selectedAlternativeId: draft.selectedAlternativeId, alternatives: draft.alternatives, questions: draft.questions, lockedDecisions: draft.lockedDecisions }));
}

function publicDraft(draft, context = null, unavailableReason = null) {
  const staleReasons = [];
  if (unavailableReason) staleReasons.push(unavailableReason);
  if (draft.source.componentDraftStale) staleReasons.push(...(draft.source.componentDraftStaleReasons?.length ? draft.source.componentDraftStaleReasons : ['The selected component architecture was already stale when this plan was created.']));
  if (context) {
    if (context.snapshot.id !== draft.source.snapshotId || context.map.id !== draft.source.mapId) staleReasons.push('The selected system-map snapshot changed.');
    if (context.componentDraft.revision !== draft.source.componentDraftRevision) staleReasons.push('The private component architecture changed.');
    if (context.componentAlternative.id !== draft.source.componentAlternativeId) staleReasons.push('The selected component alternative changed.');
    if (context.componentDraft.stale) staleReasons.push(...(context.componentDraft.staleReasons?.length ? context.componentDraft.staleReasons : ['The selected component architecture is stale.']));
    if (context.productCatalog.revision !== draft.source.productRevision) staleReasons.push('Accepted product direction changed.');
    if (acceptedPortfolioRevision(context.portfolio) !== draft.source.portfolioRevision) staleReasons.push('The accepted front/component portfolio changed.');
    if (context.snapshot.freshness.state !== 'current') staleReasons.push(`The source snapshot is ${context.snapshot.freshness.state}.`);
  }
  const { references: _references, goalIds: _goalIds, componentSlugs: _componentSlugs, componentSnapshot: _componentSnapshot, ...publicSource } = draft.source;
  return deepFreeze({
    schemaVersion: FRONT_DESIGN_SCHEMA_VERSION, id: draft.id, repositoryId: draft.repositoryId, state: draft.state,
    createdAt: draft.createdAt, updatedAt: draft.updatedAt, expiresAt: new Date(draft.expiresAtMs).toISOString(), source: publicSource,
    stale: staleReasons.length > 0, staleReasons: [...new Set(staleReasons)], selectedAlternativeId: draft.selectedAlternativeId,
    alternatives: draft.alternatives, questions: draft.questions, lockedDecisions: draft.lockedDecisions, diagnostics: draft.diagnostics,
    history: draft.history.slice(-100), revision: draftRevision(draft), mutation: { repository: false, worktrees: false, agents: false, privateDraftOnly: true, publicationAvailableHere: false },
  });
}

function draftCatalogs(draft) {
  return { references: new Set(draft.source.references), goalIds: new Set(draft.source.goalIds), componentSlugs: new Set(draft.source.componentSlugs) };
}

function storedContext(draft) {
  return {
    goal: draft.source.goal,
    componentAlternative: { components: draft.source.componentSnapshot },
  };
}

function selectedAlternative(draft, id = draft.selectedAlternativeId) {
  const alternative = draft.alternatives.find((item) => item.id === id);
  if (!alternative) fail('FRONT_ALTERNATIVE_NOT_FOUND', `front-plan alternative '${id}' was not found`);
  return alternative;
}

function selectedFront(alternative, id) {
  const front = alternative.fronts.find((item) => item.id === id);
  if (!front) fail('FRONT_CANDIDATE_NOT_FOUND', `front candidate '${id}' was not found`);
  return front;
}

function assertMutable(front, fields = []) {
  if (front.state === 'done') fail('COMPLETED_FRONT_IMMUTABLE', `completed front '${front.slug}' and its evidence cannot be revised in replanning`);
  const locked = fields.filter((field) => front.lockedFields.includes(field));
  if (locked.length) fail('LOCKED_FRONT_FIELD', `unlock ${locked.join(', ')} before changing '${front.slug}'`, { fields: locked });
}

function frontPatch(front, updates) {
  const next = clone(front); const changed = [];
  for (const field of ['title', 'slug', 'candidateKind', 'leadComponent', 'affectedComponents', 'goalIds', 'outcome', 'motivation', 'scope', 'nonGoals', 'dependencies', 'readiness', 'acceptanceCriteria', 'verification', 'deliverables', 'risks', 'unknowns', 'evidence', 'tasks', 'context', 'handoff']) {
    if (updates[field] !== undefined) { next[field] = clone(updates[field]); if (FIELDS.has(field)) changed.push(field); }
  }
  const groundingInput = updates.fieldGrounding && typeof updates.fieldGrounding === 'object' ? updates.fieldGrounding : {};
  for (const field of FRONT_DESIGN_FIELDS) if (groundingInput[field] !== undefined) { next.fieldGrounding[field] = clone(groundingInput[field]); if (!changed.includes(field)) changed.push(field); }
  assertMutable(front, changed);
  for (const field of changed) if (groundingInput[field] === undefined && updates[field] !== undefined) {
    next.fieldGrounding[field] = defaultGrounding({ assumptions: [`Human-edited ${field}; reconcile evidence before publication.`] });
  }
  return next;
}

function validateDependencies(alternative) {
  const known = new Set(alternative.fronts.map((front) => front.slug));
  for (const front of alternative.fronts) for (const edge of front.dependencies) if (!known.has(edge.target)) fail('UNKNOWN_FRONT_DEPENDENCY', `${front.slug} references unknown front '${edge.target}'`);
}

function alternativeDiff(left, right) {
  const leftBySlug = new Map(left.fronts.map((item) => [item.slug, item])); const rightBySlug = new Map(right.fronts.map((item) => [item.slug, item]));
  const added = [...rightBySlug.keys()].filter((slug) => !leftBySlug.has(slug)).sort();
  const removed = [...leftBySlug.keys()].filter((slug) => !rightBySlug.has(slug)).sort();
  const changed = [...rightBySlug.keys()].filter((slug) => leftBySlug.has(slug) && canonical(leftBySlug.get(slug)) !== canonical(rightBySlug.get(slug))).sort();
  const edges = (alternative) => alternative.fronts.flatMap((front) => front.dependencies.map((edge) => `${front.slug}:${edge.kind}:${edge.target}`)).sort();
  return deepFreeze({ left: { id: left.id, title: left.title, strategy: left.strategy }, right: { id: right.id, title: right.title, strategy: right.strategy }, fronts: { added, removed, changed }, dependencies: { left: edges(left), right: edges(right) }, quality: { left: left.quality, right: right.quality }, materiallyDifferent: Boolean(added.length || removed.length || changed.length || canonical(edges(left)) !== canonical(edges(right))) });
}

export function compareFrontPlanAlternatives(draft, leftId, rightId) { return alternativeDiff(selectedAlternative(draft, leftId), selectedAlternative(draft, rightId)); }

export class FrontPlanningDraftStore {
  constructor({ root, now = () => Date.now(), ttlMs = FRONT_DESIGN_DRAFT_TTL_MS } = {}) {
    if (!root) fail('FRONT_DESIGN_ROOT_REQUIRED', 'front planning draft root is required');
    this.root = ensurePrivateDirectory(root); this.now = now; this.ttlMs = ttlMs; this.cleanup();
  }

  #path(id) { if (!DRAFT_ID.test(String(id || ''))) fail('FRONT_DESIGN_DRAFT_NOT_FOUND', 'front planning draft not found'); return join(this.root, `${id}.json`); }

  #load(id) {
    let draft;
    try { draft = JSON.parse(readFileSync(this.#path(id), 'utf8')); } catch (error) { if (error instanceof FrontDesignError) throw error; fail('FRONT_DESIGN_DRAFT_NOT_FOUND', 'front planning draft not found'); }
    if (draft.expiresAtMs <= this.now()) { rmSync(this.#path(id), { force: true }); fail('FRONT_DESIGN_DRAFT_EXPIRED', 'front planning draft expired'); }
    return draft;
  }

  #save(draft) { draft.updatedAt = new Date(this.now()).toISOString(); draft.expiresAtMs = this.now() + this.ttlMs; atomicPrivateJson(this.#path(draft.id), draft); return draft; }

  cleanup() {
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.root, name);
      try { const draft = JSON.parse(readFileSync(path, 'utf8')); if (!draft.expiresAtMs || draft.expiresAtMs <= this.now()) rmSync(path, { force: true }); } catch { rmSync(path, { force: true }); }
    }
  }

  create(repository, contextValue, { includeModel = true } = {}) {
    const context = normalizeFrontDesignContext(contextValue);
    if (context.repository.id !== repository.id || context.repository.adapter !== repository.adapter) fail('FRONT_DESIGN_REPOSITORY_MISMATCH', 'front design context belongs to a different repository');
    const synthesis = synthesizeFrontPlanAlternatives(context, { includeModel });
    const createdAt = new Date(this.now()).toISOString(); const id = randomUUID();
    const draft = {
      schemaVersion: FRONT_DESIGN_SCHEMA_VERSION, id, repositoryId: repository.id, state: 'review', createdAt, updatedAt: createdAt, expiresAtMs: this.now() + this.ttlMs,
      source: sourceRecord(context), selectedAlternativeId: synthesis.alternatives[0].id, alternatives: clone(synthesis.alternatives),
      questions: designQuestions(context, synthesis.alternatives), lockedDecisions: [], diagnostics: synthesis.diagnostics,
      history: [{ id: stableId('history', id, createdAt), at: createdAt, operation: 'created', summary: `${synthesis.alternatives.length} front-plan alternative(s) generated without repository, worktree or agent mutation.` }],
    };
    this.#save(draft); return publicDraft(draft, context);
  }

  list(repositoryId) {
    this.cleanup();
    return readdirSync(this.root).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try { const draft = JSON.parse(readFileSync(join(this.root, name), 'utf8')); return draft.repositoryId === repositoryId ? [publicDraft(draft)] : []; } catch { return []; }
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  source(repositoryId, id) {
    const draft = this.#load(id); if (draft.repositoryId !== repositoryId) fail('FRONT_DESIGN_DRAFT_NOT_FOUND', 'front planning draft does not belong to this repository');
    return deepFreeze({ analysisJobId: draft.source.analysisJobId, planningJobId: draft.source.planningJobId, componentDraftId: draft.source.componentDraftId, componentAlternativeId: draft.source.componentAlternativeId, goalId: draft.source.goal.manual ? null : draft.source.goal.id, goal: draft.source.goal.manual ? draft.source.goal : null, productIncluded: draft.source.productIncluded, modelIncluded: draft.source.modelIncluded });
  }

  get(repositoryId, id, { context = null, unavailableReason = null } = {}) {
    const draft = this.#load(id); if (draft.repositoryId !== repositoryId) fail('FRONT_DESIGN_DRAFT_NOT_FOUND', 'front planning draft does not belong to this repository');
    return publicDraft(draft, context ? normalizeFrontDesignContext(context) : null, unavailableReason);
  }

  compare(repositoryId, id, leftId, rightId) {
    const draft = this.#load(id); if (draft.repositoryId !== repositoryId) fail('FRONT_DESIGN_DRAFT_NOT_FOUND', 'front planning draft does not belong to this repository');
    return compareFrontPlanAlternatives(draft, leftId, rightId);
  }

  apply(repositoryId, id, operationValue, { context = null } = {}) {
    const draft = this.#load(id); if (draft.repositoryId !== repositoryId) fail('FRONT_DESIGN_DRAFT_NOT_FOUND', 'front planning draft does not belong to this repository');
    const operation = operationValue && typeof operationValue === 'object' ? operationValue : {}; const kind = inline(operation.operation, 64); const beforeRevision = draftRevision(draft);
    if (operation.expectedRevision && inline(operation.expectedRevision, 128) !== beforeRevision) fail('FRONT_DESIGN_REVISION_CONFLICT', 'the front planning draft changed; refresh before applying this operation', { expectedRevision: operation.expectedRevision, currentRevision: beforeRevision });
    const normalizedContext = context ? normalizeFrontDesignContext(context) : null; const catalogs = draftCatalogs(draft); let summary = ''; let historyDetails = null;
    if (kind === 'select-alternative') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256)); draft.selectedAlternativeId = alternative.id; summary = `Selected ${alternative.title}.`;
    } else if (kind === 'edit-front') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId); const index = alternative.fronts.findIndex((item) => item.id === operation.frontId); const current = selectedFront(alternative, operation.frontId);
      const next = normalizeCandidate(frontPatch(current, operation.updates || {}), catalogs, { label: 'edited front' });
      if (next.slug !== current.slug && alternative.fronts.some((item) => item.id !== current.id && item.slug === next.slug)) fail('DUPLICATE_FRONT_SLUG', `front slug '${next.slug}' already exists`);
      alternative.fronts[index] = next;
      if (next.slug !== current.slug) for (const front of alternative.fronts) if (front.id !== next.id) front.dependencies = front.dependencies.map((edge) => edge.target === current.slug ? { ...edge, target: next.slug, reason: `${edge.reason} Redirected after reviewed rename.` } : edge);
      summary = `Edited ${next.title}.`;
    } else if (kind === 'lock-field' || kind === 'unlock-field') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId); const front = selectedFront(alternative, operation.frontId); const field = inline(operation.field, 64);
      if (!FIELDS.has(field)) fail('INVALID_FRONT_LOCK', `unknown front field '${field}'`);
      if (front.state === 'done') fail('COMPLETED_FRONT_IMMUTABLE', `completed front '${front.slug}' is already fully locked`);
      if (kind === 'lock-field') {
        front.lockedFields = [...new Set([...front.lockedFields, field])]; draft.lockedDecisions = draft.lockedDecisions.filter((item) => !(item.frontId === front.id && item.field === field));
        draft.lockedDecisions.push({ id: stableId('front-lock', front.id, field), frontId: front.id, frontSlug: front.slug, field, valueDigest: sha256(canonical(front[field])), reason: clean(operation.reason, 2_000) || 'Locked by human review.' }); summary = `Locked ${front.slug}.${field}.`;
      } else { front.lockedFields = front.lockedFields.filter((item) => item !== field); draft.lockedDecisions = draft.lockedDecisions.filter((item) => !(item.frontId === front.id && item.field === field)); summary = `Unlocked ${front.slug}.${field}.`; }
    } else if (kind === 'delete-front') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId); const front = selectedFront(alternative, operation.frontId); assertMutable(front, front.lockedFields);
      if (alternative.fronts.length === 1) fail('INVALID_FRONT_PLAN_ALTERNATIVE', 'a plan alternative must retain at least one front');
      const inbound = alternative.fronts.flatMap((item) => item.id === front.id ? [] : item.dependencies.filter((edge) => edge.target === front.slug).map((edge) => ({ front: item.slug, edge })));
      if (inbound.length) fail('FRONT_STILL_REFERENCED', `redirect dependencies to '${front.slug}' before deleting it`, { inbound });
      alternative.fronts = alternative.fronts.filter((item) => item.id !== front.id); draft.lockedDecisions = draft.lockedDecisions.filter((item) => item.frontId !== front.id); summary = `Deleted ${front.title} from the private plan.`;
    } else if (kind === 'add-front') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId); const front = normalizeCandidate({ ...operation.front, origin: 'manual', order: alternative.fronts.length + 1 }, catalogs, { label: 'manual front' });
      if (alternative.fronts.some((item) => item.slug === front.slug)) fail('DUPLICATE_FRONT_SLUG', `front slug '${front.slug}' already exists`); alternative.fronts.push(front); summary = `Added manual front ${front.title}.`;
    } else if (kind === 'reorder-fronts') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId); const ids = list(operation.frontIds, 100, 256);
      if (ids.length !== alternative.fronts.length || new Set(ids).size !== ids.length || ids.some((frontId) => !alternative.fronts.some((front) => front.id === frontId))) fail('INVALID_FRONT_ORDER', 'frontIds must contain every candidate exactly once');
      alternative.fronts = ids.map((frontId) => selectedFront(alternative, frontId)); summary = 'Reordered front candidates.';
    } else if (kind === 'split-front') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId); const source = selectedFront(alternative, operation.frontId); assertMutable(source, source.lockedFields);
      const firstTasks = list(operation.first?.taskIndexes, 120, 16).map(Number); const secondTasks = list(operation.second?.taskIndexes, 120, 16).map(Number);
      const expected = source.tasks.map((_, index) => index); const combined = [...firstTasks, ...secondTasks];
      if (!firstTasks.length || !secondTasks.length || new Set(combined).size !== combined.length || expected.some((index) => !combined.includes(index)) || combined.some((index) => !expected.includes(index))) fail('INVALID_FRONT_SPLIT', 'taskIndexes must partition every source checklist item exactly once');
      const make = (details, indexes, suffix) => normalizeCandidate({ ...clone(source), id: stableId('front-candidate', source.id, suffix), slug: details.slug, title: details.title, outcome: details.outcome || `${details.title} produces its reviewed share of ${source.outcome}`, tasks: indexes.map((index) => source.tasks[index]), origin: 'manual', state: 'queued', lockedFields: [], fieldGrounding: Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, defaultGrounding({ assumptions: [`Human-reviewed split of ${source.slug}; ${field} requires reconciliation.`] })])) }, catalogs, { label: `split ${suffix}` });
      const first = make(operation.first || {}, firstTasks, 'first'); const second = make(operation.second || {}, secondTasks, 'second');
      if (first.slug === second.slug || alternative.fronts.some((item) => item.id !== source.id && [first.slug, second.slug].includes(item.slug))) fail('DUPLICATE_FRONT_SLUG', 'split fronts need unique slugs');
      const index = alternative.fronts.findIndex((item) => item.id === source.id); alternative.fronts.splice(index, 1, first, second);
      for (const front of alternative.fronts) if (![first.id, second.id].includes(front.id)) front.dependencies = front.dependencies.flatMap((edge) => edge.target === source.slug ? [{ ...edge, target: first.slug, reason: `${edge.reason} Redirected by reviewed split.` }, { ...edge, target: second.slug, reason: `${edge.reason} Redirected by reviewed split.` }] : [edge]);
      summary = `Split ${source.title} into ${first.title} and ${second.title}.`;
    } else if (kind === 'merge-fronts') {
      const alternative = selectedAlternative(draft, inline(operation.alternativeId, 256) || draft.selectedAlternativeId); const ids = list(operation.frontIds, 80, 256);
      if (ids.length < 2) fail('INVALID_FRONT_MERGE', 'merge requires at least two fronts'); const sources = ids.map((frontId) => selectedFront(alternative, frontId)); for (const front of sources) assertMutable(front, front.lockedFields);
      const details = operation.front || {}; const merge = (field) => uniqueBy(sources.flatMap((front) => front[field] || []), (item) => canonical(item));
      const merged = normalizeCandidate({
        id: stableId('front-candidate', 'merge', ...ids.slice().sort()), slug: details.slug, title: details.title, state: 'queued', origin: 'manual', candidateKind: details.candidateKind || 'implementation',
        leadComponent: details.leadComponent || sources[0].leadComponent, affectedComponents: [...new Set([...sources.flatMap((item) => [item.leadComponent, ...item.affectedComponents])])].filter((slug) => slug !== (details.leadComponent || sources[0].leadComponent)),
        goalIds: merge('goalIds'), analysisSnapshot: sources[0].analysisSnapshot, outcome: details.outcome || `One reviewed outcome replaces ${sources.map((item) => item.title).join(', ')}.`,
        motivation: details.motivation || sources.map((item) => item.motivation).join('\n'), scope: details.scope || sources.map((item) => item.scope).join('\n'), nonGoals: merge('nonGoals'),
        dependencies: merge('dependencies').filter((edge) => !sources.some((source) => source.slug === edge.target)), readiness: merge('readiness'), acceptanceCriteria: merge('acceptanceCriteria'), verification: merge('verification'), deliverables: merge('deliverables'), risks: merge('risks'), unknowns: merge('unknowns'), evidence: merge('evidence'), tasks: merge('tasks'), context: sources.map((item) => item.context).join('\n'), handoff: details.handoff || sources.map((item) => item.handoff).join('\n'),
        fieldGrounding: Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, defaultGrounding({ evidenceIds: [...new Set(sources.flatMap((item) => item.fieldGrounding[field].evidenceIds))], goalIds: [...new Set(sources.flatMap((item) => item.fieldGrounding[field].goalIds))], componentSlugs: [...new Set(sources.flatMap((item) => item.fieldGrounding[field].componentSlugs))], assumptions: [`Human-reviewed merge; ${field} requires scope-growth review.`] })])), lockedFields: [],
      }, catalogs, { label: 'merged front' });
      if (alternative.fronts.some((item) => !ids.includes(item.id) && item.slug === merged.slug)) fail('DUPLICATE_FRONT_SLUG', `front slug '${merged.slug}' already exists`);
      const insertion = Math.min(...sources.map((source) => alternative.fronts.findIndex((item) => item.id === source.id))); alternative.fronts = alternative.fronts.filter((item) => !ids.includes(item.id)); alternative.fronts.splice(insertion, 0, merged);
      for (const front of alternative.fronts) if (front.id !== merged.id) front.dependencies = uniqueBy(front.dependencies.map((edge) => sources.some((source) => source.slug === edge.target) ? { ...edge, target: merged.slug, reason: `${edge.reason} Redirected by reviewed merge.` } : edge), (edge) => `${edge.kind}:${edge.target}`);
      summary = `Merged ${sources.map((item) => item.title).join(', ')} into ${merged.title}.`;
    } else if (kind === 'answer-question') {
      const question = draft.questions.find((item) => item.id === operation.questionId); if (!question) fail('FRONT_QUESTION_NOT_FOUND', `front planning question '${operation.questionId}' was not found`);
      question.answer = clean(operation.answer, 4_096); question.state = question.answer ? 'answered' : 'open';
      if (question.id === 'front-question:slicing-axis' && question.answer) {
        const strategy = /risk|vertical|end.?to.?end/i.test(question.answer) ? 'risk-first' : /parallel|component|throughput/i.test(question.answer) ? 'outcome-slices' : null;
        const alternative = strategy && draft.alternatives.find((item) => item.strategy === strategy); if (alternative) draft.selectedAlternativeId = alternative.id;
      }
      applyQuestionAnswers(draft.alternatives, draft.questions);
      summary = question.answer ? `Answered: ${question.question}` : `Cleared answer: ${question.question}`;
    } else if (kind === 'skip') { draft.state = 'skipped'; summary = 'Skipped front planning without repository, worktree or agent mutation.';
    } else if (kind === 'resume') { draft.state = 'review'; summary = 'Resumed front-plan review.';
    } else if (kind === 'regenerate') {
      if (!normalizedContext) fail('FRONT_DESIGN_SOURCE_UNAVAILABLE', 'regeneration requires current component, goal and map context');
      const previous = clone(draft.alternatives); const selected = selectedAlternative(draft); const answers = new Map(draft.questions.filter((item) => item.state === 'answered').map((item) => [item.id, item.answer]));
      const locks = selected.fronts.flatMap((front) => front.lockedFields.map((field) => ({ slug: front.slug, field, value: clone(front[field]), grounding: clone(front.fieldGrounding[field]) })));
      const fresh = synthesizeFrontPlanAlternatives(normalizedContext, { includeModel: operation.includeModel !== false }); const alternatives = clone(fresh.alternatives);
      for (const alternative of alternatives) for (const front of alternative.fronts) for (const lock of locks.filter((item) => item.slug === front.slug)) { front[lock.field] = lock.value; front.fieldGrounding[lock.field] = lock.grounding; front.lockedFields = [...new Set([...front.lockedFields, lock.field])]; }
      draft.alternatives = alternatives; draft.selectedAlternativeId = alternatives.find((item) => item.strategy === selected.strategy)?.id || alternatives[0].id;
      draft.questions = designQuestions(normalizedContext, alternatives).map((item) => answers.has(item.id) ? { ...item, state: 'answered', answer: answers.get(item.id) } : item); applyQuestionAnswers(draft.alternatives, draft.questions); draft.source = sourceRecord(normalizedContext); draft.diagnostics = fresh.diagnostics;
      draft.lockedDecisions = draft.lockedDecisions.filter((lock) => alternatives.some((alternative) => alternative.fronts.some((front) => front.slug === lock.frontSlug && front.lockedFields.includes(lock.field))));
      const changes = alternatives.map((alternative) => { const prior = previous.find((item) => item.strategy === alternative.strategy); return prior ? { strategy: alternative.strategy, ...alternativeDiff(prior, alternative) } : { strategy: alternative.strategy, addedAlternative: true, materiallyDifferent: true }; });
      const removedStrategies = previous.filter((item) => !alternatives.some((alternative) => alternative.strategy === item.strategy)).map((item) => item.strategy); const materialChanges = changes.filter((item) => item.materiallyDifferent).length + removedStrategies.length;
      historyDetails = { changes, removedStrategies, materialChanges, preservedLocks: locks.length, preservedAnswers: answers.size }; summary = materialChanges ? `Regenerated with ${materialChanges} material plan change(s), preserving ${locks.length} locks and ${answers.size} answers.` : 'Regenerated a stable front plan with no material change.';
    } else fail('UNSUPPORTED_FRONT_DESIGN_OPERATION', `unsupported front design operation '${kind}'`);

    const qualityContext = normalizedContext && normalizedContext.componentDraft.revision === draft.source.componentDraftRevision ? normalizedContext : storedContext(draft);
    for (const alternative of draft.alternatives) {
      alternative.fronts = alternative.fronts.map((front, index) => ({ ...front, order: index + 1 }));
      if (alternative.strategy !== 'existing') validateDependencies(alternative);
      alternative.quality = evaluateFrontPlanAlternative(alternative.fronts, qualityContext);
    }
    const afterRevision = draftRevision(draft); draft.history.push({ id: stableId('history', draft.id, beforeRevision, afterRevision, kind), at: new Date(this.now()).toISOString(), operation: kind, summary, beforeRevision, afterRevision, ...(historyDetails ? { details: historyDetails } : {}) });
    this.#save(draft); return publicDraft(draft, normalizedContext);
  }

  delete(repositoryId, id) { const draft = this.#load(id); if (draft.repositoryId !== repositoryId) fail('FRONT_DESIGN_DRAFT_NOT_FOUND', 'front planning draft does not belong to this repository'); rmSync(this.#path(id), { force: true }); return { deleted: id }; }

  deleteRepository(repositoryId) { for (const draft of this.list(repositoryId)) rmSync(this.#path(draft.id), { force: true }); }
}

export function frontDesignFailure(error) { return error instanceof FrontDesignError ? error : new FrontDesignError('FRONT_DESIGN_INTERNAL', String(error?.message || error || 'front design failed'), { cause: error }); }
