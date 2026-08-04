import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  ANALYSIS_SCHEMA_VERSION,
  IntelligenceError,
  createAnalysisSnapshot,
} from '../contracts.mjs';
import { queryAnalysisSnapshot } from '../memory-query.mjs';

export const GRAPHIFY_ADAPTER_VERSION = '1.0.0';
export const GRAPHIFY_TESTED_VERSIONS = Object.freeze(['0.9.32']);
export const GRAPHIFY_SUPPORTED_VERSIONS = Object.freeze({
  major: 0,
  minor: 9,
  minimumPatch: 21,
  maximumPatch: 32,
  display: '>=0.9.21 <=0.9.32',
});

const MAX_GRAPH_NODES = 100_000;
const MAX_GRAPH_RELATIONS = 100_000;
const MAX_DIAGNOSTICS = 250;
const VERSION_TIMEOUT_MS = 3_000;
const VERSION_OUTPUT_BYTES = 256 * 1024;

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.py': 'Python',
  '.ts': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.cu': 'C++', '.cuh': 'C++', '.metal': 'C++',
  '.rb': 'Ruby', '.cs': 'C#', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala',
  '.php': 'PHP', '.swift': 'Swift', '.lua': 'Lua', '.luau': 'Lua', '.toc': 'Lua',
  '.zig': 'Zig', '.ps1': 'PowerShell', '.psm1': 'PowerShell', '.psd1': 'PowerShell',
  '.ex': 'Elixir', '.exs': 'Elixir', '.m': 'Objective-C', '.mm': 'Objective-C', '.jl': 'Julia',
  '.vue': 'Vue', '.svelte': 'Svelte', '.astro': 'Astro', '.groovy': 'Groovy', '.gradle': 'Groovy',
  '.dart': 'Dart', '.v': 'Verilog', '.sv': 'SystemVerilog', '.svh': 'SystemVerilog',
  '.sql': 'SQL', '.f': 'Fortran', '.f90': 'Fortran', '.f95': 'Fortran', '.f03': 'Fortran', '.f08': 'Fortran',
  '.pas': 'Pascal', '.pp': 'Pascal', '.dpr': 'Pascal', '.dpk': 'Pascal', '.lpr': 'Pascal',
  '.inc': 'Pascal', '.dfm': 'Pascal', '.lfm': 'Pascal', '.lpk': 'Pascal',
  '.sh': 'Shell', '.bash': 'Shell', '.json': 'JSON',
  '.dm': 'DreamMaker', '.dme': 'DreamMaker', '.dmi': 'DreamMaker', '.dmm': 'DreamMaker', '.dmf': 'DreamMaker',
  '.sln': '.NET', '.slnx': '.NET', '.csproj': '.NET', '.fsproj': '.NET', '.vbproj': '.NET',
  '.xaml': '.NET', '.razor': '.NET', '.cshtml': '.NET', '.cls': 'Salesforce Apex', '.trigger': 'Salesforce Apex',
});

const CAPABILITY_LANGUAGES = Object.freeze([...new Set(Object.values(LANGUAGE_BY_EXTENSION))].sort());
const CAPABILITY_RELATIONS = Object.freeze([
  'calls', 'contains', 'depends_on', 'imports', 'imports_from', 'inherits', 'implements',
  'references', 're_exports', 'uses',
]);

const digest = (value) => createHash('sha256').update(value).digest('hex');

function cleanText(value, limit = 4_096) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function pathWithin(root, target) {
  const from = resolve(root);
  const to = resolve(target);
  return to === from || to.startsWith(`${from}${sep}`);
}

function contractId(prefix, value) {
  return `${prefix}:${digest(String(value)).slice(0, 32)}`;
}

function commandEnvironment() {
  return {
    PATH: process.env.PATH || '',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    GRAPHIFY_QUERY_LOG_DISABLE: '1',
    ...(process.platform === 'win32'
      ? { SYSTEMROOT: process.env.SYSTEMROOT || '', WINDIR: process.env.WINDIR || '' }
      : {}),
  };
}

