import { createHash } from 'node:crypto';

export const WORK_CONTRACT_SCHEMA_VERSION = 2;

export const COMPONENT_STATES = Object.freeze(['active', 'closing', 'retired']);
export const FRONT_STATES = Object.freeze(['queued', 'active', 'blocked', 'paused', 'done']);
export const COMPONENT_DEPENDENCY_KINDS = Object.freeze(['hard', 'soft', 'external']);
export const FRONT_DEPENDENCY_KINDS = Object.freeze(['hard', 'coordination', 'informational']);
export const INTERFACE_KINDS = Object.freeze(['provides', 'consumes']);
export const EVIDENCE_PROVENANCE = Object.freeze(['extracted', 'inferred', 'declared']);

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NONE = '_None declared._';

const COMPONENT_SECTION_DEFINITIONS = Object.freeze({
  purpose: { heading: 'Purpose', aliases: ['purpose', 'scope', 'alcance'] },
  outcomes: { heading: 'Outcomes', aliases: ['outcomes', 'resultados'] },
  responsibilities: { heading: 'Responsibilities', aliases: ['responsibilities', 'responsabilidades'] },
  limits: { heading: 'Limits', aliases: ['limits', 'boundaries', 'límites', 'limites'] },
  invariants: { heading: 'Invariants', aliases: ['invariants', 'invariantes'] },
  interfaces: { heading: 'Interfaces', aliases: ['interfaces'] },
  dependencies: { heading: 'Dependencies', aliases: ['dependencies', 'dependencias'] },
  dataSystems: { heading: 'Data and external systems', aliases: ['data and external systems', 'data', 'datos y sistemas externos'] },
  territory: { heading: 'Territory', aliases: ['territory', 'territorio'] },
  verification: { heading: 'Verification', aliases: ['verification', 'verificación', 'verificacion'] },
  evidence: { heading: 'Evidence', aliases: ['evidence', 'evidencia'] },
  uncertainties: { heading: 'Uncertainty and open questions', aliases: ['uncertainty and open questions', 'uncertainty', 'open questions', 'incertidumbre y preguntas abiertas'] },
  guidance: { heading: 'Agent guidance', aliases: ['agent guidance', 'guidance', 'delegation', 'delegación', 'delegacion'] },
});

const FRONT_SECTION_DEFINITIONS = Object.freeze({
  outcome: { heading: 'Observable outcome', aliases: ['observable outcome', 'resultado observable', 'objetivo del frente'] },
  motivation: { heading: 'Motivation', aliases: ['motivation', 'motivación', 'motivacion'] },
  scope: { heading: 'Scope', aliases: ['scope', 'alcance'] },
  nonGoals: { heading: 'Non-goals', aliases: ['non-goals', 'non goals', 'no objetivos'] },
  readiness: { heading: 'Readiness', aliases: ['readiness', 'preparación', 'preparacion'] },
  acceptanceCriteria: { heading: 'Acceptance criteria', aliases: ['acceptance criteria', 'acceptance', 'criterios de aceptación', 'criterios de aceptacion'] },
  verification: { heading: 'Verification', aliases: ['verification', 'verificación', 'verificacion'] },
  deliverables: { heading: 'Deliverables', aliases: ['deliverables', 'entregables'] },
  risks: { heading: 'Risks and unknowns', aliases: ['risks and unknowns', 'risks', 'unknowns', 'riesgos e incógnitas', 'riesgos e incognitas'] },
  dependencies: { heading: 'Dependencies', aliases: ['dependencies', 'dependencias'] },
  evidence: { heading: 'Evidence', aliases: ['evidence', 'evidencia'] },
  context: { heading: 'Confirmed context', aliases: ['confirmed context', 'contexto confirmado', 'contexto'] },
  handoff: { heading: '▶ Handoff', aliases: ['▶ handoff', 'handoff'] },
  checklist: { heading: 'Checklist', aliases: ['checklist'] },
});

