import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  PLANNING_OPERATIONS, PLANNING_SCHEMA_VERSION, PlanningError,
} from '../contracts.mjs';

export const CODEX_PLANNING_ADAPTER_VERSION = '1.0.0';
export const CODEX_SUPPORTED_VERSIONS = '>=0.146.0 <0.147.0';
export const CODEX_DEFAULT_TIMEOUT_MS = 3 * 60_000;
export const CODEX_MAX_EVENT_BYTES = 4 * 1024 * 1024;
export const CODEX_MAX_RESULT_BYTES = 2 * 1024 * 1024;

const REQUIRED_EXEC_FLAGS = [
  '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema',
  '--output-last-message', '--cd', '--skip-git-repo-check', '--strict-config',
];

const DISABLED_FEATURES = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'goals', 'hooks',
  'image_generation', 'multi_agent', 'multi_agent_v2', 'plugins', 'remote_plugin',
  'skill_mcp_dependency_install', 'skill_search', 'shell_tool', 'unified_exec', 'code_mode_host',
];

const UNSAFE_ITEM_TYPES = new Set([
  'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'computer_use',
  'dynamic_tool_call', 'apply_patch', 'browser_action', 'image_generation',
]);

const descriptor = {
  id: 'codex-cli-planner',
  name: 'Codex CLI planning',
  version: CODEX_PLANNING_ADAPTER_VERSION,
  contractVersion: PLANNING_SCHEMA_VERSION,
  provider: { id: 'openai', name: 'OpenAI' },
  authentication: {
    owner: 'first-party-cli',
    method: 'saved Codex CLI / ChatGPT session',
    credentialsStoredByHandraise: false,
  },
  capabilities: {
    operations: [...PLANNING_OPERATIONS],
    structuredOutput: true,
    toolFreeInvocation: true,
    cancellation: true,
    usage: ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'],
    cost: false,
    boundedContext: true,
  },
  dataBoundary: {
    kind: 'cloud',
    destination: 'OpenAI through the authenticated Codex CLI',
    sourceMayLeaveHost: true,
    requiresConsent: true,
  },
  models: [{ id: 'default', label: 'Codex CLI default model', default: true }],
  degradation: {
    fallback: 'deterministic-manual',
    summary: 'Repository maps and manual component/front editors remain available when Codex planning cannot run.',
  },
};

function clean(value, max = 4_096) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function versionTuple(value) {
  const match = String(value || '').match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/);
  return match ? match.slice(1).map(Number) : null;
}

function supportedVersion(value) {
  const tuple = versionTuple(value);
  return Boolean(tuple && tuple[0] === 0 && tuple[1] === 146 && tuple[2] >= 0);
}

function detectionEnvironment(codexHome) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: homedir(),
    CODEX_HOME: codexHome,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
    ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT || '', WINDIR: process.env.WINDIR || '' } : {}),
  };
}

function capture(binary, args, { timeout = 8_000, env } = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 512 * 1024,
    env,
  });
  return {
    status: result.status,
    error: result.error,
    stdout: clean(result.stdout, 32_000),
    stderr: clean(result.stderr, 32_000),
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function config(key, value) {
  return ['-c', `${key}=${value}`];
}

export function codexPlanningInvocation({ workspacePath, schemaPath, outputPath, instructionsPath, privateHome, model = 'default' }) {
  for (const [name, value] of Object.entries({ workspacePath, schemaPath, outputPath, instructionsPath, privateHome })) {
    if (!isAbsolute(value)) throw new PlanningError('INVALID_ADAPTER_PATH', `${name} must be absolute`);
  }
  if (model !== 'default' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    throw new PlanningError('INVALID_MODEL', 'model must use a safe provider model identifier');
  }
  const commandPath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin';
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--strict-config', '--color', 'never', '--cd', workspacePath,
    '--output-schema', schemaPath, '--output-last-message', outputPath,
  ];
  if (model !== 'default') args.push('--model', model);
  for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
  args.push(
    ...config('approval_policy', '"never"'),
    ...config('web_search', '"disabled"'),
    ...config('agents.enabled', 'false'),
    ...config('project_doc_max_bytes', '0'),
    ...config('model_instructions_file', tomlString(instructionsPath)),
    ...config('default_permissions', '"handraise-planning"'),
    ...config('permissions.handraise-planning.filesystem.":root"', '"deny"'),
    ...config('permissions.handraise-planning.filesystem.":minimal"', '"read"'),
    ...config('permissions.handraise-planning.filesystem.":tmpdir"', '"deny"'),
    ...config('permissions.handraise-planning.filesystem.":slash_tmp"', '"deny"'),
    ...config('permissions.handraise-planning.filesystem.":workspace_roots"."."', '"read"'),
    ...config('permissions.handraise-planning.network.enabled', 'false'),
    ...config('shell_environment_policy.inherit', '"none"'),
    ...config('shell_environment_policy.set.PATH', tomlString(commandPath)),
    ...config('shell_environment_policy.set.HOME', tomlString(workspacePath)),
    ...config('shell_environment_policy.set.TMPDIR', tomlString(join(workspacePath, 'tmp'))),
    ...config('shell_environment_policy.set.LANG', '"C.UTF-8"'),
    '-',
  );
  return args;
}