function runDetectionCommand(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: commandEnvironment(),
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: VERSION_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    const code = result.error.code === 'ENOENT' ? 'GRAPHIFY_NOT_FOUND' : 'GRAPHIFY_DETECTION_FAILED';
    return { ok: false, code, reason: cleanText(result.error.message, 2_000) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      code: result.signal ? 'GRAPHIFY_DETECTION_TIMEOUT' : 'GRAPHIFY_DETECTION_FAILED',
      reason: cleanText(result.stderr || result.stdout || `graphify exited with code ${result.status}`, 2_000),
    };
  }
  return { ok: true, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function parseVersion(value) {
  const match = String(value || '').match(/\bgraphify\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/i);
  if (!match) return null;
  return {
    exact: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function supportedVersion(version) {
  return version
    && version.major === GRAPHIFY_SUPPORTED_VERSIONS.major
    && version.minor === GRAPHIFY_SUPPORTED_VERSIONS.minor
    && version.patch >= GRAPHIFY_SUPPORTED_VERSIONS.minimumPatch
    && version.patch <= GRAPHIFY_SUPPORTED_VERSIONS.maximumPatch;
}

export function detectGraphify({ executable = 'graphify' } = {}) {
  const binary = cleanText(executable, 4_096) || 'graphify';
  const versionResult = runDetectionCommand(binary, ['--version']);
  if (!versionResult.ok) {
    return Object.freeze({
      available: false,
      code: versionResult.code,
      reason: versionResult.code === 'GRAPHIFY_NOT_FOUND'
        ? 'Graphify is not installed or is outside the server PATH. Handraise will not install it automatically.'
        : `Graphify could not be inspected safely: ${versionResult.reason}`,
      binary,
      package: 'graphifyy',
      supportedVersions: GRAPHIFY_SUPPORTED_VERSIONS.display,
      testedVersions: GRAPHIFY_TESTED_VERSIONS,
    });
  }
  const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!version) {
    return Object.freeze({
      available: false,
      code: 'GRAPHIFY_VERSION_UNREADABLE',
      reason: 'The Graphify binary did not report an exact semantic version in `graphify X.Y.Z` form.',
      binary,
      package: 'graphifyy',
      supportedVersions: GRAPHIFY_SUPPORTED_VERSIONS.display,
      testedVersions: GRAPHIFY_TESTED_VERSIONS,
    });
  }
  if (!supportedVersion(version)) {
    return Object.freeze({
      available: false,
      code: 'GRAPHIFY_VERSION_UNSUPPORTED',
      reason: `Graphify ${version.exact} is outside the tested adapter range ${GRAPHIFY_SUPPORTED_VERSIONS.display}.`,
      binary,
      package: 'graphifyy',
      version: version.exact,
      supportedVersions: GRAPHIFY_SUPPORTED_VERSIONS.display,
      testedVersions: GRAPHIFY_TESTED_VERSIONS,
    });
  }
  const helpResult = runDetectionCommand(binary, ['extract', '--help']);
  if (!helpResult.ok) {
    return Object.freeze({
      available: false,
      code: 'GRAPHIFY_COMMAND_UNAVAILABLE',
      reason: `Graphify ${version.exact} does not expose a usable headless extract command: ${helpResult.reason}`,
      binary,
      package: 'graphifyy',
      version: version.exact,
      supportedVersions: GRAPHIFY_SUPPORTED_VERSIONS.display,
      testedVersions: GRAPHIFY_TESTED_VERSIONS,
    });
  }
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  const missingFlags = ['--code-only', '--out', '--no-cluster', '--max-workers'].filter((flag) => !help.includes(flag));
  if (missingFlags.length) {
    return Object.freeze({
      available: false,
      code: 'GRAPHIFY_CAPABILITY_MISMATCH',
      reason: `Graphify ${version.exact} is missing required safe-extraction flags: ${missingFlags.join(', ')}.`,
      binary,
      package: 'graphifyy',
      version: version.exact,
      supportedVersions: GRAPHIFY_SUPPORTED_VERSIONS.display,
      testedVersions: GRAPHIFY_TESTED_VERSIONS,
    });
  }
  return Object.freeze({
    available: true,
    code: 'GRAPHIFY_AVAILABLE',
    reason: `Graphify ${version.exact} supports the isolated local code-graph contract.`,
    binary,
    package: 'graphifyy',
    version: version.exact,
    supportedVersions: GRAPHIFY_SUPPORTED_VERSIONS.display,
    testedVersions: GRAPHIFY_TESTED_VERSIONS,
    command: 'extract --code-only --no-cluster --out <private-output>',
    schema: 'graphify-node-link/extraction-v1',
    isolation: 'private-snapshot-and-output',
    capabilities: {
      deterministicCode: true,
      semantic: false,
      modelBackend: false,
      installsHooks: false,
      installsSkills: false,
    },
  });
}

function graphifyLanguage(path) {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] || null;
}

function languagePlan(manifest) {
  const groups = new Map();
  for (const file of manifest.files) {
    const language = graphifyLanguage(file.path);
    const subject = language || `Unsupported (${extname(file.path).toLowerCase() || 'no extension'})`;
    const item = groups.get(subject) || { subject, supported: Boolean(language), files: 0, bytes: 0 };
    item.files += 1;
    item.bytes += file.size;
    groups.set(subject, item);
  }
  return [...groups.values()].sort((left, right) => left.subject.localeCompare(right.subject)).map((item) => ({
    ...item,
    status: item.supported ? 'covered' : 'unsupported',
    summary: item.supported
      ? 'Supported by Graphify local AST/code extraction; actual parse coverage is verified from the result.'
      : 'Not part of Handraise\'s deterministic Graphify code-only capability.',
  }));
}

function safeGraphFile(outputPath, byteLimit) {
  const outputRoot = realpathSync(outputPath);
  const candidates = [
    join(outputRoot, 'graphify-out', 'graph.json'),
    join(outputRoot, 'graph.json'),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new IntelligenceError('GRAPHIFY_OUTPUT_MISSING', 'Graphify completed without a private graph.json output');
  }
  const before = lstatSync(candidate);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new IntelligenceError('GRAPHIFY_OUTPUT_UNSAFE', 'Graphify graph output must be a regular file, never a symbolic link');
  }
  const resolved = realpathSync(candidate);
  if (!pathWithin(outputRoot, resolved)) {
    throw new IntelligenceError('GRAPHIFY_OUTPUT_UNSAFE', 'Graphify graph output escaped the private output directory');
  }
  if (before.size > byteLimit) {
    throw new IntelligenceError('OUTPUT_LIMIT', `Graphify graph output exceeded the ${byteLimit}-byte output budget`);
  }
  let descriptor;
  try {
    descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    throw new IntelligenceError('GRAPHIFY_OUTPUT_UNSAFE', 'Graphify graph output could not be opened without following links', { cause: error });
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size || opened.size > byteLimit) {
      throw new IntelligenceError('GRAPHIFY_OUTPUT_CHANGED', 'Graphify output changed while it was being validated');
    }
    const serialized = readFileSync(descriptor, 'utf8');
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || Buffer.byteLength(serialized) !== opened.size) {
      throw new IntelligenceError('GRAPHIFY_OUTPUT_CHANGED', 'Graphify output changed while it was being read');
    }
    try { return JSON.parse(serialized); }
    catch (error) {
      throw new IntelligenceError('GRAPHIFY_SCHEMA_INVALID', 'Graphify graph.json is not valid JSON', { cause: error });
    }
  } finally {
    closeSync(descriptor);
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntelligenceError('GRAPHIFY_SCHEMA_INVALID', `${label} must be an object`);
  }
  return value;
}

