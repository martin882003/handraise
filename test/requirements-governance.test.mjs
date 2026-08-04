import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const catalogFiles = [
  'docs/FUNCTIONAL_REQUIREMENTS.md',
  'docs/PRODUCT_REQUIREMENTS.md',
];

const nonBehaviorPrefixes = new Set(['GAP', 'TEST', 'DEC', 'QOS']);

function catalogIds() {
  const ids = [];
  for (const path of catalogFiles) {
    for (const match of read(path).matchAll(/\*\*([A-Z][A-Z0-9-]*-\d+)\b/g)) {
      const id = match[1];
      if (!nonBehaviorPrefixes.has(id.split('-')[0])) ids.push(id);
    }
  }
  return ids;
}

function expandReferences(markdown) {
  const ids = [];
  for (const match of markdown.matchAll(/`([A-Z][A-Z0-9-]*)-(\d+)(?:\.\.(\d+))?`/g)) {
    const [, prefix, startText, endText] = match;
    const start = Number(startText);
    const end = endText ? Number(endText) : start;
    const width = startText.length;
    for (let value = start; value <= end; value += 1) {
      ids.push(`${prefix}-${String(value).padStart(width, '0')}`);
    }
  }
  return ids;
}

test('every canonical functional requirement has exactly one accountable component', () => {
  const ids = catalogIds();
  assert.equal(new Set(ids).size, ids.length, 'canonical requirement IDs must be unique');

  const ownership = expandReferences(read('docs/COMPONENT_REQUIREMENTS.md'));
  const counts = new Map();
  for (const id of ownership) counts.set(id, (counts.get(id) || 0) + 1);

  const missing = ids.filter((id) => !counts.has(id));
  const duplicated = ids.filter((id) => counts.get(id) !== 1);
  assert.deepEqual(missing, [], `requirements missing component ownership: ${missing.join(', ')}`);
  assert.deepEqual(duplicated, [], `requirements with ambiguous ownership: ${duplicated.join(', ')}`);
});

test('the ownership index names exactly the seven accepted components', () => {
  const markdown = read('docs/COMPONENT_REQUIREMENTS.md');
  const actual = [...markdown.matchAll(/\*\*Component:\*\* `([^`]+)`/g)].map((match) => match[1]).sort();
  const expected = [
    'agent-integrations',
    'client-experience',
    'local-platform-trust',
    'product-direction',
    'repository-intelligence',
    'repository-planning',
    'runtime-worktree-control',
  ];
  assert.deepEqual(actual, expected);
});

test('Release 0 is a bounded component-owned contract with explicit executable cases', () => {
  const markdown = read('docs/RELEASE_0_DOGFOOD.md');
  const functional = [...markdown.matchAll(/^- \[[ x]\] \*\*(R0-(?:LPT|RPL|AIN|RUN|CUX)-\d+)\b/gm)].map((match) => match[1]);
  const cases = [...markdown.matchAll(/^- \[[ x]\] \*\*(R0-T\d+)\b/gm)].map((match) => match[1]);

  assert.equal(new Set(functional).size, functional.length, 'Release 0 functional IDs must be unique');
  assert.equal(new Set(cases).size, cases.length, 'Release 0 case IDs must be unique');
  assert.ok(functional.length >= 20, 'Release 0 must specify the complete core journey, not one happy path');
  assert.equal(cases.length, 12, 'Release 0 must retain its twelve executable acceptance cases');
  assert.match(markdown, /\*\*Status:\*\* not ready/);
});

test('checked Release 0 items have requirement-linked executable tests and evidence', () => {
  const release = read('docs/RELEASE_0_DOGFOOD.md');
  const checked = [...release.matchAll(/^- \[x\] \*\*(R0-[A-Z0-9-]+)\b/gm)].map((match) => match[1]);
  const testSources = [
    'test/ad-hoc-runs-api.test.mjs',
    'test/ad-hoc-runs.test.mjs',
    'test/auth-config.test.mjs',
    'test/browser-smoke.test.mjs',
    'test/handraise.test.mjs',
    'test/releases-api.test.mjs',
    'test/releases.test.mjs',
    'test/run-orchestration-api.test.mjs',
    'test/run-orchestration.test.mjs',
    'test/work-contracts.test.mjs',
  ].map(read).join('\n');

  assert.ok(checked.length > 0, 'verified Release 0 progress must remain evidence-backed');
  for (const id of checked) {
    assert.match(testSources, new RegExp(`\\[${id}\\]`), `${id} must be named by an executable test`);
    assert.match(release, new RegExp(`\\*\\*${id.replaceAll('-', '\\-')}\\s*\\/|\\/\\s*${id.replaceAll('-', '\\-')}|${id.replaceAll('-', '\\-')}\\s*·`), `${id} must have a dated evidence entry`);
  }
});

test('non-functional requirements use unique measurable gate IDs', () => {
  const markdown = read('docs/NON_FUNCTIONAL_REQUIREMENTS.md');
  const ids = [...markdown.matchAll(/\*\*((?:PERF|SCALE|REL|SEC|A11Y|COMPAT|OBS)-\d+)\b/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'non-functional requirement IDs must be unique');
  for (const prefix of ['PERF', 'SCALE', 'REL', 'SEC', 'A11Y', 'COMPAT', 'OBS']) {
    assert.ok(ids.some((id) => id.startsWith(`${prefix}-`)), `${prefix} requirements must exist`);
  }
  assert.match(markdown, /10 connected repositories/);
  assert.match(markdown, /1,000 fronts/);
  assert.match(markdown, /20 managed sessions/);
  assert.match(markdown, /5 authenticated clients/);
});