export class WorkContractError extends Error {
  constructor(code, message, { diagnostics = [], details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WorkContractError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.details = details;
  }

  toJSON() {
    return { error: this.message, code: this.code, diagnostics: this.diagnostics, details: this.details };
  }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');

function normalizeHeading(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US');
}

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

function jsonScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^(?:\[|\{|"|-?\d|true$|false$|null$)/.test(value)) {
    try { return JSON.parse(value); } catch { /* legacy plain scalar */ }
  }
  return value;
}

function serializeScalar(value) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number' || value === null) return JSON.stringify(value);
  const text = cleanInline(value, 2_000);
  if (!text) return '""';
  if (/^[\[{]|^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(text) || text.includes('#')) return JSON.stringify(text);
  return text;
}

export function parseWorkMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new WorkContractError('INVALID_MARKDOWN', 'work contract Markdown must be a string');
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const frontmatterMatch = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(markdown);
  const metadata = {};
  const metadataKeys = {};
  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1].split(/\r?\n/)) {
      const pair = /^(\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*:\s*)(.*)$/.exec(line);
      if (!pair) continue;
      const key = pair[2].toLowerCase();
      metadata[key] = jsonScalar(pair[4]);
      metadataKeys[key] = pair[2];
    }
  }

  const foundSections = [];
  const headingPattern = /^##[ \t]+(.+?)[ \t]*\r?$/gm;
  const matches = [...markdown.matchAll(headingPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const headingEnd = match.index + match[0].length;
    let bodyStart = headingEnd;
    if (markdown.slice(bodyStart, bodyStart + 2) === '\r\n') bodyStart += 2;
    else if (markdown[bodyStart] === '\n') bodyStart += 1;
    const end = matches[index + 1]?.index ?? markdown.length;
    foundSections.push({
      heading: match[1].trim(),
      normalizedHeading: normalizeHeading(match[1]),
      start: match.index,
      headingEnd,
      bodyStart,
      end,
      body: markdown.slice(bodyStart, end).trim(),
    });
  }
  return {
    markdown,
    newline,
    frontmatter: frontmatterMatch ? {
      start: frontmatterMatch.index,
      end: frontmatterMatch.index + frontmatterMatch[0].length,
      raw: frontmatterMatch[0],
    } : null,
    metadata,
    metadataKeys,
    sections: foundSections,
  };
}

function sectionValue(document, definition) {
  const aliases = new Set(definition.aliases.map(normalizeHeading));
  return document.sections.find((section) => aliases.has(section.normalizedHeading))?.body || '';
}

function rawSections(document) {
  return Object.fromEntries(document.sections.map((section) => [section.heading, section.body]));
}

function strings(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => cleanInline(item, 128)).filter(Boolean))];
  if (typeof value !== 'string') return [];
  const parsed = jsonScalar(value);
  if (Array.isArray(parsed)) return strings(parsed);
  return [...new Set(value.split(',').map((item) => cleanInline(item, 128)).filter(Boolean))];
}

function bullets(value) {
  const clean = cleanBlock(value);
  if (!clean || clean === NONE) return [];
  const list = [...clean.matchAll(/^\s*[-*+]\s+(?:\[[ x~]\]\s+)?(.+)$/gm)].map((match) => match[1].trim());
  return list.length ? list : clean.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
}

function structuredBullets(value, kinds, { targetKey = 'target', descriptionKey = 'reason' } = {}) {
  return bullets(value).map((raw) => {
    const match = /^\[([^\]]+)\]\s+(.+?)(?:\s+[—–-]\s+(.+))?$/.exec(raw);
    const kind = cleanInline(match?.[1], 64).toLowerCase();
    return {
      kind: kinds.includes(kind) ? kind : 'unknown',
      [targetKey]: cleanInline(match?.[2] || raw, 256),
      [descriptionKey]: cleanInline(match?.[3] || '', 1_000),
      raw,
    };
  });
}

function checklist(value) {
  return [...cleanBlock(value).matchAll(/^\s*[-*]\s+\[([ xX~])\]\s+(.+)$/gm)].map((match) => ({
    state: /x/i.test(match[1]) ? 'done' : match[1] === '~' ? 'skipped' : 'open',
    text: match[2].trim(),
  }));
}

function schemaVersion(metadata) {
  const candidate = Number(metadata.schema ?? metadata.schema_version ?? 1);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : 1;
}

function componentState(value) {
  const normalized = String(value || '').toLowerCase();
  if (['active', 'activo'].includes(normalized)) return 'active';
  if (['retired', 'retirado'].includes(normalized)) return 'retired';
  return 'closing';
}