function upstreamId(value, label) {
  const candidate = value && typeof value === 'object' ? value.id : value;
  if (!['string', 'number'].includes(typeof candidate) || !String(candidate).trim()) {
    throw new IntelligenceError('GRAPHIFY_SCHEMA_INVALID', `${label} must reference a string or numeric node id`);
  }
  return String(candidate);
}

function sourceRange(value) {
  if (!value) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.start && typeof value.start === 'object') {
      const startLine = Number(value.start.line);
      const endLine = Number(value.end?.line ?? startLine);
      if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine) return undefined;
      return {
        start: { line: startLine, column: Math.max(1, Number(value.start.column) || 1) },
        end: { line: endLine, column: Math.max(1, Number(value.end?.column) || 1) },
      };
    }
    const startLine = Number(value.line ?? value.start_line);
    const endLine = Number(value.end_line ?? startLine);
    if (Number.isSafeInteger(startLine) && startLine >= 1 && Number.isSafeInteger(endLine) && endLine >= startLine) {
      return {
        start: { line: startLine, column: Math.max(1, Number(value.column ?? value.start_column) || 1) },
        end: { line: endLine, column: Math.max(1, Number(value.end_column) || 1) },
      };
    }
    return undefined;
  }
  const match = String(value).match(/(?:^|[^0-9])L?(\d+)(?::(\d+))?(?:\s*[-–]\s*L?(\d+)(?::(\d+))?)?/i);
  if (!match) return undefined;
  const startLine = Number(match[1]);
  const endLine = Number(match[3] || match[1]);
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine) return undefined;
  return {
    start: { line: startLine, column: Math.max(1, Number(match[2]) || 1) },
    end: { line: endLine, column: Math.max(1, Number(match[4]) || 1) },
  };
}

