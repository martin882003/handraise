import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { fleetVerdict } from '../../src/fleet.mjs';
import './styles.css';

type Status = 'error' | 'blocked' | 'waiting' | 'pausing' | 'paused' | 'wrapping' | 'working';

interface Permission {
  id: string;
  key: string;
  waitingSeconds: number;
  tool?: {
    name?: string;
    input?: Record<string, unknown>;
  };
  suggestions?: unknown[];
}

interface AgentSession {
  slug: string;
  controlSlug: string;
  agent: string;
  cwd: string | null;
  repoId: string | null;
  component: string | null;
  front: string | null;
  runId: string | null;
  role: 'agent' | 'ad-hoc' | 'manager' | 'setup';
  status: Status;
  reason: string | null;
  waitingSeconds: number;
  activity: { minutesAgo: number } | null;
  permission: Permission | null;
  controllable: boolean;
  attached: boolean;
  error: string | null;
  git: GitState | null;
}

interface GitState {
  available: boolean;
  path: string | null;
  reason?: string;
  branch?: string;
  revision?: string | null;
  expectedBranch?: string | null;
  branchMismatch?: boolean;
  baseline?: string;
  baselineRevision?: string | null;
  dirty?: number | null;
  ahead?: number | null;
  behind?: number | null;
  backupRef?: string | null;
  unbacked?: number | null;
}

interface FleetState {
  sessions: AgentSession[];
  needsYou: number;
  at: string;
}

interface HistoryEvent {
  id: string;
  type: 'started' | 'completed' | 'failed' | 'stopped' | 'ended';
  at: string;
  slug: string;
  controlSlug: string;
  repoId: string | null;
  component: string | null;
  front: string | null;
  runId?: string | null;
  agent: string | null;
  durationSeconds: number | null;
}

interface HistoryData {
  events: HistoryEvent[];
  outcomes: HistoryEvent[];
  summary: { completed7d: number; failed7d: number; stopped7d: number; medianDurationSeconds: number | null };
}

type View = 'repositories' | 'overview' | 'map' | 'sessions' | 'releases' | 'ad-hoc' | 'components' | 'settings';
type FrontState = 'active' | 'queued' | 'blocked' | 'paused' | 'done';

interface RouteState {
  view: View;
  repositoryId: string | null;
  componentSlug: string | null;
  frontSlug: string | null;
  releaseSlug: string | null;
  sessionSlug: string | null;
}

interface Front {
  schemaVersion: number;
  revision: string;
  slug: string;
  component: string;
  leadComponent: string | null;
  affectedComponents: string[];
  goalIds: string[];
  analysisSnapshot: string | null;
  title: string;
  state: FrontState;
  done: number;
  total: number;
  percent: number;
  next: string | null;
  impact: string | null;
  complexity: string | null;
  kind: 'front' | 'backlog';
  outcome: string;
  motivation: string;
  scope: string;
  nonGoals: string[];
  readiness: string[];
  acceptanceCriteria: string[];
  verification: string[];
  deliverables: string[];
  risks: string[];
  dependencies: Array<{ kind: string; target: string; reason: string; raw?: string }>;
  evidence: Array<{ kind: string; reference: string; reason: string; raw?: string }>;
  context: string;
  handoff: string;
  tasks: Array<{ state: 'open' | 'done' | 'skipped'; text: string }>;
}

interface RunDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  recovery: string;
  details: unknown;
}

interface RunContext {
  prompt: string;
  bytes: number;
  digest: string;
  explicitUnknowns: string[];
}

interface RunPreflight {
  schemaVersion: 1;
  id: string;
  revision: string;
  state: 'review' | 'started';
  createdAt: string;
  expiresAt: string;
  repository: { id: string; name: string; adapter: string };
  actor: { id: string; name: string; authority: 'implicit-local' | 'paired-client' };
  front: {
    slug: string; title: string; state: string; revision: string; leadComponent: string | null;
    affectedComponents: string[]; goalIds: string[]; analysisSnapshot: string | null; outcome: string;
    motivation: string; scope: string; nonGoals: string[]; readiness: string[];
    acceptanceCriteria: string[]; verification: string[]; deliverables: string[]; risks: string[];
    evidence: Array<{ kind: string; reference: string; reason: string }>; checklist: Front['tasks'];
  };
  components: Array<{
    slug: string; title: string; revision: string; purpose: string; outcomes: string[];
    responsibilities: string[]; limits: string[]; invariants: string[]; territory: string[];
    verification: string[]; evidence: Array<{ kind: string; reference: string; reason: string }>;
    uncertainties: string[]; guidance: string;
  }>;
  goals: Array<{ id: string; title: string; outcome: string; state: string; priority: string; successSignals: string[]; constraintIds: string[] }>;
  productContext: { purpose: string; constraints: string[]; invariants: string[]; decisions: Array<{ id: string; question: string; answer: string }> };
  dependencies: Array<{ kind: string; target: string; reason: string; state: string; revision: string | null }>;
  execution: {
    agent: string; model: string; effort: string; isolate: boolean; integrationVersion: string | null;
    authProvider: string | null; requirements: { terminal: true; authenticated: true };
    capabilities: { terminal: boolean; lifecycleAttention: boolean; typedPermissions: boolean; gracefulWrapup: boolean; configured: boolean };
  };
  workspace: { path: string; branch: string | null; revision: string | null };
  source: {
    front: { slug: string; revision: string };
    components: Array<{ slug: string; revision: string }>;
    dependencies: Array<{ kind: string; target: string; state: string; revision: string | null }>;
    productRevision: string | null;
    analysisSnapshot: string | null;
    repositoryRevision: string | null;
    repositoryBranch: string | null;
    digest: string;
  };
  context: RunContext;
  readiness: { ready: boolean; errors: number; warnings: number; diagnostics: RunDiagnostic[] };
  resume: { runId: string; handoffRevision: string | null } | null;
}

interface RunActor { id: string; name: string; authority?: string }

interface RunTaskEvidence {
  id: string;
  taskIndex: number;
  task: string;
  state: 'done' | 'skipped';
  source: 'user' | 'configured-check' | 'agent-claim';
  evidence: string;
  at: string;
  actor: RunActor;
  applied: boolean;
}

interface RunCheck {
  id: string;
  kind: 'criterion' | 'verification';
  index: number;
  label: string;
  status: 'passed' | 'failed';
  source: 'configured-check' | 'user-observed' | 'agent-claim';
  evidence: string;
  at: string;
  actor: RunActor;
}

interface RunDiscovery {
  id: string;
  kind: 'discovery' | 'blocker' | 'decision' | 'scope-change';
  summary: string;
  evidence: string;
  affectedFronts: string[];
  at: string;
  actor: RunActor;
}

interface RunHandoff {
  id: string;
  revision: string;
  summary: string;
  nextSteps: string[];
  blockers: string[];
  at: string;
  actor: RunActor;
}

interface RunManifest {
  schemaVersion: 1;
  id: string;
  revision: string;
  createdAt: string;
  repository: RunPreflight['repository'];
  front: RunPreflight['front'];
  components: RunPreflight['components'];
  goals: RunPreflight['goals'];
  productContext: RunPreflight['productContext'];
  dependencies: RunPreflight['dependencies'];
  source: RunPreflight['source'];
  execution: RunPreflight['execution'];
  workspace: RunPreflight['workspace'] & { created: boolean; baseline: string | null };
  context: RunContext;
  resume: RunPreflight['resume'];
  preflight: { id: string; revision: string };
}

interface RunRecord {
  schemaVersion: 1;
  id: string;
  repositoryId: string;
  state: 'starting' | 'running' | 'awaiting-acceptance' | 'paused' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
  manifest: RunManifest;
  process: {
    state: string;
    active: boolean;
    activity: { minutesAgo?: number } | null;
    attention: { status: string; reason: string | null; permission?: Permission | null } | null;
    session: { slug: string; controlSlug: string | null; agent: string; cwd: string } | null;
  };
  currentFrontRevision: string;
  taskEvidence: RunTaskEvidence[];
  checks: RunCheck[];
  discoveries: RunDiscovery[];
  handoffs: RunHandoff[];
  outcome: { accepted: boolean; acceptedAt: string; frontRevision: string } | null;
  failure: { code: string; message: string; at: string } | null;
}

interface RunLaunchState {
  repositoryId: string;
  frontSlug: string;
  resumeRunId?: string | null;
}

type ReleaseState = 'draft' | 'ready' | 'active' | 'blocked' | 'candidate' | 'released' | 'cancelled';

interface ReleaseCandidateEvidence {
  sourceRevision: string;
  contractRevision: string;
  artifactDigest: string;
  artifact: string;
  toolVersions: Record<string, string>;
  measurementProfile: string;
  measuredAt: string;
}

interface ReleaseContract {
  schemaVersion: 1;
  repositoryId: string;
  slug: string;
  title: string;
  version: string | null;
  state: ReleaseState;
  targetBranch: string;
  outcome: string;
  requirementIds: string[];
  fronts: Array<{ slug: string; revision: string }>;
  acceptanceCriteria: string[];
  verification: string[];
  compatibility: string[];
  limitations: string[];
  candidate: ReleaseCandidateEvidence | null;
  createdAt: string;
  updatedAt: string;
  revision: string;
}

interface AdHocDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  recovery: string;
  details: unknown;
}

interface AdHocPreflight {
  schemaVersion: 1;
  kind: 'ad-hoc';
  id: string;
  revision: string;
  state: 'review' | 'started';
  createdAt: string;
  expiresAt: string;
  work: {
    slug: string;
    purpose: string;
    component: { slug: string; title: string; revision: string; territory: string[]; guidance: string } | null;
    provenance: { planned: false; front: null; release: null; requirementIds: []; deliveryProgress: false; retroactivePlanning: false };
  };
  execution: RunPreflight['execution'];
  workspace: { path: string; branch: string | null; revision: string | null };
  source: { repositoryRevision: string | null; repositoryBranch: string | null; component: { slug: string; revision: string } | null; digest: string };
  context: RunContext;
  readiness: { ready: boolean; errors: number; warnings: number; diagnostics: AdHocDiagnostic[] };
}

interface AdHocRunRecord {
  schemaVersion: 1;
  kind: 'ad-hoc';
  id: string;
  repositoryId: string;
  revision: string;
  state: 'starting' | 'running' | 'awaiting-outcome' | 'paused' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
  manifest: {
    revision: string;
    work: AdHocPreflight['work'];
    provenance: AdHocPreflight['work']['provenance'];
    execution: AdHocPreflight['execution'];
    workspace: { path: string; branch: string | null; created: boolean; baseline: string | null; revision: string | null };
    source: AdHocPreflight['source'];
    context: RunContext;
  };
  process: RunRecord['process'];
  discoveries: Array<{ id: string; kind: string; summary: string; evidence: string; at: string }>;
  checks: Array<{ id: string; label: string; status: 'passed' | 'failed'; source: string; evidence: string; at: string }>;
  handoffs: Array<{ id: string; revision: string; summary: string; nextSteps: string[]; blockers: string[]; at: string }>;
  proposals: Array<{ id: string; state: 'review'; target: { kind: 'new-front' | 'existing-front' | 'release-review'; id: string | null }; summary: string; mutatesAcceptedState: false; retroactivePlanned: false; deliveryProgress: false; at: string }>;
  outcome: { status: 'completed' | 'failed' | 'abandoned'; summary: string; accepted: false; deliveryProgress: false; retroactivePlanned: false; at: string; git: { path: string; branch: string | null; dirty: number; ahead: number; behind: number; unbacked: number; branchMismatch: boolean } } | null;
  failure: { code: string; message: string; at: string } | null;
}

interface Component {
  slug: string;
  title: string;
  state: 'active' | 'closing';
  order: number;
  progress: number | null;
  activeFront: string | null;
  counts: Record<FrontState, number>;
  sections: Record<string, string>;
  fronts: Front[];
}

interface DiscoveryProposal {
  slug: string;
  title: string;
  scope: string;
  limits: string;
  delegation: string;
  territory: string;
  order: number;
  confidence: 'high' | 'medium' | 'low';
  evidence: Array<{ path: string; reason: string }>;
  uncertainty: string[];
}

interface DiscoveryDraft {
  id: string;
  repositoryId: string;
  analyzedAt: string;
  expiresAt: number;
  fingerprint: string;
  analysis: {
    files: number;
    documentation: number;
    manifests: number;
    tests: number;
    configuration: number;
    truncated: boolean;
  };
  proposals: DiscoveryProposal[];
}

interface DiscoveryDialogState {
  repositoryId: string;
  repositoryName: string;
  loading: boolean;
  draft: DiscoveryDraft | null;
  error: string;
}

interface ProductStatement {
  id: string;
  text: string;
  sourceIds: string[];
  locked: boolean;
  order: number;
}

interface ProductGoal {
  id: string;
  title: string;
  outcome: string;
  priority: 'now' | 'next' | 'later' | 'unspecified';
  horizon: string;
  state: 'proposed' | 'active' | 'achieved' | 'retired';
  successSignals: string[];
  constraintIds: string[];
  repositoryIds: string[];
  sourceIds: string[];
  locked: boolean;
  order: number;
}

interface ProductBrief {
  schemaVersion: 1;
  title: string;
  stage: string;
  updatedAt: string;
  purpose: Omit<ProductStatement, 'order'>;
  users: ProductStatement[];
  outcomes: ProductStatement[];
  constraints: ProductStatement[];
  invariants: ProductStatement[];
  nonGoals: ProductStatement[];
  glossary: Array<{ id: string; term: string; definition: string; aliases: string[]; sourceIds: string[]; locked: boolean; order: number }>;
  goals: ProductGoal[];
  repositoryRoles: Array<{ id: string; repositoryId: string; role: string; sourceIds: string[]; locked: boolean; order: number }>;
  assumptions: ProductStatement[];
  decisions: Array<{ id: string; question: string; answer: string; state: 'open' | 'resolved' | 'dismissed'; sourceIds: string[]; locked: boolean; order: number }>;
  conflicts: Array<{ id: string; summary: string; question: string; answer: string; state: 'open' | 'resolved' | 'dismissed'; sourceIds: string[]; locked: boolean; order: number }>;
  sources: Array<{ id: string; kind: 'human' | 'document' | 'connected-source'; label: string; path?: string; digest?: string; selectedAt?: string }>;
}

interface ProductDraft {
  id: string;
  repositoryId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  baselineRevision: string | null;
  currentRevision: string | null;
  stale: boolean;
  canAccept: boolean;
  acceptedExists: boolean;
  imports: string[];
  brief: ProductBrief;
  sourceStates: Array<{ sourceId: string; status: 'current' | 'stale' | 'missing' | 'unavailable' | 'unknown'; reason: string | null; currentDigest?: string }>;
  questions: Array<{ id: string; section: string; question: string; blocking: false }>;
}

interface ProductDialogState {
  repositoryId: string;
  repositoryName: string;
  repositoryAdapter: Repository['adapter'];
  loading: boolean;
  draft: ProductDraft | null;
  error: string;
}

interface ProductPreview {
  baselineRevision: string | null;
  currentRevision: string | null;
  proposedRevision: string;
  stale: boolean;
  canAccept: boolean;
  sourceStates: ProductDraft['sourceStates'];
  before: string;
  after: string;
}

interface ProductStatus {
  supported: boolean;
  exists: boolean;
  revision: string | null;
  brief: ProductBrief | null;
  questions: Array<{ id: string; section: string; question: string; blocking: false }>;
}

interface Repository {
  id: string;
  name: string;
  path: string;
  adapter: 'director' | 'handraise' | 'uninitialized';
  components: Component[];
  fronts: Front[];
  lanes: Array<{
    slug: string;
    component: string | null;
    worktree: string | null;
    statusText: string | null;
    liveness: 'live' | 'dead' | 'unknown';
  }>;
  summary?: { components: number; openFronts: number; activeSessions: number };
  error?: string;
  recovery?: string;
  availability?: {
    available: boolean;
    kind: 'available' | 'missing' | 'unreadable' | 'invalid';
    detail: string | null;
    recovery: string | null;
  };
  mutations: {
    components: boolean;
    frontCreate: boolean;
    frontEdit: boolean;
    frontDelete: boolean;
    workContracts?: {
      componentReadVersions: number[];
      frontReadVersions: number[];
      writeVersion: number | null;
      componentEdit: boolean;
      frontEdit: boolean;
      migrate: boolean;
      plan: boolean;
      preservesUnknown: boolean;
    };
  };
  workContracts?: {
    schemaVersion: number;
    components: Record<string, number>;
    fronts: Record<string, number>;
    migrationAvailable: boolean;
    validation: ContractValidation;
  };
  workshop: {
    worktrees: Array<{ path: string; branch: string | null; primary: boolean; orphan: boolean; owner: { slug: string; controlSlug: string; front: string | null } | null; git: GitState }>;
    orphans: Array<{ path: string; branch: string | null; git: GitState }>;
    error?: string;
  };
  defaultAgent: string | null;
  model: string;
  effort: string;
  runs: RunRecord[];
  runError?: string;
  releases: ReleaseContract[];
  releaseError?: string;
  adHocRuns: AdHocRunRecord[];
  adHocRunError?: string;
  reconciliation?: ReconciliationSummary | null;
  reconciliationError?: string;
}

interface ContractDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

interface ContractValidation {
  valid: boolean;
  diagnostics: ContractDiagnostic[];
  summary: { components: number; fronts: number; errors: number; warnings: number };
}

interface ContractMigrationPreview {
  previewId: string;
  repositoryId: string;
  schemaVersion: number;
  noOp: boolean;
  canApply: boolean;
  scope: { mode: 'all' | 'selected'; frontSlugs: string[]; componentSlugs: string[] };
  operations: Array<{
    kind: 'component' | 'front';
    slug: string;
    relativePath: string;
    before: string;
    after: string;
    beforeRevision: string;
    afterRevision: string;
  }>;
  validation: ContractValidation;
}

interface ContractMigrationDialogState {
  repositoryId: string;
  repositoryName: string;
  loading: boolean;
  applying: boolean;
  scope: { frontSlugs: string[]; componentSlugs: string[] };
  preview: ContractMigrationPreview | null;
  error: string;
}

interface AnalyzerDescriptor {
  id: string;
  name: string;
  version: string;
  capabilities: { languages: string[]; semantic: boolean; incremental: boolean };
  privacy: { localOnly: boolean; modelAssisted: boolean; sourceMayLeaveHost: boolean; requiresConsent: boolean };
  availability?: {
    available: boolean;
    code?: string;
    reason?: string;
    binary?: string;
    package?: string;
    version?: string;
    supportedVersions?: string;
    command?: string;
    schema?: string;
    isolation?: string;
  };
}

interface AnalysisPlan {
  id: string;
  repositoryId: string;
  analyzer: AnalyzerDescriptor;
  createdAt: string;
  expiresAt: string;
  manifest: {
    digest: string;
    files: Array<{ path: string; size: number; source: 'tracked' | 'untracked' | 'ignored-explicit' }>;
    counts: { files: number; bytes: number; tracked: number; untracked: number; ignoredExplicit: number };
    git: { head: string | null; branch: string | null; dirty: boolean };
  };
  scope: {
    excluded: Array<{ pattern: string; reason: string }>;
    truncated: boolean;
    limits: Record<string, number>;
  };
  adapterPlan?: {
    mode?: string;
    deterministic?: boolean;
    semantic?: boolean;
    upstreamVersion?: string;
    isolation?: string;
    supportedFiles?: number;
    unsupportedFiles?: number;
    invocation?: string[];
  };
  plannedInMs: number;
}

type AnalysisJobState = 'queued' | 'running' | 'awaiting-input' | 'stale' | 'cancelled' | 'failed' | 'complete';

interface AnalysisJob {
  id: string;
  analyzerId: string;
  state: AnalysisJobState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  progress: number;
  stage: string;
  message: string;
  snapshotId: string | null;
  snapshotFreshness: string | null;
  error: { code?: string; message?: string; retryable?: boolean } | null;
  resources: { files?: number; bytes?: number; outputBytes?: number; durationMs?: number; isolation?: string; resourceLimits?: string } | null;
  events: Array<{ stage: string; at: string; progress: number; message: string }>;
}

type SystemMapLens = 'responsibility' | 'module' | 'deployable' | 'dependency' | 'entry-point' | 'interface' | 'data-flow' | 'data-store' | 'test' | 'external-system' | 'change-coupling';

interface SystemMapGroup {
  id: string;
  lens: SystemMapLens;
  name: string;
  summary: string;
  memberEntityIds: string[];
  relationIds: string[];
  evidenceIds: string[];
  provenance: 'extracted' | 'inferred' | 'declared';
  rationale: Array<{ kind: string; summary: string; evidenceIds: string[] }>;
  alternatives: Array<{ summary: string; memberEntityIds: string[]; evidenceIds: string[] }>;
  uncertainty: { level: 'low' | 'medium' | 'high'; reasons: string[] };
  coverageImpact: { representedEntities: number; snapshotEntities: number; uncoveredSubjects: number; excludedPaths: number; stale: boolean };
}

interface SystemMapEntity {
  id: string;
  kind: string;
  name: string;
  language?: string;
  location?: { path: string; range?: { start: { line: number; column: number }; end: { line: number; column: number } } };
  evidenceIds: string[];
}

interface SystemMapRelation {
  id: string;
  source: string;
  target: string;
  kind: string;
  confidence?: number;
  evidenceIds: string[];
}

interface SystemMapEvidence {
  id: string;
  sourceKind: string;
  provenance: 'extracted' | 'inferred' | 'declared';
  path?: string;
  range?: { start: { line: number; column: number }; end: { line: number; column: number } };
  summary?: string;
}

interface SystemMapSummary {
  id: string;
  snapshotId: string;
  algorithmVersion: string;
  derivedAt: string;
  authority: { kind: 'derived'; accepted: false; statement: string };
  source: {
    snapshotStatus: 'complete' | 'partial';
    freshness: { state: string; checkedAt: string; reason?: string };
    analyzer: { id: string; name: string; version: string };
    manifestDigest: string;
  };
  counts: { entities: number; relations: number; evidence: number; groups: number };
  coverage: {
    mappedEntities: number;
    selectedEntities: number;
    totalSnapshotEntities: number;
    selectedRelations: number;
    totalSnapshotRelations: number;
    excludedPaths: number;
    counts: Record<string, number>;
    subjects: Array<{ id: string; subject: string; status: string; summary: string; evidenceIds: string[] }>;
  };
  lenses: Array<{ id: SystemMapLens; status: 'available' | 'partial' | 'unsupported'; summary: string; groupIds: string[]; relationKinds: string[]; gaps: string[] }>;
  diagnostics: Array<{ code: string; severity: 'info' | 'warning' | 'error'; message: string; path?: string; source?: string }>;
}

interface SystemMapQueryResult {
  mapId: string;
  snapshotId: string;
  groups: SystemMapGroup[];
  entities: SystemMapEntity[];
  relations: SystemMapRelation[];
  evidence: SystemMapEvidence[];
  aggregates: Record<string, Array<{ key: string; count: number }>> | null;
  diagnostics: Array<{ code: string; severity: string; message: string }>;
  truncated: boolean;
  authority: SystemMapSummary['authority'];
}

interface SystemMapComparison {
  noChange: boolean;
  causes: string[];
  content: { manifestChanged: boolean; added: string[]; removed: string[]; changed: string[]; moved: Array<{ from: string; to: string }> ; truncated: boolean };
  analyzer: { changed: boolean; from: { id: string; name: string; version: string }; to: { id: string; name: string; version: string } };
  observed: Record<'entities' | 'relations' | 'evidence', { added: string[]; removed: string[]; changed: string[] }>;
  inference: { added: string[]; removed: string[]; changed: string[] };
  authority: SystemMapSummary['authority'];
}

type ReconciliationDecisionState = 'open' | 'dismissed' | 'deferred' | 'accepted-for-planning';

interface ReconciliationFinding {
  id: string;
  kind: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  summary: string;
  detail: string;
  subject: { kind: string; id: string; label: string };
  confidence: { score: number; level: 'high' | 'medium' | 'low'; reasons: string[] };
  provenance: { kind: 'observed' | 'inferred' | 'declared'; snapshotIds: string[]; analyzerIds: string[]; explanation: string };
  evidence: { ids: string[]; paths: string[] };
  alternatives: Array<{ summary: string; evidenceIds: string[] }>;
  guidance: string;
  affected: { productClaims: string[]; components: string[]; fronts: string[]; runs: string[] };
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  active: boolean;
  disposition: ReconciliationDecisionState;
  dispositionRecord: { rationale?: string; reconsiderAfter?: string | null } | null;
}

interface ReconciliationSummary {
  repositoryId: string;
  lastCycle: {
    id: string; createdAt: string; cause: string;
    from: { snapshotId: string }; to: { snapshotId: string };
    summary: { noChange: boolean; findings: number; newFindings: number; bounded: boolean; bySeverity: Record<string, number>; stale: Record<string, number> };
    diagnostics: Array<{ code: string; severity: string; message: string }>;
  } | null;
  findings: { active: number; open: number; bySeverity: Record<string, number>; byDisposition: Record<string, number> };
  pendingTriggers: number;
  activeJobs: number;
  authority: { kind: 'derived'; accepted: false };
}

interface ReconciliationCycle {
  id: string;
  createdAt: string;
  findings: ReconciliationFinding[];
  summary: ReconciliationSummary['lastCycle'] extends infer T ? T extends { summary: infer S } ? S : never : never;
  authority: { kind: 'derived'; accepted: false; statement: string };
}

interface ReconciliationJob {
  id: string;
  analysisJobId: string;
  state: 'running' | 'reconciling' | 'complete' | 'failed' | 'cancelled' | 'stale';
  progress: number;
  stage: string;
  message: string;
  updatedAt: string;
  cycleId: string | null;
  error: { code?: string; message?: string } | null;
}

interface ReconciliationTrigger {
  id: string;
  cause: string;
  sourceId: string;
  message: string;
  state: 'pending' | 'addressed';
  createdAt: string;
}

type LearningProposalState = 'open' | 'dismissed' | 'deferred' | 'accepted-for-draft' | 'stale' | 'expired';
type LearningDraftKind = 'product-direction' | 'component-design' | 'front-design';

interface LearningRoutedDraft {
  kind: LearningDraftKind;
  draftId: string;
  draftRevision: string;
  componentDraftId?: string;
  componentDraftRevision?: string;
  validated: true;
  publicationRequired: true;
  contractMutation?: false;
  at?: string;
}

interface LearningProposal {
  schemaVersion: 1;
  id: string;
  revision: string;
  rank: number;
  state: LearningProposalState;
  createdAt: string;
  lastSeen: string;
  expiresAt: string;
  occurrences: number;
  summary: string;
  detail: string;
  cause: {
    kind: string;
    id: string;
    sourceState: string;
    at: string;
    verified: boolean;
    authority: { provenance: 'observed' | 'inferred' | 'declared'; trustedAsFact: boolean };
  };
  target: { kind: 'product-assumption' | 'component' | 'front' | 'new-front'; id: string; revision: string | null; exists: boolean; leadComponent?: string | null };
  changes: Array<{
    field: string;
    operation: 'append' | 'review' | 'create' | string;
    proposedValue: unknown;
    reason: string;
    beforeDigest: string;
    afterDigest: string;
    beforeSummary: string;
  }>;
  affected: { goals: string[]; components: string[]; fronts: string[]; runs: string[] };
  evidence: { references: string[]; paths: string[] };
  confidence: { score: number; reasons: string[] };
  decisionMemory: { state?: string; rationale?: string; reconsiderAfter?: string | null; decisionId?: string } | null;
  decision: { state: string; rationale: string; reconsiderAfter: string | null; at: string } | null;
  routedDraft: LearningRoutedDraft | null;
  contradictions: string[];
  staleReasons: string[];
  authority: { accepted: false; contractMutation: false; statement: string };
}

interface LearningFeedback {
  id: string;
  proposalId: string;
  proposalRevision: string;
  signal: 'useful' | 'not-useful';
  reasonCode: string;
  rationale: string;
  createdAt: string;
  privacy: { localOnly: true; exported: boolean };
}

interface LearningSummary {
  schemaVersion: 1;
  repositoryId: string;
  updatedAt: string;
  proposals: { total: number; open: number; stale: number; contradictions: number; byState: Record<LearningProposalState, number> };
  feedback: { total: number; useful: number; notUseful: number };
  authority: { localOnly: true; acceptedMutation: false; automaticExport: false };
}

interface LearningExportPreview {
  id: string;
  purpose: string;
  feedbackIds: string[];
  payload: Record<string, unknown>;
  revision: string;
  createdAt: string;
  expiresAt: string;
}

type PlanningOperation = 'component-design' | 'front-design' | 'portfolio-review';
type PlanningJobState = 'queued' | 'running' | 'cancelled' | 'failed' | 'complete';

interface PlanningAdapterDescriptor {
  id: string;
  name: string;
  version: string;
  provider: { id: string; name: string };
  authentication: { owner: string; method: string; credentialsStoredByHandraise: false };
  capabilities: {
    operations: PlanningOperation[];
    structuredOutput: boolean;
    toolFreeInvocation: boolean;
    cancellation: boolean;
    usage: string[];
    cost: boolean;
    boundedContext: boolean;
  };
  dataBoundary: { kind: 'local' | 'cloud'; destination: string; sourceMayLeaveHost: boolean; requiresConsent: boolean };
  models: Array<{ id: string; label: string; default: boolean }>;
  degradation: { fallback: 'deterministic-manual'; summary: string };
  availability?: {
    available: boolean;
    code?: string;
    reason?: string;
    binary?: string;
    version?: string;
    supportedVersions?: string;
    isolation?: string;
    authentication?: { connected?: boolean | null; owner?: string; safelyReusable?: boolean };
    capabilities?: Record<string, unknown>;
  };
}

interface PlanningPreflight {
  id: string;
  repositoryId: string;
  operation: PlanningOperation;
  adapter: PlanningAdapterDescriptor;
  availability: PlanningAdapterDescriptor['availability'];
  model: string;
  createdAt: string;
  expiresAt: string;
  context: {
    digest: string;
    snapshot: { id: string; status: string; freshness: string } | null;
    product: { revision: string; title: string } | null;
    counts: { sources: number; bytes: number; evidenceIds: number };
    diagnostics: Array<{ code: string; message: string }>;
  };
  sources: Array<{
    id: string; kind: 'graph-query' | 'evidence' | 'product' | 'portfolio' | 'human'; title: string;
    snippet: string; bytes: number; digest: string; provenance: string; evidenceIds: string[];
  }>;
  dataBoundary: PlanningAdapterDescriptor['dataBoundary'];
  consent: { required: boolean; granted: false; statement: string };
  mutation: { repository: false; privateRuntimeStateOnly: true };
  fallback: { kind: 'deterministic-manual'; available: true; summary: string };
}

interface PlanningJob {
  id: string;
  repositoryId: string;
  preflightId: string;
  operation: PlanningOperation;
  adapterId: string;
  provider: { id: string; name: string };
  model: string;
  state: PlanningJobState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  stage: string;
  progress: number;
  message: string;
  attempts: number;
  repairs: number;
  usage: Record<string, number> | null;
  cost: number | null;
  resultAvailable: boolean;
  error: { code?: string; message?: string; retryable?: boolean } | null;
  dataBoundary: PlanningAdapterDescriptor['dataBoundary'];
  context: { digest: string; counts: { sources: number; bytes: number; evidenceIds: number }; snapshot: unknown; product: unknown };
  fallback: { kind: 'deterministic-manual'; available: true; summary: string };
  events: Array<{ stage: string; at: string; progress: number; message: string }>;
}

interface PlanningGrounding {
  evidenceIds: string[];
  uncertainty: 'low' | 'medium' | 'high' | 'unknown';
  assumptions: string[];
  questions: string[];
}

interface PlanningResult {
  schemaVersion: 1;
  operation: PlanningOperation;
  summary: string;
  components: Array<PlanningGrounding & {
    slug: string; title: string; responsibility: string; outcomes: string[]; responsibilities: string[]; limits: string[];
    invariants: string[]; interfaces: string[]; dependencies: string[]; dataSystems: string[]; territory: string[]; verification: string[];
  }>;
  fronts: Array<PlanningGrounding & {
    slug: string; title: string; componentSlug: string; objective: string; motivation: string; scope: string; nonGoals: string[];
    readiness: string[]; acceptanceCriteria: string[]; verification: string[]; deliverables: string[]; risks: string[];
    dependencies: string[]; affectedComponents: string[]; goalIds: string[];
  }>;
  findings: Array<PlanningGrounding & {
    id: string; title: string; kind: string; description: string; recommendation: string;
  }>;
  assumptions: string[];
  questions: string[];
}

type ComponentDesignField = 'purpose' | 'outcomes' | 'responsibilities' | 'limits' | 'invariants' | 'interfaces' | 'dependencies' | 'dataSystems' | 'territory' | 'verification' | 'evidence' | 'uncertainties' | 'guidance';

interface ComponentFieldGrounding {
  evidenceIds: string[];
  intentIds: string[];
  assumptions: string[];
  questions: string[];
}

interface ComponentDesignCandidate {
  id: string;
  slug: string;
  title: string;
  state: 'active';
  order: number;
  origin: 'generated' | 'accepted' | 'model' | 'manual';
  memberEntityIds: string[];
  contract: {
    purpose: string;
    outcomes: string[];
    responsibilities: string[];
    limits: string[];
    invariants: string[];
    interfaces: Array<{ kind: 'provides' | 'consumes'; target: string; description: string }>;
    dependencies: Array<{ kind: 'hard' | 'soft' | 'external'; target: string; reason: string }>;
    dataSystems: string[];
    territory: string[];
    verification: string[];
    evidence: Array<{ kind: 'extracted' | 'inferred' | 'declared'; reference: string; reason: string }>;
    uncertainties: string[];
    guidance: string;
  };
  fieldGrounding: Record<ComponentDesignField, ComponentFieldGrounding>;
  lockedFields: ComponentDesignField[];
}

interface ComponentDesignQuality {
  coverage: { ratio: number; coveredEntities: number; totalEntities: number; orphanEntityIds: string[] };
  overlap: { entities: number; examples: Array<{ entityId: string; owners: string[] }> };
  cohesion: { ratio: number | null; internalRelations: number; crossingRelations: number };
  coupling: { crossingRelations: number; ratio: number | null };
  duplicateResponsibilities: Array<{ responsibility: string; owners: string[] }>;
  dependencyCycles: string[][];
  unstableBoundaries: string[];
  diagnostics: Array<{ code: string; severity: 'info' | 'warning' | 'error'; path: string; message: string; details?: unknown }>;
  gateC: { pass: boolean; hardFailures: number; evidenceFailures: number; minimumCoverage: number; measuredCoverage: number; statement: string };
  stale?: boolean;
}

interface ComponentDesignAlternative {
  id: string;
  strategy: 'responsibility' | 'hybrid' | 'existing' | 'model' | 'manual';
  title: string;
  summary: string;
  rationale: string[];
  tradeoffs: { strengths: string[]; risks: string[]; bestWhen: string[] };
  components: ComponentDesignCandidate[];
  quality: ComponentDesignQuality;
  generatedBy: { kind: 'deterministic' | 'model' | 'human'; adapterId: string | null; model: string | null };
}

interface ComponentDesignDraft {
  schemaVersion: 1;
  id: string;
  repositoryId: string;
  state: 'review' | 'skipped';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  source: {
    contextIdentity: string; analysisJobId: string; planningJobId: string | null; snapshotId: string; mapId: string;
    snapshot: { status: string; freshness: { state: string }; analyzer: { id: string; version: string } };
    productRevision: string | null; productIncluded: boolean; modelIncluded: boolean; portfolioRevision: string;
  };
  stale: boolean;
  staleReasons: string[];
  selectedAlternativeId: string;
  alternatives: ComponentDesignAlternative[];
  questions: Array<{ id: string; question: string; why: string; affects: ComponentDesignField[]; state: 'open' | 'answered'; answer: string }>;
  lockedDecisions: Array<{ id: string; componentId: string; componentSlug: string; field: ComponentDesignField; valueDigest: string; reason: string }>;
  history: Array<{ id: string; at: string; operation: string; summary: string; beforeRevision?: string; afterRevision?: string }>;
  revision: string;
  mutation: { repository: false; privateDraftOnly: true; publicationAvailableHere: false };
}

interface ComponentDesignComparison {
  left: { id: string; title: string; strategy: string };
  right: { id: string; title: string; strategy: string };
  components: { added: string[]; removed: string[]; changed: string[] };
  movedEntities: Array<{ entityId: string; from: string | null; to: string | null }>;
  quality: { left: ComponentDesignQuality; right: ComponentDesignQuality };
  materiallyDifferent: boolean;
}

type FrontDesignField = 'outcome' | 'leadComponent' | 'affectedComponents' | 'motivation' | 'scope' | 'nonGoals' | 'dependencies' | 'readiness' | 'acceptanceCriteria' | 'verification' | 'deliverables' | 'risks' | 'unknowns' | 'evidence' | 'tasks' | 'context' | 'handoff';

interface FrontFieldGrounding {
  evidenceIds: string[];
  goalIds: string[];
  componentSlugs: string[];
  assumptions: string[];
  questions: string[];
}

interface FrontDesignCandidate {
  id: string;
  slug: string;
  title: string;
  state: FrontState;
  order: number;
  origin: 'generated' | 'accepted' | 'model' | 'manual';
  candidateKind: 'implementation' | 'research' | 'decision' | 'validation' | 'migration';
  leadComponent: string;
  affectedComponents: string[];
  goalIds: string[];
  analysisSnapshot: string | null;
  outcome: string;
  motivation: string;
  scope: string;
  nonGoals: string[];
  dependencies: Array<{ kind: 'hard' | 'coordination' | 'informational'; target: string; reason: string }>;
  readiness: string[];
  acceptanceCriteria: string[];
  verification: string[];
  deliverables: string[];
  risks: string[];
  unknowns: string[];
  evidence: Array<{ kind: 'extracted' | 'inferred' | 'declared'; reference: string; reason: string }>;
  tasks: Array<{ state: 'open' | 'done' | 'skipped'; text: string }>;
  context: string;
  handoff: string;
  fieldGrounding: Record<FrontDesignField, FrontFieldGrounding>;
  lockedFields: FrontDesignField[];
}

interface FrontDesignQuality {
  goalCoverage: { selectedGoalId: string; covered: boolean; coveredGoalIds: string[]; uncoveredGoalIds: string[] };
  duplicateOutcomes: Array<{ outcome: string; owners: string[] }>;
  dependencyCycles: string[][];
  readySet: string[];
  criticalPath: string[];
  parallelism: {
    safePairs: Array<{ left: string; right: string }>;
    collisions: Array<{ left: string; right: string; sharedComponents: string[]; sharedTerritory: string[] }>;
    maximumReady: number;
  };
  broadFronts: string[];
  diagnostics: Array<{ code: string; severity: 'info' | 'warning' | 'error'; path: string; message: string; details?: unknown }>;
  feedback: { firstOutcomeDepth: number; criticalPathLength: number; independentOutcomeSlices: number };
  risk: { explicitRisks: number; explicitUnknowns: number };
  gateD: { pass: boolean; hardFailures: number; statement: string };
}

interface FrontDesignAlternative {
  id: string;
  strategy: 'outcome-slices' | 'risk-first' | 'existing' | 'model' | 'manual';
  title: string;
  summary: string;
  rationale: string[];
  tradeoffs: { strengths: string[]; risks: string[]; bestWhen: string[] };
  fronts: FrontDesignCandidate[];
  quality: FrontDesignQuality;
  generatedBy: { kind: 'deterministic' | 'model' | 'human'; adapterId: string | null; model: string | null };
}

interface FrontDesignDraft {
  schemaVersion: 1;
  id: string;
  repositoryId: string;
  state: 'review' | 'skipped';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  source: {
    contextIdentity: string; analysisJobId: string; planningJobId: string | null; snapshotId: string; mapId: string;
    componentDraftId: string; componentDraftRevision: string; componentAlternativeId: string; componentRevision: string;
    goal: ProductGoal & { manual?: boolean }; productRevision: string | null; portfolioRevision: string;
    repository: { id: string; adapter: string }; productIncluded: boolean; modelIncluded: boolean; componentDraftStale?: boolean;
  };
  stale: boolean;
  staleReasons: string[];
  selectedAlternativeId: string;
  alternatives: FrontDesignAlternative[];
  questions: Array<{ id: string; question: string; why: string; affects: FrontDesignField[]; state: 'open' | 'answered'; answer: string }>;
  lockedDecisions: Array<{ id: string; frontId: string; frontSlug: string; field: FrontDesignField; valueDigest: string; reason: string }>;
  diagnostics: Array<{ code: string; severity: string; message: string }>;
  history: Array<{ id: string; at: string; operation: string; summary: string; beforeRevision?: string; afterRevision?: string; details?: unknown }>;
  revision: string;
  mutation: { repository: false; worktrees: false; agents: false; privateDraftOnly: true; publicationAvailableHere: false };
}

interface FrontDesignComparison {
  left: { id: string; title: string; strategy: string };
  right: { id: string; title: string; strategy: string };
  fronts: { added: string[]; removed: string[]; changed: string[] };
  dependencies: { left: string[]; right: string[] };
  quality: { left: FrontDesignQuality; right: FrontDesignQuality };
  materiallyDifferent: boolean;
}

interface FrontPlanningLaunch {
  repositoryId: string;
  componentDraftId?: string;
  componentAlternativeId?: string;
  frontDraftId?: string;
}

type PublicationMode = 'components-only' | 'product-components' | 'complete-plan';

interface PublicationOperation {
  id: string;
  kind: 'project' | 'metadata' | 'product' | 'component' | 'front' | 'audit';
  slug: string;
  action: 'create' | 'update' | 'delete';
  relativePath: string;
  before: string | null;
  after: string | null;
  beforeRevision: string | null;
  afterRevision: string | null;
}

interface PublicationManifest {
  id: string;
  repositoryId: string;
  adapter: 'handraise' | 'uninitialized';
  state: 'review' | 'committing' | 'committed' | 'conflict' | 'failed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  selection: {
    mode: PublicationMode; includeProduct: boolean; includeComponents: true; includeFronts: boolean;
    deleteAbsentComponents: boolean; deleteAbsentFronts: boolean; allowCompletedDeletes: boolean;
  };
  source: {
    componentDraftId: string; componentDraftRevision: string; componentAlternativeId: string;
    frontDraftId: string | null; frontDraftRevision: string | null; frontAlternativeId: string | null;
    productDraftId: string | null; productDraftRevision: string | null; snapshotId: string; snapshotManifestDigest: string;
    analyzer?: { id: string; version: string } | null;
  };
  publicationDigest: string;
  revision: string;
  noOp: boolean;
  canPublish: boolean;
  summary: { creates: number; updates: number; deletes: number; files: number; bytes: number; errors: number; warnings: number };
  validation: { valid: boolean; diagnostics: Array<{ code: string; severity: 'error' | 'warning'; path: string; message: string }> };
  relationships: {
    components: Array<{ slug: string; action: 'create' | 'update' | 'delete'; before: unknown; after: unknown }>;
    fronts: Array<{ slug: string; action: 'create' | 'update' | 'delete'; before: unknown; after: unknown }>;
  };
  operations: PublicationOperation[];
  result: {
    committed: true; publicationId: string; publicationDigest: string; committedAt: string; auditPath: string | null;
    artifacts: Array<{ kind: string; slug: string; action: string; path: string; revision: string | null }>;
  } | null;
  failure?: { code: string; message: string; at: string; recoveryRequired: boolean } | null;
}

interface PublicationLaunch {
  repositoryId: string;
  componentDraftId?: string;
  componentAlternativeId?: string;
  frontDraftId?: string;
  frontAlternativeId?: string;
  mode?: PublicationMode;
}

interface AgentConfig {
  title: string;
  binary: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  model: string;
  effort: string;
  efforts: string[];
  auth: {
    connected: boolean;
    provider: string | null;
    email: string | null;
    plan: string | null;
    loginCommand: string;
    logoutCommand: string;
  };
  capabilities: {
    terminal: boolean;
    lifecycleAttention: boolean;
    typedPermissions: boolean;
    gracefulWrapup: boolean;
    configured: boolean;
    setup: string | null;
  };
}

interface Settings {
  agents: Record<string, AgentConfig>;
  hooks: {
    repairNeeded: boolean;
    sourceCurrent: boolean;
    version: number | null;
    expectedVersion: number;
    claude: { configured: boolean; path: string };
    codex: { configured: boolean; path: string; trustReview: string };
  };
  platform: {
    desktopNotifications: { available: boolean; provider: string | null; optional: boolean; reason: string | null };
  };
  quality?: {
    benchmarkVersion: string;
    corpusVersion: string;
    status: 'pass' | 'fail' | 'blocked' | 'unverified';
    promotionAllowed: boolean;
    automatedPass: boolean;
    humanStatus: 'pass' | 'fail' | 'blocked' | 'unverified';
    generatedAt: string | null;
    limitations: string[];
  };
  repositories: Array<Pick<Repository, 'id' | 'name' | 'path' | 'adapter' | 'availability'> & {
    defaultAgent: string | null;
    model: string;
    effort: string;
  }>;
}

interface AuthStatus {
  authenticated: boolean;
  needsSetup: boolean;
  implicitLocal?: boolean;
  device: { id: string; name: string; kind?: string; implicit?: boolean; revocable?: boolean } | null;
}

type ClientState =
  | { kind: 'loading' }
  | { kind: 'offline'; detail: string }
  | { kind: 'not-ready'; detail: string }
  | { kind: 'unpaired'; auth: AuthStatus }
  | { kind: 'expired'; auth: AuthStatus }
  | { kind: 'authenticated'; auth: AuthStatus };

interface ReadinessStatus { ready: boolean }

class ApiError extends Error {
  status: number | null;
  network: boolean;
  code: string | null;
  details: unknown;

  constructor(message: string, {
    status = null, network = false, code = null, details = null,
  }: { status?: number | null; network?: boolean; code?: string | null; details?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.network = network;
    this.code = code;
    this.details = details;
  }
}

const baseRoute = (view: View = 'repositories'): RouteState => ({
  view, repositoryId: null, componentSlug: null, frontSlug: null, releaseSlug: null, sessionSlug: null,
});

function parseRoute(pathname = window.location.pathname): RouteState {
  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] === 'settings') return baseRoute('settings');
  if (parts[0] !== 'repositories' || !parts[1]) return baseRoute();
  const repositoryId = parts[1];
  if (!parts[2]) return { ...baseRoute('overview'), repositoryId };
  if (parts[2] === 'sessions') {
    return { ...baseRoute('sessions'), repositoryId, sessionSlug: parts[3] || null };
  }
  if (parts[2] === 'releases') return { ...baseRoute('releases'), repositoryId, releaseSlug: parts[3] || null };
  if (parts[2] === 'ad-hoc') return { ...baseRoute('ad-hoc'), repositoryId };
  if (parts[2] === 'map') return { ...baseRoute('map'), repositoryId };
  const componentSlug = parts[2] === 'components' ? parts[3] || null : null;
  const frontSlug = parts[4] === 'fronts' ? parts[5] || null : null;
  return { ...baseRoute('components'), repositoryId, componentSlug, frontSlug };
}

function routePath(route: RouteState): string {
  if (route.view === 'settings') return '/settings';
  if (!route.repositoryId || route.view === 'repositories') return '/repositories';
  const root = `/repositories/${encodeURIComponent(route.repositoryId)}`;
  if (route.view === 'overview') return root;
  if (route.view === 'sessions') {
    return `${root}/sessions${route.sessionSlug ? `/${encodeURIComponent(route.sessionSlug)}` : ''}`;
  }
  if (route.view === 'releases') return `${root}/releases${route.releaseSlug ? `/${encodeURIComponent(route.releaseSlug)}` : ''}`;
  if (route.view === 'ad-hoc') return `${root}/ad-hoc`;
  if (route.view === 'map') return `${root}/map`;
  const component = route.componentSlug ? `/${encodeURIComponent(route.componentSlug)}` : '';
  const front = route.frontSlug ? `/fronts/${encodeURIComponent(route.frontSlug)}` : '';
  return `${root}/components${component}${front}`;
}

function RouteLink({ to, onNavigate, className, children, ariaLabel, ariaCurrent }: {
  to: RouteState;
  onNavigate: (route: RouteState) => void;
  className?: string;
  children: preact.ComponentChildren;
  ariaLabel?: string;
  ariaCurrent?: 'page';
}) {
  return <a class={className} href={routePath(to)} aria-label={ariaLabel} aria-current={ariaCurrent} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(to);
  }}>{children}</a>;
}

function BreadcrumbTrail({ items, onNavigate }: {
  items: Array<{ label: string; to?: RouteState }>;
  onNavigate: (route: RouteState) => void;
}) {
  return <nav class="breadcrumbs" aria-label="Breadcrumb">{items.map((item, index) => <span class="breadcrumb-item" key={`${index}:${item.label}`}>
    {index > 0 && <i aria-hidden="true">/</i>}
    {item.to ? <RouteLink to={item.to} onNavigate={onNavigate}>{item.label}</RouteLink> : <b aria-current="page">{item.label}</b>}
  </span>)}</nav>;
}

const STATUS_LABEL: Record<Status, string> = {
  error: 'Failed',
  blocked: 'Needs you',
  waiting: 'Waiting',
  pausing: 'Pausing',
  wrapping: 'Wrapping up',
  working: 'Working',
  paused: 'Paused',
};

type ThemeName = 'orange' | 'coral' | 'indigo';
type ColorMode = 'light' | 'dark';
const THEMES: Array<{ id: ThemeName; title: string }> = [
  { id: 'orange', title: 'Orange' },
  { id: 'coral', title: 'Coral' },
  { id: 'indigo', title: 'Indigo' },
];

function savedTheme(): ThemeName {
  if (typeof window === 'undefined') return 'indigo';
  const value = window.localStorage.getItem('handraise-theme');
  return THEMES.some((theme) => theme.id === value) ? value as ThemeName : 'indigo';
}

function savedColorMode(): ColorMode {
  if (typeof window === 'undefined') return 'light';
  return window.localStorage.getItem('handraise-color-mode') === 'dark' ? 'dark' : 'light';
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: options?.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'The Handraise server is unavailable.',
      { network: true },
    );
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; code?: string; details?: unknown };
    if (response.status === 401) window.dispatchEvent(new CustomEvent('handraise:unauthorized'));
    throw new ApiError(payload.error || response.statusText, {
      status: response.status, code: payload.code || null, details: payload.details ?? null,
    });
  }
  return response.json() as Promise<T>;
}

function age(seconds: number): string {
  if (!seconds) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function plainCopy(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*[-#>]\s*/gm, '')
    .trim();
}

function permissionSummary(permission: Permission): string {
  const input = permission.tool?.input ?? {};
  const value = input.command ?? input.file_path ?? input.url;
  return typeof value === 'string' ? value : JSON.stringify(input, null, 1);
}

function safePermissionValue(value: unknown, key = ''): unknown {
  if (/pass(word)?|token|secret|api[_-]?key|authorization|cookie|credential/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => safePermissionValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, safePermissionValue(child, childKey)]));
  }
  return value;
}

function PermissionRequest({ permission }: { permission: Permission }) {
  const [deciding, setDeciding] = useState<'allow' | 'deny' | null>(null);

  const decide = async (behavior: 'allow' | 'deny') => {
    const message = behavior === 'deny'
      ? window.prompt('Optional reason for the agent (Cancel keeps the request pending):', '')
      : '';
    if (message === null) return;
    setDeciding(behavior);
    try {
      await api(`/api/permission/${encodeURIComponent(permission.key)}`, {
        method: 'POST',
        body: JSON.stringify({ id: permission.id, behavior, message }),
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setDeciding(null);
    }
  };

  return (
    <section class="permission" aria-label="Permission request">
      <div class="permission-title">
        {permission.tool?.name || 'Tool'} · waiting {age(permission.waitingSeconds)}
      </div>
      <code>{permissionSummary(permission)}</code>
      <details class="permission-details"><summary>Review complete request</summary><pre>{JSON.stringify(safePermissionValue(permission.tool?.input || {}), null, 2)}</pre>{Boolean(permission.suggestions?.length) && <><b>Agent suggestions</b><pre>{JSON.stringify(safePermissionValue(permission.suggestions), null, 2)}</pre></>}</details>
      <div class="button-row">
        <button class="primary" disabled={deciding !== null} onClick={() => void decide('allow')}>
          {deciding === 'allow' ? 'Allowing…' : 'Allow once'}
        </button>
        <button class="danger" disabled={deciding !== null} onClick={() => void decide('deny')}>
          {deciding === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </div>
    </section>
  );
}

function SessionCard({ session, onOpen }: { session: AgentSession; onOpen?: () => void }) {
  const openFromKey = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen?.();
    }
  };

  return (
    <article
      class={`session-card ${session.status}`}
      tabIndex={onOpen ? 0 : undefined}
      role={onOpen ? 'button' : undefined}
      aria-label={onOpen ? `Open ${session.slug}, ${STATUS_LABEL[session.status]}` : `${session.slug}, ${STATUS_LABEL[session.status]}`}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('button')) onOpen?.();
      }}
      onKeyDown={openFromKey}
    >
      <div class="card-heading">
        <span class="session-name"><i class="state-dot" aria-hidden="true" />{session.slug}</span>
        <span class="status-label">
          {STATUS_LABEL[session.status]}{session.waitingSeconds ? ` · ${age(session.waitingSeconds)}` : ''}
        </span>
      </div>
      <div class="session-meta">
        {[session.cwd, session.git?.available && session.git.branch ? `branch ${session.git.branch}` : null, session.git?.dirty ? `${session.git.dirty} dirty` : null, session.git?.unbacked ? `${session.git.unbacked} unbacked` : null, session.activity ? `active ${session.activity.minutesAgo}m ago` : null]
          .filter(Boolean).join(' · ')}
      </div>
      {session.status !== 'blocked' && session.reason && <div class="session-meta">{session.reason}</div>}
      {session.permission && <PermissionRequest permission={session.permission} />}
      <footer class="card-footer">
        <span>{session.role === 'manager' ? `Director · ${session.agent}` : session.role === 'setup' ? `Account setup · ${session.agent}` : session.role === 'ad-hoc' ? `Ad-hoc · unplanned · ${session.agent}` : session.agent || 'agent'}</span>
        <span class="open-label">{session.controllable ? 'Open session →' : 'View session →'}</span>
      </footer>
    </article>
  );
}

interface SessionDrawerProps {
  session: AgentSession | null;
  onClose: () => void;
  frontRoute?: RouteState;
  onNavigate: (route: RouteState) => void;
  onRetry: (session: AgentSession) => Promise<void>;
  onStopped: () => void;
}

function SessionDrawer({ session, onClose, frontRoute, onNavigate, onRetry, onStopped }: SessionDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const terminalRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const [pane, setPane] = useState('');
  const [paneError, setPaneError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const setupSession = session?.role === 'setup';
  const setupTitle = session?.agent === 'claude' ? 'Claude Code account setup' : session?.agent === 'codex' ? 'Codex account setup' : 'Agent account setup';

  const refreshPane = useCallback(async () => {
    if (!session?.controllable) return;
    try {
      const result = await api<{ html: string }>(`/api/session/${encodeURIComponent(session.controlSlug)}/pane?lines=400`);
      const terminal = terminalRef.current;
      const atBottom = terminal
        ? terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 40
        : true;
      setPaneError('');
      setPane(result.html);
      requestAnimationFrame(() => {
        const current = terminalRef.current;
        if (current && (pinned.current || atBottom)) current.scrollTop = current.scrollHeight;
      });
    } catch (error) {
      setPane('');
      setPaneError(String(error instanceof Error ? error.message : error));
    }
  }, [session]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (session && dialog && !dialog.open) {
      dialog.showModal();
      if (session.controllable) {
        void refreshPane();
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
    if (!session && dialog?.open) dialog.close();
  }, [session, refreshPane]);

  useEffect(() => {
    if (!session?.controllable) return;
    const timer = window.setInterval(() => void refreshPane(), 1200);
    return () => window.clearInterval(timer);
  }, [session, refreshPane]);

  const sendKey = async (key: string) => {
    if (!session) return;
    try {
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}/key`, {
        method: 'POST', body: JSON.stringify({ key }),
      });
      window.setTimeout(() => void refreshPane(), 220);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const sendMessage = async () => {
    if (!session || !message) return;
    const text = message;
    setMessage('');
    try {
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}/text`, {
        method: 'POST', body: JSON.stringify({ text }),
      });
      window.setTimeout(() => void refreshPane(), 220);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setMessage(text);
    }
  };

  const wrapUp = async () => {
    if (!session || !window.confirm(`Ask ${session.slug} to wrap up? It will finish its turn and save a handoff.`)) return;
    try {
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}/wrapup`, {
        method: 'POST', body: '{}',
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const lifecycle = async (action: 'pause' | 'resume') => {
    if (!session) return;
    if (action === 'pause' && !window.confirm(`Pause ${session.slug} safely? The agent will save a handoff and stop starting new work.`)) return;
    setBusy(action);
    try {
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}/${action}`, {
        method: 'POST', body: '{}',
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const stop = async () => {
    if (!session || !window.confirm(setupSession
      ? `Cancel ${setupTitle}? You can restart sign-in from Settings.`
      : `Stop ${session.slug} immediately? Unsaved agent work may be lost.`)) return;
    setBusy('stop');
    try {
      await api(`/api/session/${encodeURIComponent(session.controlSlug)}`, { method: 'DELETE' });
      onStopped();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setBusy('');
    }
  };

  const retry = async () => {
    if (!session) return;
    setBusy('retry');
    try {
      await onRetry(session);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onClose} onCancel={onClose}>
      <div class="drawer">
        <header class="drawer-header">
          <div class="drawer-identity">
            <strong>{setupSession ? setupTitle : session?.slug}</strong>
            <small>{[setupSession ? 'Credentials stay with the CLI' : session?.agent, session?.attached ? 'also attached in a terminal' : null, session?.cwd].filter(Boolean).join(' · ')}</small>
            {session?.git?.available && <small>{[session.git.branch, session.git.dirty ? `${session.git.dirty} dirty` : 'clean', session.git.ahead ? `${session.git.ahead} ahead` : null, session.git.behind ? `${session.git.behind} behind` : null, session.git.unbacked ? `${session.git.unbacked} only on this machine` : null].filter(Boolean).join(' · ')}</small>}
          </div>
          <div class="button-row">
            {frontRoute && <RouteLink className="button-link" to={frontRoute} onNavigate={onNavigate}>View front</RouteLink>}
            {session?.controllable && session.status === 'error' && <button class="primary" disabled={Boolean(busy)} onClick={() => void retry()}>{busy === 'retry' ? 'Restarting…' : 'Retry'}</button>}
            {session?.controllable && !setupSession && ['paused', 'pausing'].includes(session.status) && <button class="primary" disabled={Boolean(busy)} onClick={() => void lifecycle('resume')}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>}
            {session?.controllable && !setupSession && !['error', 'paused', 'pausing', 'wrapping'].includes(session.status) && <button disabled={Boolean(busy)} onClick={() => void lifecycle('pause')}>{busy === 'pause' ? 'Requesting…' : 'Pause'}</button>}
            {session?.controllable && !setupSession && !['error', 'wrapping'].includes(session.status) && <button disabled={Boolean(busy)} onClick={() => void wrapUp()}>Wrap up</button>}
            {session?.controllable && <button class="danger" disabled={Boolean(busy)} onClick={() => void stop()}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>}
            <button onClick={onClose}>Close</button>
          </div>
        </header>
        {session?.controllable ? <pre
            ref={terminalRef}
            class="terminal"
            onScroll={(event) => {
              const node = event.currentTarget;
              pinned.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 40;
            }}
          >
            {paneError || <span dangerouslySetInnerHTML={{ __html: pane }} />}
          </pre> : <section class="external-session-detail">
            <p class="section-kicker">External session</p>
            <h2>{STATUS_LABEL[session?.status || 'paused']}</h2>
            <p>{session?.reason || 'This lane was registered outside Handraise.'}</p>
            <dl>
              <div><dt>Component</dt><dd>{session?.component || 'Unassigned'}</dd></div>
              <div><dt>Front</dt><dd>{session?.front || session?.slug}</dd></div>
              <div><dt>Worktree</dt><dd>{session?.cwd || 'Unknown'}</dd></div>
            </dl>
            <small>This session is visible but read-only because it was not started in a Handraise-controlled tmux pane.</small>
          </section>}
        {session?.controllable && session.status !== 'error' && <footer class="composer">
          <input
            ref={inputRef}
            value={message}
            onInput={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void sendMessage();
            }}
            placeholder={setupSession ? 'Type to the setup terminal' : 'Type to the agent'}
            aria-label={setupSession ? 'Message to setup terminal' : 'Message to agent'}
            autoComplete="off"
            spellcheck={false}
          />
          <button onClick={() => void sendMessage()}>Send</button>
          <button onClick={() => void sendKey('Escape')}>Esc</button>
          <button onClick={() => void sendKey('Up')}>↑</button>
          <button onClick={() => void sendKey('Down')}>↓</button>
          <button onClick={() => void sendKey('C-c')}>Ctrl-C</button>
        </footer>}
      </div>
    </dialog>
  );
}

function PairScreen({ auth, expired = false, onPaired }: { auth: AuthStatus; expired?: boolean; onPaired: (status: AuthStatus) => void }) {
  const token = new URLSearchParams(window.location.search).get('pair');
  const [credential, setCredential] = useState(token || '');
  const [name, setName] = useState(/Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'Browser');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);

  const pair = useCallback(async (value: string) => {
    if (!value) return;
    setPairing(true);
    setError('');
    try {
      const result = await api<AuthStatus>('/api/auth/pair', {
        method: 'POST', body: JSON.stringify(token ? { token: value, name } : { code: value, name }),
      });
      window.history.replaceState({}, '', '/');
      onPaired(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPairing(false);
    }
  }, [name, onPaired, token]);

  useEffect(() => { if (token) void pair(token); }, [pair, token]);

  return (
    <main class="pair-screen">
      <section class="pair-card">
        <img src="/handraise-mark.png" width="62" height="62" alt="" />
        <div>
          <p class="section-kicker">Client authentication</p>
          <h1>{expired ? 'Client session expired' : 'Pair this client'}</h1>
          <p>{expired
            ? <>This client is no longer authorized. Pair it again from an active client, or reset authentication on the server host.</>
            : auth.needsSetup
            ? <>Enter the one-time code issued by the Handraise server in the terminal running <code>handraise serve</code>.</>
            : <>Generate a client code from Settings on an already paired client. If none remains, run <code>handraise auth reset --yes</code> on the server host and restart it.</>}</p>
        </div>
        <label>
          <span>Client name</span>
          <input value={name} onInput={(event) => setName(event.currentTarget.value)} autoComplete="off" />
        </label>
        <label>
          <span>Pairing code</span>
          <input
            class="pair-code-input"
            value={token ? 'Pairing from QR…' : credential}
            disabled={Boolean(token)}
            onInput={(event) => setCredential(event.currentTarget.value.toUpperCase())}
            onKeyDown={(event) => { if (event.key === 'Enter') void pair(credential); }}
            autoComplete="one-time-code"
            spellcheck={false}
          />
        </label>
        {error && <p class="form-error" role="alert">{error}</p>}
        <button class="primary pair-submit" disabled={pairing || !credential} onClick={() => void pair(credential)}>
          {pairing ? 'Connecting…' : 'Pair client'}
        </button>
        <small>Codes expire after five minutes. Paired clients can be revoked from Settings.</small>
      </section>
    </main>
  );
}

function OfflineScreen({ detail, onRetry, kind = 'offline' }: { detail: string; onRetry: () => void; kind?: 'offline' | 'not-ready' }) {
  const unavailable = kind === 'offline';
  return (
    <main class="pair-screen">
      <section class="pair-card offline-card">
        <img src="/handraise-mark.png" width="62" height="62" alt="" />
        <div>
          <p class="section-kicker">{unavailable ? 'Server unavailable' : 'Server not ready'}</p>
          <h1>{unavailable ? 'Handraise is offline' : 'Handraise needs attention'}</h1>
          <p>{unavailable
            ? <>This client cannot reach the Handraise server at <code>{window.location.host}</code>. Start the server and try again.</>
            : <>The Handraise server is reachable, but a required local capability failed. Run <code>handraise doctor</code> on the server host and retry.</>}</p>
        </div>
        <code class="offline-detail">{detail}</code>
        <button class="primary pair-submit" onClick={onRetry}>Try again</button>
        <small>The cached interface is read-only while the server is unavailable.</small>
      </section>
    </main>
  );
}

function PageHeading({ eyebrow, title, children, back }: { eyebrow: string; title: string; children?: preact.ComponentChildren; back?: () => void }) {
  return (
    <section class="page-heading">
      <div class="page-heading-copy">
        {back && <button class="page-heading-back" type="button" aria-label="Back to repositories" title="Back to repositories" onClick={back}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7M8 12h12" /></svg></button>}
        <div><p>{eyebrow}</p><h1>{title}</h1></div>
      </div>
      {children}
    </section>
  );
}

type TruthKind = 'observed' | 'derived' | 'declared' | 'accepted' | 'agent-claim' | 'unknown';

const TRUTH_LABELS: Record<TruthKind, string> = {
  observed: 'Observed',
  derived: 'Derived',
  declared: 'Declared',
  accepted: 'Accepted',
  'agent-claim': 'Agent claim',
  unknown: 'Unknown',
};

function TruthBadge({ kind, children }: { kind: TruthKind; children?: preact.ComponentChildren }) {
  return <span class={`truth-badge ${kind}`}>{children || TRUTH_LABELS[kind]}</span>;
}

type JourneyPhase = 'understand' | 'design' | 'run';

function RepositoryJourney({
  repository, connected, refreshToken, onNavigate, onProduct, onAnalyze, onDiscover, onInitializeEmpty,
  onDesignArchitecture, onPlanFronts,
}: {
  repository: Repository;
  connected: boolean;
  refreshToken: number;
  onNavigate: (phase: JourneyPhase) => void;
  onProduct: () => void;
  onAnalyze: () => void;
  onDiscover: () => Promise<void>;
  onInitializeEmpty: () => Promise<void>;
  onDesignArchitecture: () => void;
  onPlanFronts: () => void;
}) {
  const [product, setProduct] = useState<ProductStatus | null>(null);
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    Promise.all([
      api<ProductStatus>(`/api/repositories/${repository.id}/product`),
      api<{ jobs: AnalysisJob[] }>(`/api/repositories/${repository.id}/analysis/jobs`),
    ]).then(([nextProduct, analysis]) => {
      if (disposed) return;
      setProduct(nextProduct);
      setJobs(analysis.jobs);
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [repository.id, repository.adapter, repository.components.length, repository.fronts.length, repository.runs.length, refreshToken]);

  const snapshot = jobs.find((item) => item.snapshotId && ['complete', 'stale'].includes(item.state)) || null;
  const activeJob = jobs.find((item) => ['queued', 'running', 'awaiting-input'].includes(item.state)) || null;
  const openFronts = repository.fronts.filter((front) => front.state !== 'done');
  const acceptedFronts = openFronts.filter((front) => front.schemaVersion === 2);
  const legacyFronts = openFronts.filter((front) => front.schemaVersion !== 2);
  const activeRuns = repository.runs.filter((run) => !['completed', 'failed'].includes(run.state));
  let nextTitle = 'Define the product intent';
  let nextDetail = 'Declare why this repository exists before inferred structure becomes a work model.';
  let nextAction = onProduct;
  let nextLabel = 'Define product brief';
  let secondaryLabel = 'Skip to read-only analysis';
  let secondaryAction = onAnalyze;
  if (loading && !product) {
    nextTitle = 'Checking accepted direction and evidence';
    nextDetail = 'Handraise is loading local workflow state before recommending a boundary-crossing action.';
    nextLabel = 'Open product workspace';
  } else if (repository.components.length && !acceptedFronts.length && legacyFronts.length) {
    nextTitle = 'Upgrade existing work for safe runs';
    nextDetail = `${legacyFronts.length} open front${legacyFronts.length === 1 ? '' : 's'} still use legacy contracts and cannot cross the reviewed run boundary.`;
    nextAction = () => onNavigate('design');
    nextLabel = 'Choose a front to upgrade';
    secondaryLabel = product?.exists ? 'Inspect system evidence' : 'Define product intent';
    secondaryAction = product?.exists ? () => onNavigate('understand') : onProduct;
  } else if (!product?.exists) {
    // Product intent is recommended, but analysis remains an explicit optional path.
  } else if (!snapshot && !activeJob) {
    nextTitle = 'Create a repository snapshot';
    nextDetail = 'Preview exact scope and data boundaries, then run a local read-only analyzer.';
    nextAction = onAnalyze;
    nextLabel = 'Analyze repository';
    secondaryLabel = 'Continue manually';
    secondaryAction = () => onNavigate('design');
  } else if (activeJob) {
    nextTitle = 'Analysis is in progress';
    nextDetail = `${activeJob.message} Open the job to inspect progress, provide input or recover it.`;
    nextAction = onAnalyze;
    nextLabel = 'Open analysis job';
    secondaryLabel = 'Inspect current map';
    secondaryAction = () => onNavigate('understand');
  } else if (snapshot && repository.adapter === 'uninitialized') {
    nextTitle = 'Review proposed responsibilities';
    nextDetail = 'Discovery stays private until you accept complete component contracts explicitly.';
    nextAction = () => void onDiscover();
    nextLabel = 'Discover components';
    secondaryLabel = 'Initialize empty';
    secondaryAction = () => void onInitializeEmpty();
  } else if (repository.adapter !== 'uninitialized' && !repository.components.length) {
    nextTitle = 'Design component boundaries';
    nextDetail = 'Turn evidence and product intent into reviewable responsibilities, limits and ownership.';
    nextAction = onDesignArchitecture;
    nextLabel = 'Design architecture';
    secondaryLabel = 'Open manual design';
    secondaryAction = () => onNavigate('design');
  } else if (repository.components.length && !acceptedFronts.length) {
    nextTitle = 'Design executable fronts';
    nextDetail = 'Slice product goals into dependency-aware outcomes with one accountable lead.';
    nextAction = onPlanFronts;
    nextLabel = 'Plan fronts';
    secondaryLabel = 'Review components';
    secondaryAction = () => onNavigate('design');
  } else if (acceptedFronts.length) {
    nextTitle = activeRuns.length ? 'Keep the run evidence honest' : 'Review work before agents run';
    nextDetail = activeRuns.length
      ? `${activeRuns.length} run${activeRuns.length === 1 ? '' : 's'} active; process state and verified outcomes remain separate.`
      : `${acceptedFronts.length} accepted front${acceptedFronts.length === 1 ? '' : 's'} can cross execution only through a fresh preflight.`;
    nextAction = () => onNavigate(activeRuns.length ? 'run' : 'design');
    nextLabel = activeRuns.length ? 'Open running agents' : 'Review ready work';
    secondaryLabel = 'Inspect system evidence';
    secondaryAction = () => onNavigate('understand');
  }

  return <section class="repository-journey" aria-label="Repository status and recommended next action">
    <header>
      <span><p class="section-kicker">Recommended next</p><strong>{nextTitle}</strong><small>{nextDetail}</small></span>
      <button type="button" class="journey-next" onClick={nextAction}><strong>{nextLabel} →</strong></button>
    </header>
    <div class="journey-context">
      <span class="journey-truth"><TruthBadge kind={product?.exists ? 'accepted' : 'declared'} /> Product {product?.exists ? `accepted · ${shortRevision(product.revision)}` : loading && !product ? 'checking…' : 'not accepted'}</span>
      <span class="journey-truth"><TruthBadge kind="derived" /> Analysis {snapshot ? `${snapshot.state} · ${shortRevision(snapshot.snapshotId)}` : 'not available'}</span>
      <span class="journey-truth"><TruthBadge kind="accepted" /> Contracts {repository.adapter === 'uninitialized' ? 'not initialized' : `${repository.components.length} components`}</span>
      <span class="journey-truth"><TruthBadge kind="observed" /> Runtime {activeRuns.length || repository.summary?.activeSessions || 0} active</span>
      <button type="button" class="journey-secondary" onClick={secondaryAction}>{secondaryLabel}</button>
    </div>
    <details class="journey-boundary"><summary>Scope, authority and recovery</summary><div><p><TruthBadge kind="observed" /> Repository analysis is optional, read-only and bounded to the exact previewed files. Built-in and Graphify analyzers stay local; model context shows its external boundary before consent.</p><p><TruthBadge kind="declared" /> Product intent and generated plans remain private proposals until an explicit accepted publication. Manual and skip paths stay available.</p><p><TruthBadge kind="accepted" /> Agent execution requires a fresh readiness preflight. Agent claims never satisfy acceptance without independent observed or user-reviewed evidence.</p>{!connected && <p class="journey-reconnect"><b>Live stream disconnected.</b> Polling recovery is active; cached state must be treated as read-only until the server responds.</p>}{error && <p class="journey-reconnect"><b>Status detail unavailable.</b> {error} Reopen this repository to retry.</p>}</div></details>
  </section>;
}

function RepositoryHome({ repository, sessions, onNavigate, onBack, children }: {
  repository: Repository;
  sessions: AgentSession[];
  onNavigate: (route: RouteState) => void;
  onBack: () => void;
  children: preact.ComponentChildren;
}) {
  const route = (view: 'overview' | 'map' | 'components' | 'releases' | 'ad-hoc' | 'sessions'): RouteState => ({
    ...baseRoute(view), repositoryId: repository.id,
  });
  const componentRoute = (slug: string): RouteState => ({ ...route('components'), componentSlug: slug });
  const frontRoute = (front: Front): RouteState => ({ ...componentRoute(front.component), frontSlug: front.slug });
  const releaseRoute = (slug: string): RouteState => ({ ...route('releases'), releaseSlug: slug });
  const sessionRoute = (slug: string): RouteState => ({ ...route('sessions'), sessionSlug: slug });
  const openFronts = repository.fronts.filter((front) => front.kind === 'front' && front.state !== 'done');
  const executionWorktrees = repository.workshop.worktrees.filter((worktree) => !worktree.primary);
  const openReleases = repository.releases.filter((release) => !['released', 'cancelled'].includes(release.state));
  const releaseOrder: ReleaseState[] = ['blocked', 'active', 'candidate', 'ready', 'draft', 'released', 'cancelled'];
  const currentRelease = openReleases.slice().sort((left, right) => releaseOrder.indexOf(left.state) - releaseOrder.indexOf(right.state))[0] || null;
  const deliveryFronts = currentRelease
    ? currentRelease.fronts.map((selected) => repository.fronts.find((front) => front.slug === selected.slug)).filter((front): front is Front => Boolean(front))
    : openFronts.filter((front) => ['active', 'blocked', 'queued'].includes(front.state)).slice(0, 4);
  const activeSessions = sessions.filter((session) => session.repoId === repository.id);
  const needsYou = activeSessions.filter((session) => ['error', 'blocked', 'waiting'].includes(session.status));
  const relationFor = (front: Front) => {
    const component = repository.components.find((item) => item.slug === (front.leadComponent || front.component))
      || repository.components.find((item) => item.slug === front.component) || null;
    const worktree = executionWorktrees.find((item) => item.owner?.front === front.slug || item.path.endsWith(`/${front.slug}`)) || null;
    const session = activeSessions.find((item) => item.front === front.slug || item.controlSlug === worktree?.owner?.controlSlug) || null;
    const run = repository.runs.find((item) => item.manifest.front.slug === front.slug) || null;
    return { component, worktree, session, run };
  };
  const worktreeState = (worktree: Repository['workshop']['worktrees'][number]) => {
    const risks = [
      worktree.orphan ? 'orphaned' : null,
      worktree.git.branchMismatch ? 'branch mismatch' : null,
      worktree.git.dirty ? `${worktree.git.dirty} dirty` : null,
      worktree.git.unbacked ? `${worktree.git.unbacked} only here` : null,
      worktree.git.ahead ? `${worktree.git.ahead} ahead` : null,
    ].filter(Boolean);
    return risks.join(' · ') || 'clean';
  };

  return <div class="repository-home">
    <PageHeading eyebrow="Repository workspace" title={repository.name} back={onBack}>
      <span class={`repository-home-health ${needsYou.length ? 'attention' : ''}`}>{needsYou.length ? `${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you` : 'No agent needs attention'}</span>
    </PageHeading>
    {children}

    <section class="guided-path" aria-labelledby="guided-path-title">
      <header><div><p class="section-kicker">Your path</p><h2 id="guided-path-title">Move from understanding to a shipped outcome.</h2><p>Each step opens only the workspace needed for that decision.</p></div></header>
      <nav class="guided-path-list" aria-label="Guided repository path">
        <RouteLink className="guided-stage" to={route('map')} onNavigate={onNavigate}>
          <i aria-hidden="true">1</i><span><b>Understand</b><strong>Clarify the product and inspect the system.</strong><small>Product intent, repository snapshot and evidence.</small></span><em>Open →</em>
        </RouteLink>
        <RouteLink className="guided-stage" to={route('components')} onNavigate={onNavigate}>
          <i aria-hidden="true">2</i><span><b>Design</b><strong>Organize responsibilities and outcome slices.</strong><small>{repository.components.length} components · {openFronts.length} open fronts</small></span><em>Open →</em>
        </RouteLink>
        <RouteLink className="guided-stage" to={route('releases')} onNavigate={onNavigate}>
          <i aria-hidden="true">3</i><span><b>Run</b><strong>Commit a release and operate the work.</strong><small>{openReleases.length} open releases · {executionWorktrees.length} worktrees · {activeSessions.length} sessions</small></span><em>Open →</em>
        </RouteLink>
      </nav>
    </section>

    <section class="current-delivery" aria-labelledby="current-delivery-title">
      <header><div><p class="section-kicker">Current delivery</p><h2 id="current-delivery-title">{currentRelease ? currentRelease.title : 'No release is organizing this work yet.'}</h2><p>{currentRelease ? currentRelease.outcome : 'A release turns selected fronts into one coherent increment with an explicit outcome and verification.'}</p></div>{currentRelease
        ? <RouteLink className="text-link" to={releaseRoute(currentRelease.slug)} onNavigate={onNavigate}>Open release →</RouteLink>
        : <RouteLink className="primary-link" to={route('releases')} onNavigate={onNavigate}>Create a release</RouteLink>}</header>
      {deliveryFronts.length > 0 ? <div class="delivery-chain" role="list">{deliveryFronts.map((front) => {
        const relation = relationFor(front);
        return <article class={`delivery-chain-item ${front.state}`} role="listitem" key={front.slug}>
          <RouteLink className="delivery-front-link" to={frontRoute(front)} onNavigate={onNavigate}>
            <span><small>Front · {front.state}</small><strong>{front.title}</strong><p>{front.outcome || front.next || 'Outcome not defined.'}</p></span><em>Open →</em>
          </RouteLink>
          <div class="delivery-relations" aria-label={`Relationships for ${front.title}`}>
            {relation.component ? <RouteLink to={componentRoute(relation.component.slug)} onNavigate={onNavigate}><span>Component</span><b>{relation.component.title}</b></RouteLink> : <span class="missing-relation"><span>Component</span><b>Owner unavailable</b></span>}
            {relation.worktree ? <RouteLink to={frontRoute(front)} onNavigate={onNavigate}><span>Worktree</span><b>{relation.worktree.branch || 'Detached workspace'}</b><small>{worktreeState(relation.worktree)}</small></RouteLink> : <span class="missing-relation"><span>Worktree</span><b>Not allocated</b></span>}
            {relation.session ? <RouteLink to={sessionRoute(relation.session.controlSlug)} onNavigate={onNavigate}><span>Session</span><b>{relation.session.slug}</b><small>{STATUS_LABEL[relation.session.status]}</small></RouteLink> : <span class="missing-relation"><span>Session</span><b>Not running</b>{relation.run && <small>Run {relation.run.state}</small>}</span>}
          </div>
        </article>;
      })}</div> : <div class="guided-empty"><strong>No planned front is ready to show here.</strong><p>Design outcome-oriented fronts first, then select their exact revisions in a release.</p><RouteLink className="text-link" to={route('components')} onNavigate={onNavigate}>Open Design →</RouteLink></div>}
      {currentRelease && currentRelease.fronts.length > deliveryFronts.length && <RouteLink className="text-link delivery-more" to={releaseRoute(currentRelease.slug)} onNavigate={onNavigate}>View all {currentRelease.fronts.length} release fronts →</RouteLink>}
    </section>

    <section class="repository-browse" aria-labelledby="repository-browse-title">
      <header><div><p class="section-kicker">Browse and connect</p><h2 id="repository-browse-title">The work model, without the wall of data.</h2><p>Open a group only when you need it. Every available relationship leads to its real context.</p></div></header>
      <div class="repository-browse-groups">
        <details>
          <summary><span><b>Components and fronts</b><small>{repository.components.length} responsibilities · {openFronts.length} open outcomes</small></span><strong>Browse</strong></summary>
          <div class="browse-link-list">{repository.components.map((component) => {
            const fronts = openFronts.filter((front) => front.component === component.slug || front.leadComponent === component.slug);
            return <RouteLink key={component.slug} to={componentRoute(component.slug)} onNavigate={onNavigate}><span><b>{component.title}</b><small>{fronts.length} open front{fronts.length === 1 ? '' : 's'}</small></span><em>Open →</em></RouteLink>;
          })}{!repository.components.length && <p>No accepted components yet.</p>}</div>
        </details>
        <details>
          <summary><span><b>Worktrees and sessions</b><small>{executionWorktrees.length} workspaces · {activeSessions.length} live processes</small></span><strong>Browse</strong></summary>
          <div class="browse-link-list">{executionWorktrees.map((worktree) => {
            const front = worktree.owner?.front ? repository.fronts.find((item) => item.slug === worktree.owner?.front) || null : null;
            return front ? <RouteLink key={worktree.path} to={frontRoute(front)} onNavigate={onNavigate}><span><b>{worktree.branch || 'Detached worktree'}</b><small>{front.title} · {worktreeState(worktree)}</small></span><em>Inspect →</em></RouteLink>
              : <span class="browse-missing" key={worktree.path}><span><b>{worktree.branch || 'Unowned worktree'}</b><small>{worktreeState(worktree)} · no navigable owner</small></span></span>;
          })}{activeSessions.map((session) => <RouteLink key={session.controlSlug} to={sessionRoute(session.controlSlug)} onNavigate={onNavigate}><span><b>{session.slug}</b><small>Session · {STATUS_LABEL[session.status]}{session.front ? ` · ${session.front}` : ''}</small></span><em>Open →</em></RouteLink>)}{!executionWorktrees.length && !activeSessions.length && <p>No execution workspace or agent session is active.</p>}</div>
        </details>
      </div>
    </section>
  </div>;
}

function RepositoryOverview({ repositories, onSelect }: { repositories: Repository[]; onSelect: (id: string) => void }) {
  if (!repositories.length) {
    return <p class="empty-state">No repositories connected. Add the first one from Settings.</p>;
  }
  return (
    <section class="repository-grid">
      {repositories.map((repository) => (
        <button class="repository-card" key={repository.id} onClick={() => onSelect(repository.id)}>
          <span><strong>{repository.name}</strong><small>{repository.path}</small></span>
          {repository.availability?.available === false
            ? <span class="adapter-badge unavailable">{repository.availability.kind}</span>
            : repository.adapter === 'uninitialized' && <span class="adapter-badge uninitialized">Setup needed</span>}
          <dl class="repository-signals">
            <div class="structure"><dt>Components</dt><dd>{repository.summary?.components || 0}</dd></div>
            <div class="fronts"><dt>Open fronts</dt><dd>{repository.summary?.openFronts || 0}</dd></div>
            <div class="operation"><dt>Sessions</dt><dd>{repository.summary?.activeSessions || 0}</dd></div>
          </dl>
          <span class="drill-label">Enter repository →</span>
        </button>
      ))}
    </section>
  );
}

function FleetDashboard({ repositories, sessions, history, historyError, onOpenSession, onOpenRepository, onStartManager }: {
  repositories: Repository[];
  sessions: AgentSession[];
  history: HistoryData;
  historyError: string;
  onOpenSession: (session: AgentSession) => void;
  onOpenRepository: (repositoryId: string) => void;
  onStartManager: () => Promise<void>;
}) {
  const [managerBusy, setManagerBusy] = useState(false);
  const outcomes = history.outcomes || history.events.filter((event) => ['completed', 'failed', 'stopped', 'ended'].includes(event.type));
  const fleet = fleetVerdict({ repositories, sessions, outcomes });
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (13 - index));
    return date.toISOString().slice(0, 10);
  });
  const dayCounts = new Map(days.map((day) => [day, outcomes.filter((event) => event.at.slice(0, 10) === day).length]));
  const max = Math.max(1, ...dayCounts.values());
  return (
    <section class={`fleet-dashboard ${fleet.kind}`}>
      <header><div><p class="section-kicker">Fleet verdict · {fleet.kind.replace('-', ' ')}</p><h2>{fleet.title}</h2></div><button class="primary" disabled={managerBusy || !repositories.length} onClick={async () => {
        setManagerBusy(true);
        try { await onStartManager(); } finally { setManagerBusy(false); }
      }}>{managerBusy ? 'Opening…' : 'Open fleet Director'}</button></header>
      <div class="fleet-metrics">
        <article><span>Running</span><strong>{fleet.counts.running}</strong><small>controlled + external</small></article>
        <article class={fleet.counts.needsYou ? 'alert' : ''}><span>Needs you</span><strong>{fleet.counts.needsYou}</strong><small>{fleet.counts.failed} failed · {fleet.counts.blocked} blocked · {fleet.counts.waiting} waiting</small></article>
        <article class={fleet.counts.unsafe ? 'warn' : ''}><span>Git risk</span><strong>{fleet.counts.unsafe}</strong><small>dirty, unbacked, orphaned or mismatched</small></article>
        <article><span>Completed · 7d</span><strong>{history.summary.completed7d}</strong><small>{history.summary.medianDurationSeconds ? `median ${age(history.summary.medianDurationSeconds)}` : 'no duration sample'}</small></article>
      </div>
      {(fleet.attention.length > 0 || fleet.risks.length > 0) && <div class="fleet-actions">
        {fleet.attention.slice(0, 6).map((session: AgentSession) => <button onClick={() => onOpenSession(session)}><i class={session.status} /> <span><strong>{session.slug}</strong><small>{session.reason || STATUS_LABEL[session.status]} · {repositories.find((repository) => repository.id === session.repoId)?.name || 'global'}</small></span><b>Open →</b></button>)}
        {fleet.risks.slice(0, 4).map((worktree: Repository['workshop']['worktrees'][number] & { repoId: string; repositoryName: string }) => <button onClick={() => onOpenRepository(worktree.repoId)}><i class="git" /><span><strong>{worktree.branch || worktree.path}</strong><small>{worktree.repositoryName} · {[worktree.orphan ? 'orphaned' : null, worktree.git.dirty ? `${worktree.git.dirty} dirty` : null, worktree.git.unbacked ? `${worktree.git.unbacked} only here` : null, worktree.git.branchMismatch ? 'branch mismatch' : null].filter(Boolean).join(' · ')}</small></span><b>Inspect →</b></button>)}
      </div>}
      <div class="fleet-activity"><div><p class="section-kicker">14-day activity</p><div class="activity-heatmap" aria-label="Terminal session outcomes over the last 14 days">{days.map((day) => <span key={day} title={`${day}: ${dayCounts.get(day)} outcomes`} style={{ opacity: .18 + .82 * ((dayCounts.get(day) || 0) / max) }} />)}</div></div><div><p class="section-kicker">Outcomes · 7d</p>{historyError ? <p class="form-error">History unavailable · {historyError}</p> : <p>{history.summary.completed7d} completed · {history.summary.failed7d} failed · {history.summary.stopped7d} stopped</p>}</div></div>
    </section>
  );
}

function EmptyRepositoryHome({ onConnect }: { onConnect: () => void }) {
  return (
    <section class="empty-repository-home">
      <p class="section-kicker">Local workspace</p>
      <h1>Start with a repository.</h1>
      <p>Connect a local Git repository to see its components, work fronts and agent sessions.</p>
      <button class="primary" onClick={onConnect}>Connect repository</button>
      <small>Handraise reads the repository in place. It does not upload or duplicate it.</small>
    </section>
  );
}

function ComponentsView({
  repository, onDiscover, onInitializeEmpty, onOpen, onRename, onCreate, onRetry, onReconnect,
}: { repository: Repository; onDiscover: () => Promise<void>; onInitializeEmpty: () => Promise<void>; onOpen: (slug: string) => void; onRename: (slug: string) => Promise<void>; onCreate: () => Promise<void>; onRetry: () => Promise<void>; onReconnect: () => void }) {
  if (repository.error) return <div class="empty-state action-empty repository-recovery"><span><strong>Repository unavailable · {repository.availability?.kind || 'read error'}.</strong><br />{repository.error}<br />{repository.recovery}</span><div class="button-row"><button onClick={() => void onRetry()}>Retry</button><button class="primary" onClick={onReconnect}>Open Settings</button></div></div>;
  if (repository.adapter === 'uninitialized') {
    return <div class="empty-state action-empty discovery-entry"><span><strong>Define this repository by responsibility.</strong><br />Run a read-only analysis and review every proposed contract before Handraise writes metadata, or start with an empty portfolio.</span><div class="button-row"><button class="primary" onClick={() => void onDiscover()}>Discover components</button><button onClick={() => void onInitializeEmpty()}>Initialize empty</button></div></div>;
  }
  if (!repository.components.length) return <div class="empty-state action-empty component-empty-state"><span>No components registered in this repository.</span><button class="primary" disabled={!repository.mutations.components} onClick={() => void onCreate()}>New component</button></div>;
  return (
    <section class="component-grid">
      {repository.components.map((component) => (
        <article class="component-card" key={component.slug}>
          <button class="component-card-main" type="button" onClick={() => onOpen(component.slug)}>
            <header>
              <span><strong>{component.title}</strong><TruthBadge kind="accepted">contract</TruthBadge></span>
              <span class={`adapter-badge ${component.state}`}>{component.state}</span>
            </header>
            <div class="component-progress-heading"><span>Progress</span><b>{component.progress === null ? '—' : `${component.progress}%`}</b></div>
            <div class="component-progress">
              <span style={{ width: `${component.progress || 0}%` }} />
            </div>
            <p>{component.activeFront ? <>Working on <b>{component.activeFront}</b></> : 'No active front'}</p>
            <dl>
              <div class="active"><dt>Active</dt><dd>{component.counts.active}</dd></div>
              <div class="queued"><dt>Queued</dt><dd>{component.counts.queued}</dd></div>
              <div class="blocked"><dt>Blocked</dt><dd>{component.counts.blocked}</dd></div>
              <div class="done"><dt>Done</dt><dd>{component.counts.done}</dd></div>
            </dl>
            <span class="drill-label">Open component →</span>
          </button>
          <button class="component-edit" type="button" aria-label={`Edit ${component.title}`} title={repository.mutations.components ? 'Edit component' : 'This Director repository does not expose its safe component helper'} disabled={!repository.mutations.components} onClick={() => void onRename(component.slug)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10.8-10.8a2.1 2.1 0 0 0-3-3L5.5 16 4 20ZM14.5 6.5l3 3" /></svg></button>
        </article>
      ))}
    </section>
  );
}

interface AcceptedWorkModel {
  fronts: Array<Front & { openHardDependencies: string[]; unknownDependencies: string[]; dependencyReady: boolean; run: RunRecord | null }>;
  goals: string[];
  dependencies: number;
  unknownDependencies: number;
  dependencyReady: number;
  criticalPath: string[];
  cycles: string[][];
}

function deriveAcceptedWorkModel(repository: Repository): AcceptedWorkModel {
  const accepted = repository.fronts.filter((front) => front.kind === 'front');
  const bySlug = new Map(accepted.map((front) => [front.slug, front]));
  const targetSlug = (target: string) => {
    const decoded = target.trim().replace(/^front:/, '');
    return decoded.split('/').filter(Boolean).at(-1) || decoded;
  };
  const hardDependencies = new Map(accepted.map((front) => [front.slug, front.dependencies
    .filter((dependency) => dependency.kind === 'hard')
    .map((dependency) => targetSlug(dependency.target))]));
  const cycles: string[][] = [];
  const memo = new Map<string, string[]>();
  const longestTo = (slug: string, stack: string[] = []): string[] => {
    if (memo.has(slug)) return memo.get(slug)!;
    const cycleAt = stack.indexOf(slug);
    if (cycleAt >= 0) {
      const cycle = [...stack.slice(cycleAt), slug];
      if (!cycles.some((item) => item.join('\0') === cycle.join('\0'))) cycles.push(cycle);
      return [slug];
    }
    const dependencies = (hardDependencies.get(slug) || []).filter((dependency) => bySlug.has(dependency) && bySlug.get(dependency)?.state !== 'done');
    const longestDependency = dependencies.map((dependency) => longestTo(dependency, [...stack, slug]))
      .sort((left, right) => right.length - left.length)[0] || [];
    const path = [...longestDependency, slug];
    if (!stack.length || !cycles.length) memo.set(slug, path);
    return path;
  };
  const active = accepted.filter((front) => front.state !== 'done');
  const criticalPath = active.map((front) => longestTo(front.slug)).sort((left, right) => right.length - left.length)[0] || [];
  const fronts = accepted.map((front) => {
    const dependencies = hardDependencies.get(front.slug) || [];
    const unknownDependencies = dependencies.filter((dependency) => !bySlug.has(dependency));
    const openHardDependencies = dependencies.filter((dependency) => bySlug.has(dependency) && bySlug.get(dependency)?.state !== 'done');
    const run = repository.runs.find((item) => item.manifest.front.slug === front.slug) || null;
    return { ...front, openHardDependencies, unknownDependencies, dependencyReady: front.state !== 'done' && !openHardDependencies.length && !unknownDependencies.length, run };
  });
  return {
    fronts,
    goals: [...new Set(accepted.flatMap((front) => front.goalIds))],
    dependencies: accepted.reduce((total, front) => total + front.dependencies.length, 0),
    unknownDependencies: fronts.reduce((total, front) => total + front.unknownDependencies.length, 0),
    dependencyReady: fronts.filter((front) => front.dependencyReady).length,
    criticalPath,
    cycles,
  };
}

function AcceptedWorkModelView({ repository, onOpenFront }: { repository: Repository; onOpenFront: (componentSlug: string, frontSlug: string) => void }) {
  const [mode, setMode] = useState<'graph' | 'list'>('graph');
  const model = useMemo(() => deriveAcceptedWorkModel(repository), [repository]);
  if (!repository.components.length || repository.adapter === 'uninitialized') return null;
  const componentTitle = new Map(repository.components.map((component) => [component.slug, component.title]));
  return <section class="accepted-work-model" aria-label="Accepted work model">
    <header><div><p class="section-kicker">Accepted work model</p><h2>Goals → components → fronts → runs</h2><p>Inspect ownership, dependencies and execution evidence without treating generated structure or process activity as verified outcomes.</p></div><div class="work-model-mode" aria-label="Work model display"><button type="button" class={mode === 'graph' ? 'active' : ''} aria-pressed={mode === 'graph'} onClick={() => setMode('graph')}>Graph</button><button type="button" class={mode === 'list' ? 'active' : ''} aria-pressed={mode === 'list'} onClick={() => setMode('list')}>List</button></div></header>
    <div class="work-model-authority"><span><TruthBadge kind="declared" /> goals</span><span><TruthBadge kind="accepted" /> components + fronts</span><span><TruthBadge kind="derived" /> dependency readiness + critical path</span><span><TruthBadge kind="observed" /> run state</span></div>
    <dl class="work-model-summary"><div><dt>Goals</dt><dd>{model.goals.length}</dd></div><div><dt>Components</dt><dd>{repository.components.length}</dd></div><div><dt>Fronts</dt><dd>{model.fronts.length}</dd></div><div><dt>Dependencies</dt><dd>{model.dependencies}</dd></div><div><dt>Dependency-ready</dt><dd>{model.dependencyReady}</dd></div><div><dt>Drift</dt><dd>{repository.reconciliation?.findings.active || 0}</dd></div></dl>
    {mode === 'graph' ? <div class="work-model-graph" role="list" aria-label="Components and their accepted fronts">
      {repository.components.map((component) => {
        const fronts = model.fronts.filter((front) => front.component === component.slug || front.leadComponent === component.slug);
        return <article role="listitem" key={component.slug}><header><span><TruthBadge kind="accepted">component</TruthBadge><b>{component.title}</b></span><small>{fronts.length} fronts</small></header><div>{fronts.length ? fronts.map((front) => <button type="button" key={front.slug} onClick={() => onOpenFront(front.component, front.slug)}><span><b>{front.title}</b><small>{front.goalIds.length ? `${front.goalIds.length} goals` : 'No linked goal'} · {front.openHardDependencies.length ? `blocked by ${front.openHardDependencies.join(', ')}` : front.unknownDependencies.length ? 'unknown dependency' : 'dependency-ready'}</small></span><span><i class={front.state} />{front.run ? front.run.state : front.state}</span></button>) : <p>No accepted fronts led here.</p>}</div></article>;
      })}
    </div> : <div class="work-model-list" role="table" aria-label="Accepted fronts and dependencies"><div role="row" class="work-model-list-head"><span role="columnheader">Front / owner</span><span role="columnheader">Goals</span><span role="columnheader">Dependencies</span><span role="columnheader">Readiness</span><span role="columnheader">Run</span></div>{model.fronts.map((front) => <button type="button" role="row" key={front.slug} onClick={() => onOpenFront(front.component, front.slug)}><span role="cell"><b>{front.title}</b><small>{componentTitle.get(front.leadComponent || front.component) || front.leadComponent || front.component}</small></span><span role="cell">{front.goalIds.join(', ') || 'Unlinked'}</span><span role="cell">{front.dependencies.map((item) => `${item.kind}: ${item.target}`).join(' · ') || 'None'}</span><span role="cell">{front.dependencyReady ? 'Dependency-ready' : front.state === 'done' ? 'Done' : front.unknownDependencies.length ? 'Missing context' : `Blocked: ${front.openHardDependencies.join(', ')}`}</span><span role="cell">{front.run?.state || 'Not started'}</span></button>)}</div>}
    <footer><span><b>Derived critical path</b><small>{model.criticalPath.length ? model.criticalPath.join(' → ') : 'No open hard-dependency chain'}</small></span><span><b>Limits</b><small>{model.cycles.length ? `${model.cycles.length} cycle${model.cycles.length === 1 ? '' : 's'} require review` : model.unknownDependencies ? `${model.unknownDependencies} unresolved dependency targets` : 'No dependency cycle detected'}. Dependency-ready is not run-ready; preflight remains authoritative.</small></span></footer>
  </section>;
}

interface ReleaseEditorProps {
  repository: Repository;
  release: ReleaseContract | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

const releaseLines = (value: string) => value.split('\n').map((item) => item.trim()).filter(Boolean);
const releaseSlug = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'release';

function ReleaseEditor({ repository, release, onCancel, onSaved }: ReleaseEditorProps) {
  const [title, setTitle] = useState(release?.title || '');
  const [slug, setSlug] = useState(release?.slug || '');
  const [version, setVersion] = useState(release?.version || '');
  const [targetBranch, setTargetBranch] = useState(release?.targetBranch || 'main');
  const [outcome, setOutcome] = useState(release?.outcome || '');
  const [requirements, setRequirements] = useState((release?.requirementIds || []).join('\n'));
  const [acceptance, setAcceptance] = useState((release?.acceptanceCriteria || []).join('\n'));
  const [verification, setVerification] = useState((release?.verification || []).join('\n'));
  const [compatibility, setCompatibility] = useState((release?.compatibility || []).join('\n'));
  const [limitations, setLimitations] = useState((release?.limitations || []).join('\n'));
  const [selected, setSelected] = useState((release?.fronts || []).map((front) => front.slug));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const openMembership = new Map((repository.releases || [])
    .filter((item) => item.slug !== release?.slug && !['released', 'cancelled'].includes(item.state))
    .flatMap((item) => item.fronts.map((front) => [front.slug, item.slug] as const)));
  const selectable = repository.fronts.filter((front) => front.schemaVersion === 2 && !openMembership.has(front.slug));
  const frontIndex = new Map(repository.fronts.map((front) => [front.slug, front]));
  const add = (frontSlug: string) => setSelected((current) => current.includes(frontSlug) ? current : [...current, frontSlug]);
  const remove = (frontSlug: string) => setSelected((current) => current.filter((item) => item !== frontSlug));
  const move = (index: number, offset: number) => setSelected((current) => {
    const destination = index + offset;
    if (destination < 0 || destination >= current.length) return current;
    const next = [...current];
    [next[index], next[destination]] = [next[destination], next[index]];
    return next;
  });
  const submit = async () => {
    setError('');
    const normalizedSlug = release ? release.slug : releaseSlug(slug || title);
    const fronts = selected.map((frontSlug) => frontIndex.get(frontSlug)).filter((front): front is Front => Boolean(front));
    if (!title.trim() || !outcome.trim() || !selected.length) {
      setError('Title, observable outcome and at least one current v2 front are required.');
      return;
    }
    if (fronts.length !== selected.length) {
      setError('A selected front is no longer available. Refresh and review the release again.');
      return;
    }
    setSaving(true);
    try {
      const contract = {
        title: title.trim(), version: version.trim() || null, targetBranch: targetBranch.trim(), outcome: outcome.trim(),
        requirementIds: releaseLines(requirements), fronts: fronts.map((front) => ({ slug: front.slug, revision: front.revision })),
        acceptanceCriteria: releaseLines(acceptance), verification: releaseLines(verification),
        compatibility: releaseLines(compatibility), limitations: releaseLines(limitations),
      };
      if (release) {
        await api(`/api/repositories/${repository.id}/releases/${encodeURIComponent(release.slug)}`, {
          method: 'PATCH', body: JSON.stringify({ expectedRevision: release.revision, ...contract }),
        });
      } else {
        await api(`/api/repositories/${repository.id}/releases`, {
          method: 'POST', body: JSON.stringify({ slug: normalizedSlug, state: 'draft', ...contract }),
        });
      }
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  return <div class="release-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <section class="release-editor" role="dialog" aria-modal="true" aria-labelledby="release-editor-title">
      <header><div><p class="section-kicker">Repository-local delivery contract</p><h2 id="release-editor-title">{release ? `Edit ${release.title}` : 'Assemble a release'}</h2></div><button type="button" aria-label="Close release editor" disabled={saving} onClick={onCancel}>×</button></header>
      <p class="release-editor-intro">A release is the delivery authority above fronts and runs. Saving binds the exact current revision of every selected front; it does not start an agent or mark work complete.</p>
      <div class="release-editor-fields">
        <label><span>Title</span><input value={title} onInput={(event) => { setTitle(event.currentTarget.value); if (!release && !slug) setSlug(releaseSlug(event.currentTarget.value)); }} placeholder="Release 0 — Dogfood core" /></label>
        <label><span>Slug</span><input value={release ? release.slug : slug} disabled={Boolean(release)} onInput={(event) => setSlug(event.currentTarget.value)} placeholder="release-0" spellcheck={false} /></label>
        <label><span>Version <small>optional</small></span><input value={version} onInput={(event) => setVersion(event.currentTarget.value)} placeholder="0.1.0" /></label>
        <label><span>Target branch</span><input value={targetBranch} onInput={(event) => setTargetBranch(event.currentTarget.value)} placeholder="main" spellcheck={false} /></label>
        <label class="wide"><span>Observable delivery outcome</span><textarea value={outcome} onInput={(event) => setOutcome(event.currentTarget.value)} placeholder="A user can complete one verified end-to-end journey from the packaged candidate." /></label>
      </div>
      <div class="release-assembly">
        <section><header><div><p class="section-kicker">Selected fronts · ordered</p><strong>{selected.length} exact contract{selected.length === 1 ? '' : 's'}</strong></div></header>
          <div class="release-selected-fronts">{selected.length ? selected.map((frontSlug, index) => {
            const front = frontIndex.get(frontSlug);
            const acceptedRevision = release?.fronts.find((item) => item.slug === frontSlug)?.revision;
            const stale = Boolean(acceptedRevision && front && acceptedRevision !== front.revision);
            return <article class={stale ? 'stale' : ''} key={frontSlug}><span><b>{front?.title || frontSlug}</b><small>{front?.component || 'missing owner'} · {front?.state || 'missing'} · <code>{shortRevision(front?.revision || acceptedRevision)}</code>{stale ? ' · changed since release review' : ''}</small></span><div><button type="button" aria-label={`Move ${frontSlug} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button type="button" aria-label={`Move ${frontSlug} down`} disabled={index === selected.length - 1} onClick={() => move(index, 1)}>↓</button><button type="button" onClick={() => remove(frontSlug)}>Remove</button></div></article>;
          }) : <p>No fronts selected. Add one from the reviewed v2 portfolio.</p>}</div>
        </section>
        <section><header><div><p class="section-kicker">Available accepted fronts</p><strong>{selectable.filter((front) => !selected.includes(front.slug)).length} available</strong></div></header>
          <div class="release-available-fronts">{selectable.filter((front) => !selected.includes(front.slug)).map((front) => <button type="button" key={front.slug} onClick={() => add(front.slug)}><span><b>{front.title}</b><small>{front.component} · {front.state} · <code>{shortRevision(front.revision)}</code></small></span><strong>Add +</strong></button>)}</div>
          {openMembership.size > 0 && <small class="release-membership-note">Fronts already owned by another open release are intentionally unavailable.</small>}
        </section>
      </div>
      <div class="release-gate-fields">
        <label><span>Selected requirement IDs <small>one per line</small></span><textarea value={requirements} onInput={(event) => setRequirements(event.currentTarget.value)} placeholder={'R0-RPL-05\nR0-RUN-06'} /></label>
        <label><span>Acceptance criteria <small>one per line</small></span><textarea value={acceptance} onInput={(event) => setAcceptance(event.currentTarget.value)} /></label>
        <label><span>Required verification <small>one test/gate per line</small></span><textarea value={verification} onInput={(event) => setVerification(event.currentTarget.value)} placeholder={'R0-T11\nnpm test'} /></label>
        <label><span>Compatibility bounds <small>one per line</small></span><textarea value={compatibility} onInput={(event) => setCompatibility(event.currentTarget.value)} /></label>
        <label><span>Known limitations <small>one per line</small></span><textarea value={limitations} onInput={(event) => setLimitations(event.currentTarget.value)} /></label>
      </div>
      {error && <p class="form-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={saving} onClick={onCancel}>Cancel</button><button class="primary" type="button" disabled={saving} onClick={() => void submit()}>{saving ? 'Saving exact contract…' : release ? 'Save reviewed release' : 'Create draft release'}</button></footer>
    </section>
  </div>;
}

function DeliveryWorkspaceTabs({ repositoryId, active, onNavigate }: { repositoryId: string; active: 'releases' | 'ad-hoc' | 'sessions'; onNavigate: (view: 'releases' | 'ad-hoc' | 'sessions') => void }) {
  const link = (view: 'releases' | 'ad-hoc' | 'sessions'): RouteState => ({ ...baseRoute(view), repositoryId });
  return <nav class="delivery-workspace-tabs" aria-label="Delivery workspace">
    <RouteLink className={active === 'releases' ? 'active' : ''} ariaCurrent={active === 'releases' ? 'page' : undefined} to={link('releases')} onNavigate={() => onNavigate('releases')}><span>Releases</span><small>Planned delivery authority</small></RouteLink>
    <RouteLink className={active === 'ad-hoc' ? 'active' : ''} ariaCurrent={active === 'ad-hoc' ? 'page' : undefined} to={link('ad-hoc')} onNavigate={() => onNavigate('ad-hoc')}><span>Ad-hoc work</span><small>Explicitly unplanned · zero progress</small></RouteLink>
    <RouteLink className={active === 'sessions' ? 'active' : ''} ariaCurrent={active === 'sessions' ? 'page' : undefined} to={link('sessions')} onNavigate={() => onNavigate('sessions')}><span>Agent sessions</span><small>Processes and live control</small></RouteLink>
    <span class="delivery-workspace-scope"><TruthBadge kind="accepted" /> {repositoryId}</span>
  </nav>;
}

function ReleasesView({ repository, selectedSlug, onRefresh, onOpenRelease, onShowAll, onOpenFront }: {
  repository: Repository;
  selectedSlug: string | null;
  onRefresh: () => Promise<void>;
  onOpenRelease: (release: string) => void;
  onShowAll: () => void;
  onOpenFront: (component: string, front: string) => void;
}) {
  const [editor, setEditor] = useState<ReleaseContract | 'new' | null>(null);
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<Record<string, { message: string; blockers: Array<{ code: string; message: string }> }>>({});
  const releases = repository.releases || [];
  const selectedRelease = selectedSlug ? releases.find((release) => release.slug === selectedSlug) || null : null;
  const displayedReleases = selectedSlug ? (selectedRelease ? [selectedRelease] : []) : releases;
  const frontIndex = new Map(repository.fronts.map((front) => [front.slug, front]));
  const transition = async (release: ReleaseContract, targetState: ReleaseState) => {
    if (targetState === 'cancelled' && !window.confirm(`Cancel ${release.title}? Its fronts will become available to another release, while this history remains inspectable.`)) return;
    if (targetState === 'ready' && !window.confirm(`Mark ${release.title} structurally ready? This confirms the selected requirement IDs and required-test definitions, but does not claim those tests passed.`)) return;
    setBusy(release.slug); setErrors((current) => ({ ...current, [release.slug]: { message: '', blockers: [] } }));
    const requirementEvidence = targetState === 'ready'
      ? Object.fromEntries(release.requirementIds.map((id) => [id, {
        accepted: true,
        tests: release.verification.map((testId) => ({ id: testId, status: 'defined', sourceRevision: release.revision })),
      }]))
      : undefined;
    try {
      await api(`/api/repositories/${repository.id}/releases/${encodeURIComponent(release.slug)}/transition`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: release.revision, targetState, requirementEvidence }),
      });
      await onRefresh();
    } catch (reason) {
      const apiError = reason as ApiError;
      const details = apiError.details as { blockers?: Array<{ code: string; message: string }> } | null;
      setErrors((current) => ({ ...current, [release.slug]: {
        message: reason instanceof Error ? reason.message : String(reason), blockers: details?.blockers || [],
      } }));
    } finally { setBusy(''); }
  };

  return <>
    <section class="release-command-bar"><div><p class="section-kicker">Planned delivery</p><h2>{selectedRelease ? selectedRelease.title : 'One release contract owns progress above fronts and runs.'}</h2><p>{selectedRelease ? selectedRelease.outcome : 'Sessions are process activity. Release progress comes only from exact accepted contracts and current gate evidence.'}</p></div>{selectedSlug
      ? <button type="button" onClick={onShowAll}>All releases</button>
      : <button class="primary" disabled={repository.adapter !== 'handraise'} onClick={() => setEditor('new')}>Assemble release</button>}</section>
    {repository.releaseError && <p class="form-error" role="alert">Release contracts are unavailable: {repository.releaseError}</p>}
    {selectedSlug && !selectedRelease && <div class="empty-state action-empty"><span><strong>Release not found.</strong><br />It may have been renamed or removed since this link was created.</span><button onClick={onShowAll}>Open all releases</button></div>}
    {repository.adapter === 'director' && <p class="empty-state">Director release mutation is read-only until that repository exposes its own validated release helper.</p>}
    {repository.adapter === 'handraise' && !releases.length && <section class="release-empty"><p class="section-kicker">No release contract yet</p><h2>Fronts organize work. A release decides what coherent increment you are committing to ship.</h2><p>Select exact v2 front revisions, requirement IDs, acceptance criteria, required verification, compatibility and limitations. Nothing runs when you create the draft.</p><button class="primary" onClick={() => setEditor('new')}>Create the first release</button></section>}
    <section class="release-list" aria-live="polite">{displayedReleases.map((release) => {
      const error = errors[release.slug];
      const staleFronts = release.fronts.filter((selected) => frontIndex.get(selected.slug)?.revision !== selected.revision);
      return <article class={`release-card ${release.state}`} key={release.slug}>
        <header><div><p class="section-kicker">{release.version ? `Version ${release.version}` : release.slug} · <TruthBadge kind={release.state === 'released' ? 'observed' : 'accepted'}>{release.state}</TruthBadge></p><h2>{selectedSlug ? release.title : <RouteLink to={{ ...baseRoute('releases'), repositoryId: repository.id, releaseSlug: release.slug }} onNavigate={() => onOpenRelease(release.slug)}>{release.title}</RouteLink>}</h2><p>{release.outcome}</p></div><span class={`release-state ${release.state}`}>{release.state}</span></header>
        <dl class="release-summary"><div><dt>Requirements</dt><dd>{release.requirementIds.length}</dd></div><div><dt>Fronts</dt><dd>{release.fronts.length}</dd></div><div><dt>Required gates</dt><dd>{release.verification.length}</dd></div><div><dt>Target</dt><dd>{release.targetBranch}</dd></div></dl>
        <div class="release-front-list">{release.fronts.map((selected, index) => {
          const front = frontIndex.get(selected.slug); const stale = front?.revision !== selected.revision;
          return front ? <RouteLink className={stale ? 'stale' : ''} key={selected.slug} to={{ ...baseRoute('components'), repositoryId: repository.id, componentSlug: front.component, frontSlug: front.slug }} onNavigate={() => onOpenFront(front.component, front.slug)}><i>{index + 1}</i><span><b>{front.title}</b><small>{front.component} · {front.state} · <code>{shortRevision(selected.revision)}</code>{stale ? ' · stale contract' : ''}</small></span><strong>Open →</strong></RouteLink>
            : <span class="missing" key={selected.slug}><i>{index + 1}</i><span><b>{selected.slug}</b><small>missing · <code>{shortRevision(selected.revision)}</code></small></span><strong>Missing</strong></span>;
        })}</div>
        <details class="release-contract-details"><summary>Requirements, gates and technical contract</summary><div class="release-contract-columns"><section><p class="section-kicker">Requirement IDs</p>{release.requirementIds.length ? <ul>{release.requirementIds.map((id) => <li><code>{id}</code></li>)}</ul> : <p>None selected.</p>}</section><section><p class="section-kicker">Required verification</p>{release.verification.length ? <ul>{release.verification.map((item) => <li>{item}</li>)}</ul> : <p>No gates defined.</p>}</section><section><p class="section-kicker">Compatibility + limits</p>{[...release.compatibility, ...release.limitations].length ? <ul>{release.compatibility.map((item) => <li>{item}</li>)}{release.limitations.map((item) => <li>{item}</li>)}</ul> : <p>Nothing declared.</p>}</section></div><p class="release-contract-revision">Contract revision <code>{shortRevision(release.revision)}</code></p></details>
        {release.candidate && <div class="release-candidate"><span><TruthBadge kind="observed">candidate evidence</TruthBadge><b>{release.candidate.artifact}</b><small>source <code>{shortRevision(release.candidate.sourceRevision)}</code> · artifact <code>{shortRevision(release.candidate.artifactDigest)}</code> · measured {new Date(release.candidate.measuredAt).toLocaleString()}</small></span></div>}
        {staleFronts.length > 0 && <p class="release-warning" role="status">{staleFronts.length} selected front revision{staleFronts.length === 1 ? ' is' : 's are'} stale. Edit and explicitly rebind before any gate transition.</p>}
        {error?.message && <div class="release-blockers" role="alert"><strong>{error.message}</strong>{error.blockers.length > 0 && <ul>{error.blockers.map((item) => <li><code>{item.code}</code> {item.message}</li>)}</ul>}</div>}
        <footer><div>
          {release.state === 'draft' && <><button type="button" disabled={busy === release.slug} onClick={() => setEditor(release)}>Edit assembly</button><button class="primary" type="button" disabled={busy === release.slug || staleFronts.length > 0} onClick={() => void transition(release, 'ready')}>Mark structurally ready</button></>}
          {release.state === 'ready' && <button class="primary" type="button" disabled={busy === release.slug || staleFronts.length > 0} onClick={() => void transition(release, 'active')}>Activate release</button>}
          {release.state === 'active' && <span class="release-runner-note">Candidate promotion waits for current passing test and artifact evidence.</span>}
          {release.state === 'blocked' && <button type="button" disabled={busy === release.slug} onClick={() => void transition(release, 'active')}>Resume release</button>}
          {!['released', 'cancelled'].includes(release.state) && <button class="danger" type="button" disabled={busy === release.slug} onClick={() => void transition(release, 'cancelled')}>Cancel</button>}
        </div></footer>
      </article>;
    })}</section>
    {editor && <ReleaseEditor repository={repository} release={editor === 'new' ? null : editor} onCancel={() => setEditor(null)} onSaved={async () => { setEditor(null); await onRefresh(); }} />}
  </>;
}

function AdHocStartDialog({
  repository, settings, onCancel, onStarted,
}: {
  repository: Repository;
  settings: Settings | null;
  onCancel: () => void;
  onStarted: (run: AdHocRunRecord) => Promise<void>;
}) {
  const enabledAgents = Object.entries(settings?.agents || {}).filter(([, value]) => value.enabled);
  const defaultAgent = enabledAgents.some(([id]) => id === repository.defaultAgent)
    ? repository.defaultAgent || ''
    : enabledAgents[0]?.[0] || '';
  const [purpose, setPurpose] = useState('');
  const [componentSlug, setComponentSlug] = useState('');
  const [agent, setAgent] = useState(defaultAgent);
  const [model, setModel] = useState(repository.model || settings?.agents[defaultAgent]?.model || '');
  const [effort, setEffort] = useState(repository.effort || settings?.agents[defaultAgent]?.effort || '');
  const [isolate, setIsolate] = useState(true);
  const [preflight, setPreflight] = useState<AdHocPreflight | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const invalidate = () => { setPreflight(null); setConfirmed(false); setError(''); };
  const prepare = async () => {
    if (purpose.trim().length < 20) { setError('Describe a concrete unplanned purpose using at least 20 characters.'); return; }
    if (!agent) { setError('Enable and choose an agent before reviewing readiness.'); return; }
    setLoading(true); setConfirmed(false); setError('');
    try {
      const result = await api<{ preflight: AdHocPreflight }>(`/api/repositories/${repository.id}/ad-hoc-runs/preflight`, {
        method: 'POST', body: JSON.stringify({ purpose: purpose.trim(), componentSlug: componentSlug || null, agent, model: model.trim(), effort, isolate }),
      });
      setPreflight(result.preflight);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  const start = async () => {
    if (!preflight || !confirmed || !preflight.readiness.ready) return;
    setStarting(true); setError('');
    try {
      const result = await api<{ run: AdHocRunRecord }>(`/api/repositories/${repository.id}/ad-hoc-runs/preflight/${encodeURIComponent(preflight.id)}/start`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: preflight.revision, confirmed: true }),
      });
      await onStarted(result.run);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.code ? `${reason.message} (${reason.code})` : reason instanceof Error ? reason.message : String(reason));
      setConfirmed(false);
    } finally { setStarting(false); }
  };

  return <div class="component-name-backdrop run-preflight-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !starting) onCancel();
  }}>
    <section class="component-name-dialog run-preflight-dialog ad-hoc-start-dialog" role="dialog" aria-modal="true" aria-labelledby="ad-hoc-start-title">
      <header><div><p class="section-kicker">Explicitly unplanned · {repository.name}</p><h2 id="ad-hoc-start-title">Review ad-hoc work</h2></div><button type="button" aria-label="Close ad-hoc review" disabled={starting} onClick={onCancel}>×</button></header>
      <p class="component-name-help">Use this for bounded work that is not part of an accepted front or release. It gets the same ownership, Git and agent safety checks, while contributing zero delivery progress.</p>

      <label class="ad-hoc-purpose"><span>Concrete purpose</span><textarea rows={3} value={purpose} disabled={loading || starting} placeholder="Investigate and reproduce the intermittent local startup failure without changing accepted planning." onInput={(event) => { setPurpose(event.currentTarget.value); invalidate(); }} /></label>
      <div class="run-preflight-controls ad-hoc-preflight-controls">
        <label><span>Optional component context</span><select value={componentSlug} disabled={loading || starting} onChange={(event) => { setComponentSlug(event.currentTarget.value); invalidate(); }}><option value="">Unscoped investigation</option>{repository.components.map((item) => <option value={item.slug}>{item.title}</option>)}</select></label>
        <label><span>Agent</span><select value={agent} disabled={loading || starting || !enabledAgents.length} onChange={(event) => { const next = event.currentTarget.value; setAgent(next); setModel(repository.model || settings?.agents[next]?.model || ''); setEffort(repository.effort || settings?.agents[next]?.effort || ''); invalidate(); }}>{enabledAgents.map(([id, value]) => <option value={id}>{value.title}</option>)}</select></label>
        <label><span>Model</span><input value={model} disabled={loading || starting} placeholder="Agent default" onInput={(event) => { setModel(event.currentTarget.value); invalidate(); }} /></label>
        <label><span>Effort</span><select value={effort} disabled={loading || starting || !agent} onChange={(event) => { setEffort(event.currentTarget.value); invalidate(); }}><option value="">CLI default</option>{(settings?.agents[agent]?.efforts || []).map((value) => <option value={value}>{value}</option>)}</select></label>
      </div>
      <label class="session-isolation run-isolation"><span>Workspace</span><span class="checkbox-row"><input type="checkbox" checked={isolate} disabled={loading || starting} onChange={(event) => { setIsolate(event.currentTarget.checked); invalidate(); }} /><b>Use an isolated Git worktree and branch</b></span><small>Recommended. An ad-hoc branch remains inspectable and is never silently merged into planned delivery.</small></label>

      {!preflight && <div class="run-prepare-boundary ad-hoc-boundary"><span><b>Read-only safety review</b><small>No worktree, session, front, release or requirement is created or changed by this review.</small></span><button class="primary" type="button" disabled={loading || starting || purpose.trim().length < 20 || !agent} onClick={() => void prepare()}>{loading ? 'Reviewing…' : 'Review ad-hoc readiness'}</button></div>}

      {preflight && <div class="run-preflight-review">
        <section class={`run-readiness ${preflight.readiness.ready ? 'ready' : 'blocked'}`}>
          <header><span><p class="section-kicker">Safety boundary</p><h3>{preflight.readiness.ready ? 'Ready for explicit unplanned start' : 'Resolve blocking conditions'}</h3></span><b>{preflight.readiness.errors} errors · {preflight.readiness.warnings} warnings</b></header>
          {preflight.readiness.diagnostics.length ? <div class="run-diagnostics">{preflight.readiness.diagnostics.map((item) => <article class={item.severity} key={`${item.code}:${item.message}`}><code>{item.code}</code><span><b>{item.message}</b><small>{item.recovery}</small></span></article>)}</div> : <p>No blocking diagnostics. Current ownership and Git state are revalidated immediately before launch.</p>}
        </section>
        <div class="ad-hoc-authority"><TruthBadge kind="declared">Unplanned</TruthBadge><span><b>Zero accepted delivery progress</b><small>No requirement, front or release provenance exists. A later promotion can only create a review proposal.</small></span></div>
        <div class="run-review-grid">
          <article><p class="section-kicker">Purpose</p><strong>{preflight.work.component?.title || 'Unscoped investigation'}</strong><small>{preflight.work.purpose}</small><small>Source {shortRevision(preflight.source.digest)}</small></article>
          <article><p class="section-kicker">Execution</p><strong>{settings?.agents[preflight.execution.agent]?.title || preflight.execution.agent}</strong><small>{preflight.execution.model || 'CLI model default'} · {preflight.execution.effort || 'CLI effort default'}</small><small>{preflight.execution.isolate ? 'Isolated worktree' : 'Primary checkout'}</small></article>
          <article><p class="section-kicker">Reviewed workspace</p><strong>{preflight.workspace.branch || 'Current branch'}</strong><code>{preflight.workspace.path}</code><small>Revision {shortRevision(preflight.workspace.revision)}</small><small>Expires {new Date(preflight.expiresAt).toLocaleTimeString()}</small></article>
        </div>
        {preflight.context.explicitUnknowns.length > 0 && <section class="run-unknowns"><p class="section-kicker">Explicit unknowns</p><ul>{preflight.context.explicitUnknowns.map((item) => <li>{item}</li>)}</ul></section>}
        <details class="run-exact-context"><summary>Inspect exact ad-hoc agent context · {formatBytes(preflight.context.bytes)}</summary><pre>{preflight.context.prompt}</pre></details>
        <label class="run-confirm"><input type="checkbox" checked={confirmed} disabled={starting || !preflight.readiness.ready} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span><b>I reviewed this exact unplanned run revision</b><small>Start may create only the shown workspace and agent process. It cannot claim planned or release progress.</small></span></label>
        <div class="run-review-actions"><button type="button" disabled={starting} onClick={() => { setPreflight(null); setConfirmed(false); setError(''); }}>Change setup</button><button type="button" disabled={loading || starting} onClick={() => void prepare()}>Refresh safety</button><button class="primary" type="button" disabled={starting || !confirmed || !preflight.readiness.ready} onClick={() => void start()}>{starting ? 'Starting isolated work…' : 'Start reviewed ad-hoc work'}</button></div>
      </div>}
      {error && <p class="form-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onCancel} disabled={starting}>Cancel</button></footer>
    </section>
  </div>;
}

function AdHocRunCard({ run, repository, onRefresh, onOpenSession }: {
  run: AdHocRunRecord;
  repository: Repository;
  onRefresh: () => Promise<void>;
  onOpenSession: (controlSlug: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const endpoint = (suffix = '') => `/api/repositories/${repository.id}/ad-hoc-runs/${encodeURIComponent(run.id)}${suffix}`;
  const perform = async (name: string, suffix: string, body: Record<string, unknown>) => {
    setBusy(name); setError('');
    try {
      await api(endpoint(suffix), { method: 'POST', body: JSON.stringify({ expectedRevision: run.revision, ...body }) });
      await onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };
  const discovery = async () => {
    const summary = window.prompt('What did this unplanned run discover?'); if (!summary?.trim()) return;
    const evidence = window.prompt('Evidence or location (optional):', '') || '';
    await perform('discovery', '/discoveries', { kind: 'discovery', summary: summary.trim(), evidence: evidence.trim() });
  };
  const check = async () => {
    const label = window.prompt('Check or observation:'); if (!label?.trim()) return;
    const rawStatus = window.prompt('Result: passed or failed', 'passed'); if (rawStatus === null) return;
    const status = rawStatus.trim().toLowerCase();
    if (!['passed', 'failed'].includes(status)) { setError('Check result must be passed or failed.'); return; }
    const evidence = window.prompt('Observed evidence:', '') || '';
    await perform('check', '/checks', { label: label.trim(), status, source: 'user-observed', evidence: evidence.trim() });
  };
  const handoff = async () => {
    const summary = window.prompt('Durable handoff summary:'); if (!summary?.trim()) return;
    const next = window.prompt('Next steps, one per line (optional):', '') || '';
    const blockers = window.prompt('Blockers, one per line (optional):', '') || '';
    await perform('handoff', '/handoff', { summary: summary.trim(), nextSteps: releaseLines(next), blockers: releaseLines(blockers) });
  };
  const complete = async () => {
    const summary = window.prompt('Record the observable ad-hoc outcome. This will remain outside release progress:'); if (!summary?.trim()) return;
    await perform('outcome', '/complete', { status: 'completed', summary: summary.trim() });
  };
  const restart = async () => {
    if (!window.confirm('Restart this exact ad-hoc run in its preserved workspace? Agent capability, ownership, component revision and Git identity will be revalidated first.')) return;
    await perform('restart', '/restart', { confirmed: true });
  };
  const promote = async () => {
    const rawKind = window.prompt('Promotion target: new-front, existing-front or release-review', 'new-front'); if (rawKind === null) return;
    const kind = rawKind.trim() as 'new-front' | 'existing-front' | 'release-review';
    if (!['new-front', 'existing-front', 'release-review'].includes(kind)) { setError('Promotion target must be new-front, existing-front or release-review.'); return; }
    const targetId = kind === 'new-front' ? null : window.prompt(kind === 'existing-front' ? 'Existing front slug to review:' : 'Release slug to review:');
    if (kind !== 'new-front' && !targetId?.trim()) return;
    const summary = window.prompt('Describe the planned follow-up proposal:'); if (!summary?.trim()) return;
    await perform('promotion', '/promotions', { target: { kind, id: targetId?.trim() || null }, summary: summary.trim() });
  };
  const terminal = Boolean(run.outcome) || run.state === 'completed';
  const sessionSlug = run.process.session?.controlSlug;

  return <article class={`ad-hoc-card ${run.state}`}>
    <header><div><p class="section-kicker">Unplanned work · <code>{shortRevision(run.id)}</code></p><h2>{run.manifest.work.purpose}</h2><p>{run.manifest.work.component ? `${run.manifest.work.component.title} context · exact revision ${shortRevision(run.manifest.work.component.revision)}` : 'No accepted component context selected.'}</p></div><span class={`ad-hoc-state ${run.state}`}>{run.state.replace('-', ' ')}</span></header>
    <div class="ad-hoc-authority"><TruthBadge kind="declared">Unplanned</TruthBadge><span><b>0 requirement · 0 front · 0 release progress</b><small>Process activity and evidence remain durable, but never become retroactively planned.</small></span></div>
    <dl class="ad-hoc-summary"><div><dt>Agent</dt><dd>{run.manifest.execution.agent}</dd></div><div><dt>Workspace</dt><dd>{run.manifest.workspace.branch || 'current branch'}</dd></div><div><dt>Discoveries</dt><dd>{run.discoveries.length}</dd></div><div><dt>Checks</dt><dd>{run.checks.length}</dd></div></dl>
    {run.process.attention && <div class="run-attention"><b>{run.process.attention.status}</b><span>{run.process.attention.reason || 'The agent needs review.'}</span></div>}
    {(run.discoveries.length > 0 || run.checks.length > 0 || run.handoffs.length > 0) && <div class="ad-hoc-ledger">
      <section><p class="section-kicker">Discoveries</p>{run.discoveries.length ? run.discoveries.map((item) => <article key={item.id}><b>{item.kind}</b><span>{item.summary}</span><small>{item.evidence || new Date(item.at).toLocaleString()}</small></article>) : <p>None recorded.</p>}</section>
      <section><p class="section-kicker">Checks</p>{run.checks.length ? run.checks.map((item) => <article key={item.id}><b class={item.status}>{item.status}</b><span>{item.label}</span><small>{item.source} · {item.evidence || new Date(item.at).toLocaleString()}</small></article>) : <p>None recorded.</p>}</section>
      <section><p class="section-kicker">Handoffs</p>{run.handoffs.length ? run.handoffs.map((item) => <article key={item.id}><b>{shortRevision(item.revision)}</b><span>{item.summary}</span><small>{item.nextSteps.join(' · ') || 'No next step recorded'}</small></article>) : <p>None recorded.</p>}</section>
    </div>}
    {run.outcome && <section class="ad-hoc-outcome"><div><TruthBadge kind="observed">Recorded outcome</TruthBadge><h3>{run.outcome.summary}</h3><p>{run.outcome.status} · accepted: no · delivery progress: no</p></div><dl><div><dt>Branch</dt><dd>{run.outcome.git.branch || 'unknown'}</dd></div><div><dt>Dirty</dt><dd>{run.outcome.git.dirty}</dd></div><div><dt>Ahead</dt><dd>{run.outcome.git.ahead}</dd></div><div><dt>Unbacked</dt><dd>{run.outcome.git.unbacked}</dd></div></dl></section>}
    {run.proposals.length > 0 && <section class="ad-hoc-proposals"><p class="section-kicker">Planning proposals · review only</p>{run.proposals.map((item) => <article key={item.id}><TruthBadge kind="derived">Review</TruthBadge><span><b>{item.target.kind}</b><small>{item.summary}</small></span><em>0 progress</em></article>)}</section>}
    {error && <p class="form-error" role="alert">{error}</p>}
    <footer><span><small>Record revision</small><code>{shortRevision(run.revision)}</code></span><div>
      {run.process.active && sessionSlug && <button type="button" disabled={Boolean(busy)} onClick={() => onOpenSession(sessionSlug)}>Open live session</button>}
      {!terminal && <><button type="button" disabled={Boolean(busy)} onClick={() => void discovery()}>{busy === 'discovery' ? 'Recording…' : 'Add discovery'}</button><button type="button" disabled={Boolean(busy)} onClick={() => void check()}>{busy === 'check' ? 'Recording…' : 'Record check'}</button><button type="button" disabled={Boolean(busy)} onClick={() => void handoff()}>{busy === 'handoff' ? 'Saving…' : 'Save handoff'}</button></>}
      {!terminal && !run.process.active && <><button type="button" disabled={Boolean(busy)} onClick={() => void restart()}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button><button class="primary" type="button" disabled={Boolean(busy)} onClick={() => void complete()}>{busy === 'outcome' ? 'Recording…' : 'Record outcome'}</button></>}
      {terminal && <button type="button" disabled={Boolean(busy)} onClick={() => void promote()}>{busy === 'promotion' ? 'Proposing…' : 'Propose planned follow-up'}</button>}
    </div></footer>
  </article>;
}

function AdHocRunsView({ repository, settings, onRefresh, onOpenSession }: {
  repository: Repository;
  settings: Settings | null;
  onRefresh: () => Promise<void>;
  onOpenSession: (controlSlug: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const runs = repository.adHocRuns || [];
  return <>
    <section class="release-command-bar ad-hoc-command-bar"><div><p class="section-kicker">Explicitly unplanned work</p><h2>Investigate safely without falsifying the delivery plan.</h2><p>Every run gets a reviewed purpose, ownership checks, isolated Git state and a durable outcome. It remains separate from requirements, fronts and releases forever.</p></div><button class="primary" disabled={repository.adapter !== 'handraise'} onClick={() => setStarting(true)}>Start ad-hoc work</button></section>
    {repository.adHocRunError && <p class="form-error" role="alert">Ad-hoc records are unavailable: {repository.adHocRunError}</p>}
    {repository.adapter === 'director' && <p class="empty-state">Director repositories are read-only until they expose the same typed ad-hoc boundary.</p>}
    {repository.adapter === 'handraise' && !runs.length && <section class="release-empty ad-hoc-empty"><p class="section-kicker">No unplanned work recorded</p><h2>Use ad-hoc work for a real interruption or investigation—not as a shortcut around planning.</h2><p>If the result deserves planned delivery, record its outcome first and create a review proposal. Existing release progress never changes automatically.</p><button class="primary" onClick={() => setStarting(true)}>Review the first ad-hoc run</button></section>}
    <section class="ad-hoc-list" aria-live="polite">{runs.map((run) => <AdHocRunCard key={run.id} run={run} repository={repository} onRefresh={onRefresh} onOpenSession={onOpenSession} />)}</section>
    {starting && <AdHocStartDialog repository={repository} settings={settings} onCancel={() => setStarting(false)} onStarted={async () => { setStarting(false); await onRefresh(); }} />}
  </>;
}

interface ComponentDialogState {
  mode: 'create' | 'edit';
  initial: string;
  initialScope: string;
  initialLimits: string;
  initialDelegation: string;
  initialTerritory: string;
  initialOrder: number;
  slug?: string;
}

interface ComponentDetailsDraft {
  scope: string;
  limits: string;
  delegation: string;
  territory: string;
  order: number;
}

function ComponentNameDialog({
  state, onCancel, onSubmit,
}: {
  state: ComponentDialogState;
  onCancel: () => void;
  onSubmit: (title: string, details: ComponentDetailsDraft) => Promise<void>;
}) {
  const [value, setValue] = useState(state.initial);
  const [scope, setScope] = useState(state.initialScope);
  const [limits, setLimits] = useState(state.initialLimits);
  const [delegation, setDelegation] = useState(state.initialDelegation);
  const [territory, setTerritory] = useState(state.initialTerritory);
  const [order, setOrder] = useState(state.initialOrder);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const title = value.trim();
    if (!title) {
      setError('Enter a component name.');
      return;
    }
    if (!scope.trim()) {
      setError('Describe what this component owns.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit(title, {
        scope: scope.trim(), limits: limits.trim(), delegation: delegation.trim(), territory: territory.trim(), order,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  return (
    <div
      class="component-name-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <section class="component-name-dialog" role="dialog" aria-modal="true" aria-labelledby="component-name-title">
        <header>
          <div>
            <p class="section-kicker">{state.mode === 'create' ? 'New component' : 'Edit component'}</p>
            <h2 id="component-name-title">{state.mode === 'create' ? 'Create a component' : 'Update component definition'}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onCancel} disabled={saving}>×</button>
        </header>
        <p class="component-name-help">{state.mode === 'create' ? 'Give the agent enough context to work inside this component.' : 'Keep the component contract useful to the agent.'}</p>
        <label>
          <span>Component name</span>
          <input
            ref={inputRef}
            value={value}
            disabled={saving}
            onInput={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
              if (event.key === 'Escape' && !saving) onCancel();
            }}
          />
        </label>
        <label><span>Display order</span><input type="number" min="0" max="999" value={order} disabled={saving} onInput={(event) => setOrder(Math.max(0, Math.min(999, Number(event.currentTarget.value) || 0)))} /></label>
        <label>
          <span>Scope / purpose</span>
          <textarea
            value={scope}
            disabled={saving}
            placeholder="What does this component own?"
            rows={4}
            onInput={(event) => setScope(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Boundaries</span>
          <textarea value={limits} disabled={saving} placeholder="What is out of scope?" rows={3} onInput={(event) => setLimits(event.currentTarget.value)} />
        </label>
        <label>
          <span>Agent guidance</span>
          <textarea value={delegation} disabled={saving} placeholder="How should the agent coordinate or hand off work?" rows={3} onInput={(event) => setDelegation(event.currentTarget.value)} />
        </label>
        <label>
          <span>Territory</span>
          <textarea value={territory} disabled={saving} placeholder="Which folders, files or surfaces does it own?" rows={3} onInput={(event) => setTerritory(event.currentTarget.value)} />
        </label>
        {error && <p class="form-error" role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
          <button class="primary" type="button" onClick={() => void submit()} disabled={saving || !value.trim() || !scope.trim()}>
            {saving ? 'Saving…' : state.mode === 'create' ? 'Create component' : 'Save definition'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function DiscoveryDialog({
  state, onCancel, onRegenerate, onAccept, onSkip,
}: {
  state: DiscoveryDialogState;
  onCancel: () => void;
  onRegenerate: () => Promise<void>;
  onAccept: (components: DiscoveryProposal[]) => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const [proposals, setProposals] = useState<DiscoveryProposal[]>(state.draft?.proposals || []);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    setProposals(state.draft?.proposals || []);
    setLocalError('');
  }, [state.draft?.id]);

  const update = <K extends keyof DiscoveryProposal>(index: number, field: K, value: DiscoveryProposal[K]) => {
    setProposals((current) => current.map((proposal, proposalIndex) => (
      proposalIndex === index ? { ...proposal, [field]: value } : proposal
    )));
  };

  const regenerate = async () => {
    if (state.draft && !window.confirm('Replace this proposal and discard your current edits?')) return;
    setLocalError('');
    try { await onRegenerate(); }
    catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const accept = async () => {
    if (!proposals.length) {
      setLocalError('Keep at least one component, or initialize an empty portfolio instead.');
      return;
    }
    const incomplete = proposals.find((proposal) => !proposal.slug.trim() || !proposal.title.trim()
      || !proposal.scope.trim() || !proposal.limits.trim() || !proposal.delegation.trim()
      || !proposal.territory.trim() || !Number.isInteger(proposal.order) || proposal.order < 1);
    if (incomplete) {
      setLocalError(`Complete every contract field for ${incomplete.title || incomplete.slug || 'the proposal'}.`);
      return;
    }
    const slugs = proposals.map((proposal) => proposal.slug.trim());
    if (new Set(slugs).size !== slugs.length) {
      setLocalError('Every proposed component needs a unique slug.');
      return;
    }
    if (!window.confirm(`Create ${proposals.length} component contract${proposals.length === 1 ? '' : 's'} in ${state.repositoryName}? This is the first repository mutation.`)) return;
    setSaving(true);
    setLocalError('');
    try { await onAccept(proposals); }
    catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  const skip = async () => {
    if (!window.confirm(`Initialize ${state.repositoryName} with an empty component portfolio? No proposal will be written.`)) return;
    setSaving(true);
    setLocalError('');
    try { await onSkip(); }
    catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  const busy = state.loading || saving;
  return (
    <div class="component-name-backdrop" role="presentation">
      <section class="component-name-dialog discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="discovery-title">
        <header>
          <div>
            <p class="section-kicker">Read-only repository analysis</p>
            <h2 id="discovery-title">Discover components for {state.repositoryName}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onCancel} disabled={busy}>×</button>
        </header>
        <p class="component-name-help">Nothing in the repository changes while you review, edit, remove or regenerate this proposal. Evidence explains each inferred responsibility; uncertainty stays visible.</p>

        {state.loading && !state.draft && <div class="discovery-loading" role="status"><i aria-hidden="true" /><span>Inspecting repository structure, documentation, manifests, tests and configuration…</span></div>}

        {state.draft && <>
          <dl class="discovery-analysis" aria-label="Discovery analysis summary">
            <div><dt>Files</dt><dd>{state.draft.analysis.files}{state.draft.analysis.truncated ? '+' : ''}</dd></div>
            <div><dt>Docs</dt><dd>{state.draft.analysis.documentation}</dd></div>
            <div><dt>Manifests</dt><dd>{state.draft.analysis.manifests}</dd></div>
            <div><dt>Tests</dt><dd>{state.draft.analysis.tests}</dd></div>
            <div><dt>Config</dt><dd>{state.draft.analysis.configuration}</dd></div>
          </dl>
          <div class="discovery-proposal-heading">
            <span><strong>{proposals.length} proposed responsibilit{proposals.length === 1 ? 'y' : 'ies'}</strong><small>Draft {state.draft.fingerprint} · expires {new Date(state.draft.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span>
            <button type="button" onClick={() => void regenerate()} disabled={busy}>Regenerate</button>
          </div>
          <div class="discovery-proposals">
            {proposals.map((proposal, index) => (
              <details class="discovery-proposal" key={`${proposal.slug}-${index}`} open={index === 0}>
                <summary>
                  <span><b>{proposal.title || 'Untitled component'}</b><small>{proposal.slug || 'missing-slug'} · order {proposal.order}</small></span>
                  <span class={`adapter-badge ${proposal.confidence === 'high' ? 'active' : proposal.confidence === 'medium' ? 'handraise' : 'uninitialized'}`}>{proposal.confidence} confidence</span>
                </summary>
                <div class="discovery-contract">
                  <div class="discovery-identity">
                    <label><span>Component name</span><input value={proposal.title} disabled={busy} onInput={(event) => update(index, 'title', event.currentTarget.value)} /></label>
                    <label><span>Slug</span><input value={proposal.slug} disabled={busy} spellcheck={false} onInput={(event) => update(index, 'slug', event.currentTarget.value)} /></label>
                    <label><span>Display order</span><input type="number" min="1" max="999" value={proposal.order} disabled={busy} onInput={(event) => update(index, 'order', Number(event.currentTarget.value) || 0)} /></label>
                  </div>
                  <label><span>Scope / purpose</span><textarea rows={4} value={proposal.scope} disabled={busy} onInput={(event) => update(index, 'scope', event.currentTarget.value)} /></label>
                  <label><span>Boundaries</span><textarea rows={3} value={proposal.limits} disabled={busy} onInput={(event) => update(index, 'limits', event.currentTarget.value)} /></label>
                  <label><span>Agent guidance</span><textarea rows={3} value={proposal.delegation} disabled={busy} onInput={(event) => update(index, 'delegation', event.currentTarget.value)} /></label>
                  <label><span>Territory</span><textarea rows={3} value={proposal.territory} disabled={busy} onInput={(event) => update(index, 'territory', event.currentTarget.value)} /></label>
                  <div class="discovery-basis">
                    <section><p class="section-kicker">Repository evidence</p>{proposal.evidence.length ? <ul>{proposal.evidence.map((item) => <li key={item.path}><code>{item.path}</code><span>{item.reason}</span></li>)}</ul> : <p>No concrete evidence was available.</p>}</section>
                    <section><p class="section-kicker">Material uncertainty</p>{proposal.uncertainty.length ? <ul>{proposal.uncertainty.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No material uncertainty detected by this pass.</p>}</section>
                  </div>
                  <button class="danger discovery-remove" type="button" disabled={busy} onClick={() => setProposals((current) => current.filter((_, proposalIndex) => proposalIndex !== index))}>Remove proposal</button>
                </div>
              </details>
            ))}
            {!proposals.length && <div class="empty-state">All proposals were removed. Regenerate them or initialize an empty portfolio.</div>}
          </div>
          {state.loading && <p class="discovery-refreshing" role="status">Regenerating from the current repository…</p>}
        </>}

        {(state.error || localError) && <p class="form-error" role="alert">{localError || state.error}</p>}
        <footer class="discovery-footer">
          <button type="button" onClick={() => void skip()} disabled={busy}>Skip and initialize empty</button>
          <span />
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          {!state.draft
            ? <button class="primary" type="button" onClick={() => void regenerate()} disabled={busy}>{state.loading ? 'Analyzing…' : 'Retry analysis'}</button>
            : <button class="primary" type="button" onClick={() => void accept()} disabled={busy || !proposals.length}>{saving ? 'Creating…' : `Accept ${proposals.length} component${proposals.length === 1 ? '' : 's'}`}</button>}
        </footer>
      </section>
    </div>
  );
}

function ContractMigrationDialog({
  state, onCancel, onRefresh, onApply,
}: {
  state: ContractMigrationDialogState;
  onCancel: () => void;
  onRefresh: () => Promise<void>;
  onApply: () => Promise<void>;
}) {
  const preview = state.preview;
  const busy = state.loading || state.applying;
  return (
    <div class="component-name-backdrop contract-migration-backdrop" role="presentation">
      <section class="component-name-dialog contract-migration-dialog" role="dialog" aria-modal="true" aria-labelledby="contract-migration-title">
        <header>
          <div><p class="section-kicker">Explicit schema migration</p><h2 id="contract-migration-title">Review work contracts for {state.repositoryName}</h2></div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>
        <p class="component-name-help">This preview is read-only. Applying it requires this exact repository baseline, preserves unknown Markdown and commits the file set under one repository lock.</p>
        {state.loading && <div class="discovery-loading" role="status"><i aria-hidden="true" /><span>Rendering and validating the exact v1 → v2 change…</span></div>}
        {preview && <>
          <div class={`contract-migration-summary ${preview.canApply ? '' : 'invalid'}`}>
            <span><strong>{preview.noOp ? 'Already on schema v2' : `${preview.operations.length} file${preview.operations.length === 1 ? '' : 's'} will change`}</strong><small>{preview.scope.mode === 'selected' ? `Selected front ${preview.scope.frontSlugs.join(', ')} · components ${preview.scope.componentSlugs.join(', ')}` : 'All legacy work contracts'} · preview {preview.previewId.slice(0, 12)} · {preview.validation.summary.errors} errors · {preview.validation.summary.warnings} warnings</small></span>
            <b>{preview.canApply ? preview.noOp ? 'no-op' : 'ready' : 'blocked'}</b>
          </div>
          {preview.validation.diagnostics.length > 0 && <details class="contract-migration-diagnostics" open={!preview.canApply}>
            <summary>Validation diagnostics ({preview.validation.diagnostics.length})</summary>
            <ul>{preview.validation.diagnostics.map((item, index) => <li class={item.severity} key={`${item.code}-${item.path}-${index}`}><b>{item.code}</b><span>{item.message}</span><code>{item.path}</code></li>)}</ul>
          </details>}
          <div class="contract-migration-operations">
            {preview.operations.map((operation) => <details key={operation.relativePath}>
              <summary><span><b>{operation.relativePath}</b><small>{operation.kind} · {operation.beforeRevision.slice(0, 8)} → {operation.afterRevision.slice(0, 8)}</small></span><strong>Review text</strong></summary>
              <div class="contract-migration-diff"><section><p class="section-kicker">Before</p><pre>{operation.before}</pre></section><section><p class="section-kicker">After</p><pre>{operation.after}</pre></section></div>
            </details>)}
            {preview.noOp && <div class="empty-state">No contract bytes need to change. Existing v2 files will not be rewritten.</div>}
          </div>
        </>}
        {state.error && <p class="form-error" role="alert">{state.error}</p>}
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          {state.error && <button type="button" onClick={() => void onRefresh()} disabled={busy}>Refresh preview</button>}
          <button class="primary" type="button" onClick={() => void onApply()} disabled={busy || !preview?.canApply || preview.noOp}>
            {state.applying ? 'Migrating…' : 'Apply reviewed migration'}
          </button>
        </footer>
      </section>
    </div>
  );
}

const JOB_STATE_GUIDANCE: Record<AnalysisJobState | PlanningJobState, string> = {
  queued: 'Queued private work; it is safe to close and resume from recent jobs.',
  running: 'Private work is active. Progress and diagnostics remain inspectable.',
  'awaiting-input': 'The job needs reviewed input before it can continue; no repository mutation has occurred.',
  stale: 'The source revision changed. Review a fresh scope before retrying.',
  cancelled: 'Execution stopped. Private data remains available until explicit cleanup.',
  failed: 'The attempt failed. Retry the reviewed context, choose a fallback or delete its private data.',
  complete: 'The private result is complete; it is still not accepted product or repository truth.',
};

function JobProgress({
  state, message, meta, progress,
}: {
  state: AnalysisJobState | PlanningJobState;
  message: string;
  meta: string;
  progress: number;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return <div class="unified-job-progress" role="status" aria-live="polite" aria-label={`${state}: ${message}`}>
    <div class="analysis-job-heading"><span><b>{state.replaceAll('-', ' ')}</b><strong>{message}</strong><small>{meta}</small></span><i>{percent}%</i></div>
    <div class="analysis-progress" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
    <p class="job-state-guidance">{JOB_STATE_GUIDANCE[state]}</p>
  </div>;
}

function AnalysisDialog({ repository, onCancel }: { repository: Repository; onCancel: () => void }) {
  const [analyzers, setAnalyzers] = useState<AnalyzerDescriptor[]>([]);
  const [analyzerId, setAnalyzerId] = useState('handraise-inventory');
  const [includeDirty, setIncludeDirty] = useState(true);
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [plan, setPlan] = useState<AnalysisPlan | null>(null);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [pastJobs, setPastJobs] = useState<AnalysisJob[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const loadJobs = useCallback(async () => {
    const result = await api<{ jobs: AnalysisJob[] }>(`/api/repositories/${repository.id}/analysis/jobs`);
    setPastJobs(result.jobs);
    return result.jobs;
  }, [repository.id]);

  useEffect(() => {
    let disposed = false;
    Promise.allSettled([
      api<{ analyzers: AnalyzerDescriptor[] }>('/api/analysis/analyzers'),
      api<{ jobs: AnalysisJob[] }>(`/api/repositories/${repository.id}/analysis/jobs`),
    ]).then(([analyzerResult, jobResult]) => {
      if (disposed) return;
      const loadErrors: string[] = [];
      if (analyzerResult.status === 'fulfilled') {
        setAnalyzers(analyzerResult.value.analyzers);
        setAnalyzerId(analyzerResult.value.analyzers.find((analyzer) => analyzer.availability?.available !== false)?.id || 'handraise-inventory');
      } else loadErrors.push(`Analyzer catalog unavailable: ${analyzerResult.reason instanceof Error ? analyzerResult.reason.message : String(analyzerResult.reason)}`);
      if (jobResult.status === 'fulfilled') {
        setPastJobs(jobResult.value.jobs);
        setJob(jobResult.value.jobs.find((item) => ['queued', 'running', 'awaiting-input'].includes(item.state))
          || jobResult.value.jobs.find((item) => item.state === 'stale' || (item.state === 'failed' && item.error?.retryable))
          || null);
      } else loadErrors.push(`Private jobs unavailable: ${jobResult.reason instanceof Error ? jobResult.reason.message : String(jobResult.reason)}`);
      setError(loadErrors.join(' '));
      setBusy(false);
    });
    return () => { disposed = true; };
  }, [repository.id]);

  useEffect(() => {
    if (!job || ['complete', 'stale', 'cancelled', 'failed', 'awaiting-input'].includes(job.state)) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await api<{ job: AnalysisJob }>(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(job.id)}`);
        if (!disposed) setJob(result.job);
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      } finally { if (!disposed) timer = window.setTimeout(() => void poll(), 750); }
    };
    void poll();
    return () => { disposed = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [job?.id, job?.state, repository.id]);

  const preview = async () => {
    setBusy(true);
    setError('');
    setPlan(null);
    try {
      const result = await api<{ plan: AnalysisPlan }>(`/api/repositories/${repository.id}/analysis/plan`, {
        method: 'POST', body: JSON.stringify({ analyzerId, scope: { includeDirty, includeUntracked } }),
      });
      setPlan(result.plan);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const start = async () => {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ job: AnalysisJob }>(`/api/repositories/${repository.id}/analysis/jobs`, {
        method: 'POST', body: JSON.stringify({ planId: plan.id }),
      });
      setJob(result.job);
      setPlan(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const cancel = async (reviewFreshScope = false) => {
    if (!job) return;
    setBusy(true);
    try {
      const result = await api<{ job: AnalysisJob }>(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' });
      if (reviewFreshScope) { setJob(null); await loadJobs(); }
      else setJob(result.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const remove = async (target: AnalysisJob) => {
    if (!window.confirm('Delete this private snapshot, analyzer output and diagnostics now?')) return;
    setBusy(true);
    try {
      await api(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (job?.id === target.id) setJob(null);
      await loadJobs();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const selectedAnalyzer = analyzers.find((analyzer) => analyzer.id === analyzerId) || null;
  const analyzerAvailable = selectedAnalyzer?.availability?.available !== false;
  const terminal = job && ['complete', 'stale', 'cancelled', 'failed'].includes(job.state);
  return (
    <div class="component-name-backdrop analysis-backdrop" role="presentation">
      <section class="component-name-dialog analysis-dialog" role="dialog" aria-modal="true" aria-labelledby="analysis-title">
        <header><div><p class="section-kicker">Read-only repository intelligence</p><h2 id="analysis-title">Analyze {repository.name}</h2></div><button type="button" aria-label="Close analysis" onClick={onCancel} disabled={busy && Boolean(job && !terminal)}>×</button></header>
        <p class="component-name-help">Handraise previews an exact scope, copies it into private read-only storage and runs the analyzer there. Planning and analysis never write into this repository.</p>

        {!job && <div class="analysis-configuration">
          <label><span>Analyzer</span><select value={analyzerId} disabled={busy} onChange={(event) => { setAnalyzerId(event.currentTarget.value); setPlan(null); }}>
            {analyzers.map((analyzer) => <option value={analyzer.id} key={analyzer.id}>{analyzer.name} · {analyzer.availability?.available === false ? 'unavailable' : analyzer.availability?.version || analyzer.version}</option>)}
          </select></label>
          <div class="analysis-scope-toggles"><label><input type="checkbox" checked={includeDirty} disabled={busy} onChange={(event) => { setIncludeDirty(event.currentTarget.checked); setPlan(null); }} /><span><b>Working-tree changes</b><small>Include modified tracked files</small></span></label><label><input type="checkbox" checked={includeUntracked} disabled={busy} onChange={(event) => { setIncludeUntracked(event.currentTarget.checked); setPlan(null); }} /><span><b>Untracked files</b><small>Default secret/generated exclusions still apply</small></span></label></div>
          {selectedAnalyzer && <div class="analysis-privacy"><b>{selectedAnalyzer.privacy.localOnly ? 'Local-only' : 'External boundary'}</b><span>{selectedAnalyzer.privacy.modelAssisted ? 'Model-assisted' : 'Deterministic'} · source {selectedAnalyzer.privacy.sourceMayLeaveHost ? 'may leave this host with consent' : 'stays on this host'}</span></div>}
          {selectedAnalyzer?.availability && <div class={`analysis-availability ${analyzerAvailable ? 'available' : 'unavailable'}`}><span><b>{analyzerAvailable ? 'Available' : selectedAnalyzer.availability.code || 'Unavailable'}</b><small>{selectedAnalyzer.availability.reason || 'Capability detection returned no additional detail.'}</small></span>{selectedAnalyzer.availability.supportedVersions && <code>{selectedAnalyzer.availability.supportedVersions}</code>}</div>}
          <button class="primary analysis-preview-action" type="button" disabled={busy || !analyzers.length || !analyzerAvailable} onClick={() => void preview()}>{busy ? 'Planning…' : 'Preview exact scope'}</button>
        </div>}

        {plan && !job && <div class="analysis-plan-review">
          <div class="analysis-plan-summary"><article><span>Files</span><strong>{plan.manifest.counts.files}</strong><small>{plan.manifest.counts.tracked} tracked · {plan.manifest.counts.untracked} untracked</small></article><article><span>Bytes</span><strong>{formatBytes(plan.manifest.counts.bytes)}</strong><small>{plan.scope.truncated ? 'budget truncated' : 'inside budget'}</small></article><article><span>Git scope</span><strong>{plan.manifest.git.dirty ? 'Dirty' : 'Clean'}</strong><small>{plan.manifest.git.branch || 'detached / non-Git'}</small></article><article><span>Expires</span><strong>{new Date(plan.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><small>{plan.id.slice(0, 12)}</small></article></div>
          <details><summary>Included manifest ({plan.manifest.files.length})</summary><ul class="analysis-file-list">{plan.manifest.files.slice(0, 120).map((file) => <li key={file.path}><code>{file.path}</code><span>{file.source} · {formatBytes(file.size)}</span></li>)}</ul>{plan.manifest.files.length > 120 && <small>Showing the first 120 paths.</small>}</details>
          <details><summary>Exclusions and diagnostics ({plan.scope.excluded.length})</summary><ul class="analysis-file-list">{plan.scope.excluded.slice(0, 120).map((item, index) => <li key={`${item.pattern}-${index}`}><code>{item.pattern}</code><span>{item.reason}</span></li>)}</ul></details>
          {plan.adapterPlan && <div class="analysis-adapter-plan"><span><b>{plan.adapterPlan.mode || 'adapter-defined'} analysis</b><small>{plan.adapterPlan.deterministic ? 'Deterministic' : 'Model-assisted'} · {plan.adapterPlan.isolation || 'private snapshot'}{plan.adapterPlan.upstreamVersion ? ` · upstream ${plan.adapterPlan.upstreamVersion}` : ''}</small></span>{typeof plan.adapterPlan.supportedFiles === 'number' && <strong>{plan.adapterPlan.supportedFiles} supported · {plan.adapterPlan.unsupportedFiles || 0} unsupported</strong>}</div>}
          <div class="analysis-accept-row"><span><b>No repository mutation</b><small>The start action creates only private runtime state.</small></span><button class="primary" type="button" disabled={busy} onClick={() => void start()}>Start reviewed analysis</button></div>
        </div>}

        {job && <div class={`analysis-job ${job.state}`}>
          <JobProgress state={job.state} message={job.message} meta={`${job.analyzerId} · ${job.stage}`} progress={job.progress} />
          {job.resources && <dl><div><dt>Private scope</dt><dd>{job.resources.files || 0} files · {formatBytes(job.resources.bytes || 0)}</dd></div><div><dt>Isolation</dt><dd>{job.resources.isolation || 'private snapshot'}{job.resources.resourceLimits ? ` · ${job.resources.resourceLimits}` : ''}</dd></div><div><dt>Output</dt><dd>{formatBytes(job.resources.outputBytes || 0)}</dd></div><div><dt>Duration</dt><dd>{age(Math.round((job.resources.durationMs || 0) / 1000))}</dd></div></dl>}
          {job.snapshotId && <div class="analysis-snapshot-id"><span>Snapshot</span><code>{job.snapshotId}</code><b>{job.snapshotFreshness}</b></div>}
          {job.error && <p class="form-error" role="alert">{job.error.code ? `${job.error.code} · ` : ''}{job.error.message || job.message}</p>}
          <details class="analysis-events"><summary>Progress events ({job.events.length})</summary><ol>{job.events.map((event, index) => <li key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.message}</span></li>)}</ol></details>
          <div class="button-row">{!terminal && <button class="danger" type="button" disabled={busy} onClick={() => void cancel(job.state === 'awaiting-input')}>{job.state === 'awaiting-input' ? 'Cancel and review a fresh scope' : 'Cancel analysis'}</button>}{terminal && <button type="button" onClick={() => { setJob(null); void loadJobs(); }}>Plan another</button>}{job.state === 'failed' && job.analyzerId !== 'handraise-inventory' && <button type="button" onClick={() => { setJob(null); setPlan(null); setAnalyzerId('handraise-inventory'); setError(''); }}>Use structural fallback</button>}<button class="danger" type="button" disabled={busy} onClick={() => void remove(job)}>Delete private data</button></div>
        </div>}

        {!job && pastJobs.length > 0 && <details class="analysis-history"><summary>Recent private jobs ({pastJobs.length})</summary><div>{pastJobs.slice(0, 10).map((item) => <button type="button" key={item.id} onClick={() => setJob(item)}><i class={item.state} /><span><b>{item.analyzerId}</b><small>{item.state} · {new Date(item.updatedAt).toLocaleString()}</small></span><strong>Open →</strong></button>)}</div></details>}
        {error && <p class="form-error" role="alert">{error}</p>}
        <footer><span /><button type="button" onClick={onCancel} disabled={busy && Boolean(job && !terminal)}>Close</button></footer>
      </section>
    </div>
  );
}

const PLANNING_OPERATION_LABELS: Record<PlanningOperation, { title: string; detail: string }> = {
  'component-design': { title: 'Design components', detail: 'Durable product responsibilities and boundaries' },
  'front-design': { title: 'Design fronts', detail: 'Executable outcomes over accepted responsibilities' },
  'portfolio-review': { title: 'Review work model', detail: 'Gaps, overlap, dependencies and questions' },
};

function PlanningGroundingView({ value }: { value: PlanningGrounding }) {
  return <div class="planning-grounding">
    <span><TruthBadge kind="derived">proposal</TruthBadge><span class={`planning-uncertainty ${value.uncertainty}`}>{value.uncertainty} uncertainty</span></span>
    <div>{value.evidenceIds.map((id) => <code key={id}>{id}</code>)}</div>
    {value.assumptions.length > 0 && <p><b>Assumptions:</b> {value.assumptions.join(' · ')}</p>}
    {value.questions.length > 0 && <p><b>Questions:</b> {value.questions.join(' · ')}</p>}
  </div>;
}

function PlanningResultView({ result }: { result: PlanningResult }) {
  return <div class="planning-result">
    <div class="planning-result-intro"><span><p class="section-kicker">Validated private proposal</p><h3>{PLANNING_OPERATION_LABELS[result.operation].title}</h3></span><b>schema v{result.schemaVersion}</b></div>
    <p>{result.summary}</p>
    {result.components.length > 0 && <section><h4>Component proposals ({result.components.length})</h4><div class="planning-proposal-list">{result.components.map((component) => <article key={component.slug}>
      <header><span><code>{component.slug}</code><h5>{component.title}</h5></span><strong>proposal</strong></header>
      <p>{component.responsibility}</p>
      <dl><div><dt>Responsibilities</dt><dd>{component.responsibilities.join(' · ') || 'None proposed'}</dd></div><div><dt>Limits</dt><dd>{component.limits.join(' · ') || 'None proposed'}</dd></div><div><dt>Territory</dt><dd>{component.territory.join(' · ') || 'Unresolved'}</dd></div><div><dt>Verification</dt><dd>{component.verification.join(' · ') || 'Unresolved'}</dd></div></dl>
      <PlanningGroundingView value={component} />
    </article>)}</div></section>}
    {result.fronts.length > 0 && <section><h4>Front proposals ({result.fronts.length})</h4><div class="planning-proposal-list">{result.fronts.map((front) => <article key={front.slug}>
      <header><span><code>{front.componentSlug} / {front.slug}</code><h5>{front.title}</h5></span><strong>proposal</strong></header>
      <p>{front.objective}</p><small>{front.scope}</small>
      <dl><div><dt>Acceptance</dt><dd>{front.acceptanceCriteria.join(' · ') || 'Unresolved'}</dd></div><div><dt>Verification</dt><dd>{front.verification.join(' · ') || 'Unresolved'}</dd></div><div><dt>Risks</dt><dd>{front.risks.join(' · ') || 'None proposed'}</dd></div><div><dt>Dependencies</dt><dd>{front.dependencies.join(' · ') || 'None proposed'}</dd></div></dl>
      <PlanningGroundingView value={front} />
    </article>)}</div></section>}
    {result.findings.length > 0 && <section><h4>Portfolio findings ({result.findings.length})</h4><div class="planning-proposal-list">{result.findings.map((finding) => <article key={finding.id}>
      <header><span><code>{finding.kind}</code><h5>{finding.title}</h5></span><strong>finding</strong></header>
      <p>{finding.description}</p><small>{finding.recommendation}</small>
      <PlanningGroundingView value={finding} />
    </article>)}</div></section>}
    {(result.assumptions.length > 0 || result.questions.length > 0) && <div class="planning-open-items">
      {result.assumptions.length > 0 && <section><b>Cross-cutting assumptions</b><ul>{result.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></section>}
      {result.questions.length > 0 && <section><b>Questions for human review</b><ul>{result.questions.map((item) => <li key={item}>{item}</li>)}</ul></section>}
    </div>}
    <div class="analysis-accept-row planning-no-write"><span><b>Nothing was published</b><small>Review this proposal; accepted contracts still require an explicit repository action.</small></span><strong>private result</strong></div>
  </div>;
}

function PlanningDialog({ repository, onCancel }: { repository: Repository; onCancel: () => void }) {
  const [adapters, setAdapters] = useState<PlanningAdapterDescriptor[]>([]);
  const [adapterId, setAdapterId] = useState('codex-cli-planner');
  const [operation, setOperation] = useState<PlanningOperation>('component-design');
  const [model, setModel] = useState('default');
  const [analysisJobs, setAnalysisJobs] = useState<AnalysisJob[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState('');
  const [includeProduct, setIncludeProduct] = useState(true);
  const [question, setQuestion] = useState('Suggest the strongest evidence-backed work model and surface the decisions a human still needs to make.');
  const [preflight, setPreflight] = useState<PlanningPreflight | null>(null);
  const [consent, setConsent] = useState(false);
  const [job, setJob] = useState<PlanningJob | null>(null);
  const [result, setResult] = useState<PlanningResult | null>(null);
  const [pastJobs, setPastJobs] = useState<PlanningJob[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const resetPreflight = () => { setPreflight(null); setConsent(false); setError(''); };
  const loadJobs = useCallback(async () => {
    const response = await api<{ jobs: PlanningJob[] }>(`/api/repositories/${repository.id}/planning/jobs`);
    setPastJobs(response.jobs);
    return response.jobs;
  }, [repository.id]);

  useEffect(() => {
    let disposed = false;
    Promise.all([
      api<{ adapters: PlanningAdapterDescriptor[] }>('/api/planning/adapters'),
      api<{ jobs: AnalysisJob[] }>(`/api/repositories/${repository.id}/analysis/jobs`),
      api<{ jobs: PlanningJob[] }>(`/api/repositories/${repository.id}/planning/jobs`),
    ]).then(([adapterResponse, analysisResponse, planningResponse]) => {
      if (disposed) return;
      setAdapters(adapterResponse.adapters);
      const available = adapterResponse.adapters.find((adapter) => adapter.availability?.available !== false);
      setAdapterId(available?.id || adapterResponse.adapters[0]?.id || 'codex-cli-planner');
      setModel(available?.models.find((item) => item.default)?.id || 'default');
      setAnalysisJobs(analysisResponse.jobs);
      const latestSnapshot = analysisResponse.jobs.find((item) => item.snapshotId && ['complete', 'stale'].includes(item.state));
      setAnalysisJobId(latestSnapshot?.id || '');
      setPastJobs(planningResponse.jobs);
      setBusy(false);
    }).catch((reason) => {
      if (!disposed) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
    });
    return () => { disposed = true; };
  }, [repository.id]);

  useEffect(() => {
    if (!job || ['complete', 'cancelled', 'failed'].includes(job.state)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const response = await api<{ job: PlanningJob }>(`/api/repositories/${repository.id}/planning/jobs/${encodeURIComponent(job.id)}`);
        if (!disposed) setJob(response.job);
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    const timer = window.setInterval(() => void poll(), 500);
    void poll();
    return () => { disposed = true; window.clearInterval(timer); };
  }, [job?.id, job?.state, repository.id]);

  useEffect(() => {
    if (!job?.resultAvailable || job.state !== 'complete' || result) return;
    let disposed = false;
    api<{ result: PlanningResult }>(`/api/repositories/${repository.id}/planning/jobs/${encodeURIComponent(job.id)}/result`)
      .then((response) => { if (!disposed) setResult(response.result); })
      .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; };
  }, [job?.id, job?.resultAvailable, job?.state, repository.id, result]);

  const preview = async () => {
    setBusy(true); setError(''); setPreflight(null); setConsent(false); setJob(null); setResult(null);
    try {
      const response = await api<{ preflight: PlanningPreflight }>(`/api/repositories/${repository.id}/planning/preflight`, {
        method: 'POST', body: JSON.stringify({ adapterId, operation, model, analysisJobId: analysisJobId || null, includeProduct, question }),
      });
      setPreflight(response.preflight);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const start = async () => {
    if (!preflight) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await api<{ job: PlanningJob }>(`/api/repositories/${repository.id}/planning/jobs`, {
        method: 'POST', body: JSON.stringify({ preflightId: preflight.id, consent: preflight.consent.required ? consent : true }),
      });
      setJob(response.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const response = await api<{ job: PlanningJob }>(`/api/repositories/${repository.id}/planning/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' });
      setJob(response.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const remove = async (target: PlanningJob) => {
    if (!window.confirm('Delete this private planning context, provider diagnostics and proposal now?')) return;
    setBusy(true);
    try {
      await api(`/api/repositories/${repository.id}/planning/jobs/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (job?.id === target.id) { setJob(null); setResult(null); }
      await loadJobs();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const selectedAdapter = adapters.find((adapter) => adapter.id === adapterId) || null;
  const adapterAvailable = selectedAdapter?.availability?.available !== false;
  const terminal = job && ['complete', 'cancelled', 'failed'].includes(job.state);
  const snapshotJobs = analysisJobs.filter((item) => item.snapshotId && ['complete', 'stale'].includes(item.state));
  return <div class="component-name-backdrop planning-backdrop" role="presentation">
    <section class="component-name-dialog planning-dialog" role="dialog" aria-modal="true" aria-labelledby="planning-title">
      <header><div><p class="section-kicker">Design the work</p><h2 id="planning-title">Plan {repository.name} with a model</h2></div><button type="button" aria-label="Close planning" onClick={onCancel} disabled={busy && Boolean(job && !terminal)}>×</button></header>
      <p class="component-name-help">Handraise sends only the reviewed graph, evidence, product and portfolio snippets below. The model can return proposals, but it cannot inspect or mutate this repository.</p>

      {!job && !preflight && <div class="planning-configuration">
        <div class="planning-field-grid"><label><span>Operation</span><select value={operation} disabled={busy} onChange={(event) => { setOperation(event.currentTarget.value as PlanningOperation); resetPreflight(); }}>{(Object.entries(PLANNING_OPERATION_LABELS) as Array<[PlanningOperation, { title: string; detail: string }]>).map(([id, item]) => <option value={id} key={id}>{item.title} · {item.detail}</option>)}</select></label>
          <label><span>Provider adapter</span><select value={adapterId} disabled={busy} onChange={(event) => { const next = adapters.find((adapter) => adapter.id === event.currentTarget.value); setAdapterId(event.currentTarget.value); setModel(next?.models.find((item) => item.default)?.id || 'default'); resetPreflight(); }}>{adapters.map((adapter) => <option value={adapter.id} key={adapter.id}>{adapter.name} · {adapter.availability?.available === false ? 'unavailable' : adapter.availability?.version || adapter.version}</option>)}</select></label></div>
        <div class="planning-field-grid"><label><span>Model</span><input value={model} disabled={busy} onInput={(event) => { setModel(event.currentTarget.value); resetPreflight(); }} /></label><label><span>Analysis snapshot</span><select value={analysisJobId} disabled={busy} onChange={(event) => { setAnalysisJobId(event.currentTarget.value); resetPreflight(); }}><option value="">No snapshot · product/portfolio only</option>{snapshotJobs.map((item) => <option value={item.id} key={item.id}>{item.analyzerId} · {item.state} · {item.snapshotId?.slice(0, 10)}</option>)}</select></label></div>
        <label class="planning-question"><span>Planning request</span><textarea rows={3} value={question} disabled={busy} onInput={(event) => { setQuestion(event.currentTarget.value); resetPreflight(); }} /></label>
        <label class="planning-product-toggle"><input type="checkbox" checked={includeProduct} disabled={busy} onChange={(event) => { setIncludeProduct(event.currentTarget.checked); resetPreflight(); }} /><span><b>Include accepted product direction</b><small>Only normalized selected fields—not arbitrary repository documents</small></span></label>
        {selectedAdapter && <div class="planning-boundary-summary"><span><b>{selectedAdapter.provider.name} · {selectedAdapter.dataBoundary.kind}</b><small>{selectedAdapter.dataBoundary.destination} · {selectedAdapter.authentication.method}</small></span><strong>{selectedAdapter.authentication.credentialsStoredByHandraise ? 'credential copy' : 'CLI-owned auth'}</strong></div>}
        {selectedAdapter?.availability && <div class={`analysis-availability ${adapterAvailable ? 'available' : 'unavailable'}`}><span><b>{adapterAvailable ? 'Available' : selectedAdapter.availability.code || 'Unavailable'}</b><small>{selectedAdapter.availability.reason || 'No additional capability detail.'}</small></span>{selectedAdapter.availability.supportedVersions && <code>{selectedAdapter.availability.supportedVersions}</code>}</div>}
        {!snapshotJobs.length && <div class="planning-partial-note"><b>No completed analysis snapshot yet</b><span>You can preview product/portfolio-only context, or close this dialog and run repository analysis first.</span></div>}
        <div class="planning-action-row"><button type="button" onClick={onCancel}>Continue manually</button><button class="primary" type="button" disabled={busy || !selectedAdapter || !adapterAvailable || !question.trim()} onClick={() => void preview()}>{busy ? 'Building preflight…' : 'Preview exact model context'}</button></div>
      </div>}

      {preflight && !job && <div class="planning-preflight">
        <div class="analysis-plan-summary"><article><span>Sources</span><strong>{preflight.context.counts.sources}</strong><small>{preflight.context.counts.evidenceIds} allowed evidence IDs</small></article><article><span>Context</span><strong>{formatBytes(preflight.context.counts.bytes)}</strong><small>{preflight.context.digest.slice(0, 12)}</small></article><article><span>Provider</span><strong>{preflight.adapter.provider.name}</strong><small>{preflight.model}</small></article><article><span>Boundary</span><strong>{preflight.dataBoundary.kind}</strong><small>{preflight.dataBoundary.sourceMayLeaveHost ? 'explicit consent required' : 'stays local'}</small></article></div>
        {preflight.context.diagnostics.length > 0 && <div class="planning-diagnostics">{preflight.context.diagnostics.map((item) => <p key={item.code}><b>{item.code}</b><span>{item.message}</span></p>)}</div>}
        <div class="planning-source-list">{preflight.sources.map((source) => <details key={source.id}><summary><span><b>{source.title}</b><small>{source.kind} · {source.provenance} · {formatBytes(source.bytes)}</small></span><code>{source.digest.slice(0, 12)}</code></summary><pre>{source.snippet}</pre><footer><span>{source.evidenceIds.length} evidence IDs</span><code>{source.id}</code></footer></details>)}</div>
        <div class="planning-consent"><span><b>Exact data boundary</b><small>{preflight.consent.statement}</small><em>No repository write or agent run is authorized.</em></span>{preflight.consent.required && <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} /><span>I consent to this exact source set leaving the host</span></label>}</div>
        <div class="planning-action-row"><button type="button" onClick={() => { setPreflight(null); setConsent(false); }}>Change selection</button><button type="button" onClick={onCancel}>Continue manually</button><button class="primary" type="button" disabled={busy || (preflight.consent.required && !consent)} onClick={() => void start()}>{busy ? 'Starting…' : 'Run reviewed planning'}</button></div>
      </div>}

      {job && <div class={`analysis-job planning-job ${job.state}`}>
        <JobProgress state={job.state} message={job.message} meta={`${job.provider.name} · ${job.model} · ${job.stage} · attempt ${job.attempts || 1}`} progress={job.progress} />
        <dl><div><dt>Reviewed context</dt><dd>{job.context.counts.sources} sources · {formatBytes(job.context.counts.bytes)}</dd></div><div><dt>Evidence allowlist</dt><dd>{job.context.counts.evidenceIds} IDs</dd></div><div><dt>Usage</dt><dd>{job.usage ? Object.entries(job.usage).map(([key, value]) => `${key.replaceAll('_', ' ')} ${value}`).join(' · ') : 'Not reported yet'}</dd></div><div><dt>Cost</dt><dd>{job.cost === null ? 'Not reported by adapter' : `$${job.cost.toFixed(4)}`}</dd></div></dl>
        {job.repairs > 0 && <div class="planning-repair-note"><b>Schema repair used</b><span>{job.repairs} of 1 bounded repair attempt consumed; evidence validation still ran after repair.</span></div>}
        {job.error && <p class="form-error" role="alert">{job.error.code ? `${job.error.code} · ` : ''}{job.error.message || job.message}</p>}
        {result && <PlanningResultView result={result} />}
        <details class="analysis-events"><summary>Progress events ({job.events.length})</summary><ol>{job.events.map((event, index) => <li key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.message}</span></li>)}</ol></details>
        <div class="planning-fallback"><span><b>Deterministic/manual fallback is available</b><small>{job.fallback.summary}</small></span><button type="button" onClick={onCancel}>Continue manually</button></div>
        <div class="button-row">{!terminal && <button class="danger" type="button" disabled={busy} onClick={() => void cancel()}>Cancel planning</button>}{terminal && job.state !== 'complete' && preflight && <button type="button" disabled={busy} onClick={() => void start()}>Retry same reviewed context</button>}{terminal && <button type="button" onClick={() => { setJob(null); setResult(null); setPreflight(null); setConsent(false); void loadJobs(); }}>Plan another</button>}<button class="danger" type="button" disabled={busy} onClick={() => void remove(job)}>Delete private data</button></div>
      </div>}

      {!job && !preflight && pastJobs.length > 0 && <details class="analysis-history planning-history"><summary>Recent private planning jobs ({pastJobs.length})</summary><div>{pastJobs.slice(0, 10).map((item) => <button type="button" key={item.id} onClick={() => { setJob(item); setResult(null); }}><i class={item.state} /><span><b>{PLANNING_OPERATION_LABELS[item.operation].title}</b><small>{item.provider.name} · {item.state} · {new Date(item.updatedAt).toLocaleString()}</small></span><strong>Open →</strong></button>)}</div></details>}
      {error && <p class="form-error" role="alert">{error}</p>}
      <footer><span /><button type="button" onClick={onCancel} disabled={busy && Boolean(job && !terminal)}>Close</button></footer>
    </section>
  </div>;
}

const COMPONENT_DESIGN_FIELD_LABELS: Record<ComponentDesignField, string> = {
  purpose: 'Purpose', outcomes: 'Outcomes', responsibilities: 'Responsibilities', limits: 'Limits', invariants: 'Invariants',
  interfaces: 'Interfaces', dependencies: 'Dependencies', dataSystems: 'Data and external systems', territory: 'Territory',
  verification: 'Verification', evidence: 'Evidence', uncertainties: 'Uncertainty and open questions', guidance: 'Agent guidance',
};

const COMPONENT_DESIGN_FIELDS = Object.keys(COMPONENT_DESIGN_FIELD_LABELS) as ComponentDesignField[];

interface ComponentEditorState {
  mode: 'add' | 'edit';
  componentId: string | null;
  title: string;
  slug: string;
  purpose: string;
  outcomes: string;
  responsibilities: string;
  limits: string;
  invariants: string;
  interfaces: string;
  dependencies: string;
  dataSystems: string;
  territory: string;
  verification: string;
  evidence: string;
  uncertainties: string;
  guidance: string;
}

const textLines = (value: string) => value.split('\n').map((item) => item.trim()).filter(Boolean);
const structuredLines = <T extends Record<string, string>>(value: T[], keys: Array<keyof T>) => value
  .map((item) => keys.map((key) => item[key]).join(' | ')).join('\n');

function componentEditorState(component: ComponentDesignCandidate | null, snapshotId: string): ComponentEditorState {
  if (!component) return {
    mode: 'add', componentId: null, title: '', slug: '', purpose: '', outcomes: '', responsibilities: '', limits: '', invariants: '',
    interfaces: '', dependencies: '', dataSystems: '', territory: '', verification: '',
    evidence: `declared | ${snapshotId} | Human-authored component grounded against the reviewed snapshot.`,
    uncertainties: 'Human-authored boundary; evidence reconciliation is required before publication.', guidance: '',
  };
  return {
    mode: 'edit', componentId: component.id, title: component.title, slug: component.slug, purpose: component.contract.purpose,
    outcomes: component.contract.outcomes.join('\n'), responsibilities: component.contract.responsibilities.join('\n'), limits: component.contract.limits.join('\n'),
    invariants: component.contract.invariants.join('\n'), interfaces: structuredLines(component.contract.interfaces, ['kind', 'target', 'description']),
    dependencies: structuredLines(component.contract.dependencies, ['kind', 'target', 'reason']), dataSystems: component.contract.dataSystems.join('\n'),
    territory: component.contract.territory.join('\n'), verification: component.contract.verification.join('\n'),
    evidence: structuredLines(component.contract.evidence, ['kind', 'reference', 'reason']), uncertainties: component.contract.uncertainties.join('\n'),
    guidance: component.contract.guidance,
  };
}

function parseStructured<T extends string>(value: string, kinds: readonly T[], label: string): Array<{ kind: T; target: string; detail: string }> {
  return textLines(value).map((line, index) => {
    const [rawKind, rawTarget, ...rest] = line.split('|').map((item) => item.trim());
    const kind = rawKind as T;
    const detail = rest.join(' | ').trim();
    if (!kinds.includes(kind) || !rawTarget || !detail) throw new Error(`${label} line ${index + 1} must use: ${kinds.join('/')} | target | description`);
    return { kind, target: rawTarget, detail };
  });
}

function editorPayload(editor: ComponentEditorState) {
  const interfaces = parseStructured(editor.interfaces, ['provides', 'consumes'] as const, 'Interface')
    .map((item) => ({ kind: item.kind, target: item.target, description: item.detail }));
  const dependencies = parseStructured(editor.dependencies, ['hard', 'soft', 'external'] as const, 'Dependency')
    .map((item) => ({ kind: item.kind, target: item.target, reason: item.detail }));
  const evidence = parseStructured(editor.evidence, ['extracted', 'inferred', 'declared'] as const, 'Evidence')
    .map((item) => ({ kind: item.kind, reference: item.target, reason: item.detail }));
  const contract = {
    purpose: editor.purpose.trim(), outcomes: textLines(editor.outcomes), responsibilities: textLines(editor.responsibilities), limits: textLines(editor.limits),
    invariants: textLines(editor.invariants), interfaces, dependencies, dataSystems: textLines(editor.dataSystems), territory: textLines(editor.territory),
    verification: textLines(editor.verification), evidence, uncertainties: textLines(editor.uncertainties), guidance: editor.guidance.trim(),
  };
  const fieldGrounding = COMPONENT_DESIGN_FIELDS.reduce((result, field) => {
    result[field] = {
      evidenceIds: [], intentIds: [], assumptions: [`Human-authored ${COMPONENT_DESIGN_FIELD_LABELS[field].toLocaleLowerCase()}; reconcile cited evidence before publication.`], questions: [],
    };
    return result;
  }, {} as Record<ComponentDesignField, ComponentFieldGrounding>);
  return { title: editor.title.trim(), slug: editor.slug.trim(), contract, fieldGrounding };
}

function ComponentContractEditor({ state, busy, onChange, onCancel, onSave }: {
  state: ComponentEditorState;
  busy: boolean;
  onChange: (state: ComponentEditorState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const update = (field: keyof ComponentEditorState, value: string) => onChange({ ...state, [field]: value });
  const listField = (field: keyof ComponentEditorState, label: string, help = 'One item per line.') => <label><span>{label}</span><textarea rows={3} value={String(state[field])} disabled={busy} onInput={(event) => update(field, event.currentTarget.value)} /><small>{help}</small></label>;
  return <section class="architecture-editor" aria-label={`${state.mode === 'add' ? 'Add' : 'Edit'} component contract`}>
    <header><div><p class="section-kicker">Complete component v2</p><h3>{state.mode === 'add' ? 'Author a component' : 'Edit reviewed contract'}</h3></div><button type="button" onClick={onCancel} aria-label="Close component editor">×</button></header>
    <div class="architecture-editor-grid">
      <label><span>Title</span><input value={state.title} disabled={busy} onInput={(event) => update('title', event.currentTarget.value)} /></label>
      <label><span>Slug</span><input value={state.slug} disabled={busy} onInput={(event) => update('slug', event.currentTarget.value)} /></label>
    </div>
    <label><span>Purpose</span><textarea rows={3} value={state.purpose} disabled={busy} onInput={(event) => update('purpose', event.currentTarget.value)} /></label>
    <div class="architecture-editor-grid">
      {listField('outcomes', 'Outcomes')}{listField('responsibilities', 'Responsibilities')}{listField('limits', 'Limits')}{listField('invariants', 'Invariants')}
      {listField('interfaces', 'Interfaces', 'provides/consumes | target | description')}{listField('dependencies', 'Dependencies', 'hard/soft/external | target | reason')}
      {listField('dataSystems', 'Data and external systems')}{listField('territory', 'Territory')}{listField('verification', 'Verification')}
      {listField('evidence', 'Evidence', 'extracted/inferred/declared | reference ID | reason')}{listField('uncertainties', 'Uncertainty and open questions')}
    </div>
    <label><span>Agent guidance</span><textarea rows={3} value={state.guidance} disabled={busy} onInput={(event) => update('guidance', event.currentTarget.value)} /></label>
    <p class="architecture-editor-note">Human edits remain explicit assumptions until you reconcile their evidence. This editor does not publish repository files.</p>
    <footer><button type="button" onClick={onCancel} disabled={busy}>Cancel</button><button class="primary" type="button" onClick={onSave} disabled={busy}>{busy ? 'Saving…' : state.mode === 'add' ? 'Add to private draft' : 'Save private edit'}</button></footer>
  </section>;
}

function ArchitectureQuality({ quality, compact = false }: { quality: ComponentDesignQuality; compact?: boolean }) {
  const percentage = (value: number | null) => value === null ? 'n/a' : `${Math.round(value * 100)}%`;
  return <div class={`architecture-quality ${compact ? 'compact' : ''}`}>
    <dl>
      <div><dt>Coverage</dt><dd>{percentage(quality.coverage.ratio)}</dd></div>
      <div><dt>Cohesion</dt><dd>{percentage(quality.cohesion.ratio)}</dd></div>
      <div><dt>Crossings</dt><dd>{quality.coupling.crossingRelations}</dd></div>
      <div><dt>Overlap</dt><dd>{quality.overlap.entities}</dd></div>
      <div><dt>Cycles</dt><dd>{quality.dependencyCycles.length}</dd></div>
      <div><dt>Unstable</dt><dd>{quality.unstableBoundaries.length}</dd></div>
    </dl>
    {!compact && <>
      <div class={`architecture-gate ${quality.gateC.pass ? 'pass' : 'review'}`}><b>{quality.gateC.pass ? 'Gate C passed' : 'Gate C needs review'}</b><span>{quality.gateC.statement}</span></div>
      {quality.coverage.orphanEntityIds.length > 0 && <details><summary>{quality.coverage.orphanEntityIds.length} orphan evidence entities</summary><code>{quality.coverage.orphanEntityIds.join('\n')}</code></details>}
      {quality.diagnostics.length > 0 && <details><summary>{quality.diagnostics.length} quality diagnostics</summary><ul>{quality.diagnostics.map((item, index) => <li key={`${item.code}-${index}`} class={item.severity}><b>{item.code}</b><span>{item.message}</span></li>)}</ul></details>}
    </>}
  </div>;
}

function ArchitectureContractField({ field, component, busy, onLock }: {
  field: ComponentDesignField;
  component: ComponentDesignCandidate;
  busy: boolean;
  onLock: (field: ComponentDesignField, locked: boolean) => void;
}) {
  const value = component.contract[field];
  const grounding = component.fieldGrounding[field];
  const locked = component.lockedFields.includes(field);
  const renderValue = () => {
    if (typeof value === 'string') return <p>{value}</p>;
    if (!value.length) return <p class="architecture-none">None observed or declared.</p>;
    if (typeof value[0] === 'string') return <ul>{(value as string[]).map((item, index) => <li key={`${field}-${index}`}>{item}</li>)}</ul>;
    return <ul>{(value as Array<Record<string, string>>).map((item, index) => <li key={`${field}-${index}`}><b>{item.kind}</b> <code>{item.target || item.reference}</code><span>{item.description || item.reason}</span></li>)}</ul>;
  };
  return <section class="architecture-contract-field">
    <header><h5>{COMPONENT_DESIGN_FIELD_LABELS[field]}</h5><button type="button" class={locked ? 'locked' : ''} disabled={busy} onClick={() => onLock(field, locked)}>{locked ? 'Locked' : 'Lock'}</button></header>
    {renderValue()}
    <details class="architecture-grounding"><summary>Why this field?</summary>
      {grounding.evidenceIds.length > 0 && <div><b>Evidence</b>{grounding.evidenceIds.map((id) => <code key={id}>{id}</code>)}</div>}
      {grounding.intentIds.length > 0 && <div><b>Product intent</b>{grounding.intentIds.map((id) => <code key={id}>{id}</code>)}</div>}
      {grounding.assumptions.length > 0 && <div><b>Assumptions</b><ul>{grounding.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {grounding.questions.length > 0 && <div><b>Open questions</b><ul>{grounding.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    </details>
  </section>;
}

function ComponentArchitectureDialog({ repository, launchDraftId, onCancel, onAnalyze, onPlan, onPlanFronts, onPublish }: {
  repository: Repository;
  launchDraftId?: string | null;
  onCancel: () => void;
  onAnalyze: () => void;
  onPlan: () => void;
  onPlanFronts: (draft: ComponentDesignDraft, alternative: ComponentDesignAlternative) => void;
  onPublish: (draft: ComponentDesignDraft, alternative: ComponentDesignAlternative) => void;
}) {
  const [analysisJobs, setAnalysisJobs] = useState<AnalysisJob[]>([]);
  const [planningJobs, setPlanningJobs] = useState<PlanningJob[]>([]);
  const [drafts, setDrafts] = useState<ComponentDesignDraft[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState('');
  const [planningJobId, setPlanningJobId] = useState('');
  const [includeProduct, setIncludeProduct] = useState(true);
  const [draft, setDraft] = useState<ComponentDesignDraft | null>(null);
  const [componentId, setComponentId] = useState('');
  const [compareId, setCompareId] = useState('');
  const [comparison, setComparison] = useState<ComponentDesignComparison | null>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [editor, setEditor] = useState<ComponentEditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  const loadSources = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [analysisResponse, planningResponse, draftResponse] = await Promise.all([
        api<{ jobs: AnalysisJob[] }>(`/api/repositories/${repository.id}/analysis/jobs`),
        api<{ jobs: PlanningJob[] }>(`/api/repositories/${repository.id}/planning/jobs`),
        api<{ drafts: ComponentDesignDraft[] }>(`/api/repositories/${repository.id}/component-design/drafts`),
      ]);
      setAnalysisJobs(analysisResponse.jobs);
      setPlanningJobs(planningResponse.jobs);
      setDrafts(draftResponse.drafts);
      const launched = launchDraftId ? draftResponse.drafts.find((item) => item.id === launchDraftId) : null;
      if (launched) setDraft(launched);
      const latest = analysisResponse.jobs.find((item) => item.snapshotId && ['complete', 'stale'].includes(item.state));
      if (latest) setAnalysisJobId((current) => current || latest.id);
      const model = planningResponse.jobs.find((item) => item.operation === 'component-design' && item.state === 'complete' && item.resultAvailable);
      if (model) setPlanningJobId((current) => current || model.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [repository.id, launchDraftId]);

  useEffect(() => { void loadSources(); }, [loadSources]);

  const selectedAlternative = draft?.alternatives.find((item) => item.id === draft.selectedAlternativeId) || null;
  const selectedComponent = selectedAlternative?.components.find((item) => item.id === componentId) || selectedAlternative?.components[0] || null;

  useEffect(() => {
    if (selectedAlternative && !selectedAlternative.components.some((item) => item.id === componentId)) {
      setComponentId(selectedAlternative.components[0]?.id || '');
      setMergeIds([]);
    }
    if (draft && (!compareId || compareId === draft.selectedAlternativeId || !draft.alternatives.some((item) => item.id === compareId))) {
      setCompareId(draft.alternatives.find((item) => item.id !== draft.selectedAlternativeId)?.id || '');
      setComparison(null);
    }
  }, [draft?.revision, draft?.selectedAlternativeId, selectedAlternative?.id, componentId, compareId]);

  const createDraft = async () => {
    if (!analysisJobId) { setError('Choose a completed analysis snapshot first.'); return; }
    setBusy(true); setError(''); setWarning('');
    try {
      const response = await api<{ draft: ComponentDesignDraft }>(`/api/repositories/${repository.id}/component-design/drafts`, {
        method: 'POST', body: JSON.stringify({ analysisJobId, planningJobId: planningJobId || null, includeModel: Boolean(planningJobId), includeProduct }),
      });
      setDraft(response.draft); setDrafts((current) => [response.draft, ...current.filter((item) => item.id !== response.draft.id)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const openDraft = async (id: string) => {
    setBusy(true); setError(''); setWarning('');
    try {
      const response = await api<{ draft: ComponentDesignDraft; contextWarning: string | null }>(`/api/repositories/${repository.id}/component-design/drafts/${encodeURIComponent(id)}`);
      setDraft(response.draft); setWarning(response.contextWarning || '');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const applyOperation = async (operation: Record<string, unknown>) => {
    if (!draft) return null;
    setBusy(true); setError(''); setWarning('');
    try {
      const response = await api<{ draft: ComponentDesignDraft; contextWarning: string | null }>(`/api/repositories/${repository.id}/component-design/drafts/${encodeURIComponent(draft.id)}/operations`, {
        method: 'POST', body: JSON.stringify({ ...operation, expectedRevision: draft.revision }),
      });
      setDraft(response.draft); setWarning(response.contextWarning || '');
      return response.draft;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return null; }
    finally { setBusy(false); }
  };

  const removeDraft = async (target = draft) => {
    if (!target || !window.confirm('Delete this private architecture workspace? No repository files will change.')) return;
    setBusy(true); setError('');
    try {
      await api(`/api/repositories/${repository.id}/component-design/drafts/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      setDrafts((current) => current.filter((item) => item.id !== target.id));
      if (draft?.id === target.id) setDraft(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const selectAlternative = async (alternativeId: string) => {
    setComparison(null);
    await applyOperation({ operation: 'select-alternative', alternativeId });
  };

  const compare = async () => {
    if (!draft || !compareId) return;
    setBusy(true); setError('');
    try {
      const response = await api<{ comparison: ComponentDesignComparison }>(`/api/repositories/${repository.id}/component-design/drafts/${encodeURIComponent(draft.id)}/compare?left=${encodeURIComponent(draft.selectedAlternativeId)}&right=${encodeURIComponent(compareId)}`);
      setComparison(response.comparison);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const reorder = async (candidate: ComponentDesignCandidate, direction: -1 | 1) => {
    if (!selectedAlternative) return;
    const ids = selectedAlternative.components.map((item) => item.id);
    const index = ids.indexOf(candidate.id);
    const next = index + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    await applyOperation({ operation: 'reorder-components', componentIds: ids });
  };

  const split = async (candidate: ComponentDesignCandidate) => {
    if (candidate.memberEntityIds.length < 2) { setError('This candidate needs at least two mapped entities to split.'); return; }
    const defaultFirst = candidate.memberEntityIds.slice(0, Math.ceil(candidate.memberEntityIds.length / 2));
    const rawMembers = window.prompt('Entity IDs for the first component, comma-separated. Every remaining entity goes to the second component.', defaultFirst.join(', '));
    if (rawMembers === null) return;
    const firstMembers = [...new Set(rawMembers.split(',').map((item) => item.trim()).filter(Boolean))];
    const secondMembers = candidate.memberEntityIds.filter((id) => !firstMembers.includes(id));
    const firstTitle = window.prompt('First component title:', `${candidate.title} A`);
    if (!firstTitle) return;
    const secondTitle = window.prompt('Second component title:', `${candidate.title} B`);
    if (!secondTitle) return;
    const slug = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    await applyOperation({
      operation: 'split-component', componentId: candidate.id,
      first: { title: firstTitle, slug: slug(firstTitle), memberEntityIds: firstMembers },
      second: { title: secondTitle, slug: slug(secondTitle), memberEntityIds: secondMembers },
    });
  };

  const merge = async () => {
    if (mergeIds.length < 2) { setError('Select at least two component candidates to merge.'); return; }
    const title = window.prompt('Merged component title:', 'Merged responsibility');
    if (!title) return;
    const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const next = await applyOperation({ operation: 'merge-components', componentIds: mergeIds, component: { title, slug } });
    if (next) setMergeIds([]);
  };

  const saveEditor = async () => {
    if (!editor) return;
    try {
      const payload = editorPayload(editor);
      if (!payload.title || !payload.slug || !payload.contract.purpose || !payload.contract.guidance) throw new Error('Title, slug, purpose and agent guidance are required.');
      if (!payload.contract.outcomes.length || !payload.contract.responsibilities.length || !payload.contract.limits.length || !payload.contract.invariants.length || !payload.contract.territory.length || !payload.contract.verification.length || !payload.contract.evidence.length) {
        throw new Error('Outcomes, responsibilities, limits, invariants, territory, verification and evidence each need at least one item.');
      }
      const next = editor.mode === 'add'
        ? await applyOperation({ operation: 'add-component', component: { ...payload, memberEntityIds: [], lockedFields: [] } })
        : await applyOperation({ operation: 'edit-component', componentId: editor.componentId, updates: payload });
      if (next) setEditor(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const answer = async (question: ComponentDesignDraft['questions'][number]) => {
    const value = window.prompt(question.question, question.answer);
    if (value === null) return;
    await applyOperation({ operation: 'answer-question', questionId: question.id, answer: value });
  };

  const snapshotJobs = analysisJobs.filter((item) => item.snapshotId && ['complete', 'stale'].includes(item.state));
  const modelJobs = planningJobs.filter((item) => item.operation === 'component-design' && item.state === 'complete' && item.resultAvailable);

  return <div class="component-name-backdrop architecture-backdrop" role="presentation">
    <section class="component-name-dialog architecture-dialog" role="dialog" aria-modal="true" aria-labelledby="architecture-title">
      <header><div><p class="section-kicker">Understand → design</p><h2 id="architecture-title">Design {repository.name}'s component architecture</h2></div><button type="button" aria-label="Close component architecture" onClick={onCancel} disabled={busy}>×</button></header>
      {!draft ? <div class="architecture-start">
        <p class="component-name-help">Combine one immutable system-map snapshot with accepted product intent. Handraise creates a private review workspace only—no component or front Markdown is written here.</p>
        <div class="architecture-source-grid">
          <label><span>Analysis snapshot · required</span><select value={analysisJobId} disabled={busy} onChange={(event) => setAnalysisJobId(event.currentTarget.value)}><option value="">Choose a completed snapshot</option>{snapshotJobs.map((item) => <option key={item.id} value={item.id}>{item.analyzerId} · {item.state} · {item.snapshotId?.slice(0, 12)}</option>)}</select></label>
          <label><span>Optional model alternative</span><select value={planningJobId} disabled={busy} onChange={(event) => setPlanningJobId(event.currentTarget.value)}><option value="">Deterministic/manual only</option>{modelJobs.map((item) => <option key={item.id} value={item.id}>{item.provider.name} · {item.model} · {new Date(item.updatedAt).toLocaleString()}</option>)}</select></label>
        </div>
        <label class="planning-product-toggle"><input type="checkbox" checked={includeProduct} disabled={busy} onChange={(event) => setIncludeProduct(event.currentTarget.checked)} /><span><b>Use accepted product direction</b><small>Normalized intent influences purpose, outcomes, invariants and boundary questions.</small></span></label>
        {!snapshotJobs.length && <div class="planning-partial-note"><b>No completed analysis snapshot</b><span>Architecture design needs a system map; run read-only analysis first.</span><button type="button" onClick={onAnalyze}>Analyze repository</button></div>}
        {!modelJobs.length && <div class="architecture-optional-model"><span><b>Model synthesis is optional</b><small>Deterministic and manual paths retain full contract/validation parity.</small></span><button type="button" onClick={onPlan}>Create model proposal</button></div>}
        <div class="architecture-start-actions"><button type="button" onClick={() => void loadSources()} disabled={busy}>Refresh sources</button><button class="primary" type="button" disabled={busy || !analysisJobId} onClick={() => void createDraft()}>{busy ? 'Building workspace…' : 'Generate private alternatives'}</button></div>
        {drafts.length > 0 && <section class="architecture-recent"><h3>Recent private workspaces</h3>{drafts.map((item) => <article key={item.id}><span><b>{item.alternatives.length} alternatives · {item.state}</b><small>{new Date(item.updatedAt).toLocaleString()} · expires {new Date(item.expiresAt).toLocaleDateString()}</small></span><button type="button" onClick={() => void openDraft(item.id)}>Resume</button><button class="danger" type="button" onClick={() => void removeDraft(item)}>Delete</button></article>)}</section>}
      </div> : <div class="architecture-workspace">
        <div class="architecture-safety"><span><b>Private draft · nothing published</b><small>{draft.source.snapshot.analyzer.id} {draft.source.snapshot.analyzer.version} · snapshot {draft.source.snapshotId.slice(0, 12)} · {draft.source.productIncluded ? 'product included' : 'repository evidence only'}</small></span><strong>{draft.state}</strong></div>
        {(draft.stale || warning) && <div class="architecture-stale" role="status"><b>Context needs attention</b><span>{[...draft.staleReasons, warning].filter(Boolean).join(' ')}</span></div>}
        {draft.history.at(-1)?.operation === 'regenerate' && <div class="architecture-history-note" role="status"><b>Regeneration result</b><span>{draft.history.at(-1)?.summary}</span></div>}
        <nav class="architecture-alternatives" aria-label="Architecture alternatives">{draft.alternatives.map((alternative) => <button type="button" key={alternative.id} class={alternative.id === draft.selectedAlternativeId ? 'active' : ''} aria-pressed={alternative.id === draft.selectedAlternativeId} disabled={busy} onClick={() => void selectAlternative(alternative.id)}><span><b>{alternative.title}</b><small>{alternative.strategy} · {alternative.components.length} components</small></span><em class={alternative.quality.gateC.pass ? 'pass' : 'review'}>{alternative.quality.gateC.pass ? 'Gate C' : 'Review'}</em><ArchitectureQuality quality={alternative.quality} compact /></button>)}</nav>
        {selectedAlternative && <>
          <section class="architecture-alternative-intro"><div><p class="section-kicker">{selectedAlternative.strategy} alternative</p><h3>{selectedAlternative.title}</h3><p>{selectedAlternative.summary}</p></div><ArchitectureQuality quality={selectedAlternative.quality} /></section>
          <div class="architecture-tradeoffs"><section><h4>Why this boundary</h4><ul>{selectedAlternative.rationale.map((item, index) => <li key={index}>{item}</li>)}</ul></section><section><h4>Strengths</h4><ul>{selectedAlternative.tradeoffs.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul></section><section><h4>Risks</h4><ul>{selectedAlternative.tradeoffs.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></section></div>
          {draft.questions.length > 0 && <section class="architecture-questions"><header><div><p class="section-kicker">Decisions only humans can make</p><h3>Boundary questions</h3></div><span>{draft.questions.filter((item) => item.state === 'answered').length}/{draft.questions.length} answered</span></header>{draft.questions.map((question) => <article key={question.id} class={question.state}><span><b>{question.question}</b><small>{question.why}</small>{question.answer && <p>{question.answer}</p>}<em>Affects {question.affects.map((field) => COMPONENT_DESIGN_FIELD_LABELS[field]).join(', ')}</em></span><button type="button" disabled={busy} onClick={() => void answer(question)}>{question.answer ? 'Edit answer' : 'Answer'}</button></article>)}</section>}
          <section class="architecture-compare"><label><span>Compare selected with</span><select value={compareId} disabled={busy} onChange={(event) => { setCompareId(event.currentTarget.value); setComparison(null); }}>{draft.alternatives.filter((item) => item.id !== draft.selectedAlternativeId).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><button type="button" disabled={busy || !compareId} onClick={() => void compare()}>Compare alternatives</button>{comparison && <div><b>{comparison.materiallyDifferent ? 'Materially different' : 'Equivalent assignment'}</b><span>{comparison.components.added.length} added · {comparison.components.removed.length} removed · {comparison.components.changed.length} changed · {comparison.movedEntities.length} entities moved</span><details><summary>Review exact diff</summary><pre>{JSON.stringify({ components: comparison.components, movedEntities: comparison.movedEntities }, null, 2)}</pre></details></div>}</section>
          <div class="architecture-review-grid">
            <aside class="architecture-component-list" aria-label="Component candidates"><header><div><h3>Components</h3><small>{selectedAlternative.components.length} proposed boundaries</small></div><button type="button" onClick={() => setEditor(componentEditorState(null, draft.source.snapshotId))}>Add manual</button></header>{selectedAlternative.components.map((candidate, index) => <article key={candidate.id} class={candidate.id === selectedComponent?.id ? 'active' : ''}><label><input type="checkbox" checked={mergeIds.includes(candidate.id)} onChange={(event) => setMergeIds((current) => event.currentTarget.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} aria-label={`Select ${candidate.title} for merge`} /></label><button type="button" class="architecture-component-select" onClick={() => setComponentId(candidate.id)}><span><b>{candidate.title}</b><small>{candidate.slug} · {candidate.origin} · {candidate.memberEntityIds.length} entities</small></span><em>{candidate.lockedFields.length} locks</em></button><div><button type="button" aria-label={`Move ${candidate.title} up`} disabled={busy || index === 0} onClick={() => void reorder(candidate, -1)}>↑</button><button type="button" aria-label={`Move ${candidate.title} down`} disabled={busy || index === selectedAlternative.components.length - 1} onClick={() => void reorder(candidate, 1)}>↓</button></div></article>)}<footer><button type="button" disabled={busy || mergeIds.length < 2} onClick={() => void merge()}>Merge selected ({mergeIds.length})</button></footer></aside>
            <section class="architecture-component-detail">{selectedComponent ? <><header><div><p class="section-kicker">{selectedComponent.origin} candidate · order {selectedComponent.order}</p><h3>{selectedComponent.title}</h3><code>{selectedComponent.slug}</code></div><div><button type="button" disabled={busy} onClick={() => setEditor(componentEditorState(selectedComponent, draft.source.snapshotId))}>Edit</button><button type="button" disabled={busy || selectedComponent.memberEntityIds.length < 2 || selectedComponent.lockedFields.length > 0} onClick={() => void split(selectedComponent)}>Split</button><button class="danger" type="button" disabled={busy || selectedAlternative.components.length === 1 || selectedComponent.lockedFields.length > 0} onClick={() => void applyOperation({ operation: 'delete-component', componentId: selectedComponent.id })}>Delete</button></div></header><div class="architecture-entity-members"><b>Mapped responsibility members</b>{selectedComponent.memberEntityIds.length ? <code>{selectedComponent.memberEntityIds.join('\n')}</code> : <span>No map entities assigned; this manual boundary needs evidence reconciliation.</span>}</div><div class="architecture-contract-fields">{COMPONENT_DESIGN_FIELDS.map((field) => <ArchitectureContractField key={field} field={field} component={selectedComponent} busy={busy} onLock={(target, locked) => void applyOperation({ operation: locked ? 'unlock-field' : 'lock-field', componentId: selectedComponent.id, field: target, reason: 'Locked during human architecture review.' })} />)}</div></> : <p class="empty-state">Choose a component candidate.</p>}</section>
          </div>
        </>}
        <footer class="architecture-workspace-actions"><button type="button" onClick={() => setDraft(null)} disabled={busy}>Back to workspaces</button><button class="danger" type="button" onClick={() => void removeDraft()} disabled={busy}>Delete private draft</button><span /><button type="button" disabled={busy} onClick={() => void applyOperation({ operation: draft.state === 'skipped' ? 'resume' : 'skip' })}>{draft.state === 'skipped' ? 'Resume review' : 'Skip for now'}</button><button type="button" disabled={busy} onClick={() => void applyOperation({ operation: 'regenerate', includeModel: draft.source.modelIncluded })}>{busy ? 'Working…' : 'Regenerate safely'}</button><button type="button" disabled={busy || !selectedAlternative || draft.state === 'skipped'} onClick={() => selectedAlternative && onPublish(draft, selectedAlternative)}>Review publication</button><button class="primary" type="button" disabled={busy || !selectedAlternative} onClick={() => selectedAlternative && onPlanFronts(draft, selectedAlternative)}>Plan fronts from this architecture</button></footer>
      </div>}
      {editor && draft && <div class="architecture-editor-backdrop"><ComponentContractEditor state={editor} busy={busy} onChange={setEditor} onCancel={() => setEditor(null)} onSave={() => void saveEditor()} /></div>}
      {error && <p class="form-error architecture-error" role="alert">{error}</p>}
      {!draft && <footer><span /><button type="button" onClick={onCancel} disabled={busy}>Close</button></footer>}
    </section>
  </div>;
}

const FRONT_DESIGN_FIELD_LABELS: Record<FrontDesignField, string> = {
  outcome: 'Observable outcome', leadComponent: 'Lead component', affectedComponents: 'Affected components', motivation: 'Motivation', scope: 'Scope', nonGoals: 'Non-goals',
  dependencies: 'Dependencies', readiness: 'Readiness', acceptanceCriteria: 'Acceptance criteria', verification: 'Verification', deliverables: 'Deliverables', risks: 'Risks',
  unknowns: 'Unknowns', evidence: 'Evidence', tasks: 'Ordered checklist', context: 'Confirmed context', handoff: 'Handoff',
};
const FRONT_DESIGN_FIELDS = Object.keys(FRONT_DESIGN_FIELD_LABELS) as FrontDesignField[];

interface FrontPlanEditorState {
  mode: 'add' | 'edit';
  frontId: string | null;
  original: FrontDesignCandidate | null;
  title: string; slug: string; candidateKind: FrontDesignCandidate['candidateKind']; leadComponent: string; affectedComponents: string; goalIds: string;
  outcome: string; motivation: string; scope: string; nonGoals: string; dependencies: string; readiness: string; acceptanceCriteria: string;
  verification: string; deliverables: string; risks: string; unknowns: string; evidence: string; tasks: string; context: string; handoff: string;
  snapshotId: string; evidenceReference: string;
}

const frontPlanLines = (value: string) => value.split('\n').map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
const frontPlanSlug = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

function frontPlanEditorState(front: FrontDesignCandidate | null, defaults: { leadComponent: string; goalId: string; snapshotId: string; evidenceReference: string }): FrontPlanEditorState {
  if (!front) return {
    mode: 'add', frontId: null, original: null, title: 'New research front', slug: 'new-research-front', candidateKind: 'research', leadComponent: defaults.leadComponent,
    affectedComponents: '', goalIds: defaults.goalId, outcome: 'A bounded answer removes one explicit unknown from the selected product goal.',
    motivation: 'This unknown needs evidence before implementation can be planned safely.', scope: 'Investigate only the stated question and record the evidence-backed answer.',
    nonGoals: 'Do not implement downstream product behavior.', dependencies: '', readiness: 'The question, owner and evidence boundary are explicit.',
    acceptanceCriteria: 'A reviewer can inspect the answer, evidence and downstream implication.', verification: 'Review the answer against cited repository and product evidence.',
    deliverables: 'A recorded answer with evidence and implications.', risks: 'Available evidence may be insufficient.', unknowns: 'The research question still needs a human-reviewed answer.',
    evidence: `declared | ${defaults.evidenceReference} | Human-authored front grounded in the selected planning snapshot.`,
    tasks: '[ ] State the bounded question.\n[ ] Inspect cited evidence.\n[ ] Record the answer and downstream implications.',
    context: 'Manual candidate inside a private front-planning workspace.', handoff: 'Return an evidence-backed answer; do not broaden into implementation without review.',
    snapshotId: defaults.snapshotId, evidenceReference: defaults.evidenceReference,
  };
  return {
    mode: 'edit', frontId: front.id, original: front, title: front.title, slug: front.slug, candidateKind: front.candidateKind, leadComponent: front.leadComponent,
    affectedComponents: front.affectedComponents.join('\n'), goalIds: front.goalIds.join('\n'), outcome: front.outcome, motivation: front.motivation, scope: front.scope,
    nonGoals: front.nonGoals.join('\n'), dependencies: front.dependencies.map((item) => `${item.kind} | ${item.target} | ${item.reason}`).join('\n'), readiness: front.readiness.join('\n'),
    acceptanceCriteria: front.acceptanceCriteria.join('\n'), verification: front.verification.join('\n'), deliverables: front.deliverables.join('\n'), risks: front.risks.join('\n'),
    unknowns: front.unknowns.join('\n'), evidence: front.evidence.map((item) => `${item.kind} | ${item.reference} | ${item.reason}`).join('\n'),
    tasks: front.tasks.map((item) => `${item.state === 'done' ? '[x]' : item.state === 'skipped' ? '[-]' : '[ ]'} ${item.text}`).join('\n'), context: front.context, handoff: front.handoff,
    snapshotId: defaults.snapshotId, evidenceReference: defaults.evidenceReference,
  };
}

function parseFrontPlanTriples(value: string, label: string) {
  return frontPlanLines(value).map((line) => {
    const [kind, target, ...reason] = line.split('|').map((item) => item.trim());
    if (!kind || !target || !reason.join(' | ').trim()) throw new Error(`${label} lines must use “kind | target/reference | reason”.`);
    return { kind, target, reference: target, reason: reason.join(' | ').trim() };
  });
}

function frontPlanEditorPayload(editor: FrontPlanEditorState) {
  const dependencies = parseFrontPlanTriples(editor.dependencies, 'Dependency').map(({ kind, target, reason }) => ({ kind, target, reason }));
  const evidence = parseFrontPlanTriples(editor.evidence, 'Evidence').map(({ kind, reference, reason }) => ({ kind, reference, reason }));
  const tasks = frontPlanLines(editor.tasks).map((line) => {
    const match = line.match(/^\[(x|-| )\]\s*(.+)$/i);
    return { state: match?.[1].toLocaleLowerCase() === 'x' ? 'done' : match?.[1] === '-' ? 'skipped' : 'open', text: (match?.[2] || line).trim() };
  });
  const payload = {
    title: editor.title.trim(), slug: frontPlanSlug(editor.slug || editor.title), candidateKind: editor.candidateKind, leadComponent: frontPlanSlug(editor.leadComponent),
    affectedComponents: frontPlanLines(editor.affectedComponents).map(frontPlanSlug), goalIds: frontPlanLines(editor.goalIds), outcome: editor.outcome.trim(), motivation: editor.motivation.trim(),
    scope: editor.scope.trim(), nonGoals: frontPlanLines(editor.nonGoals), dependencies, readiness: frontPlanLines(editor.readiness), acceptanceCriteria: frontPlanLines(editor.acceptanceCriteria),
    verification: frontPlanLines(editor.verification), deliverables: frontPlanLines(editor.deliverables), risks: frontPlanLines(editor.risks), unknowns: frontPlanLines(editor.unknowns), evidence, tasks,
    context: editor.context.trim(), handoff: editor.handoff.trim(), analysisSnapshot: editor.snapshotId,
  };
  if (!payload.title || !payload.slug || !payload.leadComponent || !payload.outcome || !payload.motivation || !payload.scope || !payload.context || !payload.handoff) throw new Error('Title, slug, lead component and every narrative field are required.');
  for (const [label, value] of Object.entries({ nonGoals: payload.nonGoals, readiness: payload.readiness, acceptanceCriteria: payload.acceptanceCriteria, verification: payload.verification, deliverables: payload.deliverables, risks: payload.risks, unknowns: payload.unknowns, evidence: payload.evidence, tasks: payload.tasks, goalIds: payload.goalIds })) {
    if (!value.length) throw new Error(`${label} needs at least one explicit item.`);
  }
  return payload;
}

function frontPlanEditorUpdates(editor: FrontPlanEditorState) {
  const payload = frontPlanEditorPayload(editor);
  if (!editor.original) {
    const fieldGrounding = Object.fromEntries(FRONT_DESIGN_FIELDS.map((field) => [field, {
      evidenceIds: field === 'evidence' || field === 'verification' ? [editor.evidenceReference] : [], goalIds: payload.goalIds,
      componentSlugs: field === 'leadComponent' || field === 'affectedComponents' ? [payload.leadComponent, ...payload.affectedComponents] : [],
      assumptions: [`Human-authored ${field}; evidence must be reconciled before publication.`], questions: [],
    }])) as unknown as Record<FrontDesignField, FrontFieldGrounding>;
    return { ...payload, fieldGrounding, lockedFields: [] };
  }
  const original = editor.original as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => key !== 'analysisSnapshot' && JSON.stringify(original[key]) !== JSON.stringify(value)));
}

function FrontPlanQuality({ quality, compact = false }: { quality: FrontDesignQuality; compact?: boolean }) {
  return <div class={`front-plan-quality ${compact ? 'compact' : ''}`}>
    <dl><div><dt>Goal</dt><dd>{quality.goalCoverage.covered ? 'covered' : 'gap'}</dd></div><div><dt>Ready now</dt><dd>{quality.readySet.length}</dd></div><div><dt>Critical path</dt><dd>{quality.criticalPath.length}</dd></div><div><dt>Safe pairs</dt><dd>{quality.parallelism.safePairs.length}</dd></div><div><dt>Collisions</dt><dd>{quality.parallelism.collisions.length}</dd></div><div><dt>Unknowns</dt><dd>{quality.risk.explicitUnknowns}</dd></div></dl>
    {!compact && <><div class={`architecture-gate ${quality.gateD.pass ? 'pass' : ''}`}><b>{quality.gateD.pass ? 'Automated Gate D passed' : 'Automated Gate D needs review'}</b><span>{quality.gateD.statement}</span></div><details><summary>Plan diagnostics ({quality.diagnostics.length})</summary><ul>{quality.diagnostics.map((item, index) => <li class={item.severity} key={`${item.code}-${index}`}><b>{item.code}</b><span>{item.message}</span></li>)}</ul></details></>}
  </div>;
}

function FrontPlanContractField({ field, front, busy, onLock }: { field: FrontDesignField; front: FrontDesignCandidate; busy: boolean; onLock: (field: FrontDesignField, locked: boolean) => void }) {
  const value = front[field]; const grounding = front.fieldGrounding[field]; const locked = front.lockedFields.includes(field);
  const renderValue = () => {
    if (typeof value === 'string') return <p>{value}</p>;
    if (!value.length) return <p class="architecture-none">None declared.</p>;
    if (typeof value[0] === 'string') return <ul>{(value as string[]).map((item, index) => <li key={`${field}-${index}`}>{item}</li>)}</ul>;
    if (field === 'tasks') return <ol>{(value as FrontDesignCandidate['tasks']).map((item, index) => <li key={index} class={item.state}><b>{item.state}</b><span>{item.text}</span></li>)}</ol>;
    return <ul>{(value as Array<Record<string, string>>).map((item, index) => <li key={`${field}-${index}`}><b>{item.kind}</b> <code>{item.target || item.reference}</code><span>{item.reason}</span></li>)}</ul>;
  };
  return <section class="architecture-contract-field front-plan-contract-field"><header><h5>{FRONT_DESIGN_FIELD_LABELS[field]}</h5><button type="button" class={locked ? 'locked' : ''} disabled={busy || front.state === 'done'} onClick={() => onLock(field, locked)}>{front.state === 'done' ? 'Completed' : locked ? 'Locked' : 'Lock'}</button></header>{renderValue()}<details class="architecture-grounding"><summary>Evidence, intent and uncertainty</summary>
    {grounding.evidenceIds.length > 0 && <div><b>Evidence</b>{grounding.evidenceIds.map((id) => <code key={id}>{id}</code>)}</div>}
    {grounding.goalIds.length > 0 && <div><b>Goals</b>{grounding.goalIds.map((id) => <code key={id}>{id}</code>)}</div>}
    {grounding.componentSlugs.length > 0 && <div><b>Components</b>{grounding.componentSlugs.map((id) => <code key={id}>{id}</code>)}</div>}
    {grounding.assumptions.length > 0 && <div><b>Assumptions</b><ul>{grounding.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    {grounding.questions.length > 0 && <div><b>Questions</b><ul>{grounding.questions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
  </details></section>;
}

function FrontPlanEditor({ state, components, busy, onChange, onCancel, onSave }: { state: FrontPlanEditorState; components: string[]; busy: boolean; onChange: (state: FrontPlanEditorState) => void; onCancel: () => void; onSave: () => void }) {
  const set = <K extends keyof FrontPlanEditorState>(key: K, value: FrontPlanEditorState[K]) => onChange({ ...state, [key]: value });
  const listFields: Array<[keyof FrontPlanEditorState, string, number]> = [
    ['affectedComponents', 'Affected components · one slug per line', 3], ['goalIds', 'Goal IDs · one per line', 3], ['nonGoals', 'Non-goals · one per line', 4],
    ['readiness', 'Readiness · one per line', 4], ['acceptanceCriteria', 'Acceptance criteria · one per line', 5], ['verification', 'Feasible verification · one per line', 5],
    ['deliverables', 'Deliverables · one per line', 4], ['risks', 'Risks · one per line', 4], ['unknowns', 'Unknowns · one per line', 4],
  ];
  return <section class="architecture-editor front-plan-editor" role="dialog" aria-modal="true" aria-labelledby="front-plan-editor-title"><header><div><p class="section-kicker">Complete front v2 contract</p><h3 id="front-plan-editor-title">{state.mode === 'add' ? 'Add manual front' : `Edit ${state.title}`}</h3></div><button type="button" aria-label="Close front editor" disabled={busy} onClick={onCancel}>×</button></header>
    <div class="architecture-editor-grid"><label><span>Title</span><input value={state.title} disabled={busy} onInput={(event) => set('title', event.currentTarget.value)} /></label><label><span>Slug</span><input value={state.slug} disabled={busy} onInput={(event) => set('slug', event.currentTarget.value)} /></label><label><span>Front kind</span><select value={state.candidateKind} disabled={busy} onChange={(event) => set('candidateKind', event.currentTarget.value as FrontPlanEditorState['candidateKind'])}><option value="implementation">Implementation</option><option value="research">Research</option><option value="decision">Decision</option><option value="validation">Validation</option><option value="migration">Migration</option></select></label><label><span>Single lead component</span><select value={state.leadComponent} disabled={busy} onChange={(event) => set('leadComponent', event.currentTarget.value)}>{components.map((slug) => <option key={slug} value={slug}>{slug}</option>)}</select></label></div>
    <div class="front-plan-narrative-grid"><label><span>Observable outcome</span><textarea rows={4} value={state.outcome} disabled={busy} onInput={(event) => set('outcome', event.currentTarget.value)} /></label><label><span>Motivation</span><textarea rows={4} value={state.motivation} disabled={busy} onInput={(event) => set('motivation', event.currentTarget.value)} /></label><label><span>Scope</span><textarea rows={5} value={state.scope} disabled={busy} onInput={(event) => set('scope', event.currentTarget.value)} /></label><label><span>Confirmed context</span><textarea rows={5} value={state.context} disabled={busy} onInput={(event) => set('context', event.currentTarget.value)} /></label><label><span>Handoff</span><textarea rows={5} value={state.handoff} disabled={busy} onInput={(event) => set('handoff', event.currentTarget.value)} /></label></div>
    <div class="architecture-editor-grid">{listFields.map(([field, label, rows]) => <label key={field}><span>{label}</span><textarea rows={rows} value={String(state[field])} disabled={busy} onInput={(event) => set(field, event.currentTarget.value as never)} /></label>)}<label><span>Dependencies · kind | target | reason</span><textarea rows={5} value={state.dependencies} disabled={busy} onInput={(event) => set('dependencies', event.currentTarget.value)} /></label><label><span>Evidence · provenance | reference | reason</span><textarea rows={5} value={state.evidence} disabled={busy} onInput={(event) => set('evidence', event.currentTarget.value)} /></label><label><span>Ordered checklist · [ ], [x] or [-]</span><textarea rows={7} value={state.tasks} disabled={busy} onInput={(event) => set('tasks', event.currentTarget.value)} /></label></div>
    <p class="architecture-editor-note">This editor changes only the private workspace. Changed fields are marked as human decisions and must still pass deterministic whole-plan validation.</p><footer><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button class="primary" type="button" disabled={busy} onClick={onSave}>{state.mode === 'add' ? 'Add private candidate' : 'Save reviewed changes'}</button></footer>
  </section>;
}

function FrontPlanningDialog({ repository, launch, onCancel, onModelPlan, onPublish }: { repository: Repository; launch: FrontPlanningLaunch; onCancel: () => void; onModelPlan: () => void; onPublish: (draft: FrontDesignDraft, alternative: FrontDesignAlternative) => void }) {
  const [componentDrafts, setComponentDrafts] = useState<ComponentDesignDraft[]>([]);
  const [planningJobs, setPlanningJobs] = useState<PlanningJob[]>([]);
  const [product, setProduct] = useState<{ exists: boolean; revision: string | null; brief: ProductBrief | null }>({ exists: false, revision: null, brief: null });
  const [drafts, setDrafts] = useState<FrontDesignDraft[]>([]);
  const [componentDraftId, setComponentDraftId] = useState(launch.componentDraftId || '');
  const [componentAlternativeId, setComponentAlternativeId] = useState(launch.componentAlternativeId || '');
  const [goalMode, setGoalMode] = useState<'accepted' | 'manual'>('accepted');
  const [goalId, setGoalId] = useState('');
  const [manualGoalTitle, setManualGoalTitle] = useState('');
  const [manualGoalOutcome, setManualGoalOutcome] = useState('');
  const [manualSuccessSignals, setManualSuccessSignals] = useState('');
  const [planningJobId, setPlanningJobId] = useState('');
  const [draft, setDraft] = useState<FrontDesignDraft | null>(null);
  const [frontId, setFrontId] = useState('');
  const [compareId, setCompareId] = useState('');
  const [comparison, setComparison] = useState<FrontDesignComparison | null>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [editor, setEditor] = useState<FrontPlanEditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  const loadSources = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [componentResponse, planningResponse, productResponse, draftResponse] = await Promise.all([
        api<{ drafts: ComponentDesignDraft[] }>(`/api/repositories/${repository.id}/component-design/drafts`),
        api<{ jobs: PlanningJob[] }>(`/api/repositories/${repository.id}/planning/jobs`),
        api<{ exists: boolean; revision: string | null; brief: ProductBrief | null }>(`/api/repositories/${repository.id}/product`),
        api<{ drafts: FrontDesignDraft[] }>(`/api/repositories/${repository.id}/front-design/drafts`),
      ]);
      setComponentDrafts(componentResponse.drafts); setPlanningJobs(planningResponse.jobs); setProduct(productResponse); setDrafts(draftResponse.drafts);
      const launched = launch.frontDraftId ? draftResponse.drafts.find((item) => item.id === launch.frontDraftId) : null;
      if (launched) {
        setDraft(launched); setComponentDraftId(launched.source.componentDraftId); setComponentAlternativeId(launched.source.componentAlternativeId);
      }
      const architecture = componentResponse.drafts.find((item) => item.id === launch.componentDraftId) || componentResponse.drafts[0];
      if (architecture) {
        setComponentDraftId((current) => current || architecture.id);
        const alternativeId = launch.componentDraftId === architecture.id && launch.componentAlternativeId
          ? launch.componentAlternativeId : architecture.selectedAlternativeId;
        setComponentAlternativeId((current) => current || alternativeId);
      }
      const acceptedGoals = productResponse.brief?.goals.filter((item) => !['achieved', 'retired'].includes(item.state)) || [];
      if (acceptedGoals.length) { setGoalId((current) => current || acceptedGoals[0].id); }
      else setGoalMode('manual');
      const model = planningResponse.jobs.find((item) => item.operation === 'front-design' && item.state === 'complete' && item.resultAvailable);
      if (model) setPlanningJobId((current) => current || model.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [repository.id, launch.componentDraftId, launch.componentAlternativeId, launch.frontDraftId]);

  useEffect(() => { void loadSources(); }, [loadSources]);

  const sourceArchitecture = componentDrafts.find((item) => item.id === componentDraftId) || null;
  const sourceAlternative = sourceArchitecture?.alternatives.find((item) => item.id === componentAlternativeId) || null;
  useEffect(() => {
    if (sourceArchitecture && !sourceArchitecture.alternatives.some((item) => item.id === componentAlternativeId)) setComponentAlternativeId(sourceArchitecture.selectedAlternativeId);
  }, [sourceArchitecture?.id, sourceArchitecture?.revision, componentAlternativeId]);

  const selectedAlternative = draft?.alternatives.find((item) => item.id === draft.selectedAlternativeId) || null;
  const selectedFront = selectedAlternative?.fronts.find((item) => item.id === frontId) || selectedAlternative?.fronts[0] || null;
  const sourceComponents = sourceArchitecture?.alternatives.find((item) => item.id === (draft?.source.componentAlternativeId || componentAlternativeId))?.components.map((item) => item.slug)
    || [...new Set(selectedAlternative?.fronts.flatMap((item) => [item.leadComponent, ...item.affectedComponents]) || [])];

  useEffect(() => {
    if (selectedAlternative && !selectedAlternative.fronts.some((item) => item.id === frontId)) { setFrontId(selectedAlternative.fronts[0]?.id || ''); setMergeIds([]); }
    if (draft && (!compareId || compareId === draft.selectedAlternativeId || !draft.alternatives.some((item) => item.id === compareId))) {
      setCompareId(draft.alternatives.find((item) => item.id !== draft.selectedAlternativeId)?.id || ''); setComparison(null);
    }
  }, [draft?.revision, draft?.selectedAlternativeId, selectedAlternative?.id, frontId, compareId]);

  const createDraft = async () => {
    if (!componentDraftId || !componentAlternativeId) { setError('Choose a private component architecture and one reviewed alternative.'); return; }
    if (goalMode === 'accepted' && !goalId) { setError('Choose an accepted product goal.'); return; }
    if (goalMode === 'manual' && (!manualGoalTitle.trim() || !manualGoalOutcome.trim())) { setError('A manual goal needs a title and observable outcome.'); return; }
    setBusy(true); setError(''); setWarning('');
    try {
      const response = await api<{ draft: FrontDesignDraft }>(`/api/repositories/${repository.id}/front-design/drafts`, {
        method: 'POST', body: JSON.stringify({
          componentDraftId, componentAlternativeId,
          ...(goalMode === 'accepted' ? { goalId, includeProduct: true } : { goal: { title: manualGoalTitle.trim(), outcome: manualGoalOutcome.trim(), successSignals: frontPlanLines(manualSuccessSignals) }, includeProduct: false }),
          planningJobId: planningJobId || null, includeModel: Boolean(planningJobId),
        }),
      });
      setDraft(response.draft); setDrafts((current) => [response.draft, ...current.filter((item) => item.id !== response.draft.id)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const openDraft = async (id: string) => {
    setBusy(true); setError(''); setWarning('');
    try {
      const response = await api<{ draft: FrontDesignDraft; contextWarning: string | null }>(`/api/repositories/${repository.id}/front-design/drafts/${encodeURIComponent(id)}`);
      setDraft(response.draft); setWarning(response.contextWarning || ''); setComponentDraftId(response.draft.source.componentDraftId); setComponentAlternativeId(response.draft.source.componentAlternativeId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const applyOperation = async (operation: Record<string, unknown>) => {
    if (!draft) return null;
    setBusy(true); setError(''); setWarning('');
    try {
      const response = await api<{ draft: FrontDesignDraft; contextWarning: string | null }>(`/api/repositories/${repository.id}/front-design/drafts/${encodeURIComponent(draft.id)}/operations`, {
        method: 'POST', body: JSON.stringify({ ...operation, expectedRevision: draft.revision }),
      });
      setDraft(response.draft); setWarning(response.contextWarning || ''); return response.draft;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return null; }
    finally { setBusy(false); }
  };

  const removeDraft = async (target = draft) => {
    if (!target || !window.confirm('Delete this private front-planning workspace? No repository files, worktrees or agents will change.')) return;
    setBusy(true); setError('');
    try {
      await api(`/api/repositories/${repository.id}/front-design/drafts/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      setDrafts((current) => current.filter((item) => item.id !== target.id)); if (draft?.id === target.id) setDraft(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const selectAlternative = async (alternativeId: string) => { setComparison(null); await applyOperation({ operation: 'select-alternative', alternativeId }); };
  const compare = async () => {
    if (!draft || !compareId) return; setBusy(true); setError('');
    try {
      const response = await api<{ comparison: FrontDesignComparison }>(`/api/repositories/${repository.id}/front-design/drafts/${encodeURIComponent(draft.id)}/compare?left=${encodeURIComponent(draft.selectedAlternativeId)}&right=${encodeURIComponent(compareId)}`);
      setComparison(response.comparison);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const reorder = async (candidate: FrontDesignCandidate, direction: -1 | 1) => {
    if (!selectedAlternative) return; const ids = selectedAlternative.fronts.map((item) => item.id); const index = ids.indexOf(candidate.id); const next = index + direction;
    if (next < 0 || next >= ids.length) return; [ids[index], ids[next]] = [ids[next], ids[index]]; await applyOperation({ operation: 'reorder-fronts', frontIds: ids });
  };

  const split = async (candidate: FrontDesignCandidate) => {
    if (candidate.tasks.length < 2) { setError('This front needs at least two checklist items to split.'); return; }
    const firstTitle = window.prompt('First outcome-slice title:', `${candidate.title} A`); if (!firstTitle) return;
    const secondTitle = window.prompt('Second outcome-slice title:', `${candidate.title} B`); if (!secondTitle) return;
    const pivot = Math.ceil(candidate.tasks.length / 2);
    await applyOperation({ operation: 'split-front', frontId: candidate.id,
      first: { title: firstTitle, slug: frontPlanSlug(firstTitle), taskIndexes: candidate.tasks.map((_, index) => index).slice(0, pivot) },
      second: { title: secondTitle, slug: frontPlanSlug(secondTitle), taskIndexes: candidate.tasks.map((_, index) => index).slice(pivot) },
    });
  };

  const merge = async () => {
    if (mergeIds.length < 2) { setError('Select at least two front candidates to merge.'); return; }
    const title = window.prompt('Merged outcome title:', 'Merged outcome slice'); if (!title) return;
    const next = await applyOperation({ operation: 'merge-fronts', frontIds: mergeIds, front: { title, slug: frontPlanSlug(title), outcome: `One reviewed outcome replaces the selected fronts: ${title}.` } });
    if (next) setMergeIds([]);
  };

  const saveEditor = async () => {
    if (!editor) return;
    try {
      const updates = frontPlanEditorUpdates(editor);
      const next = editor.mode === 'add' ? await applyOperation({ operation: 'add-front', front: updates }) : await applyOperation({ operation: 'edit-front', frontId: editor.frontId, updates });
      if (next) setEditor(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const answer = async (question: FrontDesignDraft['questions'][number]) => {
    const value = window.prompt(question.question, question.answer); if (value === null) return;
    await applyOperation({ operation: 'answer-question', questionId: question.id, answer: value });
  };

  const acceptedGoals = product.brief?.goals.filter((item) => !['achieved', 'retired'].includes(item.state)) || [];
  const modelJobs = planningJobs.filter((item) => item.operation === 'front-design' && item.state === 'complete' && item.resultAvailable);

  return <div class="component-name-backdrop architecture-backdrop front-plan-backdrop" role="presentation"><section class="component-name-dialog architecture-dialog front-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="front-plan-title">
    <header><div><p class="section-kicker">Design the work</p><h2 id="front-plan-title">Plan {repository.name}'s executable fronts</h2></div><button type="button" aria-label="Close front planning" onClick={onCancel} disabled={busy}>×</button></header>
    {!draft ? <div class="architecture-start front-plan-start"><p class="component-name-help">Turn one reviewed component model and product goal into outcome-oriented fronts, readiness edges and a safe parallelism view. This remains private: no Markdown, worktree or agent is created.</p>
      <div class="architecture-source-grid"><label><span>Private component architecture · required</span><select value={componentDraftId} disabled={busy} onChange={(event) => { setComponentDraftId(event.currentTarget.value); const next = componentDrafts.find((item) => item.id === event.currentTarget.value); setComponentAlternativeId(next?.selectedAlternativeId || ''); }}><option value="">Choose a component workspace</option>{componentDrafts.map((item) => <option key={item.id} value={item.id}>{new Date(item.updatedAt).toLocaleString()} · {item.alternatives.length} alternatives{item.stale ? ' · stale' : ''}</option>)}</select></label><label><span>Reviewed component alternative</span><select value={componentAlternativeId} disabled={busy || !sourceArchitecture} onChange={(event) => setComponentAlternativeId(event.currentTarget.value)}><option value="">Choose an architecture</option>{sourceArchitecture?.alternatives.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.components.length} components · {item.quality.gateC.pass ? 'Gate C' : 'review'}</option>)}</select></label></div>
      {sourceArchitecture?.stale && <div class="architecture-stale"><b>Selected architecture is stale</b><span>{sourceArchitecture.staleReasons.join(' ')}</span></div>}
      <section class="front-plan-goal-source"><header><span><b>Planning goal</b><small>Every front must trace back to this outcome.</small></span><div><button type="button" class={goalMode === 'accepted' ? 'active' : ''} disabled={!acceptedGoals.length} onClick={() => setGoalMode('accepted')}>Accepted product goal</button><button type="button" class={goalMode === 'manual' ? 'active' : ''} onClick={() => setGoalMode('manual')}>Manual partial goal</button></div></header>
        {goalMode === 'accepted' ? <label><span>Accepted goal</span><select value={goalId} disabled={busy} onChange={(event) => setGoalId(event.currentTarget.value)}>{acceptedGoals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title} · {goal.priority}</option>)}</select></label> : <div class="architecture-source-grid"><label><span>Goal title</span><input value={manualGoalTitle} disabled={busy} placeholder="What outcome are we planning?" onInput={(event) => setManualGoalTitle(event.currentTarget.value)} /></label><label><span>Observable outcome</span><textarea rows={3} value={manualGoalOutcome} disabled={busy} onInput={(event) => setManualGoalOutcome(event.currentTarget.value)} /></label><label><span>Success signals · one per line</span><textarea rows={3} value={manualSuccessSignals} disabled={busy} onInput={(event) => setManualSuccessSignals(event.currentTarget.value)} /></label></div>}
      </section>
      <div class="architecture-source-grid"><label><span>Optional front-design model result</span><select value={planningJobId} disabled={busy} onChange={(event) => setPlanningJobId(event.currentTarget.value)}><option value="">Deterministic/manual alternatives only</option>{modelJobs.map((item) => <option key={item.id} value={item.id}>{item.provider.name} · {item.model} · {new Date(item.updatedAt).toLocaleString()}</option>)}</select></label></div>
      {!componentDrafts.length && <div class="planning-partial-note"><b>No private component architecture</b><span>Design and review component responsibilities before slicing work.</span></div>}
      {!modelJobs.length && <div class="architecture-optional-model"><span><b>Model synthesis is optional</b><small>Deterministic outcome-slice and risk-first alternatives retain full review parity.</small></span><button type="button" onClick={onModelPlan}>Create model proposal</button></div>}
      <div class="architecture-start-actions"><button type="button" disabled={busy} onClick={() => void loadSources()}>Refresh sources</button><button class="primary" type="button" disabled={busy || !componentDraftId || !componentAlternativeId} onClick={() => void createDraft()}>{busy ? 'Designing portfolio…' : 'Generate private front alternatives'}</button></div>
      {drafts.length > 0 && <section class="architecture-recent"><h3>Recent front workspaces</h3>{drafts.map((item) => <article key={item.id}><span><b>{item.alternatives.length} alternatives · {item.source.goal.title}</b><small>{new Date(item.updatedAt).toLocaleString()} · {item.state}{item.stale ? ' · stale' : ''}</small></span><button type="button" onClick={() => void openDraft(item.id)}>Resume</button><button class="danger" type="button" onClick={() => void removeDraft(item)}>Delete</button></article>)}</section>}
    </div> : <div class="architecture-workspace front-plan-workspace">
      <div class="architecture-safety"><span><b>Private plan · no execution allocation</b><small>Goal {draft.source.goal.id} · component model {draft.source.componentAlternativeId} · snapshot {draft.source.snapshotId.slice(0, 12)}</small></span><strong>{draft.state}</strong></div>
      {(draft.stale || warning) && <div class="architecture-stale" role="status"><b>Context needs attention</b><span>{[...draft.staleReasons, warning].filter(Boolean).join(' ')}</span></div>}
      {draft.history.at(-1)?.operation === 'regenerate' && <div class="architecture-history-note"><b>Regeneration result</b><span>{draft.history.at(-1)?.summary}</span></div>}
      {draft.diagnostics.length > 0 && <div class="front-plan-model-diagnostics"><b>Rejected optional source</b><span>{draft.diagnostics.map((item) => `${item.code}: ${item.message}`).join(' ')}</span></div>}
      <nav class="architecture-alternatives front-plan-alternatives" aria-label="Front-plan alternatives">{draft.alternatives.map((alternative) => <button type="button" key={alternative.id} class={alternative.id === draft.selectedAlternativeId ? 'active' : ''} aria-pressed={alternative.id === draft.selectedAlternativeId} disabled={busy} onClick={() => void selectAlternative(alternative.id)}><span><b>{alternative.title}</b><small>{alternative.strategy} · {alternative.fronts.length} fronts</small></span><em class={alternative.quality.gateD.pass ? 'pass' : 'review'}>{alternative.quality.gateD.pass ? 'Gate D' : 'Review'}</em><FrontPlanQuality quality={alternative.quality} compact /></button>)}</nav>
      {selectedAlternative && <><section class="architecture-alternative-intro"><div><p class="section-kicker">{selectedAlternative.strategy} portfolio</p><h3>{selectedAlternative.title}</h3><p>{selectedAlternative.summary}</p></div><FrontPlanQuality quality={selectedAlternative.quality} /></section>
        <div class="architecture-tradeoffs"><section><h4>Slicing rationale</h4><ul>{selectedAlternative.rationale.map((item, index) => <li key={index}>{item}</li>)}</ul></section><section><h4>Strengths</h4><ul>{selectedAlternative.tradeoffs.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul></section><section><h4>Risks</h4><ul>{selectedAlternative.tradeoffs.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></section></div>
        {draft.questions.length > 0 && <section class="architecture-questions"><header><div><p class="section-kicker">Planning decisions</p><h3>Questions that change the portfolio</h3></div><span>{draft.questions.filter((item) => item.state === 'answered').length}/{draft.questions.length} answered</span></header>{draft.questions.map((question) => <article key={question.id} class={question.state}><span><b>{question.question}</b><small>{question.why}</small>{question.answer && <p>{question.answer}</p>}<em>Affects {question.affects.map((field) => FRONT_DESIGN_FIELD_LABELS[field]).join(', ')}</em></span><button type="button" disabled={busy} onClick={() => void answer(question)}>{question.answer ? 'Edit answer' : 'Answer'}</button></article>)}</section>}
        <section class="front-plan-flow"><header><div><p class="section-kicker">Dependency and parallelism view</p><h3>What can move now</h3></div><span>{selectedAlternative.quality.readySet.length} ready · {selectedAlternative.quality.criticalPath.length} on critical path</span></header><div class="front-plan-ready"><b>Ready set</b>{selectedAlternative.quality.readySet.length ? selectedAlternative.quality.readySet.map((slug) => <code key={slug}>{slug}</code>) : <span>No front is currently ready.</span>}</div><div class="front-plan-critical"><b>Critical path</b>{selectedAlternative.quality.criticalPath.map((slug, index) => <span key={slug}><code>{slug}</code>{index < selectedAlternative.quality.criticalPath.length - 1 && <i>→</i>}</span>)}</div><div class="front-plan-dag">{selectedAlternative.fronts.map((front) => <article key={front.id} class={`${selectedAlternative.quality.readySet.includes(front.slug) ? 'ready' : ''} ${front.state}`}><span><b>{front.title}</b><small>{front.candidateKind} · lead {front.leadComponent}</small></span><div>{front.dependencies.length ? front.dependencies.map((edge) => <code class={edge.kind} key={`${edge.kind}-${edge.target}`} title={edge.reason}>{edge.kind} ← {edge.target}</code>) : <code>no prerequisites</code>}</div></article>)}</div>{selectedAlternative.quality.parallelism.collisions.length > 0 && <details class="front-plan-collisions"><summary>Ownership / territory collisions ({selectedAlternative.quality.parallelism.collisions.length})</summary><ul>{selectedAlternative.quality.parallelism.collisions.map((item) => <li key={`${item.left}-${item.right}`}><code>{item.left}</code><span>↔</span><code>{item.right}</code><small>{[...item.sharedComponents, ...item.sharedTerritory].join(', ')}</small></li>)}</ul></details>}</section>
        <section class="architecture-compare"><label><span>Compare selected with</span><select value={compareId} disabled={busy} onChange={(event) => { setCompareId(event.currentTarget.value); setComparison(null); }}>{draft.alternatives.filter((item) => item.id !== draft.selectedAlternativeId).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><button type="button" disabled={busy || !compareId} onClick={() => void compare()}>Compare portfolios</button>{comparison && <div><b>{comparison.materiallyDifferent ? 'Materially different plan' : 'Equivalent plan'}</b><span>{comparison.fronts.added.length} added · {comparison.fronts.removed.length} removed · {comparison.fronts.changed.length} changed</span><details><summary>Exact fronts and edges</summary><pre>{JSON.stringify({ fronts: comparison.fronts, dependencies: comparison.dependencies }, null, 2)}</pre></details></div>}</section>
        <div class="architecture-review-grid front-plan-review-grid"><aside class="architecture-component-list front-plan-list"><header><div><h3>Fronts</h3><small>{selectedAlternative.fronts.length} outcome / discovery boundaries</small></div><button type="button" disabled={busy} onClick={() => setEditor(frontPlanEditorState(null, { leadComponent: sourceComponents[0] || selectedAlternative.fronts[0].leadComponent, goalId: draft.source.goal.id, snapshotId: draft.source.snapshotId, evidenceReference: draft.source.snapshotId }))}>Add manual</button></header>{selectedAlternative.fronts.map((candidate, index) => <article key={candidate.id} class={candidate.id === selectedFront?.id ? 'active' : ''}><label><input type="checkbox" checked={mergeIds.includes(candidate.id)} disabled={candidate.state === 'done' || candidate.lockedFields.length > 0} onChange={(event) => setMergeIds((current) => event.currentTarget.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} aria-label={`Select ${candidate.title} for merge`} /></label><button type="button" class="architecture-component-select" onClick={() => setFrontId(candidate.id)}><span><b>{candidate.title}</b><small>{candidate.slug} · {candidate.candidateKind} · {candidate.leadComponent}</small></span><em>{candidate.state === 'done' ? 'complete' : `${candidate.lockedFields.length} locks`}</em></button><div><button type="button" disabled={busy || index === 0} onClick={() => void reorder(candidate, -1)}>↑</button><button type="button" disabled={busy || index === selectedAlternative.fronts.length - 1} onClick={() => void reorder(candidate, 1)}>↓</button></div></article>)}<footer><button type="button" disabled={busy || mergeIds.length < 2} onClick={() => void merge()}>Merge selected ({mergeIds.length})</button></footer></aside>
          <section class="architecture-component-detail front-plan-detail">{selectedFront ? <><header><div><p class="section-kicker">{selectedFront.origin} · {selectedFront.candidateKind} · order {selectedFront.order}</p><h3>{selectedFront.title}</h3><code>{selectedFront.slug}</code></div><div><button type="button" disabled={busy || selectedFront.state === 'done'} onClick={() => setEditor(frontPlanEditorState(selectedFront, { leadComponent: selectedFront.leadComponent, goalId: draft.source.goal.id, snapshotId: draft.source.snapshotId, evidenceReference: draft.source.snapshotId }))}>Edit all fields</button><button type="button" disabled={busy || selectedFront.state === 'done' || selectedFront.tasks.length < 2 || selectedFront.lockedFields.length > 0} onClick={() => void split(selectedFront)}>Split</button><button class="danger" type="button" disabled={busy || selectedFront.state === 'done' || selectedAlternative.fronts.length === 1 || selectedFront.lockedFields.length > 0} onClick={() => void applyOperation({ operation: 'delete-front', frontId: selectedFront.id })}>Delete</button></div></header><div class="front-plan-owner"><span><b>Lead</b><code>{selectedFront.leadComponent}</code></span><span><b>Affected</b><code>{selectedFront.affectedComponents.join(', ') || 'none'}</code></span><span><b>Goals</b><code>{selectedFront.goalIds.join(', ')}</code></span></div><div class="architecture-contract-fields">{FRONT_DESIGN_FIELDS.map((field) => <FrontPlanContractField key={field} field={field} front={selectedFront} busy={busy} onLock={(target, locked) => void applyOperation({ operation: locked ? 'unlock-field' : 'lock-field', frontId: selectedFront.id, field: target, reason: 'Locked during human front-plan review.' })} />)}</div></> : <p class="empty-state">Choose a front candidate.</p>}</section>
        </div>
      </>}
      <footer class="architecture-workspace-actions front-plan-actions"><button type="button" disabled={busy} onClick={() => setDraft(null)}>Back to workspaces</button><button class="danger" type="button" disabled={busy} onClick={() => void removeDraft()}>Delete private draft</button><span /><button type="button" disabled={busy} onClick={() => void applyOperation({ operation: draft.state === 'skipped' ? 'resume' : 'skip' })}>{draft.state === 'skipped' ? 'Resume review' : 'Skip for now'}</button><button type="button" disabled={busy} onClick={() => void applyOperation({ operation: 'regenerate', includeModel: draft.source.modelIncluded })}>{busy ? 'Working…' : 'Regenerate safely'}</button><button class="primary" type="button" disabled={busy || !selectedAlternative || draft.state === 'skipped'} onClick={() => selectedAlternative && onPublish(draft, selectedAlternative)}>Review complete publication</button></footer>
    </div>}
    {editor && draft && <div class="architecture-editor-backdrop"><FrontPlanEditor state={editor} components={sourceComponents} busy={busy} onChange={setEditor} onCancel={() => setEditor(null)} onSave={() => void saveEditor()} /></div>}
    {error && <p class="form-error architecture-error" role="alert">{error}</p>}
    {!draft && <footer><span /><button type="button" onClick={onCancel} disabled={busy}>Close</button></footer>}
  </section></div>;
}

function publicationBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function PublicationFileDiff({ operation }: { operation: PublicationOperation }) {
  return <details class={`publication-file ${operation.action}`} open={operation.kind !== 'audit'}>
    <summary><span><b>{operation.relativePath}</b><small>{operation.kind} · {operation.slug}</small></span><strong>{operation.action}</strong></summary>
    <div class="publication-file-revisions"><code>{operation.beforeRevision?.slice(0, 12) || 'absent'}</code><i>→</i><code>{operation.afterRevision?.slice(0, 12) || 'deleted'}</code></div>
    <div class="publication-text-diff">
      <section><header>Before · exact bytes</header><pre>{operation.before ?? '∅  File does not exist.'}</pre></section>
      <section><header>After · exact bytes</header><pre>{operation.after ?? '∅  File will be deleted.'}</pre></section>
    </div>
  </details>;
}

function PublicationDialog({ repository, launch, onCancel, onCommitted, onEditProduct }: {
  repository: Repository;
  launch: PublicationLaunch;
  onCancel: () => void;
  onCommitted: () => Promise<void>;
  onEditProduct: () => void;
}) {
  const [componentDrafts, setComponentDrafts] = useState<ComponentDesignDraft[]>([]);
  const [frontDrafts, setFrontDrafts] = useState<FrontDesignDraft[]>([]);
  const [recent, setRecent] = useState<PublicationManifest[]>([]);
  const [componentDraftId, setComponentDraftId] = useState(launch.componentDraftId || '');
  const [componentAlternativeId, setComponentAlternativeId] = useState(launch.componentAlternativeId || '');
  const [frontDraftId, setFrontDraftId] = useState(launch.frontDraftId || '');
  const [frontAlternativeId, setFrontAlternativeId] = useState(launch.frontAlternativeId || '');
  const [mode, setMode] = useState<PublicationMode>(launch.mode || (launch.frontDraftId ? 'complete-plan' : 'components-only'));
  const [includeProduct, setIncludeProduct] = useState(false);
  const [productDraft, setProductDraft] = useState<ProductDraft | null>(null);
  const [deleteAbsentComponents, setDeleteAbsentComponents] = useState(false);
  const [deleteAbsentFronts, setDeleteAbsentFronts] = useState(false);
  const [allowCompletedDeletes, setAllowCompletedDeletes] = useState(false);
  const [publication, setPublication] = useState<PublicationManifest | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const loadSources = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [components, fronts, publications] = await Promise.all([
        api<{ drafts: ComponentDesignDraft[] }>(`/api/repositories/${repository.id}/component-design/drafts`),
        api<{ drafts: FrontDesignDraft[] }>(`/api/repositories/${repository.id}/front-design/drafts`),
        api<{ publications: PublicationManifest[] }>(`/api/repositories/${repository.id}/publications`),
      ]);
      setComponentDrafts(components.drafts); setFrontDrafts(fronts.drafts); setRecent(publications.publications);
      const selectedComponent = components.drafts.find((item) => item.id === launch.componentDraftId) || components.drafts[0];
      if (selectedComponent) {
        const selectedAlternative = launch.componentDraftId === selectedComponent.id && launch.componentAlternativeId
          ? launch.componentAlternativeId : selectedComponent.selectedAlternativeId;
        setComponentDraftId((current) => current || selectedComponent.id);
        setComponentAlternativeId((current) => current || selectedAlternative);
        const compatible = fronts.drafts.filter((item) => item.source.componentDraftId === selectedComponent.id && item.source.componentAlternativeId === selectedAlternative);
        const selectedFront = compatible.find((item) => item.id === launch.frontDraftId) || compatible[0];
        if (selectedFront) {
          setFrontDraftId((current) => current || selectedFront.id);
          setFrontAlternativeId((current) => current || (launch.frontDraftId === selectedFront.id && launch.frontAlternativeId ? launch.frontAlternativeId : selectedFront.selectedAlternativeId));
        }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [repository.id, launch.componentDraftId, launch.componentAlternativeId, launch.frontDraftId, launch.frontAlternativeId]);

  useEffect(() => { void loadSources(); }, [loadSources]);

  const componentDraft = componentDrafts.find((item) => item.id === componentDraftId) || null;
  const componentAlternative = componentDraft?.alternatives.find((item) => item.id === componentAlternativeId) || null;
  const compatibleFronts = frontDrafts.filter((item) => item.source.componentDraftId === componentDraftId && item.source.componentAlternativeId === componentAlternativeId);
  const frontDraft = compatibleFronts.find((item) => item.id === frontDraftId) || null;
  const frontAlternative = frontDraft?.alternatives.find((item) => item.id === frontAlternativeId) || null;
  const needsProductDraft = mode === 'product-components' || (mode === 'complete-plan' && includeProduct);

  const selectComponentDraft = (id: string) => {
    const next = componentDrafts.find((item) => item.id === id) || null; const alternativeId = next?.selectedAlternativeId || '';
    setComponentDraftId(id); setComponentAlternativeId(alternativeId);
    const compatible = frontDrafts.find((item) => item.source.componentDraftId === id && item.source.componentAlternativeId === alternativeId) || null;
    setFrontDraftId(compatible?.id || ''); setFrontAlternativeId(compatible?.selectedAlternativeId || ''); setPublication(null); setConfirmed(false);
  };

  const selectComponentAlternative = (id: string) => {
    setComponentAlternativeId(id);
    const compatible = frontDrafts.find((item) => item.source.componentDraftId === componentDraftId && item.source.componentAlternativeId === id) || null;
    setFrontDraftId(compatible?.id || ''); setFrontAlternativeId(compatible?.selectedAlternativeId || ''); setPublication(null); setConfirmed(false);
  };

  const selectFrontDraft = (id: string) => {
    const next = compatibleFronts.find((item) => item.id === id) || null;
    setFrontDraftId(id); setFrontAlternativeId(next?.selectedAlternativeId || ''); setPublication(null); setConfirmed(false);
  };

  const loadProductDraft = async () => {
    setBusy(true); setError('');
    try {
      const response = await api<{ draft: ProductDraft }>(`/api/repositories/${repository.id}/product/drafts`, { method: 'POST', body: '{}' });
      setProductDraft(response.draft); setPublication(null); setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const prepare = async () => {
    if (!componentDraft || !componentAlternative) { setError('Choose one reviewed component workspace and alternative.'); return; }
    if (mode === 'complete-plan' && (!frontDraft || !frontAlternative)) { setError('Complete-plan publication requires one compatible reviewed front portfolio.'); return; }
    if (needsProductDraft && !productDraft) { setError('Load and review a private product draft for this publication mode.'); return; }
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const response = await api<{ publication: PublicationManifest }>(`/api/repositories/${repository.id}/publications`, {
        method: 'POST', body: JSON.stringify({
          sources: {
            componentDraftId: componentDraft.id, componentAlternativeId: componentAlternative.id,
            ...(mode === 'complete-plan' ? { frontDraftId: frontDraft!.id, frontAlternativeId: frontAlternative!.id } : {}),
            ...(needsProductDraft ? { productDraftId: productDraft!.id } : {}),
          },
          selection: {
            mode, includeProduct: mode === 'complete-plan' && includeProduct,
            deleteAbsentComponents, deleteAbsentFronts: mode === 'complete-plan' && deleteAbsentFronts,
            allowCompletedDeletes: mode === 'complete-plan' && deleteAbsentFronts && allowCompletedDeletes,
          },
        }),
      });
      setPublication(response.publication); setRecent((current) => [response.publication, ...current.filter((item) => item.id !== response.publication.id)]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const openPublication = async (id: string) => {
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const response = await api<{ publication: PublicationManifest }>(`/api/repositories/${repository.id}/publications/${encodeURIComponent(id)}`);
      setPublication(response.publication);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const discard = async () => {
    if (!publication || !window.confirm('Discard this private publication preview? Accepted repository files will not change.')) return;
    setBusy(true); setError('');
    try {
      await api(`/api/repositories/${repository.id}/publications/${encodeURIComponent(publication.id)}`, { method: 'DELETE' });
      setRecent((current) => current.filter((item) => item.id !== publication.id)); setPublication(null); setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    if (!publication || !confirmed) return;
    setBusy(true); setError('');
    try {
      const response = await api<{ publication: PublicationManifest }>(`/api/repositories/${repository.id}/publications/${encodeURIComponent(publication.id)}/commit`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: publication.revision, confirmed: true }),
      });
      setPublication(response.publication); setRecent((current) => [response.publication, ...current.filter((item) => item.id !== response.publication.id)]); setConfirmed(false);
      await onCommitted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try {
        const response = await api<{ publication: PublicationManifest }>(`/api/repositories/${repository.id}/publications/${encodeURIComponent(publication.id)}`);
        setPublication(response.publication);
      } catch { /* the actionable commit error remains visible */ }
    } finally { setBusy(false); }
  };

  const relationshipChanges = publication ? [...publication.relationships.components.map((item) => ({ ...item, kind: 'component' as const })), ...publication.relationships.fronts.map((item) => ({ ...item, kind: 'front' as const }))] : [];

  return <div class="component-name-backdrop architecture-backdrop publication-backdrop" role="presentation"><section class="component-name-dialog architecture-dialog publication-dialog" role="dialog" aria-modal="true" aria-labelledby="publication-title">
    <header><div><p class="section-kicker">Human acceptance boundary</p><h2 id="publication-title">Publish {repository.name}'s reviewed plan</h2></div><button type="button" aria-label="Close publication review" onClick={onCancel} disabled={busy}>×</button></header>
    {!publication ? <div class="publication-setup">
      <div class="architecture-safety"><span><b>Private sources only · zero accepted mutation</b><small>Preparing a preview renders exact bytes but creates no repository file, worktree or agent.</small></span><strong>review</strong></div>
      <section class="publication-mode"><header><div><p class="section-kicker">Select exactly what can cross the boundary</p><h3>Publication scope</h3></div></header><div>
        {([
          ['components-only', 'Components only', 'Publish the selected architecture; keep product and fronts private.'],
          ['product-components', 'Product + components', 'Publish one private product draft and the selected architecture.'],
          ['complete-plan', 'Complete plan', 'Publish components and one compatible front portfolio; product remains an explicit choice.'],
        ] as Array<[PublicationMode, string, string]>).map(([value, title, description]) => <button type="button" key={value} class={mode === value ? 'active' : ''} aria-pressed={mode === value} onClick={() => { setMode(value); if (value === 'product-components') setIncludeProduct(true); setPublication(null); }}><b>{title}</b><small>{description}</small></button>)}
      </div></section>
      <div class="publication-source-grid">
        <label><span>Component workspace</span><select value={componentDraftId} disabled={busy} onChange={(event) => selectComponentDraft(event.currentTarget.value)}><option value="">Choose reviewed components</option>{componentDrafts.map((item) => <option value={item.id} key={item.id}>{new Date(item.updatedAt).toLocaleString()} · {item.state}{item.stale ? ' · stale' : ''}</option>)}</select></label>
        <label><span>Component alternative</span><select value={componentAlternativeId} disabled={busy || !componentDraft} onChange={(event) => selectComponentAlternative(event.currentTarget.value)}><option value="">Choose an architecture</option>{componentDraft?.alternatives.map((item) => <option value={item.id} key={item.id}>{item.title} · {item.components.length} components · {item.quality.gateC.pass ? 'Gate C' : 'blocked'}</option>)}</select></label>
        {mode === 'complete-plan' && <><label><span>Compatible front workspace</span><select value={frontDraftId} disabled={busy || !componentAlternative} onChange={(event) => selectFrontDraft(event.currentTarget.value)}><option value="">Choose reviewed fronts</option>{compatibleFronts.map((item) => <option value={item.id} key={item.id}>{new Date(item.updatedAt).toLocaleString()} · {item.source.goal.title}{item.stale ? ' · stale' : ''}</option>)}</select></label><label><span>Front alternative</span><select value={frontAlternativeId} disabled={busy || !frontDraft} onChange={(event) => { setFrontAlternativeId(event.currentTarget.value); setPublication(null); }}><option value="">Choose a portfolio</option>{frontDraft?.alternatives.map((item) => <option value={item.id} key={item.id}>{item.title} · {item.fronts.length} fronts · {item.quality.gateD.pass ? 'Gate D' : 'blocked'}</option>)}</select></label></>}
      </div>
      {mode === 'complete-plan' && <label class="publication-choice"><input type="checkbox" checked={includeProduct} onChange={(event) => { setIncludeProduct(event.currentTarget.checked); setPublication(null); }} /><span><b>Include a reviewed product draft</b><small>Leave this off to preserve the currently accepted product brief exactly.</small></span></label>}
      {needsProductDraft && <section class="publication-product-source"><span><b>{productDraft ? productDraft.brief.title : 'Private product draft required'}</b><small>{productDraft ? `Baseline ${productDraft.baselineRevision?.slice(0, 12) || 'none'} · ${productDraft.stale ? 'stale' : 'current'}` : 'Loading resumes the latest private draft or creates one from the accepted brief. It does not publish it.'}</small></span><div><button type="button" disabled={busy} onClick={() => void loadProductDraft()}>{productDraft ? 'Reload draft' : 'Load private draft'}</button><button type="button" onClick={onEditProduct}>Edit product brief</button></div></section>}
      <details class="publication-delete-options"><summary>Explicit deletion options · off by default</summary><label class="publication-choice"><input type="checkbox" checked={deleteAbsentComponents} onChange={(event) => setDeleteAbsentComponents(event.currentTarget.checked)} /><span><b>Delete accepted components absent from this alternative</b><small>Without this choice, accepted components not mentioned by the draft are preserved.</small></span></label>{mode === 'complete-plan' && <><label class="publication-choice"><input type="checkbox" checked={deleteAbsentFronts} onChange={(event) => setDeleteAbsentFronts(event.currentTarget.checked)} /><span><b>Delete accepted fronts absent from this portfolio</b><small>Completed fronts remain protected by an additional override.</small></span></label>{deleteAbsentFronts && <label class="publication-choice danger"><input type="checkbox" checked={allowCompletedDeletes} onChange={(event) => setAllowCompletedDeletes(event.currentTarget.checked)} /><span><b>Allow deletion of completed-front evidence</b><small>Use only after reviewing every completed deletion in the exact diff.</small></span></label>}</>}</details>
      {(componentDraft?.stale || frontDraft?.stale || productDraft?.stale) && <div class="architecture-stale"><b>A selected source is stale</b><span>A preview will remain blocked until you refresh the underlying private workspace.</span></div>}
      {!componentDrafts.length && !busy && <div class="planning-partial-note"><b>No component workspace exists</b><span>Design and review repository responsibilities before publication.</span></div>}
      <div class="publication-prepare"><span><b>No implicit dependencies</b><small>{mode === 'components-only' ? 'Product and fronts stay unchanged.' : mode === 'product-components' ? 'Fronts stay unchanged.' : includeProduct ? 'Product, components and fronts are selected.' : 'Accepted product stays unchanged; components and fronts are selected.'}</small></span><button class="primary" type="button" disabled={busy || !componentDraft || !componentAlternative || (mode === 'complete-plan' && (!frontDraft || !frontAlternative)) || (needsProductDraft && !productDraft)} onClick={() => void prepare()}>{busy ? 'Rendering exact diff…' : 'Prepare whole-plan preview'}</button></div>
      {recent.length > 0 && <section class="publication-recent"><h3>Recent publication reviews</h3>{recent.map((item) => <article key={item.id}><span><b>{item.selection.mode.replaceAll('-', ' ')} · {item.summary.files} files</b><small>{new Date(item.updatedAt).toLocaleString()} · {item.state} · {item.publicationDigest.slice(0, 12)}</small></span><button type="button" onClick={() => void openPublication(item.id)}>Open</button></article>)}</section>}
    </div> : <div class="publication-review">
      <div class={`publication-authority ${publication.state}`}><span><b>{publication.state === 'committed' ? 'Accepted publication is durable' : 'Only this exact revision can be accepted'}</b><small>{publication.selection.mode} · snapshot {publication.source.snapshotId.slice(0, 12)} · {publication.source.analyzer ? `${publication.source.analyzer.id} ${publication.source.analyzer.version}` : 'analyzer unavailable'}</small></span><code>{publication.revision.slice(0, 16)}</code></div>
      <div class="publication-summary"><article><span>Creates</span><strong>{publication.summary.creates}</strong></article><article><span>Updates</span><strong>{publication.summary.updates}</strong></article><article><span>Deletes</span><strong>{publication.summary.deletes}</strong></article><article><span>Accepted files</span><strong>{publication.summary.files}</strong></article><article><span>Exact diff</span><strong>{publicationBytes(publication.summary.bytes)}</strong></article><article class={publication.validation.valid ? 'pass' : 'blocked'}><span>Validation</span><strong>{publication.validation.valid ? 'Pass' : `${publication.summary.errors} errors`}</strong></article></div>
      {publication.failure && <div class="architecture-stale"><b>{publication.failure.code}</b><span>{publication.failure.message}{publication.failure.recoveryRequired ? ' Server-host recovery is required before another write.' : ''}</span></div>}
      {publication.validation.diagnostics.length > 0 && <section class="publication-diagnostics"><header><h3>Validation diagnostics</h3><span>{publication.summary.errors} errors · {publication.summary.warnings} warnings</span></header><ul>{publication.validation.diagnostics.map((item, index) => <li class={item.severity} key={`${item.code}-${index}`}><span><b>{item.code}</b><small>{item.path}</small></span><p>{item.message}</p></li>)}</ul></section>}
      <section class="publication-relationships"><header><div><p class="section-kicker">Relationship diff</p><h3>Ownership, dependencies and goals</h3></div><span>{relationshipChanges.length} changed records</span></header>{relationshipChanges.length ? <div>{relationshipChanges.map((item) => <article class={item.action} key={`${item.kind}-${item.slug}`}><header><span><b>{item.slug}</b><small>{item.kind}</small></span><strong>{item.action}</strong></header><div><pre>{item.before ? JSON.stringify(item.before, null, 2) : '∅'}</pre><i>→</i><pre>{item.after ? JSON.stringify(item.after, null, 2) : '∅'}</pre></div></article>)}</div> : <p class="empty-state">No component/front relationship changes in this selection.</p>}</section>
      <section class="publication-files"><header><div><p class="section-kicker">Exact textual diff</p><h3>Every destination in this transaction</h3></div><span>{publication.operations.length} rendered operations · audit included</span></header>{publication.operations.map((operation) => <PublicationFileDiff operation={operation} key={operation.id} />)}</section>
      {publication.state === 'committed' ? <section class="publication-success"><b>Publication committed once</b><p>The audit is at <code>{publication.result?.auditPath}</code>. No worktree or agent was created; the accepted portfolio is now available to execution.</p></section> : <section class="publication-confirm"><label class="publication-choice"><input type="checkbox" checked={confirmed} disabled={!publication.canPublish || busy} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span><b>I reviewed every file, deletion and relationship above</b><small>This confirms revision <code>{publication.revision.slice(0, 16)}</code>. Any changed source or accepted file invalidates it.</small></span></label><button class="primary" type="button" disabled={busy || !confirmed || !publication.canPublish} onClick={() => void commit()}>{busy ? 'Publishing transaction…' : 'Publish this exact plan'}</button></section>}
      <footer class="publication-review-actions"><button type="button" disabled={busy} onClick={() => { setPublication(null); setConfirmed(false); }}>Prepare a current preview</button>{publication.state !== 'committed' && <button class="danger" type="button" disabled={busy || publication.state === 'committing'} onClick={() => void discard()}>Discard preview</button>}<span /><button type="button" disabled={busy} onClick={onCancel}>Close</button></footer>
    </div>}
    {error && <p class="form-error architecture-error" role="alert">{error}</p>}
    {!publication && <footer><span /><button type="button" onClick={onCancel} disabled={busy}>Close</button></footer>}
  </section></div>;
}

const SYSTEM_MAP_LENS_LABELS: Record<SystemMapLens, string> = {
  responsibility: 'Responsibilities',
  module: 'Modules',
  deployable: 'Deployables',
  dependency: 'Dependencies',
  'entry-point': 'Entry points',
  interface: 'Interfaces',
  'data-flow': 'Data flow',
  'data-store': 'Data stores',
  test: 'Tests',
  'external-system': 'External systems',
  'change-coupling': 'Change coupling',
};

const PROVENANCE_LABELS: Record<SystemMapEvidence['provenance'], string> = {
  extracted: 'Extracted',
  inferred: 'Inferred',
  declared: 'Declared',
};

function ProvenanceBadge({ kind }: { kind: SystemMapEvidence['provenance'] }) {
  return <span class={`provenance-badge ${kind}`}>{PROVENANCE_LABELS[kind]}</span>;
}

function EvidenceLocation({ evidence, stale = false }: { evidence: SystemMapEvidence; stale?: boolean }) {
  const line = evidence.range?.start.line;
  return <li>
    <span><code title={evidence.path || evidence.id}>{evidence.path || 'No retained source path'}</code>{line && <small>lines {line}{evidence.range?.end.line !== line ? `–${evidence.range?.end.line}` : ''}</small>}</span>
    <ProvenanceBadge kind={evidence.provenance} />
    <p>{evidence.summary || `${evidence.sourceKind.replaceAll('-', ' ')} evidence retained by the analyzer.`}</p>
    <small class="evidence-snapshot-state">Source in the selected {stale ? 'stale ' : ''}snapshot · {evidence.sourceKind.replaceAll('-', ' ')}</small>
    <details><summary>Technical reference</summary><code>{evidence.id}</code></details>
  </li>;
}

function ReconciliationPanel({
  repository, refreshToken, onAnalyze,
}: { repository: Repository; refreshToken: number; onAnalyze: () => void }) {
  const [summary, setSummary] = useState<ReconciliationSummary | null>(repository.reconciliation || null);
  const [findings, setFindings] = useState<ReconciliationFinding[]>([]);
  const [jobs, setJobs] = useState<ReconciliationJob[]>([]);
  const [triggers, setTriggers] = useState<ReconciliationTrigger[]>([]);
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(repository.reconciliationError || '');

  const load = useCallback(async () => {
    try {
      const [summaryResponse, findingsResponse, jobsResponse, triggerResponse] = await Promise.all([
        api<{ reconciliation: ReconciliationSummary }>(`/api/repositories/${repository.id}/reconciliation`),
        api<{ findings: ReconciliationFinding[] }>(`/api/repositories/${repository.id}/reconciliation/findings?active=true`),
        api<{ jobs: ReconciliationJob[] }>(`/api/repositories/${repository.id}/reconciliation/jobs`),
        api<{ triggers: ReconciliationTrigger[] }>(`/api/repositories/${repository.id}/reconciliation/triggers`),
      ]);
      setSummary(summaryResponse.reconciliation);
      setFindings(findingsResponse.findings);
      setJobs(jobsResponse.jobs);
      setTriggers(triggerResponse.triggers);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [repository.id]);

  useEffect(() => { void load(); }, [load, refreshToken]);
  useEffect(() => {
    if (!jobs.some((job) => ['running', 'reconciling'].includes(job.state))) return;
    const timer = window.setInterval(() => void load(), 700);
    return () => window.clearInterval(timer);
  }, [jobs, load]);

  const decide = async (finding: ReconciliationFinding, state: Exclude<ReconciliationDecisionState, 'open'>) => {
    const rationale = (rationales[finding.id] || '').trim();
    if (!rationale) return;
    setBusy(true); setError('');
    try {
      await api(`/api/repositories/${repository.id}/reconciliation/findings/${encodeURIComponent(finding.id)}/decision`, {
        method: 'POST', body: JSON.stringify({ state, rationale }),
      });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const cancel = async (job: ReconciliationJob) => {
    setBusy(true); setError('');
    try {
      await api(`/api/repositories/${repository.id}/reconciliation/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const activeJobs = jobs.filter((job) => ['running', 'reconciling'].includes(job.state));
  const pendingTriggers = triggers.filter((trigger) => trigger.state === 'pending');
  return <section class="reconciliation-review" aria-label="Architecture reconciliation" aria-busy={busy}>
    <header class="reconciliation-heading">
      <div><p class="section-kicker">Keep the model honest</p><h3>Architecture reconciliation</h3><p>Trace changed repository evidence into product, component, front and run risk. Findings are review overlays, never silent contract edits.</p></div>
      <button type="button" onClick={onAnalyze}>Refresh analysis</button>
    </header>

    {(pendingTriggers.length > 0 || activeJobs.length > 0) && <div class="reconciliation-attention">
      {pendingTriggers.length > 0 && <span><b>{pendingTriggers.length} refresh recommendation{pendingTriggers.length === 1 ? '' : 's'}</b><small>{pendingTriggers[0].message}</small></span>}
      {activeJobs.map((job) => <span key={job.id}><b>{job.stage} · {Math.round(job.progress * 100)}%</b><small>{job.message}</small><button type="button" disabled={busy} onClick={() => void cancel(job)}>Cancel</button></span>)}
    </div>}

    <div class="reconciliation-stats">
      <article><span>Active findings</span><strong>{summary?.findings.active || 0}</strong><small>{summary?.findings.open || 0} need a decision</small></article>
      <article><span>High / critical</span><strong>{(summary?.findings.bySeverity.high || 0) + (summary?.findings.bySeverity.critical || 0)}</strong><small>review before allocating work</small></article>
      <article><span>Latest cycle</span><strong>{summary?.lastCycle ? summary.lastCycle.summary.noChange ? 'No change' : `${summary.lastCycle.summary.findings} findings` : 'Not run'}</strong><small>{summary?.lastCycle ? new Date(summary.lastCycle.createdAt).toLocaleString() : 'compare two snapshots'}</small></article>
      <article><span>Accepted contracts</span><strong>Unchanged</strong><small>publication remains explicit</small></article>
    </div>

    <div class="reconciliation-findings" aria-live="polite">
      {findings.map((finding) => <details class={`reconciliation-finding ${finding.severity}`} key={finding.id} open={finding.severity === 'critical'}>
        <summary><span><i>{finding.severity}</i><b>{finding.summary}</b><small>{finding.kind.replaceAll('-', ' ')} · {finding.confidence.level} confidence · seen {finding.occurrences}×</small></span><strong>{finding.disposition.replaceAll('-', ' ')}</strong></summary>
        <div class="reconciliation-finding-body">
          <p>{finding.detail}</p>
          <div class="reconciliation-evidence-grid">
            <section><h4>Exact evidence</h4>{finding.evidence.paths.length > 0 && <code>{finding.evidence.paths.join('\n')}</code>}{finding.evidence.ids.length > 0 && <code>{finding.evidence.ids.join('\n')}</code>}{!finding.evidence.paths.length && !finding.evidence.ids.length && <small>No retained evidence identifiers.</small>}</section>
            <section><h4>Affected planning</h4><dl><div><dt>Components</dt><dd>{finding.affected.components.join(', ') || 'none traced'}</dd></div><div><dt>Fronts</dt><dd>{finding.affected.fronts.join(', ') || 'none traced'}</dd></div><div><dt>Runs</dt><dd>{finding.affected.runs.join(', ') || 'none traced'}</dd></div><div><dt>Product claims</dt><dd>{finding.affected.productClaims.join(', ') || 'none traced'}</dd></div></dl></section>
          </div>
          <section class="reconciliation-explanation"><h4>Why Handraise surfaced this</h4><p>{finding.provenance.explanation}</p>{finding.confidence.reasons.length > 0 && <ul>{finding.confidence.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</section>
          {finding.alternatives.length > 0 && <section class="reconciliation-alternatives"><h4>Alternatives to review</h4><ul>{finding.alternatives.map((item) => <li key={item.summary}>{item.summary}</li>)}</ul></section>}
          <div class="reconciliation-decision">
            <label><span>Decision rationale</span><textarea value={rationales[finding.id] || ''} placeholder="Why should this be dismissed, deferred or admitted into the next planning review?" onInput={(event) => setRationales((current) => ({ ...current, [finding.id]: event.currentTarget.value }))} /></label>
            <div><button type="button" disabled={busy || !(rationales[finding.id] || '').trim()} onClick={() => void decide(finding, 'dismissed')}>Dismiss</button><button type="button" disabled={busy || !(rationales[finding.id] || '').trim()} onClick={() => void decide(finding, 'deferred')}>Defer</button><button class="primary" type="button" disabled={busy || !(rationales[finding.id] || '').trim()} onClick={() => void decide(finding, 'accepted-for-planning')}>Accept for planning</button></div>
            <small>“Accept for planning” records intent only. It does not edit or publish product, component or front contracts.</small>
          </div>
        </div>
      </details>)}
      {!findings.length && <div class="empty-state">{summary?.lastCycle ? 'No active drift findings in the latest comparison.' : 'Create two reviewed snapshots, then compare them to establish reconciliation history.'}</div>}
    </div>
    {error && <p class="form-error" role="alert">{error}</p>}
  </section>;
}

const LEARNING_FEEDBACK_REASONS = [
  'correct-target', 'wrong-target', 'useful-evidence', 'weak-evidence', 'good-scope', 'too-broad', 'too-narrow', 'duplicate', 'other',
] as const;

function learningProposedValue(value: unknown): string {
  if (value === null || value === undefined) return 'Review only — no value is applied automatically.';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function LearningPanel({ repository, refreshToken, onOpenDraft }: {
  repository: Repository;
  refreshToken: number;
  onOpenDraft: (draft: LearningRoutedDraft) => void | Promise<void>;
}) {
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [proposals, setProposals] = useState<LearningProposal[]>([]);
  const [feedback, setFeedback] = useState<LearningFeedback[]>([]);
  const [implicitLocal, setImplicitLocal] = useState(false);
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [deferDates, setDeferDates] = useState<Record<string, string>>({});
  const [feedbackReasons, setFeedbackReasons] = useState<Record<string, string>>({});
  const [feedbackRationales, setFeedbackRationales] = useState<Record<string, string>>({});
  const [selectedFeedback, setSelectedFeedback] = useState<string[]>([]);
  const [exportPurpose, setExportPurpose] = useState<'benchmark-contribution' | 'ranking-evaluation'>('benchmark-contribution');
  const [exportPreview, setExportPreview] = useState<LearningExportPreview | null>(null);
  const [exportConfirmed, setExportConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const [result, auth] = await Promise.all([
        api<{ summary: LearningSummary; proposals: LearningProposal[]; feedback: LearningFeedback[] }>(`/api/repositories/${repository.id}/learning`),
        api<AuthStatus>('/api/auth/status'),
      ]);
      setSummary(result.summary); setProposals(result.proposals); setFeedback(result.feedback);
      setImplicitLocal(Boolean(auth.implicitLocal || auth.device?.implicit));
      setSelectedFeedback((current) => current.filter((id) => result.feedback.some((item) => item.id === id)));
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [repository.id]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const refresh = async () => {
    setBusy('refresh'); setError(''); setNotice(''); setExportPreview(null); setExportConfirmed(false);
    try {
      await api(`/api/repositories/${repository.id}/learning`, { method: 'POST', body: '{}' });
      await load(); setNotice('Proposals were rebuilt from current durable runs, accepted contracts and reviewed reconciliation findings.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  const decide = async (proposal: LearningProposal, state: 'open' | 'dismissed' | 'deferred') => {
    const rationale = (rationales[proposal.id] || '').trim();
    if (state !== 'open' && !rationale) return;
    const rawDate = deferDates[proposal.id];
    const reconsiderAfter = state === 'deferred' && rawDate ? new Date(`${rawDate}T00:00:00.000Z`).toISOString() : null;
    setBusy(proposal.id); setError(''); setNotice('');
    try {
      await api(`/api/repositories/${repository.id}/learning/proposals/${encodeURIComponent(proposal.id)}/decision`, {
        method: 'POST', body: JSON.stringify({ state, rationale, reconsiderAfter }),
      });
      await load();
      setNotice(state === 'open' ? 'The proposal is open for review again.' : `The ${state} decision and its rationale were retained locally.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  const route = async (proposal: LearningProposal) => {
    setBusy(proposal.id); setError(''); setNotice('');
    try {
      const result = await api<{ proposal: LearningProposal; draft: LearningRoutedDraft; authority: { contractMutation: false; publicationRequired: true } }>(`/api/repositories/${repository.id}/learning/proposals/${encodeURIComponent(proposal.id)}/route`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: proposal.revision }),
      });
      await load();
      setNotice('A validated private draft was created. Accepted contracts remain byte-for-byte unchanged until explicit publication.');
      await onOpenDraft(result.draft);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  const recordFeedback = async (proposal: LearningProposal, signal: 'useful' | 'not-useful') => {
    setBusy(`feedback:${proposal.id}`); setError(''); setNotice('');
    try {
      await api(`/api/repositories/${repository.id}/learning/proposals/${encodeURIComponent(proposal.id)}/feedback`, {
        method: 'POST', body: JSON.stringify({
          signal,
          reasonCode: feedbackReasons[proposal.id] || (signal === 'useful' ? 'correct-target' : 'wrong-target'),
          rationale: feedbackRationales[proposal.id] || '',
        }),
      });
      await load(); setNotice('Private feedback was recorded for inspectable local ranking only. It does not establish product truth.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  const removeProposal = async (proposal: LearningProposal) => {
    if (!window.confirm('Delete this private proposal and its attached local feedback? Accepted contracts will not change.')) return;
    setBusy(proposal.id); setError('');
    try {
      await api(`/api/repositories/${repository.id}/learning/proposals/${encodeURIComponent(proposal.id)}`, { method: 'DELETE' });
      await load(); setNotice('The private proposal was deleted.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  const removeFeedback = async (id: string) => {
    setBusy(`feedback:${id}`); setError('');
    try {
      await api(`/api/repositories/${repository.id}/learning/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load(); setExportPreview(null); setExportConfirmed(false); setNotice('The private feedback record was deleted.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  const prepareExport = async () => {
    if (!selectedFeedback.length) return;
    setBusy('export'); setError(''); setNotice(''); setExportConfirmed(false);
    try {
      const result = await api<{ preview: LearningExportPreview }>(`/api/repositories/${repository.id}/learning/exports/preview`, {
        method: 'POST', body: JSON.stringify({ purpose: exportPurpose, feedbackIds: selectedFeedback, benchmarkTarget: 'planning-quality-v1' }),
      });
      setExportPreview(result.preview);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  const confirmExport = async () => {
    if (!exportPreview || !exportConfirmed) return;
    setBusy('export'); setError(''); setNotice('');
    try {
      const result = await api<{ payload: Record<string, unknown>; revision: string; delivery: 'download-only'; networkRequestMade: false }>(`/api/repositories/${repository.id}/learning/exports/${encodeURIComponent(exportPreview.id)}/confirm`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: exportPreview.revision, confirmed: true }),
      });
      const href = URL.createObjectURL(new Blob([`${JSON.stringify(result.payload, null, 2)}\n`], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = href; anchor.download = `handraise-learning-${result.revision.slice(0, 12)}.json`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
      await load(); setSelectedFeedback([]); setExportPreview(null); setExportConfirmed(false);
      setNotice('The sanitized contribution was downloaded locally. Handraise made no external network request.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(''); }
  };

  return <section class="learning-review" aria-label="Outcome learning loop" aria-busy={Boolean(busy)}>
    <header class="learning-heading">
      <div><p class="section-kicker">Learn without rewriting history</p><h3>Outcome learning proposals</h3><p>Correlate exact run outcomes and reviewed drift with exact accepted revisions. Every result stays private and reviewable; no proposal mutates a contract.</p></div>
      <button type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh proposals'}</button>
    </header>

    <div class="learning-authority"><span><b>Local ranking is not product truth</b><small>Agent claims remain declared. Observed checks stay distinct. Feedback changes proposal order only.</small></span><strong>zero auto mutation</strong></div>
    <div class="learning-stats">
      <article><span>Open</span><strong>{summary?.proposals.open || 0}</strong><small>{summary?.proposals.total || 0} retained proposals</small></article>
      <article><span>Stale</span><strong>{summary?.proposals.stale || 0}</strong><small>exact revision changed</small></article>
      <article><span>Contradictions</span><strong>{summary?.proposals.contradictions || 0}</strong><small>kept separate for review</small></article>
      <article><span>Private feedback</span><strong>{summary?.feedback.total || 0}</strong><small>{summary?.feedback.useful || 0} useful · {summary?.feedback.notUseful || 0} not useful</small></article>
    </div>

    <div class="learning-proposals" aria-live="polite">
      {proposals.map((proposal, index) => <details class={`learning-proposal ${proposal.state}`} key={proposal.id} open={proposal.state === 'open' && index === 0}>
        <summary><span><i>{proposal.cause.authority.provenance}</i><b>{proposal.summary}</b><small>{proposal.target.kind.replaceAll('-', ' ')} · {proposal.target.id} · {Math.round(proposal.confidence.score * 100)}% confidence · rank {proposal.rank}</small></span><strong>{proposal.state.replaceAll('-', ' ')}</strong></summary>
        <div class="learning-proposal-body">
          <p>{proposal.detail}</p>
          <div class="learning-source-grid">
            <section><h4>Cause and authority</h4><dl><div><dt>Cause</dt><dd>{proposal.cause.kind} · {proposal.cause.id}</dd></div><div><dt>Source state</dt><dd>{proposal.cause.sourceState}</dd></div><div><dt>Fact authority</dt><dd>{proposal.cause.verified && proposal.cause.authority.trustedAsFact ? 'Observed and independently retained' : 'Reviewable declaration or inference'}</dd></div><div><dt>Occurrences</dt><dd>{proposal.occurrences}</dd></div></dl></section>
            <section><h4>Exact target</h4><dl><div><dt>Contract</dt><dd>{proposal.target.kind} · {proposal.target.id}</dd></div><div><dt>Revision</dt><dd><code>{proposal.target.revision || 'new target'}</code></dd></div><div><dt>Exists</dt><dd>{proposal.target.exists ? 'yes' : 'proposed'}</dd></div><div><dt>Proposal</dt><dd><code>{proposal.revision.slice(0, 16)}</code></dd></div></dl></section>
          </div>
          <section class="learning-changes"><h4>Proposed field changes</h4>{proposal.changes.map((change, changeIndex) => <article key={`${change.field}-${changeIndex}`}><header><span><b>{change.field}</b><small>{change.operation} · before {change.beforeSummary}</small></span><code>{change.beforeDigest.slice(0, 8)} → {change.afterDigest.slice(0, 8)}</code></header><pre>{learningProposedValue(change.proposedValue)}</pre><p>{change.reason}</p></article>)}</section>
          <div class="learning-source-grid">
            <section><h4>Evidence references</h4>{proposal.evidence.references.length ? <code class="learning-evidence">{proposal.evidence.references.join('\n')}</code> : <small>No retained reference IDs.</small>}{proposal.evidence.paths.length ? <code class="learning-evidence">{proposal.evidence.paths.join('\n')}</code> : null}</section>
            <section><h4>Confidence and affected work</h4><ul>{proposal.confidence.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><small>{[...proposal.affected.components, ...proposal.affected.fronts, ...proposal.affected.runs].join(' · ') || 'No accepted owner traced.'}</small></section>
          </div>
          {proposal.contradictions.length > 0 && <div class="learning-contradiction"><b>{proposal.contradictions.length} contradictory proposal{proposal.contradictions.length === 1 ? '' : 's'}</b><span>{proposal.contradictions.join(' · ')}</span></div>}
          {proposal.staleReasons.length > 0 && <div class="learning-stale"><b>Stale exact context</b><span>{proposal.staleReasons.join(' ')}</span></div>}
          {(proposal.decisionMemory || proposal.decision) && <section class="learning-memory"><h4>Decision memory</h4>{proposal.decisionMemory?.rationale && <p>Reconciliation: {proposal.decisionMemory.rationale}</p>}{proposal.decision?.rationale && <p>{proposal.decision.state}: {proposal.decision.rationale}</p>}{proposal.decision?.reconsiderAfter && <small>Reconsider after {new Date(proposal.decision.reconsiderAfter).toLocaleString()}</small>}</section>}

          {proposal.state === 'open' ? <div class="learning-decision">
            <label><span>Decision rationale</span><textarea value={rationales[proposal.id] || ''} placeholder="Why should this be dismissed or deferred?" onInput={(event) => setRationales((current) => ({ ...current, [proposal.id]: event.currentTarget.value }))} /></label>
            <label><span>Reconsider after · optional</span><input type="date" value={deferDates[proposal.id] || ''} onInput={(event) => setDeferDates((current) => ({ ...current, [proposal.id]: event.currentTarget.value }))} /></label>
            <div><button type="button" disabled={Boolean(busy) || !(rationales[proposal.id] || '').trim()} onClick={() => void decide(proposal, 'dismissed')}>Dismiss</button><button type="button" disabled={Boolean(busy) || !(rationales[proposal.id] || '').trim()} onClick={() => void decide(proposal, 'deferred')}>Defer</button><button class="primary" type="button" disabled={Boolean(busy)} onClick={() => void route(proposal)}>{busy === proposal.id ? 'Creating draft…' : 'Create review draft'}</button></div>
            <small>Creating a draft applies this proposal only inside an existing validated product/component/front workspace. Transactional publication remains mandatory.</small>
          </div> : ['dismissed', 'deferred'].includes(proposal.state) ? <div class="learning-reopen"><span><b>{proposal.state}</b><small>The rationale stays inspectable after reopening.</small></span><button type="button" disabled={Boolean(busy)} onClick={() => void decide(proposal, 'open')}>Reopen review</button></div> : proposal.routedDraft ? <div class="learning-routed"><span><b>Validated {proposal.routedDraft.kind.replaceAll('-', ' ')} draft</b><small>{proposal.routedDraft.draftId} · accepted contracts unchanged</small></span><button type="button" disabled={Boolean(busy)} onClick={() => void onOpenDraft(proposal.routedDraft!)}>Open draft</button></div> : null}

          <section class="learning-feedback-form"><header><span><b>Was this proposal useful?</b><small>Stored only on this host; it adjusts inspectable ranking, never facts.</small></span><select value={feedbackReasons[proposal.id] || 'correct-target'} onChange={(event) => setFeedbackReasons((current) => ({ ...current, [proposal.id]: event.currentTarget.value }))}>{LEARNING_FEEDBACK_REASONS.map((reason) => <option value={reason} key={reason}>{reason.replaceAll('-', ' ')}</option>)}</select></header><textarea value={feedbackRationales[proposal.id] || ''} placeholder="Optional private rationale — excluded from export" onInput={(event) => setFeedbackRationales((current) => ({ ...current, [proposal.id]: event.currentTarget.value }))} /><div><button type="button" disabled={Boolean(busy)} onClick={() => void recordFeedback(proposal, 'useful')}>Useful</button><button type="button" disabled={Boolean(busy)} onClick={() => void recordFeedback(proposal, 'not-useful')}>Not useful</button><button class="danger" type="button" disabled={Boolean(busy)} onClick={() => void removeProposal(proposal)}>Delete proposal</button></div></section>
        </div>
      </details>)}
      {!proposals.length && <div class="empty-state">No outcome proposal exists yet. Refresh after a durable run outcome, recorded discovery or reconciliation decision.</div>}
    </div>

    <details class="learning-feedback-ledger">
      <summary>Private feedback ledger ({feedback.length})</summary>
      <div class="learning-feedback-list">{feedback.map((item) => <article key={item.id}><label><input type="checkbox" checked={selectedFeedback.includes(item.id)} onChange={(event) => { setExportPreview(null); setExportConfirmed(false); setSelectedFeedback((current) => event.currentTarget.checked ? [...current, item.id] : current.filter((id) => id !== item.id)); }} /><span><b>{item.signal.replaceAll('-', ' ')} · {item.reasonCode.replaceAll('-', ' ')}</b><small>{new Date(item.createdAt).toLocaleString()} · {item.privacy.exported ? 'included in a prior download' : 'never exported'}</small>{item.rationale && <p>{item.rationale}</p>}</span></label><button class="danger" type="button" disabled={Boolean(busy)} onClick={() => void removeFeedback(item.id)}>Delete</button></article>)}</div>
      {!feedback.length && <p class="empty-state">No private feedback has been recorded.</p>}
      {feedback.length > 0 && <section class="learning-export"><header><span><b>Optional anonymized benchmark contribution</b><small>Host-only, exact preview, explicit confirmation and local download. No automatic upload exists.</small></span><select value={exportPurpose} disabled={!implicitLocal || Boolean(busy)} onChange={(event) => { setExportPurpose(event.currentTarget.value as typeof exportPurpose); setExportPreview(null); setExportConfirmed(false); }}><option value="benchmark-contribution">Benchmark contribution</option><option value="ranking-evaluation">Ranking evaluation</option></select></header>
        {implicitLocal ? <><button type="button" disabled={Boolean(busy) || !selectedFeedback.length} onClick={() => void prepareExport()}>{busy === 'export' ? 'Preparing…' : `Preview ${selectedFeedback.length} selected record${selectedFeedback.length === 1 ? '' : 's'}`}</button>{exportPreview && <div class="learning-export-preview"><div><b>Sanitized exact payload</b><code>{exportPreview.revision}</code></div><pre>{JSON.stringify(exportPreview.payload, null, 2)}</pre><label><input type="checkbox" checked={exportConfirmed} onChange={(event) => setExportConfirmed(event.currentTarget.checked)} /><span>I reviewed this exact payload. Download it locally; do not send it anywhere automatically.</span></label><button class="primary" type="button" disabled={Boolean(busy) || !exportConfirmed} onClick={() => void confirmExport()}>Confirm exact payload + download</button></div>}</> : <p>Open Handraise directly on the server host over loopback to prepare an export. Paired LAN and Internet clients cannot cross this privacy boundary.</p>}
      </section>}
    </details>
    {notice && <p class="learning-notice" role="status">{notice}</p>}
    {error && <p class="form-error" role="alert">{error}</p>}
  </section>;
}

function SystemMapView({
  repository, refreshToken, onAnalyze, onProduct, onNavigate, onOpenLearningDraft,
}: {
  repository: Repository;
  refreshToken: number;
  onAnalyze: () => void;
  onProduct: () => void;
  onNavigate: (route: RouteState) => void;
  onOpenLearningDraft: (draft: LearningRoutedDraft) => void | Promise<void>;
}) {
  const [product, setProduct] = useState<ProductStatus | null>(null);
  const [productLoading, setProductLoading] = useState(true);
  const [productError, setProductError] = useState('');
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobsError, setJobsError] = useState('');
  const [jobId, setJobId] = useState('');
  const [compareJobId, setCompareJobId] = useState('');
  const [map, setMap] = useState<SystemMapSummary | null>(null);
  const [result, setResult] = useState<SystemMapQueryResult | null>(null);
  const [detail, setDetail] = useState<SystemMapQueryResult | null>(null);
  const [selection, setSelection] = useState<{ kind: 'group' | 'entity'; id: string } | null>(null);
  const [comparison, setComparison] = useState<SystemMapComparison | null>(null);
  const [reconciliationCycle, setReconciliationCycle] = useState<ReconciliationCycle | null>(null);
  const [reconciliationRefresh, setReconciliationRefresh] = useState(0);
  const [focusedEvidence, setFocusedEvidence] = useState<SystemMapEvidence[]>([]);
  const [lens, setLens] = useState<SystemMapLens | ''>('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'map' | 'list'>(() => window.matchMedia('(max-width: 560px)').matches ? 'list' : 'map');
  const [visibleGroupLimit, setVisibleGroupLimit] = useState(48);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const detailRef = useRef<HTMLElement>(null);
  const mapRequestSequence = useRef(0);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);

  const requestMap = useCallback(async (targetJobId: string, expectedSnapshotId: string, selectedLens: SystemMapLens | '' = '') => {
    const requestSequence = ++mapRequestSequence.current;
    if (!targetJobId) return;
    setBusy(true); setError(''); setMap(null); setResult(null); setDetail(null); setSelection(null); setComparison(null); setReconciliationCycle(null); setFocusedEvidence([]); setVisibleGroupLimit(48); selectionTriggerRef.current = null;
    try {
      const suffix = selectedLens ? `?limit=200&lens=${encodeURIComponent(selectedLens)}` : '?limit=200';
      const response = await api<{ map: SystemMapSummary; result: SystemMapQueryResult }>(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(targetJobId)}/map${suffix}`);
      if (requestSequence !== mapRequestSequence.current) return;
      if (response.map.snapshotId !== expectedSnapshotId || response.result.snapshotId !== expectedSnapshotId) {
        throw new Error('The system explanation response does not match the selected snapshot. Reload evidence before continuing.');
      }
      setMap(response.map);
      setResult(response.result);
    } catch (reason) { if (requestSequence === mapRequestSequence.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (requestSequence === mapRequestSequence.current) setBusy(false); }
  }, [repository.id]);

  useEffect(() => {
    let disposed = false;
    const refreshSequence = ++mapRequestSequence.current;
    setBusy(true); setError(''); setJobsLoaded(false); setJobsError(''); setMap(null); setResult(null); setDetail(null); setComparison(null); setReconciliationCycle(null); setFocusedEvidence([]); setLens(''); setSearch(''); selectionTriggerRef.current = null;
    api<{ jobs: AnalysisJob[] }>(`/api/repositories/${repository.id}/analysis/jobs`).then(async (response) => {
      if (disposed) return;
      const snapshots = response.jobs.filter((item) => item.snapshotId && ['complete', 'stale'].includes(item.state));
      setJobs(response.jobs);
      setJobsLoaded(true);
      const latest = snapshots[0];
      setJobId(latest?.id || '');
      setCompareJobId(latest ? snapshots.find((item) => item.createdAt < latest.createdAt)?.id || '' : '');
      if (latest?.snapshotId) await requestMap(latest.id, latest.snapshotId);
      else if (mapRequestSequence.current === refreshSequence) setBusy(false);
    }).catch((reason) => {
      if (!disposed) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setJobs([]); setJobsLoaded(true); setJobsError(message); setJobId(''); setCompareJobId(''); setError(`Repository evidence is unavailable: ${message}`); setBusy(false);
      }
    });
    return () => { disposed = true; };
  }, [repository.id, repository.reconciliation?.lastCycle?.id, repository.reconciliation?.activeJobs, refreshToken, requestMap]);

  useEffect(() => {
    let disposed = false;
    setProductLoading(true); setProductError('');
    api<ProductStatus>(`/api/repositories/${repository.id}/product`).then((response) => {
      if (!disposed) setProduct(response);
    }).catch((reason) => {
      if (!disposed) { setProduct(null); setProductError(reason instanceof Error ? reason.message : String(reason)); }
    }).finally(() => { if (!disposed) setProductLoading(false); });
    return () => { disposed = true; };
  }, [repository.id, refreshToken]);

  useEffect(() => {
    if (!selection || !window.matchMedia('(max-width: 860px)').matches) return;
    window.requestAnimationFrame(() => {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [selection?.kind, selection?.id]);

  const query = async (payload: Record<string, unknown>, { keepSelection = false } = {}) => {
    if (!jobId) return null;
    const targetJobId = jobId;
    const expectedSnapshotId = jobs.find((item) => item.id === targetJobId)?.snapshotId;
    if (!expectedSnapshotId || map?.snapshotId !== expectedSnapshotId) {
      setError('The selected snapshot is not loaded. Reload its evidence before querying it.');
      return null;
    }
    const requestSequence = ++mapRequestSequence.current;
    setBusy(true); setError('');
    if (!keepSelection) { setResult(null); setDetail(null); setSelection(null); setFocusedEvidence([]); setVisibleGroupLimit(48); selectionTriggerRef.current = null; }
    try {
      const response = await api<{ map: SystemMapSummary; result: SystemMapQueryResult }>(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(targetJobId)}/map/query`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      if (requestSequence !== mapRequestSequence.current) return null;
      if (response.map.snapshotId !== expectedSnapshotId || response.result.snapshotId !== expectedSnapshotId) {
        throw new Error('The query response does not match the selected snapshot. Reload evidence before continuing.');
      }
      setMap(response.map);
      if (!keepSelection) setResult(response.result);
      return response.result;
    } catch (reason) { if (requestSequence === mapRequestSequence.current) setError(reason instanceof Error ? reason.message : String(reason)); return null; }
    finally { if (requestSequence === mapRequestSequence.current) setBusy(false); }
  };

  const chooseLens = async (next: SystemMapLens | '') => {
    setLens(next); setSearch('');
    await query({ type: 'overview', limit: 200, ...(next ? { lens: next } : {}) });
  };

  const runSearch = async (event: Event) => {
    event.preventDefault();
    if (!search.trim()) {
      await chooseLens(lens);
      return;
    }
    await query({ type: 'search', text: search.trim(), limit: 200, ...(lens ? { lens } : {}) });
  };

  const openGroup = async (groupId: string, trigger?: HTMLElement) => {
    selectionTriggerRef.current = trigger || document.querySelector<HTMLElement>(`[data-map-id="${CSS.escape(groupId)}"]`);
    setDetail(null); setSelection(null); setFocusedEvidence([]);
    const next = await query({ type: 'group', groupId, limit: 250 }, { keepSelection: true });
    if (next) { setDetail(next); setFocusedEvidence([]); setSelection({ kind: 'group', id: groupId }); }
  };

  const openEntity = async (entityId: string, queryType: 'entity' | 'neighbors' | 'reverse-dependencies' = 'entity', trigger?: HTMLElement) => {
    if (trigger && !trigger.closest('.system-map-detail')) selectionTriggerRef.current = trigger;
    else if (!selectionTriggerRef.current?.isConnected) selectionTriggerRef.current = document.querySelector<HTMLElement>(`[data-map-id="${CSS.escape(entityId)}"]`);
    setDetail(null); setSelection(null); setFocusedEvidence([]);
    const next = await query({ type: queryType, entityId, depth: queryType === 'entity' ? undefined : 2, limit: 100 }, { keepSelection: true });
    if (next) { setDetail(next); setFocusedEvidence([]); setSelection({ kind: 'entity', id: entityId }); }
  };

  const openEvidence = async (evidenceIds: string[]) => {
    if (!evidenceIds.length) return;
    setFocusedEvidence([]);
    const next = await query({ type: 'evidence', evidenceIds, limit: Math.min(100, evidenceIds.length) }, { keepSelection: true });
    if (next) setFocusedEvidence(next.evidence);
  };

  const returnToResults = () => {
    const selectedId = selection?.id;
    setSelection(null); setDetail(null); setFocusedEvidence([]);
    window.requestAnimationFrame(() => {
      const remembered = selectionTriggerRef.current;
      const target = remembered?.isConnected ? remembered : selectedId ? document.querySelector<HTMLElement>(`[data-map-id="${CSS.escape(selectedId)}"]`) : null;
      target?.focus();
      target?.scrollIntoView({ block: 'center' });
    });
  };

  const compare = async () => {
    if (!jobId || !compareJobId) return;
    const toJob = jobs.find((item) => item.id === jobId);
    const fromJob = jobs.find((item) => item.id === compareJobId);
    if (!toJob?.snapshotId || !fromJob?.snapshotId || fromJob.id === toJob.id || fromJob.createdAt >= toJob.createdAt || map?.snapshotId !== toJob.snapshotId) {
      setCompareJobId('');
      setError('Choose a snapshot created before the selected snapshot, then reload the selected evidence before comparing.');
      return;
    }
    setBusy(true); setError('');
    try {
      const response = await api<{ comparison: SystemMapComparison }>(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(jobId)}/map/compare?fromJobId=${encodeURIComponent(compareJobId)}`);
      setComparison(response.comparison);
      const reconciled = await api<{ cycle: ReconciliationCycle }>(`/api/repositories/${repository.id}/reconciliation/compare`, {
        method: 'POST', body: JSON.stringify({ fromJobId: compareJobId, toJobId: jobId, cause: 'manual-compare' }),
      });
      setReconciliationCycle(reconciled.cycle);
      setReconciliationRefresh((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const download = async (format: 'markdown' | 'json') => {
    if (!jobId) return;
    const selectedJob = jobs.find((item) => item.id === jobId);
    if (!selectedJob?.snapshotId || map?.snapshotId !== selectedJob.snapshotId) {
      setError('The selected snapshot is not loaded. Reload its evidence before exporting it.');
      return;
    }
    setBusy(true); setError('');
    try {
      const response = await api<{ export: { filename: string; mediaType: string; content: string } }>(`/api/repositories/${repository.id}/analysis/jobs/${encodeURIComponent(jobId)}/map/export?format=${format}`);
      const href = URL.createObjectURL(new Blob([response.export.content], { type: response.export.mediaType }));
      const anchor = document.createElement('a');
      anchor.href = href; anchor.download = response.export.filename; anchor.click();
      URL.revokeObjectURL(href);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const snapshotJobs = jobs.filter((item) => item.snapshotId && ['complete', 'stale'].includes(item.state));
  const activeJob = jobs.find((item) => ['queued', 'running', 'awaiting-input'].includes(item.state)) || null;
  const selectedSnapshotJob = snapshotJobs.find((item) => item.id === jobId) || null;
  const earlierSnapshotJobs = selectedSnapshotJob ? snapshotJobs.filter((item) => item.createdAt < selectedSnapshotJob.createdAt) : [];
  const comparisonSource = earlierSnapshotJobs.find((item) => item.id === compareJobId) || null;
  const activeGroup = selection?.kind === 'group' ? detail?.groups.find((item) => item.id === selection.id) || null : null;
  const activeEntity = selection?.kind === 'entity' ? detail?.entities.find((item) => item.id === selection.id) || null : null;
  const entityById = new Map((detail?.entities || []).map((entity) => [entity.id, entity]));
  const allGroups = result?.groups || [];
  const displayedGroups = allGroups.slice(0, visibleGroupLimit);
  const coverageGaps = map?.coverage.subjects.filter((item) => item.status !== 'covered').length || 0;
  const coverageRatio = map?.coverage.totalSnapshotEntities
    ? Math.round((map.coverage.mappedEntities / map.coverage.totalSnapshotEntities) * 100)
    : 0;
  const snapshotStale = Boolean(selectedSnapshotJob && (selectedSnapshotJob.state === 'stale' || selectedSnapshotJob.snapshotFreshness !== 'current' || map?.source.freshness.state !== 'current'));
  const mapUnavailable = Boolean(jobsLoaded && !jobsError && selectedSnapshotJob && !busy && !map);
  const comparisonReady = Boolean(comparisonSource && selectedSnapshotJob?.snapshotId && map?.snapshotId === selectedSnapshotJob.snapshotId);
  const criticalDrift = (repository.reconciliation?.findings.bySeverity.critical || 0)
    + (repository.reconciliation?.findings.bySeverity.high || 0);
  const designRoute: RouteState = { ...baseRoute('components'), repositoryId: repository.id };
  const productPurpose = product?.brief?.purpose.text || '';
  const recommendation = productError
    ? { title: 'Product direction could not be verified', detail: 'Handraise will not turn an unavailable product record into a claim that no brief exists.', action: 'product' as const, label: 'Review product direction' }
    : !productLoading && !product?.exists
    ? { title: 'Clarify the product before trusting a structural guess', detail: 'Product intent gives code evidence a purpose and keeps inferred boundaries from becoming the work model by accident.', action: 'product' as const, label: 'Define product brief' }
    : jobsError
      ? { title: 'Repository evidence could not be verified', detail: 'Snapshot availability is unknown. Retry through the analysis workspace before making an evidence-based decision.', action: 'analysis' as const, label: 'Review analysis status' }
      : activeJob
      ? { title: 'Continue the analysis already in progress', detail: `${activeJob.message} Its private state can be reopened without starting another job.`, action: 'analysis' as const, label: 'Open analysis progress' }
      : !snapshotJobs.length
        ? { title: 'Inspect the repository without changing it', detail: 'Analysis is optional. Preview the exact files and data boundary before creating a private snapshot.', action: 'analysis' as const, label: 'Review analysis scope' }
        : mapUnavailable
          ? { title: 'The selected system explanation is unavailable', detail: 'Snapshot identity remains known, but its map is not shown. Reload or review a fresh analysis before querying or exporting.', action: 'analysis' as const, label: 'Review analysis result' }
        : snapshotStale
          ? { title: 'The selected evidence is stale', detail: 'You can still inspect this snapshot, but refresh scope before using it for a new planning decision.', action: 'analysis' as const, label: 'Review fresh analysis' }
          : { title: 'Explore the current system explanation', detail: 'Start with responsibility hypotheses, then inspect uncertainty and exact snapshot evidence before moving into Design.', action: 'explore' as const, label: 'Explore responsibilities' };

  const chooseSnapshot = (nextJobId: string) => {
    const target = snapshotJobs.find((item) => item.id === nextJobId);
    if (!target?.snapshotId) return;
    setJobId(target.id);
    setCompareJobId(snapshotJobs.find((item) => item.createdAt < target.createdAt)?.id || '');
    setLens(''); setSearch('');
    void requestMap(target.id, target.snapshotId);
  };

  return <section class="system-map-workspace" aria-busy={busy}>
    <header class="understand-heading">
      <div><p class="section-kicker">Understand · {repository.name}</p><h1>Intent first. Evidence second. Work design last.</h1><p>Handraise keeps accepted product direction, observed repository data and derived explanations visibly separate.</p></div>
    </header>

    <section class="understand-next" aria-label="Recommended Understand action">
      <span><p class="section-kicker">Recommended next</p><h3>{recommendation.title}</h3><small>{recommendation.detail}</small></span>
      {recommendation.action === 'product'
        ? <button class="primary" type="button" onClick={onProduct}>{recommendation.label}</button>
        : recommendation.action === 'analysis'
          ? <button class="primary" type="button" onClick={onAnalyze}>{recommendation.label}</button>
          : <a class="button-link primary" href="#system-explanation">{recommendation.label}</a>}
    </section>

    <ol class="understand-path" aria-label="Understand path">
      <li class={productError ? 'attention' : product?.exists ? 'complete' : 'pending'}>
        <header><i aria-hidden="true">1</i><span><h2>Product intent</h2><TruthBadge kind={productError ? 'unknown' : product?.exists ? 'accepted' : 'declared'} /></span></header>
        <p>{productError ? 'Product direction is unavailable, so its existence is unknown.' : product?.exists ? productPurpose || 'An accepted product brief exists for this repository.' : productLoading ? 'Checking accepted product direction…' : 'No product brief is accepted yet. Structural evidence can still be inspected without becoming product truth.'}</p>
        <button type="button" onClick={onProduct}>{productError ? 'Review product direction' : product?.exists ? 'Review product brief' : 'Define product brief'}</button>
      </li>
      <li class={jobsError ? 'attention' : snapshotJobs.length ? snapshotStale ? 'attention' : 'complete' : activeJob ? 'working' : 'pending'}>
        <header><i aria-hidden="true">2</i><span><h2>Repository evidence</h2><TruthBadge kind={jobsError ? 'unknown' : snapshotJobs.length ? 'observed' : 'unknown'} /></span></header>
        <p>{jobsError ? 'Snapshot availability is unknown because the private job ledger could not be loaded.' : activeJob ? `${activeJob.state.replaceAll('-', ' ')} · ${activeJob.message}` : snapshotJobs.length ? `${snapshotStale ? 'Stale' : 'Current'} private snapshot from ${map?.source.analyzer.name || selectedSnapshotJob?.analyzerId || snapshotJobs[0].analyzerId}.` : jobsLoaded ? 'Analysis is optional, read-only and starts only after an exact scope review.' : 'Checking private snapshot availability…'}</p>
        <button type="button" onClick={onAnalyze}>{jobsError ? 'Review analysis status' : activeJob ? 'Open progress' : snapshotJobs.length ? 'Review or refresh analysis' : 'Preview analysis scope'}</button>
      </li>
      <li class={repository.components.length ? 'complete' : 'pending'}>
        <header><i aria-hidden="true">3</i><span><h2>Accepted work model</h2><TruthBadge kind="accepted" /></span></header>
        <p>{repository.components.length ? `${repository.components.length} accepted component${repository.components.length === 1 ? '' : 's'} own ${repository.fronts.length} front${repository.fronts.length === 1 ? '' : 's'}.` : 'No component boundary is accepted. Manual Design remains available without analysis.'}</p>
        <RouteLink className="button-link" to={designRoute} onNavigate={onNavigate}>Continue to manual Design</RouteLink>
      </li>
    </ol>

    {productError && <p class="form-error" role="alert">Product direction is unavailable: {productError}. Repository evidence remains inspectable.</p>}

    {jobsLoaded && !jobsError && !snapshotJobs.length && !busy && <section class="system-map-empty">
      <p class="section-kicker">Optional repository evidence</p>
      <h2>No repository snapshot yet</h2>
      <p>Preview a bounded read-only analysis, or continue to Design manually. Handraise never treats skipping an analyzer as permission to invent repository facts.</p>
      <div class="button-row"><button class="primary" type="button" onClick={onAnalyze}>Analyze repository</button><RouteLink className="button-link" to={designRoute} onNavigate={onNavigate}>Skip analysis</RouteLink></div>
    </section>}

    {map && <header class="system-map-heading" id="system-explanation">
      <div><p class="section-kicker">System explanation</p><h2>Derived system map</h2><p>Explore explainable hypotheses and their selected-snapshot evidence before designing component boundaries.</p></div>
    </header>}

    {map && <>
      <div class="system-map-authority" role="note"><TruthBadge kind="derived" /><span><b>Derived, not accepted truth</b><small>{map.authority.statement}</small></span></div>
      <div class="system-map-health" aria-label="Evidence health">
        <article class={snapshotStale ? 'attention' : 'current'}><span>Selected snapshot</span><strong>{snapshotStale ? 'Needs refresh' : 'Current'}</strong><small>{snapshotStale ? 'Evidence stays labeled as stale' : `Checked ${new Date(map.source.freshness.checkedAt).toLocaleString()}`}</small></article>
        <article class={coverageGaps ? 'attention' : 'current'}><span>Mapped evidence</span><strong>{coverageRatio}%</strong><small>{coverageGaps ? `${coverageGaps} coverage gap${coverageGaps === 1 ? '' : 's'} remain visible` : 'No reported coverage gaps'}</small></article>
        <article><span>Responsibility hypotheses</span><strong>{map.counts.groups.toLocaleString()}</strong><small>Each remains reviewable and non-authoritative</small></article>
      </div>

      <div class="system-map-toolbar">
        <form role="search" onSubmit={(event) => void runSearch(event)}><label><span class="sr-only">Search map</span><input value={search} placeholder="Search entities, responsibilities or source paths" onInput={(event) => setSearch(event.currentTarget.value)} /></label><button type="submit" disabled={busy}>Search</button></form>
        <div class="system-map-mode" aria-label="Map display"><button type="button" class={mode === 'map' ? 'active' : ''} aria-pressed={mode === 'map'} onClick={() => setMode('map')}>Map</button><button type="button" class={mode === 'list' ? 'active' : ''} aria-pressed={mode === 'list'} onClick={() => setMode('list')}>List</button></div>
      </div>

      <nav class="system-map-lenses" aria-label="System map lenses">
        <button type="button" class={!lens ? 'active' : ''} aria-pressed={!lens} onClick={() => void chooseLens('')}>All</button>
        {map.lenses.map((item) => <button type="button" key={item.id} class={`${lens === item.id ? 'active' : ''} ${item.status}`} onClick={() => void chooseLens(item.id)} aria-pressed={lens === item.id}><span>{SYSTEM_MAP_LENS_LABELS[item.id]}</span><small>{item.status}</small></button>)}
      </nav>

      <div class="system-map-layout">
        <div class="system-map-results">
          <p class="sr-only" role="status">{busy ? 'Updating system map results.' : `${allGroups.length} responsibility hypotheses shown.`}</p>
          {result?.truncated && <p class="system-map-budget-note">This result reached a display budget. Refine the lens or search; the server did not send an unbounded graph.</p>}
          {result && result.entities.length > 0 && <div class="system-map-entity-hits" aria-label="Matching observed entities"><span>Observed matches</span>{result.entities.slice(0, 40).map((entity) => <button type="button" data-map-id={entity.id} key={entity.id} onClick={(event) => void openEntity(entity.id, 'entity', event.currentTarget)}><b>{entity.name}</b><small>{entity.kind}{entity.location?.path ? ` · ${entity.location.path}` : ''}</small></button>)}</div>}
          {mode === 'map' ? <ul class="system-map-canvas" aria-label="Derived groups">
            {displayedGroups.map((group) => <li key={group.id}><button type="button" data-map-id={group.id} class={`system-map-node ${selection?.id === group.id ? 'selected' : ''}`} onClick={(event) => void openGroup(group.id, event.currentTarget)}>
              <span><i class={group.uncertainty.level} aria-hidden="true" /><small>{SYSTEM_MAP_LENS_LABELS[group.lens]} · {PROVENANCE_LABELS[group.provenance]}</small></span><strong>{group.name}</strong><p>{group.summary}</p><footer><b>{group.evidenceIds.length} evidence</b><em>{group.uncertainty.level} uncertainty</em></footer>
            </button></li>)}
          </ul> : <ul class="system-map-list" aria-label="Derived groups">
            {displayedGroups.map((group) => <li key={group.id}><button type="button" data-map-id={group.id} class={selection?.id === group.id ? 'selected' : ''} onClick={(event) => void openGroup(group.id, event.currentTarget)}><span><small>{SYSTEM_MAP_LENS_LABELS[group.lens]} · {PROVENANCE_LABELS[group.provenance]}</small><b>{group.name}</b><p>{group.summary}</p></span><dl><div><dt>Entities</dt><dd>{group.memberEntityIds.length}</dd></div><div><dt>Evidence</dt><dd>{group.evidenceIds.length}</dd></div><div><dt>Uncertainty</dt><dd>{group.uncertainty.level}</dd></div></dl></button></li>)}
          </ul>}
          {!busy && displayedGroups.length === 0 && <div class="empty-state">No derived groups match this lens or search. Missing capability is not interpreted as an empty architecture.</div>}
          {allGroups.length > displayedGroups.length && <button class="system-map-more" type="button" onClick={() => setVisibleGroupLimit((value) => value + 48)}>Show 48 more hypotheses</button>}
        </div>

        <aside ref={detailRef} tabIndex={-1} class={`system-map-detail ${selection ? 'has-selection' : 'empty'}`} aria-label="Map detail">
          {selection && <button class="system-map-back" type="button" onClick={returnToResults}>← Back to results</button>}
          {!selection && <div class="system-map-detail-empty"><b>Select a hypothesis</b><p>Inspect its rationale, uncertainty, members and exact evidence before using it to design work.</p></div>}
          {activeGroup && <>
            <header><p class="section-kicker">{SYSTEM_MAP_LENS_LABELS[activeGroup.lens]}</p><h3>{activeGroup.name}</h3><div class="system-map-detail-truth"><ProvenanceBadge kind={activeGroup.provenance} /><span class={`planning-uncertainty ${activeGroup.uncertainty.level}`}>{activeGroup.uncertainty.level} uncertainty</span></div></header>
            <p>{activeGroup.summary}</p>
            <section><h4>Why this grouping exists</h4>{activeGroup.rationale.map((item, index) => <article key={`${item.kind}-${index}`}><b>{item.kind.replaceAll('-', ' ')}</b><p>{item.summary}</p>{item.evidenceIds.length ? <button class="evidence-reference-action" type="button" onClick={() => void openEvidence(item.evidenceIds)}>Open {item.evidenceIds.length} exact evidence reference{item.evidenceIds.length === 1 ? '' : 's'}</button> : <small>No retained evidence reference for this rationale.</small>}</article>)}</section>
            {activeGroup.uncertainty.reasons.length > 0 && <section><h4>Uncertainty</h4><ul>{activeGroup.uncertainty.reasons.map((item) => <li key={item}>{item}</li>)}</ul></section>}
            {activeGroup.alternatives.length > 0 && <section><h4>Alternatives to review</h4><ul>{activeGroup.alternatives.map((item) => <li key={item.summary}>{item.summary}</li>)}</ul></section>}
            <section><h4>Members ({detail?.entities.length || 0})</h4><div class="system-map-member-list">{detail?.entities.map((entity) => <button type="button" data-map-id={entity.id} key={entity.id} onClick={(event) => void openEntity(entity.id, 'entity', event.currentTarget)}><span><b>{entity.name}</b><small>{entity.kind}{entity.language ? ` · ${entity.language}` : ''}</small></span><code>{entity.location?.path || 'unlocated'}</code></button>)}</div></section>
            <section><h4>Evidence in selected snapshot ({detail?.evidence.length || 0})</h4><ul class="system-map-evidence">{detail?.evidence.map((item) => <EvidenceLocation evidence={item} stale={snapshotStale} key={item.id} />)}</ul></section>
          </>}
          {activeEntity && <>
            <header><p class="section-kicker">Observed entity · {activeEntity.kind}</p><h3>{activeEntity.name}</h3><code>{activeEntity.id}</code></header>
            <div class="system-map-source-location"><b>{activeEntity.location?.path || 'No retained snapshot location'}</b>{activeEntity.location?.range && <small>lines {activeEntity.location.range.start.line}–{activeEntity.location.range.end.line}</small>}<small>Location in the selected {snapshotStale ? 'stale ' : ''}snapshot</small></div>
            <div class="button-row"><button type="button" onClick={(event) => void openEntity(activeEntity.id, 'neighbors', event.currentTarget)}>Neighborhood</button><button type="button" onClick={(event) => void openEntity(activeEntity.id, 'reverse-dependencies', event.currentTarget)}>Reverse dependencies</button></div>
            <section><h4>Relations ({detail?.relations.length || 0})</h4><ul class="system-map-relations">{detail?.relations.map((relation) => {
              const otherId = relation.source === activeEntity.id ? relation.target : relation.source;
              const other = entityById.get(otherId);
              return <li key={relation.id}><span><b>{relation.kind}</b><small>{relation.source === activeEntity.id ? 'outgoing' : 'incoming'}{relation.confidence !== undefined ? ` · ${Math.round(relation.confidence * 100)}%` : ''}</small>{relation.evidenceIds.length > 0 && <button class="evidence-reference-action" type="button" onClick={() => void openEvidence(relation.evidenceIds)}>{relation.evidenceIds.length} evidence</button>}</span><button type="button" onClick={(event) => void openEntity(otherId, 'entity', event.currentTarget)}>{other?.name || otherId}</button></li>;
            })}</ul></section>
            <section><h4>Evidence in selected snapshot ({detail?.evidence.length || 0})</h4><ul class="system-map-evidence">{detail?.evidence.map((item) => <EvidenceLocation evidence={item} stale={snapshotStale} key={item.id} />)}</ul></section>
          </>}
          {focusedEvidence.length > 0 && <section class="system-map-focused-evidence"><header><h4>Opened evidence references</h4><button type="button" onClick={() => setFocusedEvidence([])}>Close</button></header><ul class="system-map-evidence">{focusedEvidence.map((item) => <EvidenceLocation evidence={item} stale={snapshotStale} key={item.id} />)}</ul></section>}
        </aside>
      </div>

      <details class="system-map-inspection">
        <summary><span><b>Analysis and snapshot details</b><small>Scope, analyzer, IDs, coverage, diagnostics, export and explicit comparison.</small></span><strong>Inspect</strong></summary>
        <div class="system-map-inspection-body">
          <div class="system-map-heading-actions">
            <label><span>Selected snapshot</span><select value={jobId} disabled={busy} onChange={(event) => chooseSnapshot(event.currentTarget.value)}>{snapshotJobs.map((item) => <option value={item.id} key={item.id}>{item.analyzerId} · {item.state} · {item.snapshotId?.slice(0, 10)}</option>)}</select></label>
            <button type="button" onClick={onAnalyze}>New analysis</button>
            <button type="button" disabled={busy || !map} onClick={() => void download('markdown')}>Export report</button>
          </div>
          <div class="system-map-technical-identity"><span><b>Selected private result</b><small>{map.source.analyzer.name} · {map.source.analyzer.version} · {map.source.snapshotStatus} snapshot</small></span><code>map {map.id} · snapshot {map.snapshotId}</code></div>
          <div class="system-map-stats" aria-label="Technical map counts">
            <article><span>Entities</span><strong>{map.counts.entities.toLocaleString()}</strong><small>{map.coverage.mappedEntities.toLocaleString()} grouped</small></article>
            <article><span>Relations</span><strong>{map.counts.relations.toLocaleString()}</strong><small>{map.source.analyzer.name}</small></article>
            <article><span>Evidence</span><strong>{map.counts.evidence.toLocaleString()}</strong><small>selected snapshot references</small></article>
            <article class={snapshotStale ? 'stale' : 'current'}><span>Snapshot</span><strong>{map.source.freshness.state}</strong><small>{map.source.snapshotStatus} coverage</small></article>
          </div>
          <div class="system-map-lower-grid">
            <details class="system-map-coverage"><summary>Coverage and gaps ({map.coverage.subjects.length})</summary><ul>{map.coverage.subjects.map((item) => <li class={item.status} key={item.id}><span><b>{item.subject}</b><small>{item.summary}</small></span><strong>{item.status}</strong></li>)}</ul></details>
            <details class="system-map-diagnostics"><summary>Raw diagnostics ({map.diagnostics.length})</summary><ul>{map.diagnostics.map((item, index) => <li class={item.severity} key={`${item.code}-${index}`}><b>{item.code}</b><span>{item.message}</span>{item.path && <code>{item.path}</code>}</li>)}</ul></details>
            <section class="system-map-compare"><header><span><b>Compare snapshots</b><small>This creates a private drift review. It never edits an accepted contract.</small></span></header><div><select value={compareJobId} onChange={(event) => setCompareJobId(event.currentTarget.value)}><option value="">Choose earlier snapshot</option>{earlierSnapshotJobs.map((item) => <option value={item.id} key={item.id}>{item.analyzerId} · {item.snapshotId?.slice(0, 10)}</option>)}</select><button type="button" disabled={busy || !comparisonReady} onClick={() => void compare()}>Compare and create drift review</button></div>{comparison && <article class={comparison.noChange ? 'no-change' : 'changed'}><b>{comparison.noChange ? 'No derived change' : comparison.causes.join(' · ')}</b><p>{comparison.content.added.length} files added · {comparison.content.removed.length} removed · {comparison.content.changed.length} changed · {comparison.content.moved.length} moved</p><small>{comparison.observed.entities.added.length + comparison.observed.entities.removed.length + comparison.observed.entities.changed.length} entity changes · {comparison.inference.added.length + comparison.inference.removed.length + comparison.inference.changed.length} inference changes{reconciliationCycle ? ` · ${reconciliationCycle.summary.findings} planning findings` : ''}</small></article>}</section>
          </div>
        </div>
      </details>
      <details class="understand-secondary reconciliation" id="reconciliation" open={criticalDrift > 0}>
        <summary><span><b>Review architecture drift</b><small>{criticalDrift ? `${criticalDrift} high-priority finding${criticalDrift === 1 ? '' : 's'} need attention.` : 'Compare snapshots and route reviewed findings into planning.'}</small></span><strong>{criticalDrift ? 'Needs attention' : 'Open'}</strong></summary>
        <ReconciliationPanel repository={repository} refreshToken={reconciliationRefresh} onAnalyze={onAnalyze} />
      </details>
      <details class="understand-secondary learning">
        <summary><span><b>Review outcome learning</b><small>Private proposals from accepted outcomes; zero automatic contract mutation.</small></span><strong>Open</strong></summary>
        <LearningPanel repository={repository} refreshToken={reconciliationRefresh} onOpenDraft={onOpenLearningDraft} />
      </details>
    </>}
    {busy && <div class="system-map-loading" role="status"><i aria-hidden="true" /><span>Deriving a bounded map from the immutable snapshot…</span></div>}
    {error && <p class="form-error" role="alert">{error}</p>}
  </section>;
}

function productItemSlug(prefix: string, value: string, index: number): string {
  const slug = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 54) || 'item';
  return `${prefix}:${slug}${index ? `-${index + 1}` : ''}`;
}

function productLines(value: string): string[] {
  return value.split('\n').map((line) => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
}

function productStatements(value: string, current: ProductStatement[], prefix: string): ProductStatement[] {
  const used = new Set<string>();
  return productLines(value).map((text, index) => {
    const exact = current.find((item) => !used.has(item.id) && item.text === text);
    const positional = current[index] && !used.has(current[index].id) ? current[index] : null;
    const previous = exact || positional;
    let id = previous?.id || productItemSlug(prefix, text, index);
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return {
      id, text,
      sourceIds: previous?.sourceIds || ['source:human'],
      locked: previous?.locked || false,
      order: index + 1,
    };
  });
}

function productGlossary(value: string, current: ProductBrief['glossary']): ProductBrief['glossary'] {
  const used = new Set<string>();
  return productLines(value).flatMap((line, index) => {
    const [term, ...definition] = line.split(/\s+[—–-]\s+/);
    if (!term?.trim() || !definition.join(' — ').trim()) return [];
    const previous = current.find((item) => item.term.toLocaleLowerCase() === term.trim().toLocaleLowerCase()) || current[index];
    let id = previous?.id || productItemSlug('term', term, index);
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return [{
      id, term: term.trim(), definition: definition.join(' — ').trim(), aliases: previous?.aliases || [],
      sourceIds: previous?.sourceIds || ['source:human'], locked: previous?.locked || false, order: index + 1,
    }];
  });
}

function ProductBriefDialog({
  state, onDraft, onCancel, onAccepted,
}: {
  state: ProductDialogState;
  onDraft: (draft: ProductDraft) => void;
  onCancel: () => void;
  onAccepted: () => Promise<void>;
}) {
  const draft = state.draft;
  const [title, setTitle] = useState(draft?.brief.title || state.repositoryName);
  const [stage, setStage] = useState(draft?.brief.stage || 'unspecified');
  const [purpose, setPurpose] = useState(draft?.brief.purpose.text || '');
  const [purposeLocked, setPurposeLocked] = useState(Boolean(draft?.brief.purpose.locked));
  const [users, setUsers] = useState((draft?.brief.users || []).map((item) => item.text).join('\n'));
  const [outcomes, setOutcomes] = useState((draft?.brief.outcomes || []).map((item) => item.text).join('\n'));
  const [constraints, setConstraints] = useState((draft?.brief.constraints || []).map((item) => item.text).join('\n'));
  const [invariants, setInvariants] = useState((draft?.brief.invariants || []).map((item) => item.text).join('\n'));
  const [nonGoals, setNonGoals] = useState((draft?.brief.nonGoals || []).map((item) => item.text).join('\n'));
  const [glossary, setGlossary] = useState((draft?.brief.glossary || []).map((item) => `${item.term} — ${item.definition}`).join('\n'));
  const [assumptions, setAssumptions] = useState((draft?.brief.assumptions || []).map((item) => item.text).join('\n'));
  const [goals, setGoals] = useState<ProductGoal[]>(draft?.brief.goals || []);
  const [conflicts, setConflicts] = useState<ProductBrief['conflicts']>(draft?.brief.conflicts || []);
  const [importPaths, setImportPaths] = useState('');
  const [preview, setPreview] = useState<ProductPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!state.draft) return;
    const brief = state.draft.brief;
    setTitle(brief.title);
    setStage(brief.stage);
    setPurpose(brief.purpose.text);
    setPurposeLocked(brief.purpose.locked);
    setUsers(brief.users.map((item) => item.text).join('\n'));
    setOutcomes(brief.outcomes.map((item) => item.text).join('\n'));
    setConstraints(brief.constraints.map((item) => item.text).join('\n'));
    setInvariants(brief.invariants.map((item) => item.text).join('\n'));
    setNonGoals(brief.nonGoals.map((item) => item.text).join('\n'));
    setGlossary(brief.glossary.map((item) => `${item.term} — ${item.definition}`).join('\n'));
    setAssumptions(brief.assumptions.map((item) => item.text).join('\n'));
    setGoals(brief.goals);
    setConflicts(brief.conflicts);
  }, [state.draft?.updatedAt]);

  const buildBrief = (): ProductBrief => {
    if (!draft) throw new Error('The product draft is not ready yet.');
    return {
      ...draft.brief,
      title: title.trim() || state.repositoryName,
      stage: stage.trim() || 'unspecified',
      purpose: { ...draft.brief.purpose, text: purpose.trim(), locked: purposeLocked },
      users: productStatements(users, draft.brief.users, 'user'),
      outcomes: productStatements(outcomes, draft.brief.outcomes, 'outcome'),
      constraints: productStatements(constraints, draft.brief.constraints, 'constraint'),
      invariants: productStatements(invariants, draft.brief.invariants, 'invariant'),
      nonGoals: productStatements(nonGoals, draft.brief.nonGoals, 'non-goal'),
      glossary: productGlossary(glossary, draft.brief.glossary),
      assumptions: productStatements(assumptions, draft.brief.assumptions, 'assumption'),
      goals: goals.map((goal, index) => ({ ...goal, order: index + 1 })),
      conflicts,
    };
  };

  const persist = async () => {
    if (!draft) throw new Error('The product draft is not ready yet.');
    const next = buildBrief();
    const changedLockedPurpose = draft.brief.purpose.locked
      && (next.purpose.text !== draft.brief.purpose.text || !next.purpose.locked);
    if (changedLockedPurpose && purposeLocked) {
      throw new Error('Uncheck “Protect this purpose” before changing the locked purpose, save, then lock it again if needed.');
    }
    const result = await api<{ draft: ProductDraft }>(`/api/repositories/${state.repositoryId}/product/drafts/${encodeURIComponent(draft.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ brief: next, unlockIds: changedLockedPurpose ? ['purpose'] : [] }),
    });
    onDraft(result.draft);
    return result.draft;
  };

  const run = async (operation: () => Promise<void>) => {
    setSaving(true);
    setLocalError('');
    try { await operation(); }
    catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const saveAndClose = () => run(async () => { await persist(); onCancel(); });
  const importDocuments = () => run(async () => {
    const saved = await persist();
    const paths = productLines(importPaths);
    if (!paths.length) throw new Error('Enter at least one repository-relative Markdown path.');
    const planned = await api<{ preview: { documents: Array<{ path: string; bytes: number }>; totalBytes: number; repositoryMutation: false } }>(`/api/repositories/${state.repositoryId}/product/drafts/${encodeURIComponent(saved.id)}/import-preview`, {
      method: 'POST', body: JSON.stringify({ paths }),
    });
    const scope = planned.preview.documents.map((document) => `${document.path} (${document.bytes.toLocaleString()} bytes)`).join('\n');
    if (!window.confirm(`Import only these selected Markdown documents into the private draft?\n\n${scope}\n\nTotal: ${planned.preview.totalBytes.toLocaleString()} bytes. Repository mutation: none.`)) return;
    const result = await api<{ draft: ProductDraft }>(`/api/repositories/${state.repositoryId}/product/drafts/${encodeURIComponent(saved.id)}/import`, {
      method: 'POST', body: JSON.stringify({ paths }),
    });
    onDraft(result.draft);
    setImportPaths('');
    setPreview(null);
  });
  const reviewDiff = () => run(async () => {
    const saved = await persist();
    const result = await api<{ preview: ProductPreview }>(`/api/repositories/${state.repositoryId}/product/drafts/${encodeURIComponent(saved.id)}/preview`);
    setPreview(result.preview);
  });
  const accept = () => run(async () => {
    const saved = await persist();
    const result = await api<{ preview: ProductPreview }>(`/api/repositories/${state.repositoryId}/product/drafts/${encodeURIComponent(saved.id)}/preview`);
    setPreview(result.preview);
    if (result.preview.stale) throw new Error('product.md changed since this draft began. Reopen the brief and review a fresh baseline.');
    if (!result.preview.canAccept) throw new Error(state.repositoryAdapter === 'director'
      ? 'This Director repository does not expose a validated product-brief writer yet. Keep the private draft; Handraise will not edit Director Markdown directly.'
      : 'This repository is not initialized yet. Save the draft, run component discovery or initialize it, then reopen this brief to accept it.');
    if (!window.confirm(`Accept this product brief into ${state.repositoryName}? This writes the reviewed product.md shown in the preview.`)) return;
    await api(`/api/repositories/${state.repositoryId}/product/drafts/${encodeURIComponent(saved.id)}/accept`, { method: 'POST', body: '{}' });
    await onAccepted();
  });
  const discard = () => run(async () => {
    if (!draft || !window.confirm('Discard this private draft? The accepted product brief, if any, will not change.')) return;
    await api(`/api/repositories/${state.repositoryId}/product/drafts/${encodeURIComponent(draft.id)}`, { method: 'DELETE', body: '{}' });
    onCancel();
  });

  const busy = saving || state.loading;
  return (
    <div class="component-name-backdrop product-brief-backdrop" role="presentation">
      <section class="component-name-dialog product-brief-dialog" role="dialog" aria-modal="true" aria-labelledby="product-brief-title">
        <header>
          <div><p class="section-kicker">Declared product truth</p><h2 id="product-brief-title">Product brief for {state.repositoryName}</h2></div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>
        <p class="component-name-help">Code can show what exists, not what the product should become. This private draft changes no repository file until you review and explicitly accept its Markdown.</p>

        {state.loading && !draft && <div class="discovery-loading" role="status"><i aria-hidden="true" /><span>Loading the private product workspace…</span></div>}
        {draft && <>
          <div class={`product-draft-status ${draft.stale ? 'stale' : ''}`}>
            <span><strong>{draft.acceptedExists ? 'Editing accepted direction' : 'Draft only'}</strong><small>Private draft · expires {new Date(draft.expiresAt).toLocaleDateString()}</small></span>
            <b>{draft.stale ? 'Baseline changed' : draft.canAccept ? 'Ready to review' : state.repositoryAdapter === 'director' ? 'Director read-only' : 'Save before initialization'}</b>
          </div>

          {draft.questions.length > 0 && <section class="product-questions"><p class="section-kicker">Missing context</p><ul>{draft.questions.map((question) => <li key={question.id}>{question.question}</li>)}</ul></section>}

          <div class="product-core-fields">
            <label><span>Product name</span><input value={title} disabled={busy} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
            <label><span>Current stage</span><input value={stage} disabled={busy} placeholder="idea, private beta, public preview…" onInput={(event) => setStage(event.currentTarget.value)} /></label>
          </div>
          <label class="product-purpose"><span>Purpose</span><textarea rows={4} value={purpose} disabled={busy} placeholder="What should this product make possible, and for whom?" onInput={(event) => setPurpose(event.currentTarget.value)} /></label>
          <label class="product-lock-row"><input type="checkbox" checked={purposeLocked} disabled={busy} onChange={(event) => setPurposeLocked(event.currentTarget.checked)} /><span><b>Protect this purpose</b><small>Imports and regeneration must preserve it until you explicitly unlock it.</small></span></label>

          <div class="product-list-grid">
            <label><span>Users and jobs · one per line</span><textarea rows={5} value={users} disabled={busy} onInput={(event) => setUsers(event.currentTarget.value)} /></label>
            <label><span>Desired outcomes · one per line</span><textarea rows={5} value={outcomes} disabled={busy} onInput={(event) => setOutcomes(event.currentTarget.value)} /></label>
            <label><span>Constraints · one per line</span><textarea rows={5} value={constraints} disabled={busy} onInput={(event) => setConstraints(event.currentTarget.value)} /></label>
            <label><span>Invariants · one per line</span><textarea rows={5} value={invariants} disabled={busy} onInput={(event) => setInvariants(event.currentTarget.value)} /></label>
            <label><span>Non-goals · one per line</span><textarea rows={5} value={nonGoals} disabled={busy} onInput={(event) => setNonGoals(event.currentTarget.value)} /></label>
            <label><span>Glossary · Term — definition</span><textarea rows={5} value={glossary} disabled={busy} onInput={(event) => setGlossary(event.currentTarget.value)} /></label>
          </div>

          <section class="product-goals">
            <div class="product-section-heading"><span><p class="section-kicker">Current product goals</p><small>Goals later become dependency-aware fronts.</small></span><button type="button" disabled={busy} onClick={() => setGoals((current) => [...current, {
              id: productItemSlug('goal', 'new goal', current.length), title: 'New goal', outcome: '', priority: 'unspecified', horizon: '', state: 'proposed',
              successSignals: [], constraintIds: [], repositoryIds: [state.repositoryId], sourceIds: ['source:human'], locked: false, order: current.length + 1,
            }])}>Add goal</button></div>
            <div class="product-goal-list">{goals.map((goal, index) => <article key={goal.id}>
              <div class="product-goal-main"><label><span>Goal</span><input value={goal.title} disabled={busy} onInput={(event) => setGoals((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.currentTarget.value } : item))} /></label><label><span>Observable outcome</span><textarea rows={2} value={goal.outcome} disabled={busy} onInput={(event) => setGoals((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, outcome: event.currentTarget.value } : item))} /></label></div>
              <div class="product-goal-meta"><label><span>Priority</span><select value={goal.priority} disabled={busy} onChange={(event) => setGoals((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, priority: event.currentTarget.value as ProductGoal['priority'] } : item))}><option value="unspecified">Unspecified</option><option value="now">Now</option><option value="next">Next</option><option value="later">Later</option></select></label><label><span>Horizon</span><input value={goal.horizon} disabled={busy} onInput={(event) => setGoals((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, horizon: event.currentTarget.value } : item))} /></label><label><span>Success signals · one per line</span><textarea rows={2} value={goal.successSignals.join('\n')} disabled={busy} onInput={(event) => setGoals((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, successSignals: productLines(event.currentTarget.value) } : item))} /></label></div>
              <button class="danger" type="button" disabled={busy} onClick={() => setGoals((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove goal</button>
            </article>)}</div>
          </section>

          <details class="product-advanced"><summary>Assumptions, sources and document import</summary><div>
            <label><span>Assumptions or open questions · one per line</span><textarea rows={4} value={assumptions} disabled={busy} onInput={(event) => setAssumptions(event.currentTarget.value)} /></label>
            <section class="product-import"><label><span>Repository-relative Markdown paths · one per line</span><textarea rows={3} value={importPaths} disabled={busy} placeholder={'docs/product.md\nREADME.md'} onInput={(event) => setImportPaths(event.currentTarget.value)} /></label><button type="button" disabled={busy || !importPaths.trim()} onClick={() => void importDocuments()}>Import selected documents</button></section>
            <section class="product-sources"><p class="section-kicker">Attributed sources</p>{draft.brief.sources.length ? <ul>{draft.brief.sources.map((source) => {
              const sourceState = draft.sourceStates.find((item) => item.sourceId === source.id);
              return <li class={sourceState?.status || 'unknown'} key={source.id}><span><b>{source.label}</b><small>{source.kind}{source.path ? ` · ${source.path}` : ''}{sourceState?.reason ? ` · ${sourceState.reason}` : ''}</small></span><code>{sourceState?.status || 'unknown'}</code></li>;
            })}</ul> : <p>No sources yet.</p>}</section>
          </div></details>

          {conflicts.length > 0 && <section class="product-conflicts"><p class="section-kicker">Conflicts to resolve</p>{conflicts.map((conflict, index) => <article key={conflict.id}><strong>{conflict.summary}</strong><div><label><span>Status</span><select value={conflict.state} disabled={busy} onChange={(event) => setConflicts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, state: event.currentTarget.value as 'open' | 'resolved' | 'dismissed' } : item))}><option value="open">Open</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select></label><label><span>Resolution / rationale</span><input value={conflict.answer} disabled={busy} onInput={(event) => setConflicts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, answer: event.currentTarget.value } : item))} /></label></div></article>)}</section>}

          {preview && <details class="product-preview" open><summary>Exact Markdown publication preview</summary><div class="product-preview-grid"><section><p class="section-kicker">Current product.md</p><pre>{preview.before || 'No accepted product.md yet.'}</pre></section><section><p class="section-kicker">Proposed product.md</p><pre>{preview.after}</pre></section></div>{preview.stale && <p class="form-error">The baseline changed. This preview cannot be accepted.</p>}</details>}
        </>}

        {(state.error || localError) && <p class="form-error" role="alert">{localError || state.error}</p>}
        <footer class="discovery-footer product-brief-footer">
          {draft && <button class="danger" type="button" disabled={busy} onClick={() => void discard()}>Discard draft</button>}
          <span />
          <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          {draft && <button type="button" disabled={busy} onClick={() => void saveAndClose()}>{saving ? 'Saving…' : 'Save draft'}</button>}
          {draft && <button type="button" disabled={busy} onClick={() => void reviewDiff()}>Review Markdown</button>}
          {draft && <button class="primary" type="button" disabled={busy || draft.stale} onClick={() => void (draft.canAccept ? accept() : saveAndClose())}>{saving ? 'Working…' : draft.canAccept ? 'Accept product brief' : 'Save for later'}</button>}
        </footer>
      </section>
    </div>
  );
}

interface FrontDialogState {
  componentSlug: string;
  front?: Front;
}

interface FrontDraft {
  title: string;
  outcome: string;
  context: string;
  handoff: string;
  tasks: Array<{ state: 'open' | 'done' | 'skipped'; text: string }>;
  impact: string;
  complexity: string;
  state: FrontState;
}

function FrontDialog({
  state, onCancel, onSubmit,
}: {
  state: FrontDialogState;
  onCancel: () => void;
  onSubmit: (draft: FrontDraft) => Promise<void>;
}) {
  const editing = state.front;
  const [title, setTitle] = useState(editing?.title || '');
  const [outcome, setOutcome] = useState(editing?.outcome || '');
  const [context, setContext] = useState(editing?.context || '');
  const [handoff, setHandoff] = useState(editing?.handoff || '');
  const [taskText, setTaskText] = useState((editing?.tasks || []).map((task) => `${task.state === 'done' ? '[x]' : task.state === 'skipped' ? '[~]' : '[ ]'} ${task.text}`).join('\n'));
  const [impact, setImpact] = useState(editing?.impact || 'medio');
  const [complexity, setComplexity] = useState(editing?.complexity || 'media');
  const [frontState, setFrontState] = useState<FrontState>(editing?.state || 'queued');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    if (!title.trim()) { setError('Enter a front name.'); return; }
    if (!outcome.trim()) { setError('Describe the observable outcome.'); return; }
    if (context.trim().length < 20) { setError('Add enough confirmed context (at least 20 characters).'); return; }
    if (!handoff.trim()) { setError('Write the handoff an agent should read first.'); return; }
    const tasks = taskText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => ({
      state: /^\[x\]/i.test(line) ? 'done' as const : /^\[~\]/.test(line) ? 'skipped' as const : 'open' as const,
      text: line.replace(/^\[[ x~]\]\s*/i, '').replace(/^[-*]\s+/, '').trim(),
    })).filter((task) => task.text);
    if (!tasks.length) { setError('Add at least one checklist item.'); return; }
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        title: title.trim(), outcome: outcome.trim(), context: context.trim(), handoff: handoff.trim(),
        tasks, impact, complexity, state: frontState,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  return (
    <div class="component-name-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onCancel();
    }}>
      <section class="component-name-dialog" role="dialog" aria-modal="true" aria-labelledby="front-dialog-title">
        <header>
          <div>
            <p class="section-kicker">{editing ? 'Edit front' : 'New front'} · {state.componentSlug}</p>
            <h2 id="front-dialog-title">{editing ? 'Update the executable plan' : 'Create an executable front'}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onCancel} disabled={saving}>×</button>
        </header>
        <p class="component-name-help">Capture the result, known context and ordered work before an agent starts.</p>
        <label><span>Front name</span><input ref={inputRef} value={title} disabled={saving} placeholder="e.g. Add remote pairing" onInput={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); if (event.key === 'Escape' && !saving) onCancel(); }} /></label>
        <label><span>Observable outcome</span><textarea value={outcome} disabled={saving} placeholder="What will be visibly true when this closes?" rows={2} onInput={(event) => setOutcome(event.currentTarget.value)} /></label>
        <label><span>Confirmed context</span><textarea value={context} disabled={saving} placeholder="Evidence, scope, non-scope and dependencies already confirmed." rows={4} onInput={(event) => setContext(event.currentTarget.value)} /></label>
        <label><span>Handoff</span><textarea value={handoff} disabled={saving} placeholder="Where should the next agent begin, and what must it preserve?" rows={4} onInput={(event) => setHandoff(event.currentTarget.value)} /></label>
        <label><span>Checklist · one item per line</span><textarea value={taskText} disabled={saving} placeholder={'[ ] First verifiable step\n[ ] Second verifiable step'} rows={5} onInput={(event) => setTaskText(event.currentTarget.value)} /></label>
        <div class="front-dialog-selects">
          <label><span>Impact</span><select value={impact} disabled={saving} onChange={(event) => setImpact(event.currentTarget.value)}><option value="alto">High</option><option value="medio">Medium</option><option value="bajo">Low</option></select></label>
          <label><span>Complexity</span><select value={complexity} disabled={saving} onChange={(event) => setComplexity(event.currentTarget.value)}><option value="alta">High</option><option value="media">Medium</option><option value="baja">Low</option></select></label>
          {editing && <label><span>State</span><select value={frontState} disabled={saving} onChange={(event) => setFrontState(event.currentTarget.value as FrontState)}>{(['queued', 'active', 'blocked', 'paused', 'done'] as FrontState[]).map((value) => <option value={value}>{FRONT_LABEL[value]}</option>)}</select></label>}
        </div>
        {error && <p class="form-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={onCancel} disabled={saving}>Cancel</button><button class="primary" type="button" onClick={() => void submit()} disabled={saving || !title.trim() || !outcome.trim() || !context.trim() || !handoff.trim() || !taskText.trim()}>{saving ? 'Saving…' : editing ? 'Save front' : 'Create front'}</button></footer>
      </section>
    </div>
  );
}

interface SessionDialogState {
  slug: string;
  component: string;
  front: string;
  isolate: boolean;
}

interface SessionDraft extends SessionDialogState {
  agent: string;
  model: string;
  effort: string;
}

function SessionStartDialog({
  state, repository, settings, onCancel, onSubmit,
}: {
  state: SessionDialogState;
  repository: Repository;
  settings: Settings | null;
  onCancel: () => void;
  onSubmit: (draft: SessionDraft) => Promise<void>;
}) {
  const enabledAgents = Object.entries(settings?.agents || {}).filter(([, value]) => value.enabled);
  const initialAgent = enabledAgents.some(([id]) => id === repository.defaultAgent)
    ? repository.defaultAgent || enabledAgents[0]?.[0] || ''
    : enabledAgents[0]?.[0] || '';
  const [slug, setSlug] = useState(state.slug);
  const [component, setComponent] = useState(state.component);
  const [front, setFront] = useState(state.front);
  const [isolate, setIsolate] = useState(state.isolate);
  const [agent, setAgent] = useState(initialAgent);
  const [model, setModel] = useState(repository.model || settings?.agents[initialAgent]?.model || '');
  const [effort, setEffort] = useState(repository.effort || settings?.agents[initialAgent]?.effort || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const fronts = repository.fronts.filter((item) => !component || item.component === component);
  const selectedAgent = settings?.agents[agent] || null;

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const submit = async () => {
    const cleanSlug = slug.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(cleanSlug)) {
      setError('Use 1–64 letters, numbers, dots, underscores or hyphens for the session name.');
      return;
    }
    if (!agent) { setError('Enable an agent in Settings first.'); return; }
    setSaving(true);
    setError('');
    try {
      await onSubmit({ slug: cleanSlug, component, front, isolate, agent, model: model.trim(), effort });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  return (
    <div class="component-name-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onCancel();
    }}>
      <section class="component-name-dialog session-start-dialog" role="dialog" aria-modal="true" aria-labelledby="session-dialog-title">
        <header>
          <div><p class="section-kicker">New session · {repository.name}</p><h2 id="session-dialog-title">Start an agent</h2></div>
          <button type="button" aria-label="Close" onClick={onCancel} disabled={saving}>×</button>
        </header>
        <p class="component-name-help">The server starts the agent in a persistent tmux pane. Closing this browser will not stop it.</p>
        <label><span>Session name</span><input ref={inputRef} value={slug} disabled={saving} placeholder="e.g. pairing-ui" onInput={(event) => setSlug(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); if (event.key === 'Escape' && !saving) onCancel(); }} /></label>
        <div class="session-dialog-grid">
          <label><span>Component</span><select value={component} disabled={saving} onChange={(event) => {
            const next = event.currentTarget.value;
            setComponent(next);
            if (front && !repository.fronts.some((item) => item.slug === front && (!next || item.component === next))) setFront('');
          }}><option value="">Unassigned</option>{repository.components.map((item) => <option value={item.slug}>{item.title}</option>)}</select></label>
          <label><span>Front</span><select value={front} disabled={saving} onChange={(event) => {
            const next = event.currentTarget.value;
            setFront(next);
            const record = repository.fronts.find((item) => item.slug === next);
            if (record) setComponent(record.component);
          }}><option value="">Unassigned</option>{fronts.map((item) => <option value={item.slug}>{item.title}</option>)}</select></label>
          <label><span>Agent</span><select value={agent} disabled={saving || !enabledAgents.length} onChange={(event) => {
            const next = event.currentTarget.value;
            setAgent(next);
            setModel(repository.model || settings?.agents[next]?.model || '');
            setEffort(repository.effort || settings?.agents[next]?.effort || '');
          }}>{enabledAgents.map(([id, value]) => <option value={id}>{value.title}</option>)}</select></label>
          <label><span>Reasoning effort</span><select value={effort} disabled={saving || !agent} onChange={(event) => setEffort(event.currentTarget.value)}><option value="">CLI default</option>{(settings?.agents[agent]?.efforts || []).map((value) => <option value={value}>{value}</option>)}</select></label>
        </div>
        <label><span>Model override</span><input value={model} disabled={saving || !agent} placeholder="Agent default" onInput={(event) => setModel(event.currentTarget.value)} /></label>
        {selectedAgent && (!selectedAgent.capabilities.configured || selectedAgent.capabilities.setup) && <div class="session-capability-warning" role="status">
          <strong>{selectedAgent.title} capability notice</strong>
          <span>{!selectedAgent.capabilities.configured
            ? 'Terminal control is available, but lifecycle attention and typed permissions will stay in the agent terminal until hooks are repaired.'
            : selectedAgent.capabilities.setup}</span>
          {!selectedAgent.capabilities.configured && <code>handraise hooks repair</code>}
        </div>}
        <label class="session-isolation"><span>Workspace</span><span class="checkbox-row"><input type="checkbox" checked={isolate} disabled={saving} onChange={(event) => setIsolate(event.currentTarget.checked)} /><b>Use an isolated Git worktree and branch</b></span><small>Recommended for fronts. The worktree survives pauses and server restarts.</small></label>
        <small class="session-cwd">Working directory: {repository.path}</small>
        {error && <p class="form-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={onCancel} disabled={saving}>Cancel</button><button class="primary" type="button" onClick={() => void submit()} disabled={saving || !slug.trim() || !agent}>{saving ? 'Starting…' : 'Start session'}</button></footer>
      </section>
    </div>
  );
}

const FRONT_LABEL: Record<FrontState, string> = {
  active: 'Active', queued: 'Queued', blocked: 'Blocked', paused: 'Paused', done: 'Done',
};

function FrontRows({ fronts, repositoryId, componentSlug, onNavigate, onDelete, canDelete = true }: { fronts: Front[]; repositoryId: string; componentSlug: string; onNavigate: (route: RouteState) => void; onDelete: (slug: string) => void; canDelete?: boolean }) {
  if (!fronts.length) return <p class="empty-state">No fronts registered in this component.</p>;
  return (
    <section class="front-list">
      {(['active', 'blocked', 'paused', 'queued', 'done'] as FrontState[]).map((state) => {
        const group = fronts.filter((front) => front.state === state);
        if (!group.length) return null;
        return (
          <section class="front-group" key={state}>
            <header><span>{FRONT_LABEL[state]}</span><b>{group.length}</b></header>
            {group.map((front) => (
              <div class={`front-row ${front.state}`} key={front.slug}>
                <i aria-hidden="true" />
                <RouteLink className="front-row-main" to={{ ...baseRoute('components'), repositoryId, componentSlug, frontSlug: front.slug }} onNavigate={onNavigate}><span class="front-main"><strong>{front.title}</strong><small>{front.slug} · {front.component}</small></span></RouteLink>
                <span class="front-priority">{front.impact && front.complexity ? `${front.impact} / ${front.complexity}` : 'unranked'}</span>
                <span class="front-progress">{front.done}/{front.total} · {front.percent}%</span>
                <button class="front-row-delete" type="button" aria-label={`Delete ${front.title}`} title={!canDelete ? 'This adapter does not expose safe front removal' : front.state === 'active' ? 'Active fronts cannot be deleted' : 'Delete front'} disabled={!canDelete || front.state === 'active'} onClick={() => onDelete(front.slug)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v6m4-6v6" /></svg></button>
              </div>
            ))}
          </section>
        );
      })}
    </section>
  );
}

function ComponentDetail({
  repository, component, onNavigate, onCreateFront, onDeleteFront, onEdit, onToggleState, onDelete, canMutate, canCreateFront, canDeleteFront,
}: {
  repository: Repository; component: Component; onNavigate: (route: RouteState) => void; onCreateFront: () => void; onDeleteFront: (slug: string) => void;
  onEdit: () => void; onToggleState: () => void; onDelete: () => void; canMutate: boolean; canCreateFront: boolean; canDeleteFront: boolean;
}) {
  const description = Object.entries(component.sections).find(([title]) => /alcance|scope|purpose/i.test(title))?.[1]
    || Object.values(component.sections).find(Boolean)
    || 'This component has no written scope yet.';
  const fronts = component.fronts.filter((front) => front.kind === 'front');
  const progress = component.progress === null ? null : Math.min(100, Math.max(0, component.progress));
  return (
    <>
      <BreadcrumbTrail onNavigate={onNavigate} items={[
        { label: repository.name, to: { ...baseRoute('overview'), repositoryId: repository.id } },
        { label: 'Design', to: { ...baseRoute('components'), repositoryId: repository.id } },
        { label: component.title },
      ]} />
      <section class="entity-hero component-detail-hero">
        <div><p class="section-kicker">Component · {component.slug} · order {component.order}</p><h1>{component.title}</h1><p class="entity-copy">{plainCopy(description)}</p>{canMutate && <details class="entity-more-actions"><summary>Component actions</summary><div class="entity-actions"><button onClick={onEdit}>Edit definition</button><button onClick={onToggleState}>{component.state === 'active' ? 'Mark closing' : 'Reopen'}</button><button class="danger" onClick={onDelete}>Remove component</button></div></details>}</div>
        <dl class="component-metrics">
          <div class="progress"><dt>Progress</dt><dd><span class="progress-ring" style={`--progress: ${progress || 0}%`}><span>{progress === null ? '—' : `${progress}%`}</span></span></dd></div>
          <div class="active"><dt>Active</dt><dd>{component.counts.active}</dd></div>
          <div class="open"><dt>Open</dt><dd>{component.counts.queued + component.counts.blocked + component.counts.paused}</dd></div>
        </dl>
      </section>
      <section class="detail-section" id="component-fronts">
        <header><div><p class="section-kicker">Work</p><h2>Fronts</h2></div><div class="detail-section-actions"><span>{fronts.length} total</span><button class="primary" type="button" onClick={onCreateFront} disabled={!canCreateFront || component.state === 'closing'} title={component.state === 'closing' ? 'Closing components do not accept new fronts' : !canCreateFront ? 'This repository does not expose a safe front-creation helper' : undefined}>New front</button></div></header>
        <FrontRows fronts={fronts} repositoryId={repository.id} componentSlug={component.slug} onNavigate={onNavigate} onDelete={onDeleteFront} canDelete={canDeleteFront} />
      </section>
    </>
  );
}

function shortRevision(value: string | null | undefined) {
  return value ? value.slice(0, 12) : 'none';
}

function RunPreflightDialog({
  launch, repository, settings, onCancel, onStarted,
}: {
  launch: RunLaunchState;
  repository: Repository;
  settings: Settings | null;
  onCancel: () => void;
  onStarted: (run: RunRecord) => Promise<void>;
}) {
  const enabledAgents = Object.entries(settings?.agents || {}).filter(([, value]) => value.enabled);
  const defaultAgent = enabledAgents.some(([id]) => id === repository.defaultAgent)
    ? repository.defaultAgent || ''
    : enabledAgents[0]?.[0] || '';
  const [agent, setAgent] = useState(defaultAgent);
  const [model, setModel] = useState(repository.model || settings?.agents[defaultAgent]?.model || '');
  const [effort, setEffort] = useState(repository.effort || settings?.agents[defaultAgent]?.effort || '');
  const [isolate, setIsolate] = useState(true);
  const [preflight, setPreflight] = useState<RunPreflight | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const resumeRun = launch.resumeRunId
    ? repository.runs.find((run) => run.id === launch.resumeRunId) || null
    : null;

  const invalidateReview = () => {
    setPreflight(null);
    setConfirmed(false);
    setError('');
  };
  const prepare = async () => {
    if (!agent) { setError('Enable and choose an agent before reviewing readiness.'); return; }
    setLoading(true);
    setError('');
    setConfirmed(false);
    try {
      const result = await api<{ preflight: RunPreflight }>(`/api/repositories/${repository.id}/runs/preflight`, {
        method: 'POST',
        body: JSON.stringify({
          frontSlug: launch.frontSlug, agent, model: model.trim(), effort, isolate,
          resumeRunId: launch.resumeRunId || null,
        }),
      });
      setPreflight(result.preflight);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoading(false); }
  };
  const start = async () => {
    if (!preflight || !confirmed || !preflight.readiness.ready) return;
    setStarting(true);
    setError('');
    try {
      const result = await api<{ run: RunRecord }>(`/api/repositories/${repository.id}/runs/preflight/${encodeURIComponent(preflight.id)}/start`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: preflight.revision, confirmed: true }),
      });
      await onStarted(result.run);
    } catch (reason) {
      const detail = reason instanceof ApiError && reason.code ? `${reason.message} (${reason.code})` : reason instanceof Error ? reason.message : String(reason);
      setError(detail);
      setConfirmed(false);
    } finally { setStarting(false); }
  };

  return <div class="component-name-backdrop run-preflight-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !starting) onCancel();
  }}>
    <section class="component-name-dialog run-preflight-dialog" role="dialog" aria-modal="true" aria-labelledby="run-preflight-title">
      <header>
        <div><p class="section-kicker">Plan-driven run · {repository.name}</p><h2 id="run-preflight-title">Review run preflight</h2></div>
        <button type="button" aria-label="Close run preflight" onClick={onCancel} disabled={starting}>×</button>
      </header>
      <p class="component-name-help">Review the exact accepted context, ownership and execution boundary. Nothing is allocated until you confirm this revision.</p>

      <div class="run-preflight-controls">
        <label><span>Agent</span><select value={agent} disabled={loading || starting || !enabledAgents.length} onChange={(event) => {
          const next = event.currentTarget.value;
          setAgent(next);
          setModel(repository.model || settings?.agents[next]?.model || '');
          setEffort(repository.effort || settings?.agents[next]?.effort || '');
          invalidateReview();
        }}>{enabledAgents.map(([id, value]) => <option value={id}>{value.title}</option>)}</select></label>
        <label><span>Model</span><input value={model} disabled={loading || starting} placeholder="Agent default" onInput={(event) => { setModel(event.currentTarget.value); invalidateReview(); }} /></label>
        <label><span>Effort</span><select value={effort} disabled={loading || starting || !agent} onChange={(event) => { setEffort(event.currentTarget.value); invalidateReview(); }}><option value="">CLI default</option>{(settings?.agents[agent]?.efforts || []).map((value) => <option value={value}>{value}</option>)}</select></label>
      </div>
      <label class="session-isolation run-isolation"><span>Workspace</span><span class="checkbox-row"><input type="checkbox" checked={isolate} disabled={loading || starting} onChange={(event) => { setIsolate(event.currentTarget.checked); invalidateReview(); }} /><b>Use an isolated Git worktree and branch</b></span><small>Recommended. The reviewed path and branch are revalidated immediately before launch.</small></label>
      {resumeRun && <div class="run-resume-source"><span><b>Resume from reviewed handoff</b><small>Run {shortRevision(resumeRun.id)} · {resumeRun.handoffs.at(-1)?.summary || 'No handoff summary'}</small></span><code>{shortRevision(resumeRun.handoffs.at(-1)?.revision)}</code></div>}

      {!preflight && <div class="run-prepare-boundary">
        <span><b>Read-only readiness review</b><small>Checks current contracts, dependencies, agent capability, active ownership, analysis freshness and Git risk.</small></span>
        <button class="primary" type="button" disabled={loading || starting || !agent} onClick={() => void prepare()}>{loading ? 'Reviewing…' : 'Review readiness'}</button>
      </div>}

      {preflight && <div class="run-preflight-review">
        <section class={`run-readiness ${preflight.readiness.ready ? 'ready' : 'blocked'}`}>
          <header><span><p class="section-kicker">Readiness</p><h3>{preflight.readiness.ready ? 'Ready for explicit start' : 'Resolve blocking conditions'}</h3></span><b>{preflight.readiness.errors} errors · {preflight.readiness.warnings} warnings</b></header>
          {preflight.readiness.diagnostics.length ? <div class="run-diagnostics">{preflight.readiness.diagnostics.map((item) => <article class={item.severity} key={`${item.code}:${item.message}`}><code>{item.code}</code><span><b>{item.message}</b><small>{item.recovery}</small></span></article>)}</div> : <p>No blocking diagnostics. Final revalidation still runs under the start boundary.</p>}
        </section>

        <div class="run-review-grid">
          <article><p class="section-kicker">Accepted source</p><strong>{preflight.front.title}</strong><small>Front {shortRevision(preflight.front.revision)}</small><small>Portfolio digest {shortRevision(preflight.source.digest)}</small><small>Product {shortRevision(preflight.source.productRevision)}</small><small>Analysis {shortRevision(preflight.source.analysisSnapshot)}</small></article>
          <article><p class="section-kicker">Execution</p><strong>{settings?.agents[preflight.execution.agent]?.title || preflight.execution.agent}</strong><small>{preflight.execution.model || 'CLI model default'} · {preflight.execution.effort || 'CLI effort default'}</small><small>{preflight.execution.isolate ? 'Isolated worktree' : 'Primary checkout'}</small><small>Preflight {shortRevision(preflight.revision)}</small></article>
          <article><p class="section-kicker">Reviewed workspace</p><strong>{preflight.workspace.branch || 'Current branch'}</strong><code>{preflight.workspace.path}</code><small>Revision {shortRevision(preflight.workspace.revision)}</small><small>Expires {new Date(preflight.expiresAt).toLocaleTimeString()}</small></article>
        </div>

        <section class="run-review-relations">
          <div><p class="section-kicker">Components and territory</p>{preflight.components.map((item) => <article key={item.slug}><span><strong>{item.title}</strong><small>{item.slug} · {shortRevision(item.revision)}</small></span><code>{item.territory.join(', ') || 'No territory declared'}</code></article>)}</div>
          <div><p class="section-kicker">Dependencies</p>{preflight.dependencies.length ? preflight.dependencies.map((item) => <article key={`${item.kind}:${item.target}`}><span><strong>{item.target}</strong><small>{item.kind} · {item.state}</small></span><small>{item.reason}</small></article>) : <p>No declared front dependencies.</p>}</div>
        </section>

        {preflight.context.explicitUnknowns.length > 0 && <section class="run-unknowns"><p class="section-kicker">Explicit unknowns and risks</p><ul>{preflight.context.explicitUnknowns.map((item) => <li>{item}</li>)}</ul></section>}
        <details class="run-exact-context"><summary>Inspect exact agent context · {formatBytes(preflight.context.bytes)}</summary><pre>{preflight.context.prompt}</pre></details>
        <label class="run-confirm"><input type="checkbox" checked={confirmed} disabled={starting || !preflight.readiness.ready} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span><b>I reviewed this exact run revision</b><small>Start may create only the workspace and agent session shown above. Contracts are revalidated first.</small></span></label>
        <div class="run-review-actions"><button type="button" disabled={starting} onClick={() => { setPreflight(null); setConfirmed(false); setError(''); }}>Change setup</button><button type="button" disabled={loading || starting} onClick={() => void prepare()}>Refresh readiness</button><button class="primary" type="button" disabled={starting || !confirmed || !preflight.readiness.ready} onClick={() => void start()}>{starting ? 'Starting exact run…' : 'Start reviewed run'}</button></div>
      </div>}
      {error && <p class="form-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onCancel} disabled={starting}>Cancel</button></footer>
    </section>
  </div>;
}

function RunPanel({
  run, front, session, onOpenSession, onReviewNewRun, onResumeRun,
  onVerifyTask, onRecordCheck, onAddDiscovery, onHandoff, onComplete,
}: {
  run: RunRecord;
  front: Front;
  session: AgentSession | null;
  onOpenSession: (session: AgentSession) => void;
  onReviewNewRun: () => void;
  onResumeRun: () => void;
  onVerifyTask: (index: number, state: 'done' | 'skipped', evidence: string) => Promise<void>;
  onRecordCheck: (kind: 'criterion' | 'verification', index: number, label: string, evidence: string) => Promise<void>;
  onAddDiscovery: (kind: RunDiscovery['kind'], summary: string, evidence: string) => Promise<void>;
  onHandoff: (summary: string, nextSteps: string[], blockers: string[]) => Promise<void>;
  onComplete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const locked = run.state === 'completed';
  const perform = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError('');
    try { await action(); } catch (reason) {
      const detail = reason instanceof ApiError && reason.code ? `${reason.message} (${reason.code})` : reason instanceof Error ? reason.message : String(reason);
      setError(detail);
    } finally { setBusy(''); }
  };
  const passed = (kind: 'criterion' | 'verification', index: number, label: string) => run.checks.some((item) => item.kind === kind && item.index === index && item.label === label && item.status === 'passed' && item.source !== 'agent-claim');
  const evidenceCount = run.taskEvidence.filter((item) => item.applied).length + run.checks.filter((item) => item.status === 'passed' && item.source !== 'agent-claim').length;
  const handoff = run.handoffs.at(-1) || null;
  const canAttemptCompletion = !run.process.active && front.tasks.every((task) => task.state !== 'open')
    && front.acceptanceCriteria.every((label, index) => passed('criterion', index, label))
    && front.verification.every((label, index) => passed('verification', index, label));

  return <section class="run-panel" id="front-run" aria-label="Plan-driven run">
    <header class="run-panel-heading"><div><p class="section-kicker">Auditable run · {shortRevision(run.id)}</p><h2>{run.state === 'completed' ? 'Accepted outcome' : 'Execution and evidence'}</h2></div><span class={`run-state ${run.state}`}>{run.state.replaceAll('-', ' ')}</span></header>
    <div class="run-process-grid">
      <article><span>Agent process</span><strong>{run.process.active ? run.process.state : 'not running'}</strong><small>{run.process.attention?.reason || (run.process.active ? 'Live process state; not completion evidence.' : 'No active process owns this run.')}</small></article>
      <article><span>Verified evidence</span><strong>{evidenceCount}</strong><small>Agent claims remain separate and non-authoritative. <TruthBadge kind="agent-claim" /></small></article>
    </div>
    <details class="run-technical-details"><summary>Manifest and workspace identity</summary><div class="run-technical-grid"><article><span>Immutable manifest</span><strong>{shortRevision(run.manifest.revision)}</strong><small>Front source {shortRevision(run.manifest.front.revision)}</small></article><article><span>Workspace</span><strong>{run.manifest.workspace.branch || 'Primary checkout'}</strong><small>{run.manifest.workspace.path}</small></article></div></details>
    {run.failure && <p class="form-error">{run.failure.message} ({run.failure.code})</p>}
    {run.process.attention && <div class="run-attention"><b>{run.process.attention.status}</b><span>{run.process.attention.reason || 'The agent needs review in its terminal.'}</span></div>}
    {!locked && session && <div class="run-primary-action"><span><b>{session.slug}</b><small>{STATUS_LABEL[session.status]} · live process for this run</small></span><button class="primary" type="button" onClick={() => onOpenSession(session)}>Open agent session</button></div>}

    <details class="run-evidence-details" open={run.state === 'awaiting-acceptance'}><summary><span><b>Checklist and acceptance evidence</b><small>Open to verify tasks, criteria and required checks.</small></span><strong>{evidenceCount} verified</strong></summary><div class="run-evidence-columns">
      <section><header><div><p class="section-kicker">Accepted checklist</p><h3>Tasks</h3></div><b>{front.done}/{front.total}</b></header>{front.tasks.map((task, index) => <article class={`run-evidence-row ${task.state}`} key={`${index}:${task.text}`}><span><i aria-hidden="true">{task.state === 'done' ? '✓' : task.state === 'skipped' ? '—' : index + 1}</i><span><strong>{task.text}</strong><small>{task.state === 'open' ? 'Needs explicit non-agent verification' : task.state}</small></span></span>{task.state === 'open' && !locked && <div><button type="button" disabled={Boolean(busy)} onClick={() => {
        const evidence = window.prompt('What evidence verifies this checklist item?');
        if (evidence?.trim()) void perform(`task:${index}`, () => onVerifyTask(index, 'done', evidence.trim()));
      }}>{busy === `task:${index}` ? 'Saving…' : 'Verify'}</button><button type="button" disabled={Boolean(busy)} onClick={() => {
        const evidence = window.prompt('Why is this item intentionally skipped?');
        if (evidence?.trim()) void perform(`task:${index}`, () => onVerifyTask(index, 'skipped', evidence.trim()));
      }}>Skip</button></div>}</article>)}</section>
      <section><header><div><p class="section-kicker">Outcome contract</p><h3>Acceptance</h3></div></header>{front.acceptanceCriteria.map((label, index) => {
        const accepted = passed('criterion', index, label);
        return <article class={`run-evidence-row ${accepted ? 'done' : 'open'}`} key={`criterion:${index}`}><span><i aria-hidden="true">{accepted ? '✓' : index + 1}</i><span><strong>{label}</strong><small>{accepted ? 'Passed with reviewed evidence' : 'Criterion not yet accepted'}</small></span></span>{!accepted && !locked && <button type="button" disabled={Boolean(busy)} onClick={() => {
          const evidence = window.prompt('What observed evidence satisfies this acceptance criterion?');
          if (evidence?.trim()) void perform(`criterion:${index}`, () => onRecordCheck('criterion', index, label, evidence.trim()));
        }}>{busy === `criterion:${index}` ? 'Saving…' : 'Record pass'}</button>}</article>;
      })}{front.verification.map((label, index) => {
        const accepted = passed('verification', index, label);
        return <article class={`run-evidence-row ${accepted ? 'done' : 'open'}`} key={`verification:${index}`}><span><i aria-hidden="true">{accepted ? '✓' : index + 1}</i><span><strong>{label}</strong><small>{accepted ? 'Verification passed' : 'Verification evidence required'}</small></span></span>{!accepted && !locked && <button type="button" disabled={Boolean(busy)} onClick={() => {
          const evidence = window.prompt('What configured or observed result verifies this check?');
          if (evidence?.trim()) void perform(`verification:${index}`, () => onRecordCheck('verification', index, label, evidence.trim()));
        }}>{busy === `verification:${index}` ? 'Saving…' : 'Record pass'}</button>}</article>;
      })}</section>
    </div>

    {(run.discoveries.length > 0 || handoff) && <div class="run-records">
      {run.discoveries.length > 0 && <section><p class="section-kicker">Discoveries</p>{run.discoveries.slice().reverse().map((item) => <article key={item.id}><b>{item.kind}</b><span>{item.summary}</span>{item.affectedFronts.length > 0 && <small>Affects {item.affectedFronts.join(', ')}</small>}</article>)}</section>}
      {handoff && <section><p class="section-kicker">Latest handoff · {shortRevision(handoff.revision)}</p><article><b>{new Date(handoff.at).toLocaleString()}</b><span>{handoff.summary}</span>{handoff.nextSteps.length > 0 && <small>Next: {handoff.nextSteps.join(' · ')}</small>}{handoff.blockers.length > 0 && <small>Blocked: {handoff.blockers.join(' · ')}</small>}</article></section>}
    </div>}</details>

    {!locked && <div class="run-panel-actions">
      <button type="button" disabled={Boolean(busy)} onClick={() => {
        const rawKind = window.prompt('Type: discovery, blocker, decision or scope-change', 'discovery')?.trim() || '';
        const kind = (['discovery', 'blocker', 'decision', 'scope-change'].includes(rawKind) ? rawKind : 'discovery') as RunDiscovery['kind'];
        const summary = window.prompt('Summarize the finding.'); if (!summary?.trim()) return;
        const evidence = window.prompt('Evidence or source (optional).', '') || '';
        void perform('discovery', () => onAddDiscovery(kind, summary.trim(), evidence.trim()));
      }}>{busy === 'discovery' ? 'Saving…' : 'Add discovery'}</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => {
        const summary = window.prompt('Write a bounded handoff for the next agent.'); if (!summary?.trim()) return;
        const nextSteps = (window.prompt('Next steps, one per line (optional).', '') || '').split('\n').map((item) => item.trim()).filter(Boolean);
        const blockers = (window.prompt('Blockers, one per line (optional).', '') || '').split('\n').map((item) => item.trim()).filter(Boolean);
        void perform('handoff', () => onHandoff(summary.trim(), nextSteps, blockers));
      }}>{busy === 'handoff' ? 'Saving…' : 'Record handoff'}</button>
      {handoff && !run.process.active && <button type="button" disabled={Boolean(busy)} onClick={onResumeRun}>Review resume preflight</button>}
      {!run.process.active && ['failed', 'awaiting-acceptance'].includes(run.state) && <button type="button" disabled={Boolean(busy)} onClick={onReviewNewRun}>Review new run</button>}
      <button class="primary" type="button" disabled={Boolean(busy) || !canAttemptCompletion} title={!canAttemptCompletion ? 'Stop the process and verify every task, criterion and check first' : 'Revalidates contracts and Git safety before acceptance'} onClick={() => {
        if (window.confirm('Accept this outcome only after the agent is stopped and the reviewed evidence and Git state are complete?')) void perform('complete', onComplete);
      }}>{busy === 'complete' ? 'Accepting…' : 'Accept completed outcome'}</button>
    </div>}
    {run.outcome?.accepted && <div class="run-accepted"><b>Outcome accepted {new Date(run.outcome.acceptedAt).toLocaleString()}</b><span>Front revision {shortRevision(run.outcome.frontRevision)} · process activity and evidence remain separately auditable.</span></div>}
    {error && <p class="form-error" role="alert">{error}</p>}
  </section>;
}

function FrontWorkContext({ repository, component, front, release, run, worktree, session, onNavigate }: {
  repository: Repository;
  component: Component;
  front: Front;
  release: ReleaseContract | null;
  run: RunRecord | null;
  worktree: Repository['workshop']['worktrees'][number] | null;
  session: AgentSession | null;
  onNavigate: (route: RouteState) => void;
}) {
  const releaseRoute: RouteState = { ...baseRoute('releases'), repositoryId: repository.id, releaseSlug: release?.slug || null };
  const componentRoute: RouteState = { ...baseRoute('components'), repositoryId: repository.id, componentSlug: component.slug };
  const sessionRoute: RouteState = { ...baseRoute('sessions'), repositoryId: repository.id, sessionSlug: session?.controlSlug || null };
  return <section class="front-work-context" aria-labelledby="front-work-context-title">
    <header><div><p class="section-kicker">Where this work fits</p><h2 id="front-work-context-title">Follow the outcome down to its live process.</h2></div></header>
    <ol class="work-context-flow">
      <li>{release ? <RouteLink to={releaseRoute} onNavigate={onNavigate}><span>Release</span><b>{release.title}</b><small>{release.state} · coherent delivery increment</small></RouteLink> : <RouteLink className="missing-context-link" to={releaseRoute} onNavigate={onNavigate}><span>Release</span><b>Not assigned yet</b><small>Choose a coherent increment before calling this delivery.</small></RouteLink>}</li>
      <li><span class="current-context"><span>Front</span><b>{front.title}</b><small>{front.state} · planned outcome slice · current page</small></span></li>
      <li>{run ? <a href="#front-run"><span>Run</span><b>{run.state.replaceAll('-', ' ')}</b><small>Reviewed execution · {shortRevision(run.id)}</small></a> : <span class="missing-context"><span>Run</span><b>Not started</b><small>Execution begins only after a reviewed preflight.</small></span>}</li>
    </ol>
    <div class="work-context-relations" aria-label="Related ownership and execution resources">
      <RouteLink to={componentRoute} onNavigate={onNavigate}><span>Component owner</span><b>{component.title}</b><small>Durable responsibility boundary</small></RouteLink>
      {worktree ? <a href="#front-worktree"><span>Worktree</span><b>{worktree.branch || 'Detached workspace'}</b><small>Isolated Git resource</small></a> : <span class="missing-context"><span>Worktree</span><b>Not allocated</b><small>Created only when reviewed execution needs it</small></span>}
      {session ? <RouteLink to={sessionRoute} onNavigate={onNavigate}><span>Agent session</span><b>{session.slug}</b><small>{STATUS_LABEL[session.status]} · live process</small></RouteLink> : <span class="missing-context"><span>Agent session</span><b>Not running</b><small>A session is activity, never delivery progress</small></span>}
    </div>
  </section>;
}

function FrontDetail({
  repository, front, component, release, session, run, runError, worktree, onNavigate, onOpenSession, onStartSession,
  onReviewRun, onResumeRun, onVerifyRunTask, onRecordRunCheck, onAddRunDiscovery, onRunHandoff,
  onCompleteRun, onEdit, canEdit, onRemoveWorktree,
  onMigrate,
}: {
  repository: Repository;
  front: Front;
  component: Component;
  release: ReleaseContract | null;
  session: AgentSession | null;
  run: RunRecord | null;
  runError?: string;
  worktree: Repository['workshop']['worktrees'][number] | null;
  onNavigate: (route: RouteState) => void;
  onOpenSession: (session: AgentSession) => void;
  onStartSession: () => void;
  onReviewRun: () => void;
  onResumeRun: () => void;
  onVerifyRunTask: (index: number, state: 'done' | 'skipped', evidence: string) => Promise<void>;
  onRecordRunCheck: (kind: 'criterion' | 'verification', index: number, label: string, evidence: string) => Promise<void>;
  onAddRunDiscovery: (kind: RunDiscovery['kind'], summary: string, evidence: string) => Promise<void>;
  onRunHandoff: (summary: string, nextSteps: string[], blockers: string[]) => Promise<void>;
  onCompleteRun: () => Promise<void>;
  onEdit: () => void;
  canEdit: boolean;
  onRemoveWorktree: () => void;
  onMigrate: () => void;
}) {
  const planDriven = repository.adapter === 'handraise' && front.schemaVersion === 2;
  const worktreeSummary = worktree ? [
    worktree.git.branchMismatch ? 'branch mismatch' : null,
    worktree.git.dirty ? `${worktree.git.dirty} dirty` : null,
    worktree.git.ahead ? `${worktree.git.ahead} ahead` : null,
    worktree.git.behind ? `${worktree.git.behind} behind` : null,
    worktree.git.unbacked ? `${worktree.git.unbacked} only here` : null,
  ].filter(Boolean).join(' · ') || 'Clean and aligned' : '';
  return (
    <>
      <BreadcrumbTrail onNavigate={onNavigate} items={[
        { label: repository.name, to: { ...baseRoute('overview'), repositoryId: repository.id } },
        { label: component.title, to: { ...baseRoute('components'), repositoryId: repository.id, componentSlug: component.slug } },
        { label: front.title },
      ]} />
      <section class="entity-hero front-detail-hero">
        <div><p class="section-kicker">Front · {front.slug} <TruthBadge kind="accepted">accepted contract</TruthBadge></p><h1>{front.title}</h1><p class="entity-copy">{front.outcome || (front.next ? `Next: ${front.next}` : 'No outcome is registered.')}</p>{canEdit && <div class="entity-actions"><button onClick={onEdit}>Edit plan and state</button></div>}</div>
        <span class={`front-state-badge ${front.state}`}>{FRONT_LABEL[front.state]}</span>
        <dl>
          <div class="progress"><dt>Progress</dt><dd>{front.percent}%</dd></div>
          <div class="checklist"><dt>Checklist</dt><dd>{front.done}/{front.total}</dd></div>
          <div class="priority"><dt>Priority</dt><dd>{front.impact && front.complexity ? `${front.impact} / ${front.complexity}` : 'Unranked'}</dd></div>
        </dl>
        <div class={`front-detail-progress ${front.state}`}><span style={{ width: `${front.percent}%` }} /></div>
      </section>
      <FrontWorkContext repository={repository} component={component} front={front} release={release} run={run} worktree={worktree} session={session} onNavigate={onNavigate} />
      <details class="front-plan-details"><summary><span><b>Planning context and handoff</b><small>Open the accepted background only when you need it.</small></span></summary><section class="front-plan-sections">
          <article><p class="section-kicker">Confirmed context</p><p>{front.context || 'No confirmed context was recorded.'}</p></article>
          <article><p class="section-kicker">Handoff</p><p>{front.handoff || 'No handoff was recorded.'}</p></article>
        </section></details>
      {planDriven ? <>
        {run ? <RunPanel
          run={run}
          front={front}
          session={session}
          onOpenSession={onOpenSession}
          onReviewNewRun={onReviewRun}
          onResumeRun={onResumeRun}
          onVerifyTask={onVerifyRunTask}
          onRecordCheck={onRecordRunCheck}
          onAddDiscovery={onAddRunDiscovery}
          onHandoff={onRunHandoff}
          onComplete={onCompleteRun}
        /> : <section class="detail-section linked-session run-entry">
          <header><div><p class="section-kicker">Operation</p><h2>Run from the accepted plan</h2></div></header>
          <div class="linked-session-row"><span><strong>No run has crossed the execution boundary</strong><small>Review exact context, dependencies, ownership, agent capability and Git risk before anything is allocated.</small></span><button class="primary" onClick={onReviewRun}>Review run preflight</button></div>
        </section>}
        {runError && <p class="form-error">Run history is unavailable: {runError}</p>}
      </> : <section class="detail-section linked-session">
        <header><div><p class="section-kicker">Operation</p><h2>Legacy session</h2></div></header>
        {session ? <div class="linked-session-row"><span><strong>{session.slug}</strong><small>{session.controllable ? 'Handraise-controlled' : 'External · read-only'}</small></span><button class="primary" onClick={() => onOpenSession(session)}>Open session</button></div>
          : <div class="linked-session-row"><span><strong>No linked session</strong><small>Plan-driven execution requires this front and its referenced components on v2. Upgrade only this boundary, or use the legacy session path temporarily.</small></span><div class="button-row"><button onClick={onMigrate}>Review this front's v2 upgrade</button><button class="primary" onClick={onStartSession}>Start legacy session</button></div></div>}
      </section>}
      {worktree && <section class="detail-section front-worktree" id="front-worktree"><header><div><p class="section-kicker">Git workspace</p><h2>{worktree.branch || 'Detached worktree'}</h2><p>{worktreeSummary}</p></div></header><details class="worktree-technical-details"><summary>Git state, path and cleanup</summary><div><dl><div><dt>Dirty</dt><dd>{worktree.git.dirty ?? '—'}</dd></div><div><dt>Ahead / behind</dt><dd>{worktree.git.ahead ?? '—'} / {worktree.git.behind ?? '—'}</dd></div><div><dt>Only here</dt><dd>{worktree.git.unbacked ?? '—'}</dd></div></dl><code>{worktree.path}</code>{worktree.git.branchMismatch && <p class="form-error">Expected branch {worktree.git.expectedBranch}; inspect before continuing.</p>}{!session && (!run || ['completed', 'failed'].includes(run.state)) && <button class="danger" disabled={Boolean(worktree.git.dirty || worktree.git.ahead || worktree.git.unbacked)} title={worktree.git.dirty || worktree.git.ahead || worktree.git.unbacked ? 'Commit, back up and integrate this work before cleanup' : 'Remove clean worktree and merged branch'} onClick={onRemoveWorktree}>Remove clean worktree</button>}</div></details></section>}
    </>
  );
}

interface DeviceInfo {
  id: string;
  name: string;
  createdAt?: string;
  lastSeenAt?: string;
  expiresAt?: string;
  kind?: string;
  implicit?: boolean;
  revocable?: boolean;
}
interface PairingInfo { code: string; expiresAt: string; qr: string; url: string; mode: 'current' | 'private' | 'internet'; origin: string }
interface ManagedTunnelInfo {
  provider: 'cloudflare-quick';
  title: string;
  installed: boolean;
  version: string | null;
  status: 'idle' | 'starting' | 'ready' | 'stopping' | 'failed';
  publicUrl: string | null;
  target: string | null;
  startedAt: string | null;
  error: string | null;
  temporary: boolean;
  public: boolean;
  supportsSse: boolean;
  managed: boolean;
  canManage: boolean;
}
interface RemoteAccessOptions {
  listener: { address: string; port: number | null; family: string | null; loopbackOnly: boolean; wildcard: boolean };
  privateNetwork: {
    available: boolean;
    ready: boolean;
    addresses: Array<{ interface: string; address: string; family: string | number; kind: 'lan' | 'tailnet' | 'private-ipv6'; reachable: boolean; url: string }>;
    selectedAddress: string | null;
    url: string | null;
    restartCommand: string;
    serviceCommand: string;
    guidance: string;
  };
  internet: {
    configured: boolean;
    ready: boolean;
    url: string | null;
    configuredUrl: string | null;
    command: string;
    guidance: string;
    managedTunnel: ManagedTunnelInfo;
  };
}
interface DirectoryListing { path: string; parent: string | null; directories: Array<{ name: string; path: string }> }

function RemotePairingDialog({ options, onClose }: { options: RemoteAccessOptions; onClose: () => void }) {
  const [mode, setMode] = useState<'private' | 'internet' | null>(null);
  const [address, setAddress] = useState(options.privateNetwork.selectedAddress || '');
  const [publicUrl, setPublicUrl] = useState(options.internet.configuredUrl || '');
  const [tunnel, setTunnel] = useState(options.internet.managedTunnel);
  const [internetSource, setInternetSource] = useState<'managed' | 'existing'>(
    options.internet.managedTunnel.status === 'ready' || (options.internet.managedTunnel.installed && options.internet.managedTunnel.canManage)
      ? 'managed' : 'existing',
  );
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const copy = async (value: string, id: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => current === id ? '' : current), 2_000);
    } catch { setCopied(''); }
  };
  const generate = async () => {
    if (!mode) return;
    setBusy(true);
    setError('');
    try {
      setPairing(await api<PairingInfo>('/api/auth/pairing', {
        method: 'POST',
        body: JSON.stringify(mode === 'private'
          ? { mode, address }
          : internetSource === 'managed' ? { mode, managed: true } : { mode, publicUrl }),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const startTunnel = async () => {
    setBusy(true);
    setError('');
    try {
      const ready = await api<ManagedTunnelInfo>('/api/auth/internet-tunnel', { method: 'POST', body: '{}' });
      setTunnel(ready);
      setInternetSource('managed');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const stopTunnel = async () => {
    if (!window.confirm('Stop the temporary Internet tunnel? Clients using its public URL will disconnect immediately.')) return;
    setBusy(true);
    setError('');
    try {
      setTunnel(await api<ManagedTunnelInfo>('/api/auth/internet-tunnel', { method: 'DELETE' }));
      setInternetSource('existing');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (mode !== 'internet' || !['starting', 'stopping'].includes(tunnel.status)) return;
    const refresh = () => void api<ManagedTunnelInfo>('/api/auth/internet-tunnel').then(setTunnel).catch(() => {});
    const timer = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(timer);
  }, [mode, tunnel.status]);
  const privateCandidate = options.privateNetwork.addresses.find((candidate) => candidate.address === address) || null;
  const internetReady = internetSource === 'managed'
    ? tunnel.status === 'ready' && Boolean(tunnel.publicUrl)
    : Boolean(publicUrl.trim());

  return <div class="directory-browser-backdrop remote-pairing-backdrop" role="presentation">
    <section class="component-name-dialog remote-pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-pairing-title">
      <header>
        <div><p class="section-kicker">Remote client access</p><h2 id="remote-pairing-title">Pair another client</h2></div>
        <button type="button" aria-label="Close remote pairing" onClick={onClose}>×</button>
      </header>
      {!pairing && <>
        <p class="remote-pairing-intro">Where will the other browser or installed PWA connect from?</p>
        <div class="remote-mode-picker" role="radiogroup" aria-label="Remote connection type">
          <button type="button" role="radio" aria-checked={mode === 'private'} class={mode === 'private' ? 'active' : ''} onClick={() => { setMode('private'); setError(''); }}>
            <span>Private network</span><small>Same LAN or private tailnet</small>
          </button>
          <button type="button" role="radio" aria-checked={mode === 'internet'} class={mode === 'internet' ? 'active' : ''} onClick={() => { setMode('internet'); setError(''); }}>
            <span>Internet</span><small>Create a temporary public HTTPS tunnel</small>
          </button>
        </div>

        {mode === 'private' && <div class="remote-mode-detail">
          <div class={`remote-readiness ${options.privateNetwork.ready ? 'ready' : 'attention'}`}>
            <strong>{options.privateNetwork.ready ? 'Private access is reachable' : 'Private access needs server exposure'}</strong>
            <span>{options.privateNetwork.guidance}</span>
          </div>
          {options.privateNetwork.addresses.length > 0 ? <fieldset class="private-addresses">
            <legend>Server host address</legend>
            {options.privateNetwork.addresses.map((candidate) => <label key={`${candidate.interface}:${candidate.address}`}>
              <input type="radio" name="private-address" checked={address === candidate.address} onChange={() => setAddress(candidate.address)} />
              <span><strong>{candidate.address}</strong><small>{candidate.interface} · {candidate.kind === 'tailnet' ? 'private tailnet' : candidate.kind === 'lan' ? 'local network' : 'private IPv6'} · {candidate.reachable ? 'listening' : 'not listening yet'}</small></span>
            </label>)}
          </fieldset> : <p class="form-error">No private LAN or tailnet address was detected on this computer.</p>}
          {privateCandidate && <code class="remote-origin-preview">{privateCandidate.url}</code>}
          {!options.privateNetwork.ready && options.privateNetwork.addresses.length > 0 && <div class="remote-command-list">
            <p>Restart the foreground server, then reopen Settings:</p>
            <div><code>{options.privateNetwork.restartCommand}</code><button type="button" onClick={() => void copy(options.privateNetwork.restartCommand, 'private')}>{copied === 'private' ? 'Copied' : 'Copy'}</button></div>
            <p>Or update the Linux user service:</p>
            <div><code>{options.privateNetwork.serviceCommand}</code><button type="button" onClick={() => void copy(options.privateNetwork.serviceCommand, 'service')}>{copied === 'service' ? 'Copied' : 'Copy'}</button></div>
          </div>}
        </div>}

        {mode === 'internet' && <div class="remote-mode-detail internet-mode-detail">
          <div class={`managed-tunnel-card ${tunnel.status}`}>
            <div class="managed-tunnel-heading">
              <span><strong>{tunnel.status === 'ready' ? 'Temporary Internet tunnel is live' : tunnel.status === 'starting' ? 'Creating temporary tunnel…' : tunnel.status === 'failed' ? 'Temporary tunnel failed' : 'Temporary Internet tunnel'}</strong><small>{tunnel.title}{tunnel.version ? ` · ${tunnel.version}` : ''}</small></span>
              <b>{tunnel.status}</b>
            </div>
            {tunnel.status === 'ready' && tunnel.publicUrl ? <>
              <button class={`managed-origin ${internetSource === 'managed' ? 'selected' : ''}`} type="button" onClick={() => setInternetSource('managed')}><span>Use managed tunnel</span><code>{tunnel.publicUrl}</code></button>
              <p>Keep this tunnel running while the remote client uses Handraise. Closing it disconnects that public URL.</p>
              {tunnel.canManage && <button class="danger managed-tunnel-stop" type="button" disabled={busy} onClick={() => void stopTunnel()}>Stop temporary tunnel</button>}
            </> : <>
              <p>Handraise can ask the installed connector to create a random public <code>trycloudflare.com</code> URL for this server. Traffic passes through Cloudflare; the URL is temporary, has no uptime guarantee and is intended for testing or short-lived access.</p>
              {!tunnel.supportsSse && <small>Quick Tunnels do not carry server-sent events, so Handraise automatically uses authenticated polling for live state.</small>}
              {tunnel.error && <p class="form-error">{tunnel.error}</p>}
              {!tunnel.installed && <p class="form-error"><code>cloudflared</code> is not installed on the server host. Use an existing endpoint below or install the connector first.</p>}
              {tunnel.installed && !tunnel.canManage && <p class="form-error">Open Settings directly on the server host to create or stop public exposure.</p>}
              {tunnel.installed && tunnel.canManage && <button class="primary managed-tunnel-start" type="button" disabled={busy || tunnel.status === 'starting' || tunnel.status === 'stopping'} onClick={() => void startTunnel()}>{busy || tunnel.status === 'starting' ? 'Creating tunnel…' : 'Create temporary tunnel'}</button>}
            </>}
          </div>
          <details class="existing-endpoint" open={internetSource === 'existing'}>
            <summary onClick={() => setInternetSource('existing')}>Use an existing HTTPS endpoint instead</summary>
            <div>
              <label><span>Public HTTPS URL</span><input value={publicUrl} onInput={(event) => { setPublicUrl(event.currentTarget.value); setInternetSource('existing'); }} placeholder="https://your-handraise.example" inputMode="url" autoComplete="url" /></label>
              <small>This URL must already forward to this exact Handraise server.</small>
              <div class="remote-command-list">
                <p>To make this origin persistent in Handraise, restart with:</p>
                <div><code>{options.internet.command}</code><button type="button" onClick={() => void copy(options.internet.command, 'internet')}>{copied === 'internet' ? 'Copied' : 'Copy'}</button></div>
              </div>
            </div>
          </details>
        </div>}

        {error && <p class="form-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={onClose}>Cancel</button><button class="primary" type="button" disabled={busy || !mode || (mode === 'private' ? !options.privateNetwork.ready || !address : !internetReady)} onClick={() => void generate()}>{busy ? 'Working…' : 'Generate one-time QR'}</button></footer>
      </>}

      {pairing && <div class="remote-pairing-result">
        <img src={pairing.qr} width="220" height="220" alt="Remote client pairing QR code" />
        <div><p class="section-kicker">{pairing.mode === 'private' ? 'Private network' : 'Internet'} · one time</p><strong>{pairing.code}</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</small><code>{pairing.url}</code><p>Open this URL or scan the QR on the other client. The pairing credential expires after use or five minutes.{pairing.mode === 'internet' && internetSource === 'managed' ? ' Keep the temporary tunnel running after pairing.' : ''}</p></div>
        <footer><button type="button" onClick={() => setPairing(null)}>Choose another route</button><button class="primary" type="button" onClick={onClose}>Done</button></footer>
      </div>}
    </section>
  </div>;
}

function RepositorySettings({
  repository, agents, onRefresh,
}: {
  repository: Settings['repositories'][number];
  agents: Record<string, AgentConfig>;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    defaultAgent: repository.defaultAgent || '', model: repository.model, effort: repository.effort,
  });
  const save = async () => {
    await api(`/api/repositories/${repository.id}`, { method: 'PATCH', body: JSON.stringify(draft) });
    await onRefresh();
  };

  return (
    <article class="repository-setting">
      <div class="repository-setting-heading">
        <span><strong>{repository.name}</strong><small>{repository.path}</small></span>
        {repository.availability?.available === false
          ? <span class="adapter-badge unavailable">{repository.availability.kind}</span>
          : repository.adapter === 'uninitialized' && <span class="adapter-badge uninitialized">Setup needed</span>}
      </div>
      <div class="repository-defaults">
        <label><span>Default agent</span><select value={draft.defaultAgent} onChange={(event) => setDraft({ ...draft, defaultAgent: event.currentTarget.value })}><option value="">Global default</option>{Object.entries(agents).filter(([, agent]) => agent.enabled).map(([id, agent]) => <option value={id}>{agent.title}</option>)}</select></label>
        <label><span>Model override</span><input value={draft.model} placeholder="Agent default" onInput={(event) => setDraft({ ...draft, model: event.currentTarget.value })} /></label>
        <label><span>Effort override</span><select value={draft.effort} onChange={(event) => setDraft({ ...draft, effort: event.currentTarget.value })}><option value="">Agent default</option>{['low', 'medium', 'high', 'xhigh'].map((effort) => <option value={effort}>{effort}</option>)}</select></label>
        <button onClick={() => void save()}>Save defaults</button>
        <button class="danger" onClick={async () => {
          if (!window.confirm(`Disconnect ${repository.name}? The repository will not be changed.`)) return;
          await api(`/api/repositories/${repository.id}`, { method: 'DELETE' });
          await onRefresh();
        }}>Disconnect</button>
      </div>
    </article>
  );
}

function SettingsView({
  settings, onRefresh, onConnectAgent, theme, onThemeChange, mode, onModeChange,
}: { settings: Settings | null; onRefresh: () => Promise<void>; onConnectAgent: (id: string) => Promise<void>; theme: ThemeName; onThemeChange: (theme: ThemeName) => void; mode: ColorMode; onModeChange: (mode: ColorMode) => void }) {
  const [repoPath, setRepoPath] = useState('');
  const [repoName, setRepoName] = useState('');
  const [draftAgents, setDraftAgents] = useState<Record<string, AgentConfig>>({});
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessOptions | null>(null);
  const [error, setError] = useState('');
  const [deviceError, setDeviceError] = useState('');
  const [agentError, setAgentError] = useState('');
  const [connectingAgent, setConnectingAgent] = useState('');
  const [repairingHooks, setRepairingHooks] = useState(false);
  const [pickingRepository, setPickingRepository] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState('');
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null);
  const currentDevice = devices.find((device) => device.id === currentDeviceId) || null;
  const pairedDeviceCount = devices.filter((device) => !device.implicit).length;

  const loadDevices = useCallback(async () => {
    const result = await api<{ devices: DeviceInfo[]; currentDeviceId: string }>('/api/auth/devices');
    setDevices(result.devices);
    setCurrentDeviceId(result.currentDeviceId);
  }, []);

  useEffect(() => { if (settings) setDraftAgents(settings.agents); }, [settings]);
  useEffect(() => {
    void loadDevices();
    const timer = window.setInterval(() => void loadDevices(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadDevices]);
  useEffect(() => {
    if (!connectingAgent) return;
    if (settings?.agents[connectingAgent]?.auth.connected) {
      setConnectingAgent('');
      return;
    }
    const timer = window.setInterval(() => void onRefresh().catch(() => {}), 2_000);
    return () => window.clearInterval(timer);
  }, [connectingAgent, onRefresh, settings]);

  const addRepository = async () => {
    setError('');
    try {
      await api('/api/repositories', {
        method: 'POST', body: JSON.stringify({ path: repoPath, name: repoName }),
      });
      setRepoPath('');
      setRepoName('');
      await onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const browseRepository = async (path = '') => {
    setError('');
    setPickingRepository(true);
    try {
      const result = await api<DirectoryListing>('/api/repositories/browse-directory', {
        method: 'POST', body: JSON.stringify({ path }),
      });
      setDirectoryListing(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPickingRepository(false);
    }
  };

  const saveAgents = async () => {
    await api('/api/settings/agents', { method: 'PATCH', body: JSON.stringify(draftAgents) });
    await onRefresh();
  };

  const repairHooks = async () => {
    setAgentError('');
    setRepairingHooks(true);
    try {
      await api('/api/settings/hooks/repair', { method: 'POST', body: '{}' });
      await onRefresh();
    } catch (reason) {
      setAgentError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRepairingHooks(false);
    }
  };

  const openRemotePairing = async () => {
    setDeviceError('');
    try { setRemoteAccess(await api<RemoteAccessOptions>('/api/auth/remote-access')); }
    catch (reason) { setDeviceError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const connectAgent = async (id: string) => {
    setAgentError('');
    setConnectingAgent(id);
    try {
      await onConnectAgent(id);
      await onRefresh();
    } catch (reason) {
      setConnectingAgent('');
      setAgentError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const copyLoginCommand = async (id: string, command: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setCopiedCommand(id);
      window.setTimeout(() => setCopiedCommand((current) => current === id ? '' : current), 2_000);
    } catch {
      setCopiedCommand('');
    }
  };

  const chooseDirectory = (path: string) => {
    setRepoPath(path);
    setDirectoryListing(null);
  };

  return (
    <>
    <div class="settings-stack">
      <section class="settings-section appearance-section">
        <header><div><h2>Appearance</h2></div></header>
        <div class="mode-picker" role="radiogroup" aria-label="Color mode">
          {(['light', 'dark'] as ColorMode[]).map((option) => <button
            key={option}
            class={`mode-option ${mode === option ? 'active' : ''}`}
            role="radio"
            aria-checked={mode === option}
            onClick={() => onModeChange(option)}
          >
            {option === 'light'
              ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2M12 19v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M3 12h2M19 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8.5 8.5 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4Z" /></svg>}
            <span>{option === 'light' ? 'Light' : 'Dark'}</span>
          </button>)}
        </div>
        <div class="theme-picker" role="radiogroup" aria-label="Color theme">
          {THEMES.map((option) => <button
            key={option.id}
            class={`theme-option ${theme === option.id ? 'active' : ''} ${option.id}`}
            role="radio"
            aria-checked={theme === option.id}
            onClick={() => onThemeChange(option.id)}
          >
            <span class="theme-swatch" aria-hidden="true" />
            <strong>{option.title}</strong>
          </button>)}
        </div>
      </section>
      <section class="settings-section">
        <header><div><h2>Repositories</h2><p>Each repository owns its components, fronts and sessions.</p></div></header>
        <div class="repo-form">
          <label class="path-picker"><span>Repository path</span><div><input value={repoPath} onInput={(event) => setRepoPath(event.currentTarget.value)} placeholder="/home/you/code/project" autoFocus={Boolean(settings && settings.repositories.length === 0)} /><button class="path-browse" type="button" aria-label="Browse for a repository" title="Browse for a repository" onClick={() => void browseRepository()} disabled={pickingRepository}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9.5a2 2 0 0 1 2-2Z" /></svg></button></div></label>
          <label><span>Display name</span><input value={repoName} onInput={(event) => setRepoName(event.currentTarget.value)} placeholder="Optional" /></label>
          <button class="primary" disabled={!repoPath} onClick={() => void addRepository()}>Connect repository</button>
        </div>
        {error && <p class="form-error">{error}</p>}
        <div class="settings-list">
          {settings?.repositories.map((repository) => <RepositorySettings key={repository.id} repository={repository} agents={settings.agents} onRefresh={onRefresh} />)}
        </div>
      </section>

      <section class="settings-section">
        <header><div><h2>Platform capabilities</h2><p>Optional host integrations and release evidence stay explicit.</p></div></header>
        <div class="platform-capabilities">
          <article class={settings?.platform?.desktopNotifications.available ? 'available' : ''}>
            <i aria-hidden="true" />
            <span><strong>Desktop notifications</strong><small>{settings?.platform?.desktopNotifications.available
              ? `Available through ${settings.platform.desktopNotifications.provider}`
              : settings?.platform?.desktopNotifications.reason || 'Capability status unavailable'}</small></span>
            <b>{settings?.platform?.desktopNotifications.available ? 'Available' : 'Optional'}</b>
          </article>
          <article class={settings?.quality?.status === 'pass' ? 'available' : settings?.quality?.status === 'fail' ? 'failed' : 'blocked'}>
            <i aria-hidden="true" />
            <span><strong>Planning quality benchmark · v{settings?.quality?.benchmarkVersion || 'unknown'}</strong><small>{settings?.quality
              ? `Automated ${settings.quality.automatedPass ? 'passed' : 'not passed'} · human gate ${settings.quality.humanStatus} · corpus ${settings.quality.corpusVersion}`
              : 'Checked release evidence unavailable'}</small></span>
            <b>{settings?.quality?.status || 'Unverified'}</b>
          </article>
        </div>
        <details class="quality-limitations"><summary>Semantic and release limitations</summary><p>System maps and work proposals are derived hypotheses, not autonomous product truth. Accepted contracts change only through explicit human publication.</p>{settings?.quality?.limitations?.length ? <ul>{settings.quality.limitations.map((item) => <li key={item}>{item}</li>)}</ul> : null}</details>
      </section>

      <section class="settings-section">
        <header><div><h2>Agent integrations</h2><p>Handraise reuses the accounts already authenticated in each CLI. Tokens stay with the CLI and never enter Handraise.</p></div><div class="button-row">{settings?.hooks.repairNeeded && currentDevice?.implicit && <button class="primary" disabled={repairingHooks} onClick={() => void repairHooks()}>{repairingHooks ? 'Repairing hooks…' : 'Repair agent hooks'}</button>}<button disabled={repairingHooks} onClick={() => void saveAgents()}>Save agents</button></div></header>
        {agentError && <p class="form-error" role="alert">{agentError}</p>}
        <div class="agent-settings">
          {Object.entries(draftAgents).map(([id, agent]) => {
            const auth = agent.auth;
            const provider = auth.provider === 'firstParty' ? 'Anthropic' : auth.provider;
            const accountDetail = [provider, auth.plan ? auth.plan.toUpperCase() : null].filter(Boolean).join(' · ');
            return <article key={id}>
              <header><span><strong>{agent.title}</strong><small>{agent.installed ? agent.version : `${agent.binary} not found`}</small></span><input type="checkbox" checked={agent.enabled} onChange={(event) => setDraftAgents({ ...draftAgents, [id]: { ...agent, enabled: event.currentTarget.checked } })} /></header>
              <div class={`agent-account ${auth.connected ? 'connected' : 'disconnected'}`}>
                <i aria-hidden="true" />
                <span><strong>{auth.connected ? (auth.email || provider || 'Account connected') : (agent.installed ? 'Account not connected' : 'CLI not installed')}</strong><small>{auth.connected ? (accountDetail || 'Authenticated account') : agent.installed ? `Run ${auth.loginCommand} in a terminal.` : `Install ${agent.binary} to enable this integration.`}</small></span>
                <b>{auth.connected ? 'Connected' : 'Offline'}</b>
              </div>
              {!auth.connected && agent.installed && <div class="agent-onboarding-actions"><button class="primary agent-login" type="button" onClick={() => void connectAgent(id)}>{connectingAgent === id ? 'Setup terminal open' : `Connect ${agent.title}`}</button><button type="button" onClick={() => void copyLoginCommand(id, auth.loginCommand)}>{copiedCommand === id ? 'Command copied' : 'Copy command'}</button></div>}
              {!auth.connected && !agent.installed && <small class="capability-note">Install the <code>{agent.binary}</code> CLI on the server host, then refresh Settings to connect its account.</small>}
              <div class="capability-matrix" aria-label={`${agent.title} capabilities`}>
                <span class={agent.capabilities.terminal ? 'available' : ''}>Terminal control</span>
                <span class={agent.capabilities.lifecycleAttention && agent.capabilities.configured ? 'available' : ''}>Lifecycle attention</span>
                <span class={agent.capabilities.typedPermissions && agent.capabilities.configured ? 'available' : ''}>Typed permissions</span>
                <span class={agent.capabilities.gracefulWrapup ? 'available' : ''}>Graceful wrap-up</span>
              </div>
              {!agent.capabilities.configured && <small class="capability-note">Lifecycle and permission hooks are not configured. {currentDevice?.implicit ? <>Repair them here before the first managed run.</> : <>On the server host, run <code>handraise hooks repair</code>.</>}</small>}
              {agent.capabilities.setup && <small class="capability-note">{agent.capabilities.setup}</small>}
              <label><span>Default model</span><input value={agent.model} placeholder="CLI default" onInput={(event) => setDraftAgents({ ...draftAgents, [id]: { ...agent, model: event.currentTarget.value } })} /></label>
              <label><span>Reasoning effort</span><select value={agent.effort} onChange={(event) => setDraftAgents({ ...draftAgents, [id]: { ...agent, effort: event.currentTarget.value } })}><option value="">CLI default</option>{agent.efforts.map((effort) => <option value={effort}>{effort}</option>)}</select></label>
            </article>;
          })}
        </div>
      </section>

      <section class="settings-section">
        <header><div><h2>Clients</h2><p>Direct server-host access is implicit. Pair a remote browser over a private network or an existing HTTPS Internet endpoint.</p></div><div class="button-row"><button disabled={Boolean(currentDevice?.implicit)} title={currentDevice?.implicit ? 'Direct loopback access is part of the server-host trust boundary and cannot be logged out.' : undefined} onClick={async () => { await api('/api/auth/logout', { method: 'POST', body: '{}' }); window.location.reload(); }}>{currentDevice?.implicit ? 'Server host stays signed in' : 'Log out this client'}</button><button class="primary" onClick={() => void openRemotePairing()}>Pair another client</button></div></header>
        {deviceError && <p class="form-error" role="alert">{deviceError}</p>}
        <div class="settings-list">
          {devices.map((device) => (
            <article key={device.id}>
              <span><strong>{device.name}{device.id === currentDeviceId ? ' · this client' : ''}{device.implicit ? ' · implicit local' : ''}</strong><small>{device.implicit ? 'Direct loopback access · not stored as a paired client' : `Last seen ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'unknown'}`}</small></span>
              <button class="danger" disabled={device.revocable === false || (!currentDevice?.implicit && pairedDeviceCount === 1)} title={device.revocable === false ? 'The implicit server-host client cannot be revoked' : (!currentDevice?.implicit && pairedDeviceCount === 1 ? 'Pair another client before revoking the final active client' : undefined)} onClick={async () => {
                setDeviceError('');
                try {
                  await api(`/api/auth/devices/${device.id}`, { method: 'DELETE' });
                  if (device.id === currentDeviceId) window.location.reload();
                  else await loadDevices();
                } catch (reason) {
                  setDeviceError(reason instanceof Error ? reason.message : String(reason));
                }
              }}>{device.implicit ? 'Implicit' : 'Revoke'}</button>
            </article>
          ))}
        </div>
      </section>
    </div>
    {directoryListing && <div class="directory-browser-backdrop" role="presentation">
      <section class="directory-browser" role="dialog" aria-modal="true" aria-labelledby="directory-browser-title">
        <header>
          <div><p class="section-kicker">Choose a repository</p><h2 id="directory-browser-title">Browse folders</h2></div>
          <button type="button" aria-label="Close folder browser" onClick={() => setDirectoryListing(null)}>×</button>
        </header>
        <div class="directory-browser-path"><button type="button" disabled={!directoryListing.parent} onClick={() => directoryListing.parent && void browseRepository(directoryListing.parent)}>↑</button><code>{directoryListing.path}</code></div>
        <div class="directory-browser-list">
          {directoryListing.directories.length ? directoryListing.directories.map((directory) => <button type="button" key={directory.path} onClick={() => void browseRepository(directory.path)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9.5Z" /></svg><span>{directory.name}</span><b>›</b></button>) : <p class="empty-state">No subfolders here.</p>}
        </div>
        <footer><button type="button" onClick={() => setDirectoryListing(null)}>Cancel</button><button class="primary" type="button" onClick={() => chooseDirectory(directoryListing.path)}>Use this folder</button></footer>
      </section>
    </div>}
    {remoteAccess && <RemotePairingDialog options={remoteAccess} onClose={() => setRemoteAccess(null)} />}
    </>
  );
}

function Workbench() {
  const [state, setState] = useState<FleetState>({ sessions: [], needsYou: 0, at: '' });
  const [history, setHistory] = useState<HistoryData>({ events: [], outcomes: [], summary: { completed7d: 0, failed7d: 0, stopped7d: 0, medianDurationSeconds: null } });
  const [historyError, setHistoryError] = useState('');
  const [connected, setConnected] = useState(false);
  const [route, setRoute] = useState<RouteState>(() => parseRoute());
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => savedTheme());
  const [mode, setMode] = useState<ColorMode>(() => savedColorMode());
  const [componentDialog, setComponentDialog] = useState<ComponentDialogState | null>(null);
  const [discoveryDialog, setDiscoveryDialog] = useState<DiscoveryDialogState | null>(null);
  const [productDialog, setProductDialog] = useState<ProductDialogState | null>(null);
  const [contractMigrationDialog, setContractMigrationDialog] = useState<ContractMigrationDialogState | null>(null);
  const [analysisRepositoryId, setAnalysisRepositoryId] = useState<string | null>(null);
  const [planningRepositoryId, setPlanningRepositoryId] = useState<string | null>(null);
  const [architectureRepositoryId, setArchitectureRepositoryId] = useState<string | null>(null);
  const [architectureDraftId, setArchitectureDraftId] = useState<string | null>(null);
  const [frontPlanningLaunch, setFrontPlanningLaunch] = useState<FrontPlanningLaunch | null>(null);
  const [publicationLaunch, setPublicationLaunch] = useState<PublicationLaunch | null>(null);
  const [frontDialog, setFrontDialog] = useState<FrontDialogState | null>(null);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogState | null>(null);
  const [runLaunch, setRunLaunch] = useState<RunLaunchState | null>(null);
  const [fleetSessionSlug, setFleetSessionSlug] = useState<string | null>(null);
  const [journeyRefresh, setJourneyRefresh] = useState(0);
  const settingsReturnRoute = useRef<RouteState>(route.view === 'settings' ? baseRoute() : route);

  const navigate = useCallback((next: RouteState, { replace = false } = {}) => {
    setFleetSessionSlug(null);
    window.history[replace ? 'replaceState' : 'pushState']({}, '', routePath(next));
    setRoute(next);
  }, []);

  useEffect(() => {
    if (route.view !== 'settings') settingsReturnRoute.current = route;
  }, [route]);

  const toggleSettings = () => {
    navigate(route.view === 'settings' ? settingsReturnRoute.current : baseRoute('settings'));
  };
  const toggleMode = () => setMode((current) => current === 'light' ? 'dark' : 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('handraise-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    window.localStorage.setItem('handraise-color-mode', mode);
  }, [mode]);

  const refreshRepositories = useCallback(async () => {
    const repositoryData = await api<{ repositories: Repository[] }>('/api/repositories');
    setRepositories(repositoryData.repositories);
    setRoute((current) => {
      if (!current.repositoryId || repositoryData.repositories.some((repository) => repository.id === current.repositoryId)) return current;
      const fallback = baseRoute();
      window.history.replaceState({}, '', routePath(fallback));
      return fallback;
    });
  }, []);

  const refreshManagement = useCallback(async () => {
    const [, settingsData] = await Promise.all([refreshRepositories(), api<Settings>('/api/settings')]);
    setSettings(settingsData);
    try {
      const historyData = await api<HistoryData>('/api/history?limit=500');
      setHistory(historyData);
      setHistoryError('');
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [refreshRepositories]);

  useEffect(() => {
    let disposed = false;
    let streamOpen = false;
    let lastStreamMessage = 0;
    const stream = new EventSource('/api/stream');
    const poll = async () => {
      try {
        const current = await api<FleetState>('/api/state');
        if (!disposed) {
          setState(current);
          setConnected(true);
        }
      } catch {
        if (!disposed && !streamOpen) setConnected(false);
      }
    };
    stream.onopen = () => { streamOpen = true; setConnected(true); };
    stream.onerror = () => { streamOpen = false; void poll(); };
    stream.onmessage = (event) => {
      lastStreamMessage = Date.now();
      setState(JSON.parse(event.data) as FleetState);
      setConnected(true);
    };
    void poll();
    const timer = window.setInterval(() => {
      if (!streamOpen || Date.now() - lastStreamMessage > 6_000) void poll();
    }, 2_500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      stream.close();
    };
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => { void refreshManagement(); }, []);
  useEffect(() => {
    if (route.view === 'settings') return;
    void refreshRepositories();
    const timer = window.setInterval(() => void refreshRepositories(), 5_000);
    return () => window.clearInterval(timer);
  }, [route.view, refreshRepositories]);
  useEffect(() => {
    const refresh = () => void api<HistoryData>('/api/history?limit=500')
      .then((result) => { setHistory(result); setHistoryError(''); })
      .catch((reason) => setHistoryError(reason instanceof Error ? reason.message : String(reason)));
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedRepo = route.repositoryId;
  const controlledSessions = selectedRepo
    ? state.sessions.filter((session) => session.repoId === selectedRepo)
    : [];
  const controlledKeys = new Set(state.sessions.map((session) => `${session.repoId}:${session.front || session.slug}`));
  const externalSessions: AgentSession[] = repositories
    .filter((repository) => repository.id === selectedRepo)
    .flatMap((repository) => (repository.lanes || [])
      .filter((lane) => !controlledKeys.has(`${repository.id}:${lane.slug}`))
      .map((lane) => ({
        slug: lane.slug,
        controlSlug: `external:${repository.id}:${lane.slug}`,
        agent: 'external',
        cwd: lane.worktree,
        repoId: repository.id,
        component: lane.component,
        front: lane.slug,
        runId: null,
        role: 'agent',
        status: lane.liveness === 'dead' ? 'paused' : 'working',
        reason: lane.statusText,
        waitingSeconds: 0,
        activity: null,
        permission: null,
        controllable: false,
        attached: false,
        error: null,
        git: null,
      })));
  const visibleSessions = [...controlledSessions, ...externalSessions];
  const selectedRepository = repositories.find((repository) => repository.id === selectedRepo) || null;
  const selectedComponent = selectedRepository?.components.find((component) => component.slug === route.componentSlug) || null;
  const selectedFront = selectedComponent?.fronts.find((front) => front.slug === route.frontSlug) || null;
  const frontRun = selectedFront
    ? (selectedRepository?.runs || []).find((run) => run.manifest.front.slug === selectedFront.slug) || null
    : null;
  const frontRelease = selectedFront
    ? selectedRepository?.releases.find((release) => !['released', 'cancelled'].includes(release.state) && release.fronts.some((item) => item.slug === selectedFront.slug))
      || selectedRepository?.releases.find((release) => release.fronts.some((item) => item.slug === selectedFront.slug))
      || null
    : null;
  const frontSession = selectedFront
    ? visibleSessions.find((session) => (frontRun && session.runId === frontRun.id) || session.front === selectedFront.slug || session.slug === selectedFront.slug) || null
    : null;
  const frontWorktree = selectedFront
    ? selectedRepository?.workshop?.worktrees.find((worktree) => worktree.owner?.front === selectedFront.slug || worktree.path.endsWith(`/${selectedFront.slug}`)) || null
    : null;
  const openSession = route.sessionSlug
    ? visibleSessions.find((session) => session.controlSlug === route.sessionSlug) || null
    : fleetSessionSlug ? state.sessions.find((session) => session.controlSlug === fleetSessionSlug) || null : null;
  const openSessionComponent = openSession?.component
    ? selectedRepository?.components.find((component) => component.slug === openSession.component) || null
    : null;
  const openSessionFront = openSessionComponent && openSession?.front
    ? openSessionComponent.fronts.find((front) => front.slug === openSession.front) || null
    : null;
  const initializeRepository = async () => {
    if (!selectedRepository) return;
    if (!window.confirm(`Initialize ${selectedRepository.name} with an empty component portfolio?`)) return;
    await api(`/api/repositories/${selectedRepository.id}/initialize`, { method: 'POST', body: '{}' });
    await refreshManagement();
  };
  const loadContractMigration = async (repositoryId: string, repositoryName: string, scope = { frontSlugs: [] as string[], componentSlugs: [] as string[] }) => {
    setContractMigrationDialog({ repositoryId, repositoryName, loading: true, applying: false, scope, preview: null, error: '' });
    try {
      const query = new URLSearchParams();
      for (const slug of scope.frontSlugs) query.append('front', slug);
      for (const slug of scope.componentSlugs) query.append('component', slug);
      const result = await api<{ preview: ContractMigrationPreview }>(`/api/repositories/${repositoryId}/contracts/migration${query.size ? `?${query}` : ''}`);
      setContractMigrationDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, preview: result.preview, error: '' }
        : current);
    } catch (reason) {
      setContractMigrationDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, error: reason instanceof Error ? reason.message : String(reason) }
        : current);
    }
  };
  const openContractMigration = async (frontSlug?: string) => {
    if (!selectedRepository) return;
    await loadContractMigration(selectedRepository.id, selectedRepository.name, {
      frontSlugs: frontSlug ? [frontSlug] : [], componentSlugs: [],
    });
  };
  const refreshContractMigration = async () => {
    if (!contractMigrationDialog) return;
    await loadContractMigration(contractMigrationDialog.repositoryId, contractMigrationDialog.repositoryName, contractMigrationDialog.scope);
  };
  const applyContractMigration = async () => {
    const current = contractMigrationDialog;
    if (!current?.preview || current.preview.noOp || !current.preview.canApply) return;
    if (!window.confirm(`Migrate ${current.preview.operations.length} reviewed work-contract file${current.preview.operations.length === 1 ? '' : 's'} to schema v2?`)) return;
    setContractMigrationDialog({ ...current, applying: true, error: '' });
    try {
      await api(`/api/repositories/${current.repositoryId}/contracts/migration`, {
        method: 'POST', body: JSON.stringify({ previewId: current.preview.previewId, ...current.scope }),
      });
      setContractMigrationDialog(null);
      await refreshManagement();
    } catch (reason) {
      setContractMigrationDialog((latest) => latest?.repositoryId === current.repositoryId
        ? { ...latest, applying: false, error: reason instanceof Error ? reason.message : String(reason) }
        : latest);
    }
  };
  const openProductBrief = async () => {
    if (!selectedRepository) return;
    const repositoryId = selectedRepository.id;
    const repositoryName = selectedRepository.name;
    setProductDialog({ repositoryId, repositoryName, repositoryAdapter: selectedRepository.adapter, loading: true, draft: null, error: '' });
    try {
      const result = await api<{ draft: ProductDraft }>(`/api/repositories/${repositoryId}/product/drafts`, {
        method: 'POST', body: '{}',
      });
      setProductDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, draft: result.draft, error: '' }
        : current);
    } catch (reason) {
      setProductDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, error: reason instanceof Error ? reason.message : String(reason) }
        : current);
    }
  };
  const openLearningDraft = async (repository: Repository, draft: LearningRoutedDraft) => {
    if (draft.kind === 'component-design') {
      setArchitectureDraftId(draft.draftId);
      setArchitectureRepositoryId(repository.id);
      return;
    }
    if (draft.kind === 'front-design') {
      setFrontPlanningLaunch({ repositoryId: repository.id, componentDraftId: draft.componentDraftId, frontDraftId: draft.draftId });
      return;
    }
    setProductDialog({ repositoryId: repository.id, repositoryName: repository.name, repositoryAdapter: repository.adapter, loading: true, draft: null, error: '' });
    try {
      const result = await api<{ draft: ProductDraft }>(`/api/repositories/${repository.id}/product/drafts/${encodeURIComponent(draft.draftId)}`);
      setProductDialog((current) => current?.repositoryId === repository.id
        ? { ...current, loading: false, draft: result.draft, error: '' }
        : current);
    } catch (reason) {
      setProductDialog((current) => current?.repositoryId === repository.id
        ? { ...current, loading: false, error: reason instanceof Error ? reason.message : String(reason) }
        : current);
    }
  };
  const beginDiscovery = async () => {
    if (!selectedRepository) return;
    const repositoryId = selectedRepository.id;
    const repositoryName = selectedRepository.name;
    setDiscoveryDialog({ repositoryId, repositoryName, loading: true, draft: null, error: '' });
    try {
      const result = await api<{ draft: DiscoveryDraft }>(`/api/repositories/${repositoryId}/discovery`, { method: 'POST', body: '{}' });
      setDiscoveryDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, draft: result.draft, error: '' }
        : current);
    } catch (reason) {
      setDiscoveryDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, error: reason instanceof Error ? reason.message : String(reason) }
        : current);
    }
  };
  const regenerateDiscovery = async () => {
    if (!discoveryDialog) return;
    const { repositoryId, draft } = discoveryDialog;
    setDiscoveryDialog((current) => current ? { ...current, loading: true, error: '' } : current);
    try {
      const endpoint = draft
        ? `/api/repositories/${repositoryId}/discovery/${encodeURIComponent(draft.id)}/regenerate`
        : `/api/repositories/${repositoryId}/discovery`;
      const result = await api<{ draft: DiscoveryDraft }>(endpoint, { method: 'POST', body: '{}' });
      setDiscoveryDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, draft: result.draft, error: '' }
        : current);
    } catch (reason) {
      setDiscoveryDialog((current) => current?.repositoryId === repositoryId
        ? { ...current, loading: false, error: reason instanceof Error ? reason.message : String(reason) }
        : current);
    }
  };
  const acceptDiscovery = async (components: DiscoveryProposal[]) => {
    if (!discoveryDialog?.draft) throw new Error('Run discovery before accepting a proposal.');
    await api(`/api/repositories/${discoveryDialog.repositoryId}/discovery/${encodeURIComponent(discoveryDialog.draft.id)}/accept`, {
      method: 'POST', body: JSON.stringify({ components }),
    });
    setDiscoveryDialog(null);
    await refreshManagement();
  };
  const skipDiscovery = async () => {
    if (!discoveryDialog) return;
    await api(`/api/repositories/${discoveryDialog.repositoryId}/initialize`, { method: 'POST', body: '{}' });
    setDiscoveryDialog(null);
    await refreshManagement();
  };
  const renameComponent = async (slug: string) => {
    if (!selectedRepository) return;
    const component = selectedRepository.components.find((item) => item.slug === slug);
    if (!component) return;
    const section = (pattern: RegExp) => Object.entries(component.sections).find(([heading]) => pattern.test(heading))?.[1] || '';
    setComponentDialog({
      mode: 'edit',
      slug,
      initial: component.title,
      initialScope: section(/alcance|scope|purpose/i),
      initialLimits: section(/límite|limite|limits|boundar/i),
      initialDelegation: section(/delegaci|guidance/i),
      initialTerritory: section(/territorio|territory/i),
      initialOrder: component.order,
    });
  };
  const createComponent = async () => {
    if (!selectedRepository) return;
    const nextOrder = Math.max(0, ...selectedRepository.components.map((component) => component.order)) + 1;
    setComponentDialog({ mode: 'create', initial: '', initialScope: '', initialLimits: '', initialDelegation: '', initialTerritory: '', initialOrder: nextOrder });
  };
  const submitComponentDialog = async (title: string, details: ComponentDetailsDraft) => {
    if (!selectedRepository || !componentDialog) return;
    if (componentDialog.mode === 'edit') {
      const component = selectedRepository.components.find((item) => item.slug === componentDialog.slug);
      if (!component) {
        setComponentDialog(null);
        return;
      }
      await api(`/api/repositories/${selectedRepository.id}/components/${encodeURIComponent(componentDialog.slug || '')}`, {
        method: 'PATCH', body: JSON.stringify({ title, ...details }),
      });
    } else {
      await api(`/api/repositories/${selectedRepository.id}/components`, {
        method: 'POST', body: JSON.stringify({ title, ...details }),
      });
    }
    setComponentDialog(null);
    await refreshRepositories();
  };
  const createFront = () => {
    if (!selectedComponent) return;
    setFrontDialog({ componentSlug: selectedComponent.slug });
  };
  const editFront = () => {
    if (!selectedComponent || !selectedFront) return;
    setFrontDialog({ componentSlug: selectedComponent.slug, front: selectedFront });
  };
  const submitFront = async (draft: FrontDraft) => {
    if (!selectedRepository || !frontDialog) return;
    const endpoint = `/api/repositories/${selectedRepository.id}/components/${encodeURIComponent(frontDialog.componentSlug)}/fronts${frontDialog.front ? `/${encodeURIComponent(frontDialog.front.slug)}` : ''}`;
    await api(endpoint, { method: frontDialog.front ? 'PATCH' : 'POST', body: JSON.stringify(draft) });
    setFrontDialog(null);
    await refreshRepositories();
  };
  const deleteFront = async (slug: string) => {
    if (!selectedRepository || !selectedComponent) return;
    const front = selectedComponent.fronts.find((item) => item.slug === slug);
    if (!front || !window.confirm(`Delete ${front.title}? This removes its plan from the repository.`)) return;
    try {
      await api(`/api/repositories/${selectedRepository.id}/components/${encodeURIComponent(selectedComponent.slug)}/fronts/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (route.frontSlug === slug) navigate(repositoryRoute(selectedRepository.id, 'components'), { replace: true });
      await refreshRepositories();
    } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  };
  const toggleComponentState = async () => {
    if (!selectedRepository || !selectedComponent) return;
    const state = selectedComponent.state === 'active' ? 'closing' : 'active';
    if (!window.confirm(`${state === 'closing' ? 'Mark' : 'Reopen'} ${selectedComponent.title} as ${state}?`)) return;
    await api(`/api/repositories/${selectedRepository.id}/components/${encodeURIComponent(selectedComponent.slug)}`, {
      method: 'PATCH', body: JSON.stringify({ state }),
    });
    await refreshRepositories();
  };
  const removeComponent = async () => {
    if (!selectedRepository || !selectedComponent) return;
    const open = selectedComponent.fronts.filter((front) => front.state !== 'done').map((front) => front.slug);
    const summary = open.length ? `\n\nOpen work that will block removal: ${open.join(', ')}` : '\n\nThe component definition will be removed; repository code is untouched.';
    if (!window.confirm(`Remove ${selectedComponent.title}?${summary}`)) return;
    try {
      await api(`/api/repositories/${selectedRepository.id}/components/${encodeURIComponent(selectedComponent.slug)}`, { method: 'DELETE' });
      navigate(repositoryRoute(selectedRepository.id, 'components'), { replace: true });
      await refreshRepositories();
    } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  };
  const removeFrontWorktree = async () => {
    if (!selectedRepository || !selectedFront || !frontWorktree) return;
    if (!window.confirm(`Remove the clean worktree for ${selectedFront.title}?\n\n${frontWorktree.path}\n${frontWorktree.branch || ''}`)) return;
    try {
      await api(`/api/repositories/${selectedRepository.id}/worktrees/${encodeURIComponent(selectedFront.slug)}`, { method: 'DELETE' });
      await refreshRepositories();
    } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  };
  const needsYou = visibleSessions.filter((session) => ['error', 'blocked', 'waiting'].includes(session.status)).length;
  const summary = visibleSessions.length
    ? `${visibleSessions.length} session${visibleSessions.length === 1 ? '' : 's'}`
    : 'No sessions';
  const wrapping = visibleSessions.filter((session) => session.status === 'wrapping').length;
  const pausing = visibleSessions.filter((session) => session.status === 'pausing').length;
  const liveSummary = needsYou
    ? <>{summary} · <b>{needsYou} need{needsYou === 1 ? 's' : ''} you</b></>
    : pausing
      ? `${summary} · ${pausing} pausing`
      : wrapping
      ? `${summary} · ${wrapping} wrapping up`
      : `${summary} · all clear`;
  const headerStatus = selectedRepository
    ? (connected ? (state.at ? liveSummary : 'Connecting…') : (state.at ? `Offline · ${summary} last seen` : 'Connecting…'))
    : `${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}`;
  const hasRepositories = repositories.length > 0;
  const repositoryRoute = (repositoryId: string, view: 'overview' | 'components' | 'sessions' | 'releases' | 'ad-hoc' | 'map' = 'overview'): RouteState => ({
    ...baseRoute(view), repositoryId,
  });
  const openSessionRoute = (session: AgentSession) => {
    if (!selectedRepo) return;
    navigate({ ...repositoryRoute(selectedRepo, 'sessions'), sessionSlug: session.controlSlug });
  };
  const uniqueSessionSlug = (suggested = 'new-session') => {
    const base = suggested.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'new-session';
    const used = new Set(visibleSessions.map((session) => session.slug));
    if (!used.has(base)) return base;
    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  };
  const openSessionDialog = (component = '', front = '', suggested = '') => {
    setSessionDialog({ slug: uniqueSessionSlug(suggested || front), component, front, isolate: Boolean(front) });
  };
  const openRunPreflight = (resumeRunId: string | null = null) => {
    if (!selectedRepository || !selectedFront) return;
    setRunLaunch({ repositoryId: selectedRepository.id, frontSlug: selectedFront.slug, resumeRunId });
  };
  const runEndpoint = (runId: string, suffix = '') => {
    if (!selectedRepository) throw new Error('Select a repository first.');
    return `/api/repositories/${selectedRepository.id}/runs/${encodeURIComponent(runId)}${suffix}`;
  };
  const verifyRunTask = async (index: number, taskState: 'done' | 'skipped', evidence: string) => {
    if (!frontRun) throw new Error('The reviewed run is no longer available.');
    await api(runEndpoint(frontRun.id, `/tasks/${index}`), {
      method: 'POST', body: JSON.stringify({ source: 'user', state: taskState, evidence }),
    });
    await refreshRepositories();
  };
  const recordRunCheck = async (kind: 'criterion' | 'verification', index: number, label: string, evidence: string) => {
    if (!frontRun) throw new Error('The reviewed run is no longer available.');
    await api(runEndpoint(frontRun.id, '/checks'), {
      method: 'POST', body: JSON.stringify({ kind, index, label, status: 'passed', source: 'user-observed', evidence }),
    });
    await refreshRepositories();
  };
  const addRunDiscovery = async (kind: RunDiscovery['kind'], summary: string, evidence: string) => {
    if (!frontRun || !selectedRepository) throw new Error('The reviewed run is no longer available.');
    const affectedFronts = selectedRepository.fronts
      .filter((front) => front.slug !== selectedFront?.slug && (front.affectedComponents || []).some((slug) => selectedFront?.affectedComponents?.includes(slug)))
      .map((front) => front.slug);
    await api(runEndpoint(frontRun.id, '/discoveries'), {
      method: 'POST', body: JSON.stringify({ kind, summary, evidence, affectedFronts }),
    });
    await refreshRepositories();
  };
  const recordRunHandoff = async (summary: string, nextSteps: string[], blockers: string[]) => {
    if (!frontRun) throw new Error('The reviewed run is no longer available.');
    await api(runEndpoint(frontRun.id, '/handoff'), {
      method: 'POST', body: JSON.stringify({ summary, nextSteps, blockers }),
    });
    await refreshRepositories();
  };
  const completeRun = async () => {
    if (!frontRun) throw new Error('The reviewed run is no longer available.');
    await api(runEndpoint(frontRun.id, '/complete'), { method: 'POST', body: '{}' });
    await refreshRepositories();
  };
  const startSession = async (draft: SessionDraft) => {
    if (!selectedRepository) return;
    const result = await api<{ controlSlug: string }>('/api/session', {
      method: 'POST',
      body: JSON.stringify({ ...draft, repoId: selectedRepository.id, cwd: selectedRepository.path }),
    });
    setSessionDialog(null);
    navigate({ ...repositoryRoute(selectedRepository.id, 'sessions'), sessionSlug: result.controlSlug });
  };
  const retrySession = async (session: AgentSession) => {
    if (session.role === 'setup') {
      const result = await api<{ controlSlug: string | null }>(`/api/agents/${encodeURIComponent(session.agent)}/connect`, { method: 'POST', body: '{}' });
      if (result.controlSlug) setFleetSessionSlug(result.controlSlug);
      await refreshManagement();
      return;
    }
    if (session.role === 'ad-hoc' && session.repoId) {
      navigate(repositoryRoute(session.repoId, 'ad-hoc'));
      return;
    }
    await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({
        slug: session.slug, cwd: session.cwd || selectedRepository?.path,
        agent: session.agent, repoId: session.repoId,
        component: session.component, front: session.front,
        manager: session.role === 'manager', isolate: session.role === 'manager' ? false : undefined,
      }),
    });
  };
  const startDirector = async () => {
    if (!selectedRepository) return;
    try {
      const result = await api<{ controlSlug: string }>('/api/session', {
        method: 'POST', body: JSON.stringify({
          slug: 'director', repoId: selectedRepository.id, cwd: selectedRepository.path,
          manager: true, isolate: false,
        }),
      });
      navigate({ ...repositoryRoute(selectedRepository.id, 'sessions'), sessionSlug: result.controlSlug });
    } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  };
  const startFleetDirector = async () => {
    try {
      const result = await api<{ controlSlug: string }>('/api/session', {
        method: 'POST', body: JSON.stringify({ slug: 'fleet-director', manager: true, isolate: false }),
      });
      setFleetSessionSlug(result.controlSlug);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };
  const connectAgent = async (agentId: string) => {
    const result = await api<{ controlSlug: string | null; connected: boolean }>(`/api/agents/${encodeURIComponent(agentId)}/connect`, {
      method: 'POST', body: '{}',
    });
    if (result.controlSlug) setFleetSessionSlug(result.controlSlug);
    await refreshManagement();
  };

  return (
    <>
      <header class={`topbar ${hasRepositories ? '' : 'empty'}`}>
        <button class="brand-lockup" onClick={() => navigate(baseRoute())} aria-label="Choose a repository">
          <img src="/handraise-mark.png" width="38" height="38" alt="" />
          <span>
            <strong>Handraise</strong>
            <small>Local agent control</small>
          </span>
        </button>
        {selectedRepo && <nav class="primary-nav" aria-label="Primary navigation">
          <RouteLink className={route.view === 'map' ? 'active' : ''} ariaCurrent={route.view === 'map' ? 'page' : undefined} to={repositoryRoute(selectedRepo, 'map')} onNavigate={navigate}><span>Understand</span><small>System</small></RouteLink>
          <RouteLink className={route.view === 'components' ? 'active' : ''} ariaCurrent={route.view === 'components' ? 'page' : undefined} to={repositoryRoute(selectedRepo, 'components')} onNavigate={navigate}><span>Design</span><small>Work</small></RouteLink>
          <RouteLink className={['releases', 'ad-hoc', 'sessions'].includes(route.view) ? 'active' : ''} ariaCurrent={['releases', 'ad-hoc', 'sessions'].includes(route.view) ? 'page' : undefined} to={repositoryRoute(selectedRepo, 'releases')} onNavigate={navigate}><span>Run</span><small>Delivery</small></RouteLink>
        </nav>}
        {hasRepositories && <div class="fleet-summary" aria-live="polite">
          <i class={connected ? 'online' : ''} aria-hidden="true" />
          <span>{headerStatus}</span>
        </div>}
        <button
          class="mode-shortcut"
          aria-label={mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          title={mode === 'light' ? 'Dark mode' : 'Light mode'}
          onClick={toggleMode}
        >{mode === 'light'
          ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2M12 19v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M3 12h2M19 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" /></svg>
          : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8.5 8.5 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4Z" /></svg>}
        </button>
        <button
          class={`settings-shortcut ${route.view === 'settings' ? 'active' : ''}`}
          aria-label={route.view === 'settings' ? 'Close settings' : 'Open settings'}
          title={route.view === 'settings' ? 'Close settings' : 'Settings'}
          aria-pressed={route.view === 'settings'}
          onClick={toggleSettings}
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" /></svg></button>
        <button
          class={`mobile-settings-shortcut ${route.view === 'settings' ? 'active' : ''}`}
          aria-label={route.view === 'settings' ? 'Close settings' : 'Open settings'}
          aria-pressed={route.view === 'settings'}
          onClick={toggleSettings}
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" /></svg></button>
      </header>

      <main class="workspace">
        {route.view === 'repositories' && <>
          {hasRepositories ? <><PageHeading eyebrow="Fleet command center" title="Repositories" /><p class="fleet-thesis">Understand the system. Design the work. Run the agents.</p><FleetDashboard
            repositories={repositories}
            sessions={state.sessions}
            history={history}
            historyError={historyError}
            onOpenSession={(session) => session.repoId
              ? navigate({ ...repositoryRoute(session.repoId, 'sessions'), sessionSlug: session.controlSlug })
              : setFleetSessionSlug(session.controlSlug)}
            onOpenRepository={(repositoryId) => navigate(repositoryRoute(repositoryId))}
            onStartManager={startFleetDirector}
          /><RepositoryOverview repositories={repositories} onSelect={(repositoryId) => navigate(repositoryRoute(repositoryId))} /></>
            : <EmptyRepositoryHome onConnect={() => navigate(baseRoute('settings'))} />}
        </>}

        {route.view === 'overview' && selectedRepository && <RepositoryHome
          repository={selectedRepository}
          sessions={visibleSessions}
          onNavigate={navigate}
          onBack={() => navigate(baseRoute())}
        >
          <RepositoryJourney
            repository={selectedRepository}
            connected={connected}
            refreshToken={journeyRefresh}
            onNavigate={(phase) => navigate(repositoryRoute(selectedRepository.id, phase === 'understand' ? 'map' : phase === 'run' ? 'releases' : 'components'))}
            onProduct={() => void openProductBrief()}
            onAnalyze={() => setAnalysisRepositoryId(selectedRepository.id)}
            onDiscover={beginDiscovery}
            onInitializeEmpty={initializeRepository}
            onDesignArchitecture={() => { setArchitectureDraftId(null); setArchitectureRepositoryId(selectedRepository.id); }}
            onPlanFronts={() => setFrontPlanningLaunch({ repositoryId: selectedRepository.id })}
          />
        </RepositoryHome>}

        {route.view === 'sessions' && selectedRepository && <>
          <DeliveryWorkspaceTabs repositoryId={selectedRepository.id} active="sessions" onNavigate={(view) => navigate(repositoryRoute(selectedRepository.id, view))} />
          <PageHeading eyebrow={`Run · ${selectedRepository.name}`} title="Agent sessions" back={() => navigate(repositoryRoute(selectedRepository.id))}>
            <div class="session-heading-actions"><div class="legend" aria-label="Session status legend">{(Object.keys(STATUS_LABEL) as Status[]).map((status) => <span class={status} key={status}><i aria-hidden="true" />{STATUS_LABEL[status]}</span>)}</div><div class="button-row"><button type="button" onClick={() => openSessionDialog()}>Legacy direct session</button><button class="primary" type="button" onClick={() => navigate(repositoryRoute(selectedRepository.id, 'ad-hoc'))}>Start ad-hoc work</button></div></div>
          </PageHeading>
          <p class="session-process-note"><TruthBadge kind="observed">Process view</TruthBadge> Sessions show live agent processes. Planned progress belongs to Runs and Releases; unplanned outcomes belong to Ad-hoc work.</p>
          <section class="session-grid" aria-label="Agent sessions" aria-live="polite">
            {visibleSessions.length ? visibleSessions.map((session) => <SessionCard key={session.controlSlug} session={session} onOpen={() => openSessionRoute(session)} />) : state.at ? <p class="empty-state">No sessions in this repository.</p> : <p class="empty-state">Connecting to the local Handraise service…</p>}
          </section>
        </>}

        {route.view === 'releases' && selectedRepository && <>
          <DeliveryWorkspaceTabs repositoryId={selectedRepository.id} active="releases" onNavigate={(view) => navigate(repositoryRoute(selectedRepository.id, view))} />
          <PageHeading eyebrow={`Run · ${selectedRepository.name}`} title={route.releaseSlug ? 'Release detail' : 'Releases'} back={() => navigate(route.releaseSlug ? repositoryRoute(selectedRepository.id, 'releases') : repositoryRoute(selectedRepository.id))} />
          <ReleasesView
            repository={selectedRepository}
            selectedSlug={route.releaseSlug}
            onRefresh={refreshRepositories}
            onOpenRelease={(releaseSlug) => navigate({ ...repositoryRoute(selectedRepository.id, 'releases'), releaseSlug })}
            onShowAll={() => navigate(repositoryRoute(selectedRepository.id, 'releases'))}
            onOpenFront={(componentSlug, frontSlug) => navigate({ ...repositoryRoute(selectedRepository.id, 'components'), componentSlug, frontSlug })}
          />
        </>}

        {route.view === 'ad-hoc' && selectedRepository && <>
          <DeliveryWorkspaceTabs repositoryId={selectedRepository.id} active="ad-hoc" onNavigate={(view) => navigate(repositoryRoute(selectedRepository.id, view))} />
          <PageHeading eyebrow={`Run · ${selectedRepository.name}`} title="Ad-hoc work" back={() => navigate(repositoryRoute(selectedRepository.id))} />
          <AdHocRunsView
            repository={selectedRepository}
            settings={settings}
            onRefresh={refreshRepositories}
            onOpenSession={(controlSlug) => navigate({ ...repositoryRoute(selectedRepository.id, 'sessions'), sessionSlug: controlSlug })}
          />
        </>}

        {route.view === 'map' && selectedRepository && <>
          <BreadcrumbTrail onNavigate={navigate} items={[
            { label: selectedRepository.name, to: repositoryRoute(selectedRepository.id) },
            { label: 'Understand' },
          ]} />
          <SystemMapView
            repository={selectedRepository}
            refreshToken={journeyRefresh}
            onAnalyze={() => setAnalysisRepositoryId(selectedRepository.id)}
            onProduct={() => void openProductBrief()}
            onNavigate={navigate}
            onOpenLearningDraft={(draft) => openLearningDraft(selectedRepository, draft)}
          />
        </>}

        {route.view === 'components' && selectedRepository && <>
          {selectedFront && selectedComponent ? <FrontDetail
              repository={selectedRepository}
              front={selectedFront}
              component={selectedComponent}
              release={frontRelease}
              session={frontSession}
              run={frontRun}
              runError={selectedRepository.runError}
              worktree={frontWorktree}
              onNavigate={navigate}
              onOpenSession={openSessionRoute}
              onStartSession={() => openSessionDialog(selectedComponent.slug, selectedFront.slug, selectedFront.slug)}
              onReviewRun={() => openRunPreflight()}
              onResumeRun={() => frontRun && openRunPreflight(frontRun.id)}
              onVerifyRunTask={verifyRunTask}
              onRecordRunCheck={recordRunCheck}
              onAddRunDiscovery={addRunDiscovery}
              onRunHandoff={recordRunHandoff}
              onCompleteRun={completeRun}
              onEdit={editFront}
              canEdit={selectedRepository.mutations.frontEdit}
              onRemoveWorktree={() => void removeFrontWorktree()}
              onMigrate={() => void openContractMigration(selectedFront.slug)}
            /> : selectedComponent ? <ComponentDetail
              repository={selectedRepository}
              component={selectedComponent}
              onNavigate={navigate}
              onCreateFront={createFront}
              onDeleteFront={(frontSlug) => void deleteFront(frontSlug)}
              onEdit={() => void renameComponent(selectedComponent.slug)}
              onToggleState={() => void toggleComponentState()}
              onDelete={() => void removeComponent()}
              canMutate={selectedRepository.mutations.components}
              canCreateFront={selectedRepository.mutations.frontCreate}
              canDeleteFront={selectedRepository.mutations.frontDelete}
            /> : <>
              <PageHeading eyebrow={`Design · ${selectedRepository.name}`} title="Work architecture" back={() => navigate(repositoryRoute(selectedRepository.id))}>
                <div class="design-command-bar" role="toolbar" aria-label="Design workspace actions">
                  <button class="primary" onClick={() => { setArchitectureDraftId(null); setArchitectureRepositoryId(selectedRepository.id); }}>Design architecture</button>
                  <button onClick={() => setFrontPlanningLaunch({ repositoryId: selectedRepository.id })}>Plan fronts</button>
                  <details class="design-more-actions"><summary>More actions</summary><div class="button-row">
                    <button onClick={() => setAnalysisRepositoryId(selectedRepository.id)}>Analyze repository</button>
                    <button onClick={() => setPublicationLaunch({ repositoryId: selectedRepository.id })}>Review publication</button>
                    <button onClick={() => setPlanningRepositoryId(selectedRepository.id)}>Design with model</button>
                    <button onClick={() => void openProductBrief()}>Product brief</button>
                    {selectedRepository.workContracts?.migrationAvailable && <button onClick={() => void openContractMigration()}>Review v2 migration</button>}
                    <button onClick={() => void startDirector()}>Open Director</button>
                    {selectedRepository.components.length > 0 && <button disabled={!selectedRepository.mutations.components} onClick={() => void createComponent()}>New component</button>}
                  </div></details>
                </div>
              </PageHeading>
              <AcceptedWorkModelView
                repository={selectedRepository}
                onOpenFront={(componentSlug, frontSlug) => navigate({ ...repositoryRoute(selectedRepository.id, 'components'), componentSlug, frontSlug })}
              />
              <ComponentsView
                repository={selectedRepository}
                onDiscover={beginDiscovery}
                onInitializeEmpty={initializeRepository}
                onOpen={(componentSlug) => navigate({ ...repositoryRoute(selectedRepository.id, 'components'), componentSlug })}
                onRename={renameComponent}
                onCreate={createComponent}
                onRetry={refreshRepositories}
                onReconnect={() => navigate(baseRoute('settings'))}
              />
            </>}
        </>}

        {route.view === 'settings' && <>
          <PageHeading eyebrow="Handraise" title="Settings" />
          <SettingsView settings={settings} onRefresh={refreshManagement} onConnectAgent={connectAgent} theme={theme} onThemeChange={setTheme} mode={mode} onModeChange={setMode} />
        </>}
      </main>

      <SessionDrawer
        session={openSession}
        onNavigate={navigate}
        onClose={() => {
          if (fleetSessionSlug) {
            setFleetSessionSlug(null);
            if (openSession?.role === 'setup') void refreshManagement();
          } else if (selectedRepo) navigate(repositoryRoute(selectedRepo, 'sessions'), { replace: true });
        }}
        frontRoute={selectedRepo && openSessionComponent && openSessionFront
          ? { ...repositoryRoute(selectedRepo, 'components'), componentSlug: openSessionComponent.slug, frontSlug: openSessionFront.slug }
          : undefined}
        onRetry={retrySession}
        onStopped={() => {
          if (fleetSessionSlug) {
            setFleetSessionSlug(null);
            if (openSession?.role === 'setup') void refreshManagement();
          } else if (selectedRepo) navigate(repositoryRoute(selectedRepo, 'sessions'), { replace: true });
        }}
      />
      {discoveryDialog && <DiscoveryDialog
        state={discoveryDialog}
        onCancel={() => setDiscoveryDialog(null)}
        onRegenerate={regenerateDiscovery}
        onAccept={acceptDiscovery}
        onSkip={skipDiscovery}
      />}
      {productDialog && <ProductBriefDialog
        state={productDialog}
        onDraft={(draft) => setProductDialog((current) => current ? { ...current, draft, error: '' } : current)}
        onCancel={() => setProductDialog(null)}
        onAccepted={async () => { setProductDialog(null); setJourneyRefresh((value) => value + 1); await refreshManagement(); }}
      />}
      {contractMigrationDialog && <ContractMigrationDialog
        state={contractMigrationDialog}
        onCancel={() => setContractMigrationDialog(null)}
        onRefresh={refreshContractMigration}
        onApply={applyContractMigration}
      />}
      {analysisRepositoryId && repositories.find((repository) => repository.id === analysisRepositoryId) && <AnalysisDialog
        repository={repositories.find((repository) => repository.id === analysisRepositoryId)!}
        onCancel={() => { setAnalysisRepositoryId(null); setJourneyRefresh((value) => value + 1); void refreshManagement(); }}
      />}
      {planningRepositoryId && repositories.find((repository) => repository.id === planningRepositoryId) && <PlanningDialog
        repository={repositories.find((repository) => repository.id === planningRepositoryId)!}
        onCancel={() => setPlanningRepositoryId(null)}
      />}
      {architectureRepositoryId && repositories.find((repository) => repository.id === architectureRepositoryId) && <ComponentArchitectureDialog
        repository={repositories.find((repository) => repository.id === architectureRepositoryId)!}
        launchDraftId={architectureDraftId}
        onCancel={() => { setArchitectureRepositoryId(null); setArchitectureDraftId(null); }}
        onAnalyze={() => { setArchitectureRepositoryId(null); setArchitectureDraftId(null); setAnalysisRepositoryId(architectureRepositoryId); }}
        onPlan={() => { setArchitectureRepositoryId(null); setArchitectureDraftId(null); setPlanningRepositoryId(architectureRepositoryId); }}
        onPlanFronts={(draft, alternative) => { setArchitectureRepositoryId(null); setArchitectureDraftId(null); setFrontPlanningLaunch({ repositoryId: architectureRepositoryId, componentDraftId: draft.id, componentAlternativeId: alternative.id }); }}
        onPublish={(draft, alternative) => { setArchitectureRepositoryId(null); setArchitectureDraftId(null); setPublicationLaunch({ repositoryId: architectureRepositoryId, componentDraftId: draft.id, componentAlternativeId: alternative.id, mode: 'components-only' }); }}
      />}
      {frontPlanningLaunch && repositories.find((repository) => repository.id === frontPlanningLaunch.repositoryId) && <FrontPlanningDialog
        repository={repositories.find((repository) => repository.id === frontPlanningLaunch.repositoryId)!}
        launch={frontPlanningLaunch}
        onCancel={() => setFrontPlanningLaunch(null)}
        onModelPlan={() => { const repositoryId = frontPlanningLaunch.repositoryId; setFrontPlanningLaunch(null); setPlanningRepositoryId(repositoryId); }}
        onPublish={(draft, alternative) => { setFrontPlanningLaunch(null); setPublicationLaunch({ repositoryId: draft.repositoryId, componentDraftId: draft.source.componentDraftId, componentAlternativeId: draft.source.componentAlternativeId, frontDraftId: draft.id, frontAlternativeId: alternative.id, mode: 'complete-plan' }); }}
      />}
      {publicationLaunch && repositories.find((repository) => repository.id === publicationLaunch.repositoryId) && <PublicationDialog
        repository={repositories.find((repository) => repository.id === publicationLaunch.repositoryId)!}
        launch={publicationLaunch}
        onCancel={() => setPublicationLaunch(null)}
        onCommitted={refreshRepositories}
        onEditProduct={() => { setPublicationLaunch(null); void openProductBrief(); }}
      />}
      {componentDialog && <ComponentNameDialog state={componentDialog} onCancel={() => setComponentDialog(null)} onSubmit={submitComponentDialog} />}
      {frontDialog && <FrontDialog state={frontDialog} onCancel={() => setFrontDialog(null)} onSubmit={submitFront} />}
      {runLaunch && repositories.find((repository) => repository.id === runLaunch.repositoryId) && <RunPreflightDialog
        launch={runLaunch}
        repository={repositories.find((repository) => repository.id === runLaunch.repositoryId)!}
        settings={settings}
        onCancel={() => setRunLaunch(null)}
        onStarted={async () => { setRunLaunch(null); await refreshRepositories(); }}
      />}
      {sessionDialog && selectedRepository && <SessionStartDialog state={sessionDialog} repository={selectedRepository} settings={settings} onCancel={() => setSessionDialog(null)} onSubmit={startSession} />}
    </>
  );
}

function App() {
  const [client, setClient] = useState<ClientState>({ kind: 'loading' });
  const loadClient = useCallback(() => {
    setClient({ kind: 'loading' });
    api<ReadinessStatus>('/api/readiness')
      .then(() => api<AuthStatus>('/api/auth/status'))
      .then((auth) => setClient(auth.authenticated ? { kind: 'authenticated', auth } : { kind: 'unpaired', auth }))
      .catch((error) => setClient({
        kind: error instanceof ApiError && error.network ? 'offline' : 'not-ready',
        detail: error instanceof Error ? error.message : String(error),
      }));
  }, []);
  useEffect(() => loadClient(), [loadClient]);
  useEffect(() => {
    const unauthorized = () => {
      setClient({
        kind: 'expired',
        auth: { authenticated: false, needsSetup: false, device: null },
      });
    };
    window.addEventListener('handraise:unauthorized', unauthorized);
    return () => window.removeEventListener('handraise:unauthorized', unauthorized);
  }, []);
  if (client.kind === 'loading') return <main class="pair-screen"><p>Loading Handraise…</p></main>;
  if (client.kind === 'offline' || client.kind === 'not-ready') {
    return <OfflineScreen detail={client.detail} kind={client.kind} onRetry={loadClient} />;
  }
  if (client.kind === 'authenticated') return <Workbench />;
  return <PairScreen
    auth={client.auth}
    expired={client.kind === 'expired'}
    onPaired={(auth) => setClient({ kind: 'authenticated', auth })}
  />;
}

document.documentElement.dataset.theme = savedTheme();
document.documentElement.dataset.mode = savedColorMode();
render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}
