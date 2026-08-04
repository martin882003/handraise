import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const RECONCILIATION_SCHEMA_VERSION = 1;
export const RECONCILIATION_DECISIONS = ['open', 'dismissed', 'deferred', 'accepted-for-planning'];
export const RECONCILIATION_DEFAULT_LIMITS = Object.freeze({
  maxChangedItems: 1_000,
  maxFindingsPerCycle: 500,
  maxAffectedPerKind: 250,
  maxCycles: 30,
  maxJobs: 30,
  maxTriggers: 100,
  retentionMs: 30 * 24 * 60 * 60 * 1_000,
});

const DECISIONS = new Set(RECONCILIATION_DECISIONS);
const TERMINAL_ANALYSIS_STATES = new Set(['complete', 'stale', 'cancelled', 'failed']);
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function clean(value, limit = 4_000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function line(value, limit = 500) { return clean(value, limit).replace(/\s+/g, ' '); }
function unique(values, limit = 1_000) { return [...new Set((values || []).filter(Boolean))].slice(0, limit); }
function timestamp(value) { return new Date(value).toISOString(); }

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function syncDirectory(path) {
  let descriptor;
  try { descriptor = openSync(path, 'r'); fsyncSync(descriptor); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes(error?.code)) throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function atomicJson(path, value) {
  privateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    syncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

export class ReconciliationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
    this.details = details;
  }

  toJSON() { return { error: this.message, code: this.code, details: this.details }; }
}

function fail(code, message, details = null) { throw new ReconciliationError(code, message, details); }

function normalizedLimits(value = {}) {
  const result = { ...RECONCILIATION_DEFAULT_LIMITS };
  for (const [key, fallback] of Object.entries(result)) {
    const selected = Number(value[key]);
    if (Number.isFinite(selected) && selected > 0) result[key] = Math.floor(selected);
    else result[key] = fallback;
  }
  result.maxChangedItems = Math.min(result.maxChangedItems, 10_000);
  result.maxFindingsPerCycle = Math.min(result.maxFindingsPerCycle, 2_000);
  result.maxAffectedPerKind = Math.min(result.maxAffectedPerKind, 2_000);
  result.maxCycles = Math.min(result.maxCycles, 200);
  result.maxJobs = Math.min(result.maxJobs, 200);
  result.maxTriggers = Math.min(result.maxTriggers, 1_000);
  return result;
}

function normalizePortfolio(value = {}) {
  const portfolio = value?.portfolio || value || {};
  const acceptedProduct = value?.product || portfolio.product || null;
  return {
    components: (portfolio.components || []).map((item) => ({
      slug: item.slug || item.contract?.slug,
      title: item.title || item.contract?.title || item.slug,
      contract: item.contract?.contract || item.contract || {},
    })).filter((item) => item.slug),
    fronts: (portfolio.fronts || []).map((item) => item.contract || item).filter((item) => item.slug),
    product: acceptedProduct?.brief || acceptedProduct || null,
  };
}

function mapCatalog(map) {
  const evidence = new Map((map.evidence || []).map((item) => [item.id, item]));
  const entities = new Map((map.entities || []).map((item) => [item.id, item]));
  const relations = new Map((map.relations || []).map((item) => [item.id, item]));
  const groups = new Map((map.groups || []).map((item) => [item.id, item]));
  const all = new Set([
    map.id, map.snapshotId,
    ...evidence.keys(), ...entities.keys(), ...relations.keys(), ...groups.keys(),
  ].filter(Boolean));
  return { evidence, entities, relations, groups, all };
}

function groupIdentity(group) {
  return `${group.lens}:${group.attributes?.strategy || 'facet'}:${group.attributes?.sourceEntityId || group.attributes?.seedEntityId || group.attributes?.community || group.attributes?.pathBucket || group.name}`;
}

function changedSet(bucket = {}) { return new Set([...(bucket.added || []), ...(bucket.removed || []), ...(bucket.changed || [])]); }

function territoryPattern(raw) {
  const value = clean(raw, 1_000).replace(/^[-*]\s+/, '').trim();
  const quoted = value.match(/`([^`]+)`/)?.[1];
  return clean(quoted || value.split(/\s+[—–]\s+|\s+#\s+/)[0], 1_000)
    .replace(/^!/, '').replace(/^\.\//, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function globExpression(pattern) {
  let output = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') { output += '.*'; index += 1; }
    else if (character === '*') output += '[^/]*';
    else if (character === '?') output += '[^/]';
    else output += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${output}(?:/.*)?$`);
}

