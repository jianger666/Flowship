/**
 * Action 准入门槛 + ship 门禁 + build 分支规划（V0.9.x 从 task-runner.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（推进前的「能不能推」判定、全是纯函数 / 只读 git）：
 *   - checkActionPrerequisites：action 类型准入（门槛 1、技术必需类校验）
 *   - checkShipCheckGate / getShipPrecheck：ship 前 CheckRun 门禁（V0.6.25、可 override 但留痕）
 *   - planBranchesForBuild：build 首动作的分支规划 + idempotent checkout hint
 *
 * 依赖方向（保证无环）：只依赖 action-checks / branch-template / types、不 import task-runner。
 */

import { computeWorktreeFingerprint } from "./action-checks";
import {
  DEFAULT_BRANCH_TEMPLATE,
  renderBranchName,
} from "@/lib/branch-template";
import type {
  ActionType,
  CheckOverride,
  GitBranchInfo,
  ShipPrecheck,
  Task,
} from "@/lib/types";
import { ACTION_LABEL } from "@/lib/types";

// 已实装的 action 类型（advanceTask 准入门槛 1）
const AVAILABLE_ACTIONS: ReadonlySet<ActionType> = new Set([
  "plan",
  "build",
  "review",
  "ship",
  "learn",
  "dev",
  // 自定义 action：定义存在性在 advance API 校验、这里放行
  "custom",
]);

// ----------------- 准入门槛 1：action 类型 + 上游 action 依赖 -----------------

export interface PrerequisiteContext {
  gitHost?: string;
  gitToken?: string;
}

export const checkActionPrerequisites = (
  task: Task,
  actionType: ActionType,
  ctx: PrerequisiteContext = {},
): { ok: true } | { ok: false; reason: string } => {
  if (!AVAILABLE_ACTIONS.has(actionType)) {
    return {
      ok: false,
      reason: `action 类型「${ACTION_LABEL[actionType]}」尚未实现、当前支持 plan / build / review / ship / learn / dev（联调）。`,
    };
  }

  switch (actionType) {
    case "plan":
      return { ok: true }; // 永远可
    case "build":
      // V0.6.17：放开「build 必须先 plan」——小改 / 修 bug 直接 build、plan 是过度流程。
      // 有 plan 时按 plan 工单走、无 plan 时按用户指令直接改（范围以指令为准、靠 review 兜底）。
      return { ok: true };
    case "review":
      // V0.x：去掉「review 必须先有 build」流程限制——允许直接 review 现状代码找 bug、
      //   不强求先 build（agent 无改动可复核时会在 artifact 自己说明、不报错）。
      return { ok: true };
    case "ship": {
      // V0.x：去掉「ship 必须先有 build」流程限制（没改动直接 ship、agent 会发现工作区干净自己报）。
      //   保留 GitLab host/token 校验——技术必需（没配真调不了 GitLab API、提不了 MR）、不是流程限制。
      if (!ctx.gitHost || ctx.gitHost.trim().length === 0) {
        return {
          ok: false,
          reason: "ship 需要配 GitLab Host、请去「设置 → GitLab 配置」填上（如 gitlab.wukongedu.net）。",
        };
      }
      if (!ctx.gitToken || ctx.gitToken.trim().length === 0) {
        return {
          ok: false,
          reason: "ship 需要配 GitLab Personal Access Token、请去「设置 → GitLab 配置」填上（需要 api scope）。",
        };
      }
      return { ok: true };
    }
    case "learn":
      // V0.x：去掉「learn 必须先有 completed action」流程限制——空 task learn 时 agent 会发现
      //   没过程可复盘、自己说明、不报错。把判断权交给用户。
      return { ok: true };
    case "dev": {
      // V0.x：联调技术准入——至少一个仓配了 dev 分支（dev 分支名没法猜默认、必须设置页显式配）。
      //   没配 dev 分支的仓 agent 会跳过、全没配则这里拦 + 提示去设置页配（同 ship host/token 性质：技术必需、非流程限制）。
      const anyDev = task.repoPaths.some(
        (p) => (task.repoDevBranches?.[p]?.trim() ?? "").length > 0,
      );
      if (!anyDev) {
        return {
          ok: false,
          reason:
            "联调需要先给仓库配 dev 分支（设置 → 仓库列表 → dev 分支）、否则不知道推到哪。",
        };
      }
      return { ok: true };
    }
    case "custom":
      // 自定义 action：技术准入无额外要求（定义存在性 + customActionId 在 advance API 校验）。
      return { ok: true };
    default: {
      const _: never = actionType;
      return { ok: false, reason: `未知 action 类型：${_}` };
    }
  }
};

