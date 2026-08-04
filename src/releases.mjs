import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const RELEASE_SCHEMA_VERSION = 1;
export const RELEASE_STATES = Object.freeze(['draft', 'ready', 'active', 'blocked', 'candidate', 'released', 'cancelled']);

const OPEN_STATES = new Set(['draft', 'ready', 'active', 'blocked', 'candidate']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REQUIREMENT_ID = /^[A-Z][A-Z0-9-]*-\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;
const FRONTMATTER_KEYS = new Set(['schema', 'slug', 'title', 'state', 'version', 'target_branch', 'created', 'updated']);
const KNOWN_SECTIONS = new Set([
  'observable outcome', 'selected requirements', 'selected fronts', 'acceptance criteria',
  'verification', 'compatibility', 'known limitations', 'candidate evidence',
]);
const LEGAL_TRANSITIONS = Object.freeze({
  draft: new Set(['ready', 'cancelled']),
  ready: new Set(['draft', 'active', 'cancelled']),
  active: new Set(['blocked', 'candidate', 'cancelled']),
  blocked: new Set(['active', 'cancelled']),
  candidate: new Set(['active', 'released', 'cancelled']),
  released: new Set(),
  cancelled: new Set(),
});

export class ReleaseError extends Error {
  constructor(code, message, { details = null } = {}) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.message, code: this.code, details: this.details };
  }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
export const releaseRevision = (markdown) => hash(String(markdown || ''));

function cleanInline(value, limit = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function cleanBlock(value, limit = 16_000) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function instant(value, fallback) {
  const date = new Date(value ?? fallback);
  if (!Number.isFinite(date.getTime())) throw new ReleaseError('INVALID_RELEASE', `invalid release timestamp '${value}'`);
  return date.toISOString();
}

function uniqueStrings(values, { label, pattern = null, limit = 500 } = {}) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > limit) throw new ReleaseError('INVALID_RELEASE', `${label} must contain at most ${limit} items`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const item = cleanInline(value, 1_000);
    if (!item) continue;
    if (pattern && !pattern.test(item)) throw new ReleaseError('INVALID_RELEASE', `${label} contains invalid value '${item}'`);
    if (seen.has(item)) throw new ReleaseError('INVALID_RELEASE', `duplicate ${label.replace(/s$/, '')} '${item}'`);
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeFronts(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > 200) throw new ReleaseError('INVALID_RELEASE', 'release fronts must contain at most 200 items');
  const seen = new Set();
  return values.map((value, index) => {
    const slug = cleanInline(value?.slug, 64);
    const revision = cleanInline(value?.revision, 64).toLowerCase();
    if (!SLUG.test(slug)) throw new ReleaseError('INVALID_RELEASE', `release front ${index + 1} has an invalid slug`);
    if (!SHA256.test(revision)) throw new ReleaseError('INVALID_RELEASE', `release front '${slug}' needs an exact SHA-256 revision`);
    if (seen.has(slug)) throw new ReleaseError('INVALID_RELEASE', `duplicate front '${slug}'`);
    seen.add(slug);
    return { slug, revision };
  });
}

function normalizeCandidate(value) {
  if (!value) return null;
  const sourceRevision = cleanInline(value.sourceRevision, 64).toLowerCase();
  const contractRevision = cleanInline(value.contractRevision, 64).toLowerCase();
  const artifactDigest = cleanInline(value.artifactDigest, 64).toLowerCase();
  const artifact = cleanInline(value.artifact, 500);
  const measurementProfile = cleanInline(value.measurementProfile, 500);
  if (!GIT_REVISION.test(sourceRevision)) throw new ReleaseError('INVALID_CANDIDATE', 'candidate source revision must be an exact 40-character Git revision');
  if (!SHA256.test(contractRevision)) throw new ReleaseError('INVALID_CANDIDATE', 'candidate contract revision must be an exact SHA-256 revision');
  if (!SHA256.test(artifactDigest)) throw new ReleaseError('INVALID_CANDIDATE', 'candidate artifact digest must be an exact SHA-256 revision');
  if (!artifact || !measurementProfile) throw new ReleaseError('INVALID_CANDIDATE', 'candidate artifact and measurement profile are required');
  const toolVersions = value.toolVersions && typeof value.toolVersions === 'object' && !Array.isArray(value.toolVersions)
    ? Object.fromEntries(Object.entries(value.toolVersions).slice(0, 40).map(([key, version]) => [cleanInline(key, 100), cleanInline(version, 200)]).filter(([key, version]) => key && version))
    : {};
  if (!Object.keys(toolVersions).length) throw new ReleaseError('INVALID_CANDIDATE', 'candidate tool versions are required');
  return {
    sourceRevision, contractRevision, artifactDigest, artifact, toolVersions,
    measurementProfile, measuredAt: instant(value.measuredAt, Date.now()),
  };
}

