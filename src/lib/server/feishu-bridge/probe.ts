/**
 * 飞书消息桥接前置条件探测（设置页引导检查，方案 4.4b）
 *
 * 四项：CLI 登录 → scope 齐全 → cardkit 试建卡 → runtime（占位，主线接线）。
 * 「发送欢迎消息」单独走 sendWelcomeMessage，由用户点按钮触发、不自动发。
 */

import { getFeishuCliStatus } from "@/lib/server/feishu-cli";

import {
  createCardEntity,
  getBotAppInfo,
  larkApi,
  sendTextMessage,
} from "./lark-api";
import { LarkApiError } from "./types";

// ----------------- scope 清单（与提案 4.4b 表一致） -----------------

/**
 * 桥接所需 scope。API `data.app.scopes[].scope` 字段写法即这些字符串。
 * send 侧：`im:message:send_as_bot` 为主；部分租户/历史应用可能只有 `im:message:send`。
 */
export const REQUIRED_BRIDGE_SCOPES = [
  "im:message:send_as_bot",
  "im:message",
  "cardkit:card:write",
  "im:resource",
] as const;

/** send_as_bot 的等价写法（任一命中即视为 send 权限齐） */
const SEND_SCOPE_EQUIVALENTS = [
  "im:message:send_as_bot",
  "im:message:send",
] as const;

/** 探测用最小 JSON 2.0 卡（只建实体不发送，验证 cardkit:card:write） */
const PROBE_CARD_JSON = {
  schema: "2.0",
  config: { streaming_mode: false, update_multi: true },
  header: {
    title: { tag: "plain_text", content: "Flowship probe" },
    template: "blue" as const,
  },
  body: {
    elements: [
      {
        tag: "markdown",
        element_id: "probe",
        content: "ok",
      },
    ],
  },
};

/** 欢迎语（一段式）：绑定确认 + 命令清单 */
export const WELCOME_TEXT =
  "Flowship 消息桥接已就绪。直接发消息续聊；命令：/stop /compact /new /list /history /status /help";

// ----------------- 返回形状 -----------------

export interface ProbeCheckItem {
  ok: boolean;
  /** 一行给人看的说明 */
  detail?: string;
  error?: string;
}

export interface ProbeCliCheck extends ProbeCheckItem {
  installed: boolean;
  loggedIn: boolean;
}

export interface ProbeScopesCheck extends ProbeCheckItem {
  appId?: string;
  /** 应用已声明的 scope 名（从 scopes[].scope 抽出） */
  granted: string[];
  missing: string[];
  /** 缺 scope 时的权限预填深链 */
  authUrl?: string;
}

export interface ProbeCardkitCheck extends ProbeCheckItem {
  cardId?: string;
  /** LarkApiError.consoleUrl 透出 */
  consoleUrl?: string;
}

export interface BridgeProbeStatus {
  cli: ProbeCliCheck;
  scopes: ProbeScopesCheck;
  cardkit: ProbeCardkitCheck;
  /**
   * 桥接 runtime（consumer 存活等）。
   * probe 自身不依赖 inbound（避免拖入 spawn 依赖图）——由 status route 合入
   * `inbound.getBridgeRuntimeStatus()` 覆盖此占位。
   */
  runtime: null;
}

// ----------------- scope 工具（单测可直接调） -----------------

type JsonRecord = Record<string, unknown>;

const asRecord = (v: unknown): JsonRecord | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;

/**
 * 从 GET /application/v6/applications/<id> 响应抽出已授权 scope 名。
 * 官方字段：`data.app.scopes[]` 每项 `{ scope: string, token_types?: string[] }`。
 */
export const extractGrantedScopes = (apiRoot: unknown): string[] => {
  const rec = asRecord(apiRoot);
  if (!rec) return [];
  const data = asRecord(rec.data) ?? rec;
  const app = asRecord(data.app) ?? data;
  const scopes = app.scopes;
  if (!Array.isArray(scopes)) return [];
  const out: string[] = [];
  for (const item of scopes) {
    if (typeof item === "string" && item) {
      out.push(item);
      continue;
    }
    const row = asRecord(item);
    if (row && typeof row.scope === "string" && row.scope) {
      out.push(row.scope);
    }
  }
  return out;
};

