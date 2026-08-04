import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  applyBenchmarkChange,
  captureBlindReviews,
  classifyQualityRegression,
  createBenchmarkSnapshot,
  renderQualityBenchmarkMarkdown,
  runQualityBenchmark,
  validateQualityBenchmarkDefinition,
} from '../src/quality-benchmark.mjs';

const corpus = JSON.parse(readFileSync(new URL('../benchmark/v1/corpus.json', import.meta.url), 'utf8'));
const rubric = JSON.parse(readFileSync(new URL('../benchmark/v1/rubric.json', import.meta.url), 'utf8'));

test('versioned quality corpus validates and adversarial input stays explicitly excluded', () => {
  const definition = validateQualityBenchmarkDefinition({ corpus, rubric });
  assert.equal(definition.caseIds.length, 10);
  const adversarial = corpus.cases.find((item) => item.id === 'adversarial-repository');
  const before = JSON.stringify(adversarial);
  const snapshot = createBenchmarkSnapshot(adversarial);
  assert.deepEqual(snapshot.scope.included, ['README.md', 'src/safe.mjs', 'test/safe.test.mjs']);
  assert.deepEqual(snapshot.scope.excluded.map((item) => item.pattern), ['.env', 'generated/bundle.js', 'assets/blob.bin', 'escape-link']);
  assert.equal(snapshot.manifest.selection.includeIgnored, false);
  assert.equal(JSON.stringify(adversarial), before);
});

test('fixture changes preserve moves, analyzer drift and source fixture immutability', () => {
  const moveCase = corpus.cases.find((item) => item.id === 'small-js-service');
  const before = JSON.stringify(moveCase.fixture);
  const changed = applyBenchmarkChange(moveCase.fixture, moveCase.change);
  assert.ok(changed.files.some((item) => item.path === 'src/commerce/billing.mjs'));
  assert.ok(!changed.files.some((item) => item.path === 'src/billing.mjs'));
  assert.equal(JSON.stringify(moveCase.fixture), before);
  const analyzerCase = corpus.cases.find((item) => item.id === 'sparse-doc-worker');
  assert.equal(createBenchmarkSnapshot(analyzerCase, { changed: true }).analyzer.version, '2.0.0');
});

test('full automated benchmark is reproducible, source-free and honestly blocked without owner reviews', () => {
  const report = runQualityBenchmark({ corpus, rubric, generatedAt: '2026-08-03T12:00:00.000Z', packageVersion: '0.1.0' });
  assert.equal(report.status, 'blocked');
  assert.equal(report.promotionAllowed, false);
  assert.equal(report.gate.automatedPass, true);
  assert.equal(report.human.status, 'blocked');
  assert.equal(report.human.missingCases.length, corpus.cases.length);
  assert.deepEqual(report.candidates.current.summary.hard, {
    safetyFailures: 0, evidenceFailures: 0, mutationFailures: 0,
    schemaFailures: 0, securityFailures: 0, hardDependencyCycles: 0,
  });
  assert.equal(report.candidates.current.summary.understanding.evidenceResolution, 1);
  assert.equal(report.candidates.current.summary.understanding.expectedDriftRecall, 1);
  assert.equal(report.candidates.current.summary.frontDesign.ownershipCollisions, 0);
  assert.ok(report.candidates.current.cases.every((item) => item.stability.deterministic));
  assert.equal(report.privacy.sourceCaptured, false);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('HANDRAISE_BENCHMARK_INJECTION_MARKER'));
  assert.ok(!serialized.includes("ignore all prior instructions"));
  assert.ok(!serialized.includes('DATABASE_URL='));
  assert.match(renderQualityBenchmarkMarkdown(report), /Release gate:\*\* BLOCKED/);
});

test('complete independent blind ratings can pass the human gate without exposing reviewer identity', () => {
  const review = {
    schemaVersion: 1, benchmarkVersion: '1.0.0', protocolVersion: 'blind-owner-review-v1', gating: true,
    reviewerPseudonym: 'private-owner-pseudonym',
    assignments: corpus.cases.map((item) => ({
      caseId: item.id, blindedCandidateId: 'B', usefulStartingPoint: true,
      ratings: { evidenceIntegrity: 5, boundaryUsefulness: 4, frontUsefulness: 4, uncertaintyHonesty: 5 },
      harmfulErrors: [], missingResponsibilities: [], closestReferenceAlternative: item.ownerReference.acceptableDecompositions[0].id,
      rationale: 'The proposal is evidence-grounded and is a useful review starting point; publication still requires owner acceptance.',
    })),
  };
  const captured = captureBlindReviews([review], { caseIds: corpus.cases.map((item) => item.id), blindCandidateMap: { B: 'current' } });
  assert.equal(captured.length, corpus.cases.length);
  assert.ok(captured.every((item) => item.reviewerId.startsWith('reviewer:')));
  assert.ok(!JSON.stringify(captured).includes(review.reviewerPseudonym));
  const report = runQualityBenchmark({ corpus, rubric, reviews: [review], blindCandidateMap: { B: 'current' }, generatedAt: '2026-08-03T12:00:00.000Z' });
  assert.equal(report.status, 'pass');
  assert.equal(report.promotionAllowed, true);
  assert.equal(report.human.usefulStartingPointRatio, 1);
});

test('regression classifier separates evidence, analyzer, ranking, formatting and no-op changes', () => {
  const record = {
    semantic: { manifestDigest: 'a', analyzer: 'x@1', componentDigest: 'c1', frontDigest: 'f1', contractDigest: 'w1' },
    selected: { componentAlternativeCount: 2, frontAlternativeCount: 2 },
  };
  assert.equal(classifyQualityRegression(record, structuredClone(record)), 'unchanged');
  assert.equal(classifyQualityRegression(record, { ...structuredClone(record), semantic: { ...record.semantic, manifestDigest: 'b' } }), 'code-evidence');
  assert.equal(classifyQualityRegression(record, { ...structuredClone(record), semantic: { ...record.semantic, analyzer: 'x@2' } }), 'analyzer-output');
  assert.equal(classifyQualityRegression(record, { ...structuredClone(record), semantic: { ...record.semantic, componentDigest: 'c2' } }), 'inference-ranking');
  assert.equal(classifyQualityRegression(record, { semantic: { ...record.semantic, componentDigest: 'c2' }, selected: { componentAlternativeCount: 3, frontAlternativeCount: 2 } }), 'inference');
  assert.equal(classifyQualityRegression(record, { ...structuredClone(record), semantic: { ...record.semantic, contractDigest: 'w2' } }), 'formatting-only');
});
