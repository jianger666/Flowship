# Action: ship（V0.6.1 正式版、多仓 + GitLab MCP 工具 + 飞书 @ 测试人员）

ship action 的目标：把当前 task 所有仓的代码改动 push 到 origin、调 `submit_mr` MCP 工具创 GitLab MR **到 `test` 分支（提测、不是合 master）**、调飞书 MCP 在 story 评论 @ 测试人员告知 MR 链接、写 ship artifact 记录全过程。

## 工作流约定（公司内部场景、不要绕开）

- **🔒 铁律：绝不把 `test` 的内容弄到 feature 分支上**——不许 `git merge test` / `git rebase test` / `git pull origin test` 到 feature、也不许 force push。feature 只能单向往 `test` 提测；test↔feature 冲突是**用户的活**、agent 遇冲突只 `ask_user` 抛出来（详见 §3.5）、绝不自己动手解
- 所有仓 MR 一律 **`feature/...` → `test`**（提测）、`test` 通过测试后才人工合 master / main
- `submit_mr` 的 `target_branch` 入参 **写死 `test`**、不要探测 `origin/HEAD`（那个拿到的是默认主分支 master / main、跟提测工作流不对）
- 跨仓共用同一个 `feature/<username>/<story>-<title>` 分支名、`test` 也跨仓同名

## 单仓 vs 多仓

- 单仓 task（task.repoPaths 长度 = 1）：一次 push + 一次 submit_mr
- 多仓 task（task.repoPaths 长度 > 1）：对每个仓独立 `cd` + push + submit_mr——每个仓产出 1 条 MR、共用同名 source branch、target 都是 `test`
- 某仓本次无改动（`git diff origin/test...HEAD` 为空）：跳过该仓、不 push 也不调 submit_mr、在 artifact «§3 push + MR» 表里写「跳过、原因：本仓无改动」

## 准入条件（runner 已校验、agent 不用重复检查）

- 至少 1 个已通过的 build action
- settings 已配 GitLab Host + Personal Access Token（不然 runner 准入直接拒）

## 执行步骤（按顺序）

### 1. 读上下文

- 读最新 build artifact（必读、commit message 的依据）
- 读最新 review artifact（如有、写进 MR description）
- 读 task.mrs[]（判断是首次 ship 还是再次 push、`task.mrs[].version` 决定本次 v2/v3）

### 2. 飞书 @ 测试人员探测（A+C 策略、首次 ship 用）

> 同 task 后续 ship **不再**走本步——直接从 `task.feishuTesterUserIds` 读上一次记忆的列表。
>
> 不管走 A / 走 C / 用户选「跳过」、**最终都必须调一次 `set_feishu_testers`**（拿到 user_id 调一次、跳过 / 没拿到也调一次 `set_feishu_testers({ task_id, action_id, user_ids: [] })`、空数组 = 显式记忆「跳过」）。**漏调** = 下一轮 ship 还要重新走 A+C、用户体验差、artifact 后置检查会挂。

**A. 自动探测**（task.feishuStoryUrl 非空时优先走、单次 MCP 调用就够）

1. 调一次 `user-feishu-project-mcp.get_workitem_brief({ url: task.feishuStoryUrl })`、拿到 `work_item_attribute.role_members[]`
2. **过滤所有 role.name 含「测试」二字的 role**（公司项目空间至少有「测试」/「测试负责人」/「QA」三种命名习惯、不要写死单一 role.name）、把每个匹配 role 的 `members[]` 拍平到一个列表
3. 列表里 `member.key` 就是 lark_user_id、`member.name` 是中文名、`member.email` 用于备注（**不要**再调 `search_user_info`——`member.key` 已经是要的 user_id）
4. 列表非空 → 调 `set_feishu_testers({ task_id, action_id, user_ids: [member.key, ...] })`、artifact §2 记下名单（含中文名）
5. 列表为空 → 飞书 story 这边的「测试 / 测试负责人」角色都没人挂 → 走 **C** 兜底

**C. 探不到时 ask_user 兜底**（包括：task.feishuStoryUrl 为空 / `get_workitem_brief` 失败 / A 过滤完列表为空）

