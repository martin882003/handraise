# Graphify read-only adapter

Status: implemented for deterministic local code extraction.

Handraise treats Graphify as an optional analyzer behind the repository
intelligence contract. It never installs the `graphifyy` package, registers a
skill, writes assistant instructions, installs Git hooks or starts a daemon.
When Graphify is missing or incompatible, the built-in structural inventory
remains available and the original diagnostic is retained.

## Supported capability

The adapter is `graphify-code-local`. It supports Graphify `>=0.9.21 <=0.9.32`;
the fixture suite is pinned to `0.9.32`. Detection executes only:

```text
graphify --version
graphify extract --help
```

It requires the documented `extract`, `--code-only`, `--out`, `--no-cluster`
and `--max-workers` surfaces. The exact binary, package, version, supported
range, command/schema contract and incompatibility code are returned by
`GET /api/analysis/analyzers`.

The version and command contract comes from Graphify's official
[CLI reference](https://graphify.com/docs/cli),
[current package metadata](https://github.com/Graphify-Labs/graphify/blob/v8/pyproject.toml)
and [CLI source](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/__main__.py).
Graphify documents code-only extraction as local AST parsing and documents
semantic handling of other media separately in its
[README](https://github.com/Graphify-Labs/graphify/blob/v8/README.md).

## Isolation and invocation

After the user reviews an exact Git-aware manifest, the analysis runtime copies
only those regular files into a private job directory. Symlinks, default secret
patterns, generated directories and files outside the selected scope are not
followed. The target repository path is not passed to Graphify.

The runtime invokes Graphify with a structured argument vector, never a shell:

```text
graphify extract <private-snapshot>
  --code-only
  --no-cluster
  --out <private-output>
  --max-workers <bounded>
```

This intentionally combines two defenses. `--out` directs normal output away
from the corpus, while the corpus itself is already a separate private copy.
That second boundary matters because Graphify has historically fixed cases in
which auxiliary cache files ignored a custom output directory; see its official
[changelog](https://graphify.com/changelog).

The child receives an allowlisted environment with a job-private `HOME`, XDG
directories and temporary directory. Provider API keys and the target path are
not inherited. Wall time, stdout/stderr, memory, CPU and process counts are
bounded; cancellation terminates the process group and escalates to a kill.
Incomplete private source/output trees are deleted during restart recovery.

The private mirror protects the repository from the supported Graphify command
and accidental output behavior. It is not a malware sandbox: an intentionally
hostile executable running as the same OS user could seek unrelated absolute
paths. Handraise therefore detects an existing user-installed binary but never
downloads or silently replaces one.

## Output contract

Only a regular, non-symlink `graph.json` under the private output root is read.
Its byte size is checked before and during the read. Handraise accepts the two
documented Graphify shapes:

- node-link graphs with `nodes` plus `links`;
- extraction graphs with `nodes` plus `edges`.

Graphify's official [architecture contract](https://github.com/Graphify-Labs/graphify/blob/v8/ARCHITECTURE.md)
defines node locations and `EXTRACTED`, `INFERRED` and `AMBIGUOUS` relation
confidence. Normalization maps upstream IDs to stable Handraise IDs, validates
all endpoints and repository-relative locations, and preserves the original
confidence tag alongside normalized provenance/confidence.

Output fails closed on invalid JSON, duplicate node IDs, malformed records,
unsafe paths, dangling-output symlinks, oversized files or graph cardinality
above contract limits. Dangling relations, unknown confidence labels and source
paths absent from the reviewed manifest are retained as explicit partial-result
diagnostics where safe rather than fabricated into completeness.

Coverage is reported by selected language/file class. A supported file that
produces no located entity is `partial`, not evidence that it contains no
symbols. Files outside code-only coverage are `unsupported`, and make the
snapshot partial while leaving successfully extracted evidence usable.

## Semantic analysis is deliberately separate

This adapter never selects Graphify's semantic/model backends. It passes
`--code-only`, strips provider credentials and advertises all semantic and
source-egress capabilities as false. A future semantic adapter must have a
different capability identity and a preflight that names the provider, exact
source/data scope and retention boundary before explicit local-host consent.

## API and UI behavior

The analyzer catalog shows available and unavailable adapters. Scope preview
includes the upstream version, local mode, isolation strategy, supported and
unsupported file counts, and a redacted invocation. A failed Graphify job keeps
its exact failure code/events and offers the structural inventory as a clearly
named fallback; fallback output is never labeled Graphify-equivalent.

Tests cover compatible, missing, incompatible and capability-mismatched
binaries; normalized provenance; dirty/untracked paths; shell-shaped filenames;
malformed, oversized and symlink output; cancellation; startup cleanup; provider
credential stripping; and byte/mode/mtime identity of the complete target tree.
