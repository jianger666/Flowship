/**
 * GitLab REST API 客户端（V0.6.1 ship action 用）
 *
 * ## 设计取舍（V0.6.1 拍板）
 *
 * - **不**依赖 glab CLI：用户不用装、容器化部署也省事
 * - **不**依赖外部 MCP server（GitLab 官方 MCP 当前不支持自建实例）：直接 server 调 REST API
 * - **PAT 走 server 不走 agent**：API token 不暴露给 agent process、降低泄露风险
 * - 当前公司场景所有仓共用同一个 GitLab 实例、所以 host + token 是全局字段（settings 顶级）、
 *   不是 per-repo——未来要支持多 host 时再补 per-repo 覆盖字段
 *
 * ## 接口约定
 *
 * - `projectPath` 由 agent 在 shell 跑 `git config --get remote.origin.url` 解析后传入、
 *   server 不做本地仓库路径映射（解耦：server 只认识 GitLab API、不认识本地文件系统）
 * - 失败 always 返结构化错误（不抛、不 throw）、agent 拿到 `{ ok: false, error }` 直接转告用户、
 *   不试图自救——失败原因（token 过期 / project 不存在 / branch 不存在 / network）由人决策
 * - 不做重试：MR 是带副作用的操作、重试可能造成重复 MR、调用方按需手动重试
 */

interface GitLabConfig {
  /** 不带协议前缀、如 `gitlab.wukongedu.net` */
  host: string;
  /** Personal Access Token、需要 `api` scope */
  token: string;
}

/**
 * 创建 MR 入参
 *
 * `projectPath` 是 GitLab 内部 project 标识、形如 `group/subgroup/repo`、不带 host
 * 从 `git config --get remote.origin.url` 解析：
 *   - `git@gitlab.wukongedu.net:wkid/crm-web.git` → `wkid/crm-web`
 *   - `https://gitlab.wukongedu.net/wkid/crm-web.git` → `wkid/crm-web`
 */
