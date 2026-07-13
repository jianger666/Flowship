/**
 * meegle CLI 服务端封装（V0.14 首页飞书看板）
 *
 * 首页看板 / 工作项预览 / URL 解析都走这里——execFile 直调内置 meegle 二进制
 *（data/tools/bin/meegle、V0.12 起可在设置页安装）、`--format json` 输出好解析。
 *
 * 关键设计：
 * - **响应结构宽松归一**（normalizeWorkitem）：mywork / workitem get 的响应字段名
 *   没有公开 schema（官方 skill 文档只写了请求参数）、按常见命名多重兜底解析、
 *   解析不出的字段留 undefined、UI 容错渲染。真实结构以用户登录后实测校准。
 * - **错误三态**：not_installed（二进制不存在）/ not_authed（未登录）/ error（其他）——
 *   首页据此渲染降级态（装 CLI 引导 / 授权引导 / 报错重试）。
 * - 超时 30s：CLI 走公网 API、网络差时别挂死 route。
 * - **进程级串行队列**（`meegle-queue.ts`）：所有 meegle 短命子进程同一时刻最多跑 1 个
 *   （凭据文件 `~/.meegle/{.machine-key,credentials.enc}` 并发 refresh 会撞毁 → 等效登出；
 *   看板 Promise.all 会排队变慢一点，凭据安全 > 首屏 200ms）。
 *   feishu-cli 的 auth status / version / config 也走同一队列；`auth login` 长驻交互例外。
 *   排队等在 chain 上、30s/10s timeout 仍只罩 execFileAsync——排队时间不计入超时。
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { USER_ROLE_LABEL, USER_ROLES, type UserRole } from "@/lib/types";
import { meegleBin } from "./feishu-cli";
import { enqueueMeegle } from "./meegle-queue";
import { readSettingsFile } from "./settings-fs";

const execFileAsync = promisify(execFile);

// ---------- 基础执行 ----------

export type MeegleFailure = "not_installed" | "not_authed" | "error";

export class MeegleError extends Error {
  constructor(
    public readonly kind: MeegleFailure,
    message: string,
  ) {
    super(message);
    this.name = "MeegleError";
  }
}

/**
 * 跑一条 meegle 命令、解析 JSON 输出；失败抛 MeegleError（kind 三态）。
 * 整段（含 unknown-command 时的 auth status 复核）进串行队列——复核走 raw、
 * 避免已持锁再 enqueue 死锁。
 */
const runMeegle = (args: string[]): Promise<unknown> =>
  enqueueMeegle(() => runMeegleUnlocked(args));

/** execFile 超时被 kill / 带 signal / meegle exit 2（网络不可达）→ 瞬态，不是「确定未登录」 */
const isMeegleExecTransient = (err: unknown): boolean => {
  const e = err as {
    killed?: boolean;
    signal?: string | null;
    code?: number | string;
    message?: string;
    stderr?: string;
  };
  if (e.killed === true) return true;
  if (typeof e.signal === "string" && e.signal.length > 0) return true;
  // meegle auth status 官方：exit 2 = 网络不可达（与 feishu-cli probeMeegleAuth 对齐）
  if (e.code === 2) return true;
  const text = `${e.message ?? ""}\n${e.stderr ?? ""}`;
  return /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|timed? ?out|network unreachable/i.test(
    text,
  );
};

