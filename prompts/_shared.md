# 跨 phase 共享规范（plan / build / review 通用、必读）

> 占位符：`{{repoPath}}` `{{artifactPath}}`、缺失替换成「（未提供）」。
> V0.5.9 起 `{{repoPath}}` = **agent effective cwd**（单仓 = 仓库根、多仓 = 公共父目录、详见 super-prompt 顶部「任务输入」段的仓库列表）。
> 本文件是 plan / build / review 三 phase 共用的「artifact 写法 + 跨 phase 规则」、是各 phase 详细 prompt 的**前置约束**。各 phase prompt 不再重复这些规则。

## 1. artifact 写入工具

每个 phase 写 artifact 时遵循：

- **创建新 artifact** → SDK 内置 `write` 工具、args `{ path: "<绝对路径>", fileText: "<完整 markdown>" }`
- **改已存在 artifact**（revise / fix 模式）→ SDK 内置 `edit` 工具、args `{ path, oldText, newText }`
- **第一次写 artifact 前** → `read` 一遍 `artifact-writer` skill（路径见 super-prompt Skills 段）、之后同 SDK Run 复用记忆
- ⚠️ 工具名 **`write` / `edit`**、不带 `_file` 后缀（不是 `write_file` / `edit_file`）；用错调用会失败

## 2. artifact 顶部格式

**所有 artifact 直接以 `# 标题` 起头**、不带 frontmatter / yaml 头（V0.5.5 起约束、V0.5.7.4 review 跟上）：

- ✅ 对：
  ```
  # 方案：xxx
  ## 1. 需求理解
  ...
  ```
- ❌ 错：
  ```
  ---
  phase: plan
  task_id: ...
  generated_at: ...
  ---
  # 方案：xxx
  ```

frontmatter 没用户价值、占视觉、维护成本高。三 phase 同款。

## 3. path 完整路径写法（V0.5.7.6 加严、所有涉及文件位置的字段都遵守）

artifact 里任何**文件位置引用**（task 改动 / 关键参考 / 实施位置 / 改动文件清单 / 实现偏差引用位置等）**必须满足**：

1. **从 agent cwd（即 `{{repoPath}}`）起算的相对路径**——`apps/cp-class-advisor-center/src/views/mainHome/recordModal.vue`、不是 `recordModal.vue`
2. **已知行号就写**——`path:line` 或 `path:line-line` 格式（如 `packages/tch-sc/src/components/TaskInfo.vue:120-156`）；前端 markdown 自动渲染成 Cursor 可点链接、用户审 artifact 时一键跳代码
3. **不知道行号就只写文件路径**——不要瞎编行号
4. **同一文件多次出现都写完整路径**——build / review agent 按行匹配、basename 简写(如 `selList.vue`)和裸冒号续接(如 `:414-503` 这种没前缀的)都让它找不到、只能 grep 浪费 token。一个文件同一行内列多段、每段都补完整 path、不要省
5. **不要写绝对路径**（`~/Documents/...` / `/Users/foo/...`）——agent 在 `{{repoPath}}` 下跑、绝对路径换台机器就失效

> **V0.5.9 多仓场景**：`{{repoPath}}` 是公共父目录（不是 git 仓库自身）、相对路径**首段必须是子仓目录名**（例 `projA/apps/foo/bar.vue`、不是直接 `apps/foo/bar.vue`）；详见 super-prompt 顶部「任务输入」段列出的子仓名清单。

**反例**（用户实测踩过、覆盖 plan / build / review 三 phase）：
```
❌ plan「改动」：BackLog.vue、home.vue                                            ← 没目录前缀
❌ plan「关键参考」：promoteExpireReason.js（formatPromoteExpireReasonDisplay）    ← 同上
❌ build「修改记录·改动文件」：studentFollow.vue、lookStudentInformation.vue       ← V0.5.7.7 hot-fix 实测、用户截图反馈
❌ build「修改记录·改动文件」：promoteExpireReason.js（formatPromoteExpireReasonDisplay） ← 同上
❌ review「实施位置」：recordModal.vue:2189-2225                                    ← V0.5.7.6 实测、纯文件名识别不出
❌ plan「改动」：TaskInfo.vue:75-100、`:414-503`、`:540-760`                       ← 后两段裸冒号、前端识别不出是路径、点不开
```

**前端判路径规则**（`src/lib/path-utils.ts:looksLikePath`）：必须**含 `/`**、且**最后一段含 `.` 扩展名**——纯文件名 `foo.vue` 因为不含 `/` 直接 fall through 成纯文本、用户看到不可点。