/** 某 required scope 是否已被 granted 覆盖（send 走等价表） */
export const isScopeSatisfied = (
  required: string,
  granted: ReadonlySet<string>,
): boolean => {
  if (required === "im:message:send_as_bot") {
    return SEND_SCOPE_EQUIVALENTS.some((s) => granted.has(s));
  }
  return granted.has(required);
};

/** 算出缺失 scope 列表（用于深链 q= 与 UI 红灯） */
export const findMissingScopes = (granted: readonly string[]): string[] => {
  const set = new Set(granted);
  return REQUIRED_BRIDGE_SCOPES.filter((s) => !isScopeSatisfied(s, set));
};

/**
 * 权限预填深链（提案 4.4b）：
 * `https://open.feishu.cn/app/<appId>/auth?q=<逗号分隔缺失scope>&op_from=openapi&token_type=tenant`
 */
export const buildScopeAuthUrl = (
  appId: string,
  missingScopes: readonly string[],
): string => {
  // 与飞书 console_url / 提案 4.4b 同形态：q 为逗号分隔、不额外 encode（scope 仅含 [a-z:_]）
  const q = missingScopes.join(",");
  return `https://open.feishu.cn/app/${appId}/auth?q=${q}&op_from=openapi&token_type=tenant`;
};

// ----------------- 探测主流程 -----------------

const probeCli = async (): Promise<ProbeCliCheck> => {
  try {
    const snap = await getFeishuCliStatus();
    const installed = !!snap.larkCli.installed;
    const loggedIn = !!snap.larkCli.loggedIn;
    const ok = installed && loggedIn;
    return {
      ok,
      installed,
      loggedIn,
      detail: ok
        ? snap.larkCli.authDetail
          ? `已登录：${snap.larkCli.authDetail}`
          : "已安装已登录"
        : !installed
          ? "未安装 lark-cli"
          : "未登录",
    };
  } catch (err) {
    return {
      ok: false,
      installed: false,
      loggedIn: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const probeScopes = async (): Promise<ProbeScopesCheck> => {
  try {
    const info = await getBotAppInfo();
    const rec = await larkApi(
      "GET",
      `/open-apis/application/v6/applications/${encodeURIComponent(info.appId)}`,
      { params: { lang: "zh_cn" } },
    );
    const granted = extractGrantedScopes(rec);
    const missing = findMissingScopes(granted);
    const ok = missing.length === 0;
    return {
      ok,
      appId: info.appId,
      granted,
      missing,
      ...(ok
        ? { detail: "所需权限已开通" }
        : {
            detail: `缺少：${missing.join(", ")}`,
            authUrl: buildScopeAuthUrl(info.appId, missing),
          }),
    };
  } catch (err) {
    if (err instanceof LarkApiError) {
      return {
        ok: false,
        granted: [],
        missing: [...REQUIRED_BRIDGE_SCOPES],
        error: err.message,
        ...(err.consoleUrl ? { authUrl: err.consoleUrl } : {}),
      };
    }
    return {
      ok: false,
      granted: [],
      missing: [...REQUIRED_BRIDGE_SCOPES],
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const probeCardkit = async (): Promise<ProbeCardkitCheck> => {
  try {
    const { card_id } = await createCardEntity(PROBE_CARD_JSON);
    return {
      ok: true,
      cardId: card_id,
      detail: "cardkit 可用",
    };
  } catch (err) {
    if (err instanceof LarkApiError) {
      return {
        ok: false,
        error: err.message,
        ...(err.consoleUrl ? { consoleUrl: err.consoleUrl } : {}),
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/** GET /api/feishu-bridge/status 用：跑全部引导检查 */
export const probeBridgeStatus = async (): Promise<BridgeProbeStatus> => {
  const cli = await probeCli();
  // CLI 未就绪时 scope / cardkit 多半也会挂——仍继续探，方便用户一次看全缺项
  const scopes = await probeScopes();
  const cardkit = await probeCardkit();
  return {
    cli,
    scopes,
    cardkit,
    // 占位：由 /api/feishu-bridge/status route 用 inbound.getBridgeRuntimeStatus() 覆盖
    runtime: null,
  };
};

/** POST action=welcome：给应用 owner 发欢迎私聊（验证 bot 会话 + 绑定确认） */
export const sendWelcomeMessage = async (): Promise<{
  messageId: string;
  chatId: string;
}> => {
  const info = await getBotAppInfo();
  const result = await sendTextMessage(info.ownerOpenId, WELCOME_TEXT);
  return { messageId: result.message_id, chatId: result.chat_id };
};
