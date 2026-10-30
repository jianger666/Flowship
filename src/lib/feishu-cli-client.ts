/**
 * 设置页「飞书集成」对 /api/system/feishu-cli 的写请求封装（R14 B6-2 · Q6-05）。
 *
 * 之前三个按钮各写一份 fetch：
 * - 安装完全不看返回值——接口回 4xx / 5xx、断网时照样弹「已开始下载安装」，用户以为在装、其实没动；
 *   服务端「已有一轮在装」（`started: false`）也被当成「刚开始」。
 * - 登录 / 卸载直接 `res.json()`——网关回 HTML 错误页或断网时抛出没人接的 rejection，界面没有任何提示。
 * 这里统一成「永不抛、结果二选一」：调用方只看 `ok`。
 */

export const FEISHU_CLI_ENDPOINT = "/api/system/feishu-cli";

export type FeishuCliResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * @param body 有则按 JSON 发（POST）；DELETE 不带 body
 * @param fetchImpl 默认用全局 fetch，测试可注入假的
 * @returns 失败时 `message` 一定非空：服务端给的 `error` 原文 → 否则 `请求失败（HTTP 状态码）` → 网络错取 `网络错误：原因`
 */
export const requestFeishuCli = async (
  method: "POST" | "DELETE",
  body?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<FeishuCliResult> => {
  try {
    const res = await fetchImpl(FEISHU_CLI_ENDPOINT, {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    // 响应体不是 JSON（网关错误页 / 空体）不算异常：data 取空对象，成败由 res.ok 决定
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (isRecord(parsed)) data = parsed;
    } catch {
      // 非 JSON：保持空对象
    }
    if (!res.ok) {
      const error = typeof data.error === "string" ? data.error.trim() : "";
      return { ok: false, message: error || `请求失败（HTTP ${res.status}）` };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      message: `网络错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