const runMeegleUnlocked = async (args: string[]): Promise<unknown> => {
  const bin = meegleBin();
  try {
    await fs.access(bin);
  } catch {
    throw new MeegleError("not_installed", "meegle CLI 未安装");
  }
  let stdout: string;
  try {
    const r = await execFileAsync(bin, [...args, "--format", "json"], {
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = r.stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
    // 瞬态优先：VPN 卡 / 超时 kill 的 stderr 偶尔带 "auth login" 提示文案，
    // 若先走未登录正则会把登录着的人误判成 not_authed（看板弹「去授权」）
    if (isMeegleExecTransient(err)) {
      throw new MeegleError(
        "error",
        (e.stderr || e.message || "meegle 调用超时或网络不可达").slice(0, 500),
      );
    }
    if (/not logged in|no local token|auth login|unauthorized|401/i.test(text)) {
      throw new MeegleError("not_authed", "meegle 未登录、请先在设置页授权");
    }
    // 未登录时动态命令未注册、报 unknown command——但升级 / 重启后 CLI 冷启动、
    // 命令集加载慢也会瞬态报同样的错（用户实测「升级完首屏授权像没检测到」）：
    // 用静态命令 auth status 复核、真没登录才报 not_authed、登录着 / 探测瞬态算 error
    if (/unknown command/i.test(text)) {
      // 已在队列槽内：走 raw，勿再 enqueueMeegle（会死锁）
      const st = await meegleAuthStatusUnlocked();
      if (st.authenticated) {
        throw new MeegleError("error", "meegle 命令集尚未就绪、请稍后重试");
      }
      // auth status 自己超时 / exit 2 → transient，别当成未登录
      if (st.transient) {
        throw new MeegleError("error", "meegle 登录态探测失败（网络超时）、请稍后重试");
      }
      throw new MeegleError("not_authed", "meegle 未登录（命令集未加载）、请先在设置页授权");
    }
    throw new MeegleError("error", (e.stderr || e.message || "meegle 调用失败").slice(0, 500));
  }
  try {
    return JSON.parse(stdout);
  } catch {
    // 有些命令可能带非 JSON 前缀行、截取首个 { / [ 起始再试一次
    const idx = Math.min(
      ...["{", "["].map((c) => {
        const i = stdout.indexOf(c);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      }),
    );
    if (idx < Number.MAX_SAFE_INTEGER) {
      try {
        return JSON.parse(stdout.slice(idx));
      } catch {
        /* fallthrough */
      }
    }
    throw new MeegleError("error", `meegle 输出不是 JSON：${stdout.slice(0, 200)}`);
  }
};

// ---------- 登录态 ----------

/** auth status 实际执行（不进队列）；供已持锁的 runMeegleUnlocked 复核用 */
const meegleAuthStatusUnlocked = async (): Promise<{
  installed: boolean;
  authenticated: boolean;
  host?: string;
  /**
   * 探测失败是瞬态（超时 kill / exit 2 网络不可达 / 无 stdout）——
   * 不是「确定未登录」。unknown-command 复核必须看这个，否则 VPN 卡会误报 not_authed。
   */
  transient?: boolean;
}> => {
  const bin = meegleBin();
  try {
    await fs.access(bin);
  } catch {
    return { installed: false, authenticated: false };
  }
  try {
    // 官方：exit 0 = token 有效；1 = 未登录 / token 失效；2 = 网络不可达
    const r = await execFileAsync(bin, ["auth", "status"], {
      timeout: 10_000,
    });
    const parsed = JSON.parse(r.stdout) as {
      authenticated?: boolean;
      host?: string | null;
    };
    return {
      installed: true,
      authenticated: !!parsed.authenticated,
      host: parsed.host ?? undefined,
    };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    // exit 1 时 stdout 仍常有 JSON（authenticated:false）——有输出就信 JSON
    if (typeof e.stdout === "string" && e.stdout.trim()) {
      try {
        const parsed = JSON.parse(e.stdout) as {
          authenticated?: boolean;
          host?: string | null;
        };
        const transient = isMeegleExecTransient(err);
        return {
          installed: true,
          authenticated: !!parsed.authenticated,
          host: parsed.host ?? undefined,
          // exit 2 / 超时即使带 JSON 也标瞬态（调用方不得当未登录）
          ...(transient ? { transient: true } : {}),
        };
      } catch {
        /* fallthrough */
      }
    }
    // 无可用 stdout（超时 kill / 解析失败）→ 一律瞬态，绝不当 authenticated:false
    // （旧实现 catch 一律 false，是 VPN 卡看板弹「去授权」的元凶）
    return { installed: true, authenticated: false, transient: true };
  }
};

/** 对外入口：走串行队列（boot / 看板探测也会打这条，必须和 runMeegle 互斥） */
export const meegleAuthStatus = (): Promise<{
  installed: boolean;
  authenticated: boolean;
  host?: string;
  transient?: boolean;
}> => enqueueMeegle(() => meegleAuthStatusUnlocked());

// ---------- 工作项归一化 ----------

/** 看板用的工作项归一形状（字段解析不出就 undefined、UI 容错） */
export interface BoardWorkitem {
  /** 工作项 ID（字符串化） */
  id: string;
  /** 标题 */
  name: string;
  /** 空间 key（后续 workitem get / 流转都要带） */
  projectKey?: string;
  /** 空间名（展示用） */
  projectName?: string;
  /** 工作项类型（story / issue…、api_name 或 label） */
  typeLabel?: string;
  /** 当前状态 / 节点名（飞书侧状态徽标） */
  statusLabel?: string;
  /** 排期开始 / 结束（ms、时间线视图用） */
  scheduleStart?: number;
  scheduleEnd?: number;
  /** 详情页 URL（建任务时作 feishuStoryUrl） */
  url?: string;
  /** 原始对象（预览页兜底展示 / 调试） */
  raw: Record<string, unknown>;
}

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined;

const asMs = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  // 秒级时间戳兜底转毫秒（< 10^12 视为秒）
  return v < 1e12 ? v * 1000 : v;
};

// 从多个候选 key 里取第一个非空
const pick = (obj: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
};

// 日期解析：ms 时间戳（秒级兜底）或 "YYYY-MM-DD" 字符串（mywork 实测形态）
const asDateMs = (v: unknown): number | undefined => {
  const n = asMs(v);
  if (n) return n;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return undefined;
};

/**
 * 单个工作项归一。mywork todo 实测结构（2026-07-10 登录后校准）：
 * ```
 * { node_info: { node_name: "前端开发", node_state_key },
 *   project_key, project_name,
 *   schedule: { start_time: "2025-06-03", end_time: "2025-06-04" },   // 字符串日期
 *   work_item_info: { work_item_id: 4969867129, work_item_name, work_item_type_key } }
 * ```
 * 顶层扁平形态（workitem query 等其他接口可能用）保留兜底。
 */
export const normalizeWorkitem = (rawItem: unknown): BoardWorkitem | null => {
  if (!rawItem || typeof rawItem !== "object") return null;
  const m = rawItem as Record<string, unknown>;
  // 核心字段可能嵌在 work_item_info 子对象（mywork 实测）、也可能顶层扁平
  const info =
    m.work_item_info && typeof m.work_item_info === "object"
      ? (m.work_item_info as Record<string, unknown>)
      : m;
  const id = asStr(pick(info, ["work_item_id", "workItemId", "id"]));
  const name = asStr(pick(info, ["work_item_name", "name", "title"]));
  if (!id || !name) return null;

  // 状态：mywork 在 node_info.node_name（当前节点名）；其他接口可能给字符串 / 对象
  let statusLabel: string | undefined;
  if (m.node_info && typeof m.node_info === "object") {
    statusLabel = asStr((m.node_info as Record<string, unknown>).node_name);
  }
  if (!statusLabel) {
    const rawStatus = pick(m, ["work_item_status", "status", "current_status", "state"]);
    if (typeof rawStatus === "string") statusLabel = rawStatus;
    else if (rawStatus && typeof rawStatus === "object") {
      const s = rawStatus as Record<string, unknown>;
      statusLabel = asStr(pick(s, ["label", "name", "state_key", "value"]));
    }
  }

  // 排期：mywork 的 schedule.{start_time,end_time} 是 "YYYY-MM-DD" 字符串；ms 形态兜底
  let scheduleStart: number | undefined;
  let scheduleEnd: number | undefined;
  const sched = pick(m, ["schedule", "node_schedule"]);
  if (sched && typeof sched === "object") {
    const s = sched as Record<string, unknown>;
    scheduleStart = asDateMs(pick(s, ["start_time", "estimate_start_date", "start_date", "start"]));
    scheduleEnd = asDateMs(pick(s, ["end_time", "estimate_end_date", "end_date", "end", "due_date"]));
  }
  scheduleStart ??= asDateMs(pick(m, ["estimate_start_date", "start_date", "start_time"]));
  scheduleEnd ??= asDateMs(pick(m, ["estimate_end_date", "end_date", "deadline", "due_date"]));

  const typeRaw = pick(info, ["work_item_type_key", "work_item_type", "type_key", "type"]);
  const typeLabel =
    typeof typeRaw === "string"
      ? typeRaw
      : typeRaw && typeof typeRaw === "object"
        ? asStr((typeRaw as Record<string, unknown>).label ?? (typeRaw as Record<string, unknown>).name)
        : undefined;

  return {
    id,
    name,
    projectKey: asStr(pick(m, ["project_key", "projectKey", "space_id"])),
    projectName: asStr(pick(m, ["project_name", "space_name", "simple_name"])),
    typeLabel,
    statusLabel,
    scheduleStart,
    scheduleEnd,
    url: asStr(pick(m, ["url", "link", "detail_url"])),
    raw: m,
  };
};

// 响应里挖工作项数组：常见包裹 data.list / list / data / items / results
const extractItems = (resp: unknown): unknown[] => {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== "object") return [];
  const r = resp as Record<string, unknown>;
  for (const k of ["list", "items", "results", "work_items", "workItems"]) {
    if (Array.isArray(r[k])) return r[k] as unknown[];
  }
  if (r.data !== undefined) return extractItems(r.data);
  return [];
};

