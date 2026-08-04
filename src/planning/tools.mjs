import { validateAnalysisSnapshot } from '../intelligence/contracts.mjs';
import { queryAnalysisSnapshot } from '../intelligence/memory-query.mjs';
import {
  PLANNING_CONTEXT_LIMITS, PlanningError, createPlanningContext,
} from './contracts.mjs';

export const PLANNING_TOOL_LIMITS = Object.freeze({
  maxGraphQueries: PLANNING_CONTEXT_LIMITS.maxGraphQueries,
  maxGraphResults: PLANNING_CONTEXT_LIMITS.maxQueryResults,
  maxEvidenceResults: 120,
  maxProductItemsPerSection: 30,
  maxPortfolioComponents: 40,
  maxPortfolioFronts: 80,
});

const PRODUCT_SECTIONS = new Set([
  'purpose', 'users', 'outcomes', 'constraints', 'invariants', 'nonGoals', 'goals',
  'repositoryRoles', 'assumptions', 'decisions', 'conflicts', 'glossary',
]);

function clean(value, max = 2_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function integer(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new PlanningError('INVALID_TOOL_ARGUMENT', `${name} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

function array(value, name, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PlanningError('INVALID_TOOL_ARGUMENT', `${name} must be an array`);
  if (value.length > max) throw new PlanningError('TOOL_LIMIT_EXCEEDED', `${name} accepts at most ${max} items`);
  return value;
}

function compactEvidence(item) {
  return {
    id: item.id,
    sourceKind: item.sourceKind,
    provenance: item.provenance,
    ...(item.path ? { path: item.path } : {}),
    ...(item.range ? { range: item.range } : {}),
    ...(item.revision ? { revision: clean(item.revision, 256) } : {}),
    ...(item.summary ? { summary: clean(item.summary, 1_200) } : {}),
  };
}

function compactEntity(item) {
  return {
    id: item.id,
    kind: item.kind,
    name: clean(item.name, 512),
    ...(item.language ? { language: item.language } : {}),
    ...(item.location ? { location: item.location } : {}),
    evidenceIds: [...(item.evidenceIds || [])].slice(0, 20),
  };
}

function compactRelation(item) {
  return {
    id: item.id,
    source: item.source,
    target: item.target,
    kind: item.kind,
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    evidenceIds: [...(item.evidenceIds || [])].slice(0, 20),
  };
}

function shrinkArrays(value) {
  if (Array.isArray(value)) return value.length <= 1 ? value : value.slice(0, Math.max(1, Math.floor(value.length / 2))).map(shrinkArrays);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shrinkArrays(child)]));
}

function boundedJson(value, maxBytes = PLANNING_CONTEXT_LIMITS.maxSourceBytes) {
  let candidate = value;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
    if (Buffer.byteLength(serialized) <= maxBytes) return serialized;
    candidate = { ...shrinkArrays(candidate), _truncatedToContextBudget: true };
  }
  throw new PlanningError('CONTEXT_LIMIT_EXCEEDED', 'a selected planning source cannot fit inside the per-source context budget');
}

function graphOverview(snapshot, limit) {
  const entities = snapshot.entities.slice(0, limit).map(compactEntity);
  const entityIds = new Set(entities.map((item) => item.id));
  const relations = snapshot.relations
    .filter((item) => entityIds.has(item.source) && entityIds.has(item.target))
    .slice(0, limit * 2)
    .map(compactRelation);
  const findings = snapshot.findings.slice(0, limit).map((item) => ({
    id: item.id,
    kind: item.kind,
    summary: clean(item.summary, 1_500),
    evidenceIds: [...item.evidenceIds].slice(0, 20),
    entityIds: [...item.entityIds].slice(0, 20),
    uncertainty: item.uncertainty,
  }));
  const coverage = snapshot.coverage.slice(0, limit).map((item) => ({
    id: item.id, subject: clean(item.subject, 512), status: item.status,
    summary: clean(item.summary, 1_000), evidenceIds: [...item.evidenceIds].slice(0, 20),
  }));
  const diagnostics = snapshot.diagnostics.slice(0, limit).map((item) => ({
    code: item.code, severity: item.severity, message: clean(item.message, 1_000),
    ...(item.path ? { path: item.path } : {}),
  }));
  const evidenceIds = [...new Set([
    ...entities.flatMap((item) => item.evidenceIds),
    ...relations.flatMap((item) => item.evidenceIds),
    ...findings.flatMap((item) => item.evidenceIds),
    ...coverage.flatMap((item) => item.evidenceIds),
  ])].slice(0, PLANNING_CONTEXT_LIMITS.maxEvidenceIds);
  return {
    payload: {
      snapshot: {
        id: snapshot.id, status: snapshot.status, freshness: snapshot.freshness,
        analyzer: { id: snapshot.analyzer.id, name: snapshot.analyzer.name, version: snapshot.analyzer.version },
        manifest: { digest: snapshot.manifest.digest, counts: snapshot.manifest.counts, git: snapshot.manifest.git },
      },
      entities,
      relations,
      findings,
      coverage,
      diagnostics,
      limits: { requested: limit, totalEntities: snapshot.entities.length, totalRelations: snapshot.relations.length },
    },
    evidenceIds,
  };
}

function productSelection(productState, requestedSections, maxItems) {
  if (!productState?.exists || !productState.brief || !productState.revision) return null;
  const brief = productState.brief;
  const sections = requestedSections.length ? requestedSections : [...PRODUCT_SECTIONS];
  const payload = { title: clean(brief.title, 512), stage: clean(brief.stage, 256) };
  const evidenceIds = [];
  for (const section of sections) {
    if (!PRODUCT_SECTIONS.has(section)) throw new PlanningError('INVALID_TOOL_ARGUMENT', `unsupported product section '${section}'`);
    if (section === 'purpose') {
      payload.purpose = { id: brief.purpose.id, text: clean(brief.purpose.text, 4_000), locked: Boolean(brief.purpose.locked) };
      evidenceIds.push(`intent:${brief.purpose.id}`);
      continue;
    }
    const values = Array.isArray(brief[section]) ? brief[section].slice(0, maxItems) : [];
    payload[section] = values.map((item) => {
      const id = clean(item.id, 256);
      if (id) evidenceIds.push(`intent:${id}`);
      if (section === 'goals') return {
        id, title: clean(item.title, 512), outcome: clean(item.outcome, 2_000), priority: item.priority,
        horizon: clean(item.horizon, 512), state: item.state, successSignals: (item.successSignals || []).slice(0, 20).map((value) => clean(value, 512)),
      };
      if (section === 'repositoryRoles') return { id, repositoryId: clean(item.repositoryId, 256), role: clean(item.role, 2_000) };
      if (section === 'glossary') return { id, term: clean(item.term, 256), definition: clean(item.definition, 2_000) };
      if (section === 'decisions' || section === 'conflicts') return {
        id, question: clean(item.question, 2_000), answer: clean(item.answer, 2_000), state: item.state,
        ...(item.summary ? { summary: clean(item.summary, 2_000) } : {}),
      };
      return { id, text: clean(item.text, 2_000), locked: Boolean(item.locked) };
    });
  }
  return { payload, evidenceIds: [...new Set(evidenceIds)] };
}

function portfolioSelection(portfolio, componentLimit, frontLimit) {
  const components = array(portfolio?.components || [], 'portfolio.components', 10_000).slice(0, componentLimit).map((component) => ({
    slug: clean(component.slug, 96),
    title: clean(component.title, 256),
    state: clean(component.state, 64),
    scope: clean(component.sections?.scope || component.scope || '', 2_500),
    limits: clean(component.sections?.limits || component.limits || '', 2_500),
    territory: clean(component.sections?.territory || component.territory || '', 2_500),
  }));
  const componentIds = new Set(components.map((item) => item.slug));
  const fronts = array(portfolio?.fronts || [], 'portfolio.fronts', 20_000).filter((front) => !front.component || componentIds.has(front.component)).slice(0, frontLimit).map((front) => ({
    slug: clean(front.slug, 96), component: clean(front.component, 96), title: clean(front.title, 256), state: clean(front.state, 64),
    outcome: clean(front.outcome, 2_000), next: clean(front.next, 1_000), impact: clean(front.impact, 64), complexity: clean(front.complexity, 64),
  }));
  return {
    payload: { components, fronts, limits: { totalComponents: portfolio?.components?.length || 0, totalFronts: portfolio?.fronts?.length || 0 } },
    evidenceIds: [
      ...components.map((item) => `contract:component:${item.slug}`),
      ...fronts.map((item) => `contract:front:${item.slug}`),
    ],
  };
}

export function createPlanningTools({ snapshot: snapshotValue = null, product = null, portfolio = null } = {}) {
  const snapshot = snapshotValue ? validateAnalysisSnapshot(snapshotValue) : null;
  const tools = {
    manifest: Object.freeze({
      schemaVersion: 1,
      readOnly: true,
      repositoryMutation: false,
      processExecution: false,
      network: false,
      limits: PLANNING_TOOL_LIMITS,
    }),
    graphOverview({ limit = 40 } = {}) {
      if (!snapshot) throw new PlanningError('SNAPSHOT_REQUIRED', 'graph overview requires a selected analysis snapshot');
      return graphOverview(snapshot, integer(limit, 40, 1, PLANNING_TOOL_LIMITS.maxGraphResults, 'graph overview limit'));
    },
    graphQuery(query = {}) {
      if (!snapshot) throw new PlanningError('SNAPSHOT_REQUIRED', 'graph query requires a selected analysis snapshot');
      if (!query || typeof query !== 'object' || Array.isArray(query)) throw new PlanningError('INVALID_TOOL_ARGUMENT', 'graph query must be an object');
      const requestedLimit = integer(query.limit, 30, 1, PLANNING_TOOL_LIMITS.maxGraphResults, 'graph query limit');
      const result = queryAnalysisSnapshot(snapshot, { ...query, snapshotId: snapshot.id, limit: requestedLimit });
      return {
        ...result,
        entities: result.entities.map(compactEntity),
        relations: result.relations.map(compactRelation),
        evidence: result.evidence.map(compactEvidence),
      };
    },
    evidenceQuery({ evidenceIds = [], limit = 80 } = {}) {
      if (!snapshot) throw new PlanningError('SNAPSHOT_REQUIRED', 'evidence query requires a selected analysis snapshot');
      const ids = [...new Set(array(evidenceIds, 'evidenceIds', PLANNING_TOOL_LIMITS.maxEvidenceResults).map((item) => clean(item, 256)).filter(Boolean))];
      const boundedLimit = integer(limit, 80, 1, PLANNING_TOOL_LIMITS.maxEvidenceResults, 'evidence query limit');
      return queryAnalysisSnapshot(snapshot, { type: 'evidence', snapshotId: snapshot.id, evidenceIds: ids, limit: boundedLimit }).evidence.map(compactEvidence);
    },
    productQuery({ sections = [], maxItems = 20 } = {}) {
      const selectedSections = array(sections, 'product sections', PRODUCT_SECTIONS.size).map((item) => clean(item, 128));
      return productSelection(product, selectedSections, integer(maxItems, 20, 1, PLANNING_TOOL_LIMITS.maxProductItemsPerSection, 'product item limit'));
    },
    portfolioQuery({ componentLimit = 30, frontLimit = 60 } = {}) {
      return portfolioSelection(
        portfolio || { components: [], fronts: [] },
        integer(componentLimit, 30, 1, PLANNING_TOOL_LIMITS.maxPortfolioComponents, 'component limit'),
        integer(frontLimit, 60, 1, PLANNING_TOOL_LIMITS.maxPortfolioFronts, 'front limit'),
      );
    },
  };
  return Object.freeze(tools);
}

export function buildPlanningContext({
  repository, operation, snapshot = null, product = null, portfolio = null, question = '', graphQueries = [], includeProduct = true,
} = {}) {
  if (!repository?.id || !repository?.adapter) throw new PlanningError('INVALID_REPOSITORY', 'repository id and adapter are required for planning context');
  const normalizedSnapshot = snapshot ? validateAnalysisSnapshot(snapshot) : null;
  if (normalizedSnapshot && (normalizedSnapshot.repository.id !== repository.id || normalizedSnapshot.repository.adapter !== repository.adapter)) {
    throw new PlanningError('SNAPSHOT_REPOSITORY_MISMATCH', 'selected analysis snapshot belongs to a different repository or adapter');
  }
  const tools = createPlanningTools({ snapshot: normalizedSnapshot, product, portfolio });
  const sources = [];
  const diagnostics = [];
  if (normalizedSnapshot) {
    const overview = tools.graphOverview({ limit: 40 });
    sources.push({
      id: 'graph:overview', kind: 'graph-query', title: 'Bounded repository graph overview',
      content: boundedJson(overview.payload), provenance: 'mixed', evidenceIds: overview.evidenceIds,
    });
    const queries = array(graphQueries, 'graphQueries', PLANNING_TOOL_LIMITS.maxGraphQueries);
    for (const [index, query] of queries.entries()) {
      const result = tools.graphQuery(query);
      const evidenceIds = [...new Set([
        ...result.evidence.map((item) => item.id),
        ...result.entities.flatMap((item) => item.evidenceIds),
        ...result.relations.flatMap((item) => item.evidenceIds),
      ])];
      sources.push({
        id: `graph:query:${index + 1}`, kind: 'graph-query', title: `Selected graph query ${index + 1}`,
        content: boundedJson({ query: result.query, entities: result.entities, relations: result.relations, diagnostics: result.diagnostics, truncated: result.truncated }),
        provenance: 'mixed', evidenceIds,
      });
    }
    const selectedEvidence = tools.evidenceQuery({ evidenceIds: sources.flatMap((source) => source.evidenceIds), limit: 120 });
    if (selectedEvidence.length) sources.push({
      id: 'evidence:selected', kind: 'evidence', title: 'Evidence referenced by selected graph material',
      content: boundedJson({ evidence: selectedEvidence }), provenance: 'mixed', evidenceIds: selectedEvidence.map((item) => item.id),
    });
  } else diagnostics.push({ code: 'ANALYSIS_SNAPSHOT_MISSING', message: 'No analysis snapshot was selected; repository-structure claims must remain assumptions or questions.' });

  if (includeProduct) {
    const selectedProduct = tools.productQuery();
    if (selectedProduct) sources.push({
      id: 'product:accepted', kind: 'product', title: 'Accepted product direction',
      content: boundedJson(selectedProduct.payload), provenance: 'declared', evidenceIds: selectedProduct.evidenceIds,
    });
    else diagnostics.push({ code: 'PRODUCT_DIRECTION_MISSING', message: 'No accepted product brief was available; intent claims must remain assumptions or questions.' });
  }

  const selectedPortfolio = tools.portfolioQuery();
  if (selectedPortfolio.payload.components.length || selectedPortfolio.payload.fronts.length) sources.push({
    id: 'portfolio:accepted', kind: 'portfolio', title: 'Current accepted components and fronts',
    content: boundedJson(selectedPortfolio.payload), provenance: 'declared', evidenceIds: selectedPortfolio.evidenceIds,
  });
  else diagnostics.push({ code: 'PORTFOLIO_EMPTY', message: 'No accepted component/front portfolio exists yet.' });

  const normalizedQuestion = clean(question, 4_000);
  if (normalizedQuestion) sources.push({
    id: 'human:question', kind: 'human', title: 'Human planning request', content: `${normalizedQuestion}\n`,
    provenance: 'human', evidenceIds: ['human:question'],
  });

  return createPlanningContext({
    repository: { id: repository.id, adapter: repository.adapter },
    operation,
    snapshot: normalizedSnapshot ? { id: normalizedSnapshot.id, status: normalizedSnapshot.status, freshness: normalizedSnapshot.freshness.state } : null,
    product: product?.exists && product?.revision ? { revision: product.revision, title: product.brief?.title || repository.id } : null,
    sources,
    diagnostics,
  });
}
