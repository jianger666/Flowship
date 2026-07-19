# 跨 action 共享规范（任何 action 都遵守、必读）

> 下文出现的具体路径 = **agent effective cwd**（单仓 = 仓库根、多仓 = 公共父目录、详见 super-prompt 顶部「任务输入」段的仓库列表）。
> 本文件是所有 action 共用的「artifact 写法 + 跨 action 约束」、是各 action 详细 prompt 的**前置约束**。各 action prompt 不再重复这些规则。

## 1. artifact 写入工具

每个 action 写 artifact 时遵循：

- **创建新 artifact** → SDK 内置 `write` 工具、args `{ path: "<绝对路径>", fileText: "<完整 markdown>" }`
- **改已存在 artifact**（revise / fix 模式）→ SDK 内置 `edit` 工具、args `{ path, oldText, newText }`
- **第一次写 artifact 前** → `read` 一遍 `artifact-writer` skill（路径见 super-prompt Skills 段）、之后同 SDK Run 复用记忆
- ⚠️ 工具名 **`write` / `edit`**、不带 `_file` 后缀（不是 `write_file` / `edit_file`）；用错调用会失败
- ⚠️ **每个 action 写自己那一份 artifact**——不要回头 write 上一个 action 的 artifact（上游 artifact 已经 ack 完、属于历史档案、只能 `read` 不能 `write`/`edit`）。例外：plan-after-review 的「edit 上一个 plan 的对应段」是 review action 内部规则、详见 action-review.md

## 2. artifact 顶部格式

**所有 artifact 直接以 `# 标题` 起头**、不带 frontmatter / yaml 头：

- ✅ 对：
  ```
  # 方案：xxx
  ## 1. 需求理解
  ...
  ```
- ❌ 错：
  ```
  ---
  action: plan
  task_id: ...
  generated_at: ...
  ---
  # 方案：xxx
  ```

frontmatter 没用户价值、占视觉、维护成本高。所有 action 同款。

## 3. path 完整路径写法（V0.5.7.6 起加严、V0.6 沿用、所有涉及文件位置的字段都遵守）

> 下面示例用前端 Vue 仓举例（`.vue` / `.js`）、**规则与语言无关**——Java 仓换 `.java` / `.xml`、Go 换 `.go` 同理：路径都从 cwd 起算、写完整、带行号。

artifact 里任何**文件位置引用**（task 改动 / 关键参考 / 实施位置 / 改动文件清单 / 实现偏差引用位置等）**必须满足**：

1. **从 agent cwd（即 `{{repoPath}}`）起算的相对路径**——`apps/cp-class-advisor-center/src/views/mainHome/recordModal.vue`、不是 `recordModal.vue`
2. **已知行号就写**——`path:line` 或 `path:line-line` 格式（如 `packages/tch-sc/src/components/TaskInfo.vue:120-156`）；前端 markdown 自动渲染成 Cursor 可点链接、用户审 artifact 时一键跳代码
3. **不知道行号就只写文件路径**——不要瞎编行号
4. **同一文件多次出现都写完整路径**——build / review agent 按行匹配、basename 简写(如 `selList.vue`)和裸冒号续接(如 `:414-503` 这种没前缀的)都让它找不到、只能 grep 浪费 token。一个文件同一行内列多段、每段都补完整 path、不要省
5. **不要写绝对路径**（`~/Documents/...` / `/Users/foo/...`）——agent 在 `{{repoPath}}` 下跑、绝对路径换台机器就失效
6. **严禁「同上 / 同前 / ↑ / 上同 / ditto」类省略词**（V0.6.0.1 加、用户实测踩过）——表格里多条 row 引用同一文件、每条都把完整 path 写全；agent 自我感觉「读起来重复」是 OK 的、用户拿这些 path 是为了点击跳转、省略词等于让 row 失去 affordance。表格列空间不够也不准缩水成「同上」、要么换段落形式、要么把同一文件的多个引用合并到一行（用顿号分隔多个 `path:line`）

> **多仓场景**：`{{repoPath}}` 是公共父目录（不是 git 仓库自身）、相对路径**首段必须是子仓目录名**（例 `projA/apps/foo/bar.vue`、不是直接 `apps/foo/bar.vue`）；详见 super-prompt 顶部「任务输入」段列出的子仓名清单。
> ⚠️ 本节下方正例都是**单仓视角**形态（`apps/...` 起手）——多仓 task 写路径时**不要照抄这个形态**、每条前面都要补仓名（2026-06-12 实测踩过：ship artifact 写 `apps/cp-class-advisor-center/...` 漏了 `tch-service-center/` 前缀、用户点击跳转报「路径不存在」）。