/**
 * V0.6.25 ship gate：最新 build 的 CheckRun 没过 / 没配 / 没运行时、要求 per-ship override（风险接受、不是偏好）
 *
 * - 只看「最新一个 completed build」的 checkRun（ship 提的就是它的产出）
 * - checkRun.status === passed **且各仓工作区指纹没变** → 直接放行
 * - 工作区指纹比对（V0.6.25 review）：check 后又改工作区 → 指纹不一致、即使 passed 也要 override（防「曾经检查过」≠「当前要 ship 的内容检查过」）
 * - failed / not_configured / 没 checkRun（老 build / 异常）→ 必须带 override、且：
 *   · override.buildActionId 等于这个 build（重 build = 新 build action id、旧 override 自动失效）
 *   · checkRun 存在时 override.checkRunId 也要等于它（双保险：同 build 重跑过 check 也失效）
 *   · override.reason 非空（审计：为什么明知没过还提测）
 * - HITL 底线：这道门永远能被 override 越过、但必须留痕。
 */
export const checkShipCheckGate = async (
  task: Task,
  override?: CheckOverride,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const lastBuild = task.actions
    .slice()
    .reverse()
    .find((a) => a.type === "build" && a.status === "completed");
  // 没 completed build 的情况由 checkActionPrerequisites 先拦、这里兜底放行
  if (!lastBuild) return { ok: true };

  const cr = lastBuild.checkRun;
  let worktreeChanged = false;
  if (cr) {
    for (const repo of cr.repos) {
      if (!repo.worktreeFingerprint) continue;
      const current = await computeWorktreeFingerprint(repo.repoPath);
      if (current && current !== repo.worktreeFingerprint) {
        worktreeChanged = true;
        break;
      }
    }
  }
  if (cr && cr.status === "passed" && !worktreeChanged) return { ok: true };

  const why = worktreeChanged
    ? "检查通过后工作区又被改动（建议重新 build 检查、或确认风险后强制提测）"
    : !cr
      ? "未运行检查"
      : cr.status === "failed"
        ? "检查未通过"
        : cr.status === "not_configured"
          ? "有改动的仓没配检查命令"
          : "检查未通过";
  if (!override) {
    return {
      ok: false,
      reason: `最新 build 的${why}、ship 被拦。如确认无碍、请在提测 dialog 勾「仍继续提测」并填写原因。`,
    };
  }
  if (override.buildActionId !== lastBuild.id) {
    return {
      ok: false,
      reason:
        "提测确认已失效（绑定的不是最新 build、可能你又 build 过）、请重新勾选确认。",
    };
  }
  if (cr && override.checkRunId !== cr.id) {
    return {
      ok: false,
      reason: "提测确认已失效（检查已重跑）、请重新勾选确认。",
    };
  }
  if (!override.reason.trim()) {
    return { ok: false, reason: "提测确认必须填写原因。" };
  }
  return { ok: true };
};

/**
 * V0.6.25 review：ship 前置预检（GET /api/tasks/[id]/ship-precheck 调）
 *
 * 复用 checkShipCheckGate（不带 override）跑一遍、把结论给 client 展示 override 区。
 * gate 逻辑单一源在此、client 不自己用 checkRun.status 猜。⚠ 仅展示、/advance 仍会重算 gate。
 */
export const getShipPrecheck = async (task: Task): Promise<ShipPrecheck> => {
  const lastBuild = task.actions
    .slice()
    .reverse()
    .find((a) => a.type === "build" && a.status === "completed");
  // 没 completed build：ship 准入会被 checkActionPrerequisites 拦、这里不涉及 override
  if (!lastBuild) {
    return {
      needsOverride: false,
      reason: "",
      buildActionId: null,
      checkRunId: null,
      reviewMissing: false,
    };
  }
  const gate = await checkShipCheckGate(task);
  // V0.6.27 F3：最新 build 之后有没有 completed review——没有就提醒（非阻断、HITL 用户可跳过）。
  // 按 startedAt 比：action 串行、review 启动晚于 build 启动即必然 review 的是这轮 build 后的代码。
  const reviewMissing = !task.actions.some(
    (a) =>
      a.type === "review" &&
      a.status === "completed" &&
      !a.excluded &&
      a.startedAt > lastBuild.startedAt,
  );
  return {
    needsOverride: !gate.ok,
    reason: gate.ok ? "" : gate.reason,
    buildActionId: lastBuild.id,
    checkRunId: lastBuild.checkRun?.id ?? null,
    reviewMissing,
  };
};

