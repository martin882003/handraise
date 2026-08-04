# Bounded planning-model runtime

**Status:** implemented provider-neutral contract with one supported cloud
adapter and one explicit unsupported-parity declaration

**Runtime contract:** schema v1

Handraise uses reasoning models to propose a work model, never to authorize or
publish one. The runtime converts an immutable analysis snapshot, selected
product direction, the current portfolio and a human question into one bounded,
reviewable context bundle. The provider receives that exact bundle only after
the implicit server-host client consents to its data boundary.

The result is retained in private Handraise state as a proposal. It cannot write
components, fronts, Git state, hooks or repository metadata. Publication remains
a separate human-reviewed operation.

## Provider-neutral contract

Every adapter declares:

- provider, models and supported planning operations;
- first-party or explicit-provider authentication ownership;
- structured-output, tool-free invocation, cancellation and bounded-context
  capabilities;
- local/cloud destination and whether consent is mandatory;
- available usage/cost metadata and deterministic/manual degradation.

The three v1 operations are `component-design`, `front-design` and
`portfolio-review`. Results always contain the same top-level shape. Component,
front and finding claims must cite an allowlisted evidence/intent/contract ID or
state assumptions/questions and uncertainty explicitly.

## Bounded context tools

Handraise executes the read-only tools itself before provider invocation. The
model does not receive callable Handraise tools.

- Graph overview and graph queries return compact entities, relations,
  findings, coverage and diagnostics from one immutable snapshot.
- Evidence lookup resolves only selected evidence IDs from that snapshot.
- Product lookup selects normalized fields from the accepted product brief.
- Portfolio lookup selects bounded accepted component/front summaries.
- Human context is one explicit bounded request.

Arguments and results have hard count/byte limits. The resulting sources carry
an ID, kind, title, exact snippet, byte count, SHA-256 digest, provenance and
allowlisted evidence IDs. Preflight shows all of those fields. Missing analysis,
product direction or portfolio remains a visible diagnostic rather than being
silently inferred.

## Codex CLI adapter

`codex-cli-planner` is supported for the audited range
`>=0.146.0 <0.147.0`. Detection verifies the binary, version, required
non-interactive flags and `codex login status` before preflight. It reuses the
saved CLI/ChatGPT session through `CODEX_HOME`; Handraise never reads, copies or
logs the credential. Environment API keys and unrelated secret-bearing
variables are deliberately not inherited.

The invocation uses `codex exec` with:

- `--json`, `--output-schema` and `--output-last-message`;
- `--ephemeral`, `--ignore-user-config`, `--ignore-rules` and
  `project_doc_max_bytes=0`;
- a trusted replacement instruction file and disabled hooks, apps, browser,
  search, plugins, skills, subagents and command-tool feature surfaces;
- `approval_policy="never"`, web search disabled and no legacy `--sandbox`
  override;
- a permission profile that denies `:root`, grants only `:minimal` and read
  access to the private planning workspace, denies temp roots and disables
  sandboxed network;
- a model-command environment with no inherited variables and only a fixed
  system `PATH`, private `HOME`/`TMPDIR` and locale.

The CLI process itself can reach OpenAI and its CLI-owned auth. Model-generated
local commands cannot reach the repository, credentials, host filesystem or
network. Any command, file-change, MCP, browser, web or other tool event also
terminates the job and rejects the candidate. This combines an OS-enforced
least-privilege boundary with fail-closed event validation.

The implementation follows the official Codex documentation for
[`codex exec` structured output and saved authentication](https://developers.openai.com/codex/noninteractive/)
and [permission profiles](https://developers.openai.com/codex/permissions/).

## Validation, repair and lifecycle

Preflight identity binds repository ID/adapter, operation, adapter and detected
CLI versions, model and exact context digest. It expires after 15 minutes.
Cloud source selection and execution require the implicit local client; a paired
LAN, tailnet, tunnel or Internet client cannot perform either action.

Jobs persist queued/running/complete/failed/cancelled progress events, provider,
model, attempts, context identity, usage and cost when available. Cancellation
terminates the provider process group. Server restart marks active work failed
and removes incomplete workspace/home/temp data. Terminal jobs expire after
seven days or can be deleted immediately from the UI.

The provider schema constrains structure and evidence IDs. Handraise validates
the result again independently. One—and only one—repair attempt may receive the
rejected candidate and deterministic validation error as untrusted data. A
second invalid candidate, fabricated evidence, an ungrounded claim or a tool
escalation never becomes a result.

## Why Claude Code planning is not advertised yet

`claude-code-planner` is intentionally a visible unavailable declaration, not a
pretend adapter. Current Claude Code supports non-interactive structured output
and can disable tools. However, its strongest minimal `--bare` mode does not
reuse OAuth/keychain authentication, while ordinary configuration layers can
merge user/project/managed settings. Handraise will neither copy credentials nor
weaken invocation isolation to claim parity.

Interactive Claude Code sessions and first-time login remain fully supported by
the existing agent integration. Planning parity will be enabled only when an
audited invocation can simultaneously guarantee first-party auth reuse,
non-mergeable customization/tool isolation, bounded input and structured output
for a pinned version range. See Anthropic's official
[CLI reference](https://code.claude.com/docs/en/cli-usage),
[settings precedence](https://code.claude.com/docs/en/settings) and
[sandbox limitations](https://code.claude.com/docs/en/sandboxing).

## HTTP surface

- `GET /api/planning/adapters`
- `POST /api/repositories/:id/planning/preflight`
- `GET|POST /api/repositories/:id/planning/jobs`
- `GET|DELETE /api/repositories/:id/planning/jobs/:jobId`
- `GET /api/repositories/:id/planning/jobs/:jobId/result`
- `POST /api/repositories/:id/planning/jobs/:jobId/cancel`

All routes use the existing authentication and same-origin mutation boundary.
The preflight/start authority checks use the direct socket-peer plus exact
loopback Host identity; forwarding headers cannot grant local authority.

## Verification

`test/planning.test.mjs`, `test/auth-config.test.mjs` and
`test/browser-smoke.test.mjs` cover:

- bounded query/source limits and repeatable context identity;
- strict schemas, unknown evidence and ungrounded claims;
- exact Codex argv, permission profile, stripped environment and CLI-owned auth;
- auth expiry, missing/unsupported versions and partial Claude capabilities;
- prompt injection, generated-command/tool escalation and secret/repository
  non-disclosure;
- one successful repair and permanent rejection after the second invalid result;
- timeout, process-tree cancellation, restart recovery, retention/deletion and
  usage/cost states;
- local-only cloud consent, paired-remote denial and browser review;
- byte/mode/mtime repository sentinels proving no mutation.
