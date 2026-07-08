# Action: dev（联调、V0.x）

dev action 的目标：把当前 task 各仓的代码改动送到该仓的 **dev 分支（联调分支、develop）**、触发联调流水线。两种推送方式（用户在推进 dialog 选、本次到底走哪种由载荷里的 `[DEV_PUSH_MODE]` 指令钉死、不要自己挑）：

- **直推（direct）**：本地基于 `origin/<dev>` 把 feature 合进去、直接 push 到 `origin/<dev>`（开发对 dev 有直推权限）。最快触发流水线、不留 MR。
- **提 PR（mr）**：push feature 到 origin、调 `submit_mr` 建 `feature → <dev>` 的 MR（跟 ship 同一套、落详情页 MR 列表 + 冲突门禁）。

> **dev 分支从哪来**：每仓的 dev 分支见 super prompt 顶部「## 仓库分支配置」段（建 task 时从设置页快照）。**没配 dev 分支的仓本 action 跳过**（联调必须显式配 dev 分支才知道推哪）、artifact 里写「跳过、原因：未配 dev 分支」。下文 `<dev>` 都指「该仓配置的 dev 分支」。

## 🔒 铁律（跟 ship 一致、务必遵守）

- **绝不把 dev 分支的内容弄到 feature 分支上**——不许 `git merge <dev>` / `git rebase <dev>` / `git pull origin <dev>` 到 feature、不许 force push feature。feature 永远保持干净、只单向往 dev 送。
- 合并（feature → dev）只发生在**另一条分支**上、feature 本体不碰：
  - 直推模式：在本地 `<dev>` 分支上 merge feature（checkout 到 dev、不动 feature）、解完直推 `origin/<dev>`。
  - 提 PR 模式：无冲突时 GitLab 端合；有冲突走 `<feature>__conflict` 一次性分支（同 ship §3.6、方向是 feature 合进 __conflict）。
- **先看载荷里的 `[DEV_PUSH_MODE]` 指令**决定走「直推」还是「提 PR」——只走指定那一套、不要两套都做、不要自作主张换。

## 单仓 vs 多仓

- 多仓：逐个仓独立 `cd` + 推送（每仓一次独立 shell 调用、从仓根重新 `cd`、别在一个 shell 里连 `cd` 串 cwd）。
- 某仓没配 dev 分支 / 本次无改动（`git diff origin/<dev>...HEAD` 为空）→ 跳过该仓、artifact 记原因。

## 准入（runner 已校验、不用重复检查）

- 至少一个仓配了 dev 分支（全没配 runner 直接拒）。
- 提 PR 模式还需 settings 配了 GitLab Host + PAT（跟 ship 一样、`submit_mr` 要用）。

---

## 流程 A：直推（`[DEV_PUSH_MODE]` = 直推）

对每个**配了 dev 分支**的仓（逐个、各自独立 shell、从仓根 `cd`）：

```bash
cd <repoPath>
DEV=<该仓 dev 分支>                          # 见「## 仓库分支配置」段、没配则跳过本仓
FEATURE=$(git rev-parse --abbrev-ref HEAD)  # 当前 feature 分支、全程不动它

# fail-fast：fetch 不到 dev 直接退（远程没该分支 / 网络异常、别在脏状态上瞎合）
if ! git fetch origin "$DEV" 2>&1; then
  echo "[error] fetch origin/$DEV 失败、停止本仓联调"; exit 1
fi

# 先把 feature 工作区改动 commit（build 铁律不碰 .git、改动停在工作区、必须先 commit 才推得动）
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "<commit msg>"   # conventional commit 风格、跟 build artifact 实际改动一致
fi

# 判本仓相对 dev 有没有要联调的改动
CHANGES=$(git diff "origin/$DEV...$FEATURE" --name-only)
if [ -z "$CHANGES" ]; then
  echo "[skip] 本仓相对 origin/$DEV 无改动、跳过"; exit 0
fi

# 基于最新 dev 建/重置本地 dev 分支、把 feature 合进来（feature → dev、不是反过来）
git checkout -B "$DEV" "origin/$DEV"
git merge --no-ff "$FEATURE" -m "merge ${FEATURE} into ${DEV}（联调）" \
  || echo "[conflict] merge 进入冲突态、按下方「## 冲突处理」走、先别 push"
```

**merge 干净（无冲突）** → 直接 push：

