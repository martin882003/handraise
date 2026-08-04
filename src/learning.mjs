import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEARNING_SCHEMA_VERSION = 1;
export const LEARNING_PROPOSAL_STATES = Object.freeze(['open', 'dismissed', 'deferred', 'accepted-for-draft', 'stale', 'expired']);
export const LEARNING_FEEDBACK_SIGNALS = Object.freeze(['useful', 'not-useful']);
export const LEARNING_FEEDBACK_REASONS = Object.freeze([
  'correct-target', 'wrong-target', 'useful-evidence', 'weak-evidence', 'good-scope', 'too-broad', 'too-narrow', 'duplicate', 'other',
]);
export const LEARNING_EXPORT_PURPOSES = Object.freeze(['benchmark-contribution', 'ranking-evaluation']);

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_LIMITS = Object.freeze({ proposals: 500, feedback: 1_000, exports: 50 });
const STATES = new Set(LEARNING_PROPOSAL_STATES);
const SIGNALS = new Set(LEARNING_FEEDBACK_SIGNALS);
const REASONS = new Set(LEARNING_FEEDBACK_REASONS);
const EXPORT_PURPOSES = new Set(LEARNING_EXPORT_PURPOSES);
const TERMINAL_STATES = new Set(['completed', 'failed', 'awaiting-acceptance', 'paused']);

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clean(value, limit = 8_000) { return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit); }
function line(value, limit = 1_000) { return clean(value, limit).replace(/\s+/g, ' '); }
function unique(values, limit = 200) { return [...new Set(values.map((item) => line(item, 2_000)).filter(Boolean))].slice(0, limit); }
function timestamp(now) { return new Date(now).toISOString(); }

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value;
}

function privateDirectory(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; }
function atomicJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600); renameSync(temporary, path); chmodSync(path, 0o600);
}
function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return clone(fallback); } }

export class LearningError extends Error {
  constructor(code, message, details = null) { super(message); this.name = 'LearningError'; this.code = code; this.details = details; }
  toJSON() { return { error: this.message, code: this.code, details: this.details }; }
}
function fail(code, message, details = null) { throw new LearningError(code, message, details); }

function normalizedComponent(item) {
  const parsed = item?.contract?.contract ? item.contract : item;
  const contract = parsed?.contract || item?.contract || {};
  const slug = parsed?.slug || item?.slug || item?.id;
  return slug ? { slug, title: parsed?.title || item?.title || slug, revision: item?.revision || sha256(canonical(parsed)), contract } : null;
}
function normalizedFront(item) {
  const parsed = item?.contract?.slug ? item.contract : item;
  const slug = parsed?.slug || item?.slug || item?.id;
  return slug ? { slug, title: parsed?.title || item?.title || slug, revision: item?.revision || sha256(canonical(parsed)), contract: parsed } : null;
}
function normalizedPortfolio(value = {}) {
  const portfolio = value?.portfolio || value || {};
  return {
    components: (portfolio.components || []).map(normalizedComponent).filter(Boolean),
    fronts: (portfolio.fronts || []).map(normalizedFront).filter(Boolean),
    product: value?.product || portfolio.product || null,
  };
}

function exactTarget(portfolio, kind, id, fallbackRevision = null) {
  if (kind === 'component') {
    const record = portfolio.components.find((item) => item.slug === id);
    return { kind, id, revision: record?.revision || fallbackRevision, exists: Boolean(record) };
  }
  if (kind === 'front') {
    const record = portfolio.fronts.find((item) => item.slug === id);
    return { kind, id, revision: record?.revision || fallbackRevision, exists: Boolean(record) };
  }
  if (kind === 'product-assumption') {
    const revision = portfolio.product?.revision || (portfolio.product?.brief ? sha256(canonical(portfolio.product.brief)) : fallbackRevision);
    return { kind, id: 'product', revision: revision || null, exists: Boolean(portfolio.product?.brief || portfolio.product) };
  }
  const lead = portfolio.components[0];
  return { kind: 'new-front', id, revision: fallbackRevision || null, exists: false, leadComponent: lead?.slug || null };
}

