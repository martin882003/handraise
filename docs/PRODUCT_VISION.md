# Handraise product vision

**Status:** accepted product direction

**Canonical slogan:** **Understand the system. Design the work. Run the agents.**

**Last reviewed:** 2026-08-03

## Product thesis

Coding agents make implementation faster, but they do not decide what the right
units of work are. Worktrees reduce file collisions; they do not repair a bad
decomposition of the system, unclear product intent, overlapping ownership or a
front that cannot be verified.

Handraise is the local control plane that turns a software system and its
product intent into a reviewable work model, then safely runs coding agents
against that model.

Its core value is not “many terminals in one screen”. That is necessary runtime
infrastructure. The differentiated product is the closed loop:

```text
repository + history + product intent
                  ↓
       evidence-backed system map
                  ↓
     durable component architecture
                  ↓
       outcome-oriented front graph
                  ↓
       coherent release contract
                  ↓
       agents + worktrees + controls
                  ↓
       verified outcomes and drift
                  └───────────────↺
```

## The three promises

### 1. Understand the system

Handraise inspects the repository without changing it, combines structural
analysis with documentation and history, and builds a semantic map with
traceable evidence, provenance, coverage and uncertainty. It explains what is
observed in the code; it does not pretend that code alone reveals product
intent.

### 2. Design the work

Handraise combines that observed system with the user's declared outcomes,
constraints and non-goals. It proposes durable components, alternative
boundaries and executable fronts. The human can question, edit, split, merge,
regenerate or reject every proposal before anything becomes repository state.

### 3. Run the agents

Once the work model is accepted, Handraise turns it into dependency-aware agent
sessions and isolated worktrees, exposes permissions and attention, and keeps
execution tied to the accepted outcome and verification contract. Results feed
new evidence into the next planning cycle; they never silently rewrite intent.

## Product category and wedge

Handraise is an **agentic software workbench**: product modeling, architecture
understanding, work planning and local agent operations in one product.

The initial wedge remains useful by itself: a trustworthy local fleet console
for Claude Code and Codex. The durable advantage comes from placing that console
downstream of a better model of the product and its codebase.

## Canonical product truths

Handraise keeps five kinds of truth distinct:

1. **Observed truth** — facts extracted or inferred from source, configuration,
   tests, documentation and history.
2. **Declared truth** — users, desired outcomes, constraints, non-goals,
   terminology and priorities supplied or accepted by a human.
3. **Proposed truth** — generated maps, component alternatives and front plans
   that remain drafts.
4. **Accepted truth** — versioned, human-readable contracts committed to the
   repository.
5. **Execution truth** — sessions, worktrees, changes, checks, discoveries and
   outcomes seen at runtime.

No generated inference may silently cross from proposed truth into accepted
truth. No runtime observation may silently change declared intent.

## Primary users and jobs

- A technical founder needs to turn an evolving product idea and repository
  into a coherent sequence of work without becoming a full-time coordinator.
- A tech lead needs to expose architecture, ownership and dependencies before
  dispatching parallel agents.
- An individual developer needs a useful decomposition and safe execution loop
  without installing a cloud platform or surrendering provider credentials.
- A team adopting agents needs an auditable answer to: what is being changed,
  why, by whom, against which contract, and how will it be verified?

## End-to-end product journey

1. Connect or initialize one or more repositories.
2. State or import the product brief: users, outcomes, constraints, non-goals
   and current priorities.
3. Choose a bounded, read-only analysis; see exactly which sources and optional
   model providers will be used.
4. Explore the system map, its coverage, evidence, uncertainty and stale areas.
5. Compare proposed component architectures and resolve questions or conflicts.
6. Edit and accept a set of durable component contracts, or skip and author
   them manually.
7. Ask Handraise to turn a goal into fronts with one lead component, affected
   components, dependencies, acceptance criteria, verification and risks.
8. Review the complete plan as a graph and publish it transactionally.
9. Assemble ready fronts and their requirements, verification and compatibility
   obligations into a coherent release contract.
10. Start only ready fronts; Handraise creates or reuses safe worktrees and agent
   sessions with the right context.
11. Resolve attention and permissions, inspect terminals when needed, and track
    observable outcomes rather than merely process activity.
12. Reconcile code, contracts and execution evidence; review suggested updates
    and replan without losing human decisions.

## Core domain definitions

- **Product brief:** the accepted statement of users, outcomes, constraints,
  non-goals, terminology and priorities that code cannot provide.
- **System map:** a derived, replaceable analysis snapshot of entities,
  relationships, responsibilities, evidence and uncertainty.
- **Component:** a durable product or platform responsibility with explicit
  boundaries, interfaces, invariants, dependencies and territory. It is not a
  folder, worktree or temporary project.
- **Front:** a temporary, observable outcome with one lead component, zero or
  more affected components, dependencies, acceptance criteria and verification.
- **Release:** the accepted unit of delivery and commitment. It selects exact
  requirement/front revisions, defines one shippable outcome, compatibility and
  non-functional gates, and records candidate/released evidence. It is not a
  synonym for a front or a version label added after implementation.
- **Run:** the execution record that binds an accepted front to agent sessions,
  worktrees, changes, checks and decisions.
- **Ad-hoc run:** explicitly unplanned work with a declared purpose and safety
  boundary but no front or release membership. It remains separate from release
  progress and can only propose planned work through human review.
- **Drift:** a material mismatch between observed code, accepted contracts,
  declared intent or execution truth.

## Product principles

1. **Evidence before confidence.** Every important claim links back to current
   repository evidence and identifies whether it was extracted, inferred or
   supplied by a human.
2. **Human acceptance is a state transition.** Review is not decorative; until
   acceptance, proposals cannot mutate repository planning state.
3. **Components follow responsibilities.** Directory layout is evidence, not
   the decomposition algorithm.
4. **Outcomes precede agents.** Work is modeled before a worktree or session is
   allocated. Explicitly ad-hoc work is allowed, but is never retroactively
   presented as planned delivery.
5. **Local-first is a trust boundary.** Analysis stays local by default and any
   source transfer to a model is explicit, scoped and attributable.
6. **Derived state is disposable.** Graphs and caches can be regenerated;
   accepted intent and contracts remain readable and versionable.
7. **Uncertainty is a product state.** Missing coverage, conflicts and open
   questions are shown, not hidden behind a synthetic confidence score.
8. **Automation remains interruptible.** Long analysis, planning and execution
   operations expose progress, cancellation and recoverable failure.
9. **Compatibility is honest.** Director repositories use Director contracts;
   native Handraise repositories use Handraise contracts; neither is silently
   approximated as the other.
10. **Suggestions do not become governance.** Handraise can recommend structure
    and work, while people retain authorship and accountability.

## Non-goals

- Replacing Git, terminals, Claude Code or Codex.
- Treating an LLM-generated architecture as authoritative.
- Uploading an entire repository without explicit user choice.
- Making one component per directory or one front per worktree.
- Automatically starting costly or destructive agent work merely because a
  plan was generated.
- Becoming a general issue tracker, hosted source forge or autonomous product
  manager disconnected from repository evidence.
- Requiring Graphify or any single analyzer/provider for core operation.

## North-star outcome

For a real repository and a stated product goal, a user can reach an accepted,
evidence-backed component and front plan that they judge useful, then run its
ready work safely and reconcile the result—without Handraise making an
unreviewed repository mutation.

The product is complete only when all three promises work as one loop. A good
map without executable fronts is a visualization tool. A good plan without safe
runtime is a document generator. A fleet console without a good work model is a
terminal dashboard.