// ----------------- branch checkout 挂接（build action 第一次跑前）-----------------

/**
 * V0.6.1：build action 第一动作前、拼每仓 GitBranchInfo + 引导 agent 逐仓 idempotent checkout
 *
 * branch 命名规则（V0.6 拍板、多仓共用同一 name）：
 *   `feature/<username>/<飞书 story id>-<task.title 转换后>`
 *   - username 取自 settings.username
 *   - 飞书 story id 从 task.feishuStoryUrl 抠 URL 末段数字（如 detail/6956910305）
 *   - task.title 转换：保留中文、空白/特殊字符替换为 -
 *
 * base branch 探测交给 agent：每仓自探（不同仓可能 master / main / develop）
 *
 * V0.6.1 简化：**每次 build 都 inject hint、agent 跑 idempotent shell**
 *   （branch 存在 → checkout、不存在 → 基于探到的主分支建）、不再维护 checkedOut 状态。
 *   gitBranches 数组只在首次建条目时落库、之后保留 createdAt 历史值。
 *
 * 返回 null：缺 username / feishuStoryUrl / repoPaths 为空、不建 branch
 */
export const planBranchesForBuild = (
  task: Task,
  username: string | undefined,
): { infos: GitBranchInfo[]; promptHint: string } | null => {
  // V0.6.7：username 不再硬性必需（后端模板可能用 {date} 段替代 {username} 段）；
  //   storyId 仍需要（默认 + 后端模板都含 {storyId}）、feishuStoryUrl 空则不建分支
  if (!task.feishuStoryUrl || task.feishuStoryUrl.trim().length === 0) {
    return null;
  }
  const repoPaths = task.repoPaths ?? [];
  if (repoPaths.length === 0) {
    return null;
  }

  // 飞书 story id：URL 里 detail/<digits> 这段、最长一段连续数字兜底
  const m = task.feishuStoryUrl.match(/detail\/(\d+)/) ??
    task.feishuStoryUrl.match(/(\d{6,})/);
  const storyId = m ? m[1] : null;
  if (!storyId) {
    return null;
  }

  const now = Date.now();
  // V0.6.7：分支名按 per-repo 有效模板渲染（task.repoBranchTemplates 建 task 时固化、缺省回退内置默认）。
  //   占位符 {username}/{storyId}/{taskTitle}/{date:fmt}、值各自 branch-safe 化、详见 branch-template.ts
  const renderForRepo = (repoPath: string): string =>
    renderBranchName(
      task.repoBranchTemplates?.[repoPath] || DEFAULT_BRANCH_TEMPLATE,
      { username, storyId, taskTitle: task.title },
    );

  // 每仓 1 条 GitBranchInfo（已存在的保留历史记录、不覆盖 baseBranch / createdAt）
  // V0.6.3：用户给某仓填了「已有工作分支」→ 用它当 name（build 复用、不另建）；否则按模板渲染。
  //   name 落库到 gitBranches[].name、ship 提测的 MR 源分支也取这个、自动用对。
  const existing = task.gitBranches ?? [];
  const infos: GitBranchInfo[] = repoPaths.map((repoPath) => {
    const old = existing.find((b) => b.repoPath === repoPath);
    if (old) return old;
    const explicitName = task.repoFeatureBranches?.[repoPath]?.trim();
    return {
      repoPath,
      name: explicitName || renderForRepo(repoPath),
      baseBranch: "",
      checkedOut: false,
      createdAt: now,
    };
  });

  // 多仓 hint：逐仓 idempotent checkout（branch 存在则 checkout、不存在则建）
  const isMultiRepo = repoPaths.length > 1;
  // V0.6.3：每仓实际分支名取自 infos（可能因用户指定「已有工作分支」而各仓不同名）
  const uniqueNames = [...new Set(infos.map((i) => i.name))];
  const lines: string[] = [];
  lines.push("## 准入：build 第一动作、逐仓 idempotent checkout 分支");
  lines.push("");
  if (isMultiRepo) {
    if (uniqueNames.length === 1) {
      lines.push(
        `本 task 涉及 ${repoPaths.length} 个仓、共用同一 branch name：\`${uniqueNames[0]}\``,
      );
    } else {
      lines.push(
        `本 task 涉及 ${repoPaths.length} 个仓、各仓 branch name 见下（部分仓指定了已有分支）`,
      );
    }
  } else {
    lines.push(`本 task 的 branch name：\`${infos[0]?.name ?? ""}\``);
  }
  lines.push("");
  lines.push(
    "**第一动作**：调 `shell` 工具、对每个仓跑下面 idempotent 命令（branch 存在则 checkout、不存在则基于主分支建）：",
  );
  lines.push("");

  for (const repoPath of repoPaths) {
    // V0.6.3：该仓实际分支名（用户指定的已有分支 or 模板渲染名）、下面 checkout 用它
    const name =
      infos.find((i) => i.repoPath === repoPath)?.name ??
      renderForRepo(repoPath);
    if (isMultiRepo) {
      lines.push(`### 仓 \`${repoPath}\``);
      lines.push("");
    }
    lines.push("```bash");
    if (isMultiRepo) {
      lines.push(`cd ${repoPath}`);
    }
    // V0.6.3：该仓的线上分支（建 task 时从 settings 快照、per-repo）。配了就用、没配回退探测
    const repoBase = task.repoBaseBranches?.[repoPath]?.trim();
    if (repoBase) {
      // 用户在设置页给这个仓配了线上分支 → 直接用、不探测（后端 develop 默认分支会误判）
      lines.push("# 线上分支由用户在设置页指定（per-repo）、不探测");
      lines.push(`BASE=${JSON.stringify(repoBase)}`);
      lines.push("# 校验该分支在远程存在（防设置里填错名）");
      lines.push(
        'if ! git ls-remote --exit-code --heads origin "$BASE" >/dev/null 2>&1; then',
      );
      lines.push(
        '  echo "[error] 远程不存在分支 $BASE（设置页填的线上分支名、请核对）、放弃 checkout"',
      );
      lines.push("  exit 1");
      lines.push("fi");
    } else {
      lines.push("# 探主分支名（master / main / develop 都可能、用户没手填线上分支）");
      lines.push(
        "BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')",
      );
      lines.push('if [ -z "$BASE" ]; then');
      lines.push(
        "  BASE=$(git remote show origin 2>/dev/null | sed -n '/HEAD branch:/s/.*: //p')",
      );
      lines.push("fi");
      lines.push('if [ -z "$BASE" ]; then');
      lines.push('  echo "[error] 探不到主分支、放弃 checkout、稍后回报用户"');
      lines.push("  exit 1");
      lines.push("fi");
    }
    lines.push("# Idempotent：branch 已存在则 checkout、否则基于主分支建");
    lines.push(`if git show-ref --verify --quiet refs/heads/${name}; then`);
    lines.push(`  git checkout ${name}`);
    lines.push("else");
    lines.push(
      // --no-track：feature 绝不 track 线上分支。否则 git 默认（autoSetupMerge=true、从 origin/<线上>
      //   切时自动设 upstream=origin/<线上>）会让之后的裸 git push（+ push.default=upstream/tracking）
      //   误推线上、污染线上分支。--no-track 让新建分支不设 upstream；同名 upstream（origin/feature）
      //   由 ship 首次 `git push -u origin <feature>` 自然建立（-u 会覆盖、连存量脏分支也一并修回同名）。
      //   注：build 故意不主动 unset upstream——保住用户/ship 手动设好的同名 upstream、不打扰人手动推送。
      `  git fetch origin "$BASE" && git checkout -b ${name} --no-track "origin/$BASE"`,
    );
    lines.push("fi");
    // V0.6.20 防御：checkout 后强制 verify 当前分支 == 目标分支。
    //   防 checkout 静默失败 / 仍停在别的 task 分支上、agent 继续在错分支改代码（曾踩坑：
    //   agent 没切分支直接在别的需求 feature 分支上改、污染了那个分支）。
    lines.push("# 防御：确认确实切到目标分支（不对就停、绝不在错分支改代码）");
    lines.push("CURRENT=$(git rev-parse --abbrev-ref HEAD)");
    lines.push(`if [ "$CURRENT" != ${JSON.stringify(name)} ]; then`);
    lines.push(
      `  echo "[error] 当前分支 $CURRENT != 目标分支 ${name}、停止 build（不要在错分支改代码、调 wait_for_user 报告用户）"`,
    );
    lines.push("  exit 1");
    lines.push("fi");
    lines.push(`echo "[ok] 已在目标分支 ${name}"`);
    lines.push("```");
    lines.push("");
  }

  lines.push(
    "checkout 成功后、按下面 build action 标准流程做实施（多仓 task：所有仓都得 checkout 成功才开始改代码）。",
  );
  lines.push(
    "checkout 失败（工作区脏 / 探不到主分支 / 仓不是 git 仓库）→ emit 一段简短 assistant_message 告知问题、调 wait_for_user 等用户处理（**不要**自己 force / reset 操作硬盘）。",
  );

  return { infos, promptHint: lines.join("\n") };
};
