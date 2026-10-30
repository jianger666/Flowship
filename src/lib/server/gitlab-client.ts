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
 * - PAT 只发往可信 host：所有请求都经 buildBaseUrl，里面先过 assertTrustedGitHost（见 trusted-git-host.ts）
 * - PAT 不跟随重定向：所有 fetch 都走 fetchWithGitToken（`redirect: "error"`）。undici 跨源 302 只剔除
 *   Authorization / Cookie、不剔自定义头 `PRIVATE-TOKEN`——不关的话可信 host 一个 302 就能把 PAT 带给别的 host。
 *   新增 REST 入口**必须**用它、不要直接 fetch（tests/gitlab-client-redirect.test.ts 会逐个入口验证）。
 */

import {
  assertTrustedGitHost,
  fetchWithGitToken,
  GitHostRedirectError,
} from "./trusted-git-host";

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
  /** 合并后是否删源分支（V0.6.14、可配；调用方按 task.removeSourceBranchOnMerge 传、默认保留） */
  removeSourceBranch: boolean;
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

/** 单个 MR 详情（提测收件箱展示 + 合并门禁） */
export interface GetMRInput {
  config: GitLabConfig;
  projectPath: string;
  iid: number;
}

export type GetMRResult =
  | {
      ok: true;
      iid: number;
      url: string;
      title: string;
      description: string;
      state: string;
      sourceBranch: string;
      targetBranch: string;
      detailedMergeStatus: string;
      hasConflicts: boolean;
      mergeable: boolean;
      /** 源分支当前 HEAD 提交（GitLab `sha`）。收件箱据此在合并时带 `sha` 守卫——只合用户看到的那一版 */
      headSha?: string;
    }
  | { ok: false; error: string };

export type MergeMRResult =
  | {
      ok: true;
      url: string;
      iid: number;
      /** 这次没有真的合并：MR 在我们动手前已经是 merged（双击 / 两个窗口 / 别人先合了），按成功处理 */
      alreadyMerged?: true;
    }
  | { ok: false; error: string };

/** GitLab REST 统一超时——无超时会在网络挂死时拖死 ship / 关旧 MR */
const FETCH_TIMEOUT_MS = 30_000;

const buildBaseUrl = (host: string): string => {
  const trimmed = host.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
  if (!trimmed) throw new Error("GitLab host 为空");
  // PAT 只发往可信 host（首次绑定固定 / 白名单，见 trusted-git-host.ts）。
  // 放在 buildBaseUrl 而不是各调用方：本模块每个 REST 入口都先过这里、再 buildHeaders、最后才 fetch，
  // 校验失败（throw）发生在构造请求之前、调用方的 try/catch 会收成 { ok:false }——没有任何网络请求发出。
  // 调用方（submit_mr / 收件箱 / 合并 route）各自也会提前校验给出更早、更清晰的失败；这里是兜底，
  // 防以后新增调用方忘了校验。
  // 请求 URL 用校验返回的「规范化 host」而不是原始输入：校验的就是实际发出去的 host，
  // 不给「校验看到 A、URL 解析器却认成 B」的差异留空间（大小写 / `:443` / 尾点都已收敛）。
  const trustedHost = assertTrustedGitHost(trimmed);
  return `https://${trustedHost}/api/v4`;
};

/** fetch 失败文案：TimeoutError / AbortError 也走「网络错误」、给可读 message */
const formatFetchNetworkError = (err: unknown): string => {
  // 被重定向不是网络问题：文案本身已说明原因与处理办法，不加「网络错误」前缀误导排查方向
  if (err instanceof GitHostRedirectError) return err.message;
  if (err instanceof Error) {
    const name = err.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return `网络错误：请求超时（${FETCH_TIMEOUT_MS / 1000}s）`;
    }
    return `网络错误：${err.message}`;
  }
  return `网络错误：${String(err)}`;
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
 * 状态行 + 详情拼接。GitLab 的 405 / 404 等常把状态行原样塞进 message（`{"message":"405 Method Not Allowed"}`），
 * 直接拼会得到「405 Method Not Allowed: 405 Method Not Allowed」（Q10-05）。detail 自己以状态码打头（整句状态行也算）/
 * 就是 statusText → 只留一份。
 * 结果仍以状态码开头：`isMergeShaMismatch` 把「409 开头」当兜底判据（见 mr-merge-error.ts），不能丢。
 * HTTP/2 下 statusText 为空：状态行 trim 后只剩状态码，不会出现「405 : …」。
 */
const joinStatusAndDetail = (
  res: Response,
  status: string,
  detail: string,
): string => {
  const d = detail.trim();
  if (!d) return status;
  const text = res.statusText.trim().toLowerCase();
  if (text && d.toLowerCase() === text) return status;
  if (new RegExp(`^${res.status}\\b`).test(d)) return d;
  return `${status}: ${d}`;
};

