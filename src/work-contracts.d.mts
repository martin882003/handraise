export const WORK_CONTRACT_SCHEMA_VERSION: 2;
export const COMPONENT_STATES: readonly ['active', 'closing', 'retired'];
export const FRONT_STATES: readonly ['queued', 'active', 'blocked', 'paused', 'done'];
export const COMPONENT_DEPENDENCY_KINDS: readonly ['hard', 'soft', 'external'];
export const FRONT_DEPENDENCY_KINDS: readonly ['hard', 'coordination', 'informational'];
export const INTERFACE_KINDS: readonly ['provides', 'consumes'];
export const EVIDENCE_PROVENANCE: readonly ['extracted', 'inferred', 'declared'];

export type ComponentState = typeof COMPONENT_STATES[number];
export type FrontState = typeof FRONT_STATES[number];
export type EvidenceProvenance = typeof EVIDENCE_PROVENANCE[number];
export type TaskState = 'open' | 'done' | 'skipped';

export interface StructuredReference<K extends string = string> {
  kind: K | 'unknown';
  target: string;
  reason: string;
  raw: string;
}

export interface EvidenceReference {
  kind: EvidenceProvenance | 'unknown';
  reference: string;
  reason: string;
  raw: string;
}

export interface ComponentContract {
  purpose: string;
  outcomes: string[];
  responsibilities: string[];
  limits: string[];
  invariants: string[];
  interfaces: Array<{ kind: 'provides' | 'consumes' | 'unknown'; target: string; description: string; raw: string }>;
  dependencies: Array<StructuredReference<'hard' | 'soft' | 'external'>>;
  dataSystems: string[];
  territory: string[];
  verification: string[];
  evidence: EvidenceReference[];
  uncertainties: string[];
  guidance: string;
}

export interface ParsedComponentContract {
  schemaVersion: number;
  slug: string;
  title: string;
  state: ComponentState;
  order: number;
  since: string;
  sections: Record<string, string>;
  contract: ComponentContract;
}

export interface WorkTask { state: TaskState; text: string }

export interface ParsedFrontContract {
  schemaVersion: number;
  slug: string;
  component: string | null;
  leadComponent: string | null;
  affectedComponents: string[];
  goalIds: string[];
  analysisSnapshot: string | null;
  title: string;
  state: FrontState;
  done: number;
  total: number;
  percent: number;
  next: string | null;
  impact: string | null;
  complexity: string | null;
  outcome: string;
  motivation: string;
  scope: string;
  nonGoals: string[];
  readiness: string[];
  acceptanceCriteria: string[];
  verification: string[];
  deliverables: string[];
  risks: string[];
  dependencies: Array<StructuredReference<'hard' | 'coordination' | 'informational'>>;
  evidence: EvidenceReference[];
  context: string;
  handoff: string;
  tasks: WorkTask[];
  sections: Record<string, string>;
  kind: 'front' | 'backlog';
}

export interface ContractDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
  details: unknown;
}

export interface PortfolioValidation {
  valid: boolean;
  diagnostics: ContractDiagnostic[];
  summary: { components: number; fronts: number; errors: number; warnings: number };
}

export class WorkContractError extends Error {
  code: string;
  diagnostics: ContractDiagnostic[];
  details: unknown;
  toJSON(): { error: string; code: string; diagnostics: ContractDiagnostic[]; details: unknown };
}

export function parseWorkMarkdown(markdown: string): {
  markdown: string;
  newline: '\n' | '\r\n';
  frontmatter: { start: number; end: number; raw: string } | null;
  metadata: Record<string, unknown>;
  metadataKeys: Record<string, string>;
  sections: Array<{ heading: string; normalizedHeading: string; start: number; headingEnd: number; bodyStart: number; end: number; body: string }>;
};
export function parseComponentContract(markdown: string, options?: { fallbackSlug?: string }): ParsedComponentContract;
export function parseFrontContract(markdown: string, options?: { fallbackSlug?: string; adapter?: string; priority?: { impact?: string | null; complexity?: string | null } | null }): ParsedFrontContract;
export function createComponentMarkdown(component: Record<string, unknown>, options?: { since?: string }): string;
export function createFrontMarkdown(front: Record<string, unknown>): string;
export function updateComponentMarkdown(markdown: string, updates?: Record<string, unknown>): string;
export function updateFrontMarkdown(markdown: string, updates?: Record<string, unknown>): string;
export function migrateComponentMarkdown(markdown: string): string;
export function migrateFrontMarkdown(markdown: string): string;
export function validatePortfolioContracts(components: ParsedComponentContract[], fronts: ParsedFrontContract[], options?: { goalIds?: Iterable<string> }): PortfolioValidation;
export function assertPortfolioContracts(components: ParsedComponentContract[], fronts: ParsedFrontContract[], options?: { goalIds?: Iterable<string> }): PortfolioValidation;
export function workContractRevision(markdown: string): string;
export const WORK_CONTRACT_SECTIONS: Readonly<Record<'component' | 'front', Readonly<Record<string, { heading: string; aliases: string[] }>>>>;
