export const ANALYSIS_SCHEMA_VERSION: 1;
export const ANALYSIS_PROVENANCE: readonly ['extracted', 'inferred', 'declared'];
export const ANALYSIS_JOB_STATES: readonly ['queued', 'running', 'awaiting-input', 'stale', 'cancelled', 'failed', 'complete'];
export const SNAPSHOT_STATES: readonly ['complete', 'partial'];
export const FRESHNESS_STATES: readonly ['current', 'stale', 'unknown'];
export const COVERAGE_STATES: readonly ['covered', 'partial', 'excluded', 'unsupported', 'unknown'];
export const GRAPH_QUERY_TYPES: readonly ['entity', 'search', 'neighbors', 'path', 'evidence'];
export const GRAPH_QUERY_LIMITS: Readonly<{
  defaultLimit: 50;
  maxLimit: 500;
  defaultDepth: 1;
  maxDepth: 5;
  maxPathDepth: 12;
  maxTextLength: 240;
}>;

export type AnalysisProvenance = typeof ANALYSIS_PROVENANCE[number];
export type AnalysisJobState = typeof ANALYSIS_JOB_STATES[number];
export type SnapshotState = typeof SNAPSHOT_STATES[number];
export type FreshnessState = typeof FRESHNESS_STATES[number];
export type CoverageState = typeof COVERAGE_STATES[number];
export type GraphQueryType = typeof GRAPH_QUERY_TYPES[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ManifestFile {
  path: string;
  digest: string;
  size: number;
  source: 'tracked' | 'untracked' | 'ignored-explicit';
  mode?: string;
  executable?: boolean;
}

export interface ContentManifest {
  files: ManifestFile[];
  git: { head: string | null; branch: string | null; dirty: boolean; indexDigest?: string };
  selection: { includeUntracked: boolean; includeIgnored: boolean; exclusions: string[] };
  digest: string;
  counts: { files: number; bytes: number; tracked: number; untracked: number; ignoredExplicit: number };
}

export interface AnalyzerCapabilities {
  languages: string[];
  entityKinds: string[];
  relationKinds: string[];
  queries: GraphQueryType[];
  history: boolean;
  semantic: boolean;
  incremental: boolean;
}

export interface AnalyzerDescriptor {
  id: string;
  name: string;
  version: string;
  contractVersion: number;
  capabilities: AnalyzerCapabilities;
  privacy: { localOnly: boolean; modelAssisted: boolean; sourceMayLeaveHost: boolean; requiresConsent: boolean };
  extensions?: JsonValue;
}

export interface SourcePosition { line: number; column: number }
export interface SourceRange { start: SourcePosition; end: SourcePosition }

export interface AnalysisEvidence {
  id: string;
  sourceKind: string;
  provenance: AnalysisProvenance;
  path?: string;
  range?: SourceRange;
  revision?: string;
  excerptHash?: string;
  summary?: string;
  extensions?: JsonValue;
}

export interface AnalysisEntity {
  id: string;
  kind: string;
  name: string;
  evidenceIds: string[];
  location?: { path: string; range?: SourceRange };
  language?: string;
  attributes?: JsonValue;
}

export interface AnalysisRelation {
  id: string;
  source: string;
  target: string;
  kind: string;
  evidenceIds: string[];
  confidence?: number;
  attributes?: JsonValue;
}

export interface AnalysisFinding {
  id: string;
  kind: string;
  summary: string;
  evidenceIds: string[];
  entityIds: string[];
  uncertainty: { level: 'low' | 'medium' | 'high' | 'unknown'; reasons: string[] };
  alternatives: Array<{ summary: string; evidenceIds: string[] }>;
}

export interface AnalysisCoverage {
  id: string;
  subject: string;
  status: CoverageState;
  summary: string;
  evidenceIds: string[];
}

export interface AnalysisDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  evidenceIds?: string[];
  details?: JsonValue;
}

export interface AnalysisSnapshot {
  schemaVersion: 1;
  id: string;
  repository: { id: string; adapter: string };
  createdAt: string;
  analyzer: AnalyzerDescriptor;
  configurationDigest: string;
  status: SnapshotState;
  freshness: { state: FreshnessState; checkedAt: string; reason?: string };
  manifest: ContentManifest;
  scope: {
    included: string[];
    excluded: Array<{ pattern: string; reason: string }>;
    truncated: boolean;
    limits: Record<string, number>;
  };
  coverage: AnalysisCoverage[];
  entities: AnalysisEntity[];
  relations: AnalysisRelation[];
  evidence: AnalysisEvidence[];
  findings: AnalysisFinding[];
  diagnostics: AnalysisDiagnostic[];
  extensions?: JsonValue;
}

export interface GraphQuery {
  type: GraphQueryType;
  snapshotId: string;
  limit: number;
  entityId?: string;
  targetEntityId?: string;
  text?: string;
  evidenceIds?: string[];
  direction?: 'outgoing' | 'incoming' | 'both';
  depth?: number;
  relationKinds?: string[];
}

export interface GraphQueryResult {
  schemaVersion: 1;
  snapshotId: string;
  query: GraphQuery;
  entities: AnalysisEntity[];
  relations: AnalysisRelation[];
  evidence: AnalysisEvidence[];
  diagnostics: AnalysisDiagnostic[];
  truncated: boolean;
}

export interface AnalysisJob {
  id: string;
  repositoryId: string;
  analyzerId: string;
  state: AnalysisJobState;
  createdAt: string;
  updatedAt: string;
  progress: number;
  snapshotId?: string;
  stage?: string;
  message?: string;
  error?: JsonValue;
}

export interface AnalyzerAdapter {
  descriptor: AnalyzerDescriptor;
  detect(...args: any[]): unknown | Promise<unknown>;
  plan(...args: any[]): unknown | Promise<unknown>;
  analyze(...args: any[]): AnalysisSnapshot | Promise<AnalysisSnapshot>;
  query(...args: any[]): GraphQueryResult | Promise<GraphQueryResult>;
  diff?(...args: any[]): unknown | Promise<unknown>;
  dispose(...args: any[]): unknown | Promise<unknown>;
}

export class IntelligenceError extends Error {
  code: string;
  details: unknown;
  constructor(code: string, message: string, options?: { details?: unknown; cause?: unknown });
  toJSON(): { error: string; code: string; details: unknown };
}

export function createContentManifest(value?: unknown): ContentManifest;
export function validateAnalyzerDescriptor(value: unknown): AnalyzerDescriptor;
export function analysisSnapshotIdentity(value: Pick<AnalysisSnapshot, 'repository' | 'manifest' | 'analyzer' | 'configurationDigest'>): string;
export function validateAnalysisSnapshot(value: unknown, options?: { freeze?: boolean }): AnalysisSnapshot;
export function createAnalysisSnapshot(value: Omit<AnalysisSnapshot, 'schemaVersion' | 'id' | 'configurationDigest'> & { configuration?: JsonValue; configurationDigest?: string; id?: string }): AnalysisSnapshot;
export function serializeAnalysisSnapshot(value: unknown): string;
export function parseAnalysisSnapshot(serialized: string): AnalysisSnapshot;
export function validateAnalyzerAdapter(value: unknown): AnalyzerAdapter;
export function validateAnalysisJob(value: unknown): AnalysisJob;
export function validateAnalysisProgress(value: unknown): unknown;
export function validateGraphQuery(value: unknown): GraphQuery;
export function validateGraphQueryResult(value: unknown): GraphQueryResult;
export function validateAnalysisDiff(value: unknown): unknown;
export function intelligenceFailure(error: unknown, fallbackCode?: string): IntelligenceError;
