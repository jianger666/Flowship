# Grok Build chat UI / 交互层差距清单（2026-07-20）

> **范围**：只读对比 [`xai-org/grok-build`](https://github.com/xai-org/grok-build) 开源树的 **chat UI / 交互层** vs Flowship chat。  
> **本机 clone**：`/tmp/grok-build`，`HEAD=ba76b0a683fa52e4e60685017b85905451be17bc`，`SOURCE_REV=ba69d70c2f7d70a130a323b2becdf137af784c7f`。  
> **不重复**：非 UI 资产（compaction prompt / rewind 结构 / bash describe 等）见 [`grok-build-portable-assets-2026-07-17.md`](./grok-build-portable-assets-2026-07-17.md)。  
> **口径**：挖不到标「未挖到」，不臆造。

---

## 1. grok-build UI 技术形态

| 项 | 结论 | 证据 |
|---|---|---|
| 产品形态 | **终端全屏 TUI**（非独立 Web / Electron GUI） | 根 `README.md`：「terminal-based AI coding agent」「full-screen TUI」 |
| 框架 | Rust + **ratatui** + **crossterm**（pager crate） | `crates/codegen/xai-grok-pager/Cargo.toml`（`license = "Apache-2.0"`）；`src/views/prompt_widget/mod.rs` import `ratatui` / `crossterm` |
| 主 UI 代码路径 | `crates/codegen/xai-grok-pager/` | README「Repository layout」；TUI：scrollback / prompt / modals / dashboard / welcome |
| 二进制 | `xai-grok-pager`（发行名 `grok`） | `crates/codegen/xai-grok-pager-bin` |
| 官配「其它 UI」 | **无自带 Web/Desktop chat UI**；IDE 走 **ACP** stdio / WebSocket relay；文档站 [docs.x.ai/build](https://docs.x.ai/build/overview) | `docs/user-guide/15-agent-mode.md`；README 不指向独立 GUI 仓 |
| 会话存储 | `~/.grok/sessions/<encoded-cwd>/<session-id>/`，按 **工作目录分组落盘** | `docs/user-guide/17-sessions.md` |

**结论**：对标对象是 **TUI 交互语义**（会话组织、picker、dashboard、composer、快捷键），不是可直接抄的 React 组件树。移植价值在 **信息架构 + 交互协议**，不在像素级 UI。

---

## 2. 逐块对比表

图例：**照搬建议** = 是否值得把 **交互语义** 迁到 Flowship（自写实现，非抄 TUI 源码）。优先级 P0（用户痛点/高 ROI）→ P2（锦上添花）。工作量 S/M/L。

### 2.1 侧边栏 / 会话列表组织（用户重点）

| 维度 | grok-build 做法 | Flowship 现状 | 差距 | 照搬建议 | 工作量 |
|---|---|---|---|---|---|
| 主分组轴 | **按 cwd/repo**：session picker `build_grouped_picker_entries` 按 `repo_name` 分组；当前 cwd 对应组置顶；CLI `grok sessions list` 按 **worktree label** 分组 | **时间桶**：置顶 / 今天 / 昨天 / 近 7 天 / 更早（`app-sidebar.tsx` `timeBucketFor` / `buildTimeGroups`） | 时间桶与「我在哪个项目聊」心智错位；用户点名不合理 | **P0：弃用或降级时间分组 → 按工作目录/仓库分组**（未绑仓单独一组） | M |
| 活跃态分组 | Dashboard 默认按 **状态**：Needs input → Working → Idle → Inactive → Completed → Failed（`views/dashboard/state.rs` `RowState`）；可 `Ctrl+G` 切 **Directory** | 侧栏行首有 running / awaiting 指示（`task-list-item.tsx`），但 **列表不按状态分节** | 多对话并行时「谁等你」不聚在一起 | **P1：可选「按状态」视图**（或状态节叠在 repo 组内） | M |
| 置顶 | Dashboard：`Ctrl+T` pin；`Shift+↑/↓` **手动重排**；持久化 `[dashboard].pinned` / `reorder`（session id） | 有置顶（`setTaskPinned`）；组内仍按 `updatedAt`；**无手动重排** | 缺「固定顺序」 | **P1：置顶区内拖拽/按钮重排** | S–M |
| 搜索 | Picker：标题 fuzzy + **会话正文 Extended search**（`17-sessions.md`）；Dashboard：`Ctrl+/` 搜索模式，前缀 `a:`/`s:`/`#`（`23-dashboard.md`）；CLI + SQLite FTS5 | 侧栏仅 **标题** 本地包含匹配；搜索时打平分组 | 无正文搜、无状态前缀过滤 | **P0 保留标题搜**；**P2 正文/事件 FTS**（若数据量上来） | S / L |
| 源过滤 | Picker `SourceFilter`：All / Local / Remote / External（`session_picker.rs`） | 无（本地-only） | 不适用（无 remote session） | **不照搬** | — |
| 项目/文件夹 | 磁盘按 cwd 编码目录；picker 组头 = repo_name；`project_picker` 首 prompt 从非项目目录可选最近项目 | chat 新建 `repoPaths: []`（`use-new-chat.ts`）；之后可绑 workdir，但 **侧栏不展示/不分组** | 有仓字段、无列表组织 | **P0：侧栏用 `repoPaths[0]`（或 display name）作组键** | M |
| 重命名入口 | `/rename`；Dashboard `Ctrl+R` | 仅 **详情标题旁铅笔**（`chat-view.tsx`）；**侧栏无重命名** | 侧栏管理闭环不完整 | **P1：侧栏双击/菜单重命名** | S |
| 删除/关闭 | Dashboard `Ctrl+X` 双击关会话；`/quit` 退应用 | hover 删除 + confirm | 已有、够用 | 保持 | — |
| 归档 | **未挖到**「归档会话」产品能力（源码/指南里的 archive 多指 workspace 快照上传，非会话归档） | 无归档 | 双方都无 | **不造**（除非产品另立） | — |
| 多选管理 | **未挖到**会话列表多选/批量删（ask 题 multi-select 另论） | 无 | 双方都无 | **P2 观望**（量上来再做） | L |
| 常驻侧栏 vs 模态 | Welcome / `/resume` / `Ctrl+S` = **模态 picker**；Dashboard = **多 agent 总览**（非永久左栏） | Electron **常驻侧栏** | 形态不同；语义可借 | 保留常驻侧栏，**换分组轴** | — |

**关键源码证据（grok）**：

- 按 repo 分组 + 当前 repo 置顶：`crates/codegen/xai-grok-pager/src/views/session_picker.rs`（`order_repo_groups`、`build_grouped_picker_entries`，约 L57–68、L657–676）
- 按 worktree 打印：`crates/codegen/xai-grok-pager/src/sessions_cmd.rs`（`print_sessions_grouped`，约 L200–255）
- Dashboard 状态/目录分组 + pin/reorder：`docs/user-guide/23-dashboard.md`；`src/views/dashboard/state.rs`（`RowState`、`Grouping`）
- 无「今天/昨天」时间桶：在 pager session UI / user-guide 会话章节 **未挖到**

**关键源码证据（Flowship）**：

- 时间分组：`src/components/app-sidebar.tsx` L15–16、L37–102、L293–310
- 搜索仅标题：同文件 L146–153
- 置顶/删除行操作：`src/components/tasks/task-list-item.tsx`
- 新建 chat 不绑仓：`src/hooks/use-new-chat.ts` L28–32

---

### 2.2 消息流渲染

| 维度 | grok-build 做法 | Flowship 现状 | 差距 | 照搬建议 | 工作量 |
|---|---|---|---|---|---|
| 结构 | `scrollback/`：block 类型（user / agent / thinking / tool / system…）+ entry + fold | `event-stream/rows.tsx`：EventRow；thinking/tool 默认可折叠 | 大方向已对齐 | 参考语义即可 | — |
| Sticky turn header | `scrollback/sticky.rs`：滚动时 user prompt **粘顶**（iOS 节头） | **未挖到**等价 sticky | 长会话定位弱 | **P2：粘顶当前 turn 用户句** | M |
| 折叠/展开 | Vim/简单模式：`h/l`、`e`、`⇧E`、`Ctrl+E`（thinking）；可 `respect_manual_folds` | 点击 chevron；工具合并卡 | 键盘驱动弱 | **P2：键盘折叠**（桌面有价值） | S–M |
| 块级复制 | `y` 复制内容、`⇧Y` 复制元数据（如 shell cmd）；Enter 全屏看块 | 有 Copy 等（rows） | 工具命令一键拷贝可加强 | **P2** | S |
| 流内搜索 | `scrollback/search.rs` | **未挖到**当前对话内 Ctrl+F 级搜索 | 长 transcript 难搜 | **P2** | M |
| 队列可视化 | 独立 queue pane（`Ctrl+;`）；行级 send-now | 顶部 queueBanner 文案（`chat-view.tsx`） | 无队列列表/重排 | **P1：队列条可展开列表 + 提前发送**（若已有 server 队列） | M |

---

### 2.3 Composer 输入区

| 维度 | grok-build 做法 | Flowship 现状 | 差距 | 照搬建议 | 工作量 |
|---|---|---|---|---|---|
| 组件 | `views/prompt_widget/`：TextArea、paste chip、image chip、`@` file search、history search | `composer.tsx` + Lexical：slash skill、`@` 文件、附图/附路径、拖高、↑ 历史 | 能力面已接近/部分更强（skill token） | 保持自研 | — |
| 发送 vs 换行 | 默认可配 multiline；mid-turn Enter=排队；Ctrl+Enter 等 = **send-now（打断）**（`03-keyboard-shortcuts.md`） | 设置页提交快捷键；运行中可排队（banner） | **缺显式「打断并立刻发」** 与「只排队」分流 UX | **P1：双通道**（排队 vs 打断发送） | M |
| Shell 模式 | 空 prompt 敲 `!` 进 shell mode | **未挖到** composer 内 shell mode | TUI 特色；桌面可用独立终端 | **P2 / 低优** | L |
| 模式切换 | `Shift+Tab`：Normal → Plan → Always-approve | chat 无等价 cycle；task 有 action | chat 可简化 | **P2：仅 YOLO/权限** 若产品需要 | M |
| 命令面板 | `Ctrl+P` / `?`：快捷键 + slash + skills | slash 菜单有；**无全局 command palette** | 可发现性 | **P1：Cmd+K / Ctrl+P 面板** | M |
| 底部快捷键条 | Shortcuts bar 随 focus/状态变 | **未挖到**常驻 hint bar | 新手友好 | **P2：底部语境 hint** | S |

---

### 2.4 快捷键

| 维度 | grok-build 做法 | Flowship 现状 | 差距 | 照搬建议 | 工作量 |
|---|---|---|---|---|---|
| 文档化 | 完整表：`docs/user-guide/03-keyboard-shortcuts.md`；`Ctrl+.` / `?` 应用内 cheatsheet | 设置里提交快捷键；部分 Cmd+J 聚焦 | 缺统一速查 | **P1：设置页或 `?` 快捷键表** | S |
| 新建会话 | `Ctrl+N`（双击确认） | 侧栏「新建对话」按钮 | 可加全局快捷键 | **P1：Cmd+N 新建对话** | S |
| 会话 picker | `Ctrl+S` → resume picker | 侧栏常驻，无 picker 模态 | 形态不同 | 可选 Cmd+K 搜对话 | S |
| Esc Esc | 清稿 / 开 rewind | rewind 有 UI（chat-view）；手势未对齐 | 双 Esc 可考虑 | **P2** | S |
| 可重绑定 | Dashboard 等可经 `config.toml` `[keybindings]` | 仅提交快捷键可配 | 范围窄 | **P2** | M |

---

### 2.5 会话生命周期管理

| 能力 | grok-build | Flowship | 差距 | 照搬建议 | 工作量 |
|---|---|---|---|---|---|
| 新建 | `/new`、`Ctrl+N`、Dashboard dispatch | 侧栏一键新建 | OK | — | — |
| 恢复/列表 | `/resume`、欢迎页 recent、按 cwd 索引 | 侧栏全量 chat 列表 | 组织轴不同 | 见 2.1 / §3 | M |
| 重命名 | `/rename`、`Ctrl+R` | 详情内重命名 | 侧栏缺入口 | P1 | S |
| 删除 | 关会话 / 磁盘会话仍可 resume（产品语义偏「关」） | 永久删 task 目录 | 更狠；需保持确认 | 保持 | — |
| 置顶 | Dashboard pin + reorder | pin 无 reorder | 见 2.1 | P1 | S–M |
| 搜索 | 标题+正文；前缀过滤 | 仅标题 | 见 2.1 | P0/P2 | S/L |
| Fork | `/fork`（可选 worktree） | **未挖到** chat fork | 分支对话 | **P2**（产品拍板后） | L |
| Rewind | `/rewind`、Esc Esc；文件快照 | 已有 chat checkpoint/rewind（server） | UI 可再打磨 | 非本次重点；资产见 07-17 文档 | — |
| Compact | `/compact` + auto | 有 compact 推荐/能力（chat-view context） | 继续打磨即可 | 见非 UI 文档 | — |
| 归档 | **未挖到** | 无 | — | 不造 | — |
| 多选 | **未挖到** | 无 | — | P2 观望 | — |

---

### 2.6 其它亮点交互

| 亮点 | grok | Flowship | 建议 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| **Agent Dashboard**（多会话总览 + peek 回复） | `views/dashboard/` + `23-dashboard.md` | 侧栏 + 单会话页；无 peek | 多对话并行时 **peek 或分栏** 有价值，但非侧栏分组替代品 | P2 | L |
| Welcome + recent for **current cwd** | 欢迎屏列本目录会话 | 首页/侧栏全局列表 | 绑仓后「本仓最近」快捷入口 | P1 | S |
| Worktree 隔离会话 | fork/`-w`、sessions 按 label 分组 | task 有 isolateWorktree；chat 弱 | chat 一般不必强绑 | P2 | L |
| Mouse：点选块、滚轮 follow | TUI 完善 | Web 天然有 | — | — | — |
| ACP 嵌入 IDE | 一等公民 | Electron 自有壳 | 不对齐 | — | — |

---

## 3. 侧边栏组织推荐方案（针对「时间分组不合理」）

### 3.1 问题诊断

Flowship 时间桶（`app-sidebar.tsx`）模仿 Cursor 历史列表，但对 **coding agent 对话** 更关键的是：

1. **在哪个仓库/目录下聊的**（grok 磁盘与 picker 都以 cwd 为第一公民）  
2. **谁在跑 / 谁等你**（grok Dashboard 按 state）  
3. **用户钉住的少数会话**（双方都有 pin；grok 还支持手动序）

「今天/昨天/近 7 天」会把同一仓库的对话拆散，又把无关仓库揉进同一时间节——这正是用户痛点。

### 3.2 推荐信息架构（chat 模式）

```
[ 新建对话 ]
[ 搜索…… ]

置顶                    ← 用户钉住；支持拖拽排序（学 Dashboard reorder）
  · …

crm-web                 ← 组头 = settings 仓 displayName 或 basename(repoPaths[0])
  · 修登录 bug
  · …

fe-ai-flow
  · …

未绑定工作目录          ← repoPaths 空（当前新建默认）
  · 未命名对话 …
```

**组内排序**：`updatedAt` 倒序（默认）。  
**可选切换**（设置或侧栏小菜单，默认关）：「按状态」→ 待回复 / 运行中 / 空闲（映射 `runStatus` + awaiting 真需求信号，复用 `task-list-item` 已有逻辑）。

**时间信息**：不必当分组轴；可在行 tooltip / 次要文案保留「3 小时前」（已有 `formatRelative`）。

### 3.3 与 grok 的映射（避免生搬）

| grok | Flowship 落点 |
|---|---|
| `repo_name` / cwd 组 | `task.repoPaths[0]` + settings 仓名；无路径 →「未绑定工作目录」 |
| 当前 cwd 组置顶 | 可选：最近一次绑仓 / 当前打开对话的仓组吸顶（非必须） |
| Dashboard state 分组 | 可选视图或组内徽章，不必做成第二套 Dashboard |
| Extended content search | 二期；先做好标题搜 + 分组 |
| 模态 `/resume` | 不需要；常驻侧栏已覆盖「列表」职责 |

### 3.4 落地顺序建议

1. **P0**：去掉（或设置默认关闭）时间桶 → **按 `repoPaths` 分组** + 未绑定组；搜索仍打平。  
2. **P1**：侧栏重命名；置顶区重排；全局 Cmd+N；本仓「最近」可从组头折叠记忆。  
3. **P2**：正文搜索、状态分节、sticky turn、command palette、队列 pane。

### 3.5 明确不照搬

- TUI Vim 模式、shell `!` mode（除非产品要嵌终端）  
- Remote/External source filter  
- 会话「归档」与「多选批量」（双方源码均未形成产品面）  
- 完整 Agent Dashboard（成本 L；先把侧栏分组做对）

---

## 4. License 注意事项

| 项 | 内容 |
|---|---|
| 许可证 | **Apache License 2.0**（根 `LICENSE`：Copyright 2023-2026 SpaceXAI） |
| UI 结构/交互思路 | 自写 React 实现 **无碍**；属思想借鉴 |
| 复制用户指南原文/文案/快捷键表大段 | 保留版权与 Apache 声明，项目 NOTICE 记来源 |
| 直接 port Rust TUI 源码 | 需保留文件头许可；一般 **不建议**（形态不匹配） |
| 第三方 port | `THIRD-PARTY-NOTICES` / tools 内 openai/codex 等 port 需单独核——本清单未依赖那些路径 |

与 `docs/grok-build-portable-assets-2026-07-17.md` §0 口径一致。

---

## 5. 一句话结论

**grok-build 没有 Web/Desktop chat UI，官配交互是 Rust TUI + ACP。** 对 Flowship 最值得搬的是会话列表的 **「按工作目录/仓库分组 + 置顶可重排 +（可选）按运行状态」**，而不是 Cursor 式时间桶；消息流/composer 你们已大体对齐，优先补 **打断发送 vs 排队**、**命令面板/快捷键表**、**侧栏重命名**，Dashboard/peek/fork 作后续可选项。
