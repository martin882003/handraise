import type { AnalysisSnapshot, GraphQuery, GraphQueryResult } from './contracts.mjs';

export function queryAnalysisSnapshot(snapshot: AnalysisSnapshot | unknown, query: GraphQuery | unknown): GraphQueryResult;
export function createSnapshotQuery(snapshot: AnalysisSnapshot | unknown): Readonly<{
  snapshot: AnalysisSnapshot;
  query(query: Omit<GraphQuery, 'snapshotId'> & { snapshotId?: string }): GraphQueryResult;
}>;