function territoryMatches(pathValue, rawPattern) {
  const path = clean(pathValue, 4_096).replace(/^\.\//, '').replace(/\\/g, '/').replace(/^\/+/, '');
  const pattern = territoryPattern(rawPattern);
  if (!path || !pattern || pattern.includes(' ') || pattern.startsWith('!')) return false;
  if (!/[?*[]/.test(pattern)) return path === pattern || path.startsWith(`${pattern}/`);
  try { return globExpression(pattern).test(path); } catch { return false; }
}

function territoryOwners(path, components) {
  return components.filter((component) => (component.contract.territory || []).some((pattern) => territoryMatches(path, pattern)))
    .map((component) => component.slug).sort();
}

function entityArchitectureKind(entity) {
  const value = `${entity?.kind || ''} ${entity?.name || ''}`.toLocaleLowerCase();
  if (/deploy|service|application|executable|worker|daemon|runtime|container/.test(value)) return 'deployable';
  if (/interface|endpoint|route|controller|handler|api|rpc|event|message|port/.test(value)) return 'interface';
  if (/database|data.?store|repository|table|schema|model|entity|cache|queue|topic/.test(value)) return 'data';
  return null;
}

function relationIsDependency(relation) {
  return /depend|import|call|invoke|consume|produce|publish|subscribe|read|write|connect|request|response|route|load/.test(String(relation?.kind || '').toLocaleLowerCase());
}

function confidence(score, reasons = []) {
  const bounded = Math.max(0, Math.min(1, Number(score) || 0));
  return {
    score: bounded,
    level: bounded >= 0.8 ? 'high' : bounded >= 0.55 ? 'medium' : 'low',
    reasons: unique(reasons.map((item) => line(item, 500)), 20),
  };
}

function findingIdentity(kind, subject) {
  return `rec-${sha256(canonical({ kind, subject })).slice(0, 24)}`;
}

function findingRecord(input, context) {
  const subject = {
    kind: line(input.subject?.kind || 'repository', 80),
    id: line(input.subject?.id || context.repository.id, 1_000),
    label: line(input.subject?.label || input.subject?.id || context.repository.name || context.repository.id, 1_000),
  };
  const id = findingIdentity(input.kind, { kind: subject.kind, id: subject.id });
  const at = timestamp(context.now);
  return {
    schemaVersion: RECONCILIATION_SCHEMA_VERSION,
    id,
    kind: line(input.kind, 120),
    severity: ['critical', 'high', 'medium', 'low', 'info'].includes(input.severity) ? input.severity : 'medium',
    summary: line(input.summary, 2_000),
    detail: clean(input.detail, 8_000),
    subject,
    confidence: input.confidence || confidence(0.6),
    provenance: {
      kind: ['observed', 'inferred', 'declared'].includes(input.provenance?.kind) ? input.provenance.kind : 'inferred',
      snapshotIds: unique(input.provenance?.snapshotIds || [context.fromMap.snapshotId, context.toMap.snapshotId], 10),
      analyzerIds: unique(input.provenance?.analyzerIds || [context.fromMap.source?.analyzer?.id, context.toMap.source?.analyzer?.id], 10),
      explanation: line(input.provenance?.explanation || 'Derived from a bounded comparison of immutable repository analysis snapshots.', 1_000),
    },
    evidence: {
      ids: unique(input.evidence?.ids || [], 500),
      paths: unique(input.evidence?.paths || [], 500),
    },
    alternatives: (input.alternatives || []).slice(0, 20).map((item) => typeof item === 'string'
      ? { summary: line(item, 1_000), evidenceIds: [] }
      : { summary: line(item.summary, 1_000), evidenceIds: unique(item.evidenceIds || [], 100) }),
    guidance: line(input.guidance || 'Review the evidence and decide whether accepted planning needs a separate publication.', 2_000),
    affected: { productClaims: [], components: [], fronts: [], runs: [] },
    firstSeen: at,
    lastSeen: at,
    occurrences: 1,
    active: true,
    disposition: 'open',
    dispositionRecord: null,
  };
}

function mergeFinding(target, source) {
  target.evidence.ids = unique([...target.evidence.ids, ...source.evidence.ids], 500);
  target.evidence.paths = unique([...target.evidence.paths, ...source.evidence.paths], 500);
  target.alternatives = [...new Map([...target.alternatives, ...source.alternatives].map((item) => [item.summary, item])).values()].slice(0, 20);
  if (['critical', 'high', 'medium', 'low', 'info'].indexOf(source.severity) < ['critical', 'high', 'medium', 'low', 'info'].indexOf(target.severity)) target.severity = source.severity;
  return target;
}

function productClaims(product) {
  if (!product) return [];
  const result = [{ kind: 'purpose', id: product.purpose?.id || 'purpose', sourceIds: product.purpose?.sourceIds || [] }];
  for (const key of ['users', 'outcomes', 'constraints', 'invariants', 'nonGoals', 'goals', 'assumptions', 'decisions', 'conflicts']) {
    for (const item of product[key] || []) result.push({ kind: key, id: item.id, sourceIds: item.sourceIds || [] });
  }
  return result;
}

function enrichAffected(finding, context) {
  const { portfolio, runs, oldCatalog, newCatalog, changedEvidenceIds, changedPaths, limits } = context;
  const references = new Set(finding.evidence.ids);
  const paths = new Set(finding.evidence.paths);
  const affectedComponents = new Set();
  const affectedFronts = new Set();
  const affectedProduct = new Set();

  for (const claim of productClaims(portfolio.product)) {
    if (claim.sourceIds.some((id) => references.has(id) || changedEvidenceIds.has(id))) affectedProduct.add(`${claim.kind}:${claim.id}`);
  }
  for (const component of portfolio.components) {
    const evidence = component.contract.evidence || [];
    if (evidence.some((item) => references.has(item.reference) || changedEvidenceIds.has(item.reference))
      || [...paths].some((path) => (component.contract.territory || []).some((pattern) => territoryMatches(path, pattern)))) {
      affectedComponents.add(component.slug);
    }
  }
  for (const front of portfolio.fronts) {
    const frontComponents = [front.leadComponent || front.component, ...(front.affectedComponents || [])].filter(Boolean);
    if ((front.evidence || []).some((item) => references.has(item.reference) || changedEvidenceIds.has(item.reference))
      || references.has(front.analysisSnapshot)
      || frontComponents.some((slug) => affectedComponents.has(slug))) affectedFronts.add(front.slug);
  }
  let changed = true;
  for (let depth = 0; changed && depth < 3; depth += 1) {
    changed = false;
    for (const front of portfolio.fronts) {
      if (affectedFronts.has(front.slug)) continue;
      if ((front.dependencies || []).some((edge) => affectedFronts.has(edge.target))) { affectedFronts.add(front.slug); changed = true; }
    }
  }

  const affectedRuns = new Set();
  if (finding.subject.kind === 'run') affectedRuns.add(finding.subject.id);
  for (const run of runs || []) {
    const manifest = run.manifest || {};
    if (affectedFronts.has(manifest.front?.slug)
      || (manifest.components || []).some((component) => affectedComponents.has(component.slug))
      || references.has(manifest.source?.analysisSnapshot)
      || (run.discoveries || []).some((item) => (item.affectedFronts || []).some((slug) => affectedFronts.has(slug)))) affectedRuns.add(run.id);
  }

  // Evidence referenced by a changed entity/relation is useful even when the
  // accepted contract did not cite that exact graph node.
  for (const id of [...references]) {
    const node = newCatalog.entities.get(id) || oldCatalog.entities.get(id) || newCatalog.relations.get(id) || oldCatalog.relations.get(id);
    for (const evidenceId of node?.evidenceIds || []) references.add(evidenceId);
    const path = node?.location?.path;
    if (path) paths.add(path);
  }
  for (const path of changedPaths) if ([...paths].some((selected) => selected === path)) {
    for (const owner of territoryOwners(path, portfolio.components)) affectedComponents.add(owner);
  }

  finding.evidence.ids = unique([...references], 500);
  finding.evidence.paths = unique([...paths], 500);
  finding.affected = {
    productClaims: [...affectedProduct].sort().slice(0, limits.maxAffectedPerKind),
    components: [...affectedComponents].sort().slice(0, limits.maxAffectedPerKind),
    fronts: [...affectedFronts].sort().slice(0, limits.maxAffectedPerKind),
    runs: [...affectedRuns].sort().slice(0, limits.maxAffectedPerKind),
  };
  return finding;
}

function stalenessFrom(findings, limits) {
  const collections = { productClaims: new Map(), components: new Map(), fronts: new Map(), runs: new Map() };
  for (const finding of findings) for (const kind of Object.keys(collections)) for (const id of finding.affected[kind] || []) {
    const current = collections[kind].get(id) || { id, severity: finding.severity, findingIds: [], reasons: [] };
    current.findingIds.push(finding.id);
    current.reasons.push(finding.summary);
    if (['critical', 'high', 'medium', 'low', 'info'].indexOf(finding.severity) < ['critical', 'high', 'medium', 'low', 'info'].indexOf(current.severity)) current.severity = finding.severity;
    collections[kind].set(id, current);
  }
  return Object.fromEntries(Object.entries(collections).map(([kind, records]) => [kind, [...records.values()].map((item) => ({
    ...item, findingIds: unique(item.findingIds, 100), reasons: unique(item.reasons, 20),
  })).slice(0, limits.maxAffectedPerKind)]));
}

function boundedComparison(value, limit) {
  const bucket = (input = {}) => ({
    added: (input.added || []).slice(0, limit), removed: (input.removed || []).slice(0, limit), changed: (input.changed || []).slice(0, limit),
  });
  return {
    schemaVersion: value.schemaVersion,
    from: value.from,
    to: value.to,
    causes: value.causes || [],
    noChange: Boolean(value.noChange),
    content: {
      manifestChanged: Boolean(value.content?.manifestChanged), ...bucket(value.content),
      moved: (value.content?.moved || []).slice(0, limit),
      truncated: Boolean(value.content?.truncated || (value.content?.added || []).length > limit || (value.content?.removed || []).length > limit || (value.content?.changed || []).length > limit || (value.content?.moved || []).length > limit),
    },
    analyzer: value.analyzer,
    observed: {
      entities: bucket(value.observed?.entities), relations: bucket(value.observed?.relations), evidence: bucket(value.observed?.evidence),
    },
    inference: bucket(value.inference),
    authority: value.authority,
  };
}

export function reconcileArchitecture({
  repository, fromMap, toMap, comparison, portfolio: portfolioValue = {}, runs = [], previousFindings = [],
  cause = 'manual', sourceId = null, now = Date.now(), limits: limitValue = {},
} = {}) {
  if (!repository?.id || !fromMap?.snapshotId || !toMap?.snapshotId || !comparison) {
    fail('RECONCILIATION_INPUT_INVALID', 'repository, two system maps and their comparison are required');
  }
  if (fromMap.repository?.id !== repository.id || toMap.repository?.id !== repository.id) {
    fail('RECONCILIATION_REPOSITORY_MISMATCH', 'system maps do not belong to the selected repository');
  }
  const limits = normalizedLimits(limitValue);
  const portfolio = normalizePortfolio(portfolioValue);
  const oldCatalog = mapCatalog(fromMap);
  const newCatalog = mapCatalog(toMap);
  const changedEvidenceIds = new Set([
    ...changedSet(comparison.observed?.evidence), ...changedSet(comparison.observed?.entities),
    ...changedSet(comparison.observed?.relations), ...changedSet(comparison.inference),
  ]);
  const changedPaths = new Set([
    ...(comparison.content?.added || []), ...(comparison.content?.removed || []), ...(comparison.content?.changed || []),
    ...(comparison.content?.moved || []).flatMap((item) => [item.from, item.to]),
  ]);
  const context = { repository, fromMap, toMap, comparison, portfolio, runs, oldCatalog, newCatalog, changedEvidenceIds, changedPaths, now, limits };
  const records = new Map();
  const diagnostics = [];
  const emit = (input) => {
    if (records.size >= limits.maxFindingsPerCycle && !records.has(findingIdentity(input.kind, { kind: input.subject?.kind || 'repository', id: input.subject?.id || repository.id }))) return;
    const next = findingRecord(input, context);
    if (records.has(next.id)) mergeFinding(records.get(next.id), next);
    else records.set(next.id, next);
  };

  if (!comparison.noChange) {
    if (comparison.analyzer?.changed) emit({
      kind: 'analyzer-change', severity: comparison.causes?.includes('inference') ? 'medium' : 'info',
      subject: { kind: 'analyzer-transition', id: `${comparison.analyzer.from?.id}@${comparison.analyzer.from?.version}->${comparison.analyzer.to?.id}@${comparison.analyzer.to?.version}`, label: 'Analyzer or configuration changed' },
      summary: 'The analyzer or its configuration changed between snapshots.',
      detail: 'Inference differences are kept separate from repository content changes; accepted architecture remains unchanged until human review.',
      confidence: confidence(1, ['Analyzer descriptors and configuration digests are immutable snapshot fields.']),
      provenance: { kind: 'observed', explanation: 'Direct comparison of analyzer identity, version and configuration digest.' },
      alternatives: ['Treat inference-only changes as tooling drift.', 'Review changed hypotheses before planning any component update.'],
      guidance: 'Review inference changes independently from code changes; republish planning only if the new evidence changes a product or work decision.',
    });

    const partial = fromMap.source?.snapshotStatus !== 'complete' || toMap.source?.snapshotStatus !== 'complete'
      || fromMap.content?.truncated || toMap.content?.truncated;
    if (partial) emit({
      kind: 'partial-analysis', severity: 'high', subject: { kind: 'snapshot-pair', id: `${fromMap.snapshotId}:${toMap.snapshotId}`, label: 'Incomplete reconciliation evidence' },
      summary: 'One or both snapshots are partial or budget-truncated.',
      detail: 'Absence cannot be interpreted as removal while analysis coverage is incomplete.',
      confidence: confidence(1, ['Snapshot status and content truncation are explicit.']),
      provenance: { kind: 'observed' }, alternatives: ['Increase analysis limits and refresh.', 'Review only positively observed additions and changes.'],
      guidance: 'Refresh with sufficient coverage before accepting removal or missing-evidence conclusions.',
    });

    const evidenceReferences = [];
    for (const component of portfolio.components) for (const item of component.contract.evidence || []) evidenceReferences.push({
      reference: item.reference, ownerKind: 'component', ownerId: component.slug,
    });
    for (const front of portfolio.fronts) {
      for (const item of front.evidence || []) evidenceReferences.push({ reference: item.reference, ownerKind: 'front', ownerId: front.slug });
      if (front.analysisSnapshot) evidenceReferences.push({ reference: front.analysisSnapshot, ownerKind: 'front', ownerId: front.slug, snapshot: true });
    }
    for (const claim of productClaims(portfolio.product)) for (const reference of claim.sourceIds) evidenceReferences.push({
      reference, ownerKind: 'product-claim', ownerId: `${claim.kind}:${claim.id}`,
    });
    for (const item of evidenceReferences.slice(0, limits.maxChangedItems * 4)) {
      if (!item.reference || (!oldCatalog.all.has(item.reference) && item.reference !== fromMap.snapshotId)) continue;
      const missing = !newCatalog.all.has(item.reference) && item.reference !== toMap.snapshotId;
      const changed = changedEvidenceIds.has(item.reference);
      if (!missing && !changed && !(item.snapshot && item.reference !== toMap.snapshotId)) continue;
      emit({
        kind: item.snapshot ? 'stale-analysis-snapshot' : missing ? 'stale-evidence' : 'changed-evidence',
        severity: item.ownerKind === 'front' && portfolio.fronts.find((front) => front.slug === item.ownerId)?.state === 'active' ? 'high' : 'medium',
        subject: { kind: 'accepted-reference', id: `${item.ownerKind}:${item.ownerId}:${item.reference}`, label: `${item.ownerKind} ${item.ownerId}` },
        summary: item.snapshot ? `Accepted ${item.ownerKind} '${item.ownerId}' was designed against a superseded analysis snapshot.`
          : missing ? `Accepted ${item.ownerKind} '${item.ownerId}' cites evidence no longer present.`
            : `Accepted ${item.ownerKind} '${item.ownerId}' depends on changed analysis evidence.`,
        detail: `Reference ${item.reference} was resolved in the earlier map and is ${missing ? 'missing from' : 'changed in'} the new map. This is a staleness overlay, not a contract edit.`,
        confidence: confidence(partial && missing ? 0.45 : 0.92, partial && missing ? ['The newer snapshot is partial, so absence may be a coverage gap.'] : ['The exact accepted reference resolved against the earlier immutable map.']),
        provenance: { kind: 'observed' }, evidence: { ids: [item.reference] },
        alternatives: partial && missing ? ['The evidence may be outside current analysis coverage.', 'The accepted reference may need replacement through publication.'] : ['The implementation may have moved while preserving the decision.', 'The accepted contract may need a reviewed evidence update.'],
      });
    }

    for (const move of (comparison.content?.moved || []).slice(0, limits.maxChangedItems)) {
      const beforeOwners = territoryOwners(move.from, portfolio.components);
      const afterOwners = territoryOwners(move.to, portfolio.components);
      if (canonical(beforeOwners) !== canonical(afterOwners)) emit({
        kind: 'boundary-crossing', severity: beforeOwners.length && afterOwners.length ? 'high' : 'medium',
        subject: { kind: 'file-move', id: `${move.from}->${move.to}`, label: `${move.from} → ${move.to}` },
        summary: `A moved file crosses accepted component territory (${beforeOwners.join(', ') || 'unowned'} → ${afterOwners.join(', ') || 'unowned'}).`,
        detail: 'The move is content-identical by digest, but its accepted territory ownership changed.',
        confidence: confidence(0.97, ['Move identity is based on equal content digest.', 'Ownership is matched against accepted territory patterns.']),
        provenance: { kind: 'observed' }, evidence: { paths: [move.from, move.to] },
        alternatives: ['Move the file back into its accepted owner territory.', 'Publish a reviewed territory/boundary change.', 'Declare an explicit shared interface instead of shared ownership.'],
      });
    }

    for (const path of unique([...(comparison.content?.added || []), ...(comparison.content?.changed || []), ...(comparison.content?.moved || []).map((item) => item.to)], limits.maxChangedItems)) {
      const owners = territoryOwners(path, portfolio.components);
      if (!owners.length && portfolio.components.length) emit({
        kind: 'orphan-responsibility', severity: 'medium', subject: { kind: 'source-path', id: path, label: path },
        summary: `Changed source path '${path}' is outside every accepted component territory.`,
        detail: 'Unowned code may indicate an incomplete territory model or an intentionally shared/root concern.',
        confidence: confidence(0.82, ['No accepted territory pattern matched this observed path.']), provenance: { kind: 'inferred' }, evidence: { paths: [path] },
        alternatives: ['Assign the path through reviewed component publication.', 'Document it as intentionally unowned infrastructure.', 'Refine broad territory patterns if this is a matching limitation.'],
      });
      if (owners.length > 1) emit({
        kind: 'overlapping-responsibility', severity: 'high', subject: { kind: 'source-path', id: path, label: path },
        summary: `Changed source path '${path}' matches multiple accepted component territories: ${owners.join(', ')}.`,
        detail: 'Multiple accepted owners make agent allocation and change responsibility ambiguous.',
        confidence: confidence(0.9, ['Multiple accepted territory patterns matched the exact path.']), provenance: { kind: 'inferred' }, evidence: { paths: [path] },
        alternatives: ['Narrow one or more territories.', 'Create an explicit shared component with a clear interface.', 'Keep one owner and declare consumers as dependencies.'],
      });
    }

    const currentPaths = (toMap.content?.files || []).map((file) => file.path);
    for (const component of portfolio.components) for (const rawPattern of (component.contract.territory || []).slice(0, 200)) {
      const pattern = territoryPattern(rawPattern);
      const previouslyMatched = (fromMap.content?.files || []).some((file) => territoryMatches(file.path, pattern));
      if (previouslyMatched && !currentPaths.some((path) => territoryMatches(path, pattern))) emit({
        kind: 'stale-territory', severity: 'medium', subject: { kind: 'component-territory', id: `${component.slug}:${pattern}`, label: `${component.slug} · ${pattern}` },
        summary: `Accepted territory '${pattern}' for '${component.slug}' no longer matches observed files.`,
        detail: 'The territory may have moved, been removed, or fallen outside analysis coverage.',
        confidence: confidence(partial ? 0.45 : 0.88, partial ? ['The current snapshot is partial.'] : ['The pattern matched the prior snapshot and no path in the current snapshot.']),
        provenance: { kind: 'inferred' }, evidence: { paths: [pattern] },
        alternatives: ['Refresh with complete coverage.', 'Publish a reviewed territory replacement.', 'Retire the responsibility if the capability was removed.'],
      });
    }

    for (const action of ['added', 'removed']) for (const id of (comparison.observed?.entities?.[action] || []).slice(0, limits.maxChangedItems)) {
      const entity = (action === 'added' ? newCatalog : oldCatalog).entities.get(id);
      const architectureKind = entityArchitectureKind(entity);
      if (!architectureKind) continue;
      const path = entity.location?.path;
      emit({
        kind: `${action === 'added' ? 'new' : 'removed'}-${architectureKind}`, severity: architectureKind === 'deployable' ? 'high' : 'medium',
        subject: { kind: architectureKind, id: `${entity.kind}:${path || entity.name}`, label: entity.name },
        summary: `${action === 'added' ? 'New' : 'Removed'} observed ${architectureKind}: ${entity.name}.`,
        detail: `${entity.kind}${path ? ` at ${path}` : ''} changed the observed system surface.`,
        confidence: confidence(partial && action === 'removed' ? 0.45 : 0.9, partial && action === 'removed' ? ['Removal may be caused by partial coverage.'] : ['The normalized graph changed across immutable snapshots.']),
        provenance: { kind: 'observed' }, evidence: { ids: [id, ...(entity.evidenceIds || [])], paths: path ? [path] : [] },
        alternatives: action === 'added' ? ['Attach it to an existing accepted component.', 'Design a new component/interface if responsibility is distinct.'] : ['Confirm intentional removal.', 'Replace stale accepted evidence and dependencies through publication.'],
      });
    }

    const oldGroupsByIdentity = new Map((fromMap.groups || []).map((group) => [groupIdentity(group), group]));
    const newGroupsByIdentity = new Map((toMap.groups || []).map((group) => [groupIdentity(group), group]));
    for (const action of ['added', 'removed']) for (const identity of (comparison.inference?.[action] || []).slice(0, limits.maxChangedItems)) {
      const group = (action === 'added' ? newGroupsByIdentity : oldGroupsByIdentity).get(identity);
      if (!group || !['deployable', 'interface', 'data-store', 'dependency'].includes(group.lens)) continue;
      emit({
        kind: `${action === 'added' ? 'new' : 'removed'}-${group.lens}-hypothesis`, severity: 'low',
        subject: { kind: 'derived-group', id: identity, label: group.name },
        summary: `${action === 'added' ? 'New' : 'Removed'} ${group.lens} hypothesis: ${group.name}.`,
        detail: group.summary,
        confidence: confidence(group.uncertainty?.level === 'low' ? 0.72 : group.uncertainty?.level === 'medium' ? 0.58 : 0.38, group.uncertainty?.reasons || []),
        provenance: { kind: 'inferred' }, evidence: { ids: [group.id, ...(group.evidenceIds || [])] }, alternatives: group.alternatives || [],
      });
    }

    for (const action of ['added', 'removed']) for (const id of (comparison.observed?.relations?.[action] || []).slice(0, limits.maxChangedItems)) {
      const catalog = action === 'added' ? newCatalog : oldCatalog;
      const relation = catalog.relations.get(id);
      if (!relationIsDependency(relation)) continue;
      const source = catalog.entities.get(relation.source);
      const target = catalog.entities.get(relation.target);
      emit({
        kind: `${action === 'added' ? 'new' : 'removed'}-dependency`, severity: 'medium',
        subject: { kind: 'graph-relation', id: `${relation.kind}:${source?.location?.path || source?.name || relation.source}->${target?.location?.path || target?.name || relation.target}`, label: `${source?.name || relation.source} → ${target?.name || relation.target}` },
        summary: `${action === 'added' ? 'New' : 'Removed'} observed ${relation.kind} dependency between ${source?.name || relation.source} and ${target?.name || relation.target}.`,
        detail: 'Observed dependency changes can invalidate component interfaces, front readiness or coordination assumptions.',
        confidence: confidence(relation.confidence ?? 0.85, ['Normalized graph relation comparison.']), provenance: { kind: 'observed' },
        evidence: { ids: [id, ...(relation.evidenceIds || [])], paths: [source?.location?.path, target?.location?.path].filter(Boolean) },
        alternatives: ['Keep the dependency and publish an explicit interface/edge.', 'Remove the accidental coupling.', 'Route a decision or migration front before dependent work starts.'],
      });
    }

    for (const run of (runs || []).slice(0, limits.maxChangedItems)) {
      const manifest = run.manifest || {};
      const runSnapshot = manifest.source?.analysisSnapshot;
      const active = !['completed', 'failed'].includes(run.state);
      if (active && (runSnapshot === fromMap.snapshotId || (comparison.content?.manifestChanged && manifest.source?.repositoryRevision && manifest.source.repositoryRevision !== toMap.source?.git?.head))) emit({
        kind: 'stale-run-context', severity: run.state === 'running' ? 'critical' : 'high',
        subject: { kind: 'run', id: run.id, label: `${manifest.front?.slug || 'run'} · ${run.id}` },
        summary: `${run.state === 'running' ? 'Active' : 'Queued/paused'} run '${manifest.front?.slug || run.id}' was prepared from superseded repository evidence.`,
        detail: 'The immutable run manifest remains auditable, but its planning context no longer matches the latest snapshot.',
        confidence: confidence(0.96, ['Run manifests pin repository and analysis revisions.']), provenance: { kind: 'declared' },
        evidence: { ids: [runSnapshot, manifest.source?.digest].filter(Boolean), paths: [] },
        alternatives: ['Pause and create a reviewed handoff.', 'Complete only after proving the changed evidence is irrelevant.', 'Reconcile and prepare a new run preflight.'],
      });
      for (const discovery of (run.discoveries || []).slice(0, 100)) {
        if (!['blocker', 'scope-change', 'decision', 'discovery'].includes(discovery.kind)) continue;
        emit({
          kind: 'run-discovery-impact', severity: ['blocker', 'scope-change'].includes(discovery.kind) ? 'high' : 'medium',
          subject: { kind: 'run-discovery', id: `${run.id}:${discovery.id}`, label: `${discovery.kind} from ${manifest.front?.slug || run.id}` },
          summary: `Run ${discovery.kind} requires planning review: ${discovery.summary}`,
          detail: discovery.evidence || 'The run recorded no additional evidence text.',
          confidence: confidence(0.65, ['This is a recorded run claim and must be reviewed against repository evidence.']), provenance: { kind: 'declared', explanation: 'Agent/user run discovery; it is not treated as observed repository truth.' },
          evidence: { ids: [discovery.id], paths: [] }, alternatives: ['Dismiss with rationale if current evidence disproves it.', 'Accept for planning and create a reviewed draft/publication.'],
        });
      }
      const acceptedAt = Date.parse(run.outcome?.acceptedAt || '');
      const fromAt = Date.parse(fromMap.derivedAt || fromMap.source?.freshness?.checkedAt || '');
      const toAt = Date.parse(toMap.derivedAt || toMap.source?.freshness?.checkedAt || '');
      if (run.state === 'completed' && run.outcome?.accepted) {
        const acceptedCheck = (kind, label, index) => (run.checks || []).some((item) => item.kind === kind && item.index === index
          && item.label === label && item.status === 'passed' && item.source !== 'agent-claim');
        const missingCriteria = (manifest.front?.acceptanceCriteria || []).map((label, index) => ({ label, index }))
          .filter((item) => !acceptedCheck('criterion', item.label, item.index));
        const missingVerification = (manifest.front?.verification || []).map((label, index) => ({ label, index }))
          .filter((item) => !acceptedCheck('verification', item.label, item.index));
        if (missingCriteria.length || missingVerification.length) emit({
          kind: 'completed-run-evidence-gap', severity: 'high', subject: { kind: 'run', id: run.id, label: manifest.front?.slug || run.id },
          summary: `Completed run '${manifest.front?.slug || run.id}' no longer exposes all exact acceptance/verification evidence from its immutable contract.`,
          detail: `${missingCriteria.length} acceptance criterion record(s) and ${missingVerification.length} verification record(s) are unavailable or non-authoritative. The accepted front is not changed by this finding.`,
          confidence: confidence(0.98, ['Exact labels and indexes are compared with non-agent passed checks retained by the run.']), provenance: { kind: 'declared' },
          evidence: { ids: [run.id, ...missingCriteria.map((item) => `criterion:${item.index}`), ...missingVerification.map((item) => `verification:${item.index}`)] },
          alternatives: ['Restore or inspect the private run evidence record.', 'Open a validation front rather than silently trusting completion.', 'Dismiss only with independent retained proof.'],
        });
      }
      if (run.state === 'completed' && run.outcome?.accepted && Number.isFinite(acceptedAt)
        && (!Number.isFinite(fromAt) || acceptedAt >= fromAt) && (!Number.isFinite(toAt) || acceptedAt <= toAt) && comparison.content?.manifestChanged) emit({
        kind: 'completed-run-outcome', severity: 'info', subject: { kind: 'run', id: run.id, label: manifest.front?.slug || run.id },
        summary: `Accepted run '${manifest.front?.slug || run.id}' is represented in the new repository snapshot.`,
        detail: `Acceptance retained ${run.outcome.evidence?.tasks?.length || 0} task evidence records and ${run.outcome.evidence?.checks?.length || 0} criterion/verification records. ${[...changedPaths].filter((path) => (manifest.components || []).some((component) => (component.territory || []).some((pattern) => territoryMatches(path, pattern)))).length} changed path(s) match the immutable run component territory. Architecture impact still requires human review.`,
        confidence: confidence(0.88, ['The completed run has explicit acceptance metadata and the repository manifest changed afterward.']), provenance: { kind: 'declared' },
        evidence: {
          ids: [run.id, ...(run.outcome.evidence?.tasks || []), ...(run.outcome.evidence?.checks || [])],
          paths: [...changedPaths].filter((path) => (manifest.components || []).some((component) => (component.territory || []).some((pattern) => territoryMatches(path, pattern)))),
        },
        alternatives: ['Accept the architecture impact for planning.', 'Keep accepted completion while deferring architecture changes.', 'Open a follow-up front if observed evidence violates the outcome.'],
      });
    }
  }

  let findings = [...records.values()].map((finding) => enrichAffected(finding, context));
  const previous = new Map((previousFindings || []).map((finding) => [finding.id, finding]));
  findings = findings.map((finding) => {
    const prior = previous.get(finding.id);
    if (!prior) return finding;
    return {
      ...finding,
      firstSeen: prior.firstSeen || finding.firstSeen,
      occurrences: Number(prior.occurrences || 1) + 1,
      disposition: prior.disposition || 'open',
      dispositionRecord: prior.dispositionRecord || null,
    };
  });
  findings.sort((left, right) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(left.severity) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(right.severity) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));

  const totalCandidateChanges = [
    ...(comparison.content?.added || []), ...(comparison.content?.removed || []), ...(comparison.content?.changed || []), ...(comparison.content?.moved || []),
    ...Object.values(comparison.observed || {}).flatMap((bucket) => [...(bucket.added || []), ...(bucket.removed || []), ...(bucket.changed || [])]),
    ...(comparison.inference?.added || []), ...(comparison.inference?.removed || []), ...(comparison.inference?.changed || []),
  ].length;
  if (totalCandidateChanges > limits.maxChangedItems || records.size >= limits.maxFindingsPerCycle) diagnostics.push({
    code: 'RECONCILIATION_BUDGET_REACHED', severity: 'warning',
    message: `The bounded reconciliation inspected at most ${limits.maxChangedItems} entries per change class and emitted at most ${limits.maxFindingsPerCycle} findings.`,
    details: { totalCandidateChanges, emittedFindings: findings.length, limits },
  });
  if (comparison.noChange) diagnostics.push({ code: 'RECONCILIATION_NO_CHANGE', severity: 'info', message: 'The compared content, graph, analyzer and inference are unchanged.', details: null });

  const staleness = stalenessFrom(findings, limits);
  return deepFreeze({
    schemaVersion: RECONCILIATION_SCHEMA_VERSION,
    id: randomUUID(),
    repositoryId: repository.id,
    createdAt: timestamp(now),
    cause: line(cause, 80) || 'manual',
    sourceId: sourceId ? line(sourceId, 256) : null,
    from: { mapId: fromMap.id, snapshotId: fromMap.snapshotId, analyzer: fromMap.source?.analyzer, manifestDigest: fromMap.source?.manifestDigest },
    to: { mapId: toMap.id, snapshotId: toMap.snapshotId, analyzer: toMap.source?.analyzer, manifestDigest: toMap.source?.manifestDigest },
    comparison: boundedComparison(comparison, limits.maxChangedItems),
    findings,
    staleness,
    diagnostics,
    summary: {
      noChange: Boolean(comparison.noChange),
      findings: findings.length,
      newFindings: findings.filter((finding) => !previous.has(finding.id)).length,
      bySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length])),
      stale: Object.fromEntries(Object.entries(staleness).map(([kind, records]) => [kind, records.length])),
      bounded: diagnostics.some((item) => item.code === 'RECONCILIATION_BUDGET_REACHED'),
    },
    authority: { kind: 'derived', accepted: false, statement: 'Reconciliation findings and staleness are review overlays. They never modify accepted product, component or front contracts.' },
  });
}

