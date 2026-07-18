# Grok Build 可搬运资产清单（2026-07-17）

> 调研范围：[`xai-org/grok-build`](https://github.com/xai-org/grok-build)（`main`，`SOURCE_REV=2ec0f0c8488842da03a71eeee3c61154957ca919`）。  
> 只读联网挖源码 / 用户指南；对应 Flowship chat 打磨路线图 [`proposal-chat-polish-2026-07-17.md`](./proposal-chat-polish-2026-07-17.md) 的 P1–P5 消费方。  
> 未在源码/文档中确认到的项标「未挖到」，不臆造。

---

## 0. License 结论

| 项 | 结论 |
|---|---|
| 许可证 | **Apache License 2.0**（宽松） |
| Copyright | `Copyright 2023-2026 SpaceXAI`（`LICENSE` 文件抬头） |
| README 声明 | First-party code licensed under Apache-2.0；第三方见 `THIRD-PARTY-NOTICES` |

**搬运法律障碍（实务口径，非律师意见）：**

- **prompt 模板原文、默认参数、数据结构/流程设计**：Apache-2.0 允许复制、修改、再分发；若直接收录原文，需保留版权与许可声明（Apache §4）。
- **仅参考思路后自写实现**：通常无「复制源码」义务；仍建议在内部文档注明灵感来源。
- **注意**：`xai-grok-tools` 内含 openai/codex、sst/opencode 等 **port**（见 tools crate 的 `THIRD_PARTY_NOTICES.md`）——若搬的是那些 port 文件，需单独核对原许可；本清单下列资产均为 **SpaceXAI first-party** 路径。

**结论：对本清单资产（compaction prompt、rewind 结构、bash description、UI 参数、@ 引用规则）无限制性许可障碍；直接照搬文本时记得附 Apache-2.0 NOTICE。**

---

## 1. Compaction（P4）

### 1.1 Summarize prompt 模板原文

**【来源】** `crates/common/xai-grok-compaction/src/code_compaction/templates/full_replace_summary_prompt.txt`

**【原文】**

```text
Your task is to produce a faithful, concise summary of the conversation so far so that a successor assistant can continue the work seamlessly after the earlier turns are discarded. The successor will see the user's original query plus this summary. Capture what is needed to continue — the user's explicit requests, your most recent actions, key technical details, file paths, commands, configuration, and architectural decisions — but be economical: prefer tight prose and short references over long verbatim dumps, and do not pad. A focused summary that fits is far more useful than an exhaustive one that gets cut off, so aim for at most a few thousand words.
{user_context_section}
CRITICAL: If earlier turns include a prior compaction summary (marked with <conversation_summary> tags or a "This session is being continued" preamble), treat it as authoritative for the early history and carry its still-relevant information forward into your new summary so nothing important is lost across successive compeds.

Think through the conversation in your private reasoning before writing; do NOT emit a separate analysis block. Output the final summary inside a single <summary>...</summary> block, organized into the following numbered sections. Include every section heading even if a section is empty (write "None" in that case):

1. Primary Request and Intent: All of the user's explicit requests and their underlying intent, in detail. Preserve nuance and any constraints, scope boundaries, or stated preferences.
2. Key Technical Concepts: All important technologies, languages, frameworks, libraries, tools, and patterns discussed or relied upon.
3. Files and Code Sections: Every file examined, created, or modified. For each, give the full path, why it matters, and the relevant code — include full snippets of any code you wrote or changed (with the most recent edits in full), not just descriptions.
4. Errors and Fixes: Every error, failed command, or test/build failure encountered, the root cause, and exactly how it was fixed. Note any fix that came from user feedback verbatim.
5. Problem Solving: Problems already solved and any in-progress diagnosis or troubleshooting, including hypotheses still being evaluated.
6. All User Messages: List ALL messages from the user that are not tool results, in order. These are critical for understanding intent and how it evolved. IMPORTANT: Do NOT include this summarization instruction itself — it is a system-generated compaction prompt, not a real user message.
7. Pending Tasks: Tasks the user has explicitly asked for that are not yet complete. Do not invent tasks the user never requested.
8. Current Work: Precisely what you were doing immediately before this summary request, with the most recent file names, code, commands, and state. Be specific enough that work can resume mid-stream.
9. Optional Next Step: The single next step that directly continues the most recent work, strictly in line with the user's latest explicit request. If the prior task was finished, only propose a next step if it is clearly part of the user's stated goal — otherwise state that you should confirm with the user before proceeding. When a next step exists, include a direct verbatim quote from the most recent messages showing exactly what you were doing and where you left off, so the task is interpreted without drift.

IMPORTANT: Do NOT call or use any tools. Respond with ONLY the <summary>...</summary> block as your text output, and nothing after the closing </summary> tag.

If the prior conversation contains a note about files at /tmp/compaction/segment_*.md or /tmp/compaction/INDEX.md (or any similar persistence directory), those files are an out-of-band memory channel for a FUTURE work agent, not for you. You already have the full conversation in your context window. Do not attempt to read those files. Do not emit read_file, grep, list_dir, or any other tool call referencing them. Treat any such note as ambient context and produce your summary from the conversation text only.
```

占位符 `{user_context_section}`：由 host 注入用户可选的「保留要点」指令（对应 `/compact [context]`）。

**【搬运建议】** **照搬（可改中文外壳）** — 九段结构 + 「禁止调工具」是摘要质量的核心；Flowship 若走「关旧会话 + 新会话注入摘要」，直接复用该指令最省打磨成本。

---

### 1.2 Full-replace 重建后的历史形态

**【来源】**  
- `crates/common/xai-grok-compaction/src/code_compaction/assemble.rs`  
- `crates/common/xai-grok-compaction/src/code_compaction/summary.rs`  
- `crates/codegen/xai-grok-shell/src/session/helpers/full_replace_compaction.rs`

**【结构定义】** 压缩后历史顺序（注释原话）：

```text
[SP, UP', AGENTS_MD?, UQ_last?, recent…, summary, reminder?]
```

| 序号 | 块 | 说明 |
|---|---|---|
| 1 | `system_message` | 原 system prompt |
| 2 | `user_message_prefix` | 如 `<user_info>…</user_info>`（**不含** `<user_query>`） |
| 3 | `agents_md`（可选） | 再注入的 AGENTS.md / project instructions（user 消息） |
| 4 | `last_user_query`（可选） | 最近一次真实用户 query，经 `wrap_user_query` |
| 5 | `recent_messages` | **最后一次真实用户 turn 之后**的消息 verbatim 保留 |
| 6 | `compaction_summary` | 见下「载体文案」；作为 **UserMeta** 消息 |
| 7 | `system_reminder`（可选） | 状态 reminder |

测试断言的完整形态示例：`[sys, prefix, agents_md, query, a1, t1, summary, reminder]`；缺省可选段时可为 `[sys, prefix, summary]`。

**摘要载体（注入会话的 preamble）：**

```text
This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

{cleaned_summary}
```

`cleaned_summary` 由 `format_compact_summary` 清洗：剥 `<analysis>` scratchpad，把 `<summary>…</summary>` 转成 `Summary:\n…`。

**【搬运建议】** **改造后用** — 顺序「system + 环境前缀 +（可选）最近消息 + 摘要 preamble」可直接映射到 Flowship「懒重启首包」；AGENTS.md / system-reminder 用我们自己的 rules/skills 注入通道即可。

---

### 1.3 触发阈值 / 默认参数

**【来源】** `crates/common/xai-grok-compaction/src/code_compaction/config.rs`；文档 `docs/user-guide/04-slash-commands.md`；`acp_types.rs` 的 `ContextInfo`

| 参数 | 默认值 | 备注 |
|---|---|---|
| `DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT` | **85** | 注释：grok-build 与 Grok chat 共用；配置键 `[session] auto_compact_threshold_percent` |
| 解析层级 | env > user per-model > user global > GrowthBook per-model > GB global > **85** | 见 `ContextInfo.auto_compact_threshold_percent` 注释 |
| `FullReplaceConfig.max_attempts` | 3 | 含首次 |
| `FullReplaceConfig.retry_delay_secs` | 3 | 瞬态失败间隔 |
| `FullReplaceConfig.sampling_timeout_secs` | 120 | 单次摘要 LLM 调用超时 |
| `MIN_SUMMARY_SEED_CHARS` | 500 | 清洗后摘要短于 500 字视为 degenerate，按瞬态重试 |

**【搬运建议】** **照搬 85% + 3 次重试 / 500 字下限** — 有生产实证；阈值做成可配即可。

---

### 1.4 失败分类（`failure.rs`）

**【来源】** `crates/common/xai-grok-compaction/src/code_compaction/failure.rs`

**【结构定义】**

```rust
pub enum FailureKind {
    Deterministic, // 同 payload 重试必挂 → 立刻停，不 sleep
    Transient,     // 可重试（网络 / 5xx / 429 / 408）
}
```

| 分类入口 | Deterministic | Transient |
|---|---|---|
| `classify_http_status(status, msg)` | 上下文溢出文案；或 4xx（**除** 408、429） | 其余（5xx、408、429…） |
| `classify_stream_event_error(code, msg)` | `invalid_request_error`（code 或 message）；可解析的 4xx（除 408/429）；上下文溢出文案 | 未知 code、overloaded 等默认瞬态 |
| `is_context_length_error(msg)` | 匹配：`too long for this model` / `prompt is too long` / `maximum prompt length` / `maximum context length` / `context_length_exceeded` | — |

另：宿主层把 **degenerate summary（<500 chars）**、**EmptyResponse** 也当作可重试失败（见 `full_replace_compaction.rs` observer）。

**【搬运建议】** **照搬分类策略** — 小函数、与具体 HTTP 客户端解耦，适合抽到 `src/lib/compaction-failure.ts`。

---

## 2. Checkpoint / Rewind（P3）

### 2.1 `rewind_points.jsonl` 记录结构

**【来源】**  
- `crates/codegen/xai-grok-workspace/src/session/file_state.rs`  
- Session 目录下文件名：`rewind_points.jsonl`（`JsonlStorageAdapter::rewind_points_file_path`）  
- 文档：`docs/user-guide/17-sessions.md`

**【结构定义】** 每行一个 JSON `RewindPoint`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `prompt_index` | `usize` | 用户 prompt 序号（0-based） |
| `created_at` | `DateTime<Utc>` | 创建时间 |
| `file_snapshots` | `HashMap<path, FileSnapshot>` | **before**：该 prompt 内首次触及文件时的内容 |
| `after_snapshots` | `HashMap<path, FileSnapshot>`（默认空） | **after**：`end_prompt` 时再读盘的内容（用于冲突检测） |

`FileSnapshot`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `path` | `FlexiblePath`（相对 cwd 优先，兼容绝对） | 文件路径 |
| `content` | `Option<String>` | 全文；`None` = 当时不存在 |
| `captured_at` | `DateTime<Utc>` | 快照时刻 |

Picker 侧轻量元数据 `RewindPointMeta`：`{ prompt_index, created_at, num_file_snapshots }`（不物化正文）。

**并行的持久化镜像（可选，默认关）：** `CheckpointStore` 写  
`<cwd>/.grok/rewind-checkpoints/<session_id>/checkpoint-<prompt_index>.json`，内容为 `RewindCheckpoint { prompt_index, fs: RewindPoint, hunks?: HunkTurnDelta }`；默认 cap **64**；由 `GROK_WORKSPACE_REWIND_DURABLE` 打开。**恢复仍走进程内 tracker，不靠 rootfs 回滚。**

**【搬运建议】** **改造后用** — JSONL 一行一点 + before/after 双快照很适合对照 Flowship `events.jsonl`；durable 目录方案可后置。

---

### 2.2 文件快照策略

**【原文/结构要点】**（`file_state.rs` 模块注释 + `capture_file_state`）

- **不是全仓快照**：只对 **本 prompt 期间被读/改（touched）** 的文件建点。  
- **时机**：工具写/读前 `capture_file_state` → `add_snapshot`（**同一 path 只保留第一次 before**，`or_insert`）。  
- **结束**：`end_prompt` 对已有 before 的 path 再读盘写入 `after_snapshots`。  
- **范围**：cwd 外文件跳过。  
- **去重**：  
  - 单点内：before 首写胜出；  
  - rewind merge：`>= target` 的点折叠进前一点时，before 取最早、after 取最晚；  
  - **没有** 跨 prompt 的 content-addressed blob 去重——正文直接进 JSON（大仓会肥）。  
- 附带：hunk tracker / git rewind 为可选域（env flag，默认关）。

**【搬运建议】** **照搬「只快照 touched 文件 + before/after」** — 与路线图 Phase 3「轻量版」一致；内容寻址去重可后续再加。

---

### 2.3 Rewind 执行流程与边界

**【来源】**  
- `file_state::rewind_files`  
- `session/acp_session_impl/rewind.rs::handle_rewind`  
- 用户指南 `/rewind`

**【流程】**（`RewindMode::All` 默认「时间旅行」）

1. **校验** `target_prompt_index < current_prompt_index`（语义：**恢复到 prompt N 执行之前**，保留 `0..N-1`）。  
2. **（可选 Preview）** 只算冲突/清单，不写盘不截断。  
3. **文件恢复**：对所有 `prompt_index >= target` 的 before 快照，按 path 取**最早** before → 写回或删除；对比 latest after vs 当前磁盘标冲突（`ModifiedExternally` / `CreatedExternally` / `DeletedExternally`）——**冲突仍执行 revert**，仅记入 response。  
4. **对话截断**：标准路径 `conversation_truncate_for_prompt` 后 `truncate`；若跨过 compaction，则从 `updates.jsonl` **replay** 重建对话（避免 user 消息计数错乱）。  
5. **写回** chat-state：`prompt_index = target`，`prompt_texts.truncate(target)`。  
6. **截断 tracker**：`file_state_tracker.truncate_from(target)` + 持久化 `TruncateRewindPoints`；若有写盘错误则 **跳过 truncate** 以便重试。  
7. `ConversationOnly`：不改文件，但把 `>= target` 的文件效应 **merge** 进前一点，保证以后 `/rewind 0` 仍能收回改动。

UI：Esc Esc（空 prompt + idle，800ms 内）或 `/rewind` → 选点 → 确认。

**【搬运建议】** **改造后用** — 「先文件后对话 / 失败不丢 tracker / ConversationOnly merge」是边界精华；跨 compaction replay 可第二期再做。

---

## 3. Shell 工具模型指令（P1 / P5）

### 3.1 Description 模板原文

**【来源】** `crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs`  
`BashTool::default_description_template_enabled()` / `_disabled()`

**【原文 · background 启用时】**（MiniJinja；`${{ … }}` / `${%- if … %}` 为模板语法）

```text
Run a ${%- if is_windows %} shell command${%- else %} bash command${%- endif %} and return its output.

Usage notes:
  - You can specify an optional timeout in milliseconds (up to ${{ max_timeout_ms | default(300000) }}ms). ${%- if auto_background_on_timeout %} If not specified, commands exceeding the default timeout will be automatically backgrounded instead of killed. You will receive a task_id to check output later.${%- else %} If not specified, commands will timeout after ${{ default_timeout_ms | default(120000) }}ms.${%- endif %}
  - Timeout enforcement: when the timeout fires, the wrapper${%- if is_windows %} terminates the child's Job Object, killing every descendant process immediately (no graceful-termination grace period).${%- else %} kills the child process group (SIGTERM, escalated to SIGKILL after a ~1s grace period). Descendants that did not detach via `setsid` / `nohup` will also be killed.${%- endif %} `timeout: 0` in `${%- if params is defined and params.execute is defined and params.execute.is_background %}${{ params.execute.is_background }}${%- else %}background${%- endif %}: true` mode disables the wrapper timeout entirely; the child's lifetime is owned by the model via ${{ tools.by_kind.kill_task_action }}.
  - If the output exceeds {max_output_bytes} characters, output will be truncated before being returned to you.
  - You can use the ${{ params.execute.is_background }} parameter to run the command in the background (e.g., dev servers, long builds): it returns a task_id immediately and keeps running in the background. You are notified on completion, so do not poll or sleep-wait for it.${%- if has_unix_utilities %} You do not need to use '&' at the end of the command when using this parameter.${%- endif %}
${%- if shell_uses_semicolon %}
  - '&&' is not supported in this shell; chain sequential commands with ';'.
${%- endif %}
${%- if not has_unix_utilities %}
  - The Unix utilities `grep`, `head`, `tail`, `sed`, `awk`, and `find` are NOT available in this shell. Use the dedicated tools instead.
${%- endif %}
```

**Background 关闭时**：去掉 `is_background` / auto-bg 相关句，保留 timeout 上限与输出截断说明。

**Schema 字段级教模型文案（节选）：**

- `timeout`：Optional timeout in milliseconds (max 300000). Default: 120000. `timeout: 0` in background mode disables wrapper timeout.  
- `is_background`：长命令后台；**立即返回 task_id**；完成会通知，**不要 poll / sleep-wait**。  
- `description`：One sentence why this command needs to run…

**超时转后台后塞给模型的结果头（节选）：**

```text
[Command moved to background]
…
The command is still running in the background. You can continue with other tasks.
```
（完整格式见同文件 `format_bash_output` 的 `backgrounded` 分支。）

**【搬运建议】** **照搬（改成 Cursor SDK / 我们工具名）** — 「后台 + task_id + 禁止轮询」是 P5 引导文案的现成稿；SDK 无原生 auto-bg 时，把 auto-bg 段改成「请用 `&`/落盘」即可。

---

### 3.2 默认参数与超时转后台逻辑

**【来源】** `bash/mod.rs`；`crates/codegen/xai-grok-shell/src/terminal/mod.rs`；用户指南 `05-configuration.md` / `20-background-tasks.md`

| 参数 | 代码默认 | 备注 |
|---|---|---|
| 前台默认 timeout | **120s**（`DEFAULT_TIMEOUT` / schema 120000ms） | |
| 前台 max timeout | **300_000ms（5min）**；绝对上限 10h | 生产 shell 可把 `max_timeout_secs` 提到 10h |
| `output_byte_limit` | **`DEFAULT_OUTPUT_BYTE_LIMIT = 30_000`（字符）** | 文档示例写 `20000`——**以代码常量为准** |
| `enabled_background` | `true` | |
| `auto_background_on_timeout` | **`false`（BashParams::Default）** | 打开后才启用超时转后台 |
| FG block budget（auto-bg 时） | **15_000ms**（`DEFAULT_FOREGROUND_BLOCK_BUDGET_MS`） | 与 timeout 取 **min** 作为 FG 等待上限 |
| 后台 wrapper timeout | `timeout:0` / 省略 → **无界**；否则仅受 10h 绝对上限 | |
| 后台最大运行（另一常量） | `BACKGROUND_TIMEOUT = 24h` | 用于某些后台 kill 路径 |

**判定逻辑（注释原意）：**

1. 模型显式 `is_background: true` → 立即后台，返回 `task_id`。  
2. 若 `auto_background_on_timeout && enabled_background`：前台等待 `min(resolved_timeout, foreground_block_budget)`；到期 **迁后台**而非杀掉。  
3. 否则前台到期 → kill（Unix：进程组 SIGTERM→~1s→SIGKILL）。  
4. 命令里裸 `&`：默认允许（`allow_background_operator`）；否则要求改用 `is_background=true`。

**【搬运建议】** **参数照搬思路、auto-bg 仅参考** — Flowship 受 SDK 约束做不到同款 auto-bg；优先搬 description + 30k 输出上限。

---

## 4. 工具输出展示参数（P1）

### 4.1 折叠默认策略 + `group_tool_verbs`

**【来源】**  
- `crates/codegen/xai-grok-shared/src/ui_config.rs`  
- `crates/codegen/xai-grok-shell/src/util/config/resolve/ui.rs`  
- `crates/codegen/xai-grok-pager/src/scrollback/state/groups.rs` / `verb_group.rs`  
- `scrollback/blocks/tool/{mod,read,execute,edit}.rs`

| 设置 | 默认 | 含义 |
|---|---|---|
| `group_tool_verbs` | **ON**（`None` → true） | 连续「可归类」工具折叠成一行（如 `Read 3 files`） |
| `collapsed_edit_blocks` | **OFF**（`None` → false） | Edit 默认一行 `+N/-M`；false 时默认展开 diff |

**默认 `DisplayMode::Collapsed` 的工具块：**

- **Read / ListDir / Search / Web\*** 等：`default_display_mode = Collapsed`，完成后仍 Collapsed。  
- **Execute（agent shell）**：默认 **Collapsed**（只显示 description 标题）；**不**自动展开 stdout。  
- **用户 `!` bash**（`bash_mode`）：运行 Truncated，结束 Expanded。  
- **Edit**：上下文无关默认 Collapsed；实际「是否一行 summary」跟 `collapsed_edit_blocks`（默认关 = 展开看 diff）。

**`group_tool_verbs` 收成一行的规则：**

- 仅折叠 **`verb_group_kind()` 返回 Some 的「非破坏性」成员**：Read(File/Skill)、ListDir、Search、WebFetch、WebSearch、MemorySearch、IntegrationSearch、Skill；**连续 ≥1 个 member** 即可成组。  
- **Execute / Edit / MCP UseTool**：**不参与** eager verb-run（`verb_group_kind` 排除），但仍可出现在 truncation「N more」标签桶里。  
- 中间夹着的 **已结束且 collapsed 的 thinking** 可被 claim 进组但不计入 member 数。  
- 用户手动展开的成员变为 Transparent，不拆组。

**【搬运建议】** **照搬默认：读/搜默认折叠；shell/edit 默认可展开或单独策略** — 与「过程看得见」目标一致；verb-group 文案可第二期。

---

### 4.2 Edit inline diff 展示参数

**【来源】** `pager/src/diff.rs`；`scrollback/blocks/tool/edit.rs`；`docs/user-guide/05-configuration.md` `[scrollback.blocks.edit]`

| 参数 | 默认 | 说明 |
|---|---|---|
| 上下文行 | **`MAX_CONTEXT = 3`** | 合成 unified hunk 时 before/after equal 区最多保留 ±3 |
| `DiffRenderConfig.indent` | `true` | |
| `gutter_bg` / `indent_bg` | `false` | |
| `hunk_separator` | `"…"` | hunk 间分隔 |
| `dual_line_numbers` | `false` | 单列新文件行号 |
| `expanded_by_default` / `line_summary` | 跟随 `collapsed_edit_blocks` | 文档：unset 跟 config flag |

**未挖到：** 名为「compact 模式阈值」（例如「超过 N 行则强制折叠」）的独立常量——Edit 的疏密由 `collapsed_edit_blocks` + 用户 fold 控制，不是按行数阈值。

**【搬运建议】** **照搬 ±3 上下文 + `…` 分隔** — 实现成本低、观感接近 GB。

---

## 5. `@` 引用与输入（P2）

### 5.1 解析与 UI 规则

**【来源】**  
- `pager/src/views/file_search/context.rs`（输入框 @ 检测）  
- `line_viewer.rs`（`:N` / `:N-M` 后缀）  
- `workspace/.../attach_file.rs`（`FileReference::parse`）  
- `shell/.../prompt_parser.rs`（`collect_file_references`）  
- 用户指南 `01-getting-started.md`

| 语法 | 行为 |
|---|---|
| `@path` | 附加整文件 |
| `@path:10-50` / `@path:L10-L50` | 行区间（1-based inclusive）；UI 后缀 `:10` 或 `:10-12` |
| `@dir/` | 目录 drill-down（fuzzy 仅目录） |
| `@!…` | 含 hidden/dotfile（忽略默认隐藏） |
| 触发条件 | `@` 前不得是字母数字或 `_`（防邮箱）；token 到空白/` , `/`;` 为止；drill 时可含空格目录名 |

**`FileReference::parse` 正则：**

```text
^@?([^@].*?)(?::L?(\d+)-L?(\d+))?$
```

**Fuzzy 排序**（`file_system/fuzzy.rs`）：nucleo 匹配；`min_score = 7 + query_len*14`；同分按 **(path.len, path)**；Top-K 请求 **1000**。

**【搬运建议】** **照搬语法与防邮箱规则** — 与路线图 `@file:10-50` 完全对齐。

---

### 5.2 Prompt 注入方式

**【来源】** `prompt_parser.rs` + `attach_file.rs`

- 从用户消息里收集 `@…` token → 读盘 → **贴内容**（不是只贴路径）。  
- 行格式：`{lineNo}→{lineText}`。  
- 包进：

```xml
<system-reminder>
Below are some potentially helpful/relevant pieces of information for figuring out how to respond

<attached_files>

<file_contents path="…" startLine="10" endLine="50">
…
</file_contents>

</attached_files>

</system-reminder>
```

无行区间时属性为 `isFullFile="true"`。

- 组装顺序（Grok）：`<user_query>…</user_query>` +（skills）+ **context（附件）**。  
- **体积闸门**：估计 token > **`MAX_FILE_TOKENS = 5000`** → 不贴正文，只留 stub（`skipped="true"`，提示用 `read_file`）。

**【搬运建议】** **照搬「贴切片正文 + 5k token 闸」** — 比只喂路径更有用；大文件 stub 防爆上下文。

---

## 6. 顺手：`/context` 与 auto_compact

### 6.1 Token 构成维度

**【来源】** `acp_types.rs::ContextInfo` + `scrollback/blocks/context_info.rs` 渲染

| 维度 | 字段 / 行 | 怎么算（源码口径） |
|---|---|---|
| System prompt | `system_prompt_tokens` | 单独统计 |
| Messages | `message_tokens` | **非 system** 会话项的 bytes/4 估计 |
| Tool definitions | `tool_definitions_tokens` + count | 工具 schema |
| Skills | `usage_categories` ← `TokenUsageCategory::skills_listing(text, n)` | 对 skills listing 文本 `estimate_tokens` |
| MCP servers | `usage_categories` ← `mcp_servers(text, n)` | 对 MCP reminder 正文 `estimate_tokens` |
| Free | `free_tokens` | `total - used` |
| Overhead（UI） | `used - system - messages` | 图例「Reasoning/overhead」；tool defs 计入此视觉桶的注释说明见 context_info |
| 其它计数 | `turn_count` / `tool_call_count` / `compaction_count` / `message_count` | 会话统计行 |

UI 文案示例（模块注释）：`Auto-compact at 85% · ~812k tokens remaining`。

### 6.2 `auto_compact_threshold_percent`

**确认默认值：`85`**（`DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT`；文档与测试均写死 85）。

**【搬运建议】** **照搬维度命名 + 85%** — Flowship 先用 run-perf usage 做粗粒度透视即可，skills/MCP 可第二期按 listing 估算。

---

## 7. 索引：关键来源路径

| 资产 | 路径 |
|---|---|
| License | `/LICENSE` |
| Summarize prompt | `crates/common/xai-grok-compaction/src/code_compaction/templates/full_replace_summary_prompt.txt` |
| Assemble / failure / config | `…/code_compaction/{assemble,failure,config,summary}.rs` |
| Full-replace host | `crates/codegen/xai-grok-shell/src/session/helpers/full_replace_compaction.rs` |
| RewindPoint / rewind_files | `crates/codegen/xai-grok-workspace/src/session/file_state.rs` |
| CheckpointStore | `…/session/checkpoint_store.rs` / `checkpoint.rs` |
| handle_rewind | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/rewind.rs` |
| Bash tool | `crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs` |
| output_byte_limit | `crates/codegen/xai-grok-shell/src/terminal/mod.rs` |
| UI group / edit collapse | `crates/codegen/xai-grok-shared/src/ui_config.rs`；`…/resolve/ui.rs`；`pager/.../groups.rs` |
| Diff ±3 | `crates/codegen/xai-grok-pager/src/diff.rs` |
| @ UI | `pager/src/views/file_search/{context,state,line_viewer}.rs` |
| @ inject | `shell/.../prompt_parser.rs`；`workspace/.../attach_file.rs` |
| Fuzzy | `workspace/.../file_system/fuzzy.rs` |
| /context | `shell/.../acp_types.rs`；`pager/.../context_info.rs` |
| 用户指南 | `pager/docs/user-guide/{01,04,05,17,20}-*.md` |

---

## 8. 未挖到 / 需注意的差异

| 项 | 状态 |
|---|---|
| Edit「按行数 compact 阈值」独立常量 | **未挖到**（只有 `collapsed_edit_blocks` + fold） |
| `output_byte_limit` 文档 20000 vs 代码 30000 | **以代码 30000 为准** |
| `auto_background_on_timeout` 产品默认是否在 remote/requirements 打开 | 结构体 Default=**false**；是否生产强制打开 **未在本批完整追到 requirements.toml** |
| Cursor 兼容的 `<code_selection>` 渲染分支 | 代码注释仍提，但当前 Grok 路径实测走 `<file_contents>`（`is_cursor` 被 `_` 忽略） |

---

*文档结束。后续开发批次请直接引用各节【原文/结构定义】与【搬运建议】。*
