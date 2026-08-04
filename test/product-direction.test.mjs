import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { createPairingAuth } from '../src/auth.mjs';
import { ConfigStore } from '../src/config.mjs';
import {
  ProductDirectionDraftStore,
  normalizeProductBrief,
  parseProductBrief,
  productBriefQuestions,
  readAcceptedProduct,
  renderProductBrief,
} from '../src/product-direction.mjs';
import { initializeNativeRepository } from '../src/repositories.mjs';
import { createHandraise } from '../src/server.mjs';

function completeBrief(overrides = {}) {
  return {
    title: 'Handraise', stage: 'private beta',
    purpose: { text: 'Help people understand systems, design work and run coding agents.', locked: true },
    users: [{ id: 'user:lead', text: 'Technical leads who need coherent parallel work.', locked: true }],
    outcomes: [{ id: 'outcome:model', text: 'A repository has an accepted evidence-backed work model.' }],
    constraints: [{ id: 'constraint:local', text: 'Source remains local by default.' }],
    invariants: [{ id: 'invariant:acceptance', text: 'No proposal mutates repository state before acceptance.' }],
    nonGoals: [{ id: 'non-goal:forge', text: 'Do not become a hosted source forge.' }],
    glossary: [{ id: 'term:front', term: 'Front', definition: 'A temporary observable outcome.', aliases: ['work front'] }],
    goals: [{
      id: 'goal:understand', title: 'Understand repositories', outcome: 'Produce a trustworthy semantic map.',
      priority: 'now', horizon: 'current milestone', state: 'active', successSignals: ['Evidence resolves'],
      constraintIds: ['constraint:local'], repositoryIds: ['repo'], locked: true,
    }],
    repositoryRoles: [{ id: 'repository-role:repo', repositoryId: 'repo', role: 'Own the Handraise product.' }],
    assumptions: [{ id: 'assumption:graph', text: 'Structural graphs are useful but insufficient.' }],
    decisions: [{ id: 'decision:slogan', question: 'Which slogan is canonical?', answer: 'Understand the system. Design the work. Run the agents.', state: 'resolved', locked: true }],
    conflicts: [],
    sources: [{ id: 'source:vision', kind: 'document', label: 'Product vision', path: 'docs/PRODUCT_VISION.md', digest: '1'.repeat(64) }],
    ...overrides,
  };
}

