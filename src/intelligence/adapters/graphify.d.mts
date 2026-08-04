import type { RuntimeAnalyzerAdapter } from '../runtime.mjs';

export const GRAPHIFY_ADAPTER_VERSION: '1.0.0';
export const GRAPHIFY_TESTED_VERSIONS: readonly string[];
export const GRAPHIFY_SUPPORTED_VERSIONS: Readonly<{
  major: number;
  minor: number;
  minimumPatch: number;
  maximumPatch: number;
  display: string;
}>;

export interface GraphifyDetection {
  available: boolean;
  code: string;
  reason: string;
  binary: string;
  package: 'graphifyy';
  version?: string;
  supportedVersions: string;
  testedVersions: readonly string[];
  command?: string;
  schema?: string;
  isolation?: string;
  capabilities?: Record<string, boolean>;
}

export function detectGraphify(options?: { executable?: string }): GraphifyDetection;
export function createGraphifyAdapter(options?: { executable?: string; detection?: GraphifyDetection | null }): RuntimeAnalyzerAdapter;
