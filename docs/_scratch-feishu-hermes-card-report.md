# Flowship 飞书卡片：纯思考丢失修复 + Hermes 交互全移植

> 子代理报告 · 2026-07-20 · 未 commit / 未重打 FlowshipTest

## 验收结果

| 检查 | 结果 |
|------|------|
| `pnpm typecheck` | 0 error |
| `pnpm lint` | 0 warning |
| `pnpm vitest run tests/feishu-bridge-*.test.ts` | 156 passed（live 默认 skip） |
| 真机三卡 `failTotal` | **0** |

### 真机卡 ID（cli_aac269da35399cf9 / owner `ou_40832fc8084baf7cb7730a443c70aec2`）

| 种类 | cardId | messageId | failCount |
|------|--------|-----------|-----------|
| ①纯思考轮 | `7664416930505640913` | `om_x100b6ae3e74fe8acb1611b73a6417bb` | 0 |
| ②带工具轮 | `7664416955353058256` | `om_x100b6ae3e72cbcf8b2a5af854948339` | 0 |
| ③ask 按钮 | `7664416985656708083` | `om_x100b6ae3e49894b8b048fbad58a91bd` | 0 |

复跑：`FLOWSHIP_DATA_DIR=…/fe-ai-flow-test/data LARKSUITE_CLI_CONFIG_DIR=~/.lark-cli-flowship-test node scripts/smoke-feishu-hermes-roundtrip.mjs`

---

## 任务 1：真因（带证据）

### 根因 A（主，outbound）— pendingOps × finalize 竞态

`finalizeTurn` **先** `turn.finalized = true`，再 `await turn.startPromise`。
`withCard` 的 pending 回调原逻辑：

```ts
if (turn.finalized || !turn.card) return; // ← 思考/正文缓冲全丢
```

而 finalize 路径只补推 `pushAnswer`（换图），**不补推 process** → 表现恰为「正文在、思考空、面板标题仍是 0 次工具调用」。

**证据**：单测 `start 未完成时 done 到达：pending 思考仍在 finalize 前推上`；修复后 pending 不再因 finalized 跳过，且 finalize 前强制 `renderProcess(..., true)` 再 `pushProcess`。

### 根因 B（card-stream）— 全量 PUT 与嵌套 content 不同源 / 可被抹

1. `rebuildCardJson` 曾读 `processFlushed` 而非 desired；节流窗内 finalize / header 全量 PUT 可能带空 process。
2. CardKit `streaming_mode` 下全量 PUT 对 `collapsible_panel` 嵌套 markdown **不可靠**；batch `update_element` 才是嵌套区可靠写入。全量 PUT 后若不 batch 回写，面板可被抹空。

**修复**：canonical = desired；任何全量 PUT 后 `batchPutProcess` 回写；单测「纯思考轮 finalize 后 process 内容保留」。

### 线索 c（节流抢跑）

已覆盖：finalize 清 timer → `doFlush` → sync desired → PUT + batch 回写。

---

## 任务 2：Hermes 移植清单

### 已搬

| 项 | 落点 |
|----|------|
| 单一 render ← 单一状态（desired） | `card-stream` canonicalProcess/Answer + rebuild |
| 全量更新后思考区再断言（防嵌套抹掉） | `putEntityThenReassertProcess` |
| 折叠面板 `expanded: false`（运行中/完成均折叠） | `buildStreamingCardJson`（Hermes `timeline_expanded` 默认 false） |
| timeline 尾部 12 条 + 无思考时顶换 + 折叠计数行 | `outbound` selectTimelineParts / renderProcess |
| 思考/工具截断 1200/600 | 已有，保持 |
| header 状态机 thinking indigo / in_progress blue / waiting orange / completed green / failed red | card-stream；waiting/failed subtitle 改空（Hermes 同款，summary 承载） |
| footer spinner / 耗时 · 着色模型 · 深链；failed「已停止」 | 已有 + failed subtitle 对齐 |
| 工具 detail 敏感字段脱敏 | `redactToolDetail`（Hermes `_redact_tool_detail`） |
| finalize 时开放思考强制 completed | `renderProcess(..., true)` |
| ask 点选后「已选择：」 | card-action 已有，未改协议 |
| 按钮 default/medium | 已有 |

### 未搬 / 不适用（理由）

| 项 | 理由 |
|----|------|
| 每次 flush 整卡 PATCH 消息（无 CardKit 流式） | 保留 **md_answer 打字机**（既有决策） |
| token / context / subscription_usage footer | Hermes 计费字段，我们无对等数据 |
| timeline 多块 markdown（按 2400 拆） | 我们单 `md_process` + batch；拆块会破坏 element_id 稳定更新 |
| 思考区放正文后 | 用户 2026-07-19 拍板「思考在正文前」 |
| main_content_N 分块 | 破坏正文前缀守卫 |
| notice delivery / native_reply 去 header | 无对等通道 |
| progress_handoff 推断 in_progress | 无 Hermes 会话语义；避免误伤完成态 |
| runtime_header 改 title | 我们用 subtitle 承载工具预览 |
| 空 timeline 时另挂 tool_summary | 我们始终保留 panel（稳定 element_id 供 batch） |

### 我们特有保留

回显引用块、ask/retry 协议、深链 footer、element_id 短哈希、md_answer 打字机、R1-4 stopped 灰卡。

---

## 改动文件

- `src/lib/server/feishu-bridge/card-stream.ts`
- `src/lib/server/feishu-bridge/outbound.ts`
- `tests/feishu-bridge-card-stream.test.ts`
- `tests/feishu-bridge-outbound.test.ts`
- `tests/feishu-bridge-live-smoke.test.ts`（OPEN_ID 换新机器人 owner + Hermes 三卡用例）
- `scripts/smoke-feishu-hermes-roundtrip.mjs`（真机入口）
