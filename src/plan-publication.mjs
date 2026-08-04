import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { createContentManifest } from './intelligence/contracts.mjs';
import { recaptureAnalysisManifest } from './intelligence/runtime.mjs';
import { normalizeProductBrief, parseProductBrief, readAcceptedProduct, renderProductBrief } from './product-direction.mjs';
import { procAlive } from './state.mjs';
import {
  createComponentMarkdown, createFrontMarkdown, migrateComponentMarkdown, migrateFrontMarkdown,
  parseComponentContract, parseFrontContract, updateComponentMarkdown, updateFrontMarkdown,
  validatePortfolioContracts, workContractRevision,
} from './work-contracts.mjs';

export const PLAN_PUBLICATION_SCHEMA_VERSION = 1;
export const PLAN_PUBLICATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PLAN_PUBLICATION_MODES = Object.freeze(['components-only', 'product-components', 'complete-plan']);
export const PLAN_PUBLICATION_STATES = Object.freeze(['review', 'committing', 'committed', 'conflict', 'failed']);

const MODES = new Set(PLAN_PUBLICATION_MODES);
const PREVIEW_ID = /^[a-f0-9-]{36}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value;
}

function clean(value, limit = 8_000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function inline(value, limit = 256) { return clean(value, limit).replace(/\s+/g, ' '); }

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path;
}

