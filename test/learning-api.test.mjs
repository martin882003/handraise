import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import { createAnalysisSnapshot } from '../src/intelligence/contracts.mjs';
import { LearningProposalStore } from '../src/learning.mjs';
import { createFront, initializeNativeRepository, repositoryPortfolio } from '../src/repositories.mjs';
import { createHandraise } from '../src/server.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function requestJson(base, pathname, { method = 'GET', host = '127.0.0.1', origin, cookie, payload } = {}) {
  const target = new URL(pathname, base); const encoded = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method,
      headers: { host, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}) },
    }, (response) => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    request.on('error', reject); if (encoded) request.write(encoded); request.end();
  });
}

function component() {
  return {
    slug: 'runtime-control', title: 'Runtime Control', order: 1,
    purpose: 'Own authenticated server runtime control.', outcomes: ['Runtime control stays operable.'],
    responsibilities: ['Serve authenticated control routes.'], limits: ['No product architecture publication.'],
    invariants: ['Authenticate remote mutations.'], interfaces: [], dependencies: [], dataSystems: ['Private state'],
    territory: ['src/server.mjs'], verification: ['Run API tests.'],
    evidence: [{ kind: 'declared', reference: 'ev:server', reason: 'Current accepted server boundary.' }],
    uncertainties: ['The accepted boundary may be too broad.'], guidance: 'Preserve runtime behavior while reviewing boundaries.',
  };
}

function snapshot(repositoryId) {
  return createAnalysisSnapshot({
    repository: { id: repositoryId, adapter: 'handraise' }, createdAt: '2026-08-03T12:00:00.000Z',
    analyzer: {
      id: 'fixture', name: 'Fixture', version: '1.0.0', contractVersion: 1,
      capabilities: { languages: ['JavaScript'], entityKinds: ['module'], relationKinds: [], queries: ['entity', 'search', 'neighbors', 'path', 'evidence'], history: false, semantic: true, incremental: false },
      privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    },
    configuration: {}, status: 'complete', freshness: { state: 'current', checkedAt: '2026-08-03T12:00:00.000Z' },
    manifest: {
      files: [{ path: 'src/server.mjs', digest: digest('server'), size: 20, source: 'tracked' }],
      git: { head: digest('head').slice(0, 40), branch: 'main', dirty: false }, selection: { includeUntracked: false, includeIgnored: false, exclusions: [] },
    },
    scope: { included: ['src/server.mjs'], excluded: [], truncated: false, limits: {} },
    evidence: [{ id: 'ev:server', sourceKind: 'source', provenance: 'extracted', path: 'src/server.mjs' }],
    entities: [{ id: 'module:server', kind: 'module', name: 'Server', location: { path: 'src/server.mjs' }, evidenceIds: ['ev:server'], attributes: { community: 'runtime' } }],
    relations: [], findings: [], coverage: [], diagnostics: [],
  });
}

