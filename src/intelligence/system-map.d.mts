import type {
  AnalysisDiagnostic,
  AnalysisEntity,
  AnalysisEvidence,
  AnalysisRelation,
  AnalysisSnapshot,
  JsonValue,
} from './contracts.mjs';

export const SYSTEM_MAP_SCHEMA_VERSION: 1;
export const SYSTEM_MAP_ALGORITHM_VERSION: '1.0.0';
export const SYSTEM_MAP_LENSES: readonly ['responsibility', 'module', 'deployable', 'dependency', 'entry-point', 'interface', 'data-flow', 'data-store', 'test', 'external-system', 'change-coupling'];
export const SYSTEM_MAP_QUERY_TYPES: readonly ['overview', 'search', 'group', 'entity', 'neighbors', 'path', 'reverse-dependencies', 'evidence', 'aggregate'];
export const SYSTEM_MAP_LIMITS: Readonly<{
  maxEntities: number;
  maxRelations: number;
  maxEvidence: number;
  maxGroups: number;
  maxGroupMembers: number;
  defaultQueryLimit: number;
  maxQueryLimit: number;
  maxQueryDepth: number;
  maxPathDepth: number;
  maxSearchLength: number;
  maxExportBytes: number;
}>;

export type SystemMapLensId = typeof SYSTEM_MAP_LENSES[number];
export type SystemMapQueryType = typeof SYSTEM_MAP_QUERY_TYPES[number];

export interface SystemMapGroup {
  id: string;
  lens: SystemMapLensId;
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
  attributes: Record<string, JsonValue>;
}

export interface SystemMapSummary {
  schemaVersion: 1;
  algorithmVersion: '1.0.0';
  id: string;
  snapshotId: string;
  repository: { id: string; adapter: string };
  derivedAt: string;
  authority: { kind: 'derived'; accepted: false; statement: string };
  source: {
    snapshotStatus: 'complete' | 'partial';
    freshness: AnalysisSnapshot['freshness'];
    manifestDigest: string;
    git: AnalysisSnapshot['manifest']['git'];
    analyzer: { id: string; name: string; version: string };
    configurationDigest: string;
  };
  counts: { entities: number; relations: number; evidence: number; groups: number };
  coverage: Record<string, unknown>;
  lenses: Array<{ id: SystemMapLensId; status: 'available' | 'partial' | 'unsupported'; summary: string; groupIds: string[]; relationKinds: string[]; gaps: string[] }>;
  diagnostics: Array<AnalysisDiagnostic & { source?: string }>;
}

export interface SystemMap extends SystemMapSummary {
  options: { limits: Record<string, number> };
  content: { files: Array<{ path: string; digest: string; size: number; source: string }>; totalFiles: number; truncated: boolean };
  groups: SystemMapGroup[];
  entities: AnalysisEntity[];
  relations: AnalysisRelation[];
  evidence: AnalysisEvidence[];
}

export interface SystemMapQuery {
  type: SystemMapQueryType;
  limit?: number;
  lens?: SystemMapLensId;
  text?: string;
  groupId?: string;
  entityId?: string;
  targetEntityId?: string;
  depth?: number;
  direction?: 'outgoing' | 'incoming' | 'both';
  relationKinds?: string[];
  evidenceIds?: string[];
}

export interface SystemMapQueryResult {
  schemaVersion: 1;
  mapId: string;
  snapshotId: string;
  query: SystemMapQuery & { limit: number };
  groups: SystemMapGroup[];
  entities: AnalysisEntity[];
  relations: AnalysisRelation[];
  evidence: AnalysisEvidence[];
  aggregates: Record<string, Array<{ key: string; count: number }>> | null;
  diagnostics: Array<AnalysisDiagnostic & { source?: string }>;
  truncated: boolean;
  authority: SystemMapSummary['authority'];
}

export function deriveSystemMap(snapshot: unknown, options?: { limits?: Record<string, number> } | Record<string, number>): SystemMap;
export function querySystemMap(map: SystemMap, query?: SystemMapQuery): SystemMapQueryResult;
export function summarizeSystemMap(map: SystemMap): SystemMapSummary;
export function compareSystemMaps(from: SystemMap, to: SystemMap): unknown;
export function exportSystemMap(map: SystemMap, options?: { format?: 'markdown' | 'md' | 'json'; maxGroups?: number; maxBytes?: number }): {
  format: 'markdown' | 'json'; mediaType: string; filename: string; bytes: number; content: string; authority: SystemMapSummary['authority'];
};

export class SystemMapRuntime {
  constructor(options?: { limits?: Record<string, number>; maxCached?: number });
  build(snapshot: AnalysisSnapshot): SystemMap;
  describe(snapshot: AnalysisSnapshot): SystemMapSummary;
  query(snapshot: AnalysisSnapshot, query?: SystemMapQuery): SystemMapQueryResult;
  compare(fromSnapshot: AnalysisSnapshot, toSnapshot: AnalysisSnapshot): unknown;
  export(snapshot: AnalysisSnapshot, options?: { format?: 'markdown' | 'md' | 'json'; maxGroups?: number; maxBytes?: number }): ReturnType<typeof exportSystemMap>;
  clear(): void;
}
