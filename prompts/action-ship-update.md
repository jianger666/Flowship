# Action: ship（再次提测·精简版）

本任务**已提测过**（`task.mrs` 里已有提测 MR）、本次是**再次提测**：把新改动推到同一条 MR（`submit_mr` 复用现有 open MR、`mr_version` +1）并再通知测试。测试人员早已记在 `task.feishuTesterUserKeys`、所以本版只保留再次提测真正要做的步骤。

> ⚠️ **完整版 playbook**：`{{shipFullPlaybookPath}}`。下面「0. 兜底」表任一情况一出现，**立刻停止本精简流程、用 `read` 读完整版、按对应章节继续**（已 commit / push / 已建的 MR 不重做）。

## 0. 兜底：这些情况精简版不管、转完整版

| 情况 | 转完整版的哪一节 |
|---|---|
| `submit_mr` 返回 `has_conflicts: true` | §3.5 冲突门禁、§3.6 AI 智能解冲突 |
| `git push` 失败（non-fast-forward / 被拒 / 其它） | §3（仍绝不 force push、报给用户处理） |
| 某仓 `task.mrs` 里没有既有提测 MR（或 `submit_mr` 返回 `mr_version` = 1） | §3 + 「MR description 模板」 |
| `task.feishuTesterUserKeys` 为空数组 / 从未探测（`undefined`） / 读不到测试人员中文名 | §2 测试人员探测、§4 |
| 该仓本次目标分支（super prompt「仓库分支配置」段的测试分支）≠ `task.mrs` 里该仓提测 MR 的 `targetBranch` | §3 |
| 历史上执行过 `wk:*` 主流程 action（源分支按 wk-harness 规则定） | 「源分支：普通流程与 WK 流程」 |
| 最新 build 写「本轮无代码改动」、沿「有效实现来源」找不到有代码改动的 build | §1（不要编 MR 描述、artifact 写「缺少有效实现来源」） |
| 其它本表没写、你拿不准的任何情况 | 整份完整版 |

## 铁则（与完整版一致、不得绕开）

- 🔒 **绝不把测试分支内容弄到 feature 上**：不许 `git merge` / `rebase` / `pull origin <测试分支>` 到 feature；**绝不 force push**（feature / 测试分支都不行）。
- **顺序铁则：先 commit 工作区改动、再判「相对测试分支有无改动」**。build 不碰 .git、改动全停在工作区；先判会漏掉未提交改动。
- **fetch 失败 fail-fast**：`git fetch origin <测试分支>` 失败 → 报错停止本仓、**不要**当成「无改动跳过」（远程 ref 不存在时 diff 为空）。
- MR 只走 `submit_mr`：`target_branch` 填该仓**测试分支**（没配则 `test`）、不探 `origin/HEAD`；不用 `git push -o merge_request.create`、不 curl GitLab 建 MR。失败：artifact 记错误、**不重试**、不 force push、继续下一仓。
- **不 merge MR**：合 master / main 是测试通过后人工的事。
- 多仓：**每仓各用一次独立 shell 调用**、每次从该仓根重新 `cd`。
- 交卷后不自动进入下一 action；不调 `share_to_group`（提测 @ 走 `notify_group_testers`）；不在正文复述「我要 push / 提 MR」、调工具前不复述参数、拿到 MR url 后直接落 artifact。

## 步骤

### 1. 读上下文（只读、不重新探测）

- 最新 build artifact（commit message 依据）：若写了「本轮无代码改动 / 有效实现来源：沿用 build #N（`actions/N-build.md`）」→ 继续 `read` `actions/N-build.md`、递归到有代码改动的 build；最新 review artifact（如有）。
- `task.mrs[]`（每仓既有提测 MR 的 `version` / `targetBranch` / `url`；本次 `mrVersion` = 旧 `version` + 1）、`task.feishuTesterUserKeys`、`task.feishuStoryUrl`。
- 上一轮 ship artifact（`{{actionArtifactsDir}}/` 下 n 最大的 `*-ship.md`）的 artifact §2：取测试人员**中文名**（mention 块要 `cn_name`）。

### 2. 逐仓 push + submit_mr

对 `task.repoPaths` 里每个仓（每仓一次独立 shell 调用）：