// ---------- 业务查询（mywork 已退役、V0.14.1 看板换 workhour list-schedule） ----------

/** 工作项详情（预览页 / 任务详情融合用；默认字段已含 description） */
// 成功结果进程内缓存：同一 story 反复起 agent 时 resolveUserIdentity 不重付 CLI
const workitemDetailCache = new Map<string, Record<string, unknown>>();
const workitemDetailCacheKey = (id: string, projectKey?: string): string =>
  `${projectKey ?? ""}:${id}`;

export const fetchWorkitemDetail = async (
  workItemId: string,
  projectKey?: string,
): Promise<Record<string, unknown>> => {
  const cacheKey = workitemDetailCacheKey(workItemId, projectKey);
  const cached = workitemDetailCache.get(cacheKey);
  if (cached) return cached;

  const args = ["workitem", "get", "--work-item-id", workItemId];
  if (projectKey) args.push("--project-key", projectKey);
  const resp = await runMeegle(args);
  let detail: Record<string, unknown> = {};
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    // 剥常见 data 包裹
    if (r.data && typeof r.data === "object") {
      detail = r.data as Record<string, unknown>;
    } else {
      detail = r;
    }
  }
  // 成功才缓存（空对象也算一次成功响应、避免同 key 狂打）
  workitemDetailCache.set(cacheKey, detail);
  return detail;
};

