import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { procAlive } from './state.mjs';

const read = (path, fallback = '') => {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
};

function frontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  if (!match) return {};
  return Object.fromEntries(match[1].split('\n').flatMap((line) => {
    const pair = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line.trim());
    return pair ? [[pair[1].toLowerCase(), pair[2].trim()]] : [];
  }));
}

function sections(markdown) {
  const result = {};
  for (const chunk of markdown.split(/^## /m).slice(1)) {
    const breakAt = chunk.indexOf('\n');
    const title = chunk.slice(0, breakAt < 0 ? undefined : breakAt).trim();
    result[title] = breakAt < 0 ? '' : chunk.slice(breakAt + 1).trim();
  }
  return result;
}

function listMarkdown(directory) {
  try { return readdirSync(directory).filter((name) => name.endsWith('.md')).sort(); }
  catch { return []; }
}

function parseComponent(path, fallbackSlug) {
  const markdown = read(path);
  const meta = frontmatter(markdown);
  return {
    slug: meta.slug || fallbackSlug,
    title: meta.titulo || meta.title || meta.slug || fallbackSlug,
    state: ['activo', 'active'].includes(meta.estado || meta.state) ? 'active' : 'closing',
    order: Number(meta.orden || meta.order) || 99,
    since: meta.desde || meta.since || '',
    sections: sections(markdown),
  };
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

const COMPONENT_SECTIONS = {
  scope: { aliases: ['scope', 'alcance'], heading: 'Scope' },
  limits: { aliases: ['limits', 'límites', 'limites', 'boundaries'], heading: 'Limits' },
  delegation: { aliases: ['delegación', 'delegacion', 'delegation', 'agent guidance', 'guidance'], heading: 'Agent guidance' },
  territory: { aliases: ['territorio', 'territory'], heading: 'Territory' },
};

function replaceComponentSection(markdown, field, value, adapter) {
  const definition = COMPONENT_SECTIONS[field];
  const aliases = new Set(definition.aliases);
  const chunks = markdown.split(/^## /m);
  let found = false;
  const updated = chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const lineEnd = chunk.indexOf('\n');
    const title = (lineEnd < 0 ? chunk : chunk.slice(0, lineEnd)).trim().toLowerCase();
    if (!aliases.has(title)) return chunk;
    found = true;
    return `${chunk.slice(0, lineEnd < 0 ? chunk.length : lineEnd)}\n\n${value}\n`;
  });
  if (!found && value) {
    const heading = adapter === 'director' && field === 'scope' ? 'Alcance'
      : adapter === 'director' && field === 'limits' ? 'Límites'
        : adapter === 'director' && field === 'delegation' ? 'Delegación'
          : adapter === 'director' && field === 'territory' ? 'Territorio' : definition.heading;
    updated.push(`${heading}\n\n${value}\n`);
  }
  return updated.join('## ');
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

export function createFront(repository, componentSlug, { title, next, impact = 'medio', complexity = 'media' } = {}) {
  const cleanTitle = cleanMultiline(title, 160).replace(/\n+/g, ' ');
  const cleanNext = cleanMultiline(next, 500).replace(/\n+/g, ' ');
  if (!cleanTitle) throw new Error('front title is required');
  if (!cleanNext) throw new Error('front next step is required');
  const cleanImpact = ['alto', 'medio', 'bajo'].includes(String(impact)) ? String(impact) : 'medio';
  const cleanComplexity = ['alta', 'media', 'baja'].includes(String(complexity)) ? String(complexity) : 'media';
  const directory = frontDirectory(repository);
  mkdirSync(directory, { recursive: true });
  const existing = new Set(listMarkdown(directory).map((name) => name.replace(/\.md$/, '')));
  const base = componentSlugValue(cleanTitle);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) candidate = `${base}-${suffix++}`;
  const markdown = `---\nslug: ${candidate}\ncomponent: ${componentSlug}\nstate: queued\nimpact: ${cleanImpact}\ncomplexity: ${cleanComplexity}\n---\n\n# ${candidate} — ${cleanTitle}\n\n**Componente:** ${componentSlug}\n\n## ▶ Handoff\n\n- **Próximo paso:** ${cleanNext}\n\n## Checklist\n\n- [ ] ${cleanNext}\n`;
  const path = join(directory, `${candidate}.md`);
  writeFileSync(path, markdown);
  return parseFront(path, candidate, repository.adapter, new Map());
}

function componentSlugValue(value) {
  return componentSlug(value);
}

export function deleteFront(repository, componentSlug, slug) {
  const location = frontFilename(repository, slug);
  if (!location) throw new Error('front not found');
  const front = parseFront(join(location.directory, location.filename), slug, repository.adapter, new Map());
  if (front.component !== componentSlug) throw new Error('front does not belong to this component');
  if (repository.adapter === 'director' && directorLanes(repository).some((lane) => lane.slug === slug && lane.liveness === 'live')) {
    throw new Error('cannot delete an active front');
  }
  unlinkSync(join(location.directory, location.filename));
  return { deleted: slug };
}

export function createComponent(repository, { title, slug, scope, limits, delegation, territory } = {}) {
  const cleanTitle = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cleanTitle) throw new Error('component title is required');
  const cleanScope = cleanMultiline(scope);
  if (!cleanScope) throw new Error('component scope is required');
  const componentDirectory = join(repository.path, repository.adapter === 'director' ? '.claude/components' : '.handraise/components');
  mkdirSync(componentDirectory, { recursive: true });
  const existing = new Set(listMarkdown(componentDirectory).map((name) => parseComponent(join(componentDirectory, name), name.replace(/\.md$/, '')).slug));
  const base = componentSlug(slug || cleanTitle);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) candidate = `${base}-${suffix++}`;
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = repository.adapter === 'director'
    ? `slug: ${candidate}\ntitulo: ${cleanTitle}\nestado: activo\norden: 99\ndesde: ${today}`
    : `slug: ${candidate}\ntitle: ${cleanTitle}\nstate: active\norder: 99\nsince: ${today}`;
  const path = join(componentDirectory, `${candidate}.md`);
  let markdown = `---\n${frontmatter}\n---\n`;
  markdown = replaceComponentSection(markdown, 'scope', cleanScope, repository.adapter);
  for (const [field, value] of Object.entries({ limits, delegation, territory })) {
    const cleanValue = cleanMultiline(value);
    if (cleanValue) markdown = replaceComponentSection(markdown, field, cleanValue, repository.adapter);
  }
  writeFileSync(path, `${markdown.trimEnd()}\n`);
  return parseComponent(path, candidate);
}