**反例**（用户实测踩过、覆盖各 action）：
```
❌ plan「改动」：BackLog.vue、home.vue                                            ← 没目录前缀
❌ plan「关键参考」：promoteExpireReason.js（formatPromoteExpireReasonDisplay）    ← 没目录前缀
❌ build「修改记录·改动文件」：studentFollow.vue、lookStudentInformation.vue       ← V0.5.7.7 hot-fix 实测、用户截图反馈
❌ build「修改记录·改动文件」：promoteExpireReason.js（formatPromoteExpireReasonDisplay） ← 没目录前缀
❌ review「实施位置」：recordModal.vue:2189-2225                                    ← V0.5.7.6 实测、纯文件名识别不出
❌ plan「改动」：TaskInfo.vue:75-100、`:414-503`、`:540-760`                       ← 后两段裸冒号、前端识别不出是路径、点不开
❌ review 表格备注：「同上：90」/「同上：244-248」/「↑ 同前」                       ← V0.6.0.1 实测、表格 row 用「同上」指代上一行的文件名、用户没法点击跳转
❌ 多仓 ship「已知风险」：apps/cp-class-advisor-center/src/views/schedule/classList.vue ← 2026-06-12 实测、多仓 task 漏仓名前缀、cursor 链接拼到公共父目录下、点击报「路径不存在」
```

**Flowship UI 判路径规则**（`src/lib/path-utils.ts:looksLikePath`）：必须**含 `/`**、且**最后一段含 `.` 扩展名**——纯文件名 `foo.vue` / `Foo.java` 因为不含 `/` 直接 fall through 成纯文本、用户看到不可点。

**正例**：
```
✅ plan「改动」：apps/cp-class-advisor-center/src/views/homeIndex/components/BackLog.vue
✅ build「修改记录·改动文件」：apps/cp-class-advisor-center/src/views/follow/studentFollow.vue
✅ review「实施位置」：apps/cp-class-advisor-center/src/views/mainHome/recordModal.vue:2189-2225
✅ plan「改动」：packages/tch-sc/src/components/TaskInfo.vue:75-100、packages/tch-sc/src/components/TaskInfo.vue:414-503、packages/tch-sc/src/components/TaskInfo.vue:540-760
✅ 多仓 task（首段 = 仓名）：tch-service-center/apps/cp-class-advisor-center/src/views/schedule/classList.vue
```

## 4. 内部技术词禁项（artifact 是给用户看的）

artifact 是用户在 UI 上要看的「交付文档」、不是「内部协议日志」。**严禁出现以下内部技术词**：

- ❌ `fork` / `revise` / `再聊聊` / `submit_work` / `ask_user` / `[USER_MESSAGE]` / `[NEXT_ACTION ...]` 之类协议名
- ❌ `## Fork 修复` / `## Revise` / `## 重启修复` 这种新建顶层标题
- ❌ 「fork 模式」「revise 路径」「奖励信号」之类的工程黑话

用户视角的中文表述：
- ✅ 「用户反馈」「本次修改」「澄清确认」「方案调整」
- ✅ 直接说改了什么、为什么改、改在哪——不解释「这次是 revise 还是 fork」

## 5. fix mode 修改记录段格式（build / review / ship action 用、plan 走内联）

action 产出审阅中、用户在输入条发消息（[USER_MESSAGE]）走 super-prompt 的二分类（**问类只直接回复答疑、不动 artifact、不留修改记录**；改类才弹 ask_user 复述、确认后改 artifact）后、agent 按用户反馈修正、修正后追加修改记录。**两套方式**：

### 5.1 build / review / ship action：append 到 `## 修改记录` 段

artifact 末尾有 `## 修改记录` 顶层段（初稿不写、有修正才写）、按以下结构追加：

```markdown
## 修改记录

### 修改 1：<一句话标题（25 字以内、说清楚改了什么）>

- **用户反馈**：<用户消息核心语义、20 字以内简述、不要带「[USER_MESSAGE]」之类协议头>
- **改动文件**：<改了哪些文件、用完整相对路径 + 行号、对应 §3 规则>
  - build action 这里写代码改动文件（如 `apps/.../selList.vue:271-279`）
  - review action 这里写「影响位置」（如 `3-review.md` 的「实现偏差 1」、`1-plan.md §2.2` 这种 artifact 内 / 外的修改位置）
  - ship action 这里写「修改字段」（如 commit message / PR body / 飞书评论）
- **概要**：1-2 句说明改了什么、为什么改

### 修改 2：...
```

