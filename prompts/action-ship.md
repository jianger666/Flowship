# Action: ship（V0.6.1 正式版、多仓 + GitLab MCP 工具 + 飞书 @ 测试人员）

ship action 的目标：把当前 task 所有仓的代码改动 push 到 origin、调 `submit_mr` MCP 工具创 GitLab MR **到该仓的「测试分支」（提测、不是合 master）**、调飞书 MCP 在 story 评论 @ 测试人员告知 MR 链接、写 ship artifact 记录全过程。

> **测试分支从哪来**：每仓的测试分支见 super prompt 顶部「## 仓库分支配置」段（建 task 时从设置页快照）。某仓没配 → 回退默认 `test`。下文凡是 `<测试分支>` / 写死的 `test` 都指「该仓配置的测试分支、没配则 test」。

## 工作流约定（公司内部场景、不要绕开）

- **🔒 铁律：绝不把测试分支的内容弄到 feature 分支上**——不许 `git merge <测试分支>` / `git rebase <测试分支>` / `git pull origin <测试分支>` 到 feature、也不许 force push feature/测试分支。feature 只能单向往测试分支提测、本体永远保持干净。
  - 遇冲突时 `ask_user` 问用户「AI 智能解 / 自己解」（详见 §3.5）。选「AI 智能解」时**也不动 feature**——合并只发生在另建的一次性 `__conflict` 分支上（详见 §3.6）。这是铁律的唯一豁免口、边界看 §3.6。
- 所有仓 MR 一律 **`feature/...` → 该仓测试分支**（提测）、测试分支通过测试后才人工合 master / main
- `submit_mr` 的 `target_branch` 入参 **填该仓的测试分支**（见「## 仓库分支配置」段、没配则 `test`）、不要探测 `origin/HEAD`（那个拿到的是默认主分支 master / main、跟提测工作流不对）
- feature 分支名见「## 仓库分支配置」/ task.gitBranches（build 时已 checkout）、各仓可能同名也可能不同名（取决于命名模板）

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
- 如果最新 build artifact 写了「本轮无代码改动 / 有效实现来源：沿用 build #N（`actions/N-build.md`）」：必须继续 read `actions/N-build.md`，把它作为本次 MR description / commit message 的实际代码改动来源；最新 build 只用于记录“本轮评估后不改”的决策，不足以描述业务改动。
- 如果 #N 也是无代码改动 build，沿「有效实现来源」继续递归追溯，直到找到真正有代码改动的 build；找不到有效来源时，不要编 MR 描述，artifact 写明「缺少有效实现来源」、等待用户处理。
- 读最新 review artifact（如有、写进 MR description）
- 读 task.mrs[]（判断是首次 ship 还是再次 push、`task.mrs[].version` 决定本次 v2/v3）

### 2. 飞书 @ 测试人员探测（A+C 策略、首次 ship 用）

> 同 task 后续 ship **不再**走本步——直接从 `task.feishuTesterUserKeys` 读上一次记忆的列表。
>
> 不管走 A / 走 C / 用户选「跳过」、**最终都必须调一次 `set_feishu_testers`**（拿到 user_key 调一次、跳过 / 没拿到也调一次 `set_feishu_testers({ task_id, action_id, user_keys: [] })`、空数组 = 显式记忆「跳过」）。**漏调** = 下一轮 ship 还要重新走 A+C、用户体验差、artifact 后置检查会挂。

**A. 自动探测**（task.feishuStoryUrl 非空时优先走、一次 MCP 调用即可）

1. 查一次 story 的角色成员：有飞书项目 MCP 就调 `get_workitem_brief({ url: task.feishuStoryUrl })`；没有就用内置 `meegle` CLI 查询工作项详情（用法见注入的飞书项目 skills）。拿到 `work_item_attribute.role_members[]`（CLI 返回结构同源）
2. **过滤所有 role.name 含「测试」二字的 role**（公司项目空间至少有「测试」/「测试负责人」/「QA」三种命名习惯、不要写死单一 role.name）、把每个匹配 role 的 `members[]` 拍平到一个列表
3. 列表里每个 `member.key` 就是 **user_key**（纯数字、§4 @ / 通知直接用它、**不需要**再调 search_user_info 换什么 lark_user_id——2026-06-12 起 add_comment 只认 user_key 体系、lark_user_id 会被拒 `cross tenant`）、`member.name` 中文名、`member.email` 邮箱
4. 列表非空 → 调 `set_feishu_testers({ task_id, action_id, user_keys: [各 member.key, ...] })`（存的就是 user_key、纯数字）、artifact §2 记下名单（中文名 + user_key）
5. 列表为空 → 飞书 story 这边的「测试 / 测试负责人」角色都没人挂 → 走 **C** 兜底

