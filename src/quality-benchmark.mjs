import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  COMPONENT_DESIGN_SCHEMA_VERSION,
  synthesizeArchitectureAlternatives,
} from './component-design.mjs';
import {
  FRONT_DESIGN_SCHEMA_VERSION,
  synthesizeFrontPlanAlternatives,
} from './front-design.mjs';
import {
  ANALYSIS_SCHEMA_VERSION,
  createAnalysisSnapshot,
} from './intelligence/contracts.mjs';
import {
  SYSTEM_MAP_ALGORITHM_VERSION,
  SYSTEM_MAP_SCHEMA_VERSION,
  compareSystemMaps,
  deriveSystemMap,
} from './intelligence/system-map.mjs';
import { normalizeProductBrief } from './product-direction.mjs';
import { reconcileArchitecture } from './reconciliation.mjs';
import {
  WORK_CONTRACT_SCHEMA_VERSION,
  createComponentMarkdown,
  createFrontMarkdown,
  parseComponentContract,
  parseFrontContract,
  validatePortfolioContracts,
} from './work-contracts.mjs';

export const QUALITY_BENCHMARK_SCHEMA_VERSION = 1;
export const QUALITY_BENCHMARK_ENGINE_VERSION = '1.0.0';
export const QUALITY_REGRESSION_CATEGORIES = Object.freeze([
  'code-evidence', 'analyzer-output', 'inference', 'inference-ranking', 'formatting-only', 'unchanged',
]);

const FIXTURE_CREATED_AT = '2026-08-03T12:00:00.000Z';
const CHANGED_CREATED_AT = '2026-08-03T12:05:00.000Z';
const INJECTION_MARKER = 'HANDRAISE_BENCHMARK_INJECTION_MARKER';
const SECRET_PATH = /(^|\/)(?:\.env(?:\.|$)|\.git\/|id_(?:rsa|ed25519)|credentials?(?:\.|$)|secrets?(?:\.|$))/i;

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function ratio(numerator, denominator, empty = 1) { return denominator ? numerator / denominator : empty; }
function round(value, digits = 6) { return Number(Number(value || 0).toFixed(digits)); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QualityBenchmarkError('INVALID_BENCHMARK', `${label} must be an object`);
  return value;
}

export class QualityBenchmarkError extends Error {
  constructor(code, message, details = null, options = {}) {
    super(message, options);
    this.name = 'QualityBenchmarkError';
    this.code = code;
    this.details = details;
  }
}

export function validateQualityBenchmarkDefinition({ corpus, rubric } = {}) {
  assertRecord(corpus, 'corpus');
  assertRecord(rubric, 'rubric');
  if (corpus.schemaVersion !== 1 || rubric.schemaVersion !== 1) {
    throw new QualityBenchmarkError('INCOMPATIBLE_BENCHMARK_SCHEMA', 'corpus and rubric schemaVersion must both be 1');
  }
  if (!corpus.corpusVersion || !rubric.benchmarkVersion || !rubric.protocolVersion) {
    throw new QualityBenchmarkError('INVALID_BENCHMARK', 'corpusVersion, benchmarkVersion and protocolVersion are required');
  }
  if (!Array.isArray(corpus.cases) || !corpus.cases.length) throw new QualityBenchmarkError('INVALID_BENCHMARK', 'corpus needs at least one case');
  const ids = new Set();
  for (const [index, value] of corpus.cases.entries()) {
    const item = assertRecord(value, `corpus.cases[${index}]`);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(item.id || '')) throw new QualityBenchmarkError('INVALID_BENCHMARK_CASE', `case ${index + 1} needs a kebab-case id`);
    if (ids.has(item.id)) throw new QualityBenchmarkError('INVALID_BENCHMARK_CASE', `duplicate case '${item.id}'`);
    ids.add(item.id);
    if (!item.class || !['default', 'large'].includes(item.scale)) throw new QualityBenchmarkError('INVALID_BENCHMARK_CASE', `case '${item.id}' needs class and default/large scale`);
    if (!Array.isArray(item.fixture?.files) || !Array.isArray(item.fixture?.entities) || !Array.isArray(item.fixture?.relations)) {
      throw new QualityBenchmarkError('INVALID_BENCHMARK_CASE', `case '${item.id}' needs files, entities and relations`);
    }
    const paths = new Set();
    for (const file of item.fixture.files) {
      if (!file.path || file.path.startsWith('/') || file.path.split('/').includes('..')) throw new QualityBenchmarkError('INVALID_BENCHMARK_CASE', `case '${item.id}' contains an unsafe fixture path`);
      if (paths.has(file.path)) throw new QualityBenchmarkError('INVALID_BENCHMARK_CASE', `case '${item.id}' duplicates '${file.path}'`);
      paths.add(file.path);
    }
    if (!Array.isArray(item.ownerReference?.facts) || !Array.isArray(item.ownerReference?.acceptableDecompositions)) {
      throw new QualityBenchmarkError('INVALID_BENCHMARK_CASE', `case '${item.id}' needs owner facts and acceptable decompositions`);
    }
  }
  const hard = rubric.gates?.hard;
  const human = rubric.gates?.human;
  if (!hard || !human || hard.maxSafetyFailures !== 0 || hard.maxEvidenceFailures !== 0 || human.minimumUsefulStartingPointRatio < 0.8) {
    throw new QualityBenchmarkError('INVALID_BENCHMARK_RUBRIC', 'rubric must preserve zero-tolerance safety/evidence and at least 80% human usefulness');
  }
  return { caseIds: [...ids], corpusVersion: corpus.corpusVersion, benchmarkVersion: rubric.benchmarkVersion };
}

function selectedFiles(fixture) { return fixture.files.filter((file) => file.selected !== false); }