export function parseComponentContract(markdown, { fallbackSlug = 'component' } = {}) {
  const document = parseWorkMarkdown(markdown);
  const meta = document.metadata;
  const text = (field) => sectionValue(document, COMPONENT_SECTION_DEFINITIONS[field]);
  const purpose = text('purpose');
  return {
    schemaVersion: schemaVersion(meta),
    slug: cleanInline(meta.slug || fallbackSlug, 64),
    title: cleanInline(meta.title || meta.titulo || meta.slug || fallbackSlug, 160),
    state: componentState(meta.state || meta.estado),
    order: Number(meta.order ?? meta.orden) || 99,
    since: cleanInline(meta.since || meta.desde || '', 64),
    sections: rawSections(document),
    contract: {
      purpose,
      outcomes: bullets(text('outcomes')),
      responsibilities: bullets(text('responsibilities')),
      limits: bullets(text('limits')),
      invariants: bullets(text('invariants')),
      interfaces: structuredBullets(text('interfaces'), INTERFACE_KINDS, { descriptionKey: 'description' }),
      dependencies: structuredBullets(text('dependencies'), COMPONENT_DEPENDENCY_KINDS),
      dataSystems: bullets(text('dataSystems')),
      territory: bullets(text('territory')),
      verification: bullets(text('verification')),
      evidence: structuredBullets(text('evidence'), EVIDENCE_PROVENANCE, { targetKey: 'reference' }),
      uncertainties: bullets(text('uncertainties')),
      guidance: text('guidance'),
    },
  };
}

export function parseFrontContract(markdown, { fallbackSlug = 'front', adapter = 'handraise', priority = null } = {}) {
  const document = parseWorkMarkdown(markdown);
  const meta = document.metadata;
  const text = (field) => sectionValue(document, FRONT_SECTION_DEFINITIONS[field]);
  const version = schemaVersion(meta);
  const tasks = checklist(text('checklist') || (version < 2 ? markdown : ''));
  const done = tasks.filter((task) => task.state !== 'open').length;
  const titleLine = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackSlug;
  const title = cleanInline(meta.title || (titleLine.includes('—') ? titleLine.slice(titleLine.indexOf('—') + 1) : titleLine), 160);
  const lead = cleanInline(meta.component || markdown.match(/^\*\*Componente:\*\*\s*([^\s·]+)/m)?.[1] || '', 64) || null;
  const explicit = String(meta.state || '').toLowerCase();
  const closed = ['done', 'closed', 'cerrado'].includes(explicit)
    || /CERRAD[OA]|sin plan activo/i.test(titleLine)
    || (tasks.length > 0 && done === tasks.length);
  const state = closed ? 'done' : FRONT_STATES.includes(explicit) ? explicit : 'queued';
  const affected = strings(meta.affected ?? meta.affected_components).filter((item) => item !== lead);
  const goals = strings(meta.goals ?? meta.goal_ids);
  return {
    schemaVersion: version,
    slug: cleanInline(meta.slug || fallbackSlug, 64),
    component: lead,
    leadComponent: lead,
    affectedComponents: affected,
    goalIds: goals,
    analysisSnapshot: cleanInline(meta.analysis_snapshot || '', 128) || null,
    title,
    state,
    done,
    total: tasks.length,
    percent: tasks.length ? Math.round(done / tasks.length * 100) : 0,
    next: tasks.find((task) => task.state === 'open')?.text || null,
    impact: priority?.impact || cleanInline(meta.impact || '', 32) || null,
    complexity: priority?.complexity || cleanInline(meta.complexity || '', 32) || null,
    outcome: text('outcome') || title,
    motivation: text('motivation'),
    scope: text('scope'),
    nonGoals: bullets(text('nonGoals')),
    readiness: bullets(text('readiness')),
    acceptanceCriteria: bullets(text('acceptanceCriteria')),
    verification: bullets(text('verification')),
    deliverables: bullets(text('deliverables')),
    risks: bullets(text('risks')),
    dependencies: structuredBullets(text('dependencies'), FRONT_DEPENDENCY_KINDS),
    evidence: structuredBullets(text('evidence'), EVIDENCE_PROVENANCE, { targetKey: 'reference' }),
    context: text('context'),
    handoff: text('handoff'),
    tasks,
    sections: rawSections(document),
    kind: adapter === 'director' && (fallbackSlug === lead || /Esto NO es un frente/i.test(markdown.slice(0, 600)))
      ? 'backlog' : 'front',
  };
}

function renderList(value) {
  if (typeof value === 'string') return cleanBlock(value) || NONE;
  if (!Array.isArray(value) || !value.length) return NONE;
  return value.map((item) => `- ${cleanBlock(typeof item === 'string' ? item : item?.text || item?.raw)}`).join('\n');
}

