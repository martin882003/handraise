export const PRODUCT_BRIEF_SCHEMA_VERSION: 1;
export const PRODUCT_DRAFT_TTL_MS: number;

export interface ProductSource {
  id: string;
  kind: 'human' | 'document' | 'connected-source';
  label: string;
  path?: string;
  digest?: string;
  selectedAt?: string;
}

export interface ProductStatement {
  id: string;
  text: string;
  sourceIds: string[];
  locked: boolean;
  order: number;
}

export interface ProductGlossaryEntry {
  id: string;
  term: string;
  definition: string;
  aliases: string[];
  sourceIds: string[];
  locked: boolean;
  order: number;
}

export interface ProductGoal {
  id: string;
  title: string;
  outcome: string;
  priority: 'now' | 'next' | 'later' | 'unspecified';
  horizon: string;
  state: 'proposed' | 'active' | 'achieved' | 'retired';
  successSignals: string[];
  constraintIds: string[];
  repositoryIds: string[];
  sourceIds: string[];
  locked: boolean;
  order: number;
}

export interface ProductRepositoryRole {
  id: string;
  repositoryId: string;
  role: string;
  sourceIds: string[];
  locked: boolean;
  order: number;
}

export interface ProductDecision {
  id: string;
  question: string;
  answer: string;
  state: 'open' | 'resolved' | 'dismissed';
  sourceIds: string[];
  locked: boolean;
  order: number;
}

export interface ProductConflict extends ProductDecision {
  summary: string;
}

export interface ProductBrief {
  schemaVersion: 1;
  title: string;
  stage: string;
  updatedAt: string;
  purpose: Omit<ProductStatement, 'order'>;
  users: ProductStatement[];
  outcomes: ProductStatement[];
  constraints: ProductStatement[];
  invariants: ProductStatement[];
  nonGoals: ProductStatement[];
  glossary: ProductGlossaryEntry[];
  goals: ProductGoal[];
  repositoryRoles: ProductRepositoryRole[];
  assumptions: ProductStatement[];
  decisions: ProductDecision[];
  conflicts: ProductConflict[];
  sources: ProductSource[];
}

export interface ProductQuestion {
  id: string;
  section: string;
  question: string;
  blocking: false;
}

export interface ProductDraft {
  id: string;
  repositoryId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  baselineRevision: string | null;
  currentRevision: string | null;
  stale: boolean;
  canAccept: boolean;
  acceptedExists: boolean;
  imports: string[];
  brief: ProductBrief;
  sourceStates: ProductSourceState[];
  questions: ProductQuestion[];
}

export interface ProductSourceState {
  sourceId: string;
  status: 'current' | 'stale' | 'missing' | 'unavailable' | 'unknown';
  reason: string | null;
  currentDigest?: string;
}

export class ProductDirectionError extends Error {
  code: string;
  details: unknown;
}

export function normalizeProductBrief(value?: unknown, options?: { repositoryId?: string; now?: number }): ProductBrief;
export function parseProductBrief(markdown: string, options?: { repositoryId?: string; now?: number }): ProductBrief;
export function renderProductBrief(value: unknown, options?: { existingMarkdown?: string; repositoryId?: string; now?: number }): string;
export function productBriefQuestions(value: unknown): ProductQuestion[];
export function inspectProductSources(repository: { id: string; path: string }, value: unknown): ProductSourceState[];
export function readAcceptedProduct(repository: { id: string; path: string }): {
  supported: boolean;
  exists: boolean;
  brief: ProductBrief | null;
  markdown: string | null;
  revision: string | null;
};

export class ProductDirectionDraftStore {
  constructor(options: { root: string; now?: () => number; ttlMs?: number; acceptedWrite?: (path: string, markdown: string) => void });
  create(repository: { id: string; name?: string; path: string }, options?: { reset?: boolean }): ProductDraft;
  get(repository: { id: string; path: string }, id: string): ProductDraft;
  update(repository: { id: string; path: string }, id: string, value: { brief: unknown; unlockIds?: string[] }): ProductDraft;
  importDocuments(repository: { id: string; path: string }, id: string, paths: string[]): ProductDraft;
  planImport(repository: { id: string; path: string }, id: string, paths: string[]): {
    documents: Array<{ path: string; bytes: number }>;
    totalBytes: number;
    limits: { documents: number; perDocumentBytes: number; totalBytes: number };
    repositoryMutation: false;
  };
  preview(repository: { id: string; path: string }, id: string): {
    baselineRevision: string | null;
    currentRevision: string | null;
    proposedRevision: string;
    stale: boolean;
    canAccept: boolean;
    sourceStates: ProductSourceState[];
    before: string;
    after: string;
  };
  accept(repository: { id: string; path: string }, id: string): { accepted: true; revision: string; brief: ProductBrief };
  discard(repository: { id: string; path: string }, id: string): { discarded: string };
  discardRepository(repositoryId: string): void;
}