// ---------- 当前用户（子任务「只看自己」过滤 + agent prompt 身份注入） ----------

// user me 缓存（user_key / 姓名不会变、进程级缓存即可）——**只缓存成功结果**：
// v1.1.x 修（用户实测「升级重启后首屏授权像没检测到」的隐患之一）：原来失败也缓存 null、
// server 冷启动首拉赶上 CLI 慢 / 网络抖一次、看板就永远 not_authed 到进程重启
let meCache: string | undefined;
/** 身份缓存（姓名 + user_key）；与 meCache 同源、成功后两边一起填 */
let identityCache: MeegleIdentity | undefined;

/** meegle `user me` 归一：姓名（name_cn 优先）+ user_key */
export interface MeegleIdentity {
  userKey: string;
  /** 展示名：name_cn 优先、否则 name_en */
  name: string;
}

/**
 * 当前登录用户的 user_key（实测 user me 返回 { user_key, name_cn, ... }）。
 * 真·未登录返 null；**瞬态失败（超时 / 网络抖）原样抛**——调用方（board route）
 * 会按 error 态渲染「重试」、而不是误导性的「去授权」（升级重启后冷启动踩过）
 */
export const fetchMyUserKey = async (): Promise<string | null> => {
  if (meCache !== undefined) return meCache;
  // 身份已缓存时复用（避免再打一次 user me）
  if (identityCache) {
    meCache = identityCache.userKey;
    return meCache;
  }
  try {
    const resp = (await runMeegle(["user", "me"])) as Record<string, unknown>;
    const key = asStr(resp.user_key);
    if (key) {
      meCache = key;
      // 顺手填身份缓存（姓名有就存、没有只缓存 key）
      const name = asStr(resp.name_cn) ?? asStr(resp.name_en);
      if (name) identityCache = { userKey: key, name };
    }
    return key ?? null;
  } catch (err) {
    if (err instanceof MeegleError && err.kind === "not_authed") return null;
    throw err;
  }
};

