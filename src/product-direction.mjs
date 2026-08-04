import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

export const PRODUCT_BRIEF_SCHEMA_VERSION = 1;
export const PRODUCT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const COLLECTIONS = [
  'users', 'outcomes', 'constraints', 'invariants', 'nonGoals', 'glossary', 'goals',
  'repositoryRoles', 'assumptions', 'decisions', 'conflicts',
];
const SECTION_DEFINITIONS = [
  ['purpose', 'Purpose', ['purpose', 'product purpose', 'vision']],
  ['users', 'Users and jobs', ['users and jobs', 'users', 'personas']],
  ['outcomes', 'Desired outcomes', ['desired outcomes', 'outcomes']],
  ['constraints', 'Constraints', ['constraints']],
  ['invariants', 'Invariants', ['invariants']],
  ['nonGoals', 'Non-goals', ['non-goals', 'non goals']],
  ['glossary', 'Glossary', ['glossary', 'vocabulary']],
  ['goals', 'Goals', ['goals', 'priorities']],
  ['repositoryRoles', 'Repository roles', ['repository roles', 'repositories']],
  ['assumptions', 'Assumptions and questions', ['assumptions and questions', 'assumptions', 'open questions']],
  ['decisions', 'Decisions', ['decisions']],
  ['conflicts', 'Conflicts to resolve', ['conflicts to resolve', 'conflicts']],
  ['sources', 'Sources', ['sources']],
];
const SECTION_KEY = new Map(SECTION_DEFINITIONS.flatMap(([key, , aliases]) => aliases.map((alias) => [alias, key])));
const SOURCE_KINDS = new Set(['human', 'document', 'connected-source']);
const PRIORITIES = new Set(['now', 'next', 'later', 'unspecified']);
const GOAL_STATES = new Set(['proposed', 'active', 'achieved', 'retired']);
const DECISION_STATES = new Set(['open', 'resolved', 'dismissed']);
const MAX_DOCUMENTS = 12;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOTAL_IMPORT_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

class ProductDirectionError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProductDirectionError';
    this.code = code;
    this.details = details;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const revision = (markdown) => markdown === null ? null : sha256(markdown);

function fail(code, message, details = null) {
  throw new ProductDirectionError(code, message, details);
}

function cleanLine(value, { max = 1_000, required = true } = {}) {
  const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (required && !result) fail('INVALID_PRODUCT_BRIEF', 'a product brief entry is empty');
  return result;
}

function cleanText(value, { max = 12_000, required = false } = {}) {
  const result = String(value ?? '').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
  if (required && !result) fail('INVALID_PRODUCT_BRIEF', 'required product brief text is empty');
  return result;
}

function idSlug(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'item';
}

function normalizeId(value, kind, fallbackText) {
  const candidate = cleanLine(value || `${kind}:${idSlug(fallbackText)}`, { max: 128 });
  if (!SAFE_ID.test(candidate)) fail('INVALID_PRODUCT_BRIEF', `invalid ${kind} id '${candidate}'`);
  return candidate;
}

function stringList(value, { maxItems = 100, itemMax = 1_000 } = {}) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  if (items.length > maxItems) fail('INVALID_PRODUCT_BRIEF', `a product brief list exceeds ${maxItems} entries`);
  return [...new Set(items.map((item) => cleanLine(item, { max: itemMax })).filter(Boolean))];
}

function normalizeSource(source, index) {
  const label = cleanLine(source?.label || source?.path || `Source ${index + 1}`, { max: 240 });
  const kind = SOURCE_KINDS.has(source?.kind) ? source.kind : 'human';
  const result = {
    id: normalizeId(source?.id, 'source', label),
    kind,
    label,
  };
  if (source?.path) result.path = cleanLine(source.path, { max: 4_096 });
  if (source?.digest) {
    const digest = cleanLine(source.digest, { max: 64 });
    if (!/^[a-f0-9]{64}$/.test(digest)) fail('INVALID_PRODUCT_BRIEF', `source '${result.id}' has an invalid digest`);
    result.digest = digest;
  }
  if (source?.selectedAt) {
    const selectedAt = new Date(source.selectedAt);
    if (!Number.isFinite(selectedAt.getTime())) fail('INVALID_PRODUCT_BRIEF', `source '${result.id}' has an invalid selectedAt`);
    result.selectedAt = selectedAt.toISOString();
  }
  return result;
}

function normalizeStatement(item, kind, index, sourceIds) {
  const input = typeof item === 'string' ? { text: item } : item || {};
  const text = cleanText(input.text, { max: 4_096, required: true });
  return {
    id: normalizeId(input.id, kind, text),
    text,
    sourceIds: stringList(input.sourceIds?.length ? input.sourceIds : ['source:human'], { maxItems: 32, itemMax: 128 }),
    locked: Boolean(input.locked),
    order: Number.isInteger(Number(input.order)) && Number(input.order) > 0 ? Number(input.order) : index + 1,
  };
}

