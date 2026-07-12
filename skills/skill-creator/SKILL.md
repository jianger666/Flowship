---
name: skill-creator
description: 创建、修改、完善本平台的 skill（SKILL.md 能力扩展）。只要用户提到「建/写/加/改一个 skill」「把这个流程沉淀成 skill」「让 AI 以后都会做 XX」，即使没说 skill 这个词、只要意图是「沉淀可复用的能力/流程/规范」，都用本 skill。
---

# skill-creator：创建 / 修改平台 skill

skill = 一个目录 + SKILL.md（+ 可选的脚本 / 参考文件）。agent 启动时会读到所有 skill 的
name + description 索引、场景匹配时才读全文——所以 **description 写得好坏直接决定 skill 会不会被用上**。

## 写到哪（按顺序判定）

1. 环境变量 `FE_AI_FLOW_DATA_DIR` 存在 → 写到 `$FE_AI_FLOW_DATA_DIR/skills/<skill名>/`
2. 当前工作目录本身就叫 `skills`（「AI 帮建」入口开的对话）→ 直接在当前目录下建 `<skill名>/`
3. 都不满足 → 先 `echo $FE_AI_FLOW_DATA_DIR` 确认、再问用户

⚠️ 不要写到 `~/.cursor/skills/`（那是 Cursor IDE 的目录、本平台已独立管理自己的 skill）。

## 创建流程

1. **先弄清意图再动手**：如果当前对话里已经有一段成功的工作流（用户说「把刚才这套沉淀成 skill」），
   直接从对话历史提取步骤 / 工具 / 输入输出格式；信息不够就问、一次问全、别挤牙膏。
   **用户要的 skill 若已有现成实现（开源 skill 仓库 / npm 包 / 别处已写好的 SKILL.md）→ 优先安装 + 适配、
   不要从零重写山寨版**：装好依赖（CLI / 数据文件）、按本规范补齐 SKILL.md（frontmatter + 触发词）、
   附带更新脚本方便日后升级、并在正文标注来源（仓库 / 包名）。
2. **目录名**：一律 **kebab-case 英文**（简短、见名知义；如「周报」→ `weekly-report`、「写代码」→ `write-code`）。
   中文目录名技术上仍能跑（存量兼容），**新建一律英文**、不要再造中文目录。
3. **SKILL.md 结构**：
   - frontmatter 必填 `name`（跟目录名一致）+ `description`
   - **description 是唯一的触发依据**：必须同时写「做什么」+「什么场景 / 用户说什么话时用」。
     模型普遍倾向「该用没用」（undertrigger）、所以 description 要写得主动一点、
     把触发词罗列全（包括用户可能的不同说法）。「何时使用」只写在 description、别写在正文——
     正文是触发后才会被读的。
   - 正文：给 agent 看的执行指引——按序步骤、约束边界、输出格式。有信息密度、别写废话。
4. **辅助脚本**：需要跑脚本的放同目录（如 `scripts/xxx.py`）、在 SKILL.md 里用**相对本目录的路径**引用并写清怎么调用。
5. **自检**：建完 `cat` 一遍确认 frontmatter 合法（`---` 包住、YAML 可解析）；列出最终文件结构；
   告诉用户「以后说 XX 就会触发」+ 提醒去设置页 Skills 卡可以看到和编辑。

## 修改已有 skill

先读原文再改；改 description 时同样遵守上面的触发词规范；用户没让动的段落别动。