export interface CreateMRInput {
  config: GitLabConfig;
  projectPath: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export type CreateMRResult =
  | {
      ok: true;
      /** MR 网页 URL（GitLab 返的 web_url、直接给用户点开） */
      url: string;
      /** project 内 MR 编号（用户看到的 !N、不是全局 ID） */
      iid: number;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * 查 MR 可合性（冲突检测）入参（V0.6.1.1 ship 冲突检测用）
 */
export interface GetMRMergeStatusInput {
  config: GitLabConfig;
  projectPath: string;
  iid: number;
}

/**
 * MR 可合性结果
 *
 * - detailedStatus：GitLab `detailed_merge_status` 原值（mergeable / conflict / ci_must_pass / checking ...）
 * - hasConflicts：feature 跟 target(test) 有冲突（detailed=conflict / 老字段 cannot_be_merged / has_conflicts=true）
 * - mergeable：可干净合入
 * - undetermined：poll 到超时 GitLab 仍在 checking（算不准、调用方当「未知」别误判成「无冲突」）
 */
export type MRMergeStatusResult =
  | {
      ok: true;
      detailedStatus: string;
      hasConflicts: boolean;
      mergeable: boolean;
      undetermined: boolean;
    }
  | { ok: false; error: string };

const buildBaseUrl = (host: string): string => {
  const trimmed = host.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
  if (!trimmed) throw new Error("GitLab host 为空");
  return `https://${trimmed}/api/v4`;
};

const buildHeaders = (token: string): HeadersInit => {
  if (!token.trim()) throw new Error("GitLab token 为空");
  return {
    "PRIVATE-TOKEN": token.trim(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
};

const encodeProjectPath = (projectPath: string): string => {
  // GitLab API 接受 URL-encoded path 作为 project id、如 wkid%2Fcrm-web
  // 用 encodeURIComponent 自动把 / 转 %2F、其他特殊字符也一并处理
  return encodeURIComponent(projectPath.trim());
};

/**
 * 解析 GitLab API 错误响应、返人类可读的错误字符串
 *
 * GitLab 错误格式有几种：
 *   - { message: "..." }
 *   - { message: { base: ["..."], source_branch: ["..."] } }
 *   - { error: "..." } / { error_description: "..." }
 *   - 非 JSON（HTML 错误页）→ 用 status text
 */
const formatGitLabError = async (res: Response): Promise<string> => {
  const status = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (typeof body?.message === "string") return `${status}: ${body.message}`;
    if (body?.message && typeof body.message === "object") {
      // 字段级错误：把所有字段错误平铺
      const parts: string[] = [];
      for (const [field, msgs] of Object.entries(body.message)) {
        const list = Array.isArray(msgs) ? msgs.join("; ") : String(msgs);
        parts.push(`${field}: ${list}`);
      }
      return `${status}: ${parts.join(" | ")}`;
    }
    if (typeof body?.error === "string") {
      return `${status}: ${body.error}${
        body.error_description ? ` (${body.error_description})` : ""
      }`;
    }
    return `${status}: ${JSON.stringify(body).slice(0, 200)}`;
  } catch {
    return `${status}: <non-JSON body>`;
  }
};

/**
 * 查指定 source→target 的 open MR（createMR 撞 409「已有同分支 MR」时复用现有 MR 用）
 *
 * GitLab list MR API、按 source_branch + target_branch + state=opened 过滤、取第一条。
 * 复用 CreateMRResult 类型（拿到的也是 url + iid、跟新建语义对调用方透明）。
 */
const findOpenMR = async (input: CreateMRInput): Promise<CreateMRResult> => {
  let base: string;
  let headers: HeadersInit;
  try {
    base = buildBaseUrl(input.config.host);
    headers = buildHeaders(input.config.token);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const q = new URLSearchParams({
    source_branch: input.sourceBranch,
    target_branch: input.targetBranch,
    state: "opened",
  });
  const url = `${base}/projects/${encodeProjectPath(input.projectPath)}/merge_requests?${q.toString()}`;
  try {
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    const body = await res.json();
    const first = Array.isArray(body) ? body[0] : undefined;
    if (
      !first ||
      typeof first.web_url !== "string" ||
      typeof first.iid !== "number"
    ) {
      return { ok: false, error: "未查到同 source/target 的 open MR" };
    }
    return { ok: true, url: first.web_url, iid: first.iid };
  } catch (err) {
    return {
      ok: false,
      error: `网络错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * 创建 MR（V0.6.1.1 起幂等：撞 409「已有同分支 open MR」时自动复用现有 MR、不当失败）
 *
 * 失败常见原因：
 *   - 401：token 失效 / 权限不足
 *   - 404：project 不存在 / token 没有该 project 访问权限
 *   - 409：同 source/target branch 已存在 open MR → 降级 findOpenMR 复用（多次 ship / 解冲突后重跑必经）
 *   - 400：source branch 不存在（push 没成功就提 MR 时常见）
 */
export const createMR = async (
  input: CreateMRInput,
): Promise<CreateMRResult> => {
  let base: string;
  let headers: HeadersInit;
  try {
    base = buildBaseUrl(input.config.host);
    headers = buildHeaders(input.config.token);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const url = `${base}/projects/${encodeProjectPath(input.projectPath)}/merge_requests`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        // V0.6.1 暂不指派 reviewer/assignee——公司流程是研发自己 cc 测试到飞书 story 评论里
        // remove_source_branch=true：merge 后自动删 source branch、避免分支膨胀
        remove_source_branch: true,
      }),
    });
    if (!res.ok) {
      // 409 / 422 可能是「已有同分支 open MR」（多次 ship / 解冲突后重跑必经、GitLab 版本差异两种码都出现过）
      // 也可能是别的验证错误（如 source branch 不存在）——先试 findOpenMR 复用、
      //   查到就视同建好、查不到退回原始错误（不拿「复用失败」掩盖真因）
      if (res.status === 409 || res.status === 422) {
        const existing = await findOpenMR(input);
        if (existing.ok) return existing;
        return { ok: false, error: await formatGitLabError(res) };
      }
      return { ok: false, error: await formatGitLabError(res) };
    }
    const body = await res.json();
    if (typeof body?.web_url !== "string" || typeof body?.iid !== "number") {
      return {
        ok: false,
        error: `GitLab createMR 返回缺字段 web_url/iid: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    return { ok: true, url: body.web_url, iid: body.iid };
  } catch (err) {
    return {
      ok: false,
      error: `网络错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * 查 MR 可合性（V0.6.1.1 ship 冲突检测）
 *
 * 为什么单独一个函数而不复用 getMR：
 *   - getMR 给 V0.6.4 polling 用、读 state（opened/merged）
 *   - 这里要的是 mergeability（能不能干净合 / 有没有冲突）、字段是 detailed_merge_status / has_conflicts
 *
 * ⚠️ GitLab 算 mergeability 是异步的：MR 刚建出来 detailed_merge_status 往往是
 *   checking / unchecked / preparing、要 poll 几次才稳定。本函数内部 poll
 *   （最多 maxPolls 次、间隔 intervalMs）：
 *   - 命中稳定态（mergeable / conflict / ci_must_pass ...）→ 立刻返回
 *   - poll 到超时仍在算 → undetermined=true（调用方当「算不准、别误判成无冲突」）
 *
 * 老 GitLab 实例没 detailed_merge_status 字段时、退回读 merge_status（can_be_merged / cannot_be_merged）。
 */
export const getMRMergeStatus = async (
  input: GetMRMergeStatusInput,
  opts?: { maxPolls?: number; intervalMs?: number },
): Promise<MRMergeStatusResult> => {
  const maxPolls = opts?.maxPolls ?? 5;
  const intervalMs = opts?.intervalMs ?? 1500;

  let base: string;
  let headers: HeadersInit;
  try {
    base = buildBaseUrl(input.config.host);
    headers = buildHeaders(input.config.token);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const url = `${base}/projects/${encodeProjectPath(input.projectPath)}/merge_requests/${input.iid}`;
  // GitLab 仍在算 mergeability 的中间态、命中要继续 poll
  const PENDING = new Set(["checking", "unchecked", "preparing"]);

  let lastDetailed = "unchecked";
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch (err) {
      return {
        ok: false,
        error: `网络错误：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    const body = await res.json();
    // detailed_merge_status 优先（GitLab 15.6+）、老实例退回 merge_status
    const detailed: string =
      typeof body?.detailed_merge_status === "string"
        ? body.detailed_merge_status
        : typeof body?.merge_status === "string"
          ? body.merge_status
          : "unchecked";
    lastDetailed = detailed;
    const hasConflictsField = body?.has_conflicts === true;

    // 还在算 + 不是最后一次 → 等一下再 poll
    if (PENDING.has(detailed) && attempt < maxPolls - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    const undetermined = PENDING.has(detailed);
    // 冲突判定：detailed=conflict / 老字段 cannot_be_merged / has_conflicts=true 任一命中
    const hasConflicts =
      detailed === "conflict" ||
      detailed === "cannot_be_merged" ||
      hasConflictsField;
    const mergeable = detailed === "mergeable" || detailed === "can_be_merged";
    return { ok: true, detailedStatus: detailed, hasConflicts, mergeable, undetermined };
  }

  // 兜底（循环里最后一次必 return、正常到不了这）
  return {
    ok: true,
    detailedStatus: lastDetailed,
    hasConflicts: false,
    mergeable: false,
    undetermined: true,
  };
};