export function updateComponent(repository, slug, details = {}) {
  const { title, scope, limits, delegation, territory } = details;
  const cleanTitle = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  if (!cleanTitle) throw new Error('component title is required');
  const location = componentFilename(repository, slug);
  if (!location) throw new Error('component not found');
  const { componentDirectory, filename } = location;
  const path = join(componentDirectory, filename);
  let markdown = read(path);
  if (/^titulo:\s*.*$/mi.test(markdown)) markdown = markdown.replace(/^titulo:\s*.*$/mi, `titulo: ${cleanTitle}`);
  else if (/^title:\s*.*$/mi.test(markdown)) markdown = markdown.replace(/^title:\s*.*$/mi, `title: ${cleanTitle}`);
  else if (/^---\n/.test(markdown)) markdown = markdown.replace(/^---\n/, `---\ntitulo: ${cleanTitle}\n`);
  else markdown = `---\ntitulo: ${cleanTitle}\n---\n\n${markdown}`;
  const sectionDetails = { scope, limits, delegation, territory };
  for (const [field, value] of Object.entries(sectionDetails)) {
    if (!Object.prototype.hasOwnProperty.call(details, field)) continue;
    const cleanValue = cleanMultiline(value);
    markdown = replaceComponentSection(markdown, field, cleanValue, repository.adapter);
  }
  writeFileSync(path, `${markdown.trimEnd()}\n`);
  return parseComponent(path, filename.replace(/\.md$/, ''));
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
  const meta = frontmatter(markdown);
  const tasks = [...markdown.matchAll(/^- \[([ x~])\]\s+(.+)$/gm)].map((match) => ({
    state: match[1] === 'x' ? 'done' : match[1] === '~' ? 'skipped' : 'open',
    text: match[2].trim(),
  }));
  const done = tasks.filter((task) => task.state !== 'open').length;
  const titleLine = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackSlug;
  const title = meta.title || (titleLine.includes('—') ? titleLine.slice(titleLine.indexOf('—') + 1).trim() : titleLine);
  const component = meta.component || markdown.match(/^\*\*Componente:\*\*\s*([^\s·]+)/m)?.[1] || null;
  const explicit = String(meta.state || '').toLowerCase();
  const closed = ['done', 'closed', 'cerrado'].includes(explicit)
    || /CERRAD[OA]|sin plan activo/i.test(titleLine)
    || (tasks.length > 0 && done === tasks.length);
  const priority = priorities.get(fallbackSlug) || {
    impact: meta.impact || null,
    complexity: meta.complexity || null,
  };
  return {
    slug: meta.slug || fallbackSlug,
    component,
    title,
    state: closed ? 'done' : explicit === 'blocked' ? 'blocked' : 'queued',
    done,
    total: tasks.length,
    percent: tasks.length ? Math.round(done / tasks.length * 100) : 0,
    next: tasks.find((task) => task.state === 'open')?.text || null,
    impact: priority.impact,
    complexity: priority.complexity,
    kind: adapter === 'director' && (fallbackSlug === component || /Esto NO es un frente/i.test(markdown.slice(0, 600)))
      ? 'backlog' : 'front',
  };
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

export function repositoryPortfolio(repository, handraiseSessions = []) {
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
    try { return repositoryPortfolio(repository, handraiseSessions); }
    catch (error) {
      return { ...repository, components: [], fronts: [], lanes: [], error: String(error.message || error) };
    }
  });
}
