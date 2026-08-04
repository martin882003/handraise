# Guided mobile experience

**Status:** accepted UX direction; implementation is incremental

**Front:** `.handraise/fronts/understand-design-run-experience.md`

## Product decision

Understand, Design and Run remain the three global orientations, but they are
not the user's only navigation model. Opening a repository starts at a guided,
vertical home that answers, in order:

1. What should I do next?
2. What coherent release am I trying to deliver?
3. Which fronts produce that outcome and which components own them?
4. Which run, worktree and agent session currently execute each front?
5. What needs my attention?

The default view must not expose implementation revisions, raw paths, analyzer
internals, complete contract schemas or every available command. Those remain
reachable through progressive detail.

## User-facing work graph

The primary delivery chain is:

```text
Product intent and evidence
          ↓
Release — the coherent increment being committed
          ↓
Front — one planned outcome slice
          ├── Component — durable owner and responsibility boundary
          ↓
Run — reviewed execution of the accepted front
          ├── Worktree — isolated Git workspace
          └── Session — live agent process and interaction
```

Components are linked owners, not children of a release. Sessions are processes,
not progress. Worktrees are execution resources, not units of planning. The UI
must preserve those distinctions while making every relationship directly
navigable.

## Information architecture

### Repository home — vertical guide

`/repositories/:repositoryId`

- One recommended next action with a plain-language consequence.
- A compact Understand → Design → Run path with current counts and one entry
  action per stage.
- The current/open release and its member fronts.
- For each visible front, contextual links to its lead component, worktree and
  live session when they exist.
- Compact browse links for all components, fronts, releases, worktrees and
  sessions. Long inventories are collapsed or truncated by default.
- Attention and unsafe state precede healthy activity.

### Understand

`/repositories/:repositoryId/map`

Starts with product intent, snapshot availability and the system explanation.
Analyzer, provenance, coverage and source evidence are progressively disclosed.

### Design

`/repositories/:repositoryId/components`

Starts with the accepted work model and the next planning decision. Components
and fronts are linkable entities. Model selection, publication internals,
migration and legacy Director controls are secondary actions.

### Run

- `/repositories/:repositoryId/releases`
- `/repositories/:repositoryId/releases/:releaseSlug`
- `/repositories/:repositoryId/ad-hoc`
- `/repositories/:repositoryId/sessions/:sessionSlug`

The release is the planned delivery authority. A front links to its run; a run
links to its worktree and session. Ad-hoc work remains visibly outside release
progress.

## Progressive disclosure

Every screen follows this order:

1. Outcome and current state.
2. One safe primary action.
3. Related entities as real links.
4. Blockers and recovery.
5. Evidence and verification.
6. Technical identity, revisions, paths and raw diagnostics behind disclosure.

Empty states teach the next concept instead of presenting a blank dashboard.
Dangerous or authority-crossing actions remain explicit and are never hidden by
simplification.

## Hyperlink contract

- Repository, release, component, front and session have canonical URLs.
- Relationship labels are links when a target exists; text styled like a link
  must never be inert.
- Back navigation follows the conceptual parent: session/worktree/run → front,
  front → component, component/release → repository home.
- The Handraise brand returns to the repository chooser.
- Browser open-in-new-tab, copy-link and history navigation must keep working.
- Missing or stale targets render an honest disabled relationship with recovery,
  not a dead link.

## Mobile-first interaction contract

- The base layout is a single vertical column from 320 CSS pixels upward;
  wider grids are enhancements.
- Understand, Design and Run remain reachable from a thumb-friendly persistent
  mobile navigation bar with safe-area padding.
- Primary actions have at least a 44 × 44 CSS-pixel target.
- No core operation depends on hover, a wide table, drag-only interaction or a
  terminal-sized viewport.
- Dense tables have card/list alternatives, and technical content wraps or
  scrolls inside its own bounded region without widening the page.
- Context and in-progress form state survive ordinary navigation and reconnect
  wherever the owning backend contract supports resumption.
- Desktop and mobile expose the same authority and safety decisions; mobile is
  not a read-only monitor.

## First implementation increment

The first verified slice delivers the repository home, canonical release links,
contextual links across current release/front/component/worktree/session state,
repository-home back navigation, simplified Design actions and persistent mobile
phase navigation. It does not claim that every existing detail screen has
completed its progressive-disclosure redesign.

## Second implementation increment

The second verified slice carries that model into the first operational detail
path:

- global Understand, Design and Run navigation and the Run workspace switcher
  are real canonical links rather than button-only client state;
- release membership links to the exact front URL, and component front lists use
  the same canonical targets;
- a front explains Release → Front → Run vertically and links its component
  owner, worktree context and agent session without presenting process activity
  as progress;
- component mutations, accepted front context/handoff, run manifest/workspace
  identity, run evidence and raw Git path/cleanup are progressively disclosed;
- an awaiting-acceptance run opens verification evidence because that is then
  the primary task, while active process views can lead with process status and
  the session action;
- this context remains single-column, touch-safe and horizontally bounded at
  the 320px baseline.

Map internals, planning dialogs, reconciliation, the complete session surface
and ad-hoc evidence still require the same simplification pass before the whole
experience can claim progressive-disclosure completion.

## Third implementation increment

The third verified slice makes Understand a guided evidence review instead of
opening directly on analyzer and graph internals:

- product intent, repository evidence and the accepted work model appear as
  three explicitly different kinds of knowledge, with one contextual next
  action and an always-available manual Design path;
- an active analysis is recognized after a route reload and reopens the same
  resumable job rather than presenting configuration for a duplicate job;
  interrupted/retryable jobs remain recoverable even if the analyzer catalog is
  unavailable, and awaiting-input polling becomes quiescent with an explicit
  fresh-scope recovery path;
- the system explanation labels every hypothesis with provenance, uncertainty
  and evidence count, and exact evidence opens with its selected-snapshot
  location while opaque IDs remain technical detail;
- freshness, coverage gaps and accepted-versus-derived authority stay visible,
  while snapshot IDs, raw counts, export, diagnostics and comparison move
  behind one technical disclosure;
- mobile Understand starts with the accessible list alternative, caps large
  result sets, moves focus into selected evidence detail and restores it on
  return, with no horizontal overflow at the 320px baseline;
- snapshot loads and queries are identity-bound and sequenced, so a late or
  failed response cannot leave snapshot A visible while query/export acts on B;
  comparison permits only a genuinely earlier snapshot and rejects self or
  reverse-time reconciliation;
- architecture drift and outcome learning remain reachable but collapsed until
  they are the user's primary task.

The isolated real-Chrome journey verifies the exact-evidence path, disclosure
defaults, semantic list/button roles, 44px link actions, two-snapshot identity
and comparison ordering, 320px list/focus behavior and active-job
resume/cancellation. The complete serial suite remains the resource-safe full
validation mode. Planning decisions, the complete session surface and ad-hoc
evidence still need their own guided cuts before the overall front can be called
complete.
