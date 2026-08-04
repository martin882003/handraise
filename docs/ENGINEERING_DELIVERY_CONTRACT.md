# Handraise engineering delivery contract

**Status:** accepted working method

**Effective:** 2026-08-04

Handraise is developed requirements-first and released as complete vertical
slices. A module, route, dialog or test file existing is not evidence that a
product requirement is complete.

## The invariant

Every released behavior must be traceable in both directions:

```text
component
  -> requirement
  -> observable acceptance criteria
  -> required test cases
  -> implementation
  -> recorded evidence
  -> release gate
```

The inverse must also hold: production behavior that cannot be traced to an
accepted requirement is either removed, hidden behind an explicit experimental
capability, or brought into the contract before release.

## Canonical sources

The sources have distinct jobs and must not silently duplicate each other:

1. `PRODUCT_VISION.md` defines the product thesis, boundaries and north-star
   outcome.
2. `FUNCTIONAL_REQUIREMENTS.md` and `PRODUCT_REQUIREMENTS.md` contain the
   canonical behavior statements and stable requirement IDs.
3. `COMPONENT_REQUIREMENTS.md` assigns every behavior to one accountable
   component and identifies collaborators.
4. `NON_FUNCTIONAL_REQUIREMENTS.md` defines measurable performance, scale,
   reliability, security, privacy, accessibility and operability constraints.
5. A release contract, beginning with `RELEASE_0_DOGFOOD.md`, selects an
   end-to-end subset and defines its executable gate.
6. `.handraise/fronts/*.md` records implementation progress. A checked front
   item is evidence only when its required result was actually verified.

`GAP-*` entries are historical gap aliases, `DEC-*` entries are decisions and
`TEST-*` entries are legacy verification reminders. They do not count as
independent product behaviors. `QOS-*` entries are superseded by the measurable
non-functional contract while their IDs remain as compatibility references.

## Requirement record

Before implementation begins for a release, each selected requirement must
record all of the following:

- stable ID and one accountable component;
- one user- or system-observable statement, including negative behavior;
- preconditions and supported capability/environment boundary;
- acceptance criteria with no subjective “works correctly” language;
- required test cases and test levels;
- non-functional budgets that apply to the behavior;
- dependencies and compatibility obligations;
- implementation status and exact verification evidence.

Large conjunctions are split. If one part can fail while the rest passes, they
are separate acceptance criteria or separate requirements.

## Status model

Requirements move only through these states:

1. **proposed** — captured but not accepted into a release;
2. **accepted** — behavior and acceptance criteria are agreed;
3. **test-defined** — required positive, negative and recovery tests exist and
   fail for the expected reason when implementation is absent or defective;
4. **implemented** — production code exists, but release evidence is incomplete;
5. **verified** — every required test passes under the declared profile and the
   evidence is recorded;
6. **released** — the complete release gate passed from a reproducible source
   revision and artifact.

A Markdown checkmark may represent only **verified** or **released**. Existing
legacy checkmarks are implementation-audit claims until revalidated under this
contract; they cannot promote a release.

## Test obligations

Every requirement declares the smallest sufficient combination of these test
levels. “Unit tested” is not a blanket waiver for integration behavior.

| Level | What it proves |
|---|---|
| Unit | Pure rules, parsing, validation, state transitions and bounded failure behavior. |
| Contract/schema | Round trips, compatibility, unknown-field preservation and provider/adapter boundaries. |
| Integration/API | Authentication, persistence, side effects, idempotency and cross-component behavior. |
| Browser/accessibility | The real user path, keyboard/focus semantics, responsive states, offline/error recovery and honest copy. |
| Real process | Actual Git, tmux and supported CLI behavior; mocks do not satisfy the final process gate. |
| Security/adversarial | Host/origin spoofing, injection, unsafe paths, symlinks, stale identity, secret and privilege boundaries. |
| Performance/load | Latency, throughput, payload and resource budgets at the supported envelope. |
| Scale/soak | Bounded growth, reconnect storms, long-running stability and cleanup under the declared envelope. |
| Crash/recovery | Restart, interruption, partial I/O, lock recovery and no-corruption guarantees. |
| Upgrade | Old repository/state/artifact compatibility and explicit migrations without implicit overwrite. |
| Dogfood acceptance | A real supported agent completes a real Handraise front in the Handraise repository through the product UI/API. |

Tests use stable case IDs and name the requirements they cover. A release gate
must reject missing test references, skipped/todo tests, quarantined failures,
stale snapshots and evidence produced from a different source revision.

## Release rules

1. One release has one observable end-to-end outcome and a bounded supported
   envelope.
2. All selected functional and non-functional requirements are accepted before
   feature implementation expands.
3. Required tests are defined before the implementation is called complete.
4. The release is not ready while any selected requirement is merely
   implemented, any required test is absent/skipped, or the dogfood path fails.
5. The full prior release gate runs unchanged. A new slice may add capability;
   it may not weaken an earlier invariant or silently change its support bound.
6. Incomplete future slices are not mixed into the default journey. They remain
   absent or explicitly experimental, with truthful limits and no accepted-state
   mutation beyond their verified boundary.
7. A release is built and tested from the exact candidate artifact, not from a
   development server with stale in-memory code.
8. “100%” always means 100% of the named release contract, never 100% of an
   open-ended product vision.

## Current audit truth

As of 2026-08-04, the repository has broad implementation and many tests, but it
does not yet satisfy this contract:

- the baseline catalog marks all 152 entries checked without a requirement-to-
  test evidence matrix;
- the end-state catalog has 131 entries, including functional and quality
  requirements, but checked implementation slices are not equivalent to an
  integrated user journey;
- the planning benchmark measures deterministic synthetic fixtures and has
  useful latency/resource budgets, but it is not an application load, scale or
  soak test and its blind-owner gate is still incomplete;
- the default browser journey cannot yet take the current Handraise repository
  from an existing accepted front through a verified run without compatibility
  and workflow gaps.

Therefore no end-state percentage is currently asserted. The next valid
completion claim is Release 0: the dogfood core.
