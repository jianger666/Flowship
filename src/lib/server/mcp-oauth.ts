/**
 * MCP OAuth 2.1 客户端（给走 OAuth 授权的远程 MCP server 用）
 *
 * 背景（2026-06）：有些 MCP server（如飞书项目 `project.feishu.cn/mcp_server/v1`）走标准
 * OAuth 2.1 授权——在 Cursor 里点一下浏览器登录授权、token 存 Cursor 内部、连接时注入。但
 * fe 读 Cursor 的 `~/.cursor/mcp.json` 只拿到裸 url（OAuth token 不写文件）、SDK 起的 agent
 * 是 headless 的、弹不了浏览器走 OAuth → 连 server 直接 401、用不了。
 *
 * 解法：fe 自己跑一遍标准 OAuth flow（复用 `@modelcontextprotocol/sdk` 自带的 OAuth client：
 * RFC 9728/8414 发现 → RFC 7591 动态注册 DCR → PKCE 授权 → 换 token → refresh_token 续期）、
 * token 落服务端文件、起 agent 前注入到 `mcpServers[name].headers.Authorization`。
 * 一次授权、长期自动续——跟 Cursor 体验一致。
 *
 * 通用：任何标准 OAuth 2.1 的 MCP 都能用、不止飞书项目。
 *
 * 存储：`data/mcp-oauth/<sha256(serverName)>.json`（serverName = mcp.json 里的 key；
 * CR-04 起哈希命名防碰撞、记录内 serverName/serverUrl 读取时强校验、旧文件一次性迁移）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfig } from "@cursor/sdk";
import {
  dataRoot,
  hardenPathMode,
  writePrivateFileAtomic,
} from "./data-root";

// ---- 路径 / 常量 ----

// OAuth 凭证落盘目录（每个 server 一个 json）。惰性求值——模块加载时
// FE_AI_FLOW_DATA_DIR 可能还没注入（测试 / 特殊启动顺序）、跟 data-root 用法对齐
const oauthDir = (): string => path.join(dataRoot(), "mcp-oauth");

// fe 自身的 base url——**必须端口感知**（V0.13 验收踩过：硬编码 8876 时、test 实例
// （8776）发起授权、回调被打到正式实例（8876）、state 对不上直接「校验失败」）。
// 壳启动 server 时传了 PORT（正式 8876 / test 8776）、dev 兜底 8876；env 可整体覆盖。
const getBaseUrl = (): string =>
  process.env.FE_AI_FLOW_BASE_URL ??
  `http://localhost:${process.env.PORT ?? "8876"}`;
const getRedirectUri = (): string => `${getBaseUrl()}/api/mcp-oauth/callback`;

// access token 过期前多久就提前续期（避免临界过期、起 agent 时刚好失效）
const EXPIRY_BUFFER_MS = 60_000;

// ---- 按 server 串行（P1-07）：同进程内同一 server 的读-改-写互斥 ----
// 挂 globalThis：dev HMR / 多 chunk 各持一份 module 变量会让串行化失效
const OAUTH_LOCKS_KEY = "__feAiFlowMcpOAuthLocksV1__";
type OAuthLockMap = Map<string, Promise<void>>;

const getOAuthLocks = (): OAuthLockMap => {
  const g = globalThis as unknown as Record<string, OAuthLockMap | undefined>;
  if (!g[OAUTH_LOCKS_KEY]) g[OAUTH_LOCKS_KEY] = new Map();
  return g[OAUTH_LOCKS_KEY]!;
};

/**
 * 按 serverName 进程内 promise-chain 互斥（参考 meegle-queue）。
 * 罩住读-改-写全程；前驱失败不阻断后续；单进程 app、不需要跨进程文件锁。
 */
