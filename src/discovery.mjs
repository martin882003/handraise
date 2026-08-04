import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { initializeNativeRepository } from './repositories.mjs';

const MAX_FILES = 12_000;
const MAX_TEXT_FILES = 240;
const MAX_TEXT_BYTES = 96 * 1024;
const DRAFT_TTL_MS = 30 * 60 * 1_000;
const IGNORED_SEGMENTS = new Set([
  '.git', '.handraise', '.next', '.nuxt', '.output', '.turbo', '.venv', 'build', 'coverage',
  'dist', 'node_modules', 'target', 'vendor', '__pycache__',
]);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.go', '.h', '.html', '.java', '.js', '.json',
  '.jsx', '.kt', '.md', '.mjs', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.toml',
  '.ts', '.tsx', '.vue', '.yaml', '.yml',
]);
const MANIFEST_NAMES = new Set([
  'cargo.toml', 'composer.json', 'dockerfile', 'gemfile', 'go.mod', 'package.json', 'pom.xml',
  'pyproject.toml', 'requirements.txt', 'setup.cfg', 'workspace.json',
]);

const SIGNALS = [
  {
    slug: 'runtime-control', title: 'Runtime & Execution Control',
    paths: [/\b(runtime|session|process|worker|job|queue|terminal|tmux|worktree|executor|runner)\b/i],
    contents: [/\b(tmux|worktree|session lifecycle|child_process|spawn\(|process control)\b/i],
    scope: 'Own reliable execution and control of long-running work: process lifecycle, session state, isolation, recovery and the safety signals needed to operate it.',
    limits: 'Does not own product planning, provider-specific integration policy, authentication, or client presentation. It must not infer durable state from presentation text alone.',
    delegation: 'Preserve process identity and isolation across operations. Prefer explicit lifecycle evidence, validate every control target and coordinate shared session contracts with integrations and client owners.',
    reason: 'Names execution, session or isolation behavior.',
  },
  {
    slug: 'repository-planning', title: 'Repository Planning',
    paths: [/\b(repositor(?:y|ies)|portfolio|project|planning|plan|front|component|workspace|metadata)\b/i],
    contents: [/\b(component contract|work front|repository adapter|project metadata|portfolio)\b/i],
    scope: 'Turn repository knowledge into durable responsibility contracts and executable work plans, including metadata formats, lifecycle rules and safe adapter-specific mutations.',
    limits: 'Does not own agent processes, generic Git worktree mechanics, authentication, or browser interaction design. Compatibility adapters may not bypass repository-native validation.',
    delegation: 'Model components as long-lived responsibilities rather than folder mirrors. Keep repository metadata human-readable, preserve unknown content and make every mutation validated, atomic and serialized.',
    reason: 'Names repository structure, planning or responsibility metadata.',
  },
  {
    slug: 'agent-integrations', title: 'Agent Integrations',
    paths: [/\b(agent|agents|hook|hooks|codex|claude|anthropic|openai|llm|model-provider)\b/i],
    contents: [/\b(Claude Code|Codex|agent CLI|permission hook|model provider|OpenAI|Anthropic)\b/i],
    scope: 'Provide explicit, maintainable integrations with supported coding agents: invocation, capabilities, lifecycle events, permissions, diagnostics and recovery.',
    limits: 'Does not own generic process control, repository planning or client navigation. A capability must not be advertised until its end-to-end behavior is available and detectable.',
    delegation: 'Treat every agent CLI as a declared adapter with honest degradation states. Keep arguments inert, integrations reversible and capability reporting aligned with actual installed behavior.',
    reason: 'Names an agent, model-provider or hook integration.',
  },
  {
    slug: 'client-experience', title: 'Client Experience',
    paths: [/(^|\/)(ui|client|frontend|web|app)(\/|$)/i, /\.(css|scss|tsx|jsx|vue|svelte)$/i, /\b(pwa|manifest|service-worker)\b/i],
    contents: [/\b(react|preact|vue|svelte|service worker|web manifest|accessibility)\b/i],
    scope: 'Own the user-facing experience across browser and installable client surfaces: information architecture, interaction design, accessibility, responsive behavior and honest loading, offline and error states.',
    limits: 'Does not implement server-side lifecycle, repository mutation, agent adapters or authentication policy. It must not present unconfirmed operations as successful.',
    delegation: 'Start from the user decision and recovery path. Preserve context, expose capability limits, use progressive disclosure and coordinate API contract changes before depending on them.',
    reason: 'Contains a client surface, interaction code or browser asset.',
  },
  {
    slug: 'platform-trust', title: 'Platform & Trust',
    paths: [/\b(auth|authentication|authorization|permission|security|pair|token|cookie|server|api|cli|service|config)\b/i, /(^|\/)bin(\/|$)/i],
    contents: [/\b(same-origin|csrf|cookie|authentication|authorization|permission|localhost|http server|health check)\b/i],
    scope: 'Provide the secure operational foundation for the product: service lifecycle, API policy, identity and authorization boundaries, persistent configuration, diagnostics and recovery.',
    limits: 'Does not own feature-specific planning, execution or presentation semantics. It must not broaden network exposure, weaken trust boundaries or hide availability failures.',
    delegation: 'Default to least privilege, make destructive effects explicit and keep availability separate from authentication. Preserve compatibility deliberately and provide actionable recovery paths.',
    reason: 'Names a platform, API, configuration or trust boundary.',
  },
  {
    slug: 'data-foundation', title: 'Data Foundation',
    paths: [/\b(database|db|schema|migration|migrations|persistence|storage|warehouse)\b/i],
    contents: [/\b(create table|alter table|database migration|schema version|data store)\b/i],
    scope: 'Own durable data models, persistence boundaries, schema evolution and the integrity and recoverability of stored product state.',
    limits: 'Does not own feature workflows or their presentation. Schema changes must not silently destroy, reinterpret or expose existing data.',
    delegation: 'Make compatibility and migration direction explicit, validate invariants at boundaries and coordinate model changes with every consuming responsibility.',
    reason: 'Contains durable storage, schema or migration behavior.',
  },
];

function ignored(path) {
  return path.split('/').some((segment) => IGNORED_SEGMENTS.has(segment) || segment.startsWith('.handraise.'));
}

function fallbackFiles(root) {
  const found = [];
  const walk = (directory, prefix = '') => {
    if (found.length >= MAX_FILES * 2) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
    catch { return; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored(relative) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
      if (found.length >= MAX_FILES * 2) break;
    }
  };
  walk(root);
  return found;
}

function repositoryFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    }).split('\0').filter(Boolean).filter((path) => !ignored(path)).sort();
  } catch {
    return fallbackFiles(root);
  }
}