test('product brief Markdown remains human-readable, validated and preserves unknown content', () => {
  const existing = [
    '---',
    'schema: 1',
    'title: "Old title"',
    'stage: "idea"',
    'updated: 2026-08-01T00:00:00.000Z',
    'custom-owner: product-team',
    '---',
    '',
    '# Old product brief',
    '',
    'A manually maintained introduction.',
    '',
    '## Purpose',
    '',
    'Old purpose.',
    '',
    '## Custom governance',
    '',
    'This section must survive structured edits.',
    '',
  ].join('\n');
  const normalized = normalizeProductBrief(completeBrief(), { repositoryId: 'repo', now: Date.parse('2026-08-03T12:00:00.000Z') });
  const markdown = renderProductBrief(normalized, { existingMarkdown: existing, repositoryId: 'repo' });

  assert.match(markdown, /custom-owner: product-team/);
  assert.match(markdown, /## Custom governance\n\nThis section must survive structured edits\./);
  assert.match(markdown, /# Product brief — Handraise/);
  assert.match(markdown, /\[goal:understand\] \*\*Understand repositories\*\*/);
  assert.match(markdown, /source:vision/);

  const parsed = parseProductBrief(markdown, { repositoryId: 'repo' });
  assert.equal(parsed.title, 'Handraise');
  assert.equal(parsed.purpose.text, normalized.purpose.text);
  assert.equal(parsed.purpose.locked, true);
  assert.equal(parsed.users[0].id, 'user:lead');
  assert.equal(parsed.goals[0].priority, 'now');
  assert.deepEqual(parsed.goals[0].constraintIds, ['constraint:local']);
  assert.equal(parsed.decisions[0].answer, 'Understand the system. Design the work. Run the agents.');
  assert.equal(parsed.sources.find((source) => source.id === 'source:vision').path, 'docs/PRODUCT_VISION.md');
  assert.throws(() => parseProductBrief(markdown.replace('schema: 1', 'schema: 2')), /unsupported product brief schema/);
  assert.throws(() => parseProductBrief('---\nschema: 1\ntitle: "Broken"\nstage: "idea"\n---\n\n# Broken\n\n## Users and jobs\n\n- [user:broken] Broken <!-- handraise:{not-json} -->\n'), /invalid handraise metadata/);
  assert.throws(() => normalizeProductBrief(completeBrief({
    goals: [{ id: 'goal:bad', title: 'Bad', outcome: 'Bad ref', constraintIds: ['constraint:missing'] }],
  })), /unknown constraint/);
});

test('guided questions expose missing declared truth without blocking the manual path', () => {
  const brief = normalizeProductBrief({ title: 'New product' });
  const questions = productBriefQuestions(brief);
  assert.deepEqual(questions.map((question) => question.id), ['purpose', 'users', 'outcomes', 'constraints', 'non-goals', 'goals']);
  assert.ok(questions.every((question) => question.blocking === false));
  assert.deepEqual(productBriefQuestions(completeBrief()), []);
});

test('persistent product drafts import selected local Markdown, retain locks and never mutate the repository', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-product-draft-'));
  const stateRoot = join(home, 'state');
  const repositoryRoot = join(home, 'repository');
  mkdirSync(join(repositoryRoot, 'docs'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'README.md'), '# Fixture\n');
  writeFileSync(join(repositoryRoot, 'docs', 'direction.md'), [
    '# Direction',
    '## Purpose',
    'A different imported purpose that must become a visible conflict.',
    '## Users',
    '- Product engineers coordinating coding agents.',
    '## Desired outcomes',
    '- Work fronts have explicit outcomes and verification.',
    '## Constraints',
    '- No source leaves the host implicitly.',
    '## Non-goals',
    '- Do not hide uncertainty.',
    '## Goals',
    '- Design repository components.',
  ].join('\n'));
  const repository = { id: 'repo', name: 'Fixture product', path: repositoryRoot, adapter: 'uninitialized' };
  let now = Date.parse('2026-08-03T12:00:00.000Z');
  const store = new ProductDirectionDraftStore({ root: stateRoot, now: () => now });
  const created = store.create(repository);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);
  assert.equal(created.canAccept, false);
  assert.ok(created.questions.length > 0);

  const manual = normalizeProductBrief(completeBrief(), { repositoryId: repository.id, now });
  const updated = store.update(repository, created.id, { brief: manual });
  assert.equal(updated.brief.purpose.locked, true);
  assert.throws(() => store.update(repository, created.id, {
    brief: { ...updated.brief, purpose: { ...updated.brief.purpose, text: 'Changed while locked.' } },
  }), /explicitly unlocked/);
  const unlocked = store.update(repository, created.id, {
    brief: { ...updated.brief, purpose: { ...updated.brief.purpose, text: 'Human-approved purpose.', locked: false } },
    unlockIds: ['purpose'],
  });
  assert.equal(unlocked.brief.purpose.text, 'Human-approved purpose.');
  unlocked.brief.purpose.locked = true;
  const relocked = store.update(repository, created.id, { brief: unlocked.brief });

  const importPlan = store.planImport(repository, created.id, ['docs/direction.md']);
  assert.deepEqual(importPlan.documents.map((document) => document.path), ['docs/direction.md']);
  assert.equal(importPlan.repositoryMutation, false);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);
  const imported = store.importDocuments(repository, created.id, ['docs/direction.md']);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false, 'draft/import is read-only against the repository');
  assert.equal(imported.brief.purpose.text, relocked.brief.purpose.text, 'locked purpose survives import');
  assert.ok(imported.brief.users.some((item) => /Product engineers/.test(item.text)));
  assert.ok(imported.brief.conflicts.some((item) => /Purpose.*differs/i.test(item.summary)));
  assert.ok(imported.brief.sources.some((source) => source.path === 'docs/direction.md'));
  assert.deepEqual(imported.imports, ['docs/direction.md']);

  writeFileSync(join(repositoryRoot, 'docs', 'direction.md'), '# Changed direction\n');
  const staleSource = store.get(repository, created.id).sourceStates.find((source) => source.sourceId !== 'source:human' && source.status === 'stale');
  assert.ok(staleSource);

  const resumed = new ProductDirectionDraftStore({ root: stateRoot, now: () => now }).create(repository);
  assert.equal(resumed.id, created.id, 'a server restart resumes the private draft');
  assert.equal(statSync(join(stateRoot, 'product-drafts')).mode & 0o777, 0o700);
  assert.equal(statSync(join(stateRoot, 'product-drafts', `${created.id}.json`)).mode & 0o777, 0o600);
  assert.throws(() => store.importDocuments(repository, created.id, [join(home, 'outside.md')]), /ENOENT|inside the repository/);
  assert.throws(() => store.accept(repository, created.id), /initialize the native Handraise repository/);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);
});