const withServerLock = <T>(
  serverName: string,
  run: () => Promise<T>,
): Promise<T> => {
  const locks = getOAuthLocks();
  const prev = locks.get(serverName) ?? Promise.resolve();
  const result = prev.then(run, run);
  locks.set(
    serverName,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
};

// ---- 落盘记录 ----

/** 单个 server 的 OAuth 状态（落 `data/mcp-oauth/<sha256(serverName)>.json`） */
interface OAuthRecord {
  /** mcp.json 里的原始 server 名（文件名会 sanitize、这里存原名供反查） */
  serverName: string;
  /** MCP server url（complete / refresh 时从这读） */
  serverUrl: string;
  /** DCR 动态注册结果（client_id / client_secret…） */
  client?: OAuthClientInformationFull;
  /** access + refresh token */
  tokens?: OAuthTokens;
  /** saveTokens 的时间戳（ms）、配合 expires_in 算 access 是否过期 */
  obtainedAt?: number;
  /** PKCE code verifier（授权流转中临时、换完 token 清掉） */
  codeVerifier?: string;
  /** CSRF state（发起授权时存、回调校验一致后清掉） */
  state?: string;
  /** redirectToAuthorization 拿到的授权 URL（start 请求内同步读回给前端） */
  authorizationUrl?: string;
  /** 发现结果缓存（避免每次起 agent 都重新打发现请求） */
  discovery?: OAuthDiscoveryState;
}

// serverName → 文件名 = sha256(serverName)（CR-04）：旧「替换非法字符」清洗不是一一映射、
// `foo/bar` 和 `foo?bar` 撞同一个文件、互相覆盖 OAuth 状态、更糟的是 A 的 bearer token
// 可能被发到 B（可被攻击者控制）的 URL。哈希无碰撞 + 天然防路径穿越。
const recordFile = (serverName: string): string =>
  path.join(
    oauthDir(),
    `${createHash("sha256").update(serverName, "utf8").digest("hex")}.json`,
  );

// 旧清洗规则的文件路径（一次性迁移用、迁完删）
const legacyRecordFile = (serverName: string): string =>
  path.join(oauthDir(), `${serverName.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

// server url 归一（比较口径）：去首尾空白 + 尾斜杠
const normalizeServerUrl = (u: string | undefined): string =>
  (u ?? "").trim().replace(/\/+$/, "");

/**
 * 旧文件一次性迁移：新哈希路径没有时、按旧清洗规则找文件。
 * **只有记录里的 serverName 完全一致才迁**（record 出生起就带 serverName）——
 * 碰撞名写的记录（旧规则下 `foo/bar` / `foo?bar` 共用一个文件、内容属于后写的那个）
 * 不猜归属、返 null 要求该 server 重新授权。
 *
 * 注意：调用方若已持 withServerLock，不要再包一层（会死锁）；本函数本身不加锁。
 */
const migrateLegacyRecord = async (
  serverName: string,
): Promise<OAuthRecord | null> => {
  try {
    const legacyPath = legacyRecordFile(serverName);
    const raw = await fs.readFile(legacyPath, "utf-8");
    const rec = JSON.parse(raw) as OAuthRecord;
    if (rec.serverName !== serverName) return null; // 碰撞受害方、不迁、重新授权
    await writeRecord(serverName, rec);
    await fs.unlink(legacyPath).catch(() => {});
    console.log(`[mcp-oauth] 已迁移旧凭证文件（${serverName}）到哈希命名`);
    return rec;
  } catch {
    return null; // 旧文件也没有 / 坏 JSON
  }
};

const readRecord = async (serverName: string): Promise<OAuthRecord | null> => {
  try {
    const raw = await fs.readFile(recordFile(serverName), "utf-8");
    const rec = JSON.parse(raw) as OAuthRecord;
    // 身份强校验（CR-04）：记录不属于本 serverName（手动拷文件 / 极端碰撞）→ 拒用
    if (rec.serverName !== serverName) return null;
    return rec;
  } catch {
    // 新路径没有 → 尝试旧清洗规则文件的一次性迁移
    return migrateLegacyRecord(serverName);
  }
};

/** 原子写凭证文件（0600 + 目录 0700 + tmp/rename）——内部不加锁，由 withServerLock 罩 */
const writeRecord = async (
  serverName: string,
  rec: OAuthRecord,
): Promise<void> => {
  await writePrivateFileAtomic(
    recordFile(serverName),
    JSON.stringify(rec, null, 2),
  );
};

// 局部更新（读旧的 merge 新字段、首次没有时用 base 兜底）——全程持 server 锁
const patchRecord = async (
  serverName: string,
  serverUrl: string,
  patch: Partial<OAuthRecord>,
): Promise<void> =>
  withServerLock(serverName, async () => {
    const cur = (await readRecord(serverName)) ?? { serverName, serverUrl };
    await writeRecord(serverName, { ...cur, ...patch });
  });

/**
 * 启动幂等迁移：mcp-oauth 目录 0700、内文件 0600。
 * 失败只 warn、不阻断；日志不含 token 内容。
 */
export const hardenMcpOAuthPerms = async (): Promise<void> => {
  const dir = oauthDir();
  await hardenPathMode(dir, 0o700);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.warn(
      `[mcp-oauth] 启动列举凭证目录失败:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }
  for (const name of names) {
    // 只收紧普通文件；跳过意外子目录 / 隐藏 tmp（tmp 写完应已清）
    await hardenPathMode(path.join(dir, name), 0o600);
  }
};


