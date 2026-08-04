import { createHash } from 'node:crypto';

import { IntelligenceError, validateAnalysisSnapshot } from './contracts.mjs';

export const SYSTEM_MAP_SCHEMA_VERSION = 1;
export const SYSTEM_MAP_ALGORITHM_VERSION = '1.0.0';

export const SYSTEM_MAP_LENSES = Object.freeze([
  'responsibility',
  'module',
  'deployable',
  'dependency',
  'entry-point',
  'interface',
  'data-flow',
  'data-store',
  'test',
  'external-system',
  'change-coupling',
]);

export const SYSTEM_MAP_QUERY_TYPES = Object.freeze([
  'overview',
  'search',
  'group',
  'entity',
  'neighbors',
  'path',
  'reverse-dependencies',
  'evidence',
  'aggregate',
]);

export const SYSTEM_MAP_LIMITS = Object.freeze({
  maxEntities: 20_000,
  maxRelations: 80_000,
  maxEvidence: 80_000,
  maxGroups: 1_000,
  maxGroupMembers: 250,
  defaultQueryLimit: 50,
  maxQueryLimit: 500,
  maxQueryDepth: 5,
  maxPathDepth: 12,
  maxSearchLength: 240,
  maxExportBytes: 2 * 1024 * 1024,
});