function runtimeEnvironment({ privateHome, codexHome }) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: privateHome,
    CODEX_HOME: codexHome,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
    TMPDIR: join(privateHome, 'tmp'),
    XDG_CONFIG_HOME: join(privateHome, '.config'),
    XDG_CACHE_HOME: join(privateHome, '.cache'),
    XDG_DATA_HOME: join(privateHome, '.local', 'share'),
    NO_COLOR: '1',
    ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT || '', WINDIR: process.env.WINDIR || '' } : {}),
  };
}

function terminate(child, force = false) {
  if (!child || child.exitCode !== null) return;
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* process already exited */ } }
}

function eventUsage(event, current) {
  if (event?.type !== 'turn.completed' || !event.usage || typeof event.usage !== 'object') return current;
  const usage = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    if (Number.isFinite(event.usage[key]) && event.usage[key] >= 0) usage[key] = Number(event.usage[key]);
  }
  return usage;
}

function unsafeEvent(event) {
  const item = event?.item;
  if (!item || typeof item !== 'object') return null;
  return UNSAFE_ITEM_TYPES.has(item.type) ? item.type : null;
}

export function createCodexPlanningAdapter({
  binary = process.env.HANDRAISE_CODEX_BIN || 'codex',
  binaryArgs = [],
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  timeoutMs = CODEX_DEFAULT_TIMEOUT_MS,
  maxEventBytes = CODEX_MAX_EVENT_BYTES,
  maxResultBytes = CODEX_MAX_RESULT_BYTES,
  cacheMs = 5_000,
  spawnProcess = spawn,
} = {}) {
  let cachedDetection = null;
  let cachedAt = 0;

  const detect = ({ refresh = false } = {}) => {
    if (!refresh && cachedDetection && Date.now() - cachedAt < cacheMs) return cachedDetection;
    const environment = detectionEnvironment(codexHome);
    if (!Array.isArray(binaryArgs) || binaryArgs.some((argument) => typeof argument !== 'string')) throw new PlanningError('INVALID_ADAPTER_COMMAND', 'Codex binaryArgs must be a string array');
    const versionResult = capture(binary, [...binaryArgs, '--version'], { env: environment });
    if (versionResult.error?.code === 'ENOENT') {
      cachedDetection = { available: false, code: 'CODEX_NOT_INSTALLED', reason: 'Codex CLI is not installed on the server host.', binary, supportedVersions: CODEX_SUPPORTED_VERSIONS };
      cachedAt = Date.now();
      return cachedDetection;
    }
    if (versionResult.error) {
      cachedDetection = { available: false, code: 'CODEX_DETECTION_FAILED', reason: clean(versionResult.error.message || 'Codex version detection failed.'), binary, supportedVersions: CODEX_SUPPORTED_VERSIONS };
      cachedAt = Date.now();
      return cachedDetection;
    }
    if (versionResult.status !== 0) {
      cachedDetection = { available: false, code: 'CODEX_DETECTION_FAILED', reason: versionResult.stderr || versionResult.error?.message || 'Codex version detection failed.', binary, supportedVersions: CODEX_SUPPORTED_VERSIONS };
      cachedAt = Date.now();
      return cachedDetection;
    }
    const version = clean(versionResult.stdout || versionResult.stderr, 128);
    if (!supportedVersion(version)) {
      cachedDetection = { available: false, code: 'CODEX_VERSION_UNSUPPORTED', reason: `Codex ${version || 'unknown'} is outside the audited planning range.`, binary, version, supportedVersions: CODEX_SUPPORTED_VERSIONS };
      cachedAt = Date.now();
      return cachedDetection;
    }
    const helpResult = capture(binary, [...binaryArgs, 'exec', '--help'], { env: environment });
    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    const missingFlags = REQUIRED_EXEC_FLAGS.filter((flag) => !help.includes(flag));
    if (helpResult.status !== 0 || missingFlags.length) {
      cachedDetection = {
        available: false, code: 'CODEX_CAPABILITY_MISSING',
        reason: missingFlags.length ? `Codex is missing required non-interactive flags: ${missingFlags.join(', ')}.` : 'Codex exec capability detection failed.',
        binary, version, supportedVersions: CODEX_SUPPORTED_VERSIONS,
        capabilities: { structuredOutput: help.includes('--output-schema'), ephemeral: help.includes('--ephemeral'), missingFlags },
      };
      cachedAt = Date.now();
      return cachedDetection;
    }
    const authResult = capture(binary, [...binaryArgs, 'login', 'status'], { env: environment });
    const authText = clean(`${authResult.stdout}\n${authResult.stderr}`, 2_000);
    const authenticated = authResult.status === 0 && /logged in/i.test(authText) && !/not logged in/i.test(authText);
    if (!authenticated) {
      cachedDetection = {
        available: false, code: 'CODEX_AUTH_REQUIRED',
        reason: 'Codex CLI is installed but its saved ChatGPT/CLI session is not authenticated or has expired. Connect Codex in Settings, then retry.',
        binary, version, supportedVersions: CODEX_SUPPORTED_VERSIONS,
        authentication: { connected: false, owner: 'codex-cli' },
      };
      cachedAt = Date.now();
      return cachedDetection;
    }
    cachedDetection = {
      available: true, code: 'READY', reason: 'Audited Codex CLI capabilities and saved first-party authentication are available.',
      binary, version, supportedVersions: CODEX_SUPPORTED_VERSIONS,
      authentication: { connected: true, owner: 'codex-cli' },
      isolation: 'permission-profile:root-deny+private-workspace-read+network-deny',
      capabilities: { structuredOutput: true, ephemeral: true, cancellation: true, toolAttemptsFailClosed: true },
    };
    cachedAt = Date.now();
    return cachedDetection;
  };

  const run = async ({
    prompt, workspacePath, schemaPath, outputPath, instructionsPath, privateHome, model = 'default', signal,
    progress = () => {}, attempt = 1,
  }) => {
    const availability = detect({ refresh: true });
    if (!availability.available) throw new PlanningError(availability.code || 'ADAPTER_UNAVAILABLE', availability.reason || 'Codex planning is unavailable');
    if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > 512 * 1024) throw new PlanningError('PROMPT_LIMIT_EXCEEDED', 'planning prompt must be between 1 byte and 512 KiB');
    const args = codexPlanningInvocation({ workspacePath, schemaPath, outputPath, instructionsPath, privateHome, model });
    const environment = runtimeEnvironment({ privateHome, codexHome });
    progress(.05, `Starting authenticated Codex planning attempt ${attempt}.`);

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lineBuffer = '';
    let stderr = '';
    let usage = null;
    let boundaryViolation = null;
    let malformedEvent = null;
    let timedOut = false;
    let outputExceeded = false;
    const child = spawnProcess(binary, [...binaryArgs, ...args], {
      cwd: workspacePath,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const inspectLine = (line) => {
      if (!line.trim() || malformedEvent || boundaryViolation) return;
      let event;
      try { event = JSON.parse(line); }
      catch {
        malformedEvent = clean(line, 500);
        terminate(child);
        return;
      }
      const unsafe = unsafeEvent(event);
      if (unsafe) {
        boundaryViolation = unsafe;
        terminate(child);
        return;
      }
      usage = eventUsage(event, usage);
      if (event.type === 'thread.started') progress(.15, 'Codex accepted the bounded planning request.');
      else if (event.type === 'turn.started') progress(.25, 'Codex is reasoning over the reviewed context.');
      else if (event.type === 'item.completed' && event.item?.type === 'agent_message') progress(.8, 'Codex produced a candidate structured response.');
      else if (event.type === 'turn.completed') progress(.9, 'Codex completed; Handraise is validating the response.');
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxEventBytes) {
        outputExceeded = true;
        terminate(child);
        return;
      }
      lineBuffer += chunk;
      for (let newline = lineBuffer.indexOf('\n'); newline >= 0; newline = lineBuffer.indexOf('\n')) {
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        inspectLine(line);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= 512 * 1024) stderr += chunk;
      else terminate(child);
    });

    let forceTimer;
    const abort = () => {
      terminate(child);
      forceTimer = setTimeout(() => terminate(child, true), 1_000);
      forceTimer.unref?.();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      const force = setTimeout(() => terminate(child, true), 1_000);
      force.unref?.();
    }, timeoutMs);
    timer.unref?.();

    let exit;
    try {
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
      exit = await new Promise((resolvePromise, rejectPromise) => {
        child.once('error', rejectPromise);
        child.once('close', (code, closeSignal) => resolvePromise({ code, signal: closeSignal }));
      });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new PlanningError('CODEX_NOT_INSTALLED', 'Codex CLI disappeared after preflight.', { cause: error });
      throw new PlanningError('MODEL_PROCESS_FAILED', clean(error?.message || error), { cause: error });
    } finally {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
    }
    if (lineBuffer.trim()) inspectLine(lineBuffer);
    if (signal?.aborted) throw new DOMException('Planning cancelled', 'AbortError');
    if (timedOut) throw new PlanningError('MODEL_TIMEOUT', `Codex planning exceeded ${timeoutMs} ms`);
    if (outputExceeded || stderrBytes > 512 * 1024) throw new PlanningError('MODEL_OUTPUT_LIMIT', 'Codex event output exceeded the configured budget');
    if (boundaryViolation) throw new PlanningError('MODEL_TOOL_ESCALATION', `Codex attempted forbidden tool activity (${boundaryViolation}); no proposal was accepted.`, { details: { itemType: boundaryViolation } });
    if (malformedEvent) throw new PlanningError('MODEL_EVENT_INVALID', 'Codex emitted malformed JSONL progress output');
    if (exit.code !== 0) {
      const detail = clean(stderr, 2_000);
      const code = /login|auth|credential|unauthorized|401/i.test(detail) ? 'CODEX_AUTH_EXPIRED' : 'MODEL_EXIT';
      throw new PlanningError(code, detail || `Codex exited with status ${exit.code ?? exit.signal ?? 'unknown'}`);
    }
    let details;
    try { details = lstatSync(outputPath); }
    catch (error) { throw new PlanningError('MODEL_RESULT_MISSING', 'Codex did not write the required structured result.', { cause: error }); }
    if (!details.isFile() || details.isSymbolicLink()) throw new PlanningError('MODEL_RESULT_UNSAFE', 'Codex result must be a regular private file');
    if (details.size > maxResultBytes) throw new PlanningError('MODEL_OUTPUT_LIMIT', 'Codex structured result exceeds the configured budget');
    let output;
    try { output = JSON.parse(readFileSync(outputPath, 'utf8')); }
    catch (error) { throw new PlanningError('MODEL_RESULT_INVALID_JSON', 'Codex structured result is not valid JSON.', { cause: error }); }
    return {
      output,
      usage,
      cost: null,
      metadata: {
        adapterVersion: CODEX_PLANNING_ADAPTER_VERSION,
        cliVersion: availability.version,
        model,
        attempt,
        eventBytes: stdoutBytes,
        costAvailable: false,
      },
    };
  };

  return { descriptor, detect, run, async dispose() {} };
}
