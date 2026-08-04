export const AD_HOC_RUN_SCHEMA_VERSION: 1;
export const AD_HOC_PREFLIGHT_TTL_MS: number;

export interface AdHocActor {
  id: string;
  name: string;
  authority?: string;
}

export interface AdHocDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  recovery: string;
  details: unknown;
}

export interface AdHocComponentContext {
  slug: string;
  title: string;
  revision: string;
  purpose: string;
  responsibilities: string[];
  limits: string[];
  invariants: string[];
  territory: string[];
  uncertainties: string[];
  guidance: string;
}

export interface AdHocProvenance {
  planned: false;
  front: null;
  release: null;
  requirementIds: [];
  deliveryProgress: false;
  retroactivePlanning: false;
}

export interface AdHocPreflight {
  schemaVersion: 1;
  kind: 'ad-hoc';
  id: string;
  revision: string;
  state: 'review' | 'started';
  createdAt: string;
  expiresAt: string;
  repository: { id: string; name: string; adapter: string };
  actor: AdHocActor;
  work: {
    slug: string;
    purpose: string;
    component: AdHocComponentContext | null;
    provenance: AdHocProvenance;
  };
  execution: {
    agent: string;
    model: string;
    effort: string;
    isolate: boolean;
    integrationVersion: string | null;
    authProvider: string | null;
    requirements: { terminal: true; authenticated: true };
    capabilities: {
      terminal: boolean;
      lifecycleAttention: boolean;
      typedPermissions: boolean;
      gracefulWrapup: boolean;
      configured: boolean;
    };
  };
  workspace: { path: string; branch: string | null; revision: string | null };
  source: {
    repositoryRevision: string | null;
    repositoryBranch: string | null;
    component: { slug: string; revision: string } | null;
    digest: string;
  };
  context: { prompt: string; bytes: number; digest: string; explicitUnknowns: string[] };
  readiness: { ready: boolean; errors: number; warnings: number; diagnostics: AdHocDiagnostic[] };
}

export interface AdHocRunRecord {
  schemaVersion: 1;
  kind: 'ad-hoc';
  id: string;
  repositoryId: string;
  revision: string;
  state: 'starting' | 'running' | 'awaiting-outcome' | 'paused' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
  manifest: {
    schemaVersion: 1;
    kind: 'ad-hoc';
    id: string;
    revision: string;
    createdAt: string;
    repository: { id: string; name: string; adapter: string };
    work: AdHocPreflight['work'];
    provenance: AdHocProvenance;
    execution: AdHocPreflight['execution'];
    workspace: { path: string; branch: string | null; created: boolean; baseline: string | null; revision: string | null };
    source: AdHocPreflight['source'];
    context: AdHocPreflight['context'];
    preflight: { id: string; revision: string };
  };
  process: {
    state: string;
    active: boolean;
    activity: { minutesAgo?: number } | null;
    attention: { status: string; reason: string | null; permission?: unknown } | null;
    session: { slug: string; controlSlug: string | null; agent: string; cwd: string } | null;
  };
  discoveries: Array<{ id: string; kind: string; summary: string; evidence: string; at: string; actor: AdHocActor }>;
  checks: Array<{ id: string; label: string; status: 'passed' | 'failed'; source: string; evidence: string; at: string; actor: AdHocActor }>;
  handoffs: Array<{ id: string; revision: string; summary: string; nextSteps: string[]; blockers: string[]; at: string; actor: AdHocActor }>;
  proposals: Array<{
    id: string;
    state: 'review';
    target: { kind: 'new-front' | 'existing-front' | 'release-review'; id: string | null };
    summary: string;
    mutatesAcceptedState: false;
    retroactivePlanned: false;
    deliveryProgress: false;
    at: string;
  }>;
  outcome: {
    status: 'completed' | 'failed' | 'abandoned';
    summary: string;
    accepted: false;
    deliveryProgress: false;
    retroactivePlanned: false;
    at: string;
    git: {
      path: string;
      branch: string | null;
      revision: string | null;
      dirty: number;
      ahead: number;
      behind: number;
      unbacked: number;
      branchMismatch: boolean;
    };
  } | null;
  failure: { code: string; message: string; at: string } | null;
}

export class AdHocRunError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, message: string, options?: { status?: number; details?: unknown });
  toJSON(): { error: string; code: string; details: unknown };
}

export function buildAdHocPreflight(
  repository: { id: string; name: string; path: string; adapter: string },
  details?: Record<string, unknown>,
  options?: Record<string, unknown>,
): Readonly<AdHocPreflight>;

export class AdHocRunStore {
  constructor(options: { root: string; now?: () => number; ttlMs?: number });
  cleanup(): void;
  prepare(repository: Record<string, unknown>, details: Record<string, unknown>, options?: Record<string, unknown>): Readonly<AdHocPreflight>;
  getPreflight(repository: Record<string, unknown>, id: string): Readonly<AdHocPreflight>;
  list(repository: Record<string, unknown>, options?: { sessions?: unknown[] }): Readonly<AdHocRunRecord>[];
  get(repository: Record<string, unknown>, id: string, options?: { sessions?: unknown[] }): Readonly<AdHocRunRecord>;
  start(repository: Record<string, unknown>, preflightId: string, options: Record<string, unknown>): Readonly<AdHocRunRecord>;
  restart(repository: Record<string, unknown>, id: string, options: Record<string, unknown>): Readonly<AdHocRunRecord>;
  addDiscovery(repository: Record<string, unknown>, id: string, value: Record<string, unknown>, options?: Record<string, unknown>): Readonly<AdHocRunRecord>;
  recordCheck(repository: Record<string, unknown>, id: string, value: Record<string, unknown>, options?: Record<string, unknown>): Readonly<AdHocRunRecord>;
  handoff(repository: Record<string, unknown>, id: string, value: Record<string, unknown>, options?: Record<string, unknown>): Readonly<AdHocRunRecord>;
  complete(repository: Record<string, unknown>, id: string, options?: Record<string, unknown>): Readonly<AdHocRunRecord>;
  proposePromotion(repository: Record<string, unknown>, id: string, value: Record<string, unknown>, options?: Record<string, unknown>): Readonly<AdHocRunRecord>;
}
