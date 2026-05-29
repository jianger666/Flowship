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
 * 查询 MR 状态入参（V0.6.4+ polling 用、V0.6.1 先实现不调用）
 */
export interface GetMRInput {
  config: GitLabConfig;
  projectPath: string;
  iid: number;
}

export type GetMRResult =
  | {
      ok: true;
      state: "opened" | "closed" | "merged" | "locked";
      mergedAt: number | null;
      lastCommitHash: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * MR 上加 note（评论）入参
 *
 * 当前 V0.6.1 不强求用——飞书 story 评论已经覆盖测试人员通知场景、MR 评论暂不用
 * 留接口给 V0.6.2+「ship 时同时在 MR 留 fe-ai-flow 链接」用
 */
export interface AddMRNoteInput {
  config: GitLabConfig;
  projectPath: string;
  iid: number;
  body: string;
}

export type AddMRNoteResult =
  | { ok: true; noteId: number }
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
 * 创建 MR
 *
 * 失败常见原因：
 *   - 401：token 失效 / 权限不足
 *   - 404：project 不存在 / token 没有该 project 访问权限
 *   - 409：同 source/target branch 已存在 open MR（GitLab 错误信息会包含「Another open merge request already exists」）
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
 * 查询 MR 状态（V0.6.4+ polling 用、V0.6.1 先 export 不调用）
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
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    const body = await res.json();
    if (typeof body?.state !== "string") {
      return {
        ok: false,
        error: `GitLab getMR 返回缺字段 state: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      state: body.state as "opened" | "closed" | "merged" | "locked",
      mergedAt:
        typeof body.merged_at === "string" && body.merged_at
          ? new Date(body.merged_at).getTime()
          : null,
      lastCommitHash: typeof body?.sha === "string" ? body.sha : "",
    };
  } catch (err) {
    return {
      ok: false,
      error: `网络错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * MR 上加 note（V0.6.2+ 用、V0.6.1 先 export 不调用）
 */
export const addMRNote = async (
  input: AddMRNoteInput,
): Promise<AddMRNoteResult> => {
  let base: string;
  let headers: HeadersInit;
  try {
    base = buildBaseUrl(input.config.host);
    headers = buildHeaders(input.config.token);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const url = `${base}/projects/${encodeProjectPath(input.projectPath)}/merge_requests/${input.iid}/notes`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: input.body }),
    });
    if (!res.ok) {
      return { ok: false, error: await formatGitLabError(res) };
    }
    const body = await res.json();
    if (typeof body?.id !== "number") {
      return {
        ok: false,
        error: `GitLab addMRNote 返回缺字段 id: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    return { ok: true, noteId: body.id };
  } catch (err) {
    return {
      ok: false,
      error: `网络错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * 从 remote.origin.url 解析 GitLab projectPath
 *
 * 支持 ssh / https 两种格式：
 *   - git@gitlab.wukongedu.net:wkid/crm-web.git → { host: "gitlab.wukongedu.net", projectPath: "wkid/crm-web" }
 *   - https://gitlab.wukongedu.net/wkid/crm-web.git → 同上
 *   - https://gitlab.wukongedu.net/wkid/sub/crm-web → { host, projectPath: "wkid/sub/crm-web" }
 *
 * 工具函数 export 给 task-runner 使用、agent 也能在 prompt 里调（虽然 prompt 里直接让 agent shell 处理更清晰）
 */
export const parseGitLabRemoteUrl = (
  remoteUrl: string,
): { host: string; projectPath: string } | null => {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  // ssh 格式：git@host:group/repo.git
  const sshMatch = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) {
    return { host: sshMatch[1], projectPath: sshMatch[2] };
  }
  // https 格式：https://host/group/repo(.git)?
  const httpsMatch = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (httpsMatch) {
    return { host: httpsMatch[1], projectPath: httpsMatch[2] };
  }
  return null;
};
