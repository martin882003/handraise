#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { renderQualityBenchmarkMarkdown, runQualityBenchmark } from '../src/quality-benchmark.mjs';

function usage() {
  return `Usage: node scripts/quality-benchmark.mjs [options]

Options:
  --corpus <path>       Versioned corpus JSON (default benchmark/v1/corpus.json)
  --rubric <path>       Versioned rubric JSON (default benchmark/v1/rubric.json)
  --reviews <path>      Private blind-review JSON; repeatable
  --blind-map <path>    Private JSON map from blinded IDs to baseline/current
  --json <path>         Sanitized JSON report path
  --markdown <path>     Human-readable report path
  --gate                Exit non-zero unless all automated and human gates pass
  --no-write            Evaluate without writing report files
  --help                Show this help

HANDRAISE_BENCHMARK_REVIEWS may contain review paths separated by the platform
path delimiter. HANDRAISE_BENCHMARK_BLIND_MAP may point to the private blind map.
`;
}

function parseArgs(argv) {
  const value = {
    corpus: 'benchmark/v1/corpus.json', rubric: 'benchmark/v1/rubric.json', reviews: [],
    blindMap: null, json: 'benchmark/results/latest.json', markdown: 'benchmark/results/latest.md',
    gate: false, write: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') { process.stdout.write(usage()); process.exit(0); }
    if (option === '--gate') { value.gate = true; continue; }
    if (option === '--no-write') { value.write = false; continue; }
    const key = ({ '--corpus': 'corpus', '--rubric': 'rubric', '--blind-map': 'blindMap', '--json': 'json', '--markdown': 'markdown' })[option];
    if (key) {
      if (!argv[index + 1]) throw new Error(`${option} needs a path`);
      value[key] = argv[index += 1]; continue;
    }
    if (option === '--reviews') {
      if (!argv[index + 1]) throw new Error('--reviews needs a path');
      value.reviews.push(argv[index += 1]); continue;
    }
    throw new Error(`unknown option '${option}'`);
  }
  return value;
}

function json(path) { return JSON.parse(readFileSync(resolve(path), 'utf8')); }

function atomicWrite(pathValue, contents) {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  renameSync(temporary, path);
}

function environmentReviewPaths() {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return String(process.env.HANDRAISE_BENCHMARK_REVIEWS || '').split(delimiter).map((item) => item.trim()).filter(Boolean);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const packageRecord = json('package.json');
  const corpus = json(options.corpus);
  const rubric = json(options.rubric);
  const reviewPaths = [...new Set([...options.reviews, ...environmentReviewPaths()])];
  const reviews = reviewPaths.map(json);
  const blindMapPath = options.blindMap || process.env.HANDRAISE_BENCHMARK_BLIND_MAP;
  const blindCandidateMap = blindMapPath ? json(blindMapPath) : {};
  const report = runQualityBenchmark({ corpus, rubric, reviews, blindCandidateMap, packageVersion: packageRecord.version });
  if (options.write) {
    atomicWrite(options.json, `${JSON.stringify(report, null, 2)}\n`);
    atomicWrite(options.markdown, renderQualityBenchmarkMarkdown(report));
  }
  process.stdout.write(`Handraise benchmark ${report.benchmarkVersion}: ${report.status.toUpperCase()}\n`);
  process.stdout.write(`Automated gate: ${report.gate.automatedPass ? 'PASS' : 'FAIL'}; human gate: ${report.human.status.toUpperCase()}; promotion: ${report.promotionAllowed ? 'ALLOWED' : 'BLOCKED'}\n`);
  if (report.human.status === 'blocked') process.stdout.write(`Missing blind reviews: ${report.human.missingCases.join(', ')}\n`);
  if (options.write) process.stdout.write(`Reports: ${resolve(options.json)} and ${resolve(options.markdown)}\n`);
  if (options.gate && !report.promotionAllowed) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`quality benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
}