**C. 探不到时 ask_user 兜底**（包括：task.feishuStoryUrl 为空 / `get_workitem_brief` 失败 / A 过滤完列表为空）

```
ask_user({
  task_id,
  action_id,
  questions: [
    {
      id: "tester_user_keys",
      question: "需要 @ 哪些测试人员？请填工号 / 用户名、逗号分隔；不需要 @ 选「跳过」。",
      options: [
        { id: "skip", label: "跳过 @ 测试人员（飞书评论只发 MR 链接）" }
      ],
      allow_text: true,
    },
  ],
})
```

- 用户填工号 / 用户名 → 调 `user-feishu-project-mcp.search_user_info({ user_keys: [...] })`、取返回的 **`user_key` 字段**（纯数字、**不是** `lark_user_id` 字段）→ `set_feishu_testers({ task_id, action_id, user_keys: [user_key, ...] })`
- 用户选「跳过」→ **仍要调** `set_feishu_testers({ task_id, action_id, user_keys: [] })`（空数组 = 显式记忆「跳过」、下次 ship 不再重问）

### 3. 逐仓 push + submit_mr

> 多仓时**每个仓各用一次独立 shell 调用**（每次从该仓根目录重新 `cd`）、不要在一个 shell 里连续 `cd` 多个仓——上个仓没 `cd` 回、cwd 会残留串到下个仓。

对 `task.repoPaths` 里每个仓：

```bash
cd <repoPath>

# 目标分支 = 该仓的测试分支（见「## 仓库分支配置」段、没配则 test）、不要探 origin/HEAD
TARGET=<该仓测试分支、默认 test>

# 探当前 branch（task.gitBranches 里该仓对应的 source branch、build 时已 checkout 好）
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 拉一下 test 看本仓相对 test 有没有改动
# fail-fast：fetch 失败（远程没 test 分支 / 网络异常）必须报错退出、
#   否则下面 git diff 会因 origin/$TARGET ref 不存在拿到空结果、被误判成「无改动跳过」、本仓提测漏做却显示已跳过
if ! git fetch origin "$TARGET" 2>&1; then
  echo "[error] git fetch origin/$TARGET 失败、停止本仓 ship（远程 test 分支不存在或网络异常、不要当成无改动跳过）"
  exit 1
fi
# ⚠️ 顺序铁则：先 commit 工作区改动、再判「相对 test 有无改动」。
#   build 铁律是不碰 .git（不 commit / 不 push）、改动全停在工作区——必须先 commit 才看得见、才推得动。
#   若反过来先 `git diff origin/$TARGET...$BRANCH`（只看 committed 状态）判跳过、会漏掉工作区未提交的 build 改动；
#   feature 又是从 master 切的（没新 commit）时 committed diff 为空 → 被误判「无改动」直接 exit 0、本仓提测静默漏做。
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "<commit msg>"   # agent 自己写 commit message、conventional commit 风格
fi

# commit 完再判断「本仓相对 test 有没有要提测的改动」（此时已含刚 commit 的 build 产出）
CHANGES=$(git diff "origin/$TARGET...$BRANCH" --name-only)
if [ -z "$CHANGES" ]; then
  echo "[skip] 本仓相对 origin/$TARGET 无改动、跳过 push + MR"
  exit 0
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
  target_branch: "<该仓测试分支、默认 test>",                       // 见「## 仓库分支配置」段、没配才用 test
  title: "[<role>] <task.title>",            // role = task.role 中文 label、title 加上版本号 if v>1
  description: "<MR description>",            // 见下方模板
  last_commit_hash: "<HEAD_SHA>",
})
```

