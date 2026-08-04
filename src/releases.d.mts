export const RELEASE_SCHEMA_VERSION: 1;
export const RELEASE_STATES: readonly ['draft', 'ready', 'active', 'blocked', 'candidate', 'released', 'cancelled'];

export interface ReleaseFrontReference {
  slug: string;
  revision: string;
}

export interface ReleaseCandidateEvidence {
  sourceRevision: string;
  contractRevision: string;
  artifactDigest: string;
  artifact: string;
  toolVersions: Record<string, string>;
  measurementProfile: string;
  measuredAt: string;
}

export interface ReleaseContract {
  schemaVersion: 1;
  repositoryId: string;
  slug: string;
  title: string;
  version: string | null;
  state: typeof RELEASE_STATES[number];
  targetBranch: string;
  outcome: string;
  requirementIds: string[];
  fronts: ReleaseFrontReference[];
  acceptanceCriteria: string[];
  verification: string[];
  compatibility: string[];
  limitations: string[];
  candidate: ReleaseCandidateEvidence | null;
  createdAt: string;
  updatedAt: string;
  revision?: string;
}

export class ReleaseError extends Error {
  code: string;
  details: unknown;
  toJSON(): { error: string; code: string; details: unknown };
}

export function normalizeRelease(value: unknown, options?: { repositoryId?: string; now?: number | string | (() => number | string) }): ReleaseContract;
export function renderRelease(value: unknown, options?: { existingMarkdown?: string }): string;
export function parseRelease(markdown: string, options?: { repositoryId?: string; fallbackSlug?: string }): ReleaseContract;
export function releaseRevision(markdown: string): string;
export function assessRelease(value: ReleaseContract, options?: Record<string, unknown>): { phase: string; ready: boolean; blockers: Array<{ code: string; message: string; details: unknown }> };

export class ReleaseStore {
  constructor(options?: { now?: number | string | (() => number | string) });
  list(repository: unknown): ReleaseContract[];
  get(repository: unknown, slug: string): ReleaseContract;
  create(repository: unknown, value: unknown, options?: { fronts?: unknown[] }): ReleaseContract;
  update(repository: unknown, slug: string, updates: unknown, options?: { expectedRevision?: string; fronts?: unknown[] }): ReleaseContract;
  transition(repository: unknown, slug: string, targetState: string, options?: Record<string, unknown>): ReleaseContract;
}
