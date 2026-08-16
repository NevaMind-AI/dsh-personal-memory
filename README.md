# dsh-personal-memory

Personal memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), backed by [memU](https://github.com/NevaMind-AI/MemU).

`dsh` keeps everything as a plugin; memU keeps personal memory as a wiki shared across sessions, agents, and devices. This bundle is the seam between them, in both directions:

- **Retrieve** — a `memory_search` tool, plus the standing instruction that makes the model reach for it before answering. What your other agents learned, `dsh` can use.
- **Write back** — a hook that mirrors live `dsh` sessions into the JSONL layout memU mines, so what you do in `dsh` becomes memory and reusable skills that your other agents can retrieve.

Either direction works alone. Retrieval alone makes `dsh` a reader of memory other agents wrote. Write-back alone makes `dsh` a contributor to a store other agents read. Both is the loop.

```
      ┌──────────────────────── dsh session ────────────────────────┐
      │                                                             │
      │   user/message   assistant/message   tool/call   tool/result│
      │         └───────────────┴───────────┬──┴──────────────┘     │
      └───────────────────────────────────┬─┼───────────────────────┘
                                          │ │ session/event
                    memory_search ◄───────┤ ▼
                          ▲               │ ~/.dsh/memu-sessions/<project>/<sessionId>.jsonl
                          │               │        │
                          │ retrieve      │        │ memu-agent prepare  (scheduled, hourly)
                          │               │        ▼
                    ┌─────┴───────────────┴────────────────┐
                    │              memU store              │
                    │   memory · skills · resources        │
                    └──────────────────────────────────────┘
                       shared with Codex, Claude Code, Cursor, …
```

## Requirements

- `dsh` (developer preview) and Node.js ≥ 20.
- memU's CLI: `pip install memu-cli`. Configure it once — cloud (`memu.so` API key) or self-hosted — and check it with `memu-agent doctor`.

## Install

```bash
dsh plugin --profile default add github:NevaMind-AI/dsh-personal-memory
```

This is a TypeScript package installed from git, so pnpm must be allowed to run its `prepare` build. The first `add` fails and prints the exact package key; put it in the profile's `pnpm-workspace.yaml` and re-run:

```yaml
allowBuilds:
  dsh-personal-memory: true
```

That allowance is permission to execute this package's code at install time — pin a commit (`github:NevaMind-AI/dsh-personal-memory#<sha>`) so a later push cannot silently change what runs.

Verify the layer before booting:

```bash
dsh --profile default --dump-config
```

## The write-back hook

This is the half that flows `dsh` sessions **back** to memU.

`dsh` holds its session log in memory and leaves persistence to plugins. memU mines session logs **from disk**. The hook is the bridge: it subscribes to `dsh`'s post-commit `session/event` feed and appends the memorable events to one JSONL file per session, in a dialect memU's generic adapter already recognizes.

### What it writes, and where

```
~/.dsh/memu-sessions/<project>/<sessionId>.jsonl
```

`<project>` is derived from the session's working directory (last two path segments, made filesystem-safe), so two checkouts never share a tree. Set `project` in config to pin it instead.

Four event types are memorable; everything else — turn and step boundaries, streaming chunks, usage, approvals — is not conversation and not tool traffic, and is skipped:

| `dsh` session event | Mirrored record | memU classifies it as |
|---|---|---|
| `user/message` (only `source.kind: 'user'`) | `{"type":"user", …, "content":[{"type":"text"}]}` | conversation |
| `assistant/message` (visible text; reasoning dropped) | `{"type":"assistant", …, "content":[{"type":"text"}]}` | conversation |
| `tool/call` | `{"type":"assistant", …, "content":[{"type":"tool_use"}]}` | tool traffic |
| `tool/result` | `{"type":"user", …, "content":[{"type":"tool_result"}]}` | tool traffic |

That split is load-bearing on memU's side: the **memory** job reads conversation alone — what you said you wanted — while the **skill** job also reads tool calls — how the work was actually done. A record carrying both text and a `tool_use` block classifies as conversation, and the tool trace is lost to the skill job, so each tool call is mirrored as its own record.

Three decisions worth knowing about:

- **Only what you actually typed.** A `user/message` whose source is a plugin or a tool is skipped. Without that rule this plugin feeds memU its own retrieval output, and a standing instruction eventually resurfaces as a remembered preference.
- **Reasoning is dropped.** A thinking block is a draft, not something you saw or agreed to. memU's own adapters drop reasoning traces too.
- **Append-only.** memU stages a per-session cursor counting lines already mined. Rewriting or compacting a mirrored file would silently re-mine or skip records, so the sink only ever appends. A failed write is logged and dropped — a mirror that cannot be written never fails your turn.

### Closing the loop: the memU bridging task

Mirroring alone stores nothing in memU. The mirror is *input* to memU's pipeline; a scheduled task turns it into memory:

1. `memu-agent prepare --session-dir ~/.dsh/memu-sessions --base-dir ~/.memu/hosts/dsh` slices new turns into self-contained job files.
2. An agent reads each job and decides — do nothing, patch an existing skill, or write a new one. This step is real agent work, not a script.
3. `memu-agent commit --base-dir ~/.memu/hosts/dsh` submits whatever the jobs produced back into memU.

Ask your agent to register it, naming this plugin's directory:

> Read `memu-agent docs task` and register the memU bridging task, with `<SESSION_DIR>` = `~/.dsh/memu-sessions` and `--base-dir ~/.memu/hosts/dsh`.

`--base-dir` keeps `dsh` off the shared generic tree, so another agent using `memu-agent` on the same machine cannot collide with it. Changing `sessionDir` in this plugin's config means changing `--session-dir` in that task too — they are two ends of one pipe.

Confirm the mirror is being produced and read:

```bash
ls ~/.dsh/memu-sessions/*/          # sessions are being mirrored
memu-agent detect                   # memU recognizes the dialect
memu-agent doctor                   # the store is reachable
```

## The retrieval hook

`memory_search` runs memU's progressive retrieval — the query is embedded once, and segment/file/resource layers come back ranked. No LLM call, no summarization, cheap enough for a per-turn path. The tool returns memU's JSON exactly as memU shaped it, so [Code Mode](https://github.com/deepseek-ai/deepseek-harness) programs get the real structure rather than prose to parse:

```ts
const memory = await tools.memory_search({ query: 'deployment preferences' })
```

The standing instruction registers as the `memory:memu` system-prompt section at order 150, in the tool-guidance band. Set `guidance: false` to keep the tool while owning that text from your own prompt layer.

## Configuration

Every row in the bundle's [`cordis.patch.yml`](cordis.patch.yml) is a schema default, spelled out so it is copyable — a patch replaces a row's entire `config` value rather than deep-merging, so a profile overriding one key must restate the rest.

| Key | Default | Meaning |
|---|---|---|
| `binary` | `memu-agent` | The memU host-adapter binary. Point it at a dedicated binary (`memu-claude-code`, …) only to share that host's own tree. |
| `sessionDir` | `~/.dsh/memu-sessions` | Where the write-back mirror lives — the `--session-dir` the bridging task mines. |
| `project` | `''` | Subdirectory grouping one project's sessions. Empty derives it from the session's working directory. |
| `writeBack` | `true` | Register the write-back hook. |
| `retrieve` | `true` | Register the `memory_search` tool. |
| `guidance` | `true` | Register the standing instruction to search memory before answering. |
| `timeoutMs` | `20000` | Milliseconds one `retrieve` call may take before the child is killed. |
| `maxToolResultChars` | `4000` | Bound on one mirrored tool result. memU wants to see that a command ran and roughly what it returned, not a 40k-line build log. |
| `maxRetrieveChars` | `24000` | Bound on the JSON `memory_search` shows the model. Code Mode still receives the complete value. |

To override in a profile, restate the row in `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- insert:
    - id: personal-memory
      name: dsh-personal-memory
      config:
        binary: memu-agent
        sessionDir: ~/work/dsh-sessions
        project: ''
        writeBack: true
        retrieve: true
        guidance: true
        timeoutMs: 20000
        maxToolResultChars: 4000
        maxRetrieveChars: 24000
```

## Privacy

The write-back hook mirrors your prompts, the assistant's visible replies, and every tool call and result into `sessionDir` in plain text, and the bridging task sends what it distills to whichever memU backend you configured — including memU Cloud, if that is the configured mode. Tool results routinely contain file contents and command output from the machine `dsh` is running on.

Set `writeBack: false` to keep `dsh` a read-only consumer of memory other agents wrote. To stop mirroring one project only, run `dsh` there under a profile that sets it false.

## Development

```bash
npm install
npm run build        # tsc → lib/ + lib/types/
npm test             # builds, then runs the Node test suite
```

The write-back mapping's whole claim is that memU buckets its records correctly, so that is checked against memU's real classifier rather than against our reading of it:

```bash
git clone https://github.com/NevaMind-AI/MemU
PYTHONPATH=MemU/src python3 tests/classify_check.py
```

## Known limitations

- **Retrieval is model-driven, not automatic.** The standing instruction asks the model to call `memory_search`; it is guidance, not enforcement. A `agent/pre-step` listener that retrieved unconditionally would be the stronger seam, at the cost of a memU call on every step.
- **The generic adapter is the only tested path.** `binary` accepts any host adapter, but the mirrored dialect is verified against `memu-agent`. A dedicated `memu-dsh` adapter — a `TranscriptSource` plus a thin CLI on memU's side — would let memU discover `dsh` sessions itself, with no `--session-dir` to keep in sync.
- **Sessions resumed from a seed re-mirror their inherited events.** The sink writes what the live session emits and does not consult `seedLength`, so a forked session's inherited prefix is mirrored again under the new session id. memU's per-session cursor keeps it from being mined twice within one session, but the same content can reach the store from both lineages.
- **The bridging task is registered out of band.** Install, schedule, and `--base-dir` live in memU's own setup flow; this plugin neither registers nor verifies them, so a mirror can accumulate with nothing mining it. `ls ~/.memu/hosts/dsh/jobs/` after a scheduled run is the check.

## License

[Apache-2.0](LICENSE), matching memU.
