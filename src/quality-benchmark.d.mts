export const QUALITY_BENCHMARK_SCHEMA_VERSION: 1;
export const QUALITY_BENCHMARK_ENGINE_VERSION: string;
export const QUALITY_REGRESSION_CATEGORIES: readonly string[];

export class QualityBenchmarkError extends Error {
  code: string;
  details: unknown;
}

export interface QualityBenchmarkDefinition {
  corpus: Record<string, unknown>;
  rubric: Record<string, unknown>;
}

export interface QualityBenchmarkReport {
  schemaVersion: 1;
  benchmarkVersion: string;
  corpusVersion: string;
  protocolVersion: string;
  generatedAt: string;
  status: 'pass' | 'fail' | 'blocked';
  promotionAllowed: boolean;
  versions: Record<string, string | number>;
  gate: Record<string, unknown>;
  human: Record<string, unknown>;
  candidates: Record<string, unknown>;
  regressions: Record<string, unknown>;
  reviews: Array<Record<string, unknown>>;
  privacy: Record<string, boolean>;
  limitations: string[];
}

export function validateQualityBenchmarkDefinition(value: QualityBenchmarkDefinition): {
  caseIds: string[];
  corpusVersion: string;
  benchmarkVersion: string;
};
export function applyBenchmarkChange(fixture: Record<string, unknown>, change?: Record<string, unknown>): Record<string, unknown>;
export function createBenchmarkSnapshot(benchmarkCase: Record<string, unknown>, options?: { changed?: boolean }): Record<string, unknown>;
export function captureBlindReviews(reviews?: Array<Record<string, unknown>>, options?: {
  caseIds?: string[];
  blindCandidateMap?: Record<string, string>;
}): Array<Record<string, unknown>>;
export function evaluateQualityGate(summary: Record<string, unknown>, rubric: Record<string, unknown>, human: Record<string, unknown>): Record<string, unknown>;
export function classifyQualityRegression(baseline: Record<string, unknown>, current: Record<string, unknown>): string;
export function runQualityBenchmark(options: {
  corpus: Record<string, unknown>;
  rubric: Record<string, unknown>;
  reviews?: Array<Record<string, unknown>>;
  blindCandidateMap?: Record<string, string>;
  generatedAt?: string;
  packageVersion?: string;
  analyzerVersion?: string;
  modelVersion?: string;
  promptVersion?: string;
}): QualityBenchmarkReport;
export function renderQualityBenchmarkMarkdown(report: QualityBenchmarkReport): string;
