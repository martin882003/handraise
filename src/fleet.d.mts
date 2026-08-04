export interface FleetVerdictResult {
  kind: string;
  title: string;
  attention: any[];
  risks: any[];
  external: any[];
  recentOutcomes: any[];
  counts: {
    running: number;
    needsYou: number;
    failed: number;
    blocked: number;
    waiting: number;
    unsafe: number;
    completed7d: number;
    failed7d: number;
    stopped7d: number;
  };
}

export function fleetVerdict(input?: {
  repositories?: any[];
  sessions?: any[];
  outcomes?: any[];
  now?: number;
}): FleetVerdictResult;

export function fleetManagerPrompt(input?: {
  repositories?: any[];
  sessions?: any[];
  nodePath?: string;
  binPath?: string;
}): string;