- 工具返 `{ ok: true, data: { mr_url, mr_iid, mr_version, has_conflicts, merge_status, merge_undetermined } }`、记下 `mr_url` + `has_conflicts` 给 artifact + §3.5 决策用
- **`has_conflicts: true`（本 MR 跟 test 冲突）**：MR 本身已建好、但记下「该仓冲突」、继续下一个仓——**这一步先别动手解**、所有仓跑完统一到 §3.5（那里再问用户「AI 解 / 自己解」）
- 失败返 `{ ok: false, error: "..." }`、artifact 里记错误、继续下一个仓（不要重试、不要 force push、不要降级到 git push -o）

### 3.5 冲突门禁（决定 §4 走不走、V0.6.1.1 加、V0.6.8 加智能解冲突分支）

汇总所有仓的 `submit_mr` 结果、按有无冲突分流。

**所有仓都无冲突时**（`merge_undetermined` 也按无冲突放行、artifact §6 注明待人工复核）→ 直接走 §4。

**任一仓 `has_conflicts: true` 时**：跳过 §4 飞书评论（不能把合不了的 MR @ 给测试人员）、调一次 `ask_user` 问用户怎么解（多仓冲突合并成一条问、列清单）：

```typescript
ask_user({
  task_id,
  action_id,
  questions: [{
    id: "resolve_conflicts",
    question: "<仓名> MR 跟 <测试分支> 有冲突：<mr_url>。要我智能解决吗？（我会另建 <feature>__conflict 分支、把 feature 合进去解冲突后重新提测、feature 分支一根毫毛不动）",
    options: [
      { id: "ai", label: "AI 智能解决（feature 不动、另建 __conflict 分支解）" },
      { id: "manual", label: "我自己解决（解完回复、我重跑 ship）" },
    ],
    allow_text: true,
  }],
})
```

- 用户选 **`ai`** → 走 §3.6（对每个冲突仓 AI 智能解）
- 用户选 **`manual`**（或文本说自己来）→ 等用户解完回复、重跑本 ship action（重新 push 已解冲突的 feature → `submit_mr` 重 poll、冲突翻无冲突 → 走 §4）

### 3.6 AI 智能解冲突（仅当 §3.5 用户选「AI 智能解决」、V0.6.8）

> 🔑 **这是铁律的唯一豁免口、边界看清楚**：
> - ✅ **允许**：在**一次性的 `__conflict` 分支**上 `git merge <feature>`（方向是 feature 合进 __conflict、**不是** test 合进 feature）、并 `git push -f` 这条 `__conflict` 分支
> - ⛔ **仍绝不**：把 test `merge` / `rebase` / `pull` 进 **feature** 分支、force push **feature / 测试分支**
> - feature 分支全程**不 checkout、不改、不 push**——合并只发生在基于 test 新建的 `__conflict` 分支上、feature 本体保持干净

对每个 `has_conflicts` 的仓（多仓逐个、每仓独立 shell 调用、各自从仓根 `cd`）：

```bash
cd <repoPath>
TARGET=<该仓测试分支、默认 test>
FEATURE=$(git rev-parse --abbrev-ref HEAD)   # 当前 feature 分支、下面全程不动它
CONFLICT="${FEATURE}__conflict"

# fail-fast：fetch 不到 test 直接退、别在脏状态上瞎合
if ! git fetch origin "$TARGET" 2>&1; then
  echo "[error] fetch origin/$TARGET 失败、停止本仓智能解冲突"; exit 1
fi

# 基于最新 test 新建/重置 __conflict 分支（-B：已存在就重置成干净起点）
git checkout -B "$CONFLICT" "origin/$TARGET"

# 把 feature 合进来（feature → __conflict、不是反过来）
# 有冲突时 merge 返非 0、停在冲突态、下面 AI 逐个解标记
git merge --no-ff "$FEATURE" -m "merge ${FEATURE} into ${CONFLICT}（解冲突提测）" \
  || echo "[conflict] 进入冲突态、AI 接管解冲突标记"
```

然后 AI 逐个解冲突：

1. `git diff --name-only --diff-filter=U` 拿冲突文件清单
2. 逐个 `read` 冲突文件、按 `<<<<<<<` / `=======` / `>>>>>>>` 标记智能合并：
   - 原则：**保留 feature 这次任务的业务意图**、同时纳入 test 在冲突处的改动（一般两边都要、不是简单二选一）
   - 拿不准的（语义冲突、两边逻辑互斥、删改冲突）→ **别瞎猜**、停下来 `ask_user` 把这处冲突贴出来问用户怎么取舍
3. 解完所有标记后（仍在本仓 `cd`）：

