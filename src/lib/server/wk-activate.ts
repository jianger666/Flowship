/**
 * Delivery Hub REQ 激活（服务端）
 *
 * 调 Hub 内部接口 `/internal/harness/activation-draft` → `/internal/harness/activate`，
 * 鉴权头对齐官方 `wk-activate.py`（`X-Delivery-Harness-Token`）。
 * Token 只在本模块读、不回传客户端。
 *
 * 已激活过同一飞书工作项：草案带 alreadyActivated + existingReqId，直接复用编号、
 * 不再打 activate（Hub 同一 Project 只能激活一次）。
 *
 * 技术 Owner 必须是 Hub 启用中的账号（GET `/activation-owners`），confirm 走 ACCOUNT_ONLY，
 * 不再拿飞书显示名去 Hub 模糊匹配（对不上会 TECH_OWNER_NOT_FOUND）。
 */

import { fetchMyIdentity } from "@/lib/server/meegle-cli";
import { getLarkLocalIdentity } from "@/lib/server/feishu-bridge/lark-api";
import { readWkConfig, readWkHubToken } from "@/lib/server/wk-config";
import {
  parseActivationOwners,
  type HubOwnerOption,
  type WkActivateInput,
  type WkActivateResult,
  validateWkActivateInput,
} from "@/lib/wk-activate";
import {
  HUB_ACTIVATE_PATH,
  HUB_ACTIVATION_DRAFT_PATH,
  HUB_ACTIVATION_OWNERS_PATH,
  HUB_HARNESS_TOKEN_HEADER,
  normalizeHubUrl,
} from "@/lib/wk-hub";

const HUB_TIMEOUT_MS = 15000;

export const resolveActivationOwnerName = async (): Promise<string | null> => {
  const meegle = await fetchMyIdentity();
  const meegleName = meegle?.name?.trim();
  if (meegleName) return meegleName;
  const larkName = (await getLarkLocalIdentity())?.userName?.trim();
  return larkName || null;
};

export class WkActivateError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WkActivateError";
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const hubFailureMessage = (err: unknown): string => {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "连接 Delivery Hub 超时";
    }
    const code = (err.cause as { code?: string } | undefined)?.code;
    if (code === "ECONNREFUSED") return "Delivery Hub 连接被拒绝";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return "Delivery Hub 域名解析不了";
    }
    if (code) return `连不上 Delivery Hub（${code}）`;
  }
  return "连不上 Delivery Hub";
};

/** Hub 信封：success:false 抛错；有 data 就拆出来（对象或数组） */
const unwrapHubBody = (raw: unknown): unknown => {
  const obj = asRecord(raw);
  if (!obj) throw new WkActivateError("Delivery Hub 返回格式不对", 502);
  if (obj.success === false) {
    const message =
      typeof obj.message === "string" && obj.message.trim()
        ? obj.message.trim()
        : "Delivery Hub 请求失败";
    throw new WkActivateError(message, 502);
  }
  if ("data" in obj) return obj.data;
  return obj;
};

const pickText = (rec: Record<string, unknown>, key: string): string => {
  const value = rec[key];
  return typeof value === "string" ? value.trim() : "";
};

const hubRequest = async (
  method: "GET" | "POST",
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        [HUB_HARNESS_TOKEN_HEADER]: token,
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WkActivateError(hubFailureMessage(err), 502);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    raw = {};
  }

  if (res.status === 401 || res.status === 403) {
    throw new WkActivateError("Delivery Hub 鉴权失败，去设置页 → 团队检查 Token", 401);
  }
  if (!res.ok) {
    const rec = asRecord(raw);
    const message =
      (typeof rec?.message === "string" && rec.message.trim()) ||
      (typeof rec?.error === "string" && rec.error.trim()) ||
      `Delivery Hub 返回 HTTP ${res.status}`;
    throw new WkActivateError(message, 502);
  }
  return unwrapHubBody(raw);
};

export const getHubJson = async (
  baseUrl: string,
  token: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> => hubRequest("GET", baseUrl, token, path, undefined, fetchImpl);

export const postHubJson = async (
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> => {
  const data = await hubRequest("POST", baseUrl, token, path, body, fetchImpl);
  const rec = asRecord(data);
  if (!rec) throw new WkActivateError("Delivery Hub 返回格式不对", 502);
  return rec;
};

export const readWkActivateContext = async (): Promise<{
  hubReady: boolean;
  ownerName: string | null;
  owners: HubOwnerOption[];
}> => {
  const [cfg, token, ownerName] = await Promise.all([
    readWkConfig(),
    readWkHubToken(),
    resolveActivationOwnerName(),
  ]);
  const hubReady = Boolean(cfg.hubBaseUrl.trim() && cfg.hubTokenConfigured);
  let owners: HubOwnerOption[] = [];
  if (hubReady && token) {
    const base = normalizeHubUrl(cfg.hubBaseUrl);
    if (base) {
      try {
        owners = parseActivationOwners(
          await getHubJson(base, token, HUB_ACTIVATION_OWNERS_PATH),
        );
      } catch (err) {
        console.error("[wk-activate] list owners failed", err);
      }
    }
  }
  return { hubReady, ownerName, owners };
};

/**
 * 先问草案有没有激活过，没有再 confirm。techOwner 必须是 Hub 账号。
 */
export const activateRequirementInHub = async (
  input: WkActivateInput,
  postJson: (
    path: string,
    body: unknown,
  ) => Promise<Record<string, unknown>> = async () => {
    throw new WkActivateError("未注入 Hub 请求", 500);
  },
): Promise<WkActivateResult> => {
  const invalid = validateWkActivateInput(input);
  if (invalid) throw new WkActivateError(invalid);
  const techOwner = input.techOwner.trim();
  const techOwnerName = (input.techOwnerName ?? techOwner).trim() || techOwner;

  const draft = await postJson(HUB_ACTIVATION_DRAFT_PATH, {
    projectUrl: input.projectUrl.trim(),
    semanticCode: input.semanticCode.trim(),
  });
  const existingReqId = pickText(draft, "existingReqId");
  if (draft.alreadyActivated === true) {
    if (!existingReqId) {
      throw new WkActivateError("该工作项已激活，但 Hub 没返回 REQ-ID");
    }
    return { reqId: existingReqId, alreadyActivated: true };
  }

  const created = await postJson(HUB_ACTIVATE_PATH, {
    trackingProvider: "FEISHU_PROJECT",
    projectUrl: input.projectUrl.trim(),
    projectName: input.projectName.trim(),
    businessLine: input.businessLine.trim(),
    semanticCode: input.semanticCode.trim(),
    plannedOnlineDate: input.plannedOnlineDate.trim(),
    techOwner,
    techOwnerName,
    techOwnerResolveMode: "ACCOUNT_ONLY",
    requiresBizVerify: true,
    deliveryMode: "UNCONFIRMED",
  });
  const reqId = pickText(created, "reqId");
  if (!reqId) {
    throw new WkActivateError("激活成功但 Hub 没返回 REQ-ID", 502);
  }
  return { reqId, alreadyActivated: false };
};

export const runWkActivate = async (
  input: WkActivateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<WkActivateResult> => {
  const [cfg, token] = await Promise.all([readWkConfig(), readWkHubToken()]);
  const base = normalizeHubUrl(cfg.hubBaseUrl);
  if (!base || !token) {
    throw new WkActivateError("还没配 Delivery Hub，去设置页 → 团队");
  }
  return activateRequirementInHub(input, (path, body) =>
    postHubJson(base, token, path, body, fetchImpl),
  );
};
