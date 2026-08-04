import type { AnalysisSnapshot } from './intelligence/contracts.mjs';
import type { SystemMap } from './intelligence/system-map.mjs';
import type { PlanningResult } from './planning/contracts.mjs';

export const COMPONENT_DESIGN_SCHEMA_VERSION: 1;
export const COMPONENT_DESIGN_DRAFT_TTL_MS: number;
export const COMPONENT_DESIGN_STATES: readonly ['review', 'skipped'];
export const ARCHITECTURE_STRATEGIES: readonly ['responsibility', 'hybrid', 'existing', 'model', 'manual'];
export const COMPONENT_DESIGN_FIELDS: readonly ['purpose', 'outcomes', 'responsibilities', 'limits', 'invariants', 'interfaces', 'dependencies', 'dataSystems', 'territory', 'verification', 'evidence', 'uncertainties', 'guidance'];

export interface FieldGrounding { evidenceIds: string[]; intentIds: string[]; assumptions: string[]; questions: string[] }
export interface ComponentCandidate {
  id: string; slug: string; title: string; state: 'active'; order: number; origin: 'generated' | 'accepted' | 'model' | 'manual';
  memberEntityIds: string[];
  contract: {
    purpose: string; outcomes: string[]; responsibilities: string[]; limits: string[]; invariants: string[];
    interfaces: Array<{ kind: 'provides' | 'consumes'; target: string; description: string }>;
    dependencies: Array<{ kind: 'hard' | 'soft' | 'external'; target: string; reason: string }>;
    dataSystems: string[]; territory: string[]; verification: string[];
    evidence: Array<{ kind: 'extracted' | 'inferred' | 'declared'; reference: string; reason: string }>;
    uncertainties: string[]; guidance: string;
  };
  fieldGrounding: Record<typeof COMPONENT_DESIGN_FIELDS[number], FieldGrounding>;
  lockedFields: Array<typeof COMPONENT_DESIGN_FIELDS[number]>;
}

export interface ArchitectureAlternative {
  id: string; strategy: typeof ARCHITECTURE_STRATEGIES[number]; title: string; summary: string; rationale: string[];
  tradeoffs: { strengths: string[]; risks: string[]; bestWhen: string[] };
  components: ComponentCandidate[];
  quality: Record<string, unknown>;
  generatedBy: { kind: 'deterministic' | 'model' | 'human'; adapterId: string | null; model: string | null };
}

export interface ComponentDesignDraft {
  schemaVersion: 1; id: string; repositoryId: string; state: 'review' | 'skipped'; createdAt: string; updatedAt: string; expiresAt: string;
  source: Record<string, unknown>; stale: boolean; staleReasons: string[]; selectedAlternativeId: string;
  alternatives: ArchitectureAlternative[];
  questions: Array<{ id: string; question: string; why: string; affects: string[]; state: 'open' | 'answered'; answer: string }>;
  lockedDecisions: Array<Record<string, unknown>>; history: Array<Record<string, unknown>>; revision: string;
  mutation: { repository: false; privateDraftOnly: true; publicationAvailableHere: false };
}

export class ComponentDesignError extends Error {
  code: string; details: unknown; diagnostics: unknown[];
  toJSON(): { error: string; code: string; details: unknown; diagnostics: unknown[] };
}

export function normalizeComponentDesignContext(value: {
  analysisJobId: string; planningJobId?: string | null; snapshot: AnalysisSnapshot; map: SystemMap;
  product?: unknown; portfolio?: unknown; planningResult?: PlanningResult | null; modelEvidenceIds?: string[];
}): unknown;
export function evaluateArchitectureAlternative(components: ComponentCandidate[], map: SystemMap): Record<string, unknown>;
export function synthesizeArchitectureAlternatives(context: unknown, options?: { includeModel?: boolean }): { context: unknown; catalogs: unknown; alternatives: ArchitectureAlternative[] };
export function compareArchitectureAlternatives(draft: ComponentDesignDraft, leftId: string, rightId: string): unknown;

export class ComponentDesignDraftStore {
  constructor(options: { root: string; now?: () => number; ttlMs?: number });
  create(repository: { id: string; adapter: string }, context: unknown, options?: { includeModel?: boolean }): ComponentDesignDraft;
  list(repositoryId: string): ComponentDesignDraft[];
  get(repositoryId: string, id: string, options?: { context?: unknown; unavailableReason?: string | null }): ComponentDesignDraft;
  source(repositoryId: string, id: string): { analysisJobId: string; planningJobId: string | null; snapshotId: string; contextIdentity: string; productIncluded: boolean; modelIncluded: boolean };
  compare(repositoryId: string, id: string, leftId: string, rightId: string): unknown;
  apply(repositoryId: string, id: string, operation: unknown, options?: { context?: unknown }): ComponentDesignDraft;
  delete(repositoryId: string, id: string): { deleted: string };
  deleteRepository(repositoryId: string): void;
  cleanup(): void;
}

export function componentDesignFailure(error: unknown): ComponentDesignError;