export function normalizeRelease(value, { repositoryId = '', now = Date.now() } = {}) {
  const timestamp = typeof now === 'function' ? now() : now;
  const slug = cleanInline(value?.slug, 64);
  const title = cleanInline(value?.title, 180);
  const state = cleanInline(value?.state || 'draft', 32).toLowerCase();
  const outcome = cleanBlock(value?.outcome, 4_000);
  const targetBranch = cleanInline(value?.targetBranch || value?.target_branch || 'main', 240);
  if (!SLUG.test(slug)) throw new ReleaseError('INVALID_RELEASE', `release slug '${slug}' must be lowercase kebab-case`);
  if (!title) throw new ReleaseError('INVALID_RELEASE', `release '${slug}' needs a title`);
  if (!RELEASE_STATES.includes(state)) throw new ReleaseError('INVALID_RELEASE', `invalid release state '${state}'`);
  if (!outcome) throw new ReleaseError('INVALID_RELEASE', `release '${slug}' needs an observable outcome`);
  if (!targetBranch || targetBranch.startsWith('-') || /[\s~^:?*\[\\]/.test(targetBranch) || targetBranch.includes('..') || targetBranch.endsWith('.')) {
    throw new ReleaseError('INVALID_RELEASE', `release '${slug}' has an invalid target branch`);
  }
  const createdAt = instant(value?.createdAt || value?.created, timestamp);
  const updatedAt = instant(value?.updatedAt || value?.updated, timestamp);
  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    repositoryId: cleanInline(repositoryId || value?.repositoryId, 200),
    slug,
    title,
    version: cleanInline(value?.version, 80) || null,
    state,
    targetBranch,
    outcome,
    requirementIds: uniqueStrings(value?.requirementIds ?? value?.requirements, { label: 'requirements', pattern: REQUIREMENT_ID }),
    fronts: normalizeFronts(value?.fronts),
    acceptanceCriteria: uniqueStrings(value?.acceptanceCriteria, { label: 'acceptance criteria', limit: 100 }),
    verification: uniqueStrings(value?.verification, { label: 'verification checks', limit: 100 }),
    compatibility: uniqueStrings(value?.compatibility, { label: 'compatibility entries', limit: 100 }),
    limitations: uniqueStrings(value?.limitations, { label: 'limitations', limit: 100 }),
    candidate: normalizeCandidate(value?.candidate),
    createdAt,
    updatedAt,
  };
}