function exclusionReason(file) {
  if (file.symlinkTarget) return 'symlink target escapes or requires explicit resolution';
  if (file.binary) return 'binary content excluded';
  if (file.generated) return 'generated content excluded';
  if (SECRET_PATH.test(file.path)) return 'secret-bearing path excluded';
  return 'fixture selection excluded this path';
}

function languageFor(path) {
  const extension = path.split('.').pop()?.toLocaleLowerCase();
  return ({ mjs: 'JavaScript', js: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', sql: 'SQL', go: 'Go', rs: 'Rust', php: 'PHP', rb: 'Ruby', java: 'Java', kt: 'Kotlin' })[extension] || 'Text';
}

function evidenceId(path) { return `evidence:${sha256(path).slice(0, 24)}`; }

export function createBenchmarkSnapshot(benchmarkCaseValue, { changed = false } = {}) {
  const benchmarkCase = clone(assertRecord(benchmarkCaseValue, 'benchmarkCase'));
  const fixture = changed ? applyBenchmarkChange(benchmarkCase.fixture, benchmarkCase.change) : benchmarkCase.fixture;
  const files = selectedFiles(fixture);
  const paths = new Set(files.map((file) => file.path));
  const evidence = files.map((file) => ({
    id: evidenceId(file.path), sourceKind: 'source', provenance: 'extracted', path: file.path,
    revision: sha256(file.content || ''), excerptHash: sha256(file.content || ''),
    summary: `Selected benchmark source evidence at ${file.path}.`,
  }));
  const entityInputs = fixture.entities.filter((entity) => !entity.path || paths.has(entity.path));
  const entityIds = new Set(entityInputs.map((entity) => entity.id));
  const entities = entityInputs.map((entity) => ({
    id: entity.id, kind: entity.kind, name: entity.name,
    ...(entity.path ? { location: { path: entity.path } } : {}),
    ...(entity.path ? { language: languageFor(entity.path) } : {}),
    evidenceIds: entity.path ? [evidenceId(entity.path)] : [],
    attributes: { community: entity.community || 'unclassified', benchmarkCase: benchmarkCase.id },
  }));
  const relations = fixture.relations.filter((relation) => entityIds.has(relation.source) && entityIds.has(relation.target)).map((relation) => ({
    id: relation.id, source: relation.source, target: relation.target, kind: relation.kind,
    confidence: 0.95,
    evidenceIds: unique([
      entities.find((entity) => entity.id === relation.source)?.evidenceIds?.[0],
      entities.find((entity) => entity.id === relation.target)?.evidenceIds?.[0],
    ]),
  }));
  const analyzerVersion = fixture.analyzerVersion || '1.0.0';
  return createAnalysisSnapshot({
    repository: { id: `benchmark:${benchmarkCase.id}`, adapter: 'benchmark' },
    createdAt: changed ? CHANGED_CREATED_AT : FIXTURE_CREATED_AT,
    analyzer: {
      id: 'benchmark-semantic-fixture', name: 'Versioned benchmark semantic fixture', version: analyzerVersion, contractVersion: ANALYSIS_SCHEMA_VERSION,
      capabilities: {
        languages: unique(files.map((file) => languageFor(file.path))).sort(),
        entityKinds: unique(entities.map((entity) => entity.kind)).sort(),
        relationKinds: unique(relations.map((relation) => relation.kind)).sort(),
        queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: true, incremental: false,
      },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: { benchmarkVersion: '1.0.0', caseId: benchmarkCase.id },
    status: 'complete', freshness: { state: 'current', checkedAt: changed ? CHANGED_CREATED_AT : FIXTURE_CREATED_AT },
    manifest: {
      files: files.map((file) => ({ path: file.path, digest: sha256(file.content || ''), size: Buffer.byteLength(file.content || ''), source: file.source || 'tracked' })),
      git: { head: sha256(`${benchmarkCase.id}:${changed ? 'changed' : 'base'}`).slice(0, 40), branch: benchmarkCase.class === 'dirty-tree' ? 'feature/benchmark' : 'main', dirty: files.some((file) => file.source === 'untracked') },
      selection: { includeUntracked: files.some((file) => file.source === 'untracked'), includeIgnored: false, exclusions: fixture.files.filter((file) => file.selected === false).map((file) => file.path) },
    },
    scope: {
      included: files.map((file) => file.path),
      excluded: fixture.files.filter((file) => file.selected === false).map((file) => ({ pattern: file.path, reason: exclusionReason(file) })),
      truncated: false, limits: { maxFiles: 10_000, maxBytes: 50_000_000 },
    },
    evidence, entities, relations, findings: [],
    coverage: unique(files.map((file) => languageFor(file.path))).sort().map((language) => ({ id: `coverage:${language.toLocaleLowerCase()}`, subject: language, status: 'covered', summary: `${language} is represented by normalized fixture facts.`, evidenceIds: [] })),
    diagnostics: [],
  });
}

export function applyBenchmarkChange(fixtureValue, changeValue = {}) {
  const fixture = clone(fixtureValue);
  const change = changeValue || {};
  for (const move of change.moves || []) {
    const file = fixture.files.find((item) => item.path === move.from);
    if (file) file.path = move.to;
    for (const entity of fixture.entities) if (entity.path === move.from) entity.path = move.to;
  }
  for (const modification of change.modifies || []) {
    const file = fixture.files.find((item) => item.path === modification.path);
    if (file) file.content = modification.content;
  }
  if (change.removes) {
    const removedPaths = new Set(change.removes.paths || []);
    const removedEntities = new Set(change.removes.entityIds || []);
    const removedRelations = new Set(change.removes.relationIds || []);
    fixture.files = fixture.files.filter((file) => !removedPaths.has(file.path));
    fixture.entities = fixture.entities.filter((entity) => !removedEntities.has(entity.id) && !removedPaths.has(entity.path));
    const retainedIds = new Set(fixture.entities.map((entity) => entity.id));
    fixture.relations = fixture.relations.filter((relation) => !removedRelations.has(relation.id) && retainedIds.has(relation.source) && retainedIds.has(relation.target));
  }
  if (change.adds) {
    fixture.files.push(...clone(change.adds.files || []));
    fixture.entities.push(...clone(change.adds.entities || []));
    fixture.relations.push(...clone(change.adds.relations || []));
  }
  if (change.analyzerVersion) fixture.analyzerVersion = change.analyzerVersion;
  return fixture;
}

function productFor(benchmarkCase) {
  const goalId = `goal:${benchmarkCase.id}`;
  const brief = normalizeProductBrief({
    title: benchmarkCase.product.title,
    stage: 'benchmark',
    purpose: { id: 'purpose', text: 'Understand the system. Design the work. Run the agents.', sourceIds: ['source:human'], locked: true },
    users: [{ id: 'user:owner', text: 'Repository owners organizing safe agent work.', sourceIds: ['source:human'] }],
    outcomes: [{ id: 'outcome:case', text: benchmarkCase.product.outcome, sourceIds: ['source:human'], locked: true }],
    constraints: [{ id: 'constraint:evidence', text: 'Every proposed responsibility and task remains reviewable and evidence-grounded.', sourceIds: ['source:human'], locked: true }],
    invariants: [{ id: 'invariant:no-mutation', text: 'Evaluation never mutates the repository or accepted planning contracts.', sourceIds: ['source:human'], locked: true }],
    goals: [{ id: goalId, title: benchmarkCase.product.goal, outcome: benchmarkCase.product.outcome, priority: 'now', state: 'active', successSignals: ['Gate C'], sourceIds: ['source:human'] }],
  }, { repositoryId: `benchmark:${benchmarkCase.id}`, now: Date.parse(FIXTURE_CREATED_AT) });
  return { product: { exists: true, revision: sha256(canonical(brief)), brief }, goalId };
}

function componentScore(alternative) {
  const quality = alternative.quality;
  return (quality.gateC.pass ? 1_000_000 : 0)
    + quality.coverage.ratio * 100_000
    - quality.overlap.entities * 10_000
    - quality.dependencyCycles.length * 100_000
    - quality.duplicateResponsibilities.length * 1_000
    + (quality.cohesion.ratio ?? 0) * 100;
}

function frontScore(alternative) {
  const quality = alternative.quality;
  return (quality.gateD.pass ? 1_000_000 : 0)
    - quality.gateD.hardFailures * 100_000
    - quality.broadFronts.length * 10_000
    - quality.parallelism.collisions.length * 1_000
    + (quality.goalCoverage.covered ? 500 : 0)
    + quality.feedback.independentOutcomeSlices * 10;
}

function selectAlternative(alternatives, mode, kind) {
  if (!alternatives.length) throw new QualityBenchmarkError('EMPTY_CANDIDATE', `${kind} synthesis returned no alternatives`);
  if (mode === 'baseline') {
    const strategy = kind === 'component' ? 'responsibility' : 'outcome-slices';
    return alternatives.find((item) => item.strategy === strategy) || alternatives[0];
  }
  const score = kind === 'component' ? componentScore : frontScore;
  return [...alternatives].sort((left, right) => score(right) - score(left) || left.id.localeCompare(right.id))[0];
}

function designCandidate(benchmarkCase, snapshot, map, mode) {
  const { product, goalId } = productFor(benchmarkCase);
  const architecture = synthesizeArchitectureAlternatives({
    analysisJobId: `analysis:${benchmarkCase.id}`, planningJobId: null, snapshot, map, product,
    portfolio: { components: [], fronts: [] }, planningResult: null, modelEvidenceIds: [],
  }, { includeModel: false });
  const componentAlternative = selectAlternative(architecture.alternatives, mode, 'component');
  const componentRevision = sha256(canonical(componentAlternative));
  const componentDraft = {
    id: `component-draft:${sha256(benchmarkCase.id).slice(0, 24)}`,
    repositoryId: snapshot.repository.id, revision: componentRevision,
    selectedAlternativeId: componentAlternative.id, alternatives: architecture.alternatives,
  };
  const planning = synthesizeFrontPlanAlternatives({
    analysisJobId: `analysis:${benchmarkCase.id}`, planningJobId: null, snapshot, map,
    componentDraft, componentAlternativeId: componentAlternative.id,
    product, goalId, portfolio: { components: [], fronts: [] }, planningResult: null, modelEvidenceIds: [],
  }, { includeModel: false });
  const frontAlternative = selectAlternative(planning.alternatives, mode, 'front');
  return { product, goalId, architecture, componentAlternative, planning, frontAlternative };
}

function mapReferenceCatalog(map) {
  return new Set(unique([
    map.id, map.snapshotId,
    ...(map.evidence || []).map((item) => item.id),
    ...(map.entities || []).map((item) => item.id),
    ...(map.relations || []).map((item) => item.id),
    ...(map.groups || []).map((item) => item.id),
  ]));
}

function candidateReferences(candidate) {
  return unique([
    ...candidate.componentAlternative.components.flatMap((component) => [
      ...(component.contract.evidence || []).map((item) => item.reference),
      ...Object.values(component.fieldGrounding || {}).flatMap((field) => field.evidenceIds || []),
    ]),
    ...candidate.frontAlternative.fronts.flatMap((front) => [
      ...(front.evidence || []).map((item) => item.reference),
      ...Object.values(front.fieldGrounding || {}).flatMap((field) => field.evidenceIds || []),
    ]),
  ]);
}

function pairwiseAgreement(components, reference) {
  const ids = unique(reference.groups.flat());
  if (ids.length < 2) return 1;
  const owners = new Map(ids.map((id) => [id, components.filter((component) => component.memberEntityIds.includes(id)).map((component) => component.slug)]));
  const referenceGroup = new Map();
  for (const [groupIndex, group] of reference.groups.entries()) for (const id of group) referenceGroup.set(id, groupIndex);
  let agreed = 0; let total = 0;
  for (let left = 0; left < ids.length; left += 1) for (let right = left + 1; right < ids.length; right += 1) {
    const predictedTogether = owners.get(ids[left]).some((owner) => owners.get(ids[right]).includes(owner));
    const expectedTogether = referenceGroup.get(ids[left]) === referenceGroup.get(ids[right]);
    if (predictedTogether === expectedTogether) agreed += 1;
    total += 1;
  }
  return ratio(agreed, total);
}

function contractMetrics(candidate) {
  const componentContracts = [];
  const frontContracts = [];
  const failures = [];
  for (const component of candidate.componentAlternative.components) {
    try { componentContracts.push(parseComponentContract(createComponentMarkdown(component, { since: '1970-01-01' }))); }
    catch (error) { failures.push({ kind: 'component', slug: component.slug, code: error.code || 'CONTRACT_ROUNDTRIP' }); }
  }
  for (const front of candidate.frontAlternative.fronts) {
    try {
      frontContracts.push(parseFrontContract(createFrontMarkdown({
        ...front, component: front.leadComponent, analysisSnapshot: candidate.architecture.context.snapshot.id,
        risks: unique([...(front.risks || []), ...(front.unknowns || []).map((item) => `[Unknown] ${item}`)]),
      })));
    } catch (error) { failures.push({ kind: 'front', slug: front.slug, code: error.code || 'CONTRACT_ROUNDTRIP' }); }
  }
  const validation = validatePortfolioContracts(componentContracts, frontContracts, { goalIds: [candidate.goalId] });
  const total = componentContracts.length + frontContracts.length + failures.length;
  const completeFronts = frontContracts.filter((front) => [
    front.outcome, front.motivation, front.scope, front.readiness, front.acceptanceCriteria,
    front.verification, front.deliverables, front.risks, front.evidence, front.tasks,
  ].every((field) => field && (!Array.isArray(field) || field.length))).length;
  const goalLinked = frontContracts.filter((front) => front.goalIds.includes(candidate.goalId)).length;
  const acceptanceVerification = frontContracts.filter((front) => front.acceptanceCriteria.length && front.verification.length).length;
  return {
    componentContracts, frontContracts, failures, validation,
    validRatio: validation.valid && !failures.length ? 1 : ratio(total - failures.length - validation.summary.errors, total),
    completeFrontRatio: ratio(completeFronts, frontContracts.length, 0),
    goalLinkRatio: ratio(goalLinked, frontContracts.length, 0),
    acceptanceVerificationRatio: ratio(acceptanceVerification, frontContracts.length, 0),
  };
}

function securityMetrics(benchmarkCase, snapshot, candidate) {
  const dangerous = benchmarkCase.fixture.files.filter((file) => file.selected === false || file.generated || file.binary || file.symlinkTarget || SECRET_PATH.test(file.path));
  const included = new Set(snapshot.scope.included);
  const references = canonical({ components: candidate.componentAlternative.components, fronts: candidate.frontAlternative.fronts });
  const selectedDangerousPaths = dangerous.filter((file) => included.has(file.path)).map((file) => file.path);
  const leakedDangerousPaths = dangerous.filter((file) => references.includes(file.path)).map((file) => file.path);
  return {
    selectedDangerousPaths, leakedDangerousPaths,
    injectionMarkerPresent: references.includes(INJECTION_MARKER),
    failures: selectedDangerousPaths.length + leakedDangerousPaths.length + Number(references.includes(INJECTION_MARKER)),
  };
}

function uncoordinatedOwnershipCollisions(fronts, collisions) {
  const edges = new Map(fronts.map((front) => [front.slug, (front.dependencies || []).map((dependency) => dependency.target)]));
  const reaches = (source, target, seen = new Set()) => {
    if (source === target) return true;
    if (seen.has(source)) return false;
    seen.add(source);
    return (edges.get(source) || []).some((next) => reaches(next, target, seen));
  };
  return collisions.filter((collision) => !reaches(collision.left, collision.right) && !reaches(collision.right, collision.left));
}

function summarizeCase(benchmarkCase, mode, measurements) {
  const { snapshot, map, candidate, changedMap, cycle, comparison, contracts, durations, mutationFailure } = measurements;
  const referenceCatalog = mapReferenceCatalog(map);
  const references = candidateReferences(candidate);
  const unresolved = references.filter((reference) => !referenceCatalog.has(reference));
  const requiredFacts = benchmarkCase.ownerReference.facts.filter((fact) => fact.required !== false);
  const entityIds = new Set(map.entities.map((entity) => entity.id));
  const evidencePaths = new Set(map.evidence.map((item) => item.path).filter(Boolean));
  const coveredFacts = requiredFacts.filter((fact) => (fact.entityIds || []).every((id) => entityIds.has(id)) && (fact.evidencePaths || []).every((path) => evidencePaths.has(path)));
  const agreements = benchmarkCase.ownerReference.acceptableDecompositions.map((reference) => ({ id: reference.id, ratio: pairwiseAgreement(candidate.componentAlternative.components, reference) }));
  const bestAgreement = agreements.sort((left, right) => right.ratio - left.ratio)[0] || { id: null, ratio: 0 };
  const expectedKinds = benchmarkCase.change?.expectedFindingKinds || [];
  const observedKinds = unique(cycle.findings.map((finding) => finding.kind));
  const recalledKinds = expectedKinds.filter((kind) => observedKinds.includes(kind));
  const security = securityMetrics(benchmarkCase, snapshot, candidate);
  const componentQuality = candidate.componentAlternative.quality;
  const frontQuality = candidate.frontAlternative.quality;
  const ownershipCollisions = uncoordinatedOwnershipCollisions(candidate.frontAlternative.fronts, frontQuality.parallelism.collisions);
  const semantic = {
    manifestDigest: snapshot.manifest.digest,
    analyzer: `${snapshot.analyzer.id}@${snapshot.analyzer.version}`,
    componentStrategy: candidate.componentAlternative.strategy,
    componentDigest: sha256(canonical(candidate.componentAlternative.components)),
    frontStrategy: candidate.frontAlternative.strategy,
    frontDigest: sha256(canonical(candidate.frontAlternative.fronts)),
    contractDigest: sha256(canonical({ components: contracts.componentContracts, fronts: contracts.frontContracts })),
  };
  const hard = {
    safetyFailures: componentQuality.gateC.hardFailures + frontQuality.gateD.hardFailures,
    evidenceFailures: unresolved.length,
    mutationFailures: Number(mutationFailure),
    schemaFailures: contracts.failures.length + contracts.validation.summary.errors,
    securityFailures: security.failures,
    hardDependencyCycles: componentQuality.dependencyCycles.length + frontQuality.dependencyCycles.length,
  };
  const sanitized = {
    id: benchmarkCase.id, class: benchmarkCase.class, scale: benchmarkCase.scale, candidate: mode,
    selected: {
      componentStrategy: candidate.componentAlternative.strategy, frontStrategy: candidate.frontAlternative.strategy,
      componentCount: candidate.componentAlternative.components.length, frontCount: candidate.frontAlternative.fronts.length,
      componentAlternativeCount: candidate.architecture.alternatives.length, frontAlternativeCount: candidate.planning.alternatives.length,
    },
    understanding: {
      evidenceResolution: round(ratio(references.length - unresolved.length, references.length)),
      evidenceReferences: references.length, unresolvedReferences: unresolved,
      requiredFactCoverage: round(ratio(coveredFacts.length, requiredFacts.length)), requiredFacts: requiredFacts.length, coveredFacts: coveredFacts.length,
      expectedDriftRecall: round(ratio(recalledKinds.length, expectedKinds.length)), expectedFindingKinds: expectedKinds, observedFindingKinds: observedKinds,
      exclusionsDeclared: snapshot.scope.excluded.length, snapshotStatus: snapshot.status, truncated: snapshot.scope.truncated,
      comparisonCauses: comparison.causes,
    },
    componentDesign: {
      responsibilityCoverage: round(componentQuality.coverage.ratio), bestAlternativeAgreement: round(bestAgreement.ratio), closestReferenceAlternative: bestAgreement.id,
      entityOverlapRatio: round(ratio(componentQuality.overlap.entities, map.entities.length)), overlappingEntities: componentQuality.overlap.entities,
      dependencyCycles: componentQuality.dependencyCycles.length, unstableBoundaries: componentQuality.unstableBoundaries.length,
      diagnosticCodes: componentQuality.diagnostics.map((item) => item.code),
    },
    frontDesign: {
      completeFrontRatio: round(contracts.completeFrontRatio), goalLinkRatio: round(contracts.goalLinkRatio),
      ownershipCollisions: ownershipCollisions.length, coordinatedOverlaps: frontQuality.parallelism.collisions.length - ownershipCollisions.length,
      hardDependencyCycles: frontQuality.dependencyCycles.length,
      readyFronts: frontQuality.readySet.length, diagnosticCodes: frontQuality.diagnostics.map((item) => item.code),
    },
    execution: {
      validContractRatio: round(contracts.validRatio), acceptanceVerificationRatio: round(contracts.acceptanceVerificationRatio),
      portfolioValid: contracts.validation.valid, validationCodes: contracts.validation.diagnostics.map((item) => item.code), roundTripFailures: contracts.failures,
    },
    reconciliation: { expected: expectedKinds.length, recalled: recalledKinds.length, recall: round(ratio(recalledKinds.length, expectedKinds.length)), findingCount: cycle.findings.length },
    stability: { deterministic: false, firstDigest: '', repeatedDigest: '' },
    security,
    hard,
    performance: {
      totalMs: round(durations.totalMs, 3), mapMs: round(durations.mapMs, 3), componentMs: round(durations.componentMs, 3),
      frontMs: round(durations.frontMs, 3), reconciliationMs: round(durations.reconciliationMs, 3), resultBytes: 0,
      heapDeltaBytes: measurements.heapDeltaBytes,
    },
    semantic,
    changedMapDigest: sha256(canonical({ id: changedMap.id, entities: changedMap.entities, relations: changedMap.relations })),
  };
  return sanitized;
}

function evaluateCase(benchmarkCase, mode) {
  const immutableBefore = canonical(benchmarkCase);
  const heapBefore = process.memoryUsage().heapUsed;
  const totalStarted = performance.now();
  const snapshot = createBenchmarkSnapshot(benchmarkCase);
  const mapStarted = performance.now();
  const map = deriveSystemMap(snapshot);
  const mapMs = performance.now() - mapStarted;
  const componentStarted = performance.now();
  const { product, goalId } = productFor(benchmarkCase);
  const architecture = synthesizeArchitectureAlternatives({
    analysisJobId: `analysis:${benchmarkCase.id}`, planningJobId: null, snapshot, map, product,
    portfolio: { components: [], fronts: [] }, planningResult: null, modelEvidenceIds: [],
  }, { includeModel: false });
  const componentAlternative = selectAlternative(architecture.alternatives, mode, 'component');
  const componentMs = performance.now() - componentStarted;
  const frontStarted = performance.now();
  const componentDraft = {
    id: `component-draft:${sha256(benchmarkCase.id).slice(0, 24)}`, repositoryId: snapshot.repository.id,
    revision: sha256(canonical(componentAlternative)), selectedAlternativeId: componentAlternative.id, alternatives: architecture.alternatives,
  };
  const planning = synthesizeFrontPlanAlternatives({
    analysisJobId: `analysis:${benchmarkCase.id}`, planningJobId: null, snapshot, map, componentDraft,
    componentAlternativeId: componentAlternative.id, product, goalId,
    portfolio: { components: [], fronts: [] }, planningResult: null, modelEvidenceIds: [],
  }, { includeModel: false });
  const frontAlternative = selectAlternative(planning.alternatives, mode, 'front');
  const frontMs = performance.now() - frontStarted;
  const candidate = { product, goalId, architecture, componentAlternative, planning, frontAlternative };
  const contracts = contractMetrics(candidate);
  const reconciliationStarted = performance.now();
  const changedSnapshot = createBenchmarkSnapshot(benchmarkCase, { changed: true });
  const changedMap = deriveSystemMap(changedSnapshot);
  const comparison = compareSystemMaps(map, changedMap);
  const cycle = reconcileArchitecture({
    repository: snapshot.repository, fromMap: map, toMap: changedMap, comparison,
    portfolio: { components: componentAlternative.components, fronts: frontAlternative.fronts, product },
    cause: 'quality-benchmark', sourceId: benchmarkCase.id, now: Date.parse(CHANGED_CREATED_AT),
  });
  const reconciliationMs = performance.now() - reconciliationStarted;
  const totalMs = performance.now() - totalStarted;
  const result = summarizeCase(benchmarkCase, mode, {
    snapshot, map, candidate, contracts, changedMap, comparison, cycle,
    mutationFailure: immutableBefore !== canonical(benchmarkCase),
    durations: { totalMs, mapMs, componentMs, frontMs, reconciliationMs },
    heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
  });
  const repeated = designCandidate(benchmarkCase, snapshot, map, mode);
  const firstDigest = sha256(canonical({ components: componentAlternative.components, fronts: frontAlternative.fronts }));
  const repeatedDigest = sha256(canonical({ components: repeated.componentAlternative.components, fronts: repeated.frontAlternative.fronts }));
  result.stability = { deterministic: firstDigest === repeatedDigest, firstDigest, repeatedDigest };
  if (!result.stability.deterministic) result.hard.safetyFailures += 1;
  result.performance.resultBytes = Buffer.byteLength(JSON.stringify(result));
  return result;
}

function aggregateCases(cases) {
  const totals = (path) => cases.reduce((sum, item) => sum + path(item), 0);
  const hard = Object.fromEntries(Object.keys(cases[0]?.hard || {}).map((key) => [key, totals((item) => item.hard[key])]));
  const references = totals((item) => item.understanding.evidenceReferences);
  const unresolved = totals((item) => item.understanding.unresolvedReferences.length);
  const requiredFacts = totals((item) => item.understanding.requiredFacts);
  const coveredFacts = totals((item) => item.understanding.coveredFacts);
  const expected = totals((item) => item.reconciliation.expected);
  const recalled = totals((item) => item.reconciliation.recalled);
  const entities = totals((item) => item.componentDesign.responsibilityCoverage > 0 ? 1 : 1);
  return {
    cases: cases.length, hard,
    understanding: {
      evidenceResolution: round(ratio(references - unresolved, references)),
      requiredFactCoverage: round(ratio(coveredFacts, requiredFacts)), expectedDriftRecall: round(ratio(recalled, expected)),
    },
    componentDesign: {
      responsibilityCoverage: round(cases.reduce((sum, item) => sum + item.componentDesign.responsibilityCoverage, 0) / entities),
      bestAlternativeAgreement: round(cases.reduce((sum, item) => sum + item.componentDesign.bestAlternativeAgreement, 0) / entities),
      entityOverlapRatio: round(cases.reduce((sum, item) => sum + item.componentDesign.entityOverlapRatio, 0) / entities),
    },
    frontDesign: {
      completeFrontRatio: round(cases.reduce((sum, item) => sum + item.frontDesign.completeFrontRatio, 0) / entities),
      goalLinkRatio: round(cases.reduce((sum, item) => sum + item.frontDesign.goalLinkRatio, 0) / entities),
      ownershipCollisions: totals((item) => item.frontDesign.ownershipCollisions),
    },
    execution: {
      validContractRatio: round(cases.reduce((sum, item) => sum + item.execution.validContractRatio, 0) / entities),
      acceptanceVerificationRatio: round(cases.reduce((sum, item) => sum + item.execution.acceptanceVerificationRatio, 0) / entities),
    },
    performance: { budgetFailures: 0, cases: [] },
  };
}

function performanceGate(cases, rubric) {
  const failures = [];
  for (const item of cases) {
    const budget = rubric.gates.performance[item.scale];
    const checks = [
      ['totalMs', 'maxTotalMs'], ['mapMs', 'maxMapMs'], ['componentMs', 'maxComponentMs'],
      ['frontMs', 'maxFrontMs'], ['reconciliationMs', 'maxReconciliationMs'], ['resultBytes', 'maxResultBytes'],
    ];
    for (const [metric, threshold] of checks) if (item.performance[metric] > budget[threshold]) failures.push({ caseId: item.id, metric, measured: item.performance[metric], maximum: budget[threshold] });
  }
  return { pass: failures.length === 0, failures };
}

export function captureBlindReviews(reviewBundles = [], { caseIds = [], blindCandidateMap = {} } = {}) {
  const knownCases = new Set(caseIds);
  const captured = [];
  for (const bundle of reviewBundles || []) {
    if (!bundle || bundle.gating !== true || !bundle.reviewerPseudonym) continue;
    const reviewerId = `reviewer:${sha256(bundle.reviewerPseudonym).slice(0, 20)}`;
    for (const assignment of bundle.assignments || []) {
      if (!knownCases.has(assignment.caseId)) continue;
      const candidate = blindCandidateMap[assignment.blindedCandidateId];
      if (!candidate) continue;
      const ratings = assignment.ratings || {};
      const validRatings = ['evidenceIntegrity', 'boundaryUsefulness', 'frontUsefulness', 'uncertaintyHonesty']
        .every((key) => Number.isInteger(ratings[key]) && ratings[key] >= 1 && ratings[key] <= 5);
      if (typeof assignment.usefulStartingPoint !== 'boolean' || !validRatings || !String(assignment.rationale || '').trim()) continue;
      captured.push({
        caseId: assignment.caseId, candidate, reviewerId,
        usefulStartingPoint: assignment.usefulStartingPoint,
        ratings: Object.fromEntries(Object.entries(ratings).map(([key, value]) => [key, Number(value)])),
        harmfulErrors: (assignment.harmfulErrors || []).map(String).slice(0, 50),
        missingResponsibilities: (assignment.missingResponsibilities || []).map(String).slice(0, 50),
        closestReferenceAlternative: assignment.closestReferenceAlternative || null,
        rationale: String(assignment.rationale).trim().slice(0, 8_000),
      });
    }
  }
  return captured;
}

function humanGate(captured, caseIds, rubric, candidate = 'current') {
  const reviews = captured.filter((review) => review.candidate === candidate);
  const byCase = new Map(caseIds.map((id) => [id, []]));
  for (const review of reviews) byCase.get(review.caseId)?.push(review);
  const missingCases = [...byCase.entries()].filter(([, entries]) => new Set(entries.map((item) => item.reviewerId)).size < rubric.minimumReviewsPerCase).map(([id]) => id);
  const result = {
    status: missingCases.length ? 'blocked' : 'pass', reviewCount: reviews.length, missingCases,
    usefulStartingPointRatio: round(ratio(reviews.filter((review) => review.usefulStartingPoint).length, reviews.length, 0)),
    medians: {
      evidenceIntegrity: median(reviews.map((review) => review.ratings.evidenceIntegrity)),
      boundaryUsefulness: median(reviews.map((review) => review.ratings.boundaryUsefulness)),
      frontUsefulness: median(reviews.map((review) => review.ratings.frontUsefulness)),
      uncertaintyHonesty: median(reviews.map((review) => review.ratings.uncertaintyHonesty)),
    },
  };
  if (!missingCases.length && (
    result.usefulStartingPointRatio < rubric.minimumUsefulStartingPointRatio
    || result.medians.evidenceIntegrity < rubric.minimumMedianEvidenceIntegrity
    || result.medians.boundaryUsefulness < rubric.minimumMedianBoundaryUsefulness
    || result.medians.frontUsefulness < rubric.minimumMedianFrontUsefulness
  )) result.status = 'fail';
  return result;
}

export function evaluateQualityGate(summary, rubric, human) {
  const gates = rubric.gates;
  const checks = [];
  for (const [metric, maximum] of Object.entries(gates.hard)) {
    const key = metric.replace(/^max/, '').replace(/^./, (value) => value.toLocaleLowerCase());
    checks.push({ gate: 'hard', metric: key, measured: summary.hard[key] || 0, operator: '<=', threshold: maximum, pass: (summary.hard[key] || 0) <= maximum });
  }
  for (const [metric, minimum] of Object.entries(gates.understanding)) {
    const key = metric.replace(/^minimum/, '').replace(/^./, (value) => value.toLocaleLowerCase());
    checks.push({ gate: 'understanding', metric: key, measured: summary.understanding[key], operator: '>=', threshold: minimum, pass: summary.understanding[key] >= minimum });
  }
  for (const [metric, threshold] of Object.entries(gates.componentDesign)) {
    const maximum = metric.startsWith('maximum');
    const key = metric.replace(/^(minimum|maximum)/, '').replace(/^./, (value) => value.toLocaleLowerCase());
    checks.push({ gate: 'componentDesign', metric: key, measured: summary.componentDesign[key], operator: maximum ? '<=' : '>=', threshold, pass: maximum ? summary.componentDesign[key] <= threshold : summary.componentDesign[key] >= threshold });
  }
  for (const [metric, threshold] of Object.entries(gates.frontDesign)) {
    const maximum = metric.startsWith('maximum');
    const key = metric.replace(/^(minimum|maximum)/, '').replace(/^./, (value) => value.toLocaleLowerCase());
    checks.push({ gate: 'frontDesign', metric: key, measured: summary.frontDesign[key], operator: maximum ? '<=' : '>=', threshold, pass: maximum ? summary.frontDesign[key] <= threshold : summary.frontDesign[key] >= threshold });
  }
  for (const [metric, minimum] of Object.entries(gates.execution)) {
    const key = metric.replace(/^minimum/, '').replace(/^./, (value) => value.toLocaleLowerCase());
    checks.push({ gate: 'execution', metric: key, measured: summary.execution[key], operator: '>=', threshold: minimum, pass: summary.execution[key] >= minimum });
  }
  checks.push({ gate: 'performance', metric: 'budgetFailures', measured: summary.performance.budgetFailures, operator: '<=', threshold: 0, pass: summary.performance.budgetFailures === 0 });
  const automatedPass = checks.every((check) => check.pass);
  const status = !automatedPass || human.status === 'fail' ? 'fail' : human.status === 'blocked' ? 'blocked' : 'pass';
  return { status, promotionAllowed: status === 'pass', automatedPass, humanStatus: human.status, checks };
}

export function classifyQualityRegression(baseline, current) {
  if (baseline.semantic.manifestDigest !== current.semantic.manifestDigest) return 'code-evidence';
  if (baseline.semantic.analyzer !== current.semantic.analyzer) return 'analyzer-output';
  if (baseline.semantic.componentDigest !== current.semantic.componentDigest || baseline.semantic.frontDigest !== current.semantic.frontDigest) {
    if (baseline.selected.componentAlternativeCount === current.selected.componentAlternativeCount && baseline.selected.frontAlternativeCount === current.selected.frontAlternativeCount) return 'inference-ranking';
    return 'inference';
  }
  if (baseline.semantic.contractDigest !== current.semantic.contractDigest) return 'formatting-only';
  return 'unchanged';
}

export function runQualityBenchmark({
  corpus, rubric, reviews = [], blindCandidateMap = {}, generatedAt = new Date().toISOString(),
  packageVersion = 'unknown', analyzerVersion = 'benchmark-semantic-fixture@1.0.0', modelVersion = 'none', promptVersion = 'deterministic-v1',
} = {}) {
  const definition = validateQualityBenchmarkDefinition({ corpus, rubric });
  const baselineCases = corpus.cases.map((benchmarkCase) => evaluateCase(benchmarkCase, 'baseline'));
  const currentCases = corpus.cases.map((benchmarkCase) => evaluateCase(benchmarkCase, 'current'));
  const baseline = aggregateCases(baselineCases);
  const current = aggregateCases(currentCases);
  for (const [summary, cases] of [[baseline, baselineCases], [current, currentCases]]) {
    const gate = performanceGate(cases, rubric);
    summary.performance = { budgetFailures: gate.failures.length, failures: gate.failures };
  }
  const capturedReviews = captureBlindReviews(reviews, { caseIds: definition.caseIds, blindCandidateMap });
  const human = humanGate(capturedReviews, definition.caseIds, rubric.gates.human, 'current');
  const gate = evaluateQualityGate(current, rubric, human);
  const regressions = currentCases.map((item, index) => ({ caseId: item.id, category: classifyQualityRegression(baselineCases[index], item) }));
  const categories = Object.fromEntries(QUALITY_REGRESSION_CATEGORIES.map((category) => [category, regressions.filter((item) => item.category === category).length]));
  return {
    schemaVersion: QUALITY_BENCHMARK_SCHEMA_VERSION,
    benchmarkVersion: rubric.benchmarkVersion, corpusVersion: corpus.corpusVersion, protocolVersion: rubric.protocolVersion,
    generatedAt, status: gate.status, promotionAllowed: gate.promotionAllowed,
    versions: {
      package: packageVersion, benchmarkEngine: QUALITY_BENCHMARK_ENGINE_VERSION,
      analysisSchema: ANALYSIS_SCHEMA_VERSION, systemMapSchema: SYSTEM_MAP_SCHEMA_VERSION, systemMapAlgorithm: SYSTEM_MAP_ALGORITHM_VERSION,
      componentDesignSchema: COMPONENT_DESIGN_SCHEMA_VERSION, frontDesignSchema: FRONT_DESIGN_SCHEMA_VERSION,
      workContractSchema: WORK_CONTRACT_SCHEMA_VERSION, analyzer: analyzerVersion, model: modelVersion, prompt: promptVersion,
      corpusDigest: sha256(canonical(corpus)), rubricDigest: sha256(canonical(rubric)),
    },
    gate, human,
    candidates: { baseline: { summary: baseline, cases: baselineCases }, current: { summary: current, cases: currentCases } },
    regressions: { categories, cases: regressions },
    reviews: capturedReviews,
    privacy: { sourceCaptured: false, reviewerPseudonymsHashed: true, modelConfidenceUsedAsHumanRating: false },
    limitations: [
      'The checked-in corpus is synthetic and cannot substitute for independent repository-owner review.',
      'Automated structural agreement accepts multiple owner-authored decompositions but does not prove responsibility usefulness.',
      'Performance measurements depend on the host and are evaluated against fixture-class budgets.',
      ...(human.status === 'blocked' ? [`Human Gate C is blocked: ${human.missingCases.length} case(s) lack the required independent blind review.`] : []),
    ],
  };
}

function percent(value) { return `${Math.round(Number(value || 0) * 100)}%`; }

export function renderQualityBenchmarkMarkdown(report) {
  const current = report.candidates.current.summary;
  const lines = [
    `# Handraise planning quality benchmark ${report.benchmarkVersion}`,
    '',
    `**Release gate:** ${report.status.toUpperCase()} · **Promotion allowed:** ${report.promotionAllowed ? 'yes' : 'no'}`,
    '',
    `Generated ${report.generatedAt}. Corpus ${report.corpusVersion}; protocol ${report.protocolVersion}; package ${report.versions.package}.`,
    '',
    '## Gate summary',
    '',
    '| Dimension | Result |',
    '| --- | ---: |',
    `| Evidence resolution | ${percent(current.understanding.evidenceResolution)} |`,
    `| Required fact coverage | ${percent(current.understanding.requiredFactCoverage)} |`,
    `| Expected drift recall | ${percent(current.understanding.expectedDriftRecall)} |`,
    `| Responsibility coverage | ${percent(current.componentDesign.responsibilityCoverage)} |`,
    `| Best valid decomposition agreement | ${percent(current.componentDesign.bestAlternativeAgreement)} |`,
    `| Complete fronts | ${percent(current.frontDesign.completeFrontRatio)} |`,
    `| Valid contract portfolios | ${percent(current.execution.validContractRatio)} |`,
    `| Hard failures | ${Object.values(current.hard).reduce((sum, value) => sum + value, 0)} |`,
    `| Performance budget failures | ${current.performance.budgetFailures} |`,
    `| Blind human reviews | ${report.human.reviewCount} (${report.human.status}) |`,
    '',
    '## Baseline → current regressions',
    '',
    ...QUALITY_REGRESSION_CATEGORIES.map((category) => `- ${category}: ${report.regressions.categories[category]}`),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((item) => `- ${item}`),
    '',
    '## Per-case current results',
    '',
    '| Case | Components | Fronts | Coverage | Agreement | Drift recall | Hard failures |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.candidates.current.cases.map((item) => `| ${item.id} | ${item.selected.componentCount} | ${item.selected.frontCount} | ${percent(item.componentDesign.responsibilityCoverage)} | ${percent(item.componentDesign.bestAlternativeAgreement)} | ${percent(item.reconciliation.recall)} | ${Object.values(item.hard).reduce((sum, value) => sum + value, 0)} |`),
    '',
    'This report contains metrics, digests and anonymized reviewer rationale only; repository source is not captured.',
    '',
  ];
  return lines.join('\n');
}