function initialState(repositoryId) {
  return { schemaVersion: RECONCILIATION_SCHEMA_VERSION, repositoryId, updatedAt: new Date(0).toISOString(), cycles: [], findings: [], decisions: [], triggers: [], jobs: [] };
}

function publicJob(job) { const { repository: _repository, ...value } = job; return clone(value); }

export class ReconciliationRuntime {
  constructor({ root, analyses, systemMaps, context = () => ({}), now = () => Date.now(), limits = {} } = {}) {
    if (!root) fail('RECONCILIATION_ROOT_REQUIRED', 'reconciliation private storage root is required');
    if (!analyses || !systemMaps) fail('RECONCILIATION_RUNTIME_REQUIRED', 'analysis and system-map runtimes are required');
    this.root = privateDirectory(root);
    this.analyses = analyses;
    this.systemMaps = systemMaps;
    this.context = context;
    this.now = now;
    this.limits = normalizedLimits(limits);
    this.timers = new Map();
    this.closed = false;
  }

  #key(repositoryId) { return sha256(repositoryId).slice(0, 24); }
  #path(repositoryId) { return join(this.root, `${this.#key(repositoryId)}.json`); }
  #load(repositoryId) {
    const state = readJson(this.#path(repositoryId), initialState(repositoryId));
    if (state.repositoryId !== repositoryId || state.schemaVersion !== RECONCILIATION_SCHEMA_VERSION) fail('RECONCILIATION_STATE_INVALID', 'private reconciliation state does not match this repository');
    return this.#prune(state);
  }
  #save(state) { state.updatedAt = timestamp(this.now()); atomicJson(this.#path(state.repositoryId), state); return state; }
  #prune(state) {
    const cutoff = this.now() - this.limits.retentionMs;
    state.cycles = (state.cycles || []).filter((item) => Date.parse(item.createdAt) >= cutoff).slice(-this.limits.maxCycles);
    state.jobs = (state.jobs || []).filter((item) => !['complete', 'failed', 'cancelled', 'stale'].includes(item.state) || Date.parse(item.updatedAt) >= cutoff).slice(-this.limits.maxJobs);
    state.triggers = (state.triggers || []).filter((item) => item.state === 'pending' || Date.parse(item.updatedAt) >= cutoff).slice(-this.limits.maxTriggers);
    state.findings ||= []; state.decisions ||= [];
    return state;
  }

  #context(repository) {
    try { return this.context(repository) || {}; }
    catch (error) { return { portfolio: {}, runs: [], diagnostic: line(error?.message || error, 1_000) }; }
  }

  compare(repository, { fromJobId, toJobId, cause = 'manual', sourceId = null } = {}) {
    if (!fromJobId || !toJobId || fromJobId === toJobId) fail('RECONCILIATION_SNAPSHOTS_REQUIRED', 'choose two different completed analysis jobs');
    const fromSnapshot = this.analyses.snapshot(repository.id, String(fromJobId));
    const toSnapshot = this.analyses.snapshot(repository.id, String(toJobId));
    const fromMap = this.systemMaps.build(fromSnapshot);
    const toMap = this.systemMaps.build(toSnapshot);
    const comparison = this.systemMaps.compare(fromSnapshot, toSnapshot);
    const state = this.#load(repository.id);
    const external = this.#context(repository);
    const cycle = clone(reconcileArchitecture({
      repository, fromMap, toMap, comparison, portfolio: { ...(external.portfolio || {}), product: external.product || external.portfolio?.product },
      runs: external.runs || [], previousFindings: state.findings, cause, sourceId, now: this.now(), limits: this.limits,
    }));
    if (external.diagnostic) cycle.diagnostics.push({ code: 'RECONCILIATION_CONTEXT_PARTIAL', severity: 'warning', message: external.diagnostic, details: null });

    const existing = new Map(state.findings.map((finding) => [finding.id, finding]));
    for (const finding of cycle.findings) {
      const prior = existing.get(finding.id);
      const decision = [...state.decisions].reverse().find((item) => item.findingId === finding.id);
      existing.set(finding.id, {
        ...finding,
        firstSeen: prior?.firstSeen || finding.firstSeen,
        occurrences: prior ? Number(prior.occurrences || 1) + 1 : 1,
        disposition: decision?.state || prior?.disposition || 'open',
        dispositionRecord: decision || prior?.dispositionRecord || null,
        resolvedAt: null,
      });
    }
    // A later diff that does not mention an older accepted reference is not
    // proof that the planning risk disappeared: the reference may simply be
    // absent from both endpoints. Keep findings active until a human decision
    // or a future explicit resolution rule can prove the accepted dependency
    // was repaired.
    state.findings = [...existing.values()].sort((left, right) => right.lastSeen.localeCompare(left.lastSeen)).slice(0, this.limits.maxFindingsPerCycle * 4);
    cycle.findings = cycle.findings.map((finding) => clone(existing.get(finding.id)));
    cycle.summary.newFindings = cycle.findings.filter((finding) => !state.cycles.some((item) => item.findingIds?.includes(finding.id))).length;
    const storedCycle = { ...cycle, findings: undefined, findingIds: cycle.findings.map((finding) => finding.id) };
    state.cycles.push(storedCycle);
    state.cycles = state.cycles.slice(-this.limits.maxCycles);
    for (const trigger of state.triggers) if (trigger.state === 'pending'
      && (sourceId ? trigger.sourceId === sourceId : trigger.cause === cause)) {
      trigger.state = 'addressed'; trigger.cycleId = cycle.id; trigger.updatedAt = cycle.createdAt;
    }
    this.#save(state);
    return deepFreeze(cycle);
  }

  summary(repository) {
    const state = this.#load(repository.id);
    const active = state.findings.filter((item) => item.active);
    const lastCycle = state.cycles.at(-1) || null;
    return deepFreeze({
      schemaVersion: RECONCILIATION_SCHEMA_VERSION,
      repositoryId: repository.id,
      lastCycle: lastCycle ? { id: lastCycle.id, createdAt: lastCycle.createdAt, from: lastCycle.from, to: lastCycle.to, cause: lastCycle.cause, summary: lastCycle.summary, diagnostics: lastCycle.diagnostics } : null,
      findings: {
        active: active.length,
        open: active.filter((item) => item.disposition === 'open').length,
        bySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map((severity) => [severity, active.filter((item) => item.severity === severity).length])),
        byDisposition: Object.fromEntries(RECONCILIATION_DECISIONS.map((decision) => [decision, active.filter((item) => item.disposition === decision).length])),
      },
      pendingTriggers: state.triggers.filter((item) => item.state === 'pending').length,
      activeJobs: state.jobs.filter((item) => !['complete', 'failed', 'cancelled', 'stale'].includes(item.state)).length,
      authority: { kind: 'derived', accepted: false },
    });
  }

  listCycles(repository) {
    return deepFreeze(this.#load(repository.id).cycles.map((cycle) => ({
      id: cycle.id, createdAt: cycle.createdAt, cause: cycle.cause, sourceId: cycle.sourceId, from: cycle.from, to: cycle.to, summary: cycle.summary, diagnostics: cycle.diagnostics,
    })).reverse());
  }

  cycle(repository, id) {
    const state = this.#load(repository.id);
    const cycle = state.cycles.find((item) => item.id === id);
    if (!cycle) fail('RECONCILIATION_CYCLE_NOT_FOUND', 'reconciliation cycle not found');
    const findings = cycle.findingIds.map((findingId) => state.findings.find((item) => item.id === findingId)).filter(Boolean);
    return deepFreeze({ ...clone(cycle), findings });
  }

  findings(repository, { active = null, disposition = null, severity = null } = {}) {
    let records = this.#load(repository.id).findings;
    if (active !== null) records = records.filter((item) => item.active === Boolean(active));
    if (disposition) records = records.filter((item) => item.disposition === disposition);
    if (severity) records = records.filter((item) => item.severity === severity);
    return deepFreeze(clone(records));
  }

  decide(repository, findingId, value = {}, { actor = null } = {}) {
    const state = this.#load(repository.id);
    const finding = state.findings.find((item) => item.id === findingId);
    if (!finding) fail('RECONCILIATION_FINDING_NOT_FOUND', 'reconciliation finding not found');
    const decisionState = line(value.state, 64);
    if (!DECISIONS.has(decisionState)) fail('RECONCILIATION_DECISION_INVALID', `decision state must be one of: ${RECONCILIATION_DECISIONS.join(', ')}`);
    const rationale = clean(value.rationale, 4_000);
    if (decisionState !== 'open' && !rationale) fail('RECONCILIATION_RATIONALE_REQUIRED', 'dismissed, deferred and accepted-for-planning findings require a rationale');
    let reconsiderAfter = null;
    if (value.reconsiderAfter) {
      const parsed = Date.parse(value.reconsiderAfter);
      if (!Number.isFinite(parsed)) fail('RECONCILIATION_DECISION_INVALID', 'reconsiderAfter must be a valid date');
      reconsiderAfter = timestamp(parsed);
    }
    const decision = {
      id: randomUUID(), findingId, state: decisionState, rationale,
      reconsiderAfter, createdAt: timestamp(this.now()),
      actor: actor ? { id: line(actor.id, 256), name: line(actor.name || actor.label || 'Handraise client', 256), authority: actor.implicit ? 'implicit-local' : 'paired-client' } : null,
      contractMutation: false,
    };
    state.decisions.push(decision);
    finding.disposition = decisionState; finding.dispositionRecord = decision;
    this.#save(state);
    return deepFreeze({ finding: clone(finding), decision: clone(decision), authority: { acceptedForPlanningOnly: decisionState === 'accepted-for-planning', contractMutation: false } });
  }

  trigger(repository, { cause, sourceId, message = '' } = {}) {
    const normalizedCause = line(cause, 80);
    const normalizedSource = line(sourceId, 256);
    if (!normalizedCause || !normalizedSource) fail('RECONCILIATION_TRIGGER_INVALID', 'trigger cause and sourceId are required');
    const state = this.#load(repository.id);
    const key = sha256(`${normalizedCause}:${normalizedSource}`).slice(0, 24);
    const existing = state.triggers.find((item) => item.key === key);
    if (existing) return deepFreeze(clone(existing));
    const at = timestamp(this.now());
    const trigger = {
      id: randomUUID(), key, repositoryId: repository.id, cause: normalizedCause, sourceId: normalizedSource,
      message: line(message || 'Repository evidence may have changed; review and explicitly refresh analysis.', 1_000),
      state: 'pending', createdAt: at, updatedAt: at, cycleId: null, mutatesRepository: false,
    };
    state.triggers.push(trigger); state.triggers = state.triggers.slice(-this.limits.maxTriggers); this.#save(state);
    return deepFreeze(clone(trigger));
  }

  triggers(repository) { return deepFreeze(clone(this.#load(repository.id).triggers).reverse()); }

  trackAnalysis(repository, analysisJob, { fromJobId = null, cause = 'manual-refresh', sourceId = null } = {}) {
    const state = this.#load(repository.id);
    const existing = state.jobs.find((item) => item.analysisJobId === analysisJob.id);
    if (existing) { this.#schedule(repository, existing.id); return deepFreeze(publicJob(existing)); }
    const at = timestamp(this.now());
    const job = {
      id: randomUUID(), repositoryId: repository.id, analysisJobId: analysisJob.id, fromJobId: fromJobId ? String(fromJobId) : null,
      toJobId: analysisJob.id, cause: line(cause, 80), sourceId: sourceId ? line(sourceId, 256) : null,
      state: 'running', progress: Number(analysisJob.progress || 0), stage: analysisJob.stage || 'analysis',
      message: analysisJob.message || 'Creating a reviewed read-only analysis snapshot.', createdAt: at, updatedAt: at,
      cycleId: null, error: null, mutation: { repository: false, contracts: false },
    };
    state.jobs.push(job); state.jobs = state.jobs.slice(-this.limits.maxJobs); this.#save(state); this.#schedule(repository, job.id);
    return deepFreeze(publicJob(job));
  }

  #schedule(repository, reconciliationJobId) {
    if (this.closed || this.timers.has(reconciliationJobId)) return;
    const tick = () => {
      this.timers.delete(reconciliationJobId);
      if (this.closed) return;
      try {
        const job = this.observeJob(repository, reconciliationJobId);
        if (!['complete', 'failed', 'cancelled', 'stale'].includes(job.state)) {
          const timer = setTimeout(tick, 250); timer.unref?.(); this.timers.set(reconciliationJobId, timer);
        }
      } catch { /* persisted error is exposed on the next explicit status read */ }
    };
    const timer = setTimeout(tick, 25); timer.unref?.(); this.timers.set(reconciliationJobId, timer);
  }

  observeJob(repository, id) {
    let state = this.#load(repository.id);
    let job = state.jobs.find((item) => item.id === id);
    if (!job) fail('RECONCILIATION_JOB_NOT_FOUND', 'reconciliation refresh job not found');
    if (['complete', 'failed', 'cancelled', 'stale'].includes(job.state)) return deepFreeze(publicJob(job));
    let analysis;
    try { analysis = this.analyses.status(repository.id, job.analysisJobId); }
    catch (error) {
      job.state = 'failed'; job.error = { code: error?.code || 'ANALYSIS_STATUS_UNAVAILABLE', message: line(error?.message || error, 1_000) }; job.updatedAt = timestamp(this.now()); this.#save(state);
      return deepFreeze(publicJob(job));
    }
    job.progress = Number(analysis.progress || 0); job.stage = analysis.stage || analysis.state; job.message = analysis.message || job.message; job.updatedAt = timestamp(this.now());
    if (!TERMINAL_ANALYSIS_STATES.has(analysis.state)) { this.#save(state); return deepFreeze(publicJob(job)); }
    if (analysis.state !== 'complete') {
      job.state = analysis.state; job.error = analysis.error || (analysis.state === 'stale' ? { code: 'ANALYSIS_STALE', message: 'Repository content changed while the snapshot was being created; no reconciliation was accepted.' } : null);
      this.#save(state); return deepFreeze(publicJob(job));
    }
    if (!job.fromJobId) {
      job.state = 'complete'; job.progress = 1; job.stage = 'baseline'; job.message = 'Initial immutable baseline captured; a later refresh can produce a reconciliation diff.';
      this.#save(state); return deepFreeze(publicJob(job));
    }
    job.state = 'reconciling'; job.stage = 'reconciliation'; job.progress = Math.max(job.progress, 0.95); job.message = 'Tracing changed evidence through accepted planning and runs.'; this.#save(state);
    try {
      const cycle = this.compare(repository, { fromJobId: job.fromJobId, toJobId: job.toJobId, cause: job.cause, sourceId: job.sourceId });
      state = this.#load(repository.id); job = state.jobs.find((item) => item.id === id);
      job.state = 'complete'; job.progress = 1; job.stage = 'complete'; job.message = cycle.summary.noChange ? 'Refresh complete; no derived change.' : `Refresh complete with ${cycle.summary.findings} review finding(s).`; job.cycleId = cycle.id; job.updatedAt = timestamp(this.now()); this.#save(state);
    } catch (error) {
      state = this.#load(repository.id); job = state.jobs.find((item) => item.id === id);
      job.state = 'failed'; job.error = { code: error?.code || 'RECONCILIATION_FAILED', message: line(error?.message || error, 1_000) }; job.message = 'The snapshot remains private, but reconciliation failed safely.'; job.updatedAt = timestamp(this.now()); this.#save(state);
    }
    return deepFreeze(publicJob(job));
  }

  jobs(repository) {
    const state = this.#load(repository.id);
    for (const job of state.jobs.filter((item) => !['complete', 'failed', 'cancelled', 'stale'].includes(item.state))) {
      try { this.observeJob(repository, job.id); } catch { /* each explicit job read exposes its own failure */ }
    }
    return deepFreeze(this.#load(repository.id).jobs.map(publicJob).reverse());
  }

  cancel(repository, id) {
    const state = this.#load(repository.id); const job = state.jobs.find((item) => item.id === id);
    if (!job) fail('RECONCILIATION_JOB_NOT_FOUND', 'reconciliation refresh job not found');
    if (['complete', 'failed', 'cancelled', 'stale'].includes(job.state)) return deepFreeze(publicJob(job));
    try { this.analyses.cancel(repository.id, job.analysisJobId); } catch (error) {
      if (job.state !== 'reconciling') throw error;
    }
    job.state = 'cancelled'; job.stage = 'cancelled'; job.message = 'Refresh cancelled; accepted repository state was not changed.'; job.updatedAt = timestamp(this.now()); this.#save(state);
    const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id);
    return deepFreeze(publicJob(job));
  }

  discardRepository(repositoryId) {
    const target = this.#path(String(repositoryId));
    rmSync(target, { force: true });
    return { deleted: String(repositoryId) };
  }

  shutdown() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