function repositoryPath(value, context) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (candidate.includes('\0')) return null;
  if (isAbsolute(candidate)) {
    const relativeCandidate = relative(context.sourcePath, candidate).replaceAll('\\', '/');
    if (!relativeCandidate || relativeCandidate.startsWith('../') || isAbsolute(relativeCandidate)) return null;
    return context.manifest.files.some((file) => file.path === relativeCandidate) ? relativeCandidate : null;
  }
  if (/^[A-Za-z]:\//.test(candidate) || candidate.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return context.manifest.files.some((file) => file.path === candidate) ? candidate : null;
}

function safePrimitive(value, limit = 2_000) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return cleanText(value, limit);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safePrimitive(item, 256)).filter((item) => item !== undefined);
  return undefined;
}

function confidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { score: Math.max(0, Math.min(1, value)), tag: 'NUMERIC', provenance: value >= .99 ? 'extracted' : 'inferred' };
  }
  const tag = cleanText(value || 'UNKNOWN', 64).toUpperCase();
  if (tag === 'EXTRACTED') return { score: 1, tag, provenance: 'extracted' };
  if (tag === 'INFERRED') return { score: .65, tag, provenance: 'inferred' };
  if (tag === 'AMBIGUOUS') return { score: .35, tag, provenance: 'inferred' };
  return { score: .5, tag, provenance: 'inferred', unknown: true };
}

function boundedDiagnosticsPush(diagnostics, item) {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(item);
}

