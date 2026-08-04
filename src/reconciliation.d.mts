import type { AnalysisSnapshot } from './intelligence/contracts.mjs';
import type { SystemMap } from './intelligence/system-map.mjs';

export const RECONCILIATION_SCHEMA_VERSION: 1;
export const RECONCILIATION_DECISIONS: readonly ['open', 'dismissed', 'deferred', 'accepted-for-planning'];
export const RECONCILIATION_DEFAULT_LIMITS: Readonly<{
  maxChangedItems: number;
  maxFindingsPerCycle: number;
  maxAffectedPerKind: number;
  maxCycles: number;
  maxJobs: number;
  maxTriggers: number;
  retentionMs: number;
}>;

export type ReconciliationDecisionState = typeof RECONCILIATION_DECISIONS[number];

export interface ReconciliationFinding {
  schemaVersion: 1;
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
  dispositionRecord: unknown;
  resolvedAt?: string | null;
}

export interface ReconciliationCycle {
  schemaVersion: 1;
  id: string;
  repositoryId: string;
  createdAt: string;
  cause: string;
  sourceId: string | null;
  from: { mapId: string; snapshotId: string; analyzer: unknown; manifestDigest: string };
  to: { mapId: string; snapshotId: string; analyzer: unknown; manifestDigest: string };
  comparison: unknown;
  findings: ReconciliationFinding[];
  staleness: Record<'productClaims' | 'components' | 'fronts' | 'runs', Array<{ id: string; severity: string; findingIds: string[]; reasons: string[] }>>;
  diagnostics: Array<{ code: string; severity: string; message: string; details: unknown }>;
  summary: { noChange: boolean; findings: number; newFindings: number; bySeverity: Record<string, number>; stale: Record<string, number>; bounded: boolean };
  authority: { kind: 'derived'; accepted: false; statement: string };
}

export class ReconciliationError extends Error {
  code: string;
  details: unknown;
  constructor(code: string, message: string, details?: unknown);
  toJSON(): { error: string; code: string; details: unknown };
}

export function reconcileArchitecture(options: {
  repository: { id: string; name?: string };
  fromMap: SystemMap;
  toMap: SystemMap;
  comparison: unknown;
  portfolio?: unknown;
  runs?: unknown[];
  previousFindings?: ReconciliationFinding[];
  cause?: string;
  sourceId?: string | null;
  now?: number;
  limits?: Partial<typeof RECONCILIATION_DEFAULT_LIMITS>;
}): ReconciliationCycle;

export class ReconciliationRuntime {
  constructor(options: {
    root: string;
    analyses: {
      snapshot(repositoryId: string, jobId: string): AnalysisSnapshot;
      status(repositoryId: string, jobId: string): any;
      cancel(repositoryId: string, jobId: string): any;
    };
    systemMaps: {
      build(snapshot: AnalysisSnapshot): SystemMap;
      compare(from: AnalysisSnapshot, to: AnalysisSnapshot): unknown;
    };
    context?: (repository: unknown) => unknown;
    now?: () => number;
    limits?: Partial<typeof RECONCILIATION_DEFAULT_LIMITS>;
  });
  compare(repository: any, options: { fromJobId: string; toJobId: string; cause?: string; sourceId?: string | null }): ReconciliationCycle;
  summary(repository: any): unknown;
  listCycles(repository: any): unknown[];
  cycle(repository: any, id: string): ReconciliationCycle;
  findings(repository: any, filters?: { active?: boolean | null; disposition?: string | null; severity?: string | null }): ReconciliationFinding[];
  decide(repository: any, findingId: string, value: { state: ReconciliationDecisionState; rationale?: string; reconsiderAfter?: string | null }, options?: { actor?: unknown }): unknown;
  trigger(repository: any, value: { cause: string; sourceId: string; message?: string }): unknown;
  triggers(repository: any): unknown[];
  trackAnalysis(repository: any, analysisJob: any, options?: { fromJobId?: string | null; cause?: string; sourceId?: string | null }): unknown;
  observeJob(repository: any, id: string): unknown;
  jobs(repository: any): unknown[];
  cancel(repository: any, id: string): unknown;
  discardRepository(repositoryId: string): { deleted: string };
  shutdown(): void;
}