function normalizeGlossary(item, index) {
  const input = typeof item === 'string' ? (() => {
    const [term, ...definition] = item.split(/\s+[—–-]\s+/);
    return { term, definition: definition.join(' — ') || term };
  })() : item || {};
  const term = cleanLine(input.term, { max: 160 });
  const definition = cleanText(input.definition, { max: 2_000, required: true });
  return {
    id: normalizeId(input.id, 'term', term),
    term,
    definition,
    aliases: stringList(input.aliases, { maxItems: 32, itemMax: 160 }),
    sourceIds: stringList(input.sourceIds?.length ? input.sourceIds : ['source:human'], { maxItems: 32, itemMax: 128 }),
    locked: Boolean(input.locked),
    order: Number.isInteger(Number(input.order)) && Number(input.order) > 0 ? Number(input.order) : index + 1,
  };
}

function normalizeGoal(item, index) {
  const input = typeof item === 'string' ? { title: item, outcome: item } : item || {};
  const title = cleanLine(input.title || input.text || input.outcome, { max: 240 });
  return {
    id: normalizeId(input.id, 'goal', title),
    title,
    outcome: cleanText(input.outcome || input.text || title, { max: 4_096, required: true }),
    priority: PRIORITIES.has(input.priority) ? input.priority : 'unspecified',
    horizon: cleanLine(input.horizon, { max: 160, required: false }),
    state: GOAL_STATES.has(input.state) ? input.state : 'proposed',
    successSignals: stringList(input.successSignals, { maxItems: 50, itemMax: 1_000 }),
    constraintIds: stringList(input.constraintIds, { maxItems: 100, itemMax: 128 }),
    repositoryIds: stringList(input.repositoryIds, { maxItems: 100, itemMax: 128 }),
    sourceIds: stringList(input.sourceIds?.length ? input.sourceIds : ['source:human'], { maxItems: 32, itemMax: 128 }),
    locked: Boolean(input.locked),
    order: Number.isInteger(Number(input.order)) && Number(input.order) > 0 ? Number(input.order) : index + 1,
  };
}

function normalizeRepositoryRole(item, index) {
  const input = typeof item === 'string' ? { role: item } : item || {};
  const role = cleanText(input.role || input.text, { max: 2_000, required: true });
  return {
    id: normalizeId(input.id, 'repository-role', input.repositoryId || role),
    repositoryId: cleanLine(input.repositoryId, { max: 128, required: false }),
    role,
    sourceIds: stringList(input.sourceIds?.length ? input.sourceIds : ['source:human'], { maxItems: 32, itemMax: 128 }),
    locked: Boolean(input.locked),
    order: Number.isInteger(Number(input.order)) && Number(input.order) > 0 ? Number(input.order) : index + 1,
  };
}

function normalizeDecision(item, index, kind = 'decision') {
  const input = typeof item === 'string' ? { question: item } : item || {};
  const question = cleanText(input.question || input.text || input.summary, { max: 4_096, required: true });
  const result = {
    id: normalizeId(input.id, kind, question),
    question,
    answer: cleanText(input.answer || input.resolution, { max: 4_096 }),
    state: DECISION_STATES.has(input.state || input.status) ? (input.state || input.status) : 'open',
    sourceIds: stringList(input.sourceIds?.length ? input.sourceIds : ['source:human'], { maxItems: 32, itemMax: 128 }),
    locked: Boolean(input.locked),
    order: Number.isInteger(Number(input.order)) && Number(input.order) > 0 ? Number(input.order) : index + 1,
  };
  return result;
}

function normalizeConflict(item, index) {
  const decision = normalizeDecision(item, index, 'conflict');
  return { ...decision, summary: decision.question };
}

function uniqueById(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) fail('INVALID_PRODUCT_BRIEF', `duplicate ${label} id '${item.id}'`);
    seen.add(item.id);
  }
  return items.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function ensureReferences(brief) {
  const sourceIds = new Set(brief.sources.map((source) => source.id));
  const constraintIds = new Set([...brief.constraints, ...brief.invariants].map((item) => item.id));
  for (const collection of COLLECTIONS) {
    for (const item of brief[collection]) {
      for (const sourceId of item.sourceIds || []) {
        if (!sourceIds.has(sourceId)) fail('INVALID_PRODUCT_BRIEF', `${item.id} references unknown source '${sourceId}'`);
      }
    }
  }
  for (const sourceId of brief.purpose.sourceIds) {
    if (!sourceIds.has(sourceId)) fail('INVALID_PRODUCT_BRIEF', `purpose references unknown source '${sourceId}'`);
  }
  for (const goal of brief.goals) {
    for (const constraintId of goal.constraintIds) {
      if (!constraintIds.has(constraintId)) fail('INVALID_PRODUCT_BRIEF', `goal '${goal.id}' references unknown constraint '${constraintId}'`);
    }
  }
}