function fieldChange(field, operation, proposedValue, beforeValue = null, reason = '') {
  const after = operation === 'append'
    ? Array.isArray(beforeValue) ? [...beforeValue, ...(Array.isArray(proposedValue) ? proposedValue : [proposedValue])]
      : `${String(beforeValue || '').trim()}${beforeValue ? '\n\n' : ''}${String(proposedValue || '').trim()}`
    : proposedValue;
  return {
    field, operation, proposedValue: clone(proposedValue), reason: line(reason, 2_000),
    beforeDigest: sha256(canonical(beforeValue)), afterDigest: sha256(canonical(after)),
    beforeSummary: Array.isArray(beforeValue) ? `${beforeValue.length} item(s)` : beforeValue ? `${String(beforeValue).length} character(s)` : 'empty',
  };
}

function targetField(portfolio, target, field) {
  if (target.kind === 'component') return portfolio.components.find((item) => item.slug === target.id)?.contract?.[field] ?? null;
  if (target.kind === 'front') return portfolio.fronts.find((item) => item.slug === target.id)?.contract?.[field] ?? null;
  if (target.kind === 'product-assumption') return portfolio.product?.brief?.assumptions || portfolio.product?.assumptions || [];
  return null;
}

function sourceAuthority(actor, fallback = 'declared') {
  return {
    provenance: fallback,
    actor: actor ? { id: line(actor.id, 256), name: line(actor.name || 'Handraise client', 256), authority: line(actor.authority || 'authenticated-client', 64) } : null,
    trustedAsFact: fallback === 'observed',
  };
}

function proposalInput({ repository, cause, target, changes, summary, detail, affected, evidence, confidence, decisionMemory = null, now, ttlMs }) {
  const identity = sha256(canonical({ repositoryId: repository.id, cause: { kind: cause.kind, id: cause.id }, target, changes: changes.map((item) => ({ field: item.field, operation: item.operation, afterDigest: item.afterDigest })) }));
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION, id: `learning:${identity.slice(0, 32)}`, identity,
    repositoryId: repository.id, createdAt: timestamp(now), lastSeen: timestamp(now), expiresAt: timestamp(now + ttlMs),
    occurrences: 1, state: 'open', revision: '', rank: 0,
    cause, target, summary: line(summary, 1_000), detail: clean(detail, 6_000), changes,
    affected: {
      goals: unique(affected?.goals || []), components: unique(affected?.components || []), fronts: unique(affected?.fronts || []), runs: unique(affected?.runs || []),
    },
    evidence: { references: unique(evidence?.references || [], 500), paths: unique(evidence?.paths || [], 100) },
    confidence: { score: Math.max(0, Math.min(1, Number(confidence?.score ?? 0.5))), reasons: unique(confidence?.reasons || [], 20) },
    decisionMemory, decision: null, routedDraft: null, contradictions: [], staleReasons: [],
    authority: { accepted: false, contractMutation: false, statement: 'This is a private review proposal. Only a validated draft and explicit transactional publication can change accepted contracts.' },
  };
}

