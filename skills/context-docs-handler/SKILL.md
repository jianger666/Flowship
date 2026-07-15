---
name: context-docs-handler
description: >-
  处理 ai-flow super-prompt 顶部「用户提供的上下文文档」一节。
  看到这节后、不确定怎么拉取 / 怎么处理 doc 之间的冲突 / text 截断标记是什么意思 / 什么时候不该拉、
  请 read 本 skill。适用于 task 下任意 action（plan / build / review / ship / dev）及 chat。
---

# ai-flow 上下文文档清单处理协议

## 什么是「上下文文档清单」

super-prompt 顶部会出现「用户提供的上下文文档」一节（由 `renderContextDocsSection` 注入），列出用户在任务详情页上下文面板里加的全部条目。每条 doc 有：

- **title**：用户取的名（如「飞书 story」「后端技术方案」「补充说明」）
- **type**：后端推断、取值 `url` / `path` / `text` / `image`
- **content**：URL / 绝对路径 / 原文 / 图片绝对路径

清单展示形式（举例）：

```
1. **【飞书 story】**（url）
   https://project.feishu.cn/...

2. **【后端技术方案】**（url）
   https://wukongedu.feishu.cn/docx/...

3. **【补充说明】**（text、87 字）
   补升仅限 status=pending 的任务…

4. **【贴图】**（image、用户截图）
   /Users/.../tasks/<id>/uploads/att_xxx.png
   → 用 `read` 工具读这个路径、SDK 会自动转 vision
```

## 三条原则

1. **看清单、决定拉哪几份**、不要一上来全拉穿（防 token 爆 + 防无关信息搞乱思路）
2. **type=text 已 inject 全文**、不要重复拉；**type=image 只列路径**、用 `read` 看图
3. **以「本 action 真需要」为准**：例如设计稿细节可留到 build、不必在 plan 全背

## 按 type 拉取方式

### type=url（按域名分流）

| URL 模式 | 推荐工具 | 提炼重点 |
|---|---|---|
| `project.feishu.cn/.../story/...` | 有 `feishu-project-mcp` 用 `get_workitem_brief`；没有用内置 `meegle` CLI | story title / description / 验收标准 / 状态机 / 评论 |
| `*.feishu.cn/(docx\|wiki\|sheets\|doc)/...` 或 `wukongedu.feishu.cn/...` | 有 `feishu-mcp` 拉正文；没有用内置 `lark-cli` | 业务规则 / 文案 / 接口字段 / 状态机 |
| 含 `swagger` / `api-docs` / `openapi` | `shell` curl 拿 JSON、自己解 schema | path / method / params / response |
| 其他 http | `shell` curl 或 SDK fetch | 看内容性质判断 |

### type=path

绝对路径、用 SDK 内置 `read`（不是 `read_file`）。图片自动走 vision；文本 / Markdown / JSON 直接读。

### type=text

清单里已经 inject 全文、**不要重复拉**。

若 content 末尾出现「**已截断、原文共 N 字、超过 1000 字上限**」标记：

1. 默认按截断后内容处理
2. **若对方案 / 实现决定重要**、把「需要补完整 XXX」写进本 action 的 artifact（`actions/<N>-<type>.md`）「待澄清 / 不确定项」——用户审阅时可在面板补文档

### type=image

清单已给出截图绝对路径 +「用 `read` 转 vision」提示——对路径调 `read` 即可看到像素。

## 冲突处理

不同 doc 说法对不上时：

1. **不自己拍板**、不猜哪个对
2. 在本 action artifact（如 `actions/<N>-plan.md`）加「上下文冲突」节、列两份原文 + 来源
3. 同时进「待澄清 / 不确定项」、等用户审阅时澄清

## 不要做的事

- 不要拼命拉每一个 URL
- 不要从拉到的文档里发现新链接又递归去拉（例外：该链接是业务规则唯一来源）
- 不要在 `assistant_message` 里把清单原样贴回用户
- 不要质疑路径 / URL 有效性：拉不到 / 404 报出来 + 列不确定项即可

## 跨 action 复用（V0.6：无 phase 顺序）

action 模型是 **task 容器 + 任意触发**（`plan` / `build` / `review` / `ship` / `dev`），产物路径为 `data/tasks/<id>/actions/<N>-<type>.md`（prompt 里常写相对形式 `actions/<N>-<type>.md`）。

- **plan**：拉 story / PRD / 技术方案 + 必要时设计稿 / swagger → 写 `actions/<N>-plan.md`
- **build**：默认沿用 plan 已拉资料；用户新加文档在下次启动 / 续接时清单会更新 → 再按需补拉
- **review / ship / dev**：按本 action 需要读清单，不重复全量拉取

## 用户中途补上下文

用户可在任务详情页**随时**加 / 删上下文；**当前正在跑的 run** 里 super-prompt 已定稿、看不到新加条目。

- 新加的文档下次**启动新 agent / 推进新 action** 时可见；复用会话的普通消息不会刷新清单
- 若用户在消息里明确说「我加了新的上下文 XX」、去看最新清单；当轮拿不到就写进「待澄清 / 不确定项」