```bash
cd <repoPath>

# 目标分支 = 该仓测试分支（见「仓库分支配置」段、没配则 test）
TARGET=<该仓测试分支、默认 test>

BRANCH=$(git branch --show-current)
[ -n "$BRANCH" ] || { echo "[error] detached HEAD、停止本仓 ship"; exit 1; }

# fail-fast：fetch 失败必须退出（否则 diff 拿空会被误判成无改动）
if ! git fetch origin "$TARGET" 2>&1; then
  echo "[error] git fetch origin/$TARGET 失败、停止本仓 ship"
  exit 1
fi

# ⚠️ 顺序铁则：先 commit 工作区改动、再判有无改动
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "<commit msg>"   # conventional commit 风格
fi

CHANGES=$(git diff "origin/$TARGET...$BRANCH" --name-only)
if [ -z "$CHANGES" ]; then
  echo "[skip] 本仓相对 origin/$TARGET 无改动、跳过 push + MR"
  exit 0
fi

# fail-fast：push 被拒就停、绝不 force push、绝不 pull/merge 测试分支进 feature
if ! git push -u origin "$BRANCH" 2>&1; then
  echo "[error] git push 失败、停止本仓 ship（绝不 force push / merge 测试分支）"
  exit 1
fi

HEAD_SHA=$(git rev-parse HEAD)
REMOTE_URL=$(git config --get remote.origin.url)
PROJECT_PATH=$(echo "$REMOTE_URL" | sed -E 's#^[^@]+@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
echo "[ok] TARGET=$TARGET BRANCH=$BRANCH HEAD=$HEAD_SHA PROJECT=$PROJECT_PATH"
```

`[skip]` = 本仓无改动：不 push、不调 `submit_mr`、artifact §3 写「跳过、原因：本仓无改动」。`[error]` = 停止本仓、对照「0. 兜底」表。

push 成功后对每仓调 `submit_mr`：

```typescript
submit_mr({
  task_id,
  action_id,
  repo_path: "<本仓本地绝对路径>",
  project_path: "<PROJECT_PATH>",
  source_branch: "<BRANCH>",
  target_branch: "<该仓测试分支、默认 test>",   // 必须与 task.mrs 里该仓提测 MR 的 targetBranch 一致、否则转完整版
  title: "[<角色>] <task.title> v<mrVersion>",    // 角色 = 设置页「我的角色」中文 label、无则省略括号段
  description: "<MR description、见下>",
  last_commit_hash: "<HEAD_SHA>",
})
```

**MR description**：保留旧版内容、**末尾追加** `## v<mrVersion> 更新（<ISO 日期>）` + 本次相对上一版的改动摘要（引用最新 build / review）。旧 description 从 GitLab 现有 MR 读（读操作可自调 API、见 super prompt「GitLab 访问」）。⚠️ server 会把你传的 `title` / `description` **整段覆盖**到现有 MR 上，所以 `description` 要传「旧描述 + 追加段」的完整文本；**读不到旧描述就传空串**（不覆盖、只更新标题）、artifact §3 备注「描述未更新」。

返回 `{ ok: true, data: { mr_url, mr_iid, mr_version, has_conflicts, merge_status, merge_undetermined, mr_updated?, mr_update_error? } }`：

- 记下 `mr_url` / `mr_version` / `has_conflicts` 给 artifact。`mr_version` 应 = 旧 `version` + 1；为 1 → 该仓此前没有既有 MR、转完整版。
- `mr_update_error` 有值 = 标题 / 描述**没更新成功**（不挡 ship）：artifact §3 备注写明原因。
- **`has_conflicts: true`**：MR 已建好、记「该仓冲突」。**不要自己解**（不 merge / rebase 测试分支）、**不发飞书评论**；其余仓跑完后转完整版 §3.5 统一处理。
- `merge_undetermined`：按无冲突放行、artifact §6 注明「待人工复核」。
- 失败 `{ ok: false, error }`：artifact 记错误、继续下一仓。

### 3. 飞书评论 + @ 测试人员（复用已记名单、不重新探测）

> **前置门禁**：所有仓 MR 无冲突才做（`merge_undetermined` 按无冲突）；任一仓有冲突 → 整步跳过（评论、`notify_group_testers` 都不做）。本次一个 MR 都没提（全仓无改动跳过）→ 也不评论、artifact §4 写「未发：本次无 MR」。

用内置 `meegle` CLI 写评论、`content` 里用**正式 mention 块**（不是纯文本 `@中文名`）。`work_item_id` / `project_key`：`meegle url decode --url <task.feishuStoryUrl> --format json` 拿 `work_item_id` / `simple_name`、再 `meegle project search` 把 `simple_name` 转权威 `project_key`。

```bash
meegle comment add \
  --work-item-id "<work_item_id>" \
  --project-key "<project_key>" \
  --content 'MR 已更新（再次提测）、请测试人员 review：

- [<repoTailName>][ vN] <mr_url>

@张三<!-- mention:{"id":"7227652003395092508","cn_name":"张三","blockType":"AT_USER_BLOCK"} -->
' \
  --notify-user-type user_key \
  --notify-user-list "7227652003395092508" \
  --format json
```

