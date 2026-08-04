import type { AnalysisSnapshot, GraphQuery, GraphQueryResult } from '../intelligence/contracts.mjs';
import type { PlanningContext, PlanningOperation } from './contracts.mjs';

export const PLANNING_TOOL_LIMITS: Readonly<Record<string, number>>;

export interface PlanningTools {
  manifest: {
    schemaVersion: 1;
    readOnly: true;
    repositoryMutation: false;
    processExecution: false;
    network: false;
    limits: Readonly<Record<string, number>>;
  };
  graphOverview(options?: { limit?: number }): { payload: unknown; evidenceIds: string[] };
  graphQuery(query: GraphQuery | Record<string, unknown>): GraphQueryResult;
  evidenceQuery(options: { evidenceIds: string[]; limit?: number }): unknown[];
  productQuery(options?: { sections?: string[]; maxItems?: number }): { payload: unknown; evidenceIds: string[] } | null;
  portfolioQuery(options?: { componentLimit?: number; frontLimit?: number }): { payload: unknown; evidenceIds: string[] };
}

export function createPlanningTools(options?: { snapshot?: AnalysisSnapshot | null; product?: unknown; portfolio?: unknown }): PlanningTools;
export function buildPlanningContext(options: {
  repository: { id: string; adapter: string };
  operation: PlanningOperation;
  snapshot?: AnalysisSnapshot | null;
  product?: unknown;
  portfolio?: unknown;
  question?: string;
  graphQueries?: Array<Record<string, unknown>>;
  includeProduct?: boolean;
}): PlanningContext;