function runInputs(repository, runs, portfolio, now, ttlMs) {
  const proposals = [];
  for (const run of runs || []) {
    const manifest = run.manifest || {};
    const frontSlug = manifest.front?.slug;
    const lead = manifest.front?.leadComponent || manifest.components?.[0]?.slug;
    const runState = run.state || 'unknown';
    const exact = { frontRevision: manifest.front?.revision || null, componentRevision: manifest.components?.find((item) => item.slug === lead)?.revision || null, goalIds: manifest.front?.goalIds || [] };
    const verifiedChecks = (run.checks || []).filter((item) => item.status === 'passed' && item.source !== 'agent-claim');
    for (const discovery of run.discoveries || []) {
      let targetKind = discovery.kind === 'decision' ? 'product-assumption' : discovery.kind === 'discovery' && lead ? 'component' : 'front';
      let targetId = targetKind === 'component' ? lead : targetKind === 'front' ? frontSlug : 'product';
      if (!targetId) continue;
      const target = exactTarget(portfolio, targetKind, targetId, targetKind === 'component' ? exact.componentRevision : exact.frontRevision);
      let changes;
      if (targetKind === 'product-assumption') {
        changes = [fieldChange('assumptions', 'append', [{ id: `assumption:run-${sha256(discovery.id).slice(0, 12)}`, text: discovery.summary, sourceIds: ['source:human'] }], targetField(portfolio, target, 'assumptions'), 'A user-recorded run decision may update product assumptions after review.')];
      } else if (targetKind === 'component') {
        changes = [fieldChange('uncertainties', 'append', [`Run discovery (${run.id}): ${discovery.summary}`], targetField(portfolio, target, 'uncertainties'), 'Execution revealed a declared responsibility question; it remains uncertainty until reviewed.')];
      } else if (discovery.kind === 'blocker') {
        changes = [
          fieldChange('risks', 'append', [`Run blocker (${run.id}): ${discovery.summary}`], targetField(portfolio, target, 'risks'), 'Preserve a repeated execution blocker as an explicit planning risk.'),
          fieldChange('readiness', 'append', [`Resolve or explicitly waive blocker from run ${run.id}: ${discovery.summary}`], targetField(portfolio, target, 'readiness'), 'Make the blocker visible before a later run starts.'),
        ];
      } else {
        changes = [fieldChange('scope', 'append', `Scope-change candidate from run ${run.id}: ${discovery.summary}`, targetField(portfolio, target, 'scope'), 'A user-recorded scope change requires explicit replanning.')];
      }
      proposals.push(proposalInput({
        repository, now, ttlMs, target, changes,
        cause: { kind: 'run-discovery', id: discovery.id, sourceState: runState, at: discovery.at || run.updatedAt, authority: sourceAuthority(discovery.actor, 'declared'), verified: false },
        summary: `${discovery.kind}: ${discovery.summary}`, detail: discovery.evidence || 'No additional evidence was recorded.',
        affected: { goals: exact.goalIds, components: unique([lead]), fronts: unique([frontSlug, ...(discovery.affectedFronts || [])]), runs: [run.id] },
        evidence: { references: unique([run.id, discovery.id, manifest.revision, manifest.source?.analysisSnapshot]) },
        confidence: { score: 0.55, reasons: ['The discovery was explicitly recorded by an authenticated user, but remains declared rather than observed repository truth.'] },
      }));
    }
    if (run.outcome?.accepted && lead && verifiedChecks.length) {
      const target = exactTarget(portfolio, 'component', lead, exact.componentRevision);
      const labels = unique(verifiedChecks.map((item) => item.label), 20).map((label) => `Verified in accepted run ${run.id}: ${label}`);
      proposals.push(proposalInput({
        repository, now, ttlMs, target,
        changes: [fieldChange('verification', 'append', labels, targetField(portfolio, target, 'verification'), 'Reuse independently recorded successful checks as reviewable component verification guidance.')],
        cause: { kind: 'verified-run-outcome', id: run.id, sourceState: runState, at: run.outcome.acceptedAt, authority: sourceAuthority(run.outcome.actor, 'observed'), verified: true },
        summary: `Accepted run '${frontSlug}' produced reusable verification evidence.`, detail: `${verifiedChecks.length} non-agent passing check(s) matched the accepted run contract.`,
        affected: { goals: exact.goalIds, components: [lead], fronts: [frontSlug], runs: [run.id] },
        evidence: { references: unique([run.id, run.outcome.frontRevision, ...verifiedChecks.map((item) => item.id)]) },
        confidence: { score: 0.92, reasons: ['The run outcome was explicitly accepted and the checks exclude agent-only claims.'] },
      }));
    }
    const blocked = (run.discoveries || []).some((item) => item.kind === 'blocker') || ['failed'].includes(runState) || run.process?.attention?.status === 'blocked';
    if (blocked && frontSlug && !(run.discoveries || []).some((item) => item.kind === 'blocker')) {
      const target = exactTarget(portfolio, 'front', frontSlug, exact.frontRevision);
      const reason = line(run.failure?.message || run.process?.attention?.reason || `Run ended in ${runState}.`, 1_000);
      proposals.push(proposalInput({
        repository, now, ttlMs, target,
        changes: [
          fieldChange('risks', 'append', [`Observed run failure/blocker (${run.id}): ${reason}`], targetField(portfolio, target, 'risks'), 'Preserve a failed/blocked execution outcome as a reviewed risk.'),
          fieldChange('readiness', 'append', [`Review the failure mode from run ${run.id} before retrying.`], targetField(portfolio, target, 'readiness'), 'Prevent an unchanged retry from hiding the prior failure.'),
        ],
        cause: { kind: 'run-state', id: run.id, sourceState: runState, at: run.updatedAt, authority: sourceAuthority(run.actor, 'observed'), verified: TERMINAL_STATES.has(runState) },
        summary: `Run '${frontSlug}' needs failure/blocker replanning.`, detail: reason,
        affected: { goals: exact.goalIds, components: unique([lead]), fronts: [frontSlug], runs: [run.id] }, evidence: { references: unique([run.id, manifest.revision]) },
        confidence: { score: 0.85, reasons: ['The durable run state is observed; its causal interpretation remains reviewable.'] },
      }));
    }
  }
  return proposals;
}