test('product acceptance is serialized, atomic, conflict-safe and preserves accepted unknown Markdown', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-product-accept-'));
  const stateRoot = join(home, 'state');
  const repositoryRoot = join(home, 'repository');
  mkdirSync(repositoryRoot, { recursive: true });
  const repository = { id: 'repo', name: 'Accepted product', path: repositoryRoot, adapter: 'uninitialized' };
  initializeNativeRepository(repository);
  const native = { ...repository, adapter: 'handraise' };
  const store = new ProductDirectionDraftStore({ root: stateRoot });
  const draft = store.create(native);
  store.update(native, draft.id, { brief: completeBrief() });
  writeFileSync(join(repositoryRoot, '.handraise', 'product.md.tmp-dead'), 'incomplete');
  const preview = store.preview(native, draft.id);
  assert.equal(preview.stale, false);
  assert.match(preview.after, /Understand the system/);
  assert.equal(readAcceptedProduct(native).exists, false);

  const accepted = store.accept(native, draft.id);
  assert.equal(accepted.accepted, true);
  assert.equal(existsSync(join(repositoryRoot, '.handraise', 'product.md.tmp-dead')), false);
  const current = readAcceptedProduct(native);
  assert.equal(current.exists, true);
  assert.equal(current.brief.goals[0].id, 'goal:understand');
  assert.throws(() => store.get(native, draft.id), /not found/);

  const existing = readFileSync(join(repositoryRoot, '.handraise', 'product.md'), 'utf8');
  writeFileSync(join(repositoryRoot, '.handraise', 'product.md'), `${existing}\n## Human-only appendix\n\nPreserve this.\n`);
  const updateDraft = store.create(native, { reset: true });
  store.update(native, updateDraft.id, { brief: { ...updateDraft.brief, stage: 'public beta' } });
  store.accept(native, updateDraft.id);
  assert.match(readFileSync(join(repositoryRoot, '.handraise', 'product.md'), 'utf8'), /## Human-only appendix\n\nPreserve this\./);

  const conflictDraft = store.create(native, { reset: true });
  const beforeExternal = readFileSync(join(repositoryRoot, '.handraise', 'product.md'), 'utf8');
  const externallyChanged = `${beforeExternal}\nExternal concurrent edit.\n`;
  writeFileSync(join(repositoryRoot, '.handraise', 'product.md'), externallyChanged);
  assert.equal(store.preview(native, conflictDraft.id).stale, true);
  assert.throws(() => store.accept(native, conflictDraft.id), /changed after this draft/);
  assert.equal(readFileSync(join(repositoryRoot, '.handraise', 'product.md'), 'utf8'), externallyChanged);
  assert.equal(existsSync(join(stateRoot, 'product-drafts', `${conflictDraft.id}.json`)), true, 'conflicted draft remains recoverable');

  mkdirSync(join(repositoryRoot, '.handraise', '.management-lock'));
  const busyDraft = store.create(native, { reset: true });
  assert.throws(() => store.accept(native, busyDraft.id), /another Handraise project update/);
  rmSync(join(repositoryRoot, '.handraise', '.management-lock'), { recursive: true });
});

test('expired and discarded product drafts remain recoverable outcomes without accepted mutation', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-product-expiry-'));
  const repositoryRoot = join(home, 'repository');
  mkdirSync(repositoryRoot, { recursive: true });
  const repository = { id: 'repo', name: 'Expiry', path: repositoryRoot, adapter: 'uninitialized' };
  let now = 1_000;
  const store = new ProductDirectionDraftStore({ root: join(home, 'state'), now: () => now, ttlMs: 100 });
  const expired = store.create(repository);
  now += 101;
  assert.throws(() => store.get(repository, expired.id), /expired/);
  const discarded = store.create(repository);
  assert.deepEqual(store.discard(repository, discarded.id), { discarded: discarded.id });
  assert.throws(() => store.get(repository, discarded.id), /not found/);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);
});

test('Director product drafts remain explicit read-only capability', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-product-director-'));
  const repositoryRoot = join(home, 'repository');
  mkdirSync(join(repositoryRoot, '.claude', 'components'), { recursive: true });
  mkdirSync(join(repositoryRoot, '.claude', 'runtime', 'plans'), { recursive: true });
  const repository = { id: 'director', name: 'Director fixture', path: repositoryRoot, adapter: 'director' };
  const store = new ProductDirectionDraftStore({ root: join(home, 'state') });
  const draft = store.create(repository);
  assert.equal(draft.canAccept, false);
  assert.throws(() => store.accept(repository, draft.id), /does not expose a validated product-brief writer/);
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);
});

