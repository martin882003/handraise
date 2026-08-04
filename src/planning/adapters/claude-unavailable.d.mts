import type { PlanningAdapterDescriptor } from '../contracts.mjs';

export function createClaudePlanningDeclaration(options?: { binary?: string }): {
  descriptor: PlanningAdapterDescriptor;
  detect(): unknown;
  run(): Promise<never>;
  dispose(): Promise<void>;
};
