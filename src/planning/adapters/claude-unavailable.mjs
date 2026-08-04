import { spawnSync } from 'node:child_process';

import {
  PLANNING_OPERATIONS, PLANNING_SCHEMA_VERSION, PlanningError,
} from '../contracts.mjs';

const descriptor = {
  id: 'claude-code-planner',
  name: 'Claude Code planning',
  version: '0.1.0-declaration',
  contractVersion: PLANNING_SCHEMA_VERSION,
  provider: { id: 'anthropic', name: 'Anthropic' },
  authentication: {
    owner: 'first-party-cli',
    method: 'saved Claude Code session (not yet safely reusable for planning)',
    credentialsStoredByHandraise: false,
  },
  capabilities: {
    operations: [...PLANNING_OPERATIONS],
    structuredOutput: true,
    toolFreeInvocation: true,
    cancellation: true,
    usage: ['input_tokens', 'output_tokens', 'cost_usd'],
    cost: true,
    boundedContext: true,
  },
  dataBoundary: {
    kind: 'cloud',
    destination: 'Anthropic through Claude Code',
    sourceMayLeaveHost: true,
    requiresConsent: true,
  },
  models: [{ id: 'default', label: 'Claude Code default model', default: true }],
  degradation: {
    fallback: 'deterministic-manual',
    summary: 'Claude Code remains available for interactive agent sessions; planning falls back to deterministic/manual workflows.',
  },
};

function clean(value, max = 4_096) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function createClaudePlanningDeclaration({ binary = process.env.HANDRAISE_CLAUDE_BIN || 'claude' } = {}) {
  return {
    descriptor,
    detect() {
      const version = spawnSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, maxBuffer: 128 * 1024 });
      if (version.error?.code === 'ENOENT') return {
        available: false, code: 'CLAUDE_NOT_INSTALLED', reason: 'Claude Code is not installed on the server host.', binary,
        capabilities: { installed: false, structuredOutput: false, toolFreeInvocation: false, safeAuthReuse: false },
      };
      const help = spawnSync(binary, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, maxBuffer: 512 * 1024 });
      const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
      return {
        available: false,
        code: 'SAFE_AUTH_PARITY_UNAVAILABLE',
        reason: 'Claude Code can disable tools and validate JSON, but its audited --bare boundary does not reuse OAuth/keychain authentication. Handraise will not weaken isolation or copy credentials to claim parity.',
        binary,
        version: clean(version.stdout || version.stderr, 128),
        supportedVersions: 'deferred until invocation-scoped safe auth and configuration isolation are both available',
        authentication: { connected: null, owner: 'claude-code', safelyReusable: false },
        capabilities: {
          installed: version.status === 0,
          structuredOutput: helpText.includes('--json-schema'),
          toolFreeInvocation: helpText.includes('--tools'),
          bareMode: helpText.includes('--bare'),
          safeAuthReuse: false,
        },
      };
    },
    async run() {
      throw new PlanningError('SAFE_AUTH_PARITY_UNAVAILABLE', 'Claude Code planning is intentionally unavailable until safe first-party authentication parity is supportable.');
    },
    async dispose() {},
  };
}
