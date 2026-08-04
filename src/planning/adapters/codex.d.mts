import type { PlanningAdapterDescriptor } from '../contracts.mjs';

export const CODEX_PLANNING_ADAPTER_VERSION: string;
export const CODEX_SUPPORTED_VERSIONS: string;
export const CODEX_DEFAULT_TIMEOUT_MS: number;
export const CODEX_MAX_EVENT_BYTES: number;
export const CODEX_MAX_RESULT_BYTES: number;

export function codexPlanningInvocation(options: {
  workspacePath: string; schemaPath: string; outputPath: string; instructionsPath: string; privateHome: string; model?: string;
}): string[];

export function createCodexPlanningAdapter(options?: {
  binary?: string;
  binaryArgs?: string[];
  codexHome?: string;
  timeoutMs?: number;
  maxEventBytes?: number;
  maxResultBytes?: number;
  cacheMs?: number;
  spawnProcess?: typeof import('node:child_process').spawn;
}): {
  descriptor: PlanningAdapterDescriptor;
  detect(options?: { refresh?: boolean }): unknown;
  run(context: Record<string, unknown>): Promise<{ output: unknown; usage: Record<string, number> | null; cost: null; metadata: Record<string, unknown> }>;
  dispose(): Promise<void>;
};