```bash
cd <repoPath>
git diff --check                 # 确认无遗留冲突标记（有残留会打印、必须先清空再继续）
# 仅当还在 merge 态（解了冲突没提交）才 add+commit；若 test 无重叠 merge 已自动完成则跳过、避免 nothing-to-commit 报错
if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  git add -A
  git commit --no-edit           # 完成 merge commit
fi
git push -f origin "$CONFLICT"   # __conflict 是一次性分支、force push 它 OK（不碰 feature/测试分支）
HEAD_SHA=$(git rev-parse HEAD)
git checkout "$FEATURE"          # 恢复 HEAD 到 feature、防后续 re-ship 把 __conflict 误当 feature 分支
echo "[ok] CONFLICT=$CONFLICT HEAD=$HEAD_SHA"
```

4. 对本仓再调 `submit_mr`、**source 改成 `__conflict` 分支**：

```typescript
submit_mr({
  task_id,
  action_id,
  repo_path: "<本仓本地绝对路径>",
  project_path: "<wkid/crm-web>",
  source_branch: "<CONFLICT>",                 // ⚠️ source 是 __conflict、不是原 feature
  target_branch: "<该仓测试分支、默认 test>",
  title: "[<role>] <task.title>",
  description: "<同 §3 的 MR description>",
  last_commit_hash: "<HEAD_SHA>",
})
```

- server 会**自动把旧的 `feature→test` MR 关掉**（你不用管、也不要自己想办法关）、并对 `__conflict→test` 重新 poll 冲突
- 新 MR 应当 `has_conflicts: false`（基于 test + 已解冲突）；若仍 `true`（极少、解的过程里 test 又变了）→ 重跑本 §3.6（`checkout -B` 会拿最新 test 重来）

全部冲突仓解完、回 §3.5 重新汇总：所有仓无冲突 → 走 §4 飞书评论（@ 测试人员贴**新 MR**链接）。

### 4. 飞书 story 评论（V0.6.1 拍板：评论 + @ 测试人员、不动 story 状态）

> **前置门禁**：仅当所有仓 MR 无冲突才执行本步（包括 §3.6 AI 智能解冲突跑完、新 MR 翻成无冲突后）。仍有任一仓冲突（用户选自己解、还没解完）时整步跳过。

写评论：有飞书项目 MCP 就调 `add_comment`；没有就用内置 `meegle` CLI 的评论命令（用法见注入的飞书项目 skills）。`content` 里用**正式 mention 块**写 @（不是纯文本 `@中文名`）、同时传 `notify_user_type` + `notify_user_list` 两个通知参数。

> ⚠️ **id 体系一律用 user_key（纯数字、不加任何前缀）**——2026-06-12 实测确诊：官方 MCP 服务端把 mention/notify 的 id 按 user_key 校验、传 lark_user_id 直接报 `cross tenant`（bytedance.bits.collect_public:userKey cross tenant）、06-09 还能用的 lark_user_id 体系已被封死。
> 🛑 **绝对不要给 mention 块 id 加 `lark_user_id_` 前缀**——schema describe 的举例是坑、实测带前缀报 `no permission`（2026-06-04 确诊）。
>
> 🔕 **已知缺陷（2026-06-12 实测、暂无解）**：官方 MCP 通知链路故障——user_key 体系的评论能发出、@ 蓝色渲染正常、**但被 @ 的人收不到飞书推送**（评论 mention 数据模型已升级成 blockId 引用、只有 UI 手动 @ 能触发通知、MCP 拼不出新模型；AT_USER_BLOCK/user/纯文本 + notify 各种组合 2026-06-12 全试过、全不推）。等官方修复。在那之前：评论照发（链接 + @ 渲染仍有展示价值）、artifact §4 注明「通知可能未送达、必要时请用户在飞书 IM 手动知会测试」。

```typescript
add_comment({
  work_item_id: "<从 task.feishuStoryUrl 抠出的 story id>",          // 注意带下划线、不是 workitem_id
  project_key: "<从 task.feishuStoryUrl 抠出的空间 key、如 wk-dm>",  // 漏传会报错、一并带上
  content: `MR 已提交、请测试人员 review：

<对每条 MR 一行：URL 必须放行尾、不要在 URL 后追加任何字符（飞书 IM 会把括号、空格后的字符一起 link 化导致 404）>
- [\${repoTailName}]\${mrVersion > 1 ? ` v\${mrVersion}` : ""} <mr_url>