// ---- OAuthClientProvider 实现（状态全部落盘、跨请求复用） ----

/**
 * 文件型 OAuth provider：start / callback / refresh 是三个独立 HTTP 请求、provider 实例不同、
 * 所以全部状态（client / verifier / tokens / discovery）都落盘、靠 serverName 串起来。
 * 唯一例外是 `lastAuthorizationUrl`——start 请求内同步生成、同步读回、用实例字段即可。
 */
class FileOAuthClientProvider implements OAuthClientProvider {
  // start 流程里 SDK 会调 redirectToAuthorization、把授权 URL 记这、start 同步读回返给前端
  lastAuthorizationUrl: string | undefined;

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
  ) {}

  get redirectUrl(): string {
    return getRedirectUri();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "ai-flow",
      redirect_uris: [getRedirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // 声明 public client、纯 PKCE 保护（飞书项目 DCR 实测接受）
      token_endpoint_auth_method: "none",
    };
  }

  // 生成 OAuth2 state、把 serverName 编进去（回调时据此定位是哪个 server）+ CSRF 校验
  async state(): Promise<string> {
    const nonce = randomBytes(16).toString("hex");
    const s = Buffer.from(
      JSON.stringify({ s: this.serverName, n: nonce }),
    ).toString("base64url");
    await patchRecord(this.serverName, this.serverUrl, { state: s });
    return s;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return (await readRecord(this.serverName))?.client;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await patchRecord(this.serverName, this.serverUrl, { client: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await readRecord(this.serverName))?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await patchRecord(this.serverName, this.serverUrl, {
      tokens,
      obtainedAt: Date.now(),
    });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.lastAuthorizationUrl = url.toString();
    await patchRecord(this.serverName, this.serverUrl, {
      authorizationUrl: url.toString(),
    });
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await patchRecord(this.serverName, this.serverUrl, {
      codeVerifier: verifier,
    });
  }

  async codeVerifier(): Promise<string> {
    const rec = await readRecord(this.serverName);
    if (!rec?.codeVerifier) {
      throw new Error(
        `[mcp-oauth] ${this.serverName} 缺 codeVerifier、需重新发起授权`,
      );
    }
    return rec.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await patchRecord(this.serverName, this.serverUrl, { discovery: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await readRecord(this.serverName))?.discovery;
  }

  // SDK 在「token 失效 / client 失效」时主动调、清对应凭证好让 auth() 重试
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    // 与 patchRecord 同锁：避免 refresh/revoke 并发把读-改-写打穿
    await withServerLock(this.serverName, async () => {
      const rec = await readRecord(this.serverName);
      if (!rec) return;
      if (scope === "all") {
        await writeRecord(this.serverName, {
          serverName: this.serverName,
          serverUrl: this.serverUrl,
        });
        return;
      }
      if (scope === "client") rec.client = undefined;
      if (scope === "tokens") rec.tokens = undefined;
      if (scope === "verifier") rec.codeVerifier = undefined;
      if (scope === "discovery") rec.discovery = undefined;
      await writeRecord(this.serverName, rec);
    });
  }
}

// ---- 对外 API ----

/**
 * 发起授权：返回浏览器授权 URL（前端开新窗口让用户登录飞书授权）。
 *
 * 复用 SDK 的 `auth()`：没 token 时它会自动「发现 → DCR 注册（首次）→ 生成 PKCE 授权 URL →
 * 调 redirectToAuthorization」。这里先清掉旧 token/verifier、强制走授权流（重新授权也能用）、
 * 但保留已注册的 client + discovery 缓存（DCR 不必每次重来）。
 */
export const startMcpOAuth = async (
  serverName: string,
  serverUrl: string,
): Promise<string> => {
  // 先把 serverUrl 落盘（complete/refresh 要从 record 读它）
  await patchRecord(serverName, serverUrl, { serverName, serverUrl });

  const provider = new FileOAuthClientProvider(serverName, serverUrl);
  // 重新授权场景：清旧 token + 半截的 verifier、强制走浏览器授权流
  await provider.invalidateCredentials("tokens");
  await provider.invalidateCredentials("verifier");

  const result = await auth(provider, { serverUrl });
  if (result === "AUTHORIZED") {
    // 清了 token 还能 AUTHORIZED（理论不会、兜底）→ 当作已授权、无需跳浏览器
    return "";
  }
  if (!provider.lastAuthorizationUrl) {
    throw new Error(`[mcp-oauth] ${serverName} 未能生成授权 URL`);
  }
  return provider.lastAuthorizationUrl;
};