function renderStructured(value, { targetKey = 'target', descriptionKey = 'reason' } = {}) {
  if (!Array.isArray(value) || !value.length) return NONE;
  return value.map((item) => {
    if (typeof item === 'string') return `- ${cleanBlock(item)}`;
    const kind = cleanInline(item?.kind || 'unknown', 64);
    const target = cleanInline(item?.[targetKey] || '', 256);
    const description = cleanInline(item?.[descriptionKey] || '', 1_000);
    return `- [${kind}] ${target}${description ? ` — ${description}` : ''}`;
  }).join('\n');
}

function renderChecklist(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return NONE;
  return tasks.map((task, index) => {
    const record = typeof task === 'string' ? { state: 'open', text: task } : task;
    const marker = record?.state === 'done' ? 'x' : record?.state === 'skipped' ? '~' : ' ';
    return `- [${marker}] ${index + 1}. ${cleanInline(record?.text, 1_000).replace(/^\d+(?:\.\d+)*[.)]?\s+/, '')}`;
  }).join('\n');
}

function renderDocument(metadata, heading, owner, sections) {
  return [
    '---',
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${serializeScalar(value)}`),
    '---',
    '',
    ...(heading ? [`# ${heading}`, ''] : []),
    ...(owner ? [`**Componente:** ${owner}`, ''] : []),
    ...sections.flatMap(([sectionHeading, value]) => [`## ${sectionHeading}`, '', cleanBlock(value) || NONE, '']),
  ].join('\n').replace(/\n+$/, '\n');
}

export function createComponentMarkdown(component, { since = new Date().toISOString().slice(0, 10) } = {}) {
  const slug = cleanInline(component?.slug, 64);
  const title = cleanInline(component?.title, 160);
  if (!SLUG.test(slug)) throw new WorkContractError('INVALID_COMPONENT', `component slug '${slug}' must be lowercase kebab-case`);
  if (!title) throw new WorkContractError('INVALID_COMPONENT', `component '${slug}' needs a title`);
  const contract = component?.contract || component || {};
  const purpose = cleanBlock(contract.purpose ?? component?.purpose ?? component?.scope);
  if (!purpose) throw new WorkContractError('INVALID_COMPONENT', `component '${slug}' needs a purpose`);
  const state = component?.state || 'active';
  if (!COMPONENT_STATES.includes(state)) throw new WorkContractError('INVALID_COMPONENT', `component '${slug}' has invalid state '${state}'`);
  const order = Number.isInteger(Number(component?.order)) ? Number(component.order) : 99;
  return renderDocument({ schema: 2, slug, title, state, order, since }, null, null, [
    ['Purpose', purpose],
    ['Outcomes', renderList(contract.outcomes)],
    ['Responsibilities', renderList(contract.responsibilities)],
    ['Limits', renderList(contract.limits ?? component?.limits)],
    ['Invariants', renderList(contract.invariants)],
    ['Interfaces', renderStructured(contract.interfaces, { descriptionKey: 'description' })],
    ['Dependencies', renderStructured(contract.dependencies)],
    ['Data and external systems', renderList(contract.dataSystems ?? contract.data)],
    ['Territory', renderList(contract.territory ?? component?.territory)],
    ['Verification', renderList(contract.verification)],
    ['Evidence', renderStructured(contract.evidence, { targetKey: 'reference' })],
    ['Uncertainty and open questions', renderList(contract.uncertainties ?? contract.uncertainty)],
    ['Agent guidance', cleanBlock(contract.guidance ?? component?.delegation) || NONE],
  ]);
}

