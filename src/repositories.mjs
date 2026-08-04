import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { procAlive } from './state.mjs';
import {
  WorkContractError,
  assertPortfolioContracts,
  createComponentMarkdown,
  createFrontMarkdown,
  migrateComponentMarkdown,
  migrateFrontMarkdown,
  parseComponentContract,
  parseFrontContract,
  updateComponentMarkdown,
  updateFrontMarkdown,
  validatePortfolioContracts,
  workContractRevision,
} from './work-contracts.mjs';

const read = (path, fallback = '') => {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
};

export function repositoryAvailability(path) {
  try {
    if (!statSync(path).isDirectory()) {
      return {
        available: false, kind: 'invalid',
        detail: 'The configured repository path is no longer a directory.',
        recovery: 'Open Settings, disconnect this entry, and reconnect the repository at its current path.',
      };
    }
    accessSync(path, constants.R_OK | constants.X_OK);
    return { available: true, kind: 'available', detail: null, recovery: null };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return {
      available: false,
      kind: missing ? 'missing' : 'unreadable',
      detail: missing
        ? 'The configured repository path is missing or has moved.'
        : `The server cannot read the configured repository path${error?.code ? ` (${error.code})` : ''}.`,
      recovery: missing
        ? 'Open Settings, disconnect this entry, and reconnect the repository at its current path.'
        : 'Restore read and directory-traversal permission for the server user, then retry.',
    };
  }
}

function listMarkdown(directory) {
  try { return readdirSync(directory).filter((name) => name.endsWith('.md')).sort(); }
  catch { return []; }
}