/**
 * 当前登录用户身份（姓名 + user_key）。
 * 给 agent prompt「发起人」行用——**增强路径、失败一律返 null**（未登录 / 超时 / 缺字段都不抛、
 * 别堵 task / chat 启动）。成功结果进程级缓存。
 */
export const fetchMyIdentity = async (): Promise<MeegleIdentity | null> => {
  if (identityCache) return identityCache;
  try {
    const resp = (await runMeegle(["user", "me"])) as Record<string, unknown>;
    const userKey = asStr(resp.user_key);
    const name = asStr(resp.name_cn) ?? asStr(resp.name_en);
    if (!userKey || !name) return null;
    identityCache = { userKey, name };
    meCache = userKey;
    return identityCache;
  } catch {
    // 身份是增强不是依赖：not_authed / 超时 / 解析失败都吞掉
    return null;
  }
};

// ---------- prompt「用户身份」行（姓名 meegle + 角色 settings） ----------

/**
 * 从服务端 config.json 读设置页「我的角色」、映射中文标签。
 * 未设 / 坏值 → null（不注入角色段）。
 */
const readUserRoleLabel = async (): Promise<string | null> => {
  const settings = await readSettingsFile();
  const raw = settings?.userRole;
  if (typeof raw !== "string" || !USER_ROLES.includes(raw as UserRole)) {
    return null;
  }
  return USER_ROLE_LABEL[raw as UserRole];
};

/**
 * 拼 prompt「用户身份」行。
 * - 姓名 + 角色 → `- 发起人：陈禄江（角色：前端）`
 * - 只有姓名 → `- 发起人：陈禄江`
 * - 只有角色（meegle 未登录）→ `- 发起人角色：前端`
 * - 两个都没有 → 空串（调用方不注入整行）
 */
export const formatUserIdentityLine = (
  name: string | null | undefined,
  roleLabel: string | null | undefined,
): string => {
  const n = name?.trim() ?? "";
  const r = roleLabel?.trim() ?? "";
  if (n && r) return `- 发起人：${n}（角色：${r}）`;
  if (n) return `- 发起人：${n}`;
  if (r) return `- 发起人角色：${r}`;
  return "";
};

/**
 * 解析并拼出可直接塞进 super / chat prompt 的「用户身份」行。
 * - 姓名：meegle `user me`（进程级缓存保留）
 * - 角色：只读 settings.userRole（设置页 / 首页清单写入）——不再反查 story 角色组、
 *   不再读 identity.json、不再依赖 decodeUrl
 *
 * meegle 查询包 **5s 总预算**（超时仍可用角色单独注入；底层成功结果进缓存、下次能用）；
 * meegle 失败另记 60s 负缓存、避免每次启动都卡满 5s（角色仍照常注入）。
 */
/** 姓名 resolve 总预算（ms）——超时跳过姓名、不堵 agent 启动 */
const IDENTITY_RESOLVE_BUDGET_MS = 5_000;
/** meegle 失败负缓存 TTL：网络挂时 60s 内不再发起 user me */
const IDENTITY_NEG_CACHE_MS = 60_000;
let identityNegCachedAt = 0;