**正例**：
```
✅ plan「改动」：apps/cp-class-advisor-center/src/views/homeIndex/components/BackLog.vue
✅ build「修改记录·改动文件」：apps/cp-class-advisor-center/src/views/follow/studentFollow.vue
✅ review「实施位置」：apps/cp-class-advisor-center/src/views/mainHome/recordModal.vue:2189-2225
✅ plan「改动」：packages/tch-sc/src/components/TaskInfo.vue:75-100、packages/tch-sc/src/components/TaskInfo.vue:414-503、packages/tch-sc/src/components/TaskInfo.vue:540-760
```

## 4. 内部技术词禁项（artifact 是给用户看的）

artifact 是用户在 UI 上要看的「交付文档」、不是「内部协议日志」。**严禁出现以下内部技术词**：

- ❌ `fork` / `revise` / `再聊聊` / `wait_for_user` / `ask_user` / `[PHASE_ACK ...]` 之类协议名
- ❌ `## Fork 修复` / `## Revise` / `## 重启修复` 这种新建顶层标题
- ❌ 「fork 模式」「revise 路径」「奖励信号」之类的工程黑话

用户视角的中文表述：
- ✅ 「用户反馈」「本次修改」「澄清确认」「方案调整」
- ✅ 直接说改了什么、为什么改、改在哪——不解释「这次是 revise 还是 fork」

## 5. fix mode 修改记录段格式（build / review 用、plan 走内联）

phase 内用户 ack 时点「再聊聊」（revise）走 super-prompt §3 的「改类」路径（**问类只 emit assistant_message 答疑、不动 artifact、不留修改记录**；改类才弹 ask_user 复述、确认后改 artifact）、或「推进 → 从某 phase 重启」（fork 同 phase）后、agent 按用户反馈修正、修正后追加修改记录。**两套方式**：

### 5.1 build phase + review phase：append 到 `## 修改记录` 段

artifact 末尾有 `## 修改记录` 顶层段（初稿不写、有修正才写）、按以下结构追加：

```markdown
## 修改记录

### 修改 1：<一句话标题（25 字以内、说清楚改了什么）>

- **用户反馈**：<feedback 原话核心语义、20 字以内简述、不要带「[PHASE_ACK revise]」之类协议头>
- **改动文件**：<改了哪些文件、用完整相对路径 + 行号、对应 §3 规则>
  - build phase 这里写代码改动文件（如 `apps/.../selList.vue:271-279`）
  - review phase 这里写「影响位置」（如 `03-review.md` 的「实现偏差 1」、`01-plan.md §2.2` 这种 artifact 内 / 外的修改位置）
- **概要**：1-2 句说明改了什么、为什么改

### 修改 2：...
```

⛔ **严禁新建顶层标题**（如「## Fork 修复」「## Revise」），所有修正条目都汇聚在 `## 修改记录` 段下、用「### 修改 N」三级标题。
⛔ **严禁复述**：「Task 完成情况」「改动文件清单」「实现偏差」「跟飞书需求对照」等已有段落写过的内容、修改记录段只记「这次反馈带来的修正」、不要把初稿内容搬过来。

### 5.2 plan phase：内联在结论旁

plan artifact 章节结构严（§1 需求理解 / §2 业务规则 / §3 接口 / §4 决策 / §5 task / §6 待澄清）、修正不汇总顶层段、**用 `edit` 局部改对应章节内容**、紧跟修改的那一行加一行内联备注：

```markdown
> ✅ 已确认：<用户反馈核心>
```

⛔ **严禁新建顶层标题**（「## Fork 修复」「## Revise」之类）、保留旧章节结构、本轮修改内联反映在被改章节里。

## 6. 中文注释 / 中文表述

artifact 全文用**中文**——除非引用代码 / 接口路径 / 文件路径这种英文原文。

> 用户拍板：思考和回复永远用中文。

## 7. 数字 / 命名一致性自检（每次写 artifact / 改 artifact 后扫一遍）

- **task / 文件计数自检**：如果有汇总（「本 plan 涉及 Y 个 task、动 X 个文件」），写完后回头数一遍 task 列表 + 文件去重、确保数字对得上
- **业务名词全称**：表格 / 正文里的 task 名 / 业务对象写全称、不要图省事简写到 2 字（如「学情 / 关单」要写「补升学情反馈 / 补升冲刺关单」）
- **不要凭空编命令 / 端口**：artifact 里出现某条 shell 命令 / 端口 / URL 时、先用 `read` 拿 `{{repoPath}}/package.json`（**V0.5.9 多仓时读对应子仓 `{{repoPath}}/<repo>/package.json`**）的 `scripts` / `README.md` / `.env.example` 拿真值；读不到写「<按团队 README 启动>」占位、严禁猜（V0.5.7.6 实测：AI 把端口 `8080` 脑补成 `8877`）