@张三<!-- mention:{"id":"7227652003395092508","cn_name":"张三","blockType":"AT_USER_BLOCK"} --> @李四<!-- mention:{"id":"7483212744695627804","cn_name":"李四","blockType":"AT_USER_BLOCK"} -->
`,
  notify_user_type: "user_key",                                   // 我们存的是 user_key、固定填这个
  notify_user_list: ["7227652003395092508", "7483212744695627804"],  // = task.feishuTesterUserKeys 原始数字、不加前缀；跳过场景省略或传 []
})
```

- **@ 的正确姿势（关键、必背）**：`task.feishuTesterUserKeys` 是纯数字 user_key（§2 探测时存的）。
  - **content 里每个 @ 用 mention 块**：`@<中文名><!-- mention:{"id":"<纯数字 user_key>","cn_name":"<中文名>","blockType":"AT_USER_BLOCK"} -->`（中文名从 §2 一并记下、多人就拼多段空格隔开）。**不要**只写纯文本 `@中文名`（不渲染成真 @）
  - **同时传 `notify_user_type: "user_key"` + `notify_user_list: [所有 tester 的原始数字 user_key]`**（通知参数当前实测不生效、但保留传参——官方修复通知链路后大概率从这俩开关恢复）
- 多仓 task：一条评论里平铺所有 MR 链接、按 repoPath 末段名（如 `crm-web`）标注
- `feishuTesterUserKeys` 为空数组（用户选了跳过）：评论不加 @ mention 块、只贴链接、notify 两参数省略（或传空）
- 飞书评论失败：artifact «§4 飞书评论» 记 ❌ + 错误信息、不阻塞 ship action 完成（用户后续手动补）

### 4.5 飞书工作项节点流转（V0.14 状态同步、best-effort）

> **前置门禁**：同 §4（所有仓 MR 无冲突才做）；且仅当内置 `meegle` CLI 可用并已登录（`meegle auth status` 的 `authenticated=true`）。未装 / 未登录 → 整步跳过、artifact §4.5 记「跳过（meegle 未就绪）」、**不要**让用户去装。

提测 MR 已交、把飞书工作项流转到「提测 / 待测试」类节点、让飞书侧状态跟上：

1. 按注入的飞书项目 skills 里 `sop-transition-node.md` 的三步曲走：`workflow get-node`（看当前节点）→ `workflow list-state-transitions` 或节点信息（看合法流转）→ `workflow transition`（流转）
2. **目标节点自己判断**：合法流转里选语义为「提测 / 待测试 / 测试中」的节点；**没有明确匹配的就不要流转**（各空间节点命名不同、流转错状态比不流转更糟）、artifact 记「未找到提测类节点、跳过」
3. 失败（权限 / 参数 / 网络）：artifact «§4.5 节点流转» 记 ❌ + 原因、**不阻塞 ship 完成**、不重试超过 1 次

### 5. 写 ship artifact + submit_work

artifact 路径：`actions/<N>-ship.md`、按下方骨架写、写完调 `submit_work({ task_id, action_id, artifact_path: "actions/<N>-ship.md" })` 等用户 ack。

## MR description 模板

> 多次 ship 时、保留旧版的 description、在末尾加新版段。

