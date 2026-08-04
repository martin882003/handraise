export const LEARNING_SCHEMA_VERSION: 1;
export const LEARNING_PROPOSAL_STATES: readonly string[];
export const LEARNING_FEEDBACK_SIGNALS: readonly string[];
export const LEARNING_FEEDBACK_REASONS: readonly string[];
export const LEARNING_EXPORT_PURPOSES: readonly string[];

export class LearningError extends Error {
  code: string;
  details: unknown;
  toJSON(): { error: string; code: string; details: unknown };
}

export class LearningProposalStore {
  constructor(options: { root: string; now?: () => number; ttlMs?: number; limits?: Record<string, number> });
  refresh(repository: Record<string, unknown>, context?: Record<string, unknown>): Record<string, unknown>;
  list(repository: Record<string, unknown>, options?: { state?: string | null }): Array<Record<string, unknown>>;
  get(repository: Record<string, unknown>, id: string): Record<string, unknown>;
  summary(repository: Record<string, unknown>): Record<string, unknown>;
  decide(repository: Record<string, unknown>, id: string, value?: Record<string, unknown>, options?: { actor?: Record<string, unknown> | null }): Record<string, unknown>;
  route(repository: Record<string, unknown>, id: string, value?: Record<string, unknown>, options?: { actor?: Record<string, unknown> | null; route?: (proposal: Record<string, unknown>) => Record<string, unknown> }): Record<string, unknown>;
  feedback(repository: Record<string, unknown>, proposalId: string, value?: Record<string, unknown>, options?: { actor?: Record<string, unknown> | null }): Record<string, unknown>;
  feedbackList(repository: Record<string, unknown>): Array<Record<string, unknown>>;
  deleteFeedback(repository: Record<string, unknown>, id: string): { deleted: string };
  deleteProposal(repository: Record<string, unknown>, id: string): Record<string, unknown>;
  previewExport(repository: Record<string, unknown>, value?: Record<string, unknown>): Record<string, unknown>;
  confirmExport(repository: Record<string, unknown>, id: string, value?: Record<string, unknown>, options?: { actor?: Record<string, unknown> | null }): Record<string, unknown>;
  discardRepository(repositoryId: string): { deleted: string };
}
