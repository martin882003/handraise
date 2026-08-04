// The HTTP surface. Small on purpose: the panel has no database and no model of
// its own, so every route either derives state from tmux and the hook files, or
// pushes a key into a pane.
//
// It binds to 127.0.0.1 by default. This drives real agents on your machine —
// exposing it to a network is a decision you have to make explicitly, and one
// you should only make behind something that authenticates.

import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

import {
  askToPause, askToWrapUp, capture, exists, kill, resume, sendKey, sendText, start,
} from './control.mjs';
import { ansiToHtml } from './ansi.mjs';
import { AdHocRunError, AdHocRunStore } from './ad-hoc-runs.mjs';
import { createPairingAuth } from './auth.mjs';
import { agentAuthInvocation, agentInvocation, createConfigStore, detectAdapter } from './config.mjs';
import { HistoryTracker, historyOutcomes, historySummary, readHistory } from './history.mjs';
import { installHooks as repairAgentHooks } from './hooks.mjs';
import { DiscoveryDraftStore } from './discovery.mjs';
import { ComponentDesignDraftStore, ComponentDesignError } from './component-design.mjs';
import { FrontPlanningDraftStore, FrontDesignError } from './front-design.mjs';
import { fleetManagerPrompt } from './fleet.mjs';
import { AnalysisRuntime } from './intelligence/runtime.mjs';
import { IntelligenceError } from './intelligence/contracts.mjs';
import { createGraphifyAdapter } from './intelligence/adapters/graphify.mjs';
import { SystemMapRuntime } from './intelligence/system-map.mjs';
import { implicitLocalClient, LOCAL_CLIENT_ID } from './local-client.mjs';
import { LearningError, LearningProposalStore } from './learning.mjs';
import { PlanningError } from './planning/contracts.mjs';
import { createClaudePlanningDeclaration } from './planning/adapters/claude-unavailable.mjs';
import { createCodexPlanningAdapter } from './planning/adapters/codex.mjs';
import { PlanningRuntime } from './planning/runtime.mjs';
import { PlanPublicationError, PlanPublicationStore, publicationSourceRevision } from './plan-publication.mjs';
import { QUALITY_BENCHMARK_ENGINE_VERSION } from './quality-benchmark.mjs';
import { ReconciliationError, ReconciliationRuntime } from './reconciliation.mjs';
import { ReleaseError, ReleaseStore } from './releases.mjs';
import { RunOrchestrationError, RunOrchestrationStore } from './run-orchestration.mjs';
import {
  ProductDirectionDraftStore, ProductDirectionError, normalizeProductBrief, productBriefQuestions, readAcceptedProduct,
} from './product-direction.mjs';
import { pairingOriginFor, remoteAccessOptions } from './remote-access.mjs';
import {
  applyWorkContractMigration, createComponent, createFront, deleteComponent, deleteFront, initializeNativeRepository,
  previewWorkContractMigration, repositoriesSnapshot, repositoryPortfolio, setComponentState, updateComponent, updateFront,
} from './repositories.mjs';
import { resolvePermission, snapshot, stateDir } from './state.mjs';
import { createManagedInternetTunnel } from './tunnel.mjs';
import { WorkContractError } from './work-contracts.mjs';
import { createWorktree, gitState, removeWorktree, workshopSnapshot } from './worktrees.mjs';

import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const sha256Json = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const qualityReportPath = fileURLToPath(new URL('../benchmark/results/latest.json', import.meta.url));

function qualityBenchmarkStatus() {
  try {
    const report = JSON.parse(readFileSync(qualityReportPath, 'utf8'));
    return {
      benchmarkVersion: String(report.benchmarkVersion || QUALITY_BENCHMARK_ENGINE_VERSION),
      corpusVersion: String(report.corpusVersion || 'unknown'),
      status: ['pass', 'fail', 'blocked'].includes(report.status) ? report.status : 'unverified',
      promotionAllowed: report.promotionAllowed === true,
      automatedPass: report.gate?.automatedPass === true,
      humanStatus: ['pass', 'fail', 'blocked'].includes(report.human?.status) ? report.human.status : 'unverified',
      generatedAt: report.generatedAt || null,
      limitations: Array.isArray(report.limitations) ? report.limitations.map(String).slice(0, 10) : [],
    };
  } catch {
    return {
      benchmarkVersion: QUALITY_BENCHMARK_ENGINE_VERSION, corpusVersion: 'unknown', status: 'unverified',
      promotionAllowed: false, automatedPass: false, humanStatus: 'unverified', generatedAt: null,
      limitations: ['No checked planning-quality report is available in this installation.'],
    };
  }
}

async function pickDirectory() {
  const commands = process.platform === 'darwin'
    ? [['osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a Git repository")']]]
    : process.platform === 'win32'
      ? [['powershell.exe', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq "OK"){[Console]::Write($d.SelectedPath)}']]]
      : [['zenity', ['--file-selection', '--directory', '--title=Choose a Git repository']], ['kdialog', ['--getexistingdirectory', '.', 'Choose a Git repository']]];

  for (const [command, args] of commands) {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 30_000, maxBuffer: 32_000 });
      const path = String(stdout || '').trim();
      if (path) return path;
    } catch (error) {
      // ENOENT means this picker is not installed. Any other exit is a user
      // cancellation (or a picker failure), so do not open a second dialog.
      if (error?.code !== 'ENOENT') return null;
    }
  }
  return null;
}

function browseDirectory(pathname = '') {
  const requested = String(pathname || '').trim() || homedir();
  const path = realpathSync(resolve(requested));
  if (!statSync(path).isDirectory()) throw new Error('path is not a directory');
  const parent = path === dirname(path) ? null : dirname(path);
  const directories = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  return { path, parent, directories };
}

function readinessSnapshot(root, config) {
  const checks = {};
  try {
    checks.tmux = { ok: true, version: execFileSync('tmux', ['-V'], { encoding: 'utf8', timeout: 3_000 }).trim() };
  } catch {
    checks.tmux = { ok: false, recovery: 'Install tmux and restart the Handraise server.' };
  }
  try {
    accessSync(root, constants.R_OK | constants.W_OK);
    checks.state = { ok: true };
  } catch {
    checks.state = { ok: false, recovery: `Make ${root} readable and writable by the server user.` };
  }
  try {
    const settings = config.read();
    checks.config = { ok: true, repositories: settings.repositories.length };
  } catch {
    checks.config = { ok: false, recovery: 'Repair the Handraise settings file or run handraise doctor.' };
  }
  return { ready: Object.values(checks).every((check) => check.ok), checks, at: new Date().toISOString() };
}

const here = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(here, '..', 'dist', 'ui');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function serveWeb(pathname, response, webRoot, { head = false } = {}) {
  let relative;
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'; }
  catch { return false; }
  if (relative.split('/').includes('..')) return false;

  const root = resolve(webRoot);
  let file = resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${sep}`)) return false;
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    if (extname(relative)) return false;
    file = join(root, 'index.html');
    try { if (!statSync(file).isFile()) return false; } catch { return false; }
  }

  const extension = extname(file);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': CONTENT_TYPES[extension] || 'application/octet-stream',
    'cache-control': relative.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  response.end(head ? undefined : readFileSync(file));
  return true;
}

// Session names come from the URL, so the pattern is the security boundary for
// everything downstream: tmux target names are built from it.
const SLUG = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_SLUG = /^[A-Za-z0-9._-]{1,140}$/;

const json = (response, code, payload, headers = {}) => {
  response.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
};

function requestOrigin(request) {
  const protocol = request.socket?.encrypted ? 'https' : 'http';
  return `${protocol}://${request.headers.host || 'invalid.local'}`;
}

function publicOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function secureRequest(request) {
  return Boolean(request.socket?.encrypted);
}

function localTunnelTarget(listener) {
  if (!listener || typeof listener === 'string' || !listener.port) throw new Error('the server listener is not ready');
  const bound = String(listener.address || '');
  const address = bound === '0.0.0.0' ? '127.0.0.1' : ['::', '::0'].includes(bound) ? '::1' : bound;
  if (!address) throw new Error('the server listener address is unavailable');
  return `http://${address.includes(':') ? `[${address}]` : address}:${listener.port}`;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === new URL(requestOrigin(request)).host; }
  catch { return false; }
}

function body(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) request.destroy(); });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