function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function withNativeLock(repository, operation) {
  const runtime = join(repository.path, '.handraise');
  const lock = join(runtime, '.management-lock');
  mkdirSync(runtime, { recursive: true });
  try { mkdirSync(lock); } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('another Handraise project update is finishing; try again in a moment');
    throw error;
  }
  try { return operation(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function directorHelper(repository, script, action, payload) {
  const helper = join(repository.path, 'scripts', 'director', script);
  if (!existsSync(helper)) {
    throw new Error(`this Director repository is read-only in Handraise because ${script} is not available`);
  }
  const temporary = mkdtempSync(join(tmpdir(), 'handraise-director-'));
  const proposal = join(temporary, 'operation.json');
  try {
    writeFileSync(proposal, JSON.stringify(payload), { mode: 0o600 });
    const output = execFileSync(process.execPath, [helper, action, '--root', repository.path, '--from', proposal], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    return JSON.parse(output);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().replace(/^\[director\]\s*/i, '');
    throw new Error(detail || 'Director rejected the operation');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function mutationCapabilities(repository) {
  if (repository.adapter !== 'director') {
    return {
      components: true, frontCreate: true, frontEdit: true, frontDelete: true,
      workContracts: {
        componentReadVersions: [1, 2], frontReadVersions: [1, 2], writeVersion: 2,
        componentEdit: true, frontEdit: true, migrate: true, plan: true, preservesUnknown: true,
      },
    };
  }
  const componentHelper = existsSync(join(repository.path, 'scripts/director/components.mjs'));
  const frontHelper = existsSync(join(repository.path, 'scripts/director/fronts.mjs'));
  return {
    components: componentHelper,
    frontCreate: frontHelper,
    frontEdit: false,
    frontDelete: false,
    workContracts: {
      componentReadVersions: [1, 2], frontReadVersions: [1, 2], writeVersion: null,
      componentEdit: componentHelper, frontEdit: false, migrate: false,
      plan: frontHelper, preservesUnknown: false,
    },
  };
}

function unavailableMutationCapabilities() {
  return {
    components: false, frontCreate: false, frontEdit: false, frontDelete: false,
    workContracts: {
      componentReadVersions: [], frontReadVersions: [], writeVersion: null,
      componentEdit: false, frontEdit: false, migrate: false, plan: false, preservesUnknown: false,
    },
  };
}

function parseComponent(path, fallbackSlug) {
  const markdown = read(path);
  return { ...parseComponentContract(markdown, { fallbackSlug }), revision: workContractRevision(markdown) };
}

function componentSlug(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'component';
}

function cleanMultiline(value, limit = 2_000) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function normalizeNativeComponent(details, { requireComplete = false, index = 0 } = {}) {
  const title = String(details?.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw new Error(`component ${index + 1} needs a title`);
  const requestedSlug = String(details?.slug || '').trim();
  const slug = componentSlug(requestedSlug || title);
  if (requestedSlug && requestedSlug !== slug) {
    throw new Error(`component '${title}' needs a lowercase kebab-case slug`);
  }
  const fields = {
    scope: cleanMultiline(details?.purpose || details?.scope),
    limits: cleanMultiline(details?.limits),
    delegation: cleanMultiline(details?.guidance || details?.delegation),
    territory: cleanMultiline(details?.territory),
  };
  if (!fields.scope) throw new Error(`component '${slug}' needs a scope`);
  if (requireComplete) {
    for (const [field, value] of Object.entries(fields)) {
      if (!value) throw new Error(`component '${slug}' needs ${field}`);
    }
  }
  const numericOrder = Number(details?.order);
  const order = Number.isInteger(numericOrder) && numericOrder > 0 && numericOrder <= 999 ? numericOrder : index + 1;
  if (requireComplete && numericOrder !== order) {
    throw new Error(`component '${slug}' needs an integer order between 1 and 999`);
  }
  const evidence = Array.isArray(details?.evidence) ? details.evidence.map((item) => ({
    kind: item?.kind || item?.provenance || 'extracted',
    reference: item?.reference || item?.path || 'unresolved:evidence',
    reason: item?.reason || '',
  })) : [];
  return {
    slug, title, order, ...fields,
    outcomes: Array.isArray(details?.outcomes) ? details.outcomes : [],
    responsibilities: Array.isArray(details?.responsibilities) ? details.responsibilities : [],
    invariants: Array.isArray(details?.invariants) ? details.invariants : [],
    interfaces: Array.isArray(details?.interfaces) ? details.interfaces : [],
    dependencies: Array.isArray(details?.dependencies) ? details.dependencies : [],
    dataSystems: Array.isArray(details?.dataSystems || details?.data) ? (details.dataSystems || details.data) : [],
    verification: Array.isArray(details?.verification) ? details.verification : [],
    evidence,
    uncertainties: Array.isArray(details?.uncertainties || details?.uncertainty)
      ? (details.uncertainties || details.uncertainty) : [],
  };
}

const COMPONENT_SECTIONS = {
  scope: { aliases: ['scope', 'alcance'], heading: 'Scope' },
  limits: { aliases: ['limits', 'límites', 'limites', 'boundaries'], heading: 'Limits' },
  delegation: { aliases: ['delegación', 'delegacion', 'delegation', 'agent guidance', 'guidance'], heading: 'Agent guidance' },
  territory: { aliases: ['territorio', 'territory'], heading: 'Territory' },
};

function renderNativeComponent(component, since = new Date().toISOString().slice(0, 10)) {
  // Scope remains a supported human-facing alias for the v2 purpose field so
  // repositories created by the original discovery flow keep familiar text.
  return createComponentMarkdown({
    slug: component.slug,
    title: component.title,
    state: component.state || 'active',
    order: component.order,
    contract: {
      purpose: component.purpose || component.scope,
      outcomes: component.outcomes,
      responsibilities: component.responsibilities,
      limits: component.limits,
      invariants: component.invariants,
      interfaces: component.interfaces,
      dependencies: component.dependencies,
      dataSystems: component.dataSystems || component.data,
      territory: component.territory,
      verification: component.verification,
      evidence: component.evidence,
      uncertainties: component.uncertainties || component.uncertainty,
      guidance: component.guidance || component.delegation,
    },
  }, { since }).replace('## Purpose\n', '## Scope\n');
}

export function initializeNativeRepository(repository, { components = [] } = {}) {
  if (!repository?.path) throw new Error('repository path is required');
  if (!Array.isArray(components) || components.length > 24) {
    throw new Error('initialization accepts at most 24 components');
  }
  const normalized = components.map((component, index) => normalizeNativeComponent(component, {
    requireComplete: true, index,
  }));
  const slugs = new Set();
  for (const component of normalized) {
    if (slugs.has(component.slug)) throw new Error(`duplicate component slug: ${component.slug}`);
    slugs.add(component.slug);
  }
  const renderedComponents = normalized.map((component) => ({
    ...component,
    markdown: renderNativeComponent(component),
  }));
  assertPortfolioContracts(renderedComponents.map((component) => parseComponentContract(component.markdown, {
    fallbackSlug: component.slug,
  })), []);

  const target = join(repository.path, '.handraise');
  const lock = join(repository.path, '.handraise-initialize.lock');
  if (existsSync(target)) throw new Error('repository metadata already exists; refresh before initializing');
  if (existsSync(join(repository.path, '.claude', 'components'))
    && existsSync(join(repository.path, '.claude', 'runtime', 'plans'))) {
    throw new Error('this repository is managed by Director and cannot be initialized as native Handraise');
  }
  try { mkdirSync(lock); } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('another repository initialization is finishing; try again in a moment');
    throw error;
  }

  const staging = join(repository.path, `.handraise.tmp-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(join(staging, 'components'), { recursive: true });
    mkdirSync(join(staging, 'fronts'), { recursive: true });
    writeFileSync(join(staging, 'project.json'), `${JSON.stringify({ version: 1, name: repository.name }, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(staging, '.gitignore'), 'worktrees/\n.management-lock/\n', { flag: 'wx' });
    for (const component of renderedComponents) {
      writeFileSync(join(staging, 'components', `${component.slug}.md`), component.markdown, { flag: 'wx' });
    }
    // The lock serializes every Handraise initializer. This second check catches
    // metadata created by another tool while the complete tree was staged.
    if (existsSync(target)) throw new Error('repository metadata appeared during initialization; nothing was overwritten');
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  return { ...repository, adapter: 'handraise' };
}

function componentFilename(repository, slug) {
  const componentDirectory = join(repository.path, repository.adapter === 'director' ? '.claude/components' : '.handraise/components');
  const filename = listMarkdown(componentDirectory).find((name) => {
    if (name === '_TEMPLATE.md') return false;
    const fallbackSlug = name.replace(/\.md$/, '');
    return parseComponent(join(componentDirectory, name), fallbackSlug).slug === slug;
  });
  return filename ? { componentDirectory, filename } : null;
}

function frontDirectory(repository) {
  return join(repository.path, repository.adapter === 'director' ? '.claude/runtime/plans' : '.handraise/fronts');
}

function frontFilename(repository, slug) {
  const directory = frontDirectory(repository);
  const filename = listMarkdown(directory).find((name) => name.replace(/\.md$/, '') === slug);
  return filename ? { directory, filename } : null;
}

function validateNativePortfolioMutation(repository, { writes = new Map(), deletes = new Set() } = {}) {
  if (repository.adapter !== 'handraise') return null;
  const load = (directory, kind) => {
    const paths = listMarkdown(directory)
      .filter((name) => name !== '_TEMPLATE.md')
      .map((name) => join(directory, name));
    for (const path of writes.keys()) {
      if (path.startsWith(`${directory}/`) && !paths.includes(path)) paths.push(path);
    }
    return paths.filter((path) => !deletes.has(path)).sort().map((path) => {
      const markdown = writes.has(path) ? writes.get(path) : read(path);
      const fallbackSlug = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
      return kind === 'component'
        ? parseComponentContract(markdown, { fallbackSlug })
        : parseFrontContract(markdown, { fallbackSlug });
    });
  };
  const components = load(join(repository.path, '.handraise', 'components'), 'component');
  const fronts = load(join(repository.path, '.handraise', 'fronts'), 'front');
  return assertPortfolioContracts(components, fronts);
}

export function createFront(repository, componentSlug, details = {}) {
  const {
    slug, title, outcome, motivation, scope, nonGoals, readiness, acceptanceCriteria,
    verification, deliverables, risks, dependencies, evidence, affectedComponents, goalIds,
    analysisSnapshot, context, handoff, tasks, next, impact = 'medio', complexity = 'media',
  } = details;
  if (!componentFilename(repository, componentSlug)) throw new Error(`component '${componentSlug}' not found`);
  const cleanTitle = cleanMultiline(title, 160).replace(/\n+/g, ' ');
  if (!cleanTitle) throw new Error('front title is required');
  const cleanOutcome = cleanMultiline(outcome || title, 500).replace(/\n+/g, ' ');
  const cleanContext = cleanMultiline(context || handoff, 8_000);
  const cleanHandoff = cleanMultiline(handoff || context, 8_000);
  const taskValues = (Array.isArray(tasks) && tasks.length ? tasks : [next])
    .map((task) => cleanMultiline(task, 260).replace(/\n+/g, ' ').replace(/^[-*]\s*\[[ x~]\]\s*/i, ''))
    .filter(Boolean);
  if (!cleanOutcome) throw new Error('observable outcome is required');
  if (cleanContext.length < 20) throw new Error('confirmed context needs at least 20 characters');
  if (!cleanHandoff) throw new Error('handoff is required');
  if (!taskValues.length) throw new Error('the front needs at least one checklist item');
  if (taskValues.length > 30) throw new Error('the front cannot start with more than 30 checklist items');
  const cleanImpact = ['alto', 'medio', 'bajo'].includes(String(impact)) ? String(impact) : 'medio';
  const cleanComplexity = ['alta', 'media', 'baja'].includes(String(complexity)) ? String(complexity) : 'media';
  const directory = frontDirectory(repository);
  mkdirSync(directory, { recursive: true });
  const existing = new Set(listMarkdown(directory).map((name) => name.replace(/\.md$/, '')));
  const base = componentSlugValue(slug || cleanTitle);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) candidate = `${base}-${suffix++}`;
  if (['director-assistant'].includes(candidate) || candidate.startsWith('front-creator--')) throw new Error('that front name is reserved');
  if (repository.adapter === 'director') {
    directorHelper(repository, 'fronts.mjs', 'create', {
      slug: candidate, component: componentSlug, title: cleanOutcome,
      handoff: `${cleanContext}\n\n${cleanHandoff}`.trim(), tasks: taskValues,
      impact: cleanImpact, complexity: cleanComplexity,
    });
    return parseFront(join(directory, `${candidate}.md`), candidate, repository.adapter, priorityCatalog(read(join(repository.path, '.claude/runtime/priorities.md'))));
  }
  const markdown = renderNativeFront({
    slug: candidate, component: componentSlug, title: cleanTitle, state: 'queued',
    outcome: cleanOutcome, context: cleanContext, handoff: cleanHandoff,
    tasks: taskValues.map((text) => ({ state: 'open', text })), impact: cleanImpact, complexity: cleanComplexity,
    motivation, scope, nonGoals, readiness, acceptanceCriteria, verification, deliverables, risks,
    dependencies, evidence, affectedComponents, goalIds, analysisSnapshot,
  });
  const path = join(directory, `${candidate}.md`);
  withNativeLock(repository, () => {
    if (existsSync(path)) throw new Error('front already exists');
    validateNativePortfolioMutation(repository, { writes: new Map([[path, markdown]]) });
    atomicWrite(path, markdown);
  });
  return parseFront(path, candidate, repository.adapter, new Map());
}

function componentSlugValue(value) {
  return componentSlug(value);
}

function renderNativeFront(details) {
  return createFrontMarkdown(details);
}

export function deleteFront(repository, componentSlug, slug, { sessions = [] } = {}) {
  if (repository.adapter === 'director') {
    throw new Error('Director front removal is read-only until the repository provides a validated removal helper');
  }
  const location = frontFilename(repository, slug);
  if (!location) throw new Error('front not found');
  const front = parseFront(join(location.directory, location.filename), slug, repository.adapter, new Map());
  if (front.component !== componentSlug) throw new Error('front does not belong to this component');
  const live = sessions
    .filter((session) => session.repoId === repository.id && (session.front === slug || session.slug === slug))
    .map((session) => session.slug);
  const blockers = [
    front.state === 'active' ? 'front state is active' : null,
    live.length ? `live sessions: ${live.join(', ')}` : null,
  ].filter(Boolean);
  if (blockers.length) throw new Error(`cannot delete front '${slug}': ${blockers.join('; ')}`);
  const path = join(location.directory, location.filename);
  withNativeLock(repository, () => {
    validateNativePortfolioMutation(repository, { deletes: new Set([path]) });
    unlinkSync(path);
  });
  return { deleted: slug };
}

export function createComponent(repository, details = {}) {
  const {
    title, slug, scope, purpose, limits, delegation, guidance, territory, order,
    outcomes, responsibilities, invariants, interfaces, dependencies, data, dataSystems,
    verification, evidence, uncertainty, uncertainties,
  } = details;
  const cleanTitle = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cleanTitle) throw new Error('component title is required');
  const cleanScope = cleanMultiline(purpose || scope);
  if (!cleanScope) throw new Error('component scope is required');
  const componentDirectory = join(repository.path, repository.adapter === 'director' ? '.claude/components' : '.handraise/components');
  mkdirSync(componentDirectory, { recursive: true });
  const existing = new Set(listMarkdown(componentDirectory).map((name) => parseComponent(join(componentDirectory, name), name.replace(/\.md$/, '')).slug));
  const base = componentSlug(slug || cleanTitle);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) candidate = `${base}-${suffix++}`;
  const today = new Date().toISOString().slice(0, 10);
  if (repository.adapter === 'director') {
    const cleanSections = Object.fromEntries(Object.entries({
      Alcance: cleanScope, Límites: cleanMultiline(limits), Delegación: cleanMultiline(delegation), Territorio: cleanMultiline(territory),
    }));
    const result = directorHelper(repository, 'components.mjs', 'apply', {
      action: 'create', slug: candidate, title: cleanTitle, since: today,
      order: order === undefined ? undefined : Number(order), sections: cleanSections,
    });
    return {
      slug: result.component.slug, title: result.component.titulo, state: result.component.estado === 'activo' ? 'active' : 'closing',
      order: result.component.orden, since: result.component.desde, sections: result.component.secciones,
    };
  }
  const path = join(componentDirectory, `${candidate}.md`);
  const markdown = renderNativeComponent({
    slug: candidate,
    title: cleanTitle,
    state: 'active',
    order: Number.isInteger(Number(order)) ? Number(order) : 99,
    scope: cleanScope,
    limits: Array.isArray(limits) ? limits : cleanMultiline(limits),
    delegation: cleanMultiline(guidance || delegation),
    territory: Array.isArray(territory) ? territory : cleanMultiline(territory),
    outcomes,
    responsibilities,
    invariants,
    interfaces,
    dependencies,
    data: dataSystems || data,
    verification,
    evidence,
    uncertainty: uncertainties || uncertainty,
  }, today);
  withNativeLock(repository, () => {
    if (existsSync(path)) throw new Error('component already exists');
    validateNativePortfolioMutation(repository, { writes: new Map([[path, markdown]]) });
    atomicWrite(path, markdown);
  });
  return parseComponent(path, candidate);
}

export function updateComponent(repository, slug, details = {}) {
  const { title, scope, limits, delegation, territory } = details;
  const cleanTitle = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  if (!cleanTitle) throw new Error('component title is required');
  if (repository.adapter === 'director') {
    const sectionValues = {};
    for (const [field, definition] of Object.entries(COMPONENT_SECTIONS)) {
      if (Object.prototype.hasOwnProperty.call(details, field)) sectionValues[definition.heading === 'Scope' ? 'Alcance' : definition.heading === 'Limits' ? 'Límites' : definition.heading === 'Agent guidance' ? 'Delegación' : 'Territorio'] = cleanMultiline(details[field]);
    }
    const result = directorHelper(repository, 'components.mjs', 'apply', {
      action: 'update', slug, title: cleanTitle,
      order: details.order === undefined ? undefined : Number(details.order),
      sections: Object.keys(sectionValues).length ? sectionValues : undefined,
    });
    return {
      slug: result.component.slug, title: result.component.titulo, state: result.component.estado === 'activo' ? 'active' : 'closing',
      order: result.component.orden, since: result.component.desde, sections: result.component.secciones,
    };
  }
  const location = componentFilename(repository, slug);
  if (!location) throw new Error('component not found');
  const { componentDirectory, filename } = location;
  const path = join(componentDirectory, filename);
  const updates = { ...details, title: cleanTitle };
  for (const field of [
    'scope', 'purpose', 'limits', 'delegation', 'guidance', 'outcomes', 'responsibilities',
    'invariants', 'interfaces', 'dependencies', 'data', 'dataSystems', 'territory',
    'verification', 'evidence', 'uncertainty', 'uncertainties',
  ]) {
    if (Object.prototype.hasOwnProperty.call(updates, field) && typeof updates[field] === 'string') {
      updates[field] = cleanMultiline(updates[field], 16_000);
    }
  }
  const markdown = updateComponentMarkdown(read(path), updates);
  withNativeLock(repository, () => {
    validateNativePortfolioMutation(repository, { writes: new Map([[path, markdown]]) });
    atomicWrite(path, markdown);
  });
  return parseComponent(path, filename.replace(/\.md$/, ''));
}

export function setComponentState(repository, slug, state) {
  if (!['active', 'closing'].includes(state)) throw new Error('invalid component state');
  if (repository.adapter === 'director') {
    const result = directorHelper(repository, 'components.mjs', 'apply', {
      action: state === 'active' ? 'reopen' : 'retire', slug,
    });
    return result.component;
  }
  const location = componentFilename(repository, slug);
  if (!location) throw new Error('component not found');
  const path = join(location.componentDirectory, location.filename);
  const markdown = updateComponentMarkdown(read(path), { state });
  withNativeLock(repository, () => {
    validateNativePortfolioMutation(repository, { writes: new Map([[path, markdown]]) });
    atomicWrite(path, markdown);
  });
  return parseComponent(path, slug);
}

export function deleteComponent(repository, slug, { sessions = [] } = {}) {
  if (repository.adapter === 'director') return directorHelper(repository, 'components.mjs', 'apply', { action: 'remove', slug });
  const location = componentFilename(repository, slug);
  if (!location) throw new Error('component not found');
  const portfolio = repositoryPortfolio(repository, sessions);
  const component = portfolio.components.find((item) => item.slug === slug);
  const open = component?.fronts.filter((front) => front.state !== 'done').map((front) => front.slug) || [];
  const live = sessions.filter((session) => session.repoId === repository.id && session.component === slug).map((session) => session.slug);
  const blockers = [...new Set([...open, ...live])];
  if (blockers.length) throw new Error(`component still has open work: ${blockers.join(', ')}`);
  const path = join(location.componentDirectory, location.filename);
  withNativeLock(repository, () => {
    validateNativePortfolioMutation(repository, { deletes: new Set([path]) });
    unlinkSync(path);
  });
  return { action: 'remove', slug, removed: true };
}

export function renameComponent(repository, slug, title) {
  return updateComponent(repository, slug, { title });
}

function priorityCatalog(markdown) {
  const result = new Map();
  for (const line of markdown.split('\n')) {
    const match = /^\s*([a-z0-9][a-z0-9-]*)\s*:\s*(alto|medio|bajo)\s*\/\s*(alta|media|baja)/i.exec(line);
    if (match) result.set(match[1], { impact: match[2].toLowerCase(), complexity: match[3].toLowerCase() });
  }
  return result;
}

function parseFront(path, fallbackSlug, adapter, priorities) {
  const markdown = read(path);
  return { ...parseFrontContract(markdown, {
    fallbackSlug,
    adapter,
    priority: priorities.get(fallbackSlug) || null,
  }), revision: workContractRevision(markdown) };
}

export function updateFront(repository, componentSlug, slug, details = {}) {
  if (repository.adapter === 'director') {
    throw new Error('Director front editing is read-only until the repository provides a validated update helper');
  }
  const location = frontFilename(repository, slug);
  if (!location) throw new Error('front not found');
  const path = join(location.directory, location.filename);
  const baseline = read(path);
  const baselineRevision = workContractRevision(baseline);
  if (details.expectedRevision !== undefined && details.expectedRevision !== baselineRevision) {
    throw new WorkContractError('WORK_CONTRACT_BASELINE_CHANGED', `front '${slug}' changed before this reviewed update`, { details: { expected: details.expectedRevision, current: baselineRevision } });
  }
  const current = parseFrontContract(baseline, { fallbackSlug: slug, adapter: repository.adapter });
  if (current.component !== componentSlug) throw new Error('front does not belong to this component');
  const cleanTitle = cleanMultiline(details.title ?? current.title, 160).replace(/\n+/g, ' ');
  const cleanOutcome = cleanMultiline(details.outcome ?? current.outcome, 500).replace(/\n+/g, ' ');
  const cleanContext = cleanMultiline(details.context ?? current.context, 8_000);
  const cleanHandoff = cleanMultiline(details.handoff ?? current.handoff, 8_000);
  const state = String(details.state ?? current.state);
  const impact = String(details.impact ?? current.impact ?? 'medio');
  const complexity = String(details.complexity ?? current.complexity ?? 'media');
  const nextTasks = details.tasks === undefined ? current.tasks : (Array.isArray(details.tasks) ? details.tasks : []);
  const tasks = nextTasks.map((task) => typeof task === 'string'
    ? { state: 'open', text: cleanMultiline(task, 260).replace(/\n+/g, ' ') }
    : { state: ['open', 'done', 'skipped'].includes(task?.state) ? task.state : 'open', text: cleanMultiline(task?.text, 260).replace(/\n+/g, ' ') })
    .filter((task) => task.text);
  if (!cleanTitle || !cleanOutcome || cleanContext.length < 20 || !cleanHandoff || !tasks.length) throw new Error('front definition is incomplete');
  if (!['queued', 'active', 'blocked', 'paused', 'done'].includes(state)) throw new Error('invalid front state');
  if (!['alto', 'medio', 'bajo'].includes(impact) || !['alta', 'media', 'baja'].includes(complexity)) throw new Error('invalid front priority');
  const { expectedRevision: _expectedRevision, ...safeDetails } = details;
  const markdown = updateFrontMarkdown(baseline, {
    ...safeDetails,
    title: cleanTitle,
    state,
    outcome: cleanOutcome,
    context: cleanContext,
    handoff: cleanHandoff,
    tasks,
    impact,
    complexity,
  });
  withNativeLock(repository, () => {
    if (read(path) !== baseline) throw new WorkContractError('WORK_CONTRACT_BASELINE_CHANGED', `front '${slug}' changed while this reviewed update was waiting for its lock`);
    validateNativePortfolioMutation(repository, { writes: new Map([[path, markdown]]) });
    atomicWrite(path, markdown);
  });
  return { ...parseFront(path, slug, repository.adapter, new Map()), revision: workContractRevision(markdown) };
}

export function setFrontState(repository, componentSlug, slug, state) {
  return updateFront(repository, componentSlug, slug, { state });
}

function directorLanes(repository) {
  const markdown = read(join(repository.path, '.claude', 'runtime', 'SESSIONS.md'));
  const matches = [...markdown.matchAll(/^###\s+([^\s·]+)([^\n]*)$/gm)];
  return matches.map((match, index) => {
    const body = markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length);
    const field = (name) => body.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() || null;
    const header = match[2];
    const component = header.match(/componente:\s*([^\s·]+)/)?.[1] || null;
    const worktree = header.match(/worktree:\s*([^·]+?)(?:\s*·|$)/)?.[1]?.trim() || null;
    const seal = field('proc');
    return {
      slug: match[1], component, worktree, statusText: field('status'),
      session: field('session'), seal, liveness: seal ? (procAlive(seal) ? 'live' : 'dead') : 'unknown',
    };
  }).filter((lane) => /^[A-Za-z0-9._-]+$/.test(lane.slug));
}

function normalizeMigrationScope(scope = {}) {
  const normalize = (value, label) => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const unique = [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))].sort();
    if (unique.length > 100) throw new WorkContractError('WORK_CONTRACT_MIGRATION_SCOPE_INVALID', `${label} accepts at most 100 slugs`);
    if (unique.some((slug) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))) {
      throw new WorkContractError('WORK_CONTRACT_MIGRATION_SCOPE_INVALID', `${label} must contain lowercase kebab-case slugs`);
    }
    return unique;
  };
  return {
    frontSlugs: normalize(scope.frontSlugs, 'frontSlugs'),
    componentSlugs: normalize(scope.componentSlugs, 'componentSlugs'),
  };
}

function buildWorkContractMigrationPreview(repository, requestedScope = {}) {
  if (repository.adapter !== 'handraise') {
    throw new WorkContractError('WORK_CONTRACT_MIGRATION_UNSUPPORTED', 'work-contract migration is available only for native Handraise repositories');
  }
  const scope = normalizeMigrationScope(requestedScope);
  const scoped = scope.frontSlugs.length > 0 || scope.componentSlugs.length > 0;
  const componentDirectory = join(repository.path, '.handraise', 'components');
  const frontsDirectory = join(repository.path, '.handraise', 'fronts');
  const componentRecords = listMarkdown(componentDirectory)
    .filter((name) => name !== '_TEMPLATE.md')
    .map((name) => {
      const path = join(componentDirectory, name);
      const before = read(path);
      const after = migrateComponentMarkdown(before);
      return { kind: 'component', slug: name.replace(/\.md$/, ''), path, relativePath: `.handraise/components/${name}`, before, after };
    });
  const frontRecords = listMarkdown(frontsDirectory)
    .filter((name) => name !== '_TEMPLATE.md')
    .map((name) => {
      const path = join(frontsDirectory, name);
      const before = read(path);
      const after = migrateFrontMarkdown(before);
      return { kind: 'front', slug: name.replace(/\.md$/, ''), path, relativePath: `.handraise/fronts/${name}`, before, after };
    });
  const knownComponents = new Set(componentRecords.map((record) => record.slug));
  const knownFronts = new Map(frontRecords.map((record) => [record.slug, parseFrontContract(record.before, { fallbackSlug: record.slug })]));
  for (const slug of scope.frontSlugs) {
    if (!knownFronts.has(slug)) throw new WorkContractError('WORK_CONTRACT_MIGRATION_SCOPE_INVALID', `front '${slug}' was not found`);
  }
  for (const slug of scope.componentSlugs) {
    if (!knownComponents.has(slug)) throw new WorkContractError('WORK_CONTRACT_MIGRATION_SCOPE_INVALID', `component '${slug}' was not found`);
  }
  const effectiveComponents = new Set(scope.componentSlugs);
  for (const slug of scope.frontSlugs) {
    const front = knownFronts.get(slug);
    for (const component of [front.component, ...(front.affectedComponents || [])].filter(Boolean)) effectiveComponents.add(component);
  }
  const selected = (record) => !scoped
    || (record.kind === 'front' ? scope.frontSlugs.includes(record.slug) : effectiveComponents.has(record.slug));
  const records = [...componentRecords, ...frontRecords];
  const components = componentRecords.map((record) => parseComponentContract(selected(record) ? record.after : record.before, { fallbackSlug: record.slug }));
  const fronts = frontRecords.map((record) => parseFrontContract(selected(record) ? record.after : record.before, { fallbackSlug: record.slug }));
  const validation = validatePortfolioContracts(components, fronts);
  const operations = records.filter((record) => selected(record) && record.before !== record.after).map((record) => ({
    ...record,
    beforeRevision: workContractRevision(record.before),
    afterRevision: workContractRevision(record.after),
  }));
  const resolvedScope = {
    mode: scoped ? 'selected' : 'all',
    frontSlugs: scope.frontSlugs,
    componentSlugs: [...effectiveComponents].sort(),
  };
  const previewId = workContractRevision(JSON.stringify({
    repositoryId: repository.id,
    adapter: repository.adapter,
    scope: resolvedScope,
    operations: operations.map((operation) => ({
      path: operation.relativePath,
      beforeRevision: operation.beforeRevision,
      afterRevision: operation.afterRevision,
    })),
  }));
  return {
    previewId,
    repositoryId: repository.id,
    schemaVersion: 2,
    noOp: operations.length === 0,
    canApply: validation.valid,
    scope: resolvedScope,
    operations,
    validation,
  };
}

function publicMigrationPreview(preview) {
  return {
    ...preview,
    operations: preview.operations.map(({ path, ...operation }) => operation),
  };
}

export function previewWorkContractMigration(repository, scope = {}) {
  return publicMigrationPreview(buildWorkContractMigrationPreview(repository, scope));
}

export function applyWorkContractMigration(repository, { previewId, frontSlugs = [], componentSlugs = [] } = {}) {
  if (!previewId) throw new WorkContractError('WORK_CONTRACT_PREVIEW_REQUIRED', 'review a current work-contract migration preview before applying it');
  if (repository.adapter !== 'handraise') {
    throw new WorkContractError('WORK_CONTRACT_MIGRATION_UNSUPPORTED', 'work-contract migration is available only for native Handraise repositories');
  }
  return withNativeLock(repository, () => {
    const preview = buildWorkContractMigrationPreview(repository, { frontSlugs, componentSlugs });
    if (preview.previewId !== previewId) {
      throw new WorkContractError('WORK_CONTRACT_BASELINE_CHANGED', 'work contracts changed after preview; review the refreshed migration before applying it', {
        details: { expectedPreviewId: previewId, currentPreviewId: preview.previewId },
      });
    }
    if (!preview.canApply) {
      throw new WorkContractError('INVALID_PORTFOLIO', 'work-contract references must be valid before migration', {
        diagnostics: preview.validation.diagnostics,
      });
    }
    if (preview.noOp) return { ...publicMigrationPreview(preview), applied: false, migrated: 0 };

    const staging = join(repository.path, '.handraise', `.contract-migration-${process.pid}-${randomUUID()}`);
    const committed = [];
    try {
      mkdirSync(staging, { recursive: false });
      for (const [index, operation] of preview.operations.entries()) {
        const staged = join(staging, `${index}.md`);
        writeFileSync(staged, operation.after, { flag: 'wx' });
        if (readFileSync(staged, 'utf8') !== operation.after) throw new Error(`could not verify staged migration for ${operation.relativePath}`);
      }
      for (const operation of preview.operations) {
        if (read(operation.path) !== operation.before) {
          throw new WorkContractError('WORK_CONTRACT_BASELINE_CHANGED', `${operation.relativePath} changed while the migration was being committed`);
        }
        atomicWrite(operation.path, operation.after);
        committed.push(operation);
      }
    } catch (error) {
      const rollbackFailures = [];
      for (const operation of committed.reverse()) {
        try {
          if (read(operation.path) === operation.after) atomicWrite(operation.path, operation.before);
          else rollbackFailures.push(operation.relativePath);
        } catch { rollbackFailures.push(operation.relativePath); }
      }
      if (rollbackFailures.length) {
        throw new WorkContractError('WORK_CONTRACT_ROLLBACK_FAILED', `migration failed and rollback needs manual recovery for: ${rollbackFailures.join(', ')}`, { cause: error });
      }
      throw error;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return {
      ...publicMigrationPreview(preview),
      applied: true,
      migrated: preview.operations.length,
    };
  });
}

export function repositoryPortfolio(repository, handraiseSessions = []) {
  const availability = repositoryAvailability(repository.path);
  if (!availability.available) throw new Error(availability.detail);
  const adapter = repository.adapter;
  const componentDirectory = join(repository.path, adapter === 'director' ? '.claude/components' : '.handraise/components');
  const frontsDirectory = join(repository.path, adapter === 'director' ? '.claude/runtime/plans' : '.handraise/fronts');
  const prioritiesPath = join(repository.path, adapter === 'director' ? '.claude/runtime/priorities.md' : '.handraise/priorities.md');
  const priorities = priorityCatalog(read(prioritiesPath));
  const components = listMarkdown(componentDirectory)
    .map((name) => parseComponent(join(componentDirectory, name), name.replace(/\.md$/, '')))
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  const fronts = listMarkdown(frontsDirectory)
    .filter((name) => name !== '_TEMPLATE.md')
    .map((name) => parseFront(join(frontsDirectory, name), name.replace(/\.md$/, ''), adapter, priorities))
    .filter((front) => front.component);
  const contractValidation = validatePortfolioContracts(components, fronts);
  const lanes = adapter === 'director' ? directorLanes(repository) : [];

  for (const front of fronts) {
    const lane = lanes.find((item) => item.slug === front.slug);
    const session = handraiseSessions.find((item) => item.repoId === repository.id
      && (item.front === front.slug || item.slug === front.slug));
    if (session || lane?.liveness === 'live') front.state = 'active';
    else if (lane?.liveness === 'dead') front.state = 'paused';
  }

  const byComponent = components.map((component) => {
    const ownFronts = fronts.filter((front) => front.component === component.slug);
    const active = ownFronts.find((front) => front.state === 'active');
    return {
      ...component,
      activeFront: active?.slug || null,
      fronts: ownFronts,
      progress: ownFronts.length
        ? Math.round(ownFronts.reduce((sum, front) => sum + front.percent, 0) / ownFronts.length)
        : null,
      counts: {
        active: ownFronts.filter((front) => front.state === 'active').length,
        queued: ownFronts.filter((front) => front.state === 'queued').length,
        blocked: ownFronts.filter((front) => front.state === 'blocked').length,
        paused: ownFronts.filter((front) => front.state === 'paused').length,
        done: ownFronts.filter((front) => front.state === 'done').length,
      },
    };
  });
  const activeSessionKeys = new Set([
    ...handraiseSessions
      .filter((session) => session.repoId === repository.id)
      .map((session) => session.front || session.slug),
    ...lanes.filter((lane) => lane.liveness === 'live').map((lane) => lane.slug),
  ]);

  return {
    ...repository,
    availability,
    mutations: mutationCapabilities(repository),
    workContracts: {
      schemaVersion: 2,
      components: Object.fromEntries(components.map((component) => [component.slug, component.schemaVersion])),
      fronts: Object.fromEntries(fronts.map((front) => [front.slug, front.schemaVersion])),
      migrationAvailable: adapter === 'handraise' && [...components, ...fronts].some((record) => record.schemaVersion < 2),
      validation: contractValidation,
    },
    components: byComponent,
    fronts,
    lanes,
    summary: {
      components: byComponent.length,
      openFronts: fronts.filter((front) => front.kind === 'front' && front.state !== 'done').length,
      activeSessions: activeSessionKeys.size,
    },
  };
}

export function repositoriesSnapshot(config, handraiseSessions = []) {
  return config.repositories.map((repository) => {
    const availability = repositoryAvailability(repository.path);
    if (!availability.available) {
      return {
        ...repository, availability, components: [], fronts: [], lanes: [],
        mutations: unavailableMutationCapabilities(),
        summary: { components: 0, openFronts: 0, activeSessions: 0 },
        error: availability.detail,
        recovery: availability.recovery,
      };
    }
    try { return repositoryPortfolio(repository, handraiseSessions); }
    catch (error) {
      return {
        ...repository, components: [], fronts: [], lanes: [],
        mutations: unavailableMutationCapabilities(),
        error: String(error.message || error),
        recovery: 'Verify the repository path, then reconnect it from Settings if it moved.',
      };
    }
  });
}