export const resolveUserIdentityForPrompt = async (): Promise<string> => {
  // 角色走本地文件、瞬时；与 meegle 姓名解耦——超时也能注入「发起人角色」
  const roleLabel = await readUserRoleLabel();

  const negHit =
    identityNegCachedAt > 0 &&
    Date.now() - identityNegCachedAt < IDENTITY_NEG_CACHE_MS;

  let name: string | null = null;
  if (!negHit) {
    // 迟到成功清负缓存；catch 吞掉防 unhandled rejection
    const work = fetchMyIdentity()
      .then((id) => {
        if (id) identityNegCachedAt = 0;
        return id?.name ?? null;
      })
      .catch((): null => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, IDENTITY_RESOLVE_BUDGET_MS);
    });
    try {
      name = await Promise.race([work, timeout]);
      if (name) identityNegCachedAt = 0;
      else if (timedOut) identityNegCachedAt = Date.now();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return formatUserIdentityLine(name, roleLabel);
};

// ---------- 节点排期（甘特展开细节 + 需求级跨度聚合） ----------

/** 节点下的子任务（甘特展开的最细粒度、用户要看的「具体任务」） */
export interface WorkitemSubTask {
  name: string;
  start?: number;
  end?: number;
  finished?: boolean;
  /** 负责人 user_key 列表（owner 字段是 JSON 字符串 `[{"username":"<user_key>"}]`、实测） */
  owners?: string[];
}

/** 工作项的单个节点排期（甘特展开行用） */
export interface WorkitemNode {
  name: string;
  /** not_started / doing / done 等（CLI basic.status 原样） */
  status?: string;
  start?: number;
  end?: number;
  /** 节点下子任务（--need-sub-task true、实测字段 sub_task_name + ISO 日期 + is_finished） */
  subTasks: WorkitemSubTask[];
}

// 节点排期缓存：49 个工作项逐个调 CLI 太贵（每次 ~1s）、10 分钟内复用
const nodesCache = new Map<string, { at: number; nodes: WorkitemNode[] }>();
const NODES_TTL_MS = 10 * 60 * 1000;

/**
 * 拉工作项的全部节点排期（workflow get-node --node-id-list '["_all"]'、实测结构：
 * list[].basic.{name,node_key,status} + schedule.{estimate_start_time,estimate_finish_time}）。
 * 失败返回空数组（甘特降级为只显示 mywork 的当前节点排期）。
 */
export const fetchWorkitemNodes = async (
  workItemId: string,
  projectKey?: string,
  opts: { skipCache?: boolean } = {},
): Promise<WorkitemNode[]> => {
  const cacheKey = `${projectKey ?? ""}:${workItemId}`;
  if (!opts.skipCache) {
    const hit = nodesCache.get(cacheKey);
    if (hit && Date.now() - hit.at < NODES_TTL_MS) return hit.nodes;
  }
  try {
    const args = [
      "workflow",
      "get-node",
      "--work-item-id",
      workItemId,
      "--node-id-list",
      '["_all"]',
      "--need-sub-task",
      "true",
    ];
    if (projectKey) args.push("--project-key", projectKey);
    const resp = await runMeegle(args);
    const nodes: WorkitemNode[] = [];
    for (const raw of extractItems(resp)) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const basic =
        m.basic && typeof m.basic === "object"
          ? (m.basic as Record<string, unknown>)
          : m;
      const name = asStr(basic.name);
      if (!name) continue;
      let start: number | undefined;
      let end: number | undefined;
      if (m.schedule && typeof m.schedule === "object") {
        const s = m.schedule as Record<string, unknown>;
        start = asDateMs(s.estimate_start_time);
        end = asDateMs(s.estimate_finish_time);
      }
      // 子任务（实测：sub_task_name + estimate_start/end_date 为 ISO 字符串 + is_finished）
      const subTasks: WorkitemSubTask[] = [];
      if (Array.isArray(m.sub_tasks)) {
        for (const rawSub of m.sub_tasks as Array<Record<string, unknown>>) {
          const subName = asStr(rawSub.sub_task_name ?? rawSub.name);
          if (!subName) continue;
          // owner 是 JSON 字符串（[{"username":"<user_key>"}]、实测）——解出 user_key 列表
          let owners: string[] | undefined;
          if (typeof rawSub.owner === "string" && rawSub.owner.trim()) {
            try {
              const arr = JSON.parse(rawSub.owner) as Array<{ username?: string }>;
              owners = arr.map((o) => o.username).filter((v): v is string => !!v);
            } catch {
              /* owner 格式变了就不过滤 */
            }
          }
          subTasks.push({
            name: subName,
            start: asDateMs(rawSub.estimate_start_date),
            end: asDateMs(rawSub.estimate_end_date),
            finished: rawSub.is_finished === true,
            owners,
          });
        }
      }
      nodes.push({ name, status: asStr(basic.status), start, end, subTasks });
    }
    nodesCache.set(cacheKey, { at: Date.now(), nodes });
    return nodes;
  } catch {
    return [];
  }
};

