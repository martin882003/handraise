---
slug: plan-driven-agent-orchestration
component: runtime-worktree-control
state: done
impact: alto
complexity: alta
---

# plan-driven-agent-orchestration — Compile accepted outcomes into safe runs

**Componente:** runtime-worktree-control

## Observable outcome

Starting an accepted ready front creates an auditable run manifest, performs dependency/capability/Git/concurrency preflight, supplies the exact accepted context to a selected agent and tracks process, checks and outcome separately through safe completion or handoff.

## Confirmed context

Handraise already starts repository-scoped tmux sessions, supports Claude Code/Codex capabilities and can own worktrees. The target product must bind those mechanics to exact v2 front/component revisions and verification contracts. Generating a plan cannot start an agent or allocate a worktree; execution remains an explicit user transition.

## ▶ Handoff

Depend on accepted v2 contracts and transactional publication. Extend the current session/worktree lifecycle rather than create a second runtime. Define an immutable run manifest and readiness service first. Coordinate agent context/capability negotiation with Agent Integrations and completion evidence/checklist semantics with Repository Planning.

## Checklist

- [x] 1. Define immutable run manifest/revision, front/component/goal links, dependencies, territory, verification and agent capability schema.
- [x] 2. Implement readiness preflight for hard dependencies, stale/changed contracts, active conflicts, worktree/branch/dirty risk, agent auth and capability compatibility.
- [x] 3. Generate bounded agent context from accepted contracts/decisions/evidence with revisions and explicit unknowns, without relying on hidden prior conversation.
- [x] 4. Create/reuse worktree, branch and tmux session only after explicit start, preserving current ownership, rollback and cleanup guarantees.
- [x] 5. Track process activity, attention, permissions, user/agent checklist claims, configured checks and accepted outcome as separate states.
- [x] 6. Update checklist/front lifecycle only from user action or configured verifiable evidence with source/audit metadata.
- [x] 7. Capture discoveries, blockers, decisions, scope change and affected downstream fronts for reconciliation; support explicit cross-agent handoff/resume.
- [x] 8. Gate completion on acceptance/verification and existing ahead/dirty/local-only/branch risks; keep force/cleanup actions explicit and recoverable.
- [x] 9. Test dependency races, changed contracts, duplicate starts, capability loss, agent crash, reconnect, handoff and no-regression fleet/permission/worktree paths.