export function normalizeProductBrief(value = {}, { repositoryId = '', now = Date.now() } = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const suppliedSources = Array.isArray(input.sources) ? input.sources.map(normalizeSource) : [];
  if (!suppliedSources.some((source) => source.id === 'source:human')) {
    suppliedSources.unshift({ id: 'source:human', kind: 'human', label: 'Direct human input' });
  }
  const sources = uniqueById(suppliedSources.map(normalizeSource), 'source');
  const purposeInput = typeof input.purpose === 'string' ? { text: input.purpose } : input.purpose || {};
  const brief = {
    schemaVersion: PRODUCT_BRIEF_SCHEMA_VERSION,
    title: cleanLine(input.title || 'Untitled product', { max: 160 }),
    stage: cleanLine(input.stage || 'unspecified', { max: 120 }),
    updatedAt: new Date(input.updatedAt || now).toISOString(),
    purpose: {
      id: 'purpose',
      text: cleanText(purposeInput.text, { max: 12_000 }),
      sourceIds: stringList(purposeInput.sourceIds?.length ? purposeInput.sourceIds : ['source:human'], { maxItems: 32, itemMax: 128 }),
      locked: Boolean(purposeInput.locked),
    },
    users: uniqueById((input.users || []).map((item, index) => normalizeStatement(item, 'user', index)), 'user'),
    outcomes: uniqueById((input.outcomes || []).map((item, index) => normalizeStatement(item, 'outcome', index)), 'outcome'),
    constraints: uniqueById((input.constraints || []).map((item, index) => normalizeStatement(item, 'constraint', index)), 'constraint'),
    invariants: uniqueById((input.invariants || []).map((item, index) => normalizeStatement(item, 'invariant', index)), 'invariant'),
    nonGoals: uniqueById((input.nonGoals || []).map((item, index) => normalizeStatement(item, 'non-goal', index)), 'non-goal'),
    glossary: uniqueById((input.glossary || []).map(normalizeGlossary), 'glossary'),
    goals: uniqueById((input.goals || []).map(normalizeGoal), 'goal'),
    repositoryRoles: uniqueById((input.repositoryRoles || []).map((item, index) => normalizeRepositoryRole(
      typeof item === 'string' ? { repositoryId, role: item } : { repositoryId, ...item }, index,
    )), 'repository role'),
    assumptions: uniqueById((input.assumptions || []).map((item, index) => normalizeStatement(item, 'assumption', index)), 'assumption'),
    decisions: uniqueById((input.decisions || []).map((item, index) => normalizeDecision(item, index)), 'decision'),
    conflicts: uniqueById((input.conflicts || []).map(normalizeConflict), 'conflict'),
    sources,
  };
  ensureReferences(brief);
  return brief;
}

function itemMetadata(item, omitted) {
  return Object.fromEntries(Object.entries(item).filter(([key, value]) => (
    !omitted.includes(key) && value !== '' && value !== false && !(Array.isArray(value) && value.length === 0)
  )));
}

function renderBullet(item, text, omitted = []) {
  const metadata = itemMetadata(item, ['id', 'text', 'order', ...omitted]);
  const suffix = Object.keys(metadata).length ? ` <!-- handraise:${JSON.stringify(metadata)} -->` : '';
  return `- [${item.id}] ${cleanText(text, { max: 8_000, required: true }).replace(/\n+/g, ' ')}${suffix}`;
}

function renderCollection(key, brief) {
  if (key === 'purpose') {
    const metadata = itemMetadata(brief.purpose, ['id', 'text']);
    return `${brief.purpose.text || '_Not declared yet._'}\n\n<!-- handraise:${JSON.stringify(metadata)} -->`;
  }
  if (key === 'glossary') return brief.glossary.length ? brief.glossary.map((item) => renderBullet(item, `**${item.term}** — ${item.definition}`, ['term', 'definition'])).join('\n') : '_None declared._';
  if (key === 'goals') return brief.goals.length ? brief.goals.map((item) => renderBullet(item, `**${item.title}** — ${item.outcome}`, ['title', 'outcome'])).join('\n') : '_None declared._';
  if (key === 'repositoryRoles') return brief.repositoryRoles.length ? brief.repositoryRoles.map((item) => renderBullet(item, `${item.repositoryId || 'Unassigned repository'} — ${item.role}`, ['repositoryId', 'role'])).join('\n') : '_None declared._';
  if (key === 'decisions') return brief.decisions.length ? brief.decisions.map((item) => renderBullet(item, `${item.question}${item.answer ? ` — ${item.answer}` : ''}`)).join('\n') : '_None declared._';
  if (key === 'conflicts') return brief.conflicts.length ? brief.conflicts.map((item) => renderBullet(item, `${item.summary}${item.answer ? ` — ${item.answer}` : ''}`)).join('\n') : '_None._';
  if (key === 'sources') return brief.sources.map((source) => renderBullet({ ...source, order: 0 }, `${source.label}${source.path ? ` — ${source.path}` : ''}`, ['label', 'path'])).join('\n');
  return brief[key].length ? brief[key].map((item) => renderBullet(item, item.text)).join('\n') : '_None declared._';
}

function parseScalar(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.replace(/^"|"$/g, ''); }
  }
  return raw;
}

function splitMarkdown(markdown) {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
  const frontmatterMatch = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const frontmatter = frontmatterMatch?.[1] || '';
  const body = frontmatterMatch ? normalized.slice(frontmatterMatch[0].length) : normalized;
  const matches = [...body.matchAll(/^##\s+(.+)$/gm)];
  const prefix = matches.length ? body.slice(0, matches[0].index) : body;
  const sections = matches.map((match, index) => ({
    title: match[1].trim(),
    content: body.slice(match.index + match[0].length, matches[index + 1]?.index ?? body.length).trim(),
  }));
  return { frontmatter, prefix, sections };
}

function parseFrontmatter(raw) {
  const result = {};
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (match) result[match[1].toLowerCase()] = parseScalar(match[2]);
  }
  return result;
}

function parseMetadata(raw, context) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('metadata must be an object');
    return value;
  } catch (error) {
    fail('INVALID_PRODUCT_MARKDOWN', `${context} has invalid handraise metadata: ${error.message}`);
  }
}