/** 并发拉多个工作项的节点排期（限并发、看板聚合需求级跨度用） */
export const fetchNodesForItems = async (
  items: Array<{ id: string; projectKey?: string }>,
  opts: { skipCache?: boolean } = {},
): Promise<Map<string, WorkitemNode[]>> => {
  const out = new Map<string, WorkitemNode[]>();
  const CONCURRENCY = 8;
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (idx < items.length) {
      const cur = items[idx++];
      const nodes = await fetchWorkitemNodes(cur.id, cur.projectKey, opts);
      out.set(cur.id, nodes);
    }
  });
  await Promise.all(workers);
  return out;
};

// ---------- 人员排期（V0.14.1 起看板主数据源、飞书「人员排期」视图同款接口） ----------

/**
 * 按空间 + 人 + 时间区间查排期（workhour list-schedule、实测结构）：
 * ```
 * user_workload_list[0].tasks[]: {
 *   work_item_info: { id, name, work_item_status },
 *   time: { start: "2026-06-15 00:00:00", end: "...", duration: 0.5 },   // 需求级排期
 *   state: { state_name: "技术排期" },                                    // 当前节点名
 *   subtasks: [{ id, name, time: {...} }],                               // 我的子任务
 * }
 * ```
 * 为什么换它：mywork todo 只覆盖「当前节点等我操作」的工作项、同事的需求
 * （子任务负责人、非节点 owner）拉不到、空间下拉也因此缺空间——workhour 是
 * 飞书人员排期视图的底层接口、按空间查我参与的全部排期、语义正确。
 */
export const fetchUserSchedule = async (
  projectKey: string,
  userKey: string,
  startMs: number,
  endMs: number,
): Promise<BoardWorkitem[]> => {
  const fmt = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const resp = (await runMeegle([
    "workhour",
    "list-schedule",
    "--project-key",
    projectKey,
    "--user-keys",
    JSON.stringify([userKey]),
    "--start-time",
    fmt(startMs),
    "--end-time",
    fmt(endMs),
    "--work-item-type-keys",
    '["_all"]',
  ])) as Record<string, unknown>;

  const workloads = Array.isArray(resp.user_workload_list)
    ? (resp.user_workload_list as Array<Record<string, unknown>>)
    : [];
  const tasks = Array.isArray(workloads[0]?.tasks)
    ? (workloads[0]!.tasks as Array<Record<string, unknown>>)
    : [];

  // "2026-06-15 00:00:00"（空格分隔）→ ms
  const parseTime = (v: unknown): number | undefined => {
    if (typeof v !== "string" || !v.trim()) return undefined;
    const t = Date.parse(v.replace(" ", "T"));
    return Number.isFinite(t) && t > 0 ? t : undefined;
  };

  const items: BoardWorkitem[] = [];
  for (const task of tasks) {
    const info =
      task.work_item_info && typeof task.work_item_info === "object"
        ? (task.work_item_info as Record<string, unknown>)
        : {};
    const id = asStr(info.id);
    const name = asStr(info.name);
    if (!id || !name) continue;

    const time =
      task.time && typeof task.time === "object"
        ? (task.time as Record<string, unknown>)
        : {};
    const state =
      task.state && typeof task.state === "object"
        ? (task.state as Record<string, unknown>)
        : {};

    // 子任务（人员排期语义下天然只有自己的）
    const subTasks: WorkitemSubTask[] = [];
    if (Array.isArray(task.subtasks)) {
      for (const sub of task.subtasks as Array<Record<string, unknown>>) {
        const subName = asStr(sub.name);
        if (!subName) continue;
        const st =
          sub.time && typeof sub.time === "object"
            ? (sub.time as Record<string, unknown>)
            : {};
        subTasks.push({
          name: subName,
          start: parseTime(st.start),
          end: parseTime(st.end),
        });
      }
    }

    const statusLabel = asStr(state.state_name);
    items.push({
      id,
      name,
      projectKey,
      statusLabel,
      scheduleStart: parseTime(time.start),
      scheduleEnd: parseTime(time.end),
      raw: task,
    });
    // 前端展开逻辑遍历 nodes 取 subTasks——包一层单节点结构复用现有渲染
    const last = items[items.length - 1] as BoardWorkitem & {
      nodes?: WorkitemNode[];
    };
    last.nodes =
      subTasks.length > 0
        ? [{ name: statusLabel ?? "排期", status: undefined, start: undefined, end: undefined, subTasks }]
        : [];
  }
  console.log(
    `[meegle] workhour ${projectKey} ${fmt(startMs)}~${fmt(endMs)}：原始 ${tasks.length} 条、解析 ${items.length} 条`,
  );
  return items;
};

