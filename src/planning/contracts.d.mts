export const PLANNING_SCHEMA_VERSION: 1;
export const PLANNING_OPERATIONS: readonly ['component-design', 'front-design', 'portfolio-review'];
export const PLANNING_JOB_STATES: readonly ['queued', 'running', 'cancelled', 'failed', 'complete'];
export const PLANNING_SOURCE_KINDS: readonly ['graph-query', 'evidence', 'product', 'portfolio', 'human'];
export const PLANNING_UNCERTAINTY: readonly ['low', 'medium', 'high', 'unknown'];
export const PLANNING_CONTEXT_LIMITS: Readonly<Record<string, number>>;

export type PlanningOperation = typeof PLANNING_OPERATIONS[number];
export type PlanningJobState = typeof PLANNING_JOB_STATES[number];
export type PlanningSourceKind = typeof PLANNING_SOURCE_KINDS[number];

export interface PlanningAdapterDescriptor {
  id: string;
  name: string;
  version: string;
  contractVersion: 1;
  provider: { id: string; name: string };
  authentication: { owner: 'first-party-cli' | 'explicit-provider'; method: string; credentialsStoredByHandraise: false };
  capabilities: {
    operations: PlanningOperation[];
    structuredOutput: boolean;
    toolFreeInvocation: boolean;
    cancellation: boolean;
    usage: string[];
    cost: boolean;
    boundedContext: boolean;
  };
  dataBoundary: { kind: 'local' | 'cloud'; destination: string; sourceMayLeaveHost: boolean; requiresConsent: boolean };
  models: Array<{ id: string; label: string; default: boolean }>;
  degradation: { fallback: 'deterministic-manual'; summary: string };
}

export interface PlanningSource {
  id: string;
  kind: PlanningSourceKind;
  title: string;
  content: string;
  bytes: number;
  digest: string;
  provenance: 'extracted' | 'inferred' | 'declared' | 'human' | 'mixed';
  evidenceIds: string[];
}

export interface PlanningContext {
  schemaVersion: 1;
  repository: { id: string; adapter: string };
  operation: PlanningOperation;
  snapshot: { id: string; status: string; freshness: string } | null;
  product: { revision: string; title: string } | null;
  sources: PlanningSource[];
  diagnostics: Array<{ code: string; message: string }>;
  evidenceIds: string[];
  counts: { sources: number; bytes: number; evidenceIds: number };
  digest: string;
}

export interface PlanningGrounding {
  evidenceIds: string[];
  uncertainty: 'low' | 'medium' | 'high' | 'unknown';
  assumptions: string[];
  questions: string[];
}

export interface PlanningComponentProposal extends PlanningGrounding {
  slug: string; title: string; responsibility: string; outcomes: string[]; responsibilities: string[];
  limits: string[]; invariants: string[]; interfaces: string[]; dependencies: string[]; dataSystems: string[];
  territory: string[]; verification: string[];
}

export interface PlanningFrontProposal extends PlanningGrounding {
  slug: string; title: string; componentSlug: string; objective: string; motivation: string; scope: string;
  nonGoals: string[]; readiness: string[]; acceptanceCriteria: string[]; verification: string[];
  deliverables: string[]; risks: string[]; dependencies: string[]; affectedComponents: string[]; goalIds: string[];
}

export interface PlanningFinding extends PlanningGrounding {
  id: string; title: string; kind: 'gap' | 'overlap' | 'dependency' | 'risk' | 'opportunity' | 'question';
  description: string; recommendation: string;
}

export interface PlanningResult {
  schemaVersion: 1;
  operation: PlanningOperation;
  summary: string;
  components: PlanningComponentProposal[];
  fronts: PlanningFrontProposal[];
  findings: PlanningFinding[];
  assumptions: string[];
  questions: string[];
}

export class PlanningError extends Error {
  code: string;
  details: unknown;
  toJSON(): { error: string; code: string; details: unknown };
}

export function planningDigest(value: unknown): string;
export function validatePlanningAdapterDescriptor(value: unknown): PlanningAdapterDescriptor;
export function validatePlanningAdapter(value: unknown): {
  descriptor: PlanningAdapterDescriptor;
  detect(context?: unknown): Promise<unknown> | unknown;
  run(context: unknown): Promise<unknown> | unknown;
  dispose(context?: unknown): Promise<void> | void;
};
export function createPlanningContext(value: unknown): PlanningContext;
export function validatePlanningResult(value: unknown, options?: { operation?: PlanningOperation; evidenceIds?: string[] }): PlanningResult;
export function planningResultJsonSchema(options: { operation: PlanningOperation; evidenceIds?: string[] }): Record<string, unknown>;
export function planningFailure(error: unknown, fallbackCode?: string): { code: string; message: string; details: unknown };