function parseBullets(content, key) {
  if (!content || /^_None|^_Not declared/i.test(content)) return [];
  return content.split('\n').filter((line) => /^-\s+/.test(line)).map((line, index) => {
    const match = /^-\s+\[([^\]]+)\]\s+([\s\S]*?)(?:\s+<!--\s*handraise:(\{.*\})\s*-->)?\s*$/.exec(line);
    if (!match) fail('INVALID_PRODUCT_MARKDOWN', `${key} line ${index + 1} must use '- [id] text'`);
    const metadata = parseMetadata(match[3], `${key} '${match[1]}'`);
    return { id: match[1], display: match[2].trim(), ...metadata, order: metadata.order || index + 1 };
  });
}

function parseKnownSections(markdown, metadata) {
  const split = splitMarkdown(markdown);
  const byKey = new Map();
  for (const section of split.sections) {
    const key = SECTION_KEY.get(section.title.toLowerCase());
    if (key && !byKey.has(key)) byKey.set(key, section.content);
  }
  const purposeContent = byKey.get('purpose') || '';
  const purposeMetaMatch = /<!--\s*handraise:(\{.*\})\s*-->\s*$/.exec(purposeContent);
  const purposeText = purposeContent.replace(/<!--\s*handraise:\{.*\}\s*-->\s*$/, '').trim().replace(/^_Not declared yet\._$/i, '');
  const sourceItems = parseBullets(byKey.get('sources'), 'sources').map((item) => {
    const [label, path] = item.display.split(/\s+—\s+/, 2);
    return { ...item, label: item.label || label, path: item.path || path };
  });
  const generic = (key) => parseBullets(byKey.get(key), key).map((item) => ({ ...item, text: item.display }));
  const glossary = parseBullets(byKey.get('glossary'), 'glossary').map((item) => {
    const visible = item.display.replace(/^\*\*|\*\*$/g, '');
    const [term, ...definition] = visible.split(/\*\*\s+—\s+|\s+—\s+/);
    return { ...item, term: item.term || term.replaceAll('**', ''), definition: item.definition || definition.join(' — ') };
  });
  const goals = parseBullets(byKey.get('goals'), 'goals').map((item) => {
    const [title, ...outcome] = item.display.replaceAll('**', '').split(/\s+—\s+/);
    return { ...item, title: item.title || title, outcome: item.outcome || outcome.join(' — ') || title };
  });
  const repositoryRoles = parseBullets(byKey.get('repositoryRoles'), 'repositoryRoles').map((item) => {
    const [repositoryId, ...role] = item.display.split(/\s+—\s+/);
    return { ...item, repositoryId: item.repositoryId || (repositoryId === 'Unassigned repository' ? '' : repositoryId), role: item.role || role.join(' — ') };
  });
  const decisions = parseBullets(byKey.get('decisions'), 'decisions').map((item) => ({ ...item, question: item.question || item.display }));
  const conflicts = parseBullets(byKey.get('conflicts'), 'conflicts').map((item) => ({ ...item, summary: item.summary || item.display }));
  return {
    schemaVersion: Number(metadata.schema || metadata.schemaversion || 1),
    title: metadata.title || 'Untitled product',
    stage: metadata.stage || 'unspecified',
    updatedAt: metadata.updated || new Date(0).toISOString(),
    purpose: { text: purposeText, ...parseMetadata(purposeMetaMatch?.[1], 'purpose') },
    users: generic('users'), outcomes: generic('outcomes'), constraints: generic('constraints'),
    invariants: generic('invariants'), nonGoals: generic('nonGoals'), glossary, goals, repositoryRoles,
    assumptions: generic('assumptions'), decisions, conflicts, sources: sourceItems,
  };
}

export function parseProductBrief(markdown, options = {}) {
  const split = splitMarkdown(markdown);
  const metadata = parseFrontmatter(split.frontmatter);
  const schemaVersion = Number(metadata.schema || metadata.schemaversion || 1);
  if (schemaVersion !== PRODUCT_BRIEF_SCHEMA_VERSION) {
    fail('INCOMPATIBLE_PRODUCT_SCHEMA', `unsupported product brief schema ${schemaVersion}`);
  }
  return normalizeProductBrief(parseKnownSections(markdown, metadata), options);
}

function mergeFrontmatter(raw, brief) {
  const replacements = new Map([
    ['schema', String(PRODUCT_BRIEF_SCHEMA_VERSION)],
    ['title', JSON.stringify(brief.title)],
    ['stage', JSON.stringify(brief.stage)],
    ['updated', brief.updatedAt],
  ]);
  const seen = new Set();
  const lines = raw ? raw.split('\n').map((line) => {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line.trim());
    const key = match?.[1]?.toLowerCase();
    if (!key || !replacements.has(key)) return line;
    if (seen.has(key)) return null;
    seen.add(key);
    return `${match[1]}: ${replacements.get(key)}`;
  }).filter((line) => line !== null) : [];
  for (const [key, value] of replacements) if (!seen.has(key)) lines.push(`${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---`;
}

