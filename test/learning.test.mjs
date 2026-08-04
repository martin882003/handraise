import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LearningError, LearningProposalStore } from '../src/learning.mjs';

function fixture() {
  const repository = { id: 'repo:learning', name: 'Learning fixture', adapter: 'handraise' };
  const portfolio = {
    product: { revision: 'product:r1', brief: { assumptions: [], goals: [{ id: 'goal:safe', title: 'Safe delivery' }] } },
    components: [{
      revision: 'component:r1', contract: {
        slug: 'runtime-control', title: 'Runtime Control',
        contract: { uncertainties: [], verification: ['Run runtime tests.'], dependencies: [], territory: ['src/runtime/**'], evidence: [], responsibilities: ['Own runtime control.'] },
      },
    }],
    fronts: [{
      revision: 'front:r1', contract: {
        slug: 'safe-delivery', title: 'Safe delivery', component: 'runtime-control', leadComponent: 'runtime-control',
        state: 'active', readiness: ['Repository is available.'], risks: ['No known risk.'], scope: 'Deliver the accepted change.',
      },
    }],
  };
  const baseManifest = {
    revision: 'manifest:r1', source: { analysisSnapshot: 'snapshot:r1' },
    front: { slug: 'safe-delivery', revision: 'front:r1', leadComponent: 'runtime-control', goalIds: ['goal:safe'] },
    components: [{ slug: 'runtime-control', revision: 'component:r1' }],
  };
  const runs = [{
    id: 'run:completed', state: 'completed', updatedAt: '2026-08-03T12:00:00.000Z', manifest: baseManifest,
    actor: { id: 'host', name: 'Host' },
    discoveries: [
      { id: 'discovery:1', kind: 'discovery', summary: 'Runtime ownership also includes reconnect policy.', evidence: 'Observed during implementation.', affectedFronts: [], at: '2026-08-03T11:00:00.000Z', actor: { id: 'host', name: 'Host', authority: 'implicit-local' } },
      { id: 'decision:1', kind: 'decision', summary: 'Offline recovery is a product assumption.', evidence: '', affectedFronts: [], at: '2026-08-03T11:05:00.000Z', actor: { id: 'host', name: 'Host', authority: 'implicit-local' } },
    ],
    checks: [
      { id: 'check:user', label: 'Browser run passes.', status: 'passed', source: 'user-observed' },
      { id: 'check:agent', label: 'Agent says everything passes.', status: 'passed', source: 'agent-claim' },
    ],
    outcome: { accepted: true, acceptedAt: '2026-08-03T12:00:00.000Z', actor: { id: 'host', name: 'Host' }, frontRevision: 'front:r1' },
  }, {
    id: 'run:failed', state: 'failed', updatedAt: '2026-08-03T12:10:00.000Z', manifest: baseManifest,
    failure: { message: 'The reconnect check timed out.' }, discoveries: [], checks: [], actor: { id: 'host', name: 'Host' },
  }];
  const findings = [{
    id: 'finding:dependency', kind: 'new-dependency', summary: 'Runtime now calls a reconnect broker.', detail: 'The normalized dependency graph added one edge.',
    active: true, disposition: 'accepted-for-planning', lastSeen: '2026-08-03T12:15:00.000Z',
    provenance: { kind: 'observed' }, confidence: { score: .9, reasons: ['Normalized relation changed.'] },
    affected: { goals: ['goal:safe'], components: ['runtime-control'], fronts: ['safe-delivery'], runs: ['run:completed'] },
    evidence: { references: ['relation:reconnect'], paths: ['src/runtime/reconnect.mjs'] },
    dispositionRecord: { id: 'decision:reconciliation', rationale: 'Review the new broker boundary.', reconsiderAfter: null, actor: { id: 'host', name: 'Host' } },
  }];
  return { repository, portfolio, runs, findings };
}

function storeFixture(now = Date.parse('2026-08-03T13:00:00.000Z')) {
  const root = mkdtempSync(join(tmpdir(), 'handraise-learning-'));
  return { root, store: new LearningProposalStore({ root, now: () => now }), setNow(value) { now = value; } };
}