export function createHandraise({
  root = stateDir(), webRoot = WEB_ROOT,
  publicUrl = process.env.HANDRAISE_PUBLIC_URL || null,
  auth = createPairingAuth({ root }), config = createConfigStore({ root }),
  launchSession = start,
  createRunWorkspace = createWorktree,
  removeRunWorkspace = removeWorktree,
  inspectRunGitState = gitState,
  inspectRunWorkshop = workshopSnapshot,
  networkInterfaceSnapshot = null,
  managedInternetTunnel = null,
  productDirectionStore = null,
  componentDesignStore = null,
  frontPlanningStore = null,
  publicationStore = null,
  releaseStore = null,
  adHocRunStore = null,
  runOrchestrationStore = null,
  analysisRuntime = null,
  systemMapRuntime = null,
  reconciliationRuntime = null,
  learningStore = null,
  planningRuntime = null,
} = {}) {
  const pairingOrigin = publicOrigin(publicUrl);
  const internetTunnel = managedInternetTunnel || createManagedInternetTunnel({ root });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootState = lstatSync(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new Error('Handraise state root must be a real directory');
  chmodSync(root, 0o700);
  for (const name of ['attention', 'permissions']) {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  const clients = new Set();
  let timer = null;
  const history = new HistoryTracker({ root });
  const discoveries = new DiscoveryDraftStore();
  const productDirections = productDirectionStore || new ProductDirectionDraftStore({ root });
  const componentDesigns = componentDesignStore || new ComponentDesignDraftStore({ root: join(root, 'component-design-drafts') });
  const frontDesigns = frontPlanningStore || new FrontPlanningDraftStore({ root: join(root, 'front-planning-drafts') });
  const publications = publicationStore || new PlanPublicationStore({ root: join(root, 'plan-publication-previews') });
  const releases = releaseStore || new ReleaseStore();
  const adHocRuns = adHocRunStore || new AdHocRunStore({ root: join(root, 'ad-hoc-runs') });
  const runOrchestration = runOrchestrationStore || new RunOrchestrationStore({ root: join(root, 'runs') });
  const analyses = analysisRuntime || new AnalysisRuntime({
    root: join(root, 'analysis'),
    adapters: [createGraphifyAdapter()],
  });
  const systemMaps = systemMapRuntime || new SystemMapRuntime();
  const reconciliations = reconciliationRuntime || new ReconciliationRuntime({
    root: join(root, 'reconciliation'),
    analyses,
    systemMaps,
    context: (repository) => {
      const target = { ...repository, adapter: detectAdapter(repository.path) };
      const state = fleetSnapshot();
      let portfolio = { components: [], fronts: [] };
      let diagnostic = null;
      try { portfolio = repositoryPortfolio(target, state.sessions); }
      catch (error) { diagnostic = `Accepted portfolio unavailable: ${String(error?.message || error)}`; }
      let product = null;
      try { product = readAcceptedProduct(repository); }
      catch (error) { diagnostic = [diagnostic, `Accepted product unavailable: ${String(error?.message || error)}`].filter(Boolean).join(' '); }
      let runs = [];
      try { runs = runOrchestration.list(target, { sessions: state.sessions }); }
      catch (error) { diagnostic = [diagnostic, `Run history unavailable: ${String(error?.message || error)}`].filter(Boolean).join(' '); }
      return { portfolio, product, runs, diagnostic };
    },
  });
  const learning = learningStore || new LearningProposalStore({ root: join(root, 'learning') });
  const planning = planningRuntime || new PlanningRuntime({
    root: join(root, 'planning'),
    adapters: [createCodexPlanningAdapter(), createClaudePlanningDeclaration()],
  });
  const accessSnapshot = () => {
    const access = remoteAccessOptions({
      listener: server.address(),
      publicUrl: pairingOrigin,
      ...(networkInterfaceSnapshot ? {
        interfaces: typeof networkInterfaceSnapshot === 'function' ? networkInterfaceSnapshot() : networkInterfaceSnapshot,
      } : {}),
    });
    const managedTunnel = internetTunnel.snapshot();
    return {
      ...access,
      internet: {
        ...access.internet,
        ready: managedTunnel.status === 'ready' || access.internet.ready,
        url: managedTunnel.status === 'ready' ? managedTunnel.publicUrl : access.internet.url,
        guidance: managedTunnel.status === 'ready'
          ? 'The managed temporary HTTPS tunnel is live. Keep it running while remote clients use this origin.'
          : managedTunnel.installed
            ? 'The server-host client can explicitly create a temporary public HTTPS tunnel, or use an existing HTTPS origin.'
            : access.internet.guidance,
        managedTunnel,
      },
    };
  };
  // Direct loopback is the request identity even when the browser happens to
  // retain an older pairing cookie. A cookie must never downgrade this client
  // into a persisted/revocable device.
  const authenticateRequest = (request) => implicitLocalClient(request) || auth.authenticate(request.headers.cookie);

  const fleetSnapshot = () => {
    const state = snapshot({ root });
    const repositories = new Map(config.read().repositories.map((repository) => [repository.id, {
      ...repository, adapter: detectAdapter(repository.path),
    }]));
    state.sessions = state.sessions.map((session) => {
      const repository = repositories.get(session.repoId);
      if (!repository || !session.cwd) return { ...session, git: null };
      try { return { ...session, git: gitState(repository, session.cwd, session.front || session.slug) }; }
      catch (error) { return { ...session, git: { available: false, path: session.cwd, reason: String(error.message || error) } }; }
    });
    history.observe(state.sessions);
    return state;
  };

  const componentDesignContext = (repository, {
    analysisJobId, planningJobId = null, includeProduct = true,
  } = {}) => {
    if (!analysisJobId) throw new ComponentDesignError('COMPONENT_DESIGN_ANALYSIS_REQUIRED', 'a completed analysis snapshot is required');
    const target = { ...repository, adapter: detectAdapter(repository.path) };
    const analysisSnapshot = analyses.snapshot(repository.id, String(analysisJobId));
    const map = systemMaps.build(analysisSnapshot);
    let product = null;
    if (includeProduct) {
      const accepted = readAcceptedProduct(repository);
      product = accepted.exists && accepted.brief ? accepted : null;
    }
    let portfolio = { components: [], fronts: [] };
    try {
      const current = repositoryPortfolio(target, fleetSnapshot().sessions);
      portfolio = { components: current.components, fronts: current.fronts };
    } catch { /* an unavailable/uninitialized accepted portfolio remains an explicit empty baseline */ }
    let planningResult = null;
    let modelEvidenceIds = [];
    if (planningJobId) {
      const job = planning.status(repository.id, String(planningJobId));
      if (job.operation !== 'component-design') {
        throw new ComponentDesignError('COMPONENT_DESIGN_MODEL_MISMATCH', 'the selected planning job is not a component-design job');
      }
      if (job.state !== 'complete' || !job.resultAvailable) {
        throw new ComponentDesignError('COMPONENT_DESIGN_MODEL_UNAVAILABLE', 'the selected component-design planning result is not complete');
      }
      planningResult = planning.result(repository.id, String(planningJobId));
      modelEvidenceIds = [...new Set([
        ...(planningResult.components || []).flatMap((item) => item.evidenceIds || []),
        ...(planningResult.fronts || []).flatMap((item) => item.evidenceIds || []),
        ...(planningResult.findings || []).flatMap((item) => item.evidenceIds || []),
      ])];
    }
    return {
      analysisJobId: String(analysisJobId), planningJobId: planningJobId ? String(planningJobId) : null,
      snapshot: analysisSnapshot, map, product, portfolio, planningResult, modelEvidenceIds,
    };
  };

  const resolveComponentDesignContext = (repository, draftId) => {
    const source = componentDesigns.source(repository.id, draftId);
    try {
      return {
        context: componentDesignContext(repository, {
          analysisJobId: source.analysisJobId,
          planningJobId: source.modelIncluded ? source.planningJobId : null,
          includeProduct: source.productIncluded,
        }),
        unavailableReason: null,
      };
    } catch (error) {
      if (source.planningJobId) {
        try {
          return {
            context: componentDesignContext(repository, {
              analysisJobId: source.analysisJobId, planningJobId: null, includeProduct: source.productIncluded,
            }),
            unavailableReason: `The model planning source is unavailable: ${String(error?.message || error)}`,
          };
        } catch { /* the analysis source is unavailable too */ }
      }
      return { context: null, unavailableReason: `The original design source is unavailable: ${String(error?.message || error)}` };
    }
  };

  const frontDesignContext = (repository, {
    componentDraftId, componentAlternativeId = null, goalId = null, goal = null,
    planningJobId = null, includeProduct = true,
  } = {}) => {
    if (!componentDraftId) throw new FrontDesignError('FRONT_COMPONENT_DRAFT_REQUIRED', 'a reviewed private component architecture is required');
    const resolvedComponent = resolveComponentDesignContext(repository, String(componentDraftId));
    if (!resolvedComponent.context) {
      throw new FrontDesignError('FRONT_DESIGN_SOURCE_UNAVAILABLE', resolvedComponent.unavailableReason || 'the component architecture source is unavailable');
    }
    const componentDraft = componentDesigns.get(repository.id, String(componentDraftId), resolvedComponent);
    const componentSource = componentDesigns.source(repository.id, String(componentDraftId));
    let product = null;
    if (includeProduct) {
      const accepted = readAcceptedProduct(repository);
      product = accepted.exists && accepted.brief ? accepted : null;
    }
    let portfolio = { components: [], fronts: [] };
    try {
      const current = repositoryPortfolio({ ...repository, adapter: detectAdapter(repository.path) }, fleetSnapshot().sessions);
      portfolio = { components: current.components, fronts: current.fronts };
    } catch { /* unavailable/uninitialized accepted contracts remain an explicit empty baseline */ }
    let planningResult = null;
    let modelEvidenceIds = [];
    if (planningJobId) {
      const job = planning.status(repository.id, String(planningJobId));
      if (job.operation !== 'front-design') throw new FrontDesignError('FRONT_DESIGN_MODEL_MISMATCH', 'the selected planning job is not a front-design job');
      if (job.state !== 'complete' || !job.resultAvailable) throw new FrontDesignError('FRONT_DESIGN_MODEL_UNAVAILABLE', 'the selected front-design planning result is not complete');
      planningResult = planning.result(repository.id, String(planningJobId));
      modelEvidenceIds = [...new Set([
        ...(planningResult.components || []).flatMap((item) => item.evidenceIds || []),
        ...(planningResult.fronts || []).flatMap((item) => item.evidenceIds || []),
        ...(planningResult.findings || []).flatMap((item) => item.evidenceIds || []),
      ])];
    }
    return {
      analysisJobId: componentSource.analysisJobId,
      planningJobId: planningJobId ? String(planningJobId) : null,
      snapshot: resolvedComponent.context.snapshot,
      map: resolvedComponent.context.map,
      componentDraft,
      componentAlternativeId: componentAlternativeId || componentDraft.selectedAlternativeId,
      product,
      goalId: goalId ? String(goalId) : null,
      goal,
      portfolio,
      planningResult,
      modelEvidenceIds,
    };
  };

  const resolveFrontDesignContext = (repository, draftId) => {
    const source = frontDesigns.source(repository.id, draftId);
    try {
      return {
        context: frontDesignContext(repository, {
          componentDraftId: source.componentDraftId,
          componentAlternativeId: source.componentAlternativeId,
          goalId: source.goalId,
          goal: source.goal,
          planningJobId: source.modelIncluded ? source.planningJobId : null,
          includeProduct: source.productIncluded,
        }),
        unavailableReason: null,
      };
    } catch (error) {
      if (source.planningJobId) {
        try {
          return {
            context: frontDesignContext(repository, {
              componentDraftId: source.componentDraftId,
              componentAlternativeId: source.componentAlternativeId,
              goalId: source.goalId,
              goal: source.goal,
              planningJobId: null,
              includeProduct: source.productIncluded,
            }),
            unavailableReason: `The model planning source is unavailable: ${String(error?.message || error)}`,
          };
        } catch { /* a required non-model source is unavailable too */ }
      }
      return { context: null, unavailableReason: `The original front-planning source is unavailable: ${String(error?.message || error)}` };
    }
  };

  const publicationWorkspace = (repository, {
    componentDraftId, componentAlternativeId = null, frontDraftId = null, frontAlternativeId = null,
    productDraftId = null,
  } = {}) => {
    if (!componentDraftId) throw new PlanPublicationError('COMPONENT_PUBLICATION_SOURCE_INVALID', 'choose one reviewed component architecture before publication');
    const resolvedComponent = resolveComponentDesignContext(repository, String(componentDraftId));
    if (!resolvedComponent.context) throw new PlanPublicationError('PUBLICATION_SOURCE_UNAVAILABLE', resolvedComponent.unavailableReason || 'the reviewed component source is unavailable');
    const componentDraft = componentDesigns.get(repository.id, String(componentDraftId), resolvedComponent);
    let frontDraft = null;
    if (frontDraftId) {
      const resolvedFront = resolveFrontDesignContext(repository, String(frontDraftId));
      if (!resolvedFront.context) throw new PlanPublicationError('PUBLICATION_SOURCE_UNAVAILABLE', resolvedFront.unavailableReason || 'the reviewed front-plan source is unavailable');
      frontDraft = frontDesigns.get(repository.id, String(frontDraftId), resolvedFront);
    }
    const productDraft = productDraftId ? productDirections.get(repository, String(productDraftId)) : null;
    return {
      snapshot: resolvedComponent.context.snapshot,
      componentDraft,
      componentAlternativeId: componentAlternativeId ? String(componentAlternativeId) : componentDraft.selectedAlternativeId,
      frontDraft,
      frontAlternativeId: frontAlternativeId ? String(frontAlternativeId) : frontDraft?.selectedAlternativeId || null,
      productDraft,
    };
  };

  const runOptions = (repository, {
    frontSlug, agent, model, effort, isolate = true, resumeRunId = null,
  }, actor) => {
    const state = fleetSnapshot();
    const settings = config.snapshot();
    const selectedAgent = String(agent || repository.defaultAgent || (settings.agents.claude?.enabled ? 'claude' : 'codex'));
    const integration = settings.agents[selectedAgent];
    if (!integration) throw new RunOrchestrationError('RUN_AGENT_NOT_FOUND', `agent integration '${selectedAgent}' was not found`);
    const target = { ...repository, adapter: detectAdapter(repository.path) };
    let workshop = { worktrees: [], orphans: [] };
    try { workshop = inspectRunWorkshop(target, state.sessions); } catch (error) { workshop = { worktrees: [], orphans: [], error: String(error?.message || error) }; }
    let repositoryGit = { available: false, path: repository.path, reason: 'Git state is unavailable.' };
    try { repositoryGit = inspectRunGitState(target, repository.path); } catch (error) { repositoryGit = { available: false, path: repository.path, reason: String(error?.message || error) }; }
    let runs = []; let adHocRunRecords = []; let runStoreError = null;
    try { runs = runOrchestration.list(target, { sessions: state.sessions }); } catch (error) { runStoreError = String(error?.message || error); }
    try { adHocRunRecords = adHocRuns.list(target, { sessions: state.sessions }); }
    catch (error) { runStoreError = [runStoreError, String(error?.message || error)].filter(Boolean).join(' '); }
    const latestJob = analyses.list(repository.id).filter((job) => job.state === 'complete' || job.state === 'stale')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
    let resumeContext = null;
    if (resumeRunId) {
      const previous = runOrchestration.get(target, String(resumeRunId), { sessions: state.sessions });
      if (previous.manifest.front.slug !== frontSlug) throw new RunOrchestrationError('RUN_RESUME_MISMATCH', 'the selected handoff belongs to a different front');
      const handoff = previous.handoffs.at(-1);
      if (!handoff) throw new RunOrchestrationError('RUN_HANDOFF_REQUIRED', 'the previous run has no reviewed handoff to resume');
      resumeContext = { runId: previous.id, handoffRevision: handoff.revision, handoff };
    }
    return {
      actor, agent: selectedAgent,
      model: String(model || repository.model || integration.model || ''),
      effort: String(effort || repository.effort || integration.effort || ''),
      isolate: isolate !== false,
      agentIntegration: { id: selectedAgent, ...integration }, sessions: state.sessions,
      sessionsAfter: () => fleetSnapshot().sessions,
      runs, adHocRuns: adHocRunRecords, runStoreError, workshop, repositoryGit,
      latestAnalysis: latestJob ? { snapshotId: latestJob.snapshotId, freshness: latestJob.snapshotFreshness, state: latestJob.state } : null,
      resume: resumeContext,
    };
  };

  const adHocOptions = (repository, payload, actor) => {
    const base = runOptions(repository, { ...payload, frontSlug: '', resumeRunId: null }, actor);
    return { ...base, plannedRuns: base.runs, adHocRuns: base.adHocRuns };
  };

  const learningContext = (repository) => {
    const target = { ...repository, adapter: detectAdapter(repository.path) };
    const sessions = fleetSnapshot().sessions;
    let portfolio = { components: [], fronts: [] };
    try { portfolio = repositoryPortfolio(target, sessions); } catch { /* surfaced as proposals with missing/stale targets */ }
    let product = null;
    try { product = readAcceptedProduct(repository); } catch { /* optional accepted product context */ }
    let runs = [];
    try { runs = runOrchestration.list(target, { sessions }); } catch { /* explicit refresh summary remains available */ }
    let findings = [];
    try { findings = reconciliations.findings(target); } catch { /* reconciliation may not have a baseline yet */ }
    return { portfolio: { ...portfolio, product }, product, runs, findings };
  };

  const appendLearningValue = (current, change) => {
    if (change.operation === 'review') return current;
    if (change.operation !== 'append') return cloneJson(change.proposedValue);
    if (Array.isArray(current)) {
      const additions = Array.isArray(change.proposedValue) ? change.proposedValue : [change.proposedValue];
      const seen = new Set();
      return [...current, ...additions].filter((item) => {
        const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true;
      });
    }
    return `${String(current || '').trim()}${current ? '\n\n' : ''}${String(change.proposedValue || '').trim()}`;
  };

  const learningComponentDraft = (repository, target, proposal) => {
    const latest = analyses.list(repository.id).filter((job) => job.state === 'complete' && job.snapshotId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!latest) throw new LearningError('LEARNING_ANALYSIS_REQUIRED', 'create a current read-only analysis before routing this proposal into component/front design');
    const context = componentDesignContext(repository, { analysisJobId: latest.id, planningJobId: null, includeProduct: true });
    let draft = componentDesigns.create(target, context, { includeModel: false });
    const existing = draft.alternatives.find((item) => item.strategy === 'existing');
    if (existing && draft.selectedAlternativeId !== existing.id) {
      draft = componentDesigns.apply(repository.id, draft.id, { operation: 'select-alternative', alternativeId: existing.id, expectedRevision: draft.revision }, { context });
    }
    if (proposal?.target.kind === 'component') {
      const alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
      const component = alternative?.components.find((item) => item.slug === proposal.target.id);
      if (!component) throw new LearningError('LEARNING_DRAFT_TARGET_UNAVAILABLE', `component '${proposal.target.id}' is not present in the validated current architecture draft`);
      const contract = {};
      for (const change of proposal.changes.filter((item) => item.field !== 'new-front' && item.operation !== 'review')) {
        if (component.contract[change.field] !== undefined) contract[change.field] = appendLearningValue(component.contract[change.field], change);
      }
      if (Object.keys(contract).length) {
        draft = componentDesigns.apply(repository.id, draft.id, {
          operation: 'edit-component', alternativeId: alternative.id, componentId: component.id,
          updates: { contract }, expectedRevision: draft.revision,
        }, { context });
      }
    }
    return { context, draft };
  };

  const routeLearningProposal = (repository, target, proposal) => {
    if (proposal.target.kind === 'product-assumption') {
      let draft = productDirections.create(repository, { reset: true });
      const additions = proposal.changes.filter((item) => item.field === 'assumptions' && item.operation === 'append').flatMap((item) => item.proposedValue || []);
      if (additions.length) draft = productDirections.update(repository, draft.id, { brief: { ...draft.brief, assumptions: appendLearningValue(draft.brief.assumptions || [], { operation: 'append', proposedValue: additions }) } });
      return { kind: 'product-direction', draftId: draft.id, draftRevision: sha256Json(draft.brief), validated: true, publicationRequired: true };
    }
    const componentWorkspace = learningComponentDraft(repository, target, proposal.target.kind === 'component' ? proposal : null);
    if (proposal.target.kind === 'component') return {
      kind: 'component-design', draftId: componentWorkspace.draft.id, draftRevision: componentWorkspace.draft.revision,
      validated: true, publicationRequired: true,
    };
    const acceptedProduct = readAcceptedProduct(repository);
    const acceptedGoals = acceptedProduct.brief?.goals || [];
    const acceptedFront = (() => { try { return repositoryPortfolio(target).fronts.find((item) => item.contract.slug === proposal.target.id)?.contract || null; } catch { return null; } })();
    const goalId = [...(proposal.affected.goals || []), ...(acceptedFront?.goalIds || [])].find((id) => acceptedGoals.some((goal) => goal.id === id)) || acceptedGoals[0]?.id || null;
    const manualGoal = goalId ? null : { id: `goal:manual-learning-${proposal.identity.slice(0, 16)}`, title: `Review ${proposal.summary}`, outcome: proposal.summary, successSignals: ['A human reviews the proposal against its exact evidence and affected contracts.'] };
    const frontContext = frontDesignContext(repository, {
      componentDraftId: componentWorkspace.draft.id, componentAlternativeId: componentWorkspace.draft.selectedAlternativeId,
      goalId, goal: manualGoal, planningJobId: null, includeProduct: Boolean(goalId),
    });
    let draft = frontDesigns.create(target, frontContext, { includeModel: false });
    const existing = draft.alternatives.find((item) => item.strategy === 'existing');
    if (existing && draft.selectedAlternativeId !== existing.id) draft = frontDesigns.apply(repository.id, draft.id, { operation: 'select-alternative', alternativeId: existing.id, expectedRevision: draft.revision }, { context: frontContext });
    const alternative = draft.alternatives.find((item) => item.id === draft.selectedAlternativeId);
    if (proposal.target.kind === 'front') {
      const front = alternative?.fronts.find((item) => item.slug === proposal.target.id);
      if (!front) throw new LearningError('LEARNING_DRAFT_TARGET_UNAVAILABLE', `front '${proposal.target.id}' is not present in the validated current front draft`);
      const updates = {};
      for (const change of proposal.changes.filter((item) => item.operation !== 'review')) if (front[change.field] !== undefined) updates[change.field] = appendLearningValue(front[change.field], change);
      if (Object.keys(updates).length) draft = frontDesigns.apply(repository.id, draft.id, { operation: 'edit-front', alternativeId: alternative.id, frontId: front.id, updates, expectedRevision: draft.revision }, { context: frontContext });
    } else {
      const snapshotId = frontContext.snapshot.id; const effectiveGoalId = goalId || manualGoal.id; const lead = proposal.target.leadComponent || componentWorkspace.draft.alternatives.find((item) => item.id === componentWorkspace.draft.selectedAlternativeId)?.components[0]?.slug;
      if (!lead) throw new LearningError('LEARNING_DRAFT_TARGET_UNAVAILABLE', 'a new front proposal needs one reviewed lead component');
      const proposed = proposal.changes.find((item) => item.field === 'new-front')?.proposedValue || {};
      const grounding = Object.fromEntries(['outcome', 'leadComponent', 'affectedComponents', 'motivation', 'scope', 'nonGoals', 'dependencies', 'readiness', 'acceptanceCriteria', 'verification', 'deliverables', 'risks', 'unknowns', 'evidence', 'tasks', 'context', 'handoff'].map((field) => [field, { evidenceIds: [snapshotId], goalIds: [effectiveGoalId], componentSlugs: [lead], assumptions: [`Learning proposal ${proposal.id} requires human review of ${field}.`], questions: [] }]));
      draft = frontDesigns.apply(repository.id, draft.id, {
        operation: 'add-front', alternativeId: alternative.id, expectedRevision: draft.revision,
        front: {
          slug: proposal.target.id, title: proposed.title || `Review ${proposal.cause.kind}`, candidateKind: 'decision', leadComponent: lead, affectedComponents: [],
          goalIds: [effectiveGoalId], analysisSnapshot: snapshotId, outcome: proposed.outcome || proposal.summary,
          motivation: proposal.detail || 'Observed or inferred architecture drift needs an explicit reviewed outcome.', scope: 'Review the cited change, decide ownership and publish only the accepted result.',
          nonGoals: ['No accepted contract changes directly from this proposal.'], dependencies: [], readiness: ['Exact evidence and affected contracts are available for review.'],
          acceptanceCriteria: ['A human records the ownership/boundary decision and its affected contracts.'], verification: ['Re-run analysis and reconciliation after any published change.'],
          deliverables: ['A reviewed decision or bounded implementation front.'], risks: ['The inferred target may be incomplete or incorrect.'], unknowns: ['The final owner remains a human decision.'],
          evidence: [{ kind: 'inferred', reference: snapshotId, reason: `Learning proposal ${proposal.id} is routed against this immutable analysis snapshot.` }],
          tasks: [{ state: 'open', text: 'Review the exact finding and alternatives.' }, { state: 'open', text: 'Choose one lead owner and bounded outcome.' }, { state: 'open', text: 'Prepare the explicit publication diff.' }],
          context: proposal.summary, handoff: 'Do not allocate an agent until this draft is reviewed and transactionally published.', fieldGrounding: grounding,
        },
      }, { context: frontContext });
    }
    return {
      kind: 'front-design', draftId: draft.id, draftRevision: draft.revision, componentDraftId: componentWorkspace.draft.id,
      componentDraftRevision: componentWorkspace.draft.revision, validated: true, publicationRequired: true,
    };
  };

  // A process may have died after one durable rename but before rollback or
  // final acknowledgement. Recovery is safe only for our sealed publication
  // journals; unrelated/native locks are left untouched and surfaced as busy.
  let recoveryRepositories = [];
  try { recoveryRepositories = config.read().repositories; } catch { /* readiness reports an unreadable configuration */ }
  for (const repository of recoveryRepositories) {
    const target = { ...repository, adapter: detectAdapter(repository.path) };
    if (target.adapter !== 'handraise') continue;
    try { publications.recover(target); } catch { /* retry explicitly when the active owner releases its lock */ }
  }

  const push = () => {
    const payload = `data: ${JSON.stringify(fleetSnapshot())}\n\n`;
    for (const client of clients) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
  };

  // Two triggers, and both are needed. The watchers make a permission request
  // appear the instant the hook writes it — waiting up to two seconds to be told
  // you are blocking an agent is exactly the delay this tool exists to remove.
  // The interval covers what no file announces: a pane going quiet, an agent
  // finishing, a session being killed from another terminal.
  const watchers = ['attention', 'permissions'].map((name) => {
    try { return watch(join(root, name), () => push()); } catch { return null; }
  }).filter(Boolean);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json(response, 200, {
          ok: true,
          service: 'handraise-server',
          at: new Date().toISOString(),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/readiness') {
        const readiness = readinessSnapshot(root, config);
        return json(response, readiness.ready ? 200 : 503, readiness.ready
          ? readiness
          : { ...readiness, error: 'Handraise server is available but not ready; run handraise doctor on the server host.' });
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/status') {
        const device = authenticateRequest(request);
        return json(response, 200, {
          authenticated: Boolean(device),
          needsSetup: !auth.hasDevices(),
          implicitLocal: Boolean(device?.implicit),
          device,
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/pair') {
        if (!sameOrigin(request)) return json(response, 403, { error: 'cross-origin pairing is not allowed' });
        const localDevice = implicitLocalClient(request);
        if (localDevice) {
          return json(response, 200, {
            authenticated: true,
            implicitLocal: true,
            paired: false,
            device: localDevice,
          }, { 'set-cookie': auth.clearCookie({ secure: secureRequest(request) }) });
        }
        const payload = await body(request);
        const result = auth.pair(payload.token || payload.code, payload.name);
        return json(response, 200, { authenticated: true, device: result.device }, {
          'set-cookie': auth.cookie(result.token, { secure: secureRequest(request) }),
        });
      }

      const device = authenticateRequest(request);
      if (url.pathname.startsWith('/api/') && !device) {
        return json(response, 401, { error: 'pair this device with Handraise first' });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
        return json(response, 403, { error: 'cross-origin request blocked' });
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        return json(response, 200, {
          ok: true,
          remainsAuthenticated: Boolean(device.implicit),
          device: device.implicit ? device : null,
        }, {
          'set-cookie': auth.clearCookie({ secure: secureRequest(request) }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/devices') {
        const pairedDevices = auth.devices().map((pairedDevice) => ({
          ...pairedDevice, implicit: false, revocable: true,
        }));
        return json(response, 200, {
          devices: device.implicit ? [device, ...pairedDevices] : pairedDevices,
          currentDeviceId: device.id,
          implicitLocal: Boolean(device.implicit),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/remote-access') {
        const access = accessSnapshot();
        access.internet.managedTunnel.canManage = Boolean(device.implicit);
        return json(response, 200, access);
      }

      if (url.pathname === '/api/auth/internet-tunnel') {
        if (request.method === 'GET') {
          return json(response, 200, { ...internetTunnel.snapshot(), canManage: Boolean(device.implicit) });
        }
        if (!device.implicit) {
          return json(response, 403, { error: 'only the implicit server-host client can manage public Internet exposure' });
        }
        if (request.method === 'POST') {
          return json(response, 200, {
            ...await internetTunnel.start({ target: localTunnelTarget(server.address()) }), canManage: true,
          });
        }
        if (request.method === 'DELETE') {
          return json(response, 200, { ...await internetTunnel.stop(), canManage: true });
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/pairing') {
        const payload = await body(request);
        const mode = payload.mode ? String(payload.mode) : null;
        const tunnel = internetTunnel.snapshot();
        const selectedPublicUrl = payload.managed
          ? tunnel.status === 'ready' && tunnel.publicUrl
            ? tunnel.publicUrl
            : null
          : payload.publicUrl ? String(payload.publicUrl) : pairingOrigin;
        if (payload.managed && !selectedPublicUrl) throw new Error('the managed Internet tunnel is not ready');
        const origin = mode
          ? pairingOriginFor(accessSnapshot(), {
            mode,
            address: payload.address ? String(payload.address) : null,
            publicUrl: selectedPublicUrl,
            currentOrigin: requestOrigin(request),
          })
          : pairingOrigin || requestOrigin(request);
        const pairing = auth.startPairing();
        const pairUrl = new URL('/', origin);
        pairUrl.searchParams.set('pair', pairing.token);
        const qr = await QRCode.toDataURL(pairUrl.toString(), {
          width: 320, margin: 1,
          color: { dark: '#171714', light: '#f1eee5' },
        });
        return json(response, 200, {
          code: pairing.code,
          expiresAt: pairing.expiresAt,
          qr,
          url: pairUrl.toString(),
          mode: mode || 'current',
          origin,
        });
      }

      if (request.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'auth' && parts[2] === 'devices' && parts[3]) {
        if (parts[3] === LOCAL_CLIENT_ID) {
          return json(response, 400, { error: 'the implicit server-host client cannot be revoked' });
        }
        const result = auth.revoke(parts[3], { allowFinal: Boolean(device.implicit) });
        const headers = parts[3] === device.id
          ? { 'set-cookie': auth.clearCookie({ secure: secureRequest(request) }) }
          : {};
        return json(response, 200, result, headers);
      }

      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return json(response, 200, { ...config.snapshot(), quality: qualityBenchmarkStatus() });
      }

      if (request.method === 'POST' && url.pathname === '/api/settings/hooks/repair') {
        if (!device.implicit) {
          return json(response, 403, { error: 'only the implicit server-host client can repair agent hooks' });
        }
        const hooks = repairAgentHooks({ root, home: config.home });
        push();
        return json(response, 200, {
          hooks,
          message: 'Claude Code and Codex hooks were repaired. Codex still requires its explicit /hooks trust review.',
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/history') {
        const events = readHistory(root, {
          limit: Math.min(2_000, Math.max(1, Number(url.searchParams.get('limit')) || 500)),
          repoId: url.searchParams.get('repoId'),
        });
        return json(response, 200, { events, outcomes: historyOutcomes(events), summary: historySummary(events) });
      }

      if (request.method === 'GET' && url.pathname === '/api/analysis/analyzers') {
        return json(response, 200, { analyzers: await analyses.analyzers() });
      }

      if (request.method === 'GET' && url.pathname === '/api/planning/adapters') {
        return json(response, 200, { adapters: await planning.catalog() });
      }

      if (request.method === 'PATCH' && url.pathname === '/api/settings/agents') {
        return json(response, 200, config.updateAgents(await body(request)));
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'agents' && parts[2] && parts[3] === 'connect' && !parts[4]) {
        const agentId = String(parts[2]);
        let command;
        try { command = agentAuthInvocation(agentId, 'login'); }
        catch { return json(response, 404, { error: 'agent integration not found' }); }
        const integration = config.snapshot().agents[agentId];
        if (!integration?.installed) {
          return json(response, 409, { error: `${integration?.title || agentId} is not installed on the server host` });
        }
        if (integration.auth.connected) {
          return json(response, 200, {
            agent: agentId, connected: true, existed: true, controlSlug: null,
            message: `${integration.title} is already connected`,
          });
        }
        const result = launchSession({
          slug: `setup-${agentId}-account`,
          cwd: homedir(),
          command,
          agent: agentId,
          role: 'setup',
        });
        push();
        return json(response, 200, {
          ...result,
          agent: agentId,
          connected: false,
          role: 'setup',
          message: `Complete ${integration.title} sign-in in the setup terminal. Handraise will re-check the CLI-owned account automatically.`,
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/repositories') {
        const repositories = config.read().repositories.map((repository) => ({
          ...repository, adapter: detectAdapter(repository.path),
        }));
        const state = fleetSnapshot();
        const portfolio = repositoriesSnapshot({ repositories }, state.sessions);
        for (const repository of portfolio) {
          try { repository.workshop = workshopSnapshot(repository, state.sessions); }
          catch (error) { repository.workshop = { worktrees: [], orphans: [], error: String(error.message || error) }; }
          try { repository.runs = runOrchestration.list(repository, { sessions: state.sessions }); }
          catch (error) { repository.runs = []; repository.runError = String(error?.message || error); }
          try { repository.reconciliation = reconciliations.summary(repository); }
          catch (error) { repository.reconciliation = null; repository.reconciliationError = String(error?.message || error); }
          try { repository.releases = releases.list(repository); }
          catch (error) { repository.releases = []; repository.releaseError = String(error?.message || error); }
          try { repository.adHocRuns = adHocRuns.list(repository, { sessions: state.sessions }); }
          catch (error) { repository.adHocRuns = []; repository.adHocRunError = String(error?.message || error); }
        }
        return json(response, 200, { repositories: portfolio });
      }

      if (request.method === 'POST' && url.pathname === '/api/repositories') {
        const payload = await body(request);
        return json(response, 201, { repository: config.addRepository(payload.path, payload) });
      }

      if (request.method === 'POST' && url.pathname === '/api/repositories/pick-directory') {
        return json(response, 200, { path: await pickDirectory() });
      }

      if (request.method === 'POST' && url.pathname === '/api/repositories/browse-directory') {
        const payload = await body(request);
        return json(response, 200, browseDirectory(payload.path));
      }

      if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'worktrees' && !parts[4]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        return json(response, 200, workshopSnapshot({ ...repository, adapter: detectAdapter(repository.path) }, fleetSnapshot().sessions));
      }

      if (request.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'worktrees' && parts[4]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        return json(response, 200, removeWorktree({ ...repository, adapter: detectAdapter(repository.path) }, parts[4], { sessions: fleetSnapshot().sessions }));
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'analysis') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (request.method === 'POST' && parts[4] === 'plan' && !parts[5]) {
          const payload = await body(request);
          const plan = await analyses.plan(target, {
            analyzerId: payload.analyzerId,
            scope: payload.scope,
            consent: Boolean(payload.consent),
            hostAuthority: Boolean(device.implicit),
          });
          return json(response, 201, { plan });
        }
        if (parts[4] === 'jobs' && !parts[5]) {
          if (request.method === 'GET') return json(response, 200, {
            jobs: analyses.list(repository.id),
            reconciliationJobs: reconciliations.jobs(target),
          });
          if (request.method === 'POST') {
            const payload = await body(request);
            const baseline = analyses.list(repository.id).find((item) => item.snapshotId && ['complete', 'stale'].includes(item.state)) || null;
            const job = analyses.start(target, {
              planId: payload.planId,
              consent: Boolean(payload.consent),
              hostAuthority: Boolean(device.implicit),
            });
            let reconciliationJob = null;
            let reconciliationError = null;
            try {
              const pendingTrigger = reconciliations.triggers(target).find((item) => item.state === 'pending') || null;
              reconciliationJob = reconciliations.trackAnalysis(target, job, {
                fromJobId: baseline?.id || null,
                cause: payload.reconciliationCause || pendingTrigger?.cause || 'manual-refresh',
                sourceId: payload.reconciliationSourceId || pendingTrigger?.sourceId || null,
              });
            } catch (error) { reconciliationError = String(error?.message || error); }
            return json(response, 202, { job, reconciliationJob, reconciliationError });
          }
        }
        if (parts[4] === 'jobs' && parts[5]) {
          const jobId = decodeURIComponent(parts[5]);
          if (parts[6] === 'map') {
            const analysisSnapshot = analyses.snapshot(repository.id, jobId);
            if (request.method === 'GET' && !parts[7]) {
              const limit = url.searchParams.get('limit') || undefined;
              const lens = url.searchParams.get('lens') || undefined;
              return json(response, 200, {
                map: systemMaps.describe(analysisSnapshot),
                result: systemMaps.query(analysisSnapshot, { type: 'overview', limit, lens }),
              });
            }
            if (request.method === 'POST' && parts[7] === 'query' && !parts[8]) {
              const payload = await body(request);
              return json(response, 200, {
                map: systemMaps.describe(analysisSnapshot),
                result: systemMaps.query(analysisSnapshot, payload),
              });
            }
            if (request.method === 'GET' && parts[7] === 'compare' && !parts[8]) {
              const fromJobId = url.searchParams.get('fromJobId');
              if (!fromJobId) throw new IntelligenceError('MAP_COMPARE_SOURCE_REQUIRED', 'fromJobId is required to compare system maps');
              const fromSnapshot = analyses.snapshot(repository.id, fromJobId);
              return json(response, 200, { comparison: systemMaps.compare(fromSnapshot, analysisSnapshot) });
            }
            if (request.method === 'GET' && parts[7] === 'export' && !parts[8]) {
              return json(response, 200, {
                export: systemMaps.export(analysisSnapshot, {
                  format: url.searchParams.get('format') || 'markdown',
                }),
              });
            }
          }
          if (request.method === 'GET' && !parts[6]) return json(response, 200, { job: analyses.status(repository.id, jobId) });
          if (request.method === 'GET' && parts[6] === 'snapshot' && !parts[7]) return json(response, 200, { snapshot: analyses.snapshot(repository.id, jobId) });
          if (request.method === 'POST' && parts[6] === 'cancel' && !parts[7]) return json(response, 200, { job: analyses.cancel(repository.id, jobId) });
          if (request.method === 'DELETE' && !parts[6]) return json(response, 200, await analyses.delete(repository.id, jobId));
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'reconciliation') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (!parts[4] && request.method === 'GET') return json(response, 200, { reconciliation: reconciliations.summary(target) });
        if (parts[4] === 'compare' && !parts[5] && request.method === 'POST') {
          const payload = await body(request);
          return json(response, 201, { cycle: reconciliations.compare(target, {
            fromJobId: payload.fromJobId,
            toJobId: payload.toJobId,
            cause: payload.cause || 'manual-compare',
            sourceId: payload.sourceId || null,
          }) });
        }
        if (parts[4] === 'cycles') {
          if (!parts[5] && request.method === 'GET') return json(response, 200, { cycles: reconciliations.listCycles(target) });
          if (parts[5] && !parts[6] && request.method === 'GET') return json(response, 200, { cycle: reconciliations.cycle(target, decodeURIComponent(parts[5])) });
        }
        if (parts[4] === 'findings') {
          if (!parts[5] && request.method === 'GET') return json(response, 200, { findings: reconciliations.findings(target, {
            active: url.searchParams.has('active') ? url.searchParams.get('active') !== 'false' : null,
            disposition: url.searchParams.get('disposition'),
            severity: url.searchParams.get('severity'),
          }) });
          if (parts[5] && parts[6] === 'decision' && !parts[7] && request.method === 'POST') {
            const decision = reconciliations.decide(target, decodeURIComponent(parts[5]), await body(request), { actor: device });
            let learningSummary = null;
            if (decision.decision.state === 'accepted-for-planning') {
              try { learningSummary = learning.refresh(target, learningContext(repository)); } catch { /* decision remains authoritative; learning is private derived state */ }
            }
            return json(response, 200, { ...decision, learning: learningSummary });
          }
        }
        if (parts[4] === 'triggers' && !parts[5] && request.method === 'GET') return json(response, 200, { triggers: reconciliations.triggers(target) });
        if (parts[4] === 'jobs') {
          if (!parts[5] && request.method === 'GET') return json(response, 200, { jobs: reconciliations.jobs(target) });
          const reconciliationJobId = decodeURIComponent(parts[5] || '');
          if (parts[5] && !parts[6] && request.method === 'GET') return json(response, 200, { job: reconciliations.observeJob(target, reconciliationJobId) });
          if (parts[5] && parts[6] === 'cancel' && !parts[7] && request.method === 'POST') return json(response, 200, { job: reconciliations.cancel(target, reconciliationJobId) });
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'learning') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (!parts[4]) {
          if (request.method === 'GET') return json(response, 200, { summary: learning.summary(target), proposals: learning.list(target), feedback: learning.feedbackList(target) });
          if (request.method === 'POST') return json(response, 200, { summary: learning.refresh(target, learningContext(repository)), proposals: learning.list(target) });
        }
        if (parts[4] === 'proposals' && parts[5]) {
          const proposalId = decodeURIComponent(parts[5]);
          if (!parts[6] && request.method === 'GET') return json(response, 200, { proposal: learning.get(target, proposalId) });
          if (!parts[6] && request.method === 'DELETE') return json(response, 200, learning.deleteProposal(target, proposalId));
          if (parts[6] === 'decision' && !parts[7] && request.method === 'POST') return json(response, 200, { proposal: learning.decide(target, proposalId, await body(request), { actor: device }) });
          if (parts[6] === 'route' && !parts[7] && request.method === 'POST') {
            const payload = await body(request);
            return json(response, 201, learning.route(target, proposalId, payload, { actor: device, route: (proposal) => routeLearningProposal(repository, target, proposal) }));
          }
          if (parts[6] === 'feedback' && !parts[7] && request.method === 'POST') return json(response, 201, { feedback: learning.feedback(target, proposalId, await body(request), { actor: device }) });
        }
        if (parts[4] === 'feedback' && parts[5] && !parts[6] && request.method === 'DELETE') return json(response, 200, learning.deleteFeedback(target, decodeURIComponent(parts[5])));
        if (parts[4] === 'exports') {
          if (!device.implicit) return json(response, 403, { error: 'only the implicit server-host client can prepare or confirm an anonymized feedback export' });
          if (parts[5] === 'preview' && !parts[6] && request.method === 'POST') return json(response, 201, { preview: learning.previewExport(target, await body(request)) });
          if (parts[5] && parts[6] === 'confirm' && !parts[7] && request.method === 'POST') return json(response, 200, learning.confirmExport(target, decodeURIComponent(parts[5]), await body(request), { actor: device }));
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'planning') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (request.method === 'POST' && parts[4] === 'preflight' && !parts[5]) {
          const payload = await body(request);
          const analysisJobId = payload.analysisJobId ? String(payload.analysisJobId) : null;
          const analysisSnapshot = analysisJobId ? analyses.snapshot(repository.id, analysisJobId) : null;
          const acceptedProduct = payload.includeProduct === false ? null : readAcceptedProduct(repository);
          let portfolio = { components: [], fronts: [] };
          try {
            const current = repositoryPortfolio(target, fleetSnapshot().sessions);
            portfolio = { components: current.components, fronts: current.fronts };
          } catch { /* unavailable/uninitialized portfolio is represented honestly by an empty source */ }
          const preflight = await planning.preflight(target, {
            adapterId: payload.adapterId,
            operation: payload.operation,
            model: payload.model,
            snapshot: analysisSnapshot,
            product: acceptedProduct,
            portfolio,
            question: payload.question,
            graphQueries: payload.graphQueries,
            includeProduct: payload.includeProduct !== false,
            hostAuthority: Boolean(device.implicit),
          });
          return json(response, 201, { preflight });
        }
        if (parts[4] === 'jobs' && !parts[5]) {
          if (request.method === 'GET') return json(response, 200, { jobs: planning.list(repository.id) });
          if (request.method === 'POST') {
            const payload = await body(request);
            const job = planning.start(target, {
              preflightId: payload.preflightId,
              consent: payload.consent === true,
              hostAuthority: Boolean(device.implicit),
            });
            return json(response, 202, { job });
          }
        }
        if (parts[4] === 'jobs' && parts[5]) {
          const jobId = decodeURIComponent(parts[5]);
          if (request.method === 'GET' && !parts[6]) return json(response, 200, { job: planning.status(repository.id, jobId) });
          if (request.method === 'GET' && parts[6] === 'result' && !parts[7]) return json(response, 200, { result: planning.result(repository.id, jobId) });
          if (request.method === 'POST' && parts[6] === 'cancel' && !parts[7]) return json(response, 200, { job: planning.cancel(repository.id, jobId) });
          if (request.method === 'DELETE' && !parts[6]) return json(response, 200, await planning.delete(repository.id, jobId));
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'component-design'
        && parts[4] === 'drafts') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (!parts[5]) {
          if (request.method === 'GET') return json(response, 200, { drafts: componentDesigns.list(repository.id) });
          if (request.method === 'POST') {
            const payload = await body(request);
            const planningJobId = payload.includeModel === false ? null : payload.planningJobId;
            const context = componentDesignContext(repository, {
              analysisJobId: payload.analysisJobId,
              planningJobId,
              includeProduct: payload.includeProduct !== false,
            });
            const draft = componentDesigns.create(target, context, { includeModel: payload.includeModel !== false });
            return json(response, 201, { draft });
          }
        }
        const draftId = decodeURIComponent(parts[5]);
        if (!parts[6]) {
          if (request.method === 'GET') {
            const resolved = resolveComponentDesignContext(repository, draftId);
            return json(response, 200, {
              draft: componentDesigns.get(repository.id, draftId, resolved),
              contextWarning: resolved.unavailableReason,
            });
          }
          if (request.method === 'DELETE') return json(response, 200, componentDesigns.delete(repository.id, draftId));
        }
        if (request.method === 'GET' && parts[6] === 'compare' && !parts[7]) {
          return json(response, 200, {
            comparison: componentDesigns.compare(repository.id, draftId, url.searchParams.get('left'), url.searchParams.get('right')),
          });
        }
        if (request.method === 'POST' && parts[6] === 'operations' && !parts[7]) {
          const payload = await body(request);
          const resolved = resolveComponentDesignContext(repository, draftId);
          const source = componentDesigns.source(repository.id, draftId);
          if (payload.operation === 'regenerate' && payload.includeModel !== false && source.modelIncluded && resolved.unavailableReason) {
            throw new ComponentDesignError('COMPONENT_DESIGN_MODEL_UNAVAILABLE', 'the model planning source is unavailable; regenerate without the model or create a new planning result');
          }
          return json(response, 200, {
            draft: componentDesigns.apply(repository.id, draftId, payload, { context: resolved.context }),
            contextWarning: resolved.unavailableReason,
          });
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'front-design'
        && parts[4] === 'drafts') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (!parts[5]) {
          if (request.method === 'GET') return json(response, 200, { drafts: frontDesigns.list(repository.id) });
          if (request.method === 'POST') {
            const payload = await body(request);
            const planningJobId = payload.includeModel === false ? null : payload.planningJobId;
            const context = frontDesignContext(repository, {
              componentDraftId: payload.componentDraftId,
              componentAlternativeId: payload.componentAlternativeId,
              goalId: payload.goalId,
              goal: payload.goal,
              planningJobId,
              includeProduct: payload.includeProduct !== false,
            });
            const draft = frontDesigns.create(target, context, { includeModel: payload.includeModel !== false });
            return json(response, 201, { draft });
          }
        }
        const draftId = decodeURIComponent(parts[5]);
        if (!parts[6]) {
          if (request.method === 'GET') {
            const resolved = resolveFrontDesignContext(repository, draftId);
            return json(response, 200, {
              draft: frontDesigns.get(repository.id, draftId, resolved),
              contextWarning: resolved.unavailableReason,
            });
          }
          if (request.method === 'DELETE') return json(response, 200, frontDesigns.delete(repository.id, draftId));
        }
        if (request.method === 'GET' && parts[6] === 'compare' && !parts[7]) {
          return json(response, 200, {
            comparison: frontDesigns.compare(repository.id, draftId, url.searchParams.get('left'), url.searchParams.get('right')),
          });
        }
        if (request.method === 'POST' && parts[6] === 'operations' && !parts[7]) {
          const payload = await body(request);
          const resolved = resolveFrontDesignContext(repository, draftId);
          const source = frontDesigns.source(repository.id, draftId);
          if (payload.operation === 'regenerate' && payload.includeModel !== false && source.modelIncluded && resolved.unavailableReason) {
            throw new FrontDesignError('FRONT_DESIGN_MODEL_UNAVAILABLE', 'the model planning source is unavailable; regenerate without the model or create a new planning result');
          }
          return json(response, 200, {
            draft: frontDesigns.apply(repository.id, draftId, payload, { context: resolved.context }),
            contextWarning: resolved.unavailableReason,
          });
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'publications') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (!parts[4]) {
          if (request.method === 'GET') return json(response, 200, { publications: publications.list(target) });
          if (request.method === 'POST') {
            const payload = await body(request);
            const workspace = publicationWorkspace(repository, payload.sources || payload);
            const publication = publications.create(target, workspace, payload.selection || payload, { actor: device });
            return json(response, 201, { publication });
          }
        }
        if (request.method === 'POST' && parts[4] === 'recover' && !parts[5]) {
          if (!device.implicit) return json(response, 403, { error: 'only the server-host client can recover interrupted repository publication journals' });
          return json(response, 200, publications.recover(target));
        }
        const publicationId = decodeURIComponent(parts[4]);
        if (!parts[5]) {
          if (request.method === 'GET') return json(response, 200, { publication: publications.get(target, publicationId) });
          if (request.method === 'DELETE') return json(response, 200, publications.discard(target, publicationId));
        }
        if (request.method === 'POST' && parts[5] === 'commit' && !parts[6]) {
          const payload = await body(request);
          const publication = publications.get(target, publicationId);
          const sourceDescriptor = {
            componentDraftId: publication.source.componentDraftId,
            componentAlternativeId: publication.source.componentAlternativeId,
            frontDraftId: publication.source.frontDraftId,
            frontAlternativeId: publication.source.frontAlternativeId,
            productDraftId: publication.source.productDraftId,
          };
          const result = publications.commit(target, publicationId, {
            expectedRevision: payload.expectedRevision,
            confirmed: payload.confirmed === true,
            actor: device,
            sourceCheck: () => publicationSourceRevision(publicationWorkspace(repository, sourceDescriptor)),
          });
          let reconciliationTrigger = null;
          try {
            reconciliationTrigger = reconciliations.trigger(target, {
              cause: 'publication', sourceId: publicationId,
              message: 'Accepted planning was published. Refresh repository analysis explicitly to reconcile evidence and boundaries.',
            });
          } catch { /* publication is committed; trigger availability is reported by reconciliation state */ }
          return json(response, 201, {
            result,
            publication: publications.get({ ...repository, adapter: detectAdapter(repository.path) }, publicationId),
            reconciliationTrigger,
          });
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'ad-hoc-runs') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        const currentSessions = () => fleetSnapshot().sessions;
        if (!parts[4]) {
          if (request.method === 'GET') return json(response, 200, { runs: adHocRuns.list(target, { sessions: currentSessions() }) });
        }
        if (parts[4] === 'preflight') {
          if (!parts[5] && request.method === 'POST') {
            const payload = await body(request);
            const preflight = adHocRuns.prepare(target, payload, adHocOptions(repository, payload, device));
            return json(response, 201, { preflight });
          }
          const preflightId = decodeURIComponent(parts[5] || '');
          if (!parts[6] && request.method === 'GET') return json(response, 200, { preflight: adHocRuns.getPreflight(target, preflightId) });
          if (parts[6] === 'start' && !parts[7] && request.method === 'POST') {
            const payload = await body(request); const reviewed = adHocRuns.getPreflight(target, preflightId);
            const selection = {
              purpose: reviewed.work.purpose, componentSlug: reviewed.work.component?.slug || null,
              agent: reviewed.execution.agent, model: reviewed.execution.model, effort: reviewed.execution.effort,
              isolate: reviewed.execution.isolate,
            };
            const run = adHocRuns.start(target, preflightId, {
              expectedRevision: payload.expectedRevision, confirmed: payload.confirmed === true, actor: device,
              currentOptions: () => adHocOptions(repository, selection, device),
              createWorkspace: ({ preflight, execution }) => {
                if (execution.isolate) {
                  const workspace = createRunWorkspace(target, preflight.work.slug);
                  try {
                    const state = inspectRunGitState(target, workspace.path, preflight.work.slug);
                    return { ...workspace, revision: state.revision || state.baselineRevision || workspace.baseline || null };
                  } catch (error) {
                    if (workspace.created) { try { removeRunWorkspace(target, preflight.work.slug, { sessions: currentSessions() }); } catch { /* retained workspace is surfaced by readiness */ } }
                    throw error;
                  }
                }
                const state = inspectRunGitState(target, target.path);
                return { path: target.path, branch: state.branch || null, created: false, baseline: state.baseline || null, revision: state.revision || state.baselineRevision || state.baseline || null };
              },
              removeWorkspace: ({ work, workspace }) => {
                if (workspace.created) return removeRunWorkspace(target, work.slug, { sessions: currentSessions() });
                return null;
              },
              launch: ({ manifest, workspace, execution }) => {
                const invocation = agentInvocation(execution.agent, { model: execution.model, effort: execution.effort, prompt: manifest.context.prompt });
                const launched = launchSession({
                  slug: manifest.work.slug, cwd: workspace.path, command: invocation, agent: execution.agent,
                  repoId: repository.id, component: manifest.work.component?.slug || null, front: null,
                  runId: manifest.id, role: 'ad-hoc',
                });
                if (!launched.existed) {
                  const session = currentSessions().find((item) => item.controlSlug === launched.controlSlug);
                  if (session) history.started(session);
                }
                return { ...launched, slug: manifest.work.slug };
              },
            });
            push(); return json(response, 201, { run });
          }
        }
        const runId = decodeURIComponent(parts[4] || '');
        if (!parts[5] && request.method === 'GET') return json(response, 200, { run: adHocRuns.get(target, runId, { sessions: currentSessions() }) });
        if (parts[5] === 'restart' && !parts[6] && request.method === 'POST') {
          const payload = await body(request); const current = adHocRuns.get(target, runId, { sessions: currentSessions() });
          const selection = {
            purpose: current.manifest.work.purpose, componentSlug: current.manifest.work.component?.slug || null,
            agent: current.manifest.execution.agent, model: current.manifest.execution.model,
            effort: current.manifest.execution.effort, isolate: current.manifest.execution.isolate,
          };
          const run = adHocRuns.restart(target, runId, {
            expectedRevision: payload.expectedRevision, confirmed: payload.confirmed === true, actor: device,
            currentOptions: () => adHocOptions(repository, selection, device),
            inspectWorkspace: ({ manifest, workspace }) => inspectRunGitState(target, workspace.path, manifest.execution.isolate ? manifest.work.slug : ''),
            launch: ({ manifest, workspace, execution }) => {
              const invocation = agentInvocation(execution.agent, { model: execution.model, effort: execution.effort, prompt: manifest.context.prompt });
              const launched = launchSession({
                slug: manifest.work.slug, cwd: workspace.path, command: invocation, agent: execution.agent,
                repoId: repository.id, component: manifest.work.component?.slug || null, front: null,
                runId: manifest.id, role: 'ad-hoc',
              });
              if (!launched.existed) {
                const session = currentSessions().find((item) => item.controlSlug === launched.controlSlug);
                if (session) history.started(session);
              }
              return { ...launched, slug: manifest.work.slug };
            },
          });
          push(); return json(response, 200, { run });
        }
        if (parts[5] === 'discoveries' && !parts[6] && request.method === 'POST') {
          const payload = await body(request); const { expectedRevision, ...discovery } = payload;
          const run = adHocRuns.addDiscovery(target, runId, discovery, { actor: device, expectedRevision });
          push(); return json(response, 201, { run });
        }
        if (parts[5] === 'checks' && !parts[6] && request.method === 'POST') {
          const payload = await body(request); const { expectedRevision, ...check } = payload;
          if (check.source === 'configured-check') check.source = 'user-observed';
          const run = adHocRuns.recordCheck(target, runId, check, { actor: device, expectedRevision });
          return json(response, 201, { run });
        }
        if (parts[5] === 'handoff' && !parts[6] && request.method === 'POST') {
          const payload = await body(request); const { expectedRevision, ...handoff } = payload;
          const run = adHocRuns.handoff(target, runId, handoff, { actor: device, expectedRevision });
          push(); return json(response, 200, { run });
        }
        if (parts[5] === 'complete' && !parts[6] && request.method === 'POST') {
          const payload = await body(request); const current = adHocRuns.get(target, runId, { sessions: currentSessions() });
          const currentWorkspaceGit = () => {
            try { return inspectRunGitState(target, current.manifest.workspace.path, current.manifest.execution.isolate ? current.manifest.work.slug : ''); }
            catch (error) { return { available: false, path: current.manifest.workspace.path, reason: String(error?.message || error) }; }
          };
          const run = adHocRuns.complete(target, runId, {
            expectedRevision: payload.expectedRevision, status: payload.status, summary: payload.summary,
            actor: device, sessions: currentSessions, git: currentWorkspaceGit,
          });
          push(); return json(response, 200, { run });
        }
        if (parts[5] === 'promotions' && !parts[6] && request.method === 'POST') {
          const payload = await body(request); const { expectedRevision, ...proposal } = payload;
          const run = adHocRuns.proposePromotion(target, runId, proposal, { actor: device, expectedRevision });
          return json(response, 201, { run });
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'runs') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        const currentSessions = () => fleetSnapshot().sessions;
        const updateAcceptedFront = ({ componentSlug, frontSlug, expectedRevision, ...changes }) => {
          const front = updateFront(target, componentSlug, frontSlug, { ...changes, expectedRevision });
          return { front, revision: front.revision };
        };
        if (!parts[4]) {
          if (request.method === 'GET') return json(response, 200, { runs: runOrchestration.list(target, { sessions: currentSessions() }) });
        }
        if (parts[4] === 'preflight') {
          if (!parts[5] && request.method === 'POST') {
            const payload = await body(request); const frontSlug = String(payload.frontSlug || '');
            const preflight = runOrchestration.prepare(target, frontSlug, runOptions(repository, { ...payload, frontSlug }, device));
            return json(response, 201, { preflight });
          }
          const preflightId = decodeURIComponent(parts[5] || '');
          if (!parts[6] && request.method === 'GET') return json(response, 200, { preflight: runOrchestration.getPreflight(target, preflightId) });
          if (parts[6] === 'start' && !parts[7] && request.method === 'POST') {
            const payload = await body(request); const reviewed = runOrchestration.getPreflight(target, preflightId);
            const run = runOrchestration.start(target, preflightId, {
              expectedRevision: payload.expectedRevision, confirmed: payload.confirmed === true, actor: device,
              currentOptions: () => runOptions(repository, {
                frontSlug: reviewed.front.slug, agent: reviewed.execution.agent, model: reviewed.execution.model,
                effort: reviewed.execution.effort, isolate: reviewed.execution.isolate, resumeRunId: reviewed.resume?.runId || null,
              }, device),
              createWorkspace: ({ front, execution }) => {
                if (execution.isolate) {
                  const workspace = createRunWorkspace(target, front.slug);
                  try {
                    const state = inspectRunGitState(target, workspace.path, front.slug);
                    return { ...workspace, revision: state.revision || state.baselineRevision || workspace.baseline || null };
                  } catch (error) {
                    if (workspace.created) { try { removeRunWorkspace(target, front.slug, { sessions: currentSessions() }); } catch { /* retained worktree is surfaced by the next readiness review */ } }
                    throw error;
                  }
                }
                const state = inspectRunGitState(target, target.path);
                return { path: target.path, branch: state.branch || null, created: false, baseline: state.baseline || null, revision: state.revision || state.baselineRevision || state.baseline || null };
              },
              removeWorkspace: ({ front, workspace }) => {
                if (workspace.created) return removeRunWorkspace(target, front.slug, { sessions: currentSessions() });
                return null;
              },
              launch: ({ manifest, workspace, front, execution }) => {
                const invocation = agentInvocation(execution.agent, { model: execution.model, effort: execution.effort, prompt: manifest.context.prompt });
                const launched = launchSession({
                  slug: front.slug, cwd: workspace.path, command: invocation, agent: execution.agent,
                  repoId: repository.id, component: front.leadComponent, front: front.slug, runId: manifest.id, role: 'agent',
                });
                if (!launched.existed) {
                  const session = currentSessions().find((item) => item.controlSlug === launched.controlSlug);
                  if (session) history.started(session);
                }
                return { ...launched, slug: front.slug };
              },
            });
            push(); return json(response, 201, { run });
          }
        }
        const runId = decodeURIComponent(parts[4] || '');
        if (!parts[5] && request.method === 'GET') return json(response, 200, { run: runOrchestration.get(target, runId, { sessions: currentSessions() }) });
        if (parts[5] === 'discoveries' && !parts[6] && request.method === 'POST') {
          const run = runOrchestration.addDiscovery(target, runId, await body(request), { actor: device });
          let learningSummary = null;
          try { learningSummary = learning.refresh(target, learningContext(repository)); } catch { /* the durable run discovery remains available for explicit refresh */ }
          return json(response, 201, { run, learning: learningSummary });
        }
        if (parts[5] === 'handoff' && !parts[6] && request.method === 'POST') {
          const run = runOrchestration.handoff(target, runId, await body(request), { actor: device }); push(); return json(response, 200, { run });
        }
        if (parts[5] === 'tasks' && parts[6] && !parts[7] && request.method === 'POST') {
          const payload = await body(request);
          if (payload.source === 'configured-check') payload.source = 'user';
          const run = runOrchestration.recordTask(target, runId, Number(parts[6]), payload, { actor: device, updateFront: updateAcceptedFront });
          push(); return json(response, 200, { run });
        }
        if (parts[5] === 'checks' && !parts[6] && request.method === 'POST') {
          const payload = await body(request);
          if (payload.source === 'configured-check') payload.source = 'user-observed';
          return json(response, 201, { run: runOrchestration.recordCheck(target, runId, payload, { actor: device }) });
        }
        if (parts[5] === 'complete' && !parts[6] && request.method === 'POST') {
          const current = runOrchestration.get(target, runId, { sessions: currentSessions() });
          const currentWorkspaceGit = () => {
            try { return inspectRunGitState(target, current.manifest.workspace.path, current.manifest.execution.isolate ? current.manifest.front.slug : ''); }
            catch (error) { return { available: false, path: current.manifest.workspace.path, reason: String(error?.message || error) }; }
          };
          const run = runOrchestration.complete(target, runId, { actor: device, sessions: currentSessions, git: currentWorkspaceGit, updateFront: updateAcceptedFront });
          let reconciliationTrigger = null;
          if (run.state === 'completed') {
            try {
              reconciliationTrigger = reconciliations.trigger(target, {
                cause: 'completed-run', sourceId: run.id,
                message: `Run '${run.manifest.front.slug}' was accepted. Refresh analysis explicitly to compare resulting code evidence with its contracts.`,
              });
            } catch { /* completion remains authoritative; reconciliation is a review overlay */ }
          }
          let learningSummary = null;
          try { learningSummary = learning.refresh(target, learningContext(repository)); } catch { /* completion remains authoritative; learning is a review overlay */ }
          push(); return json(response, 200, { run, reconciliationTrigger, learning: learningSummary });
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'releases') {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        const currentFronts = () => repositoryPortfolio(target, fleetSnapshot().sessions).fronts;
        if (!parts[4]) {
          if (request.method === 'GET') return json(response, 200, { releases: releases.list(target) });
          if (request.method === 'POST') {
            const release = releases.create(target, await body(request), { fronts: currentFronts() });
            push();
            return json(response, 201, { release });
          }
        }
        if (parts[4]) {
          const releaseSlug = decodeURIComponent(parts[4]);
          if (request.method === 'GET' && !parts[5]) {
            return json(response, 200, { release: releases.get(target, releaseSlug) });
          }
          if (request.method === 'PATCH' && !parts[5]) {
            const payload = await body(request);
            const { expectedRevision, ...updates } = payload;
            const release = releases.update(target, releaseSlug, updates, {
              expectedRevision, fronts: currentFronts(),
            });
            push();
            return json(response, 200, { release });
          }
          if (request.method === 'POST' && parts[5] === 'transition' && !parts[6]) {
            const payload = await body(request);
            if (['candidate', 'released'].includes(payload.targetState) && payload.confirmed !== true) {
              throw new ReleaseError('RELEASE_CONFIRMATION_REQUIRED', `confirm the reviewed transition to ${payload.targetState}`);
            }
            const release = releases.transition(target, releaseSlug, String(payload.targetState || ''), {
              expectedRevision: payload.expectedRevision,
              fronts: currentFronts(),
              requirementEvidence: payload.requirementEvidence,
              priorGates: payload.priorGates,
              candidateEvidence: payload.candidateEvidence,
            });
            push();
            return json(response, 200, { release });
          }
        }
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'contracts' && parts[4] === 'migration' && !parts[5]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        if (request.method === 'GET') {
          return json(response, 200, { preview: previewWorkContractMigration(target, {
            frontSlugs: url.searchParams.getAll('front'),
            componentSlugs: url.searchParams.getAll('component'),
          }) });
        }
        if (request.method === 'POST') {
          return json(response, 200, applyWorkContractMigration(target, await body(request)));
        }
      }

      if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'product' && !parts[4]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const accepted = readAcceptedProduct(repository);
        const fallback = accepted.brief || normalizeProductBrief({
          title: repository.name,
          repositoryRoles: [{ repositoryId: repository.id, role: 'Define this repository role.' }],
        }, { repositoryId: repository.id });
        return json(response, 200, {
          supported: accepted.supported,
          exists: accepted.exists,
          revision: accepted.revision,
          brief: accepted.brief,
          questions: productBriefQuestions(fallback),
        });
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'product' && parts[4] === 'drafts' && !parts[5]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const payload = await body(request);
        return json(response, 201, { draft: productDirections.create(repository, { reset: Boolean(payload.reset) }) });
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'product' && parts[4] === 'drafts' && parts[5]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const draftId = parts[5];
        if (request.method === 'GET' && !parts[6]) {
          return json(response, 200, { draft: productDirections.get(repository, draftId) });
        }
        if (request.method === 'PATCH' && !parts[6]) {
          return json(response, 200, { draft: productDirections.update(repository, draftId, await body(request)) });
        }
        if (request.method === 'DELETE' && !parts[6]) {
          return json(response, 200, productDirections.discard(repository, draftId));
        }
        if (request.method === 'POST' && parts[6] === 'import' && !parts[7]) {
          const payload = await body(request);
          return json(response, 200, { draft: productDirections.importDocuments(repository, draftId, payload.paths) });
        }
        if (request.method === 'POST' && parts[6] === 'import-preview' && !parts[7]) {
          const payload = await body(request);
          return json(response, 200, { preview: productDirections.planImport(repository, draftId, payload.paths) });
        }
        if (request.method === 'GET' && parts[6] === 'preview' && !parts[7]) {
          return json(response, 200, { preview: productDirections.preview(repository, draftId) });
        }
        if (request.method === 'POST' && parts[6] === 'accept' && !parts[7]) {
          return json(response, 201, productDirections.accept(repository, draftId));
        }
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'discovery' && !parts[4]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        if (detectAdapter(repository.path) !== 'uninitialized') {
          throw new Error('component discovery is only available before native initialization');
        }
        return json(response, 201, { draft: discoveries.create(repository) });
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'discovery' && parts[4] && parts[5] === 'regenerate' && !parts[6]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        if (detectAdapter(repository.path) !== 'uninitialized') {
          throw new Error('repository metadata now exists; refresh the repository before continuing');
        }
        return json(response, 200, { draft: discoveries.regenerate(repository, parts[4]) });
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2]
        && parts[3] === 'discovery' && parts[4] && parts[5] === 'accept' && !parts[6]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        if (detectAdapter(repository.path) !== 'uninitialized') {
          throw new Error('repository metadata now exists; no proposal was written');
        }
        const result = discoveries.accept(repository, parts[4], (await body(request)).components);
        return json(response, 201, result);
      }

      if (request.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'components' && parts[4] && !parts[5]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const payload = await body(request);
        const target = { ...repository, adapter: detectAdapter(repository.path) };
        const component = payload.state && !payload.title
          ? setComponentState(target, parts[4], String(payload.state))
          : updateComponent(target, parts[4], payload);
        return json(response, 200, { component });
      }

      if (request.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'components' && parts[4] && !parts[5]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const result = deleteComponent({ ...repository, adapter: detectAdapter(repository.path) }, parts[4], { sessions: fleetSnapshot().sessions });
        return json(response, 200, result);
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'components' && parts[4] && parts[5] === 'fronts' && !parts[6]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const component = repositoriesSnapshot({ repositories: [{ ...repository, adapter: detectAdapter(repository.path) }] })[0].components.find((item) => item.slug === parts[4]);
        if (!component) return json(response, 404, { error: 'component not found' });
        const created = createFront({ ...repository, adapter: detectAdapter(repository.path) }, parts[4], await body(request));
        return json(response, 201, { front: created });
      }

      if (request.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'components' && parts[4] && parts[5] === 'fronts' && parts[6]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const result = deleteFront({ ...repository, adapter: detectAdapter(repository.path) }, parts[4], parts[6], { sessions: fleetSnapshot().sessions });
        return json(response, 200, result);
      }

      if (request.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'components' && parts[4] && parts[5] === 'fronts' && parts[6]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const front = updateFront({ ...repository, adapter: detectAdapter(repository.path) }, parts[4], parts[6], await body(request));
        return json(response, 200, { front });
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'components' && !parts[4]) {
        const repository = config.read().repositories.find((item) => item.id === parts[2]);
        if (!repository) return json(response, 404, { error: 'repository not found' });
        const payload = await body(request);
        const adapter = detectAdapter(repository.path);
        if (adapter === 'uninitialized') {
          const initialized = initializeNativeRepository(repository, { components: [payload] });
          const component = repositoryPortfolio(initialized).components[0];
          return json(response, 201, { component });
        }
        const component = createComponent({ ...repository, adapter }, payload);
        return json(response, 201, { component });
      }

      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && parts[3] === 'initialize') {
        const initialized = config.initializeRepository(parts[2]);
        discoveries.discardRepository(parts[2]);
        return json(response, 200, { repository: initialized });
      }

      if (parts[0] === 'api' && parts[1] === 'repositories' && parts[2] && !parts[3]) {
        if (request.method === 'PATCH') {
          return json(response, 200, { repository: config.updateRepository(parts[2], await body(request)) });
        }
        if (request.method === 'DELETE') {
          const removed = config.removeRepository(parts[2]);
          discoveries.discardRepository(parts[2]);
          productDirections.discardRepository(parts[2]);
          componentDesigns.deleteRepository(parts[2]);
          frontDesigns.deleteRepository(parts[2]);
          publications.discardRepository(parts[2]);
          reconciliations.discardRepository(parts[2]);
          learning.discardRepository(parts[2]);
          return json(response, 200, removed);
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        return json(response, 200, fleetSnapshot());
      }

      if (request.method === 'GET' && url.pathname === '/api/stream') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(`data: ${JSON.stringify(fleetSnapshot())}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return undefined;
      }

      // /api/session/<slug>/<action>
      if (parts[0] === 'api' && parts[1] === 'session' && parts[2]) {
        const slug = parts[2];
        if (!CONTROL_SLUG.test(slug)) return json(response, 400, { error: 'invalid session name' });
        const action = parts[3] ?? '';

        if (request.method === 'GET' && action === 'pane') {
          const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get('lines')) || 200));
          const text = capture(slug, { lines });
          if (text === null) return json(response, 404, { error: 'no pane for that session' });
          return json(response, 200, { html: ansiToHtml(text) });
        }

        if (request.method === 'POST' && !exists(slug)) {
          return json(response, 404, { error: 'that session was not started here' });
        }

        if (request.method === 'POST' && action === 'text') {
          const { text, enter = true } = await body(request);
          sendText(slug, String(text ?? ''), { enter: enter !== false });
          push();
          return json(response, 200, { ok: true });
        }

        if (request.method === 'POST' && action === 'key') {
          const { key } = await body(request);
          sendKey(slug, String(key ?? ''));
          push();
          return json(response, 200, { ok: true });
        }

        if (request.method === 'POST' && action === 'wrapup') {
          const { order } = await body(request);
          const result = askToWrapUp(slug, order ? { order: String(order) } : {});
          push();
          return json(response, 200, result);
        }

        if (request.method === 'POST' && action === 'pause') {
          const { order } = await body(request);
          const result = askToPause(slug, order ? { order: String(order) } : {});
          push();
          return json(response, 200, result);
        }

        if (request.method === 'POST' && action === 'resume') {
          const { order } = await body(request);
          const result = resume(slug, order ? { order: String(order) } : {});
          push();
          return json(response, 200, result);
        }

        if (request.method === 'DELETE' && !action) {
          const session = fleetSnapshot().sessions.find((item) => item.controlSlug === slug);
          if (session) history.stopped(session);
          kill(slug);
          push();
          return json(response, 200, { ok: true });
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/session') {
        const { slug, cwd, command, agent, repoId, component, front, model, effort, isolate, manager = false } = await body(request);
        if (!SLUG.test(String(slug ?? ''))) return json(response, 400, { error: 'invalid session name' });
        if (command) return json(response, 400, { error: 'custom commands are an expert CLI-only escape hatch; choose a supported agent in the client' });
        if (manager && (component || front || isolate === true)) {
          return json(response, 400, { error: 'Director sessions plan across existing portfolios and do not own a front or worktree' });
        }
        const repository = repoId
          ? config.read().repositories.find((item) => item.id === repoId)
          : null;
        if (repoId && !repository) return json(response, 400, { error: 'repository not found' });
        let selectedComponent = component ? String(component) : null;
        let selectedFront = front ? String(front) : null;
        let portfolio = null;
        let frontRecord = null;
        if (repository && (selectedComponent || selectedFront)) {
          portfolio = repositoriesSnapshot({
            repositories: [{ ...repository, adapter: detectAdapter(repository.path) }],
          }, fleetSnapshot().sessions)[0];
          frontRecord = selectedFront
            ? portfolio.fronts.find((item) => item.slug === selectedFront)
            : null;
          if (selectedFront && !frontRecord) return json(response, 400, { error: 'front not found' });
          if (!selectedComponent && frontRecord) selectedComponent = frontRecord.component;
          if (selectedComponent && !portfolio.components.some((item) => item.slug === selectedComponent)) {
            return json(response, 400, { error: 'component not found' });
          }
          if (frontRecord && selectedComponent !== frontRecord.component) {
            return json(response, 400, { error: 'front does not belong to that component' });
          }
          if (selectedFront) {
            const owner = fleetSnapshot().sessions.find((session) => session.repoId === repository.id && session.front === selectedFront);
            if (owner) {
              const expectedControlSlug = `${repository.id}--${String(slug)}`;
              if (owner.controlSlug === expectedControlSlug) return json(response, 200, { existed: true, controlSlug: owner.controlSlug, tmux: owner.tmux });
              return json(response, 409, { error: `front '${selectedFront}' is already owned by session '${owner.slug}'`, owner });
            }
            const externalOwner = portfolio.lanes.find((lane) => lane.slug === selectedFront && lane.liveness === 'live');
            if (externalOwner) return json(response, 409, { error: `front '${selectedFront}' is already owned by a live Director lane`, owner: externalOwner });
          }
        }
        const settings = config.read();
        const chosenAgent = String(agent || repository?.defaultAgent || (settings.agents.claude.enabled ? 'claude' : 'codex'));
        const agentSettings = settings.agents[chosenAgent];
        if (!agentSettings?.enabled) return json(response, 400, { error: `${chosenAgent} is disabled in Settings` });
        const targetRepository = repository ? { ...repository, adapter: detectAdapter(repository.path) } : null;
        const isolated = Boolean(!manager && targetRepository && (isolate === true || (isolate === undefined && selectedFront)));
        const worktree = isolated ? createWorktree(targetRepository, selectedFront || String(slug)) : null;
        const requestedCwd = worktree?.path || String(manager && !repository ? process.cwd() : cwd || repository?.path || process.cwd());
        if (repository && !worktree) {
          const absoluteCwd = resolve(requestedCwd);
          const repositoryRoot = resolve(repository.path);
          if (absoluteCwd !== repositoryRoot && !absoluteCwd.startsWith(`${repositoryRoot}${sep}`)) {
            return json(response, 400, { error: 'repository sessions must start inside that repository' });
          }
        }
        const componentRecord = selectedComponent ? portfolio?.components.find((item) => item.slug === selectedComponent) : null;
        const contract = componentRecord
          ? Object.entries(componentRecord.sections).map(([heading, value]) => `## ${heading}\n${value}`).join('\n\n')
          : '';
        const managerState = manager ? fleetSnapshot() : null;
        const managerRepositories = manager ? repositoriesSnapshot({
          repositories: config.read().repositories
            .filter((item) => !repository || item.id === repository.id)
            .map((item) => ({ ...item, adapter: detectAdapter(item.path) })),
        }, managerState.sessions) : [];
        const managementPrompt = manager ? fleetManagerPrompt({
          repositories: managerRepositories,
          sessions: managerState.sessions,
          nodePath: process.execPath,
          binPath: join(here, '..', 'bin', 'handraise.mjs'),
        }) : '';
        const frontPrompt = frontRecord ? [
          `You own the '${selectedFront}' front for component '${selectedComponent}'.`,
          targetRepository?.adapter === 'director'
            ? `The shared runtime is ${join(repository.path, '.claude/runtime')}. Read ${join(repository.path, '.claude/runtime/plans', `${selectedFront}.md`)} and ${join(repository.path, '.claude/MULTISESSION.md')}; adopt any paused work and register or restamp the lane before editing.`
            : `Read ${join(requestedCwd, '.handraise/fronts', `${selectedFront}.md`)} and begin with its Handoff.`,
          contract ? `Component contract:\n${contract}` : '',
          'Keep the checklist and handoff current. Do not start work outside this front without reporting the dependency.',
        ].filter(Boolean).join('\n\n').slice(0, 12_000) : '';
        const initialPrompt = managementPrompt || frontPrompt;
        const invocation = agentInvocation(chosenAgent, {
          model: model || repository?.model || agentSettings.model,
          effort: effort || repository?.effort || agentSettings.effort,
          prompt: initialPrompt,
        });
        const result = launchSession({
          slug: String(slug),
          cwd: requestedCwd,
          command: command ? String(command) : invocation,
          agent: chosenAgent,
          repoId: repository?.id || null,
          component: selectedComponent,
          front: selectedFront,
          role: manager ? 'manager' : 'agent',
        });
        if (!result.existed) {
          const session = fleetSnapshot().sessions.find((item) => item.controlSlug === result.controlSlug);
          if (session) history.started(session);
        }
        push();
        return json(response, 200, { ...result, worktree });
      }

      // /api/permission/<key>
      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'permission' && parts[2]) {
        const { id, behavior, message } = await body(request);
        const result = resolvePermission(root, parts[2], String(id ?? ''), String(behavior ?? ''), String(message ?? ''));
        push();
        return json(response, 200, result);
      }

      if (['GET', 'HEAD'].includes(request.method) && !url.pathname.startsWith('/api/')
        && serveWeb(url.pathname, response, webRoot, { head: request.method === 'HEAD' })) {
        return undefined;
      }

      return json(response, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof IntelligenceError) {
        const status = ['PLAN_NOT_FOUND', 'JOB_NOT_FOUND', 'SNAPSHOT_NOT_FOUND', 'ANALYZER_NOT_FOUND'].includes(error.code) ? 404
          : ['LOCAL_AUTHORITY_REQUIRED'].includes(error.code) ? 403
            : ['PLAN_EXPIRED', 'PLAN_REPOSITORY_MISMATCH', 'ANALYZER_CHANGED', 'REPOSITORY_CHANGED'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof PlanningError) {
        const status = ['PREFLIGHT_NOT_FOUND', 'PLANNING_JOB_NOT_FOUND', 'PLANNING_RESULT_NOT_FOUND', 'ADAPTER_NOT_FOUND'].includes(error.code) ? 404
          : ['LOCAL_AUTHORITY_REQUIRED', 'PLANNING_CONSENT_REQUIRED'].includes(error.code) ? 403
            : ['PREFLIGHT_EXPIRED', 'PREFLIGHT_REPOSITORY_MISMATCH', 'ADAPTER_CHANGED', 'ADAPTER_UNAVAILABLE'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof ComponentDesignError) {
        const status = ['COMPONENT_DESIGN_DRAFT_NOT_FOUND', 'COMPONENT_DESIGN_DRAFT_EXPIRED'].includes(error.code) ? 404
          : ['COMPONENT_DESIGN_REVISION_CONFLICT', 'COMPONENT_DESIGN_SOURCE_MISMATCH', 'COMPONENT_DESIGN_SOURCE_UNAVAILABLE', 'COMPONENT_DESIGN_MODEL_UNAVAILABLE'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof FrontDesignError) {
        const status = ['FRONT_DESIGN_DRAFT_NOT_FOUND', 'FRONT_DESIGN_DRAFT_EXPIRED'].includes(error.code) ? 404
          : ['FRONT_DESIGN_REVISION_CONFLICT', 'FRONT_DESIGN_SOURCE_MISMATCH', 'FRONT_DESIGN_SOURCE_UNAVAILABLE', 'FRONT_DESIGN_MODEL_UNAVAILABLE'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof PlanPublicationError) {
        const status = ['PUBLICATION_PREVIEW_NOT_FOUND', 'PUBLICATION_PREVIEW_EXPIRED'].includes(error.code) ? 404
          : ['PUBLICATION_ACTOR_CHANGED'].includes(error.code) ? 403
            : ['PUBLICATION_BUSY', 'PUBLICATION_REVISION_CONFLICT', 'PUBLICATION_BASELINE_CHANGED', 'PUBLICATION_SOURCE_CHANGED', 'PUBLICATION_SNAPSHOT_CHANGED', 'PUBLICATION_ADAPTER_CHANGED', 'PUBLICATION_RECOVERY_REQUIRED', 'DIRECTOR_PUBLICATION_UNSUPPORTED', 'PUBLICATION_NOT_READY'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof RunOrchestrationError) {
        const status = ['RUN_PREFLIGHT_NOT_FOUND', 'RUN_NOT_FOUND', 'RUN_FRONT_NOT_FOUND'].includes(error.code) ? 404
          : ['RUN_ACTOR_CHANGED'].includes(error.code) ? 403
            : ['RUN_BUSY', 'RUN_PREFLIGHT_CHANGED', 'RUN_PREFLIGHT_STALE', 'RUN_NOT_READY', 'RUN_DUPLICATE_SESSION', 'RUN_DUPLICATE_ACTIVE_FRONT', 'RUN_CONTRACT_CHANGED', 'RUN_PROCESS_ACTIVE', 'RUN_GIT_RISK', 'RUN_EVIDENCE_INCOMPLETE', 'RUN_CHECKLIST_INCOMPLETE', 'RUN_ADAPTER_UNSUPPORTED'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof AdHocRunError) {
        const status = ['ADHOC_PREFLIGHT_NOT_FOUND', 'ADHOC_RUN_NOT_FOUND'].includes(error.code) ? 404
          : ['ADHOC_ACTOR_CHANGED'].includes(error.code) ? 403
            : ['ADHOC_BUSY', 'ADHOC_PREFLIGHT_CHANGED', 'ADHOC_PREFLIGHT_STALE', 'ADHOC_NOT_READY', 'ADHOC_DUPLICATE_SESSION', 'ADHOC_WORKSPACE_CHANGED', 'ADHOC_REVISION_CHANGED', 'ADHOC_PROCESS_ACTIVE', 'ADHOC_RESTART_STALE', 'ADHOC_RESTART_OWNERSHIP_CONFLICT', 'ADHOC_RESTART_WORKSPACE_UNAVAILABLE', 'ADHOC_RESTART_WORKSPACE_CHANGED', 'ADHOC_RESTART_AGENT_UNAVAILABLE'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof ReleaseError) {
        const status = error.code === 'RELEASE_NOT_FOUND' ? 404
          : ['REPOSITORY_BUSY', 'RELEASE_BASELINE_CHANGED', 'FRONT_RELEASE_CONFLICT', 'FRONT_REVISION_STALE', 'FRONT_NOT_FOUND', 'FRONT_SCHEMA_UNSUPPORTED', 'RELEASE_NOT_READY', 'DIRECTOR_RELEASE_READ_ONLY', 'REPOSITORY_NOT_INITIALIZED'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof ReconciliationError) {
        const status = ['RECONCILIATION_CYCLE_NOT_FOUND', 'RECONCILIATION_FINDING_NOT_FOUND', 'RECONCILIATION_JOB_NOT_FOUND'].includes(error.code) ? 404
          : ['RECONCILIATION_STATE_INVALID'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof LearningError) {
        const status = ['LEARNING_PROPOSAL_NOT_FOUND', 'LEARNING_FEEDBACK_NOT_FOUND', 'LEARNING_EXPORT_NOT_FOUND'].includes(error.code) ? 404
          : ['LEARNING_PROPOSAL_CHANGED', 'LEARNING_PROPOSAL_STALE', 'LEARNING_ANALYSIS_REQUIRED', 'LEARNING_DRAFT_TARGET_UNAVAILABLE'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof WorkContractError) {
        const status = ['WORK_CONTRACT_BASELINE_CHANGED', 'WORK_CONTRACT_MIGRATION_UNSUPPORTED'].includes(error.code) ? 409 : 400;
        return json(response, status, error.toJSON());
      }
      if (error instanceof ProductDirectionError) {
        const status = error.code === 'DRAFT_NOT_FOUND' || error.code === 'DRAFT_EXPIRED' ? 404
          : ['PRODUCT_BASELINE_CHANGED', 'PRODUCT_WRITE_BUSY', 'PRODUCT_REPOSITORY_NOT_INITIALIZED', 'PRODUCT_ADAPTER_UNSUPPORTED'].includes(error.code) ? 409 : 400;
        return json(response, status, { error: error.message, code: error.code, details: error.details });
      }
      return json(response, 400, { error: String(error?.message || error) });
    }
  });

  server.on('listening', () => { timer = setInterval(push, 2000); timer.unref?.(); });
  server.on('close', () => {
    clearInterval(timer);
    for (const watcher of watchers) watcher.close();
    for (const client of clients) client.end();
    clients.clear();
    analyses.shutdown();
    systemMaps.clear();
    reconciliations.shutdown();
    planning.shutdown();
    void internetTunnel.stop();
  });

  server.handraise = {
    auth, config, internetTunnel, productDirections, componentDesigns, frontDesigns, publications, releases, adHocRuns, runOrchestration, analyses, systemMaps, reconciliations, learning, planning,
    shutdown: () => { analyses.shutdown(); systemMaps.clear(); reconciliations.shutdown(); planning.shutdown(); return internetTunnel.stop(); },
  };

  return server;
}