test('learning APIs remain authenticated, route through validated drafts and export only by explicit local confirmation', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-learning-api-')); context.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'state'); const repositoryRoot = join(home, 'repository'); const webRoot = join(home, 'web');
  mkdirSync(repositoryRoot, { recursive: true }); mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, 'README.md'), 'Learning API fixture.\n'); writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  initializeNativeRepository({ id: 'learning-api', name: 'Learning API', path: repositoryRoot }, { components: [component()] });
  const config = new ConfigStore({ root, resolveRepository: () => repositoryRoot, home });
  const repository = config.addRepository(repositoryRoot, { id: 'learning-api', name: 'Learning API' });
  const target = { ...repository, adapter: 'handraise' };
  createFront(target, 'runtime-control', {
    slug: 'learning-front', title: 'Review runtime learning', outcome: 'Runtime discoveries become reviewed planning inputs.',
    motivation: 'Exercise the normal front-design boundary.', scope: 'Review exact run evidence before changing accepted work.',
    nonGoals: ['No direct contract mutation.'], readiness: ['A retained run exists.'], acceptanceCriteria: ['A human reviews the draft.'],
    verification: ['Run learning API tests.'], deliverables: ['A private front draft.'], risks: ['The proposal may target the wrong owner.'],
    dependencies: [], evidence: [{ kind: 'declared', reference: 'test:learning-api', reason: 'API boundary fixture.' }], affectedComponents: [], goalIds: [], analysisSnapshot: null,
    context: 'This fixture proves front proposals route through validated private planning.', handoff: 'Keep accepted files unchanged until explicit transactional publication.', tasks: ['Review the proposal'],
  });
  const acceptedPath = join(repositoryRoot, '.handraise', 'components', 'runtime-control.md'); const acceptedBefore = readFileSync(acceptedPath, 'utf8');
  const acceptedFrontPath = join(repositoryRoot, '.handraise', 'fronts', 'learning-front.md'); const acceptedFrontBefore = readFileSync(acceptedFrontPath, 'utf8');
  const accepted = repositoryPortfolio(target);
  const acceptedFront = accepted.fronts.find((item) => item.slug === 'learning-front');
  const seedRuns = [{
    id: 'run:learning', state: 'failed', updatedAt: '2026-08-03T12:30:00.000Z', failure: { message: 'Reconnect verification timed out.' },
    manifest: { revision: 'manifest:r1', front: { slug: 'learning-front', leadComponent: 'runtime-control', revision: acceptedFront.revision, goalIds: [] }, components: [{ slug: 'runtime-control', revision: accepted.components[0].revision }], source: { analysisSnapshot: 'snapshot:r1' } },
    discoveries: [
      { id: 'discovery:learning', kind: 'discovery', summary: 'Reconnect policy belongs with runtime control.', evidence: 'Authenticated user observation.', affectedFronts: [], at: '2026-08-03T12:20:00.000Z', actor: { id: 'host', name: 'Host', authority: 'implicit-local' } },
      { id: 'decision:learning', kind: 'decision', summary: 'Offline recovery is an explicit product assumption.', evidence: 'Recorded during run review.', affectedFronts: [], at: '2026-08-03T12:21:00.000Z', actor: { id: 'host', name: 'Host', authority: 'implicit-local' } },
      { id: 'blocker:learning', kind: 'blocker', summary: 'Reconnect verification blocks another run.', evidence: 'The configured check timed out.', affectedFronts: [], at: '2026-08-03T12:22:00.000Z', actor: { id: 'host', name: 'Host', authority: 'implicit-local' } },
      { id: 'scope:learning', kind: 'scope-change', summary: 'The front may also need retry-policy review.', evidence: 'Scope changed during execution.', affectedFronts: [], at: '2026-08-03T12:23:00.000Z', actor: { id: 'host', name: 'Host', authority: 'implicit-local' } },
    ],
    checks: [], outcome: null,
  }];
  const learning = new LearningProposalStore({ root: join(root, 'learning'), now: () => Date.parse('2026-08-03T13:00:00.000Z') });
  learning.refresh(target, { portfolio: accepted, runs: seedRuns, findings: [] });
  const analysisSnapshot = snapshot(repository.id);
  const analysisRuntime = {
    analyzers: async () => [], list: () => [{ id: 'analysis-job', repositoryId: repository.id, state: 'complete', snapshotId: analysisSnapshot.id, updatedAt: '2026-08-03T12:00:00.000Z' }],
    status: () => ({ id: 'analysis-job', state: 'complete', snapshotId: analysisSnapshot.id }),
    snapshot: (repositoryId, id) => { if (repositoryId !== repository.id || id !== 'analysis-job') throw new Error('snapshot not found'); return analysisSnapshot; }, shutdown() {},
  };
  const auth = new PairingAuth({ root }); const paired = auth.pair(auth.pairingDetails().code, 'Remote reviewer');
  const planningRuntime = { catalog: async () => [], list: () => [], shutdown() {} };
  const server = createHandraise({ root, webRoot, auth, config, analysisRuntime, learningStore: learning, planningRuntime });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); }); server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) { server.close(); if (error?.code === 'EPERM') { context.skip('the execution sandbox does not permit a local listening socket'); return; } throw error; }
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`; const endpoint = `/api/repositories/${repository.id}/learning`;
  const unauthorized = await requestJson(base, endpoint, { host: 'remote.test' }); assert.equal(unauthorized.status, 401);
  const listed = await requestJson(base, endpoint); assert.equal(listed.status, 200); const proposal = listed.body.proposals.find((item) => item.cause.id === 'discovery:learning');
  assert.equal(proposal.target.kind, 'component');
  const routed = await requestJson(base, `${endpoint}/proposals/${encodeURIComponent(proposal.id)}/route`, { method: 'POST', payload: { expectedRevision: proposal.revision } });
  assert.equal(routed.status, 201, JSON.stringify(routed.body));
  assert.equal(routed.body.draft.kind, 'component-design'); assert.equal(routed.body.authority.contractMutation, false); assert.equal(routed.body.authority.publicationRequired, true);
  assert.equal(readFileSync(acceptedPath, 'utf8'), acceptedBefore, 'routing into a draft must not mutate the accepted contract');

  const productProposal = listed.body.proposals.find((item) => item.cause.id === 'decision:learning');
  const productRouted = await requestJson(base, `${endpoint}/proposals/${encodeURIComponent(productProposal.id)}/route`, { method: 'POST', payload: { expectedRevision: productProposal.revision } });
  assert.equal(productRouted.status, 201, JSON.stringify(productRouted.body)); assert.equal(productRouted.body.draft.kind, 'product-direction');
  const productDraft = await requestJson(base, `/api/repositories/${repository.id}/product/drafts/${encodeURIComponent(productRouted.body.draft.draftId)}`);
  assert.equal(productDraft.status, 200); assert.ok(productDraft.body.draft.brief.assumptions.some((item) => item.text.includes('Offline recovery')));
  assert.equal(existsSync(join(repositoryRoot, '.handraise', 'product.md')), false, 'routing a product proposal must remain private');

  const frontProposal = listed.body.proposals.find((item) => item.cause.id === 'blocker:learning');
  assert.deepEqual(frontProposal.changes.map((item) => item.field), ['risks', 'readiness']);
  const frontRouted = await requestJson(base, `${endpoint}/proposals/${encodeURIComponent(frontProposal.id)}/route`, { method: 'POST', payload: { expectedRevision: frontProposal.revision } });
  assert.equal(frontRouted.status, 201, JSON.stringify(frontRouted.body)); assert.equal(frontRouted.body.draft.kind, 'front-design');
  const frontDraft = await requestJson(base, `/api/repositories/${repository.id}/front-design/drafts/${encodeURIComponent(frontRouted.body.draft.draftId)}`);
  assert.equal(frontDraft.status, 200);
  const frontAlternative = frontDraft.body.draft.alternatives.find((item) => item.id === frontDraft.body.draft.selectedAlternativeId);
  const draftedFront = frontAlternative.fronts.find((item) => item.slug === 'learning-front');
  assert.ok(draftedFront.risks.some((item) => item.includes('Reconnect verification blocks another run')));
  assert.equal(readFileSync(acceptedFrontPath, 'utf8'), acceptedFrontBefore, 'routing a front proposal must not mutate the accepted front');

  const scopeProposal = listed.body.proposals.find((item) => item.cause.id === 'scope:learning');
  assert.ok(scopeProposal.changes.some((item) => item.field === 'scope' && item.operation === 'append'));
  const changedRevision = await requestJson(base, `${endpoint}/proposals/${encodeURIComponent(scopeProposal.id)}/route`, { method: 'POST', payload: { expectedRevision: 'outdated-proposal-revision' } });
  assert.equal(changedRevision.status, 409); assert.equal(changedRevision.body.code, 'LEARNING_PROPOSAL_CHANGED');
  const syntheticPortfolio = structuredClone(accepted); syntheticPortfolio.fronts.find((item) => item.slug === 'learning-front').revision = 'front:synthetic-new-revision';
  learning.refresh(target, { portfolio: syntheticPortfolio, runs: seedRuns, findings: [] });
  assert.equal(learning.get(target, scopeProposal.id).state, 'stale');
  const staleRoute = await requestJson(base, `${endpoint}/proposals/${encodeURIComponent(scopeProposal.id)}/route`, { method: 'POST', payload: { expectedRevision: learning.get(target, scopeProposal.id).revision } });
  assert.equal(staleRoute.status, 409); assert.equal(staleRoute.body.code, 'LEARNING_PROPOSAL_STALE');
  assert.equal(readFileSync(acceptedPath, 'utf8'), acceptedBefore); assert.equal(readFileSync(acceptedFrontPath, 'utf8'), acceptedFrontBefore);

  const feedback = await requestJson(base, `${endpoint}/proposals/${encodeURIComponent(proposal.id)}/feedback`, { method: 'POST', payload: { signal: 'useful', reasonCode: 'correct-target', rationale: 'Private reviewer rationale.' } });
  assert.equal(feedback.status, 201); const feedbackId = feedback.body.feedback.id;
  const remoteCookie = `handraise_session=${paired.token}`; const origin = 'http://remote.test';
  const forbiddenExport = await requestJson(base, `${endpoint}/exports/preview`, { method: 'POST', host: 'remote.test', origin, cookie: remoteCookie, payload: { purpose: 'benchmark-contribution', feedbackIds: [feedbackId] } });
  assert.equal(forbiddenExport.status, 403);
  const preview = await requestJson(base, `${endpoint}/exports/preview`, { method: 'POST', payload: { purpose: 'benchmark-contribution', feedbackIds: [feedbackId] } });
  assert.equal(preview.status, 201); assert.equal(preview.body.preview.payload.privacy.source, false);
  const rejected = await requestJson(base, `${endpoint}/exports/${preview.body.preview.id}/confirm`, { method: 'POST', payload: { expectedRevision: preview.body.preview.revision, confirmed: false } });
  assert.equal(rejected.status, 400);
  const confirmed = await requestJson(base, `${endpoint}/exports/${preview.body.preview.id}/confirm`, { method: 'POST', payload: { expectedRevision: preview.body.preview.revision, confirmed: true } });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.networkRequestMade, false); assert.equal(confirmed.body.delivery, 'download-only');
  assert.equal(readFileSync(acceptedPath, 'utf8'), acceptedBefore); assert.equal(readFileSync(acceptedFrontPath, 'utf8'), acceptedFrontBefore);
});