export function createFrontMarkdown(front) {
  const slug = cleanInline(front?.slug, 64);
  const title = cleanInline(front?.title, 160);
  const component = cleanInline(front?.component ?? front?.leadComponent, 64);
  if (!SLUG.test(slug)) throw new WorkContractError('INVALID_FRONT', `front slug '${slug}' must be lowercase kebab-case`);
  if (!title || !SLUG.test(component)) throw new WorkContractError('INVALID_FRONT', `front '${slug}' needs a title and one valid lead component`);
  const state = front?.state || 'queued';
  if (!FRONT_STATES.includes(state)) throw new WorkContractError('INVALID_FRONT', `front '${slug}' has invalid state '${state}'`);
  const affected = strings(front?.affectedComponents).filter((item) => item !== component);
  const goals = strings(front?.goalIds);
  const metadata = {
    schema: 2, slug, title, component, state,
    impact: front?.impact || 'medio', complexity: front?.complexity || 'media',
    affected, goals,
  };
  if (front?.analysisSnapshot) metadata.analysis_snapshot = front.analysisSnapshot;
  return renderDocument(metadata, `${slug} — ${title}`, component, [
    ['Observable outcome', cleanBlock(front?.outcome) || title],
    ['Motivation', cleanBlock(front?.motivation) || NONE],
    ['Scope', cleanBlock(front?.scope) || NONE],
    ['Non-goals', renderList(front?.nonGoals)],
    ['Readiness', renderList(front?.readiness)],
    ['Acceptance criteria', renderList(front?.acceptanceCriteria)],
    ['Verification', renderList(front?.verification)],
    ['Deliverables', renderList(front?.deliverables)],
    ['Risks and unknowns', renderList(front?.risks)],
    ['Dependencies', renderStructured(front?.dependencies)],
    ['Evidence', renderStructured(front?.evidence, { targetKey: 'reference' })],
    ['Confirmed context', cleanBlock(front?.context) || NONE],
    ['▶ Handoff', cleanBlock(front?.handoff) || NONE],
    ['Checklist', renderChecklist(front?.tasks)],
  ]);
}