function findingInputs(repository, findings, portfolio, now, ttlMs) {
  const proposals = [];
  for (const finding of (findings || []).filter((item) => item.active !== false && item.disposition === 'accepted-for-planning')) {
    const componentSlug = finding.affected?.components?.[0];
    const frontSlug = finding.affected?.fronts?.[0];
    let target = componentSlug ? exactTarget(portfolio, 'component', componentSlug) : frontSlug ? exactTarget(portfolio, 'front', frontSlug) : null;
    if (!target) target = exactTarget(portfolio, 'new-front', `review-${String(finding.kind || 'architecture-change').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, finding.lastSeen || null);
    const before = (field) => targetField(portfolio, target, field);
    let changes;
    if (target.kind === 'component') {
      const reviewField = /dependency/.test(finding.kind) ? 'dependencies' : /boundary|territory|orphan|overlap/.test(finding.kind) ? 'territory' : /evidence/.test(finding.kind) ? 'evidence' : 'responsibilities';
      changes = [
        fieldChange(reviewField, 'review', null, before(reviewField), `Review ${reviewField} against reconciliation finding '${finding.kind}'.`),
        fieldChange('uncertainties', 'append', [`Reconciliation ${finding.kind}: ${finding.summary}`], before('uncertainties'), 'Keep the drift explicit until a reviewed contract change resolves it.'),
      ];
    } else if (target.kind === 'front') {
      changes = [
        fieldChange('readiness', 'append', [`Resolve reconciliation finding ${finding.id}: ${finding.summary}`], before('readiness'), 'Changed evidence may invalidate readiness.'),
        fieldChange('risks', 'append', [`Architecture drift (${finding.kind}): ${finding.summary}`], before('risks'), 'Preserve drift as an explicit planning risk.'),
      ];
    } else {
      changes = [fieldChange('new-front', 'create', { title: `Review ${finding.kind}`, outcome: `A human resolves ${finding.summary}` }, null, 'A new or unowned system surface needs one explicit outcome and lead owner.')];
    }
    proposals.push(proposalInput({
      repository, now, ttlMs, target, changes,
      cause: {
        kind: 'reconciliation-finding', id: finding.id, sourceState: finding.disposition, at: finding.lastSeen,
        authority: sourceAuthority(finding.dispositionRecord?.actor, finding.provenance?.kind || 'inferred'), verified: finding.provenance?.kind === 'observed',
      },
      summary: finding.summary, detail: finding.detail,
      affected: { goals: finding.affected?.goals || [], components: finding.affected?.components || [], fronts: finding.affected?.fronts || [], runs: finding.affected?.runs || [] },
      evidence: finding.evidence || {}, confidence: finding.confidence,
      decisionMemory: finding.dispositionRecord ? { state: finding.disposition, rationale: finding.dispositionRecord.rationale, reconsiderAfter: finding.dispositionRecord.reconsiderAfter, decisionId: finding.dispositionRecord.id } : null,
    }));
  }
  return proposals;
}

function proposalRevision(proposal) {
  const value = clone(proposal); delete value.revision; return sha256(canonical(value));
}
function currentTargetRevision(portfolio, target) {
  if (target.kind === 'component') return portfolio.components.find((item) => item.slug === target.id)?.revision || null;
  if (target.kind === 'front') return portfolio.fronts.find((item) => item.slug === target.id)?.revision || null;
  if (target.kind === 'product-assumption') return portfolio.product?.revision || (portfolio.product?.brief ? sha256(canonical(portfolio.product.brief)) : null);
  return target.revision;
}

function initialState(repositoryId) { return { schemaVersion: LEARNING_SCHEMA_VERSION, repositoryId, updatedAt: new Date(0).toISOString(), proposals: [], feedback: [], exports: [] }; }

export class LearningProposalStore {
  constructor({ root, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, limits = {} } = {}) {
    if (!root) fail('LEARNING_ROOT_REQUIRED', 'learning storage root is required');
    this.root = privateDirectory(root); this.now = now; this.ttlMs = ttlMs;
    this.limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, value]) => Number.isInteger(value) && value > 0)) };
  }
  #path(repositoryId) { return join(this.root, `${sha256(repositoryId).slice(0, 24)}.json`); }
  #load(repositoryId) {
    const state = readJson(this.#path(repositoryId), initialState(repositoryId));
    if (state.schemaVersion !== LEARNING_SCHEMA_VERSION || state.repositoryId !== repositoryId) fail('LEARNING_STATE_INVALID', 'learning state does not match this repository');
    return state;
  }
  #save(state) {
    state.updatedAt = timestamp(this.now());
    state.proposals = state.proposals.slice(-this.limits.proposals); state.feedback = state.feedback.slice(-this.limits.feedback); state.exports = state.exports.slice(-this.limits.exports);
    atomicJson(this.#path(state.repositoryId), state); return state;
  }
  #proposal(state, id) { const proposal = state.proposals.find((item) => item.id === id); if (!proposal) fail('LEARNING_PROPOSAL_NOT_FOUND', 'learning proposal not found'); return proposal; }

  refresh(repository, context = {}) {
    const state = this.#load(repository.id); const portfolio = normalizedPortfolio(context.portfolio || context);
    const generated = [...runInputs(repository, context.runs || [], portfolio, this.now(), this.ttlMs), ...findingInputs(repository, context.findings || [], portfolio, this.now(), this.ttlMs)];
    const seen = new Set(); const existing = new Map(state.proposals.map((item) => [item.id, item]));
    for (const fresh of generated) {
      seen.add(fresh.id); const prior = existing.get(fresh.id);
      if (prior) {
        fresh.createdAt = prior.createdAt; fresh.occurrences = Number(prior.occurrences || 1) + 1;
        fresh.state = prior.state; fresh.decision = prior.decision; fresh.routedDraft = prior.routedDraft;
        if (prior.state === 'deferred' && prior.decision?.reconsiderAfter && Date.parse(prior.decision.reconsiderAfter) <= this.now()) fresh.state = 'open';
      }
      const currentRevision = currentTargetRevision(portfolio, fresh.target);
      if (fresh.target.exists && fresh.target.revision && currentRevision !== fresh.target.revision) {
        fresh.state = 'stale'; fresh.staleReasons.push('The accepted target revision changed after this proposal cause was captured.');
      }
      const related = state.feedback.filter((item) => item.causeKind === fresh.cause.kind && item.targetKind === fresh.target.kind);
      fresh.rank = Math.round((fresh.confidence.score * 100) + related.reduce((sum, item) => sum + (item.signal === 'useful' ? 5 : -8), 0));
      existing.set(fresh.id, fresh);
    }
    for (const proposal of existing.values()) {
      if (!seen.has(proposal.id) && proposal.state === 'open') { proposal.state = Date.parse(proposal.expiresAt) <= this.now() ? 'expired' : 'stale'; proposal.staleReasons = unique([...(proposal.staleReasons || []), 'The latest refresh no longer produced this unchanged cause/target proposal.']); }
    }
    const proposals = [...existing.values()];
    for (const proposal of proposals) proposal.contradictions = [];
    for (let left = 0; left < proposals.length; left += 1) for (let right = left + 1; right < proposals.length; right += 1) {
      const a = proposals[left]; const b = proposals[right];
      if (a.target.kind !== b.target.kind || a.target.id !== b.target.id) continue;
      const conflict = a.changes.some((change) => b.changes.some((other) => change.field === other.field && change.afterDigest !== other.afterDigest));
      if (conflict) { a.contradictions.push(b.id); b.contradictions.push(a.id); a.rank -= 10; b.rank -= 10; }
    }
    for (const proposal of proposals) proposal.revision = proposalRevision(proposal);
    state.proposals = proposals.sort((left, right) => left.createdAt.localeCompare(right.createdAt)); this.#save(state);
    return this.summary(repository);
  }

  list(repository, { state: selectedState = null } = {}) {
    let proposals = this.#load(repository.id).proposals;
    if (selectedState) { if (!STATES.has(selectedState)) fail('LEARNING_STATE_INVALID', 'unknown learning proposal state'); proposals = proposals.filter((item) => item.state === selectedState); }
    return deepFreeze(clone(proposals).sort((left, right) => right.rank - left.rank || right.lastSeen.localeCompare(left.lastSeen)));
  }
  get(repository, id) { return deepFreeze(clone(this.#proposal(this.#load(repository.id), id))); }
  summary(repository) {
    const state = this.#load(repository.id); const proposals = state.proposals;
    return deepFreeze({
      schemaVersion: LEARNING_SCHEMA_VERSION, repositoryId: repository.id, updatedAt: state.updatedAt,
      proposals: { total: proposals.length, open: proposals.filter((item) => item.state === 'open').length, stale: proposals.filter((item) => item.state === 'stale').length, contradictions: proposals.filter((item) => item.contradictions?.length).length, byState: Object.fromEntries(LEARNING_PROPOSAL_STATES.map((item) => [item, proposals.filter((proposal) => proposal.state === item).length])) },
      feedback: { total: state.feedback.length, useful: state.feedback.filter((item) => item.signal === 'useful').length, notUseful: state.feedback.filter((item) => item.signal === 'not-useful').length },
      authority: { localOnly: true, acceptedMutation: false, automaticExport: false },
    });
  }

  decide(repository, id, value = {}, { actor = null } = {}) {
    const state = this.#load(repository.id); const proposal = this.#proposal(state, id);
    const decisionState = line(value.state, 64);
    if (!['open', 'dismissed', 'deferred'].includes(decisionState)) fail('LEARNING_DECISION_INVALID', 'decision must be open, dismissed or deferred');
    const rationale = clean(value.rationale, 4_000); if (decisionState !== 'open' && !rationale) fail('LEARNING_RATIONALE_REQUIRED', 'dismissed and deferred proposals require rationale');
    let reconsiderAfter = null;
    if (value.reconsiderAfter) { const parsed = Date.parse(value.reconsiderAfter); if (!Number.isFinite(parsed)) fail('LEARNING_DECISION_INVALID', 'reconsiderAfter must be a valid date'); reconsiderAfter = timestamp(parsed); }
    proposal.state = decisionState; proposal.decision = { id: randomUUID(), state: decisionState, rationale, reconsiderAfter, at: timestamp(this.now()), actor: actor ? { id: line(actor.id, 256), name: line(actor.name, 256), authority: actor.implicit ? 'implicit-local' : 'paired-client' } : null };
    proposal.revision = proposalRevision(proposal); this.#save(state); return deepFreeze(clone(proposal));
  }

  route(repository, id, value = {}, { actor = null, route } = {}) {
    const state = this.#load(repository.id); const proposal = this.#proposal(state, id);
    if (value.expectedRevision !== proposal.revision) fail('LEARNING_PROPOSAL_CHANGED', 'proposal changed; review its current exact revision');
    if (['stale', 'expired'].includes(proposal.state)) fail('LEARNING_PROPOSAL_STALE', 'refresh or recreate this proposal against current accepted contracts');
    if (typeof route !== 'function') fail('LEARNING_DRAFT_BOUNDARY_REQUIRED', 'routing requires an existing validated product/component/front draft boundary');
    const routed = route(deepFreeze(clone(proposal)));
    if (!routed?.draftId || !routed?.draftRevision || !['product-direction', 'component-design', 'front-design'].includes(routed.kind) || routed.validated !== true || routed.publicationRequired !== true) {
      fail('LEARNING_DRAFT_INVALID', 'the existing draft boundary did not return a validated, publication-required draft');
    }
    proposal.state = 'accepted-for-draft'; proposal.routedDraft = { ...routed, at: timestamp(this.now()), actor: actor ? { id: line(actor.id, 256), name: line(actor.name, 256) } : null, contractMutation: false };
    proposal.revision = proposalRevision(proposal); this.#save(state);
    return deepFreeze({ proposal: clone(proposal), draft: clone(proposal.routedDraft), authority: { contractMutation: false, publicationRequired: true } });
  }

  feedback(repository, proposalId, value = {}, { actor = null } = {}) {
    const state = this.#load(repository.id); const proposal = this.#proposal(state, proposalId);
    const signal = line(value.signal, 64); const reasonCode = line(value.reasonCode || 'other', 64);
    if (!SIGNALS.has(signal) || !REASONS.has(reasonCode)) fail('LEARNING_FEEDBACK_INVALID', 'feedback signal or reason code is invalid');
    const record = {
      id: randomUUID(), proposalId, proposalRevision: proposal.revision, repositoryId: repository.id,
      causeKind: proposal.cause.kind, targetKind: proposal.target.kind, changeFields: proposal.changes.map((item) => item.field),
      signal, reasonCode, rationale: clean(value.rationale, 4_000), createdAt: timestamp(this.now()),
      actor: actor ? { id: line(actor.id, 256), name: line(actor.name, 256), authority: actor.implicit ? 'implicit-local' : 'paired-client' } : null,
      privacy: { localOnly: true, exported: false },
    };
    state.feedback.push(record); this.#save(state); return deepFreeze(clone(record));
  }
  feedbackList(repository) { return deepFreeze(clone(this.#load(repository.id).feedback).reverse()); }
  deleteFeedback(repository, id) { const state = this.#load(repository.id); const before = state.feedback.length; state.feedback = state.feedback.filter((item) => item.id !== id); if (state.feedback.length === before) fail('LEARNING_FEEDBACK_NOT_FOUND', 'feedback not found'); this.#save(state); return { deleted: id }; }
  deleteProposal(repository, id) { const state = this.#load(repository.id); const before = state.proposals.length; state.proposals = state.proposals.filter((item) => item.id !== id); state.feedback = state.feedback.filter((item) => item.proposalId !== id); if (state.proposals.length === before) fail('LEARNING_PROPOSAL_NOT_FOUND', 'learning proposal not found'); this.#save(state); return { deleted: id, feedbackDeleted: before !== state.proposals.length }; }

  previewExport(repository, value = {}) {
    const state = this.#load(repository.id); const purpose = line(value.purpose, 64);
    if (!EXPORT_PURPOSES.has(purpose)) fail('LEARNING_EXPORT_SCOPE_REQUIRED', `purpose must be one of: ${LEARNING_EXPORT_PURPOSES.join(', ')}`);
    const ids = unique(value.feedbackIds || [], this.limits.feedback); if (!ids.length) fail('LEARNING_EXPORT_SCOPE_REQUIRED', 'choose at least one local feedback record');
    const selected = ids.map((id) => state.feedback.find((item) => item.id === id)).filter(Boolean);
    if (selected.length !== ids.length) fail('LEARNING_FEEDBACK_NOT_FOUND', 'one or more selected feedback records do not exist');
    const payload = {
      schemaVersion: 1, purpose, generatedAt: timestamp(this.now()), benchmarkTarget: line(value.benchmarkTarget || 'planning-quality-v1', 128),
      contributions: selected.map((item) => ({
        id: `feedback:${sha256(item.id).slice(0, 20)}`, repositoryFingerprint: sha256(repository.id), proposalFingerprint: sha256(item.proposalId),
        proposalRevision: item.proposalRevision, causeKind: item.causeKind, targetKind: item.targetKind,
        changeFields: item.changeFields, signal: item.signal, reasonCode: item.reasonCode,
      })),
      privacy: { source: false, snippets: false, paths: false, credentials: false, actorIdentity: false, freeTextRationale: false },
    };
    const serialized = canonical(payload);
    if (/HANDRAISE_BENCHMARK_INJECTION_MARKER|(?:api[_-]?key|token|password|secret|authorization)["'=:\s]|-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:https?|file):\/\//i.test(serialized)) {
      fail('LEARNING_EXPORT_UNSAFE', 'sanitized export unexpectedly contains a forbidden source/credential marker');
    }
    const preview = { id: randomUUID(), repositoryId: repository.id, purpose, feedbackIds: selected.map((item) => item.id), payload, revision: sha256(canonical(payload)), createdAt: timestamp(this.now()), expiresAt: timestamp(this.now() + 15 * 60 * 1_000), confirmedAt: null, actor: null };
    state.exports.push(preview); this.#save(state); return deepFreeze(clone(preview));
  }
  confirmExport(repository, id, value = {}, { actor = null } = {}) {
    const state = this.#load(repository.id); const preview = state.exports.find((item) => item.id === id); if (!preview) fail('LEARNING_EXPORT_NOT_FOUND', 'export preview not found');
    if (Date.parse(preview.expiresAt) <= this.now()) fail('LEARNING_EXPORT_EXPIRED', 'export preview expired');
    if (value.expectedRevision !== preview.revision || value.confirmed !== true) fail('LEARNING_EXPORT_CONFIRMATION_REQUIRED', 'explicit confirmation of the exact scoped export is required');
    preview.confirmedAt = timestamp(this.now()); preview.actor = actor ? { id: line(actor.id, 256), name: line(actor.name, 256), authority: actor.implicit ? 'implicit-local' : 'paired-client' } : null;
    for (const feedback of state.feedback.filter((item) => preview.feedbackIds.includes(item.id))) feedback.privacy.exported = true;
    this.#save(state); return deepFreeze({ payload: clone(preview.payload), revision: preview.revision, confirmedAt: preview.confirmedAt, delivery: 'download-only', networkRequestMade: false });
  }

  discardRepository(repositoryId) { rmSync(this.#path(String(repositoryId)), { force: true }); return { deleted: String(repositoryId) }; }
}