```
ask_user({
  task_id,
  action_id,
  questions: [
    {
      id: "tester_user_ids",
      question: "需要 @ 哪些测试人员？请填工号 / 用户名、逗号分隔；不需要 @ 选「跳过」。",
      options: [
        { id: "skip", label: "跳过 @ 测试人员（飞书评论只发 MR 链接）" }
      ],
      allow_text: true,
    },
  ],
})
```

- 用户填工号 / 用户名 → 调 `user-feishu-project-mcp.search_user_info` 转 user_id（这里**才**用 search_user_info、因为没 story role 信息）→ `set_feishu_testers({ task_id, action_id, user_ids })`
- 用户选「跳过」→ **仍要调** `set_feishu_testers({ task_id, action_id, user_ids: [] })`（空数组 = 显式记忆「跳过」、下次 ship 不再重问）

### 3. 逐仓 push + submit_mr

> 多仓时**每个仓各用一次独立 shell 调用**（每次从该仓根目录重新 `cd`）、不要在一个 shell 里连续 `cd` 多个仓——上个仓没 `cd` 回、cwd 会残留串到下个仓。

对 `task.repoPaths` 里每个仓：

```bash
cd <repoPath>

# 目标分支固定 test（公司提测工作流、不要探 origin/HEAD）
TARGET=test

# 探当前 branch（task.gitBranches 里该仓对应的 source branch、build 时已 checkout 好）
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 拉一下 test 看本仓相对 test 有没有改动
# fail-fast：fetch 失败（远程没 test 分支 / 网络异常）必须报错退出、
#   否则下面 git diff 会因 origin/$TARGET ref 不存在拿到空结果、被误判成「无改动跳过」、本仓提测漏做却显示已跳过
if ! git fetch origin "$TARGET" 2>&1; then
  echo "[error] git fetch origin/$TARGET 失败、停止本仓 ship（远程 test 分支不存在或网络异常、不要当成无改动跳过）"
  exit 1
fi
CHANGES=$(git diff "origin/$TARGET...$BRANCH" --name-only)
if [ -z "$CHANGES" ]; then
  echo "[skip] 本仓相对 origin/$TARGET 无改动、跳过 push + MR"
  exit 0
fi

# 没 commit 的工作区改动先 commit（agent 自己写 commit message、conventional commit 风格）
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "<commit msg>"
fi

# push 到 origin、source branch 跟本地同名
# fail-fast：push 失败（如远程有新 commit 致 non-fast-forward）必须报错退出、
#   绝不 force push 覆盖远程、也绝不 pull/merge test 进 feature——保持 feature 干净、交给用户处理
if ! git push -u origin "$BRANCH" 2>&1; then
  echo "[error] git push 失败、停止本仓 ship（绝不 force push、绝不把 test merge 进 feature、报给用户处理）"
  exit 1
fi

# 拿当前 commit hash + GitLab project path
HEAD_SHA=$(git rev-parse HEAD)
REMOTE_URL=$(git config --get remote.origin.url)
# REMOTE_URL 形如 git@gitlab.wukongedu.net:wkid/crm-web.git 或 https://.../wkid/crm-web.git
# 解析出 wkid/crm-web、给 submit_mr 用
PROJECT_PATH=$(echo "$REMOTE_URL" | sed -E 's#^[^@]+@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')

echo "[ok] TARGET=$TARGET BRANCH=$BRANCH HEAD=$HEAD_SHA PROJECT=$PROJECT_PATH"
```

push 成功后、对每仓调 `submit_mr` MCP 工具：

```typescript
submit_mr({
  task_id,
  action_id,
  repo_path: "<本仓本地绝对路径>",
  project_path: "<解析出的 wkid/crm-web>",
  source_branch: "<BRANCH>",
  target_branch: "test",                       // 永远填 test、不要填别的
  title: "[<role>] <task.title>",            // role = task.role 中文 label、title 加上版本号 if v>1
  description: "<MR description>",            // 见下方模板
  last_commit_hash: "<HEAD_SHA>",
})
```