function textCandidate(path, size) {
  const name = basename(path).toLowerCase();
  return size <= MAX_TEXT_BYTES && (TEXT_EXTENSIONS.has(extname(name)) || MANIFEST_NAMES.has(name)
    || /^readme(?:\.|$)/i.test(name) || ['agents.md', 'claude.md', 'makefile'].includes(name));
}

function repositorySnapshot(root) {
  const listed = repositoryFiles(root);
  const selected = listed.slice(0, MAX_FILES);
  const hash = createHash('sha256');
  const files = [];
  let textFiles = 0;
  for (const path of selected) {
    try {
      const stats = statSync(join(root, path));
      if (!stats.isFile()) continue;
      hash.update(`${path}\0${stats.size}\0${Math.trunc(stats.mtimeMs)}\0`);
      let text = '';
      if (textFiles < MAX_TEXT_FILES && textCandidate(path, stats.size)) {
        text = readFileSync(join(root, path), 'utf8').slice(0, MAX_TEXT_BYTES);
        hash.update(createHash('sha256').update(text).digest());
        textFiles += 1;
      }
      files.push({ path, size: stats.size, text });
    } catch {
      hash.update(`${path}\0unreadable\0`);
    }
  }
  hash.update(`listed:${listed.length};selected:${selected.length}`);
  return {
    fingerprint: hash.digest('hex'), files,
    truncated: listed.length > selected.length, listed: listed.length, textFiles,
  };
}

function rootsFromEvidence(evidence) {
  const roots = [];
  for (const { path } of evidence) {
    const parts = path.split('/');
    const candidate = parts.length > 1 ? `${parts[0]}/` : path;
    if (!roots.includes(candidate)) roots.push(candidate);
  }
  return roots.slice(0, 5);
}