const QUERY_TYPES = new Set(SYSTEM_MAP_QUERY_TYPES);
const LENSES = new Set(SYSTEM_MAP_LENSES);
const DIRECTIONS = new Set(['outgoing', 'incoming', 'both']);
const DEPENDENCY_RELATION = /(?:depend|import|require|use|call|invoke|include|consume|provide|reference|link)/i;
const AFFINITY_RELATION = /(?:depend|import|require|use|call|invoke|include|consume|provide|contain|declare|define|own|reference|link|test)/i;
const DATA_RELATION = /(?:read|write|query|persist|publish|subscribe|produce|consume|data|store|load|save)/i;
const HISTORY_RELATION = /(?:co.?change|change.?coupl|changed.?with|history)/i;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clean(value, limit = 2_000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new IntelligenceError('INVALID_MAP_LIMIT', `${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function normalizeLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntelligenceError('INVALID_MAP_LIMIT', 'system-map limits must be an object');
  }
  return Object.freeze({
    maxEntities: boundedInteger(value.maxEntities, SYSTEM_MAP_LIMITS.maxEntities, 1, 100_000, 'maxEntities'),
    maxRelations: boundedInteger(value.maxRelations, SYSTEM_MAP_LIMITS.maxRelations, 1, 400_000, 'maxRelations'),
    maxEvidence: boundedInteger(value.maxEvidence, SYSTEM_MAP_LIMITS.maxEvidence, 1, 400_000, 'maxEvidence'),
    maxGroups: boundedInteger(value.maxGroups, SYSTEM_MAP_LIMITS.maxGroups, 1, 5_000, 'maxGroups'),
    maxGroupMembers: boundedInteger(value.maxGroupMembers, SYSTEM_MAP_LIMITS.maxGroupMembers, 2, 2_000, 'maxGroupMembers'),
  });
}

function attributes(entity) {
  return entity.attributes && typeof entity.attributes === 'object' && !Array.isArray(entity.attributes)
    ? entity.attributes
    : {};
}

function entityText(entity) {
  return `${entity.kind} ${entity.name} ${entity.location?.path || ''}`.toLocaleLowerCase();
}

function pathBucket(entity) {
  const path = entity.location?.path || '';
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return 'unlocated';
  if (parts.length === 1) return '(root)';
  const first = parts[0].toLocaleLowerCase();
  if (['src', 'lib', 'app', 'apps', 'packages', 'services', 'modules'].includes(first) && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function label(value) {
  const normalized = clean(value, 160).replace(/[-_.:/]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.replace(/\b\w/g, (part) => part.toUpperCase()) : 'Unlabeled area';
}

function category(entity) {
  const value = entityText(entity);
  const kind = String(entity.kind || '').toLocaleLowerCase();
  const path = String(entity.location?.path || '').toLocaleLowerCase();
  const base = path.split('/').at(-1) || '';
  const attrs = attributes(entity);
  const executable = attrs.executable === true;
  return {
    module: /^(?:module|package|namespace|file|code|class)$/.test(kind),
    deployable: /(?:deployable|service|application|container|process|worker|executable|daemon|lambda|function-app)/.test(kind)
      || /(?:^|\/)(?:dockerfile|compose[^/]*\.ya?ml|package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(path),
    entryPoint: /(?:entry.?point|bootstrap|main|server|cli|command|worker)/.test(kind)
      || executable
      || /^(?:main|index|server|app|cli|worker|bootstrap)(?:\.[^.]+)?$/.test(base),
    interface: /(?:interface|endpoint|route|controller|api|graphql|protocol|rpc|handler)/.test(kind)
      || /(?:^|\/)(?:api|routes?|controllers?|endpoints?|openapi|graphql|proto)(?:\/|\.|$)/.test(path),
    dataStore: /(?:database|datastore|table|collection|model|repository|store|schema|migration|queue|topic|cache)/.test(kind)
      || /(?:^|\/)(?:db|database|data|models?|schemas?|migrations?|stores?)(?:\/|\.|$)/.test(path),
    test: /(?:test|spec|fixture|mock)/.test(kind)
      || /(?:^|\/)(?:test|tests|spec|specs|__tests__|fixtures?|mocks?)(?:\/|$)/.test(path)
      || /(?:^|[._-])(?:test|spec)\.[^.]+$/.test(base),
    external: /(?:external|third.?party|vendor|dependency|remote|upstream)/.test(kind)
      || (!entity.location && /(?:package|service|api|system|library|database|queue|topic)/.test(value)),
  };
}

function mapIndexes(entities, relations, evidence) {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const relationById = new Map(relations.map((relation) => [relation.id, relation]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const relation of relations) {
    if (!outgoing.has(relation.source)) outgoing.set(relation.source, []);
    if (!incoming.has(relation.target)) incoming.set(relation.target, []);
    outgoing.get(relation.source).push(relation);
    incoming.get(relation.target).push(relation);
  }
  return { entityById, relationById, evidenceById, outgoing, incoming };
}

function evidenceIdsFor(memberIds, relationIds, indexes) {
  const ids = new Set();
  for (const id of memberIds) for (const evidenceId of indexes.entityById.get(id)?.evidenceIds || []) ids.add(evidenceId);
  for (const id of relationIds) for (const evidenceId of indexes.relationById.get(id)?.evidenceIds || []) ids.add(evidenceId);
  return [...ids].sort();
}

function uncertaintyFor({ inferred, memberIds, relationIds, snapshot }) {
  const reasons = [];
  if (inferred) reasons.push('This grouping is an inference from structural signals, not an accepted component boundary.');
  if (!relationIds.length) reasons.push('No normalized relation directly supports cohesion inside this grouping.');
  if (snapshot.status === 'partial') reasons.push('The source snapshot reports partial coverage.');
  if (snapshot.freshness.state !== 'current') reasons.push(`The source snapshot is ${snapshot.freshness.state}.`);
  if (memberIds.length === 1) reasons.push('A single observed entity provides limited boundary evidence.');
  return {
    level: reasons.length >= 3 ? 'high' : reasons.length ? 'medium' : 'low',
    reasons,
  };
}

function groupId(lens, key, memberIds) {
  return `map-group:${lens}:${sha256(`${key}\0${memberIds.join('\0')}`).slice(0, 24)}`;
}

function makeGroup({ lens, key, name, summary, memberIds, relationIds = [], indexes, snapshot,
  provenance = 'inferred', rationale = [], alternatives = [], attributes: extra = {} }) {
  const members = [...new Set(memberIds)].sort();
  const relations = [...new Set(relationIds)].sort();
  const inferred = provenance !== 'extracted';
  return {
    id: groupId(lens, key, members),
    lens,
    name: clean(name, 256),
    summary: clean(summary, 2_000),
    memberEntityIds: members,
    relationIds: relations,
    evidenceIds: evidenceIdsFor(members, relations, indexes),
    provenance,
    rationale: rationale.map((item) => ({
      kind: clean(item.kind || 'signal', 64),
      summary: clean(item.summary, 1_000),
      evidenceIds: [...new Set(item.evidenceIds || [])].sort(),
    })),
    alternatives: alternatives.map((item) => ({
      summary: clean(item.summary, 1_000),
      memberEntityIds: [...new Set(item.memberEntityIds || [])].sort(),
      evidenceIds: [...new Set(item.evidenceIds || [])].sort(),
    })),
    uncertainty: uncertaintyFor({ inferred, memberIds: members, relationIds: relations, snapshot }),
    coverageImpact: {
      representedEntities: members.length,
      snapshotEntities: snapshot.entities.length,
      uncoveredSubjects: snapshot.coverage.filter((item) => item.status !== 'covered').length,
      excludedPaths: snapshot.scope.excluded.length,
      stale: snapshot.freshness.state !== 'current',
    },
    attributes: extra,
  };
}

function relationsInside(memberIds, relations, limit) {
  const members = new Set(memberIds);
  return relations
    .filter((relation) => members.has(relation.source) && members.has(relation.target))
    .slice(0, limit)
    .map((relation) => relation.id);
}

function relationNeighbors(entityId, indexes, relationFilter = () => true) {
  const output = [];
  for (const relation of indexes.outgoing.get(entityId) || []) {
    if (relationFilter(relation)) output.push({ entityId: relation.target, relation });
  }
  for (const relation of indexes.incoming.get(entityId) || []) {
    if (relationFilter(relation)) output.push({ entityId: relation.source, relation });
  }
  return output;
}

function facetGroups({ lens, candidates, entities, relations, indexes, snapshot, limits, summary }) {
  const output = [];
  for (const entity of candidates.sort((left, right) => left.id.localeCompare(right.id))) {
    if (output.length >= limits.maxGroups) break;
    const contained = relationNeighbors(entity.id, indexes, (relation) => /contain|declare|define|own/i.test(relation.kind))
      .map((item) => item.entityId)
      .filter((id) => id !== entity.id)
      .slice(0, Math.max(0, limits.maxGroupMembers - 1));
    const members = [entity.id, ...contained];
    const relationIds = relationsInside(members, relations, limits.maxGroupMembers * 4);
    output.push(makeGroup({
      lens,
      key: entity.id,
      name: entity.name,
      summary: summary(entity, members.length),
      memberIds: members,
      relationIds,
      indexes,
      snapshot,
      provenance: 'inferred',
      rationale: [{
        kind: 'entity-classification',
        summary: `The normalized analyzer classified or located this ${lens.replace('-', ' ')} candidate.`,
        evidenceIds: entity.evidenceIds || [],
      }],
      attributes: { sourceEntityId: entity.id, pathBucket: pathBucket(entity) },
    }));
  }
  return output;
}

function connectedGroups(relations, entityById, relationPattern, maximumMembers) {
  const adjacency = new Map();
  for (const relation of relations) {
    if (!relationPattern.test(relation.kind)) continue;
    if (!adjacency.has(relation.source)) adjacency.set(relation.source, []);
    if (!adjacency.has(relation.target)) adjacency.set(relation.target, []);
    adjacency.get(relation.source).push({ id: relation.target, relationId: relation.id });
    adjacency.get(relation.target).push({ id: relation.source, relationId: relation.id });
  }
  const visited = new Set();
  const groups = [];
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const queue = [start];
    const members = [];
    const relationIds = new Set();
    while (queue.length && members.length < maximumMembers) {
      const id = queue.shift();
      if (visited.has(id) || !entityById.has(id)) continue;
      visited.add(id);
      members.push(id);
      for (const edge of adjacency.get(id) || []) {
        relationIds.add(edge.relationId);
        if (!visited.has(edge.id)) queue.push(edge.id);
      }
    }
    if (members.length > 1) groups.push({ members: members.sort(), relationIds: [...relationIds].sort() });
  }
  return groups;
}

function responsibilityGroups({ entities, relations, indexes, snapshot, limits }) {
  const output = [];
  const seenMembers = new Set();
  const byCommunity = new Map();
  for (const entity of entities) {
    const community = attributes(entity).community;
    if (community === undefined || community === null || community === '') continue;
    const key = clean(community, 128);
    if (!byCommunity.has(key)) byCommunity.set(key, []);
    byCommunity.get(key).push(entity.id);
  }
  for (const [community, memberIds] of [...byCommunity.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (output.length >= Math.min(80, limits.maxGroups)) break;
    const members = memberIds.sort().slice(0, limits.maxGroupMembers);
    if (!members.length) continue;
    const signature = members.join('\0');
    seenMembers.add(signature);
    const relationIds = relationsInside(members, relations, limits.maxGroupMembers * 4);
    output.push(makeGroup({
      lens: 'responsibility', key: `community:${community}`, name: `Community ${community}`,
      summary: 'A responsibility candidate inferred from an analyzer community signal and checked against normalized relations.',
      memberIds: members, relationIds, indexes, snapshot,
      rationale: [{ kind: 'analyzer-community', summary: `The analyzer assigned these entities to community ${community}.`, evidenceIds: evidenceIdsFor(members, relationIds, indexes) }],
      alternatives: [{ summary: 'Review deployable, interface and data ownership before treating this community as a durable component.', memberEntityIds: [], evidenceIds: [] }],
      attributes: { strategy: 'analyzer-community', community },
    }));
  }

  const degree = entities.map((entity) => ({
    entity,
    degree: (indexes.outgoing.get(entity.id)?.length || 0) + (indexes.incoming.get(entity.id)?.length || 0),
  })).filter((item) => item.degree > 0)
    .sort((left, right) => right.degree - left.degree || left.entity.id.localeCompare(right.entity.id));
  for (const { entity, degree: entityDegree } of degree.slice(0, 48)) {
    if (output.length >= Math.min(120, limits.maxGroups)) break;
    const neighbors = relationNeighbors(entity.id, indexes, (relation) => AFFINITY_RELATION.test(relation.kind))
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .slice(0, limits.maxGroupMembers - 1);
    const members = [...new Set([entity.id, ...neighbors.map((item) => item.entityId)])].sort();
    if (members.length < 2) continue;
    const signature = members.join('\0');
    if (seenMembers.has(signature)) continue;
    seenMembers.add(signature);
    const relationIds = [...new Set(neighbors.map((item) => item.relation.id))].sort();
    output.push(makeGroup({
      lens: 'responsibility', key: `affinity:${entity.id}`, name: `Responsibility around ${entity.name}`,
      summary: 'An overlapping responsibility candidate based on dependency affinity around a structurally central entity.',
      memberIds: members, relationIds, indexes, snapshot,
      rationale: [{
        kind: 'dependency-affinity',
        summary: `${entity.name} has ${entityDegree} normalized incoming/outgoing relation signal(s); one-hop peers are shown as a hypothesis.`,
        evidenceIds: evidenceIdsFor(members, relationIds, indexes),
      }],
      alternatives: [{
        summary: `A path-affinity alternative would center the boundary on ${pathBucket(entity)}; compare interfaces and product intent before choosing.`,
        memberEntityIds: entities.filter((item) => pathBucket(item) === pathBucket(entity)).slice(0, limits.maxGroupMembers).map((item) => item.id),
        evidenceIds: [],
      }],
      attributes: { strategy: 'dependency-affinity', seedEntityId: entity.id, pathBucket: pathBucket(entity), degree: entityDegree },
    }));
  }

  if (!output.length || relations.length === 0) {
    const buckets = new Map();
    for (const entity of entities) {
      const key = pathBucket(entity);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(entity.id);
    }
    for (const [bucket, memberIds] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (output.length >= Math.min(80, limits.maxGroups)) break;
      const members = memberIds.sort().slice(0, limits.maxGroupMembers);
      if (!members.length) continue;
      output.push(makeGroup({
        lens: 'responsibility', key: `path-affinity:${bucket}`, name: `Structural area: ${label(bucket)}`,
        summary: 'A low-confidence responsibility candidate using co-location only because richer dependency/community evidence is unavailable.',
        memberIds: members, relationIds: [], indexes, snapshot,
        rationale: [{ kind: 'path-affinity', summary: 'Repository path is used as one weak signal; a directory is not assumed to be a component.', evidenceIds: evidenceIdsFor(members, [], indexes) }],
        alternatives: [{ summary: 'Run a richer analyzer or add product intent before choosing a durable ownership boundary.', memberEntityIds: [], evidenceIds: [] }],
        attributes: { strategy: 'path-affinity', pathBucket: bucket },
      }));
    }
  }
  return output;
}

function lensDescriptor(id, groups, relations, snapshot, { supported = true, summary, gaps = [] } = {}) {
  const relevantGroups = groups.filter((group) => group.lens === id);
  const relationPattern = id === 'change-coupling' ? HISTORY_RELATION : id === 'data-flow' ? DATA_RELATION : id === 'dependency' ? DEPENDENCY_RELATION : null;
  const relationKinds = relationPattern
    ? [...new Set(relations.filter((relation) => relationPattern.test(relation.kind)).map((relation) => relation.kind))].sort()
    : [];
  const unavailable = !supported;
  const partial = supported && (!relevantGroups.length && !relationKinds.length || snapshot.status === 'partial');
  return {
    id,
    status: unavailable ? 'unsupported' : partial ? 'partial' : 'available',
    summary: clean(summary || `${relevantGroups.length} derived group(s) and ${relationKinds.length} observed relation kind(s).`, 1_000),
    groupIds: relevantGroups.map((group) => group.id),
    relationKinds,
    gaps: [...new Set(gaps.map((item) => clean(item, 1_000)).filter(Boolean))],
  };
}

function stableDiagnostics(snapshot, selectedEntities, selectedRelations, limits, groups) {
  const diagnostics = [];
  if (selectedEntities.length < snapshot.entities.length) diagnostics.push({
    code: 'MAP_ENTITY_BUDGET', severity: 'warning',
    message: `The map selected ${selectedEntities.length} of ${snapshot.entities.length} entities within its ${limits.maxEntities}-entity budget.`,
  });
  if (selectedRelations.length < snapshot.relations.length) diagnostics.push({
    code: 'MAP_RELATION_BUDGET', severity: 'warning',
    message: `The map selected ${selectedRelations.length} of ${snapshot.relations.length} relations within its ${limits.maxRelations}-relation budget.`,
  });
  if (groups.length >= limits.maxGroups) diagnostics.push({
    code: 'MAP_GROUP_BUDGET', severity: 'warning', message: `Derived groups reached the ${limits.maxGroups}-group budget.`,
  });
  if (snapshot.status === 'partial') diagnostics.push({
    code: 'MAP_PARTIAL_SNAPSHOT', severity: 'warning', message: 'The source snapshot is partial; absence from this map is not proof that code or relationships do not exist.',
  });
  if (snapshot.freshness.state !== 'current') diagnostics.push({
    code: 'MAP_STALE_SNAPSHOT', severity: 'warning', message: `The source snapshot is ${snapshot.freshness.state}; source locations may no longer be current.`,
  });
  if (!snapshot.analyzer.capabilities.history) diagnostics.push({
    code: 'MAP_HISTORY_UNAVAILABLE', severity: 'info', message: 'Change-coupling is unavailable because this analyzer did not provide history evidence.',
  });
  if (!selectedRelations.length) diagnostics.push({
    code: 'MAP_RELATIONS_UNAVAILABLE', severity: 'warning', message: 'No normalized relations are available; responsibility candidates use weak structural signals only.',
  });
  return diagnostics;
}

export function deriveSystemMap(snapshotValue, options = {}) {
  const snapshot = validateAnalysisSnapshot(snapshotValue);
  const limits = normalizeLimits(options.limits || options);
  const entities = [...snapshot.entities].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limits.maxEntities);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const relations = [...snapshot.relations]
    .filter((relation) => entityIds.has(relation.source) && entityIds.has(relation.target))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limits.maxRelations);
  const initialEvidenceIds = new Set([
    ...entities.flatMap((entity) => entity.evidenceIds || []),
    ...relations.flatMap((relation) => relation.evidenceIds || []),
  ]);
  const evidence = [...snapshot.evidence]
    .filter((item) => initialEvidenceIds.has(item.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limits.maxEvidence);
  const contentFiles = [...snapshot.manifest.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, limits.maxEntities)
    .map((file) => ({ path: file.path, digest: file.digest, size: file.size, source: file.source }));
  const indexes = mapIndexes(entities, relations, evidence);
  const candidates = {
    module: [], deployable: [], entryPoint: [], interface: [], dataStore: [], test: [], external: [],
  };
  for (const entity of entities) {
    const flags = category(entity);
    for (const [key, enabled] of Object.entries(flags)) if (enabled && candidates[key]) candidates[key].push(entity);
  }

  const responsibilityBudget = Math.max(1, Math.floor(limits.maxGroups * .35));
  let groups = responsibilityGroups({
    entities, relations, indexes, snapshot,
    limits: { ...limits, maxGroups: responsibilityBudget },
  });
  const facets = [
    ['module', candidates.module, (entity, count) => `${entity.name} is a normalized module/package/file candidate${count > 1 ? ` with ${count - 1} contained entities` : ''}.`],
    ['deployable', candidates.deployable, (entity) => `${entity.name} is a deployable/runtime candidate inferred from normalized kind, manifest or deployment evidence.`],
    ['entry-point', candidates.entryPoint, (entity) => `${entity.name} is a possible process, application or command entry point.`],
    ['interface', candidates.interface, (entity) => `${entity.name} is a provided/consumed interface candidate; inspect relations before assigning ownership.`],
    ['data-store', candidates.dataStore, (entity) => `${entity.name} is a data ownership or persistence candidate.`],
    ['test', candidates.test, (entity) => `${entity.name} is test/verification evidence, not production ownership by itself.`],
    ['external-system', candidates.external, (entity) => `${entity.name} appears to represent a dependency outside the located repository content.`],
  ];
  const historyReserve = snapshot.analyzer.capabilities.history ? Math.min(10, Math.max(1, Math.floor(limits.maxGroups * .1))) : 0;
  for (const [index, [lens, items, summary]] of facets.entries()) {
    if (groups.length >= limits.maxGroups) break;
    const available = Math.max(0, limits.maxGroups - groups.length - historyReserve);
    const fairShare = Math.max(1, Math.floor(available / Math.max(1, facets.length - index)));
    groups.push(...facetGroups({ lens, candidates: items, entities, relations, indexes, snapshot, limits: {
      ...limits, maxGroups: Math.min(fairShare, limits.maxGroups - groups.length),
    }, summary }));
  }

  const historyGroups = connectedGroups(relations, indexes.entityById, HISTORY_RELATION, limits.maxGroupMembers);
  for (const [index, connected] of historyGroups.entries()) {
    if (groups.length >= limits.maxGroups) break;
    groups.push(makeGroup({
      lens: 'change-coupling', key: `history:${index}`, name: `Change-coupled area ${index + 1}`,
      summary: 'Entities connected by normalized change-history evidence; correlation does not establish ownership.',
      memberIds: connected.members, relationIds: connected.relationIds, indexes, snapshot,
      rationale: [{ kind: 'change-coupling', summary: 'The active analyzer supplied co-change relations for these entities.', evidenceIds: evidenceIdsFor(connected.members, connected.relationIds, indexes) }],
      alternatives: [{ summary: 'Validate this correlation against responsibilities, interfaces and product intent before using it as a boundary.', memberEntityIds: [], evidenceIds: [] }],
      attributes: { strategy: 'change-coupling' },
    }));
  }
  groups = groups.slice(0, limits.maxGroups).sort((left, right) => left.lens.localeCompare(right.lens) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const diagnostics = stableDiagnostics(snapshot, entities, relations, limits, groups);
  if (evidence.length < initialEvidenceIds.size) diagnostics.push({
    code: 'MAP_EVIDENCE_BUDGET', severity: 'warning',
    message: `The map retained ${evidence.length} of ${initialEvidenceIds.size} referenced evidence records within its ${limits.maxEvidence}-record budget.`,
  });
  const retainedEvidence = new Set(evidence.map((item) => item.id));
  groups = groups.map((group) => ({
    ...group,
    evidenceIds: group.evidenceIds.filter((id) => retainedEvidence.has(id)),
    rationale: group.rationale.map((item) => ({ ...item, evidenceIds: item.evidenceIds.filter((id) => retainedEvidence.has(id)) })),
    alternatives: group.alternatives.map((item) => ({ ...item, evidenceIds: item.evidenceIds.filter((id) => retainedEvidence.has(id)) })),
  }));

  const lensSupport = {
    responsibility: true,
    module: true,
    deployable: candidates.deployable.length > 0,
    dependency: relations.some((relation) => DEPENDENCY_RELATION.test(relation.kind)),
    'entry-point': candidates.entryPoint.length > 0,
    interface: candidates.interface.length > 0,
    'data-flow': relations.some((relation) => DATA_RELATION.test(relation.kind)),
    'data-store': candidates.dataStore.length > 0,
    test: candidates.test.length > 0,
    'external-system': candidates.external.length > 0,
    'change-coupling': snapshot.analyzer.capabilities.history || historyGroups.length > 0,
  };
  const lenses = SYSTEM_MAP_LENSES.map((id) => lensDescriptor(id, groups, relations, snapshot, {
    supported: lensSupport[id],
    summary: id === 'responsibility'
      ? `${groups.filter((group) => group.lens === id).length} overlapping responsibility hypothesis(es); none are accepted components.`
      : undefined,
    gaps: !lensSupport[id]
      ? [`The ${id.replaceAll('-', ' ')} lens has no supporting normalized capability/evidence in this snapshot.`]
      : [],
  }));
  const mappedEntityIds = new Set(groups.flatMap((group) => group.memberEntityIds));
  const coverage = {
    snapshotStatus: snapshot.status,
    freshness: snapshot.freshness,
    mappedEntities: mappedEntityIds.size,
    selectedEntities: entities.length,
    totalSnapshotEntities: snapshot.entities.length,
    selectedRelations: relations.length,
    totalSnapshotRelations: snapshot.relations.length,
    excludedPaths: snapshot.scope.excluded.length,
    subjects: snapshot.coverage.map((item) => ({
      id: item.id, subject: item.subject, status: item.status, summary: item.summary, evidenceIds: item.evidenceIds.filter((id) => retainedEvidence.has(id)),
    })),
    counts: Object.fromEntries(['covered', 'partial', 'excluded', 'unsupported', 'unknown'].map((status) => [
      status, snapshot.coverage.filter((item) => item.status === status).length,
    ])),
  };
  const normalizedOptions = { limits };
  const id = sha256(`handraise-system-map-v1\0${canonical({
    snapshotId: snapshot.id,
    algorithmVersion: SYSTEM_MAP_ALGORITHM_VERSION,
    options: normalizedOptions,
  })}`);
  return deepFreeze({
    schemaVersion: SYSTEM_MAP_SCHEMA_VERSION,
    algorithmVersion: SYSTEM_MAP_ALGORITHM_VERSION,
    id,
    snapshotId: snapshot.id,
    repository: snapshot.repository,
    derivedAt: snapshot.createdAt,
    authority: {
      kind: 'derived', accepted: false,
      statement: 'This map is derived analysis, not accepted repository planning truth or a component definition.',
    },
    source: {
      snapshotStatus: snapshot.status,
      freshness: snapshot.freshness,
      manifestDigest: snapshot.manifest.digest,
      git: snapshot.manifest.git,
      analyzer: { id: snapshot.analyzer.id, name: snapshot.analyzer.name, version: snapshot.analyzer.version },
      configurationDigest: snapshot.configurationDigest,
    },
    content: {
      files: contentFiles,
      totalFiles: snapshot.manifest.files.length,
      truncated: contentFiles.length < snapshot.manifest.files.length,
    },
    options: normalizedOptions,
    counts: { entities: entities.length, relations: relations.length, evidence: evidence.length, groups: groups.length },
    coverage,
    lenses,
    groups,
    entities,
    relations,
    evidence,
    diagnostics: [...snapshot.diagnostics.map((item) => ({ ...item, source: 'snapshot' })), ...diagnostics.map((item) => ({ ...item, source: 'system-map' }))],
  });
}

function assertMap(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== SYSTEM_MAP_SCHEMA_VERSION
    || value.algorithmVersion !== SYSTEM_MAP_ALGORITHM_VERSION || !/^[a-f0-9]{64}$/.test(String(value.id || ''))
    || !/^[a-f0-9]{64}$/.test(String(value.snapshotId || '')) || value.authority?.accepted !== false
    || !Array.isArray(value.entities) || !Array.isArray(value.relations) || !Array.isArray(value.groups) || !Array.isArray(value.evidence)) {
    throw new IntelligenceError('INVALID_SYSTEM_MAP', 'system map is missing a supported immutable contract');
  }
  return value;
}

function normalizeQuery(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntelligenceError('INVALID_MAP_QUERY', 'map query must be an object');
  const type = clean(value.type || 'overview', 64);
  if (!QUERY_TYPES.has(type)) throw new IntelligenceError('INVALID_MAP_QUERY', `unsupported map query '${type}'`);
  const query = {
    type,
    limit: boundedInteger(value.limit, SYSTEM_MAP_LIMITS.defaultQueryLimit, 1, SYSTEM_MAP_LIMITS.maxQueryLimit, 'query.limit'),
  };
  if (value.lens !== undefined && value.lens !== '') {
    query.lens = clean(value.lens, 64);
    if (!LENSES.has(query.lens)) throw new IntelligenceError('INVALID_MAP_QUERY', `unsupported map lens '${query.lens}'`);
  }
  if (['search'].includes(type)) {
    query.text = clean(value.text, SYSTEM_MAP_LIMITS.maxSearchLength);
    if (!query.text) throw new IntelligenceError('INVALID_MAP_QUERY', 'search text is required');
  }
  if (type === 'group') query.groupId = clean(value.groupId, 512);
  if (['entity', 'neighbors', 'path', 'reverse-dependencies'].includes(type)) query.entityId = clean(value.entityId, 512);
  if (type === 'path') query.targetEntityId = clean(value.targetEntityId, 512);
  if (['neighbors', 'path', 'reverse-dependencies'].includes(type)) {
    query.depth = boundedInteger(value.depth, type === 'path' ? SYSTEM_MAP_LIMITS.maxPathDepth : 1, 1,
      type === 'path' ? SYSTEM_MAP_LIMITS.maxPathDepth : SYSTEM_MAP_LIMITS.maxQueryDepth, 'query.depth');
    query.direction = clean(value.direction || (type === 'reverse-dependencies' ? 'incoming' : 'both'), 16);
    if (!DIRECTIONS.has(query.direction)) throw new IntelligenceError('INVALID_MAP_QUERY', 'query.direction must be outgoing, incoming or both');
    if (Array.isArray(value.relationKinds)) query.relationKinds = [...new Set(value.relationKinds.map((item) => clean(item, 128)).filter(Boolean))].slice(0, 100);
  }
  if (type === 'evidence') {
    if (!Array.isArray(value.evidenceIds)) throw new IntelligenceError('INVALID_MAP_QUERY', 'evidenceIds must be an array');
    query.evidenceIds = [...new Set(value.evidenceIds.map((item) => clean(item, 512)).filter(Boolean))].slice(0, SYSTEM_MAP_LIMITS.maxQueryLimit);
  }
  for (const required of ['groupId', 'entityId', 'targetEntityId']) {
    if (required in query && !query[required]) throw new IntelligenceError('INVALID_MAP_QUERY', `${required} is required`);
  }
  return deepFreeze(query);
}

function selectedEvidence(entities, relations, directIds, indexes, limit) {
  const ids = new Set(directIds || []);
  for (const item of [...entities, ...relations]) for (const id of item.evidenceIds || []) ids.add(id);
  const all = [...ids].sort().map((id) => indexes.evidenceById.get(id)).filter(Boolean);
  return { items: all.slice(0, limit * 8), truncated: all.length > limit * 8 };
}

function result(map, query, { groups = [], entities = [], relations = [], evidenceIds = [], aggregates = null, diagnostics = [], truncated = false } = {}) {
  const indexes = mapIndexes(map.entities, map.relations, map.evidence);
  const evidence = selectedEvidence(entities, relations, evidenceIds, indexes, query.limit);
  return deepFreeze({
    schemaVersion: SYSTEM_MAP_SCHEMA_VERSION,
    mapId: map.id,
    snapshotId: map.snapshotId,
    query,
    groups: groups.slice(0, query.limit),
    entities: entities.slice(0, query.limit),
    relations: relations.slice(0, query.limit * 4),
    evidence: evidence.items,
    aggregates,
    diagnostics,
    truncated: Boolean(truncated || evidence.truncated || groups.length > query.limit || entities.length > query.limit || relations.length > query.limit * 4),
    authority: map.authority,
  });
}

function missing(code, message) {
  return [{ code, severity: 'warning', message, source: 'system-map-query' }];
}

function relationMatches(relation, query, fallbackPattern = null) {
  if (query.relationKinds?.length) return query.relationKinds.includes(relation.kind);
  return fallbackPattern ? fallbackPattern.test(relation.kind) : true;
}

function adjacent(relation, entityId, direction) {
  if (direction === 'outgoing' && relation.source === entityId) return relation.target;
  if (direction === 'incoming' && relation.target === entityId) return relation.source;
  if (direction === 'both') {
    if (relation.source === entityId) return relation.target;
    if (relation.target === entityId) return relation.source;
  }
  return null;
}

function graphWalk(map, query, fallbackPattern = null) {
  const indexes = mapIndexes(map.entities, map.relations, map.evidence);
  if (!indexes.entityById.has(query.entityId)) return result(map, query, { diagnostics: missing('MAP_ENTITY_NOT_FOUND', `Entity '${query.entityId}' was not found.`) });
  const selected = new Set([query.entityId]);
  const relationIds = new Set();
  let frontier = [query.entityId];
  let truncated = false;
  for (let depth = 0; depth < query.depth && frontier.length; depth += 1) {
    const next = [];
    for (const entityId of frontier) {
      for (const relation of map.relations) {
        if (!relationMatches(relation, query, fallbackPattern)) continue;
        const neighbor = adjacent(relation, entityId, query.direction);
        if (!neighbor) continue;
        if (selected.size >= query.limit || relationIds.size >= query.limit * 4) { truncated = true; continue; }
        relationIds.add(relation.id);
        if (!selected.has(neighbor)) { selected.add(neighbor); next.push(neighbor); }
      }
    }
    frontier = next;
  }
  const entities = [...selected].map((id) => indexes.entityById.get(id)).filter(Boolean);
  const allowed = new Set(entities.map((entity) => entity.id));
  const relations = [...relationIds].map((id) => indexes.relationById.get(id)).filter((relation) => relation && allowed.has(relation.source) && allowed.has(relation.target));
  const groups = map.groups.filter((group) => group.memberEntityIds.some((id) => allowed.has(id)));
  return result(map, query, { groups, entities, relations, truncated });
}

function pathQuery(map, query) {
  const indexes = mapIndexes(map.entities, map.relations, map.evidence);
  if (!indexes.entityById.has(query.entityId)) return result(map, query, { diagnostics: missing('MAP_ENTITY_NOT_FOUND', `Entity '${query.entityId}' was not found.`) });
  if (!indexes.entityById.has(query.targetEntityId)) return result(map, query, { diagnostics: missing('MAP_TARGET_NOT_FOUND', `Target '${query.targetEntityId}' was not found.`) });
  const queue = [{ id: query.entityId, depth: 0 }];
  const previous = new Map([[query.entityId, null]]);
  let scanned = 0;
  while (queue.length && !previous.has(query.targetEntityId)) {
    const current = queue.shift();
    if (current.depth >= query.depth) continue;
    for (const relation of map.relations) {
      if (!relationMatches(relation, query)) continue;
      const neighbor = adjacent(relation, current.id, query.direction);
      if (!neighbor || previous.has(neighbor)) continue;
      scanned += 1;
      if (scanned > query.limit * SYSTEM_MAP_LIMITS.maxPathDepth) break;
      previous.set(neighbor, { entityId: current.id, relationId: relation.id });
      queue.push({ id: neighbor, depth: current.depth + 1 });
    }
  }
  if (!previous.has(query.targetEntityId)) return result(map, query, {
    diagnostics: missing('MAP_PATH_NOT_FOUND', `No path was found within depth ${query.depth}.`),
    truncated: scanned > query.limit * SYSTEM_MAP_LIMITS.maxPathDepth,
  });
  const entityIds = [];
  const relationIds = [];
  let cursor = query.targetEntityId;
  while (cursor) {
    entityIds.push(cursor);
    const step = previous.get(cursor);
    if (!step) break;
    relationIds.push(step.relationId);
    cursor = step.entityId;
  }
  entityIds.reverse(); relationIds.reverse();
  const entities = entityIds.map((id) => indexes.entityById.get(id));
  const relations = relationIds.map((id) => indexes.relationById.get(id));
  const ids = new Set(entityIds);
  return result(map, query, { groups: map.groups.filter((group) => group.memberEntityIds.some((id) => ids.has(id))), entities, relations });
}

function countBy(values, selector) {
  const counts = new Map();
  for (const value of values) {
    const key = clean(selector(value) || 'unknown', 256) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function aggregates(map) {
  return {
    groupsByLens: countBy(map.groups, (group) => group.lens),
    entitiesByKind: countBy(map.entities, (entity) => entity.kind),
    entitiesByLanguage: countBy(map.entities, (entity) => entity.language || 'unknown'),
    relationsByKind: countBy(map.relations, (relation) => relation.kind),
    evidenceByProvenance: countBy(map.evidence, (item) => item.provenance),
    coverageByStatus: Object.entries(map.coverage.counts).map(([key, count]) => ({ key, count })),
  };
}

export function querySystemMap(mapValue, queryValue = {}) {
  const map = assertMap(mapValue);
  const query = normalizeQuery(queryValue);
  const indexes = mapIndexes(map.entities, map.relations, map.evidence);
  if (query.type === 'overview') {
    const groups = map.groups.filter((group) => !query.lens || group.lens === query.lens);
    return result(map, query, { groups, aggregates: aggregates(map), diagnostics: map.diagnostics.slice(0, 100) });
  }
  if (query.type === 'aggregate') return result(map, query, { aggregates: aggregates(map), diagnostics: map.diagnostics.slice(0, 100) });
  if (query.type === 'search') {
    const needle = query.text.toLocaleLowerCase();
    const groups = map.groups.filter((group) => (!query.lens || group.lens === query.lens)
      && `${group.name} ${group.summary} ${group.lens}`.toLocaleLowerCase().includes(needle));
    const entities = map.entities.filter((entity) => entityText(entity).includes(needle));
    const selected = new Set(entities.slice(0, query.limit).map((entity) => entity.id));
    const relations = map.relations.filter((relation) => selected.has(relation.source) && selected.has(relation.target));
    return result(map, query, { groups, entities, relations });
  }
  if (query.type === 'group') {
    const group = map.groups.find((item) => item.id === query.groupId);
    if (!group) return result(map, query, { diagnostics: missing('MAP_GROUP_NOT_FOUND', `Group '${query.groupId}' was not found.`) });
    const members = new Set(group.memberEntityIds);
    return result(map, query, {
      groups: [group],
      entities: group.memberEntityIds.map((id) => indexes.entityById.get(id)).filter(Boolean),
      relations: group.relationIds.map((id) => indexes.relationById.get(id)).filter(Boolean)
        .filter((relation) => members.has(relation.source) && members.has(relation.target)),
      evidenceIds: group.evidenceIds,
    });
  }
  if (query.type === 'entity') {
    const entity = indexes.entityById.get(query.entityId);
    if (!entity) return result(map, query, { diagnostics: missing('MAP_ENTITY_NOT_FOUND', `Entity '${query.entityId}' was not found.`) });
    const relations = [...(indexes.outgoing.get(entity.id) || []), ...(indexes.incoming.get(entity.id) || [])];
    return result(map, query, {
      groups: map.groups.filter((group) => group.memberEntityIds.includes(entity.id)), entities: [entity], relations,
    });
  }
  if (query.type === 'neighbors') return graphWalk(map, query);
  if (query.type === 'reverse-dependencies') return graphWalk(map, query, DEPENDENCY_RELATION);
  if (query.type === 'path') return pathQuery(map, query);
  const missingIds = [];
  const evidence = [];
  for (const id of query.evidenceIds) {
    const item = indexes.evidenceById.get(id);
    if (item) evidence.push(item);
    else missingIds.push(id);
  }
  return deepFreeze({
    schemaVersion: SYSTEM_MAP_SCHEMA_VERSION, mapId: map.id, snapshotId: map.snapshotId, query,
    groups: [], entities: [], relations: [], evidence: evidence.slice(0, query.limit), aggregates: null,
    diagnostics: missingIds.length ? missing('MAP_EVIDENCE_NOT_FOUND', `Evidence not found: ${missingIds.join(', ')}`) : [],
    truncated: evidence.length > query.limit, authority: map.authority,
  });
}

export function summarizeSystemMap(mapValue) {
  const map = assertMap(mapValue);
  return deepFreeze({
    schemaVersion: map.schemaVersion,
    algorithmVersion: map.algorithmVersion,
    id: map.id,
    snapshotId: map.snapshotId,
    repository: map.repository,
    derivedAt: map.derivedAt,
    authority: map.authority,
    source: map.source,
    counts: map.counts,
    coverage: map.coverage,
    lenses: map.lenses,
    diagnostics: map.diagnostics.slice(0, 500),
  });
}

function changedBucket(fromItems, toItems, identity = (item) => item.id) {
  const before = new Map(fromItems.map((item) => [identity(item), item]));
  const after = new Map(toItems.map((item) => [identity(item), item]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()].filter((id) => before.has(id) && canonical(before.get(id)) !== canonical(after.get(id))).sort();
  return { added, removed, changed };
}

export function compareSystemMaps(fromValue, toValue) {
  const from = assertMap(fromValue);
  const to = assertMap(toValue);
  if (from.repository.id !== to.repository.id || from.repository.adapter !== to.repository.adapter) {
    throw new IntelligenceError('MAP_REPOSITORY_MISMATCH', 'system maps belong to different repositories or adapters');
  }
  const content = changedBucket(
    from.content?.files || [],
    to.content?.files || [],
    (item) => item.path,
  );
  const removedByDigest = new Map((from.content?.files || [])
    .filter((file) => content.removed.includes(file.path))
    .map((file) => [file.digest, file.path]));
  const moved = (to.content?.files || [])
    .filter((file) => content.added.includes(file.path) && removedByDigest.has(file.digest))
    .map((file) => ({ from: removedByDigest.get(file.digest), to: file.path, digest: file.digest }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const observed = {
    entities: changedBucket(from.entities, to.entities),
    relations: changedBucket(from.relations, to.relations),
    evidence: changedBucket(from.evidence, to.evidence),
  };
  const inferenceIdentity = (group) => `${group.lens}:${group.attributes?.strategy || 'facet'}:${group.attributes?.sourceEntityId || group.attributes?.seedEntityId || group.attributes?.community || group.attributes?.pathBucket || group.name}`;
  const inference = changedBucket(from.groups, to.groups, inferenceIdentity);
  const analyzer = {
    changed: canonical(from.source.analyzer) !== canonical(to.source.analyzer)
      || from.source.configurationDigest !== to.source.configurationDigest,
    from: { ...from.source.analyzer, configurationDigest: from.source.configurationDigest },
    to: { ...to.source.analyzer, configurationDigest: to.source.configurationDigest },
  };
  const manifestChanged = from.source.manifestDigest !== to.source.manifestDigest;
  const inferenceChanged = Boolean(inference.added.length || inference.removed.length || inference.changed.length);
  const evidenceChanged = Object.values(observed).some((bucket) => bucket.added.length || bucket.removed.length || bucket.changed.length);
  const causes = [
    ...(manifestChanged ? ['code'] : []),
    ...(evidenceChanged ? ['evidence'] : []),
    ...(analyzer.changed ? ['analyzer'] : []),
    ...(inferenceChanged ? ['inference'] : []),
  ];
  return deepFreeze({
    schemaVersion: SYSTEM_MAP_SCHEMA_VERSION,
    from: summarizeSystemMap(from),
    to: summarizeSystemMap(to),
    causes,
    noChange: causes.length === 0,
    content: {
      manifestChanged,
      ...content,
      moved,
      truncated: Boolean(from.content?.truncated || to.content?.truncated),
    },
    analyzer,
    observed,
    inference,
    authority: to.authority,
  });
}

function markdownCell(value) {
  return clean(value, 1_000).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function markdownCode(value) {
  return clean(value, 1_000).replaceAll('`', '\\`').replaceAll('\n', ' ');
}

export function exportSystemMap(mapValue, { format = 'markdown', maxGroups = 500, maxBytes = SYSTEM_MAP_LIMITS.maxExportBytes } = {}) {
  const map = assertMap(mapValue);
  const normalizedFormat = clean(format, 32).toLocaleLowerCase();
  const groupLimit = boundedInteger(maxGroups, 500, 1, SYSTEM_MAP_LIMITS.maxGroups, 'maxGroups');
  const byteLimit = boundedInteger(maxBytes, SYSTEM_MAP_LIMITS.maxExportBytes, 1_024, 16 * 1024 * 1024, 'maxBytes');
  let content;
  let mediaType;
  if (normalizedFormat === 'json') {
    content = `${JSON.stringify(map, null, 2)}\n`;
    mediaType = 'application/json';
  } else if (normalizedFormat === 'markdown' || normalizedFormat === 'md') {
    const lines = [
      '# Derived system map',
      '',
      '> This report is derived analysis. It is not accepted repository planning truth and does not define components.',
      '',
      `- Map: \`${markdownCode(map.id)}\``,
      `- Snapshot: \`${markdownCode(map.snapshotId)}\``,
      `- Analyzer: ${markdownCell(map.source.analyzer.name)} ${markdownCell(map.source.analyzer.version)}`,
      `- Snapshot status: ${markdownCell(map.source.snapshotStatus)} / ${markdownCell(map.source.freshness.state)}`,
      `- Selected evidence: ${map.counts.entities} entities, ${map.counts.relations} relations, ${map.counts.evidence} evidence records`,
      '',
      '## Coverage',
      '',
      '| Subject | Status | Summary |',
      '| --- | --- | --- |',
      ...map.coverage.subjects.map((item) => `| ${markdownCell(item.subject)} | ${markdownCell(item.status)} | ${markdownCell(item.summary)} |`),
      '',
      '## Derived groups',
      '',
      ...map.groups.slice(0, groupLimit).flatMap((group) => [
        `### ${markdownCell(group.name)}`,
        '',
        `Lens: **${markdownCell(group.lens)}** · provenance: **${markdownCell(group.provenance)}** · uncertainty: **${markdownCell(group.uncertainty.level)}**`,
        '',
        markdownCell(group.summary),
        '',
        `Members (${group.memberEntityIds.length}): ${group.memberEntityIds.slice(0, 40).map((id) => `\`${markdownCode(id)}\``).join(', ')}${group.memberEntityIds.length > 40 ? ', …' : ''}`,
        '',
        `Evidence: ${group.evidenceIds.length ? group.evidenceIds.map((id) => `\`${markdownCode(id)}\``).join(', ') : 'none retained'}`,
        '',
      ]),
      ...(map.groups.length > groupLimit ? [`_Export truncated at ${groupLimit} of ${map.groups.length} groups._`, ''] : []),
    ];
    content = `${lines.join('\n')}\n`;
    mediaType = 'text/markdown';
  } else {
    throw new IntelligenceError('UNSUPPORTED_MAP_EXPORT', "system map export format must be 'markdown' or 'json'");
  }
  const bytes = Buffer.byteLength(content);
  if (bytes > byteLimit) throw new IntelligenceError('MAP_EXPORT_LIMIT', `system map export exceeded the ${byteLimit}-byte limit`, { details: { bytes, maxBytes: byteLimit } });
  return deepFreeze({
    format: normalizedFormat === 'md' ? 'markdown' : normalizedFormat,
    mediaType,
    filename: `handraise-system-map-${map.snapshotId.slice(0, 12)}.${normalizedFormat === 'json' ? 'json' : 'md'}`,
    bytes,
    content,
    authority: map.authority,
  });
}

export class SystemMapRuntime {
  constructor({ limits = {}, maxCached = 8 } = {}) {
    this.limits = normalizeLimits(limits);
    this.maxCached = boundedInteger(maxCached, 8, 1, 64, 'maxCached');
    this.cache = new Map();
  }

  build(snapshot) {
    const validated = validateAnalysisSnapshot(snapshot);
    const key = `${validated.id}:${sha256(canonical(this.limits))}`;
    if (this.cache.has(key)) {
      const current = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, current);
      return current;
    }
    const map = deriveSystemMap(validated, { limits: this.limits });
    this.cache.set(key, map);
    while (this.cache.size > this.maxCached) this.cache.delete(this.cache.keys().next().value);
    return map;
  }

  describe(snapshot) { return summarizeSystemMap(this.build(snapshot)); }
  query(snapshot, query) { return querySystemMap(this.build(snapshot), query); }
  compare(fromSnapshot, toSnapshot) { return compareSystemMaps(this.build(fromSnapshot), this.build(toSnapshot)); }
  export(snapshot, options) { return exportSystemMap(this.build(snapshot), options); }
  clear() { this.cache.clear(); }
}