function normalizeGraphifyGraph(graphValue, { descriptor, detection, context, stderr }) {
  const graph = record(graphValue, 'Graphify graph.json');
  if (!Array.isArray(graph.nodes)) throw new IntelligenceError('GRAPHIFY_SCHEMA_INVALID', 'Graphify graph.json must contain a nodes array');
  const rawRelations = Array.isArray(graph.links) ? graph.links : Array.isArray(graph.edges) ? graph.edges : null;
  if (!rawRelations) throw new IntelligenceError('GRAPHIFY_SCHEMA_INVALID', 'Graphify graph.json must contain a links or edges array');
  if (graph.nodes.length > MAX_GRAPH_NODES) throw new IntelligenceError('OUTPUT_LIMIT', `Graphify returned more than ${MAX_GRAPH_NODES} nodes`);
  if (rawRelations.length > MAX_GRAPH_RELATIONS) throw new IntelligenceError('OUTPUT_LIMIT', `Graphify returned more than ${MAX_GRAPH_RELATIONS} relations`);

  const diagnostics = [];
  const evidence = [];
  const entities = [];
  const nodeIds = new Map();
  const entityEvidence = new Map();
  const manifestByPath = new Map(context.manifest.files.map((file) => [file.path, file]));
  let outOfScopeSources = 0;

  graph.nodes.forEach((nodeValue, index) => {
    const node = record(nodeValue, `Graphify node ${index}`);
    const originalId = upstreamId(node.id ?? node.key ?? node.name, `Graphify node ${index}.id`);
    if (nodeIds.has(originalId)) throw new IntelligenceError('GRAPHIFY_SCHEMA_INVALID', `Graphify graph contains duplicate node id '${cleanText(originalId, 256)}'`);
    const id = contractId('entity:graphify', originalId);
    nodeIds.set(originalId, id);
    const rawSource = node.source_file ?? node.sourceFile ?? node.path ?? null;
    const path = repositoryPath(rawSource, context);
    if (rawSource && !path) outOfScopeSources += 1;
    const range = sourceRange(node.source_location ?? node.sourceLocation ?? node.location);
    const evidenceIds = [];
    if (path) {
      const evidenceId = contractId('evidence:graphify-node', `${originalId}\0${path}\0${JSON.stringify(range || null)}`);
      const source = manifestByPath.get(path);
      evidence.push({
        id: evidenceId,
        sourceKind: 'source',
        provenance: 'extracted',
        path,
        ...(range ? { range } : {}),
        revision: source.digest,
        summary: `Graphify located ${cleanText(node.label ?? node.name ?? originalId, 256)} in the reviewed private snapshot.`,
        extensions: { graphifyNodeId: cleanText(originalId, 256) },
      });
      evidenceIds.push(evidenceId);
    }
    entityEvidence.set(id, evidenceIds);
    const entity = {
      id,
      kind: cleanText(node.file_type ?? node.kind ?? node.type ?? 'symbol', 128) || 'symbol',
      name: cleanText(node.label ?? node.name ?? originalId, 1_024) || cleanText(originalId, 1_024),
      evidenceIds,
      ...(path ? { location: { path, ...(range ? { range } : {}) }, language: cleanText(node.language || graphifyLanguage(path) || '', 128) || undefined } : {}),
      attributes: {
        graphifyNodeId: cleanText(originalId, 256),
        ...(safePrimitive(node.community) !== undefined ? { community: safePrimitive(node.community) } : {}),
        ...(safePrimitive(node.confidence) !== undefined ? { graphifyConfidence: safePrimitive(node.confidence) } : {}),
        ...(safePrimitive(node.verification) !== undefined ? { verification: safePrimitive(node.verification) } : {}),
        ...(safePrimitive(node._origin ?? node.origin) !== undefined ? { graphifyOrigin: safePrimitive(node._origin ?? node.origin) } : {}),
      },
    };
    if (!entity.language) delete entity.language;
    entities.push(entity);
  });

  let danglingRelations = 0;
  let unknownConfidence = 0;
  const relations = [];
  rawRelations.forEach((relationValue, index) => {
    const relation = record(relationValue, `Graphify relation ${index}`);
    const sourceOriginal = upstreamId(relation.source ?? relation._src, `Graphify relation ${index}.source`);
    const targetOriginal = upstreamId(relation.target ?? relation._tgt, `Graphify relation ${index}.target`);
    const source = nodeIds.get(sourceOriginal);
    const target = nodeIds.get(targetOriginal);
    if (!source || !target) {
      danglingRelations += 1;
      return;
    }
    const assessed = confidence(relation.confidence ?? relation.provenance);
    if (assessed.unknown) unknownConfidence += 1;
    const kind = cleanText(relation.relation ?? relation.kind ?? relation.type ?? 'related_to', 128) || 'related_to';
    const relationKey = relation.id ?? `${sourceOriginal}\0${targetOriginal}\0${kind}\0${index}`;
    const evidenceIds = [...new Set([...(entityEvidence.get(source) || []), ...(entityEvidence.get(target) || [])])];
    relations.push({
      id: contractId('relation:graphify', relationKey),
      source,
      target,
      kind,
      evidenceIds,
      confidence: assessed.score,
      attributes: {
        provenance: assessed.provenance,
        graphifyConfidence: assessed.tag,
        ...(safePrimitive(relation.context) !== undefined ? { context: safePrimitive(relation.context) } : {}),
        ...(safePrimitive(relation._origin ?? relation.origin) !== undefined ? { graphifyOrigin: safePrimitive(relation._origin ?? relation.origin) } : {}),
      },
    });
  });

  if (outOfScopeSources) boundedDiagnosticsPush(diagnostics, {
    code: 'GRAPHIFY_SOURCE_OUT_OF_SCOPE', severity: 'warning',
    message: `${outOfScopeSources} Graphify node source path(s) were absent from the reviewed manifest; those nodes retain no source location.`,
    details: { count: outOfScopeSources },
  });
  if (danglingRelations) boundedDiagnosticsPush(diagnostics, {
    code: 'GRAPHIFY_DANGLING_RELATIONS', severity: 'warning',
    message: `${danglingRelations} Graphify relation(s) referenced missing nodes and were excluded from the normalized snapshot.`,
    details: { count: danglingRelations },
  });
  if (unknownConfidence) boundedDiagnosticsPush(diagnostics, {
    code: 'GRAPHIFY_UNKNOWN_CONFIDENCE', severity: 'warning',
    message: `${unknownConfidence} relation(s) used an unknown confidence label and were retained as inferred with neutral confidence.`,
    details: { count: unknownConfidence },
  });

  const upstreamDiagnostics = [
    ...(Array.isArray(graph.diagnostics) ? graph.diagnostics : []),
    ...(Array.isArray(graph.parse_failures) ? graph.parse_failures : []),
    ...(Array.isArray(graph.failed_files) ? graph.failed_files : []),
    ...(Array.isArray(graph.errors) ? graph.errors : []),
  ];
  for (const item of upstreamDiagnostics.slice(0, MAX_DIAGNOSTICS - diagnostics.length)) {
    const detail = item && typeof item === 'object' ? item : { message: item };
    const path = repositoryPath(detail.path ?? detail.source_file ?? detail.file, context);
    boundedDiagnosticsPush(diagnostics, {
      code: 'GRAPHIFY_UPSTREAM_DIAGNOSTIC',
      severity: String(detail.severity || '').toLowerCase() === 'error' ? 'error' : 'warning',
      message: cleanText(detail.message ?? detail.error ?? JSON.stringify(detail), 4_096) || 'Graphify reported an extraction diagnostic.',
      ...(path ? { path } : {}),
    });
  }

  const pathsWithEntities = new Set(entities.flatMap((entity) => entity.location ? [entity.location.path] : []));
  const coverage = (context.adapterPlan?.languageCoverage || languagePlan(context.manifest)).map((item) => {
    const paths = context.manifest.files.filter((file) => (graphifyLanguage(file.path) || `Unsupported (${extname(file.path).toLowerCase() || 'no extension'})`) === item.subject);
    const represented = paths.filter((file) => pathsWithEntities.has(file.path));
    const status = !item.supported ? 'unsupported' : represented.length < paths.length ? 'partial' : 'covered';
    const evidenceIds = [...new Set(entities.filter((entity) => entity.location && paths.some((file) => file.path === entity.location.path)).flatMap((entity) => entity.evidenceIds))];
    return {
      id: contractId('coverage:graphify', item.subject),
      subject: item.subject,
      status,
      summary: !item.supported
        ? `${paths.length} file(s) were outside the deterministic code-only capability.`
        : status === 'covered'
          ? `${represented.length} of ${paths.length} selected file(s) produced located graph entities.`
          : `${represented.length} of ${paths.length} selected file(s) produced located graph entities; absence is not treated as proof that no symbols exist.`,
      evidenceIds,
    };
  });
  if (context.scope.truncated) boundedDiagnosticsPush(diagnostics, {
    code: 'SCOPE_TRUNCATED', severity: 'warning', message: 'The reviewed repository scope reached a file or byte budget before Graphify ran.',
  });

  const redactedStderr = cleanText(stderr, 2_000)
    .replaceAll(context.sourcePath, '<private-snapshot>')
    .replaceAll(context.outputPath, '<private-output>');
  const partial = context.scope.truncated
    || coverage.some((item) => item.status !== 'covered')
    || diagnostics.some((item) => item.severity === 'error' || item.code.startsWith('GRAPHIFY_'));
  return createAnalysisSnapshot({
    repository: context.repository,
    createdAt: context.createdAt,
    analyzer: descriptor,
    configuration: context.options,
    status: partial ? 'partial' : 'complete',
    freshness: { state: 'current', checkedAt: context.createdAt },
    manifest: context.manifest,
    scope: context.scope,
    evidence,
    entities,
    relations,
    findings: [],
    coverage,
    diagnostics,
    extensions: {
      graphify: {
        adapterVersion: GRAPHIFY_ADAPTER_VERSION,
        upstreamVersion: detection.version,
        schema: detection.schema,
        mode: 'code-only',
        deterministic: true,
        semantic: false,
        sourceMayLeaveHost: false,
        directed: Boolean(graph.directed),
        upstreamNodeCount: graph.nodes.length,
        upstreamRelationCount: rawRelations.length,
        ...(redactedStderr ? { stderr: redactedStderr } : {}),
      },
    },
  });
}

