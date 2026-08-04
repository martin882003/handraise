# Planning quality evaluation

Handraise treats a plausible-looking work model as a product risk. The quality
gate therefore tests the complete **understand → design → run-ready → reconcile**
boundary against objective invariants and independent human usefulness. Model
self-confidence, acceptance history and demo quality never count as owner
judgment.

## Versioned assets

Benchmark v1 consists of:

- [`benchmark/v1/corpus.json`](../benchmark/v1/corpus.json): ten redistributable
  synthetic cases spanning small JavaScript, polyglot, monorepo, service,
  library, legacy, sparse-documentation, misleading-layout, dirty-tree and
  adversarial repositories;
- [`benchmark/v1/rubric.json`](../benchmark/v1/rubric.json): separate
  understanding, component, front, execution, reconciliation, human and
  performance gates;
- [`benchmark/v1/BLIND_REVIEW_PROTOCOL.md`](../benchmark/v1/BLIND_REVIEW_PROTOCOL.md):
  owner/maintainer assignment and review rules;
- [`benchmark/v1/review-template.json`](../benchmark/v1/review-template.json): a
  deliberately non-gating capture template;
- [`benchmark/results/latest.md`](../benchmark/results/latest.md) and
  [`latest.json`](../benchmark/results/latest.json): the latest sanitized,
  reproducible release report.

Owner references describe facts, questions and one or more acceptable
decompositions. Agreement uses responsibility co-membership against the best
valid alternative; the benchmark does not assume that architecture has one
canonical answer.

## What the executable benchmark measures

For every case, the engine runs the actual Handraise contracts and deterministic
planning code:

1. build an immutable, selected-file-only `AnalysisSnapshot`;
2. derive the semantic system map;
3. synthesize and rank complete component alternatives;
4. synthesize and rank complete front portfolios;
5. render, parse and validate component/front schema-v2 contracts;
6. apply a declared repository/analyzer change and run architecture
   reconciliation;
7. repeat synthesis and compare semantic digests for stability.

The sanitized result records versions, digests, metrics, diagnostic codes,
phase duration, output size and non-negative heap delta. It does not retain
fixture source. Evidence references must resolve against the immutable map;
repository input is compared before and after evaluation; unsafe paths,
generated/binary content, escaping symlinks, secrets and the adversarial prompt
marker must remain absent.

The automated gate has zero tolerance for safety, evidence, mutation, schema,
security and hard-cycle failures. Scored thresholds require at least 80%
responsibility/fact coverage, 60% agreement with a valid owner decomposition,
complete front and execution contracts, no uncoordinated ownership collision,
and fixture-class performance budgets. Coordinated overlap is allowed only when
the front DAG makes the sequencing relationship explicit.

## Blind human Gate C

At least one independent repository owner or maintainer reviews every case with
candidate identity hidden. A valid review includes a boolean useful-starting-
point decision, four 1–5 ratings and rationale. The gate requires at least 80%
useful starting points and medians of four for evidence integrity, boundary
usefulness and front usefulness.

Review pseudonyms are hashed during capture. Rationale and disagreements are
retained, but repository source and the private blinded-ID mapping are not.
Passing means “useful input to human review”; it is never permission to publish
contracts or a claim of universal architectural truth.

The checked report is currently **blocked**, not passed: all automated v1 gates
pass, but no real blind owner reviews have been supplied. This is intentional
release truth, not a skipped test.

## Commands and promotion behavior

Run and write sanitized reports:

```bash
npm run benchmark
```

Run the strict release gate without writing files:

```bash
npm run benchmark:gate
```

`benchmark:gate` exits non-zero for both `fail` and `blocked`, and `prepack`
includes that command. A package therefore cannot be promoted while hard gates
fail or required owner reviews are absent.

Private reviews and the blinded mapping can be supplied without committing
either file:

```bash
HANDRAISE_BENCHMARK_REVIEWS=/private/review-1.json \
HANDRAISE_BENCHMARK_BLIND_MAP=/private/blind-map.json \
npm run benchmark:gate
```

The blind map is a JSON object such as `{ "B": "current", "A": "baseline" }`.
Multiple review paths use the host path delimiter or repeated `--reviews`
arguments when invoking the script directly.

## Regression attribution

Baseline and current candidates are evaluated from the same immutable input.
Per-case differences are classified, in precedence order, as:

- `code-evidence` — selected repository evidence changed;
- `analyzer-output` — analyzer identity/version changed;
- `inference` — the candidate set changed;
- `inference-ranking` — the same alternatives were ranked differently;
- `formatting-only` — semantic plans match but serialized contracts differ;
- `unchanged` — no observed benchmark difference.

This keeps a prompt/ranking change from being reported as code drift and keeps a
format-only change from masquerading as better planning.

## Known limits

The public corpus is synthetic and intentionally small enough for deterministic
CI. It verifies mechanics, safety and structural quality; only independent
owners can judge whether a work model is genuinely useful. Host performance
affects duration measurements. Private real-repository corpora may supplement
the public corpus through reproducible digests, but source must remain outside
the repository and outside sanitized reports.
