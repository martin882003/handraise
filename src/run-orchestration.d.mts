export const RUN_ORCHESTRATION_SCHEMA_VERSION: 1;
export const RUN_PREFLIGHT_TTL_MS: number;

export interface RunDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  recovery: string;
  details: unknown;
}

export interface RunPreflight {
  schemaVersion: 1;
  id: string;
  revision: string;
  state: 'review' | 'started';
  createdAt: string;
  expiresAt: string;
  repository: { id: string; name: string; adapter: string };
  actor: { id: string; name: string; authority: 'implicit-local' | 'paired-client' };
  front: Record<string, unknown> & { slug: string; title: string; state: string; revision: string; leadComponent: string | null; acceptanceCriteria: string[]; verification: string[]; checklist: Array<{ state: string; text: string }> };
  components: Array<Record<string, unknown> & { slug: string; title: string; revision: string; territory: string[] }>;
  goals: Array<Record<string, unknown> & { id: string; title: string; outcome: string }>;
  productContext: { purpose: string; constraints: string[]; invariants: string[]; decisions: Array<{ id: string; question: string; answer: string }> };
  dependencies: Array<{ kind: string; target: string; reason: string; state: string; revision: string | null }>;
  execution: Record<string, unknown> & { agent: string; model: string; effort: string; isolate: boolean; capabilities: Record<string, boolean> };
  workspace: { path: string; branch: string | null; revision: string | null };
  source: { front: { slug: string; revision: string }; components: Array<{ slug: string; revision: string }>; dependencies: Array<{ kind: string; target: string; state: string; revision: string | null }>; productRevision: string | null; analysisSnapshot: string | null; repositoryRevision: string | null; repositoryBranch: string | null; digest: string };
  context: { prompt: string; bytes: number; digest: string; explicitUnknowns: string[] };
  readiness: { ready: boolean; errors: number; warnings: number; diagnostics: RunDiagnostic[] };
  resume: { runId: string; handoffRevision: string | null } | null;
}

export interface RunRecord {
  schemaVersion: 1;
  id: string;
  repositoryId: string;
  state: 'starting' | 'running' | 'awaiting-acceptance' | 'paused' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
  manifest: Record<string, unknown> & { revision: string; front: RunPreflight['front']; context: RunPreflight['context'] };
  process: { state: string; active: boolean; activity: unknown; attention: unknown; session: unknown };
  currentFrontRevision: string;
  events: Array<Record<string, unknown>>;
  taskEvidence: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  discoveries: Array<Record<string, unknown>>;
  handoffs: Array<Record<string, unknown>>;
  outcome: Record<string, unknown> | null;
  failure: Record<string, unknown> | null;
}

export class RunOrchestrationError extends Error {
  code: string;
  details: unknown;
  toJSON(): { error: string; code: string; details: unknown };
}

export function buildRunPreflight(repository: Record<string, any>, frontSlug: string, options?: Record<string, any>): RunPreflight;

export class RunOrchestrationStore {
  constructor(options: { root: string; now?: () => number; ttlMs?: number });
  cleanup(): void;
  prepare(repository: Record<string, any>, frontSlug: string, options?: Record<string, any>): RunPreflight;
  getPreflight(repository: Record<string, any>, id: string): RunPreflight;
  list(repository: Record<string, any>, options?: { sessions?: any[] }): RunRecord[];
  get(repository: Record<string, any>, id: string, options?: { sessions?: any[] }): RunRecord;
  start(repository: Record<string, any>, preflightId: string, options?: Record<string, any>): RunRecord;
  addDiscovery(repository: Record<string, any>, id: string, value: Record<string, any>, options?: Record<string, any>): RunRecord;
  handoff(repository: Record<string, any>, id: string, value: Record<string, any>, options?: Record<string, any>): RunRecord;
  recordTask(repository: Record<string, any>, id: string, index: number, value: Record<string, any>, options?: Record<string, any>): RunRecord;
  recordCheck(repository: Record<string, any>, id: string, value: Record<string, any>, options?: Record<string, any>): RunRecord;
  complete(repository: Record<string, any>, id: string, options?: Record<string, any>): RunRecord;
}