```markdown
## 任务

<task.title>（飞书 story: <task.feishuStoryUrl>）

## 方案

<最新 plan artifact 的摘要 / 直接链接到 ai-flow 详情页>

## 改动概览

<有效实现来源 build artifact 的「Task 完成情况」段、按 plan 对照；如果最新 build 本轮无代码改动，必须使用其指向的 build #N>

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
- 持久化结果（user_key）: <task.feishuTesterUserKeys 写完后的列表、或 []>

## §3 push + MR 详情

| 仓 | target | source | HEAD commit | MR | version | 冲突 | 备注 |
|---|--------|--------|-------------|----|---------|------|------|
| <repoPath 1> | test | feature/clj/xxx-yyy | abc1234 | <mr_url> | v1 | 无 | 首次提测 |
| <repoPath 2> | test | feature/clj/xxx-yyy__conflict | def5678 | <new_mr_url> | v2 | 已解（AI） | 原 feature→test MR 已被 server 关、改用 __conflict 分支 |
| <repoPath 3> | test | feature/clj/xxx-yyy | ghi9012 | <mr_url> | v1 | ⚠️ 有 | 用户选自己解、待解决、本仓未评论 |
| <repoPath 4> | test | - | - | - | - | - | 跳过、原因：本仓无改动 |

## §4 飞书评论

- 评论 id: <add_comment 返的 comment id>
- 内容预览: <前 200 字>
- @ 的测试人员: <user_key 列表、或「跳过」>
- 状态: ✅ 成功 / ❌ 失败 + 错误信息 / ⏸ 因 MR 冲突跳过（待用户解决后重跑 ship 再评论）
- ⚠️ 通知送达: 评论已发、但官方 MCP 通知链路故障（2026-06-12 起）、@ 仅渲染不推送——必要时请在飞书 IM 手动知会测试人员

## §4.5 节点流转

- 状态: ✅ 已流转到「<节点名>」 / ⏭ 跳过（meegle 未就绪 / 未找到提测类节点） / ❌ 失败 + 原因

## §5 自检结果

- typecheck: ✅ / ❌
- lint: ✅ / ❌
- git status 干净: ✅ / ❌

## §6 待澄清 / 已知风险

<如果 ask_user 时用户「稍后再补充」过 / 有跳仓 / 有 MR 失败的、列在这里>
```

## 反例

- ❌ 提测遇冲突时自己 `git merge test` / `rebase test` / `pull origin test` 到 **feature** 解冲突（**绝对不**、保持 feature 干净；智能解冲突走 §3.6 的 `__conflict` 分支、方向是 feature 合进 __conflict）
- ❌ 智能解冲突时去 `checkout` / 改 / `push` **feature** 分支（**绝对不**、§3.6 全程只动一次性的 `__conflict` 分支、feature 本体不碰）
- ❌ force push **feature / 测试分支**（只有一次性的 `__conflict` 分支才能 `git push -f`）
- ❌ 用户选「自己解」后还自作主张去 AI 解 / 反之（按用户在 §3.5 的选择走）
- ❌ 智能解冲突后还自己想办法关旧 MR（server 会自动关被取代的旧 MR、别手动折腾）
- ❌ push 被拒（non-fast-forward）时 force push 覆盖远程 feature（**绝对不**、报用户处理）
- ❌ MR 有冲突还照发飞书评论 @ 测试人员（合不了的 MR 不能甩给测试、§3.5 门禁拦）
- ❌ target_branch 探 origin/HEAD 拿 master / main（公司工作流 = 提测、填该仓配置的测试分支、没配才用 test）
- ❌ 走 `git push -o merge_request.create` 绕开 `submit_mr`（task.mrs 不会落库、详情页看不到）
- ❌ 自己用 SDK `shell` curl GitLab REST API / `glab` / `gh`（PAT 在 server、agent 拿不到、必然失败）
- ❌ 拿到测试人员 user_key 但漏调 set_feishu_testers（下次 ship 还要重新探、artifact 后置检查会发现）
- ❌ mention / notify 传 lark_user_id（2026-06-12 起服务端按 user_key 校验、报 `cross tenant`——一律用 user_key）
- ❌ 强推到 master / main（GitLab 禁、且违反工作流）
- ❌ commit message 跟 build artifact 实际改动不一致
- ❌ 拿到 `submit_mr` 失败结果时自动重试 / force push（**绝对不**、artifact 记错、让用户手动处理）
- ❌ 跳过的仓没在 artifact §3 写原因（后置检查会挡）
- ❌ artifact 没写 `task.feishuTesterUserKeys` 来源（A / C / 沿用、需可审计）
- ❌ ship 交卷后自动跑下一 action（绝对不、交卷即结束回复、等用户推进）
- ❌ 飞书评论里 URL 后面追加 `(v1)` / `（v1）` / 任何字符（飞书 IM 会一起 link 化导致 404）

## 调用礼仪

- 整个流程不在 assistant_message 里讲「我要 push / 我要提 MR」之类（用户从 artifact 看就够）
- 调 submit_mr / add_comment 前**不要**先用 assistant_message 复述参数（agent 倾向于「写出来让用户确认」、但这里入参全在 artifact 里、用户 ack 时一并看）
- 拿到 MR url 后**不要**复述「MR 已创建：<url>」、直接落 artifact 即可
