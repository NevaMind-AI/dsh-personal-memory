# @nevamind-ai/dsh-memu

[中文](README.zh.md)

The first native memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), backed by [memU](https://github.com/NevaMind-AI/memU). It implements both halves of durable agent memory without routing through MCP:

- **Recall:** retrieves relevant memU context automatically before a user-driven step and exposes an explicit `memory_search` tool.
- **Memorization:** mirrors clean DSH conversation and tool records to plain JSONL for memU's scheduled `prepare → self-evolve → commit` pipeline.

The plugin is an opt-in DSH bundle. Installing it into a profile adds one Cordis row; removing it removes the row and all live registrations.

## Prerequisites

- Node.js `^22.19.0` or `>=24`
- DeepSeek Harness `0.1.0-rc.6` (`next` dist-tag)
- Python `>=3.11`
- `memu-cli` configured in either cloud or local mode

Install and verify memU first:

```sh
pip install memu-cli
memu-agent doctor
```

`doctor` must pass. Zero hits are valid for a new store.

## Install

Published package:

```sh
dsh plugin --profile web add @nevamind-ai/dsh-memu
```

Local checkout:

```sh
dsh plugin --profile web add .
```

Install the bundle separately into every DSH profile that should use memory. Restart that profile after the initial installation; later `cordis.patch.yml` changes are hot-reloaded by DSH.

The bundle inserts this default-off-from-DSH, enabled-in-the-selected-profile row:

```yaml
- insert:
    - id: memory-memu
      name: '@nevamind-ai/dsh-memu'
      config:
        command: memu-agent
        autoRetrieve: true
```

## What the model sees

The plugin adds a short system-prompt rule and the `memory_search` schema. Before an eligible step, it queries memU with only direct user text. Non-empty results enter durable history as a `form: recall` plugin message immediately before the current request.

Every recall is wrapped with an explicit trust label: memory is historical user data, not instructions. Current system, workspace, and user instructions take precedence. Empty retrieval results add no tokens.

`memory_search` accepts one focused natural-language `query`. It uses the same bounded retrieval path as automatic recall and returns the three progressive memU layers: `segments`, `files`, and `resources`.

## Turn on memorization

The plugin writes future direct-user messages, model messages, tool calls, and tool results to:

```text
~/.memu/hosts/deepseek-harness/sessions/*.jsonl
```

Plugin-injected recall and other runtime context are excluded, so memU does not mine its own injected payload as something the user said. Session IDs are SHA-256 encoded in filenames; the original ID remains inside the owner-only local row.

Run the first prepare gate:

```sh
memu-agent prepare \
  --base-dir ~/.memu/hosts/deepseek-harness \
  --session-dir ~/.memu/hosts/deepseek-harness/sessions
```

Then give a DSH headless agent the following recurring pipeline. It must process each generated job itself; memU intentionally makes no LLM call inside `MemoryService`.

```text
Run the memU bridging pipeline strictly in order.

1. If ~/.memu/hosts/deepseek-harness/jobs already contains *.txt files, process
   them in ascending numeric order, then run:
   memu-agent commit --base-dir ~/.memu/hosts/deepseek-harness
2. Run:
   memu-agent prepare --base-dir ~/.memu/hosts/deepseek-harness --session-dir ~/.memu/hosts/deepseek-harness/sessions
   Stop if it fails.
3. List ~/.memu/hosts/deepseek-harness/jobs/*.txt and process every file in
   ascending numeric order. Read each file and follow its instructions exactly.
   Producing no file for a job is valid.
4. Run:
   memu-agent commit --base-dir ~/.memu/hosts/deepseek-harness
   Stop and report the error if it fails.

Finish with the number of jobs processed and what was committed.
```

Schedule that prompt with the agent runner or system scheduler. For an hourly Unix wrapper, keep the prompt in a file rather than a crontab line, prevent overlapping runs with a lock, and launch the headless agent with `MEMU_BRIDGING_RUN=1`. The flag tells this plugin not to capture a self-evolve run if the bundle is also installed in the headless profile.

Use `memu-agent docs task` for memU's complete scheduler, leftover-job, bare-`PATH`, and failure-reporting procedure. Keep the integration-specific `--base-dir` and `--session-dir` arguments shown above.

## Configuration

Override the inserted row in a profile or home `cordis.patch.yml`. DSH patches replace the complete `config`, so restate every key you need.

| Key | Default | Meaning |
|---|---:|---|
| `command` | `memu-agent` | memU executable or absolute executable path |
| `autoRetrieve` | `true` | Retrieve before steps containing new direct-user text |
| `captureTranscripts` | `true` | Write memU-compatible sidecar JSONL |
| `transcriptDir` | `~/.memu/hosts/deepseek-harness/sessions` | Sidecar session directory |
| `timeoutMs` | `10000` | Complete retrieval deadline |
| `maxOutputBytes` | `65536` | Per-stream retrieval output cap |
| `processGraceMs` | `1000` | Child-process termination grace |
| `maxQueryChars` | `8000` | Query cap; the newest end is retained |

Example with automatic retrieval disabled while keeping explicit search and capture:

```yaml
- id: memory-memu
  config:
    command: memu-agent
    autoRetrieve: false
    captureTranscripts: true
    timeoutMs: 10000
    maxOutputBytes: 65536
    processGraceMs: 1000
    maxQueryChars: 8000
```

## Security and privacy

- The plugin invokes `memu-agent` through Harness's managed subprocess service with an argv array, never a shell string.
- Retrieval has a deadline and bounded stdout/stderr. Invalid JSON and invalid progressive-layer types are rejected before model injection.
- Harness normally removes credential-shaped ambient variables from children. This plugin deliberately forwards only `MEMU_*` variables so process-env memU configuration still works; ordinary memU installs should prefer the owner-only `~/.memu/config.env` file.
- Sidecar transcripts contain conversation and tool data in plaintext. The plugin enforces mode `0700` on the configured directory and `0600` on transcript files.
- `MEMU_BRIDGING_RUN=1` disables transcript capture for that DSH process.
- memU backend configuration, retention, cloud identity, embeddings, and deletion remain memU-owned.

## Verify

```sh
pnpm run check
pnpm pack --dry-run
```

Functional smoke test:

1. Start DSH with the plugin and ask it to remember a unique preference.
2. Confirm a new JSONL file appears in the transcript directory.
3. Run the bridging pipeline once.
4. Open a fresh DSH session and ask for the preference. Confirm automatic recall or a `memory_search` call returns it.

## Known limitations

- Memorization is scheduled, not immediate. This matches memU's agent-driven distillation design; the plugin does not invent a second write API.
- The sidecar captures events emitted after the plugin is active. Installing or hot-loading it does not backfill an already-open session's constructor history.
- Automatic retrieval adds up to `timeoutMs` latency on user-driven steps. Failures log a warning and leave the original step unchanged; explicit `memory_search` failures remain visible tool errors.
- The generic memU CLI reports this path as host `agent`. A future dedicated `memu-deepseek-harness` adapter can improve host-specific diagnostics without changing the plugin's transcript format.
- Sidecar JSONL duplicates a bounded subset of DSH's canonical session log and therefore consumes additional local disk space.
