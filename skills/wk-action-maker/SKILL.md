---
name: wk-action-maker
description: 把团队 harness（wk-harness）的某条 wk:* 指令转成 Flowship 推进 action 壳（薄壳模板 + 上传共享库）。当用户说「把 wk:xxx 做成 action / 领导加了新指令帮我转一下」时使用。
---

# wk 指令 → 推进 action 转换器

把一条 `wk:*` 指令按团队约定的**薄壳模板**转成可分发的推进 action。规则固化在本文件，任何人任何时候转出来的壳都长一样。

## 步骤

1. **读契约确认指令**：读团队库镜像里的 `wk-harness` SKILL.md（及其 `references/command-contract.md`），确认这条指令的：中文名、职责一句话、主产物文件（人要审的那个 md）、用户需要提供的入参（通常 REQ-ID）。
2. **按模板生成壳目录**（两个文件，放 `<目录名 = 指令名去掉 wk: 前缀、冒号换连字符>`）：

`SKILL.md`（严格套这个骨架、只填空、不加内容）：

```markdown
---
name: <目录名>
description: 执行 <wk:指令>（<中文名>）。仅推进该 action 时使用。
---

# <中文名>（<wk:指令>）

执行团队 harness 指令 `<wk:指令>`，用户在推进时的输入作为指令参数（如 REQ-ID、需求描述）。

## 执行

- 完整契约见 `wk-harness` skill（可用能力清单里有、按其规则执行；其中库内相对路径以该 skill 的 kbRoot 为根解析）。
- 找不到业务文档仓（doc repo）时按契约停下询问；用户让你代配时可创建 `~/.wk/doc-repo` 并把绝对路径写入 `~/.wk/config.yaml` 的 `doc_repo.local_path`（macOS / Windows 都用绝对路径）。

## artifact 产出（写入本 action 的 artifact 文件）

- 顶部一段元信息：执行的指令与参数、状态从什么推进到什么、**本次全部产物文件**的路径清单：
  - 只列**文件**（必须带文件名和扩展名），**禁止列目录**
  - **绝对路径**、用反引号包裹（面板可点击跳 IDE）
  - 优先列文档仓 / 仓库内的正式产物路径；若同时列 task workspace / worktree 副本，必须列到具体文件、与正式路径一一对应，不能只写副本目录
  - 清单须覆盖本指令实际产出或更新的全部文件，缺一不可
- 正文放本步主产物的完整内容（本指令主产物：<主产物文件>），用户在面板直接审阅；其余辅助文件留路径即可。
- 用户反馈修改时，文档仓原件与 artifact 两处同步更新。
```

`.flowship-action.json`：

```json
{
  "label": "<中文名> (<wk:指令>)",
  "placeholder": "<一句话入参提示、如：填 REQ-ID + 需求描述>",
  "exportedAt": <当前毫秒时间戳>
}
```

3. **红线**：壳只做指令绑定 + 环境桥接，**不复制契约内容**（REQ-ID 校验、门禁、doc repo 解析细节都在 wk-harness 里，别搬）；description 一句话、不写教程。
4. **上传**：把生成的目录放进本机自管 skills 后，用能力页「上传到共享库」推到 `common` 分类（或直接在共享库 clone 的 `skills/common/` 下提交），全组同步即得。

## 参考样本

共享库 `skills/common/wk-biz-analyze/` 就是本模板的标准产物，拿不准时对照它。