function updateFrontmatter(markdown, updates) {
  const document = parseWorkMarkdown(markdown);
  const newline = document.newline;
  if (!document.frontmatter) {
    const block = ['---', ...Object.entries(updates).map(([key, value]) => `${key}: ${serializeScalar(value)}`), '---', ''].join(newline);
    return `${block}${markdown}`;
  }
  const raw = document.frontmatter.raw;
  const lines = raw.split(/\r?\n/);
  const pending = new Map(Object.entries(updates).map(([key, value]) => [key.toLowerCase(), value]));
  const next = lines.map((line) => {
    const pair = /^(\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*:\s*)(.*)$/.exec(line);
    if (!pair) return line;
    const key = pair[2].toLowerCase();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${pair[1]}${pair[2]}${pair[3]}${serializeScalar(value)}`;
  });
  const close = next.length - 1;
  next.splice(close, 0, ...[...pending].map(([key, value]) => `${key}: ${serializeScalar(value)}`));
  return `${markdown.slice(0, document.frontmatter.start)}${next.join(newline)}${markdown.slice(document.frontmatter.end)}`;
}

function comments(body) {
  return [...String(body || '').matchAll(/<!--[\s\S]*?-->/g)].map((match) => match[0]);
}

function updateSection(markdown, definition, value, { append = true } = {}) {
  const document = parseWorkMarkdown(markdown);
  const aliases = new Set(definition.aliases.map(normalizeHeading));
  const section = document.sections.find((item) => aliases.has(item.normalizedHeading));
  const newline = document.newline;
  const clean = cleanBlock(value);
  if (!section) {
    if (!append) return markdown;
    const separator = markdown.endsWith(newline) ? newline : `${newline}${newline}`;
    return `${markdown}${separator}## ${definition.heading}${newline}${newline}${clean || NONE}${newline}`;
  }
  const retainedComments = comments(section.body).filter((comment) => !clean.includes(comment));
  const body = [clean || NONE, ...retainedComments].filter(Boolean).join(`${newline}${newline}`);
  const afterHeading = markdown.slice(section.headingEnd, section.bodyStart);
  const leading = afterHeading || newline;
  const replacement = `${leading}${newline}${body}${newline}${newline}`;
  return `${markdown.slice(0, section.headingEnd)}${replacement}${markdown.slice(section.end)}`;
}

function updateH1(markdown, slug, title) {
  const replacement = `# ${slug} — ${title}`;
  if (/^#\s+.+$/m.test(markdown)) return markdown.replace(/^#\s+.+$/m, replacement);
  const document = parseWorkMarkdown(markdown);
  const insertion = document.frontmatter?.end ?? 0;
  const newline = document.newline;
  return `${markdown.slice(0, insertion)}${newline}${newline}${replacement}${newline}${markdown.slice(insertion)}`;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function updateComponentMarkdown(markdown, updates = {}) {
  const current = parseComponentContract(markdown);
  const meta = {};
  if (hasOwn(updates, 'title')) meta.title = cleanInline(updates.title, 160);
  if (hasOwn(updates, 'state')) meta.state = updates.state;
  if (hasOwn(updates, 'order')) meta.order = Number(updates.order);
  let result = Object.keys(meta).length ? updateFrontmatter(markdown, meta) : markdown;
  const aliases = {
    scope: 'purpose', purpose: 'purpose', limits: 'limits', delegation: 'guidance', guidance: 'guidance',
    outcomes: 'outcomes', responsibilities: 'responsibilities', invariants: 'invariants', interfaces: 'interfaces',
    dependencies: 'dependencies', data: 'dataSystems', dataSystems: 'dataSystems', territory: 'territory',
    verification: 'verification', evidence: 'evidence', uncertainty: 'uncertainties', uncertainties: 'uncertainties',
  };
  for (const [input, field] of Object.entries(aliases)) {
    if (!hasOwn(updates, input)) continue;
    const structured = field === 'interfaces'
      ? renderStructured(updates[input], { descriptionKey: 'description' })
      : field === 'dependencies' ? renderStructured(updates[input])
        : field === 'evidence' ? renderStructured(updates[input], { targetKey: 'reference' })
          : ['outcomes', 'responsibilities', 'limits', 'invariants', 'dataSystems', 'territory', 'verification', 'uncertainties'].includes(field)
            ? renderList(updates[input]) : cleanBlock(updates[input]);
    result = updateSection(result, COMPONENT_SECTION_DEFINITIONS[field], structured);
  }
  if (current.schemaVersion >= 2 && !/^schema\s*:/mi.test(result)) result = updateFrontmatter(result, { schema: 2 });
  return result.endsWith('\n') ? result : `${result}\n`;
}

export function updateFrontMarkdown(markdown, updates = {}) {
  const current = parseFrontContract(markdown);
  const meta = {};
  const mapping = {
    title: 'title', state: 'state', impact: 'impact', complexity: 'complexity',
    component: 'component', leadComponent: 'component', affectedComponents: 'affected', goalIds: 'goals',
    analysisSnapshot: 'analysis_snapshot',
  };
  for (const [input, output] of Object.entries(mapping)) if (hasOwn(updates, input)) meta[output] = updates[input];
  let result = Object.keys(meta).length ? updateFrontmatter(markdown, meta) : markdown;
  const slug = current.slug;
  const title = cleanInline(updates.title ?? current.title, 160);
  if (hasOwn(updates, 'title')) result = updateH1(result, slug, title);
  const fields = {
    outcome: (value) => cleanBlock(value), motivation: (value) => cleanBlock(value), scope: (value) => cleanBlock(value),
    nonGoals: renderList, readiness: renderList, acceptanceCriteria: renderList, verification: renderList,
    deliverables: renderList, risks: renderList,
    dependencies: (value) => renderStructured(value),
    evidence: (value) => renderStructured(value, { targetKey: 'reference' }),
    context: (value) => cleanBlock(value), handoff: (value) => cleanBlock(value), checklist: renderChecklist, tasks: renderChecklist,
  };
  for (const [input, renderer] of Object.entries(fields)) {
    if (!hasOwn(updates, input)) continue;
    const field = input === 'tasks' ? 'checklist' : input;
    result = updateSection(result, FRONT_SECTION_DEFINITIONS[field], renderer(updates[input]));
  }
  return result.endsWith('\n') ? result : `${result}\n`;
}

function ensureSections(markdown, definitions) {
  let result = markdown;
  for (const definition of Object.values(definitions)) {
    const document = parseWorkMarkdown(result);
    const aliases = new Set(definition.aliases.map(normalizeHeading));
    if (!document.sections.some((section) => aliases.has(section.normalizedHeading))) {
      result = updateSection(result, definition, NONE);
    }
  }
  return result;
}

export function migrateComponentMarkdown(markdown) {
  const current = parseComponentContract(markdown);
  if (current.schemaVersion >= 2) return markdown;
  let result = updateFrontmatter(markdown, { schema: 2 });
  result = ensureSections(result, COMPONENT_SECTION_DEFINITIONS);
  return result.endsWith('\n') ? result : `${result}\n`;
}

export function migrateFrontMarkdown(markdown) {
  const current = parseFrontContract(markdown);
  if (current.schemaVersion >= 2) return markdown;
  let result = updateFrontmatter(markdown, { schema: 2, title: current.title, affected: [], goals: [] });
  result = ensureSections(result, FRONT_SECTION_DEFINITIONS);
  return result.endsWith('\n') ? result : `${result}\n`;
}

function diagnostic(code, severity, path, message, details = null) {
  return { code, severity, path, message, details };
}

export function validatePortfolioContracts(components, fronts, { goalIds } = {}) {
  const diagnostics = [];
  const knownComponents = new Set();
  const knownFronts = new Set();
  const knownGoals = goalIds ? new Set(goalIds) : null;

  for (const [index, component] of components.entries()) {
    const path = `components[${index}]`;
    if (!SLUG.test(component.slug)) diagnostics.push(diagnostic('INVALID_COMPONENT_SLUG', 'error', `${path}.slug`, `Component slug '${component.slug}' must be lowercase kebab-case.`));
    if (knownComponents.has(component.slug)) diagnostics.push(diagnostic('DUPLICATE_COMPONENT_SLUG', 'error', `${path}.slug`, `Component slug '${component.slug}' is duplicated.`));
    knownComponents.add(component.slug);
    if (!COMPONENT_STATES.includes(component.state)) diagnostics.push(diagnostic('INVALID_COMPONENT_STATE', 'error', `${path}.state`, `Component '${component.slug}' has invalid state '${component.state}'.`));
    if (component.schemaVersion > WORK_CONTRACT_SCHEMA_VERSION) diagnostics.push(diagnostic('UNSUPPORTED_COMPONENT_SCHEMA', 'error', `${path}.schemaVersion`, `Component '${component.slug}' uses unsupported schema ${component.schemaVersion}.`));
    if (component.schemaVersion >= 2) {
      for (const field of ['purpose', 'outcomes', 'responsibilities', 'limits', 'invariants', 'territory', 'verification', 'evidence', 'guidance']) {
        const value = component.contract?.[field];
        if (!value || (Array.isArray(value) && value.length === 0)) diagnostics.push(diagnostic('INCOMPLETE_COMPONENT_CONTRACT', 'warning', `${path}.contract.${field}`, `Component '${component.slug}' has no declared ${field}.`));
      }
    }
  }

  for (const [index, front] of fronts.entries()) {
    const path = `fronts[${index}]`;
    if (!SLUG.test(front.slug)) diagnostics.push(diagnostic('INVALID_FRONT_SLUG', 'error', `${path}.slug`, `Front slug '${front.slug}' must be lowercase kebab-case.`));
    if (knownFronts.has(front.slug)) diagnostics.push(diagnostic('DUPLICATE_FRONT_SLUG', 'error', `${path}.slug`, `Front slug '${front.slug}' is duplicated.`));
    knownFronts.add(front.slug);
    if (!front.component) diagnostics.push(diagnostic('MISSING_LEAD_COMPONENT', 'error', `${path}.component`, `Front '${front.slug}' needs exactly one lead component.`));
    else if (!knownComponents.has(front.component)) diagnostics.push(diagnostic('UNKNOWN_LEAD_COMPONENT', 'error', `${path}.component`, `Front '${front.slug}' references unknown lead component '${front.component}'.`));
    if (!FRONT_STATES.includes(front.state)) diagnostics.push(diagnostic('INVALID_FRONT_STATE', 'error', `${path}.state`, `Front '${front.slug}' has invalid state '${front.state}'.`));
    const affected = new Set();
    for (const component of front.affectedComponents || []) {
      if (component === front.component) diagnostics.push(diagnostic('DUPLICATE_LEAD_COMPONENT', 'error', `${path}.affectedComponents`, `Front '${front.slug}' repeats its lead component '${component}' as affected.`));
      else if (affected.has(component)) diagnostics.push(diagnostic('DUPLICATE_AFFECTED_COMPONENT', 'error', `${path}.affectedComponents`, `Front '${front.slug}' repeats affected component '${component}'.`));
      else if (!knownComponents.has(component)) diagnostics.push(diagnostic('UNKNOWN_AFFECTED_COMPONENT', 'error', `${path}.affectedComponents`, `Front '${front.slug}' references unknown affected component '${component}'.`));
      affected.add(component);
    }
    if (knownGoals) for (const goal of front.goalIds || []) {
      if (!knownGoals.has(goal)) diagnostics.push(diagnostic('UNKNOWN_GOAL', 'error', `${path}.goalIds`, `Front '${front.slug}' references unknown goal '${goal}'.`));
    }
    if (front.analysisSnapshot && !SHA256.test(front.analysisSnapshot)) diagnostics.push(diagnostic('INVALID_ANALYSIS_SNAPSHOT', 'error', `${path}.analysisSnapshot`, `Front '${front.slug}' has an invalid analysis snapshot digest.`));
    if (front.schemaVersion > WORK_CONTRACT_SCHEMA_VERSION) diagnostics.push(diagnostic('UNSUPPORTED_FRONT_SCHEMA', 'error', `${path}.schemaVersion`, `Front '${front.slug}' uses unsupported schema ${front.schemaVersion}.`));
    if (front.schemaVersion >= 2) {
      for (const field of ['outcome', 'motivation', 'scope', 'readiness', 'acceptanceCriteria', 'verification', 'deliverables', 'risks', 'evidence', 'tasks']) {
        const value = front[field];
        if (!value || (Array.isArray(value) && value.length === 0)) diagnostics.push(diagnostic('INCOMPLETE_FRONT_CONTRACT', 'warning', `${path}.${field}`, `Front '${front.slug}' has no declared ${field}.`));
      }
    }
  }

  for (const [index, component] of components.entries()) {
    for (const [dependencyIndex, dependency] of (component.contract?.dependencies || []).entries()) {
      if (dependency.kind === 'unknown') diagnostics.push(diagnostic('INVALID_COMPONENT_DEPENDENCY_KIND', 'error', `components[${index}].contract.dependencies[${dependencyIndex}]`, `Component '${component.slug}' has an unknown dependency kind.`));
      else if (dependency.kind !== 'external' && !knownComponents.has(dependency.target)) diagnostics.push(diagnostic('UNKNOWN_COMPONENT_DEPENDENCY', 'error', `components[${index}].contract.dependencies[${dependencyIndex}]`, `Component '${component.slug}' depends on unknown component '${dependency.target}'.`));
    }
  }

  const hardEdges = new Map(fronts.map((front) => [front.slug, []]));
  for (const [index, front] of fronts.entries()) {
    for (const [dependencyIndex, dependency] of (front.dependencies || []).entries()) {
      const path = `fronts[${index}].dependencies[${dependencyIndex}]`;
      if (dependency.kind === 'unknown') diagnostics.push(diagnostic('INVALID_FRONT_DEPENDENCY_KIND', 'error', path, `Front '${front.slug}' has an unknown dependency kind.`));
      else if (!knownFronts.has(dependency.target)) diagnostics.push(diagnostic('UNKNOWN_FRONT_DEPENDENCY', 'error', path, `Front '${front.slug}' depends on unknown front '${dependency.target}'.`));
      else if (dependency.target === front.slug) diagnostics.push(diagnostic('SELF_FRONT_DEPENDENCY', 'error', path, `Front '${front.slug}' cannot depend on itself.`));
      else if (dependency.kind === 'hard') hardEdges.get(front.slug)?.push(dependency.target);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const reportedCycles = new Set();
  const visit = (slug) => {
    if (visiting.has(slug)) {
      const start = stack.indexOf(slug);
      const cycle = [...stack.slice(start), slug];
      const key = [...new Set(cycle)].sort().join('|');
      if (!reportedCycles.has(key)) {
        diagnostics.push(diagnostic('HARD_DEPENDENCY_CYCLE', 'error', 'fronts', `Hard front dependency cycle: ${cycle.join(' → ')}.`));
        reportedCycles.add(key);
      }
      return;
    }
    if (visited.has(slug)) return;
    visiting.add(slug);
    stack.push(slug);
    for (const target of hardEdges.get(slug) || []) visit(target);
    stack.pop();
    visiting.delete(slug);
    visited.add(slug);
  };
  for (const slug of knownFronts) visit(slug);

  return {
    valid: !diagnostics.some((item) => item.severity === 'error'),
    diagnostics,
    summary: {
      components: components.length,
      fronts: fronts.length,
      errors: diagnostics.filter((item) => item.severity === 'error').length,
      warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    },
  };
}

export function assertPortfolioContracts(components, fronts, options) {
  const result = validatePortfolioContracts(components, fronts, options);
  if (!result.valid) {
    throw new WorkContractError('INVALID_PORTFOLIO', `${result.summary.errors} work-contract validation error(s) must be resolved`, {
      diagnostics: result.diagnostics,
    });
  }
  return result;
}

export function workContractRevision(markdown) {
  return hash(String(markdown));
}

export const WORK_CONTRACT_SECTIONS = Object.freeze({
  component: COMPONENT_SECTION_DEFINITIONS,
  front: FRONT_SECTION_DEFINITIONS,
});
