---
slug: understand-design-run-experience
component: client-experience
state: active
impact: alto
complexity: alta
---

# understand-design-run-experience — Make the product thesis one coherent journey

**Componente:** client-experience

## Observable outcome

The app presents Understand, Design and Run as a coherent evidence-first workflow—from repository/product onboarding through analysis, maps, decisions, plan review and ready agent work—while preserving immediate fleet control, responsive PWA behavior, accessibility and honest failure/authority states.

## Confirmed context

Core fronts must ship thin client slices while their contracts evolve; this integration front consolidates the final information architecture and recovery paths after APIs stabilize. The current application has a mature dark control-console language and should evolve from it rather than introduce a visually disconnected planning product. Terminals remain drill-down runtime detail, not the primary planning metaphor.

The accepted mobile-first direction is specified in
`docs/GUIDED_MOBILE_EXPERIENCE.md`: the horizontal modes remain global
orientation, while a vertical repository home guides the user through releases,
fronts, component ownership, runs, worktrees and sessions with canonical links
and progressive disclosure.

## ▶ Handoff

Track stable slices from product direction, intelligence and planning; do not begin with a speculative graph canvas. Test the full journey with real API states and narrow viewports. Preserve local implicit/remote paired authority distinctions and current fleet speed. The slogan is canonical product navigation/copy, not merely landing-page text. Coordinate only through client-owned files; preserve `site/` and its independent launch front.

## Checklist

- [x] 1. Define information architecture, routes and responsive navigation for Understand, Design and Run with direct fleet/session access.
- [ ] 2. Build guided repository/product/analysis onboarding that previews scope, analyzer/model capability, data boundary and manual/skip paths.
- [ ] 3. Unify job progress, awaiting-input, stale, cancelled, failed, retry, cleanup and reconnect/resume states across analysis/planning.
- [ ] 4. Build evidence/provenance/coverage/uncertainty patterns shared by map, component, front and drift details.
- [ ] 5. Build decision workspace patterns for questions, alternatives, locks, edits, conflicts, diffs and explicit publication.
- [ ] 6. Build accessible list/graph views of goals, components, fronts, dependencies, critical path, readiness, runs and drift with scalable drill-down.
- [x] 7. Connect accepted ready fronts to run preflight and runtime outcomes without implying that generated or agent-claimed state is verified.
- [ ] 8. Verify keyboard/screen-reader/focus/contrast/touch behavior, mobile PWA layouts, polling/SSE reconnect and local/remote authority parity.
- [ ] 9. Run complete browser journeys for manual, built-in analyzer, Graphify, model-assisted, failure/recovery, publication conflict and plan-to-run paths.

## Verified evidence

- **2026-08-04 · checklist 1:** `docs/GUIDED_MOBILE_EXPERIENCE.md` defines the
  accepted vertical information architecture, progressive-disclosure order,
  canonical link contract and 320px mobile baseline. The repository root now
  renders that guide; Understand, Design and Run retain direct routes; releases
  have canonical detail URLs; and repository, component, front and session
  navigation preserves browser history and normal hyperlink behavior.
- **Verification:** `npm run typecheck`, `npm run build` and the complete
  serial test suite passed (164 tests). The real Chrome journey additionally
  verified the repository-root route, canonical guide/release links, collapsed
  secondary detail, readable type, AA secondary-text contrast, keyboard focus,
  fixed mobile phase navigation, 44px targets and no horizontal overflow at
  320px.
- **2026-08-04 · checklist 7:** the exact release member links to its canonical
  front; the front now renders Release → Front → Run vertically and links its
  component owner, contextual worktree and canonical session. Run preflight,
  process state, reviewed evidence and accepted outcome remain distinct; agent
  claims are still labeled non-authoritative. The same Chrome journey verified
  this path through explicit preflight, one run, independent task/check evidence
  and outcome acceptance.
- **Load note:** an unconstrained parallel suite run saturated Chrome startup
  and two planning-fixture timeouts (161/164); the browser and planning tests
  both passed in isolation, and `npm test -- --test-concurrency=1` passed all
  164. This is test-runner resource pressure, not accepted evidence of product
  failure, and remains visible rather than being counted as a parallel green run.
- **2026-08-04 · guided Understand increment:** Understand now presents product
  intent → repository evidence → accepted work model before the derived system
  explanation. Provenance, uncertainty, exact selected-snapshot evidence and
  stale/coverage state remain explicit; analyzer IDs, raw counts, diagnostics,
  export and comparison are progressively disclosed. Mobile starts list-first,
  bounds large results, transfers/restores focus around evidence detail and is
  horizontally bounded at 320px. A route reload with a live analysis now
  reopens that same job and preserves cancellation instead of offering a
  duplicate configuration flow. Snapshot requests are sequence- and
  identity-bound; query/export cannot operate against a different visible
  snapshot; and reconciliation comparison accepts only an earlier snapshot.
  Result buttons retain their native accessible role inside semantic lists,
  link actions meet 44px and disclosures retain visible keyboard focus.
- **Verification:** `npm run typecheck`, `npm run build`, the isolated real
  Chrome smoke and `npm test -- --test-concurrency=1` passed (164/164, zero
  skips). The Chrome journey covers the three-step hierarchy, manual skip,
  exact evidence/provenance, collapsed technical/drift/learning sections,
  active-job reload/resume/cancel, two distinct snapshot identities,
  self/reverse-time comparison prevention and 320px touch/focus/overflow
  behavior.
- Items 2–6 and 8–9 remain open: these increments do not claim that every detail
  workspace has completed its guided/progressive-disclosure redesign or its
  full screen-reader and recovery audit.
