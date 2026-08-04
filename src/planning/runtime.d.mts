import type { PlanningAdapterDescriptor, PlanningJobState, PlanningOperation, PlanningResult } from './contracts.mjs';

export const PLANNING_RUNTIME_VERSION: 1;
export const PLANNING_PREFLIGHT_TTL_MS: number;
export const PLANNING_JOB_RETENTION_MS: number;
export const PLANNING_MAX_REPAIR_ATTEMPTS: 1;

export interface PlanningPreflight {
  id: string;
  repositoryId: string;
  operation: PlanningOperation;
  adapter: PlanningAdapterDescriptor;
  availability: Record<string, unknown>;
  model: string;
  createdAt: string;
  expiresAt: string;
  context: { digest: string; snapshot: unknown; product: unknown; counts: { sources: number; bytes: number; evidenceIds: number }; diagnostics: unknown[] };
  sources: Array<Record<string, unknown> & { snippet: string }>;
  dataBoundary: PlanningAdapterDescriptor['dataBoundary'];
  consent: { required: boolean; granted: false; statement: string };
  mutation: { repository: false; privateRuntimeStateOnly: true };
  fallback: { kind: 'deterministic-manual'; available: true; summary: string };
}

export interface PlanningJob {
  id: string; repositoryId: string; preflightId: string; operation: PlanningOperation; adapterId: string;
  provider: { id: string; name: string }; model: string; state: PlanningJobState; createdAt: string; updatedAt: string; expiresAt: string;
  stage: string; progress: number; message: string; attempts: number; repairs: number;
  usage: Record<string, number> | null; cost: number | null; resultAvailable: boolean;
  error: { code: string; message: string; retryable: boolean; details?: unknown } | null;
  consent: { granted: true; at: string; boundary: string; contextDigest: string };
  dataBoundary: PlanningAdapterDescriptor['dataBoundary']; context: unknown; fallback: unknown; events: unknown[];
}

export class PlanningRuntime {
  constructor(options: { root: string; adapters?: unknown[]; now?: () => number; preflightTtlMs?: number; retentionMs?: number; contextBuilder?: Function });
  registerAdapter(adapter: unknown): PlanningAdapterDescriptor;
  catalog(): Promise<Array<PlanningAdapterDescriptor & { availability: Record<string, unknown> }>>;
  preflight(repository: { id: string; path: string; adapter: string }, options?: Record<string, unknown>): Promise<PlanningPreflight>;
  start(repository: { id: string; path: string; adapter: string }, options: { preflightId: string; consent?: boolean; hostAuthority?: boolean }): PlanningJob;
  status(repositoryId: string, id: string): PlanningJob;
  list(repositoryId: string): PlanningJob[];
  result(repositoryId: string, id: string): PlanningResult;
  cancel(repositoryId: string, id: string): PlanningJob;
  delete(repositoryId: string, id: string): Promise<{ deleted: string }>;
  cleanup(): void;
  shutdown(): void;
}
