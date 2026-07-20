# 成熟产品交互借鉴候选清单（2026-07-20）

> 口径：来自 Codex 桌面版 / Cursor Agent Window / grok-build / Claude·ChatGPT 桌面版的「我们还没有」的交互。
> 已做或在做的不列（侧栏按仓分组、消息左右区分、长消息折叠、轮次分割线、Cmd+K、打断发送、队列列表、启动单行等）。
> 每条：交互描述 → Flowship 落点 → 成本。用户勾选后逐条派活。

## A. 阅读与导航

| # | 来源 | 交互 | Flowship 落点 | 成本 |
|---|---|---|---|---|
| A1 | Codex | **轮次导航**：上一轮/下一轮跳转箭头 + 「已处理 Xm Ys」每轮耗时小徽标 | 事件流右下角悬浮 ↑↓ 按轮跳；轮次分割线上带耗时 | S–M |
| A2 | Codex/ChatGPT | **回到底部**悬浮按钮（滚上去看历史时出现、点击回到最新） | 事件流滚动容器（Virtuoso 有现成 API） | S |
| A3 | Claude | **长产出「在面板打开」**：AI 输出超长 markdown/代码时右上角「展开到侧面板」阅读 | chat 复用 task 模式 artifact 面板容器 | M |
| A4 | Cursor Agent Window | **文件变更清单卡**：本轮 AI 改了哪些文件（增删行数）聚合成卡、点击看 diff | chat 绑 workdir 时按 checkpoint diff 生成；点击进 IDE 或内嵌 diff | L |

## B. 输入与控制

| # | 来源 | 交互 | Flowship 落点 | 成本 |
|---|---|---|---|---|
| B1 | Cursor | **上下文用量小表**：composer 角落一个百分比/色条，接近上限时变色提示（点击直达压缩） | 已有 context-usage 数据源，仅补 UI | S |
| B2 | ChatGPT | **建议快捷回复**：AI 回复末尾给 2-3 个一键继续按钮（「继续」「换个方案」…由模型顺带产出） | prompt 约定 + 事件 meta + 气泡尾按钮 | M |
| B3 | Codex | **会话置顶信息条**：当前 workdir/分支常驻小条（点击换绑）——现在绑定信息在 composer 上方、滚动后不可见 | chat 顶部 bar 已有 title，补 workdir/分支 chip | S |
| B4 | grok-build | **/fork 会话分叉**：从当前对话复制上下文开新对话（可选隔离 worktree） | server 复制 events + 新 task；入口放对话菜单 | L |

## C. 多会话与系统

| # | 来源 | 交互 | Flowship 落点 | 成本 |
|---|---|---|---|---|
| C1 | grok-build | **Dashboard peek**：多对话总览网格、每格显示最新一句、可就地快速回一句 | 工作台 tab 加「对话总览」视图 | L |
| C2 | Codex | **系统通知点击直达**：任务/对话完成的系统通知点击后跳到那个对话 | 壳已有 task-notify 链路，补 chat 完成通知 + 深链路由 | S–M |
| C3 | Cursor | **多窗口**：一个对话拆独立窗口并排看 | Electron 多 BrowserWindow + 路由；单实例锁内多窗 | L |

## D. 快速小件（凑单）

| # | 来源 | 交互 | 成本 |
|---|---|---|---|
| D1 | Codex | AI 回复悬浮操作条统一化（复制/重试/引用回复）——现在只有复制 | S |
| D2 | ChatGPT | 代码块行内「换行开关」（超长行 wrap/scroll 切换） | S |
| D3 | Cursor | 事件流工具行 hover 显示完整参数 tooltip（不用点开） | S |
