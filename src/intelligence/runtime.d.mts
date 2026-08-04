import type {
  AnalysisJobState,
  AnalysisSnapshot,
  AnalyzerAdapter,
  AnalyzerDescriptor,
  ContentManifest,
  JsonValue,
} from './contracts.mjs';

export const ANALYSIS_RUNTIME_VERSION: 1;
export const ANALYSIS_DEFAULT_LIMITS: Readonly<{
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxPlanDurationMs: number;
  maxAnalysisDurationMs: number;
  maxOutputBytes: number;
  maxMemoryBytes: number;
  maxCpuSeconds: number;
  maxProcesses: number;
}>;
export const ANALYSIS_DEFAULT_EXCLUSIONS: readonly string[];

export interface AnalysisScopeOptions {
  includeDirty?: boolean;
  includeUntracked?: boolean;
  ignoredPaths?: string[];
  exclusions?: string[];
  limits?: Partial<typeof ANALYSIS_DEFAULT_LIMITS>;
}

export function recaptureAnalysisManifest(
  repository: { id: string; adapter: string; path: string },
  snapshot: AnalysisSnapshot,
  options?: { now?: () => number },
): ContentManifest;

export interface AnalysisPlan {
  id: string;
  repositoryId: string;
  repositoryAdapter: string;
  analyzer: AnalyzerDescriptor;
  createdAt: string;
  expiresAt: string;
  manifest: ContentManifest;
  scope: {
    included: string[];
    excluded: Array<{ pattern: string; reason: string }>;
    truncated: boolean;
    limits: typeof ANALYSIS_DEFAULT_LIMITS;
  };
  options: Required<AnalysisScopeOptions>;
  adapterPlan: JsonValue;
  plannedInMs: number;
}

export interface AnalysisRuntimeEvent {
  jobId: string;
  state: AnalysisJobState;
  stage: string;
  at: string;
  progress: number;
  message: string;
}

export interface AnalysisRuntimeJob {
  id: string;
  repositoryId: string;
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
  error: JsonValue | null;
  resources: JsonValue | null;
  events: AnalysisRuntimeEvent[];
}

export interface CommandAnalyzerExecution {
  command(context: {
    sourcePath: string;
    outputPath: string;
    manifest: ContentManifest;
    options: Required<AnalysisScopeOptions>;
    adapterPlan: JsonValue;
  }): {
    file: string;
    args: string[];
    env?: Record<`HANDRAISE_${string}`, string>;
  } | Promise<{
    file: string;
    args: string[];
    env?: Record<`HANDRAISE_${string}`, string>;
  }>;
  parseResult(context: { stdout: Buffer; stderr: Buffer; outputPath: string; context: unknown }): AnalysisSnapshot | Promise<AnalysisSnapshot>;
}

export type RuntimeAnalyzerAdapter = AnalyzerAdapter & { execution?: CommandAnalyzerExecution };

export interface AnalysisRepository {
  id: string;
  path: string;
  adapter: string;
}

export class AnalysisRuntime {
  constructor(options: {
    root: string;
    adapters?: RuntimeAnalyzerAdapter[];
    now?: () => number;
    planTtlMs?: number;
    retentionMs?: number;
  });
  readonly root: string;
  registerAdapter(adapter: RuntimeAnalyzerAdapter): AnalyzerDescriptor;
  analyzers(): Promise<Array<AnalyzerDescriptor & { availability: {
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
  } }>>;
  plan(repository: AnalysisRepository, options?: { analyzerId?: string; scope?: AnalysisScopeOptions; hostAuthority?: boolean; consent?: boolean }): Promise<AnalysisPlan>;
  start(repository: AnalysisRepository, options: { planId: string; hostAuthority?: boolean; consent?: boolean }): AnalysisRuntimeJob;
  status(repositoryId: string, jobId: string): AnalysisRuntimeJob;
  list(repositoryId: string): AnalysisRuntimeJob[];
  snapshot(repositoryId: string, jobId: string): AnalysisSnapshot;
  cancel(repositoryId: string, jobId: string): AnalysisRuntimeJob;
  delete(repositoryId: string, jobId: string): Promise<{ deleted: string }>;
  cleanup(): void;
  shutdown(): void;
}

export function createAnalysisRuntime(options: ConstructorParameters<typeof AnalysisRuntime>[0]): AnalysisRuntime;
