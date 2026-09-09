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
import { isTransientLarkMessage, LarkApiError } from "./types";

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

/**
 * 群功能所需 scope（实测 3 个就够：2026-09-09 用户实锤 `im:chat.group_info:readonly`
 * 是历史版本，新应用点一键页显示“当前无需开通任何权限”，根本开不了，也不需要——
 * 有 `im:chat:readonly` 就覆盖它了。之前把 4 个全列进必备，3 个全开完还红 1 个，误导。）
 * 与 REQUIRED_BRIDGE_SCOPES 分开声明、合并展示：设置页实盘只有一行“权限齐全”
 * （没有单独的群行），群缺口在同一行内用前缀文案区分
 * （“群功能缺少（发消息正常）：”），authUrl 一次预填全部缺口。
 */
export const REQUIRED_GROUP_SCOPES = [
  "im:chat:readonly",
  "im:chat",
  "im:chat.members:read",
] as const;

/** send_as_bot 的等价写法（任一命中即视为 send 权限齐） */
const SEND_SCOPE_EQUIVALENTS = [
  "im:message:send_as_bot",
  "im:message:send",
] as const;

/**
 * `im:message`（收消息）的等价写法。2026-07-19 冒烟实测：lark-cli init 建的应用
 * 只有细分 readonly scope、没有大 `im:message`，但 event consume 收 p2p 消息可用——
 * 细分任一命中即视为满足，避免误报红灯。
 */
const RECEIVE_SCOPE_EQUIVALENTS = [
  "im:message",
  "im:message:readonly",
  "im:message.p2p_msg:readonly",
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

/** 欢迎语（一段式）：绑定确认 + 指到 /help（清单注释在 /help 里、不重复整段） */
export const WELCOME_TEXT =
  "Flowship 消息桥接已就绪。直接发消息续聊；发 /help 看命令清单";

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
  /** 网络类失败（EOF/超时/断连）——不是权限问题、UI 不给「去开通」误导 */
  networkError?: boolean;
}

export interface ProbeCardkitCheck extends ProbeCheckItem {
  cardId?: string;
  /** LarkApiError.consoleUrl 透出 */
  consoleUrl?: string;
  /** 网络类失败——同上 */
  networkError?: boolean;
}

/**
 * 网络类错误判定（2026-07-20 同事实测：公司网络下 accounts.feishu.cn EOF 被
 * 渲染成「权限缺失 + 去开通」、纯误导）——这类失败只提示重试/查网络。
 * 判据下沉到 types.isTransientLarkMessage（与 runLark 的重试闸共用同一份口径）。
 */
const isNetworkErrorMessage = isTransientLarkMessage;

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
 *
 * `token_types` 故意忽略：实盘只见过 `"tenant"` / 缺省两种（单测 fixture 即按实盘写），
 * 从没见过 user-only 之类的限定值——在见过之前只认 scope 名，不拿未知词汇做绿灯闸。
 * 若将来出现“探针全绿但报缺 scope”，第一排查点就是该字段（到时把限定值收进准入表）。
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
  if (required === "im:message") {
    return RECEIVE_SCOPE_EQUIVALENTS.some((s) => granted.has(s));
  }
  return granted.has(required);
};

/** 算出缺失 scope 列表（用于深链 q= 与 UI 红灯） */
export const findMissingScopes = (granted: readonly string[]): string[] => {
  const set = new Set(granted);
  return REQUIRED_BRIDGE_SCOPES.filter((s) => !isScopeSatisfied(s, set));
};

/**
 * 一键开通深链（跟 lark-cli 报错里的 console_url 同款）：
 * `https://open.feishu.cn/page/scope-apply?clientID=<appId>&scopes=<encode 后缺失scope>`
 * 点开是“确定开通以下权限吗”+蓝色开通键，确认即开。之前用的 `/app/<id>/auth` 要自己勾+发版，绕。
 */