/** 从回调 state 解出 serverName（state 是 base64url(JSON{ s, n })） */
export const parseOAuthState = (
  state: string,
): { serverName: string } | null => {
  try {
    const obj = JSON.parse(Buffer.from(state, "base64url").toString("utf-8")) as {
      s?: string;
    };
    if (typeof obj.s === "string" && obj.s) return { serverName: obj.s };
  } catch {
    // state 坏 → null
  }
  return null;
};

/**
 * 完成授权：拿回调的 code 换 token、落盘。
 * 校验回调 state 跟发起时一致（CSRF）。
 */
export const completeMcpOAuth = async (
  serverName: string,
  code: string,
  state: string,
): Promise<void> => {
  const rec = await readRecord(serverName);
  if (!rec) {
    throw new Error(`[mcp-oauth] ${serverName} 无授权记录、请重新发起`);
  }
  if (!rec.state || rec.state !== state) {
    throw new Error(`[mcp-oauth] ${serverName} state 校验失败（疑似 CSRF / 已过期）`);
  }

  const provider = new FileOAuthClientProvider(serverName, rec.serverUrl);
  // 带 authorizationCode 调 auth() → 用已存的 client + codeVerifier 换 token、saveTokens
  const result = await auth(provider, {
    serverUrl: rec.serverUrl,
    authorizationCode: code,
  });
  if (result !== "AUTHORIZED") {
    throw new Error(`[mcp-oauth] ${serverName} 换 token 失败（${result}）`);
  }

  // 清掉一次性的 verifier / state / authUrl
  await provider.invalidateCredentials("verifier");
  await patchRecord(serverName, rec.serverUrl, {
    state: undefined,
    authorizationUrl: undefined,
  });
};

/** 落盘 token 状态（不含探测结果） */
interface TokenStatus {
  /** 已拿到 access token */
  authorized: boolean;
  /** access token 过期绝对时间（ms）；有 refresh 时过期也会自动续 */
  expiresAt?: number;
  /** 有 refresh_token（过期能自动续、无需用户再授权） */
  hasRefresh: boolean;
}

/** 单个 server 的授权状态（给前端展示） */
export interface McpOAuthStatus extends TokenStatus {
  /** 探测出该 server 要求 OAuth（连接返回 401）；本地 / url 自带 token / 公开 MCP 均为 false */
  needsOAuth: boolean;
}

// 读落盘 token 状态（已授权 / 过期时间 / 有无 refresh）
const getTokenStatus = async (serverName: string): Promise<TokenStatus> => {
  const rec = await readRecord(serverName);
  if (!rec?.tokens?.access_token) {
    return { authorized: false, hasRefresh: false };
  }
  const expiresAt =
    rec.obtainedAt && rec.tokens.expires_in
      ? rec.obtainedAt + rec.tokens.expires_in * 1000
      : undefined;
  return {
    authorized: true,
    expiresAt,
    hasRefresh: Boolean(rec.tokens.refresh_token),
  };
};

// 本地 / 内网地址：本地 MCP 服务（如 figma desktop 的 127.0.0.1）不走 OAuth、不探测
const isLocalUrl = (url: string): boolean => {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h === "::1" ||
      h.endsWith(".local")
    );
  } catch {
    return false;
  }
};

/**
 * 探测 server 是否要求 OAuth：发一个 MCP initialize、看是否 401（OAuth challenge）。
 * 跟 Cursor 一个机制——不靠猜「有 url 没 auth header 就当要授权」、而是连一下看 server 怎么回。
 * - 401 → 要 OAuth（设置页显示「授权」）
 * - 其余 / 连不上 → 不要（本地服务、url 自带 token、公开 MCP 都走这、不再误显示）
 */
const probeOAuthRequired = async (
  serverUrl: string,
  headers?: Record<string, string>,
): Promise<boolean> => {
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "fe-oauth-probe",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "ai-flow", version: "0" },
        },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 401;
  } catch {
    return false;
  }
};

/**
 * 评估 mcp.json 各 server 的 OAuth 状态（设置页卡片用、key=原始 serverName）。
 * 只收录「探测出要授权」或「已经授权过」的 server——
 * stdio 本地进程 / 本地地址 http / url 自带 token / 已手配 Authorization / 公开 MCP 都不会进来。
 */
