---
name: context-docs-handler
description: >-
  处理 fe-ai-flow plan 任务 super-prompt 顶部「用户提供的上下文文档清单」一节。
  看到这节后、不确定怎么拉取 / 怎么处理 doc 之间的冲突 / text 截断标记是什么意思 / 什么时候不该拉、
  请 read 本 skill。适用于 plan 模式所有 phase（V0.3.4 起为 plan / build 两个 phase）。
---

# fe-ai-flow 上下文文档清单处理协议

## 什么是「上下文文档清单」

super-prompt 顶部会出现一节「用户提供的上下文文档」、列出用户在 fe-ai-flow 任务详情页面板里加的所有上下文。每条 doc 有 3 个字段：

- **title**：用户取的名（如「飞书 story」「后端技术方案」「补充说明」）
- **type**：后端推断、取值 `url` / `path` / `text`
- **content**：URL / 绝对路径 / 原文

清单展示形式（举例）：

```
1. **【飞书 story】**（url）
   https://project.feishu.cn/...

2. **【后端技术方案】**（url）
   https://wukongedu.feishu.cn/docx/...

3. **【补充说明】**（text、87 字）
   补升仅限 status=pending 的任务、且 promoteCount < 3、超过 7 天不能补升。
```

## 三条原则（记住这三点、其他都是细节）

1. **看清单、决定拉哪几份**、不要一上来全拉穿（防 token 爆 + 防无关信息搞乱思路）
2. **type=text 已 inject 全文**、不要重复拉（清单里看到的内容就是全部）
3. **以「本 phase 真需要」为准**：设计稿可以留到 Phase 2/3、不是 Phase 1 背的锅

## 按 type 拉取方式

### type=url（按域名分流）

| URL 模式 | 推荐工具 | 提炼重点 |
|---|---|---|
| `project.feishu.cn/.../story/...` | `feishu-project-mcp` 的 `get_workitem_brief` 或相关工具 | story title / description / 验收标准 / 状态机 / 评论 |
| `*.feishu.cn/(docx\|wiki\|sheets\|doc)/...` 或 `wukongedu.feishu.cn/...` | `feishu-mcp` 拉文档正文 | 业务规则 / 文案 / 接口字段定义 / 状态机 |
| 含 `swagger` / `api-docs` / `openapi` | `shell` curl 拿 JSON、自己解 schema | 接口 path / method / params / response 类型 |
| 其他 http | `shell` curl 或 SDK fetch | 看内容性质判断 |

### type=path

绝对路径、用 SDK 内置 `read` 工具（注意：工具名是 `read`、不是 `read_file`）。

- 图片自动走 vision 通道（看得到像素）
- 文本 / Markdown / JSON 直接读

### type=text

清单里已经 inject 全文、**不要重复拉**。

如果 content 末尾出现「**已截断、原文共 N 字、超过 1000 字上限**」标记：

1. 默认按截断后内容处理方案
2. **如果这段对方案决定重要**、把「需要补完整 XXX 文档」列进 01-plan.md 的「待澄清 / 不确定项」、用户 ack 时会在面板里补一份或者告诉你去哪拉

## 冲突处理（重要）

不同 doc 说法对不上是常见场景（典型：飞书 PRD 说字段叫 A、后端技术方案说叫 B）。这种情况：

1. **不自己拍板**、不猜哪个是对的
2. 在 01-plan.md 加「上下文冲突」节、两份原文 + 各自来源都列出来
3. 同时进 01-plan.md 的「待澄清 / 不确定项」、用户 ack 时澄清

## 不要做的事

- 不要拼命拉每一个 URL（token 炸 + 加载不相关信息乱思路）
- 不要从拉到的文档中发现新链接又递归去拉（不扩散）
  - 例外：该链接明确是业务规则的唯一来源、才拉
- 不要在 `assistant_message` 里把清单原样贴回用户（内部协议、用户看不到也不需要看）
- 不要质疑路径 / URL 有效性：后端传上来之前已经 trim 过、拉不到 / 404 是用户拍的事、你只需要报出来 + 列「不确定项」

## 跨 phase 复用（V0.3.4 起：plan / build 两个 phase）

- **Phase 1（plan、含上下文收集 + 方案规划）**：拉飞书 story / PRD / 后端技术方案 + 必要时拉 Figma 设计稿 / swagger → 出 01-plan.md（业务上下文 + 改动范围 + task 拆分）
- **Phase 2（build、编码实现）**：默认沿用 plan 拉过的资料、必要时补拉 plan ack 之后用户新加的文档（设计稿细节 / 接口字段更正）→ 写代码 + 写 02-build.md

## 用户中途补上下文怎么办

用户可以在任务详情页面板里**随时**加 / 删上下文。但当前 phase 跑的过程中、super-prompt 已经拼好、你看不到新加的。

- 下一次启动 / revise 时 super-prompt 会拼最新清单、那时再看
- 如果用户在 revise feedback 里明确说「我加了新的上下文 XX」、你可以在下次 wait_for_user 返回后立刻去看清单（如果 super-prompt 没重拼、说明节奏没跟上、当 phase 拿不到、写进「待澄清 / 不确定项」）