// ---------- 空间列表（下拉数据源 + URL 拼接） ----------

/** 可访问空间（project search 实测结构 { projects: [{ name, project_key, simple_name }] }） */
export interface MeegleProject {
  key: string;
  name: string;
  simpleName?: string;
}

// 空间列表缓存（10 分钟、空间极少变）——空间下拉 + URL 拼接共用
let projectsCache: { at: number; list: MeegleProject[] } | null = null;

/** 当前用户可访问的全部空间（V0.14.1 起空间下拉数据源——不再从数据聚合、
 * 同事踩过：mywork 覆盖不全导致下拉缺空间、看不到自己需求所在的空间） */
export const fetchProjects = async (): Promise<MeegleProject[]> => {
  if (projectsCache && Date.now() - projectsCache.at < 10 * 60 * 1000) {
    return projectsCache.list;
  }
  const resp = (await runMeegle(["project", "search"])) as Record<string, unknown>;
  const projects = Array.isArray(resp.projects) ? resp.projects : [];
  const list: MeegleProject[] = [];
  for (const p of projects as Array<Record<string, unknown>>) {
    const key = asStr(p.project_key);
    const name = asStr(p.name);
    if (key && name) list.push({ key, name, simpleName: asStr(p.simple_name) });
  }
  projectsCache = { at: Date.now(), list };
  return list;
};

export const fetchProjectSimpleNames = async (): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  try {
    for (const p of await fetchProjects()) {
      if (p.simpleName) map.set(p.key, p.simpleName);
    }
  } catch {
    // 拉不到就返回空 map（URL 兜底拼接降级为跳过）
  }
  return map;
};

/** URL → 结构化字段；非工作项详情 URL 返回 null */
// 成功结果按 url 缓存：同一 task 反复起 agent 不重付 decode CLI
const decodeUrlCache = new Map<
  string,
  { workItemId: string; simpleName?: string; typeKey?: string }
>();

export const decodeWorkitemUrl = async (
  url: string,
): Promise<{ workItemId: string; simpleName?: string; typeKey?: string } | null> => {
  const cached = decodeUrlCache.get(url);
  if (cached) return cached;
  try {
    const resp = (await runMeegle(["url", "decode", "--url", url])) as Record<
      string,
      unknown
    >;
    const kind = asStr(resp.url_kind);
    const id = asStr(resp.work_item_id);
    if (kind !== "workitem_detail" || !id) return null;
    const decoded = {
      workItemId: id,
      simpleName: asStr(resp.simple_name),
      typeKey: asStr(resp.work_item_type),
    };
    decodeUrlCache.set(url, decoded);
    return decoded;
  } catch {
    return null;
  }
};
