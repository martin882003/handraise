import type { AnalysisSnapshot } from './intelligence/contracts.mjs';

export const PLAN_PUBLICATION_SCHEMA_VERSION: 1;
export const PLAN_PUBLICATION_TTL_MS: number;
export const PLAN_PUBLICATION_MODES: readonly ['components-only', 'product-components', 'complete-plan'];
export const PLAN_PUBLICATION_STATES: readonly ['review', 'committing', 'committed', 'conflict', 'failed'];

export interface PublicationActor {
  id: string;
  name: string;
  authority: 'implicit-local' | 'paired-client';
}

export interface PublicationSelection {
  mode: typeof PLAN_PUBLICATION_MODES[number];
  includeProduct: boolean;
  includeComponents: true;
  includeFronts: boolean;
  deleteAbsentComponents: boolean;
  deleteAbsentFronts: boolean;
  allowCompletedDeletes: boolean;
}

export interface PublicationOperation {
  id: string;
  kind: 'project' | 'metadata' | 'product' | 'component' | 'front' | 'audit';
  slug: string;
  action: 'create' | 'update' | 'delete';
  relativePath: string;
  before: string | null;
  after: string | null;
  beforeRevision: string | null;
  afterRevision: string | null;
}

export interface PublicationManifest {
  schemaVersion: 1;
  id: string;
  repositoryId: string;
  adapter: 'handraise' | 'uninitialized';
  state: typeof PLAN_PUBLICATION_STATES[number];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  selection: PublicationSelection;
  actor: PublicationActor;
  source: Record<string, unknown>;
  publicationDigest: string;
  revision: string;
  noOp: boolean;
  canPublish: boolean;
  summary: { creates: number; updates: number; deletes: number; files: number; bytes: number; errors: number; warnings: number };
  validation: { valid: boolean; diagnostics: unknown[]; portfolio: unknown };
  relationships: { components: unknown[]; fronts: unknown[] };
  operations: PublicationOperation[];
  result: PublicationResult | null;
  failure?: { code: string; message: string; at: string; recoveryRequired: boolean } | null;
}

export interface PublicationWorkspace {
  repositoryId?: string;
  snapshot: AnalysisSnapshot;
  componentDraft: Record<string, unknown>;
  componentAlternativeId?: string;
  frontDraft?: Record<string, unknown> | null;
  frontAlternativeId?: string;
  productDraft?: Record<string, unknown> | null;
}

export interface PublicationResult {
  committed: true;
  publicationId: string;
  publicationDigest: string;
  committedAt: string;
  actor: PublicationActor;
  summary: PublicationManifest['summary'];
  auditPath: string | null;
  artifacts: Array<{ kind: string; slug: string; action: string; path: string; revision: string | null }>;
}

export class PlanPublicationError extends Error {
  code: string;
  details: unknown;
  diagnostics: unknown[];
  toJSON(): { error: string; code: string; details: unknown; diagnostics: unknown[] };
}

export function publicationSourceRevision(workspace: PublicationWorkspace): Readonly<Record<string, unknown>>;
export function buildPublicationManifest(
  repository: { id: string; path: string; adapter?: string; name?: string },
  workspace: PublicationWorkspace,
  selection: Partial<PublicationSelection> & { mode: PublicationSelection['mode'] },
  options: { id?: string; now?: number; actor: { id: string; name?: string; label?: string; implicit?: boolean } },
): unknown;

export class PlanPublicationStore {
  constructor(options: { root: string; now?: () => number; ttlMs?: number; fault?: ((stage: string, context: Record<string, unknown>) => void) | null });
  create(repository: { id: string; path: string; adapter?: string; name?: string }, workspace: PublicationWorkspace, selection: Partial<PublicationSelection> & { mode: PublicationSelection['mode'] }, options: { actor: { id: string; name?: string; label?: string; implicit?: boolean } }): PublicationManifest;
  list(repository: { id: string; path: string }): PublicationManifest[];
  get(repository: { id: string; path: string }, id: string): PublicationManifest;
  discard(repository: { id: string; path: string }, id: string): { discarded: string };
  discardRepository(repositoryId: string): void;
  recover(repository: { id: string; path: string }): { recovered: Array<{ previewId: string; outcome: string }> };
  commit(repository: { id: string; path: string }, id: string, options: {
    expectedRevision: string;
    confirmed: boolean;
    actor: { id: string; name?: string; label?: string; implicit?: boolean };
    sourceCheck: () => Record<string, unknown>;
  }): PublicationResult;
  cleanup(): void;
}