- **id 一律 user_key（纯数字、无前缀）**：就是 `task.feishuTesterUserKeys` 里的；传 `lark_user_id` 或加 `lark_user_id_` 前缀会报 `cross tenant` / `no permission`。
- 多人：每人一个 mention 块（`@<中文名><!-- mention:{"id":"<user_key>","cn_name":"<中文名>","blockType":"AT_USER_BLOCK"} -->`）空格隔开、每人一个 `--notify-user-list <user_key>`；`--notify-user-type user_key` 照传。
- 多仓：一条评论平铺所有 MR、按 repoPath 末段名（如 `crm-web`）标注、版本号写 URL **前面**；URL 后**不要**追加任何字符（飞书 IM 会一起 link 化、链接 404）。
- 已知缺陷：官方通知链路故障、评论里 @ 能渲染但**不推送**——评论照发、推送靠下面的需求群通知。评论失败：artifact §4 记 ❌ + 错误、不阻塞 ship。

**需求群 IM @（必做、同本步门禁）**：评论写完（成功或失败都调）立刻 `notify_group_testers({ task_id, action_id })`。人从 `feishuTesterUserKeys`、MR 从本轮 `submit_mr` 记录取——不要传人、不要拼 `open_id`、不要用 `share_to_group` 代替。返回的 `outcome` 原样写进 artifact：`sent` = 已发；`skipped_*` = 没发出（没群 / bot 不在群 / 换不出 IM 身份 / 重复调用等）；`failed` = 超时或发送失败（可重调一次；重调回 `skipped_duplicate` 说明已发出）。三者都不是 ship 失败。

### 4. 飞书工作项节点流转（best-effort）

前置门禁同步骤 3。**不要**先跑 `meegle auth status` 预检（瞬态失败会被误判成未登录）、直接按飞书项目 skills 里 `sop-transition-node.md` 三步曲走：`workflow get-node` → 判断合法目标 → `workflow transition`。只流转到「提测 / 待测试 / 测试中」类节点、**没有明确匹配（含已在该类节点）就不流转**；失败按原因（未登录 / 网络 / 未找到提测类节点 / 权限不足）记 artifact、不阻塞、重试 ≤ 1 次。

### 5. 写 ship artifact

路径 `actions/<N>-ship.md`、按下方骨架写、写完按 super-prompt 交卷。

⚠️ **后置检查（runner 自动跑）**：本次每条 `submit_mr` 记录 URL 非空且无冲突；`task.repoPaths` 里**没创建 MR 的仓**必须在 artifact §3 写跳过原因——「跳过、原因：本仓无改动」、且**该仓末段名（如 `crm-web`）与「跳过 / 无改动 / 无需 / 未改」同在表格一行**。漏写判 ❌。

```markdown
# Ship #<N>（再次提测 v<mrVersion>）

## §1 基本信息

- task: <task.id> <task.title>
- 飞书 story: <task.feishuStoryUrl>
- source branches: <逐仓 branch name>

## §2 飞书测试人员

- 探测策略: 沿用上轮记忆
- 持久化结果（user_key）: <task.feishuTesterUserKeys>

## §3 push + MR 详情

| 仓 | target | source | HEAD commit | MR | version | 冲突 | 备注 |
|---|--------|--------|-------------|----|---------|------|------|
| <repoPath 1> | test | feature/clj/xxx-yyy | abc1234 | <mr_url> | v2 | 无 | 再次提测：<本次相对上一版改了什么> |
| <repoPath 2> | test | - | - | - | - | - | 跳过、原因：本仓无改动 |

## §4 飞书评论

- 评论 id: <comment add 返的 comment id、未发写「未发」>
- 内容预览: <前 200 字>
- @ 的测试人员: <user_key 列表>
- 需求群 IM @: <notify_group_testers 的 outcome，或「未调（有冲突 / 无 MR）」>
- 状态: ✅ 成功 / ❌ 失败 + 错误信息 / ⏸ 因 MR 冲突跳过
- ⚠️ 通知送达: 官方通知链路故障、@ 仅渲染不推送——必要时请在飞书 IM 手动知会测试人员

## §4.5 节点流转

- 状态: ✅ 已流转到「<节点名>」 / ⏭ 跳过（未找到提测类节点 / 已在该类节点） / ❌ 失败 + 原因

## §5 自检结果

- typecheck: ✅ / ❌
- lint: ✅ / ❌
- git status 干净: ✅ / ❌

## §6 待澄清 / 已知风险

<跳仓 / MR 失败 / merge_undetermined 待人工复核的列这里>
```