- 工具返 `{ ok: true, data: { mr_url, mr_iid, mr_version, has_conflicts, merge_status, merge_undetermined } }`、记下 `mr_url` + `has_conflicts` 给 artifact + §3.5 决策用
- **`has_conflicts: true`（本 MR 跟 test 冲突）**：MR 本身已建好、但记下「该仓冲突」、继续下一个仓——冲突统一到 §3.5 处理、**绝不**自己 merge/rebase/force push 去解
- 失败返 `{ ok: false, error: "..." }`、artifact 里记错误、继续下一个仓（不要重试、不要 force push、不要降级到 git push -o）

### 3.5 冲突门禁（决定 §4 走不走、V0.6.1.1 加）

汇总所有仓的 `submit_mr` 结果、按有无冲突分流。

**任一仓 `has_conflicts: true` 时**：跳过 §4 飞书评论（不能把合不了的 MR @ 给测试人员）、**绝不**自己 `git merge / rebase / pull` 把 test 弄进 feature 解冲突、调一次 `ask_user` 把冲突清单抛给用户（多仓冲突合并成一条问）：

```typescript
ask_user({
  task_id,
  action_id,
  questions: [{
    id: "resolve_conflicts",
    question: "<仓名> MR 跟 test 有冲突、链接 <mr_url>；请手动解决冲突后回复，我再重跑 ship 提测。",
    options: [{ id: "resolved", label: "我已解决冲突、重新提测" }],
    allow_text: true,
  }],
})
```

用户回复后重跑本 ship action（重新 push 已解冲突的 feature → `submit_mr` 重新 poll、冲突翻成无冲突 → 再走 §4）。

**所有仓都无冲突时**（`merge_undetermined` 也按无冲突放行、artifact §6 注明待人工复核）→ 正常走 §4。

### 4. 飞书 story 评论（V0.6.1 拍板：评论 + @ 测试人员、不动 story 状态）

> **前置门禁**：仅当 §3.5 判定「所有仓 MR 无冲突」才执行本步。有任一仓冲突时整步跳过、等用户解完冲突重跑 ship。

调用 `user-feishu-project-mcp.add_comment`：

```typescript
add_comment({
  workitem_id: <从 task.feishuStoryUrl 抠出的 story id>,
  content: `MR 已提交、请测试人员 review：

<对每条 MR 一行：URL 必须放行尾、不要在 URL 后追加任何字符（飞书 IM 会把括号、空格后的字符一起 link 化导致 404）>
- [\${repoTailName}]\${mrVersion > 1 ? ` v\${mrVersion}` : ""} <mr_url>

@<测试人员中文名>（@ 拼法见下方「@ 的正确姿势」）
`,
})
```

- **@ 的正确姿势**：`task.feishuTesterUserIds` 是 lark_user_id（形如 `ou_xxx`）、**不能**直接拼成 `@ou_xxx` 塞进 content 文本（飞书 IM 不识别、显示成乱码）。优先用 `add_comment` 工具自带的 @ / mention 能力（核对工具入参有没有 `user_ids` / `mention` 之类字段、把 lark_user_id 传进去）；工具不支持时退而在 content 里用 `@<中文名>` 软提示（中文名从 §2 探测时一并记下）
- 多仓 task：一条评论里平铺所有 MR 链接、按 repoPath 末段名（如 `crm-web`）标注
- `feishuTesterUserIds` 为空数组（用户选了跳过）：评论不加 @、只贴链接
- 飞书评论失败：artifact «§4 飞书评论» 记 ❌ + 错误信息、不阻塞 ship action 完成（用户后续手动补）

### 5. 写 ship artifact + wait_for_user

artifact 路径：`actions/<N>-ship.md`、按下方骨架写、写完调 `wait_for_user({ task_id, action_id, artifact_path: "actions/<N>-ship.md" })` 等用户 ack。

## MR description 模板

> 多次 ship 时、保留旧版的 description、在末尾加新版段。

```markdown
## 任务

<task.title>（飞书 story: <task.feishuStoryUrl>）

## 方案

<最新 plan artifact 的摘要 / 直接链接到 fe-ai-flow 详情页>

## 改动概览

<最新 build artifact 的「Task 完成情况」段、按 plan 对照>

## 复核

<如有 review artifact、贴 4 类差异段；没 review 写「未做 review、由代码评审人把关」>

## 自检

- typecheck: ✅ / ❌
- lint: ✅ / ❌
- review hash: ✅ / ❌（如做了 review）

---

<如果是 v2+、加：## v\${mrVersion} 更新（\${ISO 日期}）>
<本次相对上一版的改动摘要、引用本轮 build artifact>
```

