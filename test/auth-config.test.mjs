import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PairingAuth } from '../src/auth.mjs';
import { agentInvocation, ConfigStore } from '../src/config.mjs';
import { repositoryPortfolio } from '../src/repositories.mjs';

test('pairing creates a persistent, revocable device without storing the raw token', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-auth-'));
  let now = 1_800_000_000_000;
  const auth = new PairingAuth({ root, now: () => now });
  const pairing = auth.pairingDetails();
  const result = auth.pair(pairing.code, 'Martin phone');

  assert.equal(auth.authenticate(`x=1; handraise_session=${result.token}`)?.name, 'Martin phone');
  assert.ok(!readFileSync(join(root, 'auth.json'), 'utf8').includes(result.token));
  assert.equal(statSync(join(root, 'auth.json')).mode & 0o777, 0o600);

  now += 1_000;
  const restarted = new PairingAuth({ root, now: () => now });
  assert.equal(restarted.authenticate(`handraise_session=${result.token}`)?.id, result.device.id);
  assert.throws(() => restarted.revoke(result.device.id), /final active device/);
  const secondPairing = restarted.startPairing();
  restarted.pair(secondPairing.code, 'Laptop');
  restarted.revoke(result.device.id);
  assert.equal(restarted.authenticate(`handraise_session=${result.token}`), null);
  restarted.reset();
  assert.equal(restarted.hasDevices(), false);
});

test('invalid pairing codes do not create a device', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-auth-'));
  const auth = new PairingAuth({ root });
  assert.throws(() => auth.pair('WRONGCODE', 'attacker'), /invalid pairing code/);
  assert.equal(auth.hasDevices(), false);
});

test('repositories are normalized to their git root and never duplicated', () => {
  const home = mkdtempSync(join(tmpdir(), 'handraise-config-'));
  const repository = join(home, 'repo');
  const nested = join(repository, 'packages', 'web');
  mkdirSync(nested, { recursive: true });
  const config = new ConfigStore({ root: join(home, 'state'), resolveRepository: () => repository });

  const first = config.addRepository(nested, { name: 'My repo' });
  const second = config.addRepository(repository);
  assert.equal(first.id, second.id);
  assert.equal(config.read().repositories.length, 1);
  assert.equal(first.adapter, 'uninitialized');
  const initialized = config.initializeRepository(first.id);
  assert.equal(initialized.adapter, 'handraise');
  assert.equal(JSON.parse(readFileSync(join(repository, '.handraise', 'project.json'), 'utf8')).name, 'My repo');
});

test('a Director repository becomes a repo-scoped component and front portfolio', () => {
  const root = mkdtempSync(join(tmpdir(), 'handraise-director-'));
  mkdirSync(join(root, '.claude', 'components'), { recursive: true });
  mkdirSync(join(root, '.claude', 'runtime', 'plans'), { recursive: true });
  writeFileSync(join(root, '.claude', 'components', 'backend.md'), `---\nslug: backend\ntitulo: Backend\nestado: activo\norden: 1\ndesde: 2026-08-02\n---\n\n## Alcance\n\nOwn the API.\n`);
  writeFileSync(join(root, '.claude', 'runtime', 'plans', 'auth.md'), `# auth — Pair devices\n\n**Componente:** backend\n\n## ▶ Handoff\n\nStart with pairing.\n\n- [x] 1.1 Contract\n- [ ] 1.2 UI\n`);
  writeFileSync(join(root, '.claude', 'runtime', 'priorities.md'), 'auth: alto/media\n');

  const portfolio = repositoryPortfolio({ id: 'repo', name: 'Repo', path: root, adapter: 'director' });
  assert.equal(portfolio.components[0].title, 'Backend');
  assert.equal(portfolio.fronts[0].component, 'backend');
  assert.equal(portfolio.fronts[0].percent, 50);
  assert.equal(portfolio.fronts[0].impact, 'alto');
});

test('agent invocations preserve model and effort as inert CLI arguments', () => {
  assert.equal(
    agentInvocation('codex', { model: "gpt-5'; touch /tmp/nope; echo '", effort: 'xhigh' }),
    "codex -m 'gpt-5'\\''; touch /tmp/nope; echo '\\''' -c 'model_reasoning_effort=xhigh'",
  );
  assert.equal(agentInvocation('claude', { model: 'opus', effort: 'high' }), "claude --model 'opus' --effort 'high'");
  assert.throws(() => agentInvocation('codex', { effort: 'maximum' }), /invalid effort/);
});