export const buildScopeAuthUrl = (
  appId: string,
  missingScopes: readonly string[],
): string => {
  const scopes = encodeURIComponent(missingScopes.join(","));
  return `https://open.feishu.cn/page/scope-apply?clientID=${appId}&scopes=${scopes}`;
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
          : "已安装并登录"
        : !installed
          ? "未安装飞书命令行工具"
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

/** 取应用已授权 scope（两组探针共用，一次查询）。抛错语义与原来 probeScopes 一致。 */
const fetchGrantedScopes = async (): Promise<{
  appId: string;
  granted: string[];
}> => {
  const info = await getBotAppInfo();
  const rec = await larkApi(
    "GET",
    `/open-apis/application/v6/applications/${encodeURIComponent(info.appId)}`,
    { params: { lang: "zh_cn" } },
  );
  return { appId: info.appId, granted: extractGrantedScopes(rec) };
};

const checkScopesResult = (
  appId: string,
  granted: string[],
  missing: string[],
  okDetail: string,
  missingDetailPrefix: string,
  /** 缺口后缀：群缺时追加重进补救（与群错误翻译文案统一口径） */
  missingDetailSuffix = "",
): ProbeScopesCheck => {
  const ok = missing.length === 0;
  return {
    ok,
    appId,
    granted,
    missing,
    ...(ok
      ? { detail: okDetail }
      : {
          detail: `${missingDetailPrefix}${missing.join(", ")}${missingDetailSuffix}`,
          authUrl: buildScopeAuthUrl(appId, missing),
        }),
  };
};

/**
 * 群缺口的重进补救后缀（设置页“权限齐全”行 detail 用）。
 * 与群错误翻译 `describeScopeShortage` 统一口径：不断言必须重进，
 * 只给“开通后仍不好使再重进”分支——实盘是否真要重进尚未定论，两边一致。
 * 只用于群缺口；纯桥接缺口（发消息/卡片）不需要重进，不加。
 */
export const GROUP_SCOPE_REJOIN_SUFFIX =
  "；若开通后仍不好使，把机器人移出群重进一次";

const probeScopes = async (): Promise<ProbeScopesCheck> => {
  try {
    const { appId, granted } = await fetchGrantedScopes();
    // 一次性申请全部免审权限：发消息四件套 + 群三件套并集（自建应用租户管理员自助开通，
    // 无需官方审核；敏感通讯录字段等高级权限不在表内，真缺了只告知不推链接——见 AI 提示词）。
    // 仍走原来这一行（不新增 UI 行）：detail 列全缺口，authUrl 一次预填全部。
    const bridgeMissing = findMissingScopes(granted);
    const groupMissing = (await probeGroupScopes(granted, appId)).missing;
    const missing = [...bridgeMissing, ...groupMissing];
    return checkScopesResult(
      appId,
      granted,
      missing,
      "所需权限已开通",
      groupMissing.length > 0 && bridgeMissing.length === 0
        ? "群功能缺少（发消息正常）："
        : "缺少：",
      groupMissing.length > 0 ? GROUP_SCOPE_REJOIN_SUFFIX : "",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 网络类失败 ≠ 权限缺失：不给「去开通」、不触发首次接入引导（同事实测被误导）
    if (isNetworkErrorMessage(msg)) {
      return {
        ok: false,
        granted: [],
        missing: [],
        networkError: true,
        error: "网络异常（飞书接口不可达），点重试；持续失败请检查代理/VPN",
      };
    }
    // 查询本身挂了（如新机器人还没开「获取应用信息」权限）也要给一键开通链接——
    // 尽力拿 appId 兜底构造预填深链（用户点开就是勾好的权限列表）
    let appId = "";
    try {
      appId = (await getBotAppInfo()).appId;
    } catch {
      // getBotAppInfo 也挂——真拿不到 appId、不给链接
    }
    const fallbackAuth = appId
      ? { appId, authUrl: buildScopeAuthUrl(appId, REQUIRED_BRIDGE_SCOPES) }
      : {};
    if (err instanceof LarkApiError) {
      return {
        ok: false,
        granted: [],
        missing: [...REQUIRED_BRIDGE_SCOPES],
        error: err.message,
        ...fallbackAuth,
        ...(err.consoleUrl ? { authUrl: err.consoleUrl } : {}),
      };
    }
    return {
      ok: false,
      granted: [],
      missing: [...REQUIRED_BRIDGE_SCOPES],
      error: msg,
      ...fallbackAuth,
    };
  }
};

/** 群功能权限探针（成员/群信息）。查询失败整体标红但不给误导性缺口（见下 probeBridgeStatus）。单测可直接调。
 * detail 自带重进补救后缀（与群错误翻译统一口径）；
 * 注意：probeScopes 合并展示时只取本函数的 missing，本 detail 会被合并行覆盖——
 * 合并行同样带后缀（见上），两边不会打架。 */
export const probeGroupScopes = async (
  granted: string[],
  appId: string,
): Promise<ProbeScopesCheck> => {
  const set = new Set(granted);
  const missing = REQUIRED_GROUP_SCOPES.filter((s) => !set.has(s));
  return checkScopesResult(
    appId,
    granted,
    [...missing],
    "群成员/群信息权限已开通",
    "缺少（群 @ 解析、问事取数不可用）：",
    missing.length > 0 ? GROUP_SCOPE_REJOIN_SUFFIX : "",
  );
};

const probeCardkit = async (): Promise<ProbeCardkitCheck> => {
  try {
    const { card_id } = await createCardEntity(PROBE_CARD_JSON);
    return {
      ok: true,
      cardId: card_id,
      detail: "支持流式卡片",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isNetworkErrorMessage(msg)) {
      return {
        ok: false,
        networkError: true,
        error: "网络异常（飞书接口不可达），点重试；持续失败请检查代理/VPN",
      };
    }
    if (err instanceof LarkApiError) {
      return {
        ok: false,
        error: err.message,
        ...(err.consoleUrl ? { consoleUrl: err.consoleUrl } : {}),
      };
    }
    return {
      ok: false,
      error: msg,
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