⛔ **顺序必须正序、新条目 append 到段最末尾**：`## 修改记录` 内「### 修改 N」按时间**从上到下递增**——修改 1 最早、在最上；本轮新修正编号最大、放在**所有已有条目的下方、整段的最末尾**。**严禁把新条目 prepend 到段顶 / 已有条目之前**（倒序）：`edit` 时把锚点定位到「最后一条修改的末尾」之后再插入、**绝不**定位到 `## 修改记录` 标题正下方插入（那样会变成「最新在最上」的倒序、用户实测踩过、明确要求正序、2026-06-18）。
⛔ **严禁新建顶层标题**（如「## Fork 修复」「## Revise」），所有修正条目都汇聚在 `## 修改记录` 段下、用「### 修改 N」三级标题。
⛔ **严禁复述**：「Task 完成情况」「改动文件清单」「实现偏差」「跟飞书需求对照」等已有段落写过的内容、修改记录段只记「这次反馈带来的修正」、不要把初稿内容搬过来。

### 5.2 plan action：内联在结论旁

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
- **不要凭空编命令 / 端口**：artifact 里出现某条 shell 命令 / 端口 / URL 时、先用 `read` 拿 `{{repoPath}}/package.json`（**多仓时读对应子仓 `{{repoPath}}/<repo>/package.json`**）的 `scripts` / `README.md` / `.env.example` 拿真值；读不到写「<按团队 README 启动>」占位、严禁猜（V0.5.7.6 实测：AI 把端口 `8080` 脑补成 `8877`）

## 8. 跨 action 约束（V0.6 新增）

- **不要回头改上一个 action 的 artifact**——上游 artifact 已经 ack、属于历史档案、`read` 可以、`write` / `edit` 禁。**唯一例外**：review action 内部「发现 plan 有问题、edit 最新 plan 的对应段、补 strikethrough + 内联备注」（V0.5.12 起的 review 闭环规则、V0.6 沿用、详见 action-review.md）
- **不要主动跑下一个 action**——下一 action 类型由用户在 UI 推进 dialog 选、agent 只在收到 [NEXT_ACTION ...] 信号后才能跑对应类型的 action
- **同一 task 内的 action 共享 SDK Run / 共享上下文**——你能直接 `read` 之前任何 action 的 artifact（包括 chat 对话产生的临时结论）、不需要重读 contextDocs；用 `read` 拿 `actions/<n>-<type>.md` 的完整路径见 super-prompt 顶部「Artifact 文件路径」段

## 9. shell 命令安全（V0.6.8、所有跑 shell 的 action 必守）

⛔ **三类命令一律不跑**（跑了会改坏用户仓库 / 卡死 Run / 留杀不掉的后台进程）：

1. **会自动改写文件的命令**——`lint --fix`、`eslint --fix`、任何 `*lint --fix`、`prettier --write`、`* format`、codemod、带 `--fix` / `--write` 的命令。
   - ⚠️ **跑仓库 `package.json` 里的 script 前、必须先 `read` 看它实际展开成什么**——很多仓库的 `lint` script 内部就是 `--fix`（真实事故：某 Angular 仓 `npm run lint` = `ng lint --fix=true`、整个仓库被逐文件自动改写）。**看到 `--fix` / `--write` 就不跑**、改用只读校验（typecheck / `tsc --noEmit` / 不带 fix 的 lint）。
2. **长驻 / 不自己退出的命令**——dev server（`dev` / `serve` / `start`）、`--watch`、`tail -f`、交互式 REPL。这些不返回、会把 Run 挂死、还会留下后台子进程。要验证就跑一次性命令、不要起服务。
3. **耗时全量命令**——`pnpm build` / `vite build` / `mvn package` / `gradle build` 等（各 action 另有说明、默认不跑、ROI 低）。

> **为什么这么严**：agent 用 shell 工具拉起的子进程是独立进程、**即使 task 被「停止」、agent 本体死了、这些子进程也可能 orphan 后在后台继续跑**（典型就是 `--fix` 在后台把整仓改花）。Flowship 有事后兜底清理、但**事前就不跑这类命令**才是根治。校验只用「跑完即退、不写文件」的只读命令。
