import {
  ANALYSIS_SCHEMA_VERSION, GRAPH_QUERY_LIMITS, validateAnalysisSnapshot, validateGraphQuery, validateGraphQueryResult,
} from './contracts.mjs';

function indexes(snapshot) {
  return {
    entities: new Map(snapshot.entities.map((entity) => [entity.id, entity])),
    relations: new Map(snapshot.relations.map((relation) => [relation.id, relation])),
    evidence: new Map(snapshot.evidence.map((item) => [item.id, item])),
  };
}

function relationAllowed(relation, query) {
  return !query.relationKinds?.length || query.relationKinds.includes(relation.kind);
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

function evidenceFor(entities, relations, evidenceIndex) {
  const ids = new Set();
  for (const item of [...entities, ...relations]) for (const id of item.evidenceIds || []) ids.add(id);
  return [...ids].map((id) => evidenceIndex.get(id)).filter(Boolean).slice(0, GRAPH_QUERY_LIMITS.maxLimit * 8);
}

function diagnostic(code, message) {
  return { code, severity: 'warning', message };
}

function queryEntity(snapshot, query, index) {
  const entity = index.entities.get(query.entityId);
  if (!entity) return { entities: [], relations: [], evidence: [], diagnostics: [diagnostic('ENTITY_NOT_FOUND', `Entity '${query.entityId}' does not exist in this snapshot.`)], truncated: false };
  return { entities: [entity], relations: [], evidence: evidenceFor([entity], [], index.evidence), diagnostics: [], truncated: false };
}

function querySearch(snapshot, query, index) {
  const needle = query.text.toLocaleLowerCase();
  const candidates = snapshot.entities.filter((entity) => (
    entity.id.toLocaleLowerCase().includes(needle)
    || entity.name.toLocaleLowerCase().includes(needle)
    || entity.kind.toLocaleLowerCase().includes(needle)
    || String(entity.location?.path || '').toLocaleLowerCase().includes(needle)
  ));
  const entities = candidates.slice(0, query.limit);
  return {
    entities, relations: [], evidence: evidenceFor(entities, [], index.evidence), diagnostics: [],
    truncated: candidates.length > entities.length,
  };
}

function queryNeighbors(snapshot, query, index) {
  if (!index.entities.has(query.entityId)) return queryEntity(snapshot, query, index);
  const visited = new Set([query.entityId]);
  const selectedRelations = new Map();
  let frontier = [query.entityId];
  let truncated = false;
  for (let depth = 0; depth < query.depth && frontier.length; depth += 1) {
    const next = [];
    for (const entityId of frontier) {
      for (const relation of snapshot.relations) {
        if (!relationAllowed(relation, query)) continue;
        const neighbor = adjacent(relation, entityId, query.direction);
        if (!neighbor) continue;
        if (selectedRelations.size >= query.limit * 4 || visited.size >= query.limit) {
          truncated = true;
          continue;
        }
        selectedRelations.set(relation.id, relation);
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  const entities = [...visited].map((id) => index.entities.get(id)).filter(Boolean).slice(0, query.limit);
  const allowedEntityIds = new Set(entities.map((entity) => entity.id));
  const relations = [...selectedRelations.values()].filter((relation) => (
    allowedEntityIds.has(relation.source) && allowedEntityIds.has(relation.target)
  )).slice(0, query.limit * 4);
  return { entities, relations, evidence: evidenceFor(entities, relations, index.evidence), diagnostics: [], truncated };
}

function queryPath(snapshot, query, index) {
  if (!index.entities.has(query.entityId)) return queryEntity(snapshot, query, index);
  if (!index.entities.has(query.targetEntityId)) {
    return { entities: [], relations: [], evidence: [], diagnostics: [diagnostic('TARGET_ENTITY_NOT_FOUND', `Target entity '${query.targetEntityId}' does not exist in this snapshot.`)], truncated: false };
  }
  const queue = [{ id: query.entityId, depth: 0 }];
  const previous = new Map([[query.entityId, null]]);
  let found = query.entityId === query.targetEntityId;
  let scanned = 0;
  while (queue.length && !found) {
    const current = queue.shift();
    if (current.depth >= query.depth) continue;
    for (const relation of snapshot.relations) {
      if (!relationAllowed(relation, query)) continue;
      const neighbor = adjacent(relation, current.id, query.direction);
      if (!neighbor || previous.has(neighbor)) continue;
      scanned += 1;
      if (scanned > query.limit * GRAPH_QUERY_LIMITS.maxPathDepth) break;
      previous.set(neighbor, { entityId: current.id, relationId: relation.id });
      if (neighbor === query.targetEntityId) {
        found = true;
        break;
      }
      queue.push({ id: neighbor, depth: current.depth + 1 });
    }
  }
  if (!found) {
    return { entities: [], relations: [], evidence: [], diagnostics: [diagnostic('PATH_NOT_FOUND', `No path was found within depth ${query.depth}.`)], truncated: scanned > query.limit * GRAPH_QUERY_LIMITS.maxPathDepth };
  }
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
  entityIds.reverse();
  relationIds.reverse();
  const entities = entityIds.map((id) => index.entities.get(id));
  const relations = relationIds.map((id) => index.relations.get(id));
  return { entities, relations, evidence: evidenceFor(entities, relations, index.evidence), diagnostics: [], truncated: false };
}

function queryEvidence(snapshot, query, index) {
  const missing = [];
  const evidence = [];
  for (const id of query.evidenceIds.slice(0, query.limit)) {
    const item = index.evidence.get(id);
    if (item) evidence.push(item);
    else missing.push(id);
  }
  return {
    entities: [], relations: [], evidence,
    diagnostics: missing.length ? [diagnostic('EVIDENCE_NOT_FOUND', `Evidence not found: ${missing.join(', ')}`)] : [],
    truncated: query.evidenceIds.length > query.limit,
  };
}

export function queryAnalysisSnapshot(snapshotValue, queryValue) {
  const snapshot = validateAnalysisSnapshot(snapshotValue);
  const query = validateGraphQuery(queryValue);
  if (query.snapshotId !== snapshot.id) {
    throw new Error(`query snapshot '${query.snapshotId}' does not match '${snapshot.id}'`);
  }
  const index = indexes(snapshot);
  let result;
  if (query.type === 'entity') result = queryEntity(snapshot, query, index);
  else if (query.type === 'search') result = querySearch(snapshot, query, index);
  else if (query.type === 'neighbors') result = queryNeighbors(snapshot, query, index);
  else if (query.type === 'path') result = queryPath(snapshot, query, index);
  else result = queryEvidence(snapshot, query, index);
  return validateGraphQueryResult({
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    snapshotId: snapshot.id,
    query,
    ...result,
  });
}

export function createSnapshotQuery(snapshotValue) {
  const snapshot = validateAnalysisSnapshot(snapshotValue);
  return Object.freeze({
    snapshot,
    query: (query) => queryAnalysisSnapshot(snapshot, { ...query, snapshotId: snapshot.id }),
  });
}