function scalar(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function splitMarkdown(markdown) {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
  const frontmatterMatch = /^(?:\uFEFF)?---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  const frontmatter = frontmatterMatch?.[1] || '';
  const body = frontmatterMatch ? normalized.slice(frontmatterMatch[0].length) : normalized;
  const headings = [...body.matchAll(/^##\s+([^\n]+)\s*$/gm)];
  const prefix = body.slice(0, headings[0]?.index ?? body.length).trim();
  const sections = headings.map((match, index) => ({
    heading: match[1].trim(),
    raw: body.slice(match.index, headings[index + 1]?.index ?? body.length).trim(),
    content: body.slice(match.index + match[0].length, headings[index + 1]?.index ?? body.length).trim(),
  }));
  return { frontmatter, prefix, sections };
}

function parseFrontmatter(raw) {
  const result = {};
  for (const line of String(raw || '').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) result[match[1]] = scalar(match[2]);
  }
  return result;
}

function quote(value) {
  return JSON.stringify(String(value ?? ''));
}

function renderFrontmatter(existingRaw, release) {
  const unknown = String(existingRaw || '').split('\n').filter((line) => {
    const key = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line)?.[1];
    return !key || !FRONTMATTER_KEYS.has(key);
  }).filter((line) => line.trim());
  return [
    '---',
    `schema: ${RELEASE_SCHEMA_VERSION}`,
    `slug: ${release.slug}`,
    `title: ${quote(release.title)}`,
    `state: ${release.state}`,
    `version: ${release.version ? quote(release.version) : 'null'}`,
    `target_branch: ${quote(release.targetBranch)}`,
    `created: ${release.createdAt}`,
    `updated: ${release.updatedAt}`,
    ...unknown,
    '---',
  ].join('\n');
}

function bullets(values) {
  return values.length ? values.map((item) => `- ${item}`).join('\n') : '_None declared._';
}

function renderCandidate(candidate) {
  return candidate ? `\`\`\`json\n${JSON.stringify(candidate, null, 2)}\n\`\`\`` : '_No candidate recorded._';
}

export function renderRelease(value, { existingMarkdown = '' } = {}) {
  const release = normalizeRelease(value, {
    repositoryId: value?.repositoryId,
    now: value?.updatedAt || Date.now(),
  });
  const existing = splitMarkdown(existingMarkdown);
  const humanPrefix = existing.prefix
    .split('\n')
    .filter((line, index) => !(index === 0 && /^#\s+/.test(line)))
    .join('\n')
    .trim();
  const prefix = [`# Release — ${release.title}`, humanPrefix].filter(Boolean).join('\n\n');
  const known = [
    ['Observable outcome', release.outcome],
    ['Selected requirements', release.requirementIds.length ? release.requirementIds.map((id) => `- \`${id}\``).join('\n') : '_None selected._'],
    ['Selected fronts', release.fronts.length ? release.fronts.map((front) => `- \`${front.slug}\` @ \`${front.revision}\``).join('\n') : '_None selected._'],
    ['Acceptance criteria', bullets(release.acceptanceCriteria)],
    ['Verification', bullets(release.verification)],
    ['Compatibility', bullets(release.compatibility)],
    ['Known limitations', bullets(release.limitations)],
    ['Candidate evidence', renderCandidate(release.candidate)],
  ].map(([heading, content]) => `## ${heading}\n\n${content}`);
  const unknown = existing.sections.filter((section) => !KNOWN_SECTIONS.has(section.heading.toLowerCase())).map((section) => section.raw);
  return `${renderFrontmatter(existing.frontmatter, release)}\n\n${prefix}\n\n${[...known, ...unknown].join('\n\n')}\n`;
}

function section(split, heading) {
  return split.sections.find((item) => item.heading.toLowerCase() === heading.toLowerCase())?.content || '';
}

function parseBullets(content) {
  return String(content || '').split('\n').flatMap((line) => {
    const match = /^\s*-\s+(.+?)\s*$/.exec(line);
    return match ? [match[1]] : [];
  });
}

export function parseRelease(markdown, { repositoryId = '', fallbackSlug = '' } = {}) {
  const split = splitMarkdown(markdown);
  const meta = parseFrontmatter(split.frontmatter);
  const schema = Number(meta.schema || 1);
  if (schema !== RELEASE_SCHEMA_VERSION) throw new ReleaseError('UNSUPPORTED_RELEASE_SCHEMA', `unsupported release schema ${schema}`);
  const requirements = parseBullets(section(split, 'Selected requirements')).map((item) => /^`([^`]+)`$/.exec(item)?.[1] || item);
  const selectedFronts = parseBullets(section(split, 'Selected fronts')).map((item) => {
    const match = /^`([^`]+)`\s+@\s+`([a-f0-9]{64})`$/i.exec(item);
    if (!match) throw new ReleaseError('INVALID_RELEASE', `invalid selected front entry '${item}'`);
    return { slug: match[1], revision: match[2].toLowerCase() };
  });
  const candidateContent = section(split, 'Candidate evidence');
  let candidate = null;
  const candidateMatch = /```json\s*\n([\s\S]*?)\n```/i.exec(candidateContent);
  if (candidateMatch) {
    try { candidate = JSON.parse(candidateMatch[1]); }
    catch { throw new ReleaseError('INVALID_CANDIDATE', 'release candidate evidence contains invalid JSON'); }
  }
  return normalizeRelease({
    slug: meta.slug || fallbackSlug,
    title: meta.title,
    state: meta.state,
    version: meta.version,
    targetBranch: meta.target_branch,
    createdAt: meta.created,
    updatedAt: meta.updated,
    outcome: section(split, 'Observable outcome'),
    requirementIds: requirements,
    fronts: selectedFronts,
    acceptanceCriteria: parseBullets(section(split, 'Acceptance criteria')),
    verification: parseBullets(section(split, 'Verification')),
    compatibility: parseBullets(section(split, 'Compatibility')),
    limitations: parseBullets(section(split, 'Known limitations')),
    candidate,
  }, { repositoryId, now: meta.updated || Date.now() });
}

function blocker(code, message, details = null) {
  return { code, message, details };
}

export function assessRelease(value, {
  fronts = [], requirementEvidence = {}, priorGates = [], candidateEvidence = null, phase = 'ready',
} = {}) {
  const release = normalizeRelease(value, { repositoryId: value?.repositoryId, now: value?.updatedAt || Date.now() });
  const blockers = [];
  const frontIndex = new Map(fronts.map((front) => [front.slug, front]));
  if (!release.requirementIds.length) blockers.push(blocker('NO_REQUIREMENTS', 'The release has no selected requirements.'));
  if (!release.fronts.length) blockers.push(blocker('NO_FRONTS', 'The release has no selected fronts.'));
  for (const selected of release.fronts) {
    const current = frontIndex.get(selected.slug);
    if (!current) blockers.push(blocker('FRONT_NOT_FOUND', `Front '${selected.slug}' is unavailable.`, { slug: selected.slug }));
    else {
      if (current.revision !== selected.revision) blockers.push(blocker('FRONT_REVISION_STALE', `Front '${selected.slug}' changed after release review.`, { selected: selected.revision, current: current.revision }));
      if (Number(current.schemaVersion) < 2) blockers.push(blocker('FRONT_SCHEMA_UNSUPPORTED', `Front '${selected.slug}' must use schema v2 before release membership.`));
      if (['candidate', 'released'].includes(phase) && current.state !== 'done') blockers.push(blocker('FRONT_NOT_DONE', `Front '${selected.slug}' is not done.`, { state: current.state }));
    }
  }
  for (const id of release.requirementIds) {
    const evidence = requirementEvidence instanceof Map ? requirementEvidence.get(id) : requirementEvidence?.[id];
    if (!evidence?.accepted) blockers.push(blocker('REQUIREMENT_NOT_ACCEPTED', `Requirement '${id}' is not accepted.`));
    if (!Array.isArray(evidence?.tests) || !evidence.tests.length) blockers.push(blocker('REQUIRED_TEST_UNDEFINED', `Requirement '${id}' has no required test.`));
    else if (['candidate', 'released'].includes(phase)) for (const test of evidence.tests) {
      if (test.status !== 'passed') blockers.push(blocker('REQUIRED_TEST_NOT_PASSED', `Required test '${test.id || 'unknown'}' for '${id}' is '${test.status || 'missing'}'.`, { requirementId: id, testId: test.id || null, status: test.status || null }));
      if (!SHA256.test(String(test.sourceRevision || '').toLowerCase()) && !GIT_REVISION.test(String(test.sourceRevision || '').toLowerCase())) {
        blockers.push(blocker('TEST_EVIDENCE_STALE', `Required test '${test.id || 'unknown'}' for '${id}' has no exact source revision.`));
      }
    }
  }
  if (['candidate', 'released'].includes(phase)) for (const gate of priorGates) {
    if (gate?.status !== 'passed') blockers.push(blocker('PRIOR_GATE_NOT_PASSED', `Prior release gate '${gate?.id || 'unknown'}' is not passing.`));
    if (!GIT_REVISION.test(String(gate?.sourceRevision || '').toLowerCase()) && !SHA256.test(String(gate?.sourceRevision || '').toLowerCase())) {
      blockers.push(blocker('PRIOR_GATE_STALE', `Prior release gate '${gate?.id || 'unknown'}' has no exact source revision.`));
    }
  }
  if (['candidate', 'released'].includes(phase)) {
    let candidate;
    try { candidate = normalizeCandidate(candidateEvidence || release.candidate); }
    catch (error) { blockers.push(blocker(error.code || 'INVALID_CANDIDATE', error.message)); }
    if (candidate && phase === 'candidate' && candidate.contractRevision !== value.revision) {
      blockers.push(blocker('CANDIDATE_CONTRACT_STALE', 'Candidate evidence was measured against a different release contract revision.', { expected: value.revision, actual: candidate.contractRevision }));
    }
  }
  return { phase, ready: blockers.length === 0, blockers };
}

function releaseDirectory(repository) {
  return join(repository.path, '.handraise', 'releases');
}

function ensureNative(repository) {
  if (repository?.adapter === 'director') throw new ReleaseError('DIRECTOR_RELEASE_READ_ONLY', 'Director releases are read-only until its own validated release helper exists');
  if (repository?.adapter !== 'handraise' || !existsSync(join(repository.path, '.handraise'))) {
    throw new ReleaseError('REPOSITORY_NOT_INITIALIZED', 'native Handraise metadata must be initialized before creating releases');
  }
}

function withRepositoryLock(repository, operation) {
  const lock = join(repository.path, '.handraise', '.management-lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new ReleaseError('REPOSITORY_BUSY', 'another Handraise project update is finishing; try again in a moment');
    throw error;
  }
  try { return operation(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function atomicWrite(path, markdown) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, markdown, { flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function currentFronts(release, fronts) {
  const index = new Map(fronts.map((front) => [front.slug, front]));
  for (const selected of release.fronts) {
    const current = index.get(selected.slug);
    if (!current) throw new ReleaseError('FRONT_NOT_FOUND', `front '${selected.slug}' is unavailable`);
    if (current.revision !== selected.revision) throw new ReleaseError('FRONT_REVISION_STALE', `front '${selected.slug}' changed after release review`);
    if (Number(current.schemaVersion) < 2) throw new ReleaseError('FRONT_SCHEMA_UNSUPPORTED', `front '${selected.slug}' must use schema v2`);
  }
}

export class ReleaseStore {
  constructor({ now = Date.now } = {}) {
    this.now = typeof now === 'function' ? now : () => now;
  }

  list(repository) {
    if (repository?.adapter === 'director') return [];
    let names = [];
    try { names = readdirSync(releaseDirectory(repository)).filter((name) => name.endsWith('.md')).sort(); }
    catch { return []; }
    return names.map((name) => {
      const markdown = readFileSync(join(releaseDirectory(repository), name), 'utf8');
      return { ...parseRelease(markdown, { repositoryId: repository.id, fallbackSlug: name.replace(/\.md$/, '') }), revision: releaseRevision(markdown) };
    });
  }

  get(repository, slug) {
    if (!SLUG.test(String(slug || ''))) throw new ReleaseError('INVALID_RELEASE', 'invalid release slug');
    if (repository?.adapter === 'director') throw new ReleaseError('DIRECTOR_RELEASE_READ_ONLY', 'Director releases are read-only until its own validated release helper exists');
    const path = join(releaseDirectory(repository), `${slug}.md`);
    if (!existsSync(path)) throw new ReleaseError('RELEASE_NOT_FOUND', `release '${slug}' not found`);
    const markdown = readFileSync(path, 'utf8');
    return { ...parseRelease(markdown, { repositoryId: repository.id, fallbackSlug: slug }), revision: releaseRevision(markdown) };
  }

  assertMembership(repository, release, { exclude = null } = {}) {
    const selected = new Set(release.fronts.map((front) => front.slug));
    for (const other of this.list(repository)) {
      if (other.slug === exclude || !OPEN_STATES.has(other.state)) continue;
      const conflict = other.fronts.find((front) => selected.has(front.slug));
      if (conflict) throw new ReleaseError('FRONT_RELEASE_CONFLICT', `front '${conflict.slug}' already belongs to open release '${other.slug}'`);
    }
  }

  create(repository, value, { fronts = [] } = {}) {
    ensureNative(repository);
    const release = normalizeRelease(value, { repositoryId: repository.id, now: this.now() });
    if (release.state !== 'draft') throw new ReleaseError('INVALID_RELEASE_TRANSITION', 'new releases must begin in draft state');
    if (release.candidate) throw new ReleaseError('INVALID_RELEASE_TRANSITION', 'new releases cannot begin with candidate evidence');
    return withRepositoryLock(repository, () => {
      const path = join(releaseDirectory(repository), `${release.slug}.md`);
      if (existsSync(path)) throw new ReleaseError('RELEASE_EXISTS', `release '${release.slug}' already exists`);
      currentFronts(release, fronts);
      this.assertMembership(repository, release);
      mkdirSync(releaseDirectory(repository), { recursive: true });
      const markdown = renderRelease(release);
      atomicWrite(path, markdown);
      return { ...parseRelease(markdown, { repositoryId: repository.id }), revision: releaseRevision(markdown) };
    });
  }

  update(repository, slug, updates, { expectedRevision, fronts = [] } = {}) {
    ensureNative(repository);
    const path = join(releaseDirectory(repository), `${slug}.md`);
    if (!existsSync(path)) throw new ReleaseError('RELEASE_NOT_FOUND', `release '${slug}' not found`);
    const baseline = readFileSync(path, 'utf8');
    const baselineRevision = releaseRevision(baseline);
    if (expectedRevision !== baselineRevision) throw new ReleaseError('RELEASE_BASELINE_CHANGED', `release '${slug}' changed before this reviewed update`, { details: { expected: expectedRevision, current: baselineRevision } });
    if (Object.prototype.hasOwnProperty.call(updates || {}, 'state') || Object.prototype.hasOwnProperty.call(updates || {}, 'candidate')) {
      throw new ReleaseError('INVALID_RELEASE_TRANSITION', 'release state and candidate evidence changes must use the transition operation');
    }
    const current = parseRelease(baseline, { repositoryId: repository.id, fallbackSlug: slug });
    const next = normalizeRelease({
      ...current, ...updates, slug: current.slug, state: current.state,
      createdAt: current.createdAt, updatedAt: this.now(),
    }, { repositoryId: repository.id, now: this.now() });
    const markdown = renderRelease(next, { existingMarkdown: baseline });
    return withRepositoryLock(repository, () => {
      if (readFileSync(path, 'utf8') !== baseline) throw new ReleaseError('RELEASE_BASELINE_CHANGED', `release '${slug}' changed while this update waited for its lock`);
      currentFronts(next, fronts);
      this.assertMembership(repository, next, { exclude: slug });
      atomicWrite(path, markdown);
      return { ...parseRelease(markdown, { repositoryId: repository.id }), revision: releaseRevision(markdown) };
    });
  }

  transition(repository, slug, targetState, {
    expectedRevision, fronts = [], requirementEvidence = {}, priorGates = [], candidateEvidence = null,
  } = {}) {
    ensureNative(repository);
    const current = this.get(repository, slug);
    if (expectedRevision !== current.revision) throw new ReleaseError('RELEASE_BASELINE_CHANGED', `release '${slug}' changed before this reviewed transition`);
    if (!RELEASE_STATES.includes(targetState) || !LEGAL_TRANSITIONS[current.state]?.has(targetState)) {
      throw new ReleaseError('INVALID_RELEASE_TRANSITION', `illegal release transition ${current.state} → ${targetState}`);
    }
    const phase = targetState === 'ready' ? 'ready' : targetState === 'candidate' ? 'candidate' : targetState === 'released' ? 'released' : null;
    const candidate = targetState === 'candidate' ? normalizeCandidate(candidateEvidence) : current.candidate;
    if (phase) {
      const assessment = assessRelease(current, {
        fronts, requirementEvidence, priorGates, candidateEvidence: candidate, phase,
      });
      if (!assessment.ready) throw new ReleaseError('RELEASE_NOT_READY', `release '${slug}' cannot become ${targetState}`, { details: assessment });
    }
    const path = join(releaseDirectory(repository), `${slug}.md`);
    const baseline = readFileSync(path, 'utf8');
    const next = normalizeRelease({
      ...current, state: targetState, candidate, createdAt: current.createdAt, updatedAt: this.now(),
    }, { repositoryId: repository.id, now: this.now() });
    const markdown = renderRelease(next, { existingMarkdown: baseline });
    return withRepositoryLock(repository, () => {
      if (releaseRevision(readFileSync(path, 'utf8')) !== expectedRevision) throw new ReleaseError('RELEASE_BASELINE_CHANGED', `release '${slug}' changed while this transition waited for its lock`);
      currentFronts(next, fronts);
      this.assertMembership(repository, next, { exclude: slug });
      atomicWrite(path, markdown);
      return { ...parseRelease(markdown, { repositoryId: repository.id }), revision: releaseRevision(markdown) };
    });
  }
}