```bash
# dev 有直推权限、推回 origin/dev（绝不 force、绝不碰 feature）
if ! git push origin "$DEV":"$DEV" 2>&1; then
  echo "[error] push origin/$DEV 失败（可能别人刚推了 dev、non-fast-forward）、绝不 force"
  git checkout "$FEATURE"   # 恢复 HEAD、报用户重跑（重跑会重新 fetch 最新 dev）
  exit 1
fi
HEAD_SHA=$(git rev-parse HEAD)
git checkout "$FEATURE"      # 恢复 HEAD 到 feature、防后续误把本地 dev 当工作分支
echo "[ok] DEV=$DEV HEAD=$HEAD_SHA pushed origin/$DEV"
```

**merge 有冲突** → 走「## 冲突处理」（直推模式在**当前本地 dev 分支**上解、feature 不动）。

> ⚠️ 直推没有 MR、冲突是本地 `git merge` 当场暴露的（不靠 server poll）。解完直推即触发流水线。

---

## 流程 B：提 PR（`[DEV_PUSH_MODE]` = 提 PR）

跟 ship 几乎一样、**唯一区别：`submit_mr` 的 `target_branch` 填该仓 dev 分支（不是测试分支）**。

对每个配了 dev 分支的仓（逐个独立 shell、从仓根 `cd`）：

```bash
cd <repoPath>
DEV=<该仓 dev 分支>
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if ! git fetch origin "$DEV" 2>&1; then
  echo "[error] fetch origin/$DEV 失败、停止本仓"; exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "<commit msg>"
fi
CHANGES=$(git diff "origin/$DEV...$BRANCH" --name-only)
if [ -z "$CHANGES" ]; then
  echo "[skip] 本仓相对 origin/$DEV 无改动、跳过"; exit 0
fi
# push feature 到 origin（同名 source、绝不 force、绝不把 dev merge 进 feature）
if ! git push -u origin "$BRANCH" 2>&1; then
  echo "[error] push 失败、停止本仓（绝不 force、绝不 merge dev 进 feature、报用户处理）"; exit 1
fi
HEAD_SHA=$(git rev-parse HEAD)
REMOTE_URL=$(git config --get remote.origin.url)
PROJECT_PATH=$(echo "$REMOTE_URL" | sed -E 's#^[^@]+@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
echo "[ok] DEV=$DEV BRANCH=$BRANCH HEAD=$HEAD_SHA PROJECT=$PROJECT_PATH"
```

push 成功后调 `submit_mr`（**target_branch = dev 分支**）：

```typescript
submit_mr({
  task_id,
  action_id,
  repo_path: "<本仓本地绝对路径>",
  project_path: "<解析出的 wkid/crm-web>",
  source_branch: "<BRANCH>",
  target_branch: "<该仓 dev 分支>",          // ⚠️ 联调 = dev 分支、不是测试分支、也不是 master
  title: "[联调][<role>] <task.title>",       // role = task.role 中文 label、v>1 加版本号
  description: "<MR description、参考 ship 的 description 模板>",
  last_commit_hash: "<HEAD_SHA>",
})
```

- 返 `{ ok, data: { mr_url, mr_version, has_conflicts, merge_status, ... } }`、记下 `mr_url` + `has_conflicts` 给 artifact。
- `has_conflicts: true` → 先别动手、记下、所有仓跑完统一到「## 冲突处理」问用户。
- server 自动按 `(repoPath, dev 分支)` 维护本仓联调 MR——跟同仓的提测 MR（→ 测试分支）各记各的、各自累计 version、互不覆盖。
- 失败返 `{ ok: false, error }` → artifact 记错、继续下一个仓（不重试、不 force push、不降级到 `git push -o`）。

---

## 冲突处理（两种模式共用、参考 ship §3.5/§3.6）

汇总所有仓结果、有冲突时调一次 `ask_user`（多仓合并成一条、列清单）：

```typescript
ask_user({
  task_id, action_id,
  questions: [{
    id: "resolve_conflicts",
    question: "<仓名> 跟 <dev> 有冲突。要我智能解决吗？（feature 分支全程不动）",
    options: [
      { id: "ai", label: "AI 智能解决" },
      { id: "manual", label: "我自己解决（解完回复、重跑联调）" },
    ],
    allow_text: true,
  }],
})
```

