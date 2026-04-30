# fe-ai-flow

前端需求自动化流水线、定位为**公司前端项目通用工具**（B 端为主、未来可扩 C 端）。

**当前能力（V0.1）**：粘贴需求 + swagger → AI 输出结构化 spec.md。

后续会接入 plan / build / review、参见 [docs/HANDOFF.md](./docs/HANDOFF.md)。

---

## 快速开始

```bash
pnpm install
pnpm dev
```

打开 http://localhost:3000、按以下顺序操作：

1. **主页 `/`**：占位卡片、引导去设置
2. **设置页 `/settings`**：四张 Card——
   - **API Key**：粘贴 Cursor API Key（[这里办一个](https://cursor.com/dashboard/integrations)、`crsr_` 开头）
   - **默认模型**：从 SDK 拉的可用模型列表选 + SDK 参数（thinking / context / effort 等）
   - **仓库**：点「选择文件夹」弹原生 dialog 选目录、自动填仓库名
   - **MCP servers**：JSON 编辑器、自由配
3. 每张 Card 改完点自己的「保存」、不 auto-save

> ⚠️ V0.1 的"主页提交需求 → spec.md 流式输出 → 产物落 data/tasks/<id>/"流程已被 clean slate 清空、未来重建。

---

## 项目结构（当前）

```
fe-ai-flow/
├── src/
│   ├── app/
│   │   ├── layout.tsx                # 强制 dark + Providers + Toaster + 顶部导航
│   │   ├── page.tsx                  # 主页占位卡片
│   │   ├── globals.css               # Tailwind 4 + shadcn oklch 变量 + cursor: pointer 规则
│   │   ├── settings/page.tsx         # 4 张 Card：API key / 默认模型 / 仓库 / MCP servers
│   │   └── api/
│   │       ├── models/route.ts       # POST：代理 Cursor.models.list、按 displayName 排序
│   │       └── fs/pick-folder/route.ts # POST：osascript 弹原生文件夹选择（仅 macOS）
│   ├── components/
│   │   ├── providers.tsx             # next-themes 强制 dark
│   │   └── ui/                       # shadcn/ui base-nova 组件（card / select / button / ...）
│   └── lib/
│       ├── local-store.ts            # localStorage 读写 + 老 schema 兼容
│       ├── types.ts                  # ModelSelection / FeAiFlowSettings 等
│       └── utils.ts                  # cn() 等
├── docs/
│   ├── HANDOFF.md                    # 给新对话的 onboarding 文档（重点看）
│   ├── DESIGN.md                     # 关键设计决策与权衡
│   └── ROADMAP.md                    # 老路线 + 当前阶段说明
└── (data/、prompts/ 已删除、未来重建)
```

---

## 配置

| 类型 | 位置 | 说明 |
|---|---|---|
| Cursor API Key | localStorage | 不上传服务器、每用户自配 |
| 默认模型 + 参数 | localStorage | `ModelSelection`（id + 参数数组）、跟 SDK schema 一致 |
| 仓库列表 | localStorage | 默认空、走 `/api/fs/pick-folder` 选目录 |
| MCP servers | localStorage | JSON 编辑器、自由配 |
| ~~Prompt 模板~~ | ~~`prompts/`~~ | 已删、未来主流程重建时按"文件化"原则重做 |
| ~~任务数据~~ | ~~`data/tasks/<id>/`~~ | 已删、同上 |

---

## 流程蓝图（设计哲学保留、当前未落地）

```
[飞书 + swagger + 你输入]
        ▼
   ┌───────────┐
   │  Phase 1  │ → spec.md  ← 你 ack 2 分钟           🤔 上版已删、是否重建待拍
   └───────────┘
        ▼
   ┌───────────┐
   │  Phase 2  │ → plan.md（改动文件 checkbox）       🔲 未启动
   └───────────┘
        ▼
   ┌───────────┐
   │  Phase 3  │ → git diff + draft MR               🔲 未启动
   └───────────┘
        ▼
   [你看 MR + approve + merge]
```

设计哲学（参见 [docs/DESIGN.md](./docs/DESIGN.md)）：

- **单 agent + 多 phase**、不做 multi-agent（避免 hand-off 信息丢失）
- **每个 phase 强制 HITL ack**（业界没有"全自动"成功案例）
- **所有 LLM 调用打日志 + 产物落盘**（可观测、可回退）

---

## 下一步

主流程交互形态待和用户讨论后再动手。详见 [docs/HANDOFF.md](./docs/HANDOFF.md)「待决策项」。