test('product direction APIs are authenticated, resumable and keep acceptance explicit', async (context) => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-product-api-'));
  const stateRoot = join(home, 'state');
  const repositoryRoot = join(home, 'repository');
  const webRoot = join(home, 'web');
  mkdirSync(join(repositoryRoot, 'docs'), { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, 'README.md'), '# Product API fixture\n');
  writeFileSync(join(repositoryRoot, 'docs', 'intent.md'), '# Intent\n\n## Outcomes\n\n- A reviewed product brief exists.\n');
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Handraise</title>');
  const config = new ConfigStore({ root: stateRoot, resolveRepository: () => repositoryRoot, home });
  const repository = config.addRepository(repositoryRoot, { name: 'Product API' });
  const auth = createPairingAuth({ root: stateRoot });
  const server = createHandraise({ root: stateRoot, webRoot, config, auth });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('local listen unavailable'), { code: 'EPERM' })), 2_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    if (error?.code === 'EPERM') {
      server.close();
      context.skip('the execution sandbox does not permit a local listening socket');
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    return { status: response.status, body: await response.json() };
  };

  const unauthorized = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: address.port, path: `/api/repositories/${repository.id}/product`,
      method: 'GET', headers: { host: 'remote.test' },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw || '{}') }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(unauthorized.status, 401);

  const initial = await api(`/api/repositories/${repository.id}/product`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.exists, false);
  assert.equal(initial.body.supported, false);

  const created = await api(`/api/repositories/${repository.id}/product/drafts`, { method: 'POST', body: '{}' });
  assert.equal(created.status, 201);
  const draftId = created.body.draft.id;
  const brief = completeBrief({ repositoryRoles: [{ id: 'repository-role:repo', repositoryId: repository.id, role: 'Own the fixture.' }] });
  const updated = await api(`/api/repositories/${repository.id}/product/drafts/${draftId}`, {
    method: 'PATCH', body: JSON.stringify({ brief }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.draft.brief.title, 'Handraise');

  const importPreview = await api(`/api/repositories/${repository.id}/product/drafts/${draftId}/import-preview`, {
    method: 'POST', body: JSON.stringify({ paths: ['docs/intent.md'] }),
  });
  assert.equal(importPreview.status, 200);
  assert.deepEqual(importPreview.body.preview.documents.map((document) => document.path), ['docs/intent.md']);
  assert.equal(importPreview.body.preview.repositoryMutation, false);
  const imported = await api(`/api/repositories/${repository.id}/product/drafts/${draftId}/import`, {
    method: 'POST', body: JSON.stringify({ paths: ['docs/intent.md'] }),
  });
  assert.equal(imported.status, 200);
  assert.ok(imported.body.draft.brief.sources.some((source) => source.path === 'docs/intent.md'));

  const preview = await api(`/api/repositories/${repository.id}/product/drafts/${draftId}/preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.stale, false);
  assert.equal(preview.body.preview.canAccept, false);

  const premature = await api(`/api/repositories/${repository.id}/product/drafts/${draftId}/accept`, { method: 'POST', body: '{}' });
  assert.equal(premature.status, 409);
  assert.equal(premature.body.code, 'PRODUCT_REPOSITORY_NOT_INITIALIZED');
  assert.equal(existsSync(join(repositoryRoot, '.handraise')), false);

  const initialized = await api(`/api/repositories/${repository.id}/initialize`, { method: 'POST', body: '{}' });
  assert.equal(initialized.status, 200);
  const accepted = await api(`/api/repositories/${repository.id}/product/drafts/${draftId}/accept`, { method: 'POST', body: '{}' });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.accepted, true);
  assert.equal(existsSync(join(repositoryRoot, '.handraise', 'product.md')), true);

  const current = await api(`/api/repositories/${repository.id}/product`);
  assert.equal(current.status, 200);
  assert.equal(current.body.exists, true);
  assert.equal(current.body.brief.title, 'Handraise');

  const resumed = await api(`/api/repositories/${repository.id}/product/drafts`, { method: 'POST', body: '{}' });
  const discarded = await api(`/api/repositories/${repository.id}/product/drafts/${resumed.body.draft.id}`, { method: 'DELETE', body: '{}' });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.discarded, resumed.body.draft.id);
});
