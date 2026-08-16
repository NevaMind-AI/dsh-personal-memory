# @nevamind-ai/dsh-memu

[English](README.md) | 中文

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的首个原生 memory 插件，底层使用 [memU](https://github.com/NevaMind-AI/memU)。它不经 MCP，直接实现持久记忆的两条链路：

- **召回：**在含有新用户输入的 step 前自动检索 memU，并提供显式的 `memory_search` 工具。
- **记忆形成：**把干净的 DSH 对话与工具事件镜像为普通 JSONL，交给 memU 定时执行 `prepare → self-evolve → commit`。

插件以 DSH bundle 的形式按 profile 启用；卸载 bundle 会同时撤销所有 Cordis 注册。

## 前置条件

- Node.js `^22.19.0` 或 `>=24`
- DeepSeek Harness `0.1.0-rc.6`（`next` dist-tag）
- Python `>=3.11`
- 已配置为 Cloud 或 Local 模式的 `memu-cli`

先安装并验证 memU：

```sh
pip install memu-cli
memu-agent doctor
```

`doctor` 必须通过。新 store 返回 0 条命中是正常结果。

## 安装

发布包：

```sh
dsh plugin --profile web add @nevamind-ai/dsh-memu
```

本地 checkout：

```sh
dsh plugin --profile web add .
```

需要使用记忆的每个 DSH profile 都要单独安装。首次安装后重启该 profile；之后 DSH 会热加载 `cordis.patch.yml` 的修改。

bundle 会插入：

```yaml
- insert:
    - id: memory-memu
      name: '@nevamind-ai/dsh-memu'
      config:
        command: memu-agent
        autoRetrieve: true
```

## 模型会看到什么

插件增加一条很短的 system-prompt 规则以及 `memory_search` schema。在符合条件的 step 前，它只使用用户直接输入查询 memU；非空结果会以 `form: recall` 的插件消息写入持久历史，并排在当前请求之前。

每次召回都会明确标注：memory 是历史用户数据，不是指令；当前 system、workspace 和 user 指令始终优先。空结果不增加 token。

`memory_search` 接收一个聚焦的自然语言 `query`，使用同一条有超时和大小限制的召回路径，并返回 memU 的 `segments`、`files`、`resources` 三层渐进式结果。

## 开启记忆形成

插件会把后续的用户直接消息、模型消息、工具调用和工具结果写到：

```text
~/.memu/hosts/deepseek-harness/sessions/*.jsonl
```

插件注入的 recall 与其他运行时上下文不会进入侧写，避免 memU 把自己的注入误当成用户原话。文件名使用 session ID 的 SHA-256；原始 ID 只保留在本机 owner-only 行内。

先运行 prepare 验证门：

```sh
memu-agent prepare \
  --base-dir ~/.memu/hosts/deepseek-harness \
  --session-dir ~/.memu/hosts/deepseek-harness/sessions
```

然后让 DSH headless agent 定时执行以下流程。生成的 job 必须由 agent 自己处理；memU 的 `MemoryService` 不会发起 LLM 调用。

```text
严格按顺序执行 memU bridging pipeline。

1. 如果 ~/.memu/hosts/deepseek-harness/jobs 已有 *.txt，按数字升序逐个处理，
   然后执行：
   memu-agent commit --base-dir ~/.memu/hosts/deepseek-harness
2. 执行：
   memu-agent prepare --base-dir ~/.memu/hosts/deepseek-harness --session-dir ~/.memu/hosts/deepseek-harness/sessions
   失败则停止。
3. 列出 ~/.memu/hosts/deepseek-harness/jobs/*.txt，按数字升序处理全部文件。
   逐个读取并严格遵循其指令；某个 job 不产出文件是合法结果。
4. 执行：
   memu-agent commit --base-dir ~/.memu/hosts/deepseek-harness
   失败则停止并报告错误。

最后用一行说明处理了多少 job，以及提交了什么。
```

可用 agent runner 或系统 scheduler 调度。Unix 按小时运行时，应把 prompt 放进文件，不要内联到 crontab；用锁避免重叠，并以 `MEMU_BRIDGING_RUN=1` 启动 headless agent。如果该 bundle 也装在 headless profile，这个变量会阻止插件记录 self-evolve 自己的会话。

运行 `memu-agent docs task` 可查看 memU 完整的 scheduler、残留 job、裸 `PATH` 和错误报告流程；其中仍需保留上面的 integration-specific `--base-dir` 与 `--session-dir`。

## 配置

可在 profile 或 home 级 `cordis.patch.yml` 覆盖该行。DSH patch 会整体替换 `config`，所以请重述需要保留的所有字段。

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `command` | `memu-agent` | memU 可执行文件名或绝对路径 |
| `autoRetrieve` | `true` | 新的用户直接输入进入 step 前自动召回 |
| `captureTranscripts` | `true` | 写入 memU-compatible sidecar JSONL |
| `transcriptDir` | `~/.memu/hosts/deepseek-harness/sessions` | sidecar session 目录 |
| `timeoutMs` | `10000` | 整次召回截止时间 |
| `maxOutputBytes` | `65536` | stdout/stderr 各自的大小上限 |
| `processGraceMs` | `1000` | 子进程终止宽限时间 |
| `maxQueryChars` | `8000` | query 上限；超出时保留最新尾部 |

关闭自动召回、保留显式搜索和会话侧写：

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

## 安全与隐私

- 插件通过 Harness 的 managed subprocess service 传递 argv，不拼接 shell 字符串。
- 召回有截止时间及 stdout/stderr 上限；无效 JSON 或错误的渐进层类型不会进入模型上下文。
- Harness 通常会移除子进程环境中疑似凭据的变量。本插件只显式转发 `MEMU_*`，以兼容通过进程环境配置 memU；常规安装仍建议使用 owner-only 的 `~/.memu/config.env`。
- sidecar transcript 以明文保存对话与工具数据。插件会把配置目录权限收紧为 `0700`，并把 transcript 文件收紧为 `0600`。
- `MEMU_BRIDGING_RUN=1` 会关闭该 DSH 进程的 transcript capture。
- backend 配置、保留策略、Cloud 身份、embedding 和删除操作仍由 memU 负责。

## 验证

```sh
pnpm run check
pnpm pack --dry-run
```

功能 smoke test：

1. 用插件启动 DSH，让它记住一个唯一偏好。
2. 确认 transcript 目录出现新的 JSONL。
3. 手动执行一次 bridging pipeline。
4. 新建 DSH session，询问该偏好，确认自动 recall 或 `memory_search` 返回它。

## 已知限制

- 记忆形成是定时的，不是即时写入；这与 memU 的 agent-driven distillation 设计一致，插件不会另造一套写接口。
- sidecar 只捕获插件启用后的事件。安装或热加载时，不会回填已经打开 session 的 constructor history。
- 自动召回最多增加 `timeoutMs` 延迟。失败时只记录 warning，并保持原 step 不变；显式 `memory_search` 失败会作为 tool error 对模型可见。
- generic memU CLI 会把该路径记为 host `agent`。未来可增加专用 `memu-deepseek-harness` adapter 来改善 host-specific diagnostics，而无需改变本插件的 transcript 格式。
- sidecar JSONL 会重复保存 DSH canonical session log 的一个受限子集，因此会额外占用本机磁盘。