/** message 数组里的单项 → 字符串（对象不展开成 [object Object]） */
const stringifyDetail = (item: unknown): string => {
  if (typeof item === "string") return item;
  if (item === null || item === undefined) return "";
  return JSON.stringify(item).slice(0, 200);
};

/**
 * 解析 GitLab API 错误响应、返人类可读的错误字符串
 *
 * GitLab 错误格式有几种：
 *   - { message: "..." }
 *   - { message: ["...", "..."] }（数组：逐条用「；」拼，不显示成 `0: …`）
 *   - { message: { base: ["..."], source_branch: ["..."] } }
 *   - { error: "..." } / { error_description: "..." }
 *   - 非 JSON（HTML 错误页）→ 用 status text
 */
const formatGitLabError = async (res: Response): Promise<string> => {
  const status = `${res.status} ${res.statusText}`.trim();
  try {
    const body = await res.json();
    if (typeof body?.message === "string") {
      return joinStatusAndDetail(res, status, body.message);
    }
    if (Array.isArray(body?.message)) {
      // 数组型 message：以前落进下面的 Object.entries 分支、显示成「0: a | 1: b」
      return joinStatusAndDetail(
        res,
        status,
        body.message.map(stringifyDetail).filter(Boolean).join("；"),
      );
    }
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

/** `Response.json()` 的返回类型（不写显式 any：项目禁用，且 body?.sha 之类的宽松读法要保持） */
type JsonBody = Awaited<ReturnType<Response["json"]>>;

/**
 * 读响应体 JSON，失败收成结构化错误（不抛）（Q10-06）：
 * - SyntaxError（200 + HTML：网关 / 登录页 / 代理劫持）→「返回了无法解析的内容」，不是「网络错误」；
 * - 其它（读 body 途中连接断了 / 超时）→ 才是网络错误。
 * 以前 getMRMergeStatus 把 `res.json()` 放在 try 外（200+HTML 直接抛 SyntaxError，破坏本模块「失败 always 返结构化错误」），
 * 其余入口在 try 内、被 catch 说成「网络错误：Unexpected token <」——两种都不对。
 */
const readJsonBody = async (
  res: Response,
): Promise<{ ok: true; body: JsonBody } | { ok: false; error: string }> => {
  try {
    return { ok: true, body: await res.json() };
  } catch (err) {
    // 按 name 判、不用 instanceof：Response.json 抛的 SyntaxError 可能来自另一个 realm（沙箱 / 测试环境）
    if (err instanceof Error && err.name === "SyntaxError") {
      return {
        ok: false,
        error: `GitLab 返回了无法解析的内容（HTTP ${res.status}、不是 JSON，可能被网关 / 登录页拦截）`,
      };
    }
    return { ok: false, error: formatFetchNetworkError(err) };
  }
};

/**
 * findOpenMR 结果：必须区分「确认没有」vs「查询失败」
 * （旧实现把 401/5xx/网络错误也当 ok:false、closeOpenMR 误当成「本来没开」静默成功——
 *   解冲突后旧 MR 漏关双开，审查发现）
 */
type FindOpenMRResult =
  | { ok: true; mr: { url: string; iid: number } }
  | { ok: true; mr: null }
  | { ok: false; error: string };

/**
 * 查指定 source→target 的 open MR（createMR 撞 409「已有同分支 MR」时复用现有 MR 用）
 *
 * GitLab list MR API、按 source_branch + target_branch + state=opened 过滤、取第一条。
 */
const findOpenMR = async (
  input: Pick<
    CreateMRInput,
    "config" | "projectPath" | "sourceBranch" | "targetBranch"
  >,
): Promise<FindOpenMRResult> => {
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
    const res = await fetchWithGitToken(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    const parsed = await readJsonBody(res);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const body = parsed.body;
    const first = Array.isArray(body) ? body[0] : undefined;
    if (
      !first ||
      typeof first.web_url !== "string" ||
      typeof first.iid !== "number"
    ) {
      // 确认没有同 source/target 的 open MR（空列表 / 缺字段）
      return { ok: true, mr: null };
    }
    return { ok: true, mr: { url: first.web_url, iid: first.iid } };
  } catch (err) {
    return { ok: false, error: formatFetchNetworkError(err) };
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
    const res = await fetchWithGitToken(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        // V0.6.1 暂不指派 reviewer/assignee——公司流程是研发自己 cc 测试到飞书 story 评论里
        // V0.6.14：remove_source_branch 改可配（task.removeSourceBranchOnMerge、默认保留）——
        // 用户常需保留源分支（合并后还要看 / 续推、删了得去 GitLab 重推很麻烦）。
        // `<feature>__conflict` 一次性分支由 submit_mr handler 强制传 true。
        remove_source_branch: input.removeSourceBranch,
      }),
    });
    if (!res.ok) {
      // 409 / 422 可能是「已有同分支 open MR」（多次 ship / 解冲突后重跑必经、GitLab 版本差异两种码都出现过）
      // 也可能是别的验证错误（如 source branch 不存在）——先试 findOpenMR 复用、
      //   查到就视同建好、确认没有 / 查询失败都退回原始错误（不拿「复用失败」掩盖真因）
      if (res.status === 409 || res.status === 422) {
        const existing = await findOpenMR(input);
        if (existing.ok && existing.mr) {
          return { ok: true, url: existing.mr.url, iid: existing.mr.iid };
        }
        return { ok: false, error: await formatGitLabError(res) };
      }
      return { ok: false, error: await formatGitLabError(res) };
    }
    const parsed = await readJsonBody(res);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const body = parsed.body;
    if (typeof body?.web_url !== "string" || typeof body?.iid !== "number") {
      return {
        ok: false,
        error: `GitLab createMR 返回缺字段 web_url/iid: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    return { ok: true, url: body.web_url, iid: body.iid };
  } catch (err) {
    return { ok: false, error: formatFetchNetworkError(err) };
  }
};

/**
 * 关闭单个 MR（PUT state_event=close）
 *
 * 注意：close（非 merge）**不**触发 remove_source_branch、源分支保留——
 * 这正是我们要的：被取代的旧 feature→test MR 关掉、但 feature 工作分支不能删。
 */
const closeMR = async (input: {
  config: GitLabConfig;
  projectPath: string;
  iid: number;
}): Promise<{ ok: true } | { ok: false; error: string }> => {
  let base: string;
  let headers: HeadersInit;
  try {
    base = buildBaseUrl(input.config.host);
    headers = buildHeaders(input.config.token);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const url = `${base}/projects/${encodeProjectPath(input.projectPath)}/merge_requests/${input.iid}`;
  try {
    const res = await fetchWithGitToken(url, {
      method: "PUT",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({ state_event: "close" }),
    });
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatFetchNetworkError(err) };
  }
};

/**
 * 关掉指定 source→target 的 open MR（如果存在）。
 *
 * V0.6.8：AI 智能解冲突时、原 `feature→test` MR 被 `__conflict→test` 新 MR 取代、
 * 调本函数把旧的关掉、避免 GitLab 上留一个废弃的冲突 MR（双 MR 垃圾）。
 *
 * 仅「确认没有 open MR」才当成功 closed:false——查询失败必须向上返错（审查发现：
 *   旧逻辑把 401/网络错误当「本来没开」、解冲突后旧 MR 漏关双开）。
 */
export const closeOpenMR = async (input: {
  config: GitLabConfig;
  projectPath: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<{ ok: true; closed: boolean } | { ok: false; error: string }> => {
  // 复用 findOpenMR 按 source+target 拿到旧 MR 的 iid（title/description 不参与查询、传空即可）
  const found = await findOpenMR({
    config: input.config,
    projectPath: input.projectPath,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
  });
  if (!found.ok) {
    return { ok: false, error: found.error };
  }
  if (!found.mr) {
    // 确认没有 open MR → 目标已达成（它本来就没开着）
    return { ok: true, closed: false };
  }
  const closed = await closeMR({
    config: input.config,
    projectPath: input.projectPath,
    iid: found.mr.iid,
  });
  if (!closed.ok) return { ok: false, error: closed.error };
  return { ok: true, closed: true };
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
      res = await fetchWithGitToken(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, error: formatFetchNetworkError(err) };
    }
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    const parsed = await readJsonBody(res);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const body = parsed.body;
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

/**
 * 拉单个 MR 详情（提测收件箱：标题 / 分支 / state / 可合性）。
 * 不做 poll——收件箱列表要快，checking 态交给 UI chip 展示。
 */
export const getMR = async (input: GetMRInput): Promise<GetMRResult> => {
  let base: string;
  let headers: HeadersInit;
  try {
    base = buildBaseUrl(input.config.host);
    headers = buildHeaders(input.config.token);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const url = `${base}/projects/${encodeProjectPath(input.projectPath)}/merge_requests/${input.iid}`;
  try {
    const res = await fetchWithGitToken(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    const parsed = await readJsonBody(res);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const body = parsed.body;
    const detailed: string =
      typeof body?.detailed_merge_status === "string"
        ? body.detailed_merge_status
        : typeof body?.merge_status === "string"
          ? body.merge_status
          : "unchecked";
    const hasConflicts =
      detailed === "conflict" ||
      detailed === "cannot_be_merged" ||
      body?.has_conflicts === true;
    const mergeable =
      detailed === "mergeable" || detailed === "can_be_merged";
    return {
      ok: true,
      iid: typeof body?.iid === "number" ? body.iid : input.iid,
      url: typeof body?.web_url === "string" ? body.web_url : "",
      title: typeof body?.title === "string" ? body.title : "",
      description: typeof body?.description === "string" ? body.description : "",
      state: typeof body?.state === "string" ? body.state : "opened",
      sourceBranch:
        typeof body?.source_branch === "string" ? body.source_branch : "",
      targetBranch:
        typeof body?.target_branch === "string" ? body.target_branch : "",
      detailedMergeStatus: detailed,
      hasConflicts,
      mergeable,
      ...(typeof body?.sha === "string" && body.sha ? { headSha: body.sha } : {}),
    };
  } catch (err) {
    return { ok: false, error: formatFetchNetworkError(err) };
  }
};

/** 合并被 405 拒绝时 `detailed_merge_status` → 人话。只覆盖「不能合」的几类；认不出的值不猜、不追加原因 */
const MERGE_BLOCK_REASONS = new Map<string, string>([
  ["conflict", "有冲突，先解决冲突"],
  ["cannot_be_merged", "有冲突，先解决冲突"],
  ["ci_must_pass", "流水线没通过"],
  ["ci_still_running", "流水线还在跑"],
  ["draft_status", "还是草稿（Draft）"],
  ["discussions_not_resolved", "还有未解决的讨论"],
  ["not_approved", "还没批准"],
  ["blocked_status", "被别的 MR 阻塞"],
  ["need_rebase", "需要先 rebase"],
  ["checking", "GitLab 还在检查可合性，稍后再试"],
  ["unchecked", "GitLab 还在检查可合性，稍后再试"],
  ["preparing", "GitLab 还在检查可合性，稍后再试"],
]);

/**
 * 合并请求被 405 拒绝后补查一次 MR，把「不能合」说清楚（Q10-05）。
 * 405 是 GitLab 的「现在不能合」：已合并 / 已关闭 / 草稿 / 流水线没过 / 有冲突 / 讨论未解决……全是它，
 * 光看 `405 Method Not Allowed` 什么也看不出来：
 *  - 已合并 → 幂等成功（`alreadyMerged`）：双击 / 两个窗口 / 别人先合了，用户要的结果已经达成，不该报失败；
 *  - 已关闭 → 明说；
 *  - 仍打开 → 按 detailed_merge_status 补一句原因，认不出的状态不猜；
 *  - 补查本身失败 → 原样返回 GitLab 的拒绝文案（不拿「补查失败」掩盖真因）。
 * 只对 405 补查：409（sha 守卫）等其它拒绝文案原样返回——`isMergeShaMismatch` 靠它识别。
 */
const explainMergeRefusal = async (
  input: GetMRInput,
  error: string,
): Promise<MergeMRResult> => {
  const probe = await getMR(input);
  if (!probe.ok) return { ok: false, error };
  if (probe.state === "merged") {
    return { ok: true, url: probe.url, iid: probe.iid, alreadyMerged: true };
  }
  if (probe.state === "closed") {
    return { ok: false, error: `${error}（该 MR 已关闭，无法合并）` };
  }
  const why = MERGE_BLOCK_REASONS.get(probe.detailedMergeStatus);
  return { ok: false, error: why ? `${error}（${why}）` : error };
};

/**
 * 合并 MR（PUT …/merge）。失败返结构化错误（冲突 / pipeline / 权限等）。
 *
 * input.sha：期望的源分支 HEAD 提交。带上则 GitLab 只在 HEAD 仍是它时才合并，
 * 否则回 409（「SHA does not match HEAD of source branch」）——防止用户看到「可合并」之后、
 * 作者又推了新提交，却被一并合进目标分支（收件箱的「可合并」可能是几分钟前的扫描缓存，GAP3-02）。
 * 不带 = 沿用旧行为（合并当前 HEAD）。
 */
export const mergeMR = async (
  input: GetMRInput & { sha?: string },
): Promise<MergeMRResult> => {
  let base: string;
  let headers: HeadersInit;
  try {
    base = buildBaseUrl(input.config.host);
    headers = buildHeaders(input.config.token);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const url = `${base}/projects/${encodeProjectPath(input.projectPath)}/merge_requests/${input.iid}/merge`;
  try {
    const res = await fetchWithGitToken(url, {
      method: "PUT",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify(input.sha ? { sha: input.sha } : {}),
    });
    if (!res.ok) {
      const error = await formatGitLabError(res);
      if (res.status === 405) return await explainMergeRefusal(input, error);
      return { ok: false, error };
    }
    const parsed = await readJsonBody(res);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const body = parsed.body;
    return {
      ok: true,
      iid: typeof body?.iid === "number" ? body.iid : input.iid,
      url: typeof body?.web_url === "string" ? body.web_url : "",
    };
  } catch (err) {
    return { ok: false, error: formatFetchNetworkError(err) };
  }
};