## artifact 骨架

```markdown
# Ship #<N>

## §1 基本信息

- task: <task.id> <task.title>
- 飞书 story: <task.feishuStoryUrl>
- branch（共用）: <branch name>
- 仓数: <repoPaths.length>

## §2 飞书测试人员

- 探测策略: <A 自动探测成功 | A 失败 + C ask_user 兜底 | 用户选跳过 | 沿用上轮记忆>
- 持久化结果（lark_user_id）: <task.feishuTesterUserIds 写完后的列表、或 []>

## §3 push + MR 详情

| 仓 | target | source | HEAD commit | MR | version | 冲突 | 备注 |
|---|--------|--------|-------------|----|---------|------|------|
| <repoPath 1> | test | feature/clj/xxx-yyy | abc1234 | <mr_url> | v1 | 无 | 首次提测 |
| <repoPath 2> | test | feature/clj/xxx-yyy | def5678 | <mr_url> | v1 | ⚠️ 有 | 待用户解决、本仓未评论 |
| <repoPath 3> | test | - | - | - | - | - | 跳过、原因：本仓无改动 |

## §4 飞书评论

- 评论 id: <add_comment 返的 comment id>
- 内容预览: <前 200 字>
- @ 的测试人员: <user_id 列表、或「跳过」>
- 状态: ✅ 成功 / ❌ 失败 + 错误信息 / ⏸ 因 MR 冲突跳过（待用户解决后重跑 ship 再评论）

## §5 自检结果

- typecheck: ✅ / ❌
- lint: ✅ / ❌
- git status 干净: ✅ / ❌

## §6 待澄清 / 已知风险

<如果 ask_user 时用户「稍后再补充」过 / 有跳仓 / 有 MR 失败的、列在这里>
```

## 反例

- ❌ 提测遇冲突时自己 `git merge test` / `rebase test` / `pull origin test` 到 feature 解冲突（**绝对不**、保持 feature 干净、ask_user 让用户解、见 §3.5）
- ❌ push 被拒（non-fast-forward）时 force push 覆盖远程（**绝对不**、报用户处理）
- ❌ MR 有冲突还照发飞书评论 @ 测试人员（合不了的 MR 不能甩给测试、§3.5 门禁拦）
- ❌ target_branch 探 origin/HEAD 拿 master / main（公司工作流 = 提测、`target_branch` 永远 `test`）
- ❌ 走 `git push -o merge_request.create` 绕开 `submit_mr`（task.mrs 不会落库、详情页看不到）
- ❌ 自己用 SDK `shell` curl GitLab REST API / `glab` / `gh`（PAT 在 server、agent 拿不到、必然失败）
- ❌ 拿到测试人员 user_id 但漏调 set_feishu_testers（下次 ship 还要重新探、artifact 后置检查会发现）
- ❌ 强推到 master / main（GitLab 禁、且违反工作流）
- ❌ commit message 跟 build artifact 实际改动不一致
- ❌ 拿到 `submit_mr` 失败结果时自动重试 / force push（**绝对不**、artifact 记错、让用户手动处理）
- ❌ 跳过的仓没在 artifact §3 写原因（后置检查会挡）
- ❌ artifact 没写 `task.feishuTesterUserIds` 来源（A / C / 沿用、需可审计）
- ❌ ship approve 后自动跑下一 action（绝对不、wait_for_user 待命态等用户推进）
- ❌ 飞书评论里 URL 后面追加 `(v1)` / `（v1）` / 任何字符（飞书 IM 会一起 link 化导致 404）

## 调用礼仪

- 整个流程不在 assistant_message 里讲「我要 push / 我要提 MR」之类（用户从 artifact 看就够）
- 调 submit_mr / add_comment 前**不要**先用 assistant_message 复述参数（agent 倾向于「写出来让用户确认」、但这里入参全在 artifact 里、用户 ack 时一并看）
- 拿到 MR url 后**不要**复述「MR 已创建：<url>」、直接落 artifact 即可
