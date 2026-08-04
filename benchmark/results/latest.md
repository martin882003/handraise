# Handraise planning quality benchmark 1.0.0

**Release gate:** BLOCKED · **Promotion allowed:** no

Generated 2026-08-04T00:11:34.087Z. Corpus 1.0.0; protocol blind-owner-review-v1; package 0.1.0.

## Gate summary

| Dimension | Result |
| --- | ---: |
| Evidence resolution | 100% |
| Required fact coverage | 100% |
| Expected drift recall | 100% |
| Responsibility coverage | 100% |
| Best valid decomposition agreement | 97% |
| Complete fronts | 100% |
| Valid contract portfolios | 100% |
| Hard failures | 0 |
| Performance budget failures | 0 |
| Blind human reviews | 0 (blocked) |

## Baseline → current regressions

- code-evidence: 0
- analyzer-output: 0
- inference: 0
- inference-ranking: 10
- formatting-only: 0
- unchanged: 0

## Limitations

- The checked-in corpus is synthetic and cannot substitute for independent repository-owner review.
- Automated structural agreement accepts multiple owner-authored decompositions but does not prove responsibility usefulness.
- Performance measurements depend on the host and are evaluated against fixture-class budgets.
- Human Gate C is blocked: 10 case(s) lack the required independent blind review.

## Per-case current results

| Case | Components | Fronts | Coverage | Agreement | Drift recall | Hard failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small-js-service | 3 | 3 | 100% | 100% | 100% | 0 |
| polyglot-platform | 2 | 3 | 100% | 100% | 100% | 0 |
| monorepo-commerce | 5 | 3 | 100% | 100% | 100% | 0 |
| service-collection-logistics | 5 | 3 | 100% | 100% | 100% | 0 |
| library-rendering | 4 | 3 | 100% | 100% | 100% | 0 |
| legacy-backoffice | 3 | 3 | 100% | 100% | 100% | 0 |
| sparse-doc-worker | 4 | 3 | 100% | 70% | 100% | 0 |
| misleading-layer-folders | 2 | 3 | 100% | 100% | 100% | 0 |
| dirty-feature-branch | 2 | 3 | 100% | 100% | 100% | 0 |
| adversarial-repository | 2 | 3 | 100% | 100% | 100% | 0 |

This report contains metrics, digests and anonymized reviewer rationale only; repository source is not captured.