export function renderProductBrief(value, { existingMarkdown = '', repositoryId = '', now = Date.now() } = {}) {
  const brief = normalizeProductBrief({ ...value, updatedAt: value?.updatedAt || new Date(now).toISOString() }, { repositoryId, now });
  const split = splitMarkdown(existingMarkdown);
  const rendered = new Map(SECTION_DEFINITIONS.map(([key, heading]) => [key, { heading, content: renderCollection(key, brief) }]));
  const used = new Set();
  const sections = [];
  for (const section of split.sections) {
    const key = SECTION_KEY.get(section.title.toLowerCase());
    if (!key || used.has(key)) {
      sections.push(`## ${section.title}\n\n${section.content}`.trimEnd());
      continue;
    }
    const next = rendered.get(key);
    sections.push(`## ${next.heading}\n\n${next.content}`.trimEnd());
    used.add(key);
  }
  for (const [key, next] of rendered) {
    if (!used.has(key)) sections.push(`## ${next.heading}\n\n${next.content}`.trimEnd());
  }
  let prefix = split.prefix.trim();
  if (/^#\s+/m.test(prefix)) prefix = prefix.replace(/^#\s+.*$/m, `# Product brief — ${brief.title}`);
  else prefix = `# Product brief — ${brief.title}${prefix ? `\n\n${prefix}` : ''}`;
  return `${mergeFrontmatter(split.frontmatter, brief)}\n\n${prefix}\n\n${sections.join('\n\n')}\n`;
}

export function productBriefQuestions(value) {
  const brief = normalizeProductBrief(value);
  const questions = [];
  if (!brief.purpose.text) questions.push({ id: 'purpose', section: 'purpose', question: 'What should this product make possible, and for whom?', blocking: false });
  if (!brief.users.length) questions.push({ id: 'users', section: 'users', question: 'Who has the problem this product is solving, and what job are they trying to do?', blocking: false });
  if (!brief.outcomes.length) questions.push({ id: 'outcomes', section: 'outcomes', question: 'Which observable outcomes would make the product successful?', blocking: false });
  if (!brief.constraints.length && !brief.invariants.length) questions.push({ id: 'constraints', section: 'constraints', question: 'Which constraints or invariants must every design preserve?', blocking: false });
  if (!brief.nonGoals.length) questions.push({ id: 'non-goals', section: 'nonGoals', question: 'What should this product deliberately not become?', blocking: false });
  if (!brief.goals.length) questions.push({ id: 'goals', section: 'goals', question: 'What is the most important current product goal?', blocking: false });
  return questions;
}

export function readAcceptedProduct(repository) {
  const productPath = join(repository.path, '.handraise', 'product.md');
  if (!existsSync(productPath)) return { supported: existsSync(join(repository.path, '.handraise', 'components')) && existsSync(join(repository.path, '.handraise', 'fronts')), exists: false, brief: null, markdown: null, revision: null };
  const markdown = readFileSync(productPath, 'utf8');
  return { supported: true, exists: true, brief: parseProductBrief(markdown, { repositoryId: repository.id }), markdown, revision: revision(markdown) };
}

function collectionMap(brief) {
  const entries = [['purpose', brief.purpose]];
  for (const collection of COLLECTIONS) for (const item of brief[collection]) entries.push([item.id, item]);
  return new Map(entries);
}

function assertLocked(previous, next, unlockIds) {
  const allowed = new Set(unlockIds || []);
  const nextItems = collectionMap(next);
  for (const [id, item] of collectionMap(previous)) {
    if (!item.locked || allowed.has(id)) continue;
    const candidate = nextItems.get(id);
    if (!candidate || JSON.stringify(candidate) !== JSON.stringify(item)) {
      fail('LOCKED_PRODUCT_DECISION', `locked product entry '${id}' must be explicitly unlocked before changing it`, { id });
    }
  }
}

function sectionsFromDocument(markdown) {
  const matches = [...String(markdown).matchAll(/^#{1,3}\s+(.+)$/gm)];
  return matches.map((match, index) => ({
    title: match[1].trim().toLowerCase(),
    content: String(markdown).slice(match.index + match[0].length, matches[index + 1]?.index ?? String(markdown).length).trim(),
  }));
}

function documentBullets(content) {
  return String(content || '').split('\n').map((line) => /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line)?.[1]?.trim()).filter(Boolean).slice(0, 50);
}

function firstParagraph(content) {
  return String(content || '').split(/\n\s*\n/).map((value) => value.replace(/^\s*[-*#].*$/gm, '').replace(/\s+/g, ' ').trim()).find(Boolean) || '';
}

function importedItems(markdown, source) {
  const result = { purpose: '', users: [], outcomes: [], constraints: [], invariants: [], nonGoals: [], glossary: [], goals: [], assumptions: [] };
  const sections = sectionsFromDocument(markdown);
  for (const section of sections) {
    if (/^(purpose|product thesis|vision|what .+ is)$/.test(section.title) && !result.purpose) result.purpose = firstParagraph(section.content);
    else if (/user|persona|jobs? to be done/.test(section.title)) result.users.push(...documentBullets(section.content));
    else if (/outcome|success|promise/.test(section.title)) result.outcomes.push(...documentBullets(section.content));
    else if (/constraint|guardrail/.test(section.title)) result.constraints.push(...documentBullets(section.content));
    else if (/invariant|principle/.test(section.title)) result.invariants.push(...documentBullets(section.content));
    else if (/non[- ]?goal|out of scope/.test(section.title)) result.nonGoals.push(...documentBullets(section.content));
    else if (/glossary|vocabulary|terminology/.test(section.title)) result.glossary.push(...documentBullets(section.content));
    else if (/goal|priorit|roadmap/.test(section.title)) result.goals.push(...documentBullets(section.content));
  }
  if (!result.purpose && !Object.entries(result).some(([key, value]) => key !== 'purpose' && value.length)) {
    const fallback = firstParagraph(markdown.replace(/^---[\s\S]*?---/, ''));
    if (fallback) result.assumptions.push(`Imported context from ${source.label}: ${fallback}`);
  }
  return result;
}

function appendUnique(collection, items, kind, sourceId) {
  const known = new Set(collection.map((item) => item.text.toLocaleLowerCase()));
  for (const text of items) {
    if (!text || known.has(text.toLocaleLowerCase())) continue;
    collection.push({ id: normalizeId('', kind, text), text, sourceIds: [sourceId], locked: false, order: collection.length + 1 });
    known.add(text.toLocaleLowerCase());
  }
}

function mergeDocument(brief, imported, source) {
  const next = structuredClone(brief);
  if (imported.purpose) {
    if (!next.purpose.text) next.purpose = { ...next.purpose, text: imported.purpose, sourceIds: [source.id] };
    else if (next.purpose.text.toLocaleLowerCase() !== imported.purpose.toLocaleLowerCase()) {
      const id = `conflict:purpose-${source.digest.slice(0, 8)}`;
      if (!next.conflicts.some((item) => item.id === id)) next.conflicts.push({
        id, summary: `Purpose from ${source.label} differs from the current purpose: ${imported.purpose}`,
        question: `Purpose from ${source.label} differs from the current purpose: ${imported.purpose}`,
        answer: '', state: 'open', sourceIds: [...new Set([...next.purpose.sourceIds, source.id])], locked: false,
        order: next.conflicts.length + 1,
      });
    }
  }
  appendUnique(next.users, imported.users, 'user', source.id);
  appendUnique(next.outcomes, imported.outcomes, 'outcome', source.id);
  appendUnique(next.constraints, imported.constraints, 'constraint', source.id);
  appendUnique(next.invariants, imported.invariants, 'invariant', source.id);
  appendUnique(next.nonGoals, imported.nonGoals, 'non-goal', source.id);
  appendUnique(next.assumptions, imported.assumptions, 'assumption', source.id);
  for (const item of imported.glossary) {
    const [term, ...definition] = item.split(/\s+[—–-]\s+/);
    if (!definition.length) continue;
    const existing = next.glossary.find((entry) => entry.term.toLocaleLowerCase() === term.toLocaleLowerCase());
    if (existing && existing.definition.toLocaleLowerCase() !== definition.join(' — ').toLocaleLowerCase()) {
      const id = `conflict:term-${idSlug(term)}-${source.digest.slice(0, 8)}`;
      if (!next.conflicts.some((entry) => entry.id === id)) next.conflicts.push({
        id, summary: `Glossary definition for '${term}' differs in ${source.label}.`, question: `Glossary definition for '${term}' differs in ${source.label}.`,
        answer: '', state: 'open', sourceIds: [...new Set([...existing.sourceIds, source.id])], locked: false, order: next.conflicts.length + 1,
      });
    } else if (!existing) next.glossary.push({ term, definition: definition.join(' — '), sourceIds: [source.id] });
  }
  for (const title of imported.goals) {
    if (!next.goals.some((goal) => goal.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
      next.goals.push({ title, outcome: title, sourceIds: [source.id], order: next.goals.length + 1 });
    }
  }
  if (!next.sources.some((item) => item.id === source.id)) next.sources.push(source);
  return next;
}

function safeDocument(repositoryRoot, requested) {
  const root = realpathSync(repositoryRoot);
  const candidate = realpathSync(resolve(root, String(requested || '')));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) fail('INVALID_IMPORT_PATH', 'selected document must be inside the repository');
  if (lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) fail('INVALID_IMPORT_PATH', 'selected document must be a regular file');
  if (!['.md', '.mdx'].includes(extname(candidate).toLowerCase())) fail('INVALID_IMPORT_PATH', 'only selected Markdown documents can be imported');
  const size = statSync(candidate).size;
  if (size > MAX_DOCUMENT_BYTES) fail('IMPORT_LIMIT', `${basename(candidate)} exceeds the per-document import limit`);
  return { absolute: candidate, relative: relative(root, candidate).replaceAll('\\', '/'), size };
}

export function inspectProductSources(repository, value) {
  const brief = normalizeProductBrief(value, { repositoryId: repository.id });
  return brief.sources.map((source) => {
    if (source.kind !== 'document' || !source.path || !source.digest) {
      return { sourceId: source.id, status: source.kind === 'human' ? 'current' : 'unknown', reason: null };
    }
    try {
      const document = safeDocument(repository.path, source.path);
      const currentDigest = sha256(readFileSync(document.absolute));
      return currentDigest === source.digest
        ? { sourceId: source.id, status: 'current', reason: null, currentDigest }
        : { sourceId: source.id, status: 'stale', reason: 'The selected document changed after it was imported.', currentDigest };
    } catch (error) {
      return {
        sourceId: source.id,
        status: error?.code === 'ENOENT' ? 'missing' : 'unavailable',
        reason: error?.code === 'ENOENT' ? 'The selected document no longer exists.' : String(error?.message || error),
      };
    }
  });
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicPrivateWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function cleanProductTemps(directory) {
  for (const name of readdirSync(directory)) {
    if (name.startsWith('product.md.tmp-')) rmSync(join(directory, name), { force: true });
  }
}

function atomicAcceptedWrite(path, markdown) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, markdown, { mode: 0o644, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export class ProductDirectionDraftStore {
  constructor({ root, now = () => Date.now(), ttlMs = PRODUCT_DRAFT_TTL_MS, acceptedWrite = atomicAcceptedWrite } = {}) {
    if (!root) throw new Error('product direction draft storage root is required');
    this.root = join(root, 'product-drafts');
    this.now = now;
    this.ttlMs = ttlMs;
    this.acceptedWrite = acceptedWrite;
    ensurePrivateDirectory(this.root);
  }

  #path(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id || ''))) fail('DRAFT_NOT_FOUND', 'product direction draft not found');
    return join(this.root, `${id}.json`);
  }

  #load(id) {
    const path = this.#path(id);
    let draft;
    try { draft = JSON.parse(readFileSync(path, 'utf8')); }
    catch { fail('DRAFT_NOT_FOUND', 'product direction draft not found'); }
    if (draft.expiresAtMs <= this.now()) {
      rmSync(path, { force: true });
      fail('DRAFT_EXPIRED', 'product direction draft expired; create or resume a new draft');
    }
    return draft;
  }

  #save(draft) {
    draft.updatedAt = new Date(this.now()).toISOString();
    atomicPrivateWrite(this.#path(draft.id), draft);
    return draft;
  }

  #clean() {
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      try {
        const draft = JSON.parse(readFileSync(join(this.root, name), 'utf8'));
        if (!draft?.expiresAtMs || draft.expiresAtMs <= this.now()) unlinkSync(join(this.root, name));
      } catch { rmSync(join(this.root, name), { force: true }); }
    }
  }

  #current(repository) {
    return readAcceptedProduct(repository);
  }

  #public(repository, draft) {
    const accepted = this.#current(repository);
    return {
      id: draft.id,
      repositoryId: draft.repositoryId,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      expiresAt: new Date(draft.expiresAtMs).toISOString(),
      baselineRevision: draft.baselineRevision,
      currentRevision: accepted.revision,
      stale: accepted.revision !== draft.baselineRevision,
      canAccept: accepted.supported,
      acceptedExists: accepted.exists,
      imports: draft.imports || [],
      brief: draft.brief,
      sourceStates: inspectProductSources(repository, draft.brief),
      questions: productBriefQuestions(draft.brief),
    };
  }

  create(repository, { reset = false } = {}) {
    this.#clean();
    if (!reset) {
      const resumed = readdirSync(this.root).filter((name) => name.endsWith('.json')).flatMap((name) => {
        try {
          const draft = JSON.parse(readFileSync(join(this.root, name), 'utf8'));
          return draft.repositoryId === repository.id && draft.expiresAtMs > this.now() ? [draft] : [];
        } catch { return []; }
      }).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
      if (resumed) return this.#public(repository, resumed);
    }
    const accepted = this.#current(repository);
    const id = randomUUID();
    const now = new Date(this.now()).toISOString();
    const brief = accepted.brief || normalizeProductBrief({
      title: repository.name || 'Untitled product',
      repositoryRoles: [{ repositoryId: repository.id, role: 'Define this repository role.' }],
    }, { repositoryId: repository.id, now: this.now() });
    const draft = {
      id, repositoryId: repository.id, baselineRevision: accepted.revision,
      createdAt: now, updatedAt: now, expiresAtMs: this.now() + this.ttlMs,
      imports: [], brief,
    };
    this.#save(draft);
    return this.#public(repository, draft);
  }

  get(repository, id) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repository.id) fail('DRAFT_NOT_FOUND', 'product direction draft does not belong to this repository');
    return this.#public(repository, draft);
  }

  update(repository, id, { brief, unlockIds = [] } = {}) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repository.id) fail('DRAFT_NOT_FOUND', 'product direction draft does not belong to this repository');
    const normalized = normalizeProductBrief({ ...brief, updatedAt: new Date(this.now()).toISOString() }, { repositoryId: repository.id, now: this.now() });
    assertLocked(draft.brief, normalized, unlockIds);
    draft.brief = normalized;
    draft.expiresAtMs = this.now() + this.ttlMs;
    this.#save(draft);
    return this.#public(repository, draft);
  }

  importDocuments(repository, id, paths) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repository.id) fail('DRAFT_NOT_FOUND', 'product direction draft does not belong to this repository');
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_DOCUMENTS) fail('IMPORT_LIMIT', `select between 1 and ${MAX_DOCUMENTS} Markdown documents`);
    const documents = paths.map((path) => safeDocument(repository.path, path));
    if (documents.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL_IMPORT_BYTES) fail('IMPORT_LIMIT', 'selected documents exceed the total import limit');
    let next = draft.brief;
    for (const document of documents) {
      const markdown = readFileSync(document.absolute, 'utf8');
      const source = {
        id: `source:document-${sha256(`${document.relative}\0${markdown}`).slice(0, 16)}`,
        kind: 'document', label: basename(document.relative), path: document.relative,
        digest: sha256(markdown), selectedAt: new Date(this.now()).toISOString(),
      };
      next = mergeDocument(next, importedItems(markdown, source), source);
      if (!draft.imports.includes(document.relative)) draft.imports.push(document.relative);
    }
    const normalized = normalizeProductBrief({ ...next, updatedAt: new Date(this.now()).toISOString() }, { repositoryId: repository.id, now: this.now() });
    assertLocked(draft.brief, normalized, []);
    draft.brief = normalized;
    draft.expiresAtMs = this.now() + this.ttlMs;
    this.#save(draft);
    return this.#public(repository, draft);
  }

  planImport(repository, id, paths) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repository.id) fail('DRAFT_NOT_FOUND', 'product direction draft does not belong to this repository');
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_DOCUMENTS) fail('IMPORT_LIMIT', `select between 1 and ${MAX_DOCUMENTS} Markdown documents`);
    const documents = paths.map((path) => safeDocument(repository.path, path));
    const totalBytes = documents.reduce((sum, item) => sum + item.size, 0);
    if (totalBytes > MAX_TOTAL_IMPORT_BYTES) fail('IMPORT_LIMIT', 'selected documents exceed the total import limit');
    return {
      documents: documents.map((document) => ({ path: document.relative, bytes: document.size })),
      totalBytes,
      limits: { documents: MAX_DOCUMENTS, perDocumentBytes: MAX_DOCUMENT_BYTES, totalBytes: MAX_TOTAL_IMPORT_BYTES },
      repositoryMutation: false,
    };
  }

  preview(repository, id) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repository.id) fail('DRAFT_NOT_FOUND', 'product direction draft does not belong to this repository');
    const accepted = this.#current(repository);
    const proposed = renderProductBrief(draft.brief, {
      existingMarkdown: accepted.markdown || '', repositoryId: repository.id, now: this.now(),
    });
    return {
      baselineRevision: draft.baselineRevision,
      currentRevision: accepted.revision,
      proposedRevision: revision(proposed),
      stale: accepted.revision !== draft.baselineRevision,
      canAccept: accepted.supported,
      sourceStates: inspectProductSources(repository, draft.brief),
      before: accepted.markdown || '',
      after: proposed,
    };
  }

  accept(repository, id) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repository.id) fail('DRAFT_NOT_FOUND', 'product direction draft does not belong to this repository');
    const handraise = join(repository.path, '.handraise');
    if (existsSync(join(repository.path, '.claude', 'components'))
      && existsSync(join(repository.path, '.claude', 'runtime', 'plans'))) {
      fail('PRODUCT_ADAPTER_UNSUPPORTED', 'this Director repository does not expose a validated product-brief writer; keep the private draft or use Director when that capability becomes available');
    }
    if (!existsSync(join(handraise, 'components')) || !existsSync(join(handraise, 'fronts'))) {
      fail('PRODUCT_REPOSITORY_NOT_INITIALIZED', 'save the draft, then initialize the native Handraise repository before accepting its product brief');
    }
    const lock = join(handraise, '.management-lock');
    try { mkdirSync(lock); }
    catch (error) {
      if (error?.code === 'EEXIST') fail('PRODUCT_WRITE_BUSY', 'another Handraise project update is finishing; try again in a moment');
      throw error;
    }
    try {
      cleanProductTemps(handraise);
      const accepted = this.#current(repository);
      if (accepted.revision !== draft.baselineRevision) {
        fail('PRODUCT_BASELINE_CHANGED', 'product.md changed after this draft was created; review a fresh diff before accepting');
      }
      const markdown = renderProductBrief(draft.brief, {
        existingMarkdown: accepted.markdown || '', repositoryId: repository.id, now: this.now(),
      });
      this.acceptedWrite(join(handraise, 'product.md'), markdown);
      rmSync(this.#path(id), { force: true });
      return {
        accepted: true,
        revision: revision(markdown),
        brief: parseProductBrief(markdown, { repositoryId: repository.id }),
      };
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  discard(repository, id) {
    const draft = this.#load(id);
    if (draft.repositoryId !== repository.id) fail('DRAFT_NOT_FOUND', 'product direction draft does not belong to this repository');
    rmSync(this.#path(id), { force: true });
    return { discarded: id };
  }

  discardRepository(repositoryId) {
    this.#clean();
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      try {
        const draft = JSON.parse(readFileSync(join(this.root, name), 'utf8'));
        if (draft.repositoryId === repositoryId) rmSync(join(this.root, name), { force: true });
      } catch { /* cleanup already handled on the next pass */ }
    }
  }
}

export { ProductDirectionError };