解冲突标记的通用原则：`git diff --name-only --diff-filter=U` 拿冲突清单 → 逐个 `read` → 按 `<<<<<<<` / `=======` / `>>>>>>>` 智能合并（**保留 feature 这次任务的业务意图、同时纳入 dev 在冲突处的改动**、一般两边都要、不是二选一）→ 拿不准（语义冲突 / 两边逻辑互斥 / 删改冲突）就停下来 `ask_user` 把这处贴出来问用户。

- **直推模式 + 选 AI 解**：此刻已在本地 dev 分支的 merge 冲突态、就地解：解完 `git diff --check` 确认无残留 → `git add -A && git commit --no-edit` → `git push origin "$DEV":"$DEV"` → `git checkout "$FEATURE"`。
- **提 PR 模式 + 选 AI 解**：走 ship §3.6 同款 `__conflict` 一次性分支（`git checkout -B "${FEATURE}__conflict" "origin/$DEV"` → `git merge --no-ff "$FEATURE"` 解冲突 → `git push -f` 该 __conflict 分支 → `git checkout "$FEATURE"` → 对本仓重调 `submit_mr`、`source_branch` 改成 `__conflict`、`target_branch` 仍是 dev 分支）。server 会自动关掉被取代的旧 MR、别手动折腾。
- **选自己解**：直推模式 `git merge --abort` 回干净态 + `git checkout "$FEATURE"`；提 PR 模式留着现状、等用户解完回复后重跑联调 action。

---

## 写 artifact + wait_for_user

artifact 路径：`actions/<N>-dev.md`、按下方骨架写、写完调 `wait_for_user({ task_id, action_id, artifact_path: "actions/<N>-dev.md" })` 等用户 ack。

### artifact 骨架

```markdown
# Dev（联调）#<N>

## §1 基本信息
- task: <task.id> <task.title>
- 推送方式: <直推 direct | 提 PR mr>
- 仓数: <repoPaths.length>

## §2 推送详情
| 仓 | dev 分支 | source | HEAD commit | 方式 | MR（提 PR 时）| 冲突 | 备注 |
|---|---------|--------|-------------|------|------|------|------|
| <repo1> | develop | feature/clj/x | abc1234 | 直推 | - | 无 | 已推 origin/develop、触发流水线 |
| <repo2> | develop | feature/clj/x | def5678 | 提 PR | <mr_url> v1 | 已解(AI) | __conflict 分支解、旧 MR 已被 server 关 |
| <repo3> | - | - | - | - | - | - | 跳过、原因：未配 dev 分支 / 本仓无改动 |

## §3 自检
- typecheck: ✅ / ❌
- lint: ✅ / ❌
- git status 干净（已 checkout 回 feature）: ✅ / ❌

## §4 待澄清 / 风险
<跳仓 / 冲突用户自己解 / push 失败 / MR 失败的、列这里>
```

## 反例

- ❌ 把 dev 分支 `merge` / `rebase` / `pull` 进 **feature**（绝对不、feature 保持干净）
- ❌ force push feature / dev 分支（直推 dev 用普通 push；只有提 PR 模式的一次性 `__conflict` 分支才能 force）
- ❌ 不看 `[DEV_PUSH_MODE]` 指令、自己挑直推还是提 PR、或两套都做（严格按指令走一套）
- ❌ 提 PR 模式 `target_branch` 填测试分支 / master（联调 target = dev 分支）
- ❌ 直推模式去调 `submit_mr`（直推不提 MR）；提 PR 模式去本地 push dev（提 PR 不直推）
- ❌ 没配 dev 分支的仓硬推（跳过、artifact 记原因）
- ❌ 走 `git push -o merge_request.create` 绕开 `submit_mr`（task.mrs 不落库、详情页看不到）
- ❌ push 被拒（non-fast-forward）时 force push 覆盖远程（绝对不、报用户处理 / 重跑）
- ❌ 交卷后自动跑下一 action（绝对不、交卷即结束回复、等用户推进）

## 调用礼仪

- 过程中不在 assistant_message 里讲「我要 push / 我要提 MR」之类（用户从 artifact 看就够）；调 `submit_mr` 前不复述参数、拿到 MR url 不复述「MR 已创建」、直接落 artifact。
- 写完 artifact 后、`wait_for_user` 前可以流式输出 1-3 句结论（推了哪些仓 / 用哪种方式 / 有无遗留），然后**紧跟** `wait_for_user`——别只说不调（turn 结束 = run 结束 = task failed）。
