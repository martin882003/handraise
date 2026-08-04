# Blind owner review protocol v1

The human quality gate measures whether a proposal is a useful starting point;
it does not ask whether one canonical decomposition was guessed exactly.

## Assignment

1. A coordinator freezes the corpus, rubric, candidate, analyzer, schema and
   prompt/model versions before assignments are created.
2. Each case is reviewed by at least one maintainer or repository owner who
   understands its responsibilities and change patterns. A reviewer must not
   review a case whose candidate output they produced.
3. Candidate labels are randomized (`A`, `B`, …). Product names, version labels
   and ranking order are hidden. Source/evidence remains visible because judging
   evidence integrity without it is impossible.
4. Alternative owner-authored decompositions are shown only after the initial
   rating. They are references for rationale, not answer keys.

## Questions

For each blinded proposal the reviewer records:

- `usefulStartingPoint`: could a lead begin review from this model rather than
  discard and remodel it?
- evidence integrity (1–5);
- responsibility/boundary usefulness (1–5);
- front/outcome usefulness (1–5);
- uncertainty honesty (1–5);
- harmful errors and missing responsibilities;
- which owner-authored alternative it most resembles, or why another valid
  alternative is better;
- a required free-text rationale.

“Accepted” means useful for further human review, not universal truth and not
permission to publish. Disagreement is retained; it is not averaged away as an
analyzer fact.

## Privacy and capture

Review files contain case IDs, blinded candidate IDs, ratings and rationale.
The capture command hashes the reviewer pseudonym and drops assignment metadata
that could reveal candidate identity. It never stores repository source. Private
corpora stay outside this repository and are represented only by a reproducible
manifest digest.

The checked-in `review-template.json` is non-gating. A release report remains
`blocked` until every case has the required independent review count and at
least 80% of ratings say the candidate is a useful starting point. Zero hard
safety or evidence failures is required regardless of human ratings.