function syncDirectory(path) {
  let descriptor;
  try { descriptor = openSync(path, 'r'); fsyncSync(descriptor); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes(error?.code)) throw error;
  }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function durableWrite(path, content, { mode = 0o600, exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, exclusive ? 'wx' : 'w', mode);
  try { writeFileSync(descriptor, content); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  chmodSync(path, mode); syncDirectory(dirname(path));
}

function atomicPrivateJson(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try { durableWrite(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, exclusive: true }); renameSync(temporary, path); chmodSync(path, 0o600); syncDirectory(dirname(path)); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}

function read(path, fallback = null) {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
}

function listMarkdown(path) {
  try { return readdirSync(path).filter((name) => name.endsWith('.md') && name !== '_TEMPLATE.md').sort(); }
  catch { return []; }
}

function relativeTarget(repository, relativePath) {
  if (!/^\.handraise\/(?:product\.md|project\.json|\.gitignore|components\/[a-z0-9-]+\.md|fronts\/[a-z0-9-]+\.md|publications\/[a-f0-9-]+\.json)$/.test(relativePath)) {
    throw new PlanPublicationError('UNSAFE_PUBLICATION_PATH', `unsafe publication target '${relativePath}'`);
  }
  const root = resolve(repository.path); const target = resolve(root, ...relativePath.split('/'));
  if (!target.startsWith(`${root}${sep}`)) throw new PlanPublicationError('UNSAFE_PUBLICATION_PATH', `publication target escapes repository: '${relativePath}'`);
  return target;
}

export class PlanPublicationError extends Error {
  constructor(code, message, { details = null, diagnostics = [], cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PlanPublicationError'; this.code = code; this.details = details; this.diagnostics = diagnostics;
  }

  toJSON() { return { error: this.message, code: this.code, details: this.details, diagnostics: this.diagnostics }; }
}

function fail(code, message, details = null, diagnostics = [], cause = null) { throw new PlanPublicationError(code, message, { details, diagnostics, cause }); }

function detectedAdapter(repository) {
  const director = existsSync(join(repository.path, '.claude', 'components')) && existsSync(join(repository.path, '.claude', 'runtime', 'plans'));
  const native = existsSync(join(repository.path, '.handraise', 'components')) && existsSync(join(repository.path, '.handraise', 'fronts'));
  if (director) return 'director';
  if (native) return 'handraise';
  return 'uninitialized';
}

function processSeal() {
  const stat = read('/proc/self/stat', '');
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const started = fields[19];
  const boot = clean(read('/proc/sys/kernel/random/boot_id', ''), 64);
  return started ? `${process.pid}@${started}${boot ? `@${boot.slice(0, 8)}` : ''}` : null;
}

function productDraftRevision(draft) {
  return draft ? sha256(canonical({ id: draft.id, baselineRevision: draft.baselineRevision, updatedAt: draft.updatedAt, brief: draft.brief })) : null;
}

export function publicationSourceRevision(workspace) {
  const componentDraft = workspace?.componentDraft;
  const frontDraft = workspace?.frontDraft || null;
  const productDraft = workspace?.productDraft || null;
  const snapshot = workspace?.snapshot;
  return deepFreeze({
    componentDraftId: componentDraft?.id || null,
    componentDraftRevision: componentDraft?.revision || null,
    componentAlternativeId: inline(workspace?.componentAlternativeId || componentDraft?.selectedAlternativeId, 256) || null,
    frontDraftId: frontDraft?.id || null,
    frontDraftRevision: frontDraft?.revision || null,
    frontAlternativeId: inline(workspace?.frontAlternativeId || frontDraft?.selectedAlternativeId, 256) || null,
    productDraftId: productDraft?.id || null,
    productDraftRevision: productDraftRevision(productDraft),
    productBaselineRevision: productDraft?.baselineRevision ?? null,
    snapshotId: snapshot?.id || componentDraft?.source?.snapshotId || null,
    snapshotManifestDigest: snapshot?.manifest?.digest || null,
  });
}

function normalizeActor(value) {
  const actor = value && typeof value === 'object' ? value : {};
  const id = inline(actor.id, 256); const name = inline(actor.name || actor.label || 'Handraise client', 256);
  if (!id) fail('PUBLICATION_ACTOR_REQUIRED', 'an authenticated client identity is required to prepare publication');
  return { id, name, authority: actor.implicit ? 'implicit-local' : 'paired-client' };
}

function normalizeSelection(value, workspace) {
  const input = value && typeof value === 'object' ? value : {};
  const mode = inline(input.mode, 64);
  if (!MODES.has(mode)) fail('INVALID_PUBLICATION_SELECTION', `publication mode must be one of ${PLAN_PUBLICATION_MODES.join(', ')}`);
  const selection = {
    mode,
    includeProduct: mode === 'product-components' || (mode === 'complete-plan' && input.includeProduct === true),
    includeComponents: true,
    includeFronts: mode === 'complete-plan',
    deleteAbsentComponents: input.deleteAbsentComponents === true,
    deleteAbsentFronts: mode === 'complete-plan' && input.deleteAbsentFronts === true,
    allowCompletedDeletes: input.allowCompletedDeletes === true,
  };
  if (selection.includeProduct && !workspace.productDraft) fail('PRODUCT_DRAFT_REQUIRED', 'this selection requires one reviewed private product draft');
  if (selection.includeFronts && !workspace.frontDraft) fail('FRONT_DRAFT_REQUIRED', 'complete-plan publication requires one reviewed private front plan');
  return selection;
}

function selectedArchitecture(workspace) {
  const draft = workspace.componentDraft;
  if (!draft?.id || !draft.revision || draft.repositoryId !== workspace.repositoryId) fail('COMPONENT_PUBLICATION_SOURCE_INVALID', 'a current component-design draft for this repository is required');
  const id = inline(workspace.componentAlternativeId || draft.selectedAlternativeId, 256);
  const alternative = draft.alternatives?.find((item) => item.id === id);
  if (!alternative?.components?.length) fail('COMPONENT_PUBLICATION_SOURCE_INVALID', 'the selected component alternative is unavailable');
  return alternative;
}

function selectedFrontPlan(workspace, componentAlternative) {
  const draft = workspace.frontDraft;
  if (!draft) return null;
  if (draft.repositoryId !== workspace.repositoryId || !draft.revision) fail('FRONT_PUBLICATION_SOURCE_INVALID', 'the front plan belongs to a different repository');
  if (draft.source?.componentDraftId !== workspace.componentDraft.id || draft.source?.componentDraftRevision !== workspace.componentDraft.revision || draft.source?.componentAlternativeId !== componentAlternative.id) {
    fail('FRONT_COMPONENT_SOURCE_MISMATCH', 'the front plan was not designed from this exact component draft and alternative');
  }
  const id = inline(workspace.frontAlternativeId || draft.selectedAlternativeId, 256);
  const alternative = draft.alternatives?.find((item) => item.id === id);
  if (!alternative?.fronts?.length) fail('FRONT_PUBLICATION_SOURCE_INVALID', 'the selected front-plan alternative is unavailable');
  return alternative;
}

function currentRecords(repository) {
  const root = join(repository.path, '.handraise');
  const componentDirectory = join(root, 'components'); const frontDirectory = join(root, 'fronts');
  const components = listMarkdown(componentDirectory).map((name) => {
    const path = join(componentDirectory, name); const markdown = read(path, ''); const contract = parseComponentContract(markdown, { fallbackSlug: name.replace(/\.md$/, '') });
    return { kind: 'component', slug: contract.slug, path, relativePath: `.handraise/components/${name}`, markdown, contract };
  });
  const fronts = listMarkdown(frontDirectory).map((name) => {
    const path = join(frontDirectory, name); const markdown = read(path, ''); const contract = parseFrontContract(markdown, { fallbackSlug: name.replace(/\.md$/, '') });
    return { kind: 'front', slug: contract.slug, path, relativePath: `.handraise/fronts/${name}`, markdown, contract };
  });
  return { components, fronts, product: readAcceptedProduct(repository) };
}

function componentUpdates(candidate) {
  return {
    title: candidate.title, state: candidate.state, order: candidate.order,
    purpose: candidate.contract.purpose, outcomes: candidate.contract.outcomes, responsibilities: candidate.contract.responsibilities,
    limits: candidate.contract.limits, invariants: candidate.contract.invariants, interfaces: candidate.contract.interfaces,
    dependencies: candidate.contract.dependencies, dataSystems: candidate.contract.dataSystems, territory: candidate.contract.territory,
    verification: candidate.contract.verification, evidence: candidate.contract.evidence, uncertainties: candidate.contract.uncertainties,
    guidance: candidate.contract.guidance,
  };
}

function frontUpdates(candidate) {
  return {
    title: candidate.title, state: candidate.state, component: candidate.leadComponent, affectedComponents: candidate.affectedComponents,
    goalIds: candidate.goalIds, analysisSnapshot: candidate.analysisSnapshot, outcome: candidate.outcome, motivation: candidate.motivation,
    scope: candidate.scope, nonGoals: candidate.nonGoals, readiness: candidate.readiness, acceptanceCriteria: candidate.acceptanceCriteria,
    verification: candidate.verification, deliverables: candidate.deliverables,
    risks: [...candidate.risks, ...candidate.unknowns.map((item) => `[Unknown] ${item}`)], dependencies: candidate.dependencies,
    evidence: candidate.evidence, context: candidate.context, handoff: candidate.handoff, tasks: candidate.tasks,
  };
}

function operation(kind, slug, relativePath, before, after) {
  const action = before === null ? 'create' : after === null ? 'delete' : 'update';
  return {
    id: `${kind}:${slug}`, kind, slug, action, relativePath,
    before, after, beforeRevision: before === null ? null : workContractRevision(before), afterRevision: after === null ? null : workContractRevision(after),
  };
}

function changedOperation(kind, slug, relativePath, before, after) {
  return before === after ? null : operation(kind, slug, relativePath, before, after);
}

function relationshipSnapshot(components, fronts) {
  return {
    components: components.map((item) => ({ slug: item.slug, dependencies: (item.contract?.dependencies || []).map((edge) => ({ kind: edge.kind, target: edge.target, reason: edge.reason })) })).sort((a, b) => a.slug.localeCompare(b.slug)),
    fronts: fronts.map((item) => ({ slug: item.slug, leadComponent: item.component, affectedComponents: item.affectedComponents || [], goalIds: item.goalIds || [], dependencies: (item.dependencies || []).map((edge) => ({ kind: edge.kind, target: edge.target, reason: edge.reason })) })).sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

function relationshipDiff(before, after) {
  const diff = (left, right) => {
    const leftBy = new Map(left.map((item) => [item.slug, item])); const rightBy = new Map(right.map((item) => [item.slug, item]));
    return [...new Set([...leftBy.keys(), ...rightBy.keys()])].sort().flatMap((slug) => {
      const prior = leftBy.get(slug) || null; const next = rightBy.get(slug) || null;
      return canonical(prior) === canonical(next) ? [] : [{ slug, action: !prior ? 'create' : !next ? 'delete' : 'update', before: prior, after: next }];
    });
  };
  return { components: diff(before.components, after.components), fronts: diff(before.fronts, after.fronts) };
}

function lifecycleDiagnostics(current, final, selection) {
  const diagnostics = [];
  const currentFronts = new Map(current.fronts.map((item) => [item.slug, item.contract]));
  const finalFronts = new Map(final.fronts.map((item) => [item.slug, item]));
  for (const [slug, before] of currentFronts) {
    const after = finalFronts.get(slug);
    if (before.state === 'done' && after && after.state !== 'done') diagnostics.push({ code: 'COMPLETED_FRONT_REGRESSION', severity: 'error', path: `fronts.${slug}.state`, message: `Completed front '${slug}' cannot return to ${after.state}.` });
    if (before.state === 'active' && after?.state === 'queued') diagnostics.push({ code: 'ACTIVE_FRONT_REGRESSION', severity: 'error', path: `fronts.${slug}.state`, message: `Active front '${slug}' cannot return to queued during publication.` });
    if (before.state === 'done' && !after && !selection.allowCompletedDeletes) diagnostics.push({ code: 'COMPLETED_FRONT_DELETE_REQUIRES_OVERRIDE', severity: 'error', path: `fronts.${slug}`, message: `Deleting completed front '${slug}' requires an explicit completed-evidence override.` });
  }
  return diagnostics;
}

function validateSnapshotFiles(repository, snapshot) {
  if (!snapshot?.manifest?.files) fail('PUBLICATION_SNAPSHOT_REQUIRED', 'the original analysis manifest is required for final publication revalidation');
  if (snapshot.scope?.limits) {
    let current;
    try { current = recaptureAnalysisManifest(repository, snapshot); }
    catch (error) {
      fail('PUBLICATION_SNAPSHOT_CHANGED', 'the reviewed repository scope could not be recaptured safely', { sourceCode: error?.code || null }, [], error);
    }
    if (current.digest !== snapshot.manifest.digest) {
      fail('PUBLICATION_SNAPSHOT_CHANGED', 'repository content or Git identity changed after planning', {
        expected: snapshot.manifest.digest, current: current.digest,
      });
    }
    return current;
  }
  const root = realpathSync(repository.path); const currentFiles = [];
  for (const expected of snapshot.manifest.files) {
    const absolute = resolve(root, ...expected.path.split('/'));
    if (!absolute.startsWith(`${root}${sep}`)) fail('PUBLICATION_SNAPSHOT_CHANGED', `snapshot path '${expected.path}' escapes the repository`);
    let details;
    try { details = lstatSync(absolute); } catch { fail('PUBLICATION_SNAPSHOT_CHANGED', `snapshot file '${expected.path}' is missing`); }
    if (!details.isFile() || details.isSymbolicLink()) fail('PUBLICATION_SNAPSHOT_CHANGED', `snapshot file '${expected.path}' is no longer a regular file`);
    const content = readFileSync(absolute); const digest = sha256(content);
    if (digest !== expected.digest || content.length !== expected.size) fail('PUBLICATION_SNAPSHOT_CHANGED', `snapshot file '${expected.path}' changed after planning`, { path: expected.path, expected: expected.digest, current: digest });
    currentFiles.push({ ...expected, digest, size: content.length });
  }
  const git = { ...snapshot.manifest.git };
  try {
    const run = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const head = run(['rev-parse', 'HEAD']) || null; const branch = run(['branch', '--show-current']) || null;
    if (git.head && head !== git.head) fail('PUBLICATION_SNAPSHOT_CHANGED', 'Git HEAD changed after planning', { expected: git.head, current: head });
    if (git.branch && branch !== git.branch) fail('PUBLICATION_SNAPSHOT_CHANGED', 'Git branch changed after planning', { expected: git.branch, current: branch });
    git.head = head; git.branch = branch;
  } catch (error) {
    if (error instanceof PlanPublicationError) throw error;
    if (snapshot.manifest.git.head) fail('PUBLICATION_SNAPSHOT_CHANGED', 'Git identity cannot be revalidated for this planned snapshot');
  }
  return createContentManifest({ files: currentFiles, git, selection: snapshot.manifest.selection });
}

function publicOperation(item) {
  const { path: _path, ...result } = item; return result;
}

function publicManifest(manifest) {
  const safe = clone(manifest);
  delete safe.privateSource;
  safe.operations = safe.operations.map(publicOperation);
  safe.expiresAt = new Date(safe.expiresAtMs).toISOString();
  delete safe.expiresAtMs;
  return deepFreeze(safe);
}

function calculateManifestRevision(manifest) {
  return sha256(canonical({
    id: manifest.id,
    publicationDigest: manifest.publicationDigest,
    operations: manifest.operations.map((item) => ({
      relativePath: item.relativePath,
      action: item.action,
      beforeRevision: item.beforeRevision,
      afterRevision: item.afterRevision,
    })),
    diagnostics: manifest.validation?.diagnostics || [],
  }));
}

export function buildPublicationManifest(repository, workspaceValue, selectionValue, {
  id = randomUUID(), now = Date.now(), actor: actorValue,
} = {}) {
  if (!repository?.id || !repository?.path) fail('PUBLICATION_REPOSITORY_REQUIRED', 'repository id and path are required');
  const actualAdapter = detectedAdapter(repository);
  if (actualAdapter === 'director' || repository.adapter === 'director') {
    fail('DIRECTOR_PUBLICATION_UNSUPPORTED', 'this Director repository does not advertise one validated atomic product/component/front publication capability; keep the workspace private');
  }
  if (repository.adapter && repository.adapter !== actualAdapter) fail('PUBLICATION_ADAPTER_CHANGED', `repository adapter changed from '${repository.adapter}' to '${actualAdapter}'`);
  const workspace = { ...workspaceValue, repositoryId: repository.id };
  const actor = normalizeActor(actorValue);
  const selection = normalizeSelection(selectionValue, workspace);
  const architecture = selectedArchitecture(workspace);
  const frontPlan = selection.includeFronts ? selectedFrontPlan(workspace, architecture) : null;
  const sourceRevision = publicationSourceRevision(workspace);
  if (sourceRevision.snapshotId !== workspace.snapshot?.id || sourceRevision.snapshotManifestDigest !== workspace.snapshot?.manifest?.digest) {
    fail('PUBLICATION_SNAPSHOT_MISMATCH', 'publication sources do not share the exact analysis snapshot and manifest');
  }

  const sourceDiagnostics = [];
  if (workspace.componentDraft.stale) sourceDiagnostics.push({ code: 'STALE_COMPONENT_DRAFT', severity: 'error', path: 'source.componentDraft', message: workspace.componentDraft.staleReasons?.join(' ') || 'The component draft is stale.' });
  if (workspace.componentDraft.state === 'skipped') sourceDiagnostics.push({ code: 'SKIPPED_COMPONENT_DRAFT', severity: 'error', path: 'source.componentDraft', message: 'Resume component review before publication.' });
  if (selection.includeFronts && workspace.frontDraft.stale) sourceDiagnostics.push({ code: 'STALE_FRONT_DRAFT', severity: 'error', path: 'source.frontDraft', message: workspace.frontDraft.staleReasons?.join(' ') || 'The front draft is stale.' });
  if (selection.includeFronts && workspace.frontDraft.state === 'skipped') sourceDiagnostics.push({ code: 'SKIPPED_FRONT_DRAFT', severity: 'error', path: 'source.frontDraft', message: 'Resume front-plan review before publication.' });
  if (selection.includeProduct && workspace.productDraft.stale) sourceDiagnostics.push({ code: 'STALE_PRODUCT_DRAFT', severity: 'error', path: 'source.productDraft', message: 'The accepted product baseline changed after this draft was created.' });
  if (workspace.snapshot.status !== 'complete' || workspace.snapshot.freshness?.state !== 'current') sourceDiagnostics.push({ code: 'STALE_ANALYSIS_SNAPSHOT', severity: 'error', path: 'source.snapshot', message: `Publication requires a complete current snapshot; source is ${workspace.snapshot.status}/${workspace.snapshot.freshness?.state}.` });
  if (!architecture.quality?.gateC?.pass) sourceDiagnostics.push({ code: 'COMPONENT_GATE_C_FAILED', severity: 'error', path: 'source.componentAlternative', message: 'The selected component alternative does not pass automated Gate C.' });
  if (frontPlan && !frontPlan.quality?.gateD?.pass) sourceDiagnostics.push({ code: 'FRONT_GATE_D_FAILED', severity: 'error', path: 'source.frontAlternative', message: 'The selected front portfolio does not pass automated Gate D.' });

  const current = actualAdapter === 'handraise' ? currentRecords(repository) : { components: [], fronts: [], product: { exists: false, brief: null, markdown: null, revision: null } };
  const operations = [];
  if (actualAdapter === 'uninitialized') {
    const project = `${JSON.stringify({ version: 1, name: repository.name || 'Handraise repository' }, null, 2)}\n`;
    const ignore = 'worktrees/\n.management-lock/\n.publication-transactions/\n';
    operations.push({ ...operation('project', 'project', '.handraise/project.json', null, project), path: relativeTarget(repository, '.handraise/project.json') });
    operations.push({ ...operation('metadata', 'gitignore', '.handraise/.gitignore', null, ignore), path: relativeTarget(repository, '.handraise/.gitignore') });
  } else {
    const ignorePath = relativeTarget(repository, '.handraise/.gitignore');
    const before = read(ignorePath, null);
    if (before !== null && !before.split(/\r?\n/).includes('.publication-transactions/')) {
      const after = `${before.replace(/\s*$/, '\n')}.publication-transactions/\n`;
      operations.push({ ...operation('metadata', 'gitignore', '.handraise/.gitignore', before, after), path: ignorePath });
    }
  }

  const currentComponentBySlug = new Map(current.components.map((item) => [item.slug, item]));
  const finalComponentBySlug = new Map(current.components.map((item) => [item.slug, item.contract]));
  const selectedComponentSlugs = new Set();
  for (const candidate of architecture.components) {
    if (!SLUG.test(candidate.slug) || selectedComponentSlugs.has(candidate.slug)) fail('DUPLICATE_PUBLICATION_DESTINATION', `component destination '${candidate.slug}' is invalid or duplicated`);
    selectedComponentSlugs.add(candidate.slug);
    const existing = currentComponentBySlug.get(candidate.slug) || null;
    const relativePath = existing?.relativePath || `.handraise/components/${candidate.slug}.md`;
    const before = existing?.markdown ?? null;
    const after = before === null
      ? createComponentMarkdown(candidate)
      : updateComponentMarkdown(migrateComponentMarkdown(before), componentUpdates(candidate));
    const contract = parseComponentContract(after, { fallbackSlug: candidate.slug });
    finalComponentBySlug.set(candidate.slug, contract);
    const changed = changedOperation('component', candidate.slug, relativePath, before, after);
    if (changed) operations.push({ ...changed, path: relativeTarget(repository, relativePath) });
  }
  if (selection.deleteAbsentComponents) for (const currentComponent of current.components) if (!selectedComponentSlugs.has(currentComponent.slug)) {
    finalComponentBySlug.delete(currentComponent.slug);
    operations.push({ ...operation('component', currentComponent.slug, currentComponent.relativePath, currentComponent.markdown, null), path: currentComponent.path });
  }

  const currentFrontBySlug = new Map(current.fronts.map((item) => [item.slug, item]));
  const finalFrontBySlug = new Map(current.fronts.map((item) => [item.slug, item.contract]));
  if (frontPlan) {
    const selectedFrontSlugs = new Set();
    for (const candidate of frontPlan.fronts) {
      if (!SLUG.test(candidate.slug) || selectedFrontSlugs.has(candidate.slug)) fail('DUPLICATE_PUBLICATION_DESTINATION', `front destination '${candidate.slug}' is invalid or duplicated`);
      selectedFrontSlugs.add(candidate.slug);
      const existing = currentFrontBySlug.get(candidate.slug) || null;
      const relativePath = existing?.relativePath || `.handraise/fronts/${candidate.slug}.md`;
      const before = existing?.markdown ?? null;
      const updates = frontUpdates(candidate);
      const after = before === null ? createFrontMarkdown({ ...candidate, ...updates }) : updateFrontMarkdown(migrateFrontMarkdown(before), updates);
      const contract = parseFrontContract(after, { fallbackSlug: candidate.slug });
      finalFrontBySlug.set(candidate.slug, contract);
      const changed = changedOperation('front', candidate.slug, relativePath, before, after);
      if (changed) operations.push({ ...changed, path: relativeTarget(repository, relativePath) });
    }
    if (selection.deleteAbsentFronts) for (const currentFront of current.fronts) if (!selectedFrontSlugs.has(currentFront.slug)) {
      finalFrontBySlug.delete(currentFront.slug);
      operations.push({ ...operation('front', currentFront.slug, currentFront.relativePath, currentFront.markdown, null), path: currentFront.path });
    }
  }

  let finalProduct = current.product.brief;
  if (selection.includeProduct) {
    if (workspace.productDraft.baselineRevision !== current.product.revision) sourceDiagnostics.push({ code: 'PRODUCT_BASELINE_CHANGED', severity: 'error', path: 'source.productDraft', message: 'product.md changed after the selected product draft was created.' });
    finalProduct = normalizeProductBrief(workspace.productDraft.brief, { repositoryId: repository.id, now });
    const before = current.product.markdown || null;
    const after = renderProductBrief(finalProduct, { existingMarkdown: before || '', repositoryId: repository.id, now });
    const changed = changedOperation('product', 'product', '.handraise/product.md', before, after);
    if (changed) operations.unshift({ ...changed, path: relativeTarget(repository, '.handraise/product.md') });
  }

  const finalComponents = [...finalComponentBySlug.values()].sort((left, right) => left.order - right.order || left.slug.localeCompare(right.slug));
  const finalFronts = [...finalFrontBySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug));
  const goalIds = finalProduct ? finalProduct.goals.map((goal) => goal.id) : [];
  const portfolioValidation = validatePortfolioContracts(finalComponents, finalFronts, { goalIds });
  const lifecycle = lifecycleDiagnostics(current, { components: finalComponents, fronts: finalFronts }, selection);
  const diagnostics = [...sourceDiagnostics, ...portfolioValidation.diagnostics, ...lifecycle];
  const destinations = new Set();
  for (const item of operations) {
    if (destinations.has(item.relativePath)) diagnostics.push({ code: 'DUPLICATE_PUBLICATION_DESTINATION', severity: 'error', path: item.relativePath, message: `Multiple artifacts target '${item.relativePath}'.` });
    destinations.add(item.relativePath);
  }

  const beforeRelationships = relationshipSnapshot(current.components.map((item) => item.contract), current.fronts.map((item) => item.contract));
  const afterRelationships = relationshipSnapshot(finalComponents, finalFronts);
  const relationships = relationshipDiff(beforeRelationships, afterRelationships);
  const createdAt = new Date(now).toISOString();
  const contentOperations = [...operations];
  const publicationDigest = sha256(canonical({
    schemaVersion: PLAN_PUBLICATION_SCHEMA_VERSION, repositoryId: repository.id, selection, sourceRevision,
    operations: contentOperations.map((item) => ({ kind: item.kind, slug: item.slug, action: item.action, relativePath: item.relativePath, beforeRevision: item.beforeRevision, afterRevision: item.afterRevision })), relationships,
  }));
  if (contentOperations.length) {
    const audit = {
      schemaVersion: 1, publicationId: id, publicationDigest, acceptedAt: createdAt, actor,
      repository: { id: repository.id, adapter: actualAdapter === 'uninitialized' ? 'handraise' : actualAdapter }, selection,
      sources: {
        componentDraft: { id: sourceRevision.componentDraftId, revision: sourceRevision.componentDraftRevision, alternativeId: sourceRevision.componentAlternativeId },
        frontDraft: sourceRevision.frontDraftId ? { id: sourceRevision.frontDraftId, revision: sourceRevision.frontDraftRevision, alternativeId: sourceRevision.frontAlternativeId } : null,
        productDraft: sourceRevision.productDraftId ? { id: sourceRevision.productDraftId, revision: sourceRevision.productDraftRevision } : null,
        analysis: { snapshotId: sourceRevision.snapshotId, manifestDigest: sourceRevision.snapshotManifestDigest, analyzer: workspace.snapshot.analyzer ? { id: workspace.snapshot.analyzer.id, version: workspace.snapshot.analyzer.version } : null },
      },
      artifacts: contentOperations.map((item) => ({ kind: item.kind, slug: item.slug, action: item.action, path: item.relativePath, beforeRevision: item.beforeRevision, afterRevision: item.afterRevision })),
      validation: { errors: diagnostics.filter((item) => item.severity === 'error').length, warnings: diagnostics.filter((item) => item.severity === 'warning').length },
    };
    const relativePath = `.handraise/publications/${id}.json`; const after = `${JSON.stringify(audit, null, 2)}\n`;
    operations.push({ ...operation('audit', id, relativePath, null, after), path: relativeTarget(repository, relativePath) });
  }
  const totalBytes = operations.reduce((sum, item) => sum + Buffer.byteLength(item.before || '') + Buffer.byteLength(item.after || ''), 0);
  if (totalBytes > 12 * 1024 * 1024) fail('PUBLICATION_DIFF_TOO_LARGE', 'publication preview exceeds the 12 MiB exact-diff budget');
  const revision = calculateManifestRevision({ id, publicationDigest, operations, validation: { diagnostics } });
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  return {
    schemaVersion: PLAN_PUBLICATION_SCHEMA_VERSION, id, repositoryId: repository.id, adapter: actualAdapter,
    state: 'review', createdAt, updatedAt: createdAt, expiresAtMs: now + PLAN_PUBLICATION_TTL_MS,
    selection, actor, source: {
      ...sourceRevision,
      analyzer: workspace.snapshot.analyzer ? { id: workspace.snapshot.analyzer.id, version: workspace.snapshot.analyzer.version } : null,
    },
    privateSource: { snapshot: workspace.snapshot, sourceRevision },
    publicationDigest, revision, noOp: contentOperations.length === 0, canPublish: contentOperations.length > 0 && errors === 0,
    summary: {
      creates: contentOperations.filter((item) => item.action === 'create').length,
      updates: contentOperations.filter((item) => item.action === 'update').length,
      deletes: contentOperations.filter((item) => item.action === 'delete').length,
      files: contentOperations.length, bytes: totalBytes, errors, warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    },
    validation: { valid: errors === 0, diagnostics, portfolio: portfolioValidation.summary }, relationships,
    operations, result: null,
  };
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function contentAt(path) {
  try {
    const details = lstatSync(path);
    if (details.isSymbolicLink() || !details.isFile()) fail('UNSAFE_PUBLICATION_PATH', `publication target '${path}' is not a regular file`);
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function modeAt(path, fallback = 0o644) {
  try { return statSync(path).mode & 0o777; } catch { return fallback; }
}

function targetMode(operationValue) {
  if (operationValue.kind === 'audit') return 0o600;
  return 0o644;
}

function assertSafeTarget(repository, relativePath, { createParents = false } = {}) {
  const root = realpathSync(repository.path);
  const target = relativeTarget(repository, relativePath);
  const segments = relativePath.split('/');
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    try {
      const details = lstatSync(cursor);
      if (details.isSymbolicLink() || !details.isDirectory()) fail('UNSAFE_PUBLICATION_PATH', `publication parent '${segment}' is not a regular directory`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (createParents) {
        mkdirSync(cursor, { mode: 0o755 });
        syncDirectory(dirname(cursor));
      }
    }
  }
  try {
    const details = lstatSync(target);
    if (details.isSymbolicLink() || !details.isFile()) fail('UNSAFE_PUBLICATION_PATH', `publication target '${relativePath}' is not a regular file`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

function verifyManifestIntegrity(repository, manifest) {
  if (!manifest || manifest.schemaVersion !== PLAN_PUBLICATION_SCHEMA_VERSION || !PREVIEW_ID.test(String(manifest.id || '')) || manifest.repositoryId !== repository.id) {
    fail('PUBLICATION_PREVIEW_NOT_FOUND', 'publication preview does not belong to this repository');
  }
  const destinations = new Set();
  for (const item of manifest.operations || []) {
    const expectedPath = relativeTarget(repository, item.relativePath);
    if (item.path !== expectedPath) fail('PUBLICATION_PREVIEW_CORRUPT', `stored target for '${item.relativePath}' is inconsistent`);
    if (destinations.has(item.relativePath)) fail('PUBLICATION_PREVIEW_CORRUPT', `stored publication repeats '${item.relativePath}'`);
    destinations.add(item.relativePath);
    const action = item.before === null ? 'create' : item.after === null ? 'delete' : 'update';
    if (action !== item.action
      || (item.before === null ? null : workContractRevision(item.before)) !== item.beforeRevision
      || (item.after === null ? null : workContractRevision(item.after)) !== item.afterRevision) {
      fail('PUBLICATION_PREVIEW_CORRUPT', `stored bytes for '${item.relativePath}' do not match their fingerprints`);
    }
  }
  if (calculateManifestRevision(manifest) !== manifest.revision) fail('PUBLICATION_PREVIEW_CORRUPT', 'publication preview fingerprint does not match its reviewed manifest');
}

function baselineState(repository, manifest) {
  let before = 0; let after = 0;
  const mixed = [];
  for (const operationValue of manifest.operations) {
    const target = assertSafeTarget(repository, operationValue.relativePath);
    const current = contentAt(target);
    const atBefore = current === operationValue.before;
    const atAfter = current === operationValue.after;
    if (atBefore) before += 1;
    if (atAfter) after += 1;
    if (!atBefore && !atAfter) mixed.push({ path: operationValue.relativePath, currentRevision: current === null ? null : workContractRevision(current) });
  }
  return {
    allBefore: before === manifest.operations.length,
    allAfter: after === manifest.operations.length,
    mixed,
  };
}

function validateRenderedManifest(repository, manifest) {
  const accepted = currentRecords(repository);
  const componentFiles = new Map(accepted.components.map((item) => [item.relativePath, item.markdown]));
  const frontFiles = new Map(accepted.fronts.map((item) => [item.relativePath, item.markdown]));
  let productMarkdown = accepted.product.markdown;
  for (const item of manifest.operations) {
    if (item.kind === 'component') {
      if (item.after === null) componentFiles.delete(item.relativePath); else componentFiles.set(item.relativePath, item.after);
    } else if (item.kind === 'front') {
      if (item.after === null) frontFiles.delete(item.relativePath); else frontFiles.set(item.relativePath, item.after);
    } else if (item.kind === 'product') productMarkdown = item.after;
  }
  const components = [...componentFiles.entries()].map(([path, markdown]) => parseComponentContract(markdown, { fallbackSlug: path.split('/').at(-1).replace(/\.md$/, '') }));
  const fronts = [...frontFiles.entries()].map(([path, markdown]) => parseFrontContract(markdown, { fallbackSlug: path.split('/').at(-1).replace(/\.md$/, '') }));
  const brief = productMarkdown ? parseProductBrief(productMarkdown, { repositoryId: repository.id }) : null;
  const validation = validatePortfolioContracts(components, fronts, { goalIds: brief?.goals.map((goal) => goal.id) || [] });
  if (!validation.valid) fail('PUBLICATION_VALIDATION_CHANGED', 'the exact rendered portfolio no longer passes final validation', { summary: validation.summary }, validation.diagnostics);
  return validation;
}

function atomicReplace(path, content, { mode = 0o644, beforeRename = null, afterRename = null } = {}) {
  const temporary = `${path}.publication-${process.pid}-${randomUUID()}`;
  try {
    durableWrite(temporary, content, { mode, exclusive: true });
    beforeRename?.();
    renameSync(temporary, path);
    afterRename?.();
    chmodSync(path, mode);
    syncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function lockOwner(lock) { return readJson(join(lock, 'owner.json')); }

function acquirePublicationLock(repository, previewId, { initialized }) {
  const lock = initialized
    ? join(repository.path, '.handraise', '.management-lock')
    : join(repository.path, '.handraise-publication.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const owner = {
        schemaVersion: 1, kind: 'plan-publication', token, previewId,
        seal: processSeal(), pid: process.pid, acquiredAt: new Date().toISOString(),
      };
      try { durableWrite(join(lock, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600, exclusive: true }); }
      catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      return {
        lock, owner,
        release() {
          if (lockOwner(lock)?.token === token) {
            rmSync(lock, { recursive: true, force: true });
            syncDirectory(dirname(lock));
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = lockOwner(lock);
      if (attempt === 0 && owner?.kind === 'plan-publication' && owner.seal && !procAlive(owner.seal)) {
        rmSync(lock, { recursive: true, force: true });
        syncDirectory(dirname(lock));
        continue;
      }
      fail('PUBLICATION_BUSY', 'another Handraise project update is finishing; try again in a moment', {
        owner: owner ? { kind: owner.kind, previewId: owner.previewId || null, acquiredAt: owner.acquiredAt || null } : null,
      });
    }
  }
  fail('PUBLICATION_BUSY', 'another Handraise project update is finishing; try again in a moment');
}

function transactionDirectory(repository, previewId) {
  return join(repository.path, '.handraise', '.publication-transactions', previewId);
}

function journalPath(transaction) { return join(transaction, 'journal.json'); }

function saveJournal(transaction, journal) {
  journal.updatedAt = new Date().toISOString();
  atomicPrivateJson(journalPath(transaction), journal);
}

function transactionContent(transaction, side, index) {
  const path = join(transaction, side, `${index}.content`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function rollbackTransaction(repository, transaction, journal) {
  const conflicts = [];
  journal.state = 'rolling-back'; saveJournal(transaction, journal);
  for (let index = journal.operations.length - 1; index >= 0; index -= 1) {
    const entry = journal.operations[index];
    const target = assertSafeTarget(repository, entry.relativePath, { createParents: true });
    const before = transactionContent(transaction, 'before', index);
    const after = transactionContent(transaction, 'after', index);
    const current = contentAt(target);
    try {
      if (entry.action === 'create') {
        if (current === null) continue;
        if (current !== after) { conflicts.push(entry.relativePath); continue; }
        rmSync(target, { force: true }); syncDirectory(dirname(target));
      } else if (entry.action === 'update') {
        if (current === before) continue;
        if (current !== after || before === null) { conflicts.push(entry.relativePath); continue; }
        atomicReplace(target, before, { mode: entry.beforeMode || 0o644 });
      } else if (entry.action === 'delete') {
        if (current === before) continue;
        if (current !== null || before === null) { conflicts.push(entry.relativePath); continue; }
        atomicReplace(target, before, { mode: entry.beforeMode || 0o644 });
      }
      entry.status = 'rolled-back'; saveJournal(transaction, journal);
    } catch {
      conflicts.push(entry.relativePath);
    }
  }
  if (conflicts.length) {
    journal.state = 'recovery-required'; journal.conflicts = [...new Set(conflicts)]; saveJournal(transaction, journal);
    fail('PUBLICATION_RECOVERY_REQUIRED', `publication rollback preserved conflicting files and needs manual recovery: ${journal.conflicts.join(', ')}`, { transaction, conflicts: journal.conflicts });
  }
  journal.state = 'rolled-back'; saveJournal(transaction, journal);
  rmSync(transaction, { recursive: true, force: true });
  syncDirectory(dirname(transaction));
  return { previewId: journal.previewId, outcome: 'rolled-back' };
}

function recoverTransactionsLocked(repository) {
  const root = join(repository.path, '.handraise', '.publication-transactions');
  if (!existsSync(root)) return [];
  const recovered = [];
  for (const name of readdirSync(root).sort()) {
    if (!PREVIEW_ID.test(name)) continue;
    const transaction = join(root, name);
    const journal = readJson(journalPath(transaction));
    if (!journal) {
      rmSync(transaction, { recursive: true, force: true });
      recovered.push({ previewId: name, outcome: 'discarded-incomplete-staging' });
      continue;
    }
    if (journal.state === 'committed') {
      const complete = journal.operations.every((entry, index) => {
        const target = assertSafeTarget(repository, entry.relativePath);
        return contentAt(target) === transactionContent(transaction, 'after', index);
      });
      if (!complete) fail('PUBLICATION_RECOVERY_REQUIRED', `committed publication '${name}' no longer matches its journal`, { transaction });
      rmSync(transaction, { recursive: true, force: true });
      recovered.push({ previewId: name, outcome: 'committed' });
      continue;
    }
    if (journal.state === 'rolled-back') {
      rmSync(transaction, { recursive: true, force: true });
      recovered.push({ previewId: name, outcome: 'rolled-back' });
      continue;
    }
    recovered.push(rollbackTransaction(repository, transaction, journal));
  }
  try { if (!readdirSync(root).length) rmSync(root, { recursive: true, force: true }); } catch { /* keep non-empty recovery evidence */ }
  return recovered;
}

function stageTransaction(repository, manifest) {
  const transaction = transactionDirectory(repository, manifest.id);
  const parent = ensurePrivateDirectory(dirname(transaction));
  if (existsSync(transaction)) fail('PUBLICATION_RECOVERY_REQUIRED', `an unfinished transaction already exists for publication '${manifest.id}'`);
  mkdirSync(transaction, { mode: 0o700 });
  mkdirSync(join(transaction, 'before'), { mode: 0o700 });
  mkdirSync(join(transaction, 'after'), { mode: 0o700 });
  const journal = {
    schemaVersion: 1, previewId: manifest.id, publicationDigest: manifest.publicationDigest,
    state: 'staging', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    operations: [],
  };
  try {
    for (const [index, operationValue] of manifest.operations.entries()) {
      const target = assertSafeTarget(repository, operationValue.relativePath);
      const current = contentAt(target);
      if (current !== operationValue.before) fail('PUBLICATION_BASELINE_CHANGED', `${operationValue.relativePath} changed after preview`, {
        path: operationValue.relativePath, expectedRevision: operationValue.beforeRevision,
        currentRevision: current === null ? null : workContractRevision(current),
      });
      const beforeMode = current === null ? null : modeAt(target);
      if (operationValue.before !== null) durableWrite(join(transaction, 'before', `${index}.content`), operationValue.before, { mode: 0o600, exclusive: true });
      if (operationValue.after !== null) durableWrite(join(transaction, 'after', `${index}.content`), operationValue.after, { mode: 0o600, exclusive: true });
      journal.operations.push({
        relativePath: operationValue.relativePath, action: operationValue.action,
        beforeRevision: operationValue.beforeRevision, afterRevision: operationValue.afterRevision,
        beforeMode, afterMode: operationValue.action === 'create' ? targetMode(operationValue) : beforeMode,
        status: 'staged',
      });
    }
    journal.state = 'prepared'; saveJournal(transaction, journal); syncDirectory(transaction); syncDirectory(parent);
    return { transaction, journal };
  } catch (error) {
    rmSync(transaction, { recursive: true, force: true });
    throw error;
  }
}

function applyTransaction(repository, transaction, journal, fault) {
  journal.state = 'committing'; saveJournal(transaction, journal);
  try {
    fault?.('after-stage', { previewId: journal.previewId });
    for (const [index, entry] of journal.operations.entries()) {
      const target = assertSafeTarget(repository, entry.relativePath, { createParents: true });
      const before = transactionContent(transaction, 'before', index);
      const after = transactionContent(transaction, 'after', index);
      if (contentAt(target) !== before) fail('PUBLICATION_BASELINE_CHANGED', `${entry.relativePath} changed while the publication was staged`, { path: entry.relativePath });
      entry.status = 'applying'; journal.applyingIndex = index; saveJournal(transaction, journal);
      fault?.('before-operation', { previewId: journal.previewId, index, operation: clone(entry) });
      if (entry.action === 'delete') {
        rmSync(target, { force: true }); syncDirectory(dirname(target));
      } else {
        const faultContext = { previewId: journal.previewId, index, operation: clone(entry) };
        atomicReplace(target, after, {
          mode: entry.afterMode || 0o644,
          beforeRename: () => fault?.('before-target-rename', faultContext),
          afterRename: () => fault?.('after-target-rename', faultContext),
        });
      }
      if (contentAt(target) !== after) fail('PUBLICATION_WRITE_UNVERIFIED', `could not verify '${entry.relativePath}' after publication`);
      entry.status = 'applied'; journal.applyingIndex = null; saveJournal(transaction, journal);
      fault?.('after-operation', { previewId: journal.previewId, index, operation: clone(entry) });
    }
    fault?.('before-commit', { previewId: journal.previewId });
    journal.state = 'committed'; journal.committedAt = new Date().toISOString(); saveJournal(transaction, journal);
    return journal;
  } catch (error) {
    if (error?.simulateCrash === true || error?.code === 'SIMULATED_CRASH') throw error;
    try { rollbackTransaction(repository, transaction, journal); }
    catch (rollbackError) {
      if (rollbackError instanceof PlanPublicationError) throw rollbackError;
      fail('PUBLICATION_RECOVERY_REQUIRED', 'publication failed and its rollback could not be verified', { transaction }, [], rollbackError);
    }
    throw error;
  }
}

function initializeFromManifest(repository, manifest, fault, lockOwnerValue) {
  const target = join(repository.path, '.handraise');
  const staging = join(repository.path, `.handraise.publish-${manifest.id}`);
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  let renamed = false;
  try {
    mkdirSync(staging, { mode: 0o755 });
    mkdirSync(join(staging, 'components'), { mode: 0o755 });
    mkdirSync(join(staging, 'fronts'), { mode: 0o755 });
    const internalLock = join(staging, '.management-lock');
    mkdirSync(internalLock, { mode: 0o700 });
    durableWrite(join(internalLock, 'owner.json'), `${JSON.stringify(lockOwnerValue, null, 2)}\n`, { mode: 0o600, exclusive: true });
    for (const operationValue of manifest.operations) {
      if (operationValue.action !== 'create' || operationValue.after === null) fail('PUBLICATION_PREVIEW_CORRUPT', 'uninitialized publication may contain only create operations');
      const relative = operationValue.relativePath.slice('.handraise/'.length);
      const destination = join(staging, ...relative.split('/'));
      let cursor = staging;
      for (const segment of relative.split('/').slice(0, -1)) {
        cursor = join(cursor, segment);
        if (!existsSync(cursor)) { mkdirSync(cursor, { mode: 0o755 }); syncDirectory(dirname(cursor)); }
      }
      durableWrite(destination, operationValue.after, { mode: targetMode(operationValue), exclusive: true });
    }
    syncDirectory(staging);
    fault?.('after-initialize-stage', { previewId: manifest.id });
    if (existsSync(target)) fail('PUBLICATION_BASELINE_CHANGED', 'repository metadata appeared while the complete plan was staged; nothing was overwritten');
    fault?.('before-initialize-rename', { previewId: manifest.id });
    renameSync(staging, target); renamed = true; syncDirectory(repository.path);
    fault?.('after-initialize-rename', { previewId: manifest.id });
    rmSync(join(target, '.management-lock'), { recursive: true, force: true }); syncDirectory(target);
    return;
  } catch (error) {
    if (renamed && !(error?.simulateCrash === true || error?.code === 'SIMULATED_CRASH')) {
      const exact = manifest.operations.every((operationValue) => contentAt(relativeTarget(repository, operationValue.relativePath)) === operationValue.after);
      if (exact) {
        rmSync(join(target, '.management-lock'), { recursive: true, force: true });
        renameSync(target, staging); renamed = false; syncDirectory(repository.path);
      } else {
        fail('PUBLICATION_RECOVERY_REQUIRED', 'native initialization completed but changed before rollback could prove ownership; repository metadata was preserved', { target }, [], error);
      }
    }
    if (!renamed) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function committedResult(manifest, actor, committedAt = new Date().toISOString()) {
  return {
    committed: true, publicationId: manifest.id, publicationDigest: manifest.publicationDigest,
    committedAt, actor, summary: clone(manifest.summary),
    auditPath: manifest.operations.find((item) => item.kind === 'audit')?.relativePath || null,
    artifacts: manifest.operations.filter((item) => item.kind !== 'audit').map((item) => ({
      kind: item.kind, slug: item.slug, action: item.action, path: item.relativePath, revision: item.afterRevision,
    })),
  };
}

function conflictCode(code) {
  return /(?:BASELINE|REVISION|SOURCE|SNAPSHOT|ADAPTER|ACTOR|CORRUPT|MISMATCH|RECOVERY)/.test(String(code || ''));
}

export class PlanPublicationStore {
  constructor({ root, now = () => Date.now(), ttlMs = PLAN_PUBLICATION_TTL_MS, fault = null } = {}) {
    if (!root) fail('PUBLICATION_STORE_ROOT_REQUIRED', 'publication preview storage root is required');
    this.root = ensurePrivateDirectory(root); this.now = now; this.ttlMs = ttlMs; this.fault = fault; this.cleanup();
  }

  #path(id) {
    if (!PREVIEW_ID.test(String(id || ''))) fail('PUBLICATION_PREVIEW_NOT_FOUND', 'publication preview not found');
    return join(this.root, `${id}.json`);
  }

  #load(repository, id) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(this.#path(id), 'utf8')); }
    catch (error) { if (error instanceof PlanPublicationError) throw error; fail('PUBLICATION_PREVIEW_NOT_FOUND', 'publication preview not found'); }
    if (manifest.repositoryId !== repository.id) fail('PUBLICATION_PREVIEW_NOT_FOUND', 'publication preview does not belong to this repository');
    if (manifest.expiresAtMs <= this.now()) { rmSync(this.#path(id), { force: true }); fail('PUBLICATION_PREVIEW_EXPIRED', 'publication preview expired; prepare a current review'); }
    verifyManifestIntegrity(repository, manifest);
    return manifest;
  }

  #save(manifest, { refreshExpiry = true } = {}) {
    manifest.updatedAt = new Date(this.now()).toISOString();
    if (refreshExpiry) manifest.expiresAtMs = this.now() + this.ttlMs;
    atomicPrivateJson(this.#path(manifest.id), manifest);
    return manifest;
  }

  cleanup() {
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.root, name);
      const manifest = readJson(path);
      if (!manifest?.expiresAtMs || manifest.expiresAtMs <= this.now()) rmSync(path, { force: true });
    }
  }

  create(repository, workspace, selection, { actor } = {}) {
    this.cleanup();
    const manifest = buildPublicationManifest(repository, workspace, selection, { id: randomUUID(), now: this.now(), actor });
    manifest.expiresAtMs = this.now() + this.ttlMs;
    this.#save(manifest);
    return publicManifest(manifest);
  }

  list(repository) {
    this.cleanup();
    return readdirSync(this.root).filter((name) => name.endsWith('.json')).flatMap((name) => {
      const manifest = readJson(join(this.root, name));
      if (!manifest || manifest.repositoryId !== repository.id) return [];
      try { verifyManifestIntegrity(repository, manifest); return [publicManifest(manifest)]; } catch { return []; }
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(repository, id) { return publicManifest(this.#load(repository, id)); }

  discard(repository, id) {
    const manifest = this.#load(repository, id);
    if (manifest.state === 'committing') fail('PUBLICATION_BUSY', 'a committing publication cannot be discarded');
    rmSync(this.#path(id), { force: true });
    return { discarded: id };
  }

  discardRepository(repositoryId) {
    this.cleanup();
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.root, name); const manifest = readJson(path);
      if (manifest?.repositoryId === repositoryId) rmSync(path, { force: true });
    }
  }

  recover(repository) {
    if (detectedAdapter(repository) !== 'handraise') return { recovered: [] };
    const lock = acquirePublicationLock(repository, 'recovery', { initialized: true });
    try {
      const recovered = recoverTransactionsLocked(repository);
      for (const outcome of recovered) {
        const path = join(this.root, `${outcome.previewId}.json`); const manifest = readJson(path);
        if (!manifest || manifest.repositoryId !== repository.id) continue;
        if (outcome.outcome === 'committed') {
          manifest.state = 'committed'; manifest.failure = null;
          manifest.result ||= committedResult(manifest, manifest.actor, new Date(this.now()).toISOString());
        } else {
          manifest.state = 'failed';
          manifest.failure = { code: 'PUBLICATION_RECOVERED_ROLLBACK', message: 'An interrupted publication was rolled back during recovery; prepare a fresh preview before retrying.', at: new Date(this.now()).toISOString(), recoveryRequired: false };
        }
        this.#save(manifest);
      }
      return { recovered };
    }
    finally { lock.release(); }
  }

  commit(repository, id, { expectedRevision, confirmed = false, actor: actorValue, sourceCheck } = {}) {
    const manifest = this.#load(repository, id);
    const actor = normalizeActor(actorValue);
    if (actor.id !== manifest.actor.id || actor.authority !== manifest.actor.authority) fail('PUBLICATION_ACTOR_CHANGED', 'the authenticated client that reviewed this publication must confirm it');
    if (manifest.state === 'committed' && manifest.result) return deepFreeze(clone(manifest.result));
    if (inline(expectedRevision, 128) !== manifest.revision) fail('PUBLICATION_REVISION_CONFLICT', 'publication preview changed; review the current exact diff before confirming');
    if (!confirmed) fail('PUBLICATION_CONFIRMATION_REQUIRED', 'explicit confirmation of this exact publication revision is required');
    if (!manifest.canPublish || manifest.noOp) fail('PUBLICATION_NOT_READY', manifest.noOp ? 'there are no accepted changes to publish' : 'resolve every blocking publication diagnostic before confirming', null, manifest.validation.diagnostics);
    verifyManifestIntegrity(repository, manifest);

    const initialState = baselineState(repository, manifest);
    if (initialState.allAfter) {
      manifest.state = 'committed'; manifest.result = committedResult(manifest, actor);
      this.#save(manifest); return deepFreeze(clone(manifest.result));
    }
    if (!initialState.allBefore) fail('PUBLICATION_BASELINE_CHANGED', 'accepted files no longer match this preview', { files: initialState.mixed });

    const actualAdapter = detectedAdapter(repository);
    if (manifest.adapter === 'handraise' && actualAdapter !== 'handraise') fail('PUBLICATION_ADAPTER_CHANGED', `repository adapter changed from 'handraise' to '${actualAdapter}'`);
    if (manifest.adapter === 'uninitialized' && actualAdapter !== 'uninitialized') fail('PUBLICATION_ADAPTER_CHANGED', `repository was initialized after this preview as '${actualAdapter}'`);
    if (typeof sourceCheck !== 'function') fail('PUBLICATION_SOURCE_CHECK_REQUIRED', 'final publication requires an under-lock source revision check');

    const lock = acquirePublicationLock(repository, manifest.id, { initialized: manifest.adapter === 'handraise' });
    let transaction = null; let committed = false; let simulatedCrash = false;
    try {
      if (manifest.adapter === 'handraise') recoverTransactionsLocked(repository);
      const lockedAdapter = detectedAdapter(repository);
      if (lockedAdapter !== manifest.adapter) fail('PUBLICATION_ADAPTER_CHANGED', `repository adapter changed from '${manifest.adapter}' to '${lockedAdapter}' while publication was waiting for its lock`);
      const underLockState = baselineState(repository, manifest);
      if (underLockState.allAfter) {
        manifest.state = 'committed'; manifest.result = committedResult(manifest, actor);
        this.#save(manifest); return deepFreeze(clone(manifest.result));
      }
      if (!underLockState.allBefore) fail('PUBLICATION_BASELINE_CHANGED', 'accepted files changed while publication was waiting for its lock', { files: underLockState.mixed });
      const currentSource = sourceCheck();
      if (currentSource && typeof currentSource.then === 'function') fail('PUBLICATION_SOURCE_CHECK_INVALID', 'publication source checks must complete synchronously under the repository lock');
      if (canonical(currentSource) !== canonical(manifest.privateSource.sourceRevision)) fail('PUBLICATION_SOURCE_CHANGED', 'one or more reviewed private planning sources changed; prepare a fresh publication preview', { expected: manifest.privateSource.sourceRevision, current: currentSource });
      const currentManifest = validateSnapshotFiles(repository, manifest.privateSource.snapshot);
      if (currentManifest.digest !== manifest.source.snapshotManifestDigest) fail('PUBLICATION_SNAPSHOT_CHANGED', 'analysis manifest changed after publication review');
      if (manifest.adapter === 'handraise') validateRenderedManifest(repository, manifest);
      manifest.state = 'committing'; manifest.failure = null; this.#save(manifest);

      if (manifest.adapter === 'uninitialized') {
        initializeFromManifest(repository, manifest, this.fault, lock.owner);
      } else {
        ({ transaction } = stageTransaction(repository, manifest));
        const journal = readJson(journalPath(transaction));
        applyTransaction(repository, transaction, journal, this.fault);
      }
      committed = true;
      manifest.state = 'committed'; manifest.result = committedResult(manifest, actor, new Date(this.now()).toISOString());
      this.#save(manifest);
      if (transaction) { rmSync(transaction, { recursive: true, force: true }); syncDirectory(dirname(transaction)); }
      return deepFreeze(clone(manifest.result));
    } catch (error) {
      simulatedCrash = error?.simulateCrash === true || error?.code === 'SIMULATED_CRASH';
      if (!committed) {
        manifest.state = simulatedCrash ? 'committing' : conflictCode(error?.code) ? 'conflict' : 'failed';
        manifest.failure = { code: inline(error?.code || 'PUBLICATION_FAILED', 128), message: inline(error?.message || error, 1_000), at: new Date(this.now()).toISOString(), recoveryRequired: error?.code === 'PUBLICATION_RECOVERY_REQUIRED' };
        try { this.#save(manifest); } catch { /* repository transaction evidence remains authoritative */ }
      }
      throw error;
    } finally {
      if (simulatedCrash && manifest.adapter === 'uninitialized') {
        rmSync(join(repository.path, '.handraise', '.management-lock'), { recursive: true, force: true });
      }
      lock.release();
    }
  }
}