function signalProposal(signal, files, order) {
  const evidence = [];
  let score = 0;
  for (const file of files) {
    const pathMatch = signal.paths.some((pattern) => pattern.test(file.path));
    const contentMatch = file.text && signal.contents.some((pattern) => pattern.test(file.text));
    if (!pathMatch && !contentMatch) continue;
    score += pathMatch ? 2 : 0;
    score += contentMatch ? 1 : 0;
    if (evidence.length < 4) evidence.push({ path: file.path, reason: signal.reason });
  }
  if (score < 4) return null;
  const roots = rootsFromEvidence(evidence);
  const uncertainty = [];
  if (score < 9 || evidence.length < 3) {
    uncertainty.push('This boundary is inferred from limited structural signals; confirm it reflects durable ownership.');
  }
  return {
    slug: signal.slug,
    title: signal.title,
    scope: signal.scope,
    limits: signal.limits,
    delegation: signal.delegation,
    territory: roots.length
      ? `Primary evidence points to ${roots.map((path) => `\`${path}\``).join(', ')}; refine this territory where responsibilities overlap.`
      : 'Confirm the concrete source, test and documentation paths owned by this responsibility.',
    order,
    evidence,
    uncertainty,
    confidence: score >= 16 ? 'high' : score >= 9 ? 'medium' : 'low',
  };
}

function fallbackProposal(files) {
  const evidence = files.filter((file) => file.text || /(^|\/)src(\/|$)/.test(file.path)).slice(0, 4)
    .map((file) => ({ path: file.path, reason: 'Provides the clearest available product or repository signal.' }));
  return {
    slug: 'product-core', title: 'Product Core', order: 1,
    scope: 'Own the primary product behavior and the stable domain decisions implemented by this repository.',
    limits: 'Does not automatically own deployment, generic tooling or unrelated integrations. Split this responsibility only when the repository provides durable ownership evidence.',
    delegation: 'Begin from observable product behavior, preserve public contracts and record newly discovered ownership boundaries instead of mirroring the directory tree.',
    territory: rootsFromEvidence(evidence).length
      ? `Initial evidence points to ${rootsFromEvidence(evidence).map((path) => `\`${path}\``).join(', ')}; confirm the exact boundary.`
      : 'The repository does not expose enough structure to assign concrete territory yet.',
    evidence,
    uncertainty: ['The repository exposes too few responsibility signals for a confident decomposition; start broad and refine after review.'],
    confidence: 'low',
  };
}

export function analyzeNativeRepository(repository) {
  if (!repository?.path) throw new Error('repository path is required');
  if (existsSync(join(repository.path, '.handraise'))) {
    throw new Error('repository metadata already exists; discovery is only available before native initialization');
  }
  if (existsSync(join(repository.path, '.claude', 'components'))
    && existsSync(join(repository.path, '.claude', 'runtime', 'plans'))) {
    throw new Error('Director repositories already provide their component contracts');
  }
  const snapshot = repositorySnapshot(repository.path);
  let proposals = SIGNALS.map((signal) => signalProposal(signal, snapshot.files, 1)).filter(Boolean)
    .sort((left, right) => {
      const confidence = { high: 3, medium: 2, low: 1 };
      return confidence[right.confidence] - confidence[left.confidence] || left.title.localeCompare(right.title);
    })
    .slice(0, 8)
    .map((proposal, index) => ({ ...proposal, order: index + 1 }));
  if (!proposals.length) proposals = [fallbackProposal(snapshot.files)];
  const lowerPaths = snapshot.files.map((file) => file.path.toLowerCase());
  return {
    fingerprint: snapshot.fingerprint,
    analyzedAt: new Date().toISOString(),
    analysis: {
      files: snapshot.files.length,
      documentation: lowerPaths.filter((path) => path.endsWith('.md') || path.startsWith('docs/')).length,
      manifests: lowerPaths.filter((path) => MANIFEST_NAMES.has(basename(path))).length,
      tests: lowerPaths.filter((path) => /(^|\/)(test|tests|spec|specs)(\/|\.|$)/.test(path)).length,
      configuration: lowerPaths.filter((path) => /(^|\/)(config|configs|\.github)(\/|\.|$)|\.(toml|ya?ml|json)$/.test(path)).length,
      truncated: snapshot.truncated,
    },
    proposals,
  };
}

export function repositoryFingerprint(path) {
  return repositorySnapshot(path).fingerprint;
}

export class DiscoveryDraftStore {
  constructor({ now = () => Date.now(), ttlMs = DRAFT_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.drafts = new Map();
  }

  #draft(repository, previousId = null) {
    for (const [draftId, candidate] of this.drafts) {
      if (candidate.expiresAt <= this.now()) this.drafts.delete(draftId);
    }
    const analysis = analyzeNativeRepository(repository);
    if (previousId) this.drafts.delete(previousId);
    const id = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const draft = { id, repositoryId: repository.id, expiresAt, ...analysis };
    this.drafts.set(id, draft);
    return this.#public(draft);
  }

  #get(repository, id) {
    const draft = this.drafts.get(String(id || ''));
    if (!draft || draft.repositoryId !== repository.id) throw new Error('discovery draft not found; run the analysis again');
    if (draft.expiresAt <= this.now()) {
      this.drafts.delete(draft.id);
      throw new Error('discovery draft expired; run the analysis again');
    }
    return draft;
  }

  #public(draft) {
    const { fingerprint, repositoryId, ...visible } = draft;
    return { ...visible, repositoryId, fingerprint: fingerprint.slice(0, 12) };
  }

  create(repository) {
    return this.#draft(repository);
  }

  regenerate(repository, id) {
    this.#get(repository, id);
    return this.#draft(repository, id);
  }

  accept(repository, id, components) {
    const draft = this.#get(repository, id);
    if (!Array.isArray(components) || components.length === 0) {
      throw new Error('select at least one component or skip discovery to initialize an empty portfolio');
    }
    if (repositoryFingerprint(repository.path) !== draft.fingerprint) {
      throw new Error('repository contents changed after discovery; regenerate the proposal before accepting it');
    }
    const initialized = initializeNativeRepository(repository, { components });
    for (const [draftId, candidate] of this.drafts) {
      if (candidate.repositoryId === repository.id) this.drafts.delete(draftId);
    }
    return { repository: initialized, created: components.length };
  }

  discardRepository(repositoryId) {
    for (const [draftId, candidate] of this.drafts) {
      if (candidate.repositoryId === repositoryId) this.drafts.delete(draftId);
    }
  }
}
