import type { AnalysisSnapshot } from './intelligence/contracts.mjs';
import type { SystemMap } from './intelligence/system-map.mjs';
import type { PlanningResult } from './planning/contracts.mjs';
import type { ComponentDesignDraft } from './component-design.mjs';

export const FRONT_DESIGN_SCHEMA_VERSION: 1;
export const FRONT_DESIGN_DRAFT_TTL_MS: number;
export const FRONT_DESIGN_STATES: readonly ['review', 'skipped'];
export const FRONT_PLAN_STRATEGIES: readonly ['outcome-slices', 'risk-first', 'existing', 'model', 'manual'];
export const FRONT_CANDIDATE_KINDS: readonly ['implementation', 'research', 'decision', 'validation', 'migration'];
export const FRONT_DESIGN_FIELDS: readonly string[];

export class FrontDesignError extends Error { code: string; details: unknown; diagnostics: unknown[]; toJSON(): Record<string, unknown> }
export function normalizeFrontDesignContext(value: { analysisJobId: string; planningJobId?: string | null; snapshot: AnalysisSnapshot; map: SystemMap; componentDraft: ComponentDesignDraft; componentAlternativeId?: string; product?: unknown; goalId?: string; goal?: unknown; portfolio?: unknown; planningResult?: PlanningResult | null; modelEvidenceIds?: string[] }): unknown;
export function evaluateFrontPlanAlternative(fronts: unknown[], context: unknown): Record<string, unknown>;
export function synthesizeFrontPlanAlternatives(context: unknown, options?: { includeModel?: boolean }): { context: unknown; catalogs: unknown; alternatives: unknown[]; diagnostics: unknown[] };
export function compareFrontPlanAlternatives(draft: unknown, leftId: string, rightId: string): unknown;

export class FrontPlanningDraftStore {
  constructor(options: { root: string; now?: () => number; ttlMs?: number });
  create(repository: { id: string; adapter: string }, context: unknown, options?: { includeModel?: boolean }): unknown;
  list(repositoryId: string): unknown[];
  source(repositoryId: string, id: string): Record<string, unknown>;
  get(repositoryId: string, id: string, options?: { context?: unknown; unavailableReason?: string | null }): unknown;
  compare(repositoryId: string, id: string, leftId: string, rightId: string): unknown;
  apply(repositoryId: string, id: string, operation: unknown, options?: { context?: unknown }): unknown;
  delete(repositoryId: string, id: string): { deleted: string };
  deleteRepository(repositoryId: string): void;
  cleanup(): void;
}

export function frontDesignFailure(error: unknown): FrontDesignError;