test('verified outcomes, declared discoveries and accepted drift become bounded revision-linked proposals', (context) => {
  const state = storeFixture(); context.after(() => rmSync(state.root, { recursive: true, force: true }));
  const data = fixture();
  const summary = state.store.refresh(data.repository, data);
  assert.ok(summary.proposals.open >= 5);
  const proposals = state.store.list(data.repository);
  const declared = proposals.find((item) => item.cause.id === 'discovery:1');
  assert.equal(declared.cause.authority.provenance, 'declared');
  assert.equal(declared.cause.authority.trustedAsFact, false);
  assert.equal(declared.target.id, 'runtime-control');
  assert.equal(declared.target.revision, 'component:r1');
  const outcome = proposals.find((item) => item.cause.kind === 'verified-run-outcome');
  assert.equal(outcome.cause.verified, true);
  assert.ok(outcome.evidence.references.includes('check:user'));
  assert.ok(!outcome.evidence.references.includes('check:agent'));
  assert.ok(outcome.changes.some((item) => item.field === 'verification'));
  const drift = proposals.find((item) => item.cause.id === 'finding:dependency');
  assert.ok(drift.changes.some((item) => item.field === 'dependencies' && item.operation === 'review'));
  assert.equal(drift.decisionMemory.rationale, 'Review the new broker boundary.');
  assert.equal(proposals.every((item) => item.authority.contractMutation === false), true);
  const file = join(state.root, readdirSync(state.root).find((name) => name.endsWith('.json')));
  assert.equal(statSync(state.root).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('refresh deduplicates causes, preserves decisions and marks superseded target revisions stale', (context) => {
  const state = storeFixture(); context.after(() => rmSync(state.root, { recursive: true, force: true }));
  const data = fixture(); state.store.refresh(data.repository, data);
  const selected = state.store.list(data.repository).find((item) => item.cause.id === 'discovery:1');
  const stillOpen = state.store.list(data.repository).find((item) => item.cause.id === 'finding:dependency');
  state.store.decide(data.repository, selected.id, { state: 'dismissed', rationale: 'This responsibility is already covered elsewhere.' });
  state.store.refresh(data.repository, data);
  const repeated = state.store.get(data.repository, selected.id);
  assert.equal(repeated.state, 'dismissed');
  assert.equal(repeated.occurrences, 2);
  assert.equal(repeated.decision.rationale, 'This responsibility is already covered elsewhere.');
  const changed = structuredClone(data);
  changed.portfolio.components[0].revision = 'component:r2';
  state.store.refresh(data.repository, changed);
  assert.equal(state.store.get(data.repository, selected.id).state, 'dismissed');
  assert.equal(state.store.get(data.repository, stillOpen.id).state, 'stale');
  assert.ok(state.store.list(data.repository).some((item) => item.target.revision === 'component:r2' && item.state === 'open'));
});

test('contradictory proposals remain separate and deferred rationale can reopen on its condition', (context) => {
  const initial = Date.parse('2026-08-03T13:00:00.000Z');
  const state = storeFixture(initial); context.after(() => rmSync(state.root, { recursive: true, force: true }));
  const data = fixture();
  data.runs.push({
    ...structuredClone(data.runs[1]), id: 'run:failed-again', updatedAt: '2026-08-03T12:20:00.000Z',
    failure: { message: 'The reconnect check returned a contradictory result.' },
  });
  state.store.refresh(data.repository, data);
  const contradictions = state.store.list(data.repository).filter((item) => item.contradictions.length);
  assert.ok(contradictions.length >= 2);
  const proposal = contradictions[0];
  state.store.decide(data.repository, proposal.id, { state: 'deferred', rationale: 'Wait for another observed run.', reconsiderAfter: '2026-08-04T00:00:00.000Z' });
  assert.equal(state.store.get(data.repository, proposal.id).state, 'deferred');
  state.setNow(Date.parse('2026-08-04T01:00:00.000Z'));
  state.store.refresh(data.repository, data);
  assert.equal(state.store.get(data.repository, proposal.id).state, 'open');
  assert.equal(state.store.get(data.repository, proposal.id).decision.rationale, 'Wait for another observed run.');
});

test('acceptance routes only through a validated draft and never mutates a contract directly', (context) => {
  const state = storeFixture(); context.after(() => rmSync(state.root, { recursive: true, force: true }));
  const data = fixture(); state.store.refresh(data.repository, data);
  const proposal = state.store.list(data.repository).find((item) => item.target.kind === 'component');
  assert.throws(() => state.store.route(data.repository, proposal.id, { expectedRevision: proposal.revision }), (error) => error instanceof LearningError && error.code === 'LEARNING_DRAFT_BOUNDARY_REQUIRED');
  assert.equal(state.store.get(data.repository, proposal.id).state, 'open');
  assert.equal(state.store.get(data.repository, proposal.id).routedDraft, null, 'a failed draft boundary must roll back proposal routing state');
  const routed = state.store.route(data.repository, proposal.id, { expectedRevision: proposal.revision }, {
    actor: { id: 'host', name: 'Host', implicit: true },
    route: (input) => {
      assert.equal(input.id, proposal.id);
      return { kind: 'component-design', draftId: 'draft:validated', draftRevision: 'draft:r1', validated: true, publicationRequired: true };
    },
  });
  assert.equal(routed.proposal.state, 'accepted-for-draft');
  assert.equal(routed.authority.contractMutation, false);
  assert.equal(routed.authority.publicationRequired, true);
});

test('local feedback is inspectable/deletable and explicit export strips source, identity, rationale and credentials', (context) => {
  const state = storeFixture(); context.after(() => rmSync(state.root, { recursive: true, force: true }));
  const data = fixture(); state.store.refresh(data.repository, data);
  const proposal = state.store.list(data.repository)[0];
  const feedback = state.store.feedback(data.repository, proposal.id, {
    signal: 'not-useful', reasonCode: 'wrong-target',
    rationale: 'Local-only rationale contains https://private.example and token=super-secret plus src/private.mjs.',
  }, { actor: { id: 'paired-device-real-name', name: 'Owner laptop' } });
  assert.equal(state.store.feedbackList(data.repository)[0].rationale.includes('super-secret'), true);
  const rankBeforeFeedback = proposal.rank;
  state.store.refresh(data.repository, data);
  assert.ok(state.store.get(data.repository, proposal.id).rank < rankBeforeFeedback, 'inspectable not-useful feedback should lower only the local proposal rank');
  assert.equal(state.store.get(data.repository, proposal.id).authority.contractMutation, false);
  const preview = state.store.previewExport(data.repository, { purpose: 'benchmark-contribution', feedbackIds: [feedback.id], benchmarkTarget: 'planning-quality-v1' });
  const serialized = JSON.stringify(preview.payload);
  assert.ok(!serialized.includes('super-secret'));
  assert.ok(!serialized.includes('private.example'));
  assert.ok(!serialized.includes('src/private.mjs'));
  assert.ok(!serialized.includes('paired-device-real-name'));
  assert.deepEqual(preview.payload.privacy, { source: false, snippets: false, paths: false, credentials: false, actorIdentity: false, freeTextRationale: false });
  assert.throws(() => state.store.confirmExport(data.repository, preview.id, { expectedRevision: preview.revision, confirmed: false }), (error) => error.code === 'LEARNING_EXPORT_CONFIRMATION_REQUIRED');
  const confirmed = state.store.confirmExport(data.repository, preview.id, { expectedRevision: preview.revision, confirmed: true }, { actor: { id: 'host', name: 'Host', implicit: true } });
  assert.equal(confirmed.networkRequestMade, false);
  assert.equal(confirmed.delivery, 'download-only');
  assert.equal(state.store.feedbackList(data.repository)[0].privacy.exported, true);
  state.store.deleteFeedback(data.repository, feedback.id);
  assert.equal(state.store.feedbackList(data.repository).length, 0);
  const persisted = readFileSync(join(state.root, readdirSync(state.root)[0]), 'utf8');
  assert.ok(!persisted.includes('paired-device-real-name'));
});