export function createGraphifyAdapter({ executable = 'graphify', detection: suppliedDetection = null } = {}) {
  const detection = suppliedDetection || detectGraphify({ executable });
  const descriptor = {
    id: 'graphify-code-local',
    name: 'Graphify local code graph',
    version: detection.available ? detection.version : `adapter-${GRAPHIFY_ADAPTER_VERSION}`,
    contractVersion: ANALYSIS_SCHEMA_VERSION,
    capabilities: {
      languages: CAPABILITY_LANGUAGES,
      entityKinds: ['class', 'code', 'concept', 'constant', 'document', 'file', 'function', 'interface', 'method', 'module', 'package', 'rationale', 'symbol'],
      relationKinds: CAPABILITY_RELATIONS,
      queries: ['entity', 'search', 'neighbors', 'path', 'evidence'],
      history: false,
      semantic: false,
      incremental: false,
    },
    privacy: { localOnly: true, modelAssisted: false, sourceMayLeaveHost: false, requiresConsent: false },
    extensions: {
      integration: 'graphify',
      package: 'graphifyy',
      adapterVersion: GRAPHIFY_ADAPTER_VERSION,
      upstreamVersion: detection.version || null,
      supportedVersions: GRAPHIFY_SUPPORTED_VERSIONS.display,
      testedVersions: GRAPHIFY_TESTED_VERSIONS,
      mode: 'code-only',
    },
  };
  let lastSnapshot = null;
  return {
    descriptor,
    detect() {
      const current = detectGraphify({ executable });
      if (detection.available && current.available && current.version !== detection.version) {
        return {
          ...current,
          available: false,
          code: 'GRAPHIFY_VERSION_CHANGED',
          reason: `Graphify changed from ${detection.version} to ${current.version} after the adapter was registered. Restart Handraise before using it.`,
        };
      }
      return current;
    },
    plan({ manifest }) {
      if (!detection.available) throw new IntelligenceError('ANALYZER_UNAVAILABLE', detection.reason, { details: detection });
      const languageCoverage = languagePlan(manifest);
      return {
        adapter: 'graphify',
        adapterVersion: GRAPHIFY_ADAPTER_VERSION,
        upstreamVersion: detection.version,
        package: 'graphifyy',
        mode: 'code-only',
        deterministic: true,
        semantic: false,
        sourceMayLeaveHost: false,
        isolation: 'private-snapshot-and-output',
        output: '<private-output>/graphify-out/graph.json',
        invocation: ['graphify', 'extract', '<private-snapshot>', '--code-only', '--no-cluster', '--out', '<private-output>', '--max-workers', '<bounded>'],
        languageCoverage,
        supportedFiles: languageCoverage.filter((item) => item.supported).reduce((sum, item) => sum + item.files, 0),
        unsupportedFiles: languageCoverage.filter((item) => !item.supported).reduce((sum, item) => sum + item.files, 0),
      };
    },
    analyze() {
      throw new IntelligenceError('INVALID_ANALYZER_COMMAND', 'Graphify must execute through the command adapter boundary');
    },
    query(query) {
      if (!lastSnapshot) throw new IntelligenceError('SNAPSHOT_NOT_LOADED', 'no Graphify snapshot is loaded');
      return queryAnalysisSnapshot(lastSnapshot, query);
    },
    dispose() { lastSnapshot = null; },
    execution: {
      command({ sourcePath, outputPath, options, adapterPlan }) {
        if (!detection.available) throw new IntelligenceError('ANALYZER_UNAVAILABLE', detection.reason, { details: detection });
        if (adapterPlan?.upstreamVersion !== detection.version || adapterPlan?.mode !== 'code-only') {
          throw new IntelligenceError('ANALYZER_CHANGED', 'Graphify capabilities changed after scope review; create a fresh plan');
        }
        const maxWorkers = Math.max(1, Math.min(4, Number(options?.limits?.maxProcesses) || 1));
        return {
          file: executable,
          args: ['extract', sourcePath, '--code-only', '--no-cluster', '--out', outputPath, '--max-workers', String(maxWorkers)],
          env: {
            HANDRAISE_GRAPHIFY_MODE: 'code-only',
            HANDRAISE_GRAPHIFY_NETWORK: 'no-provider-credentials',
          },
        };
      },
      parseResult({ stderr, outputPath, context }) {
        const graph = safeGraphFile(outputPath, context.options.limits.maxOutputBytes);
        lastSnapshot = normalizeGraphifyGraph(graph, { descriptor, detection, context, stderr: stderr.toString('utf8') });
        return lastSnapshot;
      },
    },
  };
}