export const evaluateMcpOAuthStatuses = async (
  servers: Record<string, McpServerConfig>,
): Promise<Record<string, McpOAuthStatus>> => {
  const entries = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      if (!("url" in cfg)) return null; // stdio 本地进程、不走 http oauth
      const token = await getTokenStatus(name);
      const headers = cfg.headers as Record<string, string> | undefined;
      const hasAuthHeader =
        headers &&
        Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
      // 本地地址 / 已手配 Authorization 的不探测（前者不走 oauth、后者已有认证）
      const needsOAuth =
        hasAuthHeader || isLocalUrl(cfg.url)
          ? false
          : await probeOAuthRequired(cfg.url, headers);
      // 既不要授权、也没授权过 → 不展示
      if (!needsOAuth && !token.authorized) return null;
      return [name, { ...token, needsOAuth }] as const;
    }),
  );
  return Object.fromEntries(
    entries.filter((e): e is readonly [string, McpOAuthStatus] => e !== null),
  );
};

/** 撤销授权：删凭证文件（下次起 agent 不再注入、需重新授权）。旧清洗命名的残留一并清。 */
export const clearMcpOAuth = async (serverName: string): Promise<void> =>
  withServerLock(serverName, async () => {
    await fs.unlink(recordFile(serverName)).catch(() => {});
    await fs.unlink(legacyRecordFile(serverName)).catch(() => {});
  });

/**
 * 拿有效 access token：未过期直接返；过期且有 refresh → 用 auth() 自动续；拿不到返 null。
 *
 * auth()（无 authorizationCode）行为：读 discovery 缓存 → 有 refresh_token 就 refresh、saveTokens、
 * 返回 AUTHORIZED。refresh 失败（refresh_token 也废了）会继续走授权流（redirectToAuthorization）、
 * 返回 REDIRECT——headless 下无意义、这里只认 AUTHORIZED、其余返 null 等用户重新授权。
 */
const getValidAccessToken = async (
  serverName: string,
  serverUrl: string,
): Promise<string | null> => {
  const rec = await readRecord(serverName);
  if (!rec?.tokens?.access_token) return null;

  // URL 强校验（CR-04）：同名 server 改绑了新 URL → 旧 token 绝不能发给新地址
  // （新地址可能是攻击者的）——要求重新授权
  if (normalizeServerUrl(rec.serverUrl) !== normalizeServerUrl(serverUrl)) {
    console.warn(
      `[mcp-oauth] ${serverName} 的 URL 已变更（${rec.serverUrl} → ${serverUrl}）、旧 token 不注入、需重新授权`,
    );
    return null;
  }

  const expiresAt =
    rec.obtainedAt && rec.tokens.expires_in
      ? rec.obtainedAt + rec.tokens.expires_in * 1000
      : undefined;
  const fresh = !expiresAt || Date.now() < expiresAt - EXPIRY_BUFFER_MS;
  if (fresh) return rec.tokens.access_token;

  if (!rec.tokens.refresh_token) return null;
  try {
    const provider = new FileOAuthClientProvider(serverName, serverUrl);
    const result = await auth(provider, { serverUrl });
    if (result === "AUTHORIZED") {
      return (await readRecord(serverName))?.tokens?.access_token ?? null;
    }
  } catch (err) {
    console.error(`[mcp-oauth] ${serverName} refresh 失败`, err);
  }
  return null;
};

/**
 * 起 agent 前给 http/sse 类 MCP server 注入 OAuth token。
 *
 * - 只处理有 `url` 的远程 server（stdio 类本地进程不走 http oauth）
 * - 用户在 mcp.json 已手配 Authorization header 的 → 尊重、不覆盖
 * - 已授权的 → 注入 `headers.Authorization = Bearer <token>`（过期先自动 refresh）
 * - 没授权 / 续期失败的 → 原样返回（连不上时用户去设置页点授权）
 */
export const enrichMcpServersWithOAuth = async (
  servers: Record<string, McpServerConfig>,
): Promise<Record<string, McpServerConfig>> => {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!("url" in cfg)) {
      out[name] = cfg;
      continue;
    }
    const hasAuthHeader =
      cfg.headers &&
      Object.keys(cfg.headers).some((k) => k.toLowerCase() === "authorization");
    if (hasAuthHeader) {
      out[name] = cfg;
      continue;
    }
    const token = await getValidAccessToken(name, cfg.url);
    if (!token) {
      out[name] = cfg;
      continue;
    }
    out[name] = {
      ...cfg,
      headers: { ...(cfg.headers ?? {}), Authorization: `Bearer ${token}` },
    };
  }
  return out;
};
