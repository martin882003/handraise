---
slug: readonly-analysis-runtime
component: repository-intelligence
state: done
impact: alto
complexity: alta
---

# readonly-analysis-runtime — Execute analyzers without touching the repository

**Componente:** repository-intelligence

## Observable outcome

Handraise can plan, start, observe, cancel and clean up a bounded analysis job over an exact repository snapshot, including selected dirty state, while automated sentinels prove that the target repository, Git index/config/hooks and ignored files remain unchanged.

## Confirmed context

The current in-process discovery scan is bounded and read-only but does not provide a general analyzer runtime, immutable private snapshots, resource/process isolation, resumable job states or rich-adapter cleanup. Graphify's normal CLI outputs cannot be allowed to land inside the target repository. This front depends on repository-intelligence-contract.

## ▶ Handoff

Implement the provider-neutral runtime before the Graphify adapter. Prefer a safe private mirror/snapshot strategy that includes explicitly selected working-tree content, blocks symlink escape and detects mid-scan changes. Do not invoke through a generated shell command. Reuse server authentication/job conventions but keep repository writes structurally unavailable to analysis workers.

## Checklist

- [x] 1. Implement scope planning with Git-aware/default exclusions, dirty/untracked selection, byte/file/time/resource budgets and a previewable manifest.
- [x] 2. Create private snapshot/mirror and output directories with restrictive permissions, stable identity and symlink/path traversal protection.
- [x] 3. Implement queued/running/awaiting-input/stale/cancelled/failed/complete job lifecycle, progress events and reconnect-safe status.
- [x] 4. Execute adapters with structured argv/environment allowlists, process-group cancellation, timeouts, output caps and deterministic cleanup.
- [x] 5. Detect files changing during capture/analysis and mark/retry the snapshot without presenting mixed evidence as coherent.
- [x] 6. Add private retention, expiry, startup recovery and immediate user deletion for snapshots, outputs, drafts and diagnostics.
- [x] 7. Expose authenticated plan/start/status/cancel/delete APIs with local-host authority gates for host-sensitive scope/provider actions.
- [x] 8. Verify byte, metadata, ignored-file, Git index/config/hook and process/artifact zero-mutation invariants across success and every failure path.
